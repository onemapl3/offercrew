// 跟进当场交给 Writer：只写原文，不记发送授权、不叫醒浏览器或发送器。
import { lines, read, writeLines, hash } from './store.mjs';
import { writeLetter } from './resume-letters.mjs';
import { letterPath } from './resume-choice.mjs';
import { draftFingerprint } from './drafts.mjs';
import { followupSource } from './followup-state.mjs';
import { endedLead } from './lead-state.mjs';
import { event } from './events.mjs';
import * as J from './jobs.mjs';

const pending = new Map();
export function draftFollowup(number, options = {}) {
  const n = Number(number);
  if (pending.has(n)) return pending.get(n);
  const work = draftOne(n, options).finally(() => pending.delete(n));
  pending.set(n, work);
  return work;
}
async function draftOne(number, { now = Date.now(), model = null, origin = 'chat', instruction = '' } = {}) {
  const lead = lines('state/leads.ndjson').find(l => l.number === number && !l.superseded);
  if (!lead || endedLead(lead)) return { ok: false, receipt: `#${number} 已结束或找不到，没起草跟进。` };
  const rid = lead.record_id || lead.id;
  const { parent, parentId, reason } = followupSource(lead, lines('state/outbound.ndjson'));
  if (reason) return { ok: false, receipt: `#${number} ${reason}` };
  const existing = lines('state/drafts.ndjson').find(d => d.record_id === rid && d.purpose === 'followup' && d.reply_message_id === parentId && d.status === 'ready');
  if (existing) return show(existing, number);
  const job = J.create({ kind: 'prepare_followup', member: 'tailor', title: `起草 #${number} 的跟进`, origin: J.ORIGINS.includes(origin) ? origin : 'chat', target: `lead:${rid}`, now });
  J.drive(job.id, 'running', { now });
  try {
    const previous = lines('state/drafts.ndjson').find(d => d.draft_id === parent.draft_id);
    const original = { rfc_id: parentId, subject: parent.subject || previous?.subject || lead.role, text: parent.body || previous?.body || '', from_address: parent.to || previous?.to || lead.email || '' };
    const r = await writeLetter({ kind: 'email', record_id: rid, now, mail: { purpose: 'followup', original, instruction }, ...(model ? { model } : {}) });
    if (r.status !== 'proposed') throw Error(r.error || '草稿没通过材料核对');
    const rec = read(letterPath(r.key), null);
    if (!rec?.text) throw Error('Writer 没留下草稿正文');
    const d = { draft_id: `follow-${hash([rid, parentId]).slice(0, 16)}`, record_id: rid, number, channel: parent.channel || 'email', purpose: 'followup',
      to: original.from_address, subject: rec.subject, body: rec.text, attachments: [], parent_outbound_id: parent.id,
      parent_thread_id: parent.thread_id || parent.to || null, reply_message_id: parentId,
      ...(parent.channel === 'email' ? { in_reply_to: parentId, references: [parentId] } : {}),
      by: 'writer', letter_key: r.key, via: parent.channel === 'email' ? 'builtin-mail' : 'writer', status: 'ready', created_at: new Date(now).toISOString() };
    // 等模型时有人结束了岗位，就不再留下待发草稿。
    if (endedLead(lines('state/leads.ndjson').find(l => (l.record_id || l.id) === rid) || {})) throw Error('这条岗位刚刚已结束');
    d.notified_at = new Date(now).toISOString(); d.displayed_hash = draftFingerprint(d);
    const drafts = lines('state/drafts.ndjson');
    for (const old of drafts) if (old.record_id === rid && old.purpose === 'followup' && old.status === 'ready') old.status = 'cancelled';
    drafts.push(d); writeLines('state/drafts.ndjson', drafts);
    J.drive(job.id, 'done', { now, result: { summary: `#${number} 的跟进草稿写好了，等你审阅`, links: { inbox: '#inbox' } } });
    event('tailor', 'followup', 'waiting_user', `#${number} 的跟进写好了，等你审阅`, { lead_id: rid, job_id: job.id });
    return show(d, number);
  } catch (e) {
    const reason = String(e.message || e).slice(0, 200);
    J.drive(job.id, 'failed', { now, reason });
    event('tailor', 'followup', 'fail', `#${number} 的跟进没写成：${reason}`, { lead_id: rid, job_id: job.id });
    return { ok: false, receipt: `#${number} 的跟进没写成：${reason}。可以重新起草。` };
  }
}
function show(d, number) {
  return { ok: true, draft: d, receipt: `#${number} 的跟进草稿：\n\n${d.channel === 'email' ? `${d.subject}\n\n` : ''}${d.body}\n\n等你审阅后再批准发送。` };
}
