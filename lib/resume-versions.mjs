// 材料 · 版本操作（2026-10-01，设计说明 4.1 / 5.3；第 10 节 10-02）：每一版都直接改，v1（上传的原简历）也能改——上传的原件
// 在后台另存一份（doc.original，lib/resume-store.mjs），出处核对看它。每一次改动记进这一版的 history（带反向操作），
// 能撤销、重做、回到任意一个时刻。新版本只在上传、Writer 改一版、「另存为新版本」、定制时出现。
//
// 编辑都落在结构化内容上（lib/resume-doc.mjs：header / sections / entries / lines，每行一个固定编号）。applyOp 是纯函数，
// 每种操作都算得出反向操作（撤销逐字节回到原样）；新行、新段、新节的编号整份文档只增不减（doc.seq），跨版本不重复。
// 保存带 rev（lib/resume-store.mjs）：两个标签页、或你打字时 Writer 从对话里改了一句，旧的 rev 存不进去（STALE）。
// 按某一步撤销（对话里 Writer 那条消息的「撤销」）：那几行在那一步之后又被改过，就拒绝（CONFLICT），不冲掉后来的字。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file } from './store.mjs';
import { event } from './events.mjs';
import { waitForLock } from './lock.mjs';
import { readFacts } from './facts.mjs';
import { currentFacts as profileFacts, saveProfile, FACTS } from './profile.mjs';
import { ENTRY_KINDS, lineIndex, clone, maxLineNumber, poolsFor, walk } from './resume-doc.mjs';
import { verifyLine } from './resume-provenance.mjs';
import { exportPdf, exportDocx, readBack, coverage, plainText } from './resume-export.mjs';
import { readableResumeName } from './resume-import.mjs';
import { DIR, fail, loadDoc, saveDoc, loadWorkspace, saveWorkspace, markDefault, contentFp, originalContent, STALE_MESSAGE, versionNumbers, draftFor } from './resume-store.mjs';
import { versionLabel } from './resume-label.mjs';
import { pickResume, routedState, exportCurrent, readyPdf } from './resume-choice.mjs';
import { noteSwallowed } from './swallow.mjs';

const iso = t => new Date(t).toISOString();
const text = s => String(s ?? '').replace(/[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, 1000); // 制表符留着：原文里有
const name = (s, max = 40) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const badOp = message => Object.assign(Error(message), { status: 400, code: 'BAD_OP' });
const KINDS = ['summary', 'experience', 'education', 'projects', 'skills', 'awards', 'other'];
const has = (o, k) => o != null && Object.hasOwn(o, k) && o[k] !== undefined;

// ── 在内容里找 ────────────────────────────────────────────────────────────────
function findLine(c, id) {
  const i = c.header.findIndex(l => l.id === id);
  if (i >= 0) return { arr: c.header, i, line: c.header[i], where: { header: true } };
  for (const s of c.sections) {
    if (s.title && s.title.id === id) return { title: true, section: s, line: s.title };
    for (const e of s.entries) for (const part of ['head', 'lines']) {
      const j = e[part].findIndex(l => l.id === id);
      if (j >= 0) return { arr: e[part], i: j, line: e[part][j], section: s, entry: e, where: { entry_id: e.id, part } };
    }
  }
  return null;
}
function findEntryAt(c, id) {
  for (const s of c.sections) { const i = s.entries.findIndex(e => e.id === id); if (i >= 0) return { section: s, i, entry: s.entries[i] }; }
  return null;
}
const findSection = (c, id) => { const i = c.sections.findIndex(s => s.id === id); return i >= 0 ? { i, section: c.sections[i] } : null; };
const need = (x, what) => { if (!x) throw badOp(`找不到${what}`); return x; };
const prevId = (arr, i) => i > 0 ? arr[i - 1].id : null;
const afterIndex = (arr, after) => { if (after == null) return 0; const i = arr.findIndex(x => x.id === after); if (i < 0) throw badOp('找不到要接在后面的那一项'); return i + 1; };
// 一行放在哪：抬头、某一段的抬头（head）或条目（lines）；给了节就放进这一节的最后一段。
function container(c, op) {
  if (op.header) return { arr: c.header, where: { header: true } };
  let entry;
  if (op.entry_id) entry = need(findEntryAt(c, op.entry_id), '这一段').entry;
  else if (op.section_id) { const s = need(findSection(c, op.section_id), '这一节').section; entry = s.entries.at(-1); if (!entry) throw badOp('这一节还没有段落，先加一段'); }
  else throw badOp('没说加在哪');
  const part = op.part === 'head' ? 'head' : 'lines';
  return { arr: entry[part], where: { entry_id: entry.id, part } };
}

// ── 编号：整份文档只增不减 ─────────────────────────────────────────────────────
const num = id => Number(String(id || '').slice(1)) || 0;
function highWater(c) {
  let entry = 0, section = 0;
  for (const s of c?.sections || []) { section = Math.max(section, num(s.id)); for (const e of s.entries || []) entry = Math.max(entry, num(e.id)); }
  return { line: maxLineNumber(c || { header: [], sections: [] }), entry, section };
}
function counters(contents, seq = {}) {
  const hw = contents.map(highWater);
  const max = k => Math.max(Number(seq[k]) || 0, 0, ...hw.map(h => h[k]));
  return { line: max('line') + 1, entry: max('entry') + 1, section: max('section') + 1 };
}
const newLine = (ids, t, bullet) => ({ id: `L${ids.line++}`, text: String(t ?? ''), ...(bullet ? { bullet: true } : {}) });

// ── 外面送进来的一步编辑：先校验、清洗（页面、对话、Writer 都走这里）。整对象（line / entry / section）只给撤销、重做内部用。
const ID = { L: /^L\d{1,6}$/, E: /^E\d{1,6}$/, S: /^S\d{1,6}$/ };
const SPEC = {
  set_text: { line_id: 'L', text: 'text' },
  set_em: { line_id: 'L', em: 'em|null!' },
  insert_line: { entry_id: 'E?', section_id: 'S?', header: 'bool?', part: 'part?', after: 'L|null', text: 'text', bullet: 'bool?' },
  delete_line: { line_id: 'L' },
  move_line: { line_id: 'L', after: 'L|null', entry_id: 'E?', part: 'part?' },
  add_entry: { section_id: 'S', after: 'E|null', head: 'texts?' },
  delete_entry: { entry_id: 'E' },
  move_entry: { entry_id: 'E', after: 'E|null', section_id: 'S?' },
  set_entry_head: { entry_id: 'E', index: 'index', text: 'text' },
  add_section: { after: 'S|null', title: 'text|null?', kind: 'kind?' },
  delete_section: { section_id: 'S' },
  set_section_title: { section_id: 'S', title: 'text|null!' },
  set_header: { index: 'index', text: 'text' },
};
export function validateOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw badOp('这一步编辑的格式不对');
  const spec = SPEC[op.op];
  if (!spec) throw badOp('不认识的编辑');
  for (const k of ['line', 'entry', 'section']) if (has(op, k)) throw badOp('这一步编辑的格式不对：不接受整行、整段或整节的对象');
  const out = { op: op.op };
  for (const [k, rule] of Object.entries(spec)) {
    // 规则：「?」可以不给；「|null」可以是 null（不给就当 null）；「!」必须给出这个字段（可以是 null，但不能漏掉）。
    const optional = rule.endsWith('?'), must = rule.endsWith('!'), r = rule.replace(/[?!]$/, ''), val = op[k];
    if (val === undefined && must) throw badOp(`这一步编辑少了「${k}」`);
    if (val === undefined) { if (optional || r.includes('|null')) { if (r.includes('|null') && !optional) out[k] = null; continue; } throw badOp(`这一步编辑少了「${k}」`); }
    const bad = () => badOp(`这一步编辑的「${k}」不对`);
    if (val === null) { if (!r.includes('null')) throw bad(); out[k] = null; continue; }
    const kind = r.replace('|null', '');
    if (ID[kind]) { if (typeof val !== 'string' || !ID[kind].test(val)) throw bad(); out[k] = val; }
    else if (kind === 'text') { if (typeof val !== 'string') throw bad(); out[k] = text(val); }
    else if (kind === 'bool') { if (typeof val !== 'boolean') throw bad(); out[k] = val; }
    else if (kind === 'part') { if (!['head', 'lines'].includes(val)) throw bad(); out[k] = val; }
    else if (kind === 'index') { if (!Number.isInteger(val) || val < 0 || val > 50) throw bad(); out[k] = val; }
    else if (kind === 'kind') { if (!KINDS.includes(val)) throw bad(); out[k] = val; }
    else if (kind === 'texts') { if (!Array.isArray(val) || val.length > 4 || val.some(t => typeof t !== 'string')) throw bad(); out[k] = val.map(text); }
    else if (kind === 'em') { if (!Array.isArray(val) || val.length > 8 || val.some(t => typeof t !== 'string' || !t.trim())) throw bad(); out[k] = val.map(t => text(t).slice(0, 80)); }
  }
  if (op.op === 'insert_line' && [out.entry_id, out.section_id, out.header].filter(Boolean).length !== 1) throw badOp('这一行要加在哪：一段、一节或抬头，只能选一个');
  return out;
}

// ── 一步编辑：纯函数 → { content, inverse, op（带上分到的编号，重做时一模一样） } ─────────────────
export function applyOp(content, op, ids = counters([content])) {
  const c = clone(content), o = op || {};
  const out = (inverse, resolved = o) => ({ content: c, inverse, op: resolved });
  switch (o.op) {
    case 'set_text': {
      const x = need(findLine(c, o.line_id), '这一行'), old = x.line.text;
      if (typeof o.text !== 'string') throw badOp('缺少文字');
      x.line.text = o.text;
      return out({ op: 'set_text', line_id: o.line_id, text: old });
    }
    case 'set_em': {
      const x = need(findLine(c, o.line_id), '这一行'), old = has(x.line, 'em') ? clone(x.line.em) : null;
      if (o.em == null) delete x.line.em;
      else { if (!Array.isArray(o.em)) throw badOp('加粗的格式不对'); x.line.em = [...o.em]; }
      return out({ op: 'set_em', line_id: o.line_id, em: old });
    }
    case 'insert_line': {
      const { arr, where } = container(c, o), at = afterIndex(arr, o.after ?? null);
      let line;
      if (o.line) { if (findLine(c, o.line.id)) throw badOp('这一行已经在了'); line = clone(o.line); }
      else {
        const sib = arr[at - 1] || arr[at];
        line = newLine(ids, o.text, o.bullet ?? (where.part === 'lines' ? !!sib?.bullet : false));
      }
      arr.splice(at, 0, line);
      return out({ op: 'delete_line', line_id: line.id }, { op: 'insert_line', ...where, after: o.after ?? null, line: clone(line) });
    }
    case 'delete_line': {
      const x = need(findLine(c, o.line_id), '这一行');
      if (x.title) throw badOp('栏目标题要用「改节标题」');
      const after = prevId(x.arr, x.i);
      x.arr.splice(x.i, 1);
      return out({ op: 'insert_line', ...x.where, after, line: clone(x.line) });
    }
    case 'move_line': {
      const x = need(findLine(c, o.line_id), '这一行');
      if (x.title) throw badOp('栏目标题不能挪');
      if (o.after === o.line_id) throw badOp('不能接在自己后面');
      if (x.where.header && o.entry_id) throw badOp('抬头的行不能挪进经历');
      const back = { op: 'move_line', line_id: o.line_id, after: prevId(x.arr, x.i), ...(x.where.header ? {} : { entry_id: x.where.entry_id, part: x.where.part }) };
      x.arr.splice(x.i, 1);
      const to = o.entry_id ? container(c, { entry_id: o.entry_id, part: o.part }).arr : x.arr;
      to.splice(afterIndex(to, o.after ?? null), 0, x.line);
      return out(back);
    }
    case 'add_entry': {
      const { section } = need(findSection(c, o.section_id), '这一节'), at = afterIndex(section.entries, o.after ?? null);
      let entry;
      if (o.entry) { if (findEntryAt(c, o.entry.id)) throw badOp('这一段已经在了'); entry = clone(o.entry); }
      else {
        const head = Array.isArray(o.head) ? o.head.slice(0, 4) : [];
        entry = { id: `E${ids.entry++}`, head: head.map(t => newLine(ids, t, false)), lines: [] };
      }
      section.entries.splice(at, 0, entry);
      return out({ op: 'delete_entry', entry_id: entry.id }, { op: 'add_entry', section_id: o.section_id, after: o.after ?? null, entry: clone(entry) });
    }
    case 'delete_entry': {
      const x = need(findEntryAt(c, o.entry_id), '这一段');
      x.section.entries.splice(x.i, 1);
      return out({ op: 'add_entry', section_id: x.section.id, after: prevId(x.section.entries, x.i), entry: clone(x.entry) });
    }
    case 'move_entry': {
      const x = need(findEntryAt(c, o.entry_id), '这一段');
      if (o.after === o.entry_id) throw badOp('不能接在自己后面');
      const back = { op: 'move_entry', entry_id: o.entry_id, after: prevId(x.section.entries, x.i), section_id: x.section.id };
      const to = o.section_id ? need(findSection(c, o.section_id), '这一节').section : x.section;
      x.section.entries.splice(x.i, 1);
      to.entries.splice(afterIndex(to.entries, o.after ?? null), 0, x.entry);
      return out(back);
    }
    case 'set_entry_head': {
      const { entry } = need(findEntryAt(c, o.entry_id), '这一段'), i = Number(o.index);
      if (!Number.isInteger(i) || i < 0 || i > entry.head.length) throw badOp('这一段的抬头没有这一行');
      // 按位置改的：执行时换成具体的行（记下的操作和反向操作都用行编号，前面的行删了也不会错位）。
      if (typeof o.text !== 'string') throw badOp('缺少文字');
      if (i < entry.head.length) { const line = entry.head[i], old = line.text; line.text = o.text; return out({ op: 'set_text', line_id: line.id, text: old }, { op: 'set_text', line_id: line.id, text: line.text }); }
      const line = newLine(ids, o.text, false), after = entry.head.at(-1)?.id || null;
      entry.head.push(line);
      return out({ op: 'delete_line', line_id: line.id }, { op: 'insert_line', entry_id: o.entry_id, part: 'head', after, line: clone(line) });
    }
    case 'add_section': {
      const at = afterIndex(c.sections, o.after ?? null);
      let section;
      if (o.section) { if (findSection(c, o.section.id)) throw badOp('这一节已经在了'); section = clone(o.section); }
      else {
        const kind = KINDS.includes(o.kind) ? o.kind : 'other', t = name(o.title, 60);
        section = { id: `S${ids.section++}`, kind, title: t ? newLine(ids, t, false) : null, entries: ENTRY_KINDS.has(kind) ? [] : [{ id: `E${ids.entry++}`, head: [], lines: [] }] };
      }
      c.sections.splice(at, 0, section);
      return out({ op: 'delete_section', section_id: section.id }, { op: 'add_section', after: o.after ?? null, section: clone(section) });
    }
    case 'delete_section': {
      const x = need(findSection(c, o.section_id), '这一节');
      c.sections.splice(x.i, 1);
      return out({ op: 'add_section', after: prevId(c.sections, x.i), section: clone(x.section) });
    }
    case 'set_section_title': {
      const { section } = need(findSection(c, o.section_id), '这一节'), old = section.title ? clone(section.title) : null;
      let resolved = o;
      if (o.line) section.title = clone(o.line);
      else if (o.title == null || o.title === '') section.title = null;
      else if (section.title) section.title.text = String(o.title);
      else { section.title = newLine(ids, o.title, false); resolved = { op: 'set_section_title', section_id: o.section_id, line: clone(section.title) }; }
      return out(old ? { op: 'set_section_title', section_id: o.section_id, line: old } : { op: 'set_section_title', section_id: o.section_id, title: null }, resolved);
    }
    case 'set_header': {
      const i = Number(o.index);
      if (!Number.isInteger(i) || i < 0 || i > c.header.length) throw badOp('抬头没有这一行');
      if (typeof o.text !== 'string') throw badOp('缺少文字');
      if (i < c.header.length) { const line = c.header[i], old = line.text; line.text = o.text; return out({ op: 'set_text', line_id: line.id, text: old }, { op: 'set_text', line_id: line.id, text: line.text }); }
      const line = newLine(ids, o.text, false), after = c.header.at(-1)?.id || null;
      c.header.push(line);
      return out({ op: 'delete_line', line_id: line.id }, { op: 'insert_line', header: true, after, line: clone(line) });
    }
    default: throw badOp('不认识的编辑');
  }
}

// ── 一版 ─────────────────────────────────────────────────────────────────────
const versionOf = (doc, vid) => { const v = doc.versions.find(x => x.id === vid); if (!v) throw fail(404, '没有这一版'); return v; };
// 这一版和上传的原件一字不差（内容指纹）：投递用原件，不拿模板重排。
const isOriginal = (doc, v) => contentFp(v.content) === contentFp(originalContent(doc));
// rev 是每一版自己的内容版本号：只有改内容（改、撤销、重做、回到某一刻）才加一；导出、设默认、另存、改名都不动它。
const vrev = v => Number(v.rev) || 0;
function fresh(docId, vid, rev) {
  const doc = loadDoc(docId), v = versionOf(doc, vid);
  if (rev == null || rev === '' || Number(rev) !== vrev(v)) throw fail(409, STALE_MESSAGE, 'STALE');
  return { doc, v };
}
const bump = v => { v.rev = vrev(v) + 1; };
// 这一版、这份文档里所有的内容（版本 + Writer 的新版）：新编号要比它们都大。
const allContents = doc => [...doc.versions.map(v => v.content), ...(doc.proposals || []).map(p => p.content).filter(Boolean)];
const seqOf = ids => ({ line: ids.line - 1, entry: ids.entry - 1, section: ids.section - 1 });
function runOps(content, ops, ids) {
  let c = content;
  const inverse = [], resolved = [];
  for (const op of ops) { const r = applyOp(c, op, ids); c = r.content; inverse.unshift(r.inverse); resolved.push(r.op); }
  return { content: c, inverse, ops: resolved };
}
// 某一步碰过哪些东西：改的、加的、删的、挪的行 / 段 / 节，它们所在的容器（段、节、抬头），和接在谁后面的锚点。
// 按某一步撤销时，和它之后的改动有交集就拒绝；没交集还要在副本上重放一遍，重放不通也拒绝。
function touched(ops) {
  const out = new Set(), add = id => { if (typeof id === 'string' && id) out.add(id); };
  const walkObj = x => { if (!x || typeof x !== 'object') return; add(x.id); for (const v of Object.values(x)) if (v && typeof v === 'object') walkObj(v); };
  for (const o of ops) {
    for (const k of ['line_id', 'entry_id', 'section_id', 'after']) add(o[k]);
    if (o.header) out.add('header');
    for (const k of ['line', 'entry', 'section']) walkObj(o[k]);
  }
  return out;
}
const touchedBy = ch => new Set([...touched(ch.ops), ...touched(ch.inverse)]);
const staleExports = (doc, vid) => { for (const x of doc.exports || []) if (x.version === vid) x.stale = true; };

// 你自己改的字：照样核对一遍（依据只有上传的原件、facts.yaml、你的回答和你写过的字），不拦，提示随结果带回。
// 什么算「你写的字」见 rebuildEvidence。before：改之前的内容（没改动的那几行不核对）。
// → 提示（最多 4 句），lines 记下哪几行有提示（对话里 Writer 那一句提醒用，lib/resume-talk.mjs yourTextNote）。
function userWarnings(doc, vid, content, ops, before) {
  const idx = lineIndex(content), was = lineIndex(before), warn = [], lines = [];
  let facts = {};
  try { facts = readFacts() || {}; } catch (e) { noteSwallowed('resume.readFacts', e, { member: 'tailor', doing: '读你的资料（核对出处用）', then: '这次只按原简历核对' }); }
  const ids = new Set();
  for (const o of ops) {
    if (o.op === 'set_text') { if (was.get(o.line_id)?.line.text !== o.text) ids.add(o.line_id); }
    else if (['insert_line', 'set_entry_head', 'set_header'].includes(o.op) && o.line) ids.add(o.line.id);
    else if (o.op === 'set_entry_head' || o.op === 'set_header') { const x = o.op === 'set_header' ? content.header[o.index] : [...walk(content)].find(y => y.entry?.id === o.entry_id && y.role === 'head' && y.entry.head.indexOf(y.line) === o.index)?.line; if (x) ids.add(x.id); }
  }
  for (const id of ids) {
    const problems = lineCheck(doc, vid, content, id, facts);
    if (problems.length) lines.push(id);
    for (const p of problems) if (warn.length < 4 && !warn.includes(p.message)) warn.push(p.message);
  }
  return { warn, lines };
}
// 一行你写的字（正文条目）核对一遍：依据是上传的原件、facts.yaml、你的回答、你在别的行写过的字（这一行自己写的不算）。
function lineCheck(doc, vid, content, id, facts) {
  const x = lineIndex(content).get(id), t = String(x?.line.text || '').trim(), original = originalContent(doc);
  if (!x || !t || x.role !== 'line') return [];
  const orig = lineIndex(original).get(id);
  const pools = poolsFor(orig ? { lineId: id } : { entryId: x.entry?.id }, { original, facts, answers: doc.answers || [], userTexts: (doc.user_texts || []).filter(u => !(u.line_id === id && u.version === vid)), current: content });
  // 只说你加上去的字（审查 F6m-1）：删掉的数字、去掉的谦辞（dropped_number / hedge）是 Writer 改写时守的规矩，你自己删是你的事，不提醒。
  return verifyLine({ after: t, original: orig?.role === 'line' ? orig.line.text : null, local: pools.local, global: pools.global }).problems.filter(p => !REMOVED.has(p.kind));
}
const REMOVED = new Set(['dropped_number', 'hedge']);
// 现在这一行有哪些找不到出处的说法（对话里的提醒说之前再看一眼）。→ { text, problems }
export function lineProblems(docId, vid, id) {
  const doc = loadDoc(docId), v = versionOf(doc, vid);
  let facts = {};
  try { facts = readFacts() || {}; } catch (e) { noteSwallowed('resume.readFacts', e, { member: 'tailor', doing: '读你的资料（核对出处用）', then: '这次只按原简历核对' }); }
  return { text: lineIndex(v.content).get(id)?.line.text ?? null, problems: lineCheck(doc, vid, v.content, id, facts) };
}
// 你写的字（出处核对的证据，doc.user_texts）：从这一版的历史里重新算，改、撤销、重做、回到某一刻以后都算一遍。
// 你每一步新打的字——和这一行改之前比多出来的那几段——记下来；之后不管谁改这一行，还在这一行里的留着，不在了就不算。
// Writer 写的字不算（你只改了其中一个词，别的字还是 Writer 的），没改动的保存什么都不记。每一行一条，几段之间用「 … 」隔开。
const TOKEN = /\d+(?:[.,]\d+)*%?|[A-Za-z][A-Za-z0-9+#'’]*(?:[.\-/&][A-Za-z0-9+#]+)*|[\u3400-\u9fff]|\S/g;
const WORDY = /[\p{L}\p{N}]/u;
export function insertedSpans(before, after) {
  const a = [...String(before ?? '').matchAll(TOKEN)].map(m => m[0]), bm = [...String(after ?? '').matchAll(TOKEN)], b = bm.map(m => m[0]);
  if (!a.length) return String(after ?? '').trim() && WORDY.test(after) ? [String(after).trim()] : [];
  if (a.length * b.length > 400000) return [String(after).trim()];
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const kept = new Array(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) { if (a[i] === b[j]) { kept[j] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  const out = [];
  for (let j = 0; j < m; j++) {
    if (kept[j]) continue;
    let k = j; while (k + 1 < m && !kept[k + 1]) k++;
    const t = String(after).slice(bm[j].index, bm[k].index + b[k].length).trim();
    if (WORDY.test(t)) out.push(t);
    j = k;
  }
  return out;
}
const alnum = c => /[A-Za-z0-9]/.test(c || '');
export const stillIn = (span, t) => { for (let at = t.indexOf(span); at >= 0; at = t.indexOf(span, at + 1)) if (!(alnum(t[at - 1]) && alnum(span[0])) && !(alnum(t[at + span.length]) && alnum(span.at(-1)))) return true; return false; };
function rebuildEvidence(doc, v) {
  const spans = new Map(), text = new Map(), when = new Map();
  for (const ch of v.history || []) {
    const put = (id, before, after) => {
      const keep = (spans.get(id) || []).filter(x => stillIn(x, after)), add = ch.by === 'you' ? insertedSpans(before, after).filter(x => !keep.includes(x)) : [];
      spans.set(id, [...keep, ...add]); text.set(id, after); if (add.length) when.set(id, ch.at);
    };
    ch.ops.forEach((o, j) => {
      const inv = (ch.inverse || [])[ch.ops.length - 1 - j];
      if (o.op === 'set_text') put(o.line_id, text.has(o.line_id) ? text.get(o.line_id) : inv?.op === 'set_text' ? inv.text : '', o.text);
      else if (o.op === 'insert_line' && o.line) put(o.line.id, '', o.line.text);
      else if (o.op === 'add_entry' && o.entry) for (const l of [...(o.entry.head || []), ...(o.entry.lines || [])]) put(l.id, '', l.text);
      else if (o.op === 'delete_line') { spans.delete(o.line_id); text.delete(o.line_id); }
    });
  }
  const idx = lineIndex(v.content), mine = [];
  for (const [id, xs] of spans) { const x = idx.get(id); if (x && xs.length) mine.push({ line_id: id, entry_id: x.entry?.id || null, text: xs.join(' … '), at: when.get(id) || null, version: v.id }); }
  // 草稿从别的版本带来的（inherited）：那一行还在、这份历史里没再算过它，就留着。
  const kept = (doc.user_texts || []).filter(u => u.version === v.id && u.inherited && idx.has(u.line_id) && !spans.has(u.line_id));
  doc.user_texts = [...(doc.user_texts || []).filter(u => u.version !== v.id), ...kept, ...mine];
}

// 改一版：ops 一步出错整次不写；rev 对不上抛 STALE。
export function applyOps(docId, vid, ops, { by = 'you', rev, now = Date.now() } = {}) {
  const { doc, v } = fresh(docId, vid, rev);
  if (!Array.isArray(ops) || !ops.length || ops.length > 200) throw badOp('没有要改的，或者一次改得太多');
  ops = ops.map(validateOp);
  const ids = counters(allContents(doc), doc.seq);
  const r = runOps(v.content, ops, ids);
  if (JSON.stringify(r.content) === JSON.stringify(v.content)) return { change_id: null, vid, rev: vrev(v), unchanged: true };
  doc.seq = seqOf(ids);
  doc.change_seq = (Number(doc.change_seq) || 0) + 1;
  const change = { id: `c${doc.change_seq}`, at: iso(now), by: by === 'writer' ? 'writer' : 'you', ops: r.ops, inverse: r.inverse, rev: vrev(v) + 1 };
  const before = v.content;
  v.content = r.content;
  bump(v);
  v.history = [...(v.history || []), change];
  v.redo = [];
  staleExports(doc, vid);
  const { warn, lines: warn_lines } = change.by === 'you' ? userWarnings(doc, vid, r.content, r.ops, before) : { warn: [], lines: [] };
  rebuildEvidence(doc, v);
  saveDoc(doc);
  followDefault(doc, v);
  return { change_id: change.id, vid, rev: vrev(v), ...(warn.length ? { warn, warn_lines } : {}) };
}
// 撤销：不给 change_id 撤最后一步（能重做）；给了就撤那一步。撤中间某一步：它之后的改动碰过同样的行、段、容器或锚点就拒绝；
// 否则在副本上重放——先从新到旧撤掉后面的改动，再撤这一步，最后把后面的改动按原样重做一遍（反向操作跟着重算）。
// 任何一步对不上都算冲突，什么都不写。撤中间某一步以后，重做清空（它们是在另一段历史上做的）。
const conflict = () => fail(422, '这几行在那一步之后又改过，撤销会冲掉后来的字，所以没有撤', 'CONFLICT');
export function undo(docId, vid, { change_id = null, rev } = {}) {
  const { doc, v } = fresh(docId, vid, rev), hist = v.history || [];
  if (!hist.length) throw fail(422, '这一版没有可以撤销的改动', 'NOTHING_TO_UNDO');
  const i = change_id ? hist.findIndex(h => h.id === change_id) : hist.length - 1;
  if (i < 0) throw fail(404, '这一步已经不在历史里了（可能已经撤销过）');
  const ch = hist[i], later = hist.slice(i + 1), ids = counters(allContents(doc), doc.seq);
  if (later.length) { const mine = touchedBy(ch); if (later.some(h => [...touchedBy(h)].some(id => mine.has(id)))) throw conflict(); }
  let c = v.content, replayed = [];
  try {
    for (const h of [...later].reverse()) c = runOps(c, h.inverse, ids).content;
    c = runOps(c, ch.inverse, ids).content;
    for (const h of later) { const r = runOps(c, h.ops, ids); c = r.content; replayed.push({ ...h, ops: r.ops, inverse: r.inverse }); }
  } catch (e) { if (e.code === 'BAD_OP') throw later.length ? conflict() : fail(422, '这一步撤不回了：内容和记录对不上', 'CONFLICT'); throw e; }
  v.content = c;
  bump(v);
  v.history = [...hist.slice(0, i), ...replayed];
  v.redo = later.length ? [] : [...(v.redo || []), ch];
  rebuildEvidence(doc, v);
  staleExports(doc, vid);
  saveDoc(doc);
  followDefault(doc, v);
  return { change_id: ch.id, vid, rev: vrev(v) };
}
export function redo(docId, vid, { rev } = {}) {
  const { doc, v } = fresh(docId, vid, rev), ch = (v.redo || []).at(-1);
  if (!ch) throw fail(422, '没有可以重做的改动', 'NOTHING_TO_REDO');
  const r = runOps(v.content, ch.ops, counters(allContents(doc), doc.seq));
  v.content = r.content;
  bump(v);
  v.redo = v.redo.slice(0, -1);
  v.history = [...(v.history || []), ch];
  rebuildEvidence(doc, v);
  staleExports(doc, vid);
  saveDoc(doc);
  followDefault(doc, v);
  return { change_id: ch.id, vid, rev: vrev(v) };
}
// 回到历史里的某一刻：那一步之后的改动一步步撤掉（都能重做）；change_id 为空就回到这一版刚建好的样子。
export function rewind(docId, vid, { change_id = null, rev } = {}) {
  const { doc, v } = fresh(docId, vid, rev), hist = v.history || [];
  const keep = change_id ? hist.findIndex(h => h.id === change_id) + 1 : 0;
  if (change_id && keep === 0) throw fail(404, '这一步已经不在历史里了');
  if (keep >= hist.length) return { vid, rev: vrev(v), undone: 0 };
  const ids = counters(allContents(doc), doc.seq);
  hist.slice(keep).reverse().forEach(ch => { v.content = runOps(v.content, ch.inverse, ids).content; v.redo = [...(v.redo || []), ch]; });
  bump(v);
  v.history = hist.slice(0, keep);
  rebuildEvidence(doc, v);
  staleExports(doc, vid);
  saveDoc(doc);
  followDefault(doc, v);
  return { vid, rev: vrev(v), undone: hist.length - keep };
}

// ── 草稿（负责人 10-03）：改动先进草稿，存了才算一版 ───────────────────────────────────────
// 打开 vid 去改：已经有它的草稿就用那份；vid 本身就是草稿也原样返回；都没有就从 vid 复制一份（rev 0）。→ 草稿的 id
export function openDraft(docId, vid, { now = Date.now() } = {}) {
  const doc = loadDoc(docId), v = versionOf(doc, vid);
  if (v.draft) return v.id;
  const had = draftFor(doc, vid);
  if (had) return had.id;
  const k = Math.max(0, ...doc.versions.filter(x => x.draft).map(x => Number(String(x.id).slice(1)) || 0)) + 1;
  doc.versions.push({ id: `d${k}`, n: null, name: '', by: 'you', base: vid, draft: true, lead_ids: [], created_at: iso(now), content: clone(v.content), history: [], redo: [], default_for: null, rev: 0 });
  // 你在这一版里亲手写过的字（出处核对的证据、Writer 不碰的行）跟着进草稿：inherited，草稿自己的历史重算时留着。
  doc.user_texts = [...(doc.user_texts || []), ...(doc.user_texts || []).filter(u => u.version === vid).map(u => ({ ...u, version: `d${k}`, inherited: true }))];
  saveDoc(doc);
  return `d${k}`;
}
const draftOf = (doc, id) => { const d = doc.versions.find(x => x.id === id && x.draft); if (!d) throw fail(404, '这份修改已经不在了，刷新看一眼', 'NO_DRAFT'); return d; };
// 草稿改了名（存成了 vN）或者没了：指着它的（你写的字、Writer 从它出发的改一版、从它改出来的版本）跟着换。
const renameRefs = (doc, from, to) => {
  doc.user_texts = (doc.user_texts || []).map(u => u.version === from ? { ...u, version: to, inherited: undefined } : u);
  for (const p of doc.proposals || []) if (p.base_version === from) p.base_version = to;
  for (const v of doc.versions) if (v.base === from && v.id !== to) v.base = to;
};
// 存为新的一版：这份的历史里加 vN+1（你自己改的 · 基于 vN · 改了 N 处），成为「现在用」；这份是默认投递的，投递也从这一版起用它。
export async function saveDraft(docId, draftId, { now = Date.now(), exporter = null } = {}) {
  const doc = loadDoc(docId), d = draftOf(doc, draftId);
  if (!d.history?.length) throw fail(422, '还没有改动，不用存', 'NO_CHANGES');
  const n = Math.max(0, ...doc.versions.filter(x => !x.draft).map(x => x.n || 0)) + 1, id = `v${n}`;
  Object.assign(d, { id, n, by: d.history.some(h => h.by === 'you') ? 'you' : 'writer', created_at: iso(now), edits: d.history.length, history: [], redo: [], rev: 0 });
  delete d.draft;
  renameRefs(doc, draftId, id);
  doc.current = id;
  saveDoc(doc);
  const lang = doc.versions.find(x => x.default_for)?.default_for;
  if (lang) await setDefault(docId, id, lang, { now, exporter });
  return { vid: id, base: d.base, edits: d.edits };
}
// 另存为新简历：新建一份，它的 v1 写「从『某某简历 vN』改出来」，带 copied_from；原来那份不动，这份草稿收起。
export function draftToNewDoc(docId, draftId, { title = '', now = Date.now() } = {}) {
  const src = loadDoc(docId), d = draftOf(src, draftId);
  if (!d.history?.length) throw fail(422, '还没有改动', 'NO_CHANGES');
  const ws = loadWorkspace(), k = versionNumbers(src).get(d.base);
  const id = `r${Math.max(0, ...ws.docs.map(x => Number(String(x.id).slice(1)) || 0)) + 1}`;
  const name = String(title || '').trim().slice(0, 40) || `${src.title}（改）`;
  const doc = {
    schema: src.schema, id, rev: 0, title: name, lang: src.lang, created_at: iso(now), source: { ...(src.source || {}) }, text: src.text || '',
    versions: [{ id: 'v1', n: 1, name: `从「${src.title} v${k}」改出来`, by: 'copy', base: null, lead_ids: [], created_at: iso(now), content: d.content, history: [], redo: [], default_for: null, rev: 0, edits: d.history.length }],
    proposals: [], answers: JSON.parse(JSON.stringify(src.answers || [])),
    user_texts: (src.user_texts || []).filter(u => u.version === draftId).map(u => ({ ...u, version: 'v1' })), exports: [],
    original: JSON.parse(JSON.stringify(src.original || { content: d.content, file: null, sha256: null, at: iso(now) })),
    copied_from: { doc: src.id, version: d.base, n: k, title: src.title, at: iso(now), edited: true },
  };
  saveDoc(doc);
  ws.docs.push({ id, title: doc.title, lang: doc.lang, created_at: doc.created_at });
  ws.active = id;
  saveWorkspace(ws);
  dropDraft(src, draftId);
  saveDoc(src);
  return { id, vid: 'v1' };
}
const dropDraft = (doc, draftId) => {
  const d = doc.versions.find(x => x.id === draftId);
  doc.versions = doc.versions.filter(x => x.id !== draftId);
  doc.user_texts = (doc.user_texts || []).filter(u => u.version !== draftId);
  for (const p of doc.proposals || []) if (p.base_version === draftId) p.base_version = d?.base || p.base_version;
  for (const v of doc.versions) if (v.base === draftId) v.base = d?.base || null;
};
// 不要这些修改：草稿丢掉，回到原来那一版。→ { vid: 原来那一版 }
export function discardDraft(docId, draftId) {
  const doc = loadDoc(docId), d = doc.versions.find(x => x.id === draftId && x.draft);
  if (!d) return { vid: draftId };
  dropDraft(doc, draftId);
  saveDoc(doc);
  return { vid: d.base };
}

// ── 新版本、改名 ───────────────────────────────────────────────────────────────
const BY = ['you', 'writer', 'copy', 'tailor'];
export function copyVersion(docId, vid, { name: n = '', by = 'copy', lead_ids = [], now = Date.now() } = {}) {
  const doc = loadDoc(docId), v = versionOf(doc, vid);
  const next = Math.max(...doc.versions.map(x => x.n)) + 1, id = `v${next}`;
  doc.versions.push({ id, n: next, name: name(n) || `基于 ${vid}`, by: BY.includes(by) ? by : 'copy', base: vid, lead_ids: [...lead_ids].map(String), created_at: iso(now), content: clone(v.content), history: [], redo: [], default_for: null, rev: 0 });
  saveDoc(doc);
  return id;
}
// 每一版都能改（10-02 起 v1 也能）：原样返回。留着给旧的调用方。
export function ensureWritable(docId, vid) {
  versionOf(loadDoc(docId), vid);
  return vid;
}
export function renameVersion(docId, vid, n) {
  const doc = loadDoc(docId), v = versionOf(doc, vid), t = name(n);
  if (!t) throw fail(400, '名字是空的');
  v.name = t;
  saveDoc(doc);
  return { vid, name: t, rev: vrev(v) };
}

// ── 导出 ─────────────────────────────────────────────────────────────────────
// 招聘方看到的是文件名：<English-Name>-Resume.pdf / <中文名>-简历.pdf（和「开始使用」导入的一样）。
function exportName(doc, content, format) {
  let id = {};
  try { id = readFacts()?.identity || {}; } catch (e) { noteSwallowed('resume.exportName', e, { member: 'tailor', doing: '读你的名字（导出文件名用）', then: '文件名按简历抬头起' }); }
  const headName = content.header?.[0]?.text || '';
  const n = readableResumeName(doc.lang === 'zh' ? 'chinese_pdf' : 'english_pdf', { name_zh: id.name_zh || (doc.lang === 'zh' ? headName : ''), name_en: id.name_en || (doc.lang === 'zh' ? '' : headName) }) || (doc.lang === 'zh' ? '简历.pdf' : 'Resume.pdf');
  return n.replace(/\.pdf$/, `.${format}`);
}
const sha = abs => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
// 导出一版（PDF / Word），导完自己读一遍（招聘方的系统能不能读出每一行）；导出记录带上内容指纹。
// actor：谁导的（运行日志里记在谁名下）。你在材料页点的是 'user'；投递前现导（preparePick）记在 Reacher（quill）名下。
export async function exportVersion(docId, vid, format, { now = Date.now(), exporter = null, keepForeign = false, actor = 'user' } = {}) {
  const doc = loadDoc(docId), v = versionOf(doc, vid);
  if (!['pdf', 'docx'].includes(format)) throw fail(400, '只能导出 PDF 或 Word');
  // 这一版和上传的原件一字不差：PDF 就是原件，不拿我们的模板重排一份。
  const own = format === 'pdf' && isOriginal(doc, v) ? uploadPdf(doc, v) : null;
  if (own) return own;
  const rel = `${DIR}/${doc.id}/${vid}/${exportName(doc, v.content, format)}`, title = v.content.header?.[0]?.text || doc.title;
  // 投递前现导（preparePick）：那个位置上的文件字节对不上这一版的导出记录（不是系统导的，或者被换过），不覆盖它。
  if (keepForeign && foreignAt(doc, vid, rel)) throw Object.assign(fail(409, NOT_OURS), { code: 'NOT_OURS' });
  const run = exporter || (format === 'pdf' ? exportPdf : exportDocx);
  const res = await run(v.content, file(rel), { title });
  let check;
  try { const back = await readBack(file(rel)); check = coverage(v.content, back.text); } catch (e) { check = { ok: false, error: String(e.message).slice(0, 160) }; }
  const rec = { version: vid, format, file: rel, bytes: res.bytes, sha256: sha(file(rel)), at: iso(now), check, content_fp: contentFp(v.content) };
  const latest = loadDoc(docId);
  latest.exports = [...(latest.exports || []).filter(x => !(x.version === vid && x.format === format && x.from !== 'upload')), rec];
  saveDoc(latest);
  event(actor, 'resume', 'ok', `材料：导出 ${versionLabel(doc, v, { lang: true })} 的 ${format === 'pdf' ? 'PDF' : 'Word'}（${Math.max(1, Math.round(res.bytes / 1024))} KB${check?.ok ? '，自检读得出每一行' : check?.missing?.length ? `，自检有 ${check.missing.length} 行读不出` : ''}）`, { refs: [{ file: rel }] });
  return rec;
}
// 这一版现成的 PDF：文件还在、字节和导出时一样（sha256 对得上）、这一版之后没改过（指纹对得上；旧的导出没有指纹，改过会被标 stale）。
const sameBytes = x => { try { return !!x.sha256 && sha(file(x.file)) === x.sha256; } catch { return false; } }; // 兜底：文件不在或读不出就是不一样
// 上传的原件（引导里导入的那份 PDF，from:'upload'）：和原件一字不差的那一版，投递文件就是它。
const uploadPdf = (doc, v) => (doc.exports || []).find(x => x.version === v.id && x.format === 'pdf' && x.from === 'upload' && sameBytes(x)) || null;
const hadUpload = (doc, v) => (doc.exports || []).some(x => x.version === v.id && x.format === 'pdf' && x.from === 'upload');
const isUploadFile = rel => !!rel && (/^candidate\/resume\/r\d+\/original\//.test(rel) || loadWorkspace().docs.some(d => { try { return (loadDoc(d.id).exports || []).some(x => x.from === 'upload' && x.file === rel); } catch { return false; } })); // 兜底：读不出来的那份不算上传的原件
// rel 上有一个文件，但它不是这一版导出的（没有导出记录，或者字节和记录对不上）：系统不覆盖它。
const foreignAt = (doc, vid, rel) => fs.existsSync(file(rel)) && !(doc.exports || []).some(x => x.version === vid && x.file === rel && sameBytes(x));
const NOT_OURS = '那个位置上的文件不是系统导出的（或者被换过），没有覆盖它';
const usablePdf = (doc, v) => (doc.exports || []).find(x => x.version === v.id && x.format === 'pdf' && exportCurrent(x, contentFp(v.content)) && sameBytes(x));

// ── 默认投递 ─────────────────────────────────────────────────────────────────
// 设默认投递：先导出 PDF → 再改 resume_routing 那一栏和 candidate/resume.tex（lib/profile.mjs 写入，旧文件先备份）→ 最后标 default_for。
// 同一种语言整个工作区只留一版；一版只能是一种语言的默认投递。任何一步失败都整体回到原样：facts.yaml、resume.tex 按字节还原
// （原来没有的 resume.tex 删掉），被清掉的其他版本的默认投递也恢复；回滚本身失败就照实说。save / mark / restoreFile 只给测试换。
const LANG_WORD = { zh: '中文', en: '英文' };
const TEX = 'candidate/resume.tex';
const bytesOf = rel => { try { return fs.statSync(file(rel)).isFile() ? fs.readFileSync(file(rel)) : null; } catch { return null; } }; // 兜底：文件不在就是没有
export function writeBack(rel, bytes) {
  if (bytes == null) { fs.rmSync(file(rel), { force: true }); return; }
  const tmp = `${file(rel)}.restore-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file(rel));
}
const snapshotDefaults = () => loadWorkspace().docs.map(d => { try { const doc = loadDoc(d.id); return { id: doc.id, map: Object.fromEntries(doc.versions.map(v => [v.id, v.default_for || null])) }; } catch { return null; } }).filter(Boolean); // 兜底：读不出来的那份不在快照里，也就不会去改它
function restoreDefaults(snap) {
  for (const { id, map } of snap) {
    const doc = loadDoc(id);
    let changed = false;
    for (const v of doc.versions) if (Object.hasOwn(map, v.id) && (v.default_for || null) !== map[v.id]) { v.default_for = map[v.id]; changed = true; }
    if (changed) saveDoc(doc);
  }
}
export const oneLanguage = (v, lang) => { if (v.default_for && v.default_for !== lang) throw fail(422, `${v.id} 已经是${LANG_WORD[v.default_for]}默认投递；一版只能给一种语言用。要用在${LANG_WORD[lang]}岗位，先另存为新版本再设。`); };
export async function setDefault(docId, vid, lang, { now = Date.now(), exporter = null, save = saveProfile, mark = markDefault, restoreFile = writeBack } = {}) {
  if (!['zh', 'en'].includes(lang)) throw fail(400, '默认投递只分中文、英文');
  let doc = loadDoc(docId), v = versionOf(doc, vid);
  oneLanguage(v, lang);
  let rec = usablePdf(doc, v);
  if (!rec) {
    try { rec = await exportVersion(docId, vid, 'pdf', { now, exporter }); }
    catch (e) {
      const why = e.code === 'NO_BROWSER' ? '本机没有能导出 PDF 的浏览器（Chrome 或 Chromium）' : String(e.message).slice(0, 160);
      throw Object.assign(fail(424, `没设成默认投递：${why}。默认投递和投递用的简历文件都没变。`), { code: e.code || 'EXPORT_FAILED' });
    }
  }
  doc = loadDoc(docId); v = versionOf(doc, vid);
  const slot = lang === 'zh' ? 'chinese_pdf' : 'english_pdf', { sig, error } = profileFacts();
  if (error) throw fail(424, `没设成默认投递：${error}`);
  const facts0 = bytesOf(FACTS), tex0 = bytesOf(TEX), defaults0 = snapshotDefaults();
  let r;
  try {
    r = save({ base: sig, set: { [`resume_routing.${slot}`]: rec.file } }, { now, files: [{ rel: TEX, text: plainText(v.content) + '\n' }], source: `材料 · 默认投递改用 ${versionLabel(doc, v, { lang })}` });
    mark(docId, vid, lang);
  } catch (e) {
    const why = String(e.message).slice(0, 160), left = [];
    try { restoreFile(FACTS, facts0); } catch { left.push('facts.yaml 的 resume_routing'); }
    try { restoreFile(TEX, tex0); } catch { left.push('candidate/resume.tex'); }
    try { restoreDefaults(defaults0); } catch { left.push('「材料」里的默认投递标记'); }
    throw fail(e.status && e.status < 500 ? (e.status === 409 ? 422 : e.status) : 500, left.length ? `没设成默认投递：${why}。想改回原样，但没能改回：${left.join('、')}，请检查一下。` : `没设成默认投递：${why}。已经改回原样。`);
  }
  event('user', 'resume', 'ok', `材料：${LANG_WORD[lang]}默认投递改用 ${versionLabel(doc, v)}`, { refs: [{ file: rec.file }] });
  // 导出的时候这一版又改过（页面自动保存、Writer 改了一句）：投递文件是改之前的，导完再排一次刷新。
  try { const now2 = loadDoc(docId), v2 = versionOf(now2, vid); if (rec.content_fp && rec.content_fp !== contentFp(v2.content)) followDefault(now2, v2); } catch (e) { noteSwallowed('resume.followAfterDefault', e, { member: 'tailor', doing: '导出后又改过时排一次刷新', then: '投递前会再刷新一次' }); }
  return { status: 'default', doc: docId, version: vid, lang, file: rec.file, slot, backup: r?.backup || null, backups: r?.backups || [] };
}
// ── 默认投递那一版的 PDF 跟着内容走 ─────────────────────────────────────────────
// 你在默认投递的那一版上改了字：停手约 20 秒后在后台重新导出，先写临时文件再改名，原子地覆盖 resume_routing 指着的那个文件，
// 同时更新 candidate/resume.tex（这里不备份，备份只在设默认投递时做）。导不出（比如没有浏览器）就记下原因，页面显示
// default_pdf_stale；投递前可以调 refresh_default 同步刷新一次。refreshConfig 只给测试换导出器、改间隔。
export const refreshConfig = { delay: 20000, exporter: null, lockWait: 120000 };
const timers = new Map();
const routedFile = lang => { let r = null; try { r = profileFacts().data?.resume_routing?.[lang === 'zh' ? 'chinese_pdf' : 'english_pdf']; } catch (e) { noteSwallowed('resume.routedFile', e, { member: 'tailor', doing: '读设置里的投递文件', then: '当没有指定' }); } return typeof r === 'string' && /^candidate\/.+\.pdf$/i.test(r) && !r.split('/').includes('..') ? r : null; };
// 这一版（默认投递）现在投出去的文件是不是它现在的内容：导出记录对得上 resume_routing、内容指纹、文件字节。
export function defaultPdfState(doc, v) {
  if (!v?.default_for) return null;
  const target = routedFile(v.default_for), fp = contentFp(v.content);
  // 设置里没有投递文件，或者那个文件不在了（10-04）：投递用这一版现成的 PDF（和原件一字不差就是原件，lib/resume-choice.mjs pickResume）。
  // 有现成的就不算旧；不在了的那个文件名带回去，材料页说一句。
  if (!target || !fs.existsSync(file(target))) {
    const f = readyPdf(doc, v);
    return { stale: !f, reason: f ? null : v.pdf_stale?.reason || '投递用的文件还是改之前的内容', file: f, ...(target ? { routing_missing: target } : {}) };
  }
  // 投递文件是上传的原件，这一版后来改过（v1 能改了）：原件不覆盖，但 resume_routing 还指着原件——别处（邮件附件、表单、匹配）
  // 读的还是改之前的内容，要刷新：刷新时换成这一版自己现导的那份（refreshOnce）。
  const fresh = !!target && routedState(doc, v, target) !== 'edited' && (doc.exports || []).some(x => x.version === v.id && x.format === 'pdf' && x.file === target && exportCurrent(x, fp) && sameBytes(x));
  return { stale: !fresh, reason: fresh ? null : v.pdf_stale?.reason || (timers.has(`${doc.id}/${v.id}`) ? '正在按改过的内容重新导出' : '投递用的文件还是改之前的内容'), file: target };
}
// 投递文件换成同一版的另一份（上传的原件 ↔ 这一版现导的那份）：resume_routing 那一栏和 candidate/resume.tex 一起改（lib/profile.mjs，
// 旧文件先备份，和设默认投递一样）。改之前再看一眼：投递文件还是 from、这一版还是这种语言的默认投递、内容指纹还是 fp——有一样变了就不改
// （别处刚改过，下一次刷新再来），返回 false。
function pointRouting(docId, vid, { lang, from, to, fp, actor = 'patch', why }) {
  const doc = loadDoc(docId), v = versionOf(doc, vid);
  if (v.default_for !== lang || routedFile(lang) !== from || contentFp(v.content) !== fp) return false;
  const { sig, error } = profileFacts();
  if (error) throw fail(424, `投递文件没换成：${error}`);
  saveProfile({ base: sig, set: { [`resume_routing.${lang === 'zh' ? 'chinese_pdf' : 'english_pdf'}`]: to } }, { files: [{ rel: TEX, text: plainText(v.content) + '\n' }], source: `材料 · ${versionLabel(doc, v, { lang: true })}${why}` });
  if (v.pdf_stale) { const d = loadDoc(docId), x = versionOf(d, vid); delete x.pdf_stale; saveDoc(d); }
  event(actor, 'resume', 'ok', `材料：默认投递的 ${versionLabel(doc, v, { lang: true })}${why}`, { refs: [{ file: to }] });
  return true;
}
// 默认投递的那一版改回了和上传的原件一字不差：投递文件是系统给这一版导的那份（字节对得上）时，换回原件（不用导出，马上换）。
function backToOriginal(doc, v, actor = 'patch') {
  if (!v.default_for || !isOriginal(doc, v)) return false; // 先看内容（不读文件）：改字时每次保存都会走到这里
  const lang = v.default_for, routed = routedFile(lang);
  if (!routed) return false;
  const up = uploadPdf(doc, v);
  if (!up || up.file === routed || !['own', 'stale'].includes(routedState(doc, v, routed))) return false;
  return pointRouting(doc.id, v.id, { lang, from: routed, to: up.file, fp: contentFp(v.content), actor, why: ' 改回了原样，投递文件换回你上传的原件' });
}
function followDefault(doc, v) {
  if (!v.default_for) return;
  const key = `${doc.id}/${v.id}`;
  clearTimeout(timers.get(key));
  try { if (backToOriginal(doc, v)) { timers.delete(key); return; } } catch (e) { noteSwallowed('resume.backToOriginal', e, { member: 'tailor', doing: '看是不是改回了原件', then: '照常排一次重新导出' }); }
  const t = setTimeout(() => { timers.delete(key); refreshDefaultPdf(doc.id, v.id, { actor: 'patch' }).catch(() => {}); }, refreshConfig.delay); // 兜底：失败原因已经记在这一版的 pdf_stale 上，页面会照实显示
  t?.unref?.();
  timers.set(key, t);
}
// 同一版同一时刻只导一次：后来的等前面那次做完，再看还要不要导（多半已经是新的了）。
const refreshing = new Map();
export async function refreshDefaultPdf(docId, vid, opts = {}) {
  const key = `${docId}/${vid}`;
  while (refreshing.has(key)) { try { await refreshing.get(key); } catch {} } // 兜底：前面那次的结果归它自己的调用方；这里只等它做完
  // 另一个进程（后台刷新、投递流程）可能正在导同一份：拿到刷新锁再做；拿到时多半已经是新的，refreshOnce 里先看还要不要导。
  const job = (async () => {
    const release = await waitForLock('resumepdf', { timeout: refreshConfig.lockWait, interval: 200 });
    try { return await refreshOnce(docId, vid, opts); } finally { release(); }
  })();
  refreshing.set(key, job);
  try { return await job; } finally { if (refreshing.get(key) === job) refreshing.delete(key); }
}
async function refreshOnce(docId, vid, { now = Date.now(), exporter = null, actor = 'user' } = {}) {
  let doc = loadDoc(docId), v = versionOf(doc, vid);
  if (!v.default_for) return { status: 'not_default', doc: docId, vid };
  const st0 = defaultPdfState(doc, v);
  if (!st0.stale) return { status: 'fresh', doc: docId, vid, file: st0.file || routedFile(v.default_for) };
  const target = routedFile(v.default_for) || `${DIR}/${doc.id}/${vid}/${exportName(doc, v.content, 'pdf')}`;
  // 改回了原样：投递文件换回上传的原件。
  if (backToOriginal(doc, v, actor)) return { status: 'refreshed', doc: docId, vid, file: routedFile(v.default_for) };
  // 投递文件是这一版的原件、这一版后来改过：原件不动，按现在的内容导到这一版自己的目录（文件名规矩照旧），再把 resume_routing 和
  // resume.tex 换成它——邮件附件、表单、匹配读的都是 resume_routing，和 pickResume 是同一份。
  if (routedState(doc, v, target) === 'edited') {
    try {
      const have = (doc.exports || []).find(x => x.version === vid && x.format === 'pdf' && x.from !== 'upload' && x.file === readyPdf(doc, v));
      const rec = have || await exportVersion(docId, vid, 'pdf', { exporter: exporter || refreshConfig.exporter, now, keepForeign: true, actor });
      if (!pointRouting(docId, vid, { lang: v.default_for, from: target, to: rec.file, fp: rec.content_fp, actor, why: ' 改过了，投递文件换成按这一版现导的 PDF（上传的原件没动）' })) return { status: 'superseded', doc: docId, vid };
      return { status: 'refreshed', doc: docId, vid, file: rec.file };
    } catch (e) {
      const reason = e.code === 'NO_BROWSER' ? '本机没有能导出 PDF 的浏览器（Chrome 或 Chromium），投递用的文件还是改之前的内容' : `重新导出没成功：${String(e.message).slice(0, 160)}；投递用的文件还是改之前的内容`;
      try { doc = loadDoc(docId); v = versionOf(doc, vid); v.pdf_stale = { reason, at: iso(now) }; saveDoc(doc); } catch {} // 兜底：记不进这一版也照样把原因抛给调用方
      throw Object.assign(fail(424, reason), { code: e.code || 'EXPORT_FAILED' });
    }
  }
  // 投递用的还是上传的原件（比如旧数据里只改了标记、没改 resume_routing）：不拿这一版去覆盖你的原件。
  if (isUploadFile(target)) {
    const reason = '投递用的还是你上传的原件，没有用这一版的内容覆盖它；要投这一版，点「设为默认投递」';
    try { doc = loadDoc(docId); v = versionOf(doc, vid); v.pdf_stale = { reason, at: iso(now) }; saveDoc(doc); } catch {} // 兜底：记不进这一版也照样把原因抛给调用方
    throw Object.assign(fail(422, reason), { code: 'UPLOAD_KEPT' });
  }
  if (foreignAt(doc, vid, target)) {
    const reason = `投递用的${NOT_OURS}；要投这一版，点「设为默认投递」`;
    try { doc = loadDoc(docId); v = versionOf(doc, vid); v.pdf_stale = { reason, at: iso(now) }; saveDoc(doc); } catch {} // 兜底：记不进这一版也照样把原因抛给调用方
    throw Object.assign(fail(422, reason), { code: 'NOT_OURS' });
  }
  const lang = v.default_for, routed = routedFile(lang);
  const content = clone(v.content), fp = contentFp(content), tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}.pdf`;
  try {
    fs.mkdirSync(path.dirname(file(target)), { recursive: true });
    const res = await (exporter || refreshConfig.exporter || exportPdf)(content, file(tmp), { title: content.header?.[0]?.text || doc.title });
    // 导的时候别处可能已经把另一版设成默认投递（或者改了投递用的文件）：这次的结果不再写回，免得旧的一版盖掉新的。
    const again = loadDoc(docId).versions.find(x => x.id === vid);
    if (again?.default_for !== lang || routedFile(lang) !== routed) { fs.rmSync(file(tmp), { force: true }); return { status: 'superseded', doc: docId, vid }; }
    fs.renameSync(file(tmp), file(target));
    writeBack(TEX, Buffer.from(plainText(content) + '\n'));
    doc = loadDoc(docId); v = versionOf(doc, vid);
    doc.exports = [...(doc.exports || []).filter(x => !(x.version === vid && x.format === 'pdf' && x.from !== 'upload')), { version: vid, format: 'pdf', file: target, bytes: res?.bytes ?? fs.statSync(file(target)).size, sha256: sha(file(target)), at: iso(now), check: null, content_fp: fp }];
    delete v.pdf_stale;
    saveDoc(doc);
    event(actor, 'resume', 'ok', `材料：默认投递的 ${versionLabel(doc, v, { lang: true })} 改过了，投递用的 PDF 已按新内容重新导出`, { refs: [{ file: target }] });
    return { status: 'refreshed', doc: docId, vid, file: target };
  } catch (e) {
    fs.rmSync(file(tmp), { force: true });
    const reason = e.code === 'NO_BROWSER' ? '本机没有能导出 PDF 的浏览器（Chrome 或 Chromium），投递用的文件还是改之前的内容' : `重新导出没成功：${String(e.message).slice(0, 160)}；投递用的文件还是改之前的内容`;
    try { doc = loadDoc(docId); v = versionOf(doc, vid); v.pdf_stale = { reason, at: iso(now) }; saveDoc(doc); } catch {} // 兜底：记不进这一版也照样把原因抛给调用方
    throw Object.assign(fail(424, reason), { code: e.code || 'EXPORT_FAILED' });
  }
}
// 投递前：把某种语言的默认投递刷新成最新内容（没改过就不导）。
export async function refreshDefault({ lang = null, docId = null, vid = null } = {}, opts = {}) {
  let target = docId && vid ? { docId, vid } : null;
  if (!target && ['zh', 'en'].includes(lang)) {
    for (const d of loadWorkspace().docs) { try { const doc = loadDoc(d.id), v = doc.versions.find(x => x.default_for === lang); if (v) { target = { docId: doc.id, vid: v.id }; break; } } catch (e) { noteSwallowed('resume.loadDoc', e, { member: 'tailor', doing: `读简历 ${d.id}`, then: '跳过它找下一份' }); } }
  }
  if (!target) throw fail(404, '还没有这种语言的默认投递');
  // 手动刷新（投递前）：改字时排下、还没触发的那次不用再跑了。
  const key = `${target.docId}/${target.vid}`;
  clearTimeout(timers.get(key)); timers.delete(key);
  return refreshDefaultPdf(target.docId, target.vid, opts);
}

// 投递时默认用哪一版：这种语言的默认投递；没有就退到另一种语言的。
export function defaultVersion(lang) {
  const found = {};
  for (const d of loadWorkspace().docs) {
    let doc; try { doc = loadDoc(d.id); } catch { continue; }
    for (const v of doc.versions) if (v.default_for && !found[v.default_for]) found[v.default_for] = { docId: doc.id, vid: v.id };
  }
  return found[lang] || found[lang === 'zh' ? 'en' : 'zh'] || null;
}

// ── 投递前：这个岗位要用的那一版备好 PDF（设计说明 4.4；lib/auto-apply.mjs 填表之前调） ─────────────────
// 现成的（内容指纹和字节都对得上，v1 用上传的原件）直接用；默认投递的那一版走上面的刷新（还是 resume_routing 指着的那个文件），
// 但投递文件不是这一版导出的（比如你自己放的 PDF）就不拿这一版去覆盖它；别的版本现导一份（rN/vN/ 下，文件名照旧好认）。
// 导不出（没有浏览器）不拦投递：返回原因，投递照旧用 resume_routing（lib/application-form.mjs resumePick），原因记进终审记录。
export async function preparePick(lead, { exporter = null, now = Date.now() } = {}) {
  let pick = pickResume(lead);
  if (!pick || pick.file || !pick.vid) return { pick, reason: null };
  let reason = null;
  try {
    const doc = loadDoc(pick.docId), v = versionOf(doc, pick.vid);
    // 和上传的原件一字不差的那一版就是原件：原件不在了或被改过，不拿模板重排一份，照旧用设置里的投递文件。
    if (isOriginal(doc, v) && hadUpload(doc, v) && !uploadPdf(doc, v)) reason = '上传的原件不在了或被改过，没有拿模板重排一份';
    else if (v.default_for) {
      const routed = routedFile(v.default_for), st = routed ? routedState(doc, v, routed) : null;
      if (!routed || st !== 'other') await refreshDefaultPdf(pick.docId, pick.vid, { exporter, now, actor: 'quill' });
      else await exportVersion(pick.docId, pick.vid, 'pdf', { exporter, now, keepForeign: true, actor: 'quill' });
    } else await exportVersion(pick.docId, pick.vid, 'pdf', { exporter, now, keepForeign: true, actor: 'quill' });
  } catch (e) {
    reason = e.code === 'NO_BROWSER' ? '本机导不出 PDF' : e.code === 'NOT_OURS' ? NOT_OURS : `导出没成功：${String(e.message).slice(0, 160)}`;
  }
  pick = pickResume(lead);
  if (pick?.file) return { pick, reason: null };
  return { pick, reason: reason || '这一版的 PDF 没导出来' };
}

// ── 投递留底（设计说明 2「投递留底」、5.1） ──────────────────────────────────────────
// 写终审记录（或预填记录）的时候，把这次上传的 PDF 原样复制进这条投递的 runs 目录（resume-snapshot.pdf），连同那一版的纯文字
// （resume-snapshot.txt）。之后再怎么改这一版，留底都不变。纯文字：PDF 就是这一版现在的内容导出的（v1 原件、或导出指纹对得上）
// 就用这一版的内容；不是（比如用的是设置里的投递文件）就从 PDF 里读回；都不行就只留 PDF。
// 返回 { pdf, txt, doc, version, label, sha256, at }；出错就抛，由调用方记一句、不拦投递（lib/auto-apply.mjs）。
export async function snapshotResume({ plan, dir, pick = {}, now = Date.now() } = {}) {
  const src = plan?.resume_absolute_path;
  if (!src || !dir) throw Error('没有要留底的文件');
  const bytes = fs.readFileSync(src), digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (plan.resume_sha256 && digest !== plan.resume_sha256) throw Error('上传的文件在填表之后又变了');
  const put = (rel, body) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); const tmp = `${file(rel)}.tmp-${process.pid}`; fs.writeFileSync(tmp, body); fs.renameSync(tmp, file(rel)); };
  const pdf = `${dir}/resume-snapshot.pdf`;
  put(pdf, bytes);
  let text = null;
  try {
    if (pick.doc && pick.version) {
      const doc = loadDoc(pick.doc), v = versionOf(doc, pick.version), rel = plan.fields?.resume_path;
      const same = (doc.exports || []).some(x => x.version === v.id && x.format === 'pdf' && x.file === rel && x.sha256 === digest && exportCurrent(x, contentFp(v.content)));
      if (same) text = plainText(v.content);
    }
  } catch {} // 兜底：对不上就从 PDF 读回文字（下一行）
  if (text == null) { try { text = String((await readBack(src)).text || '').trim() || null; } catch (e) { noteSwallowed('resume.snapshotText', e, { member: 'tailor', doing: '从投递用的 PDF 读回文字', then: '这次只留 PDF 快照' }); } }
  const txt = text == null ? null : `${dir}/resume-snapshot.txt`;
  if (txt) put(txt, text + '\n');
  return { pdf, txt, doc: pick.doc || null, version: pick.version || null, label: pick.label || null, sha256: digest, at: iso(now) };
}

// 两份内容逐行比：改过（字或加粗）、新加、删掉、只挪了位置（不在最长的共同顺序里，或者换了经历）。
export function lcsSet(a, b) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = new Set();
  for (let i = 0, j = 0; i < n && j < m;) { if (a[i] === b[j]) { out.add(a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return out;
}
export function changesOf(base, next) {
  const A = lineIndex(base), B = lineIndex(next), out = [];
  const seq = (c, other) => [...walk(c)].filter(x => x.role === 'line' && other.has(x.line.id)).map(x => x.line.id);
  const keep = lcsSet(seq(base, B), seq(next, A));
  for (const [id, x] of B) {
    if (x.role !== 'line') continue;
    const y = A.get(id);
    if (!y) out.push({ line_id: id, kind: 'added' });
    else if (y.line.text !== x.line.text || JSON.stringify(y.line.em || []) !== JSON.stringify(x.line.em || [])) out.push({ line_id: id, kind: 'changed' });
    else if (!keep.has(id) || (y.entry?.id || null) !== (x.entry?.id || null)) out.push({ line_id: id, kind: 'moved' });
  }
  for (const [id, y] of A) if (y.role === 'line' && !B.has(id)) out.push({ line_id: id, kind: 'removed' });
  return out;
}
// b 是 Writer 以 a 为底做的新版、做的时候你又改了 a：{ base_changed:true, from: Writer 开始时看到的 a }；否则 from 是 a 现在的内容。
// 对话里的版本卡片、对比页、定制版的信都按它数改了几处。
export function versionChanges(doc, a, b) {
  const p = (doc.proposals || []).find(x => x.direct && x.used_version === b.id && x.base_version === a.id && x.base_changed && x.base_content);
  const from = p ? p.base_content : a.content;
  return { from, base_changed: !!p, changes: changesOf(from, b.content) };
}
