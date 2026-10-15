// 投递与外发：哪些事一定要你点头。提交前终审、发送前确认是锁住的（事实，不是开关；
// 服务端也拒绝关掉终审，见 lib/settings.mjs FINAL_REVIEW_LOCKED）；其余几条是开关。
const val = (D, k) => D.cc.settings?.files?.concierge?.values?.[k];
const flip = (D, k) => ({ on: val(D, k) === true, set: on => D.h.post('/api/settings', { name: 'concierge', patch: { [k]: on } }) });
const policy = D => (D.setup?.steps || []).find(s => s.key === 'policy');
export default {
  id: 'send', title: '投递与外发', icon: 'shield',
  summary: () => '提交前终审 · 发送前确认',
  glance: () => '提交前终审 · 一直开着<br>发邮件 / 私信前确认 · 一直开着',
  cards: D => [
    { rows: [
      { id: 'final', label: '提交申请前', value: '每一份都等你终审', lock: true, words: '终审 投递 提交 自动投递' },
      { id: 'msgs', label: '发邮件 / 私信前', value: '每一条都等你确认', lock: true, words: '发送 私信 邮件 确认' },
      ...(/夜里[^·]*/.test(policy(D)?.summary || '') ? [{ id: 'night', label: '夜里', value: String(policy(D).summary.match(/夜里[^·]*/)[0]).replace(/^夜里\s*/, '').trim(), lock: true, words: '不打扰 静默' }] : []),
    ] },
    { rows: [
      { id: 'batch', label: '投递先审后投', value: '', toggle: flip(D, 'auto_apply_policy.require_batch_review'), words: '审核 批准' },
      { id: 'referral', label: '填表前先找内推人', value: '', toggle: flip(D, 'auto_apply_policy.require_referrer_search'), note: val(D, 'auto_apply_policy.require_referrer_search') ? '检索要接上联系人识别服务；尚未批准的岗位会短暂等待内推检索，之后会继续；你明确批准投递的岗位不会因此停住。' : '', words: '内推' },
      { id: 'onebyone', label: '拟投一张一张过', value: '', toggle: flip(D, 'auto_apply_policy.deal_one_by_one'), words: '拟投' },
    ] },
  ],
};
