// 某条线索这次投递上传哪份简历（设计说明 4.4，pickResume）：你选的 → 这个岗位的定制版 → 默认投递里同语言的那一版。
// 只读几个小文件，只 import lib/resume-store.mjs（它不 import 别的简历模块）和 lib/resume-label.mjs：
// lib/application-form.mjs 的 resumeFor 和终审信都读它，不能引出 import 环。
// 定制版的文件名和稳定版一样（放在各自的目录里），所以「投 N」的批准不失效；但文件内容变了，终审指纹会变，
// 系统会重新填表、重新请你终审（lib/auto-apply.mjs）。
import { coName } from './vocab.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { file, read, write, lines } from './store.mjs';
import { versionLabel } from './resume-label.mjs';
import { readDoc, isOld, loadWorkspace, contentFp, fail, saveDoc, currentVersionOf } from './resume-store.mjs';
import { readFacts } from './facts.mjs';
import { noteSwallowed } from './swallow.mjs';

export const TAILOR_DIR = 'candidate/resume/tailored';
export const leadKey = l => String(l?.record_id || l?.id || '');
export const tailorKey = rid => crypto.createHash('sha1').update(String(rid)).digest('hex').slice(0, 16);
export const tailorPath = rid => `${TAILOR_DIR}/${tailorKey(rid)}.json`;
const sha = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(file(p))).digest('hex'); } catch { return null; } }; // 兜底：文件不在或读不出就没有指纹，按「不是这一版」算
// 选用了、文件还在、内容没被动过的定制版；否则 null（照旧用稳定版）。
export function chosenTailored(lead) {
  const rid = leadKey(lead);
  if (!rid) return null;
  const t = read(tailorPath(rid), null);
  if (!t || t.status !== 'chosen' || !t.export?.file || sha(t.export.file) !== t.export.sha256) return null;
  return { file: t.export.file, base_version: t.base_version, doc_id: t.doc_id };
}
// 给人看：这次上传的是哪一份（终审信、岗位页）。版本的叫法和材料页一样，前面加语言（lib/resume-label.mjs）：「英文 · v3 · 通用版」。
const docAt = id => { try { return read(`candidate/resume/${id}.json`, null); } catch (e) { noteSwallowed('resume.loadDoc', e, { member: 'tailor', doing: `读简历 ${id}`, then: '当没有这份' }); return null; } };
export const OWN_FILE_LABEL = '你设置的简历文件';
export function resumeLabel(rel) {
  const p = String(rel || '');
  if (!p) return null;
  const name = p.split('/').pop();
  const t = p.match(/^candidate\/resume\/tailored\/([0-9a-f]{16})\//);
  if (t) { const rec = read(`${TAILOR_DIR}/${t[1]}.json`, null); return { file: name, kind: 'tailored', label: `按岗位定制版${rec?.base_version ? `（基于 ${versionLabel(rec.doc_id ? docAt(rec.doc_id) : null, rec.base_version, { lang: true })}）` : ''}` }; }
  const known = fileVersion(p);
  if (known) return { file: name, kind: 'stable', label: known.label };
  return { file: name, kind: 'file', label: name };
}
// 一个文件是哪一份简历的哪一版：某一版的导出记录（或上传的原件）就是这个文件、字节也和那时一样；
// 有导出记录但字节变了（你在同一路径上换了自己的文件）就不算哪一版。没有导出记录的老文件按材料目录里的路径认（rN/vN/、rN/original/）。
export function fileVersion(rel) {
  const p = String(rel || '');
  if (!p) return null;
  let all = docsOrEmpty();
  for (const d of all) {
    const recs = (d.exports || []).filter(e => e.file === p && e.format === 'pdf');
    if (!recs.length) continue;
    const x = recs.find(sameBytes);
    return x ? { doc: d.id, version: x.version, label: versionLabel(d, x.version, { lang: true }) } : null;
  }
  const o = p.match(/^candidate\/resume\/(r\d+)\/(?:original\/|(v\d+)\/)/);
  if (o) { const d = docAt(o[1]), vid = o[2] || 'v1'; return { doc: o[1], version: vid, label: versionLabel(d, d?.versions?.some(x => x.id === vid) ? vid : vid === 'v1' ? { id: 'v1', name: '原简历' } : vid, { lang: true }) }; }
  return null;
}
// 要用的那一版没用上（导不出 PDF、原件不在了……）时，终审信、预填信和运行日志里的那一句。
export const fallbackLine = ({ label, by, why, used }) => `${by === 'you' ? '你选的' : ''}「${label}」没用上（${why || '还没导出 PDF'}），这次上传的是「${used || OWN_FILE_LABEL}」`;
// 终审信、预填信上「这次上传：…」：填表时定下的那一份（resume_pick，lib/auto-apply.mjs），名字和材料页一样带语言
// （「英文 · v4 · Fabrikam 定制版」）；没有它的旧记录照旧按文件路径认（resumeLabel）。f 是 final_review 或 prefill 记录。
export function uploadedResume(f = {}) {
  const old = resumeLabel(f.resume), pick = f.resume_pick;
  if (!pick?.label || !f.resume) return old;
  return { ...(old || {}), file: String(f.resume).split('/').pop(), label: pick.label, by: pick.by === 'you' ? 'you' : 'reacher', ...(pick.version ? { doc: pick.doc, version: pick.version } : {}), ...(f.snapshot?.pdf ? { snapshot: f.snapshot.pdf } : {}), ...(pick.fallback ? { fallback: pick.fallback } : {}) };
}
export const PENDING_TAILOR = '这个岗位还有一份 Writer 定制的简历在「材料」里等你看，这次上传的不是它';
// 终审信、预填信的附注：没用上的那一版、还在等你看的定制版，各一句。
export const resumeNotes = (f = {}, lead = null) => [f.resume_pick?.fallback, lead && tailorPendingFor(lead) ? PENDING_TAILOR : null].filter(Boolean).map(x => `${x}。`).join('');
export const backfillChoices = () => backfill(docs());
// 这个岗位有一份定制版在等你看（终审信里提一句）。
// 旧的定制记录（proposed）只在还没转成「材料」里的定制版时算：迁移把它变成了 Writer 的新版、再转成定制版（lib/resume-store.mjs migrateDoc，
// lib/resume-writer.mjs settleProposals），之后等不等你看，看那一版（accepted / dismissed_at），不再看这条旧记录。
const settledIn = (all, rid, rec) => all.some(d => d.id === rec?.doc_id && ((d.versions || []).some(v => v.by === 'tailor' && (v.lead_ids || []).map(String).includes(rid)) || (d.proposals || []).some(p => p.kind === 'tailor' && String(p.lead_id || '') === rid && String(p.created_at || '') === String(rec.created_at || ''))));
export const tailoredPending = (lead, all = null) => {
  const rid = leadKey(lead), rec = rid ? read(tailorPath(rid), null) : null;
  if (rec?.status !== 'proposed') return false;
  if (!all) all = docsOrEmpty();
  return !settledIn(all, rid, rec);
};

// Tailor 写的求职信、自我介绍（lib/resume-letters.mjs）：你点了「用这封 / 用这段」的才算数。
// 求职信一个岗位一封；自我介绍有通用的（每种语言一段）和针对某个岗位的。
export const LETTER_DIR = 'candidate/resume/letters';
// 对着岗位的：跟 JD 同一种语言的那份就是 letter-<岗位>（已有的信不动）；明确要了另一种语言（jd 是 JD 的语言），另成一份 letter-<岗位>-en / -zh，
// 不和 JD 语言那份抢一个位子（第 6b 轮：要英文信，落在中文那份上把它盖了）。
export const letterKey = ({ kind, rid = null, lang = 'zh', jd = null }) => `${kind === 'self_intro' ? 'intro' : 'letter'}-${rid ? `${tailorKey(rid)}${jd && lang && lang !== jd ? `-${lang}` : ''}` : `generic-${lang}`}`;
export const letterPath = k => `${LETTER_DIR}/${k}.json`;
// 一封信的几版（10-02）：Writer「改一版」写出的新版是另一条记录 <family>-v<n>（family 是第一版的 key），原来那封不动；
// 同一封信里你点了「用这封」的那一版（status:'chosen'，最近点的）才算数。
export const letterFamily = r => String(r?.family || r?.key || '');
export const letterN = r => Number(r?.n) || 1;
const letterRecords = () => { try { return fs.readdirSync(file(LETTER_DIR)).filter(n => /^(letter|intro)-[0-9a-z-]+\.json$/.test(n)).map(n => safeRead(`${LETTER_DIR}/${n}`, null)).filter(r => r?.key); } catch { return []; } }; // 兜底：信的目录还没有就是一封都没有
const usable = r => !!r && String(r.text || '').trim() ? r : null;
// 核对通过的才能用在岗位上（10-03）：投递填表、内推请求、岗位页「换一份」都只认这一条。passed 由 lib/resume-letters.mjs 每次核对时写下；
// 10-03 以前的记录没有 passed，按存下的核对结果算（check.ok）——以前「改过一处整封能用」放进来的那几封，在这里不再算数。
export const letterPassed = (r, lead = null) => !!usable(r) && r.status !== 'failed' && (r.passed !== undefined ? r.passed === true : r.check?.ok === true) && letterMaterialCurrent(r) && (!lead || letterMaterialCurrent(r, { lead }));
// 核对结果绑定岗位当时选用的材料；同一版本原地编辑也会使旧结果失效。这里只读，不导出 PDF。
export function letterMaterial(lead, { pick = pickResume(lead), base = null } = {}) {
  const rid = leadKey(lead);
  if (!rid) return null;
  // 尚未选投递版本的独立写作仍可用已导入的文字；只钉住本次文字版本，不把它冒充附件。
  if (!pick && base) return { record_id: rid, doc: base.doc.id, version: base.id, content_fp: contentFp(base.content), unselected: true };
  if (!pick?.docId || !pick?.vid) return { record_id: rid, doc: null, version: null, content_fp: null, ...(pick?.file ? { file: pick.file, file_sha256: sha(pick.file) } : {}) };
  const doc = readDoc(pick.docId), version = doc.versions.find(v => v.id === pick.vid);
  if (!version) throw fail(409, '选定的简历版本不在了，请重新选择材料');
  return { record_id: rid, doc: doc.id, version: version.id, content_fp: contentFp(version.content) };
}
export function letterMaterialCurrent(rec, { lead = null } = {}) {
  if (!rec?.record_id) return true;
  if (!rec.material) return false; // 旧通过结果没有版本指纹，保留原文，但需按当前材料重新核对。
  try {
    const target = lead || lines('state/leads.ndjson').find(l => leadKey(l) === String(rec.record_id));
    if (!target) return false;
    const pick = pickResume(target), expected = { ...rec.material, record_id: leadKey(target) };
    let base = null;
    if (rec.material.unselected) {
      if (pick) delete expected.unselected;
      else { const doc = readDoc(rec.material.doc), v = doc.versions.find(x => x.id === rec.material.version); if (!v) return false; base = { doc, id: v.id, content: v.content }; }
    }
    return JSON.stringify(letterMaterial(target, { pick, base })) === JSON.stringify(expected);
  } catch (e) { noteSwallowed('resume-letter.material', e, { member: 'tailor', doing: '核对这封信使用的材料', then: '不再复用旧核对结果，等你重新确认材料' }); return false; }
}
const passing = r => letterPassed(r) ? r : null;
const chosenIn = (family, recs = letterRecords()) => recs.filter(r => letterFamily(r) === family && r.status === 'chosen' && passing(r)).sort((a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || '')))[0] || null;
const chosen = k => chosenIn(k);
// 你在岗位页「换一份」里给这个岗位选的那封信（一封信可以给几个岗位用）：candidate/resume/choices/letter-<tailorKey(rid)>.json = { rid, key, by:'you', at }。
export const letterChoicePath = rid => `${CHOICE_DIR}/letter-${tailorKey(rid)}.json`;
const letterChoice = rid => { const c = safeRead(letterChoicePath(rid), null); if (!c || String(c.rid) !== String(rid)) return null; const r = passing(safeRead(letterPath(String(c.key || '')), null)), lead = lines('state/leads.ndjson').find(l => leadKey(l) === String(rid)); return r && lead && letterPassed(r, lead) ? { c, r } : null; };
export const chosenLetter = lead => { const rid = leadKey(lead); if (!rid) return null; return letterChoice(rid)?.r.text || chosen(letterKey({ kind: 'cover_letter', rid }))?.text || null; };
export function chooseLetter(rid, key, { now = Date.now() } = {}) {
  const r = String(rid || '').trim();
  if (!r) throw fail(400, '没说是哪个岗位');
  if (key == null) { fs.rmSync(file(letterChoicePath(r)), { force: true }); return null; }
  const k = String(key);
  const want = /^letter-[0-9a-z-]{4,40}$/.test(k) ? safeRead(letterPath(k), null) : null;
  if (!usable(want)) throw fail(404, '这封信不在了，刷新一下');
  const lead = lines('state/leads.ndjson').find(l => leadKey(l) === r);
  if (!lead || !letterPassed(want, lead)) throw fail(409, '这封核对没过，或与这个岗位所选材料不同，按当前材料改好才能用在岗位上');
  const rec = { rid: r, key: k, by: 'you', at: new Date(now).toISOString() };
  write(letterChoicePath(r), rec);
  return rec;
}
export function chosenIntro(lang = 'zh', lead = null) {
  const own = leadKey(lead) ? chosen(letterKey({ kind: 'self_intro', rid: leadKey(lead) })) : null;
  if (own?.lang === lang) return own.text;
  const generic = chosen(letterKey({ kind: 'self_intro', lang }));
  return generic?.lang === lang ? generic.text : null;
}


// ── 某个岗位用哪一份（设计说明 4.4） ─────────────────────────────────────────────
// 岗位的语言：JD 里中文字多就是中文岗位（lib/application-form.mjs jdLanguage 也用这一条）。
const cjk = s => (String(s).match(/[㐀-鿿぀-ヿ]/g) || []).length;
const latin = s => (String(s).match(/[A-Za-z0-9][A-Za-z0-9'’./+-]*/g) || []).length;
export const jobLanguage = (l = {}) => { const body = [l.jd_text, l.role, l.company].filter(Boolean).join('\n'); return cjk(body) * 2 > latin(body) ? 'zh' : 'en'; };

// 你在岗位页「换一份」里选的：candidate/resume/choices/<tailorKey(rid)>.json = { rid, doc, version, by:'you', at }。
// version 是 null：只选了哪一份简历，投递用那份「现在用的那一版」（lib/resume-store.mjs currentVersionOf，10-03）。
export const CHOICE_DIR = 'candidate/resume/choices';
export const choicePath = rid => `${CHOICE_DIR}/${tailorKey(rid)}.json`;
const BACKFILL = `${CHOICE_DIR}/.backfill.json`;
const safeRead = (rel, dflt = null) => { try { return read(rel, dflt); } catch (e) { noteSwallowed('resume-choice.read', e, { member: 'tailor', doing: `读 ${rel}`, then: '当没有这条记录' }); return dflt; } };
// 工作区里读得出的第 2 版文档（只读，不在这里迁移：没转完的那份先不算，投递照旧用 resume_routing）。
function docs() {
  const out = [];
  for (const d of loadWorkspace().docs || []) { try { const doc = readDoc(d.id); if (!isOld(doc)) out.push(doc); } catch (e) { noteSwallowed('resume.loadDoc', e, { member: 'tailor', doing: `读简历 ${d.id}`, then: '这份先不算，投递照旧用设置里的文件' }); } }
  return out;
}
// 工作区本身读不出来：记一笔，当一份都没有（投递照旧用设置里的 resume_routing）。
function docsOrEmpty() {
  try { return docs(); } catch (e) { noteSwallowed('resume.workspace', e, { member: 'tailor', doing: '读简历工作区', then: '当一份都没有，投递照旧用设置里的文件' }); return []; }
}
const versionIn = (doc, vid) => (doc?.versions || []).find(v => v.id === vid) || null;
// 这一版现成的 PDF：字节和导出时一样、内容指纹对得上（之后改过就不算）；上传的原件（from:'upload'）也一样——
// 每一版都能改了（10-02），v1 改过以后原件就不再是它的内容，改回原样又是。两份都对得上时先用原件。
const sameBytes = x => !!x?.file && !!x.sha256 && sha(x.file) === x.sha256;
// 一条导出记录是不是这一版现在的内容：有内容指纹就只看指纹（改了又撤销，指纹回到原样就还算数）；没有指纹的旧记录看有没有被标过 stale。
// lib/resume-versions.mjs 的 defaultPdfState、usablePdf 用同一条，两处说法不会打架。
export const exportCurrent = (x, fp) => x?.content_fp ? x.content_fp === fp : !x?.stale;
export function readyPdf(doc, v) {
  if (!doc || !v) return null;
  const pdfs = (doc.exports || []).filter(x => x.version === v.id && x.format === 'pdf');
  const fp = contentFp(v.content), ok = pdfs.filter(x => exportCurrent(x, fp) && sameBytes(x));
  return (ok.find(x => x.from === 'upload') || ok.at(-1))?.file || null;
}
// 设置里的投递文件（candidate/facts.yaml resume_routing）：中文岗位看 chinese_pdf，其他看 english_pdf。
const SLOTS = { zh: 'chinese_pdf', en: 'english_pdf' };
export const routingSlot = lang => SLOTS[lang === 'zh' ? 'zh' : 'en'];
const routedIn = (routing, lang) => { const r = routing?.[routingSlot(lang)]; return typeof r === 'string' && r.trim() ? r.trim() : null; };
const currentRouting = () => { try { return readFacts()?.resume_routing || {}; } catch (e) { noteSwallowed('resume-choice.routing', e, { member: 'tailor', doing: '读设置里的投递文件', then: '当没有指定' }); return {}; } };
// resume_routing 指着的文件 rel 和这一版的关系：'own' 就是它导出的（或上传的原件），字节和内容都对得上；
// 'stale' 是它导出的、字节没被动过（或文件不见了），只是这一版之后又改过，可以按新内容刷新同一个文件；
// 'edited' 是上传的原件（from:'upload'）、字节没变，但这一版后来改过：原件不动，投递用这一版自己现导的那份；
// 'other' 不是它的文件，或者字节已经变了（你换上了自己的文件）——系统不碰。上传的原件不见了也算 'other'（不拿模板重排到原件的位置）。
export function routedState(doc, v, rel) {
  const recs = (doc?.exports || []).filter(x => x.version === v?.id && x.format === 'pdf' && x.file === rel);
  if (!recs.length) return 'other';
  const upload = recs.some(x => x.from === 'upload');
  if (!fs.existsSync(file(rel))) return upload ? 'other' : 'stale';
  const ok = recs.filter(sameBytes);
  if (!ok.length) return 'other';
  const fp = contentFp(v.content);
  return ok.some(x => exportCurrent(x, fp)) ? 'own' : upload ? 'edited' : 'stale';
}
// 迁移留在 doc.migrated_choices 里的选择补写成选择记录：只补一次（记在 .backfill.json），你已经选过的不覆盖，你后来清掉的不补回来。
function backfill(all) {
  // 读请求（pickResume）不补写：工作台启动时补一次（backfillChoices，bin/serve.mjs migrateResumes），你在「换一份」里选的时候再补一次。
  const todo = all.flatMap(d => (d.migrated_choices || []).map(c => ({ ...c, doc: c.doc || d.id }))).filter(c => c?.rid && c.version);
  if (!todo.length) return;
  const mark = safeRead(BACKFILL, null) || { done: [] }, done = new Set(mark.done || []);
  let changed = false;
  for (const c of todo.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))) {
    const key = `${c.doc}:${c.rid}:${c.version}`;
    if (done.has(key)) continue;
    done.add(key); changed = true;
    if (safeRead(choicePath(c.rid), null)) continue;
    write(choicePath(c.rid), { rid: String(c.rid), doc: c.doc, version: c.version, by: 'you', at: c.at || new Date().toISOString() });
  }
  if (changed) write(BACKFILL, { done: [...done] });
}
// 这个岗位有一份定制版在等你看：还没点「用这版」的定制版（accepted:false，10-02；你在「换一份」里另选了一份就不算），
// 旧数据里 Writer 的定制新版（ready），或者旧的定制记录（proposed）。
export const tailorWaiting = v => v?.by === 'tailor' && v.accepted === false && !v.dismissed_at;
const waiting = (all, rid) => all.some(d => d.versions.some(v => tailorWaiting(v) && (v.lead_ids || []).map(String).includes(rid)));
const pendingIn = (all, rid) => waiting(all, rid) || all.some(d => (d.proposals || []).some(p => p.kind === 'tailor' && String(p.lead_id || '') === rid && p.status === 'ready'));
// { docId, vid, by:'you'|'reacher', label, file, pending_tailor, step:'choice'|'tailored'|'default' } 或 null（一份都找不到）。
// file 是这一版现成的 PDF；还没导出（或者改过以后没再导）就是 null，投递前由 lib/resume-versions.mjs preparePick 现导。
export function pickResume(lead, { lang = jobLanguage(lead || {}), routing = null } = {}) {
  const rid = leadKey(lead);
  let all = docsOrEmpty();
  const pending_tailor = !!rid && (pendingIn(all, rid) || tailoredPending(lead, all));
  const out = (doc, v, by, step) => ({ docId: doc.id, vid: v.id, by, label: versionLabel(doc, v, { lang: true }), file: readyPdf(doc, v), pending_tailor, step });
  if (rid) {
    // 1. 你选的（指着的简历或版本已经不在了：当没选）。
    const c = safeRead(choicePath(rid), null);
    if (c && String(c.rid) === rid) { const doc = all.find(d => d.id === c.doc), v = c.version ? versionIn(doc, c.version) : doc ? currentVersionOf(doc) : null; if (v) return { ...out(doc, v, 'you', 'choice'), ...(c.version ? {} : { whole_doc: true }) }; }
    // 2. 为这个岗位做的、你点过「用这版」的定制版，最新的。还没点的（accepted:false）不算：照旧用默认投递那一版。
    const mine = all.flatMap(d => d.versions.filter(v => v.by === 'tailor' && v.accepted !== false && (v.lead_ids || []).map(String).includes(rid)).map(v => ({ d, v })))
      .sort((a, b) => String(b.v.created_at || '').localeCompare(String(a.v.created_at || '')) || (b.v.n || 0) - (a.v.n || 0));
    if (mine.length) return out(mine[0].d, mine[0].v, 'reacher', 'tailored');
    // 旧的定制记录（迁移前「按岗位定制」里选用的那份）：文件还在、没被动过才算。
    const old = chosenTailored(lead);
    if (old) return { docId: old.doc_id || null, vid: null, by: 'reacher', label: resumeLabel(old.file)?.label || '按岗位定制版', file: old.file, pending_tailor, step: 'tailored' };
  }
  // 3. 默认投递里和 JD 同语言的那一版；缺这种语言用另一种。设置里这种语言有投递文件（resume_routing）时，传的就是那个文件：
  //    它就是这一版自己导出的（或上传的原件）、字节没变才算这一版；内容改过就由 preparePick 刷新同一个文件；
  //    别的（你自己放的文件、你在同一路径上换过的文件）原样上传，不拿另一种语言的那一版顶上。
  if (!all.length) return null; // 还没有「材料」（或还没转换完）：投递照旧用 resume_routing（lib/application-form.mjs resumePick）
  const found = {};
  for (const d of all) for (const v of d.versions) if (v.default_for && !found[v.default_for]) found[v.default_for] = { d, v };
  let routed = routedIn(routing ?? currentRouting(), lang), routing_missing = null;
  // 设置里的投递文件不在了（10-04：从命令行版导进来时没带过来）：不让投递失败，也不悄悄现导一份顶上——当没设，
  // 用默认投递那一版（和原件一字不差就是原件）；routing_missing 给材料页说一句。
  if (routed && !fs.existsSync(file(routed))) { routing_missing = { slot: routingSlot(lang), file: routed }; routed = null; }
  const hit = found[lang] || (routed ? null : found[lang === 'zh' ? 'en' : 'zh']);
  if (!routed) return hit ? { ...out(hit.d, hit.v, 'reacher', 'default'), ...(routing_missing ? { routing_missing } : {}) } : null;
  if (hit) {
    const st = routedState(hit.d, hit.v, routed);
    if (st === 'own') return { ...out(hit.d, hit.v, 'reacher', 'default'), file: routed };
    if (st === 'stale') return { ...out(hit.d, hit.v, 'reacher', 'default'), file: null };
    if (st === 'edited') return out(hit.d, hit.v, 'reacher', 'default'); // 这一版自己现导的那份（还没导就是 null，投递前现导）
  }
  const known = fileVersion(routed);
  return { docId: known?.doc || null, vid: known?.version || null, by: 'reacher', label: resumeLabel(routed)?.label || OWN_FILE_LABEL, file: routed, pending_tailor, step: 'default', routing: true };
}
// 你在岗位页「换一份」里选一份（v1 也行），或者传 null 清掉、回到让 Reacher 选。返回写下的记录（清掉时 null）。
export function chooseResume(rid, sel, { now = Date.now() } = {}) {
  const r = String(rid || '').trim();
  if (!r) throw fail(400, '没说是哪个岗位');
  try { backfill(docs()); } catch (e) { noteSwallowed('resume-choice.backfill', e, { member: 'tailor', doing: '补写旧的选择记录', then: '下次再补' }); }
  if (sel == null) { fs.rmSync(file(choicePath(r)), { force: true }); return null; }
  const doc = readDoc(String(sel.doc || ''));
  if (isOld(doc)) throw fail(503, '简历数据还没转换完成，稍后再试', 'MIGRATION');
  if (sel.version != null && !versionIn(doc, String(sel.version || ''))) throw fail(404, '没有这一版');
  const rec = { rid: r, doc: doc.id, version: sel.version == null ? null : String(sel.version), by: 'you', at: new Date(now).toISOString() };
  // 还在等你点「用这版」的定制版（10-02）：选的就是它 → 记为用了；选了别的 → 那几封信收起（dismissed_at），以后做的新定制版照常来信。
  // 先记版本上的标记、再写选择：别处刚存过这份简历（STALE）就重读再来；还是存不进去就照实报错，不悄悄留下一封收不起来的信。
  for (const d0 of docs()) {
    for (let i = 0; ; i++) {
      const d = i ? readDoc(d0.id) : d0;
      let changed = false;
      for (const v of d.versions) {
        if (!tailorWaiting(v) || !(v.lead_ids || []).map(String).includes(r)) continue;
        if (d.id === rec.doc && v.id === rec.version) v.accepted = true; else v.dismissed_at = rec.at;
        changed = true;
      }
      if (!changed) break;
      try { saveDoc(d); break; } catch (e) { if (e.code !== 'STALE' || i >= 4) throw fail(500, `没选成：${String(e.message).slice(0, 120)}`); }
    }
  }
  write(choicePath(r), rec);
  return rec;
}
// 终审信用：这个岗位有没有一份定制版在等你看（和 pickResume 的 pending_tailor 同一条规矩）。
export function tailorPendingFor(lead) {
  const rid = leadKey(lead);
  if (!rid) return false;
  let all = docsOrEmpty();
  return pendingIn(all, rid) || tailoredPending(lead, all);
}

// ── 岗位页「材料」标签（web/hq.js matHtml，QA 第 2 轮新 5）──────────────────────────────
// 投递会用哪一份只有一个说法（pickResume）：{ doc, version, label, by }；这个岗位的定制版（新的在前）各标 waiting（等你确认）/ in_use（在用）/ idle；
// 「换一份」里的其他各版（别的岗位的定制版不列）；求职信：这个岗位用哪一封（current），可以换成哪一封（options，这个岗位的在前）。
const letterTitle = r => `${r.record_id ? `#${r.number ?? '—'} ${coName(r.company)}`.trim() : r.lang === 'en' ? '通用 · 英文' : '通用 · 中文'}${letterN(r) > 1 ? ` · 第 ${letterN(r)} 版` : ''}`;
function letterUses(key, recs, choices) {
  const rec = recs.find(r => r.key === key), rids = new Set(choices.filter(c => c.key === key).map(c => String(c.rid)));
  if (rec?.record_id && chosenIn(letterFamily(rec), recs)?.key === key && !choices.some(c => String(c.rid) === String(rec.record_id))) rids.add(String(rec.record_id));
  return rids.size;
}
export function leadMaterials(lead) {
  const rid = leadKey(lead);
  let all = docsOrEmpty();
  let p = null;
  try { p = pickResume(lead || {}); } catch (e) { noteSwallowed('resume-choice.pick', e, { member: 'tailor', doing: '看这个岗位投递会用哪一份', then: '岗位页先不标「在用」' }); }
  const pick = p ? { doc: p.docId, version: p.vid, label: p.label, by: p.by, ...(p.whole_doc ? { whole_doc: true } : {}) } : null;
  const isPick = (d, v) => !!pick && pick.doc === d.id && pick.version === v.id;
  const tailored = all.flatMap(d => d.versions.filter(v => v.by === 'tailor' && rid && (v.lead_ids || []).map(String).includes(rid)).map(v => ({ d, v })))
    .sort((a, b) => String(b.v.created_at || '').localeCompare(String(a.v.created_at || '')) || (b.v.n || 0) - (a.v.n || 0))
    .map(({ d, v }) => ({ doc: d.id, version: v.id, label: versionLabel(d, v, { lang: true }), state: isPick(d, v) ? 'in_use' : tailorWaiting(v) ? 'waiting' : 'idle' }));
  const others = all.flatMap(d => [...d.versions].filter(v => v.by !== 'tailor' && !v.draft).sort((a, b) => (b.n || 0) - (a.n || 0)).map(v => ({ doc: d.id, version: v.id, label: `${d.title} · ${versionLabel(d, v)}`, default_for: v.default_for || null, in_use: isPick(d, v) })));
  // 求职信
  const recs = letterRecords(), covers = recs.filter(r => r.kind === 'cover_letter' && usable(r));
  let choices = [];
  try { choices = fs.readdirSync(file(CHOICE_DIR)).filter(n => /^letter-[0-9a-f]{16}\.json$/.test(n)).map(n => safeRead(`${CHOICE_DIR}/${n}`, null)).filter(c => c?.rid && c.key); } catch {} // 兜底：选择记录的目录还没有就是没选过
  const ownFamily = rid ? letterKey({ kind: 'cover_letter', rid }) : null, mine = letterChoice(rid);
  const ownChosen = ownFamily ? chosenIn(ownFamily, recs) : null;
  const ownLatest = ownFamily ? covers.filter(r => letterFamily(r) === ownFamily).sort((a, b) => letterN(b) - letterN(a))[0] || null : null;
  const cur = mine?.r || ownChosen || ownLatest;
  const stateOf = r => (mine ? mine.r.key === r.key : r.status === 'chosen' && ownChosen?.key === r.key) ? 'in_use' : !letterPassed(r, lead) ? 'failed' : r.status === 'declined' ? 'idle' : 'waiting';
  const show = r => ({ key: r.key, title: letterTitle(r), by: r.by === 'user' ? 'you' : 'writer', state: stateOf(r), uses: letterUses(r.key, recs, choices) });
  const current = cur ? { ...show(cur), by: mine ? 'you' : 'reacher', state: stateOf(cur) } : null;
  const options = covers.sort((a, b) => (letterFamily(b) === ownFamily) - (letterFamily(a) === ownFamily) || String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 12).map(show);
  // 简历文件（「换一份」先选哪一份，用它现在用的那一版）：默认投递的那份在前。
  const files = all.map(d => { const cv = currentVersionOf(d); return { doc: d.id, title: d.title, lang: d.lang, current: cv?.id || null, label: cv ? `${d.title} · 现在用 ${cv.id}` : d.title, default_for: d.versions.find(v => v.default_for)?.default_for || null, on: !!pick?.whole_doc && pick.doc === d.id }; })
    .sort((a, b) => !!b.default_for - !!a.default_for);
  return { pick, files, tailored, others, letters: { current, options } };
}
