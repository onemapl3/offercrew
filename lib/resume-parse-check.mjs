// 材料 · 解析完拿原文核对一遍（2026-10-04，负责人：「给我解析的简历，乱七八糟的，顺序都跟我之前的不一样」）。
//
// 解析（lib/resume-doc.mjs parseResume）不重排任何一行；顺序会乱，只可能是抽文字那一步把版面读错了（双栏切错、
// 栏目名挪到页尾……）。所以拿另一种读法当「原文」：PDF 用不按版面、按内容顺序读出来的文字（pdftotext 不加 -layout，
// 或 PDFKit 的整页文字），Word 用自己读 document.xml 的那份。两种读法对不上的地方，就是解析可能有出入的地方：
//   · order：某一段在原文里的位置和解析出来的不一样（栏目先后颠倒，或这一段的内容在原文里属于别的段）；
//   · merged：原文里单独成一段的栏目（「Open Source」），解析出来没有这一段，并进了上一段；
//   · missing：原文里有一大段话，解析出来找不到。
// 只比对够长的行（短行、日期、地点两种读法本来就放在不同位置），宁可少报，不乱报。不 import 别的简历模块以外的东西。
import { headingKind, customHeading, walk } from './resume-doc.mjs';

export const CHECK_VERSION = 1;
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const cjk = s => /[㐀-鿿]/.test(s);
const long = n => n.length >= (cjk(n) ? 10 : 20);
// 一行拿来找位置的那一小段：第一栏（两格以上空白之前）的前 24 个字。
const probe = text => norm(String(text).split(/ {2,}|\t/)[0]).slice(0, 24);

// content：解析出来的（v1 / 原件的内容）；alt：另一种读法的文字。返回 { ok, issues: [{ kind, section, other? }] }。
export function parseCheck(content, alt) {
  const lines = String(alt ?? '').replace(/\r\n?/g, '\n').split(/\n|\f/).map(l => l.trim()).filter(Boolean);
  if (!content || lines.length < 5) return { ok: true, issues: [], skipped: true };
  // 原文拼成一串（去掉空白和标点），记下每一行从哪儿起。
  let joined = '';
  const starts = lines.map(l => { const at = joined.length; joined += norm(l); return at; });
  const lineAt = pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
  const sections = (content.sections || []).filter(s => s.title?.text);
  // 每个栏目名在原文里是哪一行（整行就是它）。
  const titleLine = new Map();
  for (const s of sections) {
    const t = norm(s.title.text), i = lines.findIndex((l, k) => norm(l) === t && ![...titleLine.values()].includes(k));
    if (t && i >= 0) titleLine.set(s.id, i);
  }
  const bounds = [...titleLine.entries()].map(([id, i]) => ({ id, i })).sort((a, b) => a.i - b.i);
  const sectionOfLine = i => { let id = null; for (const b of bounds) { if (b.i <= i) id = b.id; else break; } return id; };
  const issues = [], flagged = new Set(), name = id => sections.find(s => s.id === id)?.title.text || '';
  const add = (kind, id, extra = {}) => { const key = `${kind}:${id}`; if (flagged.has(key)) return; flagged.add(key); issues.push({ kind, section: name(id) || extra.section || '', ...extra }); };
  // 1. 栏目的先后。
  let last = -1;
  for (const s of sections) { const i = titleLine.get(s.id); if (i == null) continue; if (i < last) add('order', s.id); last = Math.max(last, i); }
  // 2. 每一段的内容在原文里是不是在这一段底下、先后对不对。
  const per = new Map();
  for (const x of walk(content)) {
    if (!x.section || x.role === 'title') continue;
    const p = probe(x.line.text);
    if (!long(p)) continue;
    const at = joined.indexOf(p);
    if (at < 0) continue;
    const i = lineAt(at), r = per.get(x.section.id) || { n: 0, away: 0, back: 0, prev: -1, other: new Map() };
    r.n++;
    const home = sectionOfLine(i);
    if (home && home !== x.section.id && titleLine.has(x.section.id)) { r.away++; r.other.set(home, (r.other.get(home) || 0) + 1); }
    if (i < r.prev) r.back++;
    r.prev = Math.max(r.prev, i);
    per.set(x.section.id, r);
  }
  for (const [id, r] of per) {
    // 挪走的内容：两行以上、占这一段三成以上；小的段（一两行）挪走一半就算。
    if ((r.away >= 2 && r.away >= r.n * 0.3) || (r.away >= 1 && r.away >= r.n * 0.5)) { const other = [...r.other.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; add('order', id, other ? { other: name(other) } : {}); }
    else if (r.back >= 2 && r.back >= r.n * 0.25) add('order', id);
  }
  // 3. 原文里单独成一段的栏目，解析出来没有。
  const titles = new Set(sections.map(s => norm(s.title.text)));
  const caps = lines.filter(l => headingKind(l)).length >= 2 && lines.filter(l => headingKind(l)).every(l => !/[a-z]/.test(l));
  lines.forEach((l, i) => {
    if (titles.has(norm(l)) || !(headingKind(l) || customHeading(l, { caps, next: lines[i + 1], next2: lines[i + 2] }))) return;
    if (!lines.slice(i + 1, i + 4).some(x => long(norm(x)))) return; // 底下没有成段的内容：多半不是栏目名
    const into = sectionOfLine(i);
    if (into) add('merged', `${into}:${i}`, { section: l.replace(/[:：]\s*$/, '').trim(), other: name(into) });
  });
  // 4. 原文里成段的话，解析出来找不到。
  const all = norm([...walk(content)].map(x => x.line.text).join(''));
  let miss = 0, missAt = null;
  lines.forEach((l, i) => {
    const n = norm(l);
    if (!long(n)) return;
    const head = n.slice(0, 24), tail = n.slice(-24);
    if (all.includes(head) || all.includes(tail)) return;
    miss += n.length;
    missAt ??= i;
  });
  if (miss >= 120) { const id = sectionOfLine(missAt); add('missing', id || 'header', { section: id ? name(id) : '' }); }
  return { ok: !issues.length, issues };
}

// 页面上的那一句（只说事实）：「解析可能有出入：Experience 一段顺序和原文不同」。
export function checkLine(check) {
  const issues = check?.issues || [];
  if (!issues.length) return null;
  const say = x => x.kind === 'order' ? `「${x.section}」一段${x.other ? `有内容在原文里属于「${x.other}」` : '顺序和原文不同'}`
    : x.kind === 'merged' ? `「${x.section}」在原文里单独一段，解析时并进了「${x.other}」`
    : `${x.section ? `「${x.section}」附近` : ''}有一段原文没读进来`;
  const parts = issues.slice(0, 2).map(say);
  return `解析可能有出入：${parts.join('；')}${issues.length > 2 ? `，还有 ${issues.length - 2} 处` : ''}`;
}
