// 「材料」页（2026-10-01，设计说明 design/materials/设计说明.md §3，样稿 v2-1 / v4-1 / v4-2）：简历、求职信、自我介绍。
//   #materials                         首页：简历文件，每份一行（默认投递的那份在前，10-03）
//   #materials?doc=r1                  一份简历：头上是整份的操作；左边这份自己的历史（v1、v2…按这份算），右边选中那一版的预览（只读，10-03）。
//                                      点历史里的一行只是选中它；预览上面「修改」才进草稿编辑，不是现在用的那一版再多一个「恢复到这一版」。
//   #materials?tab=letters|intros       求职信、自我介绍：列表、预览、用这封 / 不用
//   #materials/edit?doc=r1&v=v3         简历页：一张纸，点哪改哪（web/resume-editor.js）
//   #materials/compare?doc=r1&p=p2      Writer 改一版之后左右对比：不用 / 用这版（web/resume-compare.js）
// 旧地址 #resume… 由 web/app.js 换成 #materials…。数据：GET /api/resume（首页，带 letters）、/api/resume/view（编辑、对比）；
// 写都是 POST /api/resume {action}（web/resume-api.js）。这里只画和把你的选择交回去；版本规矩在服务端（lib/resume-versions.mjs）。
import { paperHtml, paperPreviewHtml, fitPaperPreviews, mountSheetCss, esc } from './resume-paper.js';
import { getJson, act, upload, exportPdf, UPLOAD_ACCEPT } from './resume-api.js';
import * as Editor from './resume-editor.js';
import * as Compare from './resume-compare.js';
import * as Letter from './resume-letter.js';
import * as Interview from './interview-materials.js';
import { morph } from './morph.js';

// ── 纯函数（tests/resume-page.test.mjs） ───────────────────────────────────────
export function parseRoute(hash = '') {
  const [path, query = ''] = String(hash).replace(/^#/, '').split('?');
  const q = new URLSearchParams(query), sub = path.split('/')[1] || '';
  const doc = q.get('doc') || null;
  if (sub === 'edit') return { view: 'edit', doc, version: q.get('v') || null };
  if (sub === 'letter') return { view: 'letter', key: q.get('key') || null };
  if (sub === 'interview') return { view: 'interview', key: q.get('key') || null };
  if (sub === 'compare') return { view: 'compare', doc, proposal: q.get('p') || null, a: q.get('a') || null, b: q.get('b') || null }; // ?a=v2&b=v5：两版之间
  const tab = ['letters', 'intros', 'interviews'].includes(q.get('tab')) ? q.get('tab') : 'resume';
  return { view: 'home', doc, tab, version: q.get('v') || null }; // ?v=：打开这份时先选中这一版（对话里 Writer 改完那张卡的「打开」）
}
export const editHash = (doc, v) => `#materials/edit?doc=${encodeURIComponent(doc)}&v=${encodeURIComponent(v)}`;
export const compareHash = (doc, p) => `#materials/compare?doc=${encodeURIComponent(doc)}&p=${encodeURIComponent(p)}`;
export const homeHash = (doc, tab = 'resume') => `#materials${doc || tab !== 'resume' ? `?${new URLSearchParams({ ...(doc ? { doc } : {}), ...(tab !== 'resume' ? { tab } : {}) })}` : ''}`;

const parts = (t, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
// 今天的写「今天 10:42」，今年的写「9 月 29 日」，更早的带年份。
export function dayLabel(iso, now = Date.now(), tz = undefined) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const a = parts(t, tz), b = parts(now, tz);
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `今天 ${a.hour}:${a.minute}`;
  const md = `${Number(a.month)} 月 ${Number(a.day)} 日`;
  return a.year === b.year ? md : `${a.year} 年 ${md}`;
}
// 谁改的、基于哪一版。
export function whoLine(v, { writer = 'Writer', source = '' } = {}) {
  const base = v.base ? ` · 基于 ${v.base}` : '';
  if (v.by === 'upload') return source ? `上传的 ${source}` : '上传的原简历';
  if (v.by === 'writer') return `${writer} 改的${base}`;
  if (v.by === 'tailor') return `${writer} 定制${base}`;
  if (v.by === 'copy') return `复制的${base}`;
  return `你改的${base}`;
}
const SHOW_PROPOSAL = new Set(['running', 'ready', 'failed']);
// 一份简历的历史（10-03）：每版一行，新的在上；版本号按这份自己算（k）。一行写清谁改的、改了什么、什么时候：
// 为哪个岗位定制（小标「为 #N 定制」）、基于哪一版、从哪份复制来的。「现在用」是这份里用哪一版，「默认投递」是哪一份——两样分开标。
export function historyRows(view, { now = Date.now(), tz = undefined } = {}) {
  // 页面上只出现一个文件名：这份是默认投递、投递传的文件已知时，只在头上写投递的那个文件，历史里上传那一版不再写原来的文件名（E4）。
  const writer = view?.crew?.name || 'Writer', source = view?.doc?.delivery?.file ? '' : view?.doc?.source?.name || '', copied = view?.doc?.copied_from || null;
  const versions = [...(view?.versions || [])].sort((a, b) => (b.k || b.n) - (a.k || a.n));
  const kOf = new Map(versions.map(v => [v.id, v.k || v.n]));
  const rows = [];
  for (const p of view?.proposals || []) {
    if (!SHOW_PROPOSAL.has(p.status)) continue;
    const tailor = p.kind === 'tailor', status = p.status === 'running' ? { text: `${writer} 在改`, tone: 'run' } : p.status === 'ready' ? { text: '等你看', tone: 'wait' } : { text: '没改成', tone: 'fail' };
    rows.push({ key: `p:${p.id}`, kind: 'proposal', id: p.id, title: tailor ? `${p.company || '岗位'} 定制版` : `${writer} 的新版`, sub: `${writer} ${tailor ? '定制' : '改的'} · 基于 v${kOf.get(p.base_version) || String(p.base_version || '').replace(/^v/, '')}`, when: p.status === 'running' ? '现在' : dayLabel(p.created_at, now, tz), status, tags: [] });
  }
  for (const v of versions) {
    const k = kOf.get(v.id), base = v.base_k ? ` · 基于 v${v.base_k}` : '';
    const num = v.for_lead?.number != null ? `#${v.for_lead.number}` : '', lead = [num, v.for_lead?.company || ''].filter(Boolean).join(' ');
    const what = v.by === 'upload' ? (source ? `上传的 ${source}` : '上传的原简历')
      : v.by === 'copy' && k === 1 && copied ? `从「${copied.title} v${copied.n}」${copied.edited ? '改出来' : '复制'}`
      : v.by === 'tailor' ? `${writer} 为 ${lead || '岗位'} 定制${base}`
      : v.by === 'writer' ? `${writer} 改了一版${base}`
      : v.by === 'copy' ? `另存的${base}` : `你自己改的${base}`;
    const used = (v.used_by || []).length;
    const tags = [
      ...(v.current ? [{ text: '现在用', tone: 'cur' }] : []),
      ...(v.default_for ? [{ text: '默认投递', tone: 'use' }] : []),
      ...(v.by === 'tailor' && (num || lead) ? [{ text: `为 ${num || lead} 定制`, tone: 'job' }] : []),
      ...(v.waiting ? [{ text: '等你确认', tone: 'wait' }] : []),
      ...(v.has_draft ? [{ text: '有没存的修改', tone: 'wait' }] : []),
    ];
    const prev = v.base || versions.find(x => kOf.get(x.id) === k - 1)?.id || null;
    rows.push({ key: `v:${v.id}`, kind: 'version', id: v.id, k, title: `v${k}${v.name && !/^v\d+$/.test(v.name) && v.name !== what ? ` · ${v.name}` : ''}`, sub: `${what}${v.changes ? ` · ${v.changes} 行有变化` : ''}`, when: dayLabel(v.updated_at || v.created_at, now, tz), used: used ? `${used} 个岗位单独选用` : '', tags, current: !!v.current, default_for: v.default_for || null, prev });
  }
  return rows;
}
// 简历文件那一列：默认投递的那份带标、排第一（服务端已经排好）。
export function fileRows(files = [], { now = Date.now(), tz = undefined } = {}) {
  return files.map(f => ({
    key: f.id, title: f.title || f.id, default_for: f.default_for || null,
    sub: [f.current ? `现在用 v${f.current.n}` : '', `共 ${f.versions} 版`, f.copied_from ? `从「${f.copied_from.title} v${f.copied_from.n}」${f.copied_from.edited ? '改出来' : '复制'}` : ''].filter(Boolean).join(' · '),
    when: dayLabel(f.updated_at, now, tz), used: f.jobs ? `${f.jobs} 个岗位单独选用` : '',
  }));
}
// 信和自我介绍：给哪个岗位、谁写的、在用还是等你看。
const LSTATE = { proposed: { text: '等你确认', tone: 'wait' }, chosen: { text: '在用', tone: 'use' }, declined: { text: '不用', tone: 'quiet' }, failed: { text: '核对没过', tone: 'fail' } };
export function letterRows(list = [], { writer = 'Writer', now = Date.now(), tz = undefined } = {}) {
  return list.map(r => ({
    key: r.key, kind: r.kind,
    title: `${r.record_id ? `#${r.number ?? '—'} ${r.company || ''}`.trim() : r.lang === 'en' ? '通用 · 英文' : '通用 · 中文'}${(r.n || 1) > 1 ? ` · 第 ${r.n} 版` : ''}`, depth: (r.n || 1) > 1 ? 1 : 0,
    sub: [r.role || '', r.by === 'user' ? '你改的' : `${writer} 写的`, dayLabel(r.created_at, now, tz)].filter(Boolean).join(' · '),
    status: LSTATE[r.status] || { text: '没写成', tone: 'fail' },
    can_use: r.status === 'proposed' || r.status === 'declined', can_skip: r.status === 'proposed' || r.status === 'chosen',
  }));
}

// ── 状态 ─────────────────────────────────────────────────────────────────────
let h = null, route = { view: 'home', tab: 'resume' }, view = null, sig = null, poll = null;
const S = { menu: null, open: null, busy: new Set(), sel: null, pv: new Map(), pvGen: 0 };
const TZ = () => globalThis.document?.querySelector('meta[name="radar-tz"]')?.content || undefined;
const $ = s => document.querySelector(s);
const writerName = () => view?.crew?.name || 'Writer';
export const resumeSig = () => route.view === 'interview' ? Interview.interviewSig() : route.view === 'letter' ? Letter.letterSig() : route.view === 'edit' ? Editor.editorSig() : route.view === 'compare' ? Compare.compareSig() : sig;
const ctx = () => ({ h, go: hash => { location.hash = hash; }, editHash, compareHash, homeHash });

async function loadHome() {
  const q = route.doc ? `?doc=${encodeURIComponent(route.doc)}` : '';
  view = await getJson(`/api/resume${q}`);
  if (route.tab === 'interviews') view.interviews = await getJson('/api/materials/interviews');
  const running = (view.proposals || []).some(p => p.status === 'running') || (view.letters?.running || []).length;
  sig = `${view.content_sig || ''}|${route.tab}|${view.interviews?.content_sig || ''}`;
  clearTimeout(poll);
  if (running) poll = setTimeout(async () => { if (!$('#rs[data-route="home"]')) return; const before = sig; try { await loadHome(); if (sig !== before) paint(); } catch {} }, 3000);
}
export async function resumePage(helpers) {
  h = helpers;
  mountSheetCss();
  route = parseRoute(location.hash);
  if (route.view === 'home' && route.version) S.sel = route.version;
  if (route.view !== 'edit') Editor.leave();
  if (route.view !== 'compare') Compare.leave();
  if (route.view !== 'letter') Letter.leaveLetter();
  if (route.view !== 'interview') Interview.leaveInterview();
  if (route.view === 'interview') return Interview.interviewPage(ctx(), route);
  if (route.tab === 'interviews') Interview.mountInterviewCss();
  if (route.view === 'letter') return Letter.letterPage(ctx(), route);
  if (route.view === 'edit') return Editor.editorPage(ctx(), route);
  if (route.view === 'compare') return Compare.comparePage(ctx(), route);
  try { await loadHome(); }
  catch (e) { view = null; sig = `error|${e.message}`; return `<div class="rs" id="rs" data-route="home">${topHtml()}<p class="rs-error">${esc(e.message)}</p></div>`; }
  return `<div class="rs" id="rs" data-route="home">${homeInner()}</div>`;
}
function paint() {
  const root = $('#rs[data-route="home"]');
  if (root && view) { morph(root, homeInner()); fitPreview(); }
}
// 材料首页（简历文件、一份的历史、求职信、自我介绍）就地更新；编辑、对比、信这几页有自己的可编辑区和事件，整块换（web/app.js）。
export const resumeMorphs = () => {
  const root = $('#rs');
  // 只有首页 → 首页才复用 DOM。否则编辑页的 addEventListener 会随 #rs 留下来，
  // leave() 清掉编辑状态以后，点首页标签仍触发旧处理器（K38 / E1）。
  return parseRoute(location.hash).view === 'home' && (!root || root.dataset.route === 'home');
};
// 换到材料首页（换标签、换一份）时先用手上这份画；看的是另一份简历、或没拉过返回 null。
export function resumeNow() {
  const r = parseRoute(location.hash);
  if (!h || !view || r.view !== 'home' || (r.doc && r.doc !== view.active)) return null;
  if (r.tab === 'interviews' && !view.interviews) return null;
  route = r;
  if (r.version) S.sel = r.version;
  return `<div class="rs" id="rs" data-route="home">${homeInner()}</div>`;
}
async function run(key, fn, { ok = null } = {}) {
  if (S.busy.has(key)) return;
  S.busy.add(key); paint();
  try { const r = await fn(); if (ok) h.toast(typeof ok === 'function' ? ok(r) : ok); await loadHome(); return r; }
  catch (e) { h.toast(e.message); try { await loadHome(); } catch {} }
  finally { S.busy.delete(key); paint(); }
}

// ── 首页 ─────────────────────────────────────────────────────────────────────
function topHtml() {
  return `<div class="rs-top"><h1>材料</h1><span class="rs-sp"></span><label class="rs-btn${S.busy.has('import') ? ' is-busy' : ''}">上传简历<input type="file" data-upload accept="${UPLOAD_ACCEPT}" hidden></label></div>`;
}
// 一封信的几版算一封。
const families = (list = []) => new Set(list.map(r => r.family || r.key)).size;
function tabsHtml() {
  const L = view?.letters || {}, n = x => x ? `<i>${x}</i>` : '';
  return `<nav class="rs-tabs" role="tablist">${[['resume', '简历', 0], ['letters', '求职信', families(L.letters)], ['intros', '自我介绍', families(L.intros)], ['interviews', '面试资料', 0]].map(([k, t, c]) => `<a href="${homeHash(k === 'interviews' ? null : route.doc, k)}" role="tab" aria-selected="${route.tab === k}" class="${route.tab === k ? 'is-on' : ''}">${t}${n(c)}</a>`).join('')}</nav>`;
}
function homeInner() {
  const mig = view.migration?.status === 'failed' || view.migration?.status === 'running' ? `<p class="rs-state is-warn">${esc(view.migration.message)}</p>` : '';
  const body = route.tab === 'interviews' ? Interview.interviewListHtml(view.interviews) : route.tab === 'letters' ? lettersHtml('letters') : route.tab === 'intros' ? lettersHtml('intros') : !view.doc ? emptyHtml() : route.doc ? `${currentCard()}<div class="rs-split">${listHtml()}${previewHtml()}</div>` : filesHtml();
  return `${topHtml()}${tabsHtml()}${mig}${body}${S.busy.has('import') ? `<p class="rs-state"><span class="rs-spin"></span>正在读这份简历…</p>` : ''}`;
}
function emptyHtml() {
  const cur = view.current || [], ups = view.uploads || [], busy = S.busy.has('import');
  const rows = [
    ...cur.map(c => `<li><span>《${esc(c.name)}》<small>${c.slot === 'chinese_pdf' ? '中文' : '英文'} · 投递正在用</small></span><button type="button" class="rs-btn" data-import-current="${esc(c.slot)}" ${busy ? 'disabled' : ''}>用这份</button></li>`),
    ...ups.map(u => `<li><span>《${esc(u.name)}》<small>${esc(dayLabel(u.uploaded_at, Date.now(), TZ()))} 上传</small></span><button type="button" class="rs-btn" data-import="${esc(u.id)}" ${busy ? 'disabled' : ''}>用这份</button></li>`),
  ];
  return `<section class="rs-card rs-empty"><p>还没有简历</p><label class="rs-btn is-pri">上传简历<input type="file" data-upload accept="${UPLOAD_ACCEPT}" hidden></label>${rows.length ? `<ul class="rs-ups">${rows.join('')}</ul>` : ''}</section>`;
}
// 简历文件那一列（10-03）：每份一行；点一行进这份自己的历史。
function filesHtml() {
  const rows = fileRows(view.files || [], { tz: TZ() });
  return `<section class="rs-card rs-list"><header class="rs-list-h"><h2>简历文件</h2><span class="rs-count">${rows.length}</span></header><div class="rs-flist">${rows.map(r => `<a class="rs-frow${r.default_for ? ' is-use' : ''}" href="${homeHash(r.key)}"><div class="rs-vname"><b>${esc(r.title)}</b>${r.default_for ? '<span class="rs-tag is-use">默认投递</span>' : ''}<small>${esc(r.sub)}</small></div><span class="rs-vwhen">${esc(r.when)}</span><span class="rs-vuse">${esc(r.used)}</span><span class="rs-lnk">打开</span></a>`).join('')}</div></section>`;
}
// 一份简历的头：压成一行（负责人 10-03，一打开不用滚就看得到预览）——← 简历文件、名字、默认投递、现在用 vN；右边整份的操作。
function currentCard() {
  const cur = view.doc?.current, meta = view.versions.find(x => x.id === cur) || {}, isDefault = !!view.doc?.default_for;
  // 导出跟随右侧预览；「现在用」和默认投递仍是文档自己的设置。
  const exportVersion = selected(), exportMeta = view.versions.find(x => x.id === exportVersion) || {};
  const exportLabel = exportMeta.k || exportMeta.n ? `v${exportMeta.k || exportMeta.n}` : exportVersion;
  const v = view.version;
  const stale = v?.default_pdf_stale && v.id === cur ? `<span class="rs-state is-warn">${esc(v.default_pdf_reason || '投递用的文件还是改之前的内容')}${/正在/.test(v.default_pdf_reason || '') ? '' : ` <button type="button" class="rs-lnk" data-refresh="${esc(cur)}" ${S.busy.has('refresh') ? 'disabled' : ''}>重新导出</button>`}</span>` : '';
  // 投递真会传的那个文件（10-04）：文件名，上传的原件标「原件」；设置里的投递文件不在了，说一句现在用的是哪一份。
  const dl = view.doc?.delivery, dname = dl?.file ? `《${esc(dl.file)}》` : '';
  const delivery = dl?.routing_missing ? `<span class="rs-state is-warn">设置里的投递文件《${esc(dl.routing_missing)}》不在了${dname ? `，现在用${dname}${dl.original ? '（原件）' : ''}` : ''}</span>`
    : dname ? `<span class="rs-meta">投递时上传的文件 ${dname}${dl.original ? '（你上传的原件）' : ''}</span>` : '';
  // 解析核对对不上（10-04）：说哪一段，给「重新解析」「按原文顺序」两条路。
  const pc = view.doc?.parse_check, busy = S.busy.has('reparse');
  const parse = pc?.line ? `<p class="rs-state is-warn rs-pcheck">${esc(pc.line)}${pc.can_reparse ? ` <button type="button" class="rs-lnk" data-reparse="auto" ${busy ? 'disabled' : ''}>重新解析</button> <button type="button" class="rs-lnk" data-reparse="alt" ${busy ? 'disabled' : ''}>按原文顺序</button>` : ''}</p>` : '';
  return `<section class="rs-card rs-fhead"><a class="rs-back" href="${homeHash(null)}">← 简历文件</a><b class="rs-fname">${esc(view.doc?.title || '')}</b>${isDefault ? '<span class="rs-tag is-use">默认投递</span>' : ''}<span class="rs-meta">现在用 v${esc(meta.k || meta.n || '')}</span>${delivery}${stale}${parse}<span class="rs-sp"></span>
    <button type="button" class="rs-btn is-sm" data-export="${esc(exportVersion)}" ${!exportVersion || S.busy.has('export:' + exportVersion) ? 'disabled' : ''}>${S.busy.has('export:' + exportVersion) ? '正在导出…' : `导出 ${esc(exportLabel)} PDF`}</button>${isDefault ? '' : `<button type="button" class="rs-btn is-sm" data-default="${esc(cur)}" ${S.busy.has('default') ? 'disabled' : ''}>设为默认投递</button>`}<button type="button" class="rs-btn is-sm" data-renamedoc>改名</button></section>`;
}
// 选中的那一版（默认是现在用的那一版）。
const selected = () => (S.sel && view.versions.some(x => x.id === S.sel) ? S.sel : view.doc?.current || view.versions[0]?.id || null);
// 右边的预览：选中那一版自己的内容（只读）；上面一行「修改」，不是现在用的再加「恢复到这一版」。
function previewHtml() {
  const vid = selected(), meta = view.versions.find(x => x.id === vid) || {}, got = S.pv.get(`${view.active}:${vid}`);
  if (!got) loadPreview(vid);
  const tags = [meta.current ? '<span class="rs-tag is-cur">现在用</span>' : '', meta.default_for ? '<span class="rs-tag is-use">默认投递</span>' : '', meta.has_draft ? '<span class="rs-tag is-wait">有没存的修改</span>' : ''].join('');
  // 窄的时候（手机）历史收成这里的一个下拉；宽的时候它藏起来，用左边那一栏。
  const pick = `<select class="rs-hsel" data-pick-select aria-label="选一个版本">${[...view.versions].sort((x, y) => (y.k || y.n) - (x.k || x.n)).map(x => `<option value="${esc(x.id)}" ${x.id === vid ? 'selected' : ''}>v${esc(x.k || x.n)} · ${esc(shortWhat(x, view))}${x.current ? '（现在用）' : ''}</option>`).join('')}</select>`;
  const prev = meta.base || view.versions.find(x => (x.k || x.n) === (meta.k || meta.n) - 1)?.id;
  const compare = prev ? `<button type="button" class="rs-btn" data-diff="${esc(vid)}" data-prev="${esc(prev)}">和上一版对比</button>` : '';
  const tools = `${compare}${pick}<b class="rs-pv-name">v${esc(meta.k || meta.n || '')}${meta.name && !/^v\d+$/.test(meta.name) ? ` · ${esc(meta.name)}` : ''}</b>${tags}<span class="rs-sp"></span><button type="button" class="rs-btn is-pri" data-edit="${esc(vid)}">${meta.has_draft ? '接着改' : '修改'}</button>${meta.current ? '' : `<button type="button" class="rs-btn" data-usev="${esc(vid)}" ${S.busy.has('usev') ? 'disabled' : ''}>恢复到这一版</button>`}`;
  const row = historyRows(view, { tz: TZ() }).find(x => x.id === vid);
  return `<section class="rs-card rs-pv"><header class="rs-pv-h">${tools}</header>${row ? `<p class="rs-pv-sub">${esc(row.sub)} · ${esc(row.when)}${row.used ? ` · ${esc(row.used)}` : ''}</p>` : ''}${got ? paperPreviewHtml(got.content) : '<div class="rs-pv-frame"><p class="rs-state"><span class="rs-spin"></span>正在打开…</p></div>'}</section>`;
}
async function loadPreview(vid) {
  const key = `${view.active}:${vid}`;
  if (!vid || S.pv.has(key) || S.busy.has('pv:' + key)) return;
  S.busy.add('pv:' + key);
  const gen = S.pvGen;
  try { const r = await getJson(`/api/resume/view?doc=${encodeURIComponent(view.active)}&version=${encodeURIComponent(vid)}&saved=1`); if (gen === S.pvGen) S.pv.set(key, { content: r.version.content }); }
  catch (e) { h.toast(e.message); }
  finally { S.busy.delete('pv:' + key); paint(); }
}
// 预览的那张纸按右边那一栏的宽度缩放（纸本身是 794px 宽）。
function fitPreview() {
  fitPaperPreviews(document.querySelector('#rs'));
}
if (typeof window !== 'undefined') window.addEventListener('resize', () => fitPreview());
function listHtml() {
  const rows = historyRows(view, { tz: TZ() });
  return `<section class="rs-card rs-list rs-hist"><header class="rs-list-h"><h2>历史</h2><span class="rs-count">${view.versions.length}</span></header><div class="rs-vlist">${rows.map(rowHtml).join('')}</div></section>`;
}
// 历史那一栏里一行说清是谁改的：「Writer 改了一版」「为 #29 定制」「你自己改的」……（完整的来历在预览上面）。
export function shortWhat(v, view = {}) {
  const writer = view?.crew?.name || 'Writer', copied = view?.doc?.copied_from;
  if (v.by === 'upload') return '上传的原简历';
  if (v.by === 'copy' && (v.k || v.n) === 1 && copied) return copied.edited ? '改出来的' : '复制来的';
  if (v.by === 'tailor') return v.for_lead?.number != null ? `为 #${v.for_lead.number} 定制` : '岗位定制';
  if (v.by === 'writer') return `${writer} 改了一版`;
  if (v.by === 'copy') return '另存的';
  return '你自己改的';
}
// 历史的一行（负责人 10-03）：点一下只是选中它，右边换成它的预览；行里不放按钮。
function rowHtml(r) {
  const cls = ['rs-hrow', 'is-go', r.current ? 'is-cur' : '', r.kind === 'version' && r.id === selected() ? 'is-sel' : ''].filter(Boolean).join(' ');
  const tags = r.kind === 'proposal' ? `<span class="rs-tag is-${r.status.tone}">${r.status.tone === 'run' ? '<span class="rs-spin"></span>' : ''}${esc(r.status.text)}</span>` : r.tags.filter(t => ['cur', 'wait'].includes(t.tone)).map(t => `<span class="rs-tag is-${t.tone}">${esc(t.text)}</span>`).join('');
  const acts = '';
  const v = view.versions.find(x => x.id === r.id), line = r.kind === 'proposal' ? r.title : `v${r.k} · ${shortWhat(v || {}, view)}`;
  return `<div class="${cls}" data-row="${esc(r.key)}" role="button" tabindex="0" aria-pressed="${r.kind === 'version' && r.id === selected()}" title="${esc(r.kind === 'proposal' ? r.sub : `${r.title} · ${r.sub}`)}" ${r.kind === 'proposal' ? `data-compare="${esc(r.id)}"` : `data-pick="${esc(r.id)}"`}><div class="rs-vname"><b>${esc(line)}</b>${tags}</div><span class="rs-vwhen">${esc(r.when)}</span><span class="rs-vuse">${esc(r.used || '')}</span><span class="rs-vact">${acts}</span></div>`;
}

// ── 求职信、自我介绍：列表；点一行进那一封的页面（和简历页同一种，web/resume-letter.js） ─────────────────
function lettersHtml(which) {
  const L = view.letters || {}, list = which === 'letters' ? L.letters || [] : L.intros || [];
  const fam = new Map();
  for (const r of list) { const k = r.family || r.key; if (!fam.has(k)) fam.set(k, []); fam.get(k).push(r); }
  const row = r => `<a class="rs-lrow" href="#materials/letter?key=${encodeURIComponent(r.key)}"><div class="rs-vname"><b>${esc(r.title)}</b><small>${esc(r.sub)}</small></div><span class="rs-tag is-${r.status.tone}">${esc(r.status.text)}</span><span class="rs-lnk">打开</span></a>`;
  const groups = [...fam.values()].map(g => {
    const ordered = g.sort((a, b) => (b.n || 1) - (a.n || 1));
    const current = ordered.find(r => r.status === 'proposed') || ordered.find(r => r.status === 'chosen') || ordered.find(r => r.status !== 'failed') || ordered[0];
    const history = ordered.filter(r => r !== current);
    return row(letterRows([current], { writer: writerName(), tz: TZ() })[0]) + (history.length ? `<details><summary>历史版本（${history.length}）</summary>${letterRows(history, { writer: writerName(), tz: TZ() }).map(row).join('')}</details>` : '');
  });
  const create = `<button type="button" class="rs-btn" data-create-letter="${which}">写一份${which === 'intros' ? '自我介绍' : '求职信'}</button>`;
  return `<section class="rs-card rs-list rs-letters"><header class="rs-list-h">${create}</header>${groups.length ? groups.join('') : `<p class="rs-empty">还没有${which === 'letters' ? '求职信' : '自我介绍'}</p>`}</section>`;
}

// ── 弹窗：预览、改名 ─────────────────────────────────────────────────────────
function dialog(html, cls = '') {
  document.querySelector('dialog.rs-dlg')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="rs-dlg ${cls}">${html}</dialog>`);
  const d = document.querySelector('dialog.rs-dlg');
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  d.showModal();
  return d;
}
async function preview(vid) {
  let v = view?.version?.id === vid ? view.version : null;
  if (!v) { try { v = (await getJson(`/api/resume/view?doc=${encodeURIComponent(view.active)}&version=${encodeURIComponent(vid)}`)).version; } catch (e) { h.toast(e.message); return; } }
  const d = dialog(`<header class="rs-dlg-h"><b>${esc(v.id)} · ${esc(v.name)}</b><span class="rs-sp"></span><button type="button" class="rs-btn" data-dlg-edit>修改</button><button type="button" class="rs-btn" data-dlg-export>导出 PDF</button><button type="button" class="rs-x" data-close aria-label="关闭">×</button></header><div class="rs-dlg-body"><div class="rs-sheet">${paperHtml(v.content)}</div></div>`, 'is-preview');
  d.querySelector('[data-dlg-edit]').onclick = () => { d.close(); edit(vid); };
  d.querySelector('[data-dlg-export]').onclick = () => { d.close(); doExport(vid); };
}
// 改名：改的是这份简历的名字（文件那一层，10-03）。
function renameDoc() {
  const t = view.doc?.title || '';
  const d = dialog(`<form method="dialog" class="rs-form"><label>名字<input name="name" maxlength="40" value="${esc(t)}" required></label><div class="rs-row"><span class="rs-sp"></span><button type="button" class="rs-btn" data-close>取消</button><button class="rs-btn is-pri" value="ok">改名</button></div></form>`, 'is-small');
  const input = d.querySelector('input'); input.select();
  d.querySelector('form').onsubmit = e => { e.preventDefault(); const title = input.value.trim(); d.close(); if (title && title !== t) run('renamedoc', () => act({ action: 'rename_doc', doc: view.active, title }), { ok: `改好了：${title}` }); };
}
function rename(vid) {
  const v = view.versions.find(x => x.id === vid);
  const d = dialog(`<form method="dialog" class="rs-form"><label>名字<input name="name" maxlength="40" value="${esc(v?.name || '')}" required></label><div class="rs-row"><span class="rs-sp"></span><button type="button" class="rs-btn" data-close>取消</button><button class="rs-btn is-pri" value="ok">改名</button></div></form>`, 'is-small');
  const input = d.querySelector('input'); input.select();
  d.querySelector('form').onsubmit = e => { e.preventDefault(); const name = input.value.trim(); d.close(); if (name && name !== v?.name) run('rename', () => act({ action: 'rename', doc: view.active, version: vid, name }), { ok: `改好了：${vid} · ${name}` }); };
}
// 修改：每一版都直接改（10-02 起 v1 也能；上传的原件在后台另存着）。
async function edit(vid) { location.hash = editHash(view.active, vid); }
const doExport = vid => run('export:' + vid, () => exportPdf(view.active, vid));

export function bindResume() {
  if (route.view === 'edit') return Editor.bindEditor();
  if (route.view === 'compare') return Compare.bindCompare();
  if (route.view === 'letter') return Letter.bindLetter();
  if (route.view === 'interview') return Interview.mountInterview();
  const root = $('#rs[data-route="home"]');
  if (!root) return;
  fitPreview();
  // 就地更新时 #rs 这一块留着，事件只绑一次。
  if (root.__bound) return;
  root.__bound = true;
  root.addEventListener('click', e => {
    const t = e.target.closest('button, a, [data-row], [data-letter-open]');
    if (!t || !root.contains(t) || !view) return;
    const ds = t.dataset;
    if (S.menu && !t.closest('.rs-menu') && !ds.more) { S.menu = null; paint(); if (!ds.edit && !ds.preview) return; }
    if (ds.more) { S.menu = S.menu === ds.more ? null : ds.more; paint(); return; }
    if (ds.createLetter) { window.OfferCrew?.panel?.open?.({ tab: 'talk', member: 'tailor', text: ds.createLetter === 'intros' ? '帮我写一份自我介绍' : '帮我写一封求职信' }); return; }
    if (ds.preview) return preview(ds.preview);
    if (ds.edit) return edit(ds.edit);
    if (ds.export) return doExport(ds.export);
    if (ds.compare) { location.hash = compareHash(view.active, ds.compare); return; }
    if (ds.copydoc) { S.menu = null; return run('copydoc', () => act({ action: 'copy_doc', doc: view.active, version: ds.copydoc }), { ok: '复制成了一份新简历' }).then(goImported); }
    if (ds.usev) return run('usev', () => act({ action: 'use_version', doc: view.active, version: ds.usev }), { ok: () => `恢复到 v${view.versions.find(x => x.id === ds.usev)?.k || ''}：这份简历现在用它` });
    if ('renamedoc' in ds) return renameDoc();
    if (ds.pick) { S.sel = ds.pick; paint(); return; }
    if (ds.diff) { location.hash = `#materials/compare?doc=${encodeURIComponent(view.active)}&a=${encodeURIComponent(ds.prev)}&b=${encodeURIComponent(ds.diff)}`; return; }
    if (ds.rename) { S.menu = null; paint(); return rename(ds.rename); }
    if (ds.default) { S.menu = null; return run('default', () => act({ action: 'set_default', doc: view.active, version: ds.default }), { ok: r => `以后投递用 ${r.vid || ds.default}` }); }
    // 重新解析换掉了 v1 的内容：做完再清掉预览的缓存（中途读到的旧内容也不要）。
    if (ds.reparse) return run('reparse', async () => { const r = await act({ action: 'reparse', doc: view.active, mode: ds.reparse }); S.pv.clear(); S.pvGen++; return r; }, { ok: ds.reparse === 'alt' ? '按原文顺序重新读好了' : '重新解析好了' });
    if (ds.refresh) return run('refresh', () => act({ action: 'refresh_default', doc: view.active, version: ds.refresh }), { ok: '投递用的 PDF 更新好了' });
    if (ds.import) return run('import', () => act({ action: 'import', upload_id: ds.import }), { ok: '导入好了：原简历存成 v1' }).then(goImported);
    if (ds.importCurrent) return run('import', () => act({ action: 'import_current', slot: ds.importCurrent }), { ok: '导入好了：原简历存成 v1' }).then(goImported);
    if (ds.letterOpen) { S.open = S.open === ds.letterOpen ? null : ds.letterOpen; paint(); return; }
    if (ds.letterUse) return run('l:' + ds.letterUse, () => act({ action: 'letter_decide', key: ds.letterUse, decision: 'use', fp: ds.fp }), { ok: r => r.receipt ? `用这一版了。${r.receipt}` : '用这一版了' });
    if (ds.letterSkip) return run('l:' + ds.letterSkip, () => act({ action: 'letter_decide', key: ds.letterSkip, decision: 'skip' }), { ok: '不用这一版了' });
  });
  root.addEventListener('change', e => {
    const sel = e.target.closest('[data-pick-select]');
    if (sel) { S.sel = sel.value; paint(); return; }
    const input = e.target.closest('[data-upload]');
    if (!input?.files?.[0]) return;
    const f = input.files[0];
    run('import', () => upload(f), { ok: r => r.status === 'exists' ? '这份简历导入过了' : '导入好了：原简历存成 v1' }).then(goImported);
  });
}
function goImported(r) { if (r?.id && /^r\d+$/.test(r.id)) location.hash = homeHash(r.id); }
