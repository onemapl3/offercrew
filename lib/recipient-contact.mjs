// Strip known tracking fields only: dstu, id, opaque tokens and other unknown
// parameters may be the recipient identity. URL paths/values are case-sensitive.
const TRACKING_PARAM = /^(?:utm_.+|trackable_token|tracking(?:_?(?:id|token))?|trk(?:Info)?|fbclid|gclid|msclkid)$/i;
export function recipientKey(d = {}) {
  if (!d.to || !d.channel) return null;
  let to = String(d.to).trim();
  if (!to) return null;
  if (/^https?:/i.test(to)) {
    try {
      const u = new URL(to);
      for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
      u.searchParams.sort();
      to = u.origin + u.pathname.replace(/\/$/, '') + u.search + u.hash;
    } catch {} // 兜底：无效网址保留原文，不能猜测其联系人身份
  } else to = to.toLowerCase();
  return `${d.channel}:${to}`;
}
const SENT = ['sent', 'sending', 'dispatched', 'submitted'];
export const firstContact = d => !(d.purpose === 'followup' || d.purpose === 'reply' || d.parent_thread_id || d.reply_message_id);
export function previousContact(draft, drafts = []) {
  if (!firstContact(draft)) return null;
  const key = recipientKey(draft);
  return key && drafts.find(d => d.draft_id !== draft.draft_id && recipientKey(d) === key && SENT.includes(d.status)) || null;
}
// A first contact to someone who already has a thread with the user is never
// sent: it is superseded by that thread (history kept, the reason names the
// thread's lead). Example: two first-contact drafts written before another
// lead's first contact went to the same Boss recruiter would otherwise sit as
// ready / needs_review although the recruiter had already answered on that thread.
const OPEN = ['ready', 'paused', 'needs_review', 'draft'];
export function supersedeDuplicateFirstContacts(drafts = [], { now = Date.now() } = {}) {
  const at = new Date(now).toISOString(), changed = [];
  for (const d of drafts) {
    if (!OPEN.includes(d.status)) continue;
    const prior = previousContact(d, drafts);
    if (!prior) continue;
    Object.assign(d, { status: 'superseded', superseded_at: at, superseded_by: prior.draft_id, superseded_reason: `同一联系人已在 #${prior.number ?? '?'} 的会话里联系过，改为沿该会话跟进，不再重复首联`, previous_status: d.status });
    changed.push({ number: d.number, draft_id: d.draft_id, thread_number: prior.number ?? null });
  }
  return changed;
}
