// 一份简历进「材料」（第 4 步收口，从 lib/resume-assistant.mjs 挪下来）：上传抽出来的文字或贴进来的文字建成一份新简历（importResume），
// 一版另存成新的一份（copyToNewDoc）。材料页、开始使用（lib/resume-import.mjs）、演示数据都从这里建，不往上引材料页。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { event } from './events.mjs';
import { parseResume, allLines } from './resume-doc.mjs';
import { saveCheck } from './resume-reparse.mjs';
import { SCHEMA, DIR, fail, loadWorkspace, saveWorkspace, loadDoc, saveDoc, versionNumbers, contentFp } from './resume-store.mjs';
import { normalizeCjkCompat } from './resume-text.mjs';
import { file, read } from './store.mjs';
import { noteSwallowed } from './swallow.mjs';
// 上传的原件、抽出的文字放在这里（lib/resume-import.mjs 从这里转出去）。
export const UPLOAD_DIR = 'candidate/uploads';

const UPLOAD_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const iso = t => new Date(t).toISOString();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const clean = (s, max = 400) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
// 读一份简历；读坏了（文件损坏、迁移没转完）记一笔再当没有，列表里先不列它。
const tryLoad = id => { try { return loadDoc(id); } catch (e) { noteSwallowed('resume.loadDoc', e, { member: 'tailor', doing: `读简历 ${id}`, then: '这份先不列' }); return null; } };
export const version = (doc, vid) => doc.versions.find(v => v.id === vid) || null;

// ── 导入 ─────────────────────────────────────────────────────────────────────
// 从「开始使用」的上传（candidate/uploads/<id>）导入，或直接给文字（测试、演示）。同一份文件导两次只算一份。
export function importResume({ upload_id = null, text = null, name = null, title = null, source: from = null } = {}, { now = Date.now() } = {}) {
  let source, alt = null;
  // 上传时存下的另一种读法（核对解析顺序用，lib/resume-reparse.mjs）：材料页上传带 upload_id，引导里导入的在 source.upload_id。
  const altOf = id => { try { const m = UPLOAD_ID.test(String(id || '')) ? read(`${UPLOAD_DIR}/${id}.json`, null) : null; return m?.alt_file && fs.existsSync(file(m.alt_file)) ? fs.readFileSync(file(m.alt_file), 'utf8') : null; } catch (e) { noteSwallowed('resume.altOf', e, { member: 'tailor', doing: '读上传时存下的另一种读法', then: '这次不核对解析顺序' }); return null; } };
  if (upload_id) {
    if (!UPLOAD_ID.test(String(upload_id))) throw fail(400, '上传编号不对');
    const meta = read(`${UPLOAD_DIR}/${upload_id}.json`, null);
    if (!meta) throw fail(404, '找不到这份上传的简历');
    if (meta.status === 'unreadable' || !meta.text_file) throw fail(422, meta.error || '这份文件读不出文字');
    text = fs.readFileSync(file(meta.text_file), 'utf8');
    source = { upload_id, name: meta.name, ext: meta.ext, method: meta.method || null, warning: meta.warning || null, sha256: meta.sha256, file: meta.file, uploaded_at: meta.uploaded_at };
  } else {
    if (!String(text || '').trim()) throw fail(400, '没有简历文字');
    source = { upload_id: null, name: clean(name || '粘贴的文字', 80), ext: 'txt', method: 'text', warning: null, sha256: sha(String(text)), ...(from || {}) };
  }
  alt = altOf(source.upload_id);
  // 上传的、粘贴的都走同一条路：兼容汉字（「⼤」）换成标准汉字，别的字不动（lib/resume-text.mjs）。
  text = normalizeCjkCompat(text);
  const ws = loadWorkspace();
  const same = ws.docs.map(d => tryLoad(d.id)).find(d => d?.source?.sha256 === source.sha256);
  if (same) { ws.active = same.id; saveWorkspace(ws); return { status: 'exists', id: same.id }; }
  // 文档写好、工作区索引没写成时，同一上传重试只补回索引，不能另建或覆盖已经存在的版本。
  const diskIds = fs.existsSync(file(DIR)) ? fs.readdirSync(file(DIR), { withFileTypes: true }).filter(d => d.isFile() && /^r\d{1,4}\.json$/.test(d.name)).map(d => d.name.slice(0, -5)) : [];
  const indexed = new Set(ws.docs.map(d => d.id));
  if (source.upload_id) for (const id of diskIds) {
    if (indexed.has(id)) continue;
    let kept;
    try { kept = read(`${DIR}/${id}.json`, null); } catch { continue; }
    if (kept?.schema !== SCHEMA || kept.id !== id || !kept.versions?.length || kept.source?.upload_id !== source.upload_id || kept.source?.sha256 !== source.sha256) continue;
    ws.docs.push({ id, title: kept.title, lang: kept.lang, created_at: kept.created_at });
    ws.active = id;
    saveWorkspace(ws);
    return { status: 'exists', id };
  }
  const content = parseResume(text);
  if (!allLines(content).length) throw fail(422, '这份文件里没读出简历内容');
  const id = `r${Math.max(0, ...[...indexed, ...diskIds].map(id => Number(String(id).slice(1)) || 0)) + 1}`;
  const doc = {
    schema: SCHEMA, id, rev: 0, title: clean(title, 40) || clean(source.name, 80) || '简历', lang: content.lang, created_at: iso(now),
    source: { ...source, chars: String(text).length }, text: String(text),
    versions: [{ id: 'v1', n: 1, name: '原简历', by: 'upload', base: null, lead_ids: [], created_at: iso(now), content, history: [], redo: [], default_for: null, rev: 0 }],
    proposals: [], answers: [], user_texts: [], exports: [],
    // 上传的原件另存一份：出处核对的依据，也是「这一版和原件一字没改」时投递用的那个文件（lib/resume-store.mjs）。
    original: { content: JSON.parse(JSON.stringify(content)), file: null, sha256: source.sha256 || null, at: iso(now) },
  };
  // 材料页或引导上传的 PDF：原件另存一份在这份简历自己的 original/ 下，文件名照你上传时的，记进 original 和一条
  // from:'upload' 的导出记录——v1 和原件一字不差时投递传的就是它，不拿解析出来的内容现导一份（lib/resume-choice.mjs readyPdf）。
  if (source.upload_id && source.ext === 'pdf' && source.file) {
    try {
      const name = String(source.name || 'resume.pdf').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(-80);
      const rel = `${DIR}/${id}/original/${/\.pdf$/i.test(name) ? name : `${name}.pdf`}`;
      fs.mkdirSync(file(`${DIR}/${id}/original`), { recursive: true });
      fs.copyFileSync(file(source.file), file(rel));
      const bytes = fs.readFileSync(file(rel)), digest = sha(bytes);
      if (!source.sha256 || digest === source.sha256) {
        doc.original.file = rel; doc.original.sha256 = digest;
        doc.exports.push({ version: 'v1', format: 'pdf', file: rel, bytes: bytes.length, sha256: digest, at: iso(now), check: null, content_fp: contentFp(content), from: 'upload' });
      }
    } catch (e) { noteSwallowed('resume.keepOriginal', e, { member: 'tailor', doing: '把上传的原件 PDF 存进这份简历', then: '要用时再从内容生成' }); }
  }
  saveDoc(doc);
  ws.docs.push({ id, title: doc.title, lang: doc.lang, created_at: doc.created_at });
  ws.active = id;
  saveWorkspace(ws);
  if (alt) { try { saveCheck(id, content, alt, { now }); } catch (e) { noteSwallowed('resume.saveCheck', e, { member: 'tailor', doing: '核对解析顺序', then: '打开时在后台再补核' }); } }
  event('user', 'resume', 'ok', `材料：导入《${source.name}》（${allLines(content).length} 行），原简历存为 v1`);
  return { status: 'imported', id };
}
// 「复制成新简历」（10-03，要你明说）：从某一份的某一版新建一份简历，它的 v1 记着从哪来。出处核对的依据、你答过的话跟着来源走。
export function copyToNewDoc(docId, vid, { title = '', now = Date.now() } = {}) {
  const src = loadDoc(docId), v = version(src, vid);
  if (!v) throw fail(404, '没有这一版');
  const ws = loadWorkspace(), n = versionNumbers(src).get(vid);
  const id = `r${Math.max(0, ...ws.docs.map(d => Number(String(d.id).slice(1)) || 0)) + 1}`;
  const name = clean(title, 40) || `${src.title}（副本）`;
  const doc = {
    schema: SCHEMA, id, rev: 0, title: name, lang: src.lang, created_at: iso(now), source: { ...(src.source || {}) }, text: src.text || '',
    versions: [{ id: 'v1', n: 1, name: `从「${src.title} v${n}」复制`, by: 'copy', base: null, lead_ids: [], created_at: iso(now), content: JSON.parse(JSON.stringify(v.content)), history: [], redo: [], default_for: null, rev: 0 }],
    proposals: [], answers: JSON.parse(JSON.stringify(src.answers || [])), user_texts: JSON.parse(JSON.stringify(src.user_texts || [])), exports: [],
    original: JSON.parse(JSON.stringify(src.original || { content: v.content, file: null, sha256: null, at: iso(now) })),
    copied_from: { doc: src.id, version: vid, n, title: src.title, at: iso(now) },
  };
  saveDoc(doc);
  ws.docs.push({ id, title: doc.title, lang: doc.lang, created_at: doc.created_at });
  ws.active = id;
  saveWorkspace(ws);
  event('user', 'resume', 'ok', `材料：从《${src.title}》v${n} 复制成新简历《${name}》`);
  return { id, vid: 'v1' };
}
