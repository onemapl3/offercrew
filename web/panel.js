// 右侧面板（2026-09-29，design/panel 定稿 + design/handoff/talk.md；09-30 布局 v3.1，design/layout-v3）：停靠在右边、把主区域推开的一栏，只放对话。
// 上面一行标题（会话切换 ▾ · + ⤢ ×，按钮里的内容由 web/talk.js 画），下面就是对话。在面板里点什么，主区都不跟着换页。
// 岗位详情在主区的岗位页（#lead/<rid>，web/hq.js），任务卡在任务页上就地展开（web/tasks.js）；面板没有「详情」了。
//   开关   ⌘K 打开并把光标放进输入框；⌘\ 收起 / 打开；× 收起。光标在面板里时 Esc 也收起。
//          入口（09-30 负责人：「侧边栏的问不太起眼」）：左栏品牌下面的绿色主按钮「问团队 ⌘K」——关着时打开、光标进输入框，
//          开着时是按下的样子，再点收起。左栏变成顶上一条的窄屏（700 px 及以下）没有它，右下角的圆按钮「问」照旧；宽屏不放圆按钮。
//   宽度   拖左边那条线：320 px 到窗口的一半；双击恢复 380 px。开没开、多宽记在这台电脑的浏览器里（localStorage oc.panel）。
//   铺满   ⤢ 盖住主区域（侧栏还在），再按一次还原。
//   浮层   停靠后主区要是窄于 600 px，面板改成盖在主区上的一层（不盖左栏），不再把主区挤窄；窗口变宽后自动回到停靠。
//   窄屏   窗口不到 900 px 时是一整屏的 sheet，不推开主区域；没有拖宽和铺满。
//   接口   window.OfferCrew.panel.open({ tab: 'talk', thread, member, text }) 打开对话（thread 是会话 id，member 是成员 id）；
//          close()、toggle()、isOpen()。对话听 oc:talk（detail 就是 open 的参数）；面板开关时发 oc:panel（detail：{ open, tab }）。
//          老的 open({ tab: 'lead', rid }) 改成主区打开岗位页，open({ tab: 'lead', card }) 改成任务页展开那张卡；面板不动。
// 这个文件顶层不碰 document / window（测试在 vm 里读纯函数）。
import { iconHtml } from './crew-faces.js';
// OPEN_FROM：以前没开关过的人窗口够宽就默认开着；10-02 起第一次一律收起（readStored），留着这个名字给还在引用它的地方。
export const PANEL_MIN = 320, PANEL_DEFAULT = 380, SHEET_BELOW = 900, MAIN_MIN = 600, OPEN_FROM = 1400, STORE_KEY = 'oc.panel';
let el = null, st = { open: false, width: PANEL_DEFAULT, wide: false };
const $ = s => document.querySelector(s);

// 入口按钮上的键帽：Mac 上是 ⌘K，别的是 Ctrl K。
export const keyCap = mac => mac ? '⌘K' : 'Ctrl K';
// 宽度：320 到窗口的一半（窗口太窄时至少 320）；认不出的数给默认值。
export function clampWidth(w, viewport) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return PANEL_DEFAULT;
  const max = Math.max(PANEL_MIN, Math.floor((Number(viewport) || 1440) * 0.5));
  return Math.round(Math.min(max, Math.max(PANEL_MIN, n)));
}
// 记下来的状态：{ open, width }；没记过（第一次用）时默认收起（负责人 10-02：不自己弹出来抢注意力，你点了才开）；你开过、关过就按你的来。
export function readStored(raw, viewport) {
  let v = null;
  try { v = JSON.parse(raw || 'null'); } catch {}
  if (!v || typeof v !== 'object') return { open: false, width: PANEL_DEFAULT, fresh: true };
  return { open: !!v.open, width: clampWidth(v.width, viewport), fresh: false };
}
// 面板怎么摆：窗口不到 900 px 是整屏 sheet；停靠后主区（窗口 − 左栏 − 面板）不到 600 px 就盖在主区上（float）；否则停靠（dock）。
export function layoutMode(viewport, sidebar, width) {
  const v = Number(viewport) || 0;
  if (v < SHEET_BELOW) return 'sheet';
  return v - (Number(sidebar) || 0) - (Number(width) || PANEL_DEFAULT) < MAIN_MIN ? 'float' : 'dock';
}
const isSheet = () => window.innerWidth < SHEET_BELOW;
const sideW = () => { const s = document.querySelector('.sidebar'); return s && getComputedStyle(s).position === 'fixed' ? s.offsetWidth : 0; };
const mode = () => layoutMode(window.innerWidth, sideW(), st.width);
const store = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ open: st.open, width: st.width })); } catch {} };
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

// ── 骨架 ─────────────────────────────────────────────────────────────────────
function build() {
  el = document.createElement('aside');
  el.id = 'panel'; el.className = 'pn'; el.setAttribute('aria-label', '团队面板');
  el.innerHTML = `<div class="pn-grip" id="pn-grip" role="separator" aria-orientation="vertical" aria-label="拖动调整面板宽度，双击恢复" title="拖动调整宽度 · 双击恢复 ${PANEL_DEFAULT} px"></div>
    <header class="pn-head">
      <button type="button" class="pn-title" id="pn-title" aria-haspopup="dialog" aria-expanded="false" title="切换会话"><span class="pn-face" id="pn-face" aria-hidden="true"></span><b id="pn-name">团队</b><i aria-hidden="true">▾</i></button>
      <span class="pn-grow"></span>
      <button type="button" class="pn-ic" data-pn-new title="新对话（和整个团队说）" aria-label="新对话">+</button>
      <button type="button" class="pn-ic" data-pn-wide title="铺满主区域（再按一次还原）" aria-label="铺满主区域" aria-pressed="false">⤢</button>
      <button type="button" class="pn-ic" data-pn-close title="收起（⌘\\）" aria-label="收起面板">×</button>
    </header>
    <div class="pn-pop" id="pn-pop" hidden></div>
    <section class="pn-body pn-talk" id="panel-talk" aria-label="对话"></section>
    <div class="pn-size" id="pn-size" hidden></div>`;
  document.body.append(el);
  // 入口：左栏的「问团队」（左栏是一竖栏时）和底边一条「问团队」（窄屏左栏变成顶上一条时；原来是右下角的圆按钮，会压住行尾的按钮，视觉验收第 6、19 条）；哪个露出来由 web/style.css 定。
  // 有没看的回音时两个上面都有一个点（web/talk.js paintBar）。
  const key = keyCap(/Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || ''));
  const nav = $('.sidebar nav');
  if (nav && !$('.sb-ask')) nav.insertAdjacentHTML('beforebegin', `<button type="button" class="sb-ask" data-pn-toggle aria-label="问团队" aria-pressed="false" aria-keyshortcuts="Meta+K Control+K" title="问团队（${key}）">${iconHtml('messages', { size: 16 })}<span>问团队</span><kbd>${key}</kbd><span class="pn-bar" data-talk-bar></span></button>`);
  if (!$('.pn-fab')) document.body.insertAdjacentHTML('beforeend', `<button type="button" class="pn-fab" data-pn-open aria-label="问团队（${key}）" title="问团队（${key}）"><span class="pn-fab-t">${iconHtml('messages', { size: 16 })}问团队</span><span class="pn-bar" id="talk-bar" data-talk-bar></span></button>`);
  el.addEventListener('click', e => {
    const t = e.target, on = s => t.closest(s);
    if (on('[data-pn-close]')) { closePanel(); return; }
    if (on('[data-pn-wide]')) { setWide(!st.wide); return; }
  });
  document.addEventListener('click', e => {
    if (e.target.closest?.('[data-pn-open]')) { e.preventDefault(); openPanel({ tab: 'talk', focus: true }); }
    else if (e.target.closest?.('[data-pn-toggle]')) { e.preventDefault(); togglePanel(); }
  });
  grip();
}

// ── 开、关、宽度 ─────────────────────────────────────────────────────────────
function apply() {
  const b = document.body, m = mode();
  b.classList.toggle('pn-open', st.open);
  b.classList.toggle('pn-wide', st.open && st.wide && m !== 'sheet');
  b.classList.toggle('pn-sheet', st.open && m === 'sheet');
  b.classList.toggle('pn-float', st.open && !st.wide && m === 'float');
  document.documentElement.style.setProperty('--pn-w', st.width + 'px');
  document.querySelectorAll('[data-pn-toggle]').forEach(b => { b.setAttribute('aria-pressed', String(st.open)); b.classList.toggle('is-on', st.open); });
  const wide = el?.querySelector('[data-pn-wide]');
  if (wide) { wide.setAttribute('aria-pressed', String(st.wide)); wide.textContent = st.wide ? '⤡' : '⤢'; wide.title = st.wide ? '还原成侧边的一栏' : '铺满主区域（再按一次还原）'; }
}
export function openPanel(opts = {}) {
  if (!el) return;
  // 老的「详情」入口：岗位去主区的岗位页，任务卡去任务页展开；面板不动。
  if (opts.tab === 'lead') {
    if (opts.rid) location.hash = '#lead/' + encodeURIComponent(opts.rid);
    else if (opts.card) window.OfferCrew?.openCard?.(opts.card);
    return;
  }
  const was = st.open;
  st.open = true;
  if (opts.wide) st.wide = !isSheet(); // 任务目录点一行：铺满主区域打开那件活的对话
  apply(); store();
  emit('oc:talk', opts);
  if (!was || opts.tab) emit('oc:panel', { open: true, tab: 'talk' });
}
export function closePanel() {
  if (!el || !st.open) return;
  const inside = el.contains(document.activeElement);
  st.open = false; st.wide = false;
  apply(); store();
  $('#pn-pop') && ($('#pn-pop').hidden = true);
  emit('oc:panel', { open: false, tab: 'talk' });
  if (inside) [...document.querySelectorAll('[data-pn-toggle],[data-pn-open]')].find(b => b.offsetParent)?.focus({ preventScroll: true });
}
export const togglePanel = () => st.open ? closePanel() : openPanel({ tab: 'talk', focus: true });
export const panelOpen = () => st.open;
export const panelTab = () => st.open ? 'talk' : null;
export const panelWidth = () => st.width;
function setWide(on) { st.wide = !!on && !isSheet(); apply(); emit('oc:panel', { open: st.open, tab: 'talk', wide: st.wide }); }
// 拖左边那条线改宽度；双击恢复。拖的时候旁边一个小牌子写着多宽。
function grip() {
  const g = $('#pn-grip'), tag = $('#pn-size');
  let drag = null;
  g.addEventListener('pointerdown', e => {
    if (isSheet() || st.wide || e.button !== 0) return;
    e.preventDefault(); g.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId }; document.body.classList.add('pn-dragging');
  });
  g.addEventListener('pointermove', e => {
    if (!drag) return;
    st.width = clampWidth(window.innerWidth - e.clientX, window.innerWidth); apply();
    tag.hidden = false; tag.textContent = `${st.width} px · 松开就记住 · 双击恢复`;
  });
  const end = () => { if (!drag) return; drag = null; document.body.classList.remove('pn-dragging'); tag.hidden = true; store(); emit('oc:panel', { open: st.open, tab: 'talk', width: st.width }); };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
  g.addEventListener('dblclick', () => { st.width = PANEL_DEFAULT; apply(); store(); emit('oc:panel', { open: st.open, tab: 'talk', width: st.width }); });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
export function initPanel() {
  if (el) return;
  const saved = (() => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } })();
  const s = readStored(saved, window.innerWidth);
  st.width = s.width;
  // 手机上第一次进来不自己弹开（整屏的 sheet 会挡住页面）；记过「开着」的照样开。
  st.open = s.fresh ? s.open && !isSheet() : s.open;
  build(); apply();
  // ⌘K / Ctrl+K：打开、光标进输入框（开着也是）；别的确认框开着时不抢。⌘\ / Ctrl+\：收起 / 打开。
  window.addEventListener('keydown', e => {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey, k = String(e.key).toLowerCase();
    if (!mod || (k !== 'k' && k !== '\\')) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    k === 'k' ? openPanel({ tab: 'talk', focus: true }) : togglePanel();
  });
  // Esc：光标在面板里、没有小弹层（会话切换、@ 选人）开着时收起。小弹层自己先接住 Esc（preventDefault）。
  el.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && !document.querySelector('dialog[open]')) { e.preventDefault(); closePanel(); } });
  let lastSheet = isSheet();
  window.addEventListener('resize', () => { const s2 = isSheet(); if (s2 !== lastSheet) { lastSheet = s2; if (s2) st.wide = false; } st.width = clampWidth(st.width, window.innerWidth); apply(); });
  window.OfferCrew = Object.assign(window.OfferCrew || {}, { panel: { open: (o = {}) => openPanel({ tab: 'talk', ...o }), close: closePanel, toggle: togglePanel, isOpen: panelOpen } });
}
