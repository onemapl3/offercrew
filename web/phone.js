// 连接手机：引导里的「连接手机」一步和「设置 → 手机」共用这一份（2026-09-29）。
// 只读写 /api/phone（接口契约见桌面版方案附录 F）：GET 看状态；POST { action } 做 pair_start / pair_confirm / pair_cancel /
// unpair / rename / hand_off。中转没上线时服务端给 available: false 和一句 reason，界面照抄 reason，不许诺时间。
// 配对进行中（waiting / confirm）每 2 秒查一次 GET /api/phone，页面上这一块跟着重画。
// 飞书是另一条路：已经配好就写「已连接」，没配就给一个去设置的链接。

import { askConfirm, askText } from './settings/ask.js';

// ── 界面文字（界面只做中文，以后做英文就换这一处） ──────────────────────────────────
const T = {
  unavailable: '现在不能配手机',
  link: { off: '没连中转服务', connecting: '正在连中转服务', online: '中转服务在线', offline: '中转服务离线' },
  pair: '扫码配对手机', again: '重新配对', cancel: '取消',
  how: url => [`在 iPhone 的 Safari 里打开 ${url}，点「分享」→「添加到主屏幕」，再从主屏幕打开；安卓用 Chrome 打开，按提示「安装」。`, '用手机扫这个码；扫不了就在手机上输入配对码。', '两边会显示同一串 6 位核对数字，一样了再在这台电脑上确认。'],
  qr: '配对二维码', code: '配对码', expires: t => `${t} 前有效，只能用一次`,
  confirmQ: '手机上显示的数字和这里一样吗？', confirm: '一样，确认配对', mismatch: '不一样，取消',
  done: '配对好了', expired: '这个码过期了，重新配对一次', cancelled: '这次配对取消了',
  list: '已配对的手机', kind: { pwa: '网页 App', ios: 'iPhone App' },
  since: t => `配对于 ${t}`, seen: t => `最近在线 ${t}`, push: on => (on ? '通知开着' : '通知关着'),
  handoff: '允许这部手机把活交给本机 AI', handoffWarn: '本机 AI 在这台 Mac 上不带沙箱运行，打开之前想清楚。',
  rename: '改名', unpair: '解除配对', unpairAsk: name => `解除和「${name}」的配对？`, unpairWhat: '这部手机的密钥会立刻作废，它再也连不上这台电脑；要再用，得重新配对。', renameAsk: '给这部手机起个名字',
};
const LIVE = new Set(['waiting', 'confirm']);
// 引导里要不要这一步：能配手机才有；不能就悄悄跳过。
export const phoneStepWanted = v => !!v && v.available === true;
export async function loadPhone() {
  const r = await fetch('/api/phone'), v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || '读取失败');
  return v;
}

// ── 画 ──────────────────────────────────────────────────────────────────────
// where：'guide'（引导里，只放配对）或 'settings'（设置里，多一张已配对手机的管理表）。
export function phoneBody(v = {}, { esc, fmt = x => x || '', where = 'settings' } = {}) {
  if (v.available !== true) return `<div class="ph" data-ph><p class="ph-reason">${esc(v.reason || T.unavailable)}</p></div>`;
  const p = v.pairing, paired = Array.isArray(v.paired) ? v.paired : [];
  // 中转只在配过手机或正在配对时才连（lib/phone/service.mjs needLink）：两样都没有时 link 是 off，那是「还不用连」不是「连不上」，
  // 不显示（10-02 开箱第 2 轮 N12：新装时写着「没连中转服务」，旁边的「扫码配对手机」其实能用）。
  const linking = paired.length > 0 || ['waiting', 'confirm'].includes(p?.state);
  const link = v.link && linking ? `<span class="ph-link is-${esc(v.link)}">${esc(T.link[v.link] || v.link)}</span>` : '';
  let pairing = `<div class="ph-actions"><button type="button" class="primary" data-ph-act="pair_start">${esc(T.pair)}</button></div>`;
  if (p && p.state === 'waiting') pairing = `<div class="ph-pair" data-ph-state="waiting"><img class="ph-qr" src="${esc(p.qr)}" alt="${esc(T.qr)}" width="180" height="180"><div class="ph-pair-body"><ol class="ph-how">${T.how(v.phone_url || p.url || '').map(x => `<li>${esc(x)}</li>`).join('')}</ol><p class="ph-code"><span>${esc(T.code)}</span><b>${esc(p.code || '')}</b></p>${p.expires_at ? `<p class="muted small">${esc(T.expires(fmt(p.expires_at)))}</p>` : ''}<div class="ph-actions"><button type="button" class="secondary" data-ph-act="pair_cancel" data-ph-id="${esc(p.id)}">${esc(T.cancel)}</button></div></div></div>`;
  else if (p && p.state === 'confirm') pairing = `<div class="ph-pair" data-ph-state="confirm"><div class="ph-pair-body"><p class="ph-q">${esc(T.confirmQ)}</p><p class="ph-sas">${esc(String(p.sas || '').replace(/^(\d{3})(\d{3})$/, '$1 $2'))}</p><div class="ph-actions"><button type="button" class="primary" data-ph-act="pair_confirm" data-ph-id="${esc(p.id)}">${esc(T.confirm)}</button><button type="button" class="secondary" data-ph-act="pair_cancel" data-ph-id="${esc(p.id)}">${esc(T.mismatch)}</button></div></div></div>`;
  else if (p && ['paired', 'expired', 'cancelled'].includes(p.state)) pairing = `<p class="ph-result is-${esc(p.state)}">${esc(p.state === 'paired' ? T.done : p.state === 'expired' ? T.expired : T.cancelled)}</p><div class="ph-actions"><button type="button" class="${p.state === 'paired' ? 'secondary' : 'primary'}" data-ph-act="pair_start">${esc(p.state === 'paired' ? T.pair : T.again)}</button></div>`;
  const row = d => `<li class="ph-dev" data-ph-dev="${esc(d.id)}"><div class="ph-dev-h"><b>${esc(d.name || d.id)}</b><span class="tag">${esc(T.kind[d.kind] || d.kind || '')}</span></div><p class="muted small">${esc([d.paired_at ? T.since(fmt(d.paired_at)) : '', d.last_seen_at ? T.seen(fmt(d.last_seen_at)) : '', T.push(!!d.push)].filter(Boolean).join(' · '))}</p>${where === 'settings' ? `<label class="ph-handoff"><input type="checkbox" data-ph-handoff="${esc(d.id)}" ${d.hand_off ? 'checked' : ''}> ${esc(T.handoff)}</label><p class="ph-warn small">${esc(T.handoffWarn)}</p><div class="ph-actions"><button type="button" class="secondary mini" data-ph-act="rename" data-ph-id="${esc(d.id)}" data-ph-name="${esc(d.name || '')}">${esc(T.rename)}</button><button type="button" class="secondary mini" data-ph-act="unpair" data-ph-id="${esc(d.id)}" data-ph-name="${esc(d.name || d.id)}">${esc(T.unpair)}</button></div>` : ''}</li>`;
  const list = paired.length ? `<div class="ph-list"><p class="ph-label">${esc(T.list)}</p><ul>${paired.map(row).join('')}</ul></div>` : '';
  return `<div class="ph" data-ph>${link}${pairing}${list}</div>`;
}

// ── 交互 ────────────────────────────────────────────────────────────────────
// post(body) 发 POST /api/phone（带 token）；repaint(view) 用新状态重画这一块。配对进行中时每 2 秒查一次。
let timer = null;
export function stopPhonePoll() { clearTimeout(timer); timer = null; }
function poll(repaint) {
  stopPhonePoll();
  timer = setTimeout(async () => {
    timer = null;
    if (!document.querySelector('[data-ph]')) return; // 这一块已经不在页面上
    try { repaint(await loadPhone()); } catch { poll(repaint); } // 重画时 bindPhone 看状态决定要不要接着查
  }, 2000);
}
export function bindPhone(root, { view, post, repaint, toast = () => {} }) {
  const box = root?.querySelector('[data-ph]');
  if (!box) return;
  if (LIVE.has(view?.pairing?.state)) poll(repaint); else stopPhonePoll();
  const act = async (body, t) => {
    if (t) t.disabled = true;
    try { const r = await post(body); const v = await loadPhone().catch(() => null); repaint(v ? { ...v, pairing: r?.pairing ?? v.pairing } : { ...view, ...(r?.pairing ? { pairing: r.pairing } : {}) }); }
    catch (e) { toast(e.message); if (t) t.disabled = false; }
  };
  // 属性写法（不是 addEventListener）：这一块被就地更新留下、又绑一次时不会叠成两份。
  box.onclick = async e => {
    const t = e.target.closest('[data-ph-act]');
    if (!t) return;
    const a = t.dataset.phAct, id = t.dataset.phId;
    if (a === 'unpair' && !(await askConfirm({ title: T.unpairAsk(t.dataset.phName), lines: [T.unpairWhat], go: T.unpair, danger: true }))) return;
    if (a === 'rename') { const name = await askText({ title: T.renameAsk, value: t.dataset.phName || '', go: T.rename, max: 40 }); if (!name) return; return act({ action: a, id, name }, t); }
    act(a === 'pair_start' ? { action: a } : { action: a, id }, t);
  };
  box.onchange = e => { const id = e.target.dataset?.phHandoff; if (id) act({ action: 'hand_off', id, allowed: e.target.checked }, e.target); };
}
