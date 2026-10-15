// Outbound is a receipt ledger. Legacy form receipts used a local confirmation
// file plus 已投递 instead of external_id; a queued/failed attempt is not a receipt.
export function delivered(o = {}, lead = {}) {
  if (['corrected', 'failed', 'pending', 'queued', 'uncertain', 'dispatched'].includes(o.status)) return false;
  if (o.external_id || o.message_id || o.reconciled || o.verified_at || o.status === 'submitted') return true;
  if (['email', 'platform_dm', 'maimai_friend_request'].includes(o.channel)) return true;
  if (/^(ats_form|portal(?:_|$))/.test(o.channel || '')) {
    return lead.auto_apply?.status === 'submitted' || !!(o.evidence && (['applied', 'rejected'].includes(lead.state) || (!lead.state && /^(已投递|拒绝)$/.test(lead.stage || '')) || lead.replied_at || lead.offer_at));
  }
  return false;
}
