// 材料 · 简历工作区的存取（2026-10-01，设计说明 5.1）：candidate/resume/ 下 workspace.json 记有哪几份简历，
// <编号>.json 是一份简历的全部状态（第 2 版结构，见下）。每存一次 rev 加一：拿着旧的 rev 去存（两个标签页、
// 你打字时 Writer 从对话里改了一句），不许悄悄覆盖，抛 STALE（409），页面重新载入。
//
// 第 2 版文档：
//   { schema: 2, id: 'r1', rev, title, lang, created_at, source, text,
//     versions: [{ id: 'v1', n, name, by: 'upload'|'you'|'writer'|'copy'|'tailor', base, lead_ids, created_at,
//                  content, history: [{ id, at, by, ops, inverse, rev }], redo: [], default_for: null|'zh'|'en' }],
//     proposals: [], answers: [], user_texts: [], exports: [{ version, format, file, at, check, content_fp? }],
//     original: { content, file, sha256, at },
//     current?: 'v3',                                   这份简历现在用哪一版（「用这版」，10-03）；没有就看下面 currentVersionOf
//     copied_from?: { doc, version, title, at } }       从别的简历复制出来的（「复制成新简历」，10-03）
// 草稿（负责人 10-03）：打开一版去改，改动先进一份草稿——versions 里一条 { id:'d1', draft:true, base:'v3', n:null, … }，
// 不算一版：历史、件数、「现在用」、投递、默认投递都不看它；「存为新的一版」才变成 vN+1（lib/resume-versions.mjs saveDraft）。
// 一份简历就是一个文件（材料页的「简历文件」，10-03）：版本号按份算。旧数据不改，读的时候补默认值。
// 每一版都能改，v1 也能（设计说明第 10 节，负责人 10-02）。上传的原件在后台另存一份（original）：出处核对的依据永远是它
// （lib/resume-doc.mjs poolsFor 的 original），不是 v1 现在的内容；哪一版和它一字不差，投递就用上传的原件（lib/resume-choice.mjs）。
// 旧数据没有 original：读的时候从 v1（那时 v1 只读，就是原件）和上传原件的导出记录（from:'upload'）补上，下次存时一起落盘。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file, read, write } from './store.mjs';
import { readFacts } from './facts.mjs';
import { lock } from './lock.mjs';
import { TZ } from './tz.mjs';
import { noteSwallowed } from './swallow.mjs';

export const SCHEMA = 2;
export const DIR = 'candidate/resume';
export const WS = `${DIR}/workspace.json`;
export const DOC_ID = /^r\d{1,4}$/;
export const fail = (status, message, code = null) => Object.assign(Error(message), { status, ...(code ? { code } : {}) });
export const STALE_MESSAGE = '这一版刚在别处改过，已重新载入';
// 版本名读的时候整理（叠了字的、末尾自动加的「· Writer 改过」）：lib/resume-label.mjs。
export { tidyName } from './resume-label.mjs';
export const docPath = id => `${DIR}/${id}.json`;

export const loadWorkspace = () => { const w = read(WS, {}) || {}; return { docs: [], active: null, ...w, tailoring: { enabled: false, only: 'all', ...(w.tailoring || {}) } }; };
export const saveWorkspace = ws => write(WS, ws);

// 读一份：原样读盘。更新版本的程序写的（schema 比这里新）不碰，直接说清楚。
export const isOld = d => !!d && (d.schema == null || Number(d.schema) < SCHEMA);
export function readDoc(id) {
  if (!DOC_ID.test(String(id || ''))) throw fail(400, '简历编号不对');
  const d = read(docPath(id), null);
  if (!d) throw fail(404, '找不到这份简历');
  if (Number(d.schema) > SCHEMA) throw fail(422, '这份简历是更新版本的 OfferCrew 写的，这里读不了；请先升级', 'NEWER_SCHEMA');
  return withOriginal(d);
}
// 上传的原件（from:'upload' 的导出记录）。
const uploadRecOf = d => (d?.exports || []).find(x => x?.from === 'upload' && x.format === 'pdf') || null;
// 没有 original 的第 2 版文档：从 v1 补上（只在内存里；改 v1 一定先读再存，所以存下来的是改之前的 v1）。已经有的不动。
export function withOriginal(d) {
  if (!d || isOld(d) || !Array.isArray(d.versions) || !d.versions[0]?.content) return d;
  if (!d.original) {
    const v1 = d.versions[0], up = uploadRecOf(d);
    d.original = { content: JSON.parse(JSON.stringify(v1.content)), file: up?.file || null, sha256: up?.sha256 || null, at: v1.created_at || d.created_at || null };
  }
  return withUploadRec(d);
}
// 原件有文件（PDF）、却没有 from:'upload' 的导出记录（10-04：命令行版导进来的、材料页上传的旧数据）：补一条，只在内存里，下次存时落盘。
// 有了它，上传的那一版和原件一字不差时投递就传原件（lib/resume-choice.mjs readyPdf），不拿解析出来的内容现导一份；
// 字节对不对（sha256）由用的地方核，对不上就不算。
function withUploadRec(d) {
  const o = d.original;
  if (!o?.file || !o.sha256 || !/\.pdf$/i.test(o.file) || uploadRecOf(d)) return d;
  const v = d.versions.find(x => x.by === 'upload') || d.versions[0];
  let size = null;
  try { size = fs.statSync(file(o.file)).size; } catch { return d; }
  d.exports = [...(d.exports || []), { version: v.id, format: 'pdf', file: o.file, bytes: size, sha256: o.sha256, at: o.at || d.created_at || null, check: null, content_fp: contentFp(o.content || v.content), from: 'upload' }];
  return d;
}
// 出处核对的依据：上传的原件的内容（没有 original 的旧数据就是 v1）。
export const originalContent = d => d?.original?.content || d?.versions?.[0]?.content || { header: [], sections: [] };
// 读到旧格式（第 1 版）：走同一个迁移入口（ensureMigrated：先备份、加锁、可以重跑），再读；这一份没转成就说清楚原因。
export function loadDoc(id) {
  const d = readDoc(id);
  if (!isOld(d)) return d;
  try { ensureMigrated(); } catch (e) { throw fail(503, `简历数据还没转换完成（${humanFs(e)}），原来的文件没有改动，稍后再试`, 'MIGRATION'); }
  const again = readDoc(id);
  if (!isOld(again)) return again;
  throw fail(503, migration?.message || '简历数据还没转换完成，稍后再试', 'MIGRATION');
}
// 这份简历现在用哪一版：你点过「用这版」的那一版；没点过就是标着默认投递的那一版；都没有就是最新的一版。
export const isDraft = v => !!v?.draft;
export const draftFor = (doc, vid) => (doc?.versions || []).find(v => v.draft && v.base === vid) || null;
export function currentVersionOf(doc) {
  const vs = (doc?.versions || []).filter(v => !v.draft);
  return vs.find(v => v.id === doc.current) || vs.find(v => v.default_for) || [...vs].sort((a, b) => (b.n || 0) - (a.n || 0))[0] || null;
}
// 显示用的版本号：按这份自己的顺序（n，再看创建时间）编成 1、2、3…；正常数据和 n 一样，断号、重号的旧数据也排得整齐。版本 id 不动。
export function versionNumbers(doc) {
  const vs = [...(doc?.versions || [])].filter(v => !v.draft).sort((a, b) => (a.n || 0) - (b.n || 0) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return new Map(vs.map((v, i) => [v.id, i + 1]));
}
// 存：盘上的 rev 和手里的对不上就不存（STALE）；对得上，rev 加一再写。
// 设置 → 个人资料的「材料」一行（QA #40）：和材料页一样数——几份简历、一共几个版本（Writer 还没用的新版不算）。读不到的那份不算。
export function materialsCount() {
  let docs = 0, versions = 0;
  for (const d of loadWorkspace().docs || []) { try { versions += (readDoc(d.id).versions || []).filter(v => !v.draft).length; docs++; } catch {} } // 兜底：读不到的那份不算（上面的注释），材料页那边会记一笔
  return { docs, versions };
}
export function saveDoc(doc) {
  if (!DOC_ID.test(String(doc?.id || ''))) throw fail(400, '简历编号不对');
  const disk = read(docPath(doc.id), null), have = Number(doc.rev) || 0;
  if (disk && (Number(disk.rev) || 0) !== have) throw fail(409, STALE_MESSAGE, 'STALE');
  doc.rev = have + 1;
  write(docPath(doc.id), doc);
  for (const fn of docHooks) try { fn(doc); } catch (e) { console.error(`[resume] 存简历之后的记账出错：${e.message}`); }
  return doc;
}
// 存完一份简历之后要做的事（lib/task-writer.mjs：Writer 改的那一版做完 / 没做成，把卡的那件活记上）。这里不认得任务，只管调。
const docHooks = new Set();
export const onDocSaved = fn => { docHooks.add(fn); };

// 一版内容的指纹：导出记录带着它，内容改过以后旧的导出就不再拿来用。
export const contentFp = content => crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex').slice(0, 16);
// 只改标记：这一版成为这种语言的默认投递（整个工作区同一种语言只留这一版），可以顺手记下一条导出。
// 不导出、不改 resume_routing——那是 lib/resume-versions.mjs setDefault 的事；这里给已经有文件的场合用（#24 引导导入）。
export function markDefault(docId, vid, lang, { exportRec = null } = {}) {
  if (!['zh', 'en'].includes(lang)) throw fail(400, '默认投递只分中文、英文');
  const target = loadDoc(docId), tv = target.versions.find(v => v.id === vid);
  if (!tv) throw fail(404, '没有这一版');
  if (tv.default_for && tv.default_for !== lang) throw fail(422, `${vid} 已经是${tv.default_for === 'zh' ? '中文' : '英文'}默认投递；一版只能给一种语言用。要用在${lang === 'zh' ? '中文' : '英文'}岗位，先另存为新版本再设。`);
  for (const d of loadWorkspace().docs) {
    if (d.id === docId) continue;
    let other; try { other = loadDoc(d.id); } catch { continue; }
    if (!other.versions.some(v => v.default_for === lang)) continue;
    for (const v of other.versions) if (v.default_for === lang) v.default_for = null;
    saveDoc(other);
  }
  for (const v of target.versions) v.default_for = v.id === vid ? lang : v.default_for === lang ? null : v.default_for;
  // 引导里导入的原件（from:'upload'）：记进 original（导入时还不知道原件放在哪）。
  if (exportRec?.from === 'upload' && target.original && !target.original.file) Object.assign(target.original, { file: exportRec.file, sha256: exportRec.sha256 || null });
  if (exportRec) target.exports = [...(target.exports || []).filter(x => !(x.version === exportRec.version && x.format === exportRec.format)), exportRec];
  saveDoc(target);
  return { doc: docId, version: vid, lang };
}

// ── 旧数据迁移（设计说明 5.2） ─────────────────────────────────────────────────────
// 旧格式（2026-09-29 的简历助手）：versions 不可改（note / changes / from），draft 另放，stable 记投递用哪一版，
// 还有 locks、suggestions、blocked、questions、review。定制记录在 candidate/resume/tailored/<key>.json。
const iso = t => new Date(t).toISOString();
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const copy = x => x == null ? x : JSON.parse(JSON.stringify(x));
// 谁改的：看旧版本里每处改动记的 by（ai、rule 是模型和代码给的建议 → writer；user、restore → you），不从 note 里猜。
const byOf = (v, i) => i === 0 ? 'upload' : (v.changes || []).some(c => c?.by === 'ai' || c?.by === 'rule') ? 'writer' : 'you';
const newVersion = ({ id, n, name, by, base = null, lead_ids = [], created_at, content }) => ({ id, n, name, by, base, lead_ids, created_at, content, history: [], redo: [], default_for: null, rev: 0 });
// 纯函数：旧文档（和属于它的定制记录）→ 第 2 版。已经是第 2 版的原样返回。
export function migrateDoc(old, { now = Date.now(), tailored = [] } = {}) {
  if (!isOld(old)) return old;
  if (!DOC_ID.test(String(old?.id || ''))) throw Error('编号不对');
  if (!Array.isArray(old.versions) || !old.versions.length || old.versions.some(v => !v?.id || !Array.isArray(v?.content?.sections))) throw Error(`${old.id} 的版本记录不全`);
  const created = old.created_at || iso(now);
  const versions = (old.versions || []).map((v, i) => newVersion({ id: v.id, n: Number(v.n) || i + 1, name: i === 0 ? '原简历' : clean(v.note) || `v${Number(v.n) || i + 1}`, by: byOf(v, i), base: i === 0 ? null : v.from || old.versions[i - 1].id, created_at: v.at || created, content: copy(v.content) }));
  const next = () => { const n = Math.max(0, ...versions.map(v => v.n)) + 1; return { id: `v${n}`, n }; };
  if (old.stable) { const v = versions.find(x => x.id === old.stable); if (v) v.default_for = old.lang === 'zh' ? 'zh' : 'en'; }
  // 没存的草稿：另存一版，不悄悄并进原来那一版。
  if (old.draft?.content) versions.push(newVersion({ ...next(), name: '未保存的改动', by: 'you', base: old.draft.base || old.current || versions.at(-1)?.id || null, created_at: old.draft.at || iso(now), content: copy(old.draft.content) }));
  // 定制记录：选用过的 → 定制版（内容就是当时选用、导出的那一份）；等你看的 → 一条 Writer 的新版；其余丢掉。
  const recs = [...tailored].filter(r => r?.doc_id === old.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const choices = [], proposals = [];
  for (const r of recs) {
    if (!r.content || !versions.some(v => v.id === r.base_version)) continue;
    if (r.status === 'chosen') {
      const v = newVersion({ ...next(), name: `${clean(r.company, 40) || '岗位'} 定制版`, by: 'tailor', base: r.base_version, lead_ids: [String(r.record_id)], created_at: r.decided_at || r.created_at || iso(now), content: copy(r.content) });
      versions.push(v);
      choices.push({ rid: String(r.record_id), doc: old.id, version: v.id, by: 'you', at: r.decided_at || r.created_at || iso(now) });
    } else if (r.status === 'proposed') {
      proposals.push({ id: `p${proposals.length + 1}`, kind: 'tailor', base_version: r.base_version, lead_id: String(r.record_id), company: r.company || '', instruction: '', content: copy(r.content), reverted: [], questions: [], status: 'ready', note: clean(r.why, 200), created_at: r.created_at || iso(now) });
    }
  }
  return {
    schema: SCHEMA, id: old.id, rev: 0, title: old.title, lang: old.lang, created_at: created, source: copy(old.source) || {}, ...(old.text != null ? { text: old.text } : {}),
    versions, proposals,
    answers: copy(old.answers) || [], user_texts: copy(old.user_texts) || [], exports: copy(old.exports) || [],
    original: { content: copy(versions[0].content), file: (old.exports || []).find(x => x?.from === 'upload' && x.format === 'pdf')?.file || null, sha256: (old.exports || []).find(x => x?.from === 'upload' && x.format === 'pdf')?.sha256 || null, at: versions[0].created_at },
    ...(choices.length ? { migrated_choices: choices } : {}),
    migrated_at: iso(now),
  };
}
// 备份目录名用本地时间，和 lib/profile.mjs 的资料备份一样（config/host.json 的时区）。
const stamp = now => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(/\D/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
const TAILOR_DIR = `${DIR}/tailored`;
export const MIGRATION_MARK = `${DIR}/.migration.json`;
// 文件系统的错说成人话（不带 errno、路径）。
export const humanFs = e => ({ EACCES: '有文件没有权限读写', EPERM: '有文件没有权限读写', ENOSPC: '磁盘满了', EDQUOT: '磁盘满了', EROFS: '磁盘是只读的', EMFILE: '同时打开的文件太多', ENOENT: '有文件找不到了' })[e?.code] || '读写文件出错';
// 备份没做成以后隔多久再试：不是每读一次都重来（每次都会复制一遍整个目录）。
export const BACKUP_RETRY_MS = 10 * 60000;
const listDir = rel => { try { return fs.readdirSync(file(rel)); } catch { return []; } }; // 兜底：目录还没有就是空的
const docIds = () => listDir(DIR).map(n => n.match(/^(r\d{1,4})\.json$/)?.[1]).filter(Boolean).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const readRaw = id => { try { return read(docPath(id), null); } catch (e) { return { id, broken: String(e.message).slice(0, 120) }; } };
// 上一次迁移没做完的原因（页面用它显示状态）；做完或者没有要转的就是 null。
let migration = null;
export const migrationState = () => migration;
// 迁移的唯一入口（lib/resume-store.mjs）：loadDoc 读到旧格式时、材料页打开时都走它。能安全重跑：全是第 2 版时什么都不写。
export function ensureMigrated({ now = Date.now() } = {}) {
  migrateWorkspace({ now });
  return migration;
}
// 整个工作区迁一遍：有旧格式的文档才动。
//   · 加锁（lib/lock.mjs 'resume'）：工作台和周期里的 tailor-resumes 不会同时迁；锁被别的进程拿着就这次不迁，下次再来。
//   · 动之前把 candidate/resume/ 整个复制到 backup-<本地时间>.partial/，复制完再改名成 backup-<本地时间>/（旧的备份不再复制）。
//   · 标记文件 .migration.json 记下备份路径和已经转好的编号：这一轮没做完（某一份出错），下次重试复用同一份备份，不再复制。
//   · 某一份转不过来：它原样留着不动，别的照转；原因记进 migration，页面显示。
// 可以重跑：全是第 2 版时什么都不写，返回 { migrated: [], backup: null }。
export function migrateWorkspace({ now = Date.now() } = {}) {
  if (!docIds().map(readRaw).some(d => d?.broken || isOld(d))) { migration = null; return { migrated: [], backup: null }; }
  let release;
  try { release = lock('resume'); }
  catch (e) {
    if (e.message !== 'another_radar_writer_running') throw e;
    migration = { status: 'running', message: '简历数据正在另一处转换，稍等一下再打开', backup: null };
    return { migrated: [], backup: null, busy: true };
  }
  try {
    const ids = docIds(), raw = ids.map(readRaw), old = raw.filter(d => d && (d.broken || isOld(d)));
    if (!old.length) { migration = null; return { migrated: [], backup: null }; }
    const mark = read(MIGRATION_MARK, null);
    let backup = mark && !mark.complete && mark.backup && fs.existsSync(file(mark.backup)) ? mark.backup : null;
    const reused = !!backup;
    if (!backup) {
      // 上次备份没做成：退避期内不再复制，页面照旧显示原因。
      const failedAt = mark?.backup_failed, retry = Date.parse(failedAt?.retry_at || '');
      if (failedAt && Number.isFinite(retry) && now < retry) { migration = { status: 'failed', message: failedAt.message, backup: null }; return { migrated: [], backup: null, failed: [{ id: null, error: failedAt.message }] }; }
      let name = `backup-${stamp(now)}`;
      for (let n = 2; fs.existsSync(file(`${DIR}/${name}`)) || fs.existsSync(file(`${DIR}/${name}.partial`)); n++) name = `backup-${stamp(now)}-${n}`;
      const partial = `${DIR}/${name}.partial`;
      try {
        fs.mkdirSync(file(partial), { recursive: true });
        for (const n of listDir(DIR)) if (!/^backup-/.test(n) && n !== path.basename(MIGRATION_MARK)) fs.cpSync(file(`${DIR}/${n}`), file(`${partial}/${n}`), { recursive: true, preserveTimestamps: true });
        backup = `${DIR}/${name}`;
        fs.renameSync(file(partial), file(backup));
      } catch (e) {
        // 复制失败（有文件读不了、磁盘满）：删掉这次半截的备份，记下原因和下次什么时候再试；原来的文件一个都没动。
        try { fs.rmSync(file(partial), { recursive: true, force: true }); } catch {} // 兜底：半截的备份删不掉就留着，下次备份用新名字，原来的文件一个都没动
        const message = `简历数据转换前要先整目录备份，但备份没做成（${humanFs(e)}）。原来的文件都没有改动，${Math.round(BACKUP_RETRY_MS / 60000)} 分钟后会再试`;
        try { write(MIGRATION_MARK, { ...(mark || {}), backup: null, complete: false, backup_failed: { at: new Date(now).toISOString(), retry_at: new Date(now + BACKUP_RETRY_MS).toISOString(), reason: humanFs(e), message } }); } catch (err) { noteSwallowed('resume-store.backupMark', err, { member: 'tailor', doing: '记下简历备份没做成', then: '这次照样不转换，下次启动再试' }); }
        migration = { status: 'failed', message, backup: null };
        return { migrated: [], backup: null, failed: [{ id: null, error: message }] };
      }
    }
    const marker = { backup, backup_failed: null, started_at: reused ? mark.started_at : new Date(now).toISOString(), migrated: reused ? [...(mark.migrated || [])] : [], failed: [], complete: false };
    write(MIGRATION_MARK, marker);
    const recs = listDir(TAILOR_DIR).filter(n => /^[0-9a-f]{16}\.json$/.test(n)).map(n => { try { return read(`${TAILOR_DIR}/${n}`, null); } catch (e) { noteSwallowed('resume-store.tailorRecord', e, { member: 'tailor', doing: `转换时读定制记录 ${n}`, then: '这条定制记录不跟着转' }); return null; } }).filter(Boolean);
    const docs = [], failed = [];
    for (const d of old) {
      if (d.broken) { failed.push({ id: d.id, error: `${d.id}.json 读不出来（${d.broken}）` }); continue; }
      try { docs.push(migrateDoc(d, { now, tailored: recs })); } catch (e) { failed.push({ id: d.id, error: String(e.message).slice(0, 160) }); }
    }
    // 同一种语言整个工作区只能有一版默认投递：resume_routing 指着的那一份优先，其次 stable 设得最晚的。
    const routing = (() => { try { return readFacts()?.resume_routing || {}; } catch (e) { noteSwallowed('resume-store.routing', e, { member: 'tailor', doing: '转换时读设置里的投递文件', then: '按设得最晚的那版定默认投递' }); return {}; } })();
    const current = raw.filter(d => d && !d.broken && !isOld(d) && Number(d.schema) === SCHEMA);
    for (const lang of ['zh', 'en']) {
      const slot = routing[lang === 'zh' ? 'chinese_pdf' : 'english_pdf'];
      const holders = [...current, ...docs].flatMap(d => d.versions.filter(v => v.default_for === lang).map(v => ({ d, v, oldDoc: old.find(o => o.id === d.id) })));
      if (holders.length < 2) continue;
      const routed = h => !!slot && (h.d.exports || []).some(x => x.version === h.v.id && x.file === slot);
      const when = h => String(h.oldDoc?.stable_at || '');
      const keep = holders.find(h => !h.oldDoc) || holders.find(routed) || [...holders].sort((a, b) => when(b).localeCompare(when(a)))[0];
      for (const h of holders) if (h !== keep && h.oldDoc) h.v.default_for = null;
    }
    for (const d of docs) { write(docPath(d.id), d); marker.migrated.push(d.id); write(MIGRATION_MARK, marker); }
    marker.failed = failed; marker.complete = !failed.length;
    if (marker.complete) marker.finished_at = new Date(now).toISOString();
    write(MIGRATION_MARK, marker);
    migration = failed.length ? { status: 'failed', message: `简历数据转换没完成：${failed.map(f => f.error).join('；')}。原来的文件在 ${backup}，没有改动`, backup, failed: failed.map(f => f.id) } : null;
    return { migrated: docs.map(d => d.id), backup, ...(failed.length ? { failed } : {}) };
  } finally { release(); }
}
