// 局部更新（第 3 步「页面」，05 第二节 2.3）：把新拼好的 HTML 和屏幕上那份比，只改不一样的地方。
// 没变的节点原样留着：选中、滚动位置、焦点、输入框里的字、展开的折叠都不丢，鼠标底下的按钮不会被换成另一个。
//
//   morph(el, html, { islands })   el 的子节点改成 html 那样；返回这次整块换新的「岛」（见下）。
//
// 怎么对上：同一层里带 key 的按 key 对（id、data-key，或列表行常用的 data-task / data-rid / data-row / data-ib-ask / data-run / data-detail），
// 不带 key 的按顺序对；key 在这一层重复的当作不带。标签不一样的不对，换新的。
// 用户动过的东西：输入框的值、勾选、<details> 的开合、<select> 的选中，只有新 HTML 里这一项和上次画的不一样时才改；
// 正有焦点的输入框连值都不碰。
// 岛（islands，一个选择器）：里面的元素由别的代码用 addEventListener 绑事件（留下来再绑一次会绑两遍），
// 这种块不往里比：和上次画进去的一样就整块留着，不一样就整块换新的；调用方只给换了的那些重新绑。
const KEY_ATTRS = ['id', 'data-key', 'data-task', 'data-rid', 'data-row', 'data-ib-ask', 'data-run', 'data-detail'];

function keyOf(n) {
  if (n.nodeType !== 1) return null;
  for (const a of KEY_ATTRS) { const v = n.getAttribute(a); if (v) return `${n.tagName}|${a}=${v}`; }
  return null;
}
// 一层里只出现一次的 key。
function keysOf(nodes) {
  const seen = new Map();
  for (const n of nodes) { const k = keyOf(n); if (k) seen.set(k, seen.has(k) ? null : n); }
  for (const [k, v] of seen) if (!v) seen.delete(k);
  return seen;
}
const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);

export function morph(target, html, { islands = null } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const ctx = { islands, swapped: [] };
  patchChildren(target, tpl.content, ctx);
  return ctx.swapped;
}

function patchChildren(parent, next, ctx) {
  const news = [...next.childNodes];
  const newKeys = keysOf(news);
  // 新的里没有的带 key 的旧节点先拿掉，后面的不用为它们挪位置（挪动会让焦点丢掉）。
  let olds = [...parent.childNodes];
  const oldKeys = keysOf(olds);
  for (const [k, o] of oldKeys) if (!newKeys.has(k)) { o.remove(); oldKeys.delete(k); }
  olds = [...parent.childNodes];
  const keyed = o => { const k = keyOf(o); return !!k && oldKeys.get(k) === o; };
  const used = new Set();
  let cursor = 0;
  // 不带 key 的按顺序：下一个没用过、也不带 key 的旧节点，类型对得上就用它。
  const nextFree = n => {
    while (cursor < olds.length && (used.has(olds[cursor]) || keyed(olds[cursor]))) cursor++;
    const o = olds[cursor];
    if (o && same(o, n)) { cursor++; return o; }
    return null;
  };
  let at = parent.firstChild;
  for (const n of news) {
    const k = keyOf(n), byKey = k && newKeys.has(k);
    let o = byKey ? oldKeys.get(k) || null : nextFree(n);
    if (o && (used.has(o) || !same(o, n))) o = null;
    let node;
    // 岛整块换新的时 patchNode 返回新节点：旧的在这里拿掉（它可能正是插入位置 at，先把 at 往后挪，
    // 不然下面 insertBefore 拿一个已经不在这一层的节点当参照会抛错，后面的绑定一个都跑不到）。
    if (o) { used.add(o); node = patchNode(o, n, ctx); if (node !== o) { if (at === o) at = o.nextSibling; o.remove(); } }
    else { node = document.importNode(n, true); if (node.nodeType === 1) fresh(node, ctx); }
    if (node === at) at = at.nextSibling;
    else parent.insertBefore(node, at);
  }
  for (const o of olds) if (!used.has(o) && o.parentNode === parent) o.remove();
}

// 新放进去的：记下画的是什么（折叠开没开、岛的 HTML），下次好比。
function fresh(el, ctx) {
  for (const d of el.tagName === 'DETAILS' ? [el] : el.querySelectorAll('details')) d.__ro = d.hasAttribute('open');
  if (!ctx.islands) return;
  for (const x of el.matches(ctx.islands) ? [el] : el.querySelectorAll(ctx.islands)) { x.__html = x.outerHTML; ctx.swapped.push(x); }
}

function patchNode(o, n, ctx) {
  if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return o; }
  if (ctx.islands && o.matches(ctx.islands)) {
    const h = n.outerHTML;
    if (o.__html === h) return o;
    const x = document.importNode(n, true);
    fresh(x, ctx);
    return x;
  }
  const focused = o === document.activeElement;
  const tag = o.tagName;
  if (tag === 'INPUT') {
    // value / checked 属性就是上次画的（打字、点勾不改属性）。
    if (!focused && o.getAttribute('value') !== n.getAttribute('value')) o.value = n.getAttribute('value') ?? '';
    if (o.hasAttribute('checked') !== n.hasAttribute('checked')) o.checked = n.hasAttribute('checked');
  } else if (tag === 'TEXTAREA') {
    syncAttrs(o, n);
    // 正在写的、写过没交的：字是用户的。只有没动过、画出来的又变了，才换成新的。
    if (!focused && o.defaultValue !== n.textContent) { const user = o.value !== o.defaultValue; o.defaultValue = n.textContent; if (!user) o.value = n.textContent; }
    return o;
  } else if (tag === 'DETAILS') {
    // open 属性跟着开合变，记不住上次画的是什么，另记一份（__ro）。
    const was = o.__ro ?? o.hasAttribute('open'), want = n.hasAttribute('open');
    const open = want !== was ? want : o.open;
    if (open) n.setAttribute('open', ''); else n.removeAttribute('open');
    o.__ro = want;
  }
  const selWas = tag === 'SELECT' ? selectedIdx(o) : -1;
  syncAttrs(o, n);
  if (focused && o.isContentEditable) return o;
  patchChildren(o, n, ctx);
  if (tag === 'SELECT' && !focused) { const want = selectedIdx(n); if (o.selectedIndex === selWas || want !== selWas) o.selectedIndex = want; }
  return o;
}
// 画出来的选中项（带 selected 属性的那个，没有就是第一个）。
const selectedIdx = s => Math.max(0, [...s.querySelectorAll('option')].findIndex(x => x.hasAttribute('selected')));

function syncAttrs(o, n) {
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
}
