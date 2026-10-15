import { excludedCompany } from './discovery-policy.mjs';
import { titlePolicyReason } from './submission-policy.mjs';
import { leadState, closedByUser, setApply } from './lead-state.mjs';
// Jobs and approvals that no longer have anything to act on are closed with the
// reason (history kept), so 「等我处理」 only lists steps someone can take.
// A lead the user passed, archived or got a verdict on, an excluded company
// (config/pipeline.json discovery.excluded_companies) and a title above the
// user's band (auto_apply_policy.exclude_title_patterns) end every open
// contact/apply step for that lead. Interview work is never closed here.
const LEAD_STEPS = /^(queue_auto_apply|prepare_application_packet|verify_contact_entry|prepare_followup|reply_on_thread)$/;
export function leadClosure(lead = {}, kind = '') {
  const st = leadState(lead);
  if (closedByUser(lead)) return '该线索已 pass 或归档，关闭关联待办；未提交、未发送。';
  if (st === 'rejected') return '该岗位已被拒，关闭关联待办。';
  if (st === 'offer' && kind !== 'prepare_followup') return '该岗位已到 Offer，关闭投递/联系待办。';
  if (excludedCompany(lead)) return '公司已被用户排除，关闭关联投递/联系待办；未提交、未发送。';
  if (kind !== 'prepare_followup' && titlePolicyReason(lead) === 'title_excluded_by_user_policy') return '岗位标题超出你的职级规则（Senior/资深/高级/Lead/架构师/专家…），关闭投递/联系待办；未提交、未发送。';
  return null;
}
export function reconcileHostJobs(jobs, leads = [], events = [], now = Date.now()) {
  return jobs.map(job => {
    if (!['pending','waiting_user','blocked'].includes(job.status)) return job;
    const lead = leads.find(l => (job.record_id && (l.record_id || l.id) === job.record_id) || (job.number != null && l.number === job.number));
    const at = new Date(now).toISOString();
    const complete = (result, evidence) => ({...job,status:'completed',result,completed_at:at,updated_at:at,waiting_user:null,blocked_reason:null,...(evidence?{evidence}: {})});
    if (lead && LEAD_STEPS.test(job.kind || '')) {
      const closed = leadClosure(lead, job.kind);
      if (closed) return complete(closed);
    }
    if (job.kind === 'queue_auto_apply' && lead) {
      const a = lead.auto_apply || {};
      if (a.status === 'submitted') return complete('已记录投递回执。', a.evidence);
      if (a.status === 'awaiting_batch_review') return {...job,status:'waiting_user',blocked_reason:'awaiting_batch_review',result:'当前投递材料或方案与原批准版本不同，需查看当前拟填内容并重新确认投递。旧登录/失败上限记录仅作历史，尚未提交。',waiting_user:`查看「预览拟填内容」，确认当前方案后回「投 ${lead.number}」；新批准会保留到提交为止（门户登录、简历更新都不再作废它）。`,checked_at:a.approval_stale?.at || a.at || job.checked_at};
    }
    if (job.blocked_reason === 'card_callback_not_delivered') {
      const success = events.find(e => e.step === 'card-action' && e.status === 'ok' && e.ts > (job.checked_at || job.created_at));
      if (success) return complete(`已于 ${success.ts} 收到真实卡片回调，旧回调阻塞已恢复。无需重复检查登录或其他电脑。`, 'state/events.ndjson');
    }
    return job;
  });
}
// The lead side of the same rule. An open approval for an excluded company, a
// passed lead or an over-band title is closed (`closed_reason` keeps why; the
// approval fields stay as history), and follow-up prompts stop for threads
// with a company the user has since excluded (contact_hold: the journey and
// the reminder list already honour it; an incoming reply is still recorded).
// 等你的（终审、补信息、Chrome 交接）也算没结束的投递：线索 pass / 归档后一起关掉。提交中 / 结果不确定的不在这里——先对账。
const OPEN_APPLY = ['approved', 'queued', 'pending', 'awaiting_batch_review', 'needs_login', 'failed', 'paused', 'awaiting_final_review', 'waiting_user', 'prepared_for_user'];
export function reconcileLeads(leads = [], { now = Date.now(), outbound = [] } = {}) {
  const at = new Date(now).toISOString(), changed = [];
  for (const l of leads) {
    const a = l.auto_apply;
    if (a && OPEN_APPLY.includes(a.status)) {
      const reason = closedByUser(l) ? 'passed' : leadState(l) === 'rejected' ? 'rejected' : excludedCompany(l) ? 'excluded_company' : titlePolicyReason(l) === 'title_excluded_by_user_policy' ? 'title_excluded' : null;
      if (reason) { setApply(l, { ...a, status: 'closed', closed_reason: reason, closed_at: at, previous_status: a.status }, { at, source: 'runtime-recovery', note: reason }); changed.push({ number: l.number, change: 'auto_apply_closed', reason }); }
    }
    const id = l.record_id || l.id, st = leadState(l);
    if (!l.contact_hold && excludedCompany(l) && !['archived', 'rejected', 'offer'].includes(st) && (['applied', 'contacted'].includes(st) || outbound.some(o => o.record_id === id))) {
      Object.assign(l, { contact_hold: true, contact_hold_reason: 'excluded_company', contact_hold_at: at });
      changed.push({ number: l.number, change: 'contact_hold', reason: 'excluded_company' });
    }
  }
  return changed;
}
