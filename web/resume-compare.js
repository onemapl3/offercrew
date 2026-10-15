// 材料 · Writer 改一版之后左右对比（2026-10-01，设计说明 3.4，样稿 v4-2）：左边现在这版，右边 Writer 的新版，都按导出的样子排
// （web/resume-paper.js）。改过的字左边标红划线、右边标绿；整行删掉的左边整行划掉，新加的右边整行标绿，只挪了位置的两边都在左侧画一道。
// 顶栏只有「不用」「用这版」：用这版 → 存成新的一版（基于原来那版），页面切过去接着改；不用 → 丢掉，回到原来那版。
// Writer 还在改：右边一栏写「Writer 在改」；没改成：写原因，给「再试一次」。对话侧栏开着时两栏各约 390 px 也看得下。
// 纯函数（wordDiff、lineMarks）在 tests/resume-page.test.mjs 里测。
import { paperHtml, esc, inline } from './resume-paper.js';
import { getJson, act } from './resume-api.js';

// ── 逐字 diff ────────────────────────────────────────────────────────────────
// 分词：一个汉字一个词；英文单词、数字（带 . ' _ - 连着的算一个）；空白一段；其余标点一个。
const TOKEN = /[㐀-鿿豈-﫿]|[A-Za-z0-9]+(?:[.'’_-][A-Za-z0-9]+)*|\s+|[^\sA-Za-z0-9㐀-鿿豈-﫿]/gu;
export const tokens = s => String(s ?? '').match(TOKEN) || [];
// → [{ t, k:'eq'|'del'|'ins' }]：左边画 eq + del，右边画 eq + ins。每一处改动先 del 后 ins。
// 夹在两处改动中间、只有一个字（或一个标点、空白）的相同部分并进改动里：中文逐字比时不会碎成「红一个字、绿一个字」。
export function wordDiff(a, b) {
  const A = tokens(a), B = tokens(b), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { raw.push({ t: A[i], k: 'eq' }); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { raw.push({ t: B[j], k: 'ins' }); j++; }
    else { raw.push({ t: A[i], k: 'del' }); i++; }
  }
  // 连起来：相同的一段、改动的一段（改动里 del 和 ins 各自拼起来）。
  const runs = [];
  for (const x of raw) {
    const last = runs.at(-1), eq = x.k === 'eq';
    if (last && last.eq === eq) { if (eq) last.t += x.t; else last[x.k] += x.t; }
    else runs.push(eq ? { eq: true, t: x.t } : { eq: false, del: x.k === 'del' ? x.t : '', ins: x.k === 'ins' ? x.t : '' });
  }
  for (let r = 1; r < runs.length - 1; r++) {
    const x = runs[r];
    if (x.eq && !runs[r - 1].eq && !runs[r + 1].eq && tokens(x.t).filter(t => t.trim()).length <= 1) {
      const p = runs[r - 1], q = runs[r + 1];
      runs.splice(r - 1, 3, { eq: false, del: p.del + x.t + q.del, ins: p.ins + x.t + q.ins });
      r -= 2;
    }
  }
  // 改动两边开头、结尾一样的空白挪回相同的部分（「working on 」→「for 」只标词）。
  const out = [];
  for (const x of runs) {
    if (!x.eq && x.del && x.ins) {
      const lead = Math.min(x.del.match(/^\s*/)[0].length, x.ins.match(/^\s*/)[0].length), tail = Math.min(x.del.match(/\s*$/)[0].length, x.ins.match(/\s*$/)[0].length);
      const pre = x.del.slice(0, lead), post = tail ? x.del.slice(-tail) : '';
      if (pre) out.push({ eq: true, t: pre });
      out.push({ eq: false, del: x.del.slice(lead, x.del.length - tail), ins: x.ins.slice(lead, x.ins.length - tail) });
      if (post) out.push({ eq: true, t: post });
    } else out.push(x);
  }
  runs.length = 0;
  for (const x of out) { const last = runs.at(-1); if (last?.eq && x.eq) last.t += x.t; else runs.push(x); }
  return runs.flatMap(x => x.eq ? [{ t: x.t, k: 'eq' }] : [...(x.del ? [{ t: x.del, k: 'del' }] : []), ...(x.ins ? [{ t: x.ins, k: 'ins' }] : [])]);
}
const order = c => { const out = []; for (const l of c?.header || []) out.push([l, null]); for (const s of c?.sections || []) { if (s.title) out.push([s.title, null]); for (const e of s.entries || []) for (const l of [...(e.head || []), ...(e.lines || [])]) out.push([l, e.id]); } return out; };
// 两份内容逐行：按行编号对上。→ { left: Map(id → { cls?, segs? }), right: Map(…), count }
//   改了字：两边都带 segs（逐字）；只改了加粗：右边 cls 'rs-new'；删掉的：左边 'rs-gone'；新加的：右边 'rs-new'；
//   只挪了位置（不在最长的共同顺序里，或者换了一段）：两边 'rs-moved'。count 是改了几处（一行算一处）。
export function lineMarks(base, next) {
  const A = order(base), B = order(next), a = new Map(A.map(([l, e]) => [l.id, { l, e }])), b = new Map(B.map(([l, e]) => [l.id, { l, e }]));
  const left = new Map(), right = new Map();
  const sa = A.map(([l]) => l.id).filter(id => b.has(id)), sb = B.map(([l]) => l.id).filter(id => a.has(id));
  const dp = Array.from({ length: sa.length + 1 }, () => new Uint16Array(sb.length + 1));
  for (let i = sa.length - 1; i >= 0; i--) for (let j = sb.length - 1; j >= 0; j--) dp[i][j] = sa[i] === sb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < sa.length && j < sb.length;) { if (sa[i] === sb[j]) { keep.add(sa[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  let count = 0;
  const changes = { text: 0, format: 0, moved: 0, added: 0, removed: 0 };
  for (const [id, { l: x }] of a) if (!b.has(id) && String(x.text || '').trim()) { left.set(id, { cls: 'rs-gone' }); count++; changes.removed++; }
  for (const [id, { l: y, e }] of b) {
    const old = a.get(id);
    if (!old) { if (String(y.text || '').trim()) { right.set(id, { cls: 'rs-new' }); count++; changes.added++; } continue; }
    if (old.l.text !== y.text) { const segs = wordDiff(old.l.text, y.text); left.set(id, { segs }); right.set(id, { segs }); count++; changes.text++; continue; }
    if (JSON.stringify(old.l.em || []) !== JSON.stringify(y.em || [])) { right.set(id, { cls: 'rs-new' }); count++; changes.format++; continue; }
    if (!keep.has(id) || old.e !== e) { left.set(id, { cls: 'rs-moved' }); right.set(id, { cls: 'rs-moved' }); count++; changes.moved++; }
  }
  return { left, right, count, changes };
}
// 改一版时 Writer 正忙着别的（startRewrite 回 busy，same:false）：说清在忙什么。proposals 是 resumeView 的列表（有公司名、基于哪一版）。
export function busyLine(r, proposals = [], writer = 'Writer') {
  if (!r?.busy || r.same) return '';
  const p = proposals.find(x => x.id === r.proposal_id) || {};
  const what = r.kind === 'tailor' ? `${p.company || '一个岗位'} 的定制版` : `${p.base_version || '另一版'} 的新版`;
  return `${writer} 正在做 ${what}，做完再改这一版`;
}
// 用这版以后：用的时候又核对了一遍，过不了的行退回原文（reverted）或丢掉（dropped），说一句。
export function usedLine(r) {
  const late = (r?.reverted?.length || 0) + (r?.dropped?.length || 0);
  return `存成 ${r?.label || r?.vid}${late ? `；有 ${late} 处找不到出处，没用上` : ''}`;
}
// Writer 想跟你确认的事（新版的 questions）：一条一行，放在右栏纸的下面。
export const asksHtml = (qs = []) => qs.length ? `<ul class="rs-asks">${qs.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : '';
const segHtml = (segs, side) => segs.map(s => s.k === 'eq' ? esc(s.t) : s.k === (side === 'left' ? 'del' : 'ins') ? `<${s.k}>${esc(s.t)}</${s.k}>` : '').join('');
export function sideHtml(content, marks, side) {
  return paperHtml(content, { lineHtml: l => { const m = marks.get(l.id); return m?.segs ? segHtml(m.segs, side) : inline(l); }, lineClass: l => marks.get(l.id)?.cls || '' });
}

// ── 页面 ─────────────────────────────────────────────────────────────────────
let C = null, V = null, R = null, poll = null, busy = false, side = 'new';
// 窄屏（手机）一次看一栏：上面「现在 / Writer 改的」二选一，默认看 Writer 改的（CSS 只在窄于 640 时显示这个切换）。
const $ = s => document.querySelector(s);
export const compareSig = () => V ? `cmp:${R.doc}:${R.proposal || `${R.a}..${R.b}`}:${V.proposal_view?.proposal?.status}:${V.proposal_view?.base?.rev}` : null;
export function leave() { clearTimeout(poll); V = null; side = 'new'; }
const writer = () => V?.crew?.name || 'Writer';
async function load() {
  // 两版之间（版本卡片上的「和上一版对比」）：?a=v2&b=v5；Writer 的新版（旧数据）：?p=p2。
  V = await getJson(`/api/resume/view?${new URLSearchParams({ ...(R.doc ? { doc: R.doc } : {}), ...(R.a && R.b ? { a: R.a, b: R.b } : { proposal: R.proposal || '' }) })}`);
  clearTimeout(poll);
  if (V.proposal_view?.proposal?.status === 'running') poll = setTimeout(async () => { if (!$('#rs[data-route="compare"]')) return; const before = compareSig(); try { await load(); } catch { return; } if (compareSig() !== before) paint(); }, 2000);
}
export async function comparePage(ctx, route) {
  C = ctx; R = route;
  try { await load(); }
  catch (e) { V = null; return `<div class="rs" id="rs" data-route="compare"><p class="rs-error">${esc(e.message)}</p></div>`; }
  return `<div class="rs is-cmp" id="rs" data-route="compare">${inner()}</div>`;
}
function paint() { const root = $('#rs[data-route="compare"]'); if (root && V) root.innerHTML = inner(); }
function inner() {
  const pv = V.proposal_view, p = pv.proposal, base = pv.base, doc = V.doc?.id;
  const pair = p.kind === 'versions', title = pair ? `${base?.label || base?.vid || ''} → ${p.label || p.used_version}` : p.kind === 'tailor' ? `${p.company || '岗位'} 定制版` : `${writer()} 改的新版`;
  const done = pair || ['used', 'dropped'].includes(p.status);
  const acts = done ? '' : `<button type="button" class="rs-btn" data-drop ${busy ? 'disabled' : ''}>不用</button><button type="button" class="rs-btn is-pri" data-use ${p.status !== 'ready' || busy ? 'disabled' : ''}>用这版</button>`;
  const bar = `<header class="rs-bar"><a class="rs-back" href="${C.homeHash(doc)}">← 材料</a><span class="rs-div"></span><b class="rs-title">${esc(title)}</b>${p.instruction ? `<span class="rs-muted">${esc(p.instruction)}</span>` : ''}${done && !pair ? `<span class="rs-tag is-quiet">${p.status === 'used' ? `已存成 ${esc(p.used_version || '')}` : '已丢掉'}</span>` : ''}${pair ? `<a class="rs-btn is-pri" href="${C.editHash(doc, p.used_version)}">打开 ${esc(p.used_version)}</a>` : ''}<span class="rs-sp"></span>${acts}</header>`;
  const marks = p.content && base ? lineMarks(base.content, p.content) : null;
  const leftCol = `<section class="rs-col is-old"><header><b>${pair ? '上一版' : '现在'}</b><span>${base ? esc(base.label || base.vid) : ''}</span></header><div class="rs-sheet">${base ? marks ? sideHtml(base.content, marks.left, 'left') : paperHtml(base.content) : ''}</div></section>`;
  let right;
  if (p.status === 'running') right = `<div class="rs-col-state"><span class="rs-spin"></span>${esc(writer())} 在改</div>`;
  else if (p.status === 'failed') right = `<div class="rs-col-state is-bad"><p>${esc(p.error || '没改成')}</p><button type="button" class="rs-btn" data-retry ${busy ? 'disabled' : ''}>再试一次</button></div>`;
  else right = p.content ? `<div class="rs-sheet">${sideHtml(p.content, marks.right, 'right')}</div>${asksHtml(p.questions)}` : '';
  const rightHead = `<header><b>${pair ? esc(p.label || p.used_version) : `${esc(writer())} 改的`}</b>${marks ? `<span>${marks.count ? Object.entries(marks.changes).filter(([, n]) => n).map(([k, n]) => `${{ text: '文字', format: '格式', moved: '顺序', added: '新增', removed: '删除' }[k]} ${n} 行`).join(' · ') : '没有改动'}</span>` : ''}</header>`;
  const note = !base?.changed_since ? '' : pair ? `<p class="rs-state is-warn">左边是 ${esc(writer())} 开始改时的 ${esc(base.vid)}；你后来在 ${esc(base.vid)} 上改的那些不在 ${esc(p.used_version || p.label || '')} 里</p>` : p.status === 'ready' ? `<p class="rs-state is-warn">${esc(base.vid)} 在 ${esc(writer())} 改的时候又改过，右边没有这些改动</p>` : '';
  const seg = `<div class="rs-seg rs-cmp-seg" role="group" aria-label="看哪一版">${[['old', pair ? base?.vid || '上一版' : '现在'], ['new', pair ? p.used_version : `${writer()} 改的`]].map(([k, t]) => `<button type="button" class="${side === k ? 'is-on' : ''}" data-side="${k}" aria-pressed="${side === k}">${esc(t)}</button>`).join('')}</div>`;
  return `${bar}${note}${seg}<div class="rs-cols" data-side="${side}" data-scroll-key="rs-cols">${leftCol}<section class="rs-col is-new">${rightHead}${right}</section></div>`;
}
async function run(fn) {
  if (busy) return;
  busy = true; paint();
  try { await fn(); } catch (e) { C.h.toast(e.message); try { await load(); } catch {} }
  finally { busy = false; paint(); }
}
export function bindCompare() {
  const root = $('#rs[data-route="compare"]');
  if (!root || !V) return;
  root.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || !V) return;
    if (t.dataset.side) { side = t.dataset.side === 'old' ? 'old' : 'new'; paint(); return; }
    const doc = V.doc.id, p = V.proposal_view.proposal, base = V.proposal_view.base;
    if ('use' in t.dataset) return run(async () => { const r = await act({ action: 'proposal_use', doc, proposal: p.id }); C.h.toast(usedLine(r)); C.go(C.editHash(doc, r.vid)); });
    if ('drop' in t.dataset) return run(async () => { await act({ action: 'proposal_drop', doc, proposal: p.id }); C.h.toast(`${writer()} 的新版丢掉了`); C.go(base ? C.editHash(doc, base.vid) : C.homeHash(doc)); });
    if ('retry' in t.dataset) return run(async () => { const r = await act({ action: 'rewrite', doc, ...(p.kind === 'tailor' && p.lead_id ? { lead_id: p.lead_id } : { version: base?.vid }), instruction: p.instruction || '' }); const busy = busyLine(r, V.proposals, writer()); if (busy) C.h.toast(busy); await load(); });
  });
}
