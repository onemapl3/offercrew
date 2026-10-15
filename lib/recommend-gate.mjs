// 推荐的判断与展示规则：
//   推荐线    Judge 判成推荐、匹配度（lib/matcher.mjs requirementScore）没到线的，改成待核，记 below_line { score, line }。
//             结论词（推荐 / 待核 / 排除）是 Judge 的话，匹配度是逐条要求的分，以前两者之间没有规则（实测 A17：40 分也写推荐）。
//             对外只显示这一个分数。线在 config/pipeline.json recommend.min_score，设置里能改；改了以后已经判过、还没定的线索按新线重算
//             （regate），不用重新调模型。
//   展示偏好  已判断合格的推荐默认全部放出（10-11 负责人：不把已经花费得到的结果藏起来）。
//             只有用户明确设置 recommend.daily_limit 正整数才按天限量，超出的按分数排队（rec_queue）。
//             放出来的记 recommended_at；这一步不调用模型，模型调用前的花费控制由 lib/spend.mjs 负责。
//   方向必填  求职方向没填：一个也不放（rec_queue.reason = no_direction），收件箱有一封「补充信息」请你选方向（directionAsk）。
//   主人决定  待核是已判过的岗位：主人看过待核点可以主动投递，不改变自动推荐规则。没结论才给「先判断」。
//
// 推荐线默认 60：匹配度里「可迁移」一条算 0.6 分，60 就是平均每条硬性要求至少够得上可迁移。Judge 说推荐、只差一项关键要求看不出来
// （判断规则 1）、其余都有证据的，算出来 80 多，照样过；一串要求都「看不出来」（0.3）、靠模型一句推荐撑着的（实测 #101 40、#395 36、
// #265 45）过不了，进待核，行上写「匹配度 45 没过线」。
import { read } from './store.mjs';
import { requirementScore } from './matcher.mjs';
import { currentFacts } from './facts.mjs';
import { directionKey } from './directions.mjs';
import { dayOf } from './tz.mjs';
import { decidedLead, endedLead, postingClosed } from './lead-state.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { shelved, happened } from './shelf.mjs';
import { sourceStats, penaltyOf, RELEASE_PENALTY } from './source-stats.mjs';
import { hasApplicationApproval } from './submission-policy.mjs';

export const GATE_DEFAULTS = { min_score: 60, daily_limit: null };
const int = (v, lo, hi, d) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
export function gateSettings(pipeline = read('config/pipeline.json', {}) || {}) {
  const r = pipeline?.recommend || {};
  return { min_score: int(r.min_score, 0, 100, GATE_DEFAULTS.min_score), daily_limit: int(r.daily_limit, 1, 100, GATE_DEFAULTS.daily_limit) };
}

// ── 推荐线 ──────────────────────────────────────────────────────────────────
// Judge 原本的结论：被线压下去的那几条原本是推荐。
export const judgeVerdict = (m = {}) => (m?.below_line ? 'recommend' : m?.verdict || null);
// 判断一出来（bin/match.mjs）和每分钟的放量（lib/recommend-sweep.mjs，改了线也按新线重核）都过这一道。算不出分（一条要求都没有）的推荐也算没过线。
export function gateMatch(match, { line = gateSettings().min_score, facts = currentFacts() } = {}) {
  if (!match || typeof match !== 'object') return match;
  const judge = judgeVerdict(match), { below_line, ...rest } = match;
  if (judge !== 'recommend') return below_line ? { ...rest, verdict: judge } : match;
  const score = requirementScore(match, facts);
  if (score != null && score >= line) return below_line ? { ...rest, verdict: 'recommend' } : match;
  return { ...rest, verdict: 'verify', below_line: { score, line } };
}
// 判完了没有：有结论，而且算得出匹配度（结论下面有逐条要求）；或者是这一版的判断逐条核过、岗位描述里本来就没写要求（req_checked）。
// 老版本留下的、只有一个结论没有逐条要求的（实测 A18：阿里 #525–#535 没有匹配度却给「批准投递」）算没判完。
export const hasJudgement = (l = {}) => !!l?.match?.verdict;
export const judgedFully = (l = {}, facts = currentFacts()) => !!l.match?.verdict && (requirementScore(l.match, facts) != null || l.match.req_checked === true);
// 自动重试已终止而没有业务结论：主人可以明说继续，原失败仍在，绝不当成系统推荐。
export const judgementStopped = (l = {}) => !!l?.match_error_final && !hasJudgement(l) && !l.superseded && !l.prefilter_reason && !shelved(l);

// ── 方向 ────────────────────────────────────────────────────────────────────
// 资料里写了认得出的求职方向（没写的老用户以前按软件工程处理，现在要补）。
export const directionSet = (facts = currentFacts()) => [facts?.preferences?.directions, facts?.preferences?.direction].flat().filter(x => x != null && x !== '').some(x => !!directionKey(x));

// ── 每天放几个 ──────────────────────────────────────────────────────────────
// 还在排队的推荐（指挥台不出筛选那一行、收件箱不出投递信）。
export const unapprovedReview = (l = {}) => l.auto_apply?.status === 'awaiting_batch_review' && !l.auto_apply?.approved_at && !happened(l);
// 系统投递建议也要过同一放量口径，不能把“能填表”或队列的待审核标记当成已经放行。
// 不限于 recommend：旧的软待核也不能被自动填表能力变成新的投递建议。真实批准/发生历史保留。
export const heldApplySuggestion = (l = {}, facts = currentFacts()) => !l.auto_apply?.approved_at && !happened(l) && !endedLead(l) && (l.match?.verdict !== 'recommend' || !l.recommended_at || !directionSet(facts));
export const heldRec = (l = {}, facts = currentFacts()) => l.match?.verdict === 'recommend' && heldApplySuggestion(l, facts);
// 推荐限量只管自动展示；用户明确批准过判断的岗位，不等推荐名额。
// 默认用于系统推荐；新批准入口显式传 ownerDecision。继续旧批准另按原计划指纹核验。
export function approvalBlocker(l = {}, { facts = currentFacts(), line = gateSettings().min_score, ownerDecision = false } = {}) {
  if (postingClosed(l)) return '这个岗位已经关了，投不了';
  if (ownerDecision && judgementStopped(l)) return null;
  // 主人主动处理待核，不是系统推荐：不等方向、分数或每日名额。未判、硬排除仍不能冒充待核。
  if (ownerDecision && hasJudgement(l) && !shelved(l) && gateMatch(l.match, { facts, line })?.verdict === 'verify' && (l.match.verdict === 'verify' || judgedFully(l, facts))) return null;
  if (!directionSet(facts) && !hasApplicationApproval(l)) return '还没选求职方向，先选好再决定投不投';
  if (!judgedFully(l, facts)) return '还没判完，先判断再决定投不投';
  if (shelved(l)) return '这条不在当前求职范围里，先重新判断';
  if (gateMatch(l.match, { facts, line })?.verdict !== 'recommend') return '这条还有待核信息或没有过推荐线，先补信息并重新判断';
  return null;
}
// 能放出来的：过了线的推荐、还没定、没放过、没被排除的公司。
const open = l => l.match?.verdict === 'recommend' && !l.recommended_at && !l.superseded && !l.legacy && !l.prefilter_reason && !postingClosed(l) && (!decidedLead(l) || unapprovedReview(l)) && !endedLead(l) && !l.auto_apply?.approved_at && !shelved(l) && !excludedCompany(l);
// 这一刻该放哪几条、哪几条排队：纯函数，不写。返回 { release: [l], hold: [{ l, reason }], today, limit, direction }。
export function planRelease(leads = [], { now = Date.now(), settings = gateSettings(), facts = currentFacts(), stats = null } = {}) {
  const today = dayOf(now), direction = directionSet(facts), limit = settings.daily_limit;
  const shown = leads.filter(l => l.recommended_at && dayOf(l.recommended_at) === today && !l.superseded).length;
  const s = stats || sourceStats(leads), rank = l => (requirementScore(l.match, facts) ?? 0) - penaltyOf(l, s, RELEASE_PENALTY);
  const cands = leads.filter(l => open(l) || (!direction && l.recommended_at && l.match?.verdict === 'recommend' && !decidedLead(l) && !endedLead(l) && !l.superseded && !l.legacy && !l.prefilter_reason)).sort((a, b) => rank(b) - rank(a) || String(b.matched_at || '').localeCompare(String(a.matched_at || '')));
  const room = !direction ? 0 : limit == null ? cands.length : Math.max(0, limit - shown);
  return { release: cands.slice(0, room), hold: cands.slice(room).map(l => ({ l, reason: direction ? 'daily_limit' : 'no_direction' })), today, limit, shown, direction };
}
// 放出来的一句（运行日志）。
export function releaseLine(p) {
  const nums = p.release.map(l => l.number != null ? `#${l.number}` : null).filter(Boolean);
  const parts = [];
  if (p.release.length) parts.push(`今天放出 ${p.release.length} 个推荐${nums.length ? `（${nums.join('、')}）` : ''}`);
  if (p.hold.length) parts.push(p.direction ? `还有 ${p.hold.length} 个按匹配度排队，明天接着放（每天最多 ${p.limit} 个）` : `${p.hold.length} 个推荐先不放：求职方向还没选`);
  return parts.join('；');
}
