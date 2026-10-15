// 左下角的 OfferCrew 账户（10-03）：没登录是「登录」；登录了是头像（邮箱的第一个字）和邮箱。
// 点开一个小面板：补给还剩多少（不限时，不写到期）；「最近用掉的」一行一次（做了什么、多少 token、什么时候）；设置；退出登录。
// 10-03 负责人：不登录看不到主界面，所以登录在最前面——打开工作台先是一整页登录（loginGate），登录了才进主界面；退出、令牌作废都回到这一页。
// 这个版本没配中转（开源、fork）和演示沙盒不拦（can_login 为 false），不然 App 打不开。
// 登录框：邮箱 → 收验证码 → 填验证码（K40：新用户的验证码进过 Gmail 垃圾邮件，这一页提一句，能重发）；或者「用 Google 登录」（系统浏览器打开中转，回到工作台自己的回环地址，lib/account.mjs）。
// 数据：GET /api/account（lib/account.mjs accountView）；POST /api/account { action: email_start | email_verify | google_start | logout }。
// 别处要登录就发 oc:login（设置里补给那块、引导、收件箱「要登录」那封信走 #login）；登录、退出以后这里发 oc:account。
let h = null, A = null, open = false, rowsAt = 0;
const L = { el: null, step: 'email', email: '', busy: false, err: '', resendAt: 0, timer: null, poll: null, gate: false, token: '' };
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const PRIVACY = '登录用的邮箱存在 OfferCrew 的中转上，只用来登录和记补给用量。';

async function post(body) {
  const r = await fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Radar-Token': h?.token?.() || L.token || '' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, body: d };
}
async function load({ rows = false } = {}) {
  try { const r = await fetch(`/api/account${rows ? '' : '?rows=0'}`); if (r.ok) { const prev = A; A = await r.json(); if (A.token) { L.token = A.token; delete A.token; } if (!rows && prev?.rows && A.signed_in) A.rows = prev.rows; } } catch {}
  paint();
  return A;
}

// ── 左下角 ─────────────────────────────────────────────────────────────────────
const whenText = iso => { if (!iso) return ''; const t = new Date(iso), now = new Date(), same = t.toDateString() === now.toDateString(), hm = t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); return same ? `今天 ${hm}` : `${t.getMonth() + 1}/${t.getDate()} ${hm}`; };
function entryHtml() {
  if (!A) return '';
  if (!A.signed_in) return A.can_login ? `<button type="button" class="na-btn na-in" data-acc="login"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>登录</button>` : '';
  return `<button type="button" class="na-btn" data-acc="toggle" aria-label="打开 OfferCrew 账户" aria-expanded="${open}" aria-haspopup="dialog"><span class="na-av" aria-hidden="true">${esc(A.initial)}</span><span class="na-mail">${esc(A.email)}</span></button>${open ? panelHtml() : ''}`;
}
function panelHtml() {
  const supply = A.blocked ? `<p class="na-warn">${esc(A.blocked.reason)}</p>` : '';
  const left = A.balance_text != null ? `<div class="na-left"><span>OfferCrew 补给</span><b>${esc(A.balance_text)}<small> ${esc(A.unit || 'token')}</small></b></div>` : '';
  const rows = A.rows == null ? `<p class="na-empty">${A.reason ? esc(A.reason) : '<span class="na-spin"></span>'}</p>` : !A.rows.length ? '<p class="na-empty">还没有用过</p>' : `<ol class="na-rows">${A.rows.map(r => `<li><span>${esc(r.what)}</span><b>${esc(r.tokens_text)}</b><time datetime="${esc(r.at || '')}">${esc(whenText(r.at))}</time></li>`).join('')}</ol>`;
  return `<div class="na-panel" role="dialog" aria-label="OfferCrew 账户"><header><span class="na-av lg" aria-hidden="true">${esc(A.initial)}</span><b title="${esc(A.email)}">${esc(A.email)}</b></header>${left}${supply}<h3>最近用掉的</h3>${rows}<footer><a href="#settings/model" data-acc="close">设置</a><button type="button" class="na-out" data-acc="logout">退出登录</button></footer></div>`;
}
function paint() {
  const box = $('#nav-account');
  if (box) box.innerHTML = entryHtml();
}
async function toggle(force = !open) {
  open = force; paint();
  if (open && Date.now() - rowsAt > 15000) { rowsAt = Date.now(); await load({ rows: true }); }
}
// 退出以后回到最前面那一页登录：重新载入之前先把主区、对话面板这些清掉（第 5 轮：门后面的旧对话辅助功能还读得到）。
export function leaveToGate() {
  document.body.classList.add('is-gated');
  for (const el of document.body.querySelectorAll('#main, #panel, .pn-fab, dialog:not(#login-dialog)')) { if (el.id === 'main') el.replaceChildren(); else el.remove(); }
  location.reload();
}
async function logout() {
  const r = await post({ action: 'logout' });
  if (!r.ok) { h?.toast?.(r.body.reason || r.body.error || '没退出'); return; }
  leaveToGate();
}

// ── 登录框 ─────────────────────────────────────────────────────────────────────
function dialog() {
  if (L.el) return L.el;
  if (L.gate) {
    const g = document.createElement('div');
    g.id = 'login-gate'; g.className = 'lg-gate';
    g.innerHTML = `<div class="lg-gate-brand">${(document.querySelector('.sidebar .brand')?.innerHTML || '<b>OfferCrew</b>').replace(/brand-paw/g, 'gate-paw')}</div><div class="lg-card"></div>`;
    g.addEventListener('submit', e => { e.preventDefault(); submit(); });
    g.addEventListener('click', e => { const b = e.target.closest('[data-lg]'); if (b) act(b.dataset.lg); });
    g.addEventListener('input', e => { if (e.target.id !== 'lg-code') return; e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6 && !L.busy) verify(); });
    document.body.append(g);
    L.box = g.querySelector('.lg-card');
    return (L.el = g);
  }
  const d = document.createElement('dialog');
  d.id = 'login-dialog'; d.className = 'lg-dialog';
  d.addEventListener('close', () => { stopPoll(); clearInterval(L.timer); });
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.addEventListener('submit', e => { e.preventDefault(); submit(); });
  d.addEventListener('click', e => { const b = e.target.closest('[data-lg]'); if (b) act(b.dataset.lg); });
  // 验证码填满 6 位就直接登录（粘贴进来也一样）。
  d.addEventListener('input', e => { if (e.target.id !== 'lg-code') return; e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6 && !L.busy) verify(); });
  document.body.append(d);
  return (L.el = d);
}
function loginHtml() {
  const wait = Math.max(0, Math.ceil((L.resendAt - Date.now()) / 1000));
  const email = `<label for="lg-email">邮箱</label><input id="lg-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="输入邮箱地址" required value="${esc(L.email)}" ${L.busy ? 'disabled' : ''}><button type="submit" class="primary" ${L.busy ? 'disabled' : ''}>${L.busy === 'send' ? '正在发…' : '发验证码'}</button>`;
  const code = `<p class="lg-sent">验证码已发送至 <b>${esc(L.email)}</b></p><p class="lg-spam">没收到？看看垃圾邮件；还没有就点下面的「重新发送」。</p><label for="lg-code">验证码</label><input id="lg-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码" required ${L.busy ? 'disabled' : ''}><button type="submit" class="primary" ${L.busy ? 'disabled' : ''}>${L.busy === 'verify' ? '正在登录…' : '登录'}</button><div class="lg-links"><button type="button" class="lg-link" data-lg="resend" ${wait || L.busy ? 'disabled' : ''}>${wait ? `重新发送（${wait} 秒）` : '重新发送'}</button><button type="button" class="lg-link" data-lg="change" ${L.busy ? 'disabled' : ''}>换个邮箱</button></div>`;
  const google = L.step === 'google'
    ? `<p class="lg-sent"><span class="na-spin"></span>在浏览器里登录 Google…</p><button type="button" class="secondary lg-google" data-lg="cancel">取消</button>`
    : `<button type="button" class="secondary lg-google" data-lg="google" ${L.busy ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6z"/></svg>用 Google 登录</button>`;
  return `<form method="dialog" class="lg-form" novalidate><header><h2>登录 OfferCrew</h2>${L.gate ? '' : '<button type="button" class="lg-x" data-lg="close" aria-label="关闭">×</button>'}</header>
    ${L.err ? `<p class="lg-err" role="alert">${esc(L.err)}</p>` : ''}${L.step === 'google' ? '' : `<div class="lg-row">${L.step === 'code' ? code : email}</div>`}
    ${L.step === 'code' ? '' : `${L.step === 'google' ? '' : '<div class="lg-or"><span>或者</span></div>'}${google}`}
    <p class="lg-note">${esc(PRIVACY)}</p></form>`;
}
function paintLogin({ focus = null } = {}) {
  const d = dialog(), box = L.gate ? L.box : d;
  const kept = d.querySelector('#lg-code')?.value || '';
  box.innerHTML = loginHtml();
  if (kept && d.querySelector('#lg-code')) d.querySelector('#lg-code').value = kept;
  const f = focus && d.querySelector(focus);
  if (f) f.focus();
}
export function openLogin() {
  if (!h) return;
  Object.assign(L, { step: L.step === 'code' && L.email ? 'code' : 'email', busy: false, err: '' });
  const d = dialog();
  paintLogin();
  if (!d.open) d.showModal();
  d.querySelector(L.step === 'code' ? '#lg-code' : '#lg-email')?.focus();
}
function tick() {
  clearInterval(L.timer);
  L.timer = setInterval(() => { if (L.step !== 'code' || Date.now() > L.resendAt) clearInterval(L.timer); const b = L.el?.querySelector('[data-lg=resend]'); if (b) { const w = Math.max(0, Math.ceil((L.resendAt - Date.now()) / 1000)); b.textContent = w ? `重新发送（${w} 秒）` : '重新发送'; b.disabled = !!w || !!L.busy; } }, 1000);
}
async function send() {
  const email = (L.el.querySelector('#lg-email')?.value ?? L.email).trim();
  if (!email) { L.err = '先填邮箱'; return paintLogin({ focus: '#lg-email' }); }
  L.email = email; L.busy = 'send'; L.err = ''; paintLogin();
  const r = await post({ action: 'email_start', email });
  L.busy = false;
  if (!r.ok) { L.err = r.body.reason || '验证码没发出去'; if (r.body.retry_after) L.resendAt = Date.now() + r.body.retry_after * 1000; return paintLogin({ focus: L.step === 'code' ? '#lg-code' : '#lg-email' }); }
  L.step = 'code'; L.resendAt = Date.now() + (r.body.resend_after || 60) * 1000; tick();
  paintLogin({ focus: '#lg-code' });
}
async function verify() {
  const code = (L.el.querySelector('#lg-code')?.value || '').replace(/\D/g, '');
  if (code.length !== 6) { L.err = '验证码是 6 位数字'; return paintLogin({ focus: '#lg-code' }); }
  L.busy = 'verify'; L.err = ''; paintLogin();
  const r = await post({ action: 'email_verify', email: L.email, code });
  L.busy = false;
  if (!r.ok) { L.err = r.body.reason || '登录没成功'; paintLogin({ focus: '#lg-code' }); const i = L.el.querySelector('#lg-code'); if (i) i.select(); return; }
  done(r.body);
}
async function done(body = {}) {
  stopPoll(); clearInterval(L.timer);
  Object.assign(L, { step: 'email', busy: false, err: '', resendAt: 0 });
  // 最前面那一页登好了：重新载入，进主界面（和引导）。
  if (L.gate) { location.reload(); return; }
  L.el?.open && L.el.close();
  rowsAt = 0; await load();
  window.dispatchEvent(new CustomEvent('oc:account'));
  h?.toast?.(`登录好了${body.email || A?.email ? `：${body.email || A.email}` : ''}`);
}
function stopPoll() { clearInterval(L.poll); L.poll = null; }
async function google() {
  L.busy = 'google'; L.err = ''; paintLogin();
  const r = await post({ action: 'google_start' });
  L.busy = false;
  if (!r.ok || !r.body.url) { L.err = r.body.reason || 'Google 登录没打开'; return paintLogin(); }
  // 桌面版：外部地址交给系统浏览器（desktop/main.mjs setWindowOpenHandler）；浏览器里就是新标签页。
  window.open(r.body.url, '_blank', 'noopener');
  L.step = 'google'; paintLogin();
  const until = Date.now() + 10 * 60000;
  stopPoll();
  L.poll = setInterval(async () => {
    if (Date.now() > until) { stopPoll(); L.step = 'email'; L.err = '登录超时了，请重新点 Google 登录。'; return paintLogin(); }
    try { const a = await (await fetch('/api/account?rows=0')).json(); if (a.signed_in) { A = a; done({ email: a.email }); } } catch {}
  }, 2000);
}
function submit() { if (L.busy) return; if (L.step === 'code') verify(); else if (L.step === 'email') send(); }
function act(k) {
  if (k === 'close') return L.gate ? null : L.el.close();
  if (k === 'resend') return send();
  if (k === 'change') { Object.assign(L, { step: 'email', err: '', resendAt: 0 }); return paintLogin({ focus: '#lg-email' }); }
  if (k === 'google') return google();
  if (k === 'cancel') { stopPoll(); Object.assign(L, { step: 'email', err: '' }); return paintLogin(); }
}

// ── 最前面那一页 ────────────────────────────────────────────────────────────────
// 没登录、而且这个版本能登录：盖一整页登录，返回的 Promise 不结束（登好了重新载入）；登着或者不用登录就马上结束。
export async function loginGate() {
  const a = await load();
  if (!a || a.signed_in || !a.can_login) return;
  L.gate = true;
  document.body.classList.add('is-gated');
  paintLogin({ focus: '#lg-email' });
  return new Promise(() => {});
}

// ── 启动 ───────────────────────────────────────────────────────────────────────
export function initAccount(helpers) {
  h = helpers;
  const box = $('#nav-account');
  if (box) box.addEventListener('click', e => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    const k = b.dataset.acc;
    if (k === 'login') openLogin();
    else if (k === 'toggle') toggle();
    else if (k === 'logout') logout();
    else if (k === 'close') toggle(false);
  });
  // 点在面板外面就收起；刚被重画掉的按钮（已经不在页面上）不算外面。
  document.addEventListener('click', e => { if (open && e.target.isConnected && !e.target.closest('#nav-account')) toggle(false); });
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') toggle(false); });
  window.addEventListener('oc:login', () => openLogin());
  // 别处退出了登录（设置里补给那块）：回到最前面那一页。
  window.addEventListener('oc:account', async () => { const a = await load(); if (a && !a.signed_in && a.can_login) leaveToGate(); });
  // 对话流完时带回最新的余额（web/talk.js 发 oc:supply）：面板上的数跟着变，不再去问。
  window.addEventListener('oc:supply', e => { const n = e.detail; if (A?.signed_in && n?.show && n.balance != null) { A.balance = n.balance; A.balance_text = n.text; paint(); } });
  load();
}
