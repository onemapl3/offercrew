// 材料 · 对话接入（F4，设计说明 3.5 / 4.2 / 5.4）：在全局对话里跟 Writer 说简历的事。
//
//   正在看   材料页开着一版简历时，面板把 { doc, version, selection } 放进 focus.resume 发过来（web/talk.js）；
//            resumeFocus 只认这台机器上真有的那一份、那一版，选中的只留这一版里的正文条目行。认不出就当没带，不报错。
//   交给 Writer 的话先分三类（writerIntent）：体检 → checkUp；改一句（选中了几行说「这几行…」，或点名了哪一段）→ editLines；
//            改一版（含「按 #521 定制一份」）→ startRewrite。其余的照旧聊天，只是用 Writer 自己的身份、带着这一版简历（resumeBrief）。
//   跑模型的活在后台做：对话里先是一张「在做」的任务卡，做完变成 Writer 的一句话和按钮（writerTask）：
//            体检 → 列出几条，末尾「按这几条改一版」；改一句 → 「改好了，简历上标黄的那句。」和「撤销」；
//            改一版 / 定制（10-02）→ 先问（kind:'ask'）：2–4 个问题，带选项和自己补一句的框，一个「开始改」（没答的算跳过）；
//            答了（或跳过）才开一条 kind:'rewrite'：在做 → 做完是一张版本卡片（card：哪一版、改了几处），「打开」和小的「和上一版对比」。
//            模型用不了时照实说原因（沙盒、没配好），不假装做了；同一段对话里只说一次原因（输入框上的黄条已经说了，QA 第 2 轮 #34）。
//   按钮（writerButton）：撤销只撤 Writer 那一步（lib/resume-versions.mjs undo 带 change_id；那几行后来又改过就不撤，说清楚）；
//            按这几条改一版把体检的几条当要求，也是先问；「开始改」交给 startRewrite。打开、对比只是换页，不经服务端。
//   体检、改一句、先问做完的结果记在 state/writer-talk.json（按消息 id）；改一版的状态直接看 doc.proposals。
import { coName } from './vocab.mjs';
import crypto from 'node:crypto';
import { read, write, lines as readLines } from './store.mjs';
import { DOC_ID, loadDoc, loadWorkspace, tidyName } from './resume-store.mjs';
import { versionLabel } from './resume-label.mjs';
import { lineIndex, entryName } from './resume-doc.mjs';
import { undo, defaultVersion, lineProblems } from './resume-versions.mjs';
import { startCheck, startEdit, startRewrite, askQuestions, answersInstruction, recordAnswers, track, unappliedEdits } from './resume-writer.mjs';
import { leadKey, letterKey, letterPath } from './resume-choice.mjs';
import { jdLang } from './resume-tailor.mjs';
import { letterView, letterQuestions, startReviseLetter, letterBusy, writeLetter, letterGate, KIND_WORD, jdLang as letterLang } from './resume-letters.mjs';
import { crewName } from './crew.mjs';
import { errorReason as sayReason, modelErrorKind } from './say-error.mjs';
import { noteSwallowed } from './swallow.mjs';
// 原因只说人话：「模型这次没成功：fetch failed」这种（信、定制那几处拼的）后面那段原样的英文报错，认得出的换成表里那一句（网络不通），认不出的去掉。
const errorReason = e => {
  const r = sayReason(e), m = /^(.*[一-龥])[：:]\s*([^一-龥]+)$/.exec(r);
  if (!m) return r;
  const k = modelErrorKind(m[2]);
  return k.kind === 'other' ? m[1] : k.text;
};

const clean = (s, max = 400) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ── 正在看 ───────────────────────────────────────────────────────────────────
// → { doc, version, name, title, lang, selection, read_only } | null
export function resumeFocus(f) {
  if (!f || typeof f !== 'object') return null;
  const docId = String(f.doc || ''), vid = String(f.version || '');
  if (!DOC_ID.test(docId) || !/^v\d{1,4}$/.test(vid)) return null;
  let doc;
  try { doc = loadDoc(docId); } catch { return null; } // 兜底：这份简历已经删了或读不出，当没有这个对象
  const v = (doc.versions || []).find(x => x.id === vid);
  if (!v) return null;
  const idx = lineIndex(v.content || {});
  const selection = [...new Set((Array.isArray(f.selection) ? f.selection : []).map(String))].filter(id => idx.get(id)?.role === 'line').slice(0, 40);
  return { doc: doc.id, version: v.id, name: tidyName(v.name), title: doc.title || '', lang: doc.lang || null, selection, read_only: false }; // 每一版都能改（10-02）
}

// 没有「正在看」时 Writer 改哪一版：手上那份简历（材料页最近打开的）的默认投递那一版，没有就最新的一版（设计说明 4.2）。
export function writerTarget(rf = null) {
  if (rf) return rf;
  const ws = loadWorkspace(), ids = (ws.docs || []).map(d => d.id);
  const id = ids.includes(ws.active) ? ws.active : ids[0];
  if (!id) return null;
  let doc;
  try { doc = loadDoc(id); } catch { return null; } // 兜底：这份简历已经删了或读不出，当没有
  const v = doc.versions.find(x => x.default_for) || [...doc.versions].sort((a, b) => b.n - a.n)[0];
  return v ? { doc: doc.id, version: v.id, name: tidyName(v.name), title: doc.title || '', lang: doc.lang || null, selection: [], read_only: false } : null;
}
export function defaultWriterTarget(lang) {
  const v = defaultVersion(lang);
  return v ? resumeFocus({ doc: v.docId, version: v.vid }) : null;
}
export const targetContent = t => { try { return loadDoc(t.doc).versions.find(v => v.id === t.version)?.content || null; } catch { return null; } }; // 兜底：这份简历已经删了或读不出，当没有内容
export const targetLabel = t => `简历 ${versionLabel(null, { id: t.version, name: t.name })}`;

// 这句话是不是 Writer 的活、是哪一种：lib/intent.mjs（4a）。这里转出去，老的调用方不用改；点名的那几行要看简历内容，在这里对。
import { wantsWriter, writerIntent as writerIntentOf, rewriteWish, writerAsk, letterAsk } from './intent.mjs';
export { wantsWriter, rewriteWish, writerAsk, letterAsk };
export const writerIntent = (text, { selection = [], content = null } = {}) => writerIntentOf(text, { selection, named: t => namedLines(t, content) });
// 点名了哪一段、哪一节（「Photo Book 第一句」「技能那行」）：那几行。
const SECTION_WORDS = { summary: ['简介', '概述', '总结', 'summary'], skills: ['技能', 'skills'], experience: ['工作经历', 'experience'], projects: ['项目经历', 'projects'], education: ['教育', 'education'] };
export function namedLines(text, content) {
  const t = String(text || '').toLowerCase(), out = [];
  for (const s of content?.sections || []) {
    const words = [s.title?.text, ...(SECTION_WORDS[s.kind] || [])].filter(w => w && String(w).trim().length >= 2).map(w => String(w).toLowerCase());
    const sectionHit = words.some(w => t.includes(w));
    for (const e of s.entries || []) {
      const name = entryName(e).toLowerCase();
      if (sectionHit || (name.length >= 2 && t.includes(name))) out.push(...(e.lines || []).map(l => l.id));
    }
  }
  return [...new Set(out)].slice(0, 40);
}

// ── 开工：先回一张「在做」的卡，结果在后台记下 ────────────────────────────────────
const STORE = 'state/writer-talk.json';
export const writerResults = () => { try { return read(STORE, {}) || {}; } catch (e) { noteSwallowed('writer-talk.results', e, { member: 'tailor', doing: '读对话里 Writer 的结果记录', then: '先当没有，之前的结果卡可能显示不出' }); return {}; } };
function remember(mid, rec) {
  const all = writerResults();
  all[mid] = { ...(all[mid] || {}), ...rec };
  const keys = Object.keys(all);
  if (keys.length > 300) for (const k of keys.sort((a, b) => String(all[a].at || '').localeCompare(String(all[b].at || ''))).slice(0, keys.length - 300)) delete all[k];
  write(STORE, all);
  for (const fn of resultHooks) try { fn(mid); } catch (e) { console.error(`[writer] 记下结果之后的记账出错：${e.message}`); }
}
// Writer 一条消息的结果记下来以后要做的事（lib/task-writer.mjs：把卡的那件活记成做完 / 没做成 / 等你答）。
const resultHooks = new Set();
export const onWriterResult = fn => { resultHooks.add(fn); };
const mid = () => crypto.randomBytes(6).toString('hex');
const findLead = n => { try { return readLines('state/leads.ndjson').filter(l => l.number === n && !l.superseded).at(-1) || null; } catch { return null; } };
const leadRef = l => ({ number: l.number, company: coName(l.company), role: String(l.role || ''), rid: leadKey(l) });
// 按岗位定制、没有「正在看」时以哪一版为底：和岗位同语言的默认投递那一版（没有就另一种语言的）。
export function tailorTarget(lead) {
  const d = defaultVersion(jdLang(lead || {}));
  if (!d) return null;
  try { const doc = loadDoc(d.docId), v = doc.versions.find(x => x.id === d.vid); return v ? { doc: doc.id, version: v.id, name: tidyName(v.name), title: doc.title || '', lang: doc.lang || null, selection: [], read_only: false } : null; } catch { return null; } // 兜底：这份简历已经删了或读不出，当没有
}
// → 一条 Writer 消息的字段（id 已定好）：{ id, kind:'writer', content, writer:{ kind, doc, version, name, … } }，或者一句直接的回话 { content }。
export async function writerStart({ intent, target, text = '', instruction = null }, { model = null, now = Date.now() } = {}) {
  if (!target) return { content: '还没有简历：先在「材料」里上传一份。' };
  const opts = model ? { model } : {}, id = mid(), at = new Date(now).toISOString();
  const base = { doc: target.doc, version: target.version, name: target.name };
  if (intent.kind === 'need_selection') return { content: '先在简历上选中你说的那几行，再说一次。' };
  if (intent.kind === 'check') {
    const r = startCheck({ docId: target.doc, vid: target.version, instruction: text }, { ...opts, onDone: r => remember(id, { kind: 'check', status: r.status === 'ready' ? 'done' : 'failed', items: r.items || [], rewrite: r.rewrite || null, from: r.from || null, note: r.note || null, reason: r.reason || null, at: new Date().toISOString() }) });
    // 连点「体检」：这一版的体检还在做，不再开一次（QA 第 2 轮 #34），结果出在上面那张卡上。
    if (r.busy) return { content: '还在体检这一版，做完就出在上面。' };
    return { id, kind: 'writer', content: '', writer: { kind: 'check', ...base, instruction: text } };
  }
  if (intent.kind === 'edit') {
    const want = clean(text, 500);
    const r = startEdit({ docId: target.doc, vid: target.version, line_ids: intent.line_ids || [], instruction: want }, { ...opts, onDone: x => remember(id, { kind: 'edit', status: x.status, change_id: x.change_id || null, from_vid: x.from_vid, to_vid: x.to_vid, line_ids: x.line_ids || [], question: x.question || null, reason: x.reason || null, at: new Date().toISOString() }) });
    return { id, kind: 'writer', content: '', writer: { kind: 'edit', ...base, job: r.job, line_ids: intent.line_ids || [], instruction: want } };
  }
  // 改一版、定制（10-02）：先问。问题在后台想（要跑模型），想好了出在这张卡上；你答完（或跳过）才改（writerButton）。
  if (intent.kind === 'rewrite') {
    let lead = null;
    if (intent.number != null) { lead = findLead(intent.number); if (!lead) return { content: `表上没有 #${intent.number}，没法按它定制。` }; }
    const want = clean(instruction ?? rewriteWish(text), 480);
    track(`ask:${target.doc}/${id}`, askQuestions({ docId: target.doc, vid: target.version, instruction: want, lead_id: lead ? leadKey(lead) : null }, opts)
      .catch(e => ({ status: 'failed', reason: errorReason(e) }))
      .then(r => remember(id, { kind: 'ask', status: r.status === 'ready' ? 'done' : r.status, questions: r.questions || [], reason: r.reason || null, at: new Date().toISOString() })));
    return { id, kind: 'writer', content: '', writer: { kind: 'ask', ...base, instruction: want, ...(lead ? { lead: leadRef(lead) } : {}) } };
  }
  return { content: '' };
}
// 信 / 自我介绍「改一版」（10-02，和简历同一种页面）：先问（固定的几句，不跑模型，当场就有），答完写成这封信的新一版。
export function writerLetterStart({ key }, { now = Date.now() } = {}) {
  let view;
  try { view = letterView(key); } catch (e) { return { content: errorReason(e) }; }
  const id = mid(), at = new Date(now).toISOString();
  remember(id, { kind: 'ask', status: 'done', questions: letterQuestions(key), at });
  const lead = letterLead(view);
  return { id, kind: 'writer', content: '', writer: { kind: 'letter_ask', letter: key, title: view.letter.title, ...(lead ? { lead } : {}) } };
}
// 这封信对着哪个岗位（通用的没有）：改信的活也记上岗位，任务目录和卡片头上照别的活一样带编号。
function letterLead(view) {
  const l = view?.letter;
  return l?.record_id ? { number: l.number ?? null, company: coName(l.company), role: String(l.role || ''), rid: String(l.record_id) } : null;
}
export const leadOfLetter = key => { try { return letterLead(letterView(key)); } catch { return null; } }; // 兜底：信的记录不在就没有对应的岗位
export function letterRewriteMessage({ key, title, instruction, lead = undefined }, { model = null, now = Date.now() } = {}) {
  const id = mid(), l = lead === undefined ? leadOfLetter(key) : lead;
  startReviseLetter({ key, instruction }, model ? { model, now } : { now }).then(r => remember(id, { kind: 'letter_rewrite', status: r.status, key: r.key || null, n: r.n || null, problems: r.problems || [], flags: r.flags ?? null, ...(r.blocked ? { blocked: r.blocked, retried: !!r.retried } : {}), reason: r.reason ? errorReason(r.reason) : null, at: new Date().toISOString() }));
  return { id, kind: 'writer', content: '', writer: { kind: 'letter_rewrite', letter: key, title, instruction, ...(l ? { lead: l } : {}) } };
}
export const letterHref = key => `#materials/letter?key=${encodeURIComponent(key)}`;
// 对话里说「给 #521 写封求职信」「写一段英文自我介绍」（L 线 10-02）：Writer 自己写（lib/resume-letters.mjs writeLetter，逐句核对出处），
// 不再开那张没人接的卡。在做 → 写好了是一张信的卡片和「打开」；核对没过照实写，模型用不了说原因。
// 已经有这封、话里是「改」的：照「改一版」先问几句（writerLetterStart，改的是这封信里你选用的那一版，没有就是最新的一版）。
// lead：编号对上的那一条（求职信必须有）；lang：你在话里说的语言（「英文求职信」）。
// 写哪种语言（第 6 轮：明确要英文，第一版却是中文——以前对着岗位时一律跟 JD 走，你说的语言被丢了）：你说了就照你说的；
// 没说：对着岗位的跟 JD 的语言走（lib/resume-letters.mjs jdLang），没对着岗位的写中文。
export const letterLanguage = ({ lang = null, lead = null } = {}) => (lang === 'en' || lang === 'zh' ? lang : lead ? letterLang(lead) : 'zh');
export function writerLetterTurnFor({ kind, lead = null, lang = null, revise = false }, { model = null, now = Date.now() } = {}) {
  if (kind === 'cover_letter' && !lead) return { content: '求职信要对着一个岗位写：告诉我是哪一条，比如「给 #12 写封求职信」。' };
  const record_id = lead ? leadKey(lead) : null, language = letterLanguage({ lang, lead });
  const base = letterKey({ kind, rid: record_id, lang: language, jd: lead ? letterLang(lead) : null });
  let have = null;
  try { have = letterView(base); } catch {} // 兜底：还没有这封信就是 null
  if (have && revise) {
    const pick = have.family.find(x => x.status === 'chosen') || have.family.at(-1);
    return writerLetterStart({ key: pick?.key || base }, { now });
  }
  const id = mid(), title = `${KIND_WORD[kind]} · ${lead ? `#${lead.number ?? '—'} ${coName(lead.company)}`.trim() + (language === 'en' ? ' · 英文' : ' · 中文') : language === 'en' ? '通用 · 英文' : '通用 · 中文'}`;
  track(`letter:${id}`, writeLetter({ kind, record_id, lang: language, now, ...(model ? { model } : {}) })
    .catch(e => ({ status: e.status === 409 ? 'busy' : 'failed', error: errorReason(e) }))
    .then(r => { let problems = 0; try { const rec = read(letterPath(r.key), null); problems = rec ? letterGate(rec).flags.length : 0; } catch {} remember(id, { kind: 'letter_write', status: r.status, key: r.key || null, problems, ...(r.blocked ? { blocked: r.blocked, retried: !!r.retried } : {}), reason: r.error && !r.blocked ? errorReason(r.error) : null, at: new Date().toISOString() }); })); // 兜底：数不出问题条数就按 0，信本身已经存好了
  return { id, kind: 'writer', content: '', writer: { kind: 'letter_write', letter_kind: kind, title, ...(lead ? { lead: leadRef(lead) } : {}), lang: language } };
}
// 答完（或跳过）：开一条改一版 / 定制，做完存成新的一版。
export async function rewriteMessage({ target, instruction, lead = null }, { model = null, now = Date.now() } = {}) {
  const opts = model ? { model } : {}, id = mid(), base = { doc: target.doc, version: target.version, name: target.name };
  let r;
  try { r = await startRewrite({ docId: target.doc, vid: target.version, instruction, lead_id: lead?.rid || null }, opts); }
  catch (e) { return { content: `没改成：${errorReason(e)}`, error_reason: true, bad: true }; }
  // 同一份简历同时只跑一条：在跑的不管是别的事、还是同一种活（另一张卡的改一版），都照实说在做什么，这张卡的回答不并进那一条，
  // 卡片还能再答（busy：writerButton 不记「答过了」）。
  if (r.busy) {
    const p = (loadDoc(target.doc).proposals || []).find(x => x.id === r.proposal_id) || {};
    return { content: `我还在做${r.kind === 'tailor' ? ` ${p.company || '一个岗位'} 的定制版` : ` ${p.base_version || '另一版'} 的新版`}，做完再按这次的回答改，上面的回答都还在。`, busy: true };
  }
  // run：这条消息开的是哪一次（那条记录的开工时间）。记录以后被别的一次接着用了（0.1.2 以前会），这条照自己那一次算（taskOf）。
  let run = null; try { run = (loadDoc(target.doc).proposals || []).find(x => x.id === r.proposal_id)?.started_at || null; } catch {} // 兜底：记录读不出就不标是哪一次
  return { id, kind: 'writer', content: '', writer: { kind: 'rewrite', ...base, proposal_id: r.proposal_id, ...(run ? { run } : {}), instruction, ...(lead ? { lead } : {}) } };
}

// ── 对话里的任务卡：在做 → 做完（Writer 的一句话和按钮）─────────────────────────────
const STALE_MS = 15 * 60000;
// 没记 run 的旧消息：消息和它开的那一次几乎同时（先开工，再记消息）；记录的开工时间比消息晚这么多，就是后来别的一次（taskOf）。
const RERUN_SLACK_MS = 60000;
// 先问的卡片上只有一个按钮（OOBE 第 4 轮：「就这样改」「直接改」分不清）：答了的照答的改，没答的算跳过。
const START = '开始改';
const numbered = items => items.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
const clicked = (s, m, kind) => (s?.messages || []).some(x => x.role === 'user' && x.action?.message_id === m.id && x.action.kind === kind);
export const editHref = (doc, vid) => `#materials/edit?doc=${encodeURIComponent(doc)}&v=${encodeURIComponent(vid)}`;
export const compareHref = (doc, a, b) => `#materials/compare?doc=${encodeURIComponent(doc)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
function titleOf(w) {
  if (w.kind === 'letter_ask' || w.kind === 'letter_rewrite') return `改一版 · ${w.title || '信'}`;
  if (w.kind === 'letter_write') return `写${w.title || '信'}`;
  const where = targetLabel(w);
  if (w.kind === 'check') return `体检 · ${where}`;
  if (w.kind === 'edit') return `改${w.line_ids?.length ? ` ${w.line_ids.length} 行` : '一句'} · ${where}`;
  if (w.lead) return `按 #${w.lead.number} ${w.lead.company} 定制 · 以 ${w.version} 为底`;
  return `改一版 · ${where}`;
}
// 模型用不了的原因，一段对话里只说一次（输入框上的黄条已经说了，QA 第 2 轮 #34）：第一条说清原因，后面的只说没做成。
const NO_MODEL_SHORT = '模型用不了，没改。';
const proposalOf = (w, cache) => { const k = w.doc; if (!cache.has(k)) { try { cache.set(k, loadDoc(k)); } catch { cache.set(k, null); } } return (cache.get(k)?.proposals || []).find(x => x.id === w.proposal_id) || null; };
function saidNoModel(x, results, cache) {
  const w = x.writer || {}, r = results[x.id];
  if (w.kind === 'check') return r?.from === 'rules' && !!r.note;
  if (w.kind === 'edit' || w.kind === 'ask' || w.kind === 'letter_rewrite' || w.kind === 'letter_write') return r?.status === 'unavailable';
  if (w.kind === 'rewrite') { const p = proposalOf(w, cache); return p?.status === 'failed' && !!p.unavailable; }
  return false;
}
const noModelBefore = (m, s, results) => { const cache = new Map(); for (const x of s?.messages || []) { if (x.id === m.id) return false; if (x.kind === 'writer' && saidNoModel(x, results, cache)) return true; } return false; };
// 没做成（T1，方案-任务即对话.md 第六节）：卡上带「看原因」「再试一次」。why：{ reason（人话的原因）, retry（换一次可能会好）}。
// 模型用不了（沙盒、没配好、钥匙失效）的不带：换一次也不会好，输入框上的黄条已经说了。同一件连着 MAX_TRIES 次没成，只留「看原因」。
// 同一件：最早那条，加上「再试一次」开出来的、writer.retry_of 指向它的那几条。
export const MAX_TRIES = 3;
export function writerTries(m, s, opts = {}) {
  const origin = m.writer?.retry_of || m.id, chain = (s?.messages || []).filter(x => x.kind === 'writer' && (x.id === origin || x.writer?.retry_of === origin));
  return { origin, chain, failed: chain.filter(x => taskOf(x, s, opts)?.why).length };
}
// → 任务卡（和 lib/talk.mjs sessionTasks 的一样的形状，多 writer / buttons / items / questions / card）。
export function writerTask(m, s, opts = {}) {
  const t = taskOf(m, s, opts);
  if (!t?.why?.retry) return t;
  const { chain, failed } = writerTries(m, s, opts), later = chain.some(x => Date.parse(x.at) > Date.parse(m.at) && x.id !== m.id);
  t.buttons.push({ kind: 'resume_why', label: '看原因', used: clicked(s, m, 'resume_why') });
  if (failed < MAX_TRIES) t.buttons.push({ kind: 'resume_retry', label: '再试一次', used: later || clicked(s, m, 'resume_retry') });
  return t;
}
function taskOf(m, s, { results = writerResults(), now = Date.now() } = {}) {
  const w = m.writer || {};
  const t = { id: `writer:${m.id}`, anchor: m.id, kind: 'writer', persona: 'tailor', title: titleOf(w), since: m.at, updated_at: m.at, status: 'running', detail: '', result: null, evidence: null, evidence_files: [], steps: [], fire_at: null, attempts: 0, behind: false, can_withdraw: false, ask: null, answer: null, reply_id: null, leads: w.lead ? [{ number: w.lead.number, rid: w.lead.rid, company: w.lead.company, role: w.lead.role || '' }] : [], writer: { kind: w.kind, doc: w.doc, version: w.version, from: w.version }, buttons: [], items: null, questions: null, card: null, bad: false };
  const gone = () => now - (Date.parse(m.at) || 0) > STALE_MS;
  const noModel = reason => noModelBefore(m, s, results) ? NO_MODEL_SHORT : `现在用不了模型：${errorReason(reason)}`;
  // 模型用不了（没配、钥匙失效）：换一次也不会好，尾上给「设置模型」，点了到配模型的地方。沙盒里不给（演示数据不接模型）。
  const unavailable = reason => { Object.assign(t, { result: noModel(reason), bad: true, why: { reason: errorReason(reason), retry: false } }); if (!/沙盒/.test(errorReason(reason))) t.buttons.push({ kind: 'resume_settings', label: '设置模型', href: '#settings/model' }); return t; };
  // 没做成：原因只说人话（errorReason：原始报错换成表里那一句，已经是人话的原样留着），原文在运行日志和模型调用的记录里。
  const fail = (head, reason, retry = true) => Object.assign(t, { result: `${head}${head ? '：' : ''}${errorReason(reason)}`, bad: true, why: { reason: errorReason(reason), retry } });
  const restarted = () => Object.assign(t, { status: 'stuck', result: '上次没做完（程序重启了），可以再说一次', bad: true, why: { reason: '上次没做完，程序重启了', retry: true } });
  if (w.kind === 'letter_write') {
    const r = results[m.id];
    t.writer = { kind: w.kind, letter_kind: w.letter_kind };
    if (!r) { if (gone()) restarted(); return t; }
    Object.assign(t, { status: 'done', updated_at: r.at || t.updated_at });
    if (r.status === 'unavailable') return unavailable(r.reason);
    if (r.status === 'busy') return Object.assign(t, { result: `这${w.letter_kind === 'self_intro' ? '段' : '封'}已经在写了，写好会出在「材料」里。` });
    if (!r.key) return fail('没写成', r.reason);
    t.card = { kind: 'letter', key: r.key, label: w.title || KIND_WORD[w.letter_kind] || '信', note: r.status === 'failed' ? (r.problems ? `有 ${r.problems} 句核对没过` : '核对没过') : '' };
    // 核对没过（已经自动重写过一次）：照实说拦在哪一句。
    t.result = t.card.note ? `${t.card.label}：核对没过${r.retried ? '，重写了一次还是没过' : ''}${r.blocked ? `，${r.blocked}` : `（${t.card.note}）`}。先别用。` : `写好了：${t.card.label}。`;
    t.buttons.push({ kind: 'resume_open', label: '打开', href: letterHref(r.key) });
    return t;
  }
  if (w.kind === 'letter_ask' || w.kind === 'letter_rewrite') {
    const r = results[m.id];
    t.writer = { kind: w.kind, letter: w.letter };
    if (!r) { if (gone()) restarted(); return t; }
    t.updated_at = r.at || t.updated_at;
    t.status = 'done';
    if (w.kind === 'letter_ask') {
      const answered = !!r.answered_at; // 和简历的问题卡一样：Writer 还在改这封信时点的不算答过，卡片还能再答
      t.questions = (r.questions || []).map(q => ({ id: q.id, kind: q.kind, text: q.text, options: q.options || [], allow_text: true }));
      t.answers = r.answers || null;
      t.head = '改之前，先问你几句：';
      t.result = `${t.head}\n${t.questions.map((q, i) => `${i + 1}. ${q.text}（${q.options.join(' / ')}）`).join('\n')}`;
      t.buttons.push({ kind: 'resume_answers', label: START, used: answered });
      return t;
    }
    if (r.status === 'unavailable') return unavailable(r.reason);
    if (!r.key) return fail('没改成', r.reason);
    const bad = r.flags ?? (r.problems || []).length;
    t.card = { kind: 'letter', key: r.key, label: `${w.title || '信'} · 第 ${r.n || 2} 版`, note: r.status === 'failed_check' ? (bad ? `有 ${bad} 句核对没过` : '核对没过') : '' };
    t.result = t.card.note ? `${t.card.label}：核对没过${r.retried ? '，重写了一次还是没过' : ''}${r.blocked ? `，${r.blocked}` : `（${t.card.note}）`}。` : `改好了：${t.card.label}。`;
    t.buttons.push({ kind: 'resume_open', label: '打开', href: letterHref(r.key) });
    return t;
  }
  if (w.kind === 'check' || w.kind === 'edit' || w.kind === 'ask') {
    const r = results[m.id];
    if (!r) { if (gone()) restarted(); return t; }
    t.updated_at = r.at || t.updated_at;
    t.status = 'done';
    if (w.kind === 'check') {
      if (r.status !== 'done') return fail('体检没做完', r.reason);
      const items = r.items || [], note = r.note && (!/^现在用不了模型/.test(r.note) || !noModelBefore(m, s, results)) ? r.note : '';
      t.items = items.map(x => ({ text: x.text, line_ids: x.line_ids || [] }));
      t.head = items.length ? `体检看完了，有 ${items.length} 处可以改：` : '体检看完了，没找到要紧的地方。';
      t.rewrite = r.rewrite || null;
      t.note = note;
      t.result = `${t.head}${items.length ? `\n${numbered(items)}` : ''}${t.rewrite ? `\n示例改写（只作示例）：\n原句：${t.rewrite.before}\n改写：${t.rewrite.text}` : ''}${note ? `\n${note}` : ''}`;
      if (items.length) t.buttons.push({ kind: 'resume_rewrite_from_check', label: '按这几条改一版', used: clicked(s, m, 'resume_rewrite_from_check') });
      return t;
    }
    if (w.kind === 'ask') {
      if (r.status === 'unavailable') return unavailable(r.reason);
      if (r.status !== 'done') return fail('没问成', r.reason);
      const answered = !!r.answered_at; // 点了、但 Writer 那时在做别的：没开始改，不算答过
      // about：问到哪一行（服务端记下的那一行，按那一版现在的内容）：卡片上带着那一行，你答的事实挂在它那一段上。
      let idx = null;
      try { idx = lineIndex(loadDoc(w.doc).versions.find(v => v.id === w.version)?.content || {}); } catch {} // 兜底：读不出那一版就不带「问到哪一行」
      const about = q => { const x = q.line_id && idx ? idx.get(q.line_id) : null; return x?.role === 'line' ? { line_id: x.line.id, text: clean(x.line.text, 80) } : null; };
      t.questions = (r.questions || []).map(q => ({ id: q.id, kind: q.kind, text: q.text, options: q.options || [], allow_text: true, about: about(q) }));
      t.answers = r.answers || null;
      t.head = w.lead ? `按 #${w.lead.number} ${w.lead.company} 改之前，先问你几句：` : '改之前，先问你几句：';
      t.result = `${t.head}\n${t.questions.map((q, i) => `${i + 1}. ${q.text}（${q.options.join(' / ')}）`).join('\n')}`; // 手机和纯文字看这一段
      t.buttons.push({ kind: 'resume_answers', label: START, used: answered });
      return t;
    }
    t.writer.version = r.to_vid || w.version;
    if (r.status === 'applied') {
      const n = (r.line_ids || []).length;
      t.writer.line_ids = r.line_ids || [];
      t.short = `改好了 ${n || 1} 句（简历 ${r.from_vid || w.version}）。`; // 手机上没有那张纸，不说「标黄的那句」
      // 改的一两句先进草稿（10-03）：存不存成新的一版，在简历页上定。
      t.result = `改好了，简历上标黄的那${n > 1 ? ` ${n} 句` : '句'}${r.to_vid && r.to_vid !== r.from_vid ? '，还没存成新的一版' : ''}。`;
      t.buttons.push({ kind: 'resume_undo', label: r.undone_at ? '撤销了' : '撤销', used: !!r.undone_at || clicked(s, m, 'resume_undo') });
      return t;
    }
    if (r.status === 'asked') return Object.assign(t, { result: r.question || '想先问你一句，再改。' });
    if (r.status === 'unavailable') return unavailable(r.reason);
    return fail(r.status === 'stale' ? '' : '没改成', r.reason);
  }
  if (w.kind === 'rewrite') {
    let doc = null, p = null;
    try { doc = loadDoc(w.doc); p = (doc.proposals || []).find(x => x.id === w.proposal_id) || null; } catch {} // 兜底：读不出来就当这份新版不在了，下一行照实告诉你
    if (!p) return Object.assign(t, { status: 'done', result: '这份新版已经不在了。', bad: true });
    // 0.1.2 以前没做成的那条会原地重跑（第 6b 轮开箱）：这条消息开的那一次早就结束了，记录被后来那次（别的对话、别的卡）接着用了。
    // 照这一次自己的结果算：只有没做成的才会被重跑，这一次的原因已经被盖掉。时间也是这一次的，不用后来那次做完的时间。
    if (w.run ? p.started_at !== w.run : Date.parse(p.started_at || '') > (Date.parse(m.at || '') || 0) + RERUN_SLACK_MS) return Object.assign(fail('没改成', '那次的原因没留下，后来又改过一次'), { status: 'done', updated_at: m.at });
    t.updated_at = p.finished_at || p.decided_at || t.updated_at;
    if (p.status === 'running') { if (gone() && now - (Date.parse(p.started_at || p.created_at) || 0) > STALE_MS) restarted(); return t; }
    t.status = 'done';
    if (p.status === 'failed') return p.unavailable ? unavailable(p.error) : fail('没改成', p.error);
    if (p.status === 'dropped') return Object.assign(t, { result: '这一版没用。' });
    const v = p.status === 'used' ? doc.versions.find(x => x.id === p.used_version) : null;
    if (p.status === 'used' && !p.direct) return Object.assign(t, { result: `用了这一版，存成 ${p.used_version}。` });
    if (!v) return Object.assign(t, { result: `改好的那一版（${p.used_version || '—'}）已经不在了。`, bad: true });
    // 版本卡片：哪一版、改了几处；「打开」进材料页并选中这一版。
    const label = versionLabel(doc, v), changes = Number(p.changes) || 0;
    t.card = { doc: w.doc, version: v.id, label, changes, base: p.base_version, kind: v.by, ...(v.by === 'tailor' ? { accepted: v.accepted !== false } : {}), ...(p.base_changed ? { base_changed: true } : {}) };
    t.result = `改好了：${label}${changes ? `，改了 ${changes} 处` : '，没有改动'}。${p.base_changed ? `\n${p.base_version} 在 ${crewName('tailor')} 改的时候你又改过，这些改动不在新版里。` : ''}`;
    const unapplied = unappliedEdits(p);
    if (unapplied.length) {
      t.bad = true;
      t.card.note = `${unapplied.length} 项未应用，需核对`;
      t.result = `只完成部分修改，已存成 ${label}；${t.card.note}，先别用于投递。\n${unapplied.slice(0, 3).map(x => `- ${x.reason}`).join('\n')}${unapplied.length > 3 ? '\n其余未应用项可在对比中查看。' : ''}`;
      t.buttons.push({ kind: 'resume_open', label: '查看未应用项', href: compareHref(w.doc, p.base_version, v.id) });
    }
    // 只留「打开」：进材料页、选中这一版（负责人 10-03：对比没必要；整篇重写等你看时的左右对比另走一条路）。
    t.buttons.push({ kind: 'resume_open', label: '打开', href: `#materials?doc=${encodeURIComponent(w.doc)}&v=${encodeURIComponent(v.id)}` });
    return t;
  }
  return null;
}

// ── 回复里的按钮 ──────────────────────────────────────────────────────────────
// → 这次回你的那句话的字段（和 writerStart 一样），外加 changed:{ doc, version }（页面据此重新载入这一版）。
// answers：「开始改」带上的回答 { q1: { option, text } }；没答的题算跳过，一题都没答就照最初的要求改（resume_skip 是旧卡片的「直接改」，同样处理）。
export async function writerButton({ session, message_id, kind, answers = null }, { model = null, now = Date.now() } = {}) {
  const m = (session?.messages || []).find(x => x.id === message_id && x.kind === 'writer');
  if (!m) return { content: '这条消息已经不在这个对话里了。', bad: true };
  const w = m.writer || {}, rec = writerResults()[m.id] || null;
  if (kind === 'resume_undo') {
    if (w.kind !== 'edit' || rec?.status !== 'applied' || !rec.change_id) return { content: '这一步没有可以撤销的改动。', bad: true };
    if (rec.undone_at) return { content: '这一步已经撤销过了。' };
    const vid = rec.to_vid || w.version;
    try {
      const rev = Number(loadDoc(w.doc).versions.find(v => v.id === vid)?.rev) || 0;
      undo(w.doc, vid, { change_id: rec.change_id, rev });
    } catch (e) { return { content: `没撤成：${errorReason(e)}`, bad: true }; }
    remember(m.id, { undone_at: new Date(now).toISOString() });
    return { content: '撤销了，那几行回到了改之前的样子。', changed: { doc: w.doc, version: vid } };
  }
  if (kind === 'resume_rewrite_from_check') {
    if (w.kind !== 'check' || rec?.status !== 'done' || !(rec.items || []).length) return { content: '这次体检没有可以照着改的几条。', bad: true };
    const want = clean(`按体检的几条改：${rec.items.map((x, i) => `${i + 1}. ${x.text}`).join('；')}`, 480);
    return writerStart({ intent: { kind: 'rewrite', number: null }, target: { doc: w.doc, version: w.version, name: w.name }, instruction: want }, { model, now });
  }
  if ((kind === 'resume_answers' || kind === 'resume_skip') && w.kind === 'letter_ask') {
    if (rec?.answered_at) return { content: '这几个问题已经答过了，改好的那一版在下面。' };
    const qs = rec?.questions || [], said = kind === 'resume_answers' && answers && typeof answers === 'object' ? cleanAnswers(answers, qs) : {};
    if (letterBusy(w.letter)) return { content: '我还在改这封信，做完再按这次的回答改，上面的回答都还在。', busy: true };
    const skipped = !Object.keys(said).length;
    remember(m.id, { answered_at: new Date(now).toISOString(), answers: said, skipped });
    return letterRewriteMessage({ key: w.letter, title: w.title, instruction: skipped ? '' : answersInstruction('', qs, said), lead: w.lead }, { model, now });
  }
  if (kind === 'resume_answers' || kind === 'resume_skip') {
    if (w.kind !== 'ask') return { content: '这条消息没有要答的问题。', bad: true };
    if (rec?.answered_at) return { content: '这几个问题已经答过了，改好的那一版在下面。' };
    if (rec?.status !== 'done') return { content: rec ? '这次没问成，没法照着改。' : '问题还在想，稍等一下。', bad: true };
    const qs = rec.questions || [], said = kind === 'resume_answers' && answers && typeof answers === 'object' ? cleanAnswers(answers, qs) : {};
    // 你自己写的事实先记下（是你的话，不管这次改没改成都算数）；真开始改了才记「答过了」——Writer 还在做别的，卡片还能再答。
    try { if (Object.keys(said).length) recordAnswers(w.doc, qs, said, { now, vid: w.version }); } catch (e) { return { content: `回答没记下：${errorReason(e)}`, bad: true }; }
    const skipped = !Object.keys(said).length, instruction = skipped ? w.instruction || '' : answersInstruction(w.instruction || '', qs, said);
    const out = await rewriteMessage({ target: { doc: w.doc, version: w.version, name: w.name }, instruction, lead: w.lead || null }, { model, now });
    if (out.writer) remember(m.id, { answered_at: new Date(now).toISOString(), answers: said, skipped });
    return out;
  }
  if (kind === 'resume_compare') return { content: '对比在「材料」页里看。' };
  return { content: '不认得这个按钮。', bad: true };
}
// 「再试一次」，而这一件不是你打字说的（点了「开始改」「按这几条改一版」开出来的）：照这条消息自己记下的输入再做一次——
// 同一份简历的同一版、同一句要求、同一个岗位。打字说的那种由 lib/talk.mjs 拿你那句话重走一遍。
export async function writerAgain(m, { model = null, now = Date.now() } = {}) {
  const w = m?.writer || {}, target = w.doc ? { doc: w.doc, version: w.version, name: w.name } : null, o = { model, now };
  if (w.kind === 'check') return writerStart({ intent: { kind: 'check' }, target, text: w.instruction || '' }, o);
  if (w.kind === 'edit') return writerStart({ intent: { kind: 'edit', line_ids: w.line_ids || [] }, target, text: w.instruction || '' }, o);
  if (w.kind === 'ask') return writerStart({ intent: { kind: 'rewrite', number: w.lead?.number ?? null }, target, instruction: w.instruction || '' }, o);
  if (w.kind === 'rewrite') return rewriteMessage({ target, instruction: w.instruction || '', lead: w.lead || null }, o);
  if (w.kind === 'letter_rewrite') return letterRewriteMessage({ key: w.letter, title: w.title, instruction: w.instruction || '', lead: w.lead }, o);
  if (w.kind === 'letter_write') return writerLetterTurnFor({ kind: w.letter_kind, lead: w.lead ? findLead(w.lead.number) : null, lang: w.lang || null }, o);
  return { content: '这件没法照原样再做一次，换个说法再说一次。', bad: true };
}
// 只留问过的那几个问题的回答：点的选项要是那个问题的选项之一，自己写的那句最多 300 字。
function cleanAnswers(answers, qs) {
  const out = {};
  for (const q of qs) {
    const a = answers[q.id];
    if (!a || typeof a !== 'object') continue;
    const option = (q.options || []).includes(String(a.option || '')) ? String(a.option) : null, text = clean(a.text, 300);
    if (option || text) out[q.id] = { ...(option ? { option } : {}), ...(text ? { text } : {}) };
  }
  return out;
}

// ── 聊天时交给模型的这一版简历（Writer 自己的身份，lib/chat.mjs systemPrompt）─────────────
export function resumeBrief(target) {
  if (!target) return '';
  const content = targetContent(target);
  if (!content) return '';
  const sel = new Set(target.selection || []), out = [`「${target.title || '简历'}」${targetLabel(target)}${target.lang === 'zh' ? '（中文）' : target.lang === 'en' ? '（英文）' : ''}。用户说「这一版」「这里」指的就是它${sel.size ? '；前面带「→」的是用户在页面上选中的行，说「这几行」指的就是它们' : ''}。`];
  out.push((content.header || []).map(l => l.text).filter(Boolean).join(' | '));
  for (const sct of content.sections || []) {
    out.push(`## ${sct.title?.text || sct.kind || ''}`);
    for (const e of sct.entries || []) {
      if ((e.head || []).length) out.push(e.head.map(l => l.text).join(' | '));
      for (const l of e.lines || []) out.push(`${sel.has(l.id) ? '→ ' : ''}- ${l.text}`);
    }
  }
  const text = out.join('\n');
  return text.length > 6000 ? text.slice(0, 6000) + '…' : text;
}

// ── 你自己写的字找不到出处：Writer 在对话里提醒一句（设计说明 4.3、第 10 节）────────────────────────
// 你改简历（POST /api/resume edit）时有一行核对没过：不拦、不在正文上挂东西。按行去抖——停手 noteConfig.delay 以后再看一眼这一行，
// 还是找不到出处，Writer 在手上那段对话里说一句（lib/talk-sessions.mjs writerNote，不跑模型）。同一行同样的那几个字只说一次
// （state/writer-notes.json）；你已经改掉了就不说。
export const noteConfig = { delay: 8000 };
const NOTES = 'state/writer-notes.json';
const noteTimers = new Map(), notePending = new Map(), noteWhere = new Map(); // noteWhere：这一行的提醒说在哪段对话（页面带来的，你正看着的那段）
const quoted = (problems, keep = () => true) => [...new Set(problems.flatMap(p => String(p.text || '').split('、')).map(t => clean(t, 40)).filter(Boolean))].filter(keep).slice(0, 3);
export function yourTextNote({ doc, version, line_ids = [], session_id = null } = {}) {
  for (const id of [...new Set(line_ids.map(String))].slice(0, 10)) {
    const key = `${doc}/${version}/${id}`;
    clearTimeout(noteTimers.get(key));
    let done;
    const p = notePending.get(key) || new Promise(r => { done = r; });
    if (done) { p.done = done; notePending.set(key, p); }
    const t = setTimeout(() => { noteTimers.delete(key); notePending.delete(key); noteWhere.delete(key); noteNow(doc, version, id, session_id).catch(e => noteSwallowed('writer-talk.note', e, { member: 'tailor', doing: '提醒你改的字找不到出处', then: '这次不提醒' })).finally(() => p.done()); }, noteConfig.delay);
    noteWhere.set(key, session_id);
    t.unref?.();
    noteTimers.set(key, t);
  }
}
// 测试用：排着的提醒马上说完。
export async function flushNotes() {
  for (const [key, t] of noteTimers) { clearTimeout(t); noteTimers.delete(key); const [doc, version, id] = key.split('/'); const p = notePending.get(key); notePending.delete(key); const where = noteWhere.get(key) || null; noteWhere.delete(key); await noteNow(doc, version, id, where).catch(e => noteSwallowed('writer-talk.note', e, { member: 'tailor', doing: '提醒你改的字找不到出处', then: '这次不提醒' })); p?.done?.(); }
}
// 同一行说过的字不再说（一行越写越长：只说新加的那几个字）：state/writer-notes.json 按「文档|行|字」记。
async function noteNow(doc, version, id, session_id = null) {
  const { problems } = lineProblems(doc, version, id);
  let said = [];
  try { said = read(NOTES, []) || []; } catch {} // 兜底：说过的记录读不出就当都没说过，最多重复提醒一次
  const key = w => `${doc}|${id}|${w}`, words = quoted(problems, w => !said.includes(key(w)));
  if (!words.length) return null;
  write(NOTES, [...said, ...words.map(key)].slice(-600));
  const { writerNote } = await import('./talk-sessions.mjs');
  return writerNote(`你写的「${words.join('」「')}」在原简历和你的资料里找不到出处，确认是真的就好。`, { session_id });
}
