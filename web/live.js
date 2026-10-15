// 后台变化怎么到页面上（第 3 步「页面」，05 第二节 2.3）。
// 页面上的每一块声明自己关心哪几张表；服务端推来一批变化，只叫关心这些表的块，各自重拉、各自就地更新（web/morph.js）。
//
//   block(name, tables, run)   tables：表名数组，或返回数组的函数（跟着当前页变）；'*' 表示什么变了都要。
//                              run(change)：change.tables 是 { 表: [id…] }，或 null（不知道哪张表，当作全变了）。
//   changed(tables)            来了一批变化。同一块正在跑就记下，跑完再跑一次（中间来的几批合成一批）。
//   parseChange(data)          SSE 的 data → { 表: [id…] } 或 null。
//
// 服务端（bin/serve.mjs 的 feed，lib/changes.mjs）每 200 毫秒推一批 changes：{tables: {jobs: [...ids], leads: null}}，null 是整张表。
// 不带 tables 的当作所有表都变了：每一块照旧重拉自己的数据，按 id 原地更新，不整页重画。
// 表名：jobs（任务卡、账）、actions（对外动作）、leads、drafts、asks（收件箱的信）、receipts、
// events（运行日志）、config（设置、配置文件）、resume（简历和信）、talk（对话）。
const blocks = new Map();
export const ALL = '*';

export function block(name, tables, run) {
  blocks.set(name, { name, tables, run, busy: false, pending: null });
  return () => blocks.delete(name);
}
const tablesOf = b => { const t = typeof b.tables === 'function' ? b.tables() : b.tables; return t === ALL ? ALL : new Set(t || []); };
// 这一批里这块关心的那部分；不关心返回 false。
function slice(b, tables) {
  const want = tablesOf(b);
  if (!tables || want === ALL) return { tables };
  const hit = Object.fromEntries(Object.entries(tables).filter(([t]) => want.has(t)));
  return Object.keys(hit).length ? { tables: hit } : false;
}
// 两批合一：有一批是「不知道哪张表」，合起来也是；否则同一张表的 id 并起来（null = 整张表）。
function merge(a, b) {
  if (!a) return b;
  if (!a.tables || !b.tables) return { tables: null };
  const out = { ...a.tables };
  for (const [t, ids] of Object.entries(b.tables)) out[t] = out[t] === null || ids === null || ids === undefined ? null : [...new Set([...(out[t] || []), ...ids])];
  return { tables: out };
}
export function changed(tables = null) {
  for (const b of blocks.values()) {
    const hit = slice(b, tables);
    if (!hit) continue;
    b.pending = merge(b.pending, hit);
    if (!b.busy) drain(b);
  }
}
async function drain(b) {
  b.busy = true;
  try {
    while (b.pending) { const c = b.pending; b.pending = null; try { await b.run(c); } catch (e) { console.error('[OfferCrew 页面]', { block: b.name, step: '后台变化' }, e); } }
  } finally { b.busy = false; }
}
export function parseChange(data) {
  try { const d = JSON.parse(data || '{}'); return d && d.tables && typeof d.tables === 'object' && !Array.isArray(d.tables) ? d.tables : null; }
  catch { return null; }
}
// 测试、调试用：现在有哪些块、各关心什么。
export const blocksNow = () => [...blocks].map(([name, b]) => ({ name, tables: tablesOf(b) === ALL ? ALL : [...tablesOf(b)] }));
