import { previousContact } from './recipient-contact.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { selectCityQuota } from './city-quota.mjs';
import { citySprint, sprintAllows } from './city-sprint.mjs';
// Reacher: the outbound role of the command room.
//
// Individual letters already have their own cards (journey kind `send`). What was
// missing is the batch: every time bin/auto-apply.mjs finishes a round, the user
// wants one card saying what actually went out, what was skipped and why, and
// what still needs them (plans/20260915-command-room.md §二). The receipt in
// state/outbound.ndjson is the only proof of a submission; a queued row is never
// counted as one.
import { read, write, lines, hash, file } from './store.mjs';
import { md } from './personas.mjs';
import { briefLine, briefRequirements, jdDigest } from './job-brief.mjs';
import { leadKey } from './journey.mjs';
import { preferenceScore } from './preferences.mjs';
import { applyWord, unifyChannel, applyUrl, leadCity, cityRank, titleExcluded, applyPolicy, autoApplyReady, autoApplyExhausted, autoSubmittable, CHANNEL_LABEL, applyChannel, AUTO_APPLY_MAX_ATTEMPTS } from './apply-channel.mjs';
import fs from 'node:fs';
import { TZ } from './tz.mjs';
import { primaryCity } from './city.mjs';
import { approvalBlocker, heldRec } from './recommend-gate.mjs';
import { prefilter } from './matcher.mjs';
const OFF_DIRECTION = new Set(['non_software_role', 'outside_target_specialty', 'excluded_role']); // 同 lib/inbox-recheck.mjs OFF_DIRECTION
const offDirection = l => { try { return OFF_DIRECTION.has(prefilter(l)); } catch { return false; } }; // 兜底：规则读不了这一条就照旧放进清单，由你决定
import { leadApplyWords } from './apply-words.mjs';
import { passedLead } from './lead-state.mjs';

export const AUTO_CHANNELS = new Set(['ats_form', 'portal','portal_bytedance','portal_sensetime','portal_netease']);
const day = at => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(at));


// Nothing is submitted until the user says so. This is the list the user rules
// on: one line per lead, the first target city first, with the titles the policy excludes folded
// into a count at the end (the user's 2026-09-15 rule).
export function applyProposal({ leads = lines('state/leads.ndjson'), policy = applyPolicy(), now = Date.now(), max = 15 } = {}) {
  const eligible = [], excluded = [], held = [], sprint = citySprint();
  for (const l of leads) {
    if (l.superseded || l.legacy || !l.match || heldRec(l) || approvalBlocker(l)) continue;
    if (l.auto_apply?.status === 'submitted' || l.auto_apply?.approved_at) continue;
    if (!autoSubmittable(l) || autoApplyExhausted(l)) continue;
    // 判的时候还没有这条方向规则的老结论（推荐 / 待核）不进拟投清单：按你现在的方向规则岗位类别不在方向里的就不拿来问你投不投
    // （实测 10-04 第 13 条：酒店前台类岗位进了投递）。
    if (offDirection(l)) continue;
    // A city sprint: postings elsewhere wait, counted so the card can say so.
    if (sprint && !sprintAllows(l, sprint)) { if (!titleExcluded(l, policy) && autoApplyReady({ ...l, location: sprint.only[0] })) held.push({ number: l.number, company: l.company, role: l.role, city: leadCity(l) }); continue; }
    const title = titleExcluded(l, policy);
    if (title) { excluded.push({ number: l.number, company: l.company, role: l.role, reason: title }); continue; }
    if (!autoApplyReady(l)) continue;
    eligible.push({
      number: l.number, record_id: leadKey(l), company: l.company || '待核', role: l.role || '待核',
      city: leadCity(l), city_rank: cityRank(l, policy), channel: CHANNEL_LABEL[applyChannel(l)] || '官方表单',
      reason: l.match?.verdict === 'recommend' ? (l.match.reasons || [])[0] || '匹配结论为推荐' : `待核：${l.match?.biggest_gap || '缺口不含硬性门槛'}`,
      // The same brief every other card uses, so a row here answers "what is
      // this" without a second question (the user's 2026-09-15 rule).
      brief: briefLine(l),
      requirements: briefRequirements(l),
      // The user cannot judge a posting from a one-liner: every row carries the
      // JD's own duties and requirements (the user's 2026-09-15 rule).
      jd: jdDigest(l, { max: 3, min: 2 }),
      url: applyUrl(l) || l.url || null,
      // The same preference score the flashcard deck orders by, so the list the
      // user rules on and the deck he swipes through agree about what is worth
      // his attention first (lib/preferences.mjs).
      preference: preferenceScore(l),
    });
  }
  eligible.sort((a, b) => a.city_rank - b.city_rank || b.preference - a.preference || (a.number || 1e9) - (b.number || 1e9));
  const rows = selectCityQuota(eligible, { limit: max, city: row => row.city });
  return { date: new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now), rows, overflow: eligible.length - rows.length, excluded, sprint: sprint ? { only: sprint.only, held } : null, numbers: rows.map(r => r.number).filter(Boolean), version: hash(rows.map(r => [r.number, r.company, r.role])).slice(0, 24) };
}










// ---------------------------------------------------------------------------
// 拟发清单: every draft that is ready and has been shown, in one card the user
// approves with 「发 全部」 (or 「发 全部 去掉 32」). Each draft still has its own
// full-text card, which is what sets `notified_at` / `displayed_hash`; this
// card only gathers the numbers so one reply releases the batch (the user's
// 2026-09-19 rule: approval is the send).
export function sendProposal({ drafts = lines('state/drafts.ndjson'), leads = lines('state/leads.ndjson'), now = Date.now() } = {}) {
  const byId = new Map(leads.map(l => [leadKey(l), l]));
  const rows = drafts
    .filter(d => d.status === 'ready' && d.notified_at && d.displayed_hash && d.number && !previousContact(d, drafts) && !excludedCompany(byId.get(d.record_id) || {}) && !passedLead(byId.get(d.record_id) || {}))
    .map(d => {
      const l = byId.get(d.record_id) || {};
      const kind = d.purpose === 'referral' ? '内推请求' : d.purpose === 'followup' ? '跟进' : d.purpose === 'inquiry' ? '询问' : '申请';
      const channel = d.channel === 'email' ? '邮件' : d.channel === 'maimai_friend_request' ? '脉脉加好友' : '平台私信';
      return { number: d.number, company: l.company || d.subject || '', role: l.role || '', city: leadCity(l), city_rank: cityRank(l), kind, channel, channel_key: unifyChannel(d), record_id: d.record_id, subject: d.subject || '', url: /^https?:/.test(d.to || '') ? d.to : applyUrl(l), to: d.to, draft_id: d.draft_id, referrer: d.referrer?.author || null, first_line: String(d.body || '').split(/\n/)[0].slice(0, 60) };
    })
    .sort((a, b) => a.city_rank - b.city_rank || a.number - b.number);
  const numbers = [...new Set(rows.map(r => r.number))];
  return { date: day(now), rows, numbers, version: hash(rows.map(r => [r.number, r.draft_id])).slice(0, 24) };
}


