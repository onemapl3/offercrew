import { recoverPostingCompany } from './lead-fields.mjs';
// One lead through the Jev judgement: is there anything to read, do the rules
// the user taught or the quality rules retire it, what does the posting say, is
// it in range, and how does it match. bin/judge-leads.mjs owns selection,
// detail fetching and persistence; this module owns the decision, so tests run
// it against a fake Jev (lib/judge.mjs `setJudgeDriver`) without the network.
//
// A post by a person is judged from its own body. The ATS full-description
// length is not a gate any more: a three-line 脉脉 post that names a role is read
// like any JD, retired by grade, family or city when that is what it says, and
// otherwise matched. What it does not state is recorded as `needs_jd` (the
// missing parts) and named as the gap, never silently skipped.
import { decodeEntities } from './ats/http.mjs';
import { prefilter, hasFullDescription, contentKey, pendingLead, parkedForJd, policyReviewNeeded } from './matcher.mjs';
import { decidedLead, endedLead } from './lead-state.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { postReason } from './post-signals.mjs';
import { readPosting, judgeMatch, postingPrefilterReason, postingGaps, leadContent, JUDGEMENT_VERSION, questionSet } from './judgements.mjs';
import { learnedPrefilterReason } from './preferences.mjs';
import { loadJudgeConfig } from './judge.mjs';
import { offlineWanted } from './judge-offline.mjs';
import { qualityReason, headhunterFirm, headhunterCompany } from './quality.mjs';
import { politely, MAX_PER_SITE, tooSlow } from './ats/politeness.mjs';

export const HEADHUNTER_COMPANY = /^待核（猎头代招：/;
// 尚未放行的推荐不占号；实际放行在 recommend-sweep。保留调用接口。
import { numberVisibleLead } from './lead-numbering.mjs';
export function numberRecommended(row, rows, options = {}) {
  if (row?.match?.verdict === 'recommend') numberVisibleLead(row, rows, options);
  return row;
}

// The official page's own detail call, for an ATS row stored without its JD.
// 判断是并发跑的：取详情按网站排队（lib/ats/politeness.mjs），同一网站同时最多 2 路，照 robots.txt 的 Crawl-delay
// 隔开，每个网站一轮只读一次 robots.txt。只改什么时候发请求，读到的内容和判断结论不变。
// load 只给测试用：换掉适配器。
export function detailFetcher(companies, { load = (type) => import(`./ats/${type}.mjs`) } = {}) {
  return async (l) => {
    const c = companies.find((x) => x.name === l.company);
    if (!l.ats_type || !c) return;
    const adapter = await load(l.ats_type);
    if (adapter.detail) Object.assign(l, await politely(() => adapter.detail(c, l), { max: MAX_PER_SITE, robots: true }));
  };
}

// 这条线索判断前要去哪个网站取详情（按网站分队列用，lib/ats/politeness.mjs siteQueue）；已有全文、不用取的是 null。
// 只是排先后的估计：真正发请求时按实际打到的主机排队。
export const detailSite = (l) => (!hasFullDescription(l) && l.ats_type && l.url ? l.url : null);

// `fetchDetail(lead)` fills `jd_text` from the source when it can (an ATS
// adapter's detail call); it is only tried when the stored text is short.
// 网站的 robots.txt 要求两次请求隔 60 秒以上，而离上次请求还不够久、或这一轮已经取过它的一条（lib/ats/politeness.mjs
// CrawlDelayTooLong）：这一轮不取它的详情，这条线索原样留着（outcome 'skipped'，什么都不改），下一轮再看。
export async function judgeLead(l, { facts, fetchDetail = null, at = new Date().toISOString() } = {}) {
  if (!hasFullDescription(l) && fetchDetail) {
    try { await fetchDetail(l); } catch (e) {
      const slow = tooSlow(e);
      if (slow) return { outcome: 'skipped', reason: 'crawl_delay_over_cap', ...slow };
    }
  }
  if (typeof l.jd_text === 'string') l.jd_text = decodeEntities(l.jd_text);
  // A headhunter's post (lib/quality.mjs): the company line is the agency, not
  // the employer, so the lead names the agency as 待核 until the client is known.
  const priorCompany = String(l.company || ''), originalCompany = priorCompany || l.field_sources?.company || '';
  const renamed = HEADHUNTER_COMPANY.test(priorCompany) || (!priorCompany && (HEADHUNTER_COMPANY.test(originalCompany) || l.headhunter?.client_named === false));
  const firm = renamed ? l.headhunter?.firm || originalCompany.slice(8, -1) : headhunterFirm(l);
  const holds = renamed ? 'agency' : firm ? headhunterCompany(l) : null;
  if (holds === 'agency') {
    if (priorCompany) l.field_sources = { ...(l.field_sources || {}), company: l.field_sources?.company || priorCompany };
    l.company = ''; l.company_status = 'unknown';
  }
  const clientNamed = holds === 'client';
  l.headhunter = firm ? { firm, client_named: clientNamed } : null;
  Object.assign(l, recoverPostingCompany(l));
  // Cheap deterministic gates first, before any request and whatever the text:
  // the companies the user excluded, what the user taught, the quality rules.
  const learned = (excludedCompany(l) && 'company_excluded_by_user') || postReason(l) || learnedPrefilterReason(l) || qualityReason(l);
  if (learned) {
    Object.assign(l, { prefilter_reason: learned, needs_jd: null, judgement: { version: JUDGEMENT_VERSION, at, posting: null, reason: learned } });
    return { outcome: 'prefiltered', reason: learned };
  }
  const content = leadContent(l);
  if (!content.readable) {
    // Nothing a model could read. The title gates still retire what they can;
    // the lead then waits for its text to change.
    const reason = prefilter(l);
    if (reason && reason !== 'china_remote_unverified') l.prefilter_reason = reason;
    l.needs_jd = { missing: content.missing, blocking: true, key: contentKey(l), at };
    l.judgement = { version: JUDGEMENT_VERSION, at, posting: null, reason: 'needs_jd', needs_jd: content.missing };
    return { outcome: 'needs_jd', missing: content.missing, prefilter: l.prefilter_reason || null };
  }
  const posting = await readPosting(l, { request_id: `posting-${String(l.id).slice(0, 24)}` });
  l.judgement = { version: JUDGEMENT_VERSION, at, posting };
  const reason = postingPrefilterReason(posting, l) || prefilter(l);
  if (reason) {
    Object.assign(l, { prefilter_reason: reason, needs_jd: null });
    l.judgement.reason = reason;
    return { outcome: 'prefiltered', reason };
  }
  l.prefilter_reason = null;
  const gaps = { ...postingGaps(posting, l), headhunter: firm && !clientNamed ? firm : null };
  const match = await judgeMatch(l, posting, { facts, gaps, request_id: `match-${String(l.id).slice(0, 24)}` });
  // A re-judge that reaches the same verdict is not a new match: matched_at is
  // what the daily brief and metrics call "today's recommendations", so it only
  // moves for a first match or a changed verdict. rejudged_at records the run.
  const previous = l.match?.verdict || null;
  // 离线规则判的（lib/judge-offline.mjs）记成 offline，界面和日志能分出来。
  // 界面上凡是显示判断理由的地方，都要看得出这是规则判的，不是模型读过的。
  const offline = match.model === 'offline-rules';
  l.match = { ...match, ...(offline ? { reasons: [`（离线规则判断，没调用模型）${match.reasons[0]}`, ...match.reasons.slice(1)] } : {}), judged_by: offline ? 'offline' : 'jev' };
  if (!previous || previous !== match.verdict || !l.matched_at) l.matched_at = at;
  if (previous) l.rejudged_at = at;
  l.judgement.match = { verdict: match.verdict, fit: match.fit, direction_match: match.direction_match };
  l.needs_jd = gaps.missing.length ? { missing: gaps.missing, blocking: gaps.blocking, key: contentKey(l), at } : null;
  return { outcome: 'matched', verdict: match.verdict, needs_jd: gaps.blocking };
}

// Which leads a run judges: never judged, judged by an older question set or
// policy, or parked for a missing JD whose text has since changed. Leads the
// user ended stay as history; visible old-policy evidence is reviewed separately.
// 换了求职方向（软件 ↔ 金融……）的人，JD 要按新方向的那套问题重读：读过的 posting 记着它是哪套问题读的
// （通用路径 question_set: 'general'，软件方向没有这个键）。没换方向的人（作者本人）一条都不重读。
// 离线规则判过的（lib/judge-offline.mjs），一旦不再用离线规则（配上了 Jev），也要重判：规则的结论不能冒充模型的。
const offlineJudged = (l) => l.match?.judged_by === 'offline' || l.judgement?.posting?.model === 'offline-rules';
export function judgeStale(l, { rejudge = false } = {}) {
  return rejudge || !l.judgement || l.judgement.version !== JUDGEMENT_VERSION || (!!l.needs_jd && l.needs_jd.key !== contentKey(l)) || (!!l.judgement.posting && (l.judgement.posting.question_set || 'software') !== questionSet()) || (offlineJudged(l) && !offlineWanted(loadJudgeConfig()));
}

// 一次用户决定不冻结判断证据。升级复查只写判断字段，绝不重放联系/投递、不撤回批准。
export function judgeWanted(l, { rejudge = false, feedbackIds = new Set() } = {}) {
  if (l.legacy || l.superseded || l.status === 'superseded' || endedLead(l)) return false;
  if (policyReviewNeeded(l)) return true;
  return (pendingLead(l) || (parkedForJd(l) && !decidedLead(l) && !l.feedback_at) || (l.match && !decidedLead(l))) && !feedbackIds.has(l.record_id || l.id) && judgeStale(l, { rejudge });
}
