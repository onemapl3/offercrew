import { ownerDecision } from './owner-decision.mjs';
import { hash } from "./store.mjs";
import { applyEvent, archivedLead } from "./lead-state.mjs";
// pass 的固定原因（收件箱、卡片、工作台里点选的）和系统自己写的原因。它们只在那条岗位的上下文里有意义：
// 作为结构化反馈留在 state/feedback.ndjson（带公司、岗位），不写进 candidate/profile.md（匹配模型会读它）。
export const PASS_REASONS = ["方向不对", "城市不对", "年限或级别不符", "公司不想去", "薪资不符"];
// 刷卡跳过：刷卡里点「跳过」时系统自己写的（lib/flashcard.mjs）。
export const PRESET_PASS_REASONS = new Set([...PASS_REASONS, "都不推进", "资深岗，按规则不投", "刷卡跳过"]);
export function parseFeedback(input, leads, { source = "codex", message_id, at = new Date().toISOString() } = {}) {
  const matches = [...input.matchAll(/(?:^|[\s,，;；])(?<number>\d+)\s*(?<action>联系|pass|跟进|备注)(?=\s|$|[，,;；])/gi)],
    events = [],
    uncertain = [];
  if (!matches.length) return { events, uncertain: [input] };
  if (input.slice(0, matches[0].index).trim()) uncertain.push(input.slice(0, matches[0].index).trim());
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i],
      number = Number(m.groups.number),
      lead = leads.find((l) => l.number === number && !archivedLead(l) && !l.superseded); // 被合并掉的旧行不按编号认
    const reason = input
      .slice(m.index + m[0].length, matches[i + 1]?.index ?? input.length)
      .trim()
      .replace(/[;；,，]+$/, "");
    if (!lead || /\b\d+\s*(?:发|联系|pass)|(?:^|\s)发\s*\d/.test(reason)) {
      uncertain.push(m[0] + reason);
      continue;
    }
    events.push({
      id: hash([source, message_id || input, i]),
      record_id: lead.record_id || lead.id,
      number,
      source,
      message_id: message_id || null,
      at,
      raw: input,
      action: m.groups.action.toLowerCase(),
      reason,
      // 学偏好的代码按线索读公司、岗位；线索以后被合并 / 改名，这条反馈自己也说得清是关于哪个岗位。
      company: lead.company || null,
      role: lead.applied_role || lead.role || null,
      ...(m.groups.action === "联系" ? { owner_decision: ownerDecision(lead, { at, source, messageId: message_id || null }) } : {}),
      status: "pending",
    });
  }
  return { events, uncertain };
}
// 用户反馈走状态机（lib/lead-state.mjs）：联系 / pass 先进「处理中」，随即由本次落盘确认（decision_applied）；
// 备注 / 跟进只记事件不改状态（跟进另记 follow_up_at，「要跟进」的那几处看它）。不写旧字段 stage / feedback。
export function updatedLead(lead, event) {
  const next = { ...lead, note: event.reason || lead.note, feedback_at: event.at };
  if (event.action === "备注") { applyEvent(next, 'note', { note: event.reason }, { at: event.at, source: event.source || 'feedback' }); return next; }
  if (event.action === "跟进") { next.follow_up_at = event.at; applyEvent(next, 'follow_up', { note: '跟进' }, { at: event.at, source: event.source || 'feedback' }); return next; }
  const decided = event.action === "pass" ? 'decide_pass' : 'decide_contact';
  const r = applyEvent(next, decided, { note: event.reason }, { at: event.at, source: event.source || 'feedback' });
  if (r.ok) {
    if (event.owner_decision) next.owner_decision = event.owner_decision;
    applyEvent(next, 'decision_applied', {}, { at: event.at, source: 'feedback-queue' });
  }
  // 状态机拒绝的 pass（已经是 Offer / 已归档）：不改写成已排除，只把这句话当备注记下。
  // 「联系」落在已经往前走了的线索上（已联系、已回复……）：状态不倒退，也只记这句话。
  else applyEvent(next, 'note', { note: `${event.action}（未生效：${r.from}）${event.reason ? '：' + event.reason : ''}` }, { at: event.at, source: event.source || 'feedback' });
  return next;
}
// Feedback the pipeline actually acts on (飞书 Base 那一列的旧值；线索上不再存 feedback，见 lib/lead-state.mjs)。
export const FEEDBACK_ACTIONS = ["联系", "pass", "跟进"];
// Labels the Feishu Base select uses to mean "nothing chosen yet". They are the
// column's empty state, not a user action, and must never reach lead.feedback.
export const BASE_FEEDBACK_PLACEHOLDERS = ["未标记"];
// The one Base label that means "submit this one": it is handed to
// bin/queue-apply.mjs (the same path as 「投 编号」in the room) and is never
// stored in lead.feedback, so 投递状态 stays a column the system writes.
export const BASE_APPLY_LABELS = ["投", "投递"];
// Normalize a feedback value (string, single-element array, or empty) into a lead.feedback
// value: a recognized action, or "" when it is empty, a placeholder label, or an option the
// code does not understand.
export function baseFeedback(value) {
  const first = Array.isArray(value) ? value.find((v) => v != null && String(v).trim()) : value;
  const label = String(first ?? "").trim();
  if (!label || BASE_FEEDBACK_PLACEHOLDERS.includes(label)) return "";
  const action = label.toLowerCase() === "pass" ? "pass" : label;
  return FEEDBACK_ACTIONS.includes(action) ? action : "";
}
export function isUserFeedback(value) {
  return baseFeedback(value) !== "";
}
