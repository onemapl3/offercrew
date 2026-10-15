// 旧自动城市暂停按当前求职设置复核；只回到待审，不外发，也不沿用旧审批。
import { readFacts } from './facts.mjs';
import { cityPreferenceRule, cityUnknown, sprintAllows } from './city-sprint.mjs';
import { leadState, postingClosed } from './lead-state.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { recheckCityPaused } from './drafts.mjs';
import { lines, read } from './store.mjs';
import { event } from './events.mjs';

// 只认旧批处理留下的完整签名；不能因为人工备注中出现“冲刺”就解除手动暂停。
export const legacyCityPause = d => d?.status === 'paused' && !d.paused_by && !d.city_pause_review && !d.cancellation &&
  (!d.pause_reason || d.pause_reason === d.paused_reason) &&
  d.paused_reason === '杭州冲刺模式（2026-09-21 起，config/pipeline.json city_sprint）：非杭州岗位暂停' &&
  d.paused_at === '2026-09-21T09:02:55.472Z' && ['ready', 'blocked', 'needs_platform_action'].includes(d.paused_from);

export function cityPauseEligibility(lead, draft, { facts = readFacts(), config = read('config/pipeline.json', {}) } = {}) {
  const no = reason => ({ ok: false, reason });
  if (!legacyCityPause(draft)) return no('保留人工或其他规则的暂停');
  if (!['new', 'contact_pending', 'contacting', 'outreach_ready'].includes(leadState(lead)) || lead.contact_hold || lead.followup_paused || lead.auto_apply || lead.sent_at || lead.contacted_at || lead.replied_at) return no('岗位已推进、结束或由你暂停');
  if (postingClosed(lead) || excludedCompany(lead, config) || lead.superseded || lead.status === 'superseded' || lead.match_status === 'superseded' || lead.match?.verdict === 'exclude' || (lead.prefilter_reason && lead.prefilter_reason !== 'outside_sprint_city')) return no('岗位已关闭、排除或替换');
  if (lead.judgement?.eligibility?.remote_china === 'conflict' || lead.match?.eligibility?.remote_china === 'conflict' || lead.judgement?.posting?.remote_scope === 'other_region_only') return no('远程工作范围仍不符合当前要求');
  const policy = cityPreferenceRule(facts);
  if (!policy || cityUnknown(lead) || !sprintAllows(lead, policy)) return no('岗位地点仍不符合当前求职设置或尚未核实');
  return { ok: true, policy: { cities: [...policy.cities], work_modes: [...policy.work_modes], source: 'candidate/facts.yaml' }, reason: `当前求职设置已允许这份岗位（${policy.only.join(' / ') || '不限城市'}）；解除旧城市暂停，等待重新审阅` };
}

export function recheckCityDrafts({ ids = null, dryRun = true, source = 'current_city_preferences', now = Date.now() } = {}) {
  // 和现有取消旧稿入口一样，先完成旧账导入，再在 drafts 的事务里检查全部关联记录。
  for (const name of ['leads', 'send-requests', 'outbound']) lines(`state/${name}.ndjson`);
  // 拿到数据库写锁后才读取偏好，避免等待锁期间沿用旧设置；这一批共用同一份设置。
  let settings;
  const result = recheckCityPaused({ ids, dryRun, source, now, eligible: (lead, draft) => cityPauseEligibility(lead, draft, settings ||= { facts: readFacts(), config: read('config/pipeline.json', {}) }) });
  if (!dryRun) for (const item of result.items) {
    try { event('system', 'draft', 'ok', `#${item.number ?? ''} ${item.reason}。没有恢复旧批准或发起发送。`, { lead_id: item.record_id, draft_id: item.draft_id }); }
    catch (e) { (result.log_errors ||= []).push({ draft_id: item.draft_id, error: String(e.message || e).slice(0, 200) }); }
  }
  return result;
}
