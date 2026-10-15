// 通知与手机：配对的手机（web/phone.js 整块照用）、什么时候找你。
import { esc, fileLine } from './ui.js';
import { phoneBody, bindPhone } from '../phone.js';

const val = (D, k) => D.cc.settings?.files?.concierge?.values?.[k];
const hour = x => (x == null || x === '' ? null : `${String(x).padStart(2, '0')}:00`);
const phones = D => D.phone?.paired || [];
function phoneHtml(D) { return `<div class="ph-wrap" id="settings-phone">${phoneBody(D.phone || {}, { esc: D.h.esc, fmt: D.h.fmt, where: 'settings' })}</div>`; }
function bindPhoneBox(root, D) {
  const wrap = root.querySelector('#settings-phone');
  if (!wrap) return;
  bindPhone(wrap, { view: D.phone, post: body => D.h.post('/api/phone', body), toast: D.h.toast, repaint: v => { D.phone = v; const w = document.querySelector('#settings-phone'); if (w) { w.innerHTML = phoneBody(v, { esc: D.h.esc, fmt: D.h.fmt, where: 'settings' }); bindPhoneBox(document, D); } } });
}
export default {
  id: 'notify', title: '通知与手机', icon: 'bell',
  summary: D => phones(D).length ? `${phones(D).length} 部手机` : '没配手机',
  glance: D => phones(D).length ? `${phones(D).length} 部手机` : '还没配对手机',
  cards(D) {
    const qs = hour(val(D, 'quiet_start')), qe = hour(val(D, 'quiet_end'));
    return [
      { title: '手机', html: phoneHtml(D), rows: [] },
      { title: '找你的时间', rows: [
        { id: 'quiet', label: '静默时段', value: qs && qe ? `${qs} – ${qe}` : '<span class="st-muted">没设</span>', sub: 'quiet', words: '勿扰 不打扰 夜里' },
        { id: 'daily', label: '每天可花的时间', value: D.kit.factValue('communication.daily_feedback_budget_minutes') != null ? `${esc(D.kit.factValue('communication.daily_feedback_budget_minutes'))} 分钟` : '<span class="st-muted">未填</span>', sub: 'times' },
      ] },
    ];
  },
  bind: (root, D) => bindPhoneBox(root, D),
  subs: {
    quiet: { title: '静默时段', render: D => `<div class="st-card st-pad">${D.kit.form('concierge', ['quiet_start', 'quiet_end'])}</div>${fileLine('config/concierge.json')}` },
    times: { title: '每天处理求职事项的时间', render: D => `<p class="st-note">每天用于看岗位、审草稿和回复的时间，不是通知的钟点。</p><div class="st-card st-pad">${D.kit.facts(['communication.daily_feedback_budget_minutes'])}</div>${fileLine('candidate/facts.yaml')}` },
  },
  index: () => [{ id: 'x-pair', label: '配对手机', value: '', words: '手机 二维码 扫码 配对码', go: '#settings/notify' }],
};
