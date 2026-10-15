// 团队页和成员工作台（2026-09-30，负责人：成员不能只剩对话，「还是要保留传统的软件入口」）。
//   #team        六张成员卡：脸、名字、岗位、一句状态、等你几件、「立即跑一轮」
//   #team/<id>   一位成员：先操作与管理，Radar 先贴链接、招聘源和联系人；再看正在做、等你、做出来的与最近结果，最后运行日志。
//   面板里不放这些（负责人 09-30：面板只是对话）；点面板团队一排的头像就到这一页。
// 数据来自 GET /api/team、/api/team/<id>（lib/crew-desk.mjs）；按钮走 POST /api/team/run（跑一项）和 /api/agent（暂停 / 恢复）。
// 每个按钮都直接跑脚本，不经过对话：模型用不了的时候，标着「要模型」的那几项写出原因、不跑，其余照常。
// 页面上的 HTML 都由下面几个纯函数拼（teamListHtml / deskHtml / memberTopHtml / doneHtml），不碰 DOM，测试直接 import。
import { faceHtml } from './crew-faces.js';
import { dayIn } from './vocab.js';
import { morph } from './morph.js';
import { href, externalLink } from './routes.js';

const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 脸上的点：只有出错（红）才有。「等你」只说一次，就是状态那一行的琥珀色标签（10-01：以前橙点、右上角「等你 N」、
// 「等你」标签、正文「N 件等你：」一张卡说四遍）。
const DOT = { error: 'warn' };
// 从 started_at 到现在多久（页面上每 20 秒更新一次，data-since 的元素）。
export const elapsed = (at, now = Date.now()) => { const m = Math.max(0, Math.round((now - Date.parse(at)) / 60000)); return !Number.isFinite(m) ? '' : m < 1 ? '刚开始' : m < 60 ? `已 ${m} 分钟` : `已 ${Math.floor(m / 60)} 小时 ${m % 60} 分钟`; };
const since = at => at ? `<span class="td-since" data-since="${esc(at)}">${esc(elapsed(at))}</span>` : '';
const inboxHref = h => esc(h || '#inbox');

// 沙盒那句（「演示 / 沙盒模式不调用模型」）不在团队页上一项项再写：左上角的「演示 / 沙盒模式」已经说了（负责人 10-02：不重复占注意力）。
const sandboxy = t => /演示 \/ 沙盒/.test(String(t || ''));
// ── 团队页：六张卡 ───────────────────────────────────────────────────────────
const foundHtml = f => f?.text ? `<span class="td-line td-found" title="${esc(f.text)}"><span class="td-state${f.stale ? ' is-stale' : ''}">${esc(f.tag)}</span>${esc(f.text)}</span>` : '';
export function teamListHtml(v = {}, ui = {}) {
  const busy = ui.busy || new Set();
  const members = v.members || [];
  const model = v.caps?.model;
  const note = model && !model.ok && !sandboxy(model.why) ? `<div class="td-note"><b>模型现在用不了</b>：${esc(model.why)}</div>` : '';
  // 一次只跑一个：运行中的操作和原因写出来，其他成员按钮暂时禁用。
  const cur = v.running_op || null, held = !cur && v.busy_line ? v.busy_line : '';
  const busyNote = cur ? `<div class="td-busy td-busy-top">${esc(cur.name)} 的「${esc(cur.label)}」在跑（${since(cur.started_at)}），一次只跑一个</div>` : held ? `<div class="td-busy td-busy-top">${esc(held)}</div>` : '';
  const cards = members.map(m => {
    const dot = DOT[m.status?.key] || null, r = m.round;
    const run = !r ? '' : r.queued ? `<button type="button" class="secondary td-run" data-team-cancel="${esc(r.queued.id)}">取消排队</button>`
      : `<button type="button" class="secondary td-run" data-team-run="${esc(m.key)}" data-op="${esc(r.key)}" data-heavy="${r.heavy ? 1 : ''}" data-usual="${esc(r.usual)}" ${r.running || r.busy || r.can_run === false || busy.has(r.key) ? 'disabled' : ''}>${r.running ? '在跑…' : '▶ 立即跑一轮'}</button>`;
    // 排着的「立即跑一轮」、排着却没跑的（开跑前没过闸）：卡上一行状态。
    const qline = r?.queued ? `<span class="td-line"><span class="td-state is-queued">排队</span>${esc(r.queued.line)}</span>` : r?.dropped ? `<span class="td-line" title="${esc(r.dropped.why)}"><span class="td-state is-error">没跑</span>${esc(r.dropped.why)}</span>` : '';
    const text = String(m.status?.text || '').replace(/^空闲 · /, '');
    // Radar：上次找到岗位是什么时候（lib/discover-fresh.mjs discoverLine）；太久没找换成提醒的颜色。
    const found = foundHtml(m.found);
    return `<article class="td-card is-${esc(m.status?.key || 'idle')}${m.paused ? ' is-paused' : ''}" data-member="${esc(m.key)}">
      <a class="td-card-main" href="#team/${esc(m.key)}">
        <span class="td-card-head">${faceHtml(m.face, { size: 40, dot, dotTitle: m.status?.label })}<span><b class="td-name">${esc(m.name)}</b><small>${esc(m.title)} · ${esc(m.group)}</small></span></span>
        <span class="td-line" title="${esc(text)}"><span class="td-state is-${esc(m.status?.key || 'idle')}">${esc(m.status?.label || '空闲')}</span>${esc(text)}${m.status?.since ? ` · ${since(m.status.since)}` : ''}</span>${m.waiting && m.status?.key !== 'waiting' && m.wait_title ? `<span class="td-line" title="${esc(m.wait_title)}"><span class="td-state is-waiting">${m.waiting > 1 ? `等你 ${esc(m.waiting)}` : '等你'}</span>${esc(m.wait_title)}</span>` : ''}
${qline}${found}${r?.why_not && !r.running && !sandboxy(r.why_not) ? `<span class="td-line">${esc(r.why_not)}</span>` : ''}
        <span class="td-duty" title="${esc(m.duty)}">${esc(m.duty)}</span>
      </a>
      <div class="td-card-foot">${run}${r?.can_run === false && !r.busy ? goLink(r.go) : ''}${ui.confirm === r?.key ? confirmHtml(r, m.key) : ''}${m.status?.log ? `<a class="td-open" href="${esc(m.status.log.href)}">${esc(m.status.log.label)}</a>` : ''}<a class="td-open" href="#team/${esc(m.key)}">打开 →</a></div>
    </article>`;
  }).join('');
  return `<div class="page-heading"><div><h1>团队</h1></div></div>${note}${busyNote}<div class="td-grid">${cards || '<div class="empty">没有读到成员</div>'}</div>`;
}

// ── 一位成员 ─────────────────────────────────────────────────────────────────
// ui：{ confirm: 要确认的操作 key, busy: Set<op> }
function opButton(o, member, ui = {}, { compact = false } = {}) {
  const busy = ui.busy?.has(o.key);
  if (o.running) return `<button type="button" class="td-go is-running" disabled>在跑… ${since(o.started_at)}</button>`;
  if (o.queued) return `<button type="button" class="td-go is-queued" data-team-cancel="${esc(o.queued.id)}">取消排队</button>`;
  if (o.busy || !o.can_run && o.why_not) return `<button type="button" class="td-go" disabled title="${esc(o.why_not)}">▶ ${compact ? esc(o.label) : '运行'}</button>`;
  return `<button type="button" class="td-go${compact ? '' : ' is-primary'}" data-team-run="${esc(member)}" data-op="${esc(o.key)}" data-heavy="${o.heavy ? 1 : ''}" data-usual="${esc(o.usual)}" ${busy ? 'disabled' : ''}>${busy ? '正在开始…' : `▶ ${compact ? esc(o.label) : '运行'}`}</button>`;
}
// 排着的那一项：「排队」+ 那一句（服务端给的），前面还排着几个也写上。
const queuedHtml = q => `<span class="td-queued"><span class="td-state is-queued">排队</span>${esc(q.line)}${q.ahead ? ` · 前面还有 ${esc(q.ahead)} 个` : ''}</span>`;
function confirmHtml(o, member) {
  return `<div class="td-confirm" role="alertdialog" aria-label="确认运行"><span>「${esc(o.label)}」${esc(o.usual)}，${esc(o.max)}${o.need === 'some' ? '，有几步会调模型' : o.need ? '，会调模型' : ''}。${o.busy ? '排在这一轮后面跑？' : '现在跑？'}</span><button type="button" class="primary" data-team-yes="${esc(member)}" data-op="${esc(o.key)}">确定跑</button><button type="button" class="secondary" data-team-no>算了</button></div>`;
}
// 跑不了、或者上次没读成时给的入口（服务端给 { label, href }，比如「接上邮箱」）。
const goLink = g => g?.href ? ` <a class="td-link" href="${esc(g.href)}">${esc(g.label)}</a>` : '';
function opRowHtml(o, member, ui, group = '') {
  const tags = [o.need_label ? `<span class="td-tag${o.need === 'some' ? ' is-soft' : ''}">${esc(o.need_label)}</span>` : '', ''].join('');
  const state = o.running ? `<span class="td-run-now">正在跑 ${since(o.started_at)}</span>` : o.queued ? queuedHtml(o.queued) : '';
  const why = !o.can_run && o.why_not && !o.running && !sandboxy(o.why_not) ? `<div class="td-why">跑不了：${esc(o.why_not)}${goLink(o.go)}</div>` : o.note && !sandboxy(o.note) ? `<div class="td-why is-soft">${esc(o.note)}</div>` : '';
  return `<li class="td-op${o.running ? ' is-running' : ''}" data-op-row="${esc(o.key)}"><div class="td-op-main"><div class="td-op-t"><b>${esc(o.label)}</b>${tags}</div><div class="td-op-d">${esc(o.desc)}</div><div class="td-op-m">${group ? `<span>${esc(group)}</span>` : ''}<span>${esc(o.usual)}</span>${state}</div>${why}</div>${opButton(o, member, ui)}${ui.confirm === o.key && ui.confirmAt !== 'head' ? confirmHtml(o, member) : ''}</li>`;
}
const cardTag = t => t.from_name ? `<span class="td-from">来自 ${esc(t.from_name)}</span>` : t.to_name ? `<span class="td-from">→ ${esc(t.to_name)}</span>` : '';
const fullText = t => t.full ? `<details class="td-full"><summary>全文</summary><p>${esc(t.full)}</p></details>` : '';
const taskRow = (t, tone = '') => `<li class="td-task${tone ? ' is-' + tone : ''}"><div>${cardTag(t)}<b>${t.href ? `<a href="${inboxHref(t.href)}">${esc(t.title)}</a>` : t.rid ? `<a href="#lead/${encodeURIComponent(t.rid)}">${esc(t.title)}</a>` : esc(t.title)}</b>${t.step ? `<small>${esc(t.step)}</small>` : ''}${t.ask && t.ask !== t.title ? `<small>${esc(t.ask)}</small>` : ''}${t.result ? `<small>${esc(t.result)}</small>` : ''}${fullText(t)}</div><span class="td-when">${t.since ? since(t.since) : esc(t.time || t.ago || '')}${t.run_id ? ` <a class="td-link" href="${esc(href.stream({ run: t.kind === 'op' ? `ops-${t.run_id}` : t.run_id }))}">日志</a>` : ''}</span></li>`;
export function tasksHtml(tasks = {}, { limit = 8 } = {}) {
  const part = (title, rows, tone, empty) => `<div class="td-sub"><h4>${esc(title)}${rows.length ? ` <i>${rows.length}</i>` : ''}</h4>${rows.length ? `<ul class="td-tasks">${rows.slice(0, limit).map(t => taskRow(t, tone)).join('')}</ul>` : `<p class="td-empty">${esc(empty)}</p>`}</div>`;
  return part('现在在做', tasks.running || [], 'run', '手上没有在跑的')
    + part('等你', (tasks.waiting || []).filter(t => t.type !== '卡住了'), 'wait', '没有等你的事')
    + ((tasks.waiting || []).some(t => t.type === '卡住了') ? part('没做成', tasks.waiting.filter(t => t.type === '卡住了'), 'bad', '') : '')
    + part('排队', tasks.queued || [], '', '没有排队的')
    + part('今天做完的', tasks.done || [], 'ok', '今天还没做完什么')
    + ((tasks.passed || []).length ? part('交出去的', tasks.passed, '', '') : '');
}
// 每节下面那一行只留有数的事实（「近 7 天找到 27 条…」「这一轮 02:08 跑完」）；解释这一节是什么的话不写（界面自己会说话）。
// 「更多」里的每一节：常开，右上角「全部 →」去放着完整清单的那一页（10-01 #19：以前默认折叠、一刷新就收起来）。
// 每一节的「全部 →」：指到能看全这一节的那一页（链接从 lib/routes.mjs 那张表拼）。没有完整列表的那几节（联系人）不给「全部」，
// 不把人带到一个对不上的页（实测 B12：联系人「全部」到了指挥台，「在路上」「没发成的」到了收件箱首页）。
const SECTION_HREF = {
  found_today: href.jobs(), on_hand: href.command({ tab: 'new' }), last_round: href.stream({ flow: 'scout' }), last_judge: href.stream({ flow: 'lens' }), research: href.tasks({ owner: 'lens' }),
  resumes: href.materials(), tailoring: href.materials(), on_the_way: href.stream({ flow: 'quill' }), sent_today: href.stream({ flow: 'quill' }), failed: href.stream({ flow: 'fail' }),
  interviews: href.command({ tab: 'interview' }), replies: href.command({ tab: 'waiting' }), mail_patrol: href.stream({ flow: 'owl' }), mail: href.stream({ flow: 'owl' }), now: href.stream({ flow: 'patch' }), asked: href.tasks(),
  heartbeats: href.stream({ flow: 'patch' }), next: href.stream({ flow: 'patch' }), last_cycle: href.stream({ flow: 'patch' }), repairs: href.stream({ flow: 'patch' }), alerts: href.stream({ flow: 'fail' }), services: href.settings('accounts'),
};
const sectionHref = (x, member) => ['referrers', 'on_the_way', 'failed'].includes(x.key) && x.rows?.length > 8 ? href.team(member, { section: x.key }) : x.key === 'executor' ? href.tasks({ owner: member }) : SECTION_HREF[x.key] || null;
// 行上的外部链接：服务端一律给 { url, label }（lib/team.mjs workerDetail）；老数据是一串网址也认。只开 http(s)。
const linkOf = r => externalLink(r.link);
// 一行上已经带着的操作画出来（10-01 #20）：收件箱那封信、站内页面、外部链接。
const rowActs = r => [
  r.followup && r.option ? `<button type="button" class="td-act" data-team-followup="${esc(r.followup)}" data-option="${esc(r.option)}">起草跟进</button>` : '',
  r.judge ? `<button type="button" class="td-act" data-team-judge="${esc(r.judge)}">重新判断</button>` : '',
  r.ask ? `<a class="td-act" href="${esc(href.inbox(r.ask))}">回答 →</a>` : r.inbox ? `<a class="td-act" href="${esc(r.inbox === 'accounts' ? href.accounts() : href.inbox())}">收件箱 →</a>` : '',
  r.href && !r.rid ? `<a class="td-act" href="${esc(r.href)}">${esc(r.href_label || '打开')} →</a>` : '',
  linkOf(r) ? `<a class="td-act" href="${esc(linkOf(r).url)}" target="_blank" rel="noopener noreferrer">${esc(linkOf(r).label)} ↗</a>` : '',
  // 告警：修它的去处（lib/alert-rules.mjs），和「不用管这条」（同类 24 小时内不再上来）。
  r.fix ? `<a class="td-act" href="${esc(r.fix.to)}">${esc(r.fix.label)}</a>` : '',
  r.dismiss ? `<button type="button" class="td-act" data-alert-dismiss="${esc(r.dismiss)}">不用管这条</button>` : '',
].join('');
// 行上的色调 → 小药丸的样式：老的五种，加上 lib/status.mjs 的六种状态色调（排队、进行中算在做，等你算等，做完了算好，已取消算灰）。
const TONE = { ok: 'ok', bad: 'bad', wait: 'wait', work: 'work', mute: 'mute', run: 'work', queued: 'work', you: 'wait', done: 'ok', cancel: 'mute' };
const sectionRow = r => `<li class="td-row"><div class="td-row-main"><b>${r.rid ? `<a href="#lead/${encodeURIComponent(r.rid)}">${esc(r.label || r.a)}</a>` : esc(r.label || r.a || '')}</b>${r.b && !(r.label && String(r.label).includes(r.b)) ? `<small>${esc(r.b)}</small>` : ''}${r.d ? `<small class="is-soft">${esc(r.d)}</small>` : ''}</div><div class="td-row-side">${r.tag ? `<span class="td-pill is-${TONE[r.tone] || 'mute'}">${esc(r.tag)}</span>` : ''}${r.c ? `<span class="td-when">${esc(r.c)}</span>` : ''}${rowActs(r)}</div></li>`;
// Radar 的招聘源：每一家都列出来（不折叠、不截到 6 行），能暂停、恢复、改、删（POST /api/sources）。
function sourceRow(r, ui) {
  const k = r.source, editing = ui.srcEdit === k, confirming = ui.srcDel === k, paused = r.tag === '暂停';
  const acts = !k ? rowActs(r) : confirming
    ? `<button type="button" class="td-act is-danger" data-src="remove" data-name="${esc(k)}">确定删除</button><button type="button" class="td-act" data-src="cancel">算了</button>`
    : `${linkOf(r) ? `<a class="td-act" href="${esc(linkOf(r).url)}" target="_blank" rel="noopener noreferrer">招聘页 ↗</a>` : ''}<button type="button" class="td-act" data-src="${paused ? 'resume' : 'pause'}" data-name="${esc(k)}">${paused ? '恢复' : '暂停'}</button><button type="button" class="td-act" data-src="edit" data-name="${esc(k)}">改</button><button type="button" class="td-act" data-src="ask-remove" data-name="${esc(k)}">删除</button>`;
  const form = k && editing ? `<form class="td-src-edit" data-src-form="update" data-name="${esc(k)}"><input name="name" value="${esc(k)}" aria-label="公司名" maxlength="60"><input name="url" type="url" value="${esc(linkOf(r)?.url || '')}" aria-label="招聘页链接" placeholder="招聘页链接"><button type="submit" class="primary">保存</button><button type="button" class="secondary" data-src="cancel">算了</button></form>` : '';
  // 管理名单只放网站身份和状态；每轮读取报告留在运行日志。
  const site = linkOf(r), address = site ? new URL(site.url).hostname : '';
  return `<li class="td-row"${k ? ` data-source="${esc(k)}"` : ''}><div class="td-row-main"><b>${esc(r.a)}</b>${address ? `<small>${esc(address)}</small>` : ''}</div><div class="td-row-side">${r.tag ? `<span class="td-pill is-${TONE[r.tone] || 'mute'}">${esc(r.tag)}</span>` : ''}${acts}</div>${form}</li>`;
}
function sourcesHtml(x, ui) {
  const query = String(ui.srcQuery || '').trim().toLocaleLowerCase(), rows = (x.rows || []).filter(r => !query || [r.a, linkOf(r)?.url].join(' ').toLocaleLowerCase().includes(query));
  return `<section class="td-panel td-sources" id="td-sources"><h2>招聘源<span class="td-more is-mute">${esc(x.rows.length)} 个 · <a href="${esc(href.settings('prefs/channels'))}">来源开关 →</a></span></h2><input class="td-source-search" type="search" data-source-search aria-label="搜索招聘源" placeholder="搜索公司或平台" value="${esc(ui.srcQuery || '')}">${rows.length ? `<ul class="td-rows td-managed-list">${rows.map(r => sourceRow(r, ui)).join('')}</ul>` : `<p class="td-empty">${esc(query ? '没有匹配的招聘源' : '还没有招聘源')}</p>`}</section>`;
}
// 交给 Radar 一个链接（招聘板首页 → 加成招聘源；岗位链接 → 收录并核验）。
// novalidate：不是链接时说中文（「要一个 http 开头的链接」，服务器那边的原话），不弹浏览器自带的英文提示（QA 第 2 轮 #18）。
const giveLinkHtml = ui => `<form class="td-give" data-src-form="link" novalidate><input name="url" type="url" required placeholder="粘贴岗位、招聘帖或招聘页链接" aria-label="交给 Radar 一个链接" value="${esc(ui.linkDraft || '')}"><button type="submit" class="primary"${ui.linkBusy ? ' disabled' : ''}>${ui.linkBusy ? '正在交给 Radar…' : '交给 Radar'}</button></form>`;
function contactsHtml(contacts = [], ui = {}) {
  const draft = ui.contactDraft || {};
  const form = `<form class="td-contact-form" data-contact-form novalidate><input name="name" aria-label="联系人姓名" placeholder="姓名" maxlength="80" value="${esc(draft.name || '')}"><input name="company" aria-label="联系人公司" placeholder="公司" maxlength="80" value="${esc(draft.company || '')}"><input name="contact" aria-label="联系人主页或邮箱" placeholder="联系人主页链接或邮箱" maxlength="2000" value="${esc(draft.contact || '')}"><button type="submit" class="secondary"${ui.contactBusy ? ' disabled' : ''}>${ui.contactBusy ? '正在添加…' : '添加联系人'}</button></form>`;
  const rows = contacts.map(r => {
    const profile = externalLink(r.url), post = externalLink(r.post_url);
    return `<li class="td-row" data-contact-row="${esc(r.id)}"><div class="td-row-main"><b>${esc([r.name, r.company].filter(Boolean).join(' · '))}</b>${r.role ? `<small>${esc(r.role)}</small>` : ''}${r.contact ? profile ? `<a class="td-contact-address" href="${esc(profile.url)}" target="_blank" rel="noopener noreferrer">${esc(r.contact)} ↗</a>` : `<small>${esc(r.contact)}</small>` : ''}${r.email && r.email !== r.contact ? `<small>${esc(r.email)}</small>` : ''}${r.contact_line ? `<small>${esc(r.contact_line)}</small>` : ''}<small class="is-soft">${esc([r.source ? `来源：${r.source}` : r.manual ? '手动添加' : '', r.status].filter(Boolean).join(' · '))}${post ? ` · <a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">原帖 ↗</a>` : ''}</small></div><div class="td-row-side">${ui.contactRemove === r.id ? `<button type="button" class="td-act is-danger" data-contact="remove" data-id="${esc(r.id)}">确定移出</button><button type="button" class="td-act" data-contact="cancel">算了</button>` : `<button type="button" class="td-act" data-contact="ask-remove" data-id="${esc(r.id)}">移出</button>`}</div></li>`;
  }).join('');
  const add = `<details class="td-contact-add"${ui.contactError || Object.values(draft).some(Boolean) ? ' open' : ''}><summary>添加联系人</summary>${form}${ui.contactError ? `<p class="td-why" role="alert">${esc(ui.contactError)}</p>` : ''}</details>`;
  return `<section class="td-panel td-contacts" id="team-section-contacts"><h2>联系人<span class="td-more is-mute">${contacts.length} 位</span></h2>${add}${rows ? `<ul class="td-rows td-managed-list">${rows}</ul>` : '<p class="td-empty">还没有联系人</p>'}</section>`;
}

// ── 一位成员的页面（10-05 负责人：「为什么现在点进团队角色页都是空空的？之前那些角色的一些功能，还有他做的事都在哪里？」）──────
// 头上：名字、一句白话，旁边一小排（立即跑一轮、暂停、和它说）。操作后，只列非空的正在做、等你和排队，再并排：
//   左  最近的结果（做完 / 没做成的任务卡，加上运行日志里定时跑的那些，连着同一句的并成「×N」）
//   右  做出来的（lib/member-done.mjs：岗位、判断、材料版本、发出的消息、认出的回复、修好的和花费，每行指到那一条）
// 操作和管理放在这些记录之前；仍保留全部任务、结果与日志入口。
// 任务是 GET /api/tasks?member=<id> 按负责成员筛出来的同一份；读不到就用 /api/team/<id> 自己的 tasks。
// 分在哪一块按账上的状态（c.state），小标的词和色调是服务端给的（lib/status.mjs），页面不自己换算。
const chip = x => x?.word ? `<span class="tb-st is-${esc(x.tone || 'mute')}">${esc(x.word)}</span>` : '';
// 页面时区来自 lib/tz.mjs，由服务端写进 shell；与运行日志使用同一份配置。
const pageZone = () => (typeof document !== 'undefined' && document.querySelector('meta[name="radar-tz"]')?.content) || Intl.DateTimeFormat().resolvedOptions().timeZone;
const hhmm = x => { const t = Date.parse(x || ''); return Number.isFinite(t) ? new Intl.DateTimeFormat('zh-CN', { timeZone: pageZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t) : ''; };
const whenOf = (x, now) => { const t = Date.parse(x || ''); if (!Number.isFinite(t)) return ''; const zone = pageZone(), day = dayIn(t, zone); return day === dayIn(now, zone) ? hhmm(x) : day === dayIn(now - 86400000, zone) ? '昨天' : new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric' }).format(t); };
const cardHref = (member, id) => `#tasks?owner=${encodeURIComponent(member)}&task=${encodeURIComponent(id)}`;
const titleOf = c => c.short || c.title || '';
// 行下面那一句：没做成的写原因；做完的写结果（「读了 3 封新信…」），「跑完了」这种空话不写。
const line = c => String(c || '').replace(/\s+/g, ' ').slice(0, 40);
const doneWhy = c => /^跑完了|^做完了/.test(String(c.result || '')) ? '' : c.result;
const evidenceLink = f => f ? `<a class="td-act" href="/api/evidence?file=${encodeURIComponent(f)}" target="_blank" rel="noopener">${/\.(png|jpe?g|webp|gif)$/i.test(f) ? '截图' : /\.log$/i.test(f) ? '日志' : '证据'} ↗</a>` : '';
// 右栏一行（做出来的、最近的结果同一个样子）：标题点进去是那一条（岗位、材料、卡片、运行日志），旁边小标、时间、证据。
const doneRow = (r, now) => `<li class="td-row${r.tone === 'bad' ? ' is-bad' : ''}"><div class="td-row-main"><b>${r.href ? `<a href="${esc(r.href)}">${esc(r.title)}</a>` : esc(r.title)}${r.n > 1 ? ` <i class="mb-times">×${esc(r.n)}</i>` : ''}</b>${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</div><div class="td-row-side">${r.tag ? `<span class="td-pill is-${TONE[r.tone] || 'mute'}">${esc(r.tag)}</span>` : ''}<span class="td-when">${esc(whenOf(r.at, now))}</span>${evidenceLink(r.evidence)}</div></li>`;
// 最近的结果：做完、没做成的卡，加上运行日志里的运行（定时跑的不是卡，10-03 以后成员页上看不到它们）。
// 同一件事既是卡又是一条运行（手点的、例行卡）：时间差 3 分钟以内、名字开头一样，留卡。
const sameThing = (c, r) => { const a = String(titleOf(c)).replace(/\s/g, ''), b = String(r.label || r.title).replace(/\s/g, ''); return Math.abs(Date.parse(c.updated_at || '') - Date.parse(r.at || '')) <= 180000 && a.slice(0, 2) && (a.includes(b.slice(0, 2)) || b.includes(a.slice(0, 2))); };
export function resultsOf(past = [], runs = [], member = '', { max = 8 } = {}) {
  const cards = past.map(c => ({ at: c.updated_at, title: titleOf(c), detail: c.state === 'failed' ? '' : line(doneWhy(c)), tag: c.word, tone: c.tone === 'bad' || c.state === 'failed' ? 'bad' : 'ok', href: cardHref(member, c.id) }));
  // 最近工作只留结果索引；逐源错误、堆栈和完整回执在这一行指向的任务或日志中。
  const rows = runs.filter(r => !past.some(c => sameThing(c, r))).map(r => ({ ...r, title: r.word ? r.label : r.title, detail: '', tag: r.word || '', tone: r.tone }));
  return [...cards, ...rows].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, max);
}
// 做出来的与最近的结果并排；汇总放在成果列表后，不把首张卡往下推。
export function madeHtml(done = {}, now = Date.now()) {
  const made = done.made || [], all = done.all && made.length ? `<a class="mb-all" href="${esc(done.all)}">全部 →</a>` : '';
  return `<div class="mb-sec mb-done"><h3>做出来的${all}</h3>${made.length ? `<ul class="td-rows">${made.map(r => doneRow(r, now)).join('')}</ul>` : '<p class="tc-empty">还没有做出来的东西</p>'}${done.facts ? `<p class="mb-facts">${esc(done.facts)}</p>` : ''}</div>`;
}
export function resultsHtml(done = {}, past = [], member = '', now = Date.now()) {
  const res = resultsOf(past, done.runs || [], member);
  return `<div class="mb-sec mb-done"><h3>最近的结果<a class="mb-all" href="#stream?flow=${encodeURIComponent(member)}">运行日志 →</a></h3>${res.length ? `<ul class="td-rows">${res.map(r => doneRow(r, now)).join('')}</ul>` : '<p class="tc-empty">还没有跑过</p>'}</div>`;
}
export const doneHtml = (done = {}, past = [], member = '', now = Date.now()) => madeHtml(done, now) + resultsHtml(done, past, member, now);
// 左栏「等你」里信那几行（d.tasks.waiting 里不是卡的：算在这位名下的信、交办任务问的、新线索筛选）。
const askRow = (t, f) => `<a class="tc-row has-why" href="${t.href ? inboxHref(t.href) : t.rid ? `#lead/${encodeURIComponent(t.rid)}` : '#inbox'}">${f}<span class="t">${esc(t.title)}</span>${chip({ word: t.type === '卡住了' ? '卡住了' : '等你', tone: t.type === '卡住了' ? 'bad' : 'you' })}<time></time>${t.ask && t.ask !== t.title ? `<span class="why">${esc(line(t.ask))}</span>` : ''}</a>`;
export function memberTopHtml(d = {}, list = {}, nowCard = null, { now = Date.now(), acts = '', note = '', body = '' } = {}) {
  const f = faceHtml(d.face, { size: 22 });
  const tw = d.tasks?.waiting || [];
  let active, past = [];
  const activePart = (title, content, count = 0) => content ? `<div class="mb-sec"><h3>${esc(title)}${count ? ` <b>${count}</b>` : ''}</h3>${content}</div>` : '';
  if (list) {
    const goals = list.goals || [], inGoal = new Set(goals.map(g => g.id));
    // 子任务（parent_task）照样列出来，行上一句它属于哪件（主会话 10-03）；目标下面的卡不单列。
    const all = [...goals, ...(list.cards || []).filter(c => !(c.goal && inGoal.has(c.goal)))].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const by = k => all.filter(c => c.state === k);
    const parentTitle = id => { const p = all.find(x => x.id === id); return p ? titleOf(p) : (list.parents || {})[id] || ''; };
    const row = (c, why = '') => { const up = c.parent_task ? parentTitle(c.parent_task) : ''; return `<a class="tc-row${why || up ? ' has-why' : ''}${c.state === 'failed' ? ' is-bad' : ''}" href="${cardHref(d.key, c.id)}">${f}<span class="t">${esc(titleOf(c))}</span>${chip(c)}<time>${esc(whenOf(c.updated_at, now))}</time>${up ? `<span class="up">属于：${esc(up)}</span>` : ''}${why ? `<span class="why">${esc(why)}</span>` : ''}</a>`; };
    const running = by('running'), cur = running[0] || null;
    const route = (nowCard?.id === cur?.id ? nowCard?.route : null) || [];
    const bar = route.length > 1 ? `<div class="mb-gbar">${route.map(s => `<i class="is-${['done', 'run', 'you'].includes(s.tone) ? s.tone : 'plan'}"></i>`).join('')}</div><div class="mb-route">${route.map(s => s.state === 'done' ? `<span class="is-done">${esc(s.label)} ✓</span>` : s.state === 'running' || s.state === 'waiting_you' ? `<span class="is-now">${esc(s.label)}${chip(s)}</span>` : `<span>${esc(s.label)}</span>`).join('<i aria-hidden="true">→</i>')}</div>` : '';
    const nowBox = cur ? `<a class="mb-now" href="${cardHref(d.key, cur.id)}"><div class="top"><b>${esc(titleOf(cur))}</b>${chip(cur)}<time>${esc(hhmm(cur.started_at || cur.updated_at))} 开始 · ${since(cur.started_at || cur.updated_at)}</time></div>${bar}</a>` : '';
    const doing = running.slice(1), queued = by('queued');
    // 等你：卡上等你的，加上不在卡上的信（卡上已经有的那几封服务端去掉了，lib/crew-desk.mjs mergedWaiting）。
    const wait = tw.filter(t => t.type !== '卡住了').map(t => askRow(t, f));
    past = [...by('done'), ...by('failed')];
    active = activePart('正在做', nowBox + doing.map(c => row(c)).join(''))
      + activePart('等你', wait.join(''), d.waiting)
      + activePart(queued[0]?.word || '排队', queued.map(c => row(c)).join(''), queued.length);
  } else {
    // 任务清单读不到：用 /api/team/<id> 自己的那份（在跑的操作、周期步骤、交办任务、等你的信）。
    const T0 = d.tasks || {}, plainRow = t => `<a class="tc-row${t.step || t.ask ? ' has-why' : ''}" href="${t.href ? inboxHref(t.href) : t.rid ? `#lead/${encodeURIComponent(t.rid)}` : `#tasks?owner=${encodeURIComponent(d.key || '')}`}">${f}<span class="t">${esc(t.title)}</span><time>${t.since ? since(t.since) : esc(t.ago || '')}</time>${t.step || t.ask ? `<span class="why">${esc(line(t.step || t.ask))}</span>` : ''}</a>`;
    active = activePart('正在做', (T0.running || []).map(plainRow).join(''))
      + activePart('等你', tw.filter(t => t.type !== '卡住了').map(t => askRow(t, f)).join(''), d.waiting)
      + activePart('排队', (T0.queued || []).map(plainRow).join(''), T0.queued?.length);
  }
  const left = resultsHtml(d.done || {}, past, d.key, now);
  const right = madeHtml(d.done || {}, now);
  const plain = d.plain || (list?.members || []).find(m => m.key === d.key)?.plain || d.duty || '';
  const log = `<a class="mb-log" href="#stream?flow=${encodeURIComponent(d.key || '')}">看他的运行日志</a>`;
  return `<div class="tc-page mb-top"><a class="mb-crumb" href="#team"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6l6 6"/></svg>团队</a><div class="mb-h">${faceHtml(d.face, { size: 56 })}<div class="mb-id"><h1>${esc(d.name)}${d.title ? `<span class="role">${esc(d.title)}</span>` : ''}</h1><p>${esc(plain)}</p></div>${acts ? `<div class="mb-acts">${acts}</div>` : ''}</div>${note}${body}<section class="mb-activity" aria-label="最近工作"><h2>最近工作</h2>${active ? `<div class="mb-active">${active}</div>` : ''}<div class="mb-cols"><div>${left}</div><div>${right}</div></div></section>${log}</div>`;
}

// 成员页先放能做的事和管理入口（lib/team.mjs workerDetail 的 sections）。
// 「做出来的」「最近的结果」已经说了的几节不再列（今天找到的、上一轮的结果、今天发出的、最近的回复和邮件、交给这台电脑的）。
const SAID_ABOVE = new Set(['found_today', 'last_round', 'last_judge', 'sent_today', 'replies', 'mail', 'last_cycle', 'executor']);
function abilitiesHtml(d, ui, busyLine) {
  const operations = (d.groups || []).flatMap(g => g.ops.map(o => opRowHtml(o, d.key, ui, g.label))).join('');
  const secs = (d.sections || []).filter(x => !x.log);
  const src = d.key === 'scout' ? secs.find(x => x.key === 'sources') : null;
  // 行多的一节占满一整行、行排成两列；别的几节并排在它下面（QA 第 2 轮 #21：一栏很长，旁边两栏下面空一大块）。
  const more = secs.filter(x => x !== src && x.rows?.length && !SAID_ABOVE.has(x.key)).map(x => { const href = ui.section === x.key ? null : sectionHref(x, d.key), wide = x.rows.length > 4; return `<section class="td-panel td-sec${wide ? ' is-wide' : ''}" id="team-section-${esc(x.key)}"><h2>${esc(x.title)}${href ? `<a class="td-more" href="${esc(href)}">全部 →</a>` : ''}</h2>${x.note ? `<p class="td-sec-note">${esc(x.note)}</p>` : ''}<ul class="td-rows${wide ? ' is-grid' : ''}">${(ui.section === x.key ? x.rows : x.rows.slice(0, 8)).map(sectionRow).join('')}</ul></section>`; }).join('');
  const links = (d.links || []).length ? `<nav class="td-entry-links" aria-label="${esc(d.name || '')}管理入口">${d.links.map(l => `<a href="${esc(l.href)}">${esc(l.label)} <span aria-hidden="true">→</span></a>`).join('')}</nav>` : '';
  const intake = d.key === 'scout' ? `<section class="td-panel td-intake" id="team-section-intake"><h2>贴链接找岗位</h2>${giveLinkHtml(ui)}${links}</section>` : '';
  const management = d.key === 'scout' ? `<div class="td-management">${src ? sourcesHtml(src, ui) : ''}${contactsHtml(d.contacts || [], ui)}</div>` : '';
  return `<div class="mb-body">${intake}<section class="td-panel td-ops-panel"><h2>能做的事</h2>${d.key === 'scout' ? '' : links}${busyLine ? `<p class="td-busy">${busyLine}</p>` : ''}${operations ? `<ul class="td-ops td-op-grid">${operations}</ul>` : '<p class="td-empty">没有能直接跑的</p>'}</section>${management}${more ? `<div class="td-secs">${more}</div>` : ''}</div>`;
}

export function deskHtml(d = {}, ui = {}, { list = null, nowCard = null, now = Date.now() } = {}) {
  // 模型用不了：每一项上自己写着（跑不了：… / 要模型的那几步这次会跳过），成员页上不再另挂一条横幅。
  const talk = `<button type="button" class="secondary" data-team-talk="${esc(d.key)}">和 ${esc(d.name)} 说</button>`;
  const round = (d.groups || []).find(g => g.key === 'round')?.ops?.[0];
  const pause = `<button type="button" class="secondary" data-team-pause="${esc(d.key)}" data-action="${d.paused ? 'resume' : 'pause'}">${d.paused ? '▶ 恢复' : 'Ⅱ 暂停'}</button>`;
  // 按钮变灰就在旁边写明为什么（10-01 #20：以前只在悬停提示里）。
  const ro = d.running_op, busyLine = ro ? `${ro.mine ? '' : `${esc(ro.name)} 的`}「${esc(ro.label)}」在跑（${since(ro.started_at)}），一次只跑一个` : d.busy_line ? esc(d.busy_line) : '';
  const headWhy = round && !round.can_run && !round.running && !round.busy && !round.queued && round.why_not && !sandboxy(round.why_not) ? `跑不了：${esc(round.why_not)}` : '';
  // 「立即跑一轮」排着：按钮成了「取消排队」，旁边写排在后面。
  const headQueued = round?.queued ? `<p class="td-head-why">${queuedHtml(round.queued)}</p>` : '';
  const acts = `${round ? opButton({ ...round, label: '立即跑一轮' }, d.key, ui, { compact: true }).replace('data-team-run=', 'data-where="head" data-team-run=') : ''}${pause}${talk}`;
  // Watcher：Mac 版没接邮箱时一行「没读邮件：邮箱还没接上 · 接上邮箱」（服务端 mail_line）。
  const mail = d.mail_line ? `<p class="td-why td-head-why">${esc(d.mail_line.text)}${goLink(d.mail_line.go)}</p>` : '';
  const found = d.found?.text ? `<p class="td-head-why td-found">${foundHtml(d.found)}</p>` : '';
  const paused = d.paused ? '<p class="td-head-why"><span class="td-state is-paused">已暂停</span> 定时工作先不做，点「恢复」接着做</p>' : '';
  const note = `${paused}${found}${mail}${headWhy ? `<p class="td-why td-head-why">${headWhy}</p>` : ''}${headQueued}${round && ui.confirm === round.key && ui.confirmAt === 'head' ? confirmHtml(round, d.key) : ''}`;
  return `<div class="td-desk" data-desk="${esc(d.key)}">${memberTopHtml(d, list, nowCard, { now, acts, note, body: abilitiesHtml(d, ui, busyLine) })}</div>`;
}

// 事件的补充说明去掉和标题重复的开头（「扫官方招聘源 · 有更新 · raw 58」→「raw 58」）。
// 只剩程序自己记的英文计数（raw 58 · added 3）就不显示：页面上只写中文。
// 链接（本机地址之类）不写；周期模式名换成中文。
const eventMore = e => { const d = String(e.detail || ''), t = String(e.text || ''); const step = t.split(' · ')[0]; let rest = d === t ? '' : d.startsWith(t + ' · ') ? d.slice(t.length + 3) : d.startsWith(step + ' · ') ? d.slice(step.length + 3) : d; rest = rest.replace(/[:：]?\s*https?:\/\/\S+/g, '').replace(/(^|· )full( ·|$)/, '$1完整周期$2').replace(/(^|· )light( ·|$)/, '$1轻量周期$2').replace(/[\s·]+$/, ''); return /^[\x00-\x7f·\s]*$/.test(rest) ? '' : rest; };
// ── 浏览器里：取数据、绑按钮 ────────────────────────────────────────────────
let token = '';
const getJson = async url => { const r = await fetch(url), d = await r.json(); if (!r.ok) throw Error(d.error || '读取失败'); if (d.token) token = d.token; return d; };
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Radar-Token': token }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || '没成功');
  return d;
}
export const loadTeam = () => getJson('/api/team');
export const loadDesk = id => getJson('/api/team/' + encodeURIComponent(id));
// 和这位说：有右侧面板（feat/talk）就开它的对话；没有就去对话页。
export function openTalk(member) {
  const panel = typeof window !== 'undefined' && window.OfferCrew?.panel;
  if (panel?.open) panel.open({ tab: 'talk', member });
  else location.hash = '#chat';
}
// 团队页主区上的按钮：跑、确认、暂停 / 恢复、和它说。repaint(ui) 重画，toast 提示。
export function bindDesk(root, { ui, repaint, toast = () => {}, after = () => {} }) {
  const run = async (member, op) => {
    ui.busy.add(op); ui.confirm = null; repaint();
    try { const r = await post('/api/team/run', { member, op }); toast(r.receipt || '已开始'); }
    catch (e) { toast(e.message); }
    finally { ui.busy.delete(op); await after(); }
  };
  // 页面按新数据重画时，正在输的链接不丢。
  root.oninput = e => {
    if (e.target.name === 'url' && e.target.closest('[data-src-form="link"]')) ui.linkDraft = e.target.value;
    if (e.target.closest('[data-contact-form]')) { ui.contactDraft ||= {}; ui.contactDraft[e.target.name] = e.target.value; }
    if ('sourceSearch' in e.target.dataset) { ui.srcQuery = e.target.value; repaint(); }
  };
  root.onsubmit = async e => {
    const contact = e.target.closest('form[data-contact-form]');
    if (contact && root.contains(contact)) {
      e.preventDefault(); if (ui.contactBusy) return;
      const body = Object.fromEntries(['name', 'company', 'contact'].map(k => [k, contact.elements[k].value.trim()]));
      ui.contactDraft = { ...body }; ui.contactBusy = true; ui.contactError = ''; repaint();
      try { const r = await post('/api/sources', { action: 'contact_add', ...body }); toast(r.receipt); if (Object.keys(body).every(k => ui.contactDraft?.[k] === body[k])) ui.contactDraft = {}; }
      catch (err) { ui.contactError = err.message; }
      ui.contactBusy = false; await after(); return;
    }
    const f = e.target.closest('form[data-src-form]');
    if (!f || !root.contains(f)) return;
    e.preventDefault();
    const url = f.elements.url?.value.trim() || '';
    if (f.dataset.srcForm === 'link') {
      ui.linkDraft = url; ui.linkBusy = true; repaint();
      try { const r = await post('/api/sources', { action: 'link', url }); toast(r.receipt || '交给 Radar 了'); ui.linkDraft = ''; } catch (err) { toast(err.message); }
      ui.linkBusy = false; await after(); return;
    }
    const name = f.dataset.name, set = {}, newName = f.elements.name?.value.trim();
    if (newName && newName !== name) set.name = newName;
    if (url && url !== (f.elements.url.defaultValue || '')) set.url = url;
    try { const r = await post('/api/sources', { action: 'update', name, set }); toast(r.receipt || '好了'); ui.srcEdit = null; } catch (err) { toast(err.message); }
    await after();
  };
  root.onclick = async e => {
    const b = e.target.closest('button,[data-team-talk]');
    if (!b || !root.contains(b)) return;
    if (b.dataset.teamRun) { e.preventDefault(); if (b.dataset.heavy) { ui.confirm = b.dataset.op; ui.confirmAt = b.dataset.where || 'row'; repaint(); } else run(b.dataset.teamRun, b.dataset.op); }
    else if (b.dataset.teamFollowup) {
      b.disabled = true;
      try { const r = await post('/api/inbox/answer', { id: b.dataset.teamFollowup, option: b.dataset.option }); toast(r.receipt || '已交给 Writer 起草'); } catch (err) { toast(err.message); }
      await after();
    }
    else if (b.dataset.teamJudge) {
      b.disabled = true;
      try { const r = await post('/api/ops', { op: 'judge-one', record_id: b.dataset.teamJudge }); toast(r.pending ? `先排着：${r.why}` : '开始判断这一条'); } catch (err) { toast(err.message); }
      await after();
    }
    else if (b.dataset.teamYes) run(b.dataset.teamYes, b.dataset.op);
    else if ('teamNo' in b.dataset) { ui.confirm = null; repaint(); }
    else if (b.dataset.teamCancel) {
      b.disabled = true;
      try { const r = await post('/api/team/queue', { id: b.dataset.teamCancel }); toast(r.receipt || '不跑了'); } catch (err) { toast(err.message); }
      await after();
    }
    else if (b.dataset.teamPause) {
      b.disabled = true;
      try { const r = await post('/api/agent', { agent: b.dataset.teamPause, action: b.dataset.action }); toast(r.receipt || '好了'); } catch (err) { toast(err.message); }
      await after();
    } else if (b.dataset.teamTalk) openTalk(b.dataset.teamTalk);
    else if (b.dataset.alertDismiss) {
      b.disabled = true;
      try { await post('/api/alerts', { action: 'dismiss', key: b.dataset.alertDismiss }); } catch (err) { toast(err.message); }
      await after();
    }
    else if (b.dataset.contact) {
      if (b.dataset.contact === 'ask-remove') { ui.contactRemove = b.dataset.id; repaint(); return; }
      if (b.dataset.contact === 'cancel') { ui.contactRemove = null; repaint(); return; }
      b.disabled = true;
      try { const r = await post('/api/sources', { action: 'contact_remove', id: b.dataset.id }); toast(r.receipt); ui.contactRemove = null; }
      catch (err) { toast(err.message); }
      await after();
    }
    else if (b.dataset.src) {
      const a = b.dataset.src, name = b.dataset.name;
      if (a === 'edit') { ui.srcEdit = name; ui.srcDel = null; repaint(); return; }
      if (a === 'ask-remove') { ui.srcDel = name; ui.srcEdit = null; repaint(); return; }
      if (a === 'cancel') { ui.srcEdit = ui.srcDel = null; repaint(); return; }
      b.disabled = true;
      const body = a === 'remove' ? { action: 'remove', name } : { action: 'update', name, set: { paused: a === 'pause' ? '你暂停的' : false } };
      try { const r = await post('/api/sources', body); toast(r.receipt || '好了'); ui.srcDel = null; } catch (err) { toast(err.message); }
      await after();
    }
  };
}
// 「已 N 分钟」每 20 秒走一下。
if (typeof document !== 'undefined') setInterval(() => document.querySelectorAll('[data-since]').forEach(x => { x.textContent = elapsed(x.dataset.since); }), 20000);

// 团队页（web/app.js 调）：teamPage 返回 HTML，bindTeam 绑按钮。
const pageUi = { confirm: null, busy: new Set() };
let pageView = null, pageKey = null, helpers = null, pageList = null, pageNow = null;
export const teamSig = () => pageView ? `${pageView.content_sig || ''}|${JSON.stringify((pageList?.cards || []).map(c => [c.id, c.status, c.updated_at]))}|${pageNow?.updated_at || ''}` : null;
// 成员页的任务：按负责成员筛的目录，在做的第一件取它的卡片（路线画进度）。读不到就照旧只画工作台。
async function loadMemberTasks(id) {
  try {
    const list = await getJson(`/api/tasks?member=${encodeURIComponent(id)}&owner=${encodeURIComponent(id)}`);
    const all = [...(list.goals || []), ...(list.cards || [])].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const cur = all.find(c => c.state === 'running' || c.status === 'running');
    const have = new Set(all.map(c => c.id)), miss = [...new Set(all.map(c => c.parent_task).filter(id => id && !have.has(id)))].slice(0, 8);
    list.parents = Object.fromEntries((await Promise.all(miss.map(id => getJson(`/api/tasks/${encodeURIComponent(id)}/card`).then(x => [id, (x.card || x).title || '']).catch(() => [id, ''])))).filter(x => x[1]));
    const current = cur ? await getJson(`/api/tasks/${encodeURIComponent(cur.id)}/card`).then(x => x.card || x).catch(() => null) : null;
    return { list, current };
  } catch { return { list: null, current: null }; } // 兜底：成员工作台自身仍有任务和结果
}
const deskNow = () => deskHtml(pageUi.section === 'made' && pageView?.done?.all_made ? { ...pageView, done: { ...pageView.done, made: pageView.done.all_made, all: null } } : pageView, pageUi, { list: pageList, nowCard: pageNow });
let viewRequest = 0;
async function reloadView(sub) {
  const request = ++viewRequest;
  const [view, tasks] = await Promise.all([sub ? loadDesk(sub) : loadTeam(), sub ? loadMemberTasks(sub) : null]);
  if (request !== viewRequest || sub !== pageKey) return false;
  pageView = view; pageList = tasks?.list || null; pageNow = tasks?.current || null;
  return true;
}
export async function teamPage(h, sub = null) {
  helpers = h;
  pageUi.section = typeof location !== 'undefined' ? new URLSearchParams(location.hash.split('?')[1] || '').get('section') : null;
  if (sub !== pageKey) { pageKey = sub; pageView = null; pageUi.confirm = null; pageList = null; pageNow = null; }
  await reloadView(sub);
  return pageView ? pageKey ? deskNow() : teamListHtml(pageView, pageUi) : '<p class="tc-empty">正在读取团队…</p>';
}
// 还没打开过团队页时先拉一份（web/app.js 空闲时、鼠标移到左栏上时调）。
export async function teamPrefetch(h) {
  if (pageView) return;
  helpers = helpers || h;
  const request = viewRequest;
  try { const v = await loadTeam(); if (request === viewRequest && !pageView) { pageView = v; pageKey = null; } } catch {}
}
// 换到团队页、成员页时先用手上这份画（web/app.js 换页立刻换）；看的不是同一位、或没拉过返回 null。
export function teamNow(sub = null) {
  if (!pageView || sub !== pageKey) return null;
  return sub ? deskNow() : teamListHtml(pageView, pageUi);
}
export function bindTeam() {
  const main = document.querySelector('#main');
  if (!main) return;
  // 六位共用 #team 页面；换成员从功能区开始，同一位的数据刷新保留滚动位置。
  const member = pageKey || '';
  if (main.dataset.teamMember !== member) {
    main.dataset.teamMember = member;
    if (!pageUi.section) window.scrollTo(0, 0);
  }
  const repaint = () => { if (!pageView) return; morph(main, pageKey ? deskNow() : teamListHtml(pageView, pageUi)); };
  bindDesk(main, { ui: pageUi, repaint, toast: t => helpers?.toast(t), after: async () => { try { if (await reloadView(pageKey)) repaint(); } catch (e) { helpers?.toast(e.message); } helpers?.refresh?.(); } });
  if (pageUi.section && main.dataset.teamSection !== location.hash) {
    main.dataset.teamSection = location.hash;
    const target = pageUi.section === 'made' ? main.querySelector('.mb-cols > div:last-child .mb-done') : document.getElementById(`team-section-${pageUi.section}`);
    target?.scrollIntoView({ block: 'start' });
  }
  if (!pageUi.section) delete main.dataset.teamSection;
}
