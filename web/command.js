import { href } from './routes.js';
import { VERDICT_WORD } from './vocab.js';
// 指挥台页面：渲染 /api/command-center 的聚合视图，并把操作台的每个按钮接到
// /api/command（与飞书指挥室同一套指令）、/api/ops（手动触发脚本）、/api/unblock、
// /api/host-job、/api/draft（草稿编辑 / AI 重写）、/api/settings、/api/facts、
// /api/preference。这里不直接改任何状态文件。
// 模型 id 的人话在 web/labels.js（modelWords）；这个文件不 import（测试用 vm 直接跑它），labels.js 载入时挂在 window 上。
// 页面里的确认框（web/settings/ask.js 载入时挂在 window 上，同 labels.js；这个文件不 import）。
const askConfirm = o => globalThis.OfferCrewAsk.askConfirm(o);
const modelWords = id => (globalThis.OfferCrewLabels?.modelWords || String)(id);
const VERDICT_KEY = { 推荐: 'recommend', 待核: 'verify', 排除: 'exclude', 未判断: 'none', 预筛排除: 'prefiltered' };
const FILTER_LABEL = { status: '状态', channel: '渠道', city: '城市', verdict: '判断', stage: '阶段', source: '来源', human: '真人', today: '今日', failed: '匹配失败', open: '未结束', q: '搜索', company: '公司' };
// 门户 / 官方表单上的「投」就是飞书里的「投 N」（与刷卡「投递」同一规则，lib/flashcard.mjs plannedEffect）：
// 批准记下来，登录墙之后照样按它提交。2026-09-28 前这里发的是「N 联系」，点了投只会去找联系方式。
function pursueBtn(a) {
  const n = a.number ?? '{n}', rid = a.number == null ? { rid: a.record_id } : {};
  return a.channel === 'email' || !a.channel || a.channel === 'unknown' ? btn(`${n} 联系`, '联系', 'primary', rid) : btn(`投 ${n}`, '投', 'primary', { confirm: 1, ...rid });
}
let h, cc, consoleLog = [], opTimer = null, dialog = null, draftDialog = null, leadFilter = {}, leadView = 'open', leadPer = 'all', leadResults = null, leadsLoading = false, leadRequestId = 0;
const openState = new Set();

function btn(cmd, label, cls = 'secondary', opts = {}) {
  const attrs = Object.entries(opts).map(([k, v]) => `data-${k}="${h.esc(v)}"`).join(' ');
  return `<button class="${cls} mini" data-cmd="${h.esc(cmd)}" ${attrs}>${h.esc(label)}</button>`;
}
const num = n => n == null ? '' : `<span class="num">#${h.esc(n)}</span>`;
const pill = (state, text) => `<span class="pill ${h.esc(state)}">${state === 'running' ? '<i class="pulse"></i>' : ''}${h.esc(text)}</span>`;
const block = (title, body, extra = '') => `<div class="sub-block"><div class="sub-heading"><h3>${title}</h3>${extra}</div>${body}</div>`;
const section = (title, body, extra = '', cls = '') => `<section class="panel ${cls}"><div class="panel-heading"><h2>${title}</h2>${extra}</div>${body}</section>`;
const empty = t => `<div class="empty small">${h.esc(t)}</div>`;
const refs = (rs = []) => rs.map(r => { const f = r.file || r.screenshot; return f ? `<a class="ref" href="/api/evidence?file=${encodeURIComponent(f)}" target="_blank" rel="noopener">${/\.(png|jpe?g|webp|gif)$/i.test(f) ? '截图' : /\.log$/i.test(f) ? '日志' : '证据'} ↗</a>` : r.url ? h.link(r.url, '原始页面') : ''; }).join(' ');
const details = (key, summary, body, open = false) => `<details class="fold" data-key="${h.esc(key)}" ${openState.has(key) || open ? 'open' : ''}><summary>${summary}</summary>${body}</details>`;
// ── 分页 + 按公司聚合 ─────────────────────────────────────────────────────────
// 每个列表一个 key；页码与每页大小记在 localStorage，刷新后位置不变。同一家公司的
// 多条合成一组，默认只展开前 3 条，避免一家公司刷屏；分页按"组"翻，一页最多 8 组。
const PAGE_SIZES = [5, 8, 12, 15, 30];
let pageState = {}; try { pageState = JSON.parse(localStorage.getItem('radar.pages') || '{}'); } catch { pageState = {}; }
const savePages = () => { try { localStorage.setItem('radar.pages', JSON.stringify(pageState)); } catch {} };
const lists = new Map();
function groupRows(rows, by) {
  if (!by) return rows.map(r => ({ name: null, rows: [r] }));
  const m = new Map();
  for (const r of rows) { const k = String(by(r) || '（未知）'); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([name, rs]) => ({ name, rows: rs }));
}
function listHtml(key) {
  const L = lists.get(key); if (!L) return '';
  const groups = groupRows(L.rows, L.by);
  const st = pageState[key] || {}; const size = st.size || L.size || 8; const pages = Math.max(1, Math.ceil(groups.length / size)); const page = Math.min(pages, Math.max(1, st.page || 1));
  const slice = groups.slice((page - 1) * size, page * size);
  const body = slice.map(g => {
    if (!g.name || g.rows.length === 1) return g.rows.map(L.render).join('');
    const open = openState.has(`${key}|${g.name}`), show = open ? g.rows : g.rows.slice(0, L.show || 3);
    return `<div class="grp"><div class="grp-head"><b>${h.esc(g.name)}</b><span class="count">${g.rows.length} 条</span>${g.rows.length > (L.show || 3) ? `<button type="button" class="chip act" data-grp="${h.esc(key)}|${h.esc(g.name)}">${open ? '收起' : `展开全部 ${g.rows.length} 条`}</button>` : ''}</div>${show.map(L.render).join('')}</div>`;
  }).join('');
  const many = groups.length > size || (pageState[key]?.size && pageState[key].size !== (L.size || 8));
  const foot = L.rows.length ? `<div class="pager"><span class="muted small">共 ${L.rows.length} 条${L.by ? ` · ${groups.length} ${L.unit || '家'}` : ''}${!L.by ? ` · 本页第 ${(page - 1) * size + 1}–${Math.min(page * size, L.rows.length)} 条` : ''}${pages > 1 ? ` · 第 ${page} / ${pages} 页` : ''}</span><span class="grow"></span>${pages > 1 ? `<button type="button" class="chip act" data-pg="${h.esc(key)}|${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button><button type="button" class="chip act" data-pg="${h.esc(key)}|${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页 ›</button>` : ''}${many || pages > 1 ? `<select class="pager-size" data-size="${h.esc(key)}">${PAGE_SIZES.map(n => `<option value="${n}" ${n === size ? 'selected' : ''}>每页 ${n}${L.by ? ' 家' : ' 条'}</option>`).join('')}</select>` : ''}</div>` : '';
  return `<div class="list" id="list-${h.esc(key)}">${body || (L.empty ? empty(L.empty) : '')}${foot}</div>`;
}
// 登记一个列表并返回它的 HTML；rows 里每一项由 render 画。
function list(key, rows, render, { by = null, size = 8, show = 3, unit = '家', empty: emptyText = '' } = {}) {
  lists.set(key, { rows, render, by, size, show, unit, empty: emptyText });
  return listHtml(key);
}
function paintList(key) { const el = document.getElementById('list-' + key); if (!el) return; const y = window.scrollY, hgt = el.offsetHeight; el.outerHTML = listHtml(key); const n = document.getElementById('list-' + key); if (n && n.offsetHeight < hgt) n.style.minHeight = hgt + 'px'; window.scrollTo(0, y); bindDynamic(n); if (key === 'memory' && n) bindMemory(n); }
const fchip = (key, value, label, cls = '') => `<button class="chip act ${cls} ${(leadFilter[key] || []).includes(String(value)) ? 'on' : ''}" data-filter="${h.esc(key)}:${h.esc(value)}">${label}</button>`;

// ── 操作台 ───────────────────────────────────────────────────────────────────
const consoleLogHtml = () => consoleLog.map(l => `<div class="console-line ${h.esc(l.kind)}"><time>${h.clock(l.at)}</time><span><b>${h.esc(l.input)}</b> → ${h.esc(l.text)}${l.navigate ? ` <a href="${h.esc(l.navigate)}">打开 →</a>` : ''}</span></div>`).join('');
// 输入框有焦点时页面不整体重绘（避免打断输入），所以回执直接画进日志框。
function logLine(input, text, kind = 'ok', extra = {}) {
  consoleLog.unshift({ at: new Date().toISOString(), input, text, kind, ...extra }); consoleLog = consoleLog.slice(0, 30);
  const box = document.querySelector('#console-log'); if (box) { box.hidden = false; box.innerHTML = consoleLogHtml(); }
}
// ── 等我处理 ─────────────────────────────────────────────────────────────────
const CHANNEL_NAMES = { email: '邮件', platform_dm: '平台私信', wechat: '微信', ats_form: '官方表单', portal: '门户', referral: '内推请求', unknown: '待定渠道' };
// ── 线索集（可点击筛选） ─────────────────────────────────────────────────────
// 顶部统计格是互斥的「视图」（点一个替换上一个）；芯片 / 阶段条是可叠加的「标签」：
// 同一类多选取或、不同类之间取交集，点一下加、再点一下去。排除与冲刺 Backlog 默认不出现。
const LEAD_VIEWS = { open: ['待处理', { open: '1' }], decided: ['已处理', { decided: '1' }], recommend: ['推荐', { open: '1', verdict: 'recommend' }], human: ['真人帖', { open: '1', human: '1' }], today: ['今日新增', { today: '1' }], backlog: ['其他城市', { view: 'backlog' }], failed: ['匹配失败', { failed: '1' }], excluded: ['已排除', { view: 'excluded' }] };
const LEAD_STATUS = { new: '新线索', contacted: '已联系', applied: '已投递', replied: '已回复', interviewing: '面试中', offer: 'Offer', rejected: '已拒绝', closed: '已关闭' };
const hasLeadQuery = () => !!leadView || Object.values(leadFilter).some(v => v && v.length);
const leadParams = () => { const p = new URLSearchParams(); if (leadView) for (const [k, v] of Object.entries(LEAD_VIEWS[leadView][1])) p.set(k, v); for (const [k, v] of Object.entries(leadFilter)) if (v && v.length) p.set(k, v.join(',')); p.set('per_company', String(leadPer)); p.set('limit', '300'); return p; };
const boardHref = () => { const p = new URLSearchParams(); if (leadView) for (const [k, v] of Object.entries(LEAD_VIEWS[leadView][1])) if (k !== 'view') p.set(k, v); for (const [k, v] of Object.entries(leadFilter)) if (v && v.length && ['city', 'verdict', 'stage', 'source', 'company', 'q'].includes(k)) p.set(k, v[0]); return href.command({ tab: 'all', verdict: { prefiltered: 'prefilter' }[p.get('verdict')] || p.get('verdict'), q: p.get('q') || p.get('company') }); };
const tagLabel = (k, v) => k === 'status' ? LEAD_STATUS[v] || v : k === 'channel' ? CHANNEL_NAMES[v] || v : v;
function leadResultsHtml() {
  if (!hasLeadQuery()) return '';
  const viewChip = leadView ? `<button class="chip act on" data-view="${h.esc(leadView)}" title="${leadView === 'open' ? '默认视图：还没点过联系 / 投 / pass 的线索' : '点一下回到待处理'}">${h.esc(LEAD_VIEWS[leadView][0])}${leadView === 'open' ? '' : ' ×'}</button>` : '';
  const tags = Object.entries(leadFilter).flatMap(([k, vs]) => (vs || []).map(v => `<button class="chip act on" data-filter="${h.esc(k)}:${h.esc(v)}" title="点一下去掉">${h.esc(FILTER_LABEL[k] || k)} ${h.esc(tagLabel(k, v))} ×</button>`)).join('');
  const per = `<span class="per-select">每家${[['3', '3'], ['10', '10'], ['all', '全部']].map(([v, l]) => `<button class="chip act ${String(leadPer) === v ? 'on' : ''}" data-per="${v}">${l}</button>`).join('')}</span>`;
  const head = `<div class="filter-bar"><span class="muted small">筛选：</span>${viewChip}${tags}<button class="chip act" id="filter-clear">清空</button>${per}<a class="chip quiet" href="${boardHref()}">在指挥台打开</a>${leadView === 'excluded' ? '' : '<button class="chip quiet act" data-view="excluded">查看已排除</button>'}<span class="grow"></span>${leadsLoading ? '<span class="muted small">加载中…</span>' : ''}</div>`;
  if (!leadResults) return head;
  const R = leadResults;
  const summary = `<div class="lead-summary">当前筛选 ${h.esc(R.total)} 条 · ${h.esc(R.companies)} 家${R.collapsed ? ` · 每家最多 ${h.esc(R.per_company)} 条，仅列出 ${h.esc(R.shown)} 条，隐藏 ${h.esc(R.collapsed)} 条 <button class="chip act" data-per="all">显示全部 ${h.esc(R.total)} 条</button>` : ' · 全部列出，按页浏览'}${R.view === 'backlog' ? ' · 其他城市：照常匹配，不发新外联' : ''}</div>`;
  // 每行同一结构、同一列宽：编号 | 公司 | 岗位 + 元信息 + 标签 | 四个固定动作位（详情 · 原帖 · 主动作 · pass）。
  // 主动作由渠道决定：邮件→联系；官方表单且可自动投→投；门户→在专用 Chrome 里打开；其它→找联系方式。空位也占宽，保证对齐。
  // Radar 只做筛选决策：要投 / 要联系 → 「N 联系」（=争取这个岗位，交给 Reacher 起草 / 排队）；真正的发送与提交在 Reacher。
  const PASS_REASONS = '方向不对|城市不对|年限或级别不符|公司不想去|薪资不符|不填原因';
  const primary = r => { if (r.state && r.state !== 'new') return `<span class="muted small decided">${h.esc(r.state_label || r.status_label || '')}</span>`; return pursueBtn({ number: r.number, record_id: r.id, channel: r.channel }); };
  const slot = (html, cls = '') => `<span class="slot ${cls}">${html || ''}</span>`;
  const row = r => `<div class="lead-row st-${h.esc(r.status)}"><span class="num">${r.number != null ? '#' + h.esc(r.number) : '—'}</span><span class="co" title="${h.esc(r.company || '')}">${h.esc(r.company || '未知公司')}</span><div class="grow"><a href="${h.leadUrl(r.id)}" title="${h.esc(r.gap || '')}">${h.esc(r.role)}</a><span class="meta muted">${h.esc(r.city || r.location || '')} · ${h.esc(r.source)}${r.human ? ' · 真人' : ''}${r.score != null ? ` · ${h.esc(r.score)} 分` : ''}</span><span class="tags"><span class="tag st-${h.esc(r.status)}">${h.esc(r.status_label || LEAD_STATUS[r.status] || r.status)}</span><span class="tag quiet">${h.esc(CHANNEL_NAMES[r.channel] || r.channel_label || r.channel)}</span>${r.sprint_hold ? '<span class="tag quiet">其他城市</span>' : ''}${r.verdict === 'exclude' ? '<span class="tag red">已排除</span>' : ''}</span></div><span class="lead-actions">${slot(`<a class="secondary mini btn-link" href="${h.leadUrl(r.id)}">详情</a>`)}${slot(r.url ? `<button type="button" class="secondary mini" data-open-url="${h.esc(r.url)}" title="在浏览器里打开原帖">原帖</button>` : '')}${slot(primary(r), 'main')}${slot(!['closed', 'rejected', 'offer'].includes(r.status) && r.verdict !== 'exclude' && !/^pass/.test(r.state || '') ? btn(`pass ${r.number ?? '{n}'} {x}`, 'pass', 'secondary', { prompt: 'choice', options: PASS_REASONS, title: '为什么 pass（可不填）', ...(r.number == null ? { rid: r.id } : {}) }) : '')}</span></div>`;
  const f = R.facets || {};
  const group = (label, chips) => chips ? `<span class="facet-group"><span class="facet-label">${label}</span>${chips}</span>` : '';
  const facets = `<div class="chips facets">${group('城市', (f.city || []).slice(0, 8).map(([k, v]) => fchip('city', k, `${h.esc(k)} ${v}`)).join(''))}${group('判断', (f.verdict || []).filter(([k]) => !/排除/.test(k)).map(([k, v]) => fchip('verdict', VERDICT_KEY[k] || k, `${h.esc(k)} ${v}`, 'quiet')).join(''))}${group('来源', (f.source || []).slice(0, 8).map(([k, v]) => fchip('source', k, `${h.esc(k)} ${v}`, 'quiet')).join(''))}</div>`;
  return head + summary + facets + `<div class="mini-list lead-grid">${list('lead-results', R.rows, row, { size: 12, empty: '这个筛选下没有线索。' })}</div>`;
}
async function loadLeads({ quiet = false } = {}) {
  const requestId = ++leadRequestId;
  if (!hasLeadQuery()) { leadResults = null; leadsLoading = false; paintLeads(); return; }
  const params = leadParams().toString();
  leadsLoading = true; if (!quiet) paintLeads();
  try {
    const r = await fetch('/api/leads?' + params), d = await r.json();
    while (r.ok && d.has_more && requestId === leadRequestId) {
      const next = await fetch('/api/leads?' + params + '&offset=' + d.rows.length), page = await next.json();
      if (!next.ok) throw Error(page.error || '加载下一页失败');
      if (!page.rows?.length) break;
      d.rows.push(...page.rows); d.has_more = page.has_more;
    }
    if (requestId !== leadRequestId) return;
    if (!r.ok) throw Error(d.error);
    leadResults = d;
  } catch (e) { if (requestId === leadRequestId) h.toast(e.message); }
  finally { if (requestId === leadRequestId) { leadsLoading = false; paintLeads(); } }
}
// 结果区只长不缩：点筛选时它先变成一行「加载中」，页面一变短浏览器就把滚动位置夹到顶上；
// 把它撑到之前的高度，滚动条就留在原地（整页重绘时由 render() 重置）。
function paintLeads() {
  const box = document.querySelector('#lead-results'); if (!box) return;
  const y = window.scrollY, keep = Math.max(box.offsetHeight, Number(box.dataset.minH) || 0);
  if (keep) { box.dataset.minH = String(keep); box.style.minHeight = keep + 'px'; }
  box.innerHTML = leadResultsHtml();
  if (!hasLeadQuery()) { box.style.minHeight = ''; delete box.dataset.minH; }
  window.scrollTo(0, y);
  document.querySelectorAll('[data-filter]').forEach(b => { const [k, v] = splitFilter(b.dataset.filter); b.classList.toggle('on', (leadFilter[k] || []).includes(v)); });
  document.querySelectorAll('.stat-mini[data-view]').forEach(b => b.classList.toggle('on', leadView === b.dataset.view));
  bindDynamic(box);
}
const splitFilter = s => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; };
// ── 个人信息（可改）与偏好（可调） ──────────────────────────────────────────
const factValue = (P, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), P);
// 枚举值给你看中文（web/labels.js，app.js 载入时挂在 globalThis.OfferCrewLabels）；改的时候对话框里仍是原值。
const LBL = () => globalThis.OfferCrewLabels || { valueLabel: x => String(x ?? ''), prefLabel: (d, v) => (v == null ? String(d) : `${d}:${v}`) };
const valueLabel = v => LBL().valueLabel(v), prefLabel = (d, v) => LBL().prefLabel(d, v);
const showValue = v => Array.isArray(v) ? v.map(x => h.esc(valueLabel(x))).join('、') : v == null || v === '' ? '<span class="muted">未填</span>' : h.esc(valueLabel(v));
function profilePanel() {
  const P = cc.profile;
  if (P.error) return section('个人信息', empty(P.error));
  const fields = cc.settings?.facts || {};
  const groups = [['联系方式', ['identity.email', 'identity.phone_cn', 'identity.linkedin', 'identity.github']], ['城市与方式', ['location.current_city', 'location.target_cities', 'location.relocation_ok', 'location.work_mode_preference', 'location.onsite_5days_acceptable', 'location.travel_ok']], ['到岗', ['availability.current_status', 'availability.notice_period_days', 'availability.earliest_start', 'availability.notice_can_shorten']], ['薪酬', ['compensation.expected_annual_cny', 'compensation.floor_annual_cny', 'compensation.current_annual_cny', 'compensation.expected_annual_usd_remote', 'compensation.equity_preference']], ['偏好', ['preferences.company_priority', 'preferences.role_families', 'preferences.hard_exclusions', 'preferences.soft_exclusions']], ['配合方式', ['communication.daily_feedback_budget_minutes']], ['固定回答', ['standard_answers.why_leaving', 'standard_answers.management_experience', 'standard_answers.biggest_strength']]];
  const row = path => { const f = fields[path]; if (!f) return ''; const v = factValue(P, path), salary = /^compensation\..*_annual_/.test(path) ? globalThis.OfferCrewSettingsWords : null, parts = salary?.salaryParts(v), history = parts?.history ? `<details class="small"><summary>校正记录</summary>${h.esc(parts.history)}</details>` : ''; return `<div><dt>${h.esc(f.label)}</dt><dd>${salary ? showValue(salary.salaryText(v)) : showValue(v)}${history} <button class="edit" data-fact="${h.esc(path)}" data-kind="${h.esc(f.kind)}" data-label="${h.esc(f.label)}" data-value="${h.esc(Array.isArray(v) ? v.join('，') : v ?? '')}" ${f.options ? `data-options="${h.esc(f.options.join(','))}"` : ''} title="修改">✎</button></dd></div>`; };
  const id = P.identity;
  const body = `<dl class="kv wide"><div><dt>姓名</dt><dd>${h.esc(id.name_zh || '')} / ${h.esc(id.name_en || '')}</dd></div>${P.current_work ? `<div><dt>现职</dt><dd>${h.esc(P.current_work.company)} · ${h.esc(P.current_work.title)} · ${h.esc(P.current_work.start)} 至今</dd></div>` : ''}</dl>
    ${groups.map(([title, paths]) => `<h3 class="sub">${title}</h3><dl class="kv wide">${paths.map(row).join('')}</dl>`).join('')}
    <h3 class="sub">简历文件</h3><div class="mini-list">${P.resumes.map(r => `<div class="mini-row"><span class="grow">${h.esc(String(r.path || '').split('/').pop())}</span>${r.exists ? `<span class="tag green">${Math.round(r.size / 1024)} KB · ${h.fmt(r.mtime)}</span>` : '<span class="tag red">缺失</span>'}</div>`).join('')}</div>
    ${P.highlights.length ? `<h3 class="sub">经历</h3><div class="chips">${P.highlights.map(e => `<span class="chip quiet">${h.esc(e.company)} · ${h.esc(e.role)} · ${h.esc(e.dates)}</span>`).join('')}</div>` : ''}
    ${P.projects.length ? `<div class="chips">${P.projects.map(p => `<span class="chip quiet">${p.url ? h.link(p.url, p.name) : h.esc(p.name)}</span>`).join('')}</div>` : ''}
    ${P.todos.length ? `<h3 class="sub">待补的个人事实 <span class="tag">${P.todos.length}</span></h3><div class="mini-list">${P.todos.map(t => `<div class="mini-row"><span class="grow">${h.esc(fields[t.path]?.label || t.label || '待补')} <span class="muted">${h.esc(valueLabel(t.value))}</span> ${fields[t.path] ? `<button class="edit" data-fact="${h.esc(t.path)}" data-kind="${h.esc(fields[t.path].kind)}" data-label="${h.esc(fields[t.path].label)}" data-value="">✎</button>` : ''}</span></div>`).join('')}</div>` : ''}
    <p class="muted small">最近修改 ${h.fmt(P.facts_mtime)}</p>`;
  return section('个人信息', body);
}
function preferencesPanel() {
  const P = cc.preferences;
  const addBtn = '<button class="chip act" id="pref-add">＋ 添加手动偏好</button>';
  if (!P) return section('偏好学习', empty('还没有偏好表') + `<div class="chips">${addBtn}</div>`);
  const chip = x => `<button class="chip act ${x.weight > 0 ? 'good' : 'bad'}" data-pref="${h.esc(x.dimension)}:${h.esc(x.value)}" data-weight="${x.weight.toFixed(1)}" title="正 ${x.positive} · 负 ${x.negative}${x.demoted ? ' · 已降权' : ''}">${h.esc(prefLabel(x.dimension, x.value))} ${x.weight > 0 ? '+' : ''}${x.weight.toFixed(1)}</button>`;
  const manual = Object.entries(P.manual || {});
  return section('偏好学习', `<p class="muted small">${P.signals ?? 0} 条信号 · 更新 ${h.fmt(P.updated_at)} · 学到的排除规则 ${P.learned_rules}${P.learned_disabled ? `（停用 ${P.learned_disabled}）` : ''}</p>
    <h3 class="sub">加权</h3><div class="chips">${P.positive.map(chip).join('') || '<span class="muted small">无</span>'}</div>
    <h3 class="sub">降权</h3><div class="chips">${P.negative.map(chip).join('') || '<span class="muted small">无</span>'}</div>
    <h3 class="sub">手改</h3><div class="chips">${manual.map(([k, v]) => `<span class="chip on">${h.esc(prefLabel(k))} ${v > 0 ? '+' : ''}${h.esc(v)} <button class="x" data-pref-clear="${h.esc(k)}" title="撤销">×</button></span>`).join('')}${addBtn}</div>`);
}

// ── 记忆库 ───────────────────────────────────────────────────────────────────
const MEM_KINDS = { decision: '决定', lesson: '教训', company: '公司备注', preference: '个人偏好', todo: '待办', fact: '事实' };
// 谁记的：说人话（10-01：页面上直接印着 claude / codex / chat）。
const MEM_BY = { user: '你', dashboard: '你', chat: '对话里记下', claude: '团队记下', codex: '团队记下', system: '系统记下' };
const memBy = b => MEM_BY[b] || '系统记下';
let memFilter = { kind: '', q: '' }, memRows = null;
function memRow(n) {
  return `<div class="mem-row ${n.pinned ? 'pinned' : ''}" data-mem="${h.esc(n.id)}"><span class="tag ${n.kind === 'lesson' ? 'red' : n.kind === 'preference' || n.kind === 'decision' ? 'green' : ''}">${h.esc(MEM_KINDS[n.kind] || n.kind)}</span><div class="grow">${n.subject ? `<b>${h.esc(n.subject)}</b> ` : ''}${h.esc(n.shown || n.text)}<br><small class="muted">${h.esc(memBy(n.by))} · ${h.fmt(n.updated_at || n.at)}${(n.numbers || []).length ? ' · #' + n.numbers.map(h.esc).join(' #') : ''}${(n.companies || []).length ? ' · ' + n.companies.map(h.esc).join('、') : ''} ${n.evidence ? (/^https?:/.test(n.evidence) ? h.link(n.evidence, '证据') : `<a class="ref" href="/api/evidence?file=${encodeURIComponent(n.evidence)}" target="_blank" rel="noopener">证据 ↗</a>`) : ''}</small></div><span class="actions"><button class="edit" data-mem-pin="${h.esc(n.id)}" data-pinned="${n.pinned ? 1 : 0}" title="${n.pinned ? '取消置顶' : '置顶：任何查询都优先带上'}">${n.pinned ? '★' : '☆'}</button><button class="edit" data-mem-edit="${h.esc(n.id)}" data-text="${h.esc(n.text)}" title="改正文">✎</button><button class="edit" data-mem-del="${h.esc(n.id)}" title="删除">×</button></span></div>`;
}
function memListHtml() {
  const rows = memRows ? memRows.rows : cc.memory.recent;
  const total = memRows ? memRows.total : cc.memory.stats.total;
  return list('memory', rows, memRow, { size: 8, empty: memFilter.kind || memFilter.q ? '这个筛选下没有条目。' : '记忆库还是空的。' }) + (total > rows.length ? `<div class="more">共 ${total} 条，已载入 ${rows.length}</div>` : '');
}
function memoryPanel() {
  const M = cc.memory || { stats: { total: 0, by_kind: {}, by_author: {} }, recent: [] };
  const kinds = Object.entries(MEM_KINDS).map(([k, v]) => `<button class="chip act ${memFilter.kind === k ? 'on' : ''}" data-mem-filter="${k}">${v} ${M.stats.by_kind[k] || 0}</button>`).join('');
  const byWho = {}; for (const [k, v] of Object.entries(M.stats.by_author || {})) byWho[memBy(k)] = (byWho[memBy(k)] || 0) + v;
  const authors = Object.entries(byWho).map(([k, v]) => `<span class="chip quiet">${h.esc(k)} ${v}</span>`).join('');
  const form = `<form id="mem-form" class="mem-form"><select id="mem-kind">${Object.entries(MEM_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><input id="mem-subject" placeholder="主题（公司 / 岗位 / 可空）"><input id="mem-numbers" placeholder="岗位编号（可空）" size="14"><input id="mem-text" placeholder="一句话" required><button class="primary mini" type="submit">记住</button></form>`;
  return section('记忆库', `<div class="chips">${kinds}${authors}</div>
    <div class="filter-bar"><input id="mem-search" type="search" placeholder="搜关键词、公司、编号…" value="${h.esc(memFilter.q)}"><span class="grow"></span>${memFilter.kind || memFilter.q ? '<button class="chip act" id="mem-clear">清空筛选</button>' : ''}</div>
    <div class="mem-list" id="mem-list">${memListHtml()}</div>
    ${form}`, `<span class="muted small">共 ${M.stats.total} 条${M.stats.pinned ? ` · 置顶 ${M.stats.pinned}` : ''}</span>`);
}
async function loadMemory() {
  if (!memFilter.kind && !memFilter.q) { memRows = null; paintMemory(); return; }
  try { const p = new URLSearchParams(); if (memFilter.kind) p.set('kind', memFilter.kind); if (memFilter.q) p.set('q', memFilter.q); p.set('limit', '100'); const r = await fetch('/api/memory?' + p.toString()); const d = await r.json(); if (!r.ok) throw Error(d.error); memRows = d; }
  catch (e) { h.toast(e.message); }
  paintMemory();
}
function paintMemory() { const box = document.querySelector('#mem-list'); if (!box) return; box.innerHTML = memListHtml(); document.querySelectorAll('[data-mem-filter]').forEach(b => b.classList.toggle('on', memFilter.kind === b.dataset.memFilter)); bindMemory(box); }
function bindMemory(root = document) {
  root.querySelectorAll('[data-mem-del]').forEach(b => b.onclick = async () => { if (!(await askConfirm({ title: '删除这条记忆？', lines: ['团队以后不再按它办事，删了找不回来。'], go: '删除', danger: true }))) return; try { await h.post('/api/memory', { action: 'delete', id: b.dataset.memDel }); h.toast('已删除'); memRows = null; await h.refresh(); } catch (e) { h.toast(e.message); } });
  root.querySelectorAll('[data-mem-edit]').forEach(b => b.onclick = async () => { const v = await ask({ title: '改这条记忆', input: 'text', value: b.dataset.text, ok: '保存' }); if (v == null) return; try { await h.post('/api/memory', { action: 'update', id: b.dataset.memEdit, text: v }); h.toast('已更新'); memRows = null; await h.refresh(); } catch (e) { h.toast(e.message); } });
  root.querySelectorAll('[data-mem-pin]').forEach(b => b.onclick = async () => { try { await h.post('/api/memory', { action: 'update', id: b.dataset.memPin, pinned: b.dataset.pinned !== '1' }); memRows = null; await h.refresh(); } catch (e) { h.toast(e.message); } });
}

// ── 模型与参数 ───────────────────────────────────────────────────────────────
const stripId = r => { const { id, ...rest } = r || {}; return rest; };
function specRow(cat, r = {}, f = {}) {
  const p = cat.find(x => x.key === r.provider) || cat[0];
  const provOpts = cat.map(x => `<option value="${h.esc(x.key)}" ${x.key === (p?.key) ? 'selected' : ''}>${h.esc(x.label)}</option>`).join('');
  const models = [...new Set([...(p?.models || []), ...(r.model && !(p?.models || []).includes(r.model) ? [r.model] : [])])];
  const modelOpts = models.map(m => `<option value="${h.esc(m)}" ${m === r.model ? 'selected' : ''}>${h.esc(modelWords(m))}</option>`).join('') + '<option value="__custom__">自定义模型名…</option>';
  const efforts = p?.efforts || [];
  return `<div class="spec-row"><select class="spec-provider" aria-label="供应商">${provOpts}</select><select class="spec-model" aria-label="模型">${modelOpts}</select>${efforts.length ? `<select class="spec-effort" aria-label="思考强度"><option value="">强度默认</option>${efforts.map(e => `<option value="${e}" ${e === r.effort ? 'selected' : ''}>${e}</option>`).join('')}</select>` : '<span class="spec-effort-none"></span>'}${f.with_label ? `<input class="spec-label" placeholder="显示名（可空）" value="${h.esc(r.label || '')}">` : ''}<span class="spec-tools"><button type="button" class="edit spec-up" title="上移">↑</button><button type="button" class="edit spec-down" title="下移">↓</button><button type="button" class="edit spec-del" title="删除">×</button><button type="button" class="chip act spec-test" title="发一个最小请求验证可用">测试</button></span></div>`;
}
function specEditor(name, key, f, v) {
  const cat = (cc.settings?.catalog || []).filter(p => !f.kinds || f.kinds.includes(p.kind));
  const rows = f.single ? (v ? [v] : []) : (Array.isArray(v) ? v : []);
  return `<div class="specs" name="${h.esc(key)}" data-kind="specs" data-single="${f.single ? 1 : 0}" data-with-label="${f.with_label ? 1 : 0}" data-kinds="${h.esc((f.kinds || []).join(','))}" data-initial="${h.esc(JSON.stringify(f.single ? stripId(rows[0] || null) : rows.map(stripId)))}">${rows.map(r => specRow(cat, r, f)).join('')}${f.single && rows.length ? '' : '<button type="button" class="chip act spec-add">＋ 添加</button>'}</div>`;
}
function control(name, key, f, v) {
  const id = `set-${name}-${key.replace(/\W/g, '_')}`;
  const attrs = `id="${id}" name="${h.esc(key)}" data-kind="${f.list ? 'list' : f.bool ? 'bool' : f.enum ? 'enum' : 'text'}"`;
  if (f.disabled) return `<span class="muted small" role="status">${h.esc(f.disabled)}</span>`;
  if (f.specs) return specEditor(name, key, f, v);
  if (f.bool) return `<select ${attrs} data-initial="${v === true ? 'true' : 'false'}"><option value="true" ${v === true ? 'selected' : ''}>开</option><option value="false" ${v !== true ? 'selected' : ''}>关</option></select>`;
  if (f.enum) return `<select ${attrs} data-initial="${h.esc(v ?? '')}">${f.enum.map(o => `<option value="${h.esc(o)}" ${String(v ?? '') === o ? 'selected' : ''}>${h.esc(o === '' ? '（默认 / 留空）' : (f.enum_labels?.[o] || o))}</option>`).join('')}</select>`;
  if (f.list) return `<input ${attrs} list="${id}-opts" value="${h.esc((v || []).join(', '))}" data-initial="${h.esc(JSON.stringify(v || []))}"><datalist id="${id}-opts">${(f.options || []).map(o => `<option value="${h.esc(o)}">`).join('')}</datalist>${(f.options || []).length ? `<div class="chips tight">${(v || []).map(m => `<button type="button" class="chip act" data-test-model="${h.esc(m)}">测 ${h.esc(m)}</button>`).join('')}</div>` : ''}`;
  return `<input ${attrs} ${f.options ? `list="${id}-opts"` : ''} value="${h.esc(v ?? '')}" data-initial="${h.esc(v ?? '')}">${f.options ? `<datalist id="${id}-opts">${f.options.map(o => `<option value="${h.esc(o)}">`).join('')}</datalist>` : ''}`;
}
function stackBlock(S, roles = null, heading = true) {
  const select = (agent, channel) => {
    if (agent.local_cli) {
      const defaults = agent.local_defaults || {}, entries = defaults.entries || [];
      return `<span data-local-ai-model="${h.esc(agent.local_cli)}">${h.esc(agent.chat_label)}</span><small class="muted">${entries.length ? entries.map(e => `读取到的默认配置：${h.esc(e.model)}<br>来源：${h.esc(e.source)}`).join('<br>') : '未读到可用的默认型号，由 CLI 决定。'}</small>${defaults.note ? `<small class="muted">${h.esc(defaults.note)}</small>` : ''}`;
    }
    const current = agent[channel] || '';
    const providers = (agent.fixed ? [] : S.catalog || []).filter(p => (!agent.kinds || agent.kinds.includes(p.kind)) && (['claude_code', 'codex_exec'].includes(p.kind) || p.base_host || current.startsWith(p.key + '/'))).sort((a, b) => Number(!['claude_code', 'codex_exec'].includes(a.kind)) - Number(!['claude_code', 'codex_exec'].includes(b.kind)));
    const options = providers.flatMap(p => p.models.filter(m => !/image|embedding|whisper|tts|auto-review/i.test(m)).map(m => ({ id: `${p.key}/${m}`, key: p.key, label: `${p.label} · ${modelWords(m)}${p.notes?.[m] ? ` · ${p.notes[m]}` : ''}`, runtime: ['claude_code', 'codex_exec'].includes(p.kind) })));
    if (current && !options.some(o => o.id === current)) options.unshift({ id: current, label: modelWords(current) });
    return `<select class="agent-backend" aria-label="${h.esc(agent.label)} · ${channel === 'chat' ? '对话与推理' : '文字生成'}" data-agent="${h.esc(agent.role)}" data-channel="${channel}" data-initial="${h.esc(current)}" ${agent.fixed ? 'disabled' : ''}>${agent.inherit ? `<option value="" ${!current ? 'selected' : ''}>跟随全局</option>` : ''}${options.map(o => `<option value="${h.esc(o.id)}" data-runtime="${o.runtime ? h.esc(o.key) : ''}" data-label="${h.esc(o.label)}" ${o.id === current ? 'selected' : ''}>${h.esc(o.label)}${o.runtime ? ' · 探测中' : ''}</option>`).join('')}</select>`;
  };
  const agents = (S.agents || []).filter(a => !roles || roles.includes(a.role));
  return `${heading ? '<h3 class="sub">智能体 → 底座</h3>' : ''}<div class="table-wrap"><table class="mini-table agent-backends"><thead><tr><th>智能体</th><th>对话与推理</th><th>文字生成</th></tr></thead><tbody>${agents.map(a => `<tr><td>${h.esc(a.label)}${a.help ? `<small class="muted">${h.esc(a.help)}</small>` : ''}</td><td ${a.single ? 'colspan="2"' : ''}>${select(a, 'chat')}${a.fallback_chat ? '<small class="muted">这项配置不可用，对话已跟随全局默认</small>' : ''}</td>${a.single ? '' : `<td>${select(a, 'text')}${a.text_issue ? '<small class="muted">不可用项会跳过；整张清单不可用时跟随全局</small>' : ''}${a.text_chain?.length > 1 ? `<small class="muted">当前有 ${a.text_chain.length} 个回退底座，重新选择后替换为单个</small>` : ''}</td>`}</tr>`).join('')}</tbody></table></div>${agents.some(a => !a.fixed) ? '<p class="agent-setting-note muted small">选择后自动保存 · 角色可跟随全局默认</p>' : ''}`;
}
// 供应商卡片第二行的人话（R24）：内部的标识、接口名、登录目录收进展开后的那一行。
const KIND_WORDS = { claude_code: '本机 · Claude Code 登录', codex_exec: '本机 · Codex', anthropic_http: 'API · Anthropic 兼容', openai_http: 'API · OpenAI 兼容' };
const kindWords = p => (p.kind === 'codex_exec' && p.base_host ? 'Codex · 中转' : KIND_WORDS[p.kind] || p.kind_label || '');
function catalogBlock(S) {
  const card = p => `<div class="provider ${p.user ? 'user' : ''}" data-provider="${h.esc(p.key)}"><div class="provider-head"><div><b>${h.esc(p.label)}</b><small class="muted">${h.esc(kindWords(p))}${p.base_host ? ' · ' + h.esc(p.base_host) : ''}</small></div><span class="pill idle" data-status="${h.esc(p.key)}">查询中…</span></div>
    <div class="agent-access-actions">${['claude_code', 'codex_exec'].includes(p.kind) ? `<button type="button" class="secondary mini" data-runtime-refresh="${h.esc(p.key)}">重新探测</button>${p.hints?.login ? `<button type="button" class="secondary mini" data-login-copy="${h.esc(p.hints.login)}">复制登录命令</button>` : ''}` : p.models[0] ? `<button type="button" class="secondary mini" data-test-backend="${h.esc(p.key)}/${h.esc(p.models[0])}">测试</button>` : ''}</div><details class="agent-model-details"><summary>模型 ${p.models.length} 个 · 地址和密钥</summary><p class="muted small provider-ids">标识 <code>${h.esc(p.key)}</code>${p.wire_api ? ` · 接口 ${h.esc(p.wire_api)}` : ''}${p.home ? ` · 登录目录 <code>${h.esc(p.home)}</code>` : ''}</p>
    <div class="chips tight">${p.models.map(m => `<span class="chip quiet">${h.esc(m)} <button type="button" class="x" data-model-del="${h.esc(p.key)}" data-model="${h.esc(m)}" title="从目录移除">×</button><button type="button" class="x" data-test-backend="${h.esc(p.key)}/${h.esc(m)}" title="测试可用">测试</button></span>`).join('')}</div>
    <form class="model-add" data-model-add="${h.esc(p.key)}"><input placeholder="添加模型名，如 ${h.esc(p.kind === 'codex_exec' ? 'gpt-5.5' : 'claude-sonnet-5')}" list="known-${h.esc(p.kind)}"><button type="submit" class="secondary mini">添加</button>${p.discoverable ? `<button type="button" class="secondary mini" data-discover="${h.esc(p.key)}" title="${h.esc(p.kind === 'codex_exec' && p.codex_provider === 'openai' ? '读本机 Codex 的模型目录缓存' : '调用 /v1/models')}">探测可用模型</button>` : ''}${p.editable_auth ? `<button type="button" class="secondary mini" data-provider-edit="${h.esc(p.key)}" data-kind="${h.esc(p.kind)}" data-wire="${h.esc(p.wire_api || '')}">改地址 / 密钥</button>` : ''}${p.removable ? `<button type="button" class="secondary mini" data-provider-remove="${h.esc(p.key)}" data-account="${p.account ? 1 : 0}">删除</button>` : ''}</form>
    ${p.discovered_at ? `<small class="muted">上次探测 ${h.fmt(p.discovered_at)} · ${h.esc(p.discovered_from || '')}</small>` : ''}
    ${p.hints ? `<div class="hints"><code>${h.esc(p.hints.login)}</code>${p.hints.status ? `<code>${h.esc(p.hints.status)}</code>` : ''}</div>` : ''}</details></div>`;
  const datalists = `<datalist id="known-codex_exec">${(S.known_models?.gpt || []).map(m => `<option value="${h.esc(m)}">`).join('')}</datalist><datalist id="known-anthropic_http">${(S.known_models?.claude || []).map(m => `<option value="${h.esc(m)}">`).join('')}</datalist><datalist id="known-claude_code">${(S.known_models?.claude || []).map(m => `<option value="${h.esc(m)}">`).join('')}</datalist>`;
  const account = `<form id="account-form" class="model-add" style="padding:8px 22px 4px"><select id="account-base"><option value="openai">OpenAI 官方订阅（再加一个 Codex 登录）</option><option value="claude_subscription">Claude 官方订阅（再加一个 Claude Code 登录）</option></select><input id="account-name" placeholder="账号名，如 b 或 work" pattern="[a-z0-9][a-z0-9_\\-]{0,23}" required><button type="submit" class="primary mini">添加账号</button><span class="muted small">添加后会给出登录命令，在终端跑一次即可；每个账号独立目录，互不影响。</span></form>`;
  const addForm = `<form id="provider-form" class="provider-form"><h4>添加供应商 <small class="muted">任意 Anthropic 兼容 / OpenAI 兼容的 API（官方 API key、DeepSeek、各种中转），或 Codex 的 Responses 中转。密钥只存本机 private/ 下，600 权限。</small></h4>
    <div class="settings-grid"><label class="setting"><span>key（英文小写，作为标识）</span><input name="key" required pattern="[a-z][a-z0-9_\\-]{1,31}" placeholder="deepseek / openai_api / anthropic_api"></label>
    <label class="setting"><span>显示名（可空）</span><input name="label" placeholder="DeepSeek 官方"></label>
    <label class="setting"><span>协议</span><select name="kind"><option value="openai_http|chat">OpenAI 兼容 · chat/completions（DeepSeek、大多数中转、官方 OpenAI）</option><option value="openai_http|responses">OpenAI 兼容 · responses（官方 OpenAI、支持 Responses 的 Codex 中转）</option><option value="anthropic_http">Anthropic Messages 兼容（官方 Anthropic、Claude 网关）</option><option value="codex_exec">Codex 供应商（codex exec 跑，中转需支持 Responses）</option></select></label>
    <label class="setting"><span>base_url</span><input name="base_url" required placeholder="https://api.deepseek.com/v1"></label>
    <label class="setting"><span>API key</span><input name="api_key" type="password" required autocomplete="off"></label>
    <label class="setting"><span>模型（逗号分隔，可空，之后可「探测」）</span><input name="models" placeholder="deepseek-flash, deepseek-v4-pro"></label></div>
    <div class="settings-foot"><button type="submit" class="primary mini">添加供应商</button><span class="muted small">添加后用卡片上的「测」验证；chat 接口不通就改成 responses，反之亦然。</span></div></form>`;
  const runtimes = (S.catalog || []).filter(p => ['claude_code', 'codex_exec'].includes(p.kind));
  const apis = (S.catalog || []).filter(p => !['claude_code', 'codex_exec'].includes(p.kind));
  return `${datalists}<h4 class="agent-setting-note">这台电脑上的登录（Claude Code / Codex）</h4><div class="providers">${runtimes.map(card).join('')}</div>${details('settings-accounts', '再加一个本机登录', account)}<h4 class="agent-setting-note">API 供应商（填 key 的）</h4><div class="providers">${apis.map(card).join('')}</div>${details('settings-add-provider', '添加供应商', addForm)}`;
}
function migrationBlock(heading = true) {
  return `${heading ? '<h3 class="sub">备份与迁移</h3>' : ''}<div class="mini-block" style="border-top:0"><p>备份包含个人资料、设置、偏好和记忆。可同时保留岗位、任务和投递进度。</p>
    <p><a class="secondary mini" href="/api/migrate/export?state=0&logins=0" download>备份资料与设置</a> <a class="secondary mini" href="/api/migrate/export?state=1&logins=0" download>备份资料与全部进度</a> <a class="secondary mini" href="/api/migrate/export?state=1&logins=1" download>备份全部并保留登录信息</a></p>
    <p><b>备份含有密钥和个人资料。</b>请妥善保管，只通过你自己的通道传到新电脑。部分账号的登录信息无法随备份迁移，换电脑后需要重新登录。</p></div>`;
}
function settingsPanel() {
  const S = cc.settings;
  if (!S) return '';
  const hidden = { host: ['executor', 'claude_provider', 'models', 'codex_models.fallback'], model: ['text.backends'], chat: ['default'], roles: Object.keys(S.files.roles?.fields || {}) };
  const forms = Object.entries(S.files).filter(([name]) => name !== 'roles').map(([name, f]) => `<form class="settings-form" id="settings-form-${h.esc(name)}" data-settings-form="${h.esc(name)}"><h3 class="sub">${h.esc(f.label)} <code>${h.esc(f.file)}</code>${f.exists ? '' : ' <span class="tag">尚未创建，保存即生成</span>'}</h3><div class="settings-grid">${Object.entries(f.fields).filter(([k]) => !(hidden[name] || []).includes(k)).map(([k, fd]) => `<label class="setting"><span>${h.esc(fd.label)}${fd.help ? `<small class="muted">${h.esc(fd.help)}</small>` : ''}</span>${control(name, k, fd, f.values[k])}</label>`).join('')}</div><div class="settings-foot"><button type="submit" class="primary mini">保存 ${h.esc(f.label)}</button><span class="muted small settings-note"></span></div></form>`).join('');
  const auth = Object.entries(S.auth).map(([k, a]) => `<span class="chip ${a.exists ? 'good' : 'bad'}" title="${h.esc(a.file)}">${h.esc(k)} ${a.exists ? '已配置' : '缺失'}${a.provider ? ' · ' + h.esc(a.provider) : ''}</span>`).join('');
  const usage = Object.entries(S.usage_today).length ? `<div class="table-wrap"><table class="mini-table"><thead><tr><th>驱动 · 模型</th><th>调用</th><th>失败</th><th>输入 tok</th><th>输出 tok</th><th>耗时</th></tr></thead><tbody>${Object.entries(S.usage_today).map(([k, u]) => `<tr><td>${h.esc(k)}</td><td>${u.calls}</td><td>${u.failed}</td><td>${u.input_tokens.toLocaleString()}</td><td>${u.output_tokens.toLocaleString()}</td><td>${(u.ms / 1000).toFixed(0)}s</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">今天还没有模型调用记录。</p>';
  const presets = Object.entries(S.presets || {}).map(([key, p]) => `<button type="button" class="op-btn" data-preset="${h.esc(key)}"><b>${h.esc(p.label)}</b><small>${h.esc(p.desc)}</small></button>`).join('');
  const advanced = `<div class="chips">${auth}</div><h3 class="sub">一键切换预设</h3><div class="ops-grid">${presets}</div>${forms}${migrationBlock()}${details('settings-usage', '今日模型用量', usage)}${details('settings-backups', '最近备份', S.backups.map(b => `<p><code>${h.esc(b)}</code></p>`).join(''))}`;
  // 上面是简单的一块（web/model-settings.js：现在用的 + 四种选择 + 测试），id settings-model：收件箱「补给用完了」
  // 跳到 #settings/model。每位成员的模型、base_url、协议、添加供应商都折进「高级」，一般用不到。
  const lead = '';
  // web/model-settings.js 由 app.js 载入，挂在 window.OfferCrewModelSimple 上（这个文件不 import，测试直接在 vm 里跑它）。
  const simple = globalThis.OfferCrewModelSimple?.html() || '<div id="settings-model" class="ms" data-model-simple><p class="muted">正在读取…</p></div>';
  return section('模型', `${simple}${details('settings-advanced', '高级', `${lead}${stackBlock(S)}${catalogBlock(S)}${advanced}`)}`);
}

// ── 设置页（web/settings/）用的零件：同一套表单、✎ 改事实、成员底座、供应商目录，按分类拆开摆 ─────────────
// 绑定仍走 bindCommand()（按 data-* 选择器找，不认位置）。这个文件不 import（测试在 vm 里跑），零件从这里拿。
function settingsFormHtml(name, keys = null, { title = '' } = {}) {
  const S = cc.settings, f = S?.files?.[name];
  if (!f) return '';
  const entries = Object.entries(f.fields).filter(([k]) => !keys || keys.includes(k));
  if (keys) entries.sort((a, b) => keys.indexOf(a[0]) - keys.indexOf(b[0]));
  if (!entries.length) return '';
  return `<form class="settings-form" id="settings-form-${h.esc(name)}" data-settings-form="${h.esc(name)}">${title ? `<h3 class="sub">${h.esc(title)}</h3>` : ''}<div class="settings-grid">${entries.map(([k, fd]) => `<label class="setting"><span>${h.esc(fd.label)}</span>${control(name, k, fd, f.values[k])}</label>`).join('')}</div><div class="settings-foot"><button type="submit" class="primary mini">保存</button><span class="muted small settings-note"></span></div></form>`;
}
function factRowsHtml(paths) {
  const P = cc.profile || {}, fields = cc.settings?.facts || {};
  if (P.error) return empty(P.error);
  const row = path => { const f = fields[path]; if (!f) return ''; const v = factValue(P, path), salary = /^compensation\..*_annual_/.test(path) ? globalThis.OfferCrewSettingsWords : null, parts = salary?.salaryParts(v), history = parts?.history ? `<details class="small"><summary>校正记录</summary>${h.esc(parts.history)}</details>` : ''; return `<div><dt>${h.esc(f.label)}</dt><dd>${salary ? showValue(salary.salaryText(v)) : showValue(v)}${history} <button class="edit" data-fact="${h.esc(path)}" data-kind="${h.esc(f.kind)}" data-label="${h.esc(f.label)}" data-value="${h.esc(Array.isArray(v) ? v.join('，') : v ?? '')}" ${f.options ? `data-options="${h.esc(f.options.join(','))}"` : ''} title="修改" aria-label="修改${h.esc(f.label)}">✎</button></dd></div>`; };
  return `<dl class="kv wide">${paths.map(row).join('')}</dl>`;
}
export function settingsKit(center, helpers) {
  h = helpers; cc = center;
  const S = cc.settings || {};
  return {
    form: settingsFormHtml,
    facts: factRowsHtml,
    factValue: path => factValue(cc.profile || {}, path),
    factLabel: path => S.facts?.[path]?.label || path,
    stack: roles => (S.agents ? stackBlock(S, roles, false) : ''),
    catalog: () => (S.catalog ? catalogBlock(S) : ''),
    presets: () => `<div class="ops-grid">${Object.entries(S.presets || {}).map(([key, p]) => `<button type="button" class="op-btn" data-preset="${h.esc(key)}"><b>${h.esc(p.label)}</b><small>${h.esc(p.desc)}</small></button>`).join('')}</div>`,
    auth: () => `<div class="chips">${Object.entries(S.auth || {}).map(([k, a]) => `<span class="chip ${a.exists ? 'good' : 'bad'}">${h.esc(k)} ${a.exists ? '已配置' : '缺失'}${a.provider ? ' · ' + h.esc(a.provider) : ''}</span>`).join('')}</div>`,
    migration: () => migrationBlock(false),
    backups: () => (S.backups || []).map((b, i) => `<p class="small">备份 ${i + 1}</p>`).join('') || '<p class="muted small">还没有备份。</p>',
    learned: () => preferencesPanel(),
    memory: () => memoryPanel(),
  };
}

export function setHelpers(helpers) { h = helpers; }
// 让其它页（运行日志）也能用 data-cmd / data-sysfix 按钮。
export function bindActions(root = document) { bindDynamic(root); }
export const sysfixButton = (target, label = `交给 ${h.crewName('patch')} 修`) => `<button type="button" class="secondary mini sysfix" data-sysfix="${h.esc(JSON.stringify(target))}" title="打包成一个修复任务，交给本机 AI 查根因；代码问题只写改法，不改代码">${h.esc(label)}</button>`;
const hasHostJobQuestion = j => j && ['waiting_user', 'blocked'].includes(j.status) && Boolean(j.required_action?.trim());
const hostJobQuickReplies = j => hasHostJobQuestion(j) ? `<div class="job-quick-replies" data-job-replies="${h.esc(j.id)}" data-question="${h.esc(j.required_action)}"><div class="job-reply-buttons"><button type="button" class="primary mini" data-job-reply="confirm">确认</button><button type="button" class="secondary mini" data-job-reply="decline">不确认</button></div><small class="muted">针对上面的问题作答，点击即提交；需要解释或补充时可点“反馈 / 补充情况”。</small><p class="job-reply-status full" role="status" aria-live="polite"></p></div>` : '';
const requiredActionHtml = (j, { quickReplies = true } = {}) => `<div class="job-next-action"><b>需要你做什么</b><p class="full">${h.esc(j.required_action || '系统尚未写明具体要求。你可以点击“反馈 / 补充情况”，要求解释或补充你的情况。')}</p>${quickReplies ? hostJobQuickReplies(j) : ''}</div>`;
const hostJobContextHtml = j => {
  const evidence = Array.isArray(j.evidence) ? j.evidence : j.evidence ? [j.evidence] : [];
  return `<div class="job-context"><b>排查结论 / 当前情况</b><p class="sys-result full">${h.esc(j.result || '尚未记录排查结论和具体处理建议。')}</p>${j.details ? `<b>原始任务</b><p class="full">${h.esc(j.details)}</p>` : ''}${evidence.length ? `<div class="sys-evidence">排查依据：${refs(evidence.map(f => typeof f === 'string' ? /^https?:\/\//.test(f) ? { url: f } : { file: f } : f))}</div>` : ''}${j.user_feedback?.length ? `<b>你的反馈记录</b>${j.user_feedback.map(f => `<p class="full"><small>${h.esc(f.at)}</small><br>${h.esc(f.text)}</p>`).join('')}` : ''}</div>`;
};
// 同一个问题的所有入口共用提交状态，避免连续点击产生相互矛盾的答复。
const quickReplySubmissions = new Map();
async function submitHostJobReply(button, root = document) {
  const group = button.closest('[data-job-replies]');
  const { jobReplies: id, question } = group.dataset;
  const answer = button.dataset.jobReply;
  if (!['confirm', 'decline'].includes(answer)) return;
  const key = JSON.stringify([id, question]);
  let submission = quickReplySubmissions.get(key);
  if (submission?.busy || submission?.saved) return;
  if (!submission || submission.answer !== answer) {
    submission = { answer, feedbackId: crypto.randomUUID() };
    quickReplySubmissions.set(key, submission);
  }
  const groups = [...root.querySelectorAll('[data-job-replies]')].filter(g => g.dataset.jobReplies === id);
  const setDisabled = value => groups.forEach(g => g.querySelectorAll('button').forEach(b => { b.disabled = value; }));
  const setStatus = text => groups.forEach(g => { g.querySelector('.job-reply-status').textContent = text; });
  submission.busy = true; setDisabled(true); setStatus('正在提交答复…');
  try {
    const label = answer === 'confirm' ? '确认（是）' : '不确认（否）';
    const r = await h.post('/api/host-job', { id, action: 'feedback', note: `针对问题：${question}\n我的答复：${label}`, feedback_id: submission.feedbackId });
    if (r.error || r.ok === false) throw Error(r.error || r.receipt || '答复保存失败');
    submission.saved = true;
    setStatus(`已提交“${answer === 'confirm' ? '确认' : '不确认'}”，等待继续处理。`);
    h.toast(r.receipt || '答复已保存');
    try { await h.refresh(); } catch { h.toast('答复已保存，页面刷新失败，请刷新查看进度。'); }
  } catch (e) {
    setStatus(`提交失败：${e.message}。请重试，或补充反馈。`); setDisabled(false);
  } finally { submission.busy = false; }
}
const feedbackDrafts = new Map();
async function openHostJobFeedback(id) {
  const response = await fetch('/api/host-job?id=' + encodeURIComponent(id));
  const job = await response.json();
  if (!response.ok) throw Error(job.error || '读取任务失败');
  let d = document.querySelector('#job-feedback-dialog');
  if (!d) { d = document.createElement('dialog'); d.id = 'job-feedback-dialog'; document.body.appendChild(d); }
  const feedbackId = crypto.randomUUID();
  d.innerHTML = `<form><h2>反馈 / 补充情况</h2><p class="full">${h.esc(job.label || job.kind)}</p><div class="job-feedback-context">${requiredActionHtml(job, { quickReplies: false })}${hostJobContextHtml(job)}</div><label for="job-feedback-text">你的反馈</label><textarea id="job-feedback-text" rows="5" maxlength="5000" required placeholder="例如：已经登录；还是不知道怎么做；这个判断不对；补充链接或公司名…">${h.esc(feedbackDrafts.get(id) || '')}</textarea><p class="muted small">反馈会附在原任务上，让本机 AI 先核验，再根据你的回答继续处理。</p><p class="feedback-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary" data-feedback-cancel>暂不提交</button><button type="submit" class="primary">提交反馈，继续处理</button></div></form>`;
  const field = d.querySelector('#job-feedback-text'), submit = d.querySelector('[type="submit"]'), error = d.querySelector('.feedback-error');
  field.oninput = () => { field.setCustomValidity(''); feedbackDrafts.set(id, field.value); };
  d.oncancel = () => feedbackDrafts.set(id, field.value);
  d.querySelector('[data-feedback-cancel]').onclick = () => { feedbackDrafts.set(id, field.value); d.close(); };
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    if (!field.value.trim()) { field.setCustomValidity('请写下你的反馈'); field.reportValidity(); return; }
    field.setCustomValidity(''); submit.disabled = true; error.textContent = ''; feedbackDrafts.set(id, field.value);
    try {
      const r = await h.post('/api/host-job', { id, action: 'feedback', note: field.value, feedback_id: feedbackId });
      if (r.error || r.ok === false) throw Error(r.error || r.receipt || '反馈保存失败');
      feedbackDrafts.delete(id); d.close(); h.toast(r.receipt || '反馈已保存'); await h.refresh();
    } catch (e) { error.textContent = e.message; }
    finally { submit.disabled = false; }
  };
  d.showModal(); field.focus();
}

// 设置页（旧版指挥台 2026-09-29 下线，指挥台在 web/hq.js；记忆库 10-10 搬进设置 · 高级，settingsKit memory）。
// extra：设置页上下加的几块（web/prefs.js：求职方向与偏好在最上面；检查清单、花费、手机、高级邮箱接入在最下面）。
export function commandPage(center, helpers, page = 'settings', extra = {}) {
  h = helpers; cc = center;
  return `<div class="page-heading"><div><h1>设置</h1></div></div><div class="one-col">${extra.top || ''}${settingsPanel()}${extra.spend || ''}${profilePanel()}${preferencesPanel()}${extra.bottom || ''}</div>`;
}

// ── 通用对话框 ───────────────────────────────────────────────────────────────
function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'console-dialog';
  dialog.innerHTML = `<form method="dialog" id="console-form"><span class="eyebrow">操作台</span><h2 id="cd-title"></h2><div id="cd-body" class="cd-body"></div><div id="cd-input"></div><div class="dialog-actions"><button type="button" id="cd-cancel" class="secondary">取消</button><button type="submit" id="cd-ok" class="primary">确认</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.querySelector('#cd-cancel').onclick = () => dialog.close('cancel');
  return dialog;
}
// 供应商状态给人看的一个词：缺凭据 / 令牌文件 / 不在目录里是「未配置」，登录目录不在或没登录是「未登录」，
// 只有真的查不出来才是「探测失败」（原来缺凭据也显示探测失败）。
export function providerStatusLabel(v = {}, runtime = false) {
  const d = String(v.detail || '');
  if (v.ok) return runtime ? '已登录' : '已配置';
  if (/未登录|not logged|登录目录.*不存在/i.test(d)) return '未登录';
  if (/^缺 |缺失|不在目录里|没有供应商|未配置/.test(d)) return '未配置';
  return '探测失败';
}
function ask({ title, body = '', input = null, ok = '确认', value = '', options = null, required = true, min = -6, max = 6, step = 0.5 }) {
  const d = ensureDialog();
  d.querySelector('#cd-title').textContent = title;
  d.querySelector('#cd-body').innerHTML = body;
  const box = d.querySelector('#cd-input');
  // choice：几个单选按钮，点哪个就是哪个（datalist 下拉在这里不好用）。
  box.innerHTML = input === 'choice' ? `<div class="choices">${(options || []).map((o, i) => `<label class="choice"><input type="radio" name="cd-choice" value="${h.esc(o)}" ${o === value || (!value && i === 0) ? 'checked' : ''}> <span>${h.esc(o)}</span></label>`).join('')}</div>` : input === 'text' || input === 'reason' ? `<textarea id="cd-value" rows="4" placeholder="${input === 'reason' ? '例如：要求算法研究 / 城市太远 / 职级不符' : ''}">${h.esc(value)}</textarea>` : input === 'datetime' ? `<input id="cd-value" type="text" placeholder="2026-09-22 14:00" value="${h.esc(value)}" pattern="\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}">` : input === 'number' ? `<input id="cd-value" type="number" step="${step}" min="${min}" max="${max}" value="${h.esc(value)}">` : input === 'line' ? `<input id="cd-value" type="text" value="${h.esc(value)}" ${options ? 'list="cd-opts"' : ''}>${options ? `<datalist id="cd-opts">${options.map(o => `<option value="${h.esc(o)}">`).join('')}</datalist>` : ''}` : input === 'bool' ? `<select id="cd-value"><option value="true" ${value === true || value === 'true' ? 'selected' : ''}>是</option><option value="false" ${value === false || value === 'false' ? 'selected' : ''}>否</option></select>` : '';
  d.querySelector('#cd-ok').textContent = ok;
  return new Promise(resolve => {
    const form = d.querySelector('#console-form');
    let result = null;
    form.onsubmit = e => {
      e.preventDefault();
      const field = d.querySelector('#cd-value');
      const v = input === 'choice' ? d.querySelector('input[name=cd-choice]:checked')?.value : field?.value?.trim();
      if (required && input && input !== 'bool' && !v && v !== '0') { field?.setCustomValidity('请填写后再提交'); field?.reportValidity(); return; }
      result = v ?? true;
      d.close('ok');
    };
    d.querySelector('#cd-value')?.addEventListener('input', e => e.target.setCustomValidity(''));
    // Resolve only after close fires, so a following prompt cannot inherit this close event.
    d.onclose = () => { resolve(d.returnValue === 'ok' ? result : null); };
    d.returnValue = '';
    d.showModal();
    d.querySelector('#cd-value')?.focus();
  });
}
function previewHtml(p) {
  if (p.kind === 'record') return `<p>${h.esc(p.text)}</p>`;
  if (p.kind === 'send') return `<p class="muted small">将授权发送以下 ${p.drafts.length} 封已展示的草稿；进入队列后由同一发送链逐封核对并发出，发后从 Sent 对账。${p.missing.length ? `<br><b>未找到可发草稿：${p.missing.join('、')}</b>（未展示或已作废的草稿不能授权）` : ''}</p>${p.drafts.map(d => `<div class="preview-draft"><b>#${h.esc(d.number)} ${h.esc(d.company || '')}</b> <span class="tag">${h.esc(d.channel)} · ${h.esc(d.purpose)}</span> <button type="button" class="secondary mini" data-draft="${h.esc(d.draft_id)}">先改一下</button><p><b>收件人</b> ${h.esc(d.to)}${d.subject ? `<br><b>主题</b> ${h.esc(d.subject)}` : ''}</p><pre>${h.esc(d.body)}</pre>${d.attachments.length ? `<p>${d.attachments.map(a => `<span class="tag green">${h.esc(a.name)} · ${Math.round(a.size / 1024)} KB</span>`).join(' ')}</p>` : ''}</div>`).join('')}`;
  // 任务页新建的「联系 #N」（lib/task-api.mjs confirmFor）、贴链接的投递（还没收录，先收录这个链接）。
  const linkRow = p.url ? `<div class="mini-row"><span class="grow">先收录这个链接：<span class="muted">${h.esc(p.url)}</span></span></div>` : '';
  if (p.kind === 'contact') return `<p class="muted small">将为以下 ${p.rows.length} 条找内推人、写一条消息；消息发出之前会再给你看。</p><div class="mini-list">${p.rows.map(r => `<div class="mini-row"><span class="grow"><b>#${h.esc(r.number)} ${h.esc(r.company)}</b> ${h.esc(r.role)} <span class="muted">· ${h.esc(r.city || '')}</span></span></div>`).join('')}${linkRow}</div>`;
  const lead = p.auto_submit ? `将批准以下 ${p.rows.length} 条进入自动投递队列（表单 / 已登录门户由系统提交，遇登录墙或必填项无答案会停下交还你）。` : `将为以下 ${p.rows.length} 条在浏览器里预填申请表，停在提交前交给你；认不出的项会列出来，由你在页面上补齐后自己提交。`;
  return `<p class="muted small">${lead}${p.missing.length ? `<br><b>库里没有这些编号：${p.missing.join('、')}</b>` : ''}</p><div class="mini-list">${p.rows.map(r => `<div class="mini-row"><span class="grow"><b>#${h.esc(r.number)} ${h.esc(r.company)}</b> ${h.esc(r.role)} <span class="muted">· ${h.esc(r.city || '')} · ${h.esc(r.channel)}</span><br><small class="muted">${h.esc(r.reason || '')}</small>${r.stop ? `<br><small class="is-warn">会被拦下：${h.esc(r.stop)}</small>` : ''}${r.warn ? `<br><small class="is-warn">${h.esc(r.warn)}</small>` : ''}</span></div>`).join('') || linkRow || '<div class="muted small">没有可投的条目</div>'}</div>`;
}
// 发送 / 投递的确认框：要发的全文、要投的清单先给你看，点确认才算数。指令栏和对话浮层（web/talk.js）共用这一个。
export async function confirmPreview(r) {
  const d = ensureDialog();
  const done = ask({ title: r.confirm_text, body: previewHtml(r.preview), ok: r.preview.kind === 'record' ? '确认，记下' : r.preview.kind === 'send' ? '确认，授权发送' : r.preview.kind === 'contact' ? '确认，开始联系' : r.preview.auto_submit ? '确认，批准投递' : '确认，开始预填' });
  d.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => { d.close('cancel'); openDraftEditor(b.dataset.draft); });
  return !!(await done);
}
export async function runCommand(text, { confirm = false } = {}) {
  let r;
  try { r = await h.post('/api/command', { text, confirm }); }
  catch (e) { h.toast(e.message); throw e; }
  if (r.error || r.ok === false) { const message = r.error || r.receipt || r.ack || '操作失败'; logLine(text, message, 'fail'); h.toast(message); return r; }
  if (r.needs_confirm) {
    if (!(await confirmPreview(r))) { h.toast('已取消'); return; }
    return runCommand(text, { confirm: true });
  }
  logLine(text, r.receipt || r.ack || '已处理', r.ok === false ? 'fail' : 'ok', { navigate: r.navigate || null });
  const brief = String(r.receipt || r.ack || '已处理').split('\n')[0].slice(0, 120);
  const open = (r.open || [])[0];
  h.toast(brief + (r.run_now ? '（已排队交给本机 AI，大约一分钟后开始）' : '') + (String(r.receipt || '').includes('\n') ? ' · 全文在操作台日志里' : ''), open ? { label: open.label || '打开', run: () => h.post('/api/open-url', { url: open.url }).then(x => h.toast(x.receipt || '已在浏览器里打开')).catch(e => h.toast(e.message)) } : null);
  if (r.navigate) location.hash = r.navigate;
  // A successful command invalidates the separately cached Radar list, including
  // requests started before the decision was saved. Do not wait for an SSE repaint.
  ++leadRequestId; leadResults = null; leadsLoading = false;
  if (document.querySelector('#lead-results')) await loadLeads({ quiet: true });
  await h.refresh();
  return r;
}
async function handleCmdButton(b) {
  let cmd = b.dataset.cmd;
  if (b.dataset.ask && !(await askConfirm({ title: b.dataset.ask, go: b.textContent.trim() || '继续' }))) return;
  if (b.dataset.prompt) {
    const choice = b.dataset.prompt === 'choice';
    const v = await ask({ title: b.dataset.title || cmd, input: b.dataset.prompt, ok: '提交', options: choice ? String(b.dataset.options || '').split('|').filter(Boolean) : null, required: !choice });
    if (v == null) return;
    cmd = cmd.replace('{x}', v === '不填原因' ? '' : String(v)).trim();
  }
  b.disabled = true;
  const row = b.closest('.todo-row, .lead-row, .mini-row');
  const acts = row?.querySelector('.actions, .lead-actions');
  let indicator, failed = false;
  const showError = message => {
    failed = true;
    row?.classList.remove('row-pending'); row?.classList.add('row-error');
    if (indicator) { indicator.className = 'tag red'; indicator.textContent = `失败：${String(message).slice(0, 80)}（可重试）`; }
  };
  try {
    if (cmd.includes('{n}')) {
      if (!b.dataset.rid) throw Error('这条线索还没有编号，也没有 id');
      const r = await h.post('/api/lead-number', { record_id: b.dataset.rid });
      if (r?.number == null) throw Error(r?.error || '补编号失败');
      cmd = cmd.replace('{n}', String(r.number));
    }
    if (row) {
      row.classList.remove('row-error'); row.classList.add('row-pending');
      row.querySelector('[data-command-progress]')?.remove();
      indicator = document.createElement('span'); indicator.dataset.commandProgress = 'true';
      indicator.className = 'tag st-pending'; indicator.textContent = '处理中…';
      if (acts) { acts.hidden = true; acts.after(indicator); } else row.appendChild(indicator);
    }
    const r = await runCommand(cmd, { confirm: false });
    if (r?.error || r?.ok === false) showError(r.error || r.receipt || '未知错误');
  } catch (e) { logLine(cmd, e.message, 'fail'); h.toast(e.message); showError(e.message); }
  finally {
    b.disabled = false; if (acts) acts.hidden = false;
    row?.classList.remove('row-pending'); if (!failed) indicator?.remove();
  }
}

// ── 草稿编辑器 ───────────────────────────────────────────────────────────────
function ensureDraftDialog() {
  if (draftDialog) return draftDialog;
  draftDialog = document.createElement('dialog');
  draftDialog.id = 'draft-dialog';
  document.body.appendChild(draftDialog);
  return draftDialog;
}
// 草稿框里给人看的名字：渠道、用途、判断（原来直接显示 maimai_friend_request · application · verify）。
const DRAFT_CHANNEL = { email: '邮件', platform_dm: '平台私信', maimai_friend_request: '脉脉加好友附言', platform_application: '平台申请', referral: '内推请求', wechat: '微信' };
const DRAFT_PURPOSE = { application: '首次联系', first_contact: '首次联系', inquiry: '询问岗位', referral: '内推请求', reply: '回复', followup: '跟进' };
const DRAFT_STATUS = { ready: '待发', editing: '修改中', sent: '已发出', cancelled: '已作废', superseded: '已被新版替换', paused: '暂停' };
export async function openDraftEditor(draft_id, readonly = false) {
  const d = ensureDraftDialog();
  d.innerHTML = '<div class="empty">读取草稿…</div>';
  if (!d.open) d.showModal();
  let v;
  try { const r = await fetch('/api/draft?id=' + encodeURIComponent(draft_id) + (readonly ? '&readonly=1' : '')); v = await r.json(); if (!r.ok) throw Error(v.error); } catch (e) { d.close(); h.toast(e.message); return; }
  const dr = v.draft, email = (dr.channel || 'email') === 'email';
  if (!v.editable) {
    d.innerHTML = `<div class="draft-head"><h2>查看 · ${h.esc(dr.subject || '草稿')}</h2><button type="button" class="secondary" data-close-view>关闭</button></div><p>${h.esc(/^https?:/.test(dr.to || '') ? `${dr.platform || '招聘平台'} · 岗位发布人` : dr.to || '')} · ${h.esc(DRAFT_CHANNEL[dr.channel || 'email'] || dr.channel)} · ${h.esc(DRAFT_STATUS[dr.status] || dr.status)}</p><pre style="white-space:pre-wrap">${h.esc(dr.body || '')}</pre>${(dr.attachments || []).map(a => `<p>${h.esc(a.name)}</p>`).join('')}`;
    d.querySelector('[data-close-view]').onclick = () => d.close();
    return;
  }
  const chars = s => [...String(s || '')].length;
  d.innerHTML = `<form id="draft-form"><div class="draft-head"><div><span class="eyebrow">${v.gmail ? 'GMAIL 草稿' : '本地草稿'} · ${h.esc(DRAFT_CHANNEL[dr.channel || 'email'] || dr.channel)} · ${h.esc(DRAFT_PURPOSE[dr.purpose || 'application'] || dr.purpose)}</span><h2>#${h.esc(dr.number)} ${h.esc(v.lead?.company || dr.company || '')} <small class="muted">${h.esc(v.lead?.role || '')}</small></h2>${v.lead ? `<p class="muted small">${h.esc(v.lead.location || '')}${v.lead.verdict ? ' · ' + h.esc(VERDICT_WORD[v.lead.verdict] || v.lead.verdict) : ''}${v.lead.gap ? ' · 缺口：' + h.esc(v.lead.gap) : ''} ${v.lead.url ? h.link(v.lead.url, '原帖') : ''} <a href="${h.leadUrl(v.lead.id)}">岗位详情</a></p>` : ''}</div><button type="button" class="icon-button" id="draft-close" aria-label="关闭">×</button></div>
    ${v.pending_edit ? `<div class="notice">这封已有一份改动在等本机 AI 同步到 Gmail（${h.fmt(v.pending_edit.at)}）。再改会覆盖它。</div>` : ''}${!v.editable ? `<div class="notice">状态 ${h.esc(dr.status)}，不能编辑。</div>` : ''}
    <div class="draft-grid"><label>收件人<input id="df-to" value="${h.esc(email || !/^https?:/.test(dr.to || '') ? dr.to || '' : `${dr.platform || '招聘平台'} · 岗位发布人`)}" ${v.gmail || !email ? 'readonly' : ''}></label><label>主题<input id="df-subject" value="${h.esc(dr.subject || '')}" ${email ? '' : 'readonly'}></label></div>
    <label class="draft-body-label">正文 <span class="muted small" id="df-count">${chars(dr.body)} 字${v.limit ? ` / 上限 ${v.limit}` : ''}</span><textarea id="df-body" rows="14" ${v.editable ? '' : 'readonly'}>${h.esc(dr.body || '')}</textarea></label>
    ${(dr.attachments || []).length ? `<p class="muted small">附件：${dr.attachments.map(a => `<span class="tag green">${h.esc(a.name)} · ${Math.round(a.size / 1024)} KB</span>`).join(' ')}（附件不在这里改）</p>` : ''}
    <div class="draft-ai"><input id="df-instruction" placeholder="AI 重写要求，可留空：更短 / 更口语 / 突出 Agent 项目 / 把第二段删掉 / 改成英文…"><button type="button" class="secondary mini" id="df-rewrite" ${v.editable ? '' : 'disabled'}>AI 重写</button></div><div id="df-notes" class="muted small"></div>
    <div class="dialog-actions draft-actions"><span class="grow muted small">${v.send_blocked ? h.esc(v.send_blocked.reason) + '；可保存文案后手动处理。 ' + h.link(v.send_blocked.fix.href, v.send_blocked.fix.label) : v.gmail ? '这封的正文在 Gmail 里：保存后由本机 AI 同步并回读，之后才能发。' : '改过以后要你再确认一次才会发出。'}</span>${v.previous ? '<button type="button" class="secondary mini" id="df-restore">恢复上一版</button>' : ''}<button type="button" class="secondary mini" id="df-cancel-draft">不发</button><button type="submit" class="secondary" id="df-save" ${v.editable ? '' : 'disabled'}>保存</button><button type="button" class="primary" id="df-save-send" ${v.editable && !v.gmail && !v.send_blocked ? '' : 'disabled'}>保存并发送</button></div></form>`;
  const $ = s => d.querySelector(s), body = $('#df-body'), notes = $('#df-notes');
  body.addEventListener('input', () => { $('#df-count').textContent = `${chars(body.value)} 字${v.limit ? ` / 上限 ${v.limit}` : ''}`; $('#df-count').classList.toggle('over', !!v.limit && chars(body.value) > v.limit); });
  $('#draft-close').onclick = () => d.close();
  const save = async () => h.post('/api/draft', { action: 'edit', draft_id: dr.draft_id, subject: $('#df-subject').value, body: body.value, to: email ? $('#df-to').value : dr.to }); // 平台私信框里显示的是「BOSS 直聘 · 岗位发布人」，存回去的还是原来的岗位页地址
  $('#draft-form').onsubmit = async e => { e.preventDefault(); const b = $('#df-save'); b.disabled = true; try { const r = await save(); h.toast(r.message || (r.status === 'unchanged' ? '没有改动' : '已保存')); if (r.status !== 'unchanged') { d.close(); await h.refresh(); } } catch (err) { h.toast(err.message); } finally { b.disabled = false; } };
  $('#df-save-send').onclick = async () => { if (v.send_blocked) { h.toast(v.send_blocked.reason); return; } const b = $('#df-save-send'); b.disabled = true; try { const r = await save(); if (r.status === 'pending_sync') { h.toast(r.message); d.close(); return; } d.close(); await runCommand(`发 ${dr.number}`); } catch (err) { h.toast(err.message); } finally { b.disabled = false; } };
  // AI 重写（10-04 实测 #429：「正在重写」挂了几分钟）：服务端整件事最多 90 秒（lib/drafts.mjs REWRITE_MS），这里再多等 15 秒兜底；
  // 没写出来、超时都在框里说清，旁边给「再试一次」。写出来还超上限也照实标出来，保存时服务端照样按上限拦。
  const REWRITE_WAIT = 105000;
  const rewrite = async () => {
    const b = $('#df-rewrite'); b.disabled = true; notes.textContent = `${h.crewName('quill')} 在改…`;
    let t;
    try {
      const r = await Promise.race([h.post('/api/draft', { action: 'rewrite', draft_id: dr.draft_id, instruction: $('#df-instruction').value }), new Promise((_, no) => { t = setTimeout(() => no(Error('模型没按时回答')), REWRITE_WAIT); })]);
      if (email) $('#df-subject').value = r.subject || $('#df-subject').value; body.value = r.body; body.dispatchEvent(new Event('input'));
      notes.innerHTML = `<b>AI 提案</b>（${h.esc(r.language)} · ${r.chars} 字${r.over_limit ? ` · <span class="over">还超 ${r.chars - r.limit} 字</span>` : ''}）：${h.esc(r.notes)} — 还没保存，看过再点「保存」。${r.over_limit ? ' <button type="button" class="secondary mini" data-df-retry>再试一次</button>' : ''}`;
    } catch (err) { notes.innerHTML = `<span class="over">没写出来：${h.esc(err.message)}</span> <button type="button" class="secondary mini" data-df-retry>再试一次</button>`; }
    finally { clearTimeout(t); b.disabled = false; notes.querySelector('[data-df-retry]')?.addEventListener('click', rewrite); }
  };
  $('#df-rewrite').onclick = rewrite;
  $('#df-restore')?.addEventListener('click', async () => { try { const r = await h.post('/api/draft', { action: 'restore', draft_id: dr.draft_id }); h.toast(r.message); d.close(); await h.refresh(); } catch (err) { h.toast(err.message); } });
  $('#df-cancel-draft').onclick = async () => { if (!(await askConfirm({ title: '作废这封草稿？', lines: ['这一封不会发出去，这条线索要再联系得重新起草。'], go: '作废', danger: true }))) return; d.close(); await runCommand(`${dr.number} 不发`); };
  // 超了上限（批准那一问的「缩短到 N 字以内」点进来的，或者命令行版导进来的老草稿）：字数标红，要求先填好，马上让 Writer 按上限重写；你看过再保存。
  if (v.editable && v.limit && chars(dr.body) > v.limit) { $('#df-count').classList.add('over'); $('#df-instruction').value = `缩短到 ${v.limit} 字以内，意思不变`; $('#df-rewrite').click(); }
}

// ── 交互 ─────────────────────────────────────────────────────────────────────
function pollOpLog() {
  clearInterval(opTimer);
  if (!cc.ops.current) return;
  const id = cc.ops.current.id, box = document.querySelector('#op-log');
  const tick = async () => { try { const r = await fetch('/api/ops/log?id=' + encodeURIComponent(id)); const d = await r.json(); if (!r.ok) throw Error(d.error); if (box) { box.textContent = d.tail || '（暂无输出）'; box.scrollTop = box.scrollHeight; } if (d.status !== 'running') { clearInterval(opTimer); h.refresh(); } } catch (e) { clearInterval(opTimer); } };
  tick(); opTimer = setInterval(tick, 3000);
}
function applicationExecutionHtml(execution = {}) {
  const note = execution.prefilled ? `已在专用 Chrome 里预填。请核对那里保留的申请页，点「打开申请页」可以直接切过去。` : '下方是本地生成的拟填字段，不是网站上已填好的表单；目前没有预填完成的记录。';
  return `<div class="job-next-action"><b>实际执行状态：${h.esc(execution.word || '没认出来')}${execution.reason ? `（${h.esc(execution.reason)}）` : ''}</b><p class="full">${h.esc(note)}</p>${execution.detail ? `<p class="full">${h.esc(execution.detail)}</p>` : ''}${execution.evidence ? refs([{file:execution.evidence}]) : ''}</div>`;
}
function readSpecs(box) {
  const rows = [...box.querySelectorAll('.spec-row')].map(r => { const o = { provider: r.querySelector('.spec-provider').value, model: r.querySelector('.spec-model').value }; const e = r.querySelector('.spec-effort')?.value; if (e) o.effort = e; const l = r.querySelector('.spec-label')?.value.trim(); if (l) o.label = l; return o; }).filter(o => o.model && o.model !== '__custom__');
  return box.dataset.single === '1' ? (rows[0] || null) : rows;
}
function parseControl(el) {
  const kind = el.dataset.kind, v = el.value;
  if (kind === 'specs') { const value = readSpecs(el); return { value, changed: JSON.stringify(value) !== el.dataset.initial }; }
  if (kind === 'chain') { const rows = v.split('\n').map(s => s.trim()).filter(Boolean).map(s => { const [provider, model, effort = 'low'] = s.split(/\s+/); return { provider, model, effort }; }); return { value: rows, changed: JSON.stringify(rows) !== el.dataset.initial }; }
  if (kind === 'list') { const rows = v.split(/[\n,，、]+/).map(s => s.trim()).filter(Boolean); return { value: rows, changed: JSON.stringify(rows) !== el.dataset.initial }; }
  if (kind === 'backends') { const t = v.split('\n').map(s => s.trim()).filter(Boolean).join('\n'); return { value: t, changed: t !== String(el.dataset.initial || '').split('\n').map(s => s.trim()).filter(Boolean).join('\n') }; }
  if (kind === 'bool') return { value: v === 'true', changed: v !== el.dataset.initial };
  return { value: v.trim(), changed: v.trim() !== String(el.dataset.initial ?? '') };
}
// 动态插入的片段（筛选结果等）也要绑定同一套按钮。
function bindDynamic(root = document) {
  root.querySelectorAll('details.fold').forEach(d => d.ontoggle = () => { d.open ? openState.add(d.dataset.key) : openState.delete(d.dataset.key); });
  root.querySelectorAll('[data-job-reply]').forEach(b => b.onclick = () => submitHostJobReply(b, root));
  root.querySelectorAll('[data-job-feedback]').forEach(b => b.onclick = async () => { b.disabled = true; try { await openHostJobFeedback(b.dataset.jobFeedback); } catch (e) { h.toast(e.message); } finally { b.disabled = false; } });
  root.querySelectorAll('[data-hostjob]').forEach(b => b.onclick = async () => {
    if (b.dataset.ask && !(await askConfirm({ title: b.dataset.ask, go: b.textContent.trim() || '继续' }))) return;
    b.disabled = true;
    try { const r = await h.post('/api/host-job', { id: b.dataset.hostjob, action: b.dataset.hj }); logLine(`${b.dataset.hj} ${b.dataset.hostjob.slice(0, 8)}`, `任务状态 → ${r.status}`); h.toast(`宿主任务已${b.dataset.hj === 'retry' ? '重新排队' : '放弃'}${r.run_now ? '，本机 AI 会接着处理' : ''}`); await h.refresh(); } catch (e) { h.toast(e.message); b.disabled = false; }
  });
  root.querySelectorAll('[data-view-draft]').forEach(b => b.onclick = () => openDraftEditor(b.dataset.viewDraft, true));
  root.querySelectorAll('[data-copy-draft]').forEach(b => b.onclick = async () => { try { const r = await fetch('/api/draft?readonly=1&id=' + encodeURIComponent(b.dataset.copyDraft)); const v = await r.json(); if (!r.ok) throw Error(v.error); await navigator.clipboard.writeText(v.draft.body || ''); h.toast('文案已复制'); } catch (e) { h.toast(e.message); } });
  root.querySelectorAll('[data-agent-profile]').forEach(b => b.onclick = async () => { try { const r = await fetch('/api/agent?role=' + encodeURIComponent(b.dataset.agentProfile)); const v = await r.json(); if (!r.ok) throw Error(v.error); const box = b.parentElement.querySelector('[data-agent-content]'); box.innerHTML = `<p>${h.esc(v.persona.name)} · ${h.esc(v.persona.duty)}</p><pre style="white-space:pre-wrap">${h.esc(v.grammar)}</pre>${v.ops.map(o => `<p><b>${h.esc(o.key)} · ${h.esc(o.label)}</b> ${h.esc(o.desc)}</p>`).join('')}<details><summary>系统提示词</summary><pre style="white-space:pre-wrap">${h.esc(v.system_prompt)}</pre></details><details><summary>模型底座</summary><pre>${h.esc(JSON.stringify(v.backends, null, 2))}</pre></details>`; } catch (e) { h.toast(e.message); } });
  root.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { const [key, p] = b.dataset.pg.split('|'); pageState[key] = { ...(pageState[key] || {}), page: Number(p) }; savePages(); paintList(key); });
  root.querySelectorAll('[data-size]').forEach(sel => sel.onchange = () => { const key = sel.dataset.size; pageState[key] = { page: 1, size: Number(sel.value) }; savePages(); paintList(key); });
  root.querySelectorAll('[data-grp]').forEach(b => b.onclick = () => { const k = b.dataset.grp; openState.has(k) ? openState.delete(k) : openState.add(k); paintList(k.split('|')[0]); });
  root.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => handleCmdButton(b));
  root.querySelectorAll('[data-archive-action],[data-archive-key]').forEach(b => b.onclick = async () => {
    const n = b.dataset.archiveNumber, label = b.dataset.archiveLabel || '';
    const choice = await ask({ title: `归档：${label}`, body: `<p class="muted small">「只归档这一项」：这一项不再出现，线索照常。「结束整条线索」：${n ? `${n} 号` : '这条'}到此为止（面试完了、有结果了、不想跟了），它所有待办与提醒一起结束，线索保留在看板「归档」里。</p>`, input: 'choice', ok: '归档', value: '只归档这一项', options: n ? ['只归档这一项', '结束整条线索'] : ['只归档这一项'] });
    if (choice == null) return;
    const whole = /整条|结束|全部/.test(choice) && n;
    let note = '';
    if (whole) { note = await ask({ title: `结束 ${n} 号：原因（可空）`, input: 'reason', ok: '结束线索', required: false }); if (note == null) return; }
    b.disabled = true;
    try {
      if (whole) await runCommand(`${n} 归档 ${note}`.trim());
      else { const r = await h.post('/api/archive', { action_id: b.dataset.archiveAction || null, key: b.dataset.archiveKey || null, note: /只归档/.test(choice) ? '' : choice }); h.toast(r.receipt); logLine(`归档 ${label}`, r.receipt); await h.refresh(); }
    } catch (e) { h.toast(e.message); b.disabled = false; }
  });
  root.querySelectorAll('[data-open-url]').forEach(b => b.onclick = async () => {
    b.disabled = true; h.toast('正在浏览器里打开…');
    try { const r = await h.post('/api/open-url', { url: b.dataset.openUrl }); h.toast(r.receipt || '已打开'); logLine('打开 ' + b.dataset.openUrl, r.receipt || '已打开'); } catch (e) { h.toast('打不开：' + e.message); } finally { b.disabled = false; }
  });
  root.querySelectorAll('[data-sysfix]').forEach(b => b.onclick = async () => {
    let target; try { target = JSON.parse(b.dataset.sysfix); } catch { return; }
    const note = await ask({ title: `交给 ${h.crewName('patch')} 修：${target.label}`, body: `<p class="muted">${h.esc(h.crewName('patch'))} 会读证据、查根因、修错误的状态记录；查到是代码问题，只写好改法交给你，不改代码。结果写回这一行。补一句你观察到的现象（可空）：</p>`, input: 'text', ok: `交给 ${h.crewName('patch')}`, required: false });
    if (note == null) return;
    b.disabled = true;
    try { const r = await h.post('/api/system-fix', { target, note }); h.toast(r.receipt); logLine(`交给 ${h.crewName('patch')} 修：${target.label}`, r.receipt, 'ok'); await h.refresh(); } catch (e) { h.toast(e.message); b.disabled = false; }
  });
  root.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => openDraftEditor(b.dataset.draft));
  root.querySelectorAll('[data-application-page]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await h.post('/api/application-page', {record_id:b.dataset.applicationPage}); if (r.error || r.ok === false) throw Error(r.error || r.receipt); h.toast(r.receipt); } catch (e) { h.toast(e.message); } finally { b.disabled = false; } });
  root.querySelectorAll('[data-form-preview]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await fetch('/api/application-plan?id=' + encodeURIComponent(b.dataset.formPreview)); const v = await r.json(); if (!r.ok) throw Error(v.error); const rows = (v.fields || []).map(f => `<tr><td class="muted">${h.esc(f.label || f.key)}</td><td style="white-space:pre-wrap">${h.esc(f.value)}</td></tr>`).join(''); await ask({ title: `${v.number != null ? '#' + v.number + ' ' : ''}${v.company} · ${v.role} 拟填内容`, body: `${applicationExecutionHtml(v.execution)}<p class="muted small">${v.url ? `入口：${h.esc(v.url)}` : ''}${v.resume ? `<br>简历：${h.esc(v.resume.split('/').pop())}` : ''}${v.error ? `<br><span class="tag red">现在还投不了：${h.esc(v.error)}</span>` : ''}</p><div class="table-wrap"><table class="mini-table"><tbody>${rows || '<tr><td class="muted">没有可填字段</td></tr>'}</tbody></table></div>`, ok: '关闭', required: false }); } catch (e) { h.toast(e.message); } finally { b.disabled = false; } });
  root.querySelectorAll('[data-computer-use]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Codex 正在接手…';
    try { await h.post('/api/ops', { op: 'computer-use-record', record_id: b.dataset.computerUse }); await h.refresh(); }
    catch (e) { b.textContent = '重试 Codex'; b.disabled = false; h.toast(e.message); }
  });
  root.querySelectorAll('[data-portal-login]').forEach(b => b.onclick = async () => { if (!(await askConfirm({ title: '确认你已登录这个网站？', lines: ['会记为你本人确认，并恢复仍有有效批准的任务。'], go: '确认已登录' }))) return; b.disabled = true; try { const r = await h.post('/api/portal-session', { host: b.dataset.portalLogin, logged_in: true, confirm: true }); h.toast(r.receipt || '已记录'); logLine('我已登录 ' + b.dataset.portalLogin, r.receipt || '已记录', 'ok'); await h.refresh(); } catch (e) { h.toast(e.message); b.disabled = false; } });
}
export function bindCommand(tabOnly = false) {
  globalThis.OfferCrewModelSimple?.mount(h, () => cc?.token || '');
  document.querySelectorAll('[data-goto]').forEach(a => a.onclick = e => { e.preventDefault(); const t = document.getElementById(a.dataset.goto); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1800); } });
  const jumpTo = new URLSearchParams(location.hash.split('?')[1] || '').get('jump'); if (jumpTo) { const t = document.getElementById(jumpTo); if (t) setTimeout(() => { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1800); }, 50); }
  bindDynamic(document);

  // 偏好：点一条设权重；× 撤销；＋ 添加。
  document.querySelectorAll('[data-pref]').forEach(b => b.onclick = async () => { const w = await ask({ title: `手动设置 ${b.dataset.pref} 的权重`, body: '<p class="muted small">正数加权、负数降权，范围 -6 … +6；手改值优先于学到的值，重算不会覆盖。</p>', input: 'number', value: b.dataset.weight || '0', ok: '保存', step: 'any' }); if (w == null) return; try { await h.post('/api/preference', { key: b.dataset.pref, weight: Number(w) }); h.toast('已保存手动偏好'); await h.refresh(); } catch (e) { h.toast(e.message); } });
  document.querySelectorAll('[data-pref-clear]').forEach(b => b.onclick = async () => { if (!(await askConfirm({ title: `撤销手动偏好 ${b.dataset.prefClear}？`, lines: ['以后按团队学到的权重来。'], go: '撤销' }))) return; try { await h.post('/api/preference', { key: b.dataset.prefClear, weight: null }); h.toast('已撤销'); await h.refresh(); } catch (e) { h.toast(e.message); } });
  const add = document.querySelector('#pref-add'); if (add) add.onclick = async () => { const k = await ask({ title: '添加手动偏好', body: '<p class="muted small">键的形式：维度:取值，例如 direction:算法研究、city:苏州、company:华为、company_type:foreign_mnc。</p>', input: 'line', ok: '下一步' }); if (!k) return; const w = await ask({ title: `${k} 的权重`, input: 'number', value: '3', ok: '保存', step: 'any' }); if (w == null) return; try { await h.post('/api/preference', { key: k, weight: Number(w) }); h.toast('已保存手动偏好'); await h.refresh(); } catch (e) { h.toast(e.message); } };
  // 个人事实：✎ 直接改。
  document.querySelectorAll('[data-fact]').forEach(b => b.onclick = async () => { const kind = b.dataset.kind, opts = b.dataset.options ? b.dataset.options.split(',') : null; const v = await ask({ title: `修改「${b.dataset.label}」`, body: kind === 'list' ? '<p class="muted small">多个值用逗号分隔，按顺序。</p>' : '', input: kind === 'bool' ? 'bool' : kind === 'int' ? 'number' : (String(b.dataset.value).length > 60 ? 'text' : 'line'), value: b.dataset.value, ok: '保存', options: opts, ...(kind === 'int' ? { min: 0, max: 100000, step: 1 } : {}) }); if (v == null) return; try { const r = await h.post('/api/facts', { path: b.dataset.fact, value: v }); h.toast(r.status === 'unchanged' ? '没有改动' : `已保存${r.backup ? '（原资料已备份）' : ''}`); await h.refresh(); } catch (e) { h.toast(e.message); } });
  // 设置：每个文件一个表单，只提交改过的字段。
  document.querySelectorAll('[data-settings-form]').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    const patch = {}; for (const el of f.querySelectorAll('[name]')) { const { value, changed } = parseControl(el); if (changed) patch[el.name] = value; }
    const note = f.querySelector('.settings-note');
    if (!Object.keys(patch).length) { note.textContent = '没有改动'; return; }
    const b = e.submitter || e.target.querySelector('button[type=submit]'); b.disabled = true;
    try { const r = await h.post('/api/settings', { name: f.dataset.settingsForm, patch }); note.textContent = r.status === 'saved' ? `已保存 ${r.changes.length} 项${r.backup ? '（原设置已备份）' : ''}` : '没有改动'; h.toast(note.textContent); await h.refresh(); } catch (err) { note.textContent = err.message; h.toast(err.message); } finally { b.disabled = false; }
  });
  // 记忆库：筛选、搜索、新增（改删置顶在 bindMemory）。
  bindMemory(document);
  if ((memFilter.kind || memFilter.q) && !memRows) loadMemory();
  document.querySelectorAll('[data-mem-filter]').forEach(b => b.onclick = () => { memFilter.kind = memFilter.kind === b.dataset.memFilter ? '' : b.dataset.memFilter; loadMemory(); });
  const ms = document.querySelector('#mem-search'); if (ms) { let t; ms.oninput = () => { clearTimeout(t); t = setTimeout(() => { memFilter.q = ms.value.trim(); loadMemory(); }, 300); }; }
  const mc = document.querySelector('#mem-clear'); if (mc) mc.onclick = () => { memFilter = { kind: '', q: '' }; memRows = null; h.refresh(); };
  const mf = document.querySelector('#mem-form'); if (mf) mf.onsubmit = async e => { e.preventDefault(); const b = e.submitter || e.target.querySelector('button[type=submit]'); b.disabled = true; try { const r = await h.post('/api/memory', { action: 'add', kind: document.querySelector('#mem-kind').value, subject: document.querySelector('#mem-subject').value, numbers: document.querySelector('#mem-numbers').value, text: document.querySelector('#mem-text').value }); h.toast(r.status === 'duplicate' ? '已经有一条一样的了' : '已记住'); document.querySelector('#mem-text').value = ''; memRows = null; await h.refresh(); } catch (err) { h.toast(err.message); } finally { b.disabled = false; } };
  // 供应商 / 模型清单编辑器。
  const cat = cc.settings?.catalog || [];
  const rebuildRow = row => { const box = row.closest('.specs'); const kinds = (box.dataset.kinds || '').split(',').filter(Boolean); const list = cat.filter(p => !kinds.length || kinds.includes(p.kind)); const cur = { provider: row.querySelector('.spec-provider').value, model: '', effort: '', label: row.querySelector('.spec-label')?.value || '' }; row.outerHTML = specRow(list, cur, { with_label: box.dataset.withLabel === '1' }); bindSpecs(box); };
  function bindSpecs(box) {
    box.querySelectorAll('.spec-provider').forEach(sel => sel.onchange = () => rebuildRow(sel.closest('.spec-row')));
    box.querySelectorAll('.spec-model').forEach(sel => sel.onchange = async () => { if (sel.value !== '__custom__') return; const v = await ask({ title: '模型名', body: '<p class="muted small">目录里没有的名字也可以填，保存后会一并加进该供应商的目录；用「测」验证是否可用。</p>', input: 'line', ok: '用这个' }); if (!v) { sel.selectedIndex = 0; return; } const o = document.createElement('option'); o.value = v; o.textContent = v; sel.insertBefore(o, sel.lastElementChild); sel.value = v; });
    box.querySelectorAll('.spec-up').forEach(b => b.onclick = () => { const r = b.closest('.spec-row'); r.previousElementSibling?.classList.contains('spec-row') && r.parentNode.insertBefore(r, r.previousElementSibling); });
    box.querySelectorAll('.spec-down').forEach(b => b.onclick = () => { const r = b.closest('.spec-row'); r.nextElementSibling?.classList.contains('spec-row') && r.parentNode.insertBefore(r.nextElementSibling, r); });
    box.querySelectorAll('.spec-del').forEach(b => b.onclick = () => { const r = b.closest('.spec-row'); r.remove(); if (box.dataset.single === '1' && !box.querySelector('.spec-add')) box.insertAdjacentHTML('beforeend', '<button type="button" class="chip act spec-add">＋ 添加</button>'); bindSpecs(box); });
    box.querySelectorAll('.spec-test').forEach(b => b.onclick = async () => { const r = b.closest('.spec-row'); const id = `${r.querySelector('.spec-provider').value}/${r.querySelector('.spec-model').value}`; b.disabled = true; b.textContent = '测试中…'; try { const x = await h.post('/api/settings/test', { backend: id }); b.textContent = x.ok ? `✓ ${(x.ms / 1000).toFixed(1)}s` : '✗'; h.toast(x.ok ? `${x.backend} 可用 · ${(x.ms / 1000).toFixed(1)} 秒` : `${x.backend} 不可用：${x.error}`); } catch (e) { b.textContent = '测'; h.toast(e.message); } finally { b.disabled = false; } });
    const add = box.querySelector('.spec-add'); if (add) add.onclick = () => { const kinds = (box.dataset.kinds || '').split(',').filter(Boolean); const list = cat.filter(p => !kinds.length || kinds.includes(p.kind)); add.insertAdjacentHTML('beforebegin', specRow(list, { provider: list[0]?.key, model: list[0]?.models?.[0] || '' }, { with_label: box.dataset.withLabel === '1' })); if (box.dataset.single === '1') add.remove(); bindSpecs(box); };
  }
  document.querySelectorAll('.specs').forEach(bindSpecs);
  document.querySelectorAll('[data-jump]').forEach(a => a.onclick = e => { e.preventDefault(); const t = document.getElementById(a.dataset.jump); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1800); } else location.hash = '#settings?jump=' + a.dataset.jump; });
  // 目录：状态、探测、增删模型、账号。
  document.querySelectorAll('[data-agent]').forEach(sel => sel.onchange = async () => {
    const previous = sel.dataset.initial, value = sel.value;
    sel.disabled = true;
    try { await h.post('/api/settings/agent', { role: sel.dataset.agent, patch: { [sel.dataset.channel]: value || null } }); sel.dataset.initial = value; h.toast('底座已保存'); await h.refresh(); }
    catch (e) { sel.value = previous; h.toast(e.message); }
    finally { sel.disabled = false; }
  });
  const probeRuntimes = async () => {
    try {
      const response = await fetch('/api/settings/providers/status'); if (!response.ok) throw Error('探测失败');
      const statuses = await response.json();
      for (const [key, v] of Object.entries(statuses)) {
        const runtime = cat.some(p => p.key === key && ['claude_code', 'codex_exec'].includes(p.kind));
        const label = providerStatusLabel(v, runtime);
        document.querySelectorAll(`[data-status="${CSS.escape(key)}"]`).forEach(el => { el.className = `pill ${v.ok ? 'ok' : 'idle'}`; el.textContent = label; el.title = v.detail || ''; });
        document.querySelectorAll(`option[data-runtime="${CSS.escape(key)}"]`).forEach(o => { o.textContent = `${o.dataset.label} · ${label}`; o.classList.toggle('agent-runtime-warning', !v.ok); });
      }
      document.querySelectorAll('.agent-backend').forEach(sel => sel.classList.toggle('agent-runtime-warning', !!sel.selectedOptions[0]?.classList.contains('agent-runtime-warning')));
    } catch (e) { document.querySelectorAll('[data-status]').forEach(el => { el.textContent = '探测失败'; }); document.querySelectorAll('option[data-runtime]').forEach(o => { if (o.dataset.runtime) { o.textContent = `${o.dataset.label} · 探测失败`; o.classList.add('agent-runtime-warning'); } }); h.toast(e.message); }
  };
  // 供应商页的状态标签也要它（以前只在成员模型表在时才探，供应商页一直停在「查询中…」，R24）。
  if (document.querySelector('.agent-backends, [data-status]')) probeRuntimes();
  document.querySelectorAll('[data-runtime-refresh]').forEach(b => b.onclick = async () => { b.disabled = true; try { await probeRuntimes(); } finally { b.disabled = false; } });
  document.querySelectorAll('[data-login-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.loginCopy); h.toast('登录命令已复制'); } catch { h.toast(`请复制：${b.dataset.loginCopy}`); } });
  document.querySelectorAll('[data-discover]').forEach(b => b.onclick = async () => { b.disabled = true; const t = b.textContent; b.textContent = '探测中…'; try { const r = await h.post('/api/settings/providers', { action: 'discover', key: b.dataset.discover }); h.toast(`${r.key}：找到 ${r.found.length} 个模型，新增 ${r.added.length}（${r.source}）`); await h.refresh(); } catch (e) { b.textContent = t; h.toast(e.message); } finally { b.disabled = false; } });
  document.querySelectorAll('[data-model-del]').forEach(b => b.onclick = async () => { const p = cat.find(x => x.key === b.dataset.modelDel); if (!p) return; if (!(await askConfirm({ title: `从 ${p.key} 的目录移除 ${b.dataset.model}？`, lines: ['用到它的成员会换成目录里别的模型。'], go: '移除', danger: true }))) return; try { await h.post('/api/settings/providers', { action: 'models', key: p.key, models: p.models.filter(m => m !== b.dataset.model) }); await h.refresh(); } catch (e) { h.toast(e.message); } });
  document.querySelectorAll('[data-model-add]').forEach(f => f.onsubmit = async e => { e.preventDefault(); const p = cat.find(x => x.key === f.dataset.modelAdd); const v = f.querySelector('input').value.trim(); if (!p || !v) return; try { await h.post('/api/settings/providers', { action: 'models', key: p.key, models: [...p.models, v] }); h.toast(`已加入 ${p.key} 的目录，点「测」验证`); await h.refresh(); } catch (err) { h.toast(err.message); } });
  document.querySelectorAll('[data-provider-remove]').forEach(b => b.onclick = async () => { if (!(await askConfirm({ title: `删除${b.dataset.account === '1' ? '账号' : '供应商'} ${b.dataset.providerRemove}？`, lines: ['用它的成员换成别的模型；凭据和登录目录留在 private/ 下。'], go: '删除', danger: true }))) return; try { const r = await h.post('/api/settings/providers', { action: 'provider_remove', key: b.dataset.providerRemove }); h.toast(r.note); await h.refresh(); } catch (e) { h.toast(e.message); } });
  document.querySelectorAll('[data-provider-edit]').forEach(b => b.onclick = async () => {
    const key = b.dataset.providerEdit, kind = b.dataset.kind;
    const d = ensureDialog();
    d.querySelector('#cd-title').textContent = `改 ${key} 的地址 / 密钥`;
    d.querySelector('#cd-body').innerHTML = `<div class="settings-grid" style="padding:0"><label class="setting"><span>base_url（留空不改）</span><input id="pe-base" placeholder="https://…"></label><label class="setting"><span>API key（留空不改）</span><input id="pe-key" type="password" autocomplete="off"></label>${kind === 'openai_http' ? `<label class="setting"><span>接口</span><select id="pe-wire"><option value="">不改</option><option value="chat">chat/completions</option><option value="responses">responses</option></select></label>` : ''}<label class="setting"><span>显示名（留空不改）</span><input id="pe-label"></label></div>`;
    d.querySelector('#cd-input').innerHTML = '';
    d.querySelector('#cd-ok').textContent = '保存';
    const ok = await new Promise(resolve => { d.querySelector('#console-form').onsubmit = e => { e.preventDefault(); d.close('ok'); resolve(true); }; d.onclose = () => { if (d.returnValue !== 'ok') resolve(false); }; d.returnValue = ''; d.showModal(); });
    if (!ok) return;
    const patch = { action: 'provider_update', key, base_url: d.querySelector('#pe-base').value.trim() || null, api_key: d.querySelector('#pe-key').value.trim() || null, label: d.querySelector('#pe-label').value.trim() || null, wire_api: d.querySelector('#pe-wire')?.value || null };
    try { const r = await h.post('/api/settings/providers', patch); h.toast(`已更新 ${key}：${r.changed.join('、')}；用「测」验证`); await h.refresh(); } catch (e) { h.toast(e.message); }
  });
  const pf = document.querySelector('#provider-form'); if (pf) pf.onsubmit = async e => { e.preventDefault(); const b = e.submitter || pf.querySelector('button[type=submit]'); b.disabled = true; const fd = new FormData(pf); const [kind, wire] = String(fd.get('kind')).split('|'); try { const r = await h.post('/api/settings/providers', { action: 'provider_add', key: fd.get('key'), label: fd.get('label') || null, kind, wire_api: wire || 'chat', base_url: fd.get('base_url'), api_key: fd.get('api_key'), models: fd.get('models') || '' }); h.toast(`已添加 ${r.key}（${r.note}）`); pf.reset(); await h.refresh(); } catch (err) { h.toast(err.message); } finally { b.disabled = false; } };
  const af = document.querySelector('#account-form'); if (af) af.onsubmit = async e => { e.preventDefault(); const b = e.submitter || af.querySelector('button[type=submit]'); b.disabled = true; try { const r = await h.post('/api/settings/providers', { action: 'account_add', base: document.querySelector('#account-base').value, name: document.querySelector('#account-name').value }); await ask({ title: `账号 ${r.key} 已建，去终端登录`, body: `<p class="muted small">${h.esc(r.note)}</p><pre class="log-box" style="margin:8px 0">${h.esc(r.login_command)}\n${h.esc(r.status_command)}</pre><p class="muted small">登录完成后回到这里，「模型目录」里该账号的状态会变成「可用」。</p>`, ok: '知道了' }); await h.refresh(); } catch (err) { h.toast(err.message); } finally { b.disabled = false; } };
  document.querySelectorAll('[data-test-backend]').forEach(b => b.onclick = async () => { b.disabled = true; const label = b.textContent; b.textContent = `测试中… ${b.dataset.testBackend}`; try { const r = await h.post('/api/settings/test', { backend: b.dataset.testBackend }); b.textContent = r.ok ? `✓ ${b.dataset.testBackend} ${(r.ms / 1000).toFixed(1)}s` : `✗ ${b.dataset.testBackend}`; b.classList.toggle('good', r.ok); b.classList.toggle('bad', !r.ok); h.toast(r.ok ? `${r.backend} 可用 · ${(r.ms / 1000).toFixed(1)} 秒 · 回答「${r.text}」` : `${r.backend} 不可用：${r.error}`); } catch (e) { b.textContent = label; h.toast(e.message); } finally { b.disabled = false; } });
  document.querySelectorAll('[data-preset]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const p = await h.post('/api/settings/preset', { name: b.dataset.preset });
      if (!p.changes.length) { h.toast('已经是这个配置，没有要改的'); return; }
      const body = `<p class="muted small">${h.esc(p.desc)}</p><div class="mini-list">${p.changes.map(c => `<div class="mini-row"><span class="grow"><code>${h.esc(c.file)}</code> ${h.esc(c.label || c.key)}<br><small class="muted">${h.esc(JSON.stringify(c.from))} → <b>${h.esc(JSON.stringify(c.to))}</b>${c.error ? ' · <span class="over">' + h.esc(c.error) + '</span>' : ''}</small></span></div>`).join('')}</div>`;
      const ok = await ask({ title: `切到「${p.label}」？`, body, ok: p.blocked.length ? '有字段不能应用' : '确认写入' });
      if (!ok || p.blocked.length) return;
      const r = await h.post('/api/settings/preset', { name: b.dataset.preset, apply: true });
      h.toast(`已切换：${r.applied.length} 处改动，原设置已备份`);
      await h.refresh();
    } catch (e) { h.toast(e.message); } finally { b.disabled = false; }
  });
  document.querySelectorAll('[data-test-model]').forEach(b => b.onclick = async () => { b.disabled = true; const label = b.textContent; b.textContent = '测试中…'; try { const r = await h.post('/api/settings/test', { model: b.dataset.testModel }); b.textContent = r.ok ? `✓ ${b.dataset.testModel} ${r.ms}ms` : `✗ ${b.dataset.testModel}`; b.classList.toggle('good', r.ok); b.classList.toggle('bad', !r.ok); h.toast(r.ok ? `${r.model} 可用 · ${r.ms} ms` : `${r.model} 不可用：${r.error}`); } catch (e) { b.textContent = label; h.toast(e.message); } finally { b.disabled = false; } });
  pollOpLog();
}
