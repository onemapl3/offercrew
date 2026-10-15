// 收件箱：一次处理一件事（2026-09-28 规则：处理一条线索不该面对一排按钮，而应像 Claude Code 的
// 提问框——一句问题、几个默认选项、再加一个用户自己写的选项；每件事别都展开）。
// 数据来自 /api/inbox（服务端按规则生成问题和选项，lib/asks.mjs），选了什么只回传
// 「哪一件、第几个选项、你写的字」到 /api/inbox/answer，由服务端决定要执行的步骤。
import { openDraftEditor } from './command.js';
import { setViewing, setLeadOrigin } from './hq.js';
import { openEditor } from './setup.js';
import { morph } from './morph.js';
import { askConfirm } from './settings/ask.js';
import { linkedinInboxHtml, bindLinkedinInbox } from './linkedin-inbox.js';

let h = null, view = null, filter = 'all', currentId = null, hi = 0, mode = null, busy = false, sig = null, poll = null, flash = null;
let answerFeedback = null;
const done = new Map();
// 只打开了页面、还没答完的信（登录页开着、等你点「我登好了」）：信留着，上面多一行刚才做了什么。
const opened = new Map();
// 标签页按服务端给的分组（lib/hq.mjs blockersOnly 的 tabs：新消息、面试、登录、终审……），不再按信的底层类型。
const tabOf = a => a.tab || a.type;
const esc = x => h.esc(x);
// 发件人：图标按老编号，名字从名册来（h.crewName 认老编号和成员 id）；执行器不是成员。
// 图标是线条图标（web/crew-faces.js 的 Tabler outline，挂在 globalThis.OfferCrewIcons），和成员的脸同一套。
// 发件人可以是老编号（radar / reacher / watch / system），也可以是成员 id（执行器的信写的是在做的那位，lib/asks.mjs needBase）。
// 「执行器」不是成员，不露给你：没写成员的老信记在 System（Patch）名下。
const SENDER_ICON = { radar: 'radar-2', reacher: 'send', watch: 'eye', system: 'settings', scout: 'radar-2', lens: 'scale', tailor: 'writing', quill: 'send', owl: 'eye', patch: 'settings' };
const TYPE_ICON = { message: 'messages', interview: 'calendar', login: 'key', review: 'file-check', decide: 'arrows-split', info: 'pencil', followup: 'repeat', triage: 'filter', inflight: 'hourglass', accounts: 'lock' };
const icon = n => globalThis.OfferCrewIcons?.iconHtml?.(n) || '';
const typeIcon = k => icon(TYPE_ICON[k]);
// 一封信的图标：新消息一个，其余按信的底层类型（标签页现在按类别分，lib/hq.mjs inboxTab）。
const askIcon = a => typeIcon(a?.tab === 'message' ? 'message' : a?.type);
const sender = k => { const id = Object.hasOwn(SENDER_ICON, k) ? k : 'system'; return [icon(SENDER_ICON[id]), h.crewName(id)]; };
const visible = () => (view?.asks || []).filter(a => filter === 'all' || tabOf(a) === filter || (filter.startsWith('from:') && a.from === filter.slice(5))).filter(a => !done.has(a.id));
// 左栏「收件箱」后面的数：只有这一个函数写它，数只有一个来处——服务端那张单子（lib/hq.mjs deskInbox）的件数，
// 减去这一页上刚答完、服务端还没刷新掉的那几件。指挥台（/api/hq 的 inbox.waiting）、别的页（/api/inbox/count）都交给它。
export function paintBadge(n) { const b = typeof document === 'undefined' ? null : document.querySelector('#inbox-count'); if (b) b.textContent = n > 0 ? String(n) : ''; }
const liveCount = () => (view?.asks || []).filter(a => !done.has(a.id) && !a.focus_only).length;
// 指挥台跳过来时先设好筛选和要看的那一封（同一个模块实例，状态直接共享）。
export function presetInbox({ filter: f = null, select = null } = {}) {
  if (f) { filter = f; try { localStorage.setItem('radar.inbox.filter', f); } catch {} }
  if (select) currentId = select;
  hi = 0; mode = null;
}
const current = () => visible().find(a => a.id === currentId) || visible()[0] || null;
const optionsOf = a => a ? [...a.options, ...(a.other ? [{ key: 'other', label: '其他', other: true }] : [])] : [];

// 还没打开过收件箱时先拉一份（web/app.js 空闲时、鼠标移到左栏上时调），换过来就能当场画。
export async function inboxPrefetch(helpers) {
  if (view) return;
  h = h || helpers;
  try { const r = await fetch('/api/inbox'), d = await r.json(); if (r.ok && !view) view = d; } catch {}
}
export async function inboxPage(helpers) {
  h = helpers;
  const r = await fetch('/api/inbox'), d = await r.json();
  if (!r.ok) throw Error(d.error || '收件箱读取失败');
  // 已处理完的项，服务端刷新后自然消失；本地标记只留到服务端也不再返回为止。
  for (const id of [...done.keys()]) if (!d.asks.some(a => a.id === id)) done.delete(id);
  for (const id of [...opened.keys()]) if (!d.asks.some(a => a.id === id)) opened.delete(id);
  view = d; sig = d.content_sig || null;
  // 记住的标签这次没有了（处理完了，或者是改版前的标签名）：回到「全部」，不对着一个空标签说「都处理完了」。
  if (filter !== 'all' && filter !== 'accounts' && !filter.startsWith('from:') && !(d.tabs || []).some(t => t.key === filter)) filter = 'all';
  // 深链 #inbox?ask=<id>（指挥台上「你」和成员卡片的「等你：…」）：筛选换回全部、停在那一件上，进来时闪一下。
  // 地址在画完之后换回 #inbox（bindInbox），之后刷新、换一件都不再跳回来。
  const deep = askInHash();
  if (deep && d.asks.some(a => a.id === deep)) { presetInbox({ filter: 'all', select: deep }); flash = deep; }
  // #inbox?tab=accounts（成员页「网站账号」一行、设置里过来）：直接打开那一个标签。
  const tabQ = typeof location === 'undefined' ? null : /[?&]tab=([a-z:]+)/.exec(location.hash)?.[1];
  if (tabQ && (tabQ === 'accounts' || (d.tabs || []).some(t => t.key === tabQ))) presetInbox({ filter: tabQ });
  paintBadge(liveCount());
  if (!current()) { currentId = null; hi = 0; }
  return html();
}
export const inboxSig = () => sig;
// 换到收件箱时先用手上这份画（web/app.js 换页立刻换）；没拉过、或地址指着某一封（要先认）返回 null。
export function inboxNow() {
  if (!view || !h || askInHash()) return null;
  if (!current()) { currentId = null; hi = 0; }
  return html();
}
// 收件箱空着时那一句。待核还在就不说「都处理完了」（10-02 开箱第 3 轮：全部 0、待核 14 个，这一句却说都处理完了）：
// 待核在指挥台的行上答，这里只说没有要回的信，再指过去。
export const emptyLine = ({ filter = 'all', verify = 0 } = {}) => filter === 'all' && verify ? `没有要你回的信。 <a class="ib-verify" href="#command?tab=verify">待核 ${verify} 个 →</a>` : '都处理完了。';
const askInHash = () => { const m = typeof location === 'undefined' ? null : /[?&]ask=([^&]+)/.exec(location.hash); try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; } };

function html() {
  const live = (view.asks || []).filter(a => !done.has(a.id));
  paintBadge(live.length);
  const tab = (k, label, n) => `<button type="button" class="ib-tab ${filter === k ? 'on' : ''}" data-ib-filter="${k}">${label}${n != null ? ` <b>${n}</b>` : ''}</button>`;
  const groups = (view.tabs || []).map(t => [t.key, t.label]);
  // 标签就是「全部」里的分组（lib/hq.mjs arrange）：名字一样，数的是同样那几封。
  // 账号是一张账号表，不是待办：不带数字（实测 10-04 第 14 条：「账号 29」数的是表上所有站点，看不出是什么）；挡着事的账号在「要你登录」里数。
  const tabs = [tab('all', '全部', live.length), ...groups.map(([k, label]) => tab(k, `${askIcon(live.find(a => tabOf(a) === k))}<span>${esc(label)}</span>`, live.filter(a => tabOf(a) === k).length)), tab('accounts', `${typeIcon('accounts')}<span>账号</span>`, null)].join('') + (filter.startsWith('from:') ? `<button type="button" class="ib-tab on" data-ib-filter="all" title="看全部">来自 ${sender(filter.slice(5))[0]} ${esc(sender(filter.slice(5))[1])} ×</button>` : '');
  // 一件都没有：只一句话（10-01 第 1 轮验收第 30 条：原来左边「这一类没有待办。」右边又两句）。
  const body = filter === 'accounts' ? accountsHtml() : !visible().length ? `<div class="panel ib-panel ib-none"><p>${emptyLine({ filter, verify: view.verify })}</p></div>` : `<div class="ib-body"><aside class="ib-list" aria-label="待办列表">${listHtml()}</aside><section class="ib-focus" aria-live="polite">${focusHtml()}</section></div>`;
  // 这里只放「需要你」（卡住、只有你能定的事），是答它们的唯一地方。页头只有标题：「已暂缓 N」「指挥台上还有 N 件」不再写
  // （负责人 10-02：不占注意力；在路上的事看运行日志和任务页，以前的「进行中」标签也去掉了）。
  return `<div class="inbox"><div class="page-heading ib-heading"><div><h1>收件箱</h1></div></div><div class="ib-tabs" role="tablist">${tabs}</div>${body}</div>`;
}

function listHtml() {
  const items = visible();
  if (!items.length) return '<div class="empty small">这一类没有待办。</div>';
  let last = null;
  return items.map(a => {
    // 按「需要你」的分类分组（对方回复、缺信息、没找到联系人……，lib/hq.mjs），和指挥台一样的顺序。
    const g = groupOf(a);
    const head = filter === 'all' && g !== last ? `<div class="ib-group">${askIcon(a)} ${esc(g)} <span>${items.filter(x => groupOf(x) === g).length}</span></div>` : '';
    last = g;
    const on = current()?.id === a.id;
    return `${head}<button type="button" class="ib-item tier-${tierOf(a)} ${on ? 'on' : ''} ${flash === a.id ? 'is-flash' : ''}" data-ib-ask="${esc(a.id)}">${tierTag(a)}<span class="ib-item-title"><span class="ib-from" title="${esc(sender(a.from)[1])} 发来">${sender(a.from)[0]}</span>${esc(a.title)}</span><span class="ib-item-q">${a.lead?.role ? `${esc(short(a.lead.role, 24))} · ` : ''}${esc(headline(a))}</span></button>`;
  }).join('') + (filter === 'followup' && items.length > 1 ? `<div class="ib-batch"><button type="button" class="secondary mini" data-ib-batch="1">全部跟进（${items.length}）</button><button type="button" class="secondary mini" data-ib-batch="2">全部不跟</button></div>` : '')
    + (['reapprove', 'stale'].includes(filter) && reconfirmable(items).length > 1 ? `<div class="ib-batch"><button type="button" class="secondary mini" data-ib-batch="reconfirm">全部按现在的材料确认（${reconfirmable(items).length}）</button></div>` : '');
}
const short = (t, n) => { const s = String(t || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const groupOf = a => a.tab_label || a.tag || view.types[a.type]?.label || '';
// 四档（lib/status.mjs TIERS）：每档一种颜色的色条和小标，词由服务端带来（a.tier_word），页面不自带词表。
const tierOf = a => (/^(block|reply|decide|note)$/.test(a.tier || '') ? a.tier : 'decide');
const tierTag = a => a.tier_word ? `<span class="ib-tier tier-${tierOf(a)}">${esc(a.tier_word)}</span>` : '';
// 列表上一行说清是什么事：执行器写的长句只取第一句（到句号、分号、问号为止），全文在右边的详情里。
// 汇报带了短标题（a.headline，执行器 need 的 title）就用它。
export const headline = a => {
  if (a.headline) return short(a.headline, 40);
  // 问题开头又说了一遍标题（「#22 Initech 已在浏览器里预填好」）：列表上标题已经在上一行了。
  const t = String(a.title || ''), q0 = String(a.question || '').trim(), q = t && q0.startsWith(t) ? q0.slice(t.length).trim() : q0;
  if (q.length <= 40) return q;
  const first = q.split(/(?<=[。；;！!？?])/)[0].replace(/[。；;]$/, '');
  return short(first.length >= 8 ? first : q, 40);
};
// 上海时间：带时刻的显示成「9/28 17:05」，只有日期的原样显示日期。
// 本地时区：bin/serve.mjs 写进 <meta name="radar-tz">（config/host.json，lib/tz.mjs）；没有就用浏览器所在时区。
const TZ = (typeof document !== 'undefined' && document.querySelector('meta[name="radar-tz"]')?.content) || undefined;
const hhmm = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) : ''; };
const when = t => /T/.test(String(t)) ? new Date(t).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : String(t).slice(0, 10);

function focusHtml() {
  const a = current();
  if (!a) return `<div class="ib-empty"><p>都处理完了。</p></div>`;
  const list = visible(), pos = list.indexOf(a) + 1, T = view.types[a.type];
  const opts = optionsOf(a);
  if (hi >= opts.length) hi = 0;
  const ctx = (a.context || []).map(c => `<span class="ib-chip">${esc(c)}</span>`).join('');
  const affected = a.affected?.length ? `<ul class="ib-affected">${a.affected.map(x => `<li>${x.record_id ? `<a href="${h.leadUrl(x.record_id)}">${esc(x.label)}</a>` : esc(x.label)}${x.count > 1 ? ` <span class="muted">× ${x.count} 天</span>` : ''}</li>`).join('')}</ul>` : '';
  const p = a.preview;
  const message = p?.kind === 'message' ? `<div class="ib-preview"><div class="ib-preview-head"><span>${esc(p.platform || '消息')}</span>${p.from ? `<span>来自 ${esc(p.from)}</span>` : ''}${p.time_label || p.received_at ? `<span>${esc(p.time_label || when(p.received_at))}</span>` : ''}${p.url ? h.link(p.url, '打开原对话') : ''}</div><div class="ib-preview-body" tabindex="0" aria-label="收到的完整消息">${esc(p.body)}</div></div>` : '';
  const preview = p?.kind === 'draft' ? `<div class="ib-preview"><div class="ib-preview-head"><span>${esc(p.platform || (p.channel === 'email' ? '邮件' : '消息'))}</span>${p.channel === 'email' ? `<span>发给 ${esc(p.to)}</span>` : ''}${p.subject && p.channel === 'email' ? `<span>主题：${esc(p.subject)}</span>` : ''}</div><div class="ib-preview-body">${esc(p.body)}</div>${p.attachments?.length ? `<div class="ib-preview-att">附件：${p.attachments.map(esc).join('、')}</div>` : ''}${p.warning ? `<div class="ib-warn">${esc(p.warning)}</div>` : ''}</div>` : '';
  // 终审：这次上传的是哪一份简历（稳定版 vN / 按岗位定制版，lib/resume-choice.mjs）。
  const resumeLine = p?.kind === 'form' && p.resume ? `<p class="ib-resume">这次上传：<b>${esc(p.resume.file)}</b> · ${esc(p.resume.label)}</p>` : '';
  const form = p?.kind === 'form' ? `${resumeLine}<div class="ib-preview ib-form">${p.screenshot ? `<a href="/api/evidence?file=${encodeURIComponent(p.screenshot)}" target="_blank" rel="noopener"><img class="ib-shot" alt="填好的申请表截图" src="/api/evidence?file=${encodeURIComponent(p.screenshot)}"></a>` : ''}${p.fields?.length ? `<table class="mini-table ib-form-fields"><tbody>${p.fields.map(f => `<tr><td class="muted">${esc(f.key)}</td><td>${esc(short(f.value, 200))}</td></tr>`).join('')}</tbody></table>` : ''}</div>` : '';
  // 登录信：系统最近一次自己去浏览器里看的结果（lib/login-watch.mjs）。
  const ck = a.account?.checked, watchLine = a.account?.probe ? `<p class="ib-watch">${ck?.at ? `系统 ${esc(when(ck.at))} 看过：${esc(ck.logged_in ? '已登录' : ck.reason || '还没登录')}` : '系统会自己去浏览器里看你登好了没有'}${ck?.stuck ? ' · 继续了几次任务还是说要登录，请打开看看' : ''}</p>` : '';
  const account = (a.account?.how ? `<p class="ib-how">${esc(a.account.how)}</p>` : '') + watchLine;
  const facts = a.facts?.length ? `<dl class="ib-facts">${a.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join('')}</dl>` : '';
  const initialFields = !mode && a.form?.length && a.options.some(o => o.input === 'fields') ? subHtml(a, { kind: 'fields', initial: true }) : '';
  const sub = mode && mode.ask === a.id ? subHtml(a) : '';
  const optsHtml = sub ? '' : `<ol class="ib-options" role="listbox" aria-label="选项">${opts.map((o, i) => o.other
    ? `<li class="ib-opt ib-other ${hi === i ? 'on' : ''}" data-ib-i="${i}"><span class="ib-caret">❯</span><kbd>${i + 1}</kbd><input class="ib-other-input" type="text" maxlength="1000" placeholder="${esc(a.other.placeholder || '其他：直接告诉系统怎么做')}" aria-label="其他"><button type="button" class="secondary mini" data-ib-send-other="1">发送</button></li>`
    : `<li class="ib-opt ${hi === i ? 'on' : ''} ${o.danger ? 'danger' : ''}" data-ib-i="${i}" role="option" aria-selected="${hi === i}"><span class="ib-caret">❯</span><kbd>${i + 1}</kbd><span class="ib-opt-label">${esc(o.label)}</span>${o.hint ? `<span class="ib-opt-hint">${esc(o.hint)}</span>` : ''}</li>`).join('')}</ol>`;
  const links = [a.url ? h.link(a.url, '原帖 / 入口') : '', a.lead?.record_id ? `<a href="${h.leadUrl(a.lead.record_id)}">线索详情 →</a>` : '', a.form_preview ? `<button type="button" class="link-button" data-ib-form="${esc(a.form_preview)}">看拟填内容</button>` : ''].filter(Boolean).join(' · ');
  // 自动预填停下来的那一页（lib/asks.mjs proofOf）：截图、地址、停在哪一步；原始的码只在这里。
  const pf = a.proof, proof = pf ? `<div class="ib-proof">${pf.screenshot ? `<a href="/api/evidence?file=${encodeURIComponent(pf.screenshot)}" target="_blank" rel="noopener"><img class="ib-shot" alt="停下时的页面截图" src="/api/evidence?file=${encodeURIComponent(pf.screenshot)}"></a>` : ''}<dl class="ib-facts">${pf.step ? `<dt>停在</dt><dd>${esc(pf.step)}</dd>` : ''}${pf.url ? `<dt>页面</dt><dd>${h.link(pf.url, short(pf.url, 60))}</dd>` : ''}${pf.at ? `<dt>时间</dt><dd>${esc(when(pf.at))}</dd>` : ''}</dl></div>` : '';
  const detail = rest(a) || (a.note && !['triage', 'decide'].includes(a.type)) || links || proof ? `<details class="ib-detail"><summary>详情与证据</summary>${a.note && !['triage', 'decide'].includes(a.type) ? `<p class="ib-note">${esc(a.note)}</p>` : ''}${rest(a) ? `<p class="full">${esc(rest(a))}</p>` : ''}${proof}${links ? `<p class="ib-links">${links}</p>` : ''}</details>` : '';
  const doneReceipt = done.get(a.id);
  const feedback = answerFeedback?.ask === a.id ? answerFeedback : null;
  const feedbackHtml = feedback ? `<p class="ib-answer-feedback ${feedback.kind}" role="${feedback.kind === 'error' ? 'alert' : 'status'}">${esc(feedback.text)}</p>` : '';
  return `<article class="ib-ask t-${esc(a.type)} tier-${tierOf(a)} ${flash === a.id ? 'is-flash' : ''} ${busy && feedback?.kind === 'pending' ? 'busy' : ''}" aria-busy="${busy && feedback?.kind === 'pending'}" data-ask-id="${esc(a.id)}"><div class="ib-ask-meta">${tierTag(a)}<span class="ib-sender">${sender(a.from)[0]} ${esc(sender(a.from)[1])} 来信</span><span class="ib-type">${askIcon(a)} ${esc(a.tag || T?.label || '')}</span><span class="muted">${pos} / ${list.length}</span><span class="ib-nav"><button type="button" class="icon-button" data-ib-step="-1" title="上一件（K）">‹</button><button type="button" class="icon-button" data-ib-step="1" title="下一件（J）">›</button></span></div><h2 class="ib-title">${esc(a.title)}</h2>${ctx ? `<div class="ib-context">${ctx}</div>` : ''}${a.said && p?.kind !== 'message' ? `<blockquote class="ib-said">${esc(a.said)}</blockquote>` : ''}${a.intervention ? `<p class="ib-intervention"><strong>${esc(a.intervention.prompt)}</strong></p>` : ''}<p class="ib-question">${esc(dropTitle(a, fullQuestion(a)))}</p>${a.note && ['triage', 'decide'].includes(a.type) ? `<p class="ib-note">${esc(a.note)}</p>` : ''}${Array.isArray(a.form) && mode?.kind !== 'fields' && a.form.some(f => !String(a.question).includes(f.label)) ? `<p class="ib-need-fields">要填：${a.form.map(f => esc(f.label)).join('、')}</p>` : ''}${affected}${account}${facts}${message}${preview}${p?.kind === 'form' ? `${optsHtml}${sub}${form}` : `${form}${initialFields}${optsHtml}${sub}`}${feedbackHtml}${doneReceipt ? `<p class="ib-receipt">✓ ${esc(doneReceipt)}</p>` : opened.has(a.id) ? `<p class="ib-receipt">${esc(opened.get(a.id))}</p>` : ''}${detail}</article>`;
}

// 「详情与证据」里放问题之外的话：详情开头就是问题本身（执行器的原话）时去掉这一段，不把同一句话说两遍。
// 问题开头又说了一遍标题（「#22 Initech 已在浏览器里预填好」）：标题就在上面一行，去掉。
const dropTitle = (a, q) => { const t = String(a.title || ''); return t && q.startsWith(t + ' ') ? q.slice(t.length).trim() : q; };
// 问题在服务端被截短过（末尾「…」）而详情里有原话：大字那一句给全文。
function fullQuestion(a) {
  const q = String(a.question || ''), d = String(a.detail || '');
  if (!q.endsWith('…') || !d.startsWith(q.slice(0, -1))) return q;
  return d.split(/\n\s*\n/)[0].trim();
}
function rest(a) {
  const d = String(a.detail || '').trim(), q = fullQuestion(a).trim();
  // 对方的原话已经在信上（a.said）：「详情与证据」里不再放一遍。
  if (!d || d === a.note || (a.said && d === a.said)) return '';
  if (q && d.startsWith(q)) return d.slice(q.length).replace(/^[\s。；;]+/, '').trim();
  return d;
}

// 选项之后的第二步：pass 原因、面试时间、投递 / 发送确认、飞书扫码。
function subHtml(a, override = null) {
  const m = override || mode;
  if (m.kind === 'reason') {
    const reasons = [...m.reasons, '不填原因'];
    return `<div class="ib-sub"><p class="ib-sub-q">${esc(m.label)}：为什么？</p><ol class="ib-options">${reasons.map((r, i) => `<li class="ib-opt ${hi === i ? 'on' : ''}" data-ib-reason="${i}"><span class="ib-caret">❯</span><kbd>${i + 1}</kbd><span class="ib-opt-label">${esc(r)}</span></li>`).join('')}</ol></div>`;
  }
  // 补充信息（harness）：信里列了哪几项就填哪几项；答案记进本地答案簿，以后别的申请表自动填。
  if (m.kind === 'fields') {
    // 答案簿里已有的项预先填好（f.value / f.remembered），你确认或改一下就行。
    const input = f => f.type === 'choice' ? `<select data-ib-field="${esc(f.key)}"><option value="">请选择</option>${(f.options || []).map(o => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : f.type === 'long_text' ? `<textarea data-ib-field="${esc(f.key)}" rows="3">${esc(f.value ?? '')}</textarea>`
      : `<input data-ib-field="${esc(f.key)}" type="${{ date: 'date', number: 'number' }[f.type] || 'text'}" placeholder="${f.type === 'month' ? '例如 1995-03' : ''}" value="${esc(f.value ?? '')}" autocomplete="off">`;
    return `<div class="ib-sub"><div class="ib-fields-form">${(a.form || []).map(f => `<label class="ib-field"><span>${esc(f.label)}${f.remembered ? ' <small class="muted">（答案簿里有，确认一下）</small>' : ''}</span>${input(f)}</label>`).join('')}</div>${m.initial ? '' : '<div class="ib-inline"><button type="button" class="primary mini" data-ib-fields="1">保存并继续</button></div>'}</div>`;
  }
  if (m.kind === 'url') return `<div class="ib-sub"><div class="ib-inline"><input type="url" class="ib-url" placeholder="https://" autocomplete="off"><button type="button" class="primary mini" data-ib-url="1">换上</button></div></div>`;
  if (m.kind === 'datetime') return `<div class="ib-sub"><p class="ib-sub-q">面试时间（北京时间）</p><div class="ib-inline"><input type="datetime-local" class="ib-dt"><button type="button" class="primary mini" data-ib-dt="1">记下</button></div></div>`;
  if (m.kind === 'confirm_send') return `<div class="ib-sub ib-confirm"><p class="ib-sub-q">${m.final ? '确认提交这份申请表？提交后就撤不回来了。' : '确认发出上面这段内容？发出后就收不回来了。'}</p><ol class="ib-options"><li class="ib-opt on" data-ib-confirm="1"><span class="ib-caret">❯</span><kbd>1</kbd><span class="ib-opt-label">${m.final ? '确认提交' : '确认发送'}</span></li><li class="ib-opt" data-ib-cancel="1"><span class="ib-caret">❯</span><kbd>2</kbd><span class="ib-opt-label">再想想</span></li></ol></div>`;
  if (m.kind === 'confirm') {
    const pv = m.preview || {};
    if (pv.kind === 'record') return `<div class="ib-sub ib-confirm"><p class="ib-sub-q">${esc(pv.text)}</p><ol class="ib-options"><li><button type="button" class="ib-opt ${hi === 0 ? 'on' : ''}" data-ib-confirm="1" ${busy ? 'disabled' : ''}><span class="ib-caret" aria-hidden="true">❯</span><kbd aria-hidden="true">1</kbd><span class="ib-opt-label">确认记录</span></button></li><li><button type="button" class="ib-opt ${hi === 1 ? 'on' : ''}" data-ib-cancel="1" ${busy ? 'disabled' : ''}><span class="ib-caret" aria-hidden="true">❯</span><kbd aria-hidden="true">2</kbd><span class="ib-opt-label">取消</span></button></li></ol></div>`;
    const rows = pv.kind === 'queue_apply' ? (pv.rows || []).map(r => `<li><b>#${esc(r.number)} ${esc(r.company)}</b> · ${esc(r.role)}${r.city ? ' · ' + esc(r.city) : ''} <span class="muted">${esc(r.channel || '')}${r.reason ? ' · ' + esc(r.reason) : ''}</span>${r.warn ? `<p class="ib-warn">${esc(r.warn)}</p>` : ''}</li>`).join('') : (pv.drafts || []).map(d => `<li><b>#${esc(d.number)} ${esc(d.company || '')}</b> → ${esc(d.to || '')}<div class="ib-preview-body small">${esc(short(d.body, 400))}</div></li>`).join('');
    const fields = m.fields?.length ? `<div class="ib-fields"><p class="muted small">系统会按这些资料填写（来自你的个人资料）：</p><table class="mini-table"><tbody>${m.fields.map(f => `<tr><td class="muted">${esc(f.label || f.key)}</td><td>${esc(short(f.value, 160))}</td></tr>`).join('')}</tbody></table></div>` : '';
    return `<div class="ib-sub ib-confirm"><p class="ib-sub-q">${pv.kind === 'queue_apply' ? '确认投递？' : '确认发送？'}</p><ul class="ib-confirm-rows">${rows || '<li class="muted">（没有可预览的内容）</li>'}</ul>${pv.missing?.length ? `<p class="ib-warn">这些编号现在不能处理：${pv.missing.map(esc).join('、')}</p>` : ''}${fields}<ol class="ib-options"><li class="ib-opt on" data-ib-confirm="1"><span class="ib-caret">❯</span><kbd>1</kbd><span class="ib-opt-label">${pv.kind === 'queue_apply' ? ((pv.rows || []).some(r => r.warn) ? '确定要投' : '确认投递') : '确认发送'}</span></li><li class="ib-opt" data-ib-cancel="1"><span class="ib-caret">❯</span><kbd>2</kbd><span class="ib-opt-label">取消</span></li></ol></div>`;
  }
  return '';
}

// 进行中：你拍板之后的事走到哪一步（和指挥台同一份数据）。有下一步要你做的，点一下直接跳到那一封。
// 哪一条：#编号 公司 · 做什么。你交代的事没有公司（10-01 第 1 轮验收第 26 条：行首空着只剩「· 帮我查一下…」）：前面写在做的那位。
// 做什么里已经点了这条（「给 #6 Contoso 写一封求职信」）：只写这一句，编号加粗，不在前面再说一遍公司（10-01 第 2 轮验收第 30 条）。
const flightWho = i => { const tag = i.number != null ? new RegExp(`#${i.number}(?!\\d)`) : null; if (i.what && tag?.test(i.what)) return esc(i.what).replace(tag, m => `<b>${m}</b>`); const head = i.number != null || i.company ? `${i.number != null ? `<b>#${esc(i.number)}</b> ` : ''}${esc(i.company || '')}`.trim() : i.member ? `<b>${esc(h.crewName(i.member))}</b>` : ''; return [head, i.what ? esc(i.what) : ''].filter(Boolean).join(' · '); };
function accountsHtml() {
  const rows = (view.accounts || []);
  const state = a => a.logged_in === true ? `<span class="tag green">${a.confirmed_days_ago >= 1 ? '上次确认已登录' : '已登录'}</span>` : a.logged_in === false ? `<span class="tag red">${a.maybe_out ? '可能掉线了' : '没登录'}</span>` : '<span class="tag">还没核实</span>';
  const kind = { service: '服务授权', platform: '招聘平台', portal: '公司招聘站' };
  // 一个账号一行（原来是一张五列的表：开着对话栏时「类型」「状态」被挤成一字一行，按钮挤出了卡片）。
  const row = a => `<div class="ib-acct ${a.logged_in === false ? 'is-out' : ''}"><div class="ib-acct-name"><b>${esc(a.label)}</b><span class="muted small">${kind[a.kind] || esc(a.kind)}${a.hosts?.length > 1 ? ` · ${a.hosts.length} 个站点共用一个账号` : ''}</span></div><div class="ib-acct-state">${state(a)}${a.waiting ? ` <b class="ib-acct-wait">${a.waiting} 项在等</b>` : ''}${a.verified_at ? `<div class="muted small">上次确认 ${a.confirmed_days_ago >= 1 ? `${a.confirmed_days_ago} 天前 · ` : ''}${esc(when(a.verified_at))}${a.confirmed_days_ago >= 1 ? '；当前登录可能已变化' : ''}</div>` : ''}${a.auto_check?.at && (!a.verified_at || Date.parse(a.auto_check.at) >= Date.parse(a.verified_at)) ? `<div class="muted small">系统 ${esc(when(a.auto_check.at))} 自动看过：${esc(a.auto_check.logged_in ? '已登录' : a.auto_check.reason || '没登录')}</div>` : ''}</div><div class="ib-acct-actions">${a.kind === 'service' ? '' : `${a.login_url ? `<button type="button" class="secondary mini" data-ib-open="${esc(a.login_url)}" data-ib-acct="${esc(a.key || '')}">打开登录页</button>` : ''}<button type="button" class="secondary mini" data-ib-check="${esc(a.key)}">重新检查</button><button type="button" class="secondary mini" data-ib-ready="${esc(a.key)}">我登好了</button>`}</div></div>`;
  return `<div class="panel ib-panel ib-accts">${rows.map(a => row(a) + (a.key === 'linkedin' ? `<div class="ib-acct-note">${linkedinInboxHtml({ loggedIn: a.logged_in })}</div>` : '')).join('')}</div>`;
}

// ── 交互 ─────────────────────────────────────────────────────────────────────
function repaint({ focus = false } = {}) {
  const main = document.querySelector('#main');
  if (!main || main.dataset.page !== 'inbox') return;
  morph(main, html());
  bindInbox();
  // 两栏时只滚右边这一栏回到信的开头，整页不动；上下排（窄窗口、手机）时把信滚进视野。
  if (focus) { const f = main.querySelector('.ib-focus'); if (f && getComputedStyle(f).overflowY === 'auto') f.scrollTop = 0; else { const ask = main.querySelector('.ib-ask'); if (ask && ask.getBoundingClientRect().top < 0 || ask?.getBoundingClientRect().top > innerHeight * 0.6) ask.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }
  // 选中的那一件只在列表自己里面滚进视野（scrollIntoView 会连整页一起滚：上下排时列表在信下面，页头就滚出去了）。
  const on = main.querySelector('.ib-item.on'), list = main.querySelector('.ib-list');
  if (on && list) { const r = on.getBoundingClientRect(), b = list.getBoundingClientRect(); if (r.top < b.top) list.scrollTop -= b.top - r.top + 30; else if (r.bottom > b.bottom) list.scrollTop += r.bottom - b.bottom; }
}
function select(id) { currentId = id; hi = 0; mode = null; repaint({ focus: true }); }
function step(d) { const list = visible(), a = current(); if (!list.length) return; const i = Math.max(0, Math.min(list.length - 1, list.indexOf(a) + d)); select(list[i].id); }

async function answer(a, option, extra = {}) {
  if (busy) return;
  busy = true;
  answerFeedback = { ask: a.id, kind: 'pending', text: a.type === 'login' && extra.confirm ? '正在检查登录…' : '正在处理…' };
  repaint();
  try {
    const r = await h.post('/api/inbox/answer', { id: a.id, option, ...(a.preview?.fingerprint ? { fingerprint: a.preview.fingerprint } : {}), ...extra });
    answerFeedback = null;
    if (r.needs_confirm) {
      mode = { kind: 'confirm', ask: a.id, option, extra, preview: r.preview, fingerprint: r.fingerprint };
      hi = 0;
      if (r.preview?.kind === 'queue_apply' && a.form_preview) {
        try { const f = await fetch('/api/application-plan?id=' + encodeURIComponent(a.form_preview)); const v = await f.json(); if (f.ok) mode.fields = (v.fields || []).slice(0, 14); } catch {}
      }
      return repaint();
    }
    if (r.client?.draft_editor) { mode = null; repaint(); return openDraftEditor(r.client.draft_editor); }
    if (r.client?.navigate) { mode = null; location.hash = r.client.navigate; return; }
    // 「补充…」「补信息」：打开个人资料编辑器的那一组（和指挥台、岗位页同一个，web/setup.js）；信留着，补完相关的重新判断。
    if (r.client?.profile_editor) { mode = null; repaint(); return openEditor(r.client.profile_editor, h, r.client.profile_context); }
    mode = null;
    // 要你打开的页面（登录页、申请页、岗位链接落空时这家公司的职位列表）是一个按钮，不把链接印在回执里。
    const open = (r.open || [])[0];
    const openBtn = open ? { label: open.label || '打开', run: () => h.post('/api/open-url', { url: open.url }).then(x => h.toast(x.receipt || '已在浏览器里打开')).catch(e => h.toast(e.message)) } : null;
    if (r.done === false) { opened.set(a.id, r.receipt || '已打开'); h.toast(r.receipt || '已打开', openBtn); repaint({ focus: true }); h.refresh(); return; }
    done.set(a.id, r.receipt || '已处理');
    h.toast(r.receipt || '已处理', openBtn);
    const next = visible()[0];
    currentId = next?.id || null; hi = 0;
    repaint({ focus: true });
    h.refresh();
  } catch (e) {
    answerFeedback = { ask: a.id, kind: 'error', text: e.message || '没能处理，请重试' };
    h.toast(answerFeedback.text);
  } finally {
    busy = false;
    repaint();
  }
}

function choose(a, i) {
  const o = optionsOf(a)[i];
  if (!o) return;
  // 绿框先跟到点的、按的这一项（以前只有上下键会重画，点了、按数字键框还停在第一个）。
  hi = i;
  document.querySelectorAll('.ib-options [data-ib-i]').forEach(li => { const on = Number(li.dataset.ibI) === i; li.classList.toggle('on', on); li.setAttribute('aria-selected', String(on)); });
  // 站外的页面（买补给）：点下去当场在浏览器里打开，不经过服务器。
  if (o.href && /^https:\/\//.test(o.href)) { window.open(o.href, '_blank', 'noopener'); return; }
  if (o.other) { document.querySelector('.ib-other-input')?.focus(); hi = i; return; }
  if (o.reasons?.length) { mode = { kind: 'reason', ask: a.id, option: o.key, label: o.label, reasons: o.reasons }; hi = 0; return repaint(); }
  if (o.input === 'datetime') { mode = { kind: 'datetime', ask: a.id, option: o.key }; repaint(); document.querySelector('.ib-dt')?.focus(); return; }
  if (o.input === 'url') { mode = { kind: 'url', ask: a.id, option: o.key }; repaint(); document.querySelector('.ib-url')?.focus(); return; }
  if (o.input === 'fields') { mode = { kind: 'fields', ask: a.id, option: o.key }; if (document.querySelector('[data-ib-field]')) return submitFields(); repaint(); document.querySelector('[data-ib-field]')?.focus(); return; }
  if (o.confirm_inline || o.steps?.some(s => s.confirm === 'inline')) { mode = { kind: 'confirm_send', ask: a.id, option: o.key, final: !!o.confirm_inline }; hi = 0; return repaint(); }
  answer(a, o.key);
}

// 「材料变了」「批准很久了」里的投递（实测 10-04 第 10 条：16 封只能一封一封点）：在这一组里一次确认。
// 每一条照旧按现在的内容重新绑指纹（服务端 answerMany：先算这一条现在的预览，再按它的指纹确认），不是拿一个空确认放行。
// 只有投递：发信、私信还是一封一封看着全文发。
const reconfirmable = items => items.filter(a => (a.kind === 'reapprove' && a.options?.[0]?.label === '按新材料投递') || (a.kind === 'stale' && a.options?.[0]?.label === '投递'));
async function reconfirmAll() {
  const items = reconfirmable(visible());
  if (!items.length) return;
  const lines = items.slice(0, 20).map(a => `${a.title}${a.changes?.length ? '：' + a.changes.join('；') : ''}`).join('\n') + (items.length > 20 ? `\n……还有 ${items.length - 20} 条` : '');
  if (!(await askConfirm({ title: `按现在的材料确认这 ${items.length} 条投递？`, lines: ['确认以后系统按现在的材料预填，停在提交前，提交还要你看过。', ...lines.split('\n')], go: `确认 ${items.length} 条` }))) return;
  h.toast(`正在确认 ${items.length} 条；离开页面也会做完`);
  let ok = 0, failed = [];
  for (let i = 0; i < items.length; i += 50) {
    try { const r = await h.post('/api/inbox/answer', { ids: items.slice(i, i + 50).map(a => a.id), option: '1', confirm: true }); ok += r.ok; for (const x of r.results || []) x.ok ? done.set(x.id, '已按现在的材料确认') : failed.push(x); }
    catch (e) { failed.push({ error: e.message }); break; }
  }
  h.toast(`已确认 ${ok} / ${items.length} 条${failed.length ? `；${failed.length} 条没成：${failed[0].error}` : ''}`);
  currentId = visible()[0]?.id || null; repaint(); h.refresh();
}
async function batch(which) {
  if (which === 'reconfirm') return reconfirmAll();
  const items = visible().filter(a => a.type === 'followup');
  if (!items.length || !(await askConfirm(which === '1' ? { title: `给这 ${items.length} 条都准备一段跟进？`, lines: ['只起草，发送前仍给你看。'], go: '都准备' } : { title: `这 ${items.length} 条都不再提醒跟进？`, lines: ['以后不再为它们问你，要跟进得自己记着。'], go: '都不提醒' }))) return;
  // 一次交给服务端：它一条条做完（约 3 秒一条），关掉或刷新页面也不会停在半路；做完一条列表就少一条。
  h.toast(`正在处理 ${items.length} 条，约 ${items.length * 3} 秒；离开页面也会做完`);
  try {
    const r = await h.post('/api/inbox/answer', { ids: items.map(a => a.id), option: which });
    for (const x of r.results || []) if (x.ok) done.set(x.id, which === '1' ? '已安排跟进' : '不再提醒');
    const failed = (r.results || []).filter(x => !x.ok);
    h.toast(`已处理 ${r.ok} / ${r.total} 条${failed.length ? `；${failed.length} 条没成：${failed[0].error}` : ''}`);
  } catch (e) { h.toast(e.message); }
  currentId = visible()[0]?.id || null; repaint(); h.refresh();
}

// 选中的这封挂在哪个岗位上：对话里的「正在看 #12」跟着它（web/hq.js setViewing → oc:viewing）。
// 从别的页换回收件箱、页面是原样放回去的（web/app.js restorePage）时也报一次。
const lr = a => a?.lead?.rid || a?.lead?.record_id || null;
export function inboxShown() { const cur = current(); setViewing(lr(cur) ? { ...cur.lead, rid: lr(cur) } : null); }
export function bindInbox() {
  const root = document.querySelector('#main');
  if (!root) return;
  bindLinkedinInbox(root, h);
  inboxShown();
  // 去岗位页：「←」回收件箱（选中的这封、筛选都留着），‹ › 按这张表上挂着岗位的信的顺序翻。
  root.querySelectorAll('.ib-focus a[href^="#lead/"]').forEach(x => x.onclick = () => { const rid = decodeURIComponent(x.getAttribute('href').slice(6)); setLeadOrigin({ hash: '#inbox', label: '收件箱', list: [...new Set(visible().map(lr).filter(Boolean))], rid }); });
  root.querySelectorAll('[data-ib-filter]').forEach(b => b.onclick = e => { e.preventDefault(); filter = b.dataset.ibFilter; currentId = null; hi = 0; mode = null; try { localStorage.setItem('radar.inbox.filter', filter); } catch {} repaint(); });
  root.querySelectorAll('[data-ib-ask]').forEach(b => b.onclick = () => select(b.dataset.ibAsk));
  root.querySelectorAll('[data-ib-goto]').forEach(b => b.onclick = () => { filter = 'all'; currentId = b.dataset.ibGoto; hi = 0; mode = null; repaint({ focus: true }); });
  root.querySelectorAll('[data-ib-step]').forEach(b => b.onclick = () => step(Number(b.dataset.ibStep)));
  root.querySelectorAll('[data-ib-i]').forEach(li => li.onclick = e => { if (e.target.closest('input,button')) return; const a = current(); hi = Number(li.dataset.ibI); choose(a, hi); });
  root.querySelectorAll('[data-ib-reason]').forEach(li => li.onclick = () => pickReason(Number(li.dataset.ibReason)));
  root.querySelectorAll('[data-ib-confirm]').forEach(li => li.onclick = () => confirmNow());
  root.querySelectorAll('[data-ib-cancel]').forEach(li => li.onclick = () => { mode = null; answerFeedback = null; hi = 0; repaint(); });
  root.querySelectorAll('[data-ib-dt]').forEach(b => b.onclick = () => submitDatetime());
  root.querySelectorAll('[data-ib-url]').forEach(b => b.onclick = () => submitUrl());
  const urlBox = root.querySelector('.ib-url'); if (urlBox) urlBox.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submitUrl(); } };
  root.querySelectorAll('[data-ib-fields]').forEach(b => b.onclick = () => submitFields());
  root.querySelectorAll('[data-ib-send-other]').forEach(b => b.onclick = () => submitOther());
  root.querySelectorAll('[data-ib-form]').forEach(b => b.onclick = () => showForm(b.dataset.ibForm));
  root.querySelectorAll('[data-ib-batch]').forEach(b => b.onclick = () => batch(b.dataset.ibBatch));
  root.querySelectorAll('[data-ib-open]').forEach(b => b.onclick = async () => { try { const r = await h.post('/api/open-url', { url: b.dataset.ibOpen, account: b.dataset.ibAcct || null }); h.toast(r.receipt || '已在浏览器里打开'); } catch (e) { h.toast(e.message); } });
  root.querySelectorAll('[data-ib-check]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await h.post('/api/account-ready', { account: b.dataset.ibCheck, check_only: true }); h.toast(r.receipt); h.refresh(); } catch (e) { h.toast(e.message); } finally { b.disabled = false; } });
  root.querySelectorAll('[data-ib-ready]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await h.post('/api/account-ready', { account: b.dataset.ibReady, confirm: b.dataset.confirmed === '1' }); if (r.needs_confirm) { b.dataset.confirmed = '1'; b.textContent = '确认已登录并继续'; const info = document.createElement('p'); info.className = 'small'; info.textContent = r.preview.text; b.parentElement.append(info); b.disabled = false; return; } h.toast(r.receipt || '已记下'); h.refresh(); } catch (e) { h.toast(e.message); b.disabled = false; } });
  const input = root.querySelector('.ib-other-input');
  if (input) { input.onfocus = () => { hi = optionsOf(current()).findIndex(o => o.other); root.querySelectorAll('.ib-opt').forEach((x, i) => x.classList.toggle('on', i === hi)); }; }
  // 深链进来的那一件：列表滚到它（只滚列表自己），地址换回 #inbox；闪的样子留到下一次重画。
  if (flash) {
    const list = root.querySelector('.ib-list'), it = list?.querySelector('.ib-item.is-flash');
    if (list && it) list.scrollTop += it.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - it.offsetHeight) / 2;
    if (/[?&](?:ask|tab)=/.test(location.hash)) { history.replaceState(null, '', '#inbox'); root.dataset.renderHash = location.hash; }
    flash = null;
  }
}
function pickReason(i) {
  const a = current(); if (!a || mode?.kind !== 'reason') return;
  const reasons = [...mode.reasons, '不填原因'];
  answer(a, mode.option, { reason: i < mode.reasons.length ? reasons[i] : '' });
}
function confirmNow() {
  const a = current(); if (!a || !mode) return;
  if (mode.kind === 'confirm') return answer(a, mode.option, { ...(mode.extra || {}), confirm: mode.fingerprint || true, ...(mode.fingerprint ? { fingerprint: mode.fingerprint } : {}) });
  if (mode.kind === 'confirm_send') return answer(a, mode.option);
}
function submitFields() {
  const a = current(); if (!a || mode?.kind !== 'fields') return;
  const values = {};
  document.querySelectorAll('[data-ib-field]').forEach(el => { values[el.dataset.ibField] = el.value.trim(); });
  const missing = (a.form || []).find(f => !values[f.key]);
  if (missing) return h.toast(`「${missing.label}」还没填`);
  answer(a, mode.option, { fields: values });
}
function submitUrl() {
  const a = current(), v = document.querySelector('.ib-url')?.value?.trim();
  if (!/^https?:\/\//.test(v || '')) return h.toast('贴一个以 http 开头的链接');
  answer(a, mode.option, { text: v });
}
function submitDatetime() {
  const a = current(), v = document.querySelector('.ib-dt')?.value;
  if (!v) return h.toast('请选择时间');
  answer(a, mode.option, { datetime: v.replace('T', ' ') });
}
function submitOther() {
  const a = current(), v = document.querySelector('.ib-other-input')?.value?.trim();
  if (!v) return h.toast('请写点什么');
  answer(a, 'other', { text: v });
}
async function showForm(id) {
  try {
    const r = await fetch('/api/application-plan?id=' + encodeURIComponent(id)), v = await r.json();
    if (!r.ok) throw Error(v.error);
    const box = document.querySelector('.ib-detail');
    if (box) { box.open = true; box.insertAdjacentHTML('beforeend', `<div class="ib-fields"><p class="muted small">拟填内容（来自你的个人资料${v.resume ? ' · 简历 ' + esc(v.resume.split('/').pop()) : ''}）${v.error ? ` <span class="tag red">现在还投不了：${esc(v.error)}</span>` : ''}</p><table class="mini-table"><tbody>${(v.fields || []).map(f => `<tr><td class="muted">${esc(f.label || f.key)}</td><td>${esc(short(f.value, 200))}</td></tr>`).join('') || '<tr><td class="muted">没有可填字段</td></tr>'}</tbody></table></div>`); }
  } catch (e) { h.toast(e.message); }
}

// 键盘：只在收件箱页、没有弹窗时生效；在输入框里只接 Enter / Esc。
let keysBound = false;
export function bindInboxKeys() {
  if (keysBound) return; keysBound = true;
  document.addEventListener('keydown', e => {
    const main = document.querySelector('#main');
    if (!main || main.dataset.page !== 'inbox' || document.querySelector('dialog[open]') || filter === 'accounts') return;
    const a = current(); if (!a) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (typing) {
      if (e.key === 'Enter' && document.activeElement.classList.contains('ib-other-input')) { e.preventDefault(); submitOther(); }
      if (e.key === 'Enter' && document.activeElement.classList.contains('ib-dt')) { e.preventDefault(); submitDatetime(); }
      if (e.key === 'Enter' && document.activeElement.dataset?.ibField != null && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); submitFields(); }
      if (e.key === 'Escape') { document.activeElement.blur(); mode = null; repaint(); }
      return;
    }
    if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
    // 记录确认用原生按钮：Tab 聚焦取消后，Enter / Space 应触发那个按钮。
    if (['Enter', ' '].includes(e.key) && document.activeElement?.matches('button[data-ib-confirm],button[data-ib-cancel]')) return;
    const sub = mode && mode.ask === a.id ? mode : null;
    const n = sub?.kind === 'reason' ? sub.reasons.length + 1 : sub?.kind === 'confirm' || sub?.kind === 'confirm_send' ? 2 : sub ? 0 : optionsOf(a).length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!n) return; e.preventDefault(); hi = (hi + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; repaint(); if (sub?.preview?.kind === 'record') document.querySelector(hi === 0 ? 'button[data-ib-confirm]' : 'button[data-ib-cancel]')?.focus(); return; }
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); return step(1); }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); return step(-1); }
    if (e.key === 'Escape') { if (sub) { mode = null; answerFeedback = null; hi = 0; repaint(); } return; }
    if (e.key === '/') { const i = optionsOf(a).findIndex(o => o.other); if (i >= 0 && !sub) { e.preventDefault(); hi = i; repaint(); document.querySelector('.ib-other-input')?.focus(); } return; }
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : null;
    if (digit != null && digit < n) { e.preventDefault(); hi = digit; }
    else if (e.key !== 'Enter') return;
    else e.preventDefault();
    if (sub?.kind === 'reason') return pickReason(hi);
    if (sub?.kind === 'confirm' || sub?.kind === 'confirm_send') return hi === 0 ? confirmNow() : (mode = null, answerFeedback = null, hi = 0, repaint());
    if (sub) return;
    choose(a, hi);
  });
}
export function initInboxFilter() { try { filter = localStorage.getItem('radar.inbox.filter') || 'all'; } catch {} if (filter === 'inflight') filter = 'all'; }
