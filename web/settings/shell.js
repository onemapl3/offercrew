// 设置页的外壳（2026-09-30，方案 design/settings-ia/spec.md）：左边一列分类、一次看一类；
// 分类页是几张卡片、一行一项（名字 · 现在的值 · ›）；点一行进子页或弹对话框；一个搜索框搜全部设置。
// 内容区窄于 760px（手机，或电脑上开着右侧面板又比较窄）时：先是分类列表，点进去是一整页，左上角返回。
//
// 网址：#settings                 概览（窄屏是分类列表）
//       #settings/<分类>          分类页
//       #settings/<分类>/<子页>   子页
//       …?hl=<行>                 滚到这一行、闪一下（搜索、概览、收件箱跳过来时用）
//       #settings?q=<词>          搜索结果
// 老网址照样能打开（legacyTarget）：#settings/setup、#settings/phone、#settings/mail、#settings?jump=settings-xxx。
import { icon, esc, cardsHtml, rowHtml, plain, dot } from './ui.js';
import { settingsKit } from '../command.js';
import { loadPrefsView } from '../prefs.js';
import { loadPhone } from '../phone.js';
import { loadDesktop } from '../desktop.js';
import overview from './overview.js';
import prefs from './prefs.js';
import profile from './profile.js';
import model from './model.js';
import spend from './spend.js';
import crew from './crew.js';
import send from './send.js';
import notify from './notify.js';
import accounts from './accounts.js';
import desktop from './desktop.js';
import advanced from './advanced.js';
import about from './about.js';

// 左栏：null 是分组的细线。
export const CATS = [overview, null, prefs, profile, null, model, spend, crew, null, send, notify, accounts, null, desktop, advanced, about];
const ALL = CATS.filter(Boolean);
const byId = id => ALL.find(c => c.id === id) || null;

// ── 路由（纯函数，测试直接调） ───────────────────────────────────────────────
export function parseRoute(hash = '') {
  const [path, qs = ''] = String(hash).replace(/^#/, '').split('?');
  const [, cat = '', sub = ''] = path.split('/');
  const p = new URLSearchParams(qs);
  return { cat: cat && cat !== 'overview' ? cat : 'overview', sub: sub || null, hl: p.get('hl') || null, q: (p.get('q') || '').trim() };
}
const JUMP = { 'settings-model': 'model', 'settings-spend': 'spend', 'settings-setup': '', 'settings-prefs': 'prefs', 'settings-phone': 'notify', 'settings-desktop': 'desktop', 'settings-mail': 'accounts?hl=mail', 'settings-advanced': 'advanced', 'settings-usage': 'advanced', 'settings-backups': 'advanced/backup', 'settings-accounts': 'advanced/providers', 'settings-add-provider': 'advanced/providers' };
// 老网址 #settings/mail：接邮箱的那一页（账号与连接 → 邮箱），不是「高级」里的 Google 授权。
const OLD = { setup: '', phone: 'notify', mail: 'accounts/mail' };
// 老网址 → 新网址；不用换就返回 null。
export function legacyTarget(hash = '') {
  const [path, qs = ''] = String(hash).replace(/^#/, '').split('?');
  const seg = path.split('/');
  if (seg[0] !== 'settings') return null;
  const jump = new URLSearchParams(qs).get('jump');
  const to = t => `#settings${t ? '/' + t : ''}`;
  if (jump) return to(JUMP[jump] ?? '');
  if (seg[1] && Object.hasOwn(OLD, seg[1])) return to(OLD[seg[1]]);
  if (seg[1] && !byId(seg[1]) && seg[1] !== 'overview') return '#settings';
  return null;
}

// ── 数据 ────────────────────────────────────────────────────────────────────
let D = null, rows = new Map(), token = '';
const getJSON = async url => { const r = await fetch(url), v = await r.json(); if (!r.ok) throw Error(v.error || '读取失败'); return v; };
async function load(h) {
  // 七样一起拉（以前分两批，第一次打开要等两轮）。
  const [cc, team, setup, usage, onb, phone, desk] = await Promise.all([getJSON('/api/command-center'), getJSON('/api/team').catch(() => null), getJSON('/api/setup').catch(() => null), getJSON('/api/usage').catch(() => null), loadPrefsView(h), loadPhone().catch(() => null), loadDesktop().catch(() => null)]);
  token = cc.token || token;
  return { h, cc, kit: settingsKit(cc, h), onb, setup, usage, phone, desktop: desk, team: team?.members || [] };
}
export const settingsToken = () => token;
const visible = c => c && !c.hidden?.(D);
// 一张卡片画不出来：这一张空着，别的照画；控制台记原文和哪一类（不再只是 warn）。
const safe = (fn, fallback = '', where = '') => { try { return fn(); } catch (e) { console.error('[OfferCrew 页面]', { page: 'settings', step: where || '画卡片', hash: typeof location === 'undefined' ? '' : location.hash }, e); return fallback; } };

// ── 画 ──────────────────────────────────────────────────────────────────────
function rail(cur) {
  return CATS.map(c => c === null ? '<hr>' : visible(c) ? `<a href="#settings${c.id === 'overview' ? '' : '/' + c.id}" class="${c.id === cur ? 'on' : ''}"${c.id === cur ? ' aria-current="page"' : ''}>${icon(c.icon)}<span>${esc(c.title)}</span></a>` : '').join('').replace(/(<hr>)+/g, '<hr>').replace(/<hr>$/, '');
}
function remember(cat, list) { for (const r of list) rows.set(`${cat}:${r.id}`, { cat, r }); }
function catPage(c) {
  const cards = safe(() => c.cards(D), []);
  cards.forEach(k => remember(c.id, k.rows || []));
  return `<a class="st-back narrow" href="#settings">${icon('back')}设置</a><h2 class="st-title">${esc(c.title)}</h2>${safe(() => c.top?.(D) || '')}${cardsHtml(cards, c.id)}`;
}
async function subPage(c, name) {
  const s = c.subs?.[name];
  if (!s) return catPage(c);
  let body = '';
  try {
    if (s.cards) { const cards = s.cards(D); cards.forEach(k => remember(c.id, k.rows || [])); body = cardsHtml(cards, c.id); }
    body += s.render ? await s.render(D) : '';
  } catch (e) { body = `<p class="st-err" role="alert">${esc(e.message)}</p>`; }
  const back = c.id === 'overview' ? '#settings' : `#settings/${c.id}`;
  return `<a class="st-back" href="${back}">${icon('back')}${esc(c.title)}</a><h2 class="st-title">${esc(typeof s.title === 'function' ? s.title(D) : s.title)}</h2><div class="st-sub">${body}</div>`;
}
// 搜索：每一类的行（名字 + 现在的值 + 同义词），再加子页里的字段（index）。按分类分组，还是原来那种行。
export function searchHits(q, cats = ALL, data = D) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const c of cats) {
    if (c.id === 'overview' || c.hidden?.(data)) continue;
    const list = [...safe(() => c.cards(data), []).flatMap(k => k.rows || []), ...safe(() => c.index?.(data) || [], [])];
    const seen = new Set(), hits = list.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return `${plain(r.label)} ${plain(r.value)} ${r.words || ''}`.toLowerCase().includes(needle); });
    if (hits.length) out.push({ cat: c, rows: hits });
  }
  return out;
}
function searchPage(q) {
  // 结果里只显示、不能点的行（锁住的、纯状态）点了就去它所在的那一页，那一行闪一下。
  const groups = searchHits(q).map(g => ({ ...g, rows: g.rows.map(r => (r.go || r.href || r.sub || r.toggle || r.action ? r : { ...r, go: `#settings/${g.cat.id}?hl=${encodeURIComponent(r.id)}` })) }));
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  groups.forEach(g => remember(g.cat.id, g.rows));
  const body = groups.map(g => `<div class="st-card"><h3><a href="#settings/${g.cat.id}">${esc(g.cat.title)}</a></h3>${g.rows.map(r => rowHtml(r, `${g.cat.id}:${r.id}`, re)).join('')}</div>`).join('');
  return `<h2 class="st-title">搜索「${esc(q)}」</h2>${body || '<div class="st-card"><div class="st-row static"><span class="st-v">没有找到</span></div></div>'}`;
}
// soft：编辑型子页保留自己的表单；其余页面每次以完整新数据拼出 HTML，由 morph 保留未变的节点。
export async function settingsPage(h, { soft = false } = {}) {
  // 子页标了 keep（填表的那种，比如邮箱）：后台刷新不重画它。它自己读状态、自己重画；整页一换，按下鼠标时的按钮松开时已经不在了，
  // 点击就丢了，填了一半的授权码也跟着没了（第 6 轮：负责人贴了应用专用密码，「没有反应」）。
  if (soft && D) { const r0 = parseRoute(location.hash), c0 = byId(r0.cat); if (r0.sub && !r0.q && c0?.subs?.[r0.sub]?.keep && document.querySelector(`.st-root[data-st-sub="${r0.sub}"]`)) return null; }
  const next = await load(h);
  // 只比较部分接口的签名会漏掉同等级下的摘要、渠道和用量变化；不要把已拉到的新数据丢掉。
  D = next; rows = new Map();
  const route = parseRoute(location.hash);
  let c = byId(route.cat);
  if (!visible(c)) c = overview;
  const content = route.q ? searchPage(route.q) : route.sub ? await subPage(c, route.sub) : c.id === 'overview' ? overview.page(D, { remember, visible: ALL.filter(visible) }) : catPage(c);
  return shellHtml(route, c, content);
}
// 换分类、从别的页换过来时先用手上这份画（web/app.js 换页立刻换），再拉新的；子页要现读的（render 是异步的）、没拉过返回 null。
export function settingsNow() {
  if (!D) return null;
  const route = parseRoute(location.hash);
  let c = byId(route.cat);
  if (!visible(c)) c = overview;
  rows = new Map();
  const content = route.q ? searchPage(route.q) : route.sub ? subPageNow(c, route.sub) : c.id === 'overview' ? overview.page(D, { remember, visible: ALL.filter(visible) }) : catPage(c);
  return content == null ? null : shellHtml(route, c, content);
}
function subPageNow(c, name) {
  const s = c.subs?.[name];
  if (!s) return catPage(c);
  let body = '';
  try {
    if (s.cards) { const cards = s.cards(D); cards.forEach(k => remember(c.id, k.rows || [])); body = cardsHtml(cards, c.id); }
    const r = s.render ? s.render(D) : '';
    if (typeof r?.then === 'function') return null;
    body += r;
  } catch (e) { body = `<p class="st-err" role="alert">${esc(e.message)}</p>`; }
  const back = c.id === 'overview' ? '#settings' : `#settings/${c.id}`;
  return `<a class="st-back" href="${back}">${icon('back')}${esc(c.title)}</a><h2 class="st-title">${esc(typeof s.title === 'function' ? s.title(D) : s.title)}</h2><div class="st-sub">${body}</div>`;
}
function shellHtml(route, c, content) {
  return `<div class="st-root" data-st-cat="${esc(c.id)}"${route.sub ? ` data-st-sub="${esc(route.sub)}"` : ''}${route.q ? ' data-st-search="1"' : ''}>
<div class="st-head"><h1>设置</h1><label class="st-search">${icon('search')}<input id="st-q" type="search" placeholder="搜索设置" autocomplete="off" aria-label="搜索设置" value="${esc(route.q)}"></label></div>
<div class="st-body"><nav class="st-rail" aria-label="设置分类">${rail(route.q ? '' : c.id)}</nav><section class="st-page">${content}</section></div></div>`;
}

// ── 绑定 ────────────────────────────────────────────────────────────────────
async function act(key, el) {
  const hit = rows.get(key);
  if (!hit) return;
  const { cat, r } = hit;
  if (r.go) { location.hash = r.go; return; }
  if (r.href) { window.open(r.href, '_blank', 'noopener'); return; }
  if (r.sub) { location.hash = `#settings/${cat}/${r.sub}`; return; }
  if (r.action) { await r.action(D); return; }
  if (r.toggle) {
    const sw = el.querySelector('.st-tog'), next = !r.toggle.on;
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; sw?.classList.toggle('on', next); sw?.setAttribute('aria-checked', String(next));
    try { await r.toggle.set(next, D); r.toggle.on = next; D.h.toast('已保存'); await D.h.refresh(); }
    catch (e) { sw?.classList.toggle('on', !next); sw?.setAttribute('aria-checked', String(!next)); D.h.toast(e.message); }
    finally { delete el.dataset.busy; }
  }
}
function bindRows(root) {
  root.querySelectorAll('.st-row[role=button]').forEach(el => {
    el.onclick = e => { if (e.target.closest('a,button:not(.st-tog),input,select,textarea')) return; act(el.dataset.stRow, el).catch(x => D.h.toast(x.message)); };
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
  });
}
// swapped：这次就地更新里整块换新的岛（web/morph.js）。右半边（.st-page）没换就不再绑一遍（各分类用 addEventListener，绑两遍会点一下做两次）。
export function bindSettingsPage(swapped = null) {
  const root = document.querySelector('.st-root');
  if (!root || !D) return;
  bindRows(root);
  const route = parseRoute(location.hash), c = byId(root.dataset.stCat) || overview;
  const page = root.querySelector('.st-page');
  if (!route.q && (!swapped || swapped.includes(page))) {
    const s = route.sub ? c.subs?.[route.sub] : null;
    // 这一类的按钮没绑上：照实报（3a 的「解除配对」就是绑定没跑、却没人知道）。
    try { s ? s.bind?.(page, D) : c.bind?.(page, D); } catch (e) { D.h.pageError ? D.h.pageError(`绑按钮（设置 · ${c.id}${route.sub ? '/' + route.sub : ''}）`, e) : console.error('[OfferCrew 页面]', e); }
  }
  // 搜索：边打边在原地换内容（输入框不重画，焦点留着），网址跟着换，刷新后结果还在。
  const q = root.querySelector('#st-q');
  if (q) {
    let t = null;
    const paint = () => {
      const v = q.value.trim(), hash = v ? `#settings?q=${encodeURIComponent(v)}` : '#settings';
      history.replaceState(null, '', hash);
      document.querySelector('#main')?.setAttribute('data-render-hash', hash);
      root.dataset.stSearch = v ? '1' : '';
      if (!v) { location.hash = '#settings'; return; }
      rows = new Map(); page.innerHTML = searchPage(v); bindRows(page);
      root.querySelectorAll('.st-rail a.on').forEach(a => a.classList.remove('on'));
    };
    q.oninput = () => { clearTimeout(t); t = setTimeout(paint, 150); };
    q.onkeydown = e => { if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = ''; paint(); } };
  }
  if (route.hl) {
    const el = [...root.querySelectorAll('[data-st-row]')].find(x => x.dataset.stRow.endsWith(':' + route.hl));
    if (el) setTimeout(() => { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400); }, 30);
  }
}
export { ALL as SETTINGS_CATS, dot };
