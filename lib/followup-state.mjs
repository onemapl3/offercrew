// 跟进必须接在真实的上一封联系后面。起草入口和岗位行共用这份判断，不把旧请求当成草稿。
export function followupSource(lead, outbound = []) {
  const rid = lead.record_id || lead.id;
  const receipts = outbound.filter(o => o.record_id === rid && o.status !== 'corrected');
  const isForm = o => /^(?:ats_form|portal)/.test(o.channel || '');
  const sent = receipts.filter(o => !isForm(o));
  if (sent.every(o => Number.isFinite(Date.parse(o.at)))) sent.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const parent = sent.at(-1);
  if (!parent) return receipts.some(isForm) || lead.auto_apply?.status === 'submitted'
    ? { application: true, reason: '已通过申请表提交，目前没有邮件或私信会话可跟进。可到申请页查看进度，收到回复后再继续。' }
    : { reason: '没有已发送的联系记录，没法接着起草跟进。' };
  if (parent.channel === 'maimai_friend_request') return { parent, reason: '目前只有好友申请回执，还没有可接着跟进的会话；先等对方通过或回复。' };
  const parentId = parent.external_id || parent.message_id;
  if (!parentId || !(parent.thread_id || parent.to)) return { parent, reason: '上一封的消息编号或会话回执不完整，没起草跟进；先核实已发送记录。' };
  return { parent, parentId, reason: null };
}
