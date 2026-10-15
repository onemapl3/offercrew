// 内置邮箱的连接框（引导的「邮箱」一步、设置 → 账号与连接 → 邮箱 共用）：认出是哪家的邮箱 → 粘贴授权码 → 测试 → 保存；
// 连上以后：重新测试、换授权码、断开。接口是 /api/mail（lib/mail/api.mjs）：授权码只在这一次请求里过一下，页面不存、不回显。
// 「怎么拿授权码」是一个链接，打开 /help/mail-auth-code 对应的那一节（docs/mail-auth-code.md）。
//
// 用法：const S = mailState(); 画 mailConnectHtml(S, esc)，绑 bindMailConnect(root, S, { post, address, repaint })。
//   post(path, body) 带 token 的 POST；address() 现在要连的地址（引导里是同一屏上那个输入框）；repaint() 重画。
import { askConfirm } from './settings/ask.js';

// askAddress：没连上时框里自己带一个地址输入框（设置页；引导那一屏上面已经有了）。
export const mailState = ({ askAddress = false } = {}) => ({ view: null, info: null, infoFor: '', address: '', addressEdited: false, askAddress, code: '', login: '', busy: '', detecting: '', detectSeq: 0, result: null, err: '', changing: false });
const normalizedAddress = a => String(a || '').trim().toLowerCase();
const draftAddress = S => S.addressEdited || S.address ? S.address : S.view?.address || '';

export async function loadMail(S) {
  const r = await fetch('/api/mail');
  const v = await r.json();
  if (!r.ok) throw Error(v.error || '读取邮箱状态失败');
  // 只换连接状态。你填的授权码、「正在测试」、上一次的结果都不动（第 6 轮：设置页在后台刷新时重新读一遍状态，以前顺手把这些清空了——
  // 粘贴完一点「测试」，焦点一离开输入框，暂缓的刷新就跑了，框变空、按钮不灰、结果画到了看不见的旧页面上，看起来就是「没有反应」）。
  const previousAddress = normalizedAddress(S.view?.address);
  S.view = v;
  // 没连上时 GET 已经带着按资料里的地址认出的那一家（label、code、help），不用再认一次。
  // GET 描述的是已保存的资料，不是正在输入的地址。不能把旧地址的识别结果盖回新地址，也不能抢过尚未完成的检测。
  if (!v.connected && !v.status && v.address && !S.addressEdited && !S.address && !S.changing && !S.detecting && (!S.infoFor || S.infoFor === previousAddress)) {
    S.info = v.provider || v.reason ? { provider: v.provider, label: v.label, code: v.code, help: v.help, how: v.how, custom_domain: v.custom_domain, reason: v.reason } : null;
    S.infoFor = normalizedAddress(v.address);
  }
  return v;
}

// 按钮上的字：点了马上换成在做什么。
const BUSY = { test: '正在测试…', save: '正在保存…', retest: '正在测试…', disconnect: '正在断开…', change: '换授权码', cancel: '取消' };
const label = (S, k, text) => (S.busy === k ? BUSY[k] || text : text);
// 填了授权码还没保存（离开这一页时提醒，web/settings/accounts.js）。
export const unsavedCode = (S) => !!String(S.code || '').trim() && !S.busy && !(S.result?.saved);
const anchorOf = (info) => String(info?.help || '').split('#')[1] || '';
const helpLink = (info, esc) => (anchorOf(info) ? `<a class="mc-help" href="/help/mail-auth-code#${esc(anchorOf(info))}" target="_blank" rel="noopener">怎么拿${esc(info.code || '授权码')}</a>` : '');
// 服务器回的最新一封是 { subject, at }（以前页面直接拿对象拼字，显示成「[object Object]」）。
const latestSubject = (r) => (r.latest && typeof r.latest === 'object' ? r.latest.subject : r.latest) || '';
// 收信、发信分别一行（G9）：服务端给的 checks（lib/mail/api.mjs checksOf）；旧的服务端没有就照下面以前的写法。
const tone = ok => (ok === true ? 'ok' : ok === false ? 'bad' : 'warn');
function checksHtml(r, esc) {
  const c = r.checks, line = (k, x) => `<p class="mc-msg ${tone(x.ok)}">${k}：${esc(x.text)}${x.note ? `<br><small>${esc(x.note)}</small>` : ''}</p>`;
  const server = r.server || r.send?.server;
  return `${r.saved ? '<p class="mc-msg ok">保存好了</p>' : ''}${line('收信', c.receive)}${line('发信', c.send)}${server ? `<p class="mc-msg"><small>邮箱服务器说：${esc(server)}</small></p>` : ''}`;
}
function resultHtml(S, esc) {
  if (S.result?.disconnected) return `<p class="mc-msg ok" role="status">邮箱已断开，保存的授权码已删除。</p>${S.err ? `<p class="mc-msg bad" role="alert">重新识别邮箱时遇到问题：${esc(S.err)}。点「继续连接」可重试。</p>` : ''}`;
  if (S.err) return `<p class="mc-msg bad" role="alert">${esc(S.err)}</p>`;
  const r = S.result;
  if (!r) return '';
  if (r.checks) return checksHtml(r, esc);
  // 只收信（第 6b 轮）：收信通、发信不通，也照样能保存；写清发信为什么不通、能怎么办。
  if (r.ok && r.receive_only) return `<p class="mc-msg warn">${r.saved ? '保存好了，现在只收信' : '收信通了，发信不通'}${latestSubject(r) ? `：收件箱最新一封「${esc(latestSubject(r))}」` : ''}</p><p class="mc-msg bad">${esc(r.send?.reason || '发信服务器连不上')}${r.send?.server ? `<br><small>邮箱服务器说：${esc(r.send.server)}</small>` : ''}</p>`;
  if (r.ok) return `<p class="mc-msg ok">${r.saved ? '保存好了' : '连通了'}${latestSubject(r) ? `：收件箱最新一封「${esc(latestSubject(r))}」` : r.count === 0 ? '：收件箱是空的' : ''}</p>`;
  return `<p class="mc-msg bad" role="alert">${esc(r.reason || '没连上')}${r.server ? `<br><small>邮箱服务器说：${esc(r.server)}</small>` : ''}</p>`;
}

export function mailConnectHtml(S, esc) {
  const v = S.view || {};
  const busy = (k) => (S.busy || S.detecting ? ` disabled${S.busy === k || k === 'detect' && S.detecting ? ' aria-busy="true"' : ''}` : '');
  // 连着（或者连不上）就显示状态和三个按钮；点了「换授权码」才换成填码的框（以前写成「连着，或者连不上且没在换」，连着时换码打不开）。
  if ((v.connected || v.status) && !S.changing) {
    const ok = v.connected, only = ok && v.receive_only;
    return `<div class="mc">
      <p class="mc-line"><b>${esc(v.address || '')}</b> · ${esc(v.label || '')} <span class="mc-state ${only ? 'warn' : ok ? 'ok' : 'bad'}">${only ? '只收信' : ok ? '已连上' : '连不上'}</span></p>
      ${ok ? (only && !S.result ? `<p class="mc-msg bad">${esc(v.send_problem || '发信不通')}</p>` : '') : `<p class="mc-msg bad">${esc(v.problem || '授权码不能用了，换一个新的')}</p>`}
      ${resultHtml(S, esc)}
      <div class="mc-actions"><button type="button" class="secondary" data-mc="retest"${busy('retest')}>${label(S, 'retest', '重新测试')}</button><button type="button" class="secondary" data-mc="change"${busy('change')}>换授权码</button><button type="button" class="secondary danger" data-mc="disconnect"${busy('disconnect')}>${label(S, 'disconnect', '断开')}</button></div>
    </div>`;
  }
  const info = !S.askAddress || S.changing || normalizedAddress(draftAddress(S)) === S.infoFor ? S.info : null;
  const unsupported = info && !info.provider;
  // 码从哪儿来：一行能直接动手的，链接在浏览器里打开（第 6b 轮）；没有这一行的照旧给说明页的链接。
  const how = info?.how?.text ? `<p class="mc-how">${esc(info.how.text)}${info.how.url ? `：<a href="${esc(info.how.url)}" target="_blank" rel="noopener noreferrer">${esc(info.how.url.replace(/^https:\/\//, ''))} ↗</a>` : ''}</p>` : '';
  const which = info && !unsupported ? `<p class="mc-line"><b>${esc(info.label || '')}</b> · ${esc(info.code || '授权码')}连接${!how && helpLink(info, esc) ? ` · ${helpLink(info, esc)}` : ''}</p>${how}` : '';
  const why = unsupported ? `<p class="mc-msg bad">${esc(info.reason || '这个邮箱现在接不上')}</p>` : '';
  const fields = info && !unsupported ? `
      ${info.custom_domain ? `<label class="mc-field"><span>登录名</span><input name="mc-login" type="email" autocomplete="off" maxlength="254" value="${esc(S.login)}" placeholder="@icloud.com 那个地址"></label>` : ''}
      <label class="mc-field"><span>${esc(info.code || '授权码')}</span><input name="mc-code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="80" value="${esc(S.code)}"></label>
      <p class="mc-how">测试收信和发信登录，不会发送邮件。</p>
      <div class="mc-actions"><button type="button" class="secondary" data-mc="test"${busy('test')}>${label(S, 'test', '测试连接')}</button><button type="button" class="primary" data-mc="save"${busy('save')}>${label(S, 'save', '连接并保存')}</button>${S.changing ? `<button type="button" class="secondary" data-mc="cancel"${busy('cancel')}>取消</button>` : ''}</div>` : '';
  const addr = S.askAddress && !S.changing ? `<label class="mc-field"><span>邮箱地址</span><input name="mc-address" type="email" autocomplete="email" maxlength="254" value="${esc(draftAddress(S))}" placeholder="you@example.com"${S.busy ? ' disabled' : ''}></label>` : '';
  const intro = !S.changing ? `<p class="mc-line"><b>邮箱连接</b><span class="mc-state warn">未连接</span></p>${!info || unsupported ? '<p class="mc-how">支持 QQ、163 / 126、iCloud、Gmail 和 Yahoo；使用邮箱授权码或应用专用密码连接。</p>' : ''}` : '';
  const next = !info || unsupported ? `<div class="mc-actions"><button type="button" class="primary" data-mc="detect"${busy('detect')}>${S.detecting ? '正在识别邮箱…' : '继续连接'}</button>${S.changing ? `<button type="button" class="secondary" data-mc="cancel"${busy('cancel')}>取消</button>` : ''}</div>` : '';
  return `<div class="mc">${intro}${addr}${which}${why}${next}${fields}${resultHtml(S, esc)}</div>`;
}

// 地址变了才重新认一次（认邮箱可能要查一次 MX）。
export async function detectMail(S, address, post) {
  const a = normalizedAddress(address);
  if (a && a === S.infoFor && (S.info?.provider || S.detecting)) return false;
  if (a !== S.infoFor) { S.code = ''; S.login = ''; }
  const seq = ++S.detectSeq;
  S.infoFor = a; S.info = null; S.result = null; S.err = '';
  S.detecting = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) { S.err = a ? '邮箱地址不完整，再看一下' : '先填邮箱地址'; return true; }
  S.detecting = a;
  try { const info = await post('/api/mail', { action: 'detect', address: a }); if (seq !== S.detectSeq) return false; S.info = info; }
  catch (e) { if (seq !== S.detectSeq) return false; S.err = e.message; }
  finally { if (seq === S.detectSeq) S.detecting = ''; }
  return true;
}

// root 可以是元素，也可以是一个函数，每次回页面上现在的那一块（设置页后台刷新会换掉整页）。
export function bindMailConnect(root, S, { post, address, repaint, onSaved = () => {} }) {
  const box = (typeof root === 'function' ? root() : root)?.querySelector('.mc');
  if (!box) return;
  const currentAddress = () => S.changing ? S.view?.address : S.askAddress ? draftAddress(S) : address();
  // 检测开始时只更新按钮，别替换仍在编辑的地址框；否则 Enter 引起的重画又触发 blur/change，可能把整张表单移除两次。
  const detectionFeedback = () => {
    box.querySelectorAll('button, [name="mc-code"], [name="mc-login"]').forEach(el => { el.disabled = !!(S.busy || S.detecting); });
    const next = box.querySelector('[data-mc="detect"]');
    if (next) { next.textContent = S.detecting ? '正在识别邮箱…' : '继续连接'; if (S.detecting) next.setAttribute('aria-busy', 'true'); else next.removeAttribute('aria-busy'); }
  };
  const detect = async () => { const work = detectMail(S, currentAddress(), post); detectionFeedback(); if (await work) repaint(); };
  box.oninput = ((e) => {
    if (e.target.name === 'mc-code') S.code = e.target.value;
    if (e.target.name === 'mc-login') S.login = e.target.value;
    if (e.target.name === 'mc-address') {
      const changed = normalizedAddress(e.target.value) !== normalizedAddress(draftAddress(S));
      S.address = e.target.value; S.addressEdited = true;
      if (changed) {
        S.detectSeq++; S.detecting = ''; S.info = null; S.infoFor = ''; S.code = ''; S.login = ''; S.result = null; S.err = '';
        box.querySelectorAll('[name="mc-code"], [name="mc-login"]').forEach(el => { el.value = ''; });
        detectionFeedback();
      }
    }
  });
  box.querySelector('[name="mc-address"]')?.addEventListener('change', detect);
  box.querySelector('[name="mc-address"]')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !S.busy) { e.preventDefault(); void detect(); } });
  box.onclick = (async (e) => {
    const b = e.target.closest('[data-mc]');
    if (!b || S.busy || S.detecting) return;
    const act = b.dataset.mc;
    if (act === 'detect') return detect();
    if (act === 'change') {
      S.changing = true; S.result = null; S.err = ''; S.code = '';
      const work = detectMail(S, S.view?.address, post); repaint(); await work; return repaint();
    }
    if (act === 'cancel') { S.changing = false; S.code = ''; S.result = null; S.err = ''; return repaint(); }
    if (act === 'disconnect' && !(await askConfirm({ title: '断开邮箱？', lines: ['保存的授权码会删掉，之后不再读信、发信；要再用得重新填授权码。'], go: '断开', danger: true }))) return;
    const disconnectedAddress = act === 'disconnect' ? S.view?.address : null;
    if ((act === 'test' || act === 'save') && (!S.info?.provider || S.infoFor !== normalizedAddress(currentAddress()))) return detect();
    S.busy = act; S.err = ''; S.result = null; repaint();
    try {
      const addr = currentAddress();
      const body = act === 'test' || act === 'save' ? { action: act, address: addr, code: S.code, ...(S.login.trim() ? { login: S.login.trim() } : {}) } : { action: act };
      const r = await post('/api/mail', body);
      S.result = act === 'disconnect' ? null : r;
      if (r.mail) S.view = r.mail;
      if (act === 'save' && r.saved) { S.code = ''; S.changing = false; onSaved(r); }
      if (act === 'disconnect') {
        S.code = ''; S.login = ''; S.changing = false; S.info = null; S.infoFor = '';
        if (S.askAddress) { S.address = disconnectedAddress || ''; S.addressEdited = true; }
        await detectMail(S, currentAddress(), post);
        S.result = { disconnected: true };
      }
    } catch (x) { S.err = x.message; }
    S.busy = '';
    repaint();
  });
}
