// 材料 · 解析核对的结果、重新解析（2026-10-04）。
//
// 核对（lib/resume-parse-check.mjs）的结果存在 candidate/resume/<编号>/parse-check.json，不进简历文档本身：
// 后台补做核对不会让你手里那一版的 rev 过期（不弹「这一版刚在别处改过」）。结果记着它核的是哪一份原件内容（fp），
// 原件内容换了（重新解析过）就作废。
//   { v, fp, ok, issues, at, mode }
// 导入时有另一种读法（上传时存的 <id>.alt.txt）就当场核；以前导入的（没核过）打开时在后台读一遍原件再核。
//
// 重新解析（页面上「重新解析」「按原文顺序」）：从原件重新抽文字、重新切分，换掉上传的那一版（v1）和出处核对用的原件内容。
//   mode 'auto'：照现在的读法（按版面）；mode 'alt'：用按内容顺序读出来的那份文字。
//   v1 你改过就不换（会盖掉你的修改），说清楚；别的版本不动。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { file, read, write } from './store.mjs';
import { event } from './events.mjs';
import { parseResume, allLines } from './resume-doc.mjs';
import { parseCheck, checkLine, CHECK_VERSION } from './resume-parse-check.mjs';
import { DIR, fail, loadDoc, saveDoc, contentFp, originalContent } from './resume-store.mjs';
import { normalizeCjkCompat } from './resume-text.mjs';
import { noteSwallowed } from './swallow.mjs';

export const checkPath = id => `${DIR}/${id}/parse-check.json`;
const iso = t => new Date(t).toISOString();
const sha = abs => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

export function saveCheck(id, content, alt, { mode = 'auto', now = Date.now() } = {}) {
  // 没有另一种读法、或者原文太短核不了：也记一笔（ok），打开页面时不再一遍遍地读原件。
  const r = alt ? parseCheck(content, alt) : { ok: true, issues: [] };
  const rec = { v: CHECK_VERSION, fp: contentFp(content), ok: r.ok, issues: r.issues, at: iso(now), mode };
  write(checkPath(id), rec);
  return rec;
}
// 这份简历现在的核对结果（给页面）：{ ok, issues, line } 或 null（没核过 / 核的不是现在的原件）。
export function checkOf(doc) {
  let rec = null;
  try { rec = read(checkPath(doc.id), null); } catch {} // 兜底：核对记录不在或读坏了就当没核过，下面会再核
  if (!rec || rec.v !== CHECK_VERSION || rec.fp !== contentFp(originalContent(doc))) return null;
  return { ok: !!rec.ok, issues: rec.issues || [], line: checkLine(rec), mode: rec.mode || 'auto' };
}

// 原件在哪：original.file（引导、材料页上传时记下的），没有就是上传记录里的那份（source.file）。字节要和记下的一样。
export function originalFile(doc) {
  for (const [rel, want] of [[doc.original?.file, doc.original?.sha256], [doc.source?.file, doc.source?.sha256]]) {
    if (!rel || !/^candidate\//.test(rel) || String(rel).split('/').includes('..')) continue;
    const abs = file(rel);
    if (!fs.existsSync(abs)) continue;
    if (want && sha(abs) !== want) continue;
    const ext = String(rel).split('.').pop().toLowerCase();
    if (['pdf', 'docx', 'txt', 'md'].includes(ext)) return { rel, abs, ext };
  }
  return null;
}
async function read2(doc) {
  const f = originalFile(doc);
  if (!f) return null;
  const { extractText } = await import('./resume-extract.mjs');
  return extractText(f.abs, f.ext);
}

// 以前导入的、没核过的：后台读一遍原件再核。同一份同一时刻只做一次；失败不报错（下次打开再试）。
const running = new Set();
export function checkLater(doc) {
  if (running.has(doc.id) || checkOf(doc) || !originalFile(doc)) return false;
  running.add(doc.id);
  (async () => {
    try { const r = await read2(doc); if (r) saveCheck(doc.id, originalContent(doc), r.alt || null); }
    catch (e) { noteSwallowed('resume.checkLater', e, { member: 'tailor', doing: '在后台补核解析顺序', then: '下次打开再补' }); } finally { running.delete(doc.id); }
  })();
  return true;
}

export async function reparse(docId, { mode = 'auto', now = Date.now() } = {}) {
  if (!['auto', 'alt'].includes(mode)) throw fail(400, '重新解析只有两种：照版面、按原文顺序');
  let doc = loadDoc(docId);
  const v1 = doc.versions.find(v => v.by === 'upload') || null;
  if (!v1) throw fail(422, '这份简历不是上传的，没有原件可以重新解析');
  const draft = doc.versions.find(x => x.draft && x.base === v1.id && (x.history || []).length);
  if (contentFp(v1.content) !== contentFp(originalContent(doc)) || draft) throw fail(409, `v${v1.n || 1} 你改过，重新解析会盖掉这些修改；先「另存为新版本」再来`);
  if (!originalFile(doc)) throw fail(404, '原件不在了（或者被换过），没法重新解析');
  let r;
  try { r = await read2(doc); } catch (e) { throw fail(422, `原件读不出文字：${String(e.message).slice(0, 120)}`); }
  const text = normalizeCjkCompat(mode === 'alt' ? r?.alt : r?.text);
  if (!String(text || '').trim()) throw fail(422, mode === 'alt' ? '这份原件没有另一种读法' : '原件里没读出文字');
  const content = parseResume(text, { lang: doc.lang || null });
  if (!allLines(content).length) throw fail(422, '原件里没读出简历内容');
  doc = loadDoc(docId);
  const v = doc.versions.find(x => x.id === v1.id), fp = contentFp(content);
  v.content = content; v.history = []; v.redo = [];
  doc.original = { ...(doc.original || {}), content: JSON.parse(JSON.stringify(content)), reparsed_at: iso(now), reparse_mode: mode };
  doc.text = text;
  // 上传的原件那条导出记录跟着新的内容走（投递照旧传原件）；这一版以前现导的 PDF 内容对不上了，自然不再用。
  doc.exports = (doc.exports || []).map(x => x.version === v.id && x.from === 'upload' ? { ...x, content_fp: fp } : x);
  saveDoc(doc);
  // 核对：照版面解析的拿另一种读法核；按原文顺序解析的就是原文，不再报。
  if (mode === 'auto' && r.alt) saveCheck(docId, content, r.alt, { now });
  else write(checkPath(docId), { v: CHECK_VERSION, fp, ok: true, issues: [], at: iso(now), mode });
  event('user', 'resume', 'ok', `材料：《${doc.title}》从原件重新解析（${mode === 'alt' ? '按原文顺序' : '照版面'}，${allLines(content).length} 行）`);
  return { doc: docId, vid: v.id, mode, check: checkOf(loadDoc(docId)) };
}
