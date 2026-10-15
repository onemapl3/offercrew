// 批准一条投递（「投 N」、收件箱的「投递」、任务卡、对话）：拒投规则和记下批准只在这一处（以前 bin/queue-apply.mjs 和
// lib/command-center.mjs applyStop 各写一份，02a 第四节第 6 条）。lib/action-kinds.mjs 的 prefill 和 bin/queue-apply.mjs 都用它。
//   applyRefusal(l, ctx) → null，或 { text, open? }：按你的规矩不投、投不了的原因（一句人话）；open 是可以给你打开的申请页
//   loginNeeded(l)       → 门户要先登录 / 注册的那一条阻碍，或 null（不是拒投：批准照记，等你登录）
//   approveLead(l, ...)  → 把批准记到线索上（auto_apply 的状态、批准时的计划指纹），推进线索状态
import { applyWord, autoApplyExhausted, applyUrl, applyChannel, applyBlockers, titleExcluded } from './apply-channel.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { outOfScopeNow, prefilter } from './matcher.mjs';
import { planFingerprint, approvalKey, priorSubmission } from './submission-policy.mjs';
import { applyEvent, setApply, appliedLead, endedLead, postingClosed } from './lead-state.mjs';
import { approvalBlocker } from './recommend-gate.mjs';
import { hash } from './store.mjs';
import { pendingReview, ownerDecision } from './owner-decision.mjs';

export function applyRefusal(l, { leads = [], outbound = [] } = {}) {
  const n = l.number;
  if (excludedCompany(l)) return { text: `${l.company} 在你的排除公司名单里，不投` };
  const title = titleExcluded(l);
  if (title) return { text: `${title}，按你的职级规则不投` };
  if (postingClosed(l)) return { text: '这个岗位已经关了，投不了' };
  if (appliedLead(l)) return { text: '已投递过，不重复提交' };
  // 结果没确认的那一次先对账，不重新批准成第二次提交。
  if (['submitting', 'uncertain'].includes(l.auto_apply?.status)) return { text: '上次提交结果还没确认，先对账，不会重复提交' };
  if (l.auto_apply?.status === 'prepared_for_user') return { text: '申请已经预填好、停在提交前，请你检查后提交' };
  if (endedLead(l)) return { text: `这条已 pass 或已结束；要恢复先回「${n} 联系」` };
  if (priorSubmission(l, applyUrl(l), outbound, leads)) return { text: '已有同一岗位的投递回执，不重复提交' };
  if (!['ats_form', 'portal'].includes(applyChannel(l))) return { text: `不是系统能填的官方表单或门户，需要你自己投递${applyUrl(l) ? '' : '（入口还没核实）'}`, ...(applyUrl(l) ? { open: applyUrl(l) } : {}) };
  if (autoApplyExhausted(l)) return { text: `${applyWord()}已失败 ${l.auto_apply?.attempts} 次，请你自己打开申请页提交`, open: applyUrl(l) };
  return null;
}
// 按你现在的规则这个岗位不该投（lib/matcher.mjs outOfScopeNow：岗位类别不在方向里、级别偏高、届别不对……）：不是拒投——你点名要投可以投，
// 但单条要先问你一句、确认的指纹带上这一句；批量（「投 全部」、多选）一律跳过（实测 10-04 #515：转发进来就判了不是工程类，
// 两分钟后被批量批准了）。→ null 或 { code, text }。
const OFF_WORD = { company_excluded_by_user: '你排除了这家公司', non_software_role: '不是软件岗', seniority_out_of_range: '级别偏高', outside_target_specialty: '方向不对', excluded_role: '你不做的岗位类型', cohort_mismatch: '校招届别不对', posting_closed: '岗位已关闭', human_not_direct_hiring: '发帖人不是直招', not_a_job_post: '不是招聘帖', outside_target_location: '城市不对', outside_sprint_city: '冲刺期城市不符' };
export function offDirection(l) {
  let code = null;
  try { if (!outOfScopeNow(l)) return null; code = prefilter(l); } catch { return null; } // 兜底：规则读不了这一条就不拦，照常问你投不投
  return { code, text: `这个岗位不在你的方向里（${OFF_WORD[code] || '按你现在的规则不该投'}），确定要投吗？` };
}
// 预填动作确认绑的指纹（lib/action-kinds.mjs prefill prepare）：计划指纹；不在方向里的带上那一句「确定要投吗？」。
export const prefillFingerprint = (l, fp) => { const off = offDirection(l), review = pendingReview(l); return off || review ? hash([fp, off?.text || null, review?.fingerprint || null]) : fp; };
export const loginNeeded = l => applyBlockers(l).find(b => ['needs_login', 'register_by_owner'].includes(b.code)) || null;

// 记下批准：你刚看到的这一版计划就是批准的那一版；旧的批准、执行器留下的「过期」记号一起换掉。
export function approveLead(l, { plan, source, at, messageId = null, batchId = null }) {
  const stop = approvalBlocker(l, { ownerDecision: true });
  if (stop) throw Error(stop);
  const login = loginNeeded(l);
  const { approval_stale, ...prior } = l.auto_apply || {};
  const next = { ...prior, status: login ? 'needs_login' : 'approved', ...(login ? { domain: login.domain, error: prior.error || 'login_required' } : {}), approved_at: at, approved_by: source, user_requested_at: at, approved_plan_fingerprint: planFingerprint(plan), approval_key: approvalKey(plan), approved_url: plan.url, approved_resume: { slot: plan.resume?.slot || null, label: plan.resume?.label || null }, approval_source: source, approval_message_id: messageId, approval_batch_id: batchId || messageId };
  const review = ownerDecision(l, { at, source, messageId });
  if (review) next.owner_decision = review;
  else delete next.owner_decision;
  if (!login) delete next.error;
  // 子状态没变（重新批准一条已经批准过的）也记一次批准：状态照表再走一步，历史里看得到这次批准。
  if (!setApply(l, next, { at, source, note: login?.code || null })) applyEvent(l, login ? 'apply_needs_user' : 'apply_approved', login ? { note: login.code } : {}, { at, source, strict: true });
  return { login };
}
