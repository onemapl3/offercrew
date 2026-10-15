// 指挥台 v2（2026-09-29，照 design/hq-v2；同日晚瘦身，design/hq-slim；09-30 布局 v3.1，design/layout-v3/布局重构.md）：处理线索的地方。
//   ① 页头     「指挥台」加件数。找新岗位是 Radar 的事，不挂在页头（09-30 负责人）：团队页 Radar 名下「Radar 跑一轮」；
//              表里一条都没有时，表里给「让 Radar 找岗位」（同一个 op：POST /api/team/run round-scout）；Radar 正在跑就说在找、跑了多久。
//   ② 流水线   标签 · 搜索 · 按公司分组 · 八列步骤；每行一个就地动作（投 / 联系 / pass；看草稿 → 发送 / 我来改 / 不发了；
//              批准投递 / 不投；跟进 / 不跟），可以多选批量（草稿除外）。成员不再是筛选（负责人 09-30：成员从导航降为署名）。
//              表格按自己的宽度收紧（容器查询）：700–999 px 渠道并进第二行，700 px 以下八个点换成一条进度加当前这一步。
//   ③ 岗位页   点一行（或行上的 去补 / 去终审），主区换成这条的岗位页 #lead/<rid>（下面 leadPage）：
//              页头（← 来处 · 公司岗位城市编号薪资原帖阶段 · ‹ 1/3 › 按来处那张表的顺序翻，j / k 也行）、
//              等你的那封信（整封，就地回答，和收件箱同一封；答完给「下一件 →」；没有等你的事放 pass / 重新打开），
//              四块页内标签：JD 与判断 · 材料 · 进展（每一步一个小头像）· 公司（点开才画）。
//   ④ 说话     右侧面板只是对话（web/talk.js）；在面板里点什么主区都不跳。主区正在看的岗位由 focusLead() 给出，变了发 oc:viewing。
// 数据全部来自 /api/hq（lib/hq.mjs 已经分好类、算成中文）和 /api/lead，这里只负责画，和把你的选择交回服务端。
import { presetInbox, paintBadge } from './inbox.js';
import { runCommand, openDraftEditor } from './command.js';
import { companySection, prepSection, interviewSection, requestCompany } from './company.js';
import { faceHtml as face } from './face.js';
import { traceHtml, resumeUsedHtml, evidenceLabel } from './trace.js';
import { openEditor } from './setup.js';
import { paperHtml, mountSheetCss } from './resume-paper.js';
import { morph } from './morph.js';
import { askConfirm } from './settings/ask.js';
import { coName as coClean, coTbd, coPoster, verdictWord, VERDICT_KEYS, plainJudgement, jobTitle } from './vocab.js';

let h = null, view = null, sig = null, viewAt = 0, viewLoading = null;
const S = { tab: 'all', q: '', cities: [], filters: [], multi: false, sel: new Set(), menu: null, pop: null, expand: null, confirm: null, pick: null, batch: null, busy: new Set(), done: new Map(), answered: new Set(), sticky: new Map(), flash: null, from: null, ldTab: 'jd', jdOpen: false, trace: null, logOpen: false, find: null, backScroll: null, only: null, order: 'recent', page: 1 };
const OLD_FILTERS = ['company', 'verdict', 'facet', 'filter'];
const FILTERS = [['recommend', '仅推荐', '使用当前已保存的推荐结论'], ['remote', '仅远程 / Remote', '明确支持远程，不含仅混合办公的岗位'], ['referral', '真人内推', '原帖明确提供内推；不含匿名、猎头或未核实的历史记录']];
const SORTS = ['recent', 'oldest', 'role', 'role-desc', 'progress', 'progress-desc'];
try { const s = JSON.parse(sessionStorage.getItem('radar.hq2') || '{}'); if (s.tab) S.tab = s.tab; if (typeof s.q === 'string') S.q = s.q; if (Array.isArray(s.cities)) S.cities = [...new Set(s.cities.filter(x => typeof x === 'string' && x && x.length <= 64))].slice(0, 50); if (Array.isArray(s.filters)) S.filters = FILTERS.map(([key]) => key).filter(key => s.filters.includes(key)); if (SORTS.includes(s.order)) S.order = s.order; S.page = OLD_FILTERS.some(k => s[k]) || (s.order && !SORTS.includes(s.order)) ? 1 : Math.max(1, Math.floor(Number(s.page)) || 1); } catch {}
try { S.from = JSON.parse(sessionStorage.getItem('oc.leadFrom') || 'null'); } catch {}
const save = () => { try { sessionStorage.setItem('radar.hq2', JSON.stringify({ tab: S.tab, q: S.q, cities: S.cities, filters: S.filters, order: S.order, page: S.page })); } catch {} };
save(); // 旧公司/结论条件只迁出，不让已移除的控件继续暗中过滤。
const esc = x => h.esc(x);
const $ = s => document.querySelector(s);
const COLS = ['发现', '判断', '筛选', '准备', '批准', '递出', '回复', '面试'];
const DOT = { done: 'done', current: 'cur', waiting_you: 'you', blocked: 'bad', hold: 'hold', skipped: 'skip', not_reached: 'none' };
// 成员的名字和脸只从 /api/hq 的 workers 读（lib/crew.mjs 名册）；告警来源、「让谁起草」都按成员 id 查名字。
const whoName = k => view?.workers?.find(w => w.key === k)?.name || k || '';
const STAGE_RANK = { interview: 0, waiting: 1, moving: 2, approve: 3, new: 4, verify: 4, ended: 5, library: 6, shelf: 7 };
const PASS = ['方向不对', '城市不对', '年限或级别不符', '公司不想去', '薪资不符'];
// 同一个动作只有一个叫法（视觉验收第 1、2 条）：行上「投递 / 不投」，批量栏和岗位页的选项也这么叫。带原因的那个选项（信里叫 pass）就是不投。
const VERB_WORD = { 投: '投递', pass: '不投' };
const verbWord = v => VERB_WORD[v] || v;
const optLabel = o => o?.reasons?.length ? '不投' : o?.label || '';

export const hqSig = () => sig;
// 拿到新的 /api/hq：服务端已经不再给的信（处理完了）从「已回答」里拿掉；还在的行保持原位，直到换标签。
function takeView(v) {
  view = v; viewAt = Date.now(); sig = v.content_sig || null;
  if (!(v.tab_labels || []).some(([key]) => key === S.tab)) { S.tab = 'all'; S.page = 1; save(); }
  for (const id of [...S.answered]) if (!v.asks[id]) S.answered.delete(id);
  // 收到下一步的提问，立刻让它替换上一动作的回执。
  for (const id of [...S.done.keys()]) { const r = rowById(id); if (r?.ending) S.sticky.delete(id); if (r && (blockOf(r) || pipeOf(r))) { S.done.delete(id); S.sticky.delete(id); } }
  for (const id of [...S.sel]) if (!batchable(rowById(id))) S.sel.delete(id);
  paintBadge(v.inbox?.waiting ?? v.tally?.waiting?.total ?? 0); // 和收件箱同一张单子的件数（lib/hq.mjs deskInbox）
}
// unless：主区上这份指挥台是按哪个签名画的（后台刷新时 app.js 给）；拉到的还是它就不拼整页 HTML（几百行，慢机器上几十毫秒），返回 null。
export async function hqPage(helpers, { unless = null } = {}) {
  h = helpers;
  // 老链接 #command/<成员>（原来在面板「详情」里开它的日志）：成员的事在它的成员页。
  const deep = decodeURIComponent(location.hash.slice(1).split('?')[0].split('/')[1] || '');
  if (deep) { location.replace('#team/' + encodeURIComponent(deep)); return ''; }
  // #command?tab=verify（收件箱、对话指过来）：落在那个标签上；only=first-round（首轮那封信的「看这 N 个」）：只列那几条
  // （名单是 /api/hq 的 first_round_need，和信里的 N 同一个来源），标签旁边一个「只看这 N 个 ✕」。
  // 只认一次：画完以后（bindHq）地址换回 #command，之后你点别的标签不被它拉回去。不能在这里就换——app.js 画之前
  // 比一次地址，变了就当你已经去了别处，这一页不画（收件箱点「看这 4 个」没反应，第 4 轮负责人）。
  // 旧公司/结论深链回到全部；搜索词和明确的进度标签仍生效，过时条件在 bindHq 清掉。
  const hp = new URLSearchParams(location.hash.split('?')[1] || ''), want = hp.get('tab'), only = hp.get('only'), q = hp.get('q'), old = OLD_FILTERS.some(k => hp.has(k));
  if (want || only || old || q != null) { S.tab = want || (old || q != null ? 'all' : S.tab); if (q != null) S.q = q; S.only = null; S.page = 1; S.sticky.clear(); save(); }
  const r = await fetch('/api/hq'), v = await r.json();
  if (!r.ok) throw Error(v.error || '指挥台读取失败');
  takeView(v);
  if (only === 'first-round') S.only = new Set(v.first_round_need || []);
  if (unless && sig === unless) return null;
  requestAnimationFrame(() => showTab($('#hq-tabs')));
  return pageHtml();
}

// 换到指挥台时先用手上这份 /api/hq 画（web/app.js 换页立刻换）；没拉过、或地址带着要先认的参数（tab / only / 成员）就返回 null。
export function hqNow() {
  if (!view || !h || DEEP.test(location.hash) || location.hash.slice(1).split('?')[0].split('/')[1]) return null;
  requestAnimationFrame(() => showTab($('#hq-tabs')));
  return pageHtml();
}

const DEEP = /[?&](tab|only|q|verdict|company|facet|filter)(?:=|&|$)/;
// ── 小工具 ───────────────────────────────────────────────────────────────────
const rows = () => view?.rows || [];
const rowById = id => rows().find(r => r.rid === id) || null;
const libById = id => (view?.library || []).find(r => r.rid === id) || (view?.shelved || []).find(r => r.rid === id) || null;
const askOf = id => (id && view?.asks?.[id]) || null;
const live = id => !!askOf(id) && !S.answered.has(id);
const roleTitle = r => r.role ? jobTitle(r.role) : '岗位待核';
const numText = n => n != null ? `#${n}` : '未编号';
// 公司名、结论词：lib/vocab.mjs 一份（浏览器经 /vocab.js 取）。
const coName = c => ({ name: coClean(c) || '公司待核', tbd: coTbd(c) });
const listVerdictWord = k => k === 'none' ? '未判断' : k === 'prefilter' ? '初筛未通过' : verdictWord(k);
const vdTag = k => `<span class="hq-vd${k === 'recommend' ? ' is-rec' : ''}">${esc(listVerdictWord(k))}</span>`;
const verdictTag = r => !r.ending && ['recommend', 'verify'].includes(r.vkey || r.verdict) ? vdTag(r.vkey || r.verdict) : '';
// 匹配度（D4，lib/matcher.mjs requirementScore）：行上只跟在「推荐」后面；岗位页在「判断」旁边（jdHtml）。
const scoreTag = r => (r.vkey || r.verdict) === 'recommend' && r.score != null ? `<span class="hq-score">匹配度 ${Number(r.score)}</span>` : '';
const tabOf = r => S.sticky.get(r.rid) || r.tab;
const pipeOf = r => live(r.pipe) ? askOf(r.pipe) : null;
const blockOf = r => live(r.block) ? askOf(r.block) : null;
const optBy = (a, ...labels) => a?.options?.find(o => labels.includes(o.label)) || null;
const primaryOpt = a => optBy(a, '先判断', '投递', '联系', '跟进一次');
const passOpt = a => a?.options?.find(o => o.reasons?.length) || null;
// 没判完的岗位只有「先判断」（lib/asks.mjs judgeFirst），不出投递。
const verbOf = a => primaryOpt(a)?.label === '先判断' ? '先判断' : a?.kind === 'apply' ? '批准投递' : primaryOpt(a)?.label === '投递' ? '投递' : primaryOpt(a)?.label === '跟进一次' ? '跟进' : '联系';
const judgeRetryBlocked = (r, a = pipeOf(r)) => !!r?.judge_recovery && (primaryOpt(a)?.label === '先判断' || (a?.judgement_stopped === true && ['queued', 'running'].includes(r.judge_recovery.status)));
const batchable = r => !!r && !!pipeOf(r) && r.pipe_kind !== 'draft' && !S.done.has(r.rid) && !blockOf(r) && !judgeRetryBlocked(r);
// 「已 3 分钟」：从开始到现在。
export const sinceText = (at, now = Date.now()) => { const m = Math.floor((now - Date.parse(at || '')) / 60000); return !Number.isFinite(m) || m < 1 ? '刚开始' : m < 60 ? `已 ${m} 分钟` : `已 ${Math.floor(m / 60)} 小时 ${m % 60} 分`; };

// ── ① 页头 ───────────────────────────────────────────────────────────────────
// 页头只有标题和件数。正在跑的那一项不挂在页头（负责人 10-02：进度进运行日志）；表还空着时，那一句是表自己的空状态（rowsHtml）。
function headingHtml() {
  const n = hasFilters() ? filteredRows().length : view?.tabs?.all ?? rows().length;
  return `<h1>指挥台${n || hasFilters() ? `<small class="hq-n">${n}</small>` : ''}</h1>`;
}
// 「Radar 在找 · 找到 12 个 · Judge 判了 3/15 · 已 4 分钟」；别的成员：「「看 BOSS 消息」在跑 · 已 2 分钟」。
// 找到的多、这一批只判一部分时说清 15 是什么（和 lib/hq.mjs runProgress 同一句）。
const runProg = run => [run.found ? `找到 ${run.found} 个${run.total && run.total < run.found ? `，先判最对口的 ${run.total} 个` : ''}` : '', run.judged || run.total ? `${run.judge_name} 判了 ${run.judged}${run.total ? `/${run.total}` : ''}` : ''].filter(Boolean);
// 表里一条都没有时：「让 Radar 找岗位」（Radar 跑一轮，op 和团队页同一个）；重的操作先问一句（和团队页同一句），轻的点了就跑。
function findHtml() {
  const f = view?.find || {}, run = view?.running;
  if (!f.op) return '';
  // 操作台上别的在跑（一次只跑一个）：按钮换成「X 在跑」，点不了。周期里某位成员在跑不挡操作台，按钮照常。
  if (run?.op) return `<button type="button" class="primary hq-find" disabled>「${esc(run.label)}」在跑</button>`;
  const btn = `<button type="button" class="primary hq-find" data-find ${S.busy.has('find') ? 'disabled' : ''}>${S.busy.has('find') ? '正在开始…' : `让 ${esc(whoName('scout'))} 找岗位`}</button>`;
  const confirm = S.find === 'confirm' ? `<div class="td-confirm hq-find-ok" role="alertdialog" aria-label="确认运行"><span>「${esc(f.label)}」比较重：${esc(f.usual || '要跑一阵')}。现在跑？</span><button type="button" class="primary" data-find-yes>确定跑</button><button type="button" class="secondary" data-find-no>算了</button></div>` : '';
  return `${btn}${confirm}`;
}
async function findJobs() {
  const f = view?.find; if (!f?.op || S.busy.has('find')) return;
  S.find = null; S.busy.add('find'); paint('rows');
  try { const r = await h.post('/api/team/run', { member: 'scout', op: f.op }); h.toast(r.receipt || '已开始'); }
  catch (e) { h.toast(e.message); }
  finally { S.busy.delete('find'); setTimeout(() => h.refresh(), 600); paint('rows'); }
}

// 首轮跑完的结果不再挂在指挥台顶上（第 3 轮负责人：顶上只放挡路的大事）：要你补信息的进收件箱，进度进运行日志（lib/first-round.mjs）。
// ⓪ 挡路大事（lib/blockers.mjs）：系统走不下去、得你动手的才有这一条，一次一条；一句话加「看原因」（打开和 System 的对话）。
function topHtml() {
  const b = systemTop();
  if (!b) return '';
  // 普通待答事项留在收件箱。只有运行故障占顶部，必须处理的故障不能关掉。
  const btn = b?.go ? `<button type="button" class="hq-top-why" data-top-go="${esc(b.go)}">${esc(b.label || '打开')}</button>` : '<button type="button" class="hq-top-why" data-top-why>看原因</button>';
  const x = b.kind === 'phone' ? '<button type="button" class="hq-top-x" data-top-close aria-label="暂时关闭手机连接提示" title="暂时关闭">×</button>' : '';
  return `<div class="hq-top" role="${b.kind === 'phone' ? 'status' : 'alert'}" data-kind="${esc(b.kind)}"><span class="hq-top-t">${esc(b.text)}</span>${btn}${x}</div>`;
}
const SYSTEM_TOP = new Set(['facts', 'model', 'alert', 'phone']);
let dismissedTop = null;
const topKey = b => JSON.stringify([b.kind, b.text, b.detail || '', b.go || '']);
function systemTop() {
  const b = view?.top;
  // 只在这次页面会话忽略同一条非必需手机提示；恢复或内容变化后重新显示。
  if (!b || b.kind !== 'phone' || topKey(b) !== dismissedTop) dismissedTop = null;
  return b && SYSTEM_TOP.has(b.kind) && topKey(b) !== dismissedTop ? b : null;
}
function dismissTop() {
  const b = systemTop();
  if (b?.kind !== 'phone') return false;
  dismissedTop = topKey(b); return true;
}
function askSystem(b) {
  const oc = typeof window !== 'undefined' ? window.OfferCrew : null;
  // 带完整内容（lib/blockers.mjs 的 detail：哪件事、卡在哪一步、为什么、能怎么办、证据），不带横条上截过的字；对话框一条最多 2000 字。
  // 直接发出去，System 当场答（L2：以前只是把横条那句塞进输入框，要你自己再按发送）。
  const text = `这是怎么回事：${b.detail || b.text}`.slice(0, 2000);
  if (oc?.talkSay) { oc.panel?.open?.({ tab: 'talk', member: 'patch' }); oc.talkSay(text); }
  else if (oc?.panel?.open) oc.panel.open({ tab: 'talk', member: 'patch', text });
  else location.hash = '#chat';
}
function pageHtml() {
  // 页头一行：标题（件数、在跑的那一项）在左，搜索和多选在右；标签自己占流水线顶上一整行，不折行。
  return `<div class="hq" id="hq"><div class="page-heading hq-h"><div class="hq-hl" id="hq-heading">${headingHtml()}</div><div class="hq-tools"${rows().length || view?.library?.length || view?.shelved?.length ? '' : ' hidden'}><span class="hq-rel hq-city" id="hq-city">${cityFilterHtml()}</span><span class="hq-rel hq-filter" id="hq-more">${moreFilterHtml()}</span><input class="hq-search" id="hq-q" type="search" placeholder="搜公司 / 岗位 / 编号 / 来源" aria-label="搜公司、岗位、编号或来源" value="${esc(S.q)}">${multiBtn()}</div></div>
    <div id="hq-top">${topHtml()}</div>
    <section class="hq-pipe" aria-label="流水线">
      <div class="hq-pipe-h"><div class="hq-tabs" id="hq-tabs" role="tablist">${tabsHtml()}</div><span id="hq-only">${onlyHtml()}</span></div>
      <div class="hq-tbl${S.multi && anyPick() ? '' : ' is-plain'}" id="hq-tbl"><div id="hq-thead">${headHtml()}</div><div class="hq-rows" id="hq-rows" data-scroll-key="hq-rows">${rowsHtml()}</div></div><div id="hq-pager">${pagerHtml()}</div>
    </section>
  </div>`;
}
// 只重画一块（其余不动，光标和滚动位置都在）。指挥台上：heading / tabs / head / rows；岗位页上：drawer（等你的那封信）/ lhead / pane。
function paint(...parts) {
  if (parts.includes('rows')) parts.push('pager');
  const at = { top: ['#hq-top', topHtml], heading: ['#hq-heading', headingHtml], cities: ['#hq-city', cityFilterHtml], filters: ['#hq-more', moreFilterHtml], tabs: ['#hq-tabs', tabsHtml], only: ['#hq-only', onlyHtml], pager: ['#hq-pager', pagerHtml], head: ['#hq-thead', headHtml], rows: ['#hq-rows', rowsHtml], drawer: ['#ld-ask', askAreaHtml], lhead: ['#ld-head', leadHeadHtml], ltabs: ['#ld-tabs', ldTabsHtml], pane: ['#ld-pane', paneHtml] };
  // 就地更新（web/morph.js）：没变的行、按钮原样留着，滚动位置不动。
  for (const p of new Set(parts)) { const [sel, fn] = at[p] || []; const el = sel && $(sel); if (!el || !view) continue; morph(el, fn()); }
  if (parts.includes('rows')) syncMulti();
  if (parts.includes('tabs')) requestAnimationFrame(() => showTab($('#hq-tabs')));
}

// ── 等你的那封信：选项 + 自己写一句；要确认的（投、发、提交）第二下才生效，和收件箱一样 ─────────
// 按钮上的小号按排在第几个数（1、2、3），不照信里的选项号：补信息信的「不投」是 9，放在这里成了「1 填好提交 · 9 不投」（第 2 轮新 6）。
function optBtn(o, a, i = 0) {
  const on = S.pick?.ask === a.id && S.pick.key === o.key;
  return `<button type="button" class="hq-opt ${o.primary ? 'is-pri' : ''} ${o.danger ? 'is-danger' : ''} ${on ? 'is-sel' : ''}" data-opt="${esc(o.key)}" data-ask="${esc(a.id)}" title="${esc(o.hint)}" ${S.busy.has(a.id) ? 'disabled' : ''}><kbd>${i + 1}</kbd>${esc(optLabel(o))}${o.reasons ? ' ▾' : ''}</button>`;
}
function confirmBox(a) {
  const p = S.pick?.ask === a.id ? S.pick : null;
  if (!p?.confirm) return '';
  const o = a.options.find(x => x.key === p.key) || {}, pv = p.preview || {};
  // 一行说清要做什么：指令本身 + 这个选项的说明（和收件箱同一句）；清单外的、缺编号的另起一行。
  const outside = [...(pv.rows || []).filter(x => x.warn).map(x => `${numText(x.number)} ${x.warn}`), ...(pv.rows || []).filter(x => x.in_proposal === false).map(x => `${numText(x.number)} 不在当前拟投清单里，提交时按规则再核一遍`)];
  const sends = pv.kind === 'send' ? (pv.drafts || []).map(d => `${numText(d.number)} → ${d.to || ''}`) : [];
  const lines = [...outside, ...sends, ...(pv.missing?.length ? [`这些编号现在不能处理：${pv.missing.join('、')}`] : [])];
  const what = pv.kind === 'record' ? pv.text : p.confirm === 'inline' ? (/提交/.test(o.label) ? '按上面这份表提交，提交后撤不回来' : '发出上面这段内容，发出后收不回来') : o.hint || '';
  const plan = (p.fields || []).length ? `<details class="hq-plan"><summary>看拟填内容（${p.fields.length} 项，来自你的个人资料）</summary><table class="hq-mini-table">${p.fields.map(f => `<tr><td>${esc(f.label || f.key)}</td><td>${esc(String(f.value ?? '').slice(0, 120))}</td></tr>`).join('')}</table></details>` : '';
  return `<div class="hq-confirm"><span class="hq-what">${p.text ? `<code>${esc(p.text)}</code>` : ''}${esc(what)}${lines.map(x => `<small>${esc(x)}</small>`).join('')}</span><button type="button" class="hq-btn is-pri" data-go="${esc(a.id)}" ${S.busy.has(a.id) ? 'disabled' : ''}>确认${esc(optLabel(o))}</button><button type="button" class="hq-btn" data-cancel-pick>取消</button>${plan}</div>`;
}
function askBody(a, recovery = null) {
  const r = a.lead?.rid ? rowById(a.lead.rid) : null;
  const p = S.pick?.ask === a.id ? S.pick : null, o = p ? a.options.find(x => x.key === p.key) : null;
  let said = '';
  if (a.kind === 'reply' && r) { const s = r.steps.find(x => x.key === 'reply'); const m = /^(.+?)[：:](.+)$/.exec(s?.note || ''); said = m ? `<p class="hq-said">「${esc(m[2])}」<small>${esc(m[1])}${s.when ? ' · ' + esc(s.when) : ''}</small></p>` : s?.note && s.note !== s.ask_text ? `<p class="hq-said">「${esc(s.note)}」</p>` : ''; }
  const left = `${said}<p class="hq-q">${esc(a.question)}</p>${a.note && (!['triage', 'apply'].includes(a.kind) || (a.judgement_stopped === true && !recovery)) ? `<p class="hq-note">${esc(a.note)}</p>` : ''}${a.account?.how ? `<p class="hq-note">${esc(a.account.how)}</p>` : ''}${(a.affected || []).length ? `<p class="hq-note">挡住了：${a.affected.map(x => esc(x.label)).join('、')}</p>` : ''}`;
  const fields = a.form?.length && a.options.some(x => x.input === 'fields') ? `<div class="hq-fields">${a.form.map(f => `<label${f.type === 'long_text' ? ' class="is-long"' : ''}>${esc(f.label)}${f.remembered ? '<small>（答案簿里有，确认一下）</small>' : ''}${f.type === 'long_text' ? `<textarea data-field="${esc(f.key)}" rows="5" autocomplete="off">${esc(f.value ?? '')}</textarea>` : f.type === 'choice' ? `<select data-field="${esc(f.key)}"><option value="">请选择</option>${(f.options || []).map(x => `<option ${x === f.value ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<input data-field="${esc(f.key)}" type="${{ date: 'date', number: 'number' }[f.type] || 'text'}" placeholder="${f.type === 'month' ? '例如 1995-03' : ''}" value="${esc(f.value ?? '')}" autocomplete="off">`}</label>`).join('')}</div>` : '';
  const opts = a.options.length ? `<div class="hq-opts">${a.options.map((x, i) => recovery && x.key === primaryOpt(a)?.key ? judgeRecoveryHtml({ judge_recovery: recovery }) : optBtn(x, a, i)).join('')}</div>` : '';
  const reasons = o?.reasons ? `<div class="hq-reasons">${[...o.reasons, '不填原因'].map(x => `<button type="button" class="hq-reason" data-reason="${esc(x === '不填原因' ? '' : x)}" data-ask="${esc(a.id)}">${esc(x)}</button>`).join('')}</div>` : '';
  const dt = o?.input === 'datetime' ? `<div class="hq-say"><input type="datetime-local" data-dt="${esc(a.id)}"><button type="button" class="hq-btn is-pri" data-dt-go="${esc(a.id)}">记下</button></div>` : '';
  const say = a.other ? `<div class="hq-say">${a.kind === 'reply' ? `<textarea placeholder="${esc(a.other.placeholder)}" data-say="${esc(a.id)}" maxlength="1000"></textarea>` : `<input placeholder="${esc(a.other.placeholder)}" data-say="${esc(a.id)}" maxlength="1000">`}<button type="button" class="hq-btn ${a.options.length ? '' : 'is-pri'}" data-send="${esc(a.id)}">${a.kind === 'reply' ? `让 ${esc(whoName('quill'))} 起草` : '发送'}</button></div>` : '';
  const draft = a.preview?.kind === 'draft' ? draftPreview(a) : '';
  return `${left}${recovery ? `<p class="hq-note">${esc(recovery.reason)}</p>` : ''}${draft}${fields}${opts}${reasons}${dt}${recovery && o?.key === primaryOpt(a)?.key ? '' : confirmBox(a)}${say}`;
}
const draftPreview = a => { const v = a.preview || {}; return `<div class="hq-draft">${v.subject && v.channel === 'email' ? `<div class="hq-draft-subj">${esc(v.subject)}</div>` : ''}${esc(v.body)}</div>${v.warning ? `<p class="hq-note is-warn">${esc(v.warning)}</p>` : ''}`; };

// ── 成员只做署名：进展里每一步一个小头像，信上一个发信人头像 ───────────────────────
// 名字和脸从两处拼：/api/talk 的名册（web/talk.js 经 crewTalk 交过来）和 /api/hq 的 workers。老编号换成成员。
const ALIAS = { radar: 'scout', reacher: 'quill', watch: 'owl', system: 'patch', nightwatch: 'owl' };
const mid = k => ALIAS[k] || k;
let crew = { members: {} };
const workerOf = id => (view?.workers || []).find(w => w.key === id) || (view?.workers || []).find(w => w.key !== 'executor' && mid(w.key) === id) || null;
function memberInfo(id) {
  const m = crew.members?.[id] || {}, w = workerOf(id) || {};
  return { id, key: id, name: m.name || w.name || (id === 'you' ? '你' : id), face: m.face || w.face || null };
}
const faceHtml = (id, cls = '') => face(memberInfo(id), `hq-emo ${cls}`);
// web/talk.js 每次拉完 /api/talk 交过来名册；面板上没有头像排了，这里只记下名字和脸。签名不变（talk.js 在用）。
export function crewTalk({ members = {} } = {}) { crew = { members }; }

// ── ② 流水线 ─────────────────────────────────────────────────────────────────
// 标签横着滑的时候，选中的那个滑到看得见的地方（只动这一排，不动整页）。
const showTab = el => { const on = el?.querySelector('.hq-tab.is-on'); if (!on) return; const a = el.getBoundingClientRect(), b = on.getBoundingClientRect(); if (b.left < a.left) el.scrollLeft -= a.left - b.left; else if (b.right > a.right - 24) el.scrollLeft += b.right - (a.right - 24); };
const onlyOk = r => !S.only || S.only.has(r.rid);
const onlyHtml = () => (S.only ? `<button type="button" class="secondary mini" data-hq-only aria-label="显示全部">只看这 ${rows().filter(onlyOk).length} 个 ✕</button>` : '');
// 标签上的数是服务端那份（/api/hq tabs，和团队页、对话报的同一份账，lib/tally.mjs）；只看那几条（only）时数那几条。
function tabsHtml() {
  const base = (hasFilters() ? searchRows() : rows()).filter(onlyOk).filter(filterOk).filter(queryOk);
  const n = k => S.only || hasFilters() ? (k === 'all' ? base.length : base.filter(r => tabOf(r) === k).length) : view.tabs?.[k] ?? 0;
  return (view.tab_labels || []).map(([k, l]) => { const c = n(k); return `<button type="button" role="tab" class="hq-tab ${S.tab === k ? 'is-on' : ''} ${c ? '' : 'is-zero'}" data-tab="${k}" aria-selected="${S.tab === k}">${esc(l)}<b>${c}</b></button>`; }).join('');
}
const SHELF_KEY = 'shelf';
const includesShelf = () => !!S.q.trim();
const searchRows = () => [...rows(), ...(view?.library || []), ...(includesShelf() ? view?.shelved || [] : [])];
const rowCities = r => Array.isArray(r.cities) && r.cities.length ? r.cities : [r.city || '城市未写'];
const cityOk = r => !S.cities.length || rowCities(r).some(city => S.cities.includes(city));
const hasFilters = () => S.cities.length || S.filters.length;
const filterOk = r => cityOk(r) && S.filters.every(key => key === 'recommend' ? r.vkey === 'recommend' : r[key] === true);
const queryOk = r => { const q = S.q.trim().toLowerCase(); return !q || [r.company, r.role, numText(r.number), r.city, r.source, r.judgement_reason, r.screening_note, r.why].join(' ').toLowerCase().includes(q); };
function cityFilterHtml() {
  const cities = [...new Set([...searchRows().flatMap(rowCities), ...S.cities])].sort((a, b) => a === '城市未写' ? 1 : b === '城市未写' ? -1 : a.localeCompare(b, 'zh-CN'));
  const label = S.cities.length ? `城市 · ${S.cities.length <= 2 ? S.cities.join('、') : `已选 ${S.cities.length} 个`}` : '城市 · 全部';
  return `<button type="button" class="hq-tab${S.cities.length ? ' is-on' : ''}" data-city-menu aria-label="筛选城市" aria-expanded="${S.pop === 'cities'}" aria-controls="hq-city-options" title="${esc(label)}">${esc(label)} ▾</button>${S.pop === 'cities' ? `<div class="hq-pop hq-city-pop" id="hq-city-options" role="group" aria-label="城市列表"><div class="hq-city-options">${cities.map(city => `<label><input type="checkbox" class="hq-chk" data-hq-city="${esc(city)}" ${S.cities.includes(city) ? 'checked' : ''}><span>${esc(city)}</span></label>`).join('')}</div><button type="button" data-city-clear ${S.cities.length ? '' : 'disabled'}>清除城市筛选</button></div>` : ''}`;
}
function moreFilterHtml() {
  const label = `更多筛选${S.filters.length ? ` · ${S.filters.length}` : ''}`;
  return `<button type="button" class="hq-tab${S.filters.length ? ' is-on' : ''}" data-more-menu aria-label="更多筛选" aria-expanded="${S.pop === 'filters'}" aria-controls="hq-more-options">${label} ▾</button>${S.pop === 'filters' ? `<div class="hq-pop hq-city-pop" id="hq-more-options" role="group" aria-label="更多筛选条件"><div class="hq-city-options">${FILTERS.map(([key, text, hint]) => `<label title="${esc(hint)}"><input type="checkbox" class="hq-chk" data-hq-filter="${key}" ${S.filters.includes(key) ? 'checked' : ''}><span>${text}</span></label>`).join('')}</div><button type="button" data-filters-clear ${S.filters.length ? '' : 'disabled'}>清除更多筛选</button></div>` : ''}`;
}
const allRows = () => S.tab === 'all' && !S.only
  ? searchRows()
  : rows();
function filteredRows() {
  const seen = new Set();
  return allRows().filter(r => {
    if (seen.has(r.rid)) return false;
    seen.add(r.rid);
    return onlyOk(r) && filterOk(r) && queryOk(r) && (S.tab === 'all' || tabOf(r) === S.tab);
  });
}
const visibleRows = () => filteredRows();
// 时间只用真实联系/回复或收录；扫描、判断和后台更新时间不改变跟进顺序。
const rowTime = r => [r.activity_at, r.collected_at].map(Date.parse).find(Number.isFinite) || 0;
const recentKey = r => [rowTime(r) ? 0 : 1, -rowTime(r), -(r.number ?? -1)];
const rowKey = r => S.order.startsWith('progress')
  ? [(STAGE_RANK[tabOf(r)] ?? 9) * (S.order === 'progress-desc' ? -1 : 1), ...recentKey(r)]
  : S.order.startsWith('role') ? [roleTitle(r), ...recentKey(r)]
  : S.order === 'oldest' ? [rowTime(r) ? 0 : 1, rowTime(r), -(r.number ?? -1)] : recentKey(r);
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return typeof a[i] === 'string' ? collator.compare(a[i], b[i]) * (S.order === 'role-desc' ? -1 : 1) : a[i] < b[i] ? -1 : 1; return 0; };
const sortColumn = () => S.order === 'oldest' ? 'recent' : S.order.replace('-desc', '');
function sortHead(key, label, cls, title) {
  const active = sortColumn() === key, descending = !['oldest', 'role', 'progress-desc'].includes(S.order);
  return `<span class="${cls}" role="columnheader" aria-sort="${active ? descending ? 'descending' : 'ascending' : 'none'}"><button type="button" class="hq-col-sort" data-hq-order="${key}" aria-label="按${label}排序" title="${title}">${label}<span aria-hidden="true">${active ? descending ? '↓' : '↑' : '↕'}</span></button></span>`;
}
function rowTimeHtml(r) {
  const at = rowTime(r); if (!at) return '';
  const label = Number.isFinite(Date.parse(r.activity_at)) ? '联系' : '收录', date = new Date(at);
  return `<time class="hq-row-time" datetime="${date.toISOString()}" title="${label}：${esc(date.toLocaleString('zh-CN'))}">${label} ${date.getMonth() + 1}/${date.getDate()}</time>`;
}
// 多选的一批按动作分组：投（筛选里的「投递」+ 拟投）、联系、pass、跟进、不跟；每组用它那封信自己的选项号。
function batchGroups() {
  const sel = [...S.sel].map(rowById).filter(batchable), g = { 投: [], 联系: [], pass: [], 跟进: [], 不跟: [] };
  for (const r of sel) {
    const a = pipeOf(r), v = verbOf(a);
    if (v === '投递' || v === '批准投递') g.投.push(r); else if (v === '联系') g.联系.push(r);
    if (passOpt(a)) g.pass.push(r);
    if (r.pipe_kind === 'followup') { g.跟进.push(r); g.不跟.push(r); }
  }
  return { sel, g };
}
// 多选（负责人 09-30：复选框平时不出现，要批量处理时点「多选」才出现；「完成」收起、清空选择）。
// 这个标签下一行能批量的都没有（草稿、等你登录……）：「多选」是灰的，已经在多选里也不空出勾选那一列（视觉验收第 3 条）。
const anyPick = () => pageView().rows.some(batchable);
function multiWhy() {
  const rs = pageView().rows;
  if (!rs.length) return '当前没有可批量处理的岗位';
  if (rs.every(r => r.pipe_kind === 'draft')) return '草稿需要逐份审阅';
  if (rs.some(r => blockOf(r))) return '这些岗位需要分别补信息或处理阻塞';
  return '这些岗位没有可批量执行的同类动作';
}
const multiBtn = () => {
  const unavailable = !S.multi && !anyPick(), why = unavailable ? multiWhy() : '';
  return `<span class="hq-multi-wrap"><button type="button" class="hq-multi${S.multi ? ' is-on' : ''}" data-multi aria-pressed="${S.multi}"${unavailable ? ' disabled aria-describedby="hq-multi-why"' : ''}>${S.multi ? '完成' : '多选'}</button>${why ? `<small id="hq-multi-why" class="hq-muted">${esc(why)}</small>` : ''}</span>`;
};
function syncMulti() {
  $('#hq-tbl')?.classList.toggle('is-plain', !S.multi || !anyPick());
  const b = $('[data-multi]'); if (b) b.closest('.hq-multi-wrap').outerHTML = multiBtn();
}
function setMulti(on) {
  S.multi = !!on;
  if (!S.multi) { S.sel.clear(); S.batch = null; if (S.pop === 'batch') S.pop = null; }
  paint('head', 'rows');
}
function headHtml() {
  const { sel, g } = batchGroups();
  const here = new Set(pageView().rows.map(r => r.rid));
  const scopeOf = rs => {
    const offPage = rs.filter(r => !here.has(r.rid)).length;
    return offPage ? `<span class="hq-selection-scope">${offPage} 个不在本页</span>` : '';
  };
  const scope = scopeOf(sel);
  if (!sel.length && !allRows().length) return '';
  if (!sel.length) return `<div class="hq-th"><span class="hq-c-chk"></span>${sortHead('role', '岗位 · 公司', 'hq-h-job', '按公司和岗位名称排序')}<span class="hq-c-ch">渠道</span>${sortHead('progress', '进度', 'hq-c-steps', '按当前进度排序')}${sortHead('progress', '进度', 'hq-c-prog', '按当前进度排序')}${sortHead('recent', '时间', 'hq-h-time', '按最近联系时间排序；没有联系记录时按收录时间')}<span class="hq-c-act">操作</span></div>`;
  if (S.batch) {
    const rs = g[S.batch.verb] || [];
    return `<div class="hq-bbar"><input type="checkbox" class="hq-chk" data-clear-sel checked aria-label="取消全部选择"><div class="hq-bb"><b>确认${esc(verbWord(S.batch.verb))}这 ${rs.length} 条？</b>${scopeOf(rs)}<span class="hq-bb-list">${rs.map(r => `${numText(r.number)} ${esc(coName(r.company).name)}`).join('、')}</span><span class="hq-spacer"></span><span class="hq-muted">提交前还会给你终审</span><button type="button" class="hq-btn is-pri" data-batch-go ${S.busy.has('batch') ? 'disabled' : ''}>确认投递 ${rs.length} 条</button><button type="button" class="hq-btn" data-batch-cancel>取消</button></div></div>`;
  }
  const b = (verb, cls = '') => g[verb].length ? `<button type="button" class="hq-btn ${cls}" data-batch="${verb}" ${S.busy.has('batch') ? 'disabled' : ''}>${verbWord(verb)} ${g[verb].length}</button>` : '';
  const pop = S.pop === 'batch' ? passPop('batch') : '';
  return `<div class="hq-bbar"><input type="checkbox" class="hq-chk" data-clear-sel checked aria-label="取消全部选择"><div class="hq-bb"><b>已选 ${sel.length}</b>${scope}${b('投', 'is-pri')}${b('联系', 'is-pri')}${g.pass.length ? `<span class="hq-rel"><button type="button" class="hq-btn" data-batch-pass>不投 ${g.pass.length} ▾</button>${pop}</span>` : ''}${b('跟进', 'is-pri')}${b('不跟')}<span class="hq-spacer"></span><span class="hq-muted">${g.投.length ? '投的会先在浏览器里预填，由你在页面上提交' : g.联系.length ? '首联写好后先给你看' : ''}</span><button type="button" class="hq-lnk" data-clear-sel>取消选择</button></div></div>`;
}
const passPop = id => `<div class="hq-pop" role="menu">${[...PASS, '不填原因'].map(x => `<button type="button" data-pass="${esc(id)}" data-why="${esc(x === '不填原因' ? '' : x)}">${esc(x)}</button>`).join('')}</div>`;
// 刚在这一行上答完（S.done）：先显示回执；服务端随后在这一行上挂了新的等你（投了之后要登录、要终审），就换成那一件。
const doneOf = r => S.done.has(r.rid) && !blockOf(r) ? S.done.get(r.rid) : null;
const rowConfirmOf = r => S.confirm?.rid === r.rid && !S.confirm.draft && !doneOf(r) && !blockOf(r) && pipeOf(r) ? S.confirm : null;
// 等你登录某个账号：「等你登录 字节跳动招聘」，按钮直接去收件箱里那封登录信（上面有「打开登录页」「我登好了」）。
const loginOf = r => { const b = blockOf(r); return b?.kind === 'login' ? b : null; };
// 按公司分开的账号（「Workday · Globex」）：公司名已经是这一组的标题，只说平台。
const loginName = a => (a.account?.label || String(a.title || '').replace(/^登录\s*/, '') || '账号').split(' · ')[0];
function nowCell(r) {
  const d = doneOf(r);
  if (d) return `<span class="hq-t is-ok" title="${esc(d)}">✓ ${esc(d)}</span>`;
  if (rowConfirmOf(r)) return '<span class="hq-t is-you">待你确认</span>';
  const b = blockOf(r), lg = loginOf(r);
  if (lg) return `<span class="hq-t is-you" title="${esc(lg.line || lg.question)}">等你登录 ${esc(loginName(lg))}</span>`;
  if (b) return `<span class="hq-t is-you" title="${esc(b.line || b.question)}">${esc(b.row || r.now || b.tag)}</span>`;
  const p = pipeOf(r);
  // 新线索、拟投：只放判断的标签（推荐 / 待核）；推荐理由在岗位页的「JD 与判断」里（09-30 负责人：第一屏不放灰字）。
  // 待核的再写一个短词说还差什么（「工作许可没填」，lib/first-round.mjs verifyGap）。
  if (p?.kind === 'triage' && r.verdict === 'verify' && r.gap) return `${verdictTag(r)}<span class="hq-t hq-gap" title="${esc(r.gap.title || p.detail || p.note || r.gap.text)}">${esc(r.gap.text)}</span>`;
  // 推荐里还要你确认的那一项、年限差一点（第 3 轮负责人 10-02，判断规则 1、2）：同一格写短词，悬停是整句。
  if (p && ['triage', 'apply'].includes(p.kind) && r.verdict === 'recommend' && r.note) return `${verdictTag(r)}${scoreTag(r)}<span class="hq-t hq-gap" title="${esc(r.note.title)}">${esc(r.note.text)}</span>`;
  if (p && ['triage', 'apply'].includes(p.kind)) return (verdictTag(r) + scoreTag(r)) || `<span class="hq-t is-you">${p.kind === 'apply' ? '待批准' : '待筛选'}</span>`;
  if (p?.kind === 'draft') return `<span class="hq-t is-you" title="${esc(String(p.question).replace(/，?看完就可以发。?$/, ''))}">草稿待发</span>`;
  if (p?.kind === 'followup') { const n = /(\d+) 天没回复/.exec(r.text || '')?.[1]; return `<span class="hq-t is-you" title="${esc(r.text)}">${n ? `${n} 天未回复` : '待跟进'}</span>`; }
  const tone = r.ending === 'offer' ? 'is-ok' : r.tone === 'bad' ? 'is-bad' : r.tone === 'mute' || r.ending ? 'is-mute' : r.current_status === 'waiting_you' ? 'is-you' : '';
  return `<span class="hq-t ${tone}" title="${esc(r.text)}">${esc(r.now || r.text)}</span>`;
}
function recoveryActionsHtml(r, { detail = false } = {}) {
  if (!r?.row_actions?.length) return '';
  const buttons = r.row_actions.map(a => a.key === 'end'
    ? `<span class="hq-rel"><button type="button" class="hq-act" data-passmenu-d="${esc(r.rid)}">不投 ▾</button>${S.pop === 'd:' + r.rid ? passPop('d:' + r.rid) : ''}</span>`
    : a.href ? `<a class="hq-act is-pri" href="${esc(a.href)}"${a.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(a.label)}${a.external ? ' ↗' : ''}</a>`
    : `<button type="button" class="hq-act${a.key === 'followup' || a.key === 'contact' ? ' is-pri' : ''}" data-progress-act="${esc(r.rid)}" data-key="${esc(a.key)}"${a.disabled || S.busy.has(r.rid) ? ' disabled' : ''}${a.reason ? ` title="${esc(a.reason)}"` : ''}>${esc(a.label)}</button>`).join('');
  return `${buttons}${!detail && r.followup_note ? `<small class="hq-action-note">${esc(r.followup_note)}</small>` : ''}`;
}
const judgeRecoveryHtml = r => r?.judge_recovery ? `<a class="hq-act is-pri" href="${esc(r.judge_recovery.href)}" title="${esc(r.judge_recovery.reason)}">${['running', 'queued', 'retrying'].includes(r.judge_recovery.status) ? '查看状态' : '查看问题'}</a>` : '';
function actCell(r) {
  if (doneOf(r)) return '';
  const dis = S.busy.has(r.rid) ? 'disabled' : '';
  const b = blockOf(r), lg = loginOf(r);
  if (lg) return `<a class="hq-act is-pri" href="#inbox?ask=${encodeURIComponent(lg.id)}">登录</a>`;
  // 卡在你这儿（线索级的「需要你」）：去补 / 去终审 / 去回……打开这一行的抽屉，回答表单就在抽屉最上面。
  if (b) return `<button type="button" class="hq-act is-pri" data-go-row="${esc(r.rid)}" data-kind="${esc(b.kind)}" title="${esc(b.tag)}">${esc(b.go || '处理')}</button>`;
  const a = pipeOf(r);
  if (!a) return `${r.row_actions?.some(x => x.key !== 'end') ? '' : judgeRecoveryHtml(r)}${recoveryActionsHtml(r)}`;
  if (judgeRetryBlocked(r, a)) {
    const fill = optBy(a, '补信息');
    return `${judgeRecoveryHtml(r)}${fill ? `<button type="button" class="hq-act" data-row-act="${esc(r.rid)}" data-key="${esc(fill.key)}" ${dis}>补信息</button>` : ''}<button type="button" class="hq-act" data-passmenu="${esc(r.rid)}" ${dis}>不投 ▾</button>${S.pop === r.rid ? passPop(r.rid) : ''}`;
  }
  if (rowConfirmOf(r)) return '';
  if (S.confirm?.rid === r.rid) return `<button type="button" class="hq-act is-pri" data-row-go="${esc(r.rid)}" ${dis}>确认${a.kind === 'apply' || verbOf(a) === '投递' ? '投递' : ''}</button><button type="button" class="hq-act is-quiet" data-unconfirm>取消</button>`;
  const pop = S.pop === r.rid ? passPop(r.rid) : '';
  // 补信息是另一个选择，不能遮掉主人已判待核时的投递/联系入口。
  if (a.kind === 'triage') {
    const fill = optBy(a, '补信息');
    return `<button type="button" class="hq-act is-pri" data-row-act="${esc(r.rid)}" data-key="${esc(primaryOpt(a)?.key || '1')}" ${dis}>${esc(verbOf(a))}</button>${fill ? `<button type="button" class="hq-act" data-row-act="${esc(r.rid)}" data-key="${esc(fill.key)}" ${dis}>补信息</button>` : ''}<button type="button" class="hq-act" data-passmenu="${esc(r.rid)}" ${dis}>不投 ▾</button>${pop}`;
  }
  if (a.kind === 'apply') return `<button type="button" class="hq-act is-pri" data-row-act="${esc(r.rid)}" data-key="${esc(primaryOpt(a)?.key || '1')}" ${dis}>${esc(verbOf(a))}</button><button type="button" class="hq-act" data-passmenu="${esc(r.rid)}" ${dis}>不投 ▾</button>${pop}`;
  if (a.kind === 'draft') return `<button type="button" class="hq-act ${S.expand === r.rid ? 'is-dark' : 'is-pri'}" data-expand="${esc(r.rid)}" aria-expanded="${S.expand === r.rid}">${S.expand === r.rid ? '收起草稿' : '看草稿'}</button>`;
  if (a.kind === 'followup') return `<button type="button" class="hq-act is-pri" data-row-act="${esc(r.rid)}" data-key="${esc(primaryOpt(a)?.key || '1')}" ${dis}>跟进</button><button type="button" class="hq-act" data-row-act="${esc(r.rid)}" data-key="${esc(optBy(a, '不跟了')?.key || '2')}" ${dis}>不跟</button>`;
  return '';
}
function draftBox(r) {
  const a = pipeOf(r), v = a.preview || {}, dis = S.busy.has(r.rid) ? 'disabled' : '';
  const to = v.channel === 'email' ? `发给 ${v.to}` : v.platform ? `在 ${v.platform} 上发给岗位发布人` : v.to ? `发到 ${v.to}` : '';
  const send = optBy(a, '发送'), edit = optBy(a, '我来改'), drop = optBy(a, '不发了');
  const confirming = S.confirm?.rid === r.rid && S.confirm.draft;
  const acts = confirming
    ? `<span class="hq-bold">确认发出上面这段内容？发出后收不回来。</span><button type="button" class="hq-btn is-pri" data-row-go="${esc(r.rid)}" ${dis}>确认发送</button><button type="button" class="hq-btn" data-unconfirm>再想想</button>`
    : `${send ? `<button type="button" class="hq-btn is-pri" data-draft-send="${esc(r.rid)}" ${dis}>发送</button>` : ''}${edit ? `<button type="button" class="hq-btn" data-row-act="${esc(r.rid)}" data-key="${esc(edit.key)}" ${dis}>我来改</button>` : ''}${drop ? `<button type="button" class="hq-btn is-danger" data-row-act="${esc(r.rid)}" data-key="${esc(drop.key)}" ${dis}>不发了</button>` : ''}${a.other ? `<span class="hq-say"><input placeholder="${esc(a.other.placeholder || '说怎么改')}" data-say-row="${esc(r.rid)}" maxlength="1000"><button type="button" class="hq-btn" data-rewrite="${esc(r.rid)}" ${dis}>让它改</button></span>` : ''}`;
  return `<div class="hq-draft-meta"><b>${esc(String(a.question).replace(/，?看完就可以发。?$/, ''))}</b><span>${esc(to)}</span></div>
    <div class="hq-draft">${v.subject && v.channel === 'email' ? `<div class="hq-draft-subj">${esc(v.subject)}</div>` : ''}${esc(v.body)}</div>${v.warning ? `<p class="hq-note is-warn">${esc(v.warning)}</p>` : ''}
    <div class="hq-xact">${acts}</div>`;
}
// 不在推进的线索（「全部」里，旧「岗位看板」那些）：一行只有岗位、城市、Judge 的结论；点开是它的岗位页。
// 第二行：城市；公司待核的再写发帖人（这一组的名字是「公司待核」）。
const subOf = r => { const p = coPoster(r.company); return [r.city || '', r.source || '', p && (/^猎头/.test(p) ? p : `发帖人 ${p}`)].filter(Boolean).join(' · '); };
const shelfText = r => (r.shelf === 'not_job' ? '不是岗位' : '已收起') + (r.why && r.why !== '不对口' ? ` · ${r.why}` : '');
const shelfCell = r => `<span class="hq-sub" title="${esc(r.why || '')}">${esc(shelfText(r))}</span>`;
function rowConfirmHtml(r) {
  const c = rowConfirmOf(r); if (!c) return '';
  const a = pipeOf(r), label = `确认${a.kind === 'apply' || verbOf(a) === '投递' ? '投递' : ''}`;
  return `<div class="hq-xrow"><div class="hq-xin"><div class="hq-confirm hq-row-confirm" role="group" aria-label="${esc(numText(r.number))} ${label}"><p class="hq-row-confirm-text">${esc(c.text || '确认继续处理这条岗位？')}</p><div class="hq-row-confirm-actions"><button type="button" class="hq-btn is-pri" data-row-go="${esc(r.rid)}" ${S.busy.has(r.rid) ? 'disabled' : ''}>${label}</button><button type="button" class="hq-btn" data-unconfirm>取消</button></div></div></div></div>`;
}
const judgementNote = r => {
  const label = r.shelf === 'not_job' ? '不是岗位' : listVerdictWord(r.vkey || r.verdict || 'none');
  const text = r.screening_note || [label, r.judgement_reason || r.why].filter(Boolean).join(' · ');
  return `<span class="hq-list-reason" title="${esc(text)}">${esc(text)}</span>`;
};
const libRowHtml = r => `<div class="hq-row is-lib${S.lastRid === r.rid ? ' is-open' : ''}${S.flash?.rid === r.rid && Date.now() < S.flash.until ? ' is-flash' : ''}" data-row="${esc(r.rid)}"><span class="hq-c-chk"></span><span class="hq-c-job"><span class="hq-role" title="${esc(r.role)}">${r.number != null ? `<b class="hq-no">#${esc(r.number)}</b>` : ''}${esc(roleTitle(r))}</span><span class="hq-sub">${esc(subOf(r))}</span>${judgementNote(r)}</span><span class="hq-c-ch"></span><span class="hq-c-steps"></span><span class="hq-c-prog"></span><span class="hq-c-now">${r.tab === SHELF_KEY ? shelfCell(r) : vdTag(r.vkey) + scoreTag(r)}${r.queued ? `<span class="hq-sub" title="${esc(r.queued)}">推荐排队中</span>` : ''}${rowTimeHtml(r)}</span><span class="hq-c-act">${r.tab !== SHELF_KEY ? judgeRecoveryHtml(r) : ''}</span></div>`;
function rowHtml(r) {
  if (r.tab === 'library' || r.tab === SHELF_KEY) return libRowHtml(r);
  const cls = [S.sel.has(r.rid) && 'is-sel', S.lastRid === r.rid && 'is-open', r.ending && r.ending !== 'offer' && 'is-gone', doneOf(r) && 'is-done', S.flash?.rid === r.rid && Date.now() < S.flash.until && 'is-flash'].filter(Boolean).join(' ');
  // 编号放在岗位名前面（对话里说「投 12」「#12」都认它）；第二行是城市和渠道。
  const sub = subOf(r), gapNote = r.verdict === 'verify' && r.gap ? `<span class="hq-gap-note">待核 · ${esc(r.gap.text)}</span>` : '';
  // 表格窄的时候（容器查询）：渠道并进第二行，八个点换成一条进度加当前这一步。
  const reached = r.cols.filter(c => c.status !== 'not_reached').length, cur = r.cols.findIndex(c => !['done', 'skipped'].includes(c.status));
  const step = cur < 0 ? r.cols.length - 1 : cur, st = r.cols[step]?.status;
  const prog = `<span class="hq-c-prog" title="${esc(COLS[step])}${r.cols[step]?.note ? '：' + esc(r.cols[step].note) : ''}"><span class="hq-pb is-${DOT[st] || 'none'}"><i style="width:${Math.round(reached / (r.cols.length || 8) * 100)}%"></i></span><span class="hq-pl">${cur < 0 ? '走完了' : esc(COLS[step])}</span></span>`;
  // 勾选框包在 label 里：手机上点它周围 44 px 也算（web/style.css 末尾）；行的点击本来就不理 label。
  const chk = batchable(r) ? `<input type="checkbox" class="hq-chk" data-check="${esc(r.rid)}" ${S.sel.has(r.rid) ? 'checked' : ''} aria-label="选中 ${esc(numText(r.number))}">` : '';
  const steps = r.cols.map((c, i) => `<span class="hq-st is-${DOT[c.status] || 'none'}" title="${COLS[i]}${c.note ? '：' + esc(c.note) : ''}"><i></i></span>`).join('');
  return `<div class="hq-row ${cls}" data-row="${esc(r.rid)}">${chk ? `<label class="hq-c-chk">${chk}</label>` : '<span class="hq-c-chk"></span>'}<span class="hq-c-job"><span class="hq-role" title="${esc(r.role)}">${r.number != null ? `<b class="hq-no">#${esc(r.number)}</b>` : ''}${esc(roleTitle(r))}</span><span class="hq-sub">${esc(sub)}${r.channel_short ? `<span class="hq-sub-ch">${sub ? ' · ' : ''}${esc(r.channel_short)}</span>` : ''}</span>${gapNote || judgementNote(r)}</span><span class="hq-c-ch">${esc(r.channel_short || '')}</span><span class="hq-c-steps">${steps}</span>${prog}<span class="hq-c-now">${nowCell(r)}${rowTimeHtml(r)}</span><span class="hq-c-act">${actCell(r)}</span></div>`
    + rowConfirmHtml(r)
    + (S.expand === r.rid && pipeOf(r)?.kind === 'draft' && !S.done.has(r.rid) ? `<div class="hq-xrow"><div class="hq-xin">${draftBox(r)}</div></div>` : '');
}
// 公司不明的（「待核（发帖人昵称）」）合成一组「公司待核」：发帖人的昵称、手机号不当公司名显示（R4 实测 devposter、139****0000）。
const TBD_GROUP = '__company_unverified__', groupOf = r => coTbd(r.company) ? TBD_GROUP : r.company;
// 公司分组保持完整；按时间/进度时用组内第一行给公司排序，名称排序时按公司再岗位。
function groupedRows() {
  const groups = new Map();
  for (const r of visibleRows()) { const k = groupOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.entries()].map(([c, rs]) => { rs.sort((a, b) => cmp(rowKey(a), rowKey(b))); return [c, rs, S.order.startsWith('role') ? [coName(c).name] : rowKey(rs[0])]; })
    .sort((a, b) => cmp(a[2], b[2]) || b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'));
}
// 「正在找第一批岗位 · 找到 540 个，先判最对口的 15 个 · Judge 判了 6/15 · 已 4 分钟」。
const firstLine = (run, top = false) => `<div class="hq-empty hq-first${top ? ' is-top' : ''}"><span class="co-spin" aria-hidden="true"></span>${esc(['正在找第一批岗位', ...runProg(run), run.started_at ? sinceText(run.started_at) : ''].filter(Boolean).join(' · '))}</div>`;
const HQ_PAGE_SIZE = 50;
// Filter and sort the complete data before selecting the page.
function paginateGroups(groups, page = 1, size = HQ_PAGE_SIZE) {
  const total = groups.reduce((n, [, rs]) => n + rs.length, 0), pages = Math.max(1, Math.ceil(total / size));
  page = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const start = (page - 1) * size, end = Math.min(total, start + size), shown = [];
  let offset = 0;
  for (const [key, rs] of groups) {
    const from = Math.max(0, start - offset), to = Math.min(rs.length, end - offset);
    if (to > from) shown.push({ key, rows: rs.slice(from, to), all: rs, from: from + 1, to, total: rs.length });
    offset += rs.length;
  }
  return { total, pages, page, start: total ? start + 1 : 0, end, groups: shown, rows: shown.flatMap(g => g.rows) };
}
function pageView() {
  const result = paginateGroups(groupedRows(), S.page);
  if (S.page !== result.page) { S.page = result.page; save(); }
  return result;
}
function pagerHtml() {
  const p = pageView();
  if (!p.total) return '';
  const numbers = [...new Set([1, p.page - 1, p.page, p.page + 1, p.pages])].filter(n => n >= 1 && n <= p.pages).sort((a, b) => a - b);
  const links = numbers.map((n, i) => `${i && n > numbers[i - 1] + 1 ? '<span aria-hidden="true">…</span>' : ''}<button type="button" data-hq-page="${n}"${n === p.page ? ' aria-current="page"' : ''} aria-label="第 ${n} 页">${n}</button>`).join('');
  return `<nav class="hq-pagination" aria-label="岗位分页"><span class="hq-page-range">第 ${p.start}–${p.end} 个 / ${p.total} 个${S.tab === 'all' && includesShelf() ? ' · 含收起的岗位' : ''}</span><div><button type="button" data-hq-page="${p.page - 1}"${p.page === 1 ? ' disabled' : ''}>上一页</button>${links}<button type="button" data-hq-page="${p.page + 1}"${p.page === p.pages ? ' disabled' : ''}>下一页</button></div></nav>`;
}
function groupSummary(rs) {
  const counts = new Map();
  for (const r of rs) { const k = r.shelf === 'not_job' ? 'not_job' : r.vkey || r.verdict || 'none'; counts.set(k, (counts.get(k) || 0) + 1); }
  const parts = [...VERDICT_KEYS, 'not_job'].filter(k => counts.has(k)).map(k => `${k === 'not_job' ? '不是岗位' : listVerdictWord(k)} ${counts.get(k)}`);
  const shelved = rs.filter(r => r.tab === SHELF_KEY).length;
  if (shelved) parts.push(`其中已收起 ${shelved}`);
  return parts.join(' · ');
}
function rowsHtml() {
  const p = pageView(), first = p.total && view.running?.op === 'round-first' ? firstLine(view.running, true) : '';
  if (!p.total) {
    if (!rows().length && view.running?.finding) return firstLine(view.running);
    return `<div class="hq-empty">${S.q || hasFilters() ? '没有符合当前筛选的岗位' : rows().length ? '这里现在是空的' : `还没有岗位${findHtml()}`}</div>`;
  }
  return first + p.groups.map(({ key: c, rows: rs, all: full }) => {
    const co = c === TBD_GROUP ? { name: '公司待核', tbd: false } : coName(c), batch = rs.filter(batchable), all = batch.length && batch.every(r => S.sel.has(r.rid));
    return `<div class="hq-grp"><span class="hq-c-chk">${batch.length ? `<input type="checkbox" class="hq-chk" data-group="${esc(c)}" ${all ? 'checked' : ''} aria-label="选中 ${esc(co.name)} 本页的 ${batch.length} 条">` : ''}</span><span class="hq-g-n"><span class="hq-group-title">${esc(co.name)}${co.tbd ? '<span class="hq-tbd">公司待核</span>' : ''}</span><small class="hq-group-summary">${esc(groupSummary(full))}</small></span></div>` + rs.map(rowHtml).join('');
  }).join('');
}
function resetPage() { S.page = 1; S.batch = null; S.confirm = null; S.pop = null; S.expand = null; }
function repaintList() { save(); paint('heading', 'cities', 'filters', 'tabs', 'head', 'rows'); if ($('#hq-rows')) $('#hq-rows').scrollTop = 0; }

// ── ③ 岗位页 #lead/<rid>：原来的「完整详情」和右侧抽屉合成一页 ─────────────────────────
// 来处（S.from）：{ hash, label, list, rid, scroll }。从指挥台的哪个标签、或收件箱进来，「←」就回哪里，‹ › 按那张表的顺序翻。
// 记在这个标签页的 sessionStorage 里：刷新岗位页也还知道从哪来。
export function pagerOf(list = [], rid) {
  const i = list.indexOf(rid), n = list.length;
  return { i, n, prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < n - 1 ? list[i + 1] : null };
}
// 下一件等你的：来处列表里这一条后面第一件还等你的，到底了从头找（不算这一条自己）。
export function nextWaiting(list = [], rid, waiting = () => false) {
  const i = list.indexOf(rid), order = i < 0 ? list : [...list.slice(i + 1), ...list.slice(0, i)];
  return order.find(x => x !== rid && waiting(x)) || null;
}
export function setLeadOrigin(from) {
  S.from = from ? { hash: from.hash || '#command', label: from.label || '指挥台', list: [...new Set((from.list || []).filter(id => typeof id === 'string'))], rid: from.rid || null, scroll: from.scroll ?? null } : null;
  try { sessionStorage.setItem('oc.leadFrom', JSON.stringify(S.from)); } catch {}
}
const fromOf = () => S.from || { hash: '#command', label: '指挥台', list: [] };
// 来处里有没有这一条（从别处——岗位看板、团队页、运行日志——点进来的没有，web/app.js 就把上一页记成来处）。
export const leadOriginHas = rid => !!S.from && (S.from.rid === rid || (S.from.list || []).includes(rid));
// 岗位页开在哪一页的名下（左栏亮哪一项）：从收件箱来的亮收件箱，其余亮指挥台。
export const leadFromPage = () => /^#inbox/.test(fromOf().hash) ? 'inbox' : 'command';
const isWaiting = rid => { const r = rowById(rid); return !!r && !S.done.has(rid) && !!(blockOf(r) || pipeOf(r)); };

// 主区正在看的岗位（对话输入框上「正在看 #12」）：岗位页开着，或收件箱里选中了挂在岗位上的信；变了发 oc:viewing。
let viewing = null;
export function setViewing(v) {
  // stage：岗位页上这一条走到哪一步（lib/workflow.mjs STEPS 的 key，关了的是 ended）；对话输入框上面先选好这一步的成员（F6）。
  const next = v?.rid ? { rid: v.rid, number: v.number ?? null, company: coName(v.company).name, role: v.role ? roleTitle(v) : '', ...(v.stage ? { stage: v.stage } : {}) } : null;
  if (JSON.stringify(next) === JSON.stringify(viewing)) return;
  viewing = next;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('oc:viewing', { detail: next }));
  // talk.js 在 feat/talk-team 之前只在 oc:crew 上重画「正在看」：一起发一下，合并后多余但无害。
  window.dispatchEvent(new CustomEvent('oc:crew'));
}
export const focusLead = () => viewing;

let lead = null; // { rid, d: /api/lead 的结果或 null, res: /api/resume（材料标签才拉），plan: 拟填内容 }
export const leadSig = () => lead ? `${sig}|${lead.dsig}` : null;
const LEAD_VIEW_MS = 15000;
let leadCheck = null;
function revalidateLead(rid) {
  if (leadCheck) return;
  leadCheck = (async () => {
    try { const r = await fetch('/api/hq'), v = await r.json(); if (!r.ok) return; const changed = v.content_sig !== sig; takeView(v); if (changed && location.hash === '#lead/' + encodeURIComponent(rid)) h?.refresh?.({ soft: true }); }
    catch {} finally { leadCheck = null; }
  })();
}
export async function leadPage(helpers, rid, { tab = null } = {}) {
  h = helpers;
  if (LD_TABS.some(([key]) => key === tab)) S.ldTab = tab;
  // 刚拉过的 /api/hq（从指挥台点进来、j / k 翻页）先用着，只等 /api/lead；后台再拉一次，变了再画（revalidateLead）。
  const fresh = view && Date.now() - viewAt < LEAD_VIEW_MS;
  const [d, v] = await Promise.all([
    fetch('/api/lead?id=' + encodeURIComponent(rid)).then(r => r.ok ? r.json() : null).catch(() => null),
    fresh ? null : fetch('/api/hq').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (v) takeView(v);
  if (fresh && Date.now() - viewAt > 1500) revalidateLead(rid);
  const keep = lead?.rid === rid ? lead : null;
  lead = { rid, d, dsig: d ? JSON.stringify([d.lead?.stage, d.lead?.state, d.lead?.match, d.judgement_display, d.drafts?.length, d.events?.length, d.company?.state, d.outbound?.length]) : '', res: keep?.res, plan: keep?.plan, trace: keep?.trace || new Map() };
  if (keep?.rid !== rid) { S.jdOpen = false; S.pick = null; S.trace = null; S.logOpen = false; }
  const r = rowById(rid), l = d?.lead;
  if (!r && !l) { setViewing(null); return '<div class="empty">记录不存在。</div>'; }
  S.lastRid = rid;
  setViewing({ rid, number: r?.number ?? l?.number, company: r?.company || l?.company, role: r?.role || l?.role, stage: r ? (r.ending && r.ending !== 'offer' ? 'ended' : r.current) : null });
  return `<div class="ld2" id="ld2"><div id="ld-head">${leadHeadHtml()}</div><div id="ld-ask">${askAreaHtml()}</div><div class="ld-tabs" id="ld-tabs" role="tablist">${ldTabsHtml()}</div><div class="ld-pane" id="ld-pane" role="tabpanel">${paneHtml()}</div></div>`;
}
// 换到一条的岗位页时先画（web/app.js 换页立刻换）：页头、等你的那封信用指挥台那份行数据，下面的标签页等 /api/lead 回来。
// 这条刚看过就用上次那份。指挥台的行里没有它、也没看过：返回 null。
export function leadNow(rid) {
  // 显式标签等 leadPage 读取后再画；瞬时旧页的 bindLead 会先移除 tab，导致最终结果被导航守卫丢弃。
  if (typeof location !== 'undefined' && new URLSearchParams(location.hash.split('?')[1] || '').has('tab')) return null;
  if (!h || !view) return null;
  const keep = lead?.rid === rid ? lead : null;
  if (!keep && !rowById(rid)) return null;
  if (!keep) { lead = { rid, d: null, dsig: '', loading: true, trace: new Map() }; S.jdOpen = false; S.pick = null; S.trace = null; S.logOpen = false; }
  return `<div class="ld2" id="ld2"><div id="ld-head">${leadHeadHtml()}</div><div id="ld-ask">${askAreaHtml()}</div><div class="ld-tabs" id="ld-tabs" role="tablist">${ldTabsHtml()}</div><div class="ld-pane" id="ld-pane" role="tabpanel">${paneHtml()}</div></div>`;
}
const leadOf = () => { const r = lead && rowById(lead.rid), l = lead?.d?.lead || {}; return { r, l, rid: lead?.rid, number: r?.number ?? l.number ?? null, company: r?.company || l.company || '', role: r?.role || l.role || '岗位待核', city: r?.city || l.location || '', url: l.url || l.application_url || '' }; };
const endOf = l => ['archived', 'passed', 'pass_pending', 'rejected'].includes(l.state) ? l.state : l.posting_closed || l.auto_apply?.status === 'closed' || l.prefilter_reason === 'posting_closed' ? 'closed' : /归档/.test(l.stage || '') ? 'archived' : /拒绝/.test(l.stage || '') ? 'rejected' : l.feedback === 'pass' || /已排除/.test(l.stage || '') ? 'passed' : null;
// 岗位页是看全名的地方：标题用岗位详情里的全名（指挥台的行数据把长名字截过，第 2 轮新 1），整名折行，不截。
function leadHeadHtml() {
  if (!lead) return '';
  const L = leadOf(), f = fromOf(), p = pagerOf(f.list || [], L.rid), co = coName(L.company);
  const salary = L.l.salary || L.l.salary_text || lead.d?.evaluation?.comp || '';
  // 待核标签的行：判断那个标签已经写了「待核」，不再写一遍。
  const lib = libById(L.rid);
  const stage = L.r ? (tabOf(L.r) === 'verify' ? '' : (view.tab_labels || []).find(([k]) => k === tabOf(L.r))?.[1]) : lib?.tab === SHELF_KEY ? shelfText(lib) : lib?.screening_note ? '已收录' : L.l.stage;
  const poster = L.l.author || coPoster(L.company);
  const meta = [co.tbd ? `<b>公司待核</b>${poster ? `<span class="hq-tbd">${esc(/^猎头/.test(poster) ? poster : `发帖人 ${poster}`)}</span>` : ''}` : `<b>${esc(co.name)}</b>`, L.city && esc(L.city), salary && esc(salary), L.url && h.link(L.url, '原帖')].filter(Boolean).join('<i>·</i>');
  const pager = p.i >= 0 && p.n > 1 ? `<span class="ld-pg"><button type="button" class="ld-pgb" data-ld-nav="${esc(p.prev || '')}" ${p.prev ? '' : 'disabled'} aria-label="上一条" title="上一条（k）">‹</button><span class="ld-pgn">${p.i + 1}/${p.n}</span><button type="button" class="ld-pgb" data-ld-nav="${esc(p.next || '')}" ${p.next ? '' : 'disabled'} aria-label="下一条" title="下一条（j）">›</button></span>` : '';
  return `<div class="page-heading ld-h"><div class="ld-hl"><a class="ld-back" href="${esc(f.hash)}" data-ld-back>← ${esc(f.label)}</a><h1>${L.number != null ? `<span class="ld-no">#${esc(L.number)}</span>` : ''}${esc(L.r ? roleTitle({ ...L.r, role: L.l.role || L.r.role }) : L.role)}</h1><div class="ld-meta">${meta}${L.r ? verdictTag(L.r) : ''}${stage ? `<span class="ld-stage">${esc(stage)}</span>` : ''}</div></div>${pager}</div>`;
}
// 等你的那封信（整封，就地答）；答完一封给「下一件 →」；没有等你的事放这条能做的一两个动作。
function askAreaHtml() {
  if (!lead) return '';
  const L = leadOf(), r = L.r, f = fromOf();
  if (r && S.done.has(r.rid)) {
    const nx = nextWaiting(f.list || [], r.rid, isWaiting);
    return `<section class="ld-ask is-done"><p class="hq-q is-ok">✓ ${esc(S.done.get(r.rid))}</p>${nx ? `<button type="button" class="hq-btn is-pri" data-ld-nav="${esc(nx)}">下一件 →</button>` : `<span class="hq-muted">${esc(f.label)}里没有别的等你的事</span>`}</section>`;
  }
  const recovery = !r?.ending && !endOf(L.l) && (r?.judge_recovery || libById(L.rid)?.judge_recovery);
  const a = r && (blockOf(r) || pipeOf(r));
  if (a) {
    const who = a.member ? `<span class="ld-from" title="${esc(memberInfo(mid(a.member)).name)}">${faceHtml(mid(a.member), 'is-mini')}</span>` : '';
    const fs = (a.facts || []).filter(x => !['判断', 'JD'].includes(x.k));
    return `<section class="ld-ask" aria-label="等你"><div class="ld-ask-k">${who}<span class="ld-tag">${esc(a.tag || '等你')}</span>${a.url && a.url !== L.url ? h.link(a.url, '入口') : ''}</div><div class="hq-need">${askBody(a, judgeRetryBlocked(r, a) ? recovery : null)}</div>${fs.length ? `<dl class="hq-facts">${fs.map(x => `<dt>${esc(x.k)}</dt><dd>${esc(x.v)}</dd>`).join('')}</dl>` : ''}</section>`;
  }
  const lib = r || libById(L.rid), ending = r?.ending || endOf(L.l), n = L.number;
  const end = !!ending || L.l.state === 'offer' || lib?.tab === SHELF_KEY;
  // 没判完的（没有结论，或者算不出匹配度）只给「先判断」：投不投等判完再说（lib/recommend-gate.mjs judgedFully）。收起来的不判。
  const judge = !end && lib && lib.judged === false && !r?.row_actions?.some(a => a.key !== 'end');
  const correction = view.asks?.[`owner-submit:${L.rid}`];
  const acts = [
    correction ? `<button type="button" class="hq-btn" data-opt="1" data-ask="${esc(correction.id)}">撤回误记的提交</button>${confirmBox(correction)}` : '',
    r ? recoveryActionsHtml(r, { detail: true }) : '',
    judge && recovery ? judgeRecoveryHtml({ judge_recovery: recovery }) : judge ? `<button type="button" class="hq-btn is-pri" data-judge-one="${esc(L.rid)}" ${S.busy.has('judge:' + L.rid) ? 'disabled' : ''}>先判断</button>` : '',
    ['archived', 'passed', 'pass_pending', 'rejected'].includes(ending) && n != null ? `<button type="button" class="hq-btn" data-reopen="${esc(n)}">重新打开</button>` : '',
    !end && n != null && !(r && (pipeOf(r) || r.row_actions?.some(a => a.key === 'end'))) ? `<span class="hq-rel"><button type="button" class="hq-btn" data-passmenu-d="${esc(L.rid)}">不投 ▾</button>${S.pop === 'd:' + L.rid ? passPop('d:' + L.rid) : ''}</span>` : '',
  ].filter(Boolean).join('');
  const text = judge && recovery ? recovery.reason : r ? r.text : lib?.tab === SHELF_KEY ? shelfText(lib) : lib?.screening_note || L.l.stage || '';
  return `<section class="ld-ask is-calm">${text ? `<p class="hq-q">${esc(text)}</p>` : ''}${r?.followup_note ? `<p class="hq-muted">${esc(r.followup_note)}</p>` : ''}${acts ? `<div class="ld-acts">${acts}</div>` : ''}</section>`;
}
const LD_TABS = [['jd', 'JD 与判断'], ['mat', '材料'], ['prog', '进展'], ['co', '公司']];
const ldTabsHtml = () => LD_TABS.map(([k, l]) => `<button type="button" role="tab" class="ld-tab ${S.ldTab === k ? 'is-on' : ''}" data-ld-tab="${k}" aria-selected="${S.ldTab === k}">${l}</button>`).join('');
function paneHtml() {
  if (!lead) return '';
  if (lead.loading) return '<div class="ld-loading" aria-busy="true"></div>';
  return ({ jd: jdHtml, mat: matHtml, prog: progHtml, co: coHtml }[S.ldTab] || jdHtml)();
}
// 判断程序自己拼的那句说成人话（同 lib/workflow.mjs plainJudgement）。
const REQ_WORD = { met: ['符合', 'ok'], transferable: ['可迁移', 'work'], unknown: ['待核', 'wait'], conflict: ['不符合', 'bad'] }, VERDICT_WORD = Object.fromEntries(Object.entries({ recommend: 'ok', verify: 'wait', exclude: 'bad' }).map(([k, t]) => [k, [verdictWord(k), t]]));
export const plainJudge = plainJudgement;
const sec = (title, body, extra = '') => `<section class="ld-sec"><h3>${title}${extra}</h3>${body}</section>`;
function jdHtml() {
  const { l, r } = leadOf(), display = lead.d?.judgement_display || {}, prefilter = display.prefilter;
  const m = prefilter ? {} : l.match || {}, hs = m.must_haves || [];
  const [vw, vt] = VERDICT_WORD[prefilter ? 'exclude' : m.verdict || r?.verdict] || [];
  const duplicates = (lead.d?.duplicates || []).map(x => `<a href="#lead/${esc(x.rid)}">${x.number != null ? '#' + esc(x.number) : esc(x.role)}</a>`).join('、');
  const reasons = (prefilter ? [`初筛未通过：${prefilter}。本次由筛选规则直接判定。`] : m.reasons || l.reasons || (r?.reason ? [r.reason] : [display.issue ? '暂时没有判断结论' : '还没判断'])).map(plainJudge).filter(Boolean);
  const gap = !prefilter && (m.biggest_gap || l.biggest_gap);
  const reqs = hs.length ? `<ul class="ld-reqs">${hs.map(x => { const [w, t] = REQ_WORD[x.status] || ['待核', 'wait']; const ev0 = typeof x.evidence === 'object' && x.evidence ? JSON.stringify(x.evidence) : x.evidence || x.candidate_evidence || x.resume_ref || x.quote || '', ev = String(ev0).trim().replace(/^(?:unknown|none|n\/a)\s*(?:[;；:：,，、]\s*|$)/i, ''); return `<li><span class="cmd-tag ${t}">${w}</span><div><div>${esc(x.req || x.requirement || x.name || x.item)}${x.critical !== false ? '<span class="ld-crit">关键</span>' : ''}</div>${ev ? `<div class="cmd-d">${esc(ev)}</div>` : ''}</div></li>`; }).join('')}</ul>` : '';
  const ev = lead.d?.evaluation, evaluation = ev ? sec('一页评估', `<dl class="ld-kv"><dt>级别</dt><dd>${esc(ev.level)}</dd><dt>薪资</dt><dd>${ev.comp ? `JD 写着「${esc(ev.comp)}」` : 'JD 没写'}</dd><dt>为什么</dt><dd>${esc(ev.fit || '—')}</dd></dl>${(ev.gaps || []).length ? `<ul class="ld-reqs">${ev.gaps.map(g => `<li><span class="cmd-tag wait">差距</span><div><div>${esc(g.gap)}</div>${g.plan ? `<div class="cmd-d">${esc(g.plan)}</div>` : ''}</div></li>`).join('')}</ul>` : ''}${(ev.ask || []).length ? `<ul class="ld-reqs">${ev.ask.map(x => `<li><span class="cmd-tag">问</span><div>${esc(x)}</div></li>`).join('')}</ul>` : ''}`) : '';
  const jd = String(l.jd_text || l.summary || ''), long = jd.length > 700;
  const jdBox = jd ? `<div class="ld-jd2 ${long && !S.jdOpen ? 'is-cut' : ''}">${esc(jd)}</div>${long ? `<button type="button" class="hq-lnk" data-jd-more>${S.jdOpen ? '收起' : '展开全文'}</button>` : ''}` : '<p class="hq-muted">还没拿到完整的岗位描述</p>';
  const jdBusy = S.busy.has('jd:' + lead.rid), jdEdit = S.jdEdit?.rid === lead.rid;
  const jdFill = l.url && !l.superseded && !l.paused && !endOf(l) && l.state !== 'offer' ? `<div class="ld-acts"><button type="button" class="hq-btn" data-jd-read ${jdBusy ? 'disabled' : ''}>${jdBusy ? '正在补全…' : '读取原帖并重判'}</button><button type="button" class="hq-btn" data-jd-edit ${jdBusy ? 'disabled' : ''}>粘贴完整描述</button></div>${jdEdit ? `<div class="hq-fields"><label class="is-long" for="ld-jd-text">原帖完整职位描述<textarea id="ld-jd-text" data-jd-text rows="12" maxlength="18000" ${jdBusy ? 'disabled' : ''}>${esc(S.jdEdit.text)}</textarea></label></div><div class="ld-acts"><button type="button" class="hq-btn is-pri" data-jd-save ${jdBusy ? 'disabled' : ''}>保存并重判</button><button type="button" class="hq-btn" data-jd-cancel ${jdBusy ? 'disabled' : ''}>取消</button></div>` : ''}` : '';
  const jdError = l.jd_backfill_error?.error ? `<p class="co-outdated">${esc(l.jd_backfill_error.error)}</p>` : '';
  const links = [l.url && h.link(l.url, '原帖'), l.application_url && l.application_url !== l.url && h.link(l.application_url, '申请页')].filter(Boolean).join(' · ');
  const score = !prefilter && r?.score != null ? ` <span class="ld-score">匹配度 ${Number(r.score)}</span>` : '';
  return (duplicates ? sec('可能重复', `<p>${duplicates}</p>`) : '') + sec('当前判断', `${reasons.map(x => `<p>${esc(x)}</p>`).join('')}${display.issue ? `<p class="co-outdated">${esc(display.issue)}</p>` : ''}${gap ? `<p class="ld-gap"><span class="cmd-tag wait">主要缺口</span>${esc(plainJudge(gap).replace(/^(?:推荐|待核|排除)[：:]\s*/, ''))}</p>` : ''}${reqs}`, vw ? ` <span class="cmd-tag ${vt}">${vw}</span>${score}` : '') + evaluation + sec('岗位描述', jdBox + jdError + jdFill, links ? `<span class="ld-links">${links}</span>` : '');
}
async function fillJd(action) {
  const rid = lead?.rid, l = lead?.d?.lead;
  if (!rid || !l || S.busy.has('jd:' + rid)) return;
  const text = action === 'save' ? String(document.querySelector('[data-jd-text]')?.value || '').trim() : '';
  if (action === 'save' && !text) { h.toast('请粘贴原帖完整职位描述'); return; }
  if (S.jdEdit?.rid === rid) S.jdEdit.text = text || S.jdEdit.text;
  S.busy.add('jd:' + rid); paint('pane');
  try {
    const res = await h.post('/api/lead/jd', { record_id: rid, action, source_url: l.url, ...(action === 'save' ? { text } : {}), request_id: crypto.randomUUID() });
    if (S.jdEdit?.rid === rid) S.jdEdit = null;
    h.toast(res.receipt);
  } catch (e) { h.toast(e.message); }
  finally { S.busy.delete('jd:' + rid); await h.refresh({ soft: true }); if (lead?.rid === rid) paint('pane'); }
}
// 材料：这个岗位用的简历版本、信和消息草稿、申请表拟填的内容。简历和信从 /api/resume 拿（点到这个标签才拉）。
// 投递会用哪一份只有一个说法（QA 第 2 轮新 5）：/api/lead 的 materials（lib/resume-choice.mjs leadMaterials → pickResume），
// 「Reacher 选的 / 你选的」；这个岗位的定制版各标「等你确认」「在用」，和那一句对得上；「换一份 ▾」里有这个岗位的定制版、其他各版、
// 「按岗位定制」（POST /api/resume {action:'tailor', rid}，Writer 在对话里先问，面板打开到那一段）。已经投出去的写当时上传的那一份。
// 求职信一样：这个岗位用哪一封，「换一份」里能选别的岗位的那封（一封信可以给几个岗位用）。
const TAILOR_WORD = { proposed: '等你看', ready: '等你看', accepted: '用了', applied: '用了', chosen: '在用', rejected: '没用', discarded: '没用', declined: '不用', failed: '没改成', stale: '过时了', running: '在改' };
const MAT_STATE = { waiting: ['等你确认', 'is-wait'], in_use: ['在用', 'is-ok'], failed: ['核对没过', 'is-bad'], idle: ['', ''] };
const matChip = st => { const [w, c] = MAT_STATE[st] || []; return w ? `<span class="ld-st ${c}">${w}</span>` : ''; };
const SENT_STATE = new Set(['sent', 'submitted', 'submitting']);
const editHref = (doc, v) => `#materials/edit?doc=${encodeURIComponent(doc)}&v=${encodeURIComponent(v)}`;
const letterHref = key => `#materials/letter?key=${encodeURIComponent(key)}`;
const byChip = by => by === 'you' ? '<span class="ld-by">你选的</span>' : `<span class="ld-by">${faceHtml('quill', 'is-mini')}${esc(whoName('quill'))} 选的</span>`;
function cvMenu(m) {
  const p = m.pick || {}, on = (d, v) => !p.whole_doc && p.doc === d && p.version === v;
  // 先选哪一份简历（10-03）：只选文件，投递用它现在用的那一版；默认投递的那份排第一。
  const fileItem = f => `<button type="button" role="menuitemradio" aria-checked="${f.on}" data-mat-choose data-doc="${esc(f.doc)}" data-v="" ${f.on ? 'disabled' : ''}><span class="ld-ck">${f.on ? '✓' : ''}</span>${esc(f.label)}${f.default_for ? '<small>默认投递</small>' : ''}</button>`;
  const item = x => `<button type="button" role="menuitemradio" aria-checked="${on(x.doc, x.version)}" data-mat-choose data-doc="${esc(x.doc)}" data-v="${esc(x.version)}" ${on(x.doc, x.version) ? 'disabled' : ''}><span class="ld-ck">${on(x.doc, x.version) ? '✓' : ''}</span>${esc(x.label)}${x.state === 'waiting' ? '<small>等你确认</small>' : x.default_for ? '<small>默认投递</small>' : ''}</button>`;
  return `<div class="hq-pop ld-menu" role="menu">${(m.files || []).length ? `<p class="ld-menu-h">简历文件（用它现在用的那一版）</p>${m.files.map(fileItem).join('')}` : ''}${m.tailored.length ? `<p class="ld-menu-h">这个岗位的定制版</p>${m.tailored.map(item).join('')}` : ''}${m.others.length ? `<p class="ld-menu-h">指定某一版</p>${m.others.map(item).join('')}` : ''}${p.by === 'you' ? `<button type="button" role="menuitem" data-mat-clear><span class="ld-ck"></span>让 ${esc(whoName('quill'))} 选</button>` : ''}<hr><button type="button" role="menuitem" class="is-writer" data-mat-tailor>${faceHtml('tailor', 'is-mini')}按岗位定制</button></div>`;
}
function cvHtml() {
  const d = lead.d || {}, m = d.materials, busy = S.busy.has('mat');
  const done = (d.resume_used || []).filter(u => SENT_STATE.has(u.state));
  if (done.length) return resumeUsedHtml(done, { esc, fmt: h.fmt }); // 已经投出去了：写当时上传的那一份，不再换
  if (!m?.pick) return d.resume_default ? `<p>投递会用《${esc(d.resume_default.name)}》</p>` : '<p class="hq-muted">还没有简历</p>';
  const p = m.pick;
  const head = `<div class="ld-cv"><div class="ld-cv-t"><span class="ld-cv-k">投递会用</span><b>《${esc(p.label)}》</b>${byChip(p.by)}</div><div class="ld-cv-a">${p.version ? `<button type="button" class="hq-btn" data-mat-preview data-doc="${esc(p.doc)}" data-v="${esc(p.version)}">预览</button>` : ''}<span class="hq-rel"><button type="button" class="hq-btn" data-matmenu="cv" aria-expanded="${S.pop === 'mat:cv'}" ${busy ? 'disabled' : ''}>换一份 ▾</button>${S.pop === 'mat:cv' ? cvMenu(m) : ''}</span></div></div>`;
  const rows = m.tailored.length ? `<ul class="ld-tv">${m.tailored.map(t => `<li><span class="ld-tv-n">${esc(t.label)}</span>${matChip(t.state)}<span class="ld-tv-a"><a class="hq-lnk" href="${editHref(t.doc, t.version)}">打开</a>${t.state === 'waiting' ? `<button type="button" class="hq-btn is-pri" data-mat-accept data-doc="${esc(t.doc)}" data-v="${esc(t.version)}" ${busy ? 'disabled' : ''}>用这版</button>` : ''}</span></li>`).join('')}</ul>` : '';
  return head + rows;
}
function ltMenu(L) {
  const cur = L.current?.key;
  // 核对没过的信不能选给岗位（服务端也拒绝，lib/resume-choice.mjs chooseLetter）：那一项灰着，写明核对没过。
  const item = x => `<button type="button" role="menuitemradio" aria-checked="${x.key === cur}" data-lt-choose="${esc(x.key)}" ${x.key === cur || x.state === 'failed' ? 'disabled' : ''}><span class="ld-ck">${x.key === cur && x.state !== 'failed' ? '✓' : ''}</span>${esc(x.title)}${x.state === 'failed' ? '<small>核对没过</small>' : x.uses ? `<small>用在 ${x.uses} 个岗位</small>` : ''}</button>`;
  return `<div class="hq-pop ld-menu" role="menu">${L.options.map(item).join('')}${L.current?.by === 'you' ? '<button type="button" role="menuitem" data-lt-clear><span class="ld-ck"></span>用这个岗位自己的那封</button>' : ''}<hr><button type="button" role="menuitem" class="is-writer" data-lt-write>${faceHtml('tailor', 'is-mini')}写一封新的</button></div>`;
}
function lettersHtml() {
  const m = lead.d?.materials, L = m?.letters, rid = leadOf().rid, res = lead.res;
  const out = [];
  if (L && (L.current || L.options.length)) {
    const c = L.current, busy = S.busy.has('mat');
    out.push(`<div class="ld-cv"><div class="ld-cv-t"><span class="ld-cv-k">求职信</span>${c ? `<b>《${esc(c.title)}》</b>${matChip(c.state)}${c.by === 'you' ? byChip('you') : ''}` : '<span class="hq-muted">这个岗位还没有</span>'}</div><div class="ld-cv-a">${c ? `<a class="hq-btn" href="${letterHref(c.key)}">打开</a>` : ''}<span class="hq-rel"><button type="button" class="hq-btn" data-matmenu="lt" aria-expanded="${S.pop === 'mat:lt'}" ${busy ? 'disabled' : ''}>换一份 ▾</button>${S.pop === 'mat:lt' ? ltMenu(L) : ''}</span></div></div>`);
  }
  const intros = res?.letters?.intros || [], intro = intros.find(x => x.record_id === rid) || intros.find(x => !x.record_id && x.status === 'chosen');
  if (intro) out.push(`<div class="ld-cv"><div class="ld-cv-t"><span class="ld-cv-k">自我介绍</span><b>《${esc(intro.record_id ? `${intro.number != null ? `#${intro.number} ` : ''}${intro.company || ''}`.trim() : intro.lang === 'en' ? '通用 · 英文' : '通用 · 中文')}》</b>${matChip(intro.status === 'chosen' ? 'in_use' : intro.status === 'failed' ? 'failed' : 'waiting')}</div><div class="ld-cv-a"><a class="hq-btn" href="${letterHref(intro.key)}">打开</a></div></div>`);
  return out.join('');
}
function pausedDraftAction(dr) {
  if (dr.city_pause_review && ['ready', 'blocked', 'needs_platform_action'].includes(dr.status)) return `<p class="hq-muted">旧城市暂停已按当前求职设置解除，请重新审阅。</p><details class="td-full"><summary>原暂停记录</summary><p>${esc(dr.city_pause_review.original?.reason || '')}</p></details>`;
  const reason = dr.paused_reason ? `<p class="hq-muted">当时的暂停记录：${esc(dr.paused_reason)}</p>` : '';
  if (dr.status === 'paused') return `${reason}<button type="button" class="hq-btn" data-draft-cancel="${esc(dr.draft_id)}" ${S.busy.has('cancel:' + dr.draft_id) ? 'disabled' : ''}>取消旧稿</button>`;
  if (dr.status !== 'cancelled' || dr.cancellation?.from !== 'paused') return '';
  const gmail = (dr.channel || 'email') === 'email' && /^r-?\d{8,}$/.test(dr.draft_id);
  const l = lead.d?.lead || {}, closed = ['passed', 'pass_pending', 'archived', 'rejected', 'offer'].includes(l.state) || l.contact_hold;
  return `${reason}<p class="hq-muted">旧稿的${gmail ? '本地' : ''}待发已取消${gmail ? '，Gmail 草稿仍保留' : ''}。正文、附件与审批历史保留。</p><p class="hq-muted">${closed ? '岗位仍保持暂停或结束状态。' : '需要重新准备时，可向 Writer 说明当前要求；取消本身不会启动新稿。'}</p>${closed ? '' : `<button type="button" class="hq-btn" data-draft-next="${esc(dr.draft_id)}">向 Writer 说明下一步</button>`}`;
}
const DRAFT_STATUS = { ready: '等你审', editing: '修改中', sent: '已发出', cancelled: '已取消', superseded: '已被新版替换', paused: '已暂停', blocked: '暂不能发送', needs_platform_action: '等你处理平台步骤', awaiting_judgement: '等待判断' };
function matHtml() {
  const L = leadOf(), d = lead.d || {}, res = lead.res;
  if (res === undefined) loadResume();
  // 旧的定制记录（迁移前「按岗位定制」，还没转成版本的）：照旧列一行。
  const old = (res?.tailoring?.records || []).filter(x => x.record_id === L.rid && !x.version);
  const legacy = old.length ? `<ul class="ld-mat">${old.map(x => `<li><b>${esc(x.label || `${x.base_version || ''} · 为这个岗位改过`)}</b><span class="ld-st">${esc(TAILOR_WORD[x.status] || '')}</span>${x.why ? `<small>${esc(x.why)}</small>` : ''}</li>`).join('')}</ul>` : '';
  const lts = lettersHtml();
  // 收件人：邮件写邮箱；平台私信（BOSS、脉脉……）的 to 是岗位页网址，它本来就是对着岗位发给发布人的——写「BOSS 直聘 · 岗位发布人」，网址收成一个链接（第 6 轮）。
  const PLATFORM = { 'zhipin.com': 'BOSS 直聘', 'maimai.cn': '脉脉', 'liepin.com': '猎聘', 'linkedin.com': 'LinkedIn' };
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const toText = dr => { const to = String(dr.to || ''); if (!/^https?:/.test(to)) return esc(to); const h = hostOf(to), name = dr.platform || PLATFORM[Object.keys(PLATFORM).find(k => h === k || h.endsWith('.' + k))] || h || '平台'; return `${esc(name)} · 岗位发布人 <a href="${esc(to)}" target="_blank" rel="noopener noreferrer">岗位页 ↗</a>`; };
  const drafts = (d.drafts || []).map(dr => `<details class="ld-doc" id="ld-draft-${esc(dr.draft_id)}" ${dr.status === 'ready' ? 'open' : ''}><summary><b>${esc(dr.subject || '消息草稿')}</b><span class="ld-st">${esc(DRAFT_STATUS[dr.status] || dr.status)}</span></summary><dl class="ld-kv"><dt>收件人</dt><dd>${toText(dr)}</dd>${(dr.attachments || []).length ? `<dt>附件</dt><dd>${dr.attachments.map(x => `${esc(x.name)} · ${Math.round(x.size / 1024)} KB`).join('、')}</dd>` : ''}</dl><pre class="ld-pre">${esc(dr.body)}</pre>${['ready', 'editing', 'needs_platform_action', 'blocked'].includes(dr.status) ? `<button type="button" class="hq-btn" data-draft="${esc(dr.draft_id)}">编辑 / AI 重写</button>` : ''}${pausedDraftAction(dr)}</details>`).join('');
  const a = L.r && (blockOf(L.r) || pipeOf(L.r)), fp = a?.form_preview;
  if (fp && lead.plan === undefined) loadPlan(fp);
  const plan = fp ? (Array.isArray(lead.plan) ? (lead.plan.length ? `<table class="hq-mini-table">${lead.plan.map(f => `<tr><td>${esc(f.label || f.key)}</td><td>${esc(String(f.value ?? '').slice(0, 160))}</td></tr>`).join('')}</table>` : '<p class="hq-muted">表里没有要填的</p>') : '<p class="hq-muted">正在读取…</p>') : '';
  return sec('简历', cvHtml() + legacy) + (lts ? sec('信', lts) : '') + (drafts ? sec('消息草稿', drafts) : '') + (plan ? sec('申请表拟填', plan) : '');
}
async function cancelOldDraft(id) {
  const rid = lead?.rid, shown = lead?.d?.drafts?.find(d => d.draft_id === id), busy = 'cancel:' + id;
  if (!rid || !shown || S.busy.has(busy)) return;
  S.busy.add(busy); paint('pane');
  try {
    const response = await fetch('/api/draft?readonly=1&id=' + encodeURIComponent(id)), v = await response.json();
    if (!response.ok) throw Error(v.error || '读不到这份草稿');
    const content = d => JSON.stringify([d.draft_id, d.record_id, d.to, d.subject, d.body, d.attachments, d.status]);
    if (lead?.rid !== rid) return;
    if (content(shown) !== content(v.draft)) throw Error('草稿已更新，请刷新材料并重新查看后再取消');
    if (!await askConfirm({ title: '取消这份旧稿？', lines: [`收件人：${v.draft.to || '未填写'}`, `主题：${v.draft.subject || '消息草稿'}`, v.draft.paused_reason ? `暂停原因：${v.draft.paused_reason}` : '', '正文、附件和审批历史会保留。取消只作废本地待发，不会启动新稿。', v.gmail ? 'Gmail 中的草稿不会删除。' : ''], go: '取消旧稿', cancel: '保留旧稿' })) return;
    const r = await h.post('/api/draft', { action: 'cancel', draft_id: id, record_id: rid, fingerprint: v.fingerprint });
    h.toast(r.message);
  } catch (e) { h.toast(e.message); }
  finally {
    S.busy.delete(busy);
    if (lead?.rid === rid) {
      try { const r = await fetch('/api/lead?id=' + encodeURIComponent(rid)); if (!r.ok) throw Error('材料刷新失败，请重新打开岗位'); const fresh = await r.json(); if (lead?.rid === rid) lead.d = fresh; }
      catch (e) { h.toast(e.message); }
      if (lead?.rid === rid) paint('pane');
    }
  }
}
// 「换一份」、「用这版」、「按岗位定制」：交给服务端，拿回新的 materials 重画这一块。
async function reloadMat() {
  const rid = lead?.rid; if (!rid) return;
  try { const r = await fetch('/api/lead?id=' + encodeURIComponent(rid)); if (r.ok && lead?.rid === rid) { const d = await r.json(); lead.d = { ...lead.d, materials: d.materials, resume_used: d.resume_used, resume_default: d.resume_default }; } } catch {}
  if (lead?.rid === rid) { lead.res = undefined; if (S.ldTab === 'mat') paint('pane'); }
}
async function matAct(body, { ok = null } = {}) {
  S.pop = null; S.busy.add('mat'); paint('pane');
  try { const r = await h.post('/api/resume', body); const t = typeof ok === 'function' ? ok(r) : ok; if (t) h.toast(t); return r; }
  catch (e) { h.toast(e.message); return null; }
  finally { S.busy.delete('mat'); await reloadMat(); }
}
async function matTailor() {
  const r = await matAct({ action: 'tailor', rid: lead.rid });
  if (r?.session_id) window.OfferCrew?.panel?.open?.({ session_id: r.session_id, anchor: r.message_id, pick: 'tailor' });
}
async function matPreview(doc, v) {
  let view;
  try { const r = await fetch(`/api/resume/view?doc=${encodeURIComponent(doc)}&version=${encodeURIComponent(v)}`); view = await r.json(); if (!r.ok) throw Error(view.error || '读不到这一版'); } catch (e) { h.toast(e.message); return; }
  mountSheetCss();
  document.querySelector('dialog.rs-dlg')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="rs-dlg is-preview"><header class="rs-dlg-h"><b>${esc(view.version.label || v)}</b><span class="rs-sp"></span><a class="rs-btn" href="${editHref(doc, v)}" data-close>修改</a><button type="button" class="rs-x" data-close aria-label="关闭">×</button></header><div class="rs-dlg-body"><div class="rs-sheet">${paperHtml(view.version.content)}</div></div></dialog>`);
  const dlg = document.querySelector('dialog.rs-dlg');
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  dlg.showModal();
}
async function loadResume() {
  lead.res = 'loading'; const rid = lead.rid;
  try { const r = await fetch('/api/resume'), v = await r.json(); if (lead?.rid === rid) lead.res = r.ok ? v : null; } catch { if (lead?.rid === rid) lead.res = null; }
  if (S.ldTab === 'mat') paint('pane');
}
async function loadPlan(id) {
  lead.plan = 'loading'; const rid = lead.rid;
  try { const r = await fetch('/api/application-plan?id=' + encodeURIComponent(id)), v = await r.json(); if (lead?.rid === rid) lead.plan = r.ok ? (v.fields || []) : []; } catch { if (lead?.rid === rid) lead.plan = []; }
  if (S.ldTab === 'mat') paint('pane');
}
async function loadTrace(ref) {
  const rid = lead.rid, map = lead.trace; map.set(ref, 'loading');
  try { const r = await fetch(`/api/lead/trace?id=${encodeURIComponent(rid)}&file=${encodeURIComponent(ref)}`), v = await r.json(); map.set(ref, r.ok ? v : { error: v.error || '读不到这份记录' }); } catch { map.set(ref, { error: '读不到这份记录' }); }
  if (lead?.rid === rid && S.ldTab === 'prog') paintProg();
}
// 重画「进展」时「全部处理记录」开着就还开着。
function paintProg() { const lg = $('#ld-log'); if (lg) S.logOpen = lg.open; paint('pane'); }
// 进展：按时间排的每一步（一个小头像，title 是成员名）、证据文件、联系记录和对方回复；下面是全部处理记录。
function progHtml() {
  const { r } = leadOf(), d = lead.d || {};
  // 每份证据一个按钮（邮件 / 私信 / 申请表 / 截图 / 记录），点开就地展开成人能看的样子（web/trace.js）；日志还是原文链接。
  const isLog = f => /\.log$/i.test(String(f)), refsOf = xs => [...new Set((xs || []).filter(Boolean))];
  const logLink = f => `<a class="hq-ev" href="/api/evidence?file=${encodeURIComponent(f)}">日志</a>`; // 在页面里打开（web/evidence-view.js）
  const evBtns = (refs, at) => refs.map(f => isLog(f) ? logLink(f) : `<button type="button" class="ld-evb ${S.trace === `${at}|${f}` ? 'is-on' : ''}" data-trace="${esc(f)}" data-trace-at="${at}" aria-expanded="${S.trace === `${at}|${f}`}">${evidenceLabel(f)}</button>`).join('');
  const panel = (refs, at) => { const f = refs.find(f => S.trace === `${at}|${f}`); return f ? traceHtml(lead.trace.get(f) ?? 'loading', { esc, fmt: h.fmt }) : ''; };
  const steps = r ? `<ol class="hq-tl ld-tl">${(r.timeline || r.steps).map((s, i) => {
    const cls = s.status === 'blocked' && s.hold ? 'hold' : DOT[s.status] || 'none', reached = s.status !== 'not_reached', who = s.owner === 'you' ? 'you' : mid(s.member || s.owner);
    const note = s.status === 'skipped' ? (s.note || '跳过') : reached ? (s.status === 'waiting_you' ? (s.note && s.note !== s.ask_text ? s.note : '等你') : s.note || '') : '';
    const refs = refsOf(s.evidence), first = refs.find(f => !isLog(f)), at = `st${i}`;
    const title = `${reached ? `<span class="ld-who" title="${esc(s.owner_name || memberInfo(who).name)}">${faceHtml(who, 'is-mini')}</span>` : ''}${esc(s.label)}`;
    return `<li class="is-${cls}${first ? ' has-ev' : ''}"><i></i><div>${first ? `<button type="button" class="hq-tl-t ld-stepb" data-trace="${esc(first)}" data-trace-at="${at}" aria-expanded="${refs.some(f => S.trace === `${at}|${f}`)}">${title}<span class="ld-caret" aria-hidden="true"></span></button>` : `<div class="hq-tl-t">${title}</div>`}${note ? `<div class="hq-tl-d">${esc(note)}</div>` : ''}${refs.length ? `<div class="ld-evs">${evBtns(refs, at)}</div>` : ''}${panel(refs, at)}</div><time>${esc(s.when || '')}</time></li>`;
  }).join('')}</ol>` : '';
  const atts = (r?.attempts || []).length ? sec('联系记录', `<ul class="hq-att">${r.attempts.map((x, i) => { const refs = refsOf(x.evidence), at = `at${i}`; return `<li><span>${esc(x.channel)}${x.purpose ? ` · ${esc(x.purpose)}` : ''} · ${esc(x.status)}${x.subject ? `<small>${esc(x.subject)}</small>` : ''}${x.reply ? `<small class="ld-reply">「${esc(x.reply)}」</small>` : ''}${refs.length ? `<span class="ld-evs">${evBtns(refs, at)}</span>` : ''}${panel(refs, at)}</span><time>${esc(x.when || '')}</time></li>`; }).join('')}</ul>`) : '';
  const evs = [...(d.events || [])].reverse();
  const log = evs.length ? `<details class="ld-doc" id="ld-log" ${!r || S.logOpen ? 'open' : ''}><summary><b>全部处理记录</b><span class="ld-st">${evs.length}</span></summary><ul class="cmd-log ld-log">${evs.map((e, i) => { const refs = refsOf((e.refs || []).map(x => x.file || x.screenshot)), at = `ev${i}`; return `<li class="${e.status === 'fail' ? 'fail' : ''}"><time>${esc(h.fmt(e.ts))}</time><div><span>${esc(e.text || e.msg || e.step)}</span>${refs.length ? `<span class="ld-evs">${evBtns(refs, at)}</span>` : ''}${panel(refs, at)}</div></li>`; }).join('')}</ul></details>` : '';
  return (steps ? sec('每一步', steps) : '') + atts + (log ? `<section class="ld-sec">${log}</section>` : '') || '<p class="hq-muted">这条线索还没有处理记录。</p>';
}
// 公司：点到这个标签才画（原来抽屉里的公司概况占地方）；没有简报时是「调研这家公司」（requestCompany）。
function coHtml() {
  const d = lead.d;
  if (!d) return '<p class="hq-muted">读不到这条线索的公司信息</p>';
  return `<div class="ld-co">${companySection(d, h)}${interviewSection(d, h)}${prepSection(d, h)}</div>`;
}
let leadKeys = false;
export function bindLead() {
  const main = $('#main'); if (!main || !$('#ld2')) return;
  // 进展深链只选一次标签，后续刷新不覆盖用户手动切换。
  if (new URLSearchParams(location.hash.split('?')[1] || '').has('tab')) { history.replaceState(null, '', '#lead/' + encodeURIComponent(lead.rid)); main.dataset.renderHash = location.hash; }
  main.onclick = e => { if (main.dataset.page === 'lead') onHqClick(e); };
  main.oninput = e => { if (main.dataset.page === 'lead' && e.target.matches('[data-jd-text]') && S.jdEdit?.rid === lead?.rid) S.jdEdit.text = e.target.value; };
  if (S.focusNext) { S.focusNext = false; ($('#ld-ask [data-field]') || $('#ld-ask [data-say]'))?.focus({ preventScroll: true }); }
  if (leadKeys) return;
  leadKeys = true;
  // j / k 翻下一条、上一条（按来处那张表的顺序）；光标在输入框里、有弹窗开着时不算。
  document.addEventListener('keydown', e => {
    if ($('#main')?.dataset.page !== 'lead' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || document.querySelector('dialog[open]')) return;
    const a = document.activeElement; if (a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable)) return;
    const k = String(e.key).toLowerCase(); if (k !== 'j' && k !== 'k') return;
    const p = pagerOf(fromOf().list || [], lead?.rid), to = k === 'j' ? p.next : p.prev;
    if (to) { e.preventDefault(); goLead(to); }
  });
}
const goLead = rid => { location.hash = '#lead/' + encodeURIComponent(rid); };

// ── ④ 面板对话里的「查看 #12」、@#128 ────────────────────────────────────────────
// 换到看得见这一行的标签（必要时清掉搜索），滚过去闪一下；闪的标记记在 S 里，这两秒里页面重画也还在闪。
// detail：主区打开这一条的岗位页（面板不动）。不在指挥台上、又不要详情时返回 false。
export function revealRow(rid, { detail = false } = {}) {
  if (detail) { if (!S.from || !(S.from.list || []).includes(rid)) setLeadOrigin({ hash: location.hash.startsWith('#lead/') ? fromOf().hash : location.hash || '#command', label: location.hash.startsWith('#inbox') ? '收件箱' : location.hash.startsWith('#lead/') ? fromOf().label : '指挥台', list: [rid], rid }); goLead(rid); return true; }
  const r = rowById(rid);
  if (!r || !$('#hq-rows')) return false;
  if (!visibleRows().some(x => x.rid === rid)) { S.only = null; paint('only'); S.q = ''; S.cities = []; S.filters = []; const qi = $('#hq-q'); if (qi) qi.value = ''; S.tab = 'all'; S.sticky.clear(); save(); paint('tabs', 'cities', 'filters'); }
  S.flash = { rid, until: Date.now() + 2200 };
  paint('rows');
  // 直接跳过去（不做平滑滚动）：页面可能马上重画，重画按那一刻的滚动位置恢复，滚到一半会停在半路。
  document.querySelector(`.hq-row[data-row="${CSS.escape(rid)}"]`)?.scrollIntoView({ block: 'center' });
  setTimeout(() => { if (S.flash?.rid !== rid) return; S.flash = null; document.querySelector(`.hq-row[data-row="${CSS.escape(rid)}"]`)?.classList.remove('is-flash'); }, 2300);
  return true;
}
// @# 选岗位：编号开头相同的，或公司 / 岗位里有这几个字的（指挥台已经拉到的行）。
export function leadByNumber(q) {
  const t = String(q || '').replace(/^#/, '').trim().toLowerCase();
  const hit = rows().filter(r => r.number != null && (!t || (/^\d+$/.test(t) ? String(r.number).startsWith(t) : `${r.company} ${r.role}`.toLowerCase().includes(t))));
  return hit.sort((a, b) => (String(a.number) === t ? -1 : 0) - (String(b.number) === t ? -1 : 0) || a.number - b.number).slice(0, 8).map(r => ({ rid: r.rid, number: r.number, company: coName(r.company).name, role: roleTitle(r) }));
}

// ── 动作：全部走收件箱同一个入口（/api/inbox/answer → answerAsk），或指令（/api/command → dispatchCommand）──
function markDone(r, text) { if (!r) return; S.sticky.set(r.rid, tabOf(r)); S.done.set(r.rid, text); S.sel.delete(r.rid); if (S.expand === r.rid) S.expand = null; if (S.confirm?.rid === r.rid) S.confirm = null; }
// 回执可能有好几行（「已记下批准……：」下一行才说登录哪个账号）：提示里连成一句。
const oneLine = (t, n) => { const x = String(t || '').replace(/\s*\n+\s*/g, ' ').replace(/：\s*·\s*/g, '：').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
function showReceipt(res) {
  const open = (res?.open || [])[0];
  h.toast(oneLine(res?.receipt || '已处理', 200), open ? { label: open.label || '打开登录页', run: () => openUrl(open.url) } : null);
}
async function openUrl(url) { try { const r = await h.post('/api/open-url', { url, name: 'OfferCrew · 需要你登录' }); h.toast(r.receipt || '已在浏览器里打开'); } catch (e) { h.toast(e.message); } }
// 回答一封信。extra：{ reason, text, datetime, fields, confirm }。需要确认的第一次只拿回预览（和收件箱一样）。
async function answer(a, key, extra = {}, { row = null } = {}) {
  const busyKey = row?.rid || a.id;
  if (S.busy.has(busyKey)) return null;
  S.busy.add(busyKey); S.busy.add(a.id); repaintAround(a, row);
  try {
    const res = await h.post('/api/inbox/answer', { id: a.id, option: key, ...(a.preview?.fingerprint ? { fingerprint: a.preview.fingerprint } : {}), ...extra });
    if (res.needs_confirm) {
      let fields = null;
      if (res.preview?.kind === 'queue_apply' && a.form_preview) { try { const f = await fetch('/api/application-plan?id=' + encodeURIComponent(a.form_preview)); const v = await f.json(); if (f.ok) fields = (v.fields || []).slice(0, 12); } catch {} }
      return { confirm: true, preview: res.preview, fields, text: res.confirm_text || '' };
    }
    if (res.client?.draft_editor) { openDraftEditor(res.client.draft_editor); return { ok: true, editor: true }; }
    if (res.client?.navigate) { location.hash = res.client.navigate; return { ok: true, editor: true }; }
    if (res.client?.profile_editor) { openEditor(res.client.profile_editor, h, res.client.profile_context); return { ok: true, editor: true }; }
    // 只打开了页面（登录页、投递页）：这一问还没答完，行上的选项留着（「我登好了」还要点）。
    // 申请页落空（跳到首页、下线……）时多一个「打开<网站>的职位列表」（lib/open-job-page.mjs）。
    if (res.done === false) { showReceipt({ ...res, receipt: res.receipt || '已打开' }); return { ok: true }; }
    S.answered.add(a.id);
    const r = row || (a.lead?.rid ? rowById(a.lead.rid) : null);
    const label = key === 'other' ? '按你说的' : a.options.find(o => o.key === key)?.label || '已处理';
    markDone(r, `${label} · ${oneLine(res.receipt || '已处理', 90)}`);
    if (S.pick?.ask === a.id) S.pick = null;
    showReceipt(res);
    h.refresh();
    return { ok: true };
  } catch (e) { h.toast(e.message); return null; }
  finally { S.busy.delete(busyKey); S.busy.delete(a.id); repaintAround(a, row); }
}
// 答完：表上那一行、岗位页上那封信都跟着变（刚答完的先拿掉）。
function repaintAround() { paint('head', 'rows', 'drawer', 'lhead'); }
// 选了一个选项：要原因的先问原因，要时间的先填时间，要确认的先确认；其余直接交出去。
async function choose(a, key) {
  const o = a.options.find(x => x.key === key); if (!o) return;
  if (o.reasons?.length || o.input === 'datetime') { S.pick = S.pick?.ask === a.id && S.pick.key === key ? null : { ask: a.id, key }; paint('drawer'); return; }
  if (o.input === 'fields') return submitFields(a, key);
  if (o.confirm === 'inline') { S.pick = { ask: a.id, key, confirm: 'inline' }; paint('drawer'); return; }
  const res = await answer(a, key);
  if (res?.confirm) { S.pick = { ask: a.id, key, confirm: 'server', preview: res.preview, fields: res.fields, text: res.text }; paint('drawer'); }
}
function submitFields(a, key) {
  const box = $('#ld-ask'), values = {};
  box?.querySelectorAll('[data-field]').forEach(el => { values[el.dataset.field] = el.value.trim(); });
  const missing = (a.form || []).find(f => !values[f.key]);
  if (missing) { h.toast(`「${missing.label}」还没填`); return; }
  answer(a, key, { fields: values });
}
// 行上的主动作：投 / 批准投递第一下只拿预览，第二下（确认）才交出去；联系、跟进、不跟、我来改、不发了直接交。
async function rowAct(r, key) {
  const a = pipeOf(r); if (!a) return;
  const o = a.options.find(x => x.key === key); if (!o) return;
  const res = await answer(a, key, {}, { row: r });
  if (res?.confirm) {
    // 窄窗口的聊天面板会覆盖岗位行；复用顶层确认框，让全文和确认/取消始终可操作。
    const first = (res.preview?.rows || [])[0];
    const text = first?.warn || `${o.hint || ''}${first?.in_proposal === false ? '（不在当前拟投清单里，提交时按规则再核一遍）' : ''}`;
    const go = `确认${a.kind === 'apply' || verbOf(a) === '投递' ? '投递' : optLabel(o)}`;
    if (await askConfirm({ title: `${numText(r.number)} ${go}`, lines: [text || '确认继续处理这条岗位？'], go })) {
      await answer(a, key, { confirm: true }, { row: r });
    }
  }
}
async function rowGo(r) {
  const a = pipeOf(r), c = S.confirm; if (!a || !c || c.rid !== r.rid) return;
  if (c.draft) { await answer(a, c.key, {}, { row: r }); return; }
  await answer(a, c.key, { confirm: true }, { row: r });
}
async function batch(verb, { reason = null, confirm = false } = {}) {
  const { g } = batchGroups(), rs = verb === 'pass' ? g.pass : g[verb] || [];
  if (!rs.length || S.busy.has('batch')) return;
  // 同一个动作在不同的信里选项号可能不同（筛选的「投递」是 1，拟投的「投递」也是 1）：按选项号分组各发一次。
  const pick = r => { const a = pipeOf(r); return verb === 'pass' ? passOpt(a)?.key : verb === '不跟' ? optBy(a, '不跟了')?.key : primaryOpt(a)?.key; };
  const byKey = new Map(); for (const r of rs) { const k = pick(r); if (k) (byKey.get(k) || byKey.set(k, []).get(k)).push(r); }
  S.busy.add('batch'); paint('head');
  h.toast(`正在处理 ${rs.length} 条，约 ${rs.length * 3} 秒；离开页面也会做完`);
  let ok = 0, failed = [];
  try {
    for (const [key, list] of byKey) {
      const res = await h.post('/api/inbox/answer', { ids: list.map(r => r.pipe), option: key, ...(reason != null ? { reason } : {}), ...(confirm ? { confirm: true } : {}) });
      for (const x of res.results || []) { const r = list.find(y => y.pipe === x.id); if (x.ok) { ok++; S.answered.add(x.id); markDone(r, `${verbWord(verb)}${reason ? '：' + reason : ''} · ${oneLine(x.receipt || '已处理', 80)}`); } else failed.push(`${numText(r?.number)} ${x.error}`); }
    }
    h.toast(`${verbWord(verb)} ${ok} / ${rs.length} 条${failed.length ? `；没成：${failed.slice(0, 2).join('；')}` : ''}`);
  } catch (e) { h.toast(e.message); }
  finally { S.busy.delete('batch'); S.batch = null; S.pop = null; paint('head', 'rows', 'tabs'); h.refresh(); }
}

// 指挥台和岗位页共用这一个点击处理（都在 #main 里）。
async function onHqClick(e) {
    if (!view) return;
    const t = e.target, on = s => t.closest(s);
    let x;
    // 等你的那封信：行上的 去补 / 去终审 → 这条的岗位页（回答就在最上面）；岗位页上的回答
    if ((x = on('[data-go-row]'))) { openRow(x.dataset.goRow, { focus: true }); return; }
    if ((x = on('[data-opt]'))) { const a = askOf(x.dataset.ask); if (a) choose(a, x.dataset.opt); return; }
    if ((x = on('[data-reason]'))) { const a = askOf(x.dataset.ask); if (a && S.pick?.ask === a.id) answer(a, S.pick.key, { reason: x.dataset.reason }); return; }
    if ((x = on('[data-dt-go]'))) { const a = askOf(x.dataset.dtGo), v = document.querySelector(`[data-dt="${CSS.escape(x.dataset.dtGo)}"]`)?.value; if (!v) { h.toast('请选择时间'); return; } if (a && S.pick?.ask === a.id) answer(a, S.pick.key, { datetime: v.replace('T', ' ') }); return; }
    if ((x = on('[data-go]'))) { const a = askOf(x.dataset.go), p = S.pick; if (!a || p?.ask !== a.id) return; answer(a, p.key, p.confirm === 'server' ? { confirm: true } : {}); return; }
    if (on('[data-cancel-pick]')) { S.pick = null; paint('drawer'); return; }
    if ((x = on('[data-send]'))) { const a = askOf(x.dataset.send), box = x.closest('.hq-say'), v = box?.querySelector('[data-say]')?.value.trim(); if (!v) { box?.querySelector('[data-say]')?.focus(); return; } if (a) answer(a, 'other', { text: v }); return; }
    // 页头「找新岗位」
    if (on('[data-top-why]')) { if (view.top) askSystem(view.top); return; }
    if ((x = on('[data-top-go]'))) { location.hash = x.dataset.topGo; return; }
    if (on('[data-top-close]')) { if (dismissTop()) paint('top'); return; }
    if (on('[data-find]')) { if (view.find?.heavy) { S.find = 'confirm'; paint('rows'); } else findJobs(); return; }
    if (on('[data-find-yes]')) { findJobs(); return; }
    if (on('[data-find-no]')) { S.find = null; paint('rows'); return; }
    // 岗位页：页内标签、翻页、展开 JD、编辑草稿
    if ((x = on('[data-ld-tab]'))) { S.ldTab = x.dataset.ldTab; paint('ltabs', 'pane'); return; }
    if ((x = on('[data-ld-nav]'))) { if (x.dataset.ldNav) goLead(x.dataset.ldNav); return; }
    if (on('[data-jd-more]')) { S.jdOpen = !S.jdOpen; paint('pane'); return; }
    if (on('[data-jd-read]')) { fillJd('read'); return; }
    if (on('[data-jd-edit]')) { S.jdEdit = { rid: lead.rid, text: S.jdEdit?.rid === lead.rid ? S.jdEdit.text : '' }; paint('pane'); document.querySelector('[data-jd-text]')?.focus(); return; }
    if (on('[data-jd-cancel]')) { S.jdEdit = null; paint('pane'); return; }
    if (on('[data-jd-save]')) { fillJd('save'); return; }
    if ((x = on('[data-trace]')) && lead) { const f = x.dataset.trace, k = `${x.dataset.traceAt}|${f}`; S.trace = S.trace === k ? null : k; if (S.trace && !lead.trace.has(f)) loadTrace(f); paintProg(); return; }
    if ((x = on('[data-draft]'))) { openDraftEditor(x.dataset.draft); return; }
    if ((x = on('[data-draft-cancel]'))) { cancelOldDraft(x.dataset.draftCancel); return; }
    if ((x = on('[data-draft-next]'))) { window.OfferCrew?.panel?.open?.({ member: 'tailor', text: `请为 #${lead.d?.lead?.number ?? ''} ${lead.d?.lead?.company || ''} 重新准备申请材料。旧暂停稿已取消，请依据当前事实资料与这个岗位的要求准备新的版本，供我审阅。` }); return; }
    // 岗位页「材料」：换一份、用这版、按岗位定制、预览；求职信换一封
    if ((x = on('[data-matmenu]'))) { const k = 'mat:' + x.dataset.matmenu; S.pop = S.pop === k ? null : k; paint('pane'); return; }
    if ((x = on('[data-mat-choose]'))) { matAct({ action: 'choose', rid: lead.rid, doc: x.dataset.doc, version: x.dataset.v || null }, { ok: r => r.pick ? `好，投递时用《${r.pick.label}》` : '' }); return; }
    if (on('[data-mat-clear]')) { matAct({ action: 'choose', rid: lead.rid, clear: true }, { ok: r => r.pick ? `好，交回给 ${whoName('quill')}：《${r.pick.label}》` : '' }); return; }
    if ((x = on('[data-mat-accept]'))) { matAct({ action: 'tailor_accept', doc: x.dataset.doc, version: x.dataset.v }, { ok: r => r.receipt || '' }); return; }
    if (on('[data-mat-tailor]')) { matTailor(); return; }
    if ((x = on('[data-mat-preview]'))) { matPreview(x.dataset.doc, x.dataset.v); return; }
    if ((x = on('[data-lt-choose]'))) { matAct({ action: 'letter_choose', rid: lead.rid, key: x.dataset.ltChoose }, { ok: '好，这个岗位用这封' }); return; }
    if (on('[data-lt-clear]')) { matAct({ action: 'letter_choose', rid: lead.rid, clear: true }, { ok: '好，用这个岗位自己的那封' }); return; }
    if (on('[data-lt-write]')) { matAct({ action: 'letter_write', record_id: lead.rid }, { ok: `${whoName('tailor')} 在写，写好了在「材料」的求职信里` }); return; }
    if (on('[data-ld-back]')) { S.backScroll = fromOf().scroll; return; }
    // 流水线
    if (on('[data-city-menu]')) { S.pop = S.pop === 'cities' ? null : 'cities'; paint('cities', 'filters'); return; }
    if (on('[data-more-menu]')) { S.pop = S.pop === 'filters' ? null : 'filters'; paint('cities', 'filters'); return; }
    if ((x = on('[data-hq-filter]'))) { const key = x.dataset.hqFilter; S.filters = x.checked ? [...new Set([...S.filters, key])] : S.filters.filter(k => k !== key); resetPage(); S.pop = 'filters'; repaintList(); return; }
    if (on('[data-filters-clear]')) { S.filters = []; resetPage(); repaintList(); $('#hq-more [data-more-menu]')?.focus(); return; }
    if ((x = on('[data-hq-city]'))) { const city = x.dataset.hqCity; S.cities = x.checked ? [...new Set([...S.cities, city])] : S.cities.filter(c => c !== city); resetPage(); S.pop = 'cities'; repaintList(); return; }
    if (on('[data-city-clear]')) { S.cities = []; resetPage(); repaintList(); $('#hq-city [data-city-menu]')?.focus(); return; }
    if ((x = on('[data-hq-order]'))) { const key = x.dataset.hqOrder; if (!['recent', 'role', 'progress'].includes(key)) return; const reverse = { recent: 'oldest', role: 'role-desc', progress: 'progress-desc' }; S.order = S.order === key ? reverse[key] : key; resetPage(); repaintList(); return; }
    if ((x = on('[data-hq-only]'))) { S.only = null; resetPage(); paint('tabs', 'only'); repaintList(); return; }
    if ((x = on('[data-hq-page]'))) { S.page = Number(x.dataset.hqPage); S.batch = null; S.confirm = null; S.pop = null; repaintList(); return; }
    if ((x = on('[data-tab]'))) { S.tab = x.dataset.tab; resetPage(); S.sticky.clear(); S.done.clear(); S.expand = null; S.confirm = null; S.pop = null; repaintList(); return; }
    if (on('[data-multi]')) { setMulti(!S.multi); return; }
    if ((x = on('[data-check]'))) { const id = x.dataset.check; x.checked ? S.sel.add(id) : S.sel.delete(id); S.batch = null; paint('head', 'rows'); return; }
    if ((x = on('[data-group]'))) { const rs = pageView().rows.filter(r => groupOf(r) === x.dataset.group && batchable(r)); const all = rs.every(r => S.sel.has(r.rid)); rs.forEach(r => all ? S.sel.delete(r.rid) : S.sel.add(r.rid)); S.batch = null; paint('head', 'rows'); return; }
    if (on('[data-clear-sel]')) { S.pop = null; setMulti(false); return; }
    if ((x = on('[data-batch]'))) { const v = x.dataset.batch; if (v === '投') { S.batch = { verb: '投' }; paint('head'); return; } batch(v); return; }
    if (on('[data-batch-go]')) { batch('投', { confirm: true }); return; }
    if (on('[data-batch-cancel]')) { S.batch = null; paint('head'); return; }
    if (on('[data-batch-pass]')) { S.pop = S.pop === 'batch' ? null : 'batch'; paint('head'); return; }
    if ((x = on('[data-pass]'))) {
      const id = x.dataset.pass, why = x.dataset.why; S.pop = null;
      if (id === 'batch') { batch('pass', { reason: why }); return; }
      // 岗位页上没有等你的信时的 pass（走指令，和原来的完整详情一样）
      if (id.startsWith('d:')) { const r = rowById(id.slice(2)), n = r?.number ?? (lead?.rid === id.slice(2) ? lead.d?.lead?.number : null); paint('drawer'); if (n != null) { try { await runCommand(`pass ${n}${why ? ' ' + why : ''}`); if (r) markDone(r, `不投了${why ? '：' + why : ''}`); paint('rows', 'drawer'); } catch {} } return; }
      const r = rowById(id), a = r && pipeOf(r), o = passOpt(a); if (!o) return;
      paint('rows'); answer(a, o.key, { reason: why }, { row: r });
      return;
    }
    if ((x = on('[data-passmenu]'))) { S.pop = S.pop === x.dataset.passmenu ? null : x.dataset.passmenu; paint('rows'); return; }
    if ((x = on('[data-passmenu-d]'))) { const k = 'd:' + x.dataset.passmenuD; S.pop = S.pop === k ? null : k; paint('rows', 'drawer'); return; }
    if ((x = on('[data-progress-act]'))) {
      const r = rowById(x.dataset.progressAct), a = r?.row_actions?.find(a => a.key === x.dataset.key);
      if (!a?.command || a.disabled || S.busy.has(r.rid)) return;
      S.busy.add(r.rid); paint('rows', 'drawer');
      try {
        await runCommand(a.command);
        viewAt = 0; // 保存后的刷新读取当前选择；操作期间的后台刷新可能已补回旧缓存。
        await h.refresh({ soft: true });
      } catch (e) { h.toast(e.message); }
      finally { S.busy.delete(r.rid); paint('rows', 'drawer'); }
      return;
    }
    if ((x = on('[data-row-act]'))) { const r = rowById(x.dataset.rowAct); if (r) rowAct(r, x.dataset.key); return; }
    if ((x = on('[data-row-go]'))) { const r = rowById(x.dataset.rowGo); if (r) rowGo(r); return; }
    if (on('[data-unconfirm]')) { S.confirm = null; paint('rows'); return; }
    if ((x = on('[data-expand]'))) { S.expand = S.expand === x.dataset.expand ? null : x.dataset.expand; S.confirm = null; paint('rows'); return; }
    if ((x = on('[data-draft-send]'))) { const r = rowById(x.dataset.draftSend), a = r && pipeOf(r), o = optBy(a, '发送'); if (o) { S.confirm = { rid: r.rid, key: o.key, draft: true }; paint('rows'); } return; }
    if ((x = on('[data-rewrite]'))) { const r = rowById(x.dataset.rewrite), a = r && pipeOf(r), v = document.querySelector(`[data-say-row="${CSS.escape(x.dataset.rewrite)}"]`)?.value.trim(); if (!v) return; if (a) answer(a, 'other', { text: v }, { row: r }); return; }
    if ((x = on('[data-judge-one]'))) { const rid = x.dataset.judgeOne; S.busy.add('judge:' + rid); x.disabled = true; try { const r = await h.post('/api/ops', { op: 'judge-one', record_id: rid }); h.toast(r.pending ? `先排着：${r.why}` : '开始判断这一条'); } catch (e) { S.busy.delete('judge:' + rid); x.disabled = false; h.toast(e.message); } return; }
    if ((x = on('[data-reopen]'))) { if (!(await askConfirm({ title: `把 #${x.dataset.reopen} 重新打开？`, lines: ['它会回到在推进的线索里，团队会接着跟。'], go: '重新打开' }))) return; x.disabled = true; try { await runCommand(`${x.dataset.reopen} 重新打开`); } catch { x.disabled = false; } return; }
    if ((x = on('[data-co-brief],[data-co-prep],[data-co-iv]'))) { requestCompany(x, h); return; }
    if ((x = on('[data-row]'))) {
      if (on('button, input, select, textarea, label, .hq-pop') || (on('a') && !x.matches('a'))) return;
      e.preventDefault(); openRow(x.dataset.row); return;
    }
    // 点在空白处：收起小菜单
    if (S.pop && !on('.hq-pop')) { const was = String(S.pop); S.pop = null; if (was.startsWith('mat:')) paint('pane'); else paint('rows', 'head', 'drawer', 'cities', 'filters'); }}
let keysBound = false;
export function bindHq() {
  const main = $('#main'); if (!main || !$('#hq')) return;
  main.onclick = e => { if (main.dataset.page === 'command') onHqClick(e); };
  const qi = $('#hq-q'); if (qi) qi.oninput = () => { S.q = qi.value; S.tab = 'all'; S.only = null; S.sticky.clear(); resetPage(); paint('tabs', 'only'); repaintList(); };
  // 深链用过了（hqPage 认过 tab / n）：地址换回 #command，画好的这一页记在 #command 名下（和收件箱的 #inbox?ask= 一样）。
  if (DEEP.test(location.hash)) { history.replaceState(null, '', '#command'); main.dataset.renderHash = location.hash; }
  // 从岗位页「←」回来：表格滚回原来的位置（标签、搜索本来就留着）。
  if (S.backScroll != null) { const el = $('#hq-rows'); if (el) el.scrollTop = S.backScroll; S.backScroll = null; }
  if (!keysBound) {
    keysBound = true;
    document.addEventListener('click', e => { if (['cities', 'filters'].includes(S.pop) && !e.target.closest('#hq-city, #hq-more')) { S.pop = null; paint('cities', 'filters'); } });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || $('#main')?.dataset.page !== 'command' || document.querySelector('dialog[open]')) return;
      if (S.pop) { const target = S.pop === 'cities' ? '[data-city-menu]' : S.pop === 'filters' ? '[data-more-menu]' : null; S.pop = null; paint('rows', 'head', 'cities', 'filters'); if (target) $(target)?.focus(); }
      else if (S.confirm || S.batch || S.find) { S.confirm = null; S.batch = null; S.find = null; paint('rows', 'head', 'heading'); }
      else if (S.sel.size) { S.sel.clear(); paint('head', 'rows'); }
    });
  }
}
// 打开一条的岗位页（点行，或行上的 去补 / 去终审）。来处记下这个标签和表上的顺序、滚到哪了。
// focus：缺信息的光标落进第一个空，对方回复的落进回信框。
function openRow(rid, { focus = false } = {}) {
  const label = (view?.tab_labels || []).find(([k]) => k === S.tab)?.[1];
  setLeadOrigin({ hash: '#command', label: S.tab === 'all' || !label ? '指挥台' : `指挥台 · ${label}`, list: groupedRows().flatMap(([, rs]) => rs.map(r => r.rid)), rid, scroll: $('#hq-rows')?.scrollTop ?? null });
  S.pop = null; S.focusNext = focus;
  goLead(rid);
}

// ── 别的页也要用的行（@# 选岗位、正在看）：/api/hq 最多 10 秒拉一次；指挥台和岗位页自己重画时拉 ──────
async function ensureView({ maxAge = 10000 } = {}) {
  if (!h) return;
  if (view && (Date.now() - viewAt < maxAge || ['command', 'lead'].includes($('#main')?.dataset.page))) return;
  if (viewLoading) return viewLoading;
  viewLoading = (async () => {
    try { const r = await fetch('/api/hq'), v = await r.json(); if (!r.ok) return; view = v; viewAt = Date.now(); }
    catch {} finally { viewLoading = null; }
  })();
  return viewLoading;
}
// SSE 的 update（app.js 调）：不在指挥台时也把行刷一下，但最多一分钟一次——这份有 1–2 MB，
// 只给 @# 选岗位用；原来每次 update 都拉，在任务页、收件箱上待着也一直在下载和解析（design/perf-0930/页面切换.md）。
export const crewRefresh = () => ensureView({ maxAge: 60000 });
// 测试用（tests/hq-tidy.test.mjs）：拿一份 /api/hq 的结果，画「现在」「操作」两格、页头和空表。
export const paintForTest = { use(v, helpers, { order = 'recent' } = {}) { view = v; h = helpers; S.order = order; S.page = 1; }, top: () => topHtml(), dismissTop, ask: b => askSystem(b), now: r => nowCell(r), act: r => actCell(r), heading: () => headingHtml(), rows: () => rowsHtml(), multi: () => multiBtn(), opt: (o, a, i) => optBtn(o, a, i) };
export function initHq(helpers) {
  h = helpers;
  if (initHq.done) return;
  initHq.done = true;
  ensureView();
}
