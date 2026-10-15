// 材料 · 简历（2026-10-01，设计说明 design/materials/设计说明.md）：上传 → 版本（每一版都能直接改、能撤销）→
// 导出 → 设为默认投递。Writer（Tailor）帮着改的四件事在阶段二接上（lib/resume-writer.mjs）。
//
// 规矩：
//   · 每一版都能改，v1 也能（10-02）；上传的原件另存在 doc.original，是出处核对的依据（lib/resume-store.mjs）。
//   · 新版本只在上传、Writer 改一版、你点「另存为新版本」、定制时出现。
//   · 默认投递由你标，中文、英文各一版；设的时候才导出 PDF、改 facts.yaml 的 resume_routing 和 candidate/resume.tex。
//   · 每次保存带 rev：两处同时改，后到的那一次返回 409「这一版刚在别处改过，已重新载入」，不悄悄覆盖。
// 数据都在 candidate/resume/（不进仓库，lib/resume-store.mjs）：workspace.json 记有哪几份简历，<编号>.json 是一份简历的
// 全部状态，<编号>/<版本>/ 下是导出的 PDF / Word。
import { coName } from './vocab.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { file, read, lines as readLines } from './store.mjs';
import { sandboxed, sandboxModels } from './sandbox.mjs';
import { readFacts } from './facts.mjs';
import { UPLOAD_DIR } from './resume-import.mjs';
import { extractText } from './resume-extract.mjs';
import { diffContent } from './resume-doc.mjs';
import { DIR, fail, loadWorkspace, saveWorkspace, loadDoc, saveDoc, migrationState, migrateWorkspace, tidyName, currentVersionOf, versionNumbers, draftFor } from './resume-store.mjs';
import { versionLabel } from './resume-label.mjs';
import { setDefault, exportVersion, applyOps, undo, redo, rewind, copyVersion, renameVersion, defaultPdfState, refreshDefault, openDraft, saveDraft, draftToNewDoc, discardDraft } from './resume-versions.mjs';
import { tailorKey, leadKey, pickResume, chooseResume, tailorWaiting, backfillChoices } from './resume-choice.mjs';
import { startCheck, startEdit, startRewrite, proposalView, useProposal, dropProposal, convertProposals } from './resume-writer.mjs';
import { crewName, faceOf, MEMBERS } from './crew.mjs';
import { checkOf, checkLater, reparse } from './resume-reparse.mjs';
import { noteSwallowed } from './swallow.mjs';
import { importResume, copyToNewDoc } from './resume-intake.mjs';

// 简历这一块就是团队里的 tailor（Writer，做材料，lib/crew.mjs）：名字和脸从名册读，页面从 /api/resume 读。
export const RESUME_CREW = { key: 'tailor', name: crewName('tailor'), title: MEMBERS.tailor.title, face: faceOf('tailor'), role: '帮你改简历：你自己改、让它改一版，版本、导出和默认投递' };
export { DIR } from './resume-store.mjs';
const UPLOAD_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const iso = t => new Date(t).toISOString();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const clean = (s, max = 400) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// ── 存取（lib/resume-store.mjs） ─────────────────────────────────────────────────
export { loadWorkspace, saveWorkspace, loadDoc } from './resume-store.mjs';
// 读一份简历；读坏了（文件损坏、迁移没转完）记一笔再当没有，列表里先不列它。
const tryLoad = id => { try { return loadDoc(id); } catch (e) { noteSwallowed('resume.loadDoc', e, { member: 'tailor', doing: `读简历 ${id}`, then: '这份先不列' }); return null; } };
export const version = (doc, vid) => doc.versions.find(v => v.id === vid) || null;
// 这份简历「现在的样子」：你点过「用这版」的那一版，没点过就是默认投递的那一版，再没有就最新的一版（lib/resume-store.mjs）。
export const current = doc => currentVersionOf(doc);
export const working = doc => current(doc).content;
// 已经在投递用的那份（facts.yaml 的 resume_routing）：一键导入成 v1。只读它，不挪、不改原文件。
export function currentResumes(facts = readFacts()) {
  const r = facts?.resume_routing || {}, seen = new Set();
  return ['english_pdf', 'chinese_pdf'].map(slot => ({ slot, file: typeof r[slot] === 'string' ? r[slot] : '' })).filter(x => /^candidate\/.+\.pdf$/i.test(x.file) && !x.file.split('/').includes('..') && fs.existsSync(file(x.file)) && !seen.has(x.file) && seen.add(x.file)).map(x => ({ ...x, name: x.file.split('/').pop() }));
}
export async function importCurrent(slot, { now = Date.now() } = {}) {
  const cur = currentResumes().find(x => x.slot === slot);
  if (!cur) throw fail(404, '个人资料里没有这份投递用的简历（resume_routing），或者文件不在了');
  const bytes = fs.readFileSync(file(cur.file));
  let got;
  try { got = await extractText(file(cur.file), 'pdf'); } catch (e) { throw fail(422, `读不出这份 PDF 的文字：${String(e.message).slice(0, 160)}`); }
  if (String(got.text || '').replace(/\s/g, '').length < 40) throw fail(422, '这份 PDF 里几乎没有可复制的文字（可能是扫描件或图片），请上传 Word 或文本版');
  return importResume({ text: got.text, name: cur.name, source: { kind: 'routing', file: cur.file, ext: 'pdf', method: got.method || null, warning: got.warning || null, sha256: sha(bytes) } }, { now });
}

// 「用这版」（10-03）：这份简历以后用这一版（岗位只选了这份简历时投递就用它）。这份是默认投递的，默认投递也跟着换到这一版。
export async function useVersionInDoc(docId, vid, { exporter = null } = {}) {
  const doc = loadDoc(docId);
  if (!version(doc, vid)) throw fail(404, '没有这一版');
  const def = doc.versions.find(v => v.default_for);
  doc.current = vid;
  saveDoc(doc);
  if (def && def.id !== vid) await setDefault(docId, vid, def.default_for, { exporter });
  return { doc: docId, vid, current: vid, default_for: def?.default_for || null };
}

export function switchDoc(id) { loadDoc(id); const ws = loadWorkspace(); ws.active = id; saveWorkspace(ws); return { active: id }; }

// 两版（或一版和 Writer 的新版 p…）逐条对比。
export function diffVersions(docId, a, b) {
  const doc = loadDoc(docId);
  const pick = id => version(doc, id)?.content || (doc.proposals || []).find(p => p.id === id)?.content || null;
  const A = pick(a), B = pick(b);
  if (!A || !B) throw fail(404, '没有这一版');
  return { a, b, rows: diffContent(A, B) };
}

// ── 导出、默认投递（lib/resume-versions.mjs） ─────────────────────────────────────
export { exportVersion } from './resume-versions.mjs';
// 旧名字「用这版投递」：就是设为默认投递，语言跟着这份简历。
export const useVersion = (docId, vid, opts = {}) => setDefault(docId, vid, opts.lang || (loadDoc(docId).lang === 'zh' ? 'zh' : 'en'), opts);
export const resumeFile = (docId, vid, format) => {
  const doc = loadDoc(docId), x = (doc.exports || []).find(e => e.version === vid && e.format === format);
  if (!x || !fs.existsSync(file(x.file))) throw fail(404, '这一版还没导出这个格式');
  return x.file;
};

// ── 给页面的视图 ───────────────────────────────────────────────────────────────
// 可以导入的上传：「开始使用」里传过、读得出字、还没导进来的，最新的在前。
function importable(ws) {
  let names = [];
  try { names = fs.readdirSync(file(UPLOAD_DIR)).filter(n => /^\d{8}-\d{6}-[0-9a-f]{6}\.json$/.test(n)).sort().reverse(); } catch { return []; } // 兜底：上传目录还没有，就没有可导入的
  const have = new Set(ws.docs.map(d => tryLoad(d.id)?.source?.sha256).filter(Boolean));
  return names.map(n => read(`${UPLOAD_DIR}/${n}`, null)).filter(m => m && m.text_file && !['unreadable', 'discarded'].includes(m.status) && !have.has(m.sha256)).slice(0, 5).map(m => ({ id: m.id, name: m.name, ext: m.ext, uploaded_at: m.uploaded_at, language: m.language || null }));
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
// 用这一版投递过的岗位：投递留底记下的那一版；没有留底的旧记录看上传的文件（final_review.resume）对得上这一版导出的文件、或者这一版是那个岗位的定制版。
export function usedBy(doc) {
  let leads = [];
  try { leads = readLines('state/leads.ndjson'); } catch {}
  const byFile = new Map((doc.exports || []).map(x => [x.file, x.version])), out = Object.fromEntries(doc.versions.map(v => [v.id, []]));
  for (const l of leads) {
    // 有终审记录就只看终审（它是最近一次真正填上去的；更早的预填记录不算），没有才看预填。
    const rec = l?.auto_apply?.final_review || l?.auto_apply?.prefill || null;
    const f = String(rec?.resume || ''), rid = leadKey(l);
    // 有投递留底的（lib/auto-apply.mjs，2026-10-02 起）：按留底记下的那一版算；更早的记录照旧按上传的文件认。
    const snap = rec?.snapshot?.doc && rec.snapshot.version ? rec.snapshot : null;
    if (snap && rid) { if (snap.doc === doc.id && out[snap.version] && !out[snap.version].includes(rid)) out[snap.version].push(rid); continue; }
    if (!f || !rid) continue;
    let vid = byFile.get(f) || null;
    const own = f.match(/^candidate\/resume\/(r\d+)\/(v\d+)\//);
    if (!vid && own && own[1] === doc.id) vid = own[2];
    const t = f.match(/^candidate\/resume\/tailored\/([0-9a-f]{16})\//);
    if (!vid && t) vid = doc.versions.find(v => (v.lead_ids || []).some(id => tailorKey(id) === t[1]))?.id || null;
    if (vid && out[vid] && !out[vid].includes(rid)) out[vid].push(rid);
  }
  return out;
}
// 定制版是给哪个岗位的：{ rid, number, company, role }。
function useFor(v) {
  const rid = String((v.lead_ids || [])[0] || '');
  let l = null;
  try { l = readLines('state/leads.ndjson').filter(x => leadKey(x) === rid).at(-1) || null; } catch {}
  return { rid, number: l?.number ?? null, company: coName(l?.company), role: String(l?.role || '') };
}
// 点过「用这版」的定制版：那个岗位投递时真的用它（pickResume 指着它，你在「换一份」里另选了就不算）→ { in_use_for: { number, … } }。
function inUseFor(doc, v) {
  const f = useFor(v);
  if (!f.rid) return {};
  let p = null;
  try { p = pickResume({ ...(readLines('state/leads.ndjson').filter(x => leadKey(x) === f.rid).at(-1) || {}), record_id: f.rid }); } catch {}
  return p?.docId === doc.id && p.vid === v.id ? { in_use_for: f } : {};
}
// 简历文件（材料 → 简历的第一层，10-03）：每份一行——名字、最近一次改动、几个岗位在用、默认投递的那份排第一。
// 「几个岗位在用」：用它投递过的（usedBy），加上岗位页「换一份」选了这份的（选择记录），加上这份里为岗位定制、点过「用这版」的。
function choiceRecords() {
  try { return fs.readdirSync(file(`${DIR}/choices`)).filter(n => /^[0-9a-f]{16}\.json$/.test(n)).map(n => read(`${DIR}/choices/${n}`, null)).filter(c => c?.rid && c.doc); } catch { return []; } // 兜底：还没有选择记录的目录
}
const lastChange = doc => doc.versions.flatMap(v => [v.created_at, ...(v.history || []).map(h => h.at)]).filter(Boolean).sort().at(-1) || doc.created_at || null;
export function filesView(docs, { choices = choiceRecords() } = {}) {
  return docs.map(doc => {
    const rids = new Set([...Object.values(usedBy(doc)).flat(), ...choices.filter(c => c.doc === doc.id).map(c => String(c.rid)), ...doc.versions.filter(v => v.by === 'tailor' && v.accepted !== false && !v.dismissed_at).flatMap(v => (v.lead_ids || []).map(String))]);
    const cur = currentVersionOf(doc), def = doc.versions.find(v => v.default_for);
    return { id: doc.id, title: doc.title, lang: doc.lang, updated_at: lastChange(doc), versions: doc.versions.filter(v => !v.draft).length, jobs: rids.size, current: cur ? { id: cur.id, n: versionNumbers(doc).get(cur.id) } : null, default_for: def?.default_for || null, ...(doc.copied_from ? { copied_from: doc.copied_from } : {}) };
  }).sort((a, b) => !!b.default_for - !!a.default_for || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
// 简历数据的迁移（工作台启动时调一次，bin/serve.mjs；读请求只读，契约第五节）：旧格式转第 2 版（lib/resume-store.mjs）、
// 10-02 以前做好了还没用的 Writer 新版转成版本（lib/resume-writer.mjs convertProposals）、迁移留下的「换一份」选择补写成记录。
export function migrateResumes({ now = Date.now() } = {}) {
  let r;
  try { r = migrateWorkspace({ now }); }
  finally {
    try { convertProposals({ now }); } catch (e) { noteSwallowed('resume.convertProposals', e, { member: 'tailor', doing: '把旧的 Writer 新版转成版本', then: '下次启动再转' }); }
    try { backfillChoices(); } catch (e) { noteSwallowed('resume.backfillChoices', e, { member: 'tailor', doing: '补写岗位「换一份」的选择记录', then: '下次启动再补' }); }
  }
  return r;
}
// 旧格式的工作区在工作台启动时转（bin/serve.mjs migrateResumes）；没转完不报错，页面拿到 migration 显示原因，
// 已经能读的简历照常给，转不过来的那几份先不列。
export function resumeView({ doc: want = null, version: wantVersion = null, saved = false } = {}) {
  let migration = null;
  // 迁移、旧的 Writer 新版转成版本都在工作台启动时做（bin/serve.mjs migrateResumes）；读请求只读，这里只拿上一次的结果。
  migration = migrationState();
  const all = loadWorkspace(), facts = readFacts(), routing = facts?.resume_routing || {};
  const ok = all.docs.map(d => [d, tryLoad(d.id)]).filter(([, x]) => x);
  const ws = { ...all, docs: ok.map(([d]) => d) };
  const loaded = ok.map(([, x]) => x);
  const base = { crew: RESUME_CREW, migration, files: filesView(loaded), docs: ws.docs.map(d => pick(d, ['id', 'title', 'lang'])), tailoring: ws.tailoring, uploads: importable(ws), routing: { english_pdf: routing.english_pdf || null, chinese_pdf: routing.chinese_pdf || null }, model: { available: !sandboxed() || sandboxModels(), reason: sandboxed() && !sandboxModels() ? '演示 / 沙盒模式：不调用模型，Writer 改不了；你自己改、版本、导出照常能用。' : null } };
  const id = want && ws.docs.some(d => d.id === want) ? want : ws.active && ws.docs.some(d => d.id === ws.active) ? ws.active : ws.docs[0]?.id;
  if (!id) return { ...base, active: null, doc: null, versions: [], version: null, proposals: [], current: currentResumes(facts) };
  const doc = loadDoc(id), used = usedBy(doc), nums = versionNumbers(doc), curId = currentVersionOf(doc)?.id;
  // 打开一版：它有没存的修改（草稿）就给草稿，关了页面再开还在（10-03）。
  const want0 = version(doc, String(wantVersion || '')) || current(doc), dr0 = want0.draft ? null : draftFor(doc, want0.id);
  // saved：材料页右边的预览要的是这一版自己（只读），不是它的草稿。
  const v = want0.draft || saved ? want0 : dr0?.history?.length ? dr0 : want0;
  const exportsOf = vid => Object.fromEntries((doc.exports || []).filter(x => x.version === vid && fs.existsSync(file(x.file))).map(x => [x.format, { ...pick(x, ['file', 'bytes', 'at', 'check']), stale: !!x.stale }]));
  const readOnly = false, pdf = defaultPdfState(doc, v); // 每一版都能改（10-02 起 v1 也能）；read_only 留着给旧页面
  // 解析核对（10-04）：没核过的旧数据在后台补核，下次打开就有。
  const check = checkOf(doc);
  if (!check) { try { checkLater(doc); } catch (e) { noteSwallowed('resume.checkLater', e, { member: 'tailor', doing: '在后台补核解析顺序', then: '下次打开再补' }); } }
  const v1 = doc.versions.find(x => x.by === 'upload');
  const parse_check = check && !check.ok ? { line: check.line, issues: check.issues, can_reparse: !!v1 && JSON.stringify(v1.content) === JSON.stringify(doc.original?.content || v1.content) } : null;
  // 投递真会传的那个文件（pickResume 同一条规矩）：默认投递是这份时给页面看文件名、是不是上传的原件、设置里的文件是不是不在了。
  let delivery = null;
  const def = doc.versions.find(x => x.default_for);
  if (def) {
    try {
      const pk = pickResume({}, { lang: def.default_for });
      if (pk?.docId === doc.id && (pk.file || pk.routing_missing)) delivery = { file: pk.file ? pk.file.split('/').pop() : null, original: !!pk.file && (doc.exports || []).some(x => x.from === 'upload' && x.file === pk.file), version: pk.vid, ...(pk.routing_missing ? { routing_missing: pk.routing_missing.file.split('/').pop() } : {}) };
    } catch (e) { noteSwallowed('resume.deliveryFile', e, { member: 'tailor', doing: '看默认投递会传哪个文件', then: '页面上先不显示文件名' }); }
  }
  return {
    ...base, active: id,
    doc: { id: doc.id, title: doc.title, lang: doc.lang, created_at: doc.created_at, source: pick(doc.source || {}, ['name', 'ext', 'uploaded_at', 'method', 'warning', 'kind']), current: currentVersionOf(doc)?.id || null, default_for: doc.versions.find(x => x.default_for)?.default_for || null, ...(doc.copied_from ? { copied_from: doc.copied_from } : {}), ...(parse_check ? { parse_check } : {}), ...(delivery ? { delivery } : {}) },
    versions: [...doc.versions].filter(x => !x.draft).sort((a, b) => b.n - a.n).map(x => ({ ...pick(x, ['id', 'n', 'name', 'by', 'base', 'lead_ids', 'created_at']), ...(x.by === 'tailor' ? { waiting: tailorWaiting(x) } : {}), name: tidyName(x.name), label: versionLabel(doc, x), rev: Number(x.rev) || 0, default_for: x.default_for || null, used_by: used[x.id] || [], exports: exportsOf(x.id),
      // 这份自己的版本号、是不是「现在用的」、改过几处、最近一次改动，定制版为哪个岗位（历史里写「为 #N 定制 · 基于 v3」）。
      k: nums.get(x.id), base_k: x.base ? nums.get(x.base) || null : null, current: x.id === curId, changes: x.edits || 0, has_draft: !!draftFor(doc, x.id)?.history?.length, updated_at: (x.history || []).map(h => h.at).filter(Boolean).sort().at(-1) || x.created_at || null,
      ...(x.by === 'tailor' && (x.lead_ids || []).length ? { for_lead: useFor(x) } : {}) })),
    // 还没点「用这版」的定制版（10-02）：页面上给「用这版投 #N」（POST /api/resume {action:'tailor_accept', doc, version}）。
    version: { id: v.id, draft: v.draft && v.history?.length ? { id: v.id, base: v.base, base_k: nums.get(v.base) || null, changes: (v.history || []).length } : null, name: tidyName(v.name), label: versionLabel(doc, v.draft ? version(doc, v.base) || v : v), rev: Number(v.rev) || 0, ...(v.by === 'tailor' && tailorWaiting(v) ? { use_for: useFor(v) } : v.by === 'tailor' ? inUseFor(doc, v) : {}), ...(pdf ? { default_pdf_stale: pdf.stale, default_pdf_reason: pdf.reason } : {}), content: v.content, can_undo: !readOnly && !!v.history?.length, can_redo: !readOnly && !!v.redo?.length, read_only: readOnly, history: (v.history || []).map(h => ({ id: h.id, at: h.at, by: h.by, steps: h.ops.length })).reverse() },
    // 没做成、后来同一件又做了一次的那条（superseded，lib/resume-writer.mjs startRewrite）不再列：历史里只留后来那条。
    proposals: (doc.proposals || []).filter(p => !p.superseded).map(p => pick(p, ['id', 'kind', 'base_version', 'lead_id', 'company', 'instruction', 'status', 'note', 'error', 'created_at'])).reverse(),
  };
}

// ── 一个入口给工作台（POST /api/resume {action, …}） ─────────────────────────────
// 编辑类的动作都带 rev：对不上返回 409（「这一版刚在别处改过，已重新载入」），页面重新载入。
const opsOf = p => { if (!Array.isArray(p.ops) || !p.ops.length || p.ops.length > 200 || p.ops.some(o => !o || typeof o !== 'object' || Array.isArray(o))) throw fail(400, '没有要改的，或者格式不对'); return p.ops; };
const revOf = p => p.rev == null || p.rev === '' ? null : Number(p.rev);
// 每个动作都把这一版现在的内容 rev 带回去（页面拿它做下一次保存）。
const withRev = (docId, vid, r) => { let rev = null; try { rev = Number(loadDoc(docId).versions.find(v => v.id === vid)?.rev) || 0; } catch {} return { ...r, rev }; }; // 兜底：刚改完的这份读不出来时 rev 给 null，页面下次保存会重新取
export async function resumeAction(p = {}, { exporter = null, model = null } = {}) {
  const a = String(p.action || ''), doc = String(p.doc || ''), vid = String(p.version || ''), m = model ? { model } : {};
  if (a === 'import') return importResume({ upload_id: p.upload_id ? String(p.upload_id) : null, text: p.upload_id ? null : typeof p.text === 'string' ? p.text.slice(0, 60000) : null, name: p.name ? String(p.name) : null });
  if (a === 'import_current') return importCurrent(String(p.slot || ''));
  // 从原件重新解析（10-04）：mode 'auto' 照版面、'alt' 按原文顺序（lib/resume-reparse.mjs）。
  if (a === 'reparse') { const r = await reparse(doc, { mode: p.mode === 'alt' ? 'alt' : 'auto' }); return withRev(doc, r.vid, r); }
  if (a === 'switch') return switchDoc(doc);
  if (a === 'edit') {
    // 改动先进草稿（10-03）：在一版上改，第一下就开一份草稿（rev 先按你手里那一版核一遍），之后都改在草稿上。
    const ops = opsOf(p), d0 = loadDoc(doc), here = version(d0, vid);
    if (!here) throw fail(404, '没有这一版');
    let target = vid, rev = revOf(p);
    if (!here.draft) {
      const had = draftFor(d0, vid), fresh = !had?.history?.length; // 空草稿（Writer 开了又没写成）当没有
      if (fresh && rev != null && rev !== (Number(here.rev) || 0)) throw fail(409, '这一版刚在别处改过，已重新载入', 'STALE');
      target = openDraft(doc, vid);
      if (fresh) rev = Number(version(loadDoc(doc), target)?.rev) || 0;
    }
    const r0 = applyOps(doc, target, ops, { by: 'you', rev });
    const dv = version(loadDoc(doc), target), r = { ...r0, vid: target, draft: { id: target, base: dv?.base || vid, changes: (dv?.history || []).length } };
    // 你写的字有找不到出处的：停手以后 Writer 在对话里提醒一句（lib/resume-talk.mjs，按行去抖，同样的字只说一次）。
    if (r.warn_lines?.length) { try { (await import('./resume-talk.mjs')).yourTextNote({ doc, version: r.vid, line_ids: r.warn_lines, session_id: typeof p.session_id === 'string' ? p.session_id : null }); } catch (e) { noteSwallowed('resume.yourTextNote', e, { member: 'tailor', doing: '提醒你改的字找不到出处', then: '这次不提醒' }); } }
    return r;
  }
  if (a === 'draft_save') { const r = await saveDraft(doc, vid, { exporter }); return withRev(doc, r.vid, r); }
  if (a === 'draft_new_doc') return draftToNewDoc(doc, vid, { title: typeof p.title === 'string' ? p.title : '' });
  if (a === 'draft_discard') return discardDraft(doc, vid);
  if (a === 'undo') return undo(doc, vid, { change_id: p.change_id ? String(p.change_id) : null, rev: revOf(p) });
  if (a === 'redo') return redo(doc, vid, { rev: revOf(p) });
  if (a === 'rewind') return rewind(doc, vid, { change_id: p.change_id ? String(p.change_id) : null, rev: revOf(p) });
  if (a === 'copy') { const nv = copyVersion(doc, vid, { name: typeof p.name === 'string' ? p.name : '', by: 'you' }); return withRev(doc, nv, { vid: nv }); }
  if (a === 'rename') return renameVersion(doc, vid, String(p.name ?? ''));
  if (a === 'diff') return diffVersions(doc, String(p.a || ''), String(p.b || ''));
  if (a === 'export') return withRev(doc, vid, await exportVersion(doc, vid, String(p.format || ''), { exporter }));
  // 设为默认投递：这份简历成了默认投递的那份，用的就是这一版（「用这版」也跟着落在这一版上）。
  if (a === 'set_default' || a === 'use') { const r = await setDefault(doc, vid, ['zh', 'en'].includes(p.lang) ? p.lang : loadDoc(doc).lang === 'zh' ? 'zh' : 'en', { exporter }); try { const d = loadDoc(doc); if (d.current !== vid) { d.current = vid; saveDoc(d); } } catch (e) { noteSwallowed('resume.setCurrent', e, { member: 'tailor', doing: '把这一版记成当前版', then: '默认投递已经设好，当前版下次再对齐' }); } return withRev(doc, vid, r); }
  // 这份简历改名（10-03，头上的「改名」）：文件那一层的名字。
  if (a === 'rename_doc') { const d = loadDoc(doc), t = clean(p.title, 40); if (!t) throw fail(400, '名字是空的'); d.title = t; saveDoc(d); const ws = loadWorkspace(); const e = ws.docs.find(x => x.id === doc); if (e) { e.title = t; saveWorkspace(ws); } return { doc, title: t }; }
  if (a === 'use_version') return withRev(doc, vid, await useVersionInDoc(doc, vid, { exporter }));
  if (a === 'copy_doc') return copyToNewDoc(doc, vid, { title: typeof p.title === 'string' ? p.title : '' });
  if (a === 'refresh_default') { const r = await refreshDefault({ lang: ['zh', 'en'].includes(p.lang) ? p.lang : null, docId: doc || null, vid: vid || null }, { exporter }); return r.doc ? withRev(r.doc, r.vid, r) : r; }
  // Writer（lib/resume-writer.mjs）：体检、改一句、改一版 / 定制会跑模型，立刻回 { status:'running' }，结果在后台写好
  // （体检和改一句的看 GET /api/resume/view 的 writer，改一版的看 proposals）；对比、用这版、不用是当场的。
  if (a === 'check') return startCheck({ docId: doc, vid: vid || null }, m);
  if (a === 'edit_lines') return startEdit({ docId: doc, vid: vid || null, line_ids: Array.isArray(p.line_ids) ? p.line_ids.slice(0, 40).map(String) : [], instruction: String(p.instruction ?? '') }, m);
  if (a === 'rewrite') return startRewrite({ docId: doc || null, vid: vid || null, instruction: String(p.instruction ?? ''), lead_id: p.lead_id ? String(p.lead_id) : null }, m);
  if (a === 'proposal') return proposalView(doc, String(p.proposal || ''));
  if (a === 'proposal_use') { const r = useProposal(doc, String(p.proposal || '')); return withRev(doc, r.vid, r); }
  if (a === 'proposal_drop') return dropProposal(doc, String(p.proposal || ''));
  // 岗位页「换一份」：这个岗位投递时用哪一份（{rid, doc, version}），或者清掉（{rid, clear:true}）、回到让 Reacher 选。
  if (a === 'choose') {
    const rid = String(p.rid || '');
    // 只给 doc 不给 version：这个岗位用这份简历「现在用的那一版」（10-03，先选哪一份）。
    if (!p.clear && !doc) throw fail(400, '没说选哪一份');
    const choice = chooseResume(rid, p.clear ? null : { doc, version: vid || null });
    let lead = null;
    try { lead = readLines('state/leads.ndjson').find(l => leadKey(l) === rid) || null; } catch {}
    return { rid, choice, pick: pickResume(lead || { record_id: rid }) };
  }
  throw fail(400, '未知的简历操作');
}
