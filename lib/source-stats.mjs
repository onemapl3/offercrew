// 按来源算推荐准不准（负责人 10-10：「要做的是让算法更精准，而不是把来源屏蔽掉」）。
// 来源一个都不关：每个来源推荐过几个、你后来留下几个、不推进或被排除几个；长期不准的来源，推荐放出来的时候排后（lib/recommend-gate.mjs），
// 判断挑先判谁的时候也排后（bin/match.mjs）。设置 · 求职偏好 · 岗位来源一页列出每个来源推荐过、你留下、不要几个（web/settings/prefs.js）。
//
//   来源      和设置里的开关同一张表（lib/discovery-policy.mjs DISCOVERY_SOURCES）：官网抓的、各平台、各真人帖站点。你转发的不算哪个来源。
//   推荐过    Judge 判成推荐的（过了推荐线；被推荐线压下去的 below_line 也算 Judge 推荐过——那是推荐线的事，不是来源的事，不算）。
//             只算 Judge 推荐、过了线的：现在是推荐，或者推荐放出来过（recommended_at）。
//   留下      你往下推了：批准投递、联系、投了、回复、面试……（线索不再是「新」，也没被你不推进）。
//   不要      你点了不投 / 不推进、归档，或者后来被判排除、批准被收起来（不在方向里）。
//   还没定    别的（还在新线索里）。不算准也不算不准。
// 长期不准：定了的（留下 + 不要）至少 MIN_DECIDED 个，留下的不到 LOW_KEEP。只排后，不关。
import { DISCOVERY_SOURCES } from './discovery-policy.mjs';
import { decidedLead, closedByUser } from './lead-state.mjs';

export const MIN_DECIDED = 8;
export const LOW_KEEP = 0.25;
// 排后多少：放推荐时按「匹配度 - 这么多」排（同一天里分数差 15 分以内的，准的来源先）；判断挑先后时优先分减这么多。
export const RELEASE_PENALTY = 15;
export const MATCH_PENALTY = 40;

const PLATFORM = { 脉脉: 'maimai', linkedin: 'linkedin', LinkedIn: 'linkedin', boss: 'boss', xiaohongshu: 'xiaohongshu', 小红书: 'xiaohongshu' };
// 一条线索是哪个来源找来的（DISCOVERY_SOURCES 的键）；你转发的、认不出的：null。
export function sourceKeyOf(l = {}) {
  const s = String(l.source || '');
  if (Object.hasOwn(DISCOVERY_SOURCES, s) && s !== 'official') return s;
  if (Object.hasOwn(PLATFORM, s)) return PLATFORM[s];
  if (/^official/.test(s) || l.ats_type) return 'official';
  if (/Boss直聘/.test(l.source_type || '')) return 'boss';
  return null;
}
const recommended = l => l.match?.verdict === 'recommend' || (!!l.recommended_at && !l.match?.below_line);
const dropped = l => closedByUser(l) || l.match?.verdict === 'exclude' || l.auto_apply?.status === 'closed';
const kept = l => !dropped(l) && (decidedLead(l) || !!l.auto_apply?.approved_at || !!l.auto_apply?.user_requested_at);
// { <来源>: { recommended, kept, dropped, low } }：只列有推荐过的来源。
export function sourceStats(leads = []) {
  const out = {};
  for (const l of leads) {
    if (!l || l.superseded || l.legacy || !recommended(l)) continue;
    const k = sourceKeyOf(l);
    if (!k) continue;
    const s = (out[k] ||= { recommended: 0, kept: 0, dropped: 0, low: false });
    s.recommended++;
    if (dropped(l)) s.dropped++; else if (kept(l)) s.kept++;
  }
  for (const s of Object.values(out)) { const d = s.kept + s.dropped; s.low = d >= MIN_DECIDED && s.kept / d < LOW_KEEP; }
  return out;
}
// 这一条的来源要不要排后：返回要减的分（不排后是 0）。
export const penaltyOf = (l, stats, amount) => (stats[sourceKeyOf(l)]?.low ? amount : 0);
