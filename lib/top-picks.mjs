import { excludedCompany } from './discovery-policy.mjs';
// 重点岗位: the few jobs worth the user's attention right now, and what stands
// between each one and an application.
//
// The backlog is sorted for the machine (city quota, per-company caps). The
// user asked for the opposite view (2026-09-19): "tell me which jobs matter,
// so they are not buried". This module scores every kept lead on fit, employer
// type, city and source, takes the top few, and names the blocker in words —
// a portal that needs him, a draft waiting for 「发」, a form waiting for a
// referrer search. Radar pushes the card whenever the set changes.
import { read, write, lines, hash } from './store.mjs';

import { applyChannel, applyUrl, autoApplyReady, portalSession, atsWaitReason, CHANNEL_LABEL } from './apply-channel.mjs';
import { leadCity, relocationCity, rankedIndex, REMOTE } from './city.mjs';
import { sprintAllows } from './city-sprint.mjs';
import { referrersFor } from './referrers.mjs';
import { preferenceScore } from './preferences.mjs';
import { TZ } from './tz.mjs';
import { endedLead } from './lead-state.mjs';
import { summaryPicks, summarySettings } from './recommend-summary.mjs';

export const TOP_PICKS_PATH = 'state/top-picks.json';
export const DEFAULT_MAX = 8;
const day = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(at));
// City points: the first target city 12, the second 8, any further one 7 (杭州 12, 上海 8 for the
// owner, lib/city.mjs); remote 6; a relocation city 4; anywhere else 0.
const cityPoints = (l, city) => { const i = rankedIndex(city); return i === 0 ? 12 : i === 1 ? 8 : i > 1 ? 7 : city === REMOTE ? 6 : relocationCity(l) ? 4 : 0; };
const TYPE_POINTS = { foreign_mnc: 10, chinese_big_tech: 6, startup: 2, state_owned: 2 };

export function pickScore(l = {}) {
  const fit = Number(l.match?.fit ?? (l.match?.score ? l.match.score / 33 : 0));
  const city = leadCity(l);
  const posting = l.judgement?.posting || {};
  return Math.round(
    fit * 30 +
    cityPoints(l, city) +
    (TYPE_POINTS[posting.company_type] ?? 0) +
    (/真人|内推|HR直发|Boss/.test(l.source_type || '') ? 8 : 0) +
    (l.match?.verdict === 'recommend' ? 10 : 0) +
    preferenceScore(l),
  );
}

// What has to happen next, in the user's words, and who does it.
export function blocker(l = {}, { outbound = [], referrers = [], drafts = [] } = {}) {
  const id = l.record_id || l.id;
  const sent = outbound.find((o) => o.record_id === id);
  if (sent) return { owner: 'recruiter', text: `已${sent.channel === 'email' ? '发邮件' : sent.channel === 'ats_form' ? '提交表单' : '联系'}（${String(sent.at).slice(0, 10)}），等回复` };
  const draft = drafts.find((d) => d.record_id === id && d.status === 'ready');
  if (draft) return { owner: 'user', text: draft.notified_at ? `草稿已发你，回「发 ${l.number}」` : '草稿已备好，卡片即将发你' };
  const people = referrersFor(l.company, referrers).filter((r) => ['found', 'drafted', 'contacted'].includes(r.status));
  if (people.length) return { owner: 'user', text: `找到内推人 ${people.map((p) => p.author).join('、')}，草稿待你「发」` };
  const channel = applyChannel(l);
  if (channel === 'email') return { owner: 'system', text: l.email ? '正在写申请信' : '真人帖，正在核实联系方式' };
  if (channel === 'portal') {
    const wait = atsWaitReason(l);
    if (wait) return { owner: 'system', text: wait };
    const s = portalSession(l);
    if (s?.logged_in && !s.never_auto) return { owner: 'user', text: `回「投 ${l.number}」提交` };
    return { owner: 'user', text: `需登录 ${s?.domain || '门户'}` };
  }
  if (channel === 'ats_form') {
    const wait = atsWaitReason(l);
    if (wait) return { owner: 'system', text: wait };
    return { owner: 'user', text: autoApplyReady(l) ? `表单可自动投，回「投 ${l.number}」` : '表单待核' };
  }
  return { owner: 'system', text: '投递入口待核' };
}

export function topPicks({ leads = lines('state/leads.ndjson'), outbound = lines('state/outbound.ndjson'), referrers = undefined, drafts = lines('state/drafts.ndjson'), now = Date.now(), max = DEFAULT_MAX, minFit = 1.8, perCompany = summarySettings().per_company } = {}) {
  const refs = referrers ?? lines('state/referrers.ndjson');
  const rows = leads
    // 城市冲刺期间（config/pipeline.json city_sprint）重点岗位也只看冲刺城市，和拟投清单、岗位清单一致。
    .filter((l) => !excludedCompany(l) && !l.superseded && !l.legacy && l.number && l.match && !endedLead(l) && sprintAllows(l))
    .filter((l) => l.match.verdict === 'recommend' || (l.match.verdict === 'verify' && Number(l.match.fit ?? 0) >= minFit + 0.4))
    .map((l) => {
      const b = blocker(l, { outbound, referrers: refs, drafts });
      return {
        number: l.number, company: l.company, role: l.role, city: leadCity(l) === '其他' ? (relocationCity(l) || l.location || '其他') : leadCity(l),
        fit: l.match.fit ?? null, verdict: l.match.verdict, score: pickScore(l),
        company_type: l.judgement?.posting?.company_type || null, human: /真人|内推|HR直发|Boss/.test(l.source_type || ''),
        why: (l.match.reasons || [])[1] || (l.match.reasons || [])[0] || '', gap: l.match.biggest_gap || '',
        blocker: b.text, owner: b.owner, url: l.url || '', entry: applyUrl(l), channel: CHANNEL_LABEL[applyChannel(l)] || '待定',
      };
    })
    .sort((a, b) => b.score - a.score);
  const picked = summaryPicks(rows, { perCompany, max });
  rows.length = 0; rows.push(...picked);
  return { date: day(now), rows, numbers: rows.map((r) => r.number), version: hash(rows.map((r) => [r.number, r.blocker])).slice(0, 24) };
}


