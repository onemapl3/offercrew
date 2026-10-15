// 内置操作员的浏览器层（2026-09-28）：一个很小的 Page 接口，背后可以换不同的浏览器。
//
//   goto(url) · observe() · click(id) · fill(id, text) · select(id, option) · check(id, on)
//   upload(id, path) · press(key) · scroll(dir) · screenshot(path) · url() · close({ keep })
//
// observe() 在页面里跑一次 extractPage：给看得见的可操作控件编号（写进 data-jm-id 属性），读出标签、
// 当前值、选项。编号留在元素上，同一页再看一次，同一个控件还是同一个号——模型上一步看到的 [12]，
// 下一步说 click 12 指的就是它。动作都按编号找元素，不需要模型会写 CSS 选择器。
//
// 后端：
//   playwright  playwright-core 起一个独立的浏览器，专用登录目录（默认 private/operator-profile），
//               你在里面登录一次，以后都用它；有系统 Chrome 优先用 Chrome，没有用自带 Chromium。
//               keep_open：浏览器单独起进程、只经 DevTools 端口连，本进程退出后窗口还在，填好的表留给你终审。
//   ego         已删（10-04）：ego 浏览器那条路没了，旧配置里的 backend "ego" 当作 host（专用 Chrome）。
//   cua         trycua 的 cua-driver：只做检测，浏览器动作没验证过，见 cua.mjs。
//   host        专用 Chrome（lib/browser-host.mjs，第 3 批）：和预填、扫描同一个浏览器、同一份登录状态。在一个新的任务空间窗口里
//               干活（后台开，不抢焦点）；停在终审 / 要你登录时空间交给你（「打开申请页」能切回去）；做完只关这次开的页，从不关浏览器。
//
// 页面里执行的函数（extractPage / resolveTarget / pickOption / scrollPage）是真正的函数，用 toString()
// 交给页面：不在模板字符串里拼页面代码，就不会再出 09-28 那种 \n 转义变成真换行、脚本断掉的事。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from '../spawn.mjs';
import { file } from '../store.mjs';
import { BRAND } from '../brand.mjs';
import { noteFallback } from '../fallback.mjs';
import { noteSwallowed } from '../swallow.mjs';

// ── 页面里执行的函数：不能引用外面的变量，只用参数和页面自己的全局 ─────────────────────────
export function extractPage(opts) {
  const o = Object.assign({ max: 150, text: 3000, frames: true }, opts || {});
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const cut = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const docs = [{ doc: document, frame: 0 }];
  if (o.frames) document.querySelectorAll('iframe').forEach((f, i) => { try { if (f.contentDocument && f.contentDocument.body) docs.push({ doc: f.contentDocument, frame: i + 1 }); } catch (e) { /* 兜底：跨域 iframe 读不到，只看本页；跨域 iframe 读不到 */ } });
  const SEL = 'input, select, textarea, button, a[href], summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=option], [role=menuitem], [role=tab], [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]';
  const shown = el => {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  // Web Components 把控件放在 shadow root 里，普通 querySelectorAll 看不到：连同开放的 shadow root 一起找。
  const deepAll = (root, sel, out = []) => { root.querySelectorAll(sel).forEach(n => out.push(n)); root.querySelectorAll('*').forEach(n => { if (n.shadowRoot) deepAll(n.shadowRoot, sel, out); }); return out; };
  const textOfIds = (el, ids) => { const root = el.getRootNode(); return ids.split(/\s+/).map(id => { const n = id && root.getElementById && root.getElementById(id); return n ? n.innerText || n.textContent : ''; }).join(' '); };
  const labelOf = (el, doc, tag, type) => {
    const role = el.getAttribute('role') || '';
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = clean(textOfIds(el, by)); if (t) return t; }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const buttonish = tag === 'button' || tag === 'a' || tag === 'summary' || (tag === 'input' && /^(submit|button|reset|image)$/.test(type)) || /^(button|link|option|menuitem|tab|switch)$/.test(role);
    if (buttonish) {
      // 按钮、链接只认自己身上的字：没有字就是没有字（图标按钮），不去借旁边的文字——借来一个"上一步"，
      // 图标样子的提交钮就显得无害了（09-28 复审）。
      const t = clean(el.innerText || el.textContent);
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img && clean(img.alt)) return clean(img.alt);
      if (tag === 'input' && /^(submit|button|reset)$/.test(type) && clean(el.value)) return clean(el.value);
      if (tag === 'input' && type === 'image' && clean(el.alt)) return clean(el.alt);
      return clean(el.getAttribute('title'));
    }
    if (el.labels && el.labels.length) { const t = clean([...el.labels].map(l => l.innerText || l.textContent).join(' ')); if (t) return t; }
    if (/^(checkbox|radio)$/.test(role)) { const t = clean(el.innerText || el.textContent); if (t) return t; }
    const ph = clean(el.getAttribute('placeholder')); if (ph) return ph;
    const title = clean(el.getAttribute('title')); if (title) return title;
    // 没有 label 的输入框（国内门户常见 div 排版）：往上找最近一层文字很短的容器，那段文字就是它的标题。
    let n = el.parentElement;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) { const t = clean(n.innerText); if (t && t.length <= 80) return t; if (t.length > 80) break; }
    return clean(el.getAttribute('name') || el.id || '');
  };
  const roleOf = (el, tag, type) => el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || tag === 'summary' ? 'button' : tag === 'select' ? (el.multiple ? 'listbox' : 'combobox') : tag === 'textarea' ? 'textbox' : tag === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'file', range: 'slider', search: 'searchbox' }[type] || 'textbox') : el.isContentEditable ? 'textbox' : 'generic');
  const valueOf = (el, tag, type, role) => {
    if (type === 'password') return '';
    // 自己画的下拉框（div role=combobox）：显示出来的文字就是当前选中的值。
    if (!/^(input|select|textarea)$/.test(tag) && /^(combobox|listbox|spinbutton)$/.test(role)) return cut(el.getAttribute('aria-valuetext') || el.innerText, 100);
    if (tag === 'select') return clean([...el.selectedOptions].map(x => x.text).join(', '));
    if (tag === 'input' && type === 'file') return [...(el.files || [])].map(f => f.name).join(', ');
    if (tag === 'input' && /^(checkbox|radio|submit|button|reset|image)$/.test(type)) return '';
    if (tag === 'input' || tag === 'textarea') return cut(el.value, 200);
    if (el.isContentEditable) return cut(el.innerText, 200);
    return '';
  };
  const cssPath = (el, doc) => {
    const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '_'));
    if (el.id && !/\d{4,}|^[a-f0-9-]{16,}$/i.test(el.id)) { const s = '#' + esc(el.id); try { if (doc.querySelectorAll(s).length === 1) return s; } catch (e) {} } // 兜底：选择器写法不合法就换下一种写法
    const name = el.getAttribute('name');
    if (name) { const s = el.tagName.toLowerCase() + '[name="' + name.replace(/["\\]/g, '\\$&') + '"]'; try { if (doc.querySelectorAll(s).length === 1) return s; } catch (e) {} } // 兜底：选择器写法不合法就换下一种写法
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== doc.body && parts.length < 8; n = n.parentElement) {
      const p = n.parentElement; if (!p) break;
      const same = [...p.children].filter(c => c.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  // 指纹：点之前在页面里再算一遍，和模型看到的那一刻对不上（按钮从"下一步"变成了"提交申请"）就不点。
  // resolveTarget 里有一份一模一样的，两处必须同步改。
  const fpOf = el => [el.tagName, el.getAttribute('type') || '', el.getAttribute('role') || '', el.getAttribute('aria-label') || '', el.tagName === 'INPUT' ? (/^(submit|button|reset|image)$/i.test(el.type) ? el.value : '') : el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.innerText || el.textContent || ''].join('|').replace(/\s+/g, ' ').trim().slice(0, 160);
  const cands = [];
  let order = 0, maxId = 0;
  for (const { doc, frame } of docs) {
    deepAll(doc, '[data-jm-id]').forEach(n => { maxId = Math.max(maxId, Number(n.getAttribute('data-jm-id')) || 0); });
    for (const el of deepAll(doc, SEL)) {
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag === 'button' ? String(el.type || 'submit').toLowerCase() : tag === 'select' ? el.type : tag === 'textarea' ? 'textarea' : el.isContentEditable ? 'contenteditable' : '';
      if (tag === 'input' && type === 'hidden') continue;
      // <a><span role=button> 这种嵌套：外层才是能点的那个，里层不重复列。
      if (!/^(input|select|textarea|a|button)$/.test(tag) && el.parentElement && el.parentElement.closest('a[href], button')) continue;
      let via = '';
      if (!shown(el)) {
        // 藏起来的文件框（上传按钮盖在上面）照样能设文件；藏起来的勾选框点它的 label。
        if (tag === 'input' && type === 'file') via = 'hidden';
        else if (tag === 'input' && (type === 'checkbox' || type === 'radio') && el.labels && [...el.labels].some(shown)) via = 'label';
        else continue;
      }
      const r = el.getBoundingClientRect(), vh = window.innerHeight || 800;
      cands.push({ el, doc, frame, tag, type, via, order: order++, dist: r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0 });
    }
  }
  // 太多就先保留表单控件、按钮，其次别的可点元素，最后才是链接；同类里离当前屏幕近的优先（往下滚就能
  // 看到下面的链接）。保留的仍按页面顺序排。
  const rank = c => (/^(input|select|textarea)$/.test(c.tag) || c.type === 'contenteditable' ? 0 : c.tag === 'button' ? 1 : c.tag === 'a' ? 3 : 2);
  const keep = cands.length > o.max ? [...cands].sort((a, b) => rank(a) - rank(b) || a.dist - b.dist || a.order - b.order).slice(0, o.max).sort((a, b) => a.order - b.order) : cands;
  let next = Math.max(Number(window.__jmNext) || 1, maxId + 1);
  const seen = new Set();
  const elements = keep.map(c => {
    const { el, doc, tag, type } = c;
    let id = Number(el.getAttribute('data-jm-id')) || 0;
    if (!id || seen.has(id)) { id = next++; el.setAttribute('data-jm-id', String(id)); }
    seen.add(id);
    const label = labelOf(el, doc, tag, type), role = roleOf(el, tag, type);
    const out = { id, role, tag, type, label: cut(label, 100), value: valueOf(el, tag, type, role), disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true') };
    const name = el.getAttribute('name'); if (name) out.name = name;
    if (el.required || el.getAttribute('aria-required') === 'true' || /[*＊]\s*$/.test(label) || /^[*＊]/.test(label)) out.required = true;
    if (tag === 'select') out.options = [...el.options].slice(0, 40).map(x => cut(x.text, 60));
    if (/^(checkbox|radio)$/.test(type) || /^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '')) out.checked = !!(el.checked || el.getAttribute('aria-checked') === 'true');
    if (tag === 'a') out.href = el.href;
    if ((tag === 'button' && type === 'submit' && el.form) || (tag === 'input' && /^(submit|image)$/.test(type) && el.form)) {
      out.submit = true;
      // 表单交到哪：读属性再自己解析（form.action 在表单里有 name="action" 的输入框时会变成那个输入框）。
      try { const u = new URL(el.getAttribute('formaction') || el.form.getAttribute('action') || '', el.baseURI); if (/^https?:$/.test(u.protocol)) out.form_action = u.href; } catch (e) {} // 兜底：表单地址写得不合法就不记，只少一条参考
    }
    const ph = el.getAttribute('placeholder'); if (ph && clean(ph) !== out.label) out.placeholder = cut(ph, 60);
    const ac = el.getAttribute('autocomplete'); if (ac) out.autocomplete = ac;
    if (/^(checkbox|radio)$/.test(type)) { const fsx = el.closest('fieldset'); const lg = fsx && fsx.querySelector('legend'); if (lg && clean(lg.innerText)) out.group = cut(lg.innerText, 80); }
    if (c.via) out.via = c.via;
    if (c.frame) out.frame = c.frame;
    out.css = cssPath(el, doc);
    out.fp = fpOf(el);
    return out;
  });
  window.__jmNext = next;
  // 已登录的证据：页面上任何地方（包括收在下拉菜单里、还没展开的）有"退出登录"一类的按钮或链接。
  const LOGOUT = /退出登录|注销|安全退出|退出账号|^退出$|sign ?out|log ?out/i, LOGOUT_URL = /logout|signout|sign[_-]out|log[_-]out/i;
  const logout = docs.some(({ doc }) => deepAll(doc, 'a, button, [role=menuitem], [role=button], [role=link]').some(n => LOGOUT.test(clean(n.getAttribute('aria-label') || n.textContent || n.getAttribute('title'))) || LOGOUT_URL.test(n.getAttribute('href') || '')));
  return {
    url: location.href,
    title: document.title,
    text: cut(document.body ? document.body.innerText : '', o.text),
    elements,
    total: cands.length,
    iframes: [...document.querySelectorAll('iframe')].slice(0, 12).map(f => f.src || '').filter(Boolean),
    signals: { logout },
  };
}

// 按编号找回元素：真正要点的目标（藏起来的勾选框点它的 label，给 label 打上 data-jm-click）。
export function resolveTarget(arg) {
  const id = String(arg && arg.id), sel = '[data-jm-id="' + id + '"]';
  const deepFind = root => root.querySelector(sel) || [...root.querySelectorAll('*')].reduce((hit, n) => hit || (n.shadowRoot ? deepFind(n.shadowRoot) : null), null);
  let el = deepFind(document), doc = document;
  if (!el && arg && arg.deep) for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument, x = d && deepFind(d); if (x) { el = x; doc = d; break; } } catch (e) {} } // 兜底：跨域 iframe 读不到，跳过这一个
  if (!el) return { found: false };
  const tag = el.tagName.toLowerCase(), type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
  const fpOf = n => [n.tagName, n.getAttribute('type') || '', n.getAttribute('role') || '', n.getAttribute('aria-label') || '', n.tagName === 'INPUT' ? (/^(submit|button|reset|image)$/i.test(n.type) ? n.value : '') : n.tagName === 'SELECT' || n.tagName === 'TEXTAREA' ? '' : n.innerText || n.textContent || ''].join('|').replace(/\s+/g, ' ').trim().slice(0, 160);
  const cs = doc.defaultView.getComputedStyle(el), r = el.getBoundingClientRect();
  const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) >= 0.05 && r.width >= 4 && r.height >= 4;
  let click = sel;
  if (!visible) { const lab = (el.labels && el.labels[0]) || el.closest('label'); if (lab) { lab.setAttribute('data-jm-click', id); click = '[data-jm-click="' + id + '"]'; } }
  return { found: true, sel, click, tag, type, visible, fp: fpOf(el), checked: !!(el.checked || el.getAttribute('aria-checked') === 'true'), password: type === 'password', file: type === 'file', select: tag === 'select' };
}

// 点击守卫：点之前挂在 window 上（捕获阶段），事件真正落到这个控件（或它的 label）时再算一次指纹，
// 对不上就把这次点击吃掉（不提交、不触发页面自己的处理）。从 trial 等待到真正点下去之间按钮变了
// （复审：透明遮罩让 Playwright 重试了十几秒），也点不到"提交申请"上。
export function armClickGuard(arg) {
  const sel = '[data-jm-id="' + arg.id + '"]';
  const deepFind = root => root.querySelector(sel) || [...root.querySelectorAll('*')].reduce((hit, n) => hit || (n.shadowRoot ? deepFind(n.shadowRoot) : null), null);
  const el = deepFind(document);
  if (!el) return false;
  const fpOf = n => [n.tagName, n.getAttribute('type') || '', n.getAttribute('role') || '', n.getAttribute('aria-label') || '', n.tagName === 'INPUT' ? (/^(submit|button|reset|image)$/i.test(n.type) ? n.value : '') : n.tagName === 'SELECT' || n.tagName === 'TEXTAREA' ? '' : n.innerText || n.textContent || ''].join('|').replace(/\s+/g, ' ').trim().slice(0, 160);
  const within = t => !!t && (t === el || (el.contains && el.contains(t)) || [...(el.labels || [])].some(l => l === t || l.contains(t)));
  const handler = ev => {
    const path = ev.composedPath ? ev.composedPath() : [ev.target];
    if (!path.some(within)) return;
    if (fpOf(el) !== arg.fp) { ev.preventDefault(); ev.stopImmediatePropagation(); window.__jmBlocked = (window.__jmBlocked || 0) + 1; }
  };
  if (window.__jmGuard) for (const t of window.__jmGuard.types) window.removeEventListener(t, window.__jmGuard.handler, true);
  const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick'];
  for (const t of types) window.addEventListener(t, handler, true);
  window.__jmGuard = { handler, types };
  window.__jmBlocked = 0;
  // 万一没人来撤：20 秒后自己撤掉，不影响你之后在这页上手动操作。
  setTimeout(() => { if (window.__jmGuard && window.__jmGuard.handler === handler) { for (const t of types) window.removeEventListener(t, handler, true); window.__jmGuard = null; } }, 20000);
  return true;
}
export function disarmClickGuard() {
  const g = window.__jmGuard;
  if (g) for (const t of g.types) window.removeEventListener(t, g.handler, true);
  window.__jmGuard = null;
  const blocked = window.__jmBlocked || 0;
  window.__jmBlocked = 0;
  return blocked;
}

// 下拉框按看得见的文字选：完全一样 > value 一样 > 开头一样 > 包含。选不到就把可选项带回去给模型。
export function pickOption(arg) {
  const sel = '[data-jm-id="' + arg.id + '"]';
  const find = root => root.querySelector(sel) || [...root.querySelectorAll('*')].reduce((hit, n) => hit || (n.shadowRoot ? find(n.shadowRoot) : null), null);
  let el = find(document);
  if (!el) for (const f of document.querySelectorAll('iframe')) { try { el = f.contentDocument && find(f.contentDocument); if (el) break; } catch (e) {} } // 兜底：跨域 iframe 读不到，跳过这一个
  if (!el || el.tagName.toLowerCase() !== 'select') return { found: false, reason: 'not_a_select' };
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(arg.option), opts = [...el.options];
  const hit = opts.find(o => norm(o.text) === want) || opts.find(o => norm(o.value) === want) || opts.find(o => want && norm(o.text).startsWith(want)) || opts.find(o => want && norm(o.text).includes(want)) || opts.find(o => norm(o.text) && want.includes(norm(o.text)));
  return hit ? { found: true, value: hit.value, text: hit.text.trim() } : { found: false, reason: 'option_not_found', options: opts.slice(0, 30).map(o => o.text.trim()) };
}

export function scrollPage(dir) {
  const h = window.innerHeight || 800;
  window.scrollBy(0, dir === 'up' ? -0.8 * h : 0.8 * h);
  return { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight) };
}

// ── Playwright ────────────────────────────────────────────────────────────────────────────
export async function loadPlaywright() {
  try { return await import('playwright-core'); }
  catch (e) { throw Object.assign(Error('playwright_core_missing：内置操作员的浏览器要 playwright-core（在项目目录运行 npm install）'), { code: 'playwright_missing', cause: e }); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 给可能卡住的调用设上限；结束后清掉定时器（不清的话，一个 20 秒的空定时器会让进程白等 20 秒才退出）。
const withTimeout = (promise, ms, message) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]).finally(() => clearTimeout(timer)); };
const CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  win32: [path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['LOCALAPPDATA'] || os.homedir(), 'Google/Chrome/Application/chrome.exe')],
};
const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } }; // 兜底：文件不在或读不到就当没有这个浏览器，下面会换下一个路径
// keep_open 自己起进程，要知道可执行文件：优先系统 Chrome，其次 Playwright 自带的 Chromium。
export function browserExecutable(pw, { channel = 'auto', executable_path = null } = {}) {
  if (executable_path) return executable_path;
  const chrome = (CHROME_PATHS[process.platform] || []).find(exists);
  if (chrome && channel !== 'chromium') return chrome;
  const bundled = pw.chromium.executablePath();
  if (exists(bundled)) return bundled;
  throw Error(`operator_browser_missing：没找到 Chrome，也没有自带 Chromium（npx playwright-core install chromium）`);
}
const launchHint = e => {
  const m = String(e?.message || e);
  if (/Executable doesn't exist|browserType\.launch.*not found|is not found at|distribution .* not found/i.test(m)) return Error(`operator_browser_missing：没有可用的浏览器（装 Chrome，或 npx playwright-core install chromium）\n${m.split('\n')[0]}`);
  return e;
};

export async function openPlaywright(options = {}) {
  const o = { profile_dir: 'private/operator-profile', headless: false, channel: 'auto', keep_open: false, viewport: { width: 1280, height: 900 }, timeout_ms: 15000, ...options };
  const pw = options.playwright || await loadPlaywright();
  const profile = path.isAbsolute(o.profile_dir) ? o.profile_dir : file(o.profile_dir);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (o.keep_open) return attachDetached(pw, profile, o);
  // auto：先试系统 Chrome（登录态、指纹都更像真人），没有再用自带 Chromium；chromium = 只用自带的。
  const channels = o.channel === 'auto' ? ['chrome', null] : [!o.channel || o.channel === 'chromium' ? null : o.channel];
  let context = null, last = null;
  for (const channel of channels) {
    try {
      context = await pw.chromium.launchPersistentContext(profile, { headless: !!o.headless, ...(channel ? { channel } : {}), ...(o.executable_path ? { executablePath: o.executable_path } : {}), viewport: o.viewport, acceptDownloads: false, timeout: 60000 });
      break;
    } catch (e) {
      last = e;
      if (/ProcessSingleton|SingletonLock|already in use|profile.*(?:locked|in use)/i.test(e.message)) throw Error(`operator_profile_busy：操作员浏览器已经开着（${profile}），先关掉那个窗口再试`);
    }
  }
  if (!context) throw launchHint(last);
  // 系统 Chrome 起不来、改用了自带的 Chromium（兜底清单 F03）：同一个档案，指纹不一样，记进统一的「换了」账（lib/fallback.mjs）。
  if (channels.length > 1 && last) { try { noteFallback({ kind: 'browser', from: 'chrome', to: 'chromium', why: last, member: 'quill', from_label: '系统 Chrome', to_label: '自带的 Chromium' }); } catch {} } // 兜底：noteFallback 自己会吞写账的错，这里再包一层只防它的参数出错挡住开浏览器
  return new PlaywrightPage({ context, mode: 'persistent', profile, timeout_ms: o.timeout_ms });
}

// 单独起的浏览器进程：DevToolsActivePort 文件里是端口；那个端口还活着就连上去。上一次留给你终审的
// 标签页还开着——这次只在自己新开的标签页里干活，从不碰已有的标签页（09-28 审查：别把你正在检查的那张表导航走）。
async function attachDetached(pw, profile, o) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const endpoint = async () => {
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (!port) return null;
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? `http://127.0.0.1:${port}` : null;
    } catch { return null; } // 兜底：端口文件不在或那个端口没在听，就当浏览器没开，下面自己起一个
  };
  let url = await endpoint(), child = null;
  const giveUp = e => { if (child?.pid) { try { process.kill(child.pid); } catch {} } throw e; }; // 兜底：进程已经退了就不用再杀
  if (!url) {
    fs.rmSync(portFile, { force: true });
    const exe = browserExecutable(pw, o);
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--window-size=${o.viewport.width},${o.viewport.height}`, ...(o.headless ? ['--headless=new'] : []), 'about:blank'];
    child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    for (let i = 0; i < 150 && !url; i++) { await sleep(100); url = await endpoint(); }
    if (!url) giveUp(Error(`operator_browser_start_failed：${path.basename(exe)} 没有打开调试端口`));
  }
  let browser = null;
  try {
    browser = await pw.chromium.connectOverCDP(url, { timeout: 30000 });
    const context = browser.contexts()[0] || await browser.newContext();
    // 刚起的浏览器自带一个 about:blank：用它；连上的是已经开着的浏览器，就新开一个标签页。
    const blank = child ? context.pages().find(p => p.url() === 'about:blank') : null;
    const page = blank || await context.newPage();
    return new PlaywrightPage({ context, browser, mode: 'detached', profile, timeout_ms: o.timeout_ms, pages: [page] });
  } catch (e) { await browser?.close().catch(() => {}); giveUp(e); } // 兜底：起浏览器已经失败了，先关掉半开的连接再把原来的错抛出去
}

export class PlaywrightPage {
  constructor({ context, browser = null, mode = 'persistent', profile = null, timeout_ms = 15000, pages = null, host = null }) {
    Object.assign(this, { backend: mode === 'host' ? 'host' : 'playwright', context, browser, mode, profile, timeout: timeout_ms, dialogs: [], own: new Set(), host });
    // 只管这次任务自己的标签页：持久模式下整个浏览器都是这次开的；detached 模式下只有新开的那一个，
    // 加上从它弹出来的新页（target=_blank / window.open）。你自己开的标签页不跟、不关。
    for (const p of pages || context.pages()) this._adopt(p);
    this._page = [...this.own].filter(p => !p.isClosed()).at(-1) || null;
  }
  _adopt(p) {
    if (this.own.has(p)) return;
    this.own.add(p);
    // 页面弹窗：alert 点确定、离开页面放行，confirm / prompt 一律取消——"确定要提交吗"永远不替你点确定。
    p.on('dialog', d => { this.dialogs.push({ type: d.type(), message: String(d.message()).slice(0, 200) }); (/^(alert|beforeunload)$/.test(d.type()) ? d.accept() : d.dismiss()).catch(() => {}); }); // 兜底：弹窗已经被页面自己关了；没关掉的话下一步会超时报错
    p.on('popup', q => { this._adopt(q); this._page = q; });
    p.on('close', () => { if (this._page === p) this._page = [...this.own].filter(x => !x.isClosed()).at(-1) || null; });
  }
  async page() {
    if (!this._page || this._page.isClosed()) {
      // 专用 Chrome 上不用 context.newPage()（那会在你正看着的窗口里开前台标签）：在这次任务空间的窗口里开。
      const p = this.mode === 'host' ? await this.host.rt.newTabNear([...this.own].find(x => !x.isClosed()) || null) : await this.context.newPage();
      this._adopt(p); this._page = p;
    }
    return this._page;
  }
  async _settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {}); // 兜底：页面一直在加载也接着往下看，超时不算错
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {}); // 兜底：网络一直不静下来也接着往下看，超时不算错
  }
  async _target(id) {
    const page = await this.page();
    for (const frame of page.frames()) {
      const info = await frame.evaluate(resolveTarget, { id, deep: false }).catch(() => null); // 兜底：这个 frame 已经卸掉或跨域，换下一个 frame 找
      if (info?.found) return { page, frame, info, loc: frame.locator(info.sel).first(), clickLoc: frame.locator(info.click).first() };
    }
    throw Error(`element_not_found:${id}`);
  }
  // 点之前：等它能点（trial 不真点），再在页面里重算一次指纹；和模型看到的那一刻不一样就不点。
  async _clickChecked(id, fp) {
    let t = await this._target(id);
    if (fp && t.info.fp !== fp) throw Error(`element_changed:${id}`);
    await t.clickLoc.click({ trial: true, timeout: this.timeout }).catch(() => {}); // 兜底：trial 只是等它能点；等不到下面会重新核对指纹，不对就报错
    t = await this._target(id);
    if (fp && t.info.fp !== fp) throw Error(`element_changed:${id}`);
    return t;
  }
  async goto(url) { const page = await this.page(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await this._settle(page); return { url: page.url() }; }
  async observe(opts = {}) {
    let last;
    for (let i = 0; i < 3; i++) {
      const page = await this.page();
      // 页面脚本卡死时 evaluate 不会自己返回：最多等 20 秒。
      try { const o = await withTimeout(page.evaluate(extractPage, { max: 150, text: 3000, frames: true, ...opts }), 20000, 'observe_timeout'); o.dialogs = this.dialogs.splice(0); return o; }
      catch (e) { last = e; if (!/context was destroyed|navigat|Target closed/i.test(e.message)) throw e; await this._settle(page); }
    }
    throw last;
  }
  // 带守卫点一下：守卫挂在页面里，点下去那一刻指纹不对就吃掉这次点击；被吃掉了报 element_changed。
  // 页面因为这次点击跳走了，撤守卫会失败——那说明点击确实发生了（当时指纹是对的）。
  async _guarded(t, id, fp, act) {
    if (fp) await t.frame.evaluate(armClickGuard, { id, fp }).catch(e => noteSwallowed('operator.armClickGuard', e, { member: 'quill', doing: '点之前在页面里挂守卫', then: '指纹刚核对过，照常点' }));
    let blocked = 0;
    try { await act(); }
    finally { if (fp) blocked = await t.frame.evaluate(disarmClickGuard).catch(() => 0); } // 兜底：页面因为这次点击跳走了，撤守卫会失败，说明点击确实发生了（当时指纹是对的）
    if (blocked) throw Error(`element_changed:${id}`);
  }
  async click(id, { fp = null } = {}) {
    const t = await this._clickChecked(id, fp);
    // 被别的东西挡住就报错，让模型先处理挡住的东西（Esc、关掉弹层）；不再用合成点击绕过去。
    await this._guarded(t, id, fp, () => t.clickLoc.click({ timeout: 2000 }));
    const page = await this.page();
    await this._settle(page);
    return { url: page.url() };
  }
  async fill(id, text) {
    const t = await this._target(id);
    if (t.info.password) throw Error('password_field');
    await t.loc.fill(String(text), { timeout: this.timeout });
    return {};
  }
  async select(id, option) {
    const t = await this._target(id);
    const v = await t.frame.evaluate(pickOption, { id, option: String(option) });
    if (!v.found) throw Error(v.reason === 'option_not_found' ? `option_not_found: ${(v.options || []).join(' | ')}` : v.reason);
    await t.loc.selectOption({ value: v.value }, { timeout: this.timeout });
    return { selected: v.text };
  }
  async check(id, on = true, { fp = null } = {}) {
    let t = await this._target(id);
    if (t.info.checked === !!on) return { checked: !!on };
    if (t.info.type === 'radio' && !on) throw Error('radio_cannot_uncheck');
    if (fp && t.info.fp !== fp) throw Error(`element_changed:${id}`);
    await this._guarded(t, id, fp, () => t.clickLoc.click({ timeout: this.timeout }).catch(() => t.loc.dispatchEvent('click')));
    t = await this._target(id);
    if (t.info.checked !== !!on) throw Error('check_failed');
    return { checked: !!on };
  }
  async upload(id, filePath, { fp = null } = {}) {
    let t = await this._target(id);
    if (t.info.file) await t.loc.setInputFiles(filePath, { timeout: this.timeout });
    else {
      // 不是文件框本身（"上传简历"按钮）：点它，接住弹出的文件选择框。点之前一样核对指纹。
      t = await this._clickChecked(id, fp);
      let chooser = null;
      await this._guarded(t, id, fp, async () => { [chooser] = await Promise.all([t.page.waitForEvent('filechooser', { timeout: this.timeout }), t.clickLoc.click({ timeout: 2000 })]); });
      await chooser.setFiles(filePath);
    }
    await this._settle(t.page);
    return { file: path.basename(filePath) };
  }
  async press(key) { const page = await this.page(); await page.keyboard.press(key); await this._settle(page); return {}; }
  async scroll(dir = 'down') { const page = await this.page(); return page.evaluate(scrollPage, dir); }
  async screenshot(p) {
    const page = await this.page();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await page.screenshot({ path: p, fullPage: true, timeout: 20000 }).catch(() => page.screenshot({ path: p, timeout: 20000 }));
    return p;
  }
  async url() { return (await this.page()).url(); }
  // keep=true：留着给你看。持久模式下窗口跟着本进程；detached 模式下只断开连接，窗口还在。
  // keep=false：只关这次自己开的标签页；别的标签页（上次留给你终审的）还在就不关浏览器，一个都不剩才关。
  async close({ keep = false } = {}) {
    if (this.mode === 'host') {
      const { rt, space } = this.host;
      let held = null;
      try {
        // 这次开过的页（包括弹出来的）都登记进任务空间：留给你时你能找到，收尾时一起关。
        for (const p of this.own) if (!p.isClosed()) await space._register(p).catch(e => noteSwallowed('operator.registerPage', e, { member: 'quill', doing: '把这次开的页登记进任务空间', then: '这一页收尾时可能要你自己关' }));
        if (keep) {
          const live = this._page && !this._page.isClosed() ? this._page : [...this.own].find(p => !p.isClosed());
          const targetId = live ? await rt.targetIdOf(live).catch(() => null) : null; // 兜底：拿不到标签页 id 就不标是哪一页，空间照样交给你
          const label = targetId ? Object.entries(space._record()?.pages || {}).find(([, t]) => t === targetId)?.[0] || null : null;
          await space.handOff();
          held = { browser: 'chrome', spaceId: space.spaceId, page: label, targetId };
        } else await withTimeout(space.finish({ keep: [] }), 10000, 'finish_timeout').catch(e => noteSwallowed('operator.finishSpace', e, { member: 'quill', doing: '收尾关掉任务空间', then: '窗口可能还开着' }));
      } finally { await rt.close(); }
      return { kept: !!keep, ...(held ? { held } : {}) };
    }
    if (this.mode === 'detached') {
      if (!keep) {
        // 别的标签页都没了：直接让浏览器退出（先关最后一个标签页会让浏览器自己退出，Playwright 那头会一直等）。
        const others = this.context.pages().filter(p => !p.isClosed() && !this.own.has(p));
        if (!others.length) { try { const s = await this.browser.newBrowserCDPSession(); await withTimeout(s.send('Browser.close'), 5000, 'browser_close_timeout'); } catch {} } // 兜底：浏览器已经退了或不认这条命令，下面断开连接即可
        else for (const p of this.own) await withTimeout(p.close(), 5000, 'page_close_timeout').catch(() => {}); // 兜底：标签页已经被关了，收尾关不掉不影响这次结果
      }
      await withTimeout(this.browser.close(), 5000, 'disconnect_timeout').catch(() => {}); // 兜底：连接已经断了，收尾断不开不影响这次结果
      return { kept: !!keep };
    }
    if (!keep) await this.context.close().catch(() => {}); // 兜底：浏览器已经退了，收尾关不掉不影响这次结果
    return { kept: !!keep };
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────────────────
// 一个已经过 guard.checkAction 的动作（value 是核对过的值）交给 Page 执行。
export async function performAction(page, a) {
  switch (a.action) {
    case 'click': return page.click(a.id, { fp: a.fp || null });
    case 'fill': return page.fill(a.id, a.value);
    case 'select': return page.select(a.id, a.value);
    case 'check': return page.check(a.id, a.value, { fp: a.fp || null });
    case 'upload': return page.upload(a.id, a.value, { fp: a.fp || null });
    case 'press': return page.press(a.value);
    case 'scroll': return page.scroll(a.value);
    case 'goto': return page.goto(a.value);
    case 'wait': await sleep(Math.min(Math.max(Number(a.ms) || 1500, 200), 5000)); return {};
    default: throw Error(`not_an_action:${a.action}`);
  }
}

// 专用 Chrome 上开一页：新的任务空间窗口（后台开），包成 PlaywrightPage（mode 'host'）。
export async function openHostPage(o = {}) {
  const { CompatRuntime } = await import('../browser-compat.mjs');
  const rt = await CompatRuntime.open(o.playwright ? { playwright: o.playwright } : {});
  try {
    const space = await rt.taskSpace(o.name || `${BRAND} operator ${new Date().toISOString().slice(0, 19)} ${Math.random().toString(36).slice(2, 6)}`);
    const page = await space._pwPage('p1', { create: true });
    return new PlaywrightPage({ context: rt.context, browser: rt.browser, mode: 'host', pages: [page], timeout_ms: o.timeout_ms ?? 15000, host: { rt, space } });
  } catch (e) { await rt.close(); throw e; }
}

export async function openBrowser(spec = {}) {
  const o = typeof spec === 'string' ? { backend: spec } : { ...spec };
  const backend = o.backend || 'playwright';
  // 旧配置里的 "ego"：ego 浏览器那条路删了，当作专用 Chrome。
  if (backend === 'host' || backend === 'ego') return openHostPage(o);
  if (backend === 'playwright') return openPlaywright(o);
  if (backend === 'cua') { const { openCuaPage } = await import('./cua.mjs'); return openCuaPage(o); }
  throw Error(`unknown_operator_backend:${backend}`);
}
