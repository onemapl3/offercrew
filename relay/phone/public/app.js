// OfferCrew 手机网页的外壳（中转发的）：配对；配对以后从电脑取来手机 App（引擎仓库 web/phone/，对话 / 等你 / 我的）的代码包，
// 交给 service worker，回到 /app/ 就是手机 App（sw.js）。所有内容都是和电脑之间端到端加密的（client.js），中转看不到。
// 电脑不在线又还没有代码包时，这里只说「电脑不在线」，电脑一上线就接着取。
// 没有框架、不打包：状态放在 S 里，render() 整块重画，事件用 data-* 委托。
import * as C from './crypto.js';
import { PhoneClient } from './client.js';
import { idbStore, appVersion, installBundle, clearApp, keepFresh } from './shared.js';

// ── 界面文字（只做中文；以后做英文就换这一处） ──────────────────────────────────
const T = {
  brand: 'OfferCrew',
  pairTitle: '连上你的电脑',
  pairLead: '手机是电脑上 OfferCrew 的遥控器：看进度、回信、跟团队说话。活还是在电脑上干。',
  pairSteps: ['在电脑上打开 OfferCrew，进「设置 → 手机」，点「扫码配对手机」。', '点下面的「扫码」对准电脑上的二维码；扫不了就输入配对码。', '两边会显示同一串 6 位数字，一样就在电脑上点「一样，确认配对」。'],
  scan: '扫码', codeOr: '或者输入电脑上的配对码', codePh: '比如 K7Q-2MX', connect: '连接',
  scanHint: '对准电脑屏幕上的二维码', cancel: '取消', camErr: '打不开摄像头。可以在系统设置里允许，或者直接输入配对码。',
  install: '在 Safari 里点「分享」→「添加到主屏幕」，以后从主屏幕打开，用起来像一个 App。',
  sasTitle: '核对数字', sasLead: '电脑上会出现同一串数字。一样的话，在电脑上点「一样，确认配对」。', sasWait: '等电脑上确认…', sasBad: '不一样，取消',
  connecting: '正在连接你的电脑…',
  macOff: '电脑不在线', oldMac: '电脑上的 OfferCrew 要先更新到新版本',
  noSw: '这个浏览器打不开手机 App。iPhone 请用 Safari（iOS 17 以上），安卓请用新版 Chrome。',
  forget: '在这部手机上忘掉这台电脑', forgetAsk: '忘掉以后要重新配对。电脑上的配对也请在「设置 → 手机」里解除。确定吗？',
  revoked: '电脑上解除了和这部手机的配对。要继续用，重新配对一次。',
};

// 第一版的主页在 localStorage 里存过最近的信和对话：手机上不再存电脑的数据，打开时清掉。
try { localStorage.removeItem('oc.chat'); localStorage.removeItem('oc.last'); } catch {}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const deviceName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? '安卓手机' : '我的手机'; };
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad/.test(navigator.userAgent);

const S = { screen: 'boot', error: '', sas: null, pairing: null, account: null, mac: null, link: 'off', why: '', toast: '' };
const client = new PhoneClient({ C, base: location.origin, store: idbStore(), onEvent: onClientEvent });

function onClientEvent(type, e) {
  if (type === 'link') { S.link = e.state; render(); }
  if (type === 'mac') { S.mac = e.online; if (e.online && S.screen === 'wait') openApp(); render(); }
  if (type === 'revoked') { S.account = null; S.screen = 'pair'; S.error = T.revoked; clearApp().catch(() => {}); render(); }
}

// ── 画 ──────────────────────────────────────────────────────────────────────
const mark = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3"><circle cx="16" cy="16" r="13.5"/><circle cx="16" cy="16" r="6.5"/></g></svg>';
function header(extra = '') { return `<header class="top">${mark}<b>${T.brand}</b><span class="grow"></span>${extra}</header>`; }
function pill() {
  if (S.link !== 'online') return `<span class="pill is-wait"><i></i>${T.linkConn}</span>`;
  return S.mac ? `<span class="pill is-on"><i></i>${T.macOn}</span>` : `<span class="pill is-off"><i></i>${T.macOff}</span>`;
}
function pairScreen() {
  const scanning = S.scanning ? `<div class="scan"><video playsinline muted></video><p>${T.scanHint}</p><button type="button" class="secondary" data-act="scan-stop">${T.cancel}</button></div>` : '';
  return `${header()}<main class="pair">
    <h1>${T.pairTitle}</h1><p class="lead">${T.pairLead}</p>
    <ol class="steps">${T.pairSteps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    ${S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''}
    ${scanning || `<button type="button" class="primary big" data-act="scan">${T.scan}</button>`}
    <p class="or">${T.codeOr}</p>
    <form class="code" data-form="code"><input name="code" inputmode="latin" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="7" placeholder="${T.codePh}" aria-label="配对码"><button type="submit" class="secondary">${T.connect}</button></form>
    ${isIos() && !standalone() ? `<p class="hint">${T.install}</p>` : ''}
  </main>`;
}
function sasScreen() {
  const sas = S.sas ? `${S.sas.slice(0, 3)} ${S.sas.slice(3)}` : '';
  return `${header()}<main class="pair">${S.sas ? `<h1>${T.sasTitle}</h1><p class="sas" aria-label="核对数字">${esc(sas)}</p><p class="lead">${T.sasLead}</p><p class="wait"><i class="spin"></i>${T.sasWait}</p><button type="button" class="secondary" data-act="pair-abort">${T.sasBad}</button>` : `<p class="wait"><i class="spin"></i>${T.connecting}</p>`}</main>`;
}
function waitScreen() {
  return `${header()}<main class="pair">${S.why === 'nosw' ? `<p class="err">${T.noSw}</p>` : `<h1>${S.why === 'old' ? T.oldMac : T.macOff}</h1>${S.why === 'old' ? '' : `<p class="wait"><i class="spin"></i>${T.connecting}</p>`}`}
    <footer class="foot"><button type="button" class="link" data-act="forget">${T.forget}</button></footer></main>`;
}
function render() {
  const app = $('#app');
  if (!app) return;
  const active = document.activeElement, keep = active && active.name && active.closest('form') ? { form: active.closest('form').dataset.form, id: active.closest('form').dataset.id || '', name: active.name, value: active.value, start: active.selectionStart } : null;
  const html = S.screen === 'pair' ? pairScreen() : S.screen === 'sas' ? sasScreen() : S.screen === 'wait' ? waitScreen() : S.screen === 'unsupported' ? `${header()}<main class="pair"><p class="err">${esc(S.error)}</p></main>` : `<p class="boot">${T.connecting}</p>`;
  app.innerHTML = html + (S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : '');
  if (keep) { const f = document.querySelector(`form[data-form="${keep.form}"]${keep.id ? `[data-id="${CSS.escape(keep.id)}"]` : ''}`), el = f?.elements?.[keep.name]; if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.start, keep.start); } catch {} } }
  if (S.scanning) startVideo();
}

// ── 配对 ──
async function pair(opts) {
  S.screen = 'sas'; S.sas = null; S.error = ''; render();
  try {
    const p = await client.pair({ ...opts, name: deviceName() });
    S.pairing = p;
    p.sas.then(({ sas }) => { S.sas = sas; render(); }, () => {});
    await p.done;
    S.pairing = null; S.account = await client.account(); S.screen = 'boot'; render();
    await client.connect();
    await enter();
  } catch (e) { S.pairing = null; S.screen = 'pair'; S.error = e.message; render(); }
}

// ── 配对以后：打开手机 App ──
// 代码包经加密通道从电脑取来，写进 Cache Storage（shared.js），service worker 从那里给页面代码；然后回到 /app/，service worker 给的就是手机 App。
// 取不到：电脑不在线（等它上线再取）、电脑上的 OfferCrew 太旧（包里没有手机 App）、浏览器不支持 service worker。
async function enter() {
  if (await openApp()) return;
  S.screen = 'wait'; render();
}
let opening = null, pendingHash = '';
function openApp() { return opening || (opening = tryOpen().catch(() => false).finally(() => { opening = null; })); }
async function tryOpen() {
  const sw = navigator.serviceWorker;
  if (!sw || !window.caches) { S.why = 'nosw'; return false; }
  if (!(await appVersion())) {
    if (!(await client.waitOnline(10000)) || S.mac === false) { S.why = 'off'; return false; }
    let b;
    try { b = await client.bundle(null, { timeoutMs: 60000 }); } catch { S.why = 'off'; return false; }
    if (!b?.files) { S.why = 'off'; return false; }
    try { await installBundle(b); } catch { S.why = 'old'; return false; }
  }
  // service worker 装好（active）就行：之后打开 /app/ 这一次导航一定经过它（controller 这一页上可能还没换过来）。
  const ready = sw.controller || (await Promise.race([sw.ready, new Promise(r => setTimeout(() => r(null), 15000))]));
  if (!ready) { S.why = 'nosw'; return false; }
  // 刚跳过去又回到这里（service worker 没给手机 App）：不来回跳，留在这一页。
  let last = 0;
  try { last = Number(sessionStorage.getItem('oc.jump')) || 0; sessionStorage.setItem('oc.jump', String(Date.now())); } catch {}
  if (Date.now() - last < 8000) { S.why = 'nosw'; return false; }
  location.replace('/app/' + (/^#(talk|wait|me)\b/.test(pendingHash) ? pendingHash : ''));
  return true;
}
// 扫码：iPhone 的 Safari 没有 BarcodeDetector，用 jsQR（/p/jsqr.js，Apache-2.0）逐帧解。
let stream = null, loopTimer = null;
async function loadJsQR() { if (window.jsQR) return window.jsQR; await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/p/jsqr.js'; s.onload = res; s.onerror = rej; document.head.append(s); }); return window.jsQR; }
async function startScan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    await loadJsQR();
    S.scanning = true; S.error = ''; render();
  } catch { stopScan(); S.error = T.camErr; render(); }
}
function startVideo() {
  const v = document.querySelector('.scan video');
  if (!v || !stream || v.srcObject === stream) return;
  v.srcObject = stream; v.play().catch(() => {});
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  clearInterval(loopTimer);
  loopTimer = setInterval(() => {
    if (!v.videoWidth) return;
    const w = 480, h = Math.round(v.videoHeight * (480 / v.videoWidth));
    canvas.width = w; canvas.height = h; ctx.drawImage(v, 0, 0, w, h);
    const r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (!r?.data) return;
    const hash = (() => { try { const u = new URL(r.data); return u.origin === location.origin && u.pathname === '/p' ? u.hash : null; } catch { return null; } })();
    stopScan();
    if (!hash || !C.parsePairFragment(hash)) { S.error = '这不是 OfferCrew 的配对码。'; render(); return; }
    pair({ fragment: hash });
  }, 250);
}
function stopScan() { clearInterval(loopTimer); loopTimer = null; stream?.getTracks().forEach(t => t.stop()); stream = null; S.scanning = false; }

// ── 事件 ──
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  if (act === 'scan') return startScan();
  if (act === 'scan-stop') { stopScan(); return render(); }
  if (act === 'pair-abort') { S.pairing?.abort(); return; }
  if (act === 'forget') { if (!confirm(T.forgetAsk)) return; await client.forget(); await clearApp().catch(() => {}); S.account = null; S.screen = 'pair'; return render(); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form, id = f.dataset.id, data = new FormData(f);
  if (kind === 'code') return pair({ code: String(data.get('code') || '') });
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.screen === 'wait') openApp().then(ok => { if (!ok) render(); }); if (document.visibilityState === 'hidden') client.flushReplay().catch(() => {}); });
addEventListener('pagehide', () => { client.flushReplay().catch(() => {}); });

// ── 启动 ──
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  keepFresh();
  if (!(await C.x25519Supported())) { S.screen = 'unsupported'; S.error = '这台手机的浏览器太旧，不支持需要的加密方式。请把系统升级到 iOS 17 或更新；安卓请用新版 Chrome。'; return render(); }
  const hash = location.hash;
  pendingHash = /^#(talk|wait|me)\b/.test(hash) ? hash : '';
  if (hash) history.replaceState(null, '', location.pathname === '/p' || location.pathname === '/p/' ? '/app/' : location.pathname); // 一次性密钥不留在地址栏和历史里
  S.account = await client.account();
  try { if (sessionStorage.getItem('oc.revoked')) { sessionStorage.removeItem('oc.revoked'); if (!S.account) S.error = T.revoked; } } catch {}
  if (hash && C.parsePairFragment(hash)) return pair({ fragment: hash });
  if (!S.account) { S.screen = 'pair'; return render(); }
  S.screen = 'boot'; render();
  await client.connect();
  await enter();
})();
