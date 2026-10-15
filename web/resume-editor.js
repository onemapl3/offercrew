// 材料 · 简历页（2026-10-01，设计说明 3.3，样稿 v4-1）：正文就是一张纸，排版和导出的 PDF 用同一套 CSS（web/resume-paper.js）。
//   点哪改哪：改字；回车起新的一行（光标后面的字带到新行）；空行上按退格删掉这一行；Alt+↑ / ↓ 挪一行（在抬头上挪整段经历）；
//   ⌘B 加粗选中的字；每一段后面的「+」加一段、加一节、删掉这一段。
//   自动保存：停下 600 ms 把攒下的改字打包成一次 edit（带 rev）；回车、删行、挪动先把攒下的存掉再单独存。
//   409 = 这一版刚在别处改过：重新载入，并说一句。⌘Z / ⇧⌘Z 撤销、重做；「历史」回到任意一步、另存为新版本。
//   v1 只读：第一下按键之前先复制成新的一版，跳过去接着打。
//   Writer（F4，设计说明 4.2）：「体检」直接在对话里发「@Writer 体检这一版」（只看、不改）；「改一版」打开对话、预填
//   「@Writer 改一版，」等你补一句再回车。结果都在对话里。对话里 Writer 改完一句（oc:resume-changed），这里重新载入，改过的行标黄 3 秒；
//   点体检的某一条（oc:resume-goto），那几行闪一下。Writer 在改这一版时顶栏写「Writer 在改」。
// 纯函数（keyOp、createBatcher、locate）在 tests/resume-page.test.mjs 里测。
import { paperHtml, esc } from './resume-paper.js';
import { faceHtml } from './crew-faces.js';
import { getJson, act, exportPdf } from './resume-api.js';
import { askConfirm } from './settings/ask.js';

// ── 纯函数 ───────────────────────────────────────────────────────────────────
// 一行在哪：抬头（header）、节标题（title）、一段的抬头（head）、一段的条目（lines）；同一个容器里的前后。
export function locate(content, id) {
  const header = content?.header || [];
  const hi = header.findIndex(l => l.id === id);
  if (hi >= 0) return { part: 'header', line: header[hi], arr: header, i: hi };
  for (const section of content?.sections || []) {
    if (section.title?.id === id) return { part: 'title', line: section.title, section, arr: [section.title], i: 0 };
    const entries = section.entries || [];
    for (let ei = 0; ei < entries.length; ei++) {
      const entry = entries[ei];
      for (const part of ['head', 'lines']) {
        const i = (entry[part] || []).findIndex(l => l.id === id);
        if (i >= 0) return { part, line: entry[part][i], arr: entry[part], i, entry, section, entries, ei };
      }
    }
  }
  return null;
}
// 对话里的「正在看」（设计说明 3.5）：选中的只算正文里的条目行（抬头、节标题、一段的抬头不交给 Writer 改）。
export function selectableIds(content, ids = []) {
  return [...new Set((ids || []).map(String))].filter(id => locate(content, id)?.part === 'lines').slice(0, 40);
}
// 发给对话面板的那一份：{ kind:'resume', doc, version, name, selection }。
export function viewingOf(m) {
  if (!m?.doc || !m?.vid) return null;
  return { kind: 'resume', doc: m.doc, version: m.vid, name: m.view?.version?.name || '', selection: selectableIds(m.content, m.sel || []) };
}
// 顶栏上 Writer 的两个按钮：体检直接发出去；改一版只预填，等你补一句要求。
export function writerAsk(kind, writer = 'Writer') {
  if (kind === 'check') return { say: `@${writer} 体检这一版` };
  if (kind === 'rewrite') return { fill: `@${writer} 改一版，` };
  return null;
}
const isMod = k => !!(k.meta || k.ctrl);
// 一次按键 → { ops, focus } | { cmd:'undo'|'redo' } | { focusNext:true } | { prevent:true } | null（交给浏览器）。
// k：{ key, alt, shift, meta, ctrl, start, end }（start / end 是这一行里的光标或选区，按字符数）。
export function keyOp(k, content, id) {
  const at = locate(content, id);
  if (!at) return null;
  const text = String(at.line.text ?? ''), key = k.key;
  if (isMod(k) && !k.alt && (key === 'z' || key === 'Z')) return { cmd: k.shift ? 'redo' : 'undo' };
  if (isMod(k) && !k.alt && (key === 'y' || key === 'Y')) return { cmd: 'redo' };
  if (isMod(k) && !k.alt && (key === 'b' || key === 'B')) {
    const s = Math.min(k.start ?? 0, k.end ?? 0), e = Math.max(k.start ?? 0, k.end ?? 0), pick = text.slice(s, e).trim();
    if (!pick) return { prevent: true };
    const em = Array.isArray(at.line.em) ? at.line.em : [], next = em.includes(pick) ? em.filter(x => x !== pick) : [...em, pick];
    return { ops: [{ op: 'set_em', line_id: id, em: next.length ? next : null }], focus: { line: id, start: s, end: e } };
  }
  if (key === 'Enter' && !k.shift && !isMod(k) && !k.alt) {
    if (at.part === 'title') return { focusNext: true };
    if (at.part === 'head') return { ops: [{ op: 'insert_line', entry_id: at.entry.id, part: 'lines', after: null, text: '' }], focus: { added: true, start: 0 } };
    const cut = Math.min(Math.max(k.start ?? text.length, 0), text.length), cutEnd = Math.max(cut, Math.min(k.end ?? cut, text.length));
    const left = text.slice(0, cut), right = text.slice(cutEnd);
    const where = at.part === 'header' ? { header: true } : { entry_id: at.entry.id, part: 'lines' };
    const ops = [];
    if (left !== text) ops.push({ op: 'set_text', line_id: id, text: left });
    ops.push({ op: 'insert_line', ...where, after: id, text: right });
    return { ops, focus: { added: true, start: 0 } };
  }
  if (key === 'Backspace' && !isMod(k) && !k.alt && text === '') {
    const prev = at.i > 0 ? at.arr[at.i - 1].id : null;
    if (at.part === 'title') return null;
    if (at.part === 'head') {
      if (at.entry.head.length > 1) return { ops: [{ op: 'delete_line', line_id: id }], focus: { line: prev || at.entry.head[1]?.id, start: 'end' } };
      if ((at.entry.lines || []).every(l => !String(l.text || '').trim())) return { ops: [{ op: 'delete_entry', entry_id: at.entry.id }], focus: { before: id } };
      return { prevent: true };
    }
    if (at.part === 'header' && at.i === 0) return { prevent: true };
    return { ops: [{ op: 'delete_line', line_id: id }], focus: prev ? { line: prev, start: 'end' } : { before: id } };
  }
  if (k.alt && !isMod(k) && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const up = key === 'ArrowUp';
    if (at.part === 'head') {
      const es = at.entries, i = at.ei;
      if (up ? i === 0 : i === es.length - 1) return { prevent: true };
      return { ops: [{ op: 'move_entry', entry_id: at.entry.id, after: up ? (i >= 2 ? es[i - 2].id : null) : es[i + 1].id }], focus: { line: id, start: k.start ?? 0 } };
    }
    if (at.part === 'lines' || at.part === 'header') {
      const a = at.arr, i = at.i;
      if (up ? i === 0 : i === a.length - 1) return { prevent: true };
      if (at.part === 'header' && (i === 0 || (up && i === 1))) return { prevent: true }; // 姓名那一行不动
      return { ops: [{ op: 'move_line', line_id: id, after: up ? (i >= 2 ? a[i - 2].id : null) : a[i + 1].id }], focus: { line: id, start: k.start ?? 0 } };
    }
    return { prevent: true };
  }
  return null;
}
// 攒改字：同一行的 set_text / set_em 只留最后一次；停下 delay 毫秒（或者一直在打，最多 maxWait）就交给 send 存一次。
export function createBatcher({ delay = 600, maxWait = 3000, send, set = (f, ms) => setTimeout(f, ms), clear = t => clearTimeout(t), now = () => Date.now() }) {
  let ops = [], timer = null, first = 0;
  const flush = () => { if (timer != null) clear(timer); timer = null; if (!ops.length) return null; const out = ops; ops = []; return send(out); };
  return {
    push(op) {
      const same = ops.findIndex(o => o.op === op.op && o.line_id === op.line_id && ['set_text', 'set_em'].includes(op.op));
      if (same >= 0) ops[same] = op; else ops.push(op);
      if (!first || timer == null) first = now();
      if (timer != null) clear(timer);
      timer = set(() => { const p = flush(); p?.catch?.(() => {}); }, Math.max(0, Math.min(delay, maxWait - (now() - first))));
    },
    flush,
    pending: () => ops.length,
    drop() { if (timer != null) clear(timer); timer = null; ops = []; },
  };
}

// ── 状态 ─────────────────────────────────────────────────────────────────────
let C = null, M = null, gen = 0, seq = 0, openSeq = 0;
const $ = s => document.querySelector(s);
const FLASH_MS = 3000;
export const editorSig = () => M ? `edit:${M.doc}:${M.vid}:${M.shown}` : null;
const writer = () => M?.view?.crew?.name || 'Writer';
const face = () => M?.view?.crew?.face ? faceHtml(M.view.crew.face, { size: 18 }) : '';

async function fetchView(doc, vid, proposal = null) {
  const q = new URLSearchParams({ ...(doc ? { doc } : {}), ...(vid ? { version: vid } : {}), ...(proposal ? { proposal } : {}) });
  return getJson(`/api/resume/view?${q}`);
}
function fresh(view, route) {
  return { doc: view.doc?.id, vid: view.version?.id, want: route, view, content: view.version?.content, rev: view.version?.rev ?? 0, shown: ++seq, status: 'saved', historyOpen: false, moreOpen: false, fromMore: false, plus: null, flash: new Map(), seenEdits: new Set((view.writer?.edits || []).filter(e => !recent(e)).map(e => e.id)), composing: false, busy: false, q: Promise.resolve(), pendingFocus: null, batch: null, sel: [] };
}
const recent = e => e.status === 'applied' && Date.now() - (Date.parse(e.finished_at || e.at || '') || 0) < 60000;
export function leave() { openSeq++; if (M?.batch?.pending()) M.batch.flush(); M = null; announce(null); }

// ── 对话里的「正在看 简历 v4 · 通用版 · 选中 N 行」：打开、换版本、选中的行变了就发 oc:viewing；离开这一页发 null ──
// 发在下一拍：web/app.js 画完页面以后会 setViewing(null)（岗位页来的时候那一下会发 null），我们的要在它后面。
let announced = 'null', selTimer = null;
function announce(detail) {
  const key = JSON.stringify(detail ?? null);
  if (key === announced || typeof window === 'undefined') return;
  announced = key;
  window.dispatchEvent(new CustomEvent('oc:viewing', { detail: detail ?? null }));
}
const announceSoon = () => setTimeout(() => { if (M && $('#rs[data-route="edit"]')) announce(viewingOf(M)); }, 0);
const onThisVersion = () => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); return /^#materials\/edit(\?|$)/.test(location.hash) && M && (q.get('doc') || M.doc) === M.doc && (q.get('v') || M.vid) === M.vid; };
// 选区跑到别处（对话输入框）时留着刚才选的；在纸上点一下（没选中字）就是不选。
function readSelection() {
  if (!M || !$('#rs[data-route="edit"]')) return;
  const sheet = $('#rs-sheet'), sel = getSelection();
  if (!sheet || !sel?.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (!sheet.contains(r.commonAncestorContainer)) return;
  const ids = r.collapsed ? [] : [...sheet.querySelectorAll('[data-line]')].filter(el => r.intersectsNode(el)).map(el => el.dataset.id);
  const next = selectableIds(M.content, ids);
  if (JSON.stringify(next) === JSON.stringify(M.sel || [])) return;
  M.sel = next;
  announce(viewingOf(M));
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(readSelection, 150); });
  window.addEventListener('hashchange', () => { if (onThisVersion()) announceSoon(); else if (!/^#materials\/edit(\?|$)/.test(location.hash)) announce(null); });
}

export async function editorPage(ctx, route) {
  C = ctx;
  const opening = ++openSeq, fromHash = location.hash;
  const current = () => opening === openSeq && location.hash === fromHash;
  if (M && M.want.doc === route.doc && M.want.version === route.version && $('#rs[data-route="edit"]')) {
    // 同一版还开着（后台刷新）：不整页重画——有外面的改动就就地换掉正文，光标留着。
    await sync();
    return current() ? html() : null;
  }
  if (M?.batch?.pending()) await M.batch.flush();
  let view;
  try { view = await fetchView(route.doc, route.version); }
  catch (e) { if (!current()) return null; M = null; return `<div class="rs" id="rs" data-route="edit"><p class="rs-error">${esc(e.message)}</p></div>`; }
  if (!current()) return null;
  const carry = M?.carry || null;
  M = fresh(view, route);
  M.carry = carry;
  adopt(M, M.vid); // 打开的那一版有没存的修改：页面就停在它的草稿上（地址也换过去，刷新还在）
  M.batch = createBatcher({ send: ops => save(ops) });
  markWriterEdits(view);
  return html();
}
function html() {
  return `<div class="rs is-edit" id="rs" data-route="edit"><header class="rs-bar" id="rs-bar">${barHtml()}</header><div class="rs-draftbar" id="rs-draftbar"${M.view.version.draft ? '' : ' hidden'}>${draftHtml()}</div><div class="rs-desk" data-scroll-key="rs-desk"><div class="rs-sheet is-edit" id="rs-sheet" lang="${M.content?.lang === 'zh' ? 'zh-CN' : 'en'}">${sheetHtml()}</div></div></div>`;
}
function sheetHtml() { return paperHtml(M.content, { editable: true, lineClass: l => M.flash.has(l.id) ? 'rs-flash' : '' }); }
function barHtml() {
  const v = M.view.version, meta = M.view.versions.find(x => x.id === v.id) || {};
  // 改动先进草稿（10-03）：自动存着；「存为新的一版」才在历史里多一版。没改的时候不显示这一行。
  const state = M.status === 'saved' ? '' : `<span class="rs-saved${M.status === 'error' ? ' is-bad' : ''}">${{ saving: '正在保存…', error: '没存上' }[M.status]}</span>`;
  const saved = state; // 草稿那一行在顶栏下面单独一条（draftHtml），版本名不被挤掉
  const job = (M.view.proposals || []).some(p => p.status === 'running' && p.base_version === v.id) ? `<span class="rs-job"><span class="rs-spin"></span>${esc(writer())} 在改</span>` : '';
  return `<a class="rs-back" href="${C.homeHash(M.doc)}">← 材料</a><span class="rs-div"></span><b class="rs-title">${esc(v.label || v.id)}</b>${meta.default_for ? '<span class="rs-tag is-use">默认投递</span>' : ''}${v.in_use_for?.number != null ? `<span class="rs-tag is-use">#${esc(v.in_use_for.number)} 投递在用</span>` : ''}${saved}${job}${v.use_for ? `<button type="button" class="rs-btn is-pri rs-accept" data-accept ${M.accepting ? 'disabled' : ''}>用这版投${v.use_for.number != null ? ` #${esc(v.use_for.number)}` : ''}</button>` : ''}<span class="rs-sp"></span>
    <button type="button" class="rs-btn is-writer" data-check>${face()}体检</button><button type="button" class="rs-btn is-writer" data-rewrite>${face()}改一版</button><span class="rs-div"></span>
    <button type="button" class="rs-btn is-ghost" data-undo ${v.can_undo ? '' : 'disabled'} title="撤销（⌘Z）" aria-label="撤销">↶<span class="rs-undo-t"> 撤销</span></button><span class="rs-pop-at rs-wide"><button type="button" class="rs-btn" data-history aria-expanded="${M.historyOpen && !M.fromMore}">历史</button>${M.historyOpen && !M.fromMore ? historyHtml() : ''}</span><button type="button" class="rs-btn rs-wide" data-export>导出 PDF</button>
    <span class="rs-pop-at rs-narrow"><button type="button" class="rs-btn is-ghost rs-bar-more" data-bar-more aria-label="更多" aria-expanded="${M.moreOpen}">⋯</button>${M.moreOpen ? '<div class="rs-menu" role="menu"><button type="button" role="menuitem" data-history data-from-more>历史</button><button type="button" role="menuitem" data-export>导出 PDF</button></div>' : ''}${M.historyOpen && M.fromMore ? historyHtml() : ''}</span>`;
}
const BY = { you: '你', writer: 'Writer' };
function historyHtml() {
  const hs = M.view.version.history || [], t = x => { const d = new Date(x); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
  const rows = hs.map((x, i) => `<li><span><b>${esc(x.by === 'writer' ? writer() : BY[x.by] || '你')}</b> 改了 ${x.steps} 处<small>${esc(t(x.at))}</small></span>${i ? `<button type="button" class="rs-lnk" data-rewind="${esc(x.id)}">回到这里</button>` : '<span class="rs-muted">现在</span>'}</li>`).join('');
  return `<div class="rs-pop" role="dialog" aria-label="历史"><ul>${rows}<li><span><b>${esc(M.view.version.id)} 刚建好</b><small>${esc(t(M.view.versions.find(x => x.id === M.vid)?.created_at))}</small></span>${hs.length ? '<button type="button" class="rs-lnk" data-rewind="">回到这里</button>' : '<span class="rs-muted">现在</span>'}</li></ul></div>`;
}
function paintBar() { const b = $('#rs-bar'); if (b && M) b.innerHTML = barHtml(); const d = $('#rs-draftbar'); if (d && M) { d.innerHTML = draftHtml(); d.hidden = !M.view.version.draft; } }
// 顶栏下面那一条：改了 N 处，还没存成新的一版 + 三个按钮（10-03）。没改的时候藏起来。
function draftHtml() {
  const dr = M.view.version.draft, busy = M.busy ? 'disabled' : '';
  if (!dr) return '';
  return `<span class="rs-draft">改了 ${esc(dr.changes)} 处，还没存成新的一版</span><span class="rs-sp"></span><button type="button" class="rs-btn is-pri" data-draft-save ${busy}>存为新的一版</button><button type="button" class="rs-btn" data-draft-newdoc ${busy}>另存为新简历</button><button type="button" class="rs-btn is-ghost" data-draft-discard ${busy}>不要这些修改</button>`;
}
// 正文就地重画：光标所在的那一行和位置留着。
function paintSheet(focus = null) {
  const sheet = $('#rs-sheet'); if (!sheet || !M) return;
  const cur = document.activeElement?.closest?.('#rs-sheet [data-line]');
  const keep = cur ? { line: cur.dataset.id, ...caretOf(cur) } : null;
  sheet.innerHTML = sheetHtml();
  const f = focus || keep;
  if (f) place(f);
}

// ── 光标 ─────────────────────────────────────────────────────────────────────
function caretOf(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return { start: 0, end: 0 };
  const r = sel.getRangeAt(0), pre = document.createRange();
  pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return { start, end: start + r.toString().length };
}
function pointAt(el, n) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = n, node;
  while ((node = w.nextNode())) { if (left <= node.length) return [node, left]; left -= node.length; }
  return [el, el.childNodes.length];
}
function setCaret(el, start, end = start) {
  const len = el.textContent.length, s = start === 'end' ? len : Math.min(start, len), e = end === 'end' ? len : Math.min(end, len);
  const r = document.createRange();
  r.setStart(...pointAt(el, s)); r.setEnd(...pointAt(el, e));
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function place(f) {
  const el = f.line && document.querySelector(`#rs-sheet [data-line][data-id="${CSS.escape(f.line)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  setCaret(el, f.start ?? 'end', f.end ?? f.start ?? 'end');
  el.scrollIntoView({ block: 'nearest' });
}
const ids = c => { const out = []; for (const l of c?.header || []) out.push(l.id); for (const s of c?.sections || []) { if (s.title) out.push(s.title.id); for (const e of s.entries || []) for (const l of [...(e.head || []), ...(e.lines || [])]) out.push(l.id); } return out; };

// ── 存 ───────────────────────────────────────────────────────────────────────
function localText(id, text) { const at = locate(M.content, id); if (at) at.line.text = text; }
// 所有写都排成一队：前一次回来了（拿到新的 rev）才发下一次。
function queue(fn) { const run = M.q.then(fn, fn); M.q = run.catch(() => {}); return run; }
function save(ops) {
  const me = M;
  // 页面已经离开这一版（M 换了）也照样存完：只是不再画。
  return queue(async () => {
    me.status = 'saving'; if (M === me) paintBar(); gen++;
    try {
      const sid = window.OfferCrew?.talkSession?.() || null; // Writer 的提醒落在你正看着的那段对话里
      const r = await act({ action: 'edit', doc: me.doc, version: me.vid, ops, rev: me.rev, ...(sid ? { session_id: sid } : {}) });
      me.rev = r.rev ?? me.rev; me.view.version.rev = me.rev;
      if (r.vid && r.vid !== me.vid) adopt(me, r.vid); // 第一下改动开了一份草稿：之后的撤销、重做、改动都在草稿上
      if (r.change_id) { me.view.version.can_undo = true; me.view.version.can_redo = false; }
      if ('draft' in r) me.view.version.draft = r.draft;
      me.status = 'saved';
      // r.warn（你写的字在原简历和资料里找不到）不在这里弹：设计说明 4.3，只在对话里提醒一句（F4）。
    } catch (e) { await failed(me, e); throw e; }
    finally { if (M === me) paintBar(); }
  });
}
async function failed(me, e) {
  if (M !== me) return;
  if (e.status === 409 || e.status === 422 || e.status === 400) {
    me.batch.drop();
    await reload();
    C.h.toast(e.status === 409 ? e.message || '这一版刚在别处改过，已重新载入' : e.message);
    return;
  }
  me.status = 'error';
  C.h.toast(e.message);
}
async function reload(focus = null) {
  if (!M) return;
  const me = M, view = await fetchView(me.doc, me.vid);
  if (M !== me) return;
  const before = ids(me.content);
  me.view = view; me.content = view.version.content; me.rev = view.version.rev; me.status = 'saved';
  markWriterEdits(view);
  if (focus?.added) { const had = new Set(before), nw = ids(me.content).find(x => !had.has(x)); focus = nw ? { line: nw, start: focus.start ?? 0 } : null; }
  if (focus?.before) { const all = ids(me.content), old = before.indexOf(focus.before); focus = { line: before.slice(0, Math.max(0, old)).reverse().find(x => all.includes(x)) || all[0], start: 'end' }; }
  paintSheet(focus); paintBar();
}
// 回车、删行、挪动、加粗、+：先把攒下的改字存掉，再存这一步，然后按服务端的内容重画（新行的编号是服务端给的）。
async function structural(ops, focus) {
  if (M.busy) return;
  M.busy = true;
  try { await M.batch.flush(); await save(ops); await reload(focus); }
  catch {} finally { if (M) M.busy = false; }
}
async function command(action, extra = {}) {
  if (M.busy) return;
  M.busy = true;
  try {
    await M.batch.flush();
    await queue(async () => { const r = await act({ action, doc: M.doc, version: M.vid, rev: M.rev, ...extra }); M.rev = r.rev ?? M.rev; });
    await reload();
  } catch (e) { if (e.status === 409) { await reload(); C.h.toast(e.message); } else C.h.toast(e.message); }
  finally { if (M) M.busy = false; }
}
// 后台刷新：别处改过这一版（另一个标签页、对话里的 Writer），而这里没有没存的字，就换成新的内容。
async function sync() {
  const me = M, g = gen;
  let view;
  try { view = await fetchView(me.doc, me.vid); } catch { return; }
  if (M !== me || g !== gen || me.busy || me.batch.pending() || me.composing) return;
  const changed = view.version.rev !== me.rev;
  me.view = { ...view, version: changed ? view.version : { ...view.version, content: me.content } };
  if (changed) { me.content = view.version.content; me.rev = view.version.rev; markWriterEdits(view); paintSheet(); }
  paintBar();
}
// Writer 刚改过的行（对话里「改一句」，GET /api/resume/view 的 writer.edits）：标黄 3 秒。
function markWriterEdits(view) {
  for (const e of view.writer?.edits || []) {
    if (M.seenEdits.has(e.id) || e.status !== 'applied' || e.to_vid !== M.vid) continue;
    M.seenEdits.add(e.id);
    if (!recent(e)) continue;
    for (const id of e.line_ids || []) M.flash.set(id, Date.now() + FLASH_MS);
  }
  unflashLater();
}
function unflashLater() {
  if (M?.flash.size) setTimeout(() => { if (!M) return; const now = Date.now(); for (const [id, until] of M.flash) if (until <= now) { M.flash.delete(id); document.querySelector(`#rs-sheet [data-id="${CSS.escape(id)}"]`)?.classList.remove('rs-flash'); } }, FLASH_MS + 50);
}

// ── Writer：顶栏的按钮走对话（web/talk.js talkSay / openTalk）；对话里的结果回到这一页 ──────────────────
async function askWriter(kind) {
  const a = writerAsk(kind, writer());
  try { await M.batch.flush(); } catch {}
  if (a?.say) window.OfferCrew?.talkSay?.(a.say);
  else if (a?.fill) window.OfferCrew?.openTalk?.(a.fill);
}
function flashLines(list) {
  const first = list[0];
  if (first) document.querySelector(`#rs-sheet [data-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  for (const id of list) { M.flash.set(id, Date.now() + FLASH_MS); document.querySelector(`#rs-sheet [data-id="${CSS.escape(id)}"]`)?.classList.add('rs-flash'); }
  unflashLater();
}
if (typeof window !== 'undefined') {
  // 对话里 Writer 改完了一句、撤销了、改一版做完了：这一版重新载入（改过的行由 writer.edits 标黄）；
  // 原简历 v1 上说的，改在复制出来的那一版上：跳过去。
  window.addEventListener('oc:resume-changed', e => {
    const d = e.detail || {};
    if (!M || d.doc !== M.doc || !$('#rs[data-route="edit"]')) return;
    if (d.version && d.version !== M.vid && d.from === M.vid && d.kind === 'edit') { C.go(C.editHash(M.doc, d.version)); return; }
    if (!d.version || d.version === M.vid || d.kind === 'rewrite') sync();
  });
  window.addEventListener('oc:resume-goto', e => {
    const d = e.detail || {};
    if (!M || d.doc !== M.doc || d.version !== M.vid || !$('#rs[data-route="edit"]')) return;
    flashLines((d.line_ids || []).filter(Boolean));
  });
}

// ── v1 只读：先复制 ────────────────────────────────────────────────────────────
async function copyThenType(el, text) {
  if (M.copying) return;
  M.copying = true;
  try {
    const r = await act({ action: 'copy', doc: M.doc, version: M.vid });
    C.h.toast(`${M.vid} 是原简历，改在复制出来的 ${r.vid} 上`);
    M.carry = { line: el.dataset.id, ...caretOf(el), text };
    C.go(C.editHash(M.doc, r.vid));
  } catch (e) { C.h.toast(e.message); M.copying = false; }
}

// ── 绑定 ─────────────────────────────────────────────────────────────────────
export function bindEditor() {
  const root = $('#rs[data-route="edit"]');
  if (!root || !M) return;
  const sheet = root.querySelector('#rs-sheet');
  root.addEventListener('click', e => {
    const t = e.target.closest('button, a');
    if (!t) { if ((M.historyOpen || M.moreOpen) && !e.target.closest('.rs-pop')) { M.historyOpen = M.moreOpen = false; paintBar(); } if (M.plus && !e.target.closest('.rs-plus-menu')) closePlus(); return; }
    const ds = t.dataset;
    if (M.moreOpen && !('barMore' in ds)) { M.moreOpen = false; if (!('history' in ds)) paintBar(); }
    if ('barMore' in ds) { M.moreOpen = !M.moreOpen; M.historyOpen = false; paintBar(); return; }
    if ('accept' in ds) return accept();
    if ('check' in ds) return askWriter('check');
    if ('rewrite' in ds) return askWriter('rewrite');
    if ('undo' in ds) return command('undo');
    if ('history' in ds) { M.fromMore = 'fromMore' in ds; M.historyOpen = M.fromMore || !M.historyOpen; paintBar(); return; }
    if ('rewind' in ds) { M.historyOpen = false; return command('rewind', { change_id: ds.rewind || null }); }
    if ('draftSave' in ds) return draftAct('draft_save', r => { C.h.toast(`存成了一版新的，这份简历现在用它`); C.go(C.editHash(M.doc, r.vid)); });
    if ('draftNewdoc' in ds) return draftAct('draft_new_doc', r => { C.h.toast('另存成了一份新简历'); C.go(C.editHash(r.id, r.vid)); });
    if ('draftDiscard' in ds) return askConfirm({ title: '不要这些修改？', lines: ['会回到这一版原来的样子，改的这些找不回来。'], go: '不要了', danger: true }).then(ok => ok && draftAct('draft_discard', r => C.go(C.editHash(M.doc, r.vid))));
    if ('export' in ds) return Promise.resolve(M.batch.flush()).then(() => exportPdf(M.doc, M.vid)).catch(err => C.h.toast(err.message));
    if (ds.plus) return openPlus(t);
    if (ds.plusDo) return plusDo(ds.plusDo);
  });
  sheet.addEventListener('compositionstart', () => { M.composing = true; });
  sheet.addEventListener('compositionend', () => { M.composing = false; });
  sheet.addEventListener('beforeinput', e => {
    const el = e.target.closest?.('[data-line]');
    if (!el || !M.view.version.read_only) return;
    e.preventDefault();
    copyThenType(el, e.inputType === 'insertText' || e.inputType === 'insertCompositionText' ? e.data || '' : '');
  });
  sheet.addEventListener('input', e => {
    const el = e.target.closest?.('[data-line]');
    if (!el || M.view.version.read_only) return;
    const text = el.textContent.replace(/\n/g, ' ');
    el.toggleAttribute('data-empty', !text);
    localText(el.dataset.id, text);
    M.batch.push({ op: 'set_text', line_id: el.dataset.id, text });
    if (M.status !== 'saving') { M.status = 'saving'; paintBar(); }
  });
  sheet.addEventListener('keydown', e => {
    const el = e.target.closest?.('[data-line]');
    if (!el || e.isComposing || e.keyCode === 229) return;
    if (M.view.version.read_only) return;
    const c = caretOf(el);
    localText(el.dataset.id, el.textContent);
    const r = keyOp({ key: e.key, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, start: c.start, end: c.end }, M.content, el.dataset.id);
    if (!r) return;
    e.preventDefault();
    if (r.cmd) return command(r.cmd);
    if (r.focusNext) { const all = [...sheet.querySelectorAll('[data-line]')], i = all.indexOf(el); if (all[i + 1]) place({ line: all[i + 1].dataset.id, start: 0 }); return; }
    if (r.ops) structural(r.ops, r.focus);
  });
  // v1 上按的第一下：跳到复制出来的那一版以后，接着放进去。
  if (M.carry) {
    const k = M.carry; M.carry = null;
    const el = document.querySelector(`#rs-sheet [data-line][data-id="${CSS.escape(k.line)}"]`);
    if (el) { place({ line: k.line, start: k.start, end: k.end }); if (k.text) document.execCommand('insertText', false, k.text); }
  }
  announceSoon();
}
// 还没点「用这版」的定制版：在这一版的页面上点也一样（和收件箱那封信同一个动作），之后顶栏写「#N 投递在用」。
async function accept() {
  if (M.accepting) return;
  M.accepting = true; paintBar();
  try { await M.batch.flush(); const r = await act({ action: 'tailor_accept', doc: M.doc, version: M.vid }); if (r.receipt) C.h.toast(r.receipt); await reload(); }
  catch (e) { C.h.toast(e.message); }
  finally { if (M) { M.accepting = false; paintBar(); } }
}
// 「+」：加一段、加一节、删掉这一段。
function openPlus(btn) {
  closePlus();
  const entry = btn.dataset.plus, section = btn.dataset.plusSection;
  const sec = (M.content.sections || []).find(s => s.id === section), kind = sec?.kind;
  const entryKind = ['experience', 'education', 'projects'].includes(kind);
  M.plus = { entry, section };
  btn.insertAdjacentHTML('afterend', `<div class="rs-plus-menu" role="menu">${entryKind ? '<button type="button" role="menuitem" data-plus-do="entry">加一段经历</button>' : '<button type="button" role="menuitem" data-plus-do="line">加一行</button>'}<button type="button" role="menuitem" data-plus-do="section">加一节</button><button type="button" role="menuitem" data-plus-do="drop">删掉这一段</button></div>`);
}
function closePlus() { document.querySelector('#rs-sheet .rs-plus-menu')?.remove(); if (M) M.plus = null; }
async function plusDo(what) {
  const { entry, section } = M.plus || {};
  closePlus();
  if (!entry || M.view.version.read_only) return;
  const at = (M.content.sections || []).find(s => s.id === section)?.entries.find(e => e.id === entry);
  if (what === 'entry') return structural([{ op: 'add_entry', section_id: section, after: entry, head: [''] }], { added: true, start: 0 });
  if (what === 'line') return structural([{ op: 'insert_line', entry_id: entry, part: 'lines', after: at?.lines?.at(-1)?.id ?? null, text: '' }], { added: true, start: 0 });
  if (what === 'drop') return structural([{ op: 'delete_entry', entry_id: entry }], { before: at?.head?.[0]?.id || at?.lines?.[0]?.id });
  if (what === 'section') {
    const before = new Set((M.content.sections || []).map(s => s.id));
    await structural([{ op: 'add_section', after: section, title: '新的一节', kind: 'other' }], null);
    const s = (M.content.sections || []).find(x => !before.has(x.id));
    if (s) await structural([{ op: 'insert_line', section_id: s.id, after: null, text: '' }], { line: s.title?.id, start: 0, end: 'end' });
  }
}

// 草稿的三个按钮：先把攒着的改字存进草稿，再交给服务端（lib/resume-versions.mjs saveDraft / draftToNewDoc / discardDraft）。
async function draftAct(action, then) {
  if (!M || M.busy) return;
  M.busy = true; paintBar();
  try { await M.batch.flush(); await queue(async () => {}); const r = await act({ action, doc: M.doc, version: M.vid }); await then(r); }
  catch (e) { C.h.toast(e.message); }
  finally { if (M) { M.busy = false; paintBar(); } }
}

// 页面停在哪一份上：一版第一次改就开了一份草稿（10-03），从此改动、撤销、重做都对着草稿；地址跟着换，刷新、对话里的 Writer 都认它。
function adopt(me, vid) {
  if (!me || !vid) return;
  const requested = me.want.version || '';
  me.vid = vid; me.view.version.id = vid; me.want = { ...me.want, version: vid };
  if (M === me && /^#materials\/edit(\?|$)/.test(location.hash)) {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    if ((q.get('doc') || me.doc) !== me.doc || (q.get('v') || '') !== requested) return;
    if (q.get('v') !== vid) C.h.adoptHash(location.hash, C.editHash(me.doc, vid));
  }
}
