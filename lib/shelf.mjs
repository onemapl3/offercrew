// 收起来的线索（0.1.9 R4，负责人 10-10）：不是岗位的、不对口的，不占指挥台「全部」、各标签、收件箱和对话里报的数，
// 收在「全部」最后「收起的 N 条」里，点开还看得到。
//
//   不是岗位  求职者自己的帖（「本人履历为……」、open to work，lib/post-signals.mjs），判断读成「不是招聘帖」、发帖的不是直招。
//   不对口    规则筛掉的（prefilter_reason，按当时的规则）、Judge 判排除、方向不对（direction_match === false）、你排除了的公司、
//             按你现在的规则不该投的（lib/matcher.mjs outOfScopeNow：老版本判的「待核」，标题就是资深岗之类）。
//
// 已经真的发生过的不收：发出去了、投了、对方回了、面试、Offer、被拒——那是你的记录，照常在原来的标签里。
// 批准过、草稿写好了、停在「需本人投递」都还没发生：照样收（实测 #515 转发进来判了不是工程类，被批量批准后停在需本人投递）。
// 纯函数：只看这条线索和规则，不写。
import { postReason, seekerPost } from './post-signals.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { leadState } from './lead-state.mjs';
import { outOfScopeNow } from './matcher.mjs';
import { coName, coTbd } from './vocab.mjs';

export const SHELF = { not_job: '不是岗位', off: '不对口' };
const NOT_JOB = new Set(['not_a_job_post', 'human_not_direct_hiring']);
// 「远程岗位没确认能在国内做」是待核的一种，不算筛掉。
const SOFT = new Set(['china_remote_unverified']);
const HAPPENED = new Set(['contacted', 'applied', 'replied', 'interview_scheduled', 'interview_done', 'offer', 'rejected']);
export const happened = (l = {}) => HAPPENED.has(leadState(l)) || l.auto_apply?.status === 'submitted' || !!l.replied_at || !!l.interview_at || !!l.offer_at;

// 公司那一格装的其实是一段自我介绍（「待核（本人履历为 Example Gene Tech / 示例基因）」）。
const SELF = /本人(?:履历|简历|求职|情况)|个人(?:履历|简历)|我的(?:履历|简历)|求职意向/;
export const selfIntro = (l = {}) => SELF.test(String(l.field_sources?.company || l.company || '')) || (coTbd(l.company) && seekerPost({ title: coName(l.company) }));

const prefilterOf = l => l.prefilter_reason || l.prefilter?.reason || null;
// → null | { kind: 'not_job' | 'off', why }
export function shelfOf(l = {}, { live = true } = {}) {
  if (!l || l.superseded || happened(l)) return null;
  const pre = prefilterOf(l);
  if (NOT_JOB.has(pre) || selfIntro(l) || postReason(l) === 'not_a_job_post') return { kind: 'not_job', why: pre === 'human_not_direct_hiring' ? '发帖的不是直招' : '求职者自己的帖子' };
  if (pre && !SOFT.has(pre)) return { kind: 'off', why: pre };
  if (l.match?.verdict === 'exclude') return { kind: 'off', why: 'exclude' };
  if (l.match?.direction_match === false) return { kind: 'off', why: 'direction' };
  if (excludedCompany(l)) return { kind: 'off', why: 'company_excluded_by_user' };
  if (live) { try { if (outOfScopeNow(l)) return { kind: 'off', why: 'rules_now' }; } catch {} } // 兜底：规则读不了这一条就不收
  return null;
}
export const shelved = (l, o) => !!shelfOf(l, o);
