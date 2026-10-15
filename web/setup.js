// 「设置 → 检查清单」（以前是左侧的「开始使用」页，2026-09-30 挪进设置）：一张清单，从上往下做完，系统就能跑起来；
// 换电脑、换模型之后也拿它查哪里断了。全部做完时默认收起。一屏一个问题的引导在 web/onboarding.js（#onboarding）。
// 数据来自 /api/setup（lib/setup.mjs，只读）。你的方向、简历、个人资料、求职方向四项可以就地编辑（弹窗）：
// 简历走「上传 → 模型整理成草稿 → 勾选 / 改 → 保存」（/api/setup/resume*，lib/resume-import.mjs），
// 资料和方向走 /api/setup/profile（lib/profile.mjs）；「你的方向」是七张方向卡片 + 金融的细分 + 也看的方向，
// 每个方向能看一份虚构的示例资料（/api/setup/template，lib/direction-templates.mjs）。点保存之前不写 candidate/facts.yaml；
// 保存时旧版先备份到 candidate/backup-<时间>/，文件里的注释原样保留。保存完清单重新读一遍。
// 花费档位和每天上限走 /api/settings 的 pipeline 白名单（Patch 的记账，lib/spend.mjs）。
import { presetInbox } from './inbox.js';
import { configureGuide } from './onboarding.js';
import { tokenText, cnyText, CAP_TEXT } from './usage.js';
import { askConfirm } from './settings/ask.js';
import { paperPreviewHtml, fitPaperPreviews, mountSheetCss } from './resume-paper.js';
import { mountOriginalPdf } from './resume-pdf.js';
let h = null, token = '', pending = null, stale = false;
const ICON = { ok: '✓', warn: '!', missing: '○' };
const LABEL = { ok: '好了', warn: '要看一下', missing: '还没做' };
const TYPES = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', md: 'text/markdown' };
const LIMIT = 10 * 1024 * 1024;
// 收件箱、指挥台上的「补充」直接打开要补的那一组（lib/first-round.mjs verifyGap 的 fill：技能、工作经历、教育经历、工作许可）。
const SCOPES = { profile: { title: '编辑个人资料', groups: null }, location: { title: '城市', groups: ['location'] }, targets: { title: '求职方向与排除', groups: ['location', 'targets'] }, auth: { title: '工作许可', groups: ['auth'] }, skills: { title: '技能', groups: ['skills'] }, experience: { title: '工作经历', groups: ['experience', 'current'] }, education: { title: '教育经历', groups: ['education'] } };
const GROUPS = { identity: '身份与联系方式', education: '教育经历', certifications: '证书', experience: '工作经历', current: '现职', skills: '技能', location: '城市', auth: '工作许可', availability: '到岗', compensation: '薪酬', targets: '求职方向', resume: '简历文件' };
// ── 新加的界面文字（2026-09-29，按方向）：都在这里，做中英文切换时只换这一处 ─────────────────
// 方向名、简介、细分名不在这里：服务端从 lib/directions.mjs 给 zh / en 两种（LANG 选用哪一种）。
const LANG = 'zh';
const T = {
  // 清单上「你的方向」一项的按钮、资料编辑器里的方向那一行
  pickDirection: '选方向', changeDirection: '改方向',
  directionField: '求职方向',
  legacyDirection: name => '还没选方向，推荐暂不放',
  unknownDirection: raw => `资料里的方向「${raw}」认不出来，请重新选方向`,
  // 「你的方向」弹窗
  dirTitle: '你的方向',
  loading: '正在读取你的资料…',
  dirLead: '先选一个主方向：你的求职团队按它找岗位、判断值不值得投，也按它提醒你简历和资料还要补什么。想顺带看看别的方向，在下面「也看」里勾上。',
  legacyNote: name => `你的资料里还没写方向，选好以后再推荐。`,
  unknownNote: raw => `资料里写的「${raw}」认不出来；保存后换成你在这里选的。`,
  newFile: '还没有个人资料：保存时只记下方向，别的资料之后再补。',
  primaryLegend: '主方向（选一个）',
  example: '看示例',
  tracksLegend: dir => `${dir}里想做哪几类（可多选，先勾的排在前面；都不勾就是都看）`,
  alsoLegend: '也看（可选）：这些方向的岗位也推给你，排在主方向后面',
  pickFirst: '先选一个主方向',
  noChange: '没有改动',
  save: '保存方向',
  // 界面上不出现文件名、路径和命令（主会话 10-03）：旧版留了一份就说一句，不写在哪。
  saved: backup => `方向已保存${backup ? '（旧版已备份）' : ''}`,
  // 看示例
  exampleTitle: '示例资料',
  loadingExample: '正在读取示例…',
  exampleHeading: who => `示例：${who}`,
  fictional: '这是虚构的示例人物，只用来对照怎么写：不要原样复制，每一项都换成你自己的。',
  exampleFile: () => '开头的注释写了这个方向特别要填的几项。',
  back: '← 回到选方向',
  // 清单那一块的标题
  listTitle: '检查清单', listReady: (done, total) => `${done} / ${total} 项就绪`,
  listLead: '从上往下做完，系统就能自己扫岗位、判断、起草，要你拍板的事都会进收件箱。',
};
const esc = x => h.esc(x);
// 方向、细分的名字：服务端给 zh / en 两种（lib/directions.mjs），按 LANG 取。
const nameOf = o => o?.[LANG] || o?.zh || '';

// 简历草稿（上传了、还没勾选确认的那一份）：清单和引导的简历一步都看它。
export async function loadPending() {
  try { const d = await fetch('/api/setup/resume/draft'); pending = d.ok ? (await d.json()).draft || null : null; } catch { pending = null; }
  return pending;
}
// 引导先拿到 token（/api/onboarding/state 里有），第一次 POST 就不会先吃一个 403。
export function setToken(t) { if (t) token = t; }
export async function setupSection(helpers) {
  h = helpers;
  const [r] = await Promise.all([fetch('/api/setup'), loadPending()]);
  const v = await r.json();
  if (!r.ok) return `<section class="panel su-panel" id="settings-setup"><div class="panel-heading"><h2>${esc(T.listTitle)}</h2></div><p class="su-err">${esc(v.error || '读取失败')}</p></section>`;
  token = v.token || token;
  const edit = s => s.edit === 'resume' ? `<button type="button" class="primary mini" data-su-edit="resume">${pending?.materials?.status === 'pending' ? '继续加入材料' : pending ? '继续确认简历草稿' : '导入简历'}</button>` : s.edit === 'direction' ? `<button type="button" class="primary mini" data-su-edit="direction">${esc(s.status === 'missing' ? T.pickDirection : T.changeDirection)}</button>` : s.edit ? `<button type="button" class="primary mini" data-su-edit="${esc(s.edit)}">${s.edit === 'spend' ? '选档位和上限' : '编辑'}</button>` : '';
  const note = s => s.edit === 'resume' && pending ? `<p class="su-pending">上传的《${esc(pending.name)}》${pending.materials?.status === 'pending' ? '已确认个人资料，原文件还没加入材料，可以重试' : pending.extracting ? '正在后台整理' : pending.status === 'extracted' ? '已经整理成草稿，等你勾选确认' : '还没交给模型整理'}（${esc(h.fmt(pending.uploaded_at))}）。</p>` : '';
  const row = (s, i) => `<li class="su-step st-${esc(s.status)}"><span class="su-mark" aria-label="${esc(LABEL[s.status] || s.status)}">${ICON[s.status] || '·'}</span><div class="su-body"><div class="su-head"><b>${i + 1}. ${esc(s.title)}</b><span class="tag ${s.status === 'ok' ? 'green' : s.status === 'missing' ? 'red' : ''}">${esc(LABEL[s.status] || s.status)}</span></div><p class="su-summary">${esc(s.summary)}</p>${(s.detail || []).length ? `<ul class="su-detail">${s.detail.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}${note(s)}${s.edit || s.fix ? `<div class="su-actions">${edit(s)}${s.fix ? `<a class="secondary mini su-fix" href="${esc(s.fix.href)}" ${s.fix.filter ? `data-su-filter="${esc(s.fix.filter)}"` : ''}>${esc(s.fix.label)} →</a>` : ''}</div>` : ''}</div></li>`;
  // 全部做完时默认收起（app.js 按 data-key 记住你手动开合的状态）。
  const all = v.done === v.total;
  return `<section class="panel su-panel" id="settings-setup"><details class="su-fold" data-key="settings-setup" ${all ? '' : 'open'}><summary class="panel-heading"><h2>${esc(T.listTitle)}</h2><span class="tag ${all ? 'green' : ''}">${esc(T.listReady(v.done, v.total))}</span></summary><div class="setup"><div class="su-progress"><i style="width:${Math.round(v.done / v.total * 100)}%"></i></div><ol class="su-steps">${v.steps.map(row).join('')}</ol></div></details></section>`;
}
// 设置页（web/settings/）的行直接打开这几个编辑器：direction（你的方向 + 也看）、profile（整份资料）、resume、spend。
export function openEditor(kind, helpers, context = null) {
  h = helpers || h;
  return (kind === 'resume' ? openImport() : kind === 'direction' ? openDirection() : kind === 'spend' ? openSpend() : openProfile(kind, context)).catch(e => h.toast(e.message));
}
export function bindSetup() {
  // 收件箱只在启动时读一次 localStorage 里的筛选：直接设好这一页里的收件箱（同一个模块实例），不然会落在「全部」、第一封已选中。
  document.querySelectorAll('[data-su-filter]').forEach(a => a.onclick = () => presetInbox({ filter: a.dataset.suFilter }));
  document.querySelectorAll('[data-su-edit]').forEach(b => b.onclick = () => (b.dataset.suEdit === 'resume' ? openImport() : b.dataset.suEdit === 'direction' ? openDirection() : b.dataset.suEdit === 'spend' ? openSpend() : openProfile(b.dataset.suEdit)).catch(e => h.toast(e.message)));
}

// 引导（web/onboarding.js）用这里的带 token 的 POST 和导入简历的弹窗。
// useHelpers：引导页把页面的工具（esc、toast……）交过来。新装第一次打开就进引导，还没进过「设置」，这里的 h 还是空的，
// 点「导入简历」会报 Cannot read properties of null (reading 'esc')（09-30 新用户实测）。
configureGuide({ useHelpers: x => { if (x) h = x; }, send: (...a) => send(...a), openImport: () => openImport(), pending: () => pending, loadPending: () => loadPending(), setToken, reparse: () => (pending ? extract(pending, { force: true }) : Promise.resolve()) });

// ── 弹窗 ────────────────────────────────────────────────────────────────────
function dialog() {
  let d = document.querySelector('#su-dialog');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'su-dialog';
  d.innerHTML = '<div class="su-dlg"></div>';
  document.body.appendChild(d);
  // Esc 自己处理：Chrome 连按 Esc（中间没有别的点击）时 cancel 事件不可取消，改了一半的资料会被直接关掉（09-29 QA）。
  // 拦下 keydown 就不会触发关闭请求；有没保存的修改先问一句，确认了才关。
  d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  // 关闭请求（点外面以外的系统关闭）：有没保存的修改先拦下，问过再关。
  d.addEventListener('cancel', e => { if (d.dataset.dirty === '1') { e.preventDefault(); close(); } });
  d.addEventListener('input', e => { if (e.target.type !== 'file') d.dataset.dirty = '1'; });
  d.addEventListener('click', e => { if (e.target.closest('[data-su-close]')) close(); });
  // 上传 / 整理 / 保存之后关窗：清单重新读一遍（开着窗时工作台不重绘页面）。
  d.addEventListener('close', () => { d.__resumeResize?.disconnect(); d.__resumePdfCleanup?.(); if (stale) { stale = false; h.refresh(); } });
  return d;
}
function show(html, bind, { keepScroll = false } = {}) {
  const d = dialog(), top = d.scrollTop;
  d.querySelector('.su-dlg').innerHTML = html;
  d.dataset.dirty = '';
  if (!d.open) d.showModal();
  bind?.(d);
  bindResumeOriginal(d);
  d.scrollTop = keepScroll ? top : 0;
  return d;
}
// → Promise<true（关了）/ false（你选了接着改）>。有没保存的修改先在页面里问一句（App 里 window.confirm 不弹框）。
async function close({ force = false } = {}) {
  const d = document.querySelector('#su-dialog');
  if (!d?.open) return true;
  if (!force && d.dataset.dirty === '1' && !(await askConfirm({ title: '关掉这个窗口？', lines: ['刚才改的还没保存，关掉就没了。'], go: '不保存，关掉', cancel: '接着改', danger: true }))) return false;
  d.dataset.dirty = '';
  d.close();
  return true;
}
const actions = (...buttons) => `<div class="dialog-actions">${buttons.join('')}</div>`;
const closeBtn = (label = '关闭') => `<button type="button" class="secondary" data-su-close>${label}</button>`;
const errorBox = (msg = '') => `<p class="su-err" role="alert">${esc(msg)}</p>`;
async function getJSON(url) { const r = await fetch(url), v = await r.json(); if (!r.ok) throw Error(v.error || '读取失败'); return v; }
// 工作台重启过 token 就换了（开着弹窗时页面不重载）：403 时从 /api/setup 取新的再试一次。
async function freshToken() { try { const v = await getJSON('/api/setup'); if (v.token && v.token !== token) { token = v.token; return true; } } catch {} return false; }
export async function send(path, init, retried = false) {
  const r = await fetch(path, { ...init, method: 'POST', headers: { ...init.headers, 'X-Radar-Token': token } });
  const d = await r.json().catch(() => ({}));
  if (r.status === 403 && !retried && await freshToken()) return send(path, init, true);
  if (!r.ok) throw Object.assign(Error(d.error || '请求失败'), { status: r.status });
  return d;
}
const post = (path, body) => send(path, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const here = sel => !!document.querySelector(`#su-dialog[open] ${sel}`);
function saved(message) { stale = true; close({ force: true }); h.toast(message); }

// ── 表单控件：同一套给个人资料编辑器和简历草稿用 ─────────────────────────────
function control(name, f, value) {
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  if (f.kind === 'list' || f.kind === 'lines') { const list = Array.isArray(value) ? value : value ? [value] : []; return `<textarea name="${name}" data-kind="${f.kind}" rows="${Math.min(6, Math.max(2, list.length + 1))}"${ph}>${esc(list.join('\n'))}</textarea>`; }
  if (f.kind === 'choice') { const opts = { ...(f.options || {}) }; if (value && !(value in opts)) opts[value] = value; return `<select name="${name}" data-kind="choice">${Object.entries(opts).map(([k, l]) => `<option value="${esc(k)}" ${k === (value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`; }
  // 数字也用文本框：文件里写的是「30天」这类的也照样显示，不会被浏览器清空。
  if (f.kind === 'int') return `<input name="${name}" data-kind="int" type="text" inputmode="numeric" value="${esc(value ?? '')}"${ph}>`;
  return `<input name="${name}" data-kind="${esc(f.kind)}" type="${f.kind === 'email' ? 'email' : 'text'}" value="${esc(value ?? '')}"${ph}>`;
}
// 列表一行一项；新敲的一行再按逗号、顿号拆（括号里的不拆），原来就有的项原样保留（「Python（pandas、numpy）」不会被拆开）。
const splitLine = line => { const out = []; let depth = 0, cur = ''; for (const ch of line) { if ('（(【['.includes(ch)) depth++; else if ('）)】]'.includes(ch)) depth = Math.max(0, depth - 1); if (!depth && ',，、;；'.includes(ch)) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(x => x.trim()).filter(Boolean); };
export const readValue = (kind, raw, original = []) => {
  const lines = String(raw ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  if (kind === 'list') return [...new Set(lines.flatMap(l => original.includes(l) ? [l] : splitLine(l)))];
  if (kind === 'lines') return lines;
  // 不是数字就原样交给服务端拒绝（NaN 经 JSON 会变成 null = 清空）；全角数字按半角认。
  if (kind === 'int') { const s = String(raw ?? '').normalize('NFKC').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : s; }
  return String(raw ?? '').trim();
};
const valueOf = (el, original) => readValue(el.dataset.kind, el.value, original);
const fieldsOf = el => Object.fromEntries([...el.querySelectorAll('[name^="r:"]')].map(i => [i.name.slice(2), valueOf(i)]));
const blank = v => v == null || v === '' || (Array.isArray(v) && !v.length);
const same = (a, b) => (blank(a) && blank(b)) || JSON.stringify(typeof a === 'number' ? String(a) : a) === JSON.stringify(typeof b === 'number' ? String(b) : b);

// 现在的方向，一行：认得出的用服务端算好的摘要（lib/directions.mjs directionSummary）；没写就是软件（老规则）。
export const directionText = (cat = {}) => cat?.summary ? cat.summary[LANG] || cat.summary.zh : cat?.unknown?.length ? T.unknownDirection(cat.unknown.join('、')) : T.legacyDirection(softwareName(cat));
// 没写方向时按哪个方向处理：软件那一项的名字（服务端从 lib/directions.mjs 给）。
const softwareName = cat => nameOf(cat?.options?.find(o => o.key === 'software')) || 'software';

// ── 个人资料 / 方向：结构化编辑器 ─────────────────────────────────────────────
// 只提交改过的字段；教育 / 经历有任何增删改就整张表提交（带 i 的行对应文件里的那一条）。
export function profilePatch(view, form) {
  const set = {}, rows = {};
  for (const [p, v] of Object.entries(form.fields || {})) if (!same(view.fields[p]?.value, v)) set[p] = v;
  for (const [k, list] of Object.entries(form.rows || {})) {
    const orig = view.rows[k].items, keys = Object.keys(view.rows[k].fields);
    const kept = list.filter(r => r.i != null || keys.some(f => !blank(r[f])));
    if (kept.length !== orig.length || kept.some((r, n) => r.i !== orig[n].i || keys.some(f => !same(orig[n][f], r[f])))) rows[k] = kept;
  }
  return { set, rows };
}
async function openProfile(scope, context = null) {
  const cfg = SCOPES[scope] || SCOPES.profile;
  show(`<h2>${cfg.title}</h2><p class="muted">${esc(T.loading)}</p>`);
  let v;
  try { v = await getJSON('/api/setup/profile'); } catch (e) { show(`<h2>${cfg.title}</h2>${errorBox(e.message)}${actions(closeBtn())}`); return; }
  if (v.error) { show(`<h2>${cfg.title}</h2>${errorBox(v.error)}${actions(closeBtn())}`); return; }
  const groups = v.groups.filter(g => !cfg.groups || cfg.groups.includes(g.key));
  const rowHtml = (R, r = {}) => `<div class="su-row" ${r.i != null ? `data-i="${r.i}"` : 'data-new="1"'}>${Object.entries(R.fields).map(([k, f]) => `<label class="su-field${f.kind === 'lines' ? ' wide' : ''}"><span>${esc(f.label)}</span>${control(`r:${k}`, f, r[k])}</label>`).join('')}<button type="button" class="su-row-del" data-row-del title="删除这一条" aria-label="删除这一条">✕</button></div>`;
  const legend = g => `<legend>${esc(g.title)}${g.note ? ` <small class="muted">${esc(g.note)}</small>` : ''}</legend>`;
  // 方向和细分（picker）不在这里逐项改：显示一行现在的方向，改在「你的方向」弹窗里做（卡片、细分、看示例）。
  const picker = () => `<div class="su-field wide su-picked"><span>${esc(T.directionField)}</span><div class="su-picked-line"><b>${esc(directionText(v.directions))}</b><button type="button" class="secondary mini" data-su-direction>${esc(T.changeDirection)}</button></div></div>`;
  const group = g => {
    if (g.rows) { const R = v.rows[g.rows], items = R.items.length || context?.rows !== g.rows ? R.items : [{}]; return `<fieldset class="su-group">${legend(g)}<div class="su-rows" data-rows="${esc(g.rows)}">${items.map(r => rowHtml(R, r)).join('')}</div><button type="button" class="secondary mini" data-row-add="${esc(g.rows)}">＋ 加一条${esc(R.label)}</button></fieldset>`; }
    const fields = Object.entries(v.fields).filter(([, f]) => f.group === g.key);
    if (!fields.length) return '';
    // 文件里手写成一组结构化值的字段（f.complex）：这里改不了，先不列出来，保存时原样保留（主会话 10-03：不再写「请直接改某个文件」）。
    const shown = fields.filter(([, f]) => !f.picker && !f.complex), picked = fields.some(([, f]) => f.picker);
    if (!shown.length && !picked) return '';
    return `<fieldset class="su-group">${legend(g)}<div class="su-grid">${picked ? picker() : ''}${shown.map(([p, f]) => `<label class="su-field${f.kind === 'list' || f.kind === 'lines' ? ' wide' : ''}"><span>${esc(f.label)}</span>${control(`f:${p}`, f, f.value)}</label>`).join('')}</div></fieldset>`;
  };
  const why = context?.reason ? `<p class="su-lead" id="su-gap-context"><b>${esc(context.lead || '这条岗位')}</b><br>待核：${esc(context.reason)}${context.instruction ? `<br>${esc(context.instruction)}` : ''}</p>` : '';
  const opened = show(`<h2>${cfg.title}</h2>${v.broken ? `<p class="su-warn">${esc(v.broken)}</p>` : ''}${why}<p class="su-lead">保存前会留一份旧版；这里没列出的资料原样保留。${scope === 'profile' ? '身份证号、户籍、政治面貌、出生日期不在这里填。' : ''}</p><form class="su-form" novalidate>${groups.map(group).join('')}${actions(errorBox(), closeBtn('取消'), '<button type="submit" class="primary">保存</button>')}</form>`, d => {
    const form = d.querySelector('form'), err = d.querySelector('.su-err'), touched = new Set();
    // 只提交你动过的：没碰的字段不回传（免得把文件里的写法重新拆一遍），没碰的行按原样回传。
    form.addEventListener('input', e => { if (e.target.name?.startsWith('f:')) touched.add(e.target.name); const row = e.target.closest('.su-row'); if (row) row.dataset.touched = '1'; });
    // 改方向：换到「你的方向」弹窗（这里有没保存的修改先问一句）。
    d.querySelector('[data-su-direction]')?.addEventListener('click', async () => { if (await close()) openDirection().catch(e => h.toast(e.message)); });
    d.querySelectorAll('[data-row-add]').forEach(b => b.onclick = () => { const box = d.querySelector(`.su-rows[data-rows="${b.dataset.rowAdd}"]`); box.insertAdjacentHTML('beforeend', rowHtml(v.rows[b.dataset.rowAdd])); box.lastElementChild.querySelector('input,textarea')?.focus(); d.dataset.dirty = '1'; });
    form.addEventListener('click', e => { const del = e.target.closest('[data-row-del]'); if (del) { del.closest('.su-row').remove(); d.dataset.dirty = '1'; } });
    form.onsubmit = async e => {
      e.preventDefault();
      const original = (k, i) => v.rows[k].items.find(r => r.i === i);
      const collected = { fields: Object.fromEntries([...form.querySelectorAll('[name^="f:"]')].filter(el => touched.has(el.name)).map(el => [el.name.slice(2), valueOf(el, v.fields[el.name.slice(2)].value || [])])), rows: Object.fromEntries([...form.querySelectorAll('.su-rows')].map(box => [box.dataset.rows, [...box.querySelectorAll('.su-row')].map(el => el.dataset.i != null && el.dataset.touched !== '1' ? original(box.dataset.rows, Number(el.dataset.i)) : ({ ...(el.dataset.i != null ? { i: Number(el.dataset.i) } : {}), ...fieldsOf(el) }))])) };
      const patch = profilePatch(v, collected);
      if (!Object.keys(patch.set).length && !Object.keys(patch.rows).length) { err.textContent = '没有改动'; return; }
      const btn = e.submitter || form.querySelector('[type=submit]');
      btn.disabled = true; err.textContent = '';
      try { const r = await post('/api/setup/profile', { base: v.sig, ...patch }); saved(r.status === 'unchanged' ? '没有改动' : `已保存 ${r.changes.length} 项${r.backup ? '（旧版已备份）' : ''}`); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    };
  });
  if (context) {
    const controls = [...opened.querySelectorAll('input,textarea,select')];
    const target = context.field ? controls.find(el => el.name === `f:${context.field}`) : controls.find(el => el.closest('.su-rows')?.dataset.rows === context.rows && el.name === `r:${context.row_field}`);
    if (target) {
      target.setAttribute('aria-describedby', 'su-gap-context');
      target.focus({ preventScroll: true });
      const r = target.getBoundingClientRect(), box = opened.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) target.scrollIntoView({ block: 'nearest' });
    }
  }
}

// ── 花费档位与每天上限（Patch 的记账，lib/spend.mjs、docs/cost.md）──────────────
// 新用户第一次填 API key 时最该知道的事：花多少、能不能封顶。¥ 按价格表的汇率折成美元存（config/pipeline.json budget.daily_usd）。
const TIER_NAME = { economy: '省钱', standard: '标准', premium: '高级' };
// 表单本身：检查清单的弹窗和「设置 → 花费」共用同一份（同一条写入：/api/settings 的 pipeline 白名单）。
function spendFormHtml(v, { inline = false } = {}) {
  const b = v.budget, rate = v.prices?.usd_cny || 7, cny = b.cap.daily_usd != null ? Math.round(b.cap.daily_usd * rate * 100) / 100 : '';
  return `<p class="su-lead">今天已经用了 ${tokenText(v.today.tokens)} token${v.today.usd > 0 ? `，约 ${cnyText(v.today.cny)}` : ''}</p><form class="su-form${inline ? ' su-spend-inline' : ''}" novalidate><fieldset class="choices su-spend"><legend>花费档位</legend>${v.tiers.map(t => `<label class="choice"><input type="radio" name="tier" value="${esc(t.key)}" ${v.tier === t.key ? 'checked' : ''}><span><b>${esc(t.label)}</b><small>${esc(t.note)}</small></span></label>`).join('')}</fieldset><div class="us-inputs"><label><span>每天最多花</span><span class="us-in">¥ <input name="cny" inputmode="decimal" value="${esc(cny)}" placeholder="不限" autocomplete="off"></span></label><label><span>每天最多用（token）</span><input name="tokens" inputmode="numeric" value="${esc(b.cap.daily_tokens ?? '')}" placeholder="不限" autocomplete="off"></label></div><p class="muted small">${esc(CAP_TEXT)}</p>${errorBox()}${inline ? `<div class="dialog-actions"><button type="submit" class="primary">保存</button></div>` : actions(closeBtn('取消'), '<button type="submit" class="primary">保存</button>')}</form>`;
}
function bindSpendForm(form, v, done) {
  const err = form.querySelector('.su-err'), rate = v.prices?.usd_cny || 7;
  form.onsubmit = async e => {
    e.preventDefault();
    const tier = form.querySelector('input[name=tier]:checked')?.value || 'standard';
    const yuan = String(form.cny.value || '').normalize('NFKC').trim(), tokens = String(form.tokens.value || '').normalize('NFKC').replace(/[,，\s]/g, '').trim();
    if (yuan && !(Number(yuan) > 0)) { err.textContent = '每天最多花多少：写一个大于 0 的数，或者留空'; return; }
    if (tokens && !(Number.isInteger(Number(tokens)) && Number(tokens) >= 1000)) { err.textContent = 'token 上限：写一个不小于 1000 的整数，或者留空'; return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; err.textContent = '';
    try {
      const r = await post('/api/settings', { name: 'pipeline', patch: { spend_tier: tier, 'budget.daily_usd': yuan ? Math.round(Number(yuan) / rate * 10000) / 10000 : null, 'budget.daily_tokens': tokens ? Number(tokens) : null } });
      done(r.status === 'unchanged' ? '没有改动' : `已保存：${TIER_NAME[tier]}档，${yuan || tokens ? `每天最多${yuan ? ` 约 ¥${yuan}` : ''}${tokens ? ` ${tokenText(tokens)} token` : ''}` : '不设上限'}`);
    } catch (x) { err.textContent = x.message; btn.disabled = false; }
  };
}
async function openSpend() {
  const title = '<h2>花费档位与每天上限</h2>';
  show(`${title}<p class="muted">正在读取…</p>`);
  let v;
  try { v = await getJSON('/api/usage'); } catch (e) { show(`${title}${errorBox(e.message)}${actions(closeBtn())}`); return; }
  show(`${title}${spendFormHtml(v)}`, d => bindSpendForm(d.querySelector('form'), v, saved));
}
// 「设置 → 花费」：同一份表单直接摆在页面上；保存完这一块自己重画（输入框有焦点时工作台不重绘页面）。
let spendView = null;
export async function spendSection(helpers) {
  h = helpers;
  try { spendView = await getJSON('/api/usage'); } catch (e) { spendView = null; return `<section class="panel su-panel" id="settings-spend"><div class="panel-heading"><h2>花费</h2></div><p class="su-err">${esc(e.message)}</p></section>`; }
  return `<section class="panel su-panel" id="settings-spend"><div class="panel-heading"><h2>花费</h2><span class="tag">${esc(TIER_NAME[spendView.tier] || spendView.tier)}档</span></div><div class="setup su-inline">${spendFormHtml(spendView, { inline: true })}</div></section>`;
}
export function bindSpendSection() {
  const box = document.querySelector('#settings-spend'), form = box?.querySelector('form');
  if (!form || !spendView) return;
  bindSpendForm(form, spendView, async msg => { h.toast(msg); const html = await spendSection(h); document.querySelector('#settings-spend')?.replaceWith(Object.assign(document.createElement('div'), { innerHTML: html }).firstElementChild); bindSpendSection(); });
}

// ── 你的方向：七个方向做成卡片选主方向；金融显示细分；再勾「也看」的方向；每个方向都能看示例 ─────────────
// 名字和简介来自服务端（lib/directions.mjs 的 zh / en），保存走 /api/setup/profile 同一条写入路径（白名单、版本、备份）。
// 要保存的值：主方向在前，也看的跟在后面；细分只在主方向有细分（金融）时留着，换了主方向就清掉。
// 只提交和文件里不一样的项；文件里有认不出的写法时照样提交，好把它换掉。没选主方向返回 null。
export function directionPatch(v, state) {
  const opts = v.directions?.options || [], primary = opts.find(o => o.key === state.primary);
  if (!primary) return null;
  const directions = [primary.key, ...state.also.filter(k => k !== primary.key && opts.some(o => o.key === k))];
  const tracks = state.tracks.filter(k => (primary.tracks || []).some(t => t.key === k));
  const set = {};
  for (const [p, next] of [['preferences.directions', directions], ['preferences.tracks', tracks]]) {
    const f = v.fields?.[p] || {};
    if (JSON.stringify(f.value || []) !== JSON.stringify(next) || (f.unknown || []).length) set[p] = next;
  }
  return set;
}
async function openDirection() {
  show(`<h2>${esc(T.dirTitle)}</h2><p class="muted">${esc(T.loading)}</p>`);
  let v;
  try { v = await getJSON('/api/setup/profile'); } catch (e) { show(`<h2>${esc(T.dirTitle)}</h2>${errorBox(e.message)}${actions(closeBtn())}`); return; }
  if (v.error) { show(`<h2>${esc(T.dirTitle)}</h2>${errorBox(v.error)}${actions(closeBtn())}`); return; }
  const cur = v.fields['preferences.directions']?.value || [];
  const state = { primary: cur[0] || null, also: cur.slice(1), tracks: [...(v.fields['preferences.tracks']?.value || [])] };
  renderDirection(v, state, JSON.stringify(state));
}
function renderDirection(v, state, initial, { again = false } = {}) {
  const opts = v.directions.options, primary = opts.find(o => o.key === state.primary);
  const card = o => `<div class="su-dir${o.key === state.primary ? ' on' : ''}"><label><input type="radio" name="su-primary" value="${esc(o.key)}"${o.key === state.primary ? ' checked' : ''}><b>${esc(nameOf(o))}</b><span>${esc(o.blurb?.[LANG] || o.blurb?.zh || '')}</span></label><button type="button" class="su-example" data-su-example="${esc(o.key)}">${esc(T.example)} →</button></div>`;
  const check = (name, key, label, on) => `<label class="su-check"><input type="checkbox" name="${name}" value="${esc(key)}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  const tracks = primary?.tracks?.length ? `<fieldset class="su-group"><legend>${esc(T.tracksLegend(nameOf(primary)))}</legend><div class="su-checks">${primary.tracks.map(t => check('su-track', t.key, nameOf(t), state.tracks.includes(t.key))).join('')}</div></fieldset>` : '';
  const also = primary ? `<fieldset class="su-group"><legend>${esc(T.alsoLegend)}</legend><div class="su-checks">${opts.filter(o => o.key !== primary.key).map(o => check('su-also', o.key, nameOf(o), state.also.includes(o.key))).join('')}</div></fieldset>` : '';
  const notes = [v.broken || null, !v.exists ? T.newFile : !v.directions.written ? T.legacyNote(softwareName(v.directions)) : null, v.directions.unknown?.length ? T.unknownNote(v.directions.unknown.join('、')) : null].filter(Boolean);
  show(`<h2>${esc(T.dirTitle)}</h2><p class="su-lead">${esc(T.dirLead)}</p>${notes.map(n => `<p class="su-warn">${esc(n)}</p>`).join('')}<form class="su-form" novalidate><fieldset class="su-group"><legend>${esc(T.primaryLegend)}</legend><div class="su-dirs" role="radiogroup">${opts.map(card).join('')}</div></fieldset>${tracks}${also}${errorBox()}${actions(closeBtn('取消'), `<button type="submit" class="primary">${esc(T.save)}</button>`)}</form>`, d => {
    const form = d.querySelector('form'), err = form.querySelector('.su-err');
    const changed = () => JSON.stringify(state) !== initial;
    const mark = () => { d.dataset.dirty = changed() ? '1' : ''; };
    mark();
    // 换了主方向就重画（细分、也看跟着变），焦点留在选中的那张卡片上。
    if (again) d.querySelector('input[name="su-primary"]:checked')?.focus();
    const redraw = () => renderDirection(v, state, initial, { again: true });
    form.addEventListener('change', e => {
      const t = e.target;
      if (t.name === 'su-primary') { state.primary = t.value; state.also = state.also.filter(k => k !== t.value); redraw(); return; }
      const list = t.name === 'su-also' ? state.also : t.name === 'su-track' ? state.tracks : null;
      if (!list) return;
      const at = list.indexOf(t.value);
      if (t.checked && at < 0) list.push(t.value); else if (!t.checked && at >= 0) list.splice(at, 1);
      mark();
    });
    d.querySelectorAll('[data-su-example]').forEach(b => b.onclick = () => showExample(b.dataset.suExample, redraw, changed()));
    form.onsubmit = async e => {
      e.preventDefault();
      const set = directionPatch(v, state);
      if (!set) { err.textContent = T.pickFirst; return; }
      if (!Object.keys(set).length) { err.textContent = T.noChange; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; err.textContent = '';
      try { const r = await post('/api/setup/profile', { base: v.sig, set }); saved(r.status === 'unchanged' ? T.noChange : T.saved(r.backup)); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    };
  }, { keepScroll: again });
}
// 看示例：只读显示那一份示例（虚构的人），「回到选方向」回到刚才的选择（没保存的也还在）。
// 每次点「看示例」、每次回去都换一个编号：先点的那份晚到了，不会盖掉后点的（或已经回去的）那一屏。
let exampleSeq = 0;
async function showExample(key, back, dirty) {
  const mine = ++exampleSeq, current = () => mine === exampleSeq && here('[data-su-back]');
  const backBtn = `<button type="button" class="secondary" data-su-back>${esc(T.back)}</button>`;
  const keep = d => { d.dataset.dirty = dirty ? '1' : ''; d.querySelector('[data-su-back]').onclick = () => { exampleSeq++; back(); }; };
  show(`<h2>${esc(T.exampleTitle)}</h2><p class="muted">${esc(T.loadingExample)}</p>${actions(backBtn)}`, keep);
  let t;
  try { t = await getJSON(`/api/setup/template?direction=${encodeURIComponent(key)}`); }
  catch (e) { if (current()) show(`<h2>${esc(T.exampleTitle)}</h2>${errorBox(e.message)}${actions(backBtn, '<span class="grow"></span>', closeBtn())}`, keep); return; }
  if (!current()) return; // 读的时候窗口关了、回去了或者又点了别的示例：不再显示这一份
  show(`<h2>${esc(T.exampleHeading(t.who))}</h2><p class="su-warn">${esc(T.fictional)}</p>${t.note ? `<p class="su-lead">${esc(t.note)}</p>` : ''}<p class="su-lead">${esc(T.exampleFile(t.file))}</p><pre class="su-yaml" tabindex="0">${esc(t.text)}</pre>${actions(backBtn, '<span class="grow"></span>', closeBtn())}`, keep);
}

// ── 导入简历：选文件 → 上传 → 模型整理 → 核对 ─────────────────────────────────
async function openImport() {
  if (pending?.status === 'saved' && pending.materials?.status === 'pending') return showMaterials(pending);
  if (pending?.extracting) return show(`<h2>导入简历</h2><p class="su-lead">《${esc(pending.name)}》正在后台整理，好了会提示你；也可以过一会儿再点「继续确认简历草稿」。</p>${actions('<button type="button" class="secondary" data-su-discard>放弃它</button><span class="grow"></span>', closeBtn())}`, d => { const p = pending; d.querySelector('[data-su-discard]').onclick = () => discard(p); });
  if (pending?.status === 'extracted') return openReview(pending.id);
  if (pending?.status === 'uploaded') return show(`<h2>导入简历</h2><p class="su-lead">上次上传的《${esc(pending.name)}》读出了 ${pending.text_chars} 字，还没交给模型整理${pending.extract_error ? `（上次没成功：${esc(pending.extract_error)}）` : ''}。</p>${actions('<button type="button" class="secondary" data-su-discard>放弃它</button><span class="grow"></span>', closeBtn('稍后'), '<button type="button" class="secondary" data-su-new>换一份</button>', '<button type="button" class="primary" data-su-go>继续整理</button>')}`, d => {
    const p = pending;
    d.querySelector('[data-su-go]').onclick = () => extract(p);
    d.querySelector('[data-su-new]').onclick = () => picker();
    d.querySelector('[data-su-discard]').onclick = () => discard(p);
  });
  picker();
}
function showMaterials(v) {
  const waiting = v.materials?.status === 'pending';
  show(`<h2 data-su-materials="${esc(v.id)}">${waiting ? '个人资料已保存，材料还没加入' : '简历已加入材料'}</h2><p class="su-lead">《${esc(v.name)}》中你确认的个人资料已经保存。${waiting ? '原上传文件仍保留；重试只继续加入材料，无需重新解析或再次保存个人资料。' : '原文件已加入材料，可以打开查看。'}</p>${actions(errorBox(waiting ? v.materials.error || '材料入库尚未完成，可以重试。' : ''), closeBtn(waiting ? '稍后' : '关闭'), waiting ? '<button type="button" class="primary" data-su-materials-retry>重试加入材料</button>' : `<button type="button" class="primary" data-su-materials-open>查看材料</button>`)}`, d => {
    if (!waiting) {
      d.querySelector('[data-su-materials-open]').onclick = () => { close({ force: true }); location.hash = `#materials?doc=${encodeURIComponent(v.materials.doc)}`; };
      return;
    }
    const btn = d.querySelector('[data-su-materials-retry]'), err = d.querySelector('.su-err');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '正在加入材料…'; err.textContent = '';
      const stay = () => here(`[data-su-materials="${CSS.escape(v.id)}"]`);
      try {
        const r = await post('/api/setup/resume/save', { id: v.id });
        pending = r.pending || null; stale = true;
        if (stay()) showMaterials({ ...v, materials: r.materials });
        else { h.toast(r.said); if (!document.querySelector('dialog[open]')) { stale = false; h.refresh(); } }
      } catch (e) {
        if (!stay()) { h.toast(e.message); return; }
        err.textContent = e.message; btn.disabled = false; btn.textContent = '重试加入材料';
      }
    };
  });
}
function picker(message = '') {
  show(`<h2>导入简历</h2><p class="su-lead">PDF、Word（.docx）、TXT 或 Markdown，10 MB 以内，文字不超过 40000 字。你勾选、点保存之前不会改个人资料。</p><label class="su-drop"><input type="file" accept=".pdf,.docx,.txt,.md"><span class="su-drop-text">选一个文件，或拖到这里</span></label>${errorBox(message)}${actions(closeBtn('取消'), '<button type="button" class="primary" data-su-upload disabled>上传并整理</button>')}`, d => {
    let chosen = null;
    const input = d.querySelector('input[type=file]'), drop = d.querySelector('.su-drop'), go = d.querySelector('[data-su-upload]'), err = d.querySelector('.su-err');
    const choose = f => { chosen = f; err.textContent = check(f) || ''; d.querySelector('.su-drop-text').textContent = f ? `${f.name} · ${f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'}` : '选一个文件，或拖到这里'; go.disabled = !f || !!check(f); };
    input.onchange = () => choose(input.files[0] || null);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); choose(e.dataTransfer.files[0] || null); };
    go.onclick = () => chosen && upload(chosen);
  });
}
const extOf = name => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
function check(f) {
  if (!f) return '';
  if (!TYPES[extOf(f.name)]) return '只收 PDF、Word（.docx）、TXT、Markdown 文件（老的 .doc 请先另存为 .docx）';
  if (!f.size) return '文件是空的';
  if (f.size > LIMIT) return `文件 ${(f.size / 1048576).toFixed(1)} MB，超过 10 MB`;
  return '';
}
function progress(title, lines = [], preview = '', { id = '', stage = '' } = {}) {
  show(`<h2 ${id ? `data-extract="${esc(id)}"` : ''} ${stage ? `data-stage="${esc(stage)}"` : ''}>${esc(title)}</h2>${lines.map(l => `<p class="su-lead">${esc(l)}</p>`).join('')}<p class="su-busy"><span class="su-spin" aria-hidden="true"></span> 已经 <b id="su-elapsed">0 秒</b></p>${preview ? `<details class="su-preview"><summary>原文预览（前 600 字）</summary><pre>${esc(preview)}</pre></details>` : ''}${actions(closeBtn('在后台继续'))}`);
}
// 进度里的秒数：从上传那一刻起一直走到解析完（以前上传时一直是「0 秒」，解析又从 0 开始）。
function ticker(started) {
  const tick = setInterval(() => { const el = document.querySelector('#su-elapsed'); if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)} 秒`; else clearInterval(tick); }, 1000);
  return () => clearInterval(tick);
}
async function upload(file) {
  const bad = check(file);
  if (bad) return picker(bad);
  const started = Date.now();
  progress(`上传《${file.name}》…`, ['读文字只在这台电脑上做。'], '', { stage: 'upload' });
  const stopTick = ticker(started);
  // 上传要几秒到一分钟（读 PDF / Word）：这期间你关了窗、开了别的窗，结果就只在后台接着整理，不抢你的窗口。
  const stay = () => here('[data-stage="upload"]');
  let up;
  try { up = await send('/api/setup/resume', { headers: { 'Content-Type': TYPES[extOf(file.name)], 'X-File-Name': encodeURIComponent(file.name) }, body: file }); }
  catch (e) { stopTick(); return stay() ? picker(e.message) : h.toast(`《${file.name}》：${e.message}`); }
  finally { stopTick(); }
  if (up.status === 'unreadable') return stay() ? picker(`《${up.name}》：${up.error}`) : h.toast(`《${up.name}》：${up.error}`);
  pending = up; stale = true;
  if (stay()) return extract(up, { started });
  h.toast(`《${up.name}》传好了，正在后台整理`);
  try { await post('/api/setup/resume/extract', { id: up.id }); pending = { ...up, status: 'extracted' }; h.toast(`《${up.name}》整理好了：回到「设置 → 检查清单」或引导的简历一步，点「继续确认简历草稿」`); }
  catch (e) { h.toast(e.message); }
  if (!document.querySelector('dialog[open]')) { stale = false; h.refresh(); }
}
// 解析中：只说在解析哪一份、已经多久（10-01 开箱测试 #11：以前印着「读出 N 字」和前 600 字的原文，解析的一分钟里一直不变，像卡住了）。
// 读出来的文字在下一屏核对草稿时看。
async function extract(up, { force = false, started = Date.now() } = {}) {
  progress(`正在解析《${up.name}》`, up.warning ? [up.warning] : [], '', { id: up.id });
  // 窗口还停在这一份的进度上，结果才接着显示；关掉或换成别的窗口了，就只提示一句。
  const stay = () => here(`[data-extract="${CSS.escape(up.id)}"]`);
  const stopTick = ticker(started);
  try {
    const review = await post('/api/setup/resume/extract', force ? { id: up.id, force: true } : { id: up.id });
    stopTick();
    pending = { ...up, status: 'extracted' }; stale = true;
    if (stay()) renderReview(review);
    else { h.toast(`《${up.name}》整理好了：回到「设置 → 检查清单」或引导的简历一步，点「继续确认简历草稿」`); if (!document.querySelector('dialog[open]')) { stale = false; h.refresh(); } }
  } catch (e) {
    stopTick();
    if (!stay()) { h.toast(e.message); return; }
    let original = up;
    try { original = await getJSON(`/api/setup/resume/draft?id=${encodeURIComponent(up.id)}`); } catch {}
    if (!stay()) return;
    show(`<h2>没整理成</h2>${errorBox(e.message)}${resumeOriginalHtml(original)}${actions(closeBtn(), '<button type="button" class="secondary" data-su-manual>直接手填</button>', '<button type="button" class="secondary" data-su-new>换一份</button>', e.status === 413 ? '' : '<button type="button" class="primary" data-su-go>再试一次</button>')}`, d => {
      const retry = d.querySelector('[data-su-go]'); if (retry) retry.onclick = () => extract(up);
      d.querySelector('[data-su-new]').onclick = () => picker();
      d.querySelector('[data-su-manual]').onclick = () => openProfile('profile');
    });
  }
}
async function openReview(id, note = '') {
  show('<h2>核对简历草稿</h2><p class="muted">正在读取…</p>');
  try { renderReview(await getJSON(`/api/setup/resume/draft?id=${encodeURIComponent(id)}`), note); }
  catch (e) { show(`<h2>核对简历草稿</h2>${errorBox(e.message)}${actions(closeBtn())}`); }
}
const shortRow = r => [r.school || r.company || r.name, r.degree || r.title || r.status, [r.start, r.end].filter(Boolean).join(' – ') || r.date, r.gpa ? `GPA ${r.gpa}` : ''].filter(Boolean).join(' · ');
function currentText(i) {
  if (i.op === 'add') return '';
  if (i.type === 'file') return i.current ? `现在：${i.current}` : '现在：还没有文字版';
  if (i.current == null) return '现在：未填';
  if (i.type === 'row') return `现在：${shortRow(i.current)}`;
  if (i.type === 'current_work') return `现在：${shortRow(i.current)}`;
  return `现在：${Array.isArray(i.current) ? i.current.join('、') || '空' : i.options?.[i.current] || i.current}`;
}
function itemBody(i, v) {
  if (i.type === 'field') return `${control('v', { kind: i.kind, options: i.options }, i.value)}${i.added?.length ? `<small class="muted">新加：${esc(i.added.join('、'))}</small>` : ''}`;
  if (i.type === 'row') return `<div class="su-grid">${Object.entries(v.row_fields[i.section]).map(([k, f]) => `<label class="su-field${f.kind === 'lines' ? ' wide' : ''}"><span>${esc(f.label)}</span>${control(`r:${k}`, f, i.value[k])}</label>`).join('')}</div>`;
  if (i.type === 'current_work') return `<div class="su-grid">${[['company', '公司'], ['title', '职位'], ['start', '入职']].map(([k, l]) => `<label class="su-field"><span>${l}</span>${control(`r:${k}`, { kind: 'text' }, i.value[k])}</label>`).join('')}</div>`;
  return `<p class="su-file">${esc(i.text || '')}</p>`;
}
// 原始 PDF 与材料页的完整纸张预览共处一处；资料字段仍在下方核对，切换预览不重建表单。
export function resumeOriginalHtml(v = {}, escape = esc) {
  const full = typeof v.original_text === 'string' ? v.original_text : null;
  const text = full ?? String(v.preview || ''), chars = Number(v.text_chars) || text.length;
  if (!text && !v.original_url) return '';
  const pdf = v.ext === 'pdf' && v.original_url;
  // 旧服务的响应没有结构化预览时仍逐行显示完整可用文本，不把片段叫全文。
  const content = v.preview_content || { header: [], sections: [{ id: 'original', entries: [{ id: 'text', lines: text.split('\n').map((text, n) => ({ id: `original-${n}`, text })) }] }] };
  const incomplete = full == null && chars > text.length;
  return `<section class="su-resume-preview" aria-label="简历预览"><header class="rs-pv-h"><b>${escape(v.name || '简历预览')}</b><span class="grow"></span>${v.original_url ? `<a class="secondary mini" href="${escape(v.original_url)}&download=1" download>下载原文件</a>` : ''}</header>${pdf ? `<div class="su-resume-tabs" role="tablist" aria-label="预览内容"><button type="button" role="tab" aria-selected="true" data-su-preview="file">原始 PDF</button><button type="button" role="tab" aria-selected="false" data-su-preview="text">提取的文字 · ${chars} 字</button></div><div data-su-preview-panel="file"><p class="su-resume-file-note">${escape(v.name || '原始 PDF')} · 完整原文件</p><div class="su-resume-pdf" data-su-pdf="${escape(v.original_url)}" aria-label="${escape(v.name || '原始 PDF')}"></div></div>` : ''}<div data-su-preview-panel="text" ${pdf ? 'hidden' : ''}><p class="su-resume-file-note">${incomplete ? `当前只有 ${text.length} 字预览；请重新打开草稿读取全文。` : `完整提取内容 · ${chars} 字`}</p>${paperPreviewHtml(content)}</div></section>`;
}
function bindResumeOriginal(d) {
  d.__resumeResize?.disconnect();
  d.__resumePdfCleanup?.(); d.__resumePdfCleanup = null;
  const preview = d.querySelector('.su-resume-preview');
  if (!preview) return;
  mountSheetCss(); fitPaperPreviews(preview);
  if (typeof ResizeObserver !== 'undefined') {
    d.__resumeResize = new ResizeObserver(() => fitPaperPreviews(preview));
    d.__resumeResize.observe(preview);
  }
  for (const tab of preview.querySelectorAll('[data-su-preview]')) tab.onclick = () => {
    for (const t of preview.querySelectorAll('[data-su-preview]')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of preview.querySelectorAll('[data-su-preview-panel]')) p.hidden = p.dataset.suPreviewPanel !== tab.dataset.suPreview;
    fitPaperPreviews(preview);
  };
  const pdf = preview.querySelector('[data-su-pdf]');
  if (pdf) d.__resumePdfCleanup = mountOriginalPdf(pdf, pdf.dataset.suPdf);
}
function renderReview(v, note = '') {
  const done = `<h2>核对简历草稿</h2>`;
  if (!v.items.length) return show(`${done}<p class="su-lead">《${esc(v.name)}》里的资料和你现在的个人资料一样，没有要写的。</p>${resumeOriginalHtml(v)}${actions('<button type="button" class="secondary" data-su-discard>收起这份草稿</button>', closeBtn())}`, d => { d.querySelector('[data-su-discard]').onclick = () => discard(v); });
  const byKey = Object.fromEntries(v.items.map(i => [i.key, i]));
  const sections = Object.entries(GROUPS).map(([g, title]) => { const items = v.items.filter(i => i.group === g); return items.length ? `<fieldset class="su-group"><legend>${esc(title)}</legend>${items.map(i => `<div class="su-item" data-item="${esc(i.key)}"><label class="su-check"><input type="checkbox" data-key="${esc(i.key)}" ${i.checked ? 'checked' : ''}> <b>${esc(i.label)}</b>${i.op ? ` <span class="tag ${i.op === 'add' ? 'green' : ''}">${i.op === 'add' ? '新增' : '更新'}</span>` : ''}</label><div class="su-item-body">${itemBody(i, v)}${i.note ? `<small class="su-note">${esc(i.note)}</small>` : ''}</div>${currentText(i) ? `<small class="su-item-cur muted">${esc(currentText(i))}</small>` : ''}</div>`).join('')}</fieldset>` : ''; }).join('');
  show(`${done}${note ? `<p class="su-warn">${esc(note)}</p>` : ''}${v.offline_note ? `<p class="su-warn su-offline">${esc(v.offline_note)}</p>` : ''}<p class="su-lead">${esc(v.lead || `从《${v.name}》读出 ${v.text_chars} 字。`)}${v.keep ? esc(v.keep) : ''}</p>${v.warning ? `<p class="su-warn">${esc(v.warning)}</p>` : ''}${v.facts_error ? errorBox(v.facts_error) : ''}${resumeOriginalHtml(v)}<h3 class="su-review-heading">核对要保存的资料</h3><p class="su-lead">下方资料可修改，只保存勾选项。确认后，原文件会加入「材料」；默认投递简历保持不变。</p><form class="su-form" novalidate>${sections}${errorBox()}${actions('<button type="button" class="secondary" data-su-discard>放弃这份草稿</button><span class="grow"></span>', closeBtn('稍后再说'), '<button type="submit" class="primary">保存勾选的 <b class="su-count"></b> 项</button>')}</form>`, d => {
    const form = d.querySelector('form'), err = d.querySelector('form .su-err'), count = d.querySelector('.su-count'), edited = new Set();
    const refreshCount = () => { const n = form.querySelectorAll('input[data-key]:checked').length; count.textContent = n; form.querySelector('[type=submit]').disabled = !n; };
    refreshCount();
    form.addEventListener('change', e => { if (e.target.matches('input[data-key]')) refreshCount(); });
    // 改了内容就当你要它：顺手勾上。
    form.addEventListener('input', e => { const item = e.target.closest('.su-item'), box = item?.querySelector('input[data-key]'); if (!box || e.target === box) return; edited.add(item.dataset.item); if (!box.checked) { box.checked = true; refreshCount(); } });
    d.querySelector('[data-su-discard]').onclick = () => discard(v);
    form.onsubmit = async e => {
      e.preventDefault();
      const accept = {};
      for (const box of form.querySelectorAll('input[data-key]:checked')) {
        const i = byKey[box.dataset.key], el = box.closest('.su-item');
        // 没改过的项原样收下（true = 用草稿里的值），改过的才从表单里读。
        accept[i.key] = !edited.has(i.key) ? true : i.type === 'field' ? valueOf(el.querySelector('[name="v"]'), Array.isArray(i.value) ? i.value : []) : i.type === 'row' || i.type === 'current_work' ? fieldsOf(el) : true;
      }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; err.textContent = '';
      try {
        const r = await post('/api/setup/resume/save', { id: v.id, base: v.sig, accept });
        pending = r.pending || null;
        if (pending) { stale = true; showMaterials(pending); }
        else saved(r.said || `已写入 ${Object.keys(accept).length} 项`);
      }
      catch (x) { if (x.status === 409) return openReview(v.id, '个人资料刚在别处改过：下面已按最新的重新对照，请再看一眼。'); err.textContent = x.message; btn.disabled = false; }
    };
  });
}
async function discard(v) {
  if (!(await askConfirm({ title: `放弃《${v.name}》这份草稿？`, lines: ['整理出来的这些不会写进个人资料，个人资料不变。'], go: '放弃', danger: true }))) return;
  try { await post('/api/setup/resume/discard', { id: v.id }); pending = null; saved('已放弃这份草稿'); } catch (e) { h.toast(e.message); }
}
