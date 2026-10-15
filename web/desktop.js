// 桌面版（Mac App）打开的是同一个工作台：它在页面里放一个 window.OfferCrewDesktop（2026-09-30，桌面版方案）。
//   { version, loginItem: { get() → Promise<boolean>, set(on) → Promise<boolean> },
//              hotkey:    { get() → Promise<string>,  set(accel) → Promise<{ ok, error? }> },
//              update:    { get() → Promise<{ current, ready, can_check, check }>, download() → Promise<同 get>, install() → Promise<boolean>, check() → Promise<同 get>, onChange(fn) } }
//   发现新版时侧栏提示下载，ready 必须等系统接收完成才出现「重启以更新」。
// 有它的时候，引导的「开工」一步和「设置 → 桌面」多两样：开机自动启动、全局快捷键；模型那一步先选「ChatGPT 账号」。
// 普通浏览器里没有它，这些都不出现。
// 「用 ChatGPT 账号登录」的界面由桌面版那条线做（接口 /api/codex，方案附录 H）：这里只在 GET /api/codex 不是 404 时留一个空槽位。

// ── 界面文字 ────────────────────────────────────────────────────────────────
const T = {
  loginItem: '开机自动启动', loginItemSub: '登录这台 Mac 时自动打开 OfferCrew。App 开着时，定时任务才会运行。',
  hotkey: '全局快捷键', hotkeySub: '在任何地方按它，呼出 OfferCrew。', hotkeyDefault: '⌥⇧Space', save: '保存',
  on: '开着', off: '关着', saved: '已保存', failed: '没存上',
  title: '桌面', lead: '这些只在 Mac App 里有。',
  restart: '重启以更新', check: '检查更新',
};
export const RESTART_TO_UPDATE = T.restart;
export const CHECK_UPDATE = T.check;
export const DEFAULT_HOTKEY = T.hotkeyDefault;

export const hotkeyLabel = value => String(value || '').split('+').map(k => ({ Alt: '⌥', Option: '⌥', Shift: '⇧', Control: '⌃', Ctrl: '⌃', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘' })[k] || k).join('');
export const hotkeyAccelerator = value => String(value || '').replace(/⌘/g, 'Command+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+').replace(/⌃/g, 'Control+');

export function desktopBridge(w = typeof window === 'undefined' ? null : window) {
  const b = w?.OfferCrewDesktop;
  return b && typeof b === 'object' && typeof b.loginItem?.get === 'function' && typeof b.hotkey?.get === 'function' ? b : null;
}
export async function loadDesktop(b = desktopBridge()) {
  if (!b) return null;
  const up = updateBridge(b);
  const [loginItem, hotkey, update] = await Promise.all([b.loginItem.get().catch(() => null), b.hotkey.get().catch(() => ''), up ? up.get().catch(() => null) : null]);
  return { version: b.version || null, loginItem: loginItem === true, hotkey: hotkey || T.hotkeyDefault, update };
}

// ── 更新：共用桌面 updater；普通网页、没有新版时都不放入口 ────────────────────────────
export const updateBridge = (b = desktopBridge()) => (b && typeof b.update?.get === 'function' && typeof b.update?.install === 'function' ? b.update : null);
export function updateNotice(u) {
  const version = u?.ready || u?.check?.version;
  if (!version || (u.can_check === false && !u.ready)) return null;
  const state = u.ready ? 'ready' : u.check?.state, percent = Number.isFinite(u.check?.percent) ? Math.max(0, Math.min(100, Math.floor(u.check.percent))) : null;
  const common = { state, version, percent, detail: `新版 ${version}` };
  if (state === 'ready') return { ...common, label: T.restart, action: 'install', detail: `${version} 已下好` };
  if (state === 'available') return { ...common, label: '下载更新', action: 'download' };
  if (state === 'error') return { ...common, label: '重试更新', action: 'download', detail: u.check.text || '更新没完成，点击重试' };
  if (state === 'downloading') return { ...common, label: `正在下载${percent == null ? '…' : ` ${percent}%`}` };
  if (state === 'preparing') return { ...common, label: '正在准备更新…' };
  if (state === 'checking') return { ...common, label: '正在检查新版…' };
  return null;
}
export function updateButtonHtml(u, esc, { busy = null, error = '' } = {}) {
  const n = updateNotice(u);
  if (!n) return '';
  if (busy === 'install') { n.label = '正在重启…'; n.action = null; }
  else if (busy && n.state === 'available') { n.label = '开始下载…'; n.action = null; }
  if (error) { n.label = u.ready ? '重试重启' : '重试更新'; n.detail = error; n.state = 'error'; }
  const title = `${n.label} · ${u.current ? `${u.current} → ` : ''}${n.version} · ${n.detail}`;
  const working = !!busy || ['downloading', 'preparing', 'checking'].includes(n.state);
  const icon = working ? '<path d="M21 12a9 9 0 1 1-9-9"/>' : n.state === 'ready' ? '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1"/>' : '<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>';
  return `<button type="button" class="sb-update sb-update--${n.state}${working ? ' sb-update--working' : ''}" data-app-update="${n.action || ''}" title="${esc(title)}" aria-label="${esc(title)}" aria-busy="${working}" ${!n.action || busy ? 'disabled' : ''}><span class="sb-update-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${n.state === 'available' && !working ? '<i></i>' : ''}</span><span class="sb-update-copy"><b>${esc(n.label)}</b><small>${esc(n.detail)}</small></span>${n.state === 'downloading' && n.percent != null ? `<span class="sb-update-progress" style="width:${n.percent}%"></span>` : ''}</button>`;
}
const escText = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// 侧栏底部：普通浏览器里没有桥，什么都不放。
export function mountAppUpdate(host = typeof document === 'undefined' ? null : document.querySelector('.sidebar'), up = updateBridge()) {
  if (!host || !up) return null;
  const box = host.ownerDocument.createElement('div');
  box.id = 'app-update';
  box.setAttribute('aria-live', 'polite');
  host.insertBefore(box, host.querySelector('.nav-account'));
  let current = null, busy = null, error = '', revision = 0;
  const paint = () => { const html = updateButtonHtml(current, escText, { busy, error }); if (box.innerHTML !== html) box.innerHTML = html; };
  box.onclick = (async e => {
    const btn = e.target.closest('[data-app-update]');
    if (!btn || btn.disabled || busy || !box.contains(btn)) return;
    const action = updateNotice(current)?.action;
    if (!action) return;
    busy = action; error = ''; paint();
    try {
      const result = await up[action]();
      if (action === 'install' && result === true) return; // App 正在退出；一直保留「正在重启」。
      if (action === 'download' && result?.check) current = result;
      else error = action === 'install' ? '没能重启，点击再试' : '没能开始下载，点击再试';
    } catch { error = action === 'install' ? '没能重启，点击再试' : '没能开始下载，点击再试'; }
    busy = null; paint();
  });
  up.onChange?.(u => { revision++; current = u; error = ''; paint(); });
  // 初次读取晚于进度事件返回时，不把新状态盖回旧快照。
  up.get().then(u => { if (!revision) { current = u; paint(); } }, () => {});
  return box;
}

// ── 画：引导的「开工」一步和「设置 → 桌面」共用 ────────────────────────────────────
export function desktopControlsHtml(d, esc) {
  if (!d) return '';
  return `<div class="dk" data-dk><label class="ob-switch dk-row"><input type="checkbox" data-dk-login ${d.loginItem ? 'checked' : ''}><span class="ob-switch-body"><b>${esc(T.loginItem)}</b><small>${esc(T.loginItemSub)}</small></span></label><form class="dk-row dk-hotkey" data-dk-hotkey><span class="ob-switch-body"><b>${esc(T.hotkey)}</b><small>${esc(T.hotkeySub)}</small></span><span class="pf-inline"><input name="accel" value="${esc(hotkeyLabel(d.hotkey))}" placeholder="${esc(T.hotkeyDefault)}" aria-label="${esc(T.hotkey)}" maxlength="40"><button type="submit" class="secondary">${esc(T.save)}</button></span><span class="dk-err" role="alert"></span></form></div>`;
}
export const desktopSectionHtml = (d, esc) => (d ? `<section class="panel" id="settings-desktop"><div class="panel-heading"><h2>${esc(T.title)}</h2><span class="muted small">${esc(T.lead)}${d.version ? ` · v${esc(d.version)}` : ''}</span></div><div class="ph-wrap">${desktopControlsHtml(d, esc)}</div></section>` : '');

export function bindDesktop(root, { toast = () => {}, b = desktopBridge() } = {}) {
  const box = root?.querySelector('[data-dk]');
  if (!box || !b) return;
  const login = box.querySelector('[data-dk-login]'), hotkey = box.querySelector('[data-dk-hotkey]');
  if (login) login.onchange = (async e => {
    const want = e.target.checked;
    e.target.disabled = true;
    try { const now = await b.loginItem.set(want); e.target.checked = now === true; toast(now === want ? T.saved : T.failed); }
    catch (x) { e.target.checked = !want; toast(x?.message || T.failed); }
    e.target.disabled = false;
  });
  if (hotkey) hotkey.onsubmit = (async e => {
    e.preventDefault();
    const form = e.target, err = form.querySelector('.dk-err'), accel = hotkeyAccelerator(form.accel.value.trim() || T.hotkeyDefault);
    err.textContent = '';
    try { const r = await b.hotkey.set(accel); if (r?.ok) { form.accel.value = hotkeyLabel(accel); toast(T.saved); } else err.textContent = r?.error || T.failed; }
    catch (x) { err.textContent = x?.message || T.failed; }
  });
}

// 「用 ChatGPT 账号登录」的槽位：GET /api/codex 有回应（不是 404）才留。
export async function codexSlotWanted() {
  try { const r = await fetch('/api/codex'); return r.status !== 404; } catch { return false; }
}
export const codexSlotHtml = () => '<div id="ob-codex-login" class="ob-codex-slot" data-slot="codex-login" aria-label="用 ChatGPT 账号登录"></div>';
