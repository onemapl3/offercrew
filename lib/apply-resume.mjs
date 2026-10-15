// 旧预填任务等补信息、答案却已存好：读时给恢复入口；本人点了才接着预填。
import { lines, writeLines } from './store.mjs';
import { autoApplyNeeds, NEVER_COLLECT } from './needs.mjs';
import { loadBook, lookup } from './answer-book.mjs';
import { appliedLead, endedLead, setApply } from './lead-state.mjs';
import { openFor } from './actions.mjs';
import { continuePrefill } from './action-entry.mjs';

const MANUAL = /consent|privacy|gdpr|data\s*(?:processing|protection)|同意|隐私|个人信息/i;
export function answeredApplyInfo(l, { book = loadBook() } = {}) {
  const a = l?.auto_apply;
  if (!a || appliedLead(l) || endedLead(l) || !['waiting_user', 'prepared_for_user', 'awaiting_final_review', 'approved'].includes(a.status)) return null;
  // test.9 答过后已记 approved，但任务和上次 prefill.missing 还在。
  // 只认留着明确缺项的旧批准，不从任务的中文原因猜题目，也不要求旧版写过回答时间。
  const needs = autoApplyNeeds(a.status === 'approved' ? { ...l, auto_apply: { ...a, status: a.final_review && !a.prefill ? 'awaiting_final_review' : 'prepared_for_user' } } : l);
  if (!needs.length && a.status === 'approved' && Array.isArray(a.unanswered_controls) && a.unanswered_controls.length) needs.push({ kind: 'info', fields: a.unanswered_controls });
  if (!needs.length || needs.some(n => n.kind !== 'info')) return null;
  const fields = needs.flatMap(n => n.fields || []);
  if (!fields.length || fields.some(f => f.type === 'long_text' || NEVER_COLLECT.test(f.label) || MANUAL.test(f.label) || !String(lookup(book, f.label) ?? '').trim())) return null;
  return { labels: fields.map(f => f.label) };
}

export async function resumeSavedPrefill(rid, { job_id, now = Date.now(), kick, origin = 'card' } = {}) {
  const rows = lines('state/leads.ndjson'), l = rows.find(x => !x.superseded && (x.record_id || x.id) === rid);
  if (!answeredApplyInfo(l)) throw Object.assign(Error('这条投递现在不能直接继续预填，请刷新查看当前要处理的事'), { status: 409 });
  if (openFor('submit', `lead:${rid}`).length || openFor('prefill', `lead:${rid}`).some(a => a.state === 'uncertain')) throw Object.assign(Error('上次提交结果还没核对上，先查看申请页，不重复预填或提交'), { status: 409 });
  // 旧终审不授权这次提交；继续的只是预填，完成后再次交给本人。
  const { error, stop, final_approved_at, final_plan_fingerprint, final_approved_by, ...kept } = l.auto_apply;
  const at = new Date(now).toISOString();
  setApply(l, { ...kept, status: l.auto_apply.approved_at ? 'approved' : 'awaiting_batch_review', answered_at: at }, { at, source: origin, note: 'resume_saved_answers' });
  writeLines('state/leads.ndjson', rows);
  const out = await continuePrefill([rid], { origin, now, job_id, ...(kick ? { kick } : {}) });
  return { ...out, receipt: out.continued ? '继续预填排上了，使用已存答案，填好停在提交前给你；同意框由你自己勾' : out.blocked[0] || '没排上，请刷新查看当前阻碍' };
}
