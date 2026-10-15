// 设置页的共用零件（2026-09-30 按分类重排，方案见 design/settings-ia/spec.md）。
//
// 每个分类模块（web/settings/<分类>.js）导出一个对象：
//   { id, title, icon, group,
//     hidden?(D)          这一类在这台机器上不出现（桌面只在 Mac App 里）
//     summary(D)          一行摘要：手机上的分类列表、概览卡片用
//     cards(D)            分类页：[{ title?, rows: [行], html? }]
//     subs?               子页：{ 名字: { title, render(D) → html | Promise<html>, bind?(root, D) } }
//     index?(D)           只给搜索用的条目（子页里的字段）：[{ id, label, value?, words?, sub }]
//     top?(D) / bind?(root, D)  分类页卡片前面的一块自定义内容和它的绑定 }
// 一行：{ id, label, value(html), words?, warn?,
//         go: '#…'（跳转） | href: 'https://…'（新窗口） | sub: '子页名' | toggle: { on, set(on) } | lock: true |
//         action(D) （打开对话框之类），note?: 必须写出来的事实 / 后果（一行小字） }
// D 是 shell.js 读好的数据：{ h, cc, kit, onb, setup, usage, phone, desktop, team }。
// 这些模块只拼 HTML、不碰路由；手机 App 以后按同一套分类和 #settings/<分类>/<子页> 复用。

// 图标：Tabler Icons outline（MIT，https://tabler.io/icons），24×24、线宽 2。
export const ICON = {
  bolt: '<path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/>',
  home: '<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>',
  target: '<path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"/><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>',
  user: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>',
  cpu: '<path d="M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1z"/><path d="M9 9h6v6h-6z"/><path d="M3 10h2"/><path d="M3 14h2"/><path d="M10 3v2"/><path d="M14 3v2"/><path d="M21 10h-2"/><path d="M21 14h-2"/><path d="M14 21v-2"/><path d="M10 21v-2"/>',
  coin: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1"/><path d="M12 7v10"/>',
  users: '<path d="M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  shield: '<path d="M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"/><path d="M15 19l2 2l4 -4"/>',
  bell: '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/>',
  link: '<path d="M9 15l6 -6"/><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464"/><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"/>',
  desktop: '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z"/><path d="M7 20h10"/><path d="M9 16v4"/><path d="M15 16v4"/>',
  adj: '<path d="M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 6l8 0"/><path d="M16 6l4 0"/><path d="M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 12l2 0"/><path d="M10 12l10 0"/><path d="M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 18l11 0"/><path d="M19 18l1 0"/>',
  info: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/>',
  search: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  chev: '<path d="M9 6l6 6l-6 6"/>',
  back: '<path d="M15 6l-6 6l6 6"/>',
  lock: '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>',
  ext: '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/>',
};
export const icon = (k, cls = '') => `<svg class="st-i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;
export const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pill = (text, tone = '') => `<span class="st-pill${tone ? ' ' + tone : ''}">${esc(text)}</span>`;
export const dot = (tone = 'ok') => `<span class="st-dot ${tone}" aria-hidden="true"></span>`;
export const ordered = list => list.map((x, i) => `${esc(x)}${list.length > 1 ? `<span class="st-num">${i + 1}</span>` : ''}`).join('&nbsp; ');
export const plain = html => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

const clickable = r => !!(r.go || r.href || r.sub || r.toggle || r.action);
function endOf(r) {
  if (r.toggle) return `<span class="st-tog${r.toggle.on ? ' on' : ''}" role="switch" aria-checked="${r.toggle.on ? 'true' : 'false'}" aria-label="${esc(r.label)}"></span>`;
  if (r.lock) return icon('lock', 'st-end st-lock');
  if (r.href) return icon('ext', 'st-end');
  if (clickable(r)) return icon('chev', 'st-end');
  return '';
}
// key：分类 id + 行 id，shell 用它找回这一行要做什么。hl：搜索时要高亮的词。
export function rowHtml(r, key, hl = null) {
  const mark = s => (hl ? String(s).replace(hl, m => `<mark>${m}</mark>`) : s);
  const label = r.html ? r.label : hl ? mark(esc(r.label)) : esc(r.label);
  const value = hl && r.value && !/[<>]/.test(r.value) ? mark(r.value) : r.value ?? '';
  const role = clickable(r) ? ` role="button" tabindex="0"` : '';
  return `<div class="st-row${clickable(r) ? '' : ' static'}${r.warn ? ' warn' : ''}" data-st-row="${esc(key)}"${role}><span class="st-l">${r.html ? label : `<span>${label}</span>`}</span><span class="st-v">${value}</span>${endOf(r)}</div>${r.note ? `<p class="st-note">${esc(r.note)}</p>` : ''}`;
}
export function cardsHtml(cards, cat, hl = null) {
  return cards.filter(c => c && (c.html || c.rows?.length)).map(c => `<div class="st-card">${c.title ? `<h3>${esc(c.title)}</h3>` : ''}${c.html || ''}${(c.rows || []).map(r => rowHtml(r, `${cat}:${r.id}`, hl)).join('')}</div>`).join('');
}
// 高级子页最下面：它写在哪个文件里（事实，不是说明）。
export const fileLine = () => ''; // 存储路径留在开发记录，设置页只展示设置的含义。

// 钱数和薪资说成中文（10-01：概览里的求职偏好露出了 facts 模板的英文写法「above …,000 and negotiable」）。
// 只认这几种固定的写法；认不出的照你写的原样显示。
const toWan = (n, unit = '') => { let v = Number(String(n).replace(/[,，\s]/g, '')); if (!Number.isFinite(v)) return null; if (/^k$/i.test(unit)) v *= 1000; else if (/^(w|万)$/i.test(unit)) v *= 10000; return v >= 10000 ? `${+(v / 10000).toFixed(1)} 万` : String(v); };
export function moneyText(v) { const m = /^\s*([\d,.]+)\s*(k|w|万)?\s*$/i.exec(String(v ?? '')); return m ? toWan(m[1], m[2]) || String(v) : String(v ?? ''); }
export function salaryParts(s) {
  const t = String(s ?? '').trim(), m = /(?:;\s*|\(\s*)(corrected by user|user[- ]corrected|用户校正)\s*/i.exec(t);
  if (!m) return { value: t, history: '' };
  let value = t.slice(0, m.index).trim(), history = t.slice(m.index + m[0].length).replace(/\)\s*$/, '').trim();
  if ((value.match(/\(/g) || []).length > (value.match(/\)/g) || []).length) value += ')';
  history = history.replace(/^([\d-]+),?\s*earlier\s*(.*?)\s*was wrong$/i, '你在 $1 校正；原先 $2 不正确');
  return { value, history };
}
export function salaryText(s) {
  const t = salaryParts(s).value, neg = /(?:[,，]?\s*(?:and\s+)?negotiable|[,，]?\s*可谈|[,，]?\s*面议)\s*$/i;
  if (!t) return '';
  const annual = /^~?\s*([\d,]+)\s*\(\s*([\d,]+)\s*\/(?:month|mo)(.*?)\)\s*$/i.exec(t);
  if (annual) return `${t.startsWith('~') ? '约' : ''}${toWan(annual[1])}（每月 ${toWan(annual[2])}${annual[3].replace(/months?/ig, '个月').replace(/,?\s*no bonus expected in (\d{4})/ig, '，$1 年预计没有奖金')}）`;
  if (/^(negotiable|面议|可谈)$/i.test(t)) return '面议';
  const tail = neg.test(t) ? '，可谈' : '', body = t.replace(neg, '').trim();
  let m = /^(?:above|over|at\s+least|min(?:imum)?|from|>=?|≥)\s*([\d,.]+)\s*(k|w|万)?\+?$/i.exec(body) || /^([\d,.]+)\s*(k|w|万)?\s*(?:\+|or\s+more|以上|起)$/i.exec(body);
  if (m && toWan(m[1], m[2])) return `${toWan(m[1], m[2])}以上${tail}`;
  m = /^([\d,.]+)\s*(k|w|万)?\s*(?:-|–|~|to|到|至)\s*([\d,.]+)\s*(k|w|万)?$/i.exec(body);
  if (m && toWan(m[1], m[2] || m[4]) && toWan(m[3], m[4])) return `${toWan(m[1], m[2] || m[4]).replace(/ 万$/, '')}–${toWan(m[3], m[4])}${tail}`;
  m = /^([\d,.]+)\s*(k|w|万)?$/i.exec(body);
  if (m && toWan(m[1], m[2])) return `${toWan(m[1], m[2])}${tail}`;
  return t;
}

globalThis.OfferCrewSettingsWords = { salaryText, salaryParts };
