// 首轮结果和「待核」差在哪（2026-10-02，Mac 开箱测试第 2 轮 N13；第 3 轮负责人改了规矩）。
//   新用户的首轮（op round-first，web/onboarding.js 引导结束时跑）多半判出一片「待核」：判断规则规定资格里有一项不明、
//   或者一条关键要求说不清，最多只能判待核（lib/matcher.mjs validateMatch、lib/judgements.mjs）。
//   第 3 轮负责人（10-02）：指挥台顶上只放挡路的大事；要你动手的进收件箱；进度进运行日志。所以首轮不再在指挥台顶上挂一行，
//   这里算的东西给三个地方用：
//     verifyGap / verifyGaps 一条待核还差什么：短词（行上的「Java 待核」）、归哪一类（数「多半卡在」）、能不能在资料里补（fill，
//                            资料编辑器的哪一组，web/setup.js SCOPES）。以前所有「某条要求说不清」都算一类、拿第一条的原话当
//                            主要原因，于是说成「主要原因是熟练掌握Java集合、…待核」——14 条里其实只有 1 条是它（第 3 轮）。
//     firstRoundAsk          收件箱里一封信：首轮里要你补信息才能判的有几个、多半卡在哪，带「补充」。不用你动手就不来信。
//     firstRoundSummary      对话里你问「现在怎么样」时说的那一句（lib/talk.mjs statusDigest），和信上的数一致。
//     backlogText            还没判的有多少、什么时候判：写进运行日志（bin/match.mjs），对话里也说这一句。
//   补上以后只重判因为这一项待核的那几条（rejudgeReady）：判断时记下能补的缺口（fillGaps，bin/match.mjs 写进 match.fill），
//   技能看补的是不是缺的那一项，工作经历、教育经历看那一组改没改；工作许可照旧看 missing_facts。老的判断上没有这些记号，
//   补资料不会把几百条旧的待核翻出来重判。
import { createHash } from 'node:crypto';
import { pendingLead, CONFIRM_TEXT } from './matcher.mjs';
import { read } from './store.mjs';
import { appSchedules } from './capabilities.mjs';
import { appSchedule } from './app-schedule.mjs';
import { TZ } from './tz.mjs';
import { techsIn, hasSkill, anyOfSatisfied, yearsDomains, softSkill } from './tech-words.mjs';
import { workAuthStated, NOT_STATED } from './work-auth.mjs';
import { decidedLead } from './lead-state.mjs';
import { errorReason } from './say-error.mjs';
import { redact } from './error-evidence.mjs';

const cut = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const WORK_AUTH = 'work_authorization';
// 资料里写了任何一项工作许可（中国大陆、美国、海外远程……）就算写了（lib/work-auth.mjs workAuthStated）。
export const hasWorkAuth = workAuthStated;
const unknown = v => !v || /unknown|待核|未知/i.test(String(v));
// 判断完记下：资料里缺了什么（只记会让资格变成「不明」的那几项，现在只有工作许可）。
export const missingFacts = (facts = {}) => hasWorkAuth(facts) ? [] : [WORK_AUTH];
// 你处理过、已经结束的线索不重判，也不再为它来信。
const settled = l => !!(decidedLead(l) || l.feedback_at || l.legacy || l.superseded || l.auto_apply);

// ── 一条要求说不清，归哪一类 ─────────────────────────────────────────────────
// 技术名：要求里写的、你资料里的技能没有的那一个（lib/tech-words.mjs）。「Java、Go、PHP 之一」而你会 Go，这一条就不算缺。
const YEARS = /(\d+|[一二两三四五六七八九十]+)\s*年(?:以上|及以上)?|工作年限|年限|years?\s+of/i;
const DEGREE = /学历|本科|硕士|博士|研究生|统招|学位|专业|degree|bachelor|master|ph\.?\s?d/i;
const DOMAIN = /(行业|领域|游戏|保险|金融|医疗|电商|音视频|直播|广告|支付|教育|汽车|芯片|物流|跨境)[^，,；;。]{0,12}(经验|背景|经历)|(经验|背景|经历)[^，,；;。]{0,6}(行业|领域)/;
// 一类：key 数个数、text 行上的短词、label 信上的说法、fill 资料编辑器的哪一组、fill_label 按钮上补什么。
export function gapOf(req = '', facts = {}) {
  const r = String(req);
  if (/远程.*(?:中国|地区|地点)|remote.*(?:china|location|region)/i.test(r)) return { key: 'remote', text: '远程工作地区', label: '远程工作地区', employer: true };
  if (/工作地点|目标城市|搬迁|relocat/i.test(r)) return { key: 'location', text: '工作城市', label: '能否去岗位所在城市', fill: 'location', fill_label: '城市' };
  if (r.length > 180 || /\n/.test(r)) return { key: 'other', text: '具体岗位要求', label: '当前判断未拆清具体要求' };
  if (softSkill(r)) return null;
  // 年限那一句点了你会的技术（「3 年以上 Golang 开发经验」，开箱第 4 轮 F07）：说不清的是这门技术用了几年，不是总年限。
  if (YEARS.test(r) && /经验|经历|工作|years?\s+of/i.test(r)) { const t = techsIn(r).find(name => hasSkill(facts, name)), d = yearsDomains(r)[0]?.domains[0]; if (!t && d) return { key: `years:${d}`, text: `${d}年限`, label: `${d}相关经历的年限`, fill: 'experience', fill_label: '工作经历' }; return t ? { key: `years:${t.toLowerCase()}`, text: `${t} 年限`, label: `${t} 的使用年限`, fill: 'experience', fill_label: '工作经历' } : { key: 'years', text: '年限', label: '工作年限', fill: 'experience', fill_label: '工作经历' }; }
  if (DEGREE.test(r)) return { key: 'degree', text: '学历', label: '学历或专业', fill: 'education', fill_label: '教育经历' };
  if (anyOfSatisfied(r, facts)) return null;
  const missing = techsIn(r).find(name => !hasSkill(facts, name));
  if (missing) return { key: `skill:${missing.toLowerCase()}`, text: missing, label: missing, skill: missing, fill: 'skills', fill_label: `技能（${missing}）` };
  if (DOMAIN.test(r)) return { key: 'domain', text: '行业经验', label: '相关行业经验', fill: 'experience', fill_label: '工作经历' };
  return { key: 'other', text: cut(r, 10), label: cut(r, 16) };
}
// 老 Jev 已把帖子缺 JD、代招客户未披露记在 biggest_gap；这些是来源缺口，不是个人能力要求。
export function postingUnknowns(l = {}) {
  const gap = String(l.match?.biggest_gap || ''), out = [];
  const missingJd = !!l.needs_jd?.blocking || /^JD\s*待补[：:]/i.test(gap);
  if (missingJd) out.push({ key: 'jd', text: /帖子|发帖人/.test(gap) || /真人|帖/.test(l.source_type || '') ? '帖子缺职责和任职要求，向发帖人索取完整 JD' : '页面缺完整 JD，打开原链接核对职责和任职要求' });
  if (/猎头代招[，,；; ]*客户公司待核|猎头代招.*客户公司(?:不明|未披露)/.test(gap)) out.push({ key: 'client_company', text: '猎头代招，向发帖人确认客户公司' });
  return out;
}
// 一条待核所有说不清的地方（每类只算一次）：资格（工作许可、地点、远程、签证）、年限，再加每一条关键要求。
export function verifyGaps(l = {}, facts = {}) {
  const m = l.match || {}, e = m.eligibility || {}, out = new Map();
  const add = g => { if (!out.has(g.key)) out.set(g.key, g); else if (g.requirement && !out.get(g.key).requirement) out.set(g.key, { ...out.get(g.key), requirement: g.requirement }); };
  if (e.work_auth != null && unknown(e.work_auth)) add(hasWorkAuth(facts) ? { key: 'work_auth', text: '工作许可', label: '工作许可' } : { key: 'work_auth', text: '工作许可', label: '工作许可', fill: 'auth', fill_label: '工作许可', missing: true });
  if (m.seniority_gap) add({ key: 'years', text: '年限', label: '工作年限', fill: 'experience', fill_label: '工作经历' });
  if (m.visa) add({ key: 'visa', text: '签证', label: '签证' });
  if (e.location != null && unknown(e.location)) add(l.location && !/未知|待核|未标注|远程|remote/i.test(l.location) ? { key: 'location', text: '工作城市', label: `能否去${cut(l.location, 30)}工作`, fill: 'location', fill_label: '城市' } : { key: 'location', text: '工作地点', label: '工作地点', employer: true });
  if (e.remote_china != null && unknown(e.remote_china)) add({ key: 'remote', text: '远程工作地区', label: '远程是否允许在中国大陆工作', employer: true });
  // 没填工作许可、JD 又明确要求的那一条（B 方案）：缺的就是工作许可，补的入口是「补充工作许可」。
  if ((m.must_haves || []).some(r => r.work_auth_unstated && r.status === 'unknown')) add(hasWorkAuth(facts) ? { key: 'work_auth', text: '工作许可', label: '工作许可' } : { key: 'work_auth', text: '工作许可', label: '工作许可', fill: 'auth', fill_label: '工作许可', missing: true });
  for (const r of (postingUnknowns(l).some(g => g.key === 'jd') ? [] : m.must_haves || [])) if (r.status === 'unknown' && r.critical !== false && !r.work_auth_unstated) { const g = String(r.req || '').trim() === String(l.role || '').trim() ? { key: 'other', text: '具体岗位要求', label: '当前判断只写了岗位名，未拆清具体要求' } : gapOf(r.req, facts); if (g) add({ ...g, ...(!/未拆清/.test(g.label) ? { requirement: cut(r.req, 300) } : {}) }); }
  return [...out.values()];
}
// 「补信息」必须带着这条岗位缺什么、补在哪；来源缺口不冒充个人资料缺失。
export function profileGap(l = {}, facts = {}) {
  if (l?.match?.verdict !== 'verify' || rejudgeReady(l, facts)) return null;
  const g = verifyGaps(l, facts).find(x => x.fill);
  if (!g) return null;
  const targets = {
    skills: { field: 'skills', instruction: `如果会${g.skill ? ` ${g.skill}` : '这项技能'}，在技能中补充；只写确实掌握的内容。` },
    location: { field: 'location.target_cities', instruction: `岗位地点是${l.location || '待确认'}。愿意去的话，把该城市补进目标城市；也可以说明搬迁条件。` },
    auth: { field: /美国|\bUS\b|United States/i.test(`${l.location || ''} ${g.requirement || ''}`) ? 'work_authorization.us' : /远程|remote/i.test(l.location || '') ? 'work_authorization.overseas_remote' : 'work_authorization.china_mainland', instruction: '填写实际持有的工作许可；招聘方的签证政策仍需向对方核实。' },
    experience: { rows: 'experience', row_field: g.key.startsWith('years') ? 'start' : 'highlights', instruction: g.key.startsWith('years') ? '核对相关工作的开始、结束时间，并写清对应职责；现职可在下方补充，不把未工作的时间计入。' : '在对应工作经历的「做了什么」里补充具体项目、职责与结果。' },
    education: { rows: 'education', row_field: 'degree', instruction: '核对学位与专业，并补充实际教育经历。' },
  };
  return { scope: g.fill, context: { lead: [l.number != null && `#${l.number}`, l.company, l.role].filter(Boolean).join(' · '), reason: g.missing ? '工作许可没填' : `${g.requirement || g.label}：现有资料还不能确认`, ...targets[g.fill] } };
}
const statedGap = l => {
  const text = String(l.match?.biggest_gap || '').trim();
  return text && !/^(?:无|暂无|没有)(?:明确)?(?:缺口|差距)?[。.!！]?$|^(?:none|n\/a|unknown)$/i.test(text) ? cut(text, 500) : '';
};
// 主人做决定时看到、批准时保存同一份待核点；不把雇主未披露的信息说成简历缺失。
export function decisionPoints(l = {}, facts = {}) {
  const points = [...postingUnknowns(l), ...verifyGaps(l, facts).map(g => ({ ...g, text: g.employer ? `${g.label}：JD 没写，联系时问一下` : g.missing ? '工作许可没填，可补信息或联系时核实' : g.fill ? `${g.requirement || g.label}：资料还不能确认，可补信息或联系时核实` : `${g.requirement || g.label}：联系时核实` }))];
  const bl = l.match?.below_line;
  if (bl) points.unshift({ key: 'below_line', text: bl.score == null ? '当前判断算不出匹配度' : `匹配度 ${bl.score}，未过推荐线 ${bl.line}` });
  if (!points.length && l.match?.verdict === 'verify') {
    const failure = l.match_error_final || l.match_error;
    points.push(statedGap(l) ? { key: 'other', text: statedGap(l) } : failure ? { key: 'judge_error', text: `判断未完成：${errorReason(redact(failure))}` } : { key: 'other', text: '这次判断未列出具体待核要求，查看岗位详情后再决定' });
  }
  return points;
}
// 一条待核还差什么（行上那个短词、岗位页上的「补信息」）：第一条说不清的地方。
// rejudge：补上以后的重判什么时候跑（rejudgeState，调用方一次算好传进来）；不传就只说「等重新判断」。
export function verifyGap(l = {}, facts = {}, rejudge = null) {
  const source = postingUnknowns(l), gaps = verifyGaps(l, facts), fill = gaps.find(g => g.fill)?.fill;
  if (source.length) return { key: source[0].key, text: source.map(p => p.text).join('；'), title: source.map(p => p.text).join('；'), fill };
  if (rejudgeReady(l, facts)) return { key: 'rejudge', text: rejudgeText(rejudge) };
  const g = gaps[0] && { ...gaps[0], ...(fill ? { fill } : {}) };
  // Judge 说推荐、匹配度没到推荐线（lib/recommend-gate.mjs）：行上说分数，补资料的入口照旧跟着第一条说不清的地方。
  const bl = l.match?.below_line;
  if (bl) return { ...(g || {}), key: g?.key || 'below_line', text: bl.score == null ? '匹配度算不出' : `匹配度 ${bl.score} 没过线` };
  if (!g) return decisionPoints(l, facts)[0] || { key: 'other', text: '条件待核' };
  if (g.key === 'work_auth') return g.missing ? { ...g, text: '工作许可没填' } : { ...g, text: '工作许可待核' };
  if (g.key === 'years' && l.match?.seniority_gap) return { ...g, text: '年限不够' };
  return { ...g, text: `${g.text}${/[A-Za-z+#]$/.test(g.text) ? ' ' : ''}待核` };
}
// 推荐里还要你看一眼的（第 3 轮负责人 10-02，判断规则 1、2）：只差一项关键要求看不出来（文字模型那条路写在 match.confirm；
// Jev 那条路是唯一一条关键要求待核），或者年限差 1 年以内（seniority_gap「年限差一点」）。行上写短词（「Kafka 请确认」
// 「年限差一点」），悬停是整句；岗位页的「主要缺口」写整句（biggest_gap）。别的推荐：null。
export function recommendNote(l = {}, facts = {}) {
  const m = l.match;
  if (m?.verdict !== 'recommend') return null;
  const unknown = (m.must_haves || []).filter(r => r.status === 'unknown' && r.critical !== false && !r.tenure_gap);
  const open0 = m.confirm || (unknown.length === 1 ? unknown[0] : null), open = open0 && !softSkill(open0.req) ? open0 : null, close = /^年限差一点/.test(m.seniority_gap || '') ? m.seniority_gap : null;
  if (!open && !close) return null;
  const g = open ? gapOf(open.req, facts) : null, word = g ? `${g.text}${/[A-Za-z+#]$/.test(g.text) ? ' ' : ''}请确认` : open ? '有一项请确认' : null;
  return { text: [word, close && '年限差一点'].filter(Boolean).join('，'), title: [open && (g?.employer ? `${g.label}：JD 没写，联系时问一下` : g?.key === 'other' && /未拆清/.test(g.label) ? g.label : `${CONFIRM_TEXT}：${open.req}`), close].filter(Boolean).join('；') };
}

// ── 补上以后只重判这几条 ───────────────────────────────────────────────────
const sigOf = v => createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);
// 工作经历：资料编辑器写进 current_work 和 career_highlights.entries（lib/profile.mjs）。以前这里读的是 experience / current /
// work_experience 三个不存在的键，补了经历也永远看不出改过（开箱第 4 轮 F06 顺带查到）。那时记下的记号（三个空值）不知道补之前
// 是什么样，不拿它当「改过了」，免得几百条旧的待核一下子翻出来重判。
const GROUP = { experience: f => [f?.current_work, f?.career_highlights?.entries], education: f => f?.education, location: f => f?.location };
const LEGACY_EXPERIENCE_SIG = sigOf([null, null, null]);
// 判断时记下：这条待核能在资料里补的缺口，补技能的记缺哪一项，补经历、学历的记那一组当时的样子（bin/match.mjs 写进 match.fill）。
export function fillGaps(match = {}, facts = {}, lead = {}) {
  if (match.verdict !== 'verify') return [];
  return verifyGaps({ ...lead, match }, facts).filter(g => g.fill && g.fill !== 'auth').map(g => g.skill ? { key: g.key, scope: g.fill, skill: g.skill } : { key: g.key, scope: g.fill, sig: sigOf(GROUP[g.fill]?.(facts)) });
}
export function rememberLocationGap(l, facts, changes = []) {
  if (l.match?.verdict !== 'verify' || settled(l) || l.match.fill?.some(g => g.scope === 'location') || !verifyGaps(l, facts).some(g => g.fill === 'location')) return false;
  const changed = changes.filter(c => c.path?.startsWith('location.'));
  if (!changed.length) return false;
  const before = { ...facts?.location };
  for (const c of changed) before[c.path.slice('location.'.length)] = c.from;
  l.match.fill = [...(l.match.fill || []), { key: 'location', scope: 'location', sig: sigOf(before) }];
  return true;
}
// 这条待核当时因为资料里缺的东西才没判成推荐，现在补上了：重新判断（保存资料时马上起，lib/command-center.mjs rejudgeFilled；
// 下一轮周期也会判）。工作许可看 missing_facts；技能看缺的那一项现在有没有；经历、学历看那一组改没改。你处理过的不动。
export function rejudgeReady(l = {}, facts = {}) {
  if (l.match?.verdict !== 'verify' || settled(l)) return false;
  // 工作许可补上了：当时因为它待核的重判（资格结论待核，或者 JD 明确要求、你没填的那一条；两条路都看 must_haves 上的记号）。
  if (hasWorkAuth(facts) && (((l.match.missing_facts || []).includes(WORK_AUTH) && (unknown(l.match.eligibility?.work_auth) || l.match.eligibility?.work_auth === NOT_STATED)) || (l.match.must_haves || []).some(r => r.work_auth_unstated))) return true;
  return (l.match.fill || []).some(g => g.skill ? hasSkill(facts, g.skill) : GROUP[g.scope] && !(g.scope === 'experience' && g.sig === LEGACY_EXPERIENCE_SIG) && g.sig !== sigOf(GROUP[g.scope](facts)));
}

// 补上以后的重判什么时候跑（开箱第 4 轮 F06）：保存资料时马上起「重新判断」（lib/command-center.mjs rejudgeFilled）；那时手上
// 有别的在跑（首轮、周期占着写锁），记一笔 state/rejudge-pending.json，它一跑完工作台就起（rejudgePendingTick）。
//   running：重新判断正在跑；pending：等手上这一轮跑完就起；scheduled：都不是（重判过这条但没判成、或资料不是经工作台改的），
//   下一档定时周期会判它（bin/match.mjs 的 due 带 rejudgeReady），at 是那一档的钟点。
export const REJUDGE_PENDING = 'state/rejudge-pending.json';
export function rejudgeState(now = Date.now()) {
  if (read('state/ops.json', {})?.current?.op === 'rejudge-filled') return { key: 'running' };
  if (read(REJUDGE_PENDING, null)) return { key: 'pending' };
  return { key: 'scheduled', at: nextSlot(appSchedule().find(j => j.name === 'cycle')?.times, now) };
}
const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
// 今天还没到的第一档；都过了就是明天第一档。
export function nextSlot(times = ['09:05', '13:05', '18:05'], now = Date.now()) {
  const t = [...(times || [])].sort(), cur = hhmm(now);
  return t.length ? t.find(x => x > cur) || t[0] : null;
}
export function rejudgeText(r = null) {
  if (r?.key === 'running') return '已补，正在重新判断';
  if (r?.key === 'pending') return '已补，手上这轮跑完就重判';
  if (r?.key === 'scheduled' && r.at) return `已补，${r.at} 那一档重判`;
  return '已补，等重新判断';
}

// ── 首轮 ─────────────────────────────────────────────────────────────────
const at = t => Date.parse(t || '');
// 最近一次跑完的首轮（state/ops.json 的 round-first），7 天以内；在跑的时候不算。判了的 = 这一轮里（开始到结束之间）落了判断的线索。
// System 讲「为什么推荐是 0」也按这一批数（lib/system/explain.mjs）。
export function firstRound({ ops = {}, leads = [], now = Date.now() } = {}) {
  if (ops?.current?.op === 'round-first') return null;
  const rec = (ops?.history || []).find(h => h.op === 'round-first' && h.finished_at);
  if (!rec) return null;
  const from = at(rec.started_at), to = at(rec.finished_at) + 5000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || now - to > 7 * 86400000) return null;
  const live = leads.filter(l => !l.superseded);
  return { rec, live, judged: live.filter(l => l.match?.verdict && at(l.matched_at) >= from && at(l.matched_at) <= to) };
}
const PHRASE = { years: '简历里看不出工作年限够不够', degree: '简历里看不出学历或专业', domain: '简历里看不出相关行业经验', work_auth: '工作许可没填' };
const phrase = g => g.skill ? `简历里看不出 ${g.skill} 的经验` : PHRASE[g.key] || g.label;
// 首轮里要你补信息才能判的：还待核、你没处理过、至少一个缺口能在资料里补。按类数（一条每类算一次），过半的那一类就是「多半卡在」。
function needYou(judged = [], facts = {}) {
  const need = judged.filter(l => l.match.verdict === 'verify' && !settled(l)).map(l => ({ l, gaps: verifyGaps(l, facts).filter(g => g.fill) })).filter(x => x.gaps.length);
  const counts = new Map();
  for (const { gaps } of need) for (const g of gaps) { const c = counts.get(g.key) || counts.set(g.key, { ...g, count: 0 }).get(g.key); c.count++; }
  const top = [...counts.values()].sort((a, b) => b.count - a.count);
  return { need, top, main: top[0] && top[0].count * 2 >= need.length ? top[0] : null };
}
const option = (key, label, steps, extra = {}) => ({ key: String(key), label, steps, ...extra });
// 收件箱里的一封信（lib/ask-actions.mjs inboxView）：「第一轮看了 15 个岗位，14 个要你补一点信息才能判」，多半卡在哪，带「补充」。
// 没有要你补的（都推荐了、都排除了、缺的不是资料里能补的）就不来信。补上以后相关的重判，这封信跟着变或消失；「先不补」一周内不再问。
export function firstRoundAsk({ ops = {}, leads = [], facts = {}, now = Date.now() } = {}) {
  const fr = firstRound({ ops, leads, now });
  if (!fr) return null;
  const { need, top, main } = needYou(fr.judged, facts);
  if (!need.length) return null;
  const why = main ? `多半卡在：${phrase(main)}` : `卡在：${top.slice(0, 3).map(g => `${g.label}（${g.count} 个）`).join('、')}`;
  const fills = [...new Map((main ? [main] : top.slice(0, 3)).map(g => [g.fill_label, g])).values()];
  // 「看这 N 个」：指挥台只列这几条（web/hq.js only=first-round，名单是 /api/hq 的 first_round_need，和这里同一个 needYou）。
  // 以前按编号列（&n=12-15-20），可待核的线索判的时候不编号（只有推荐的编号，lib/judge-leads.mjs numberRecommended），
  // 于是总是退回整个待核标签：信里说 8 个，点开是待核 9 个（第 5 轮）。
  return {
    from: 'lens', id: `first-round:${fr.rec.finished_at}`, type: 'info', title: '第一轮的结果',
    // 几处的数对得上（第 4 轮：首轮说 15 个、指挥台「全部」14、这里 4 个、指挥台待核 11）：写全推荐 / 待核 / 排除，
    // 排除的不进指挥台；这里的几个是待核里补一项资料就能重判的。
    question: `第一轮判了 ${fr.judged.length} 个：${verdictWords(fr.judged)}。待核里有 ${need.length} 个，补一项资料就能重新判断。`, context: [why],
    options: [
      ...fills.map((g, i) => option(i + 1, `补充${g.fill_label}`, [{ type: 'profile_editor', scope: g.fill }], { hint: '补上以后，因为这一项待核的会重新判断', ...(i === 0 ? { primary: true } : {}) })),
      option(fills.length + 1, `看这 ${need.length} 个`, [{ type: 'navigate', to: '#command?tab=all&only=first-round' }]),
      option(fills.length + 2, '先不补', [{ type: 'snooze', hours: 24 * 7 }]),
    ],
    batch: 'first-round', count: need.length,
  };
}
// 「看这 N 个」那几条的记录号（指挥台 only=first-round 用）：和信里的 N 是同一个 needYou 算的，说几个就列几个。
export function firstRoundNeedIds({ ops = {}, leads = [], facts = {}, now = Date.now() } = {}) {
  const fr = firstRound({ ops, leads, now });
  return fr ? needYou(fr.judged, facts).need.map(x => x.l.record_id || x.l.id) : [];
}
// 对话里「现在怎么样」说的那一句（lib/talk.mjs statusDigest）：在跑的时候不给（那时说进度）；你处理过其中一条、下一批判断开始了、
// 或者过了 7 天，就不再说。
export function firstRoundSummary({ ops = {}, leads = [], facts = {}, progress = null, now = Date.now() } = {}) {
  const fr = firstRound({ ops, leads, now });
  if (!fr) return null;
  if (progress && at(progress.started_at) > at(fr.rec.finished_at) + 5000) return null;
  if (fr.judged.some(l => decidedLead(l) || l.feedback_at || l.auto_apply?.approved_at)) return null;
  const verdicts = { recommend: 0, verify: 0, exclude: 0 };
  for (const l of fr.judged) if (Object.hasOwn(verdicts, l.match.verdict)) verdicts[l.match.verdict]++;
  const { need, main } = needYou(fr.judged, facts);
  const left = fr.live.filter(l => pendingLead(l) && !l.prefilter_reason && !l.match_error_final).length;
  return { judged: fr.judged.length, verdicts, need: need.length, reason: main, left, finished_at: fr.rec.finished_at };
}
// 「第一轮看了 15 个岗位：推荐 0，待核 14，排除 1」（「排除」和指挥台的标签同一个词）。
export function firstRoundLine(s) {
  if (!s) return '';
  const v = s.verdicts;
  return `第一轮判了 ${s.judged} 个：推荐 ${v.recommend}，待核 ${v.verify}，排除 ${v.exclude}${v.exclude ? '（排除的不放进指挥台）' : ''}${s.need ? `；待核里 ${s.need} 个补一项资料就能重新判断${s.reason ? `，多半卡在：${phrase(s.reason)}` : ''}` : ''}`;
}
// 「推荐 3、待核 11、排除 1（排除的不放进指挥台）」：只写有的。
function verdictWords(judged) {
  const n = { recommend: 0, verify: 0, exclude: 0 };
  for (const l of judged) if (Object.hasOwn(n, l.match?.verdict)) n[l.match.verdict]++;
  const parts = [['recommend', '推荐'], ['verify', '待核'], ['exclude', '排除']].filter(([k]) => n[k]).map(([k, w]) => `${w} ${n[k]}`);
  return parts.join('、') + (n.exclude ? '（排除的不放进指挥台）' : '');
}
// 还没判的有多少、什么时候判（运行日志、对话）。times：定时完整周期的钟点；app：桌面版（App 开着时才跑）；limit：每轮判几个；
// economy：省钱档，要你先按标题挑。
export function backlogText({ left = 0, times = ['09:05', '13:05', '18:05'], app = false, limit = 40, economy = false } = {}) {
  if (!left) return '';
  if (economy) return `还没判的 ${left} 个：要你先按标题挑，留下的才判`;
  return `还没判的 ${left} 个：${app ? 'App 开着时' : ''}每天 ${times.join('、')} 各判 ${limit} 个`;
}
// 按这台机器现在的设置说：定时周期的钟点（桌面版是 App 的定时，App 开着才跑）、每轮判几个、是不是省钱档。
export function backlogNow(left) {
  const p = read('config/pipeline.json', {}) || {};
  return backlogText({ left, times: appSchedule().find(j => j.name === 'cycle')?.times, app: appSchedules(), limit: Number(p.match_limit) || 40, economy: p.spend_tier === 'economy' });
}
