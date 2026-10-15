// OfferCrew 手机 App（手机第二里程碑，对话优先；design/phone-m2/实施方案.md 第十节）。
// 四个标签：对话 / 任务 / 等你 / 我的（10-03 负责人「任务卡片」：任务是一张卡片，对话里只放对话）。代码从这台 Mac 经加密通道送到手机（lib/phone/gateway.mjs 的代码包），service worker 缓存；
// 数据一律经通道现取（/p/shim.js 把同一地址的 /api/* 交给通道），手机上不存电脑的数据。
// 没有框架：状态在 S 里，每块 paintX() 整块重画；输入框只建一次，重画不碰它。
import * as L from './logic.js';
import { renderTalkText } from './talk-text.js';
import { faceHtml } from '/face.js';
import { preparePush, enablePush, disablePush, onPushOpen, appVersion } from '/p/shared.js';

const P = window.__offercrewPhone;
const $ = (s, r = document) => r.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const S = {
  tab: 'talk', task: null, card: null, taskList: null, taskErr: '', taskOpen: new Set(), to: null, members: {}, talkable: [], sid: null, session: null, fresh: false, tasks: {}, cards: {}, refs: {}, pend: [], focus: null, err: '',
  parse: { key: null, value: null }, pick: null, history: null, q: '', asks: null, inflight: [], total: 0, target: null,
  picks: new Map(), answered: new Map(), busy: new Set(), open: new Set(), hello: null, derived: null, push: { on: null, msg: '', busy: false }, prepared: null, version: null, renaming: false,
};
const FACE = { you: { key: 'you', name: '你' }, team: { key: 'team', name: '团队' }, executor: { key: 'executor', name: '本机 AI' } };
const memberOf = k => S.members[L.memberKey(k)] || FACE[k] || { key: k, name: '团队' };
const face = (k, cls = '') => faceHtml(memberOf(k), cls);
const nameOf = k => memberOf(k).name;
const crewList = () => S.talkable.map(k => ({ ...memberOf(k), key: k }));

// ── 和电脑说话（fetch 经 /p/shim.js 走加密通道）──
const OFFLINE = '电脑不在线，没发出去';
async function call(path, body) {
  let r;
  try { r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { throw Object.assign(Error(P?.state().mac === false ? OFFLINE : e.message || OFFLINE), { offline: true }); }
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || j.ok === false) throw Object.assign(Error(j.error || `出错了（${r.status}）`), { status: r.status, json: j });
  return j;
}
const get = p => call(p), post = (p, b) => call(p, b || {});

let toastTimer;
function toast(t) { const el = $('#toast'); if (!el) return; el.textContent = t; el.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000); }

// ── 骨架 ───────────────────────────────────────────────────────────────────
function shell() {
  $('#app').innerHTML = `
  <section class="view" id="v-talk">
    <header class="bar"><button type="button" class="title" id="t-title" aria-haspopup="dialog"><span id="t-name">团队</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6l6-6"/></svg></button></header>
    <div class="who" id="who" role="toolbar" aria-label="在跟谁说" hidden></div>
    <div class="thread" id="thread"></div>
    <form class="composer" id="composer" autocomplete="off">
      <div class="pick" id="pick" role="listbox" hidden></div>
      <div class="chips" id="chips"></div>
      <div class="hint" id="hint"></div>
      <p class="c-err" id="c-err" role="alert" hidden></p>
      <div class="c-row"><textarea id="input" rows="1" enterkeyhint="send" aria-label="说一句"></textarea><button type="submit" class="send" id="send" aria-label="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7l7 7"/></svg></button></div>
    </form>
  </section>
  <section class="view" id="v-tasks" hidden><header class="bar" id="k-bar"><h1>任务</h1></header><div class="scroll" id="tasks"></div><div class="k-foot" id="k-foot" hidden></div></section>
  <section class="view" id="v-wait" hidden><header class="bar"><h1>等你</h1></header><div class="scroll" id="wait"></div></section>
  <section class="view" id="v-me" hidden><header class="bar"><h1>我的</h1></header><div class="scroll" id="me"></div></section>
  <div class="sheet-bg" id="hist" hidden></div>`;
}

// ── 标签和地址 ──────────────────────────────────────────────────────────────
function go(r, { replace = false } = {}) {
  const h = L.hashOf(r);
  if (location.hash !== h) (replace ? history.replaceState(null, '', h) : history.pushState(null, '', h));
  show(r);
}
function show(r) {
  S.tab = r.tab;
  for (const t of ['talk', 'tasks', 'wait', 'me']) { $(`#v-${t}`).hidden = t !== r.tab; $(`#tabs [data-tab="${t}"]`)?.setAttribute('aria-current', t === r.tab ? 'page' : 'false'); }
  if (r.tab === 'talk') { if (r.session && r.session !== S.sid) { S.sid = r.session; S.fresh = false; S.session = null; loadTalk(); } paintThread(); }
  // 点通知进来找的那一条：清单真的取回来了才判断它在不在（电脑不在线时不说「已经处理了」）。
  if (r.tab === 'wait') { S.target = r.ask || null; S.targetChecked = false; paintWait(); loadWait().then(ok => { S.targetChecked = ok; paintWait(); scrollToAsk(); }); }
  if (r.tab === 'me') { paintMe(); loadMe(); }
  if (r.tab === 'tasks') { if (S.task !== (r.task || null)) { S.sub = null; S.why = null; S.sayDraft = ''; S.sayErr = ''; S.sayReply = null; } S.task = r.task || null; S.card = S.card?.id === S.task ? S.card : null; paintTasks(); (S.task ? loadCard(S.task) : loadTasks()).then(paintTasks); }
}
// ── 任务 ────────────────────────────────────────────────────────────────────
// 列表 GET /api/tasks（按六种状态的队列分组），点一件进卡片 GET /api/tasks/<id>/card（logic.js taskListHtml / phoneCardHtml）。
async function loadTasks() { try { S.taskList = await get('/api/tasks'); S.taskErr = ''; } catch (e) { S.taskErr = e.offline ? OFFLINE : e.message; } }
async function loadCard(id) { try { const d = await get(`/api/tasks/${encodeURIComponent(id)}/card`); if (S.task === id) { S.card = d.card || d; S.taskErr = ''; } } catch (e) { if (S.task === id) S.taskErr = e.offline ? OFFLINE : '这件读不到了'; } }
const BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6l6 6"/></svg>';
function paintTasks() {
  const bar = $('#k-bar'), box = $('#tasks'), foot = $('#k-foot'); if (!bar || !box) return;
  const c = S.task && S.card?.id === S.task ? S.card : null;
  // 子任务的卡片：左上角回上一级（card.parent），不是回列表。
  bar.innerHTML = S.task ? `<button type="button" class="back" ${c?.parent?.id ? `data-task-open="${esc(c.parent.id)}" aria-label="${esc(c.parent.title || '上一级')}"` : 'data-tasks-back aria-label="任务"'}>${BACK}</button><h1 class="k-h">${c ? L.cardTitleHtml(c) : ''}</h1>` : '<h1>任务</h1>';
  // 底上：给这件活下指令的框（重画时字和光标留着），下面一行来源。
  const typing = document.activeElement?.closest?.('#k-say');
  const f = c ? `${L.sayFormHtml(c, { draft: S.sayDraft, busy: S.saying, err: S.sayErr, reply: S.sayReply?.id === c.id ? S.sayReply : null, face: k => face(k, 'f sm'), name: nameOf })}${L.cardFootHtml(c) ? `<div class="k-fromrow">${L.cardFootHtml(c)}</div>` : ''}` : '';
  if (f !== foot.dataset.html) { foot.innerHTML = f; foot.dataset.html = f; if (typing) { const i = $('#k-say textarea'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } } }
  foot.hidden = !f;
  const sub = S.sub ? { ...S.sub, members: S.talkable.map(k => ({ key: k, name: nameOf(k) })) } : null;
  const subFocus = document.activeElement?.closest?.('#k-sub');
  keep(box, () => { box.innerHTML = S.taskErr ? `<p class="empty-line">${esc(S.taskErr)}</p>` : S.task ? (c ? L.phoneCardHtml(c, { face: k => face(k, 'f sm'), name: nameOf, sub, why: S.why }) : '') : S.taskList ? L.taskListHtml(S.taskList, { face: k => face(k, 'f sm'), open: S.taskOpen }) : ''; });
  if (subFocus) { const i = $('#k-sub textarea'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}
// 子任务派给谁：照新建的规矩问 System（GET /api/talk/parse 的 task.assign；认不出的是「你交代的事」，建议的人照 persona）。
let subSeq = 0;
async function subSuggest(text) {
  const seq = ++subSeq;
  try { const x = await get('/api/talk/parse?text=' + encodeURIComponent(text.slice(0, 500))); if (seq !== subSeq || !S.sub) return; const k = x.task?.assign?.suggested || x.persona || null; S.sub.assign = x.task?.assign ? { ...x.task.assign, owner: x.task.assign.owner || x.task.owner || null } : null; S.sub.suggest = k && S.talkable.includes(k) ? k : null; paintTasks(); } catch {}
}
const openCard = id => id && go({ tab: 'tasks', task: id });
function scrollToAsk() { if (!S.target) return; const el = document.querySelector(`[data-ask="${CSS.escape(S.target)}"]`); if (el) { el.scrollIntoView({ block: el.querySelector('.received') ? 'start' : 'center' }); el.classList.add('is-hit'); setTimeout(() => el.classList.remove('is-hit'), 1600); } else document.querySelector('#wait .ask-gone')?.scrollIntoView({ block: 'start' }); }

// ── 对话 ───────────────────────────────────────────────────────────────────
let talkSeq = 0;
// 现场拼出来的只读对话（旧卡没有自己的对话文件，S.derived 是卡 id）：服务端的「当前对话」不是它，不拿来换；
// 在里面说一句，POST /api/talk 带它的 id，服务端这时才建文件（adopt 以后就是普通对话）。
async function loadTalk() {
  const seq = ++talkSeq;
  try {
    const d = await get(`/api/talk${S.sid && !S.derived ? `?session=${encodeURIComponent(S.sid)}` : ''}`);
    if (seq !== talkSeq) return;
    S.members = d.members || S.members; S.talkable = d.talkable || S.talkable;
    if (!S.fresh && !S.derived) { S.session = d.session || null; S.sid = d.session?.id || S.sid; S.tasks = d.tasks || {}; S.cards = d.cards || {}; S.refs = d.refs || {}; }
    paintThread(); markSeen();
  } catch {}
}
// 看着这段对话：告诉电脑看过了（对话历史上的小点，手机和电脑同一份）。同一段没有新动静不再说。
let seenAt = '';
function markSeen() {
  const s = S.session;
  if (S.derived || S.tab !== 'talk' || !s?.id || !s.updated_at || seenAt === `${s.id}|${s.updated_at}` || document.visibilityState === 'hidden') return;
  seenAt = `${s.id}|${s.updated_at}`;
  const row = (S.history || []).find(x => x.id === s.id); if (row) row.seen_at = s.updated_at;
  post('/api/chat/seen', { session_id: s.id }).catch(() => { seenAt = ''; });
}
function adopt(r) {
  if (r.session) { S.derived = null; S.session = r.session; S.sid = r.session.id; S.fresh = false; history.replaceState(null, '', `#talk/${S.sid}`); }
  if (r.tasks) S.tasks = r.tasks; if (r.cards) S.cards = r.cards; if (r.refs) S.refs = { ...S.refs, ...r.refs };
  paintThread({ bottom: true });
}
const lastSpeaker = () => [...(S.session?.messages || [])].reverse().find(m => m.role === 'assistant' && m.persona)?.persona || null;

// 和电脑上的对话一样：`代码`、**粗体**、链接、#12；「### 小标题」整行加粗。
function md(s) {
  return renderTalkText(s, { numberLink: n => `<a href="#" class="num" data-lead="${n}">#${n}</a>` });
}
const ev = f => `/api/evidence?file=${encodeURIComponent(f)}`;
// 证据链接写它是什么（截图、日志、证据），不写文件名（发布清单 P1）。
const fileLink = f => `<a class="file" href="${esc(ev(f))}">${/\.(png|jpe?g|webp|gif)$/i.test(f) ? '截图' : /\.log$/i.test(f) ? '日志' : '证据'}</a>`;
const who = (k, at, tag = '') => `<div class="who">${face(k, 'f')}<b>${esc(nameOf(k))}</b>${tag}<time>${esc(L.clock(at))}</time></div>`;
const leadChips = (rows = []) => (rows.length ? `<div class="leads">${rows.map(r => `<a href="#" class="lead" data-lead="${esc(r.number)}"><b>#${esc(r.number)}</b>${esc(cut(r.company || String(r.label || '').replace(/^#\d+\s*/, ''), 16))}</a>`).join('')}</div>` : '');

function cardHtml(v) {
  if (!v) return '';
  const beats = ['收到', '进度', '结果'].map((b, i) => `<li class="${i < v.beat ? 'on' : ''}">${b}</li>`).join('');
  const steps = v.steps.length ? `<ol class="steps">${v.steps.map(s => `<li class="${s.bad ? 'bad' : s.you ? 'you' : ''}"><time>${esc(L.clock(s.at))}</time><span>${s.who ? `${esc(nameOf(s.who))}：` : ''}${md(cut(s.text, 120))}${s.evidence.map(fileLink).join('')}</span></li>`).join('')}</ol>` : '';
  const more = steps || v.files.length ? `<details data-open="${esc(v.id)}" ${S.open.has(v.id) ? 'open' : ''}><summary>展开细节${v.steps.length ? `（${v.steps.length} 步）` : ''}</summary>${steps}${v.files.length ? `<div class="files">${v.files.map(fileLink).join('')}</div>` : ''}</details>` : '';
  const ask = v.status === 'needs_you' ? (v.ask ? askBody(v.ask) : `${v.detail ? `<p class="res">${md(v.detail)}</p>` : ''}${v.ask_id ? `<a class="btn go-wait" href="#wait/${encodeURIComponent(v.ask_id)}">回答</a>` : ''}`) : '';
  return `<div class="card is-${esc(v.status)}" data-card="${esc(v.id)}">
    <div class="card-h">${face(v.owner, 'f sm')}<span class="card-t">${esc(v.title)}</span><span class="st t-${esc(v.tone)}">${esc(v.label)}</span></div>
    <ol class="beats" aria-label="${esc(v.label)}">${beats}</ol>
    ${v.now ? `<p class="now"><i></i>${md(cut(v.now, 120))}</p>` : ''}${v.answer && v.status !== 'done' ? `<p class="res mute">你答了：${esc(v.answer)}</p>` : ''}
    ${v.result ? `<p class="res t-${esc(v.tone)}">${md(cut(v.result, 240))}</p>` : ''}${ask}${leadChips(v.leads)}
    ${v.can_withdraw ? `<button type="button" class="btn quiet" data-withdraw="${esc(v.id)}">撤回</button>` : ''}${more}</div>`;
}
function goalHtml(g) {
  if (!g) return '';
  const legs = g.legs.map(x => `<li class="is-${esc(x.status)}">${face(x.owner, 'f xs')}<b>${esc(nameOf(x.owner))}</b><span>${esc(x.what)}</span><em>${esc(x.label)}</em>${x.mac ? `<small class="mac">${esc(x.mac)}</small>` : ''}${x.ask_id ? `<a class="btn sm go-wait" href="#wait/${encodeURIComponent(x.ask_id)}">回答</a>` : ''}</li>`).join('');
  const halt = g.halt ? `<div class="need"><p>${esc(g.halt.question)}</p><div class="opts">${g.halt.options.map(o => `<button type="button" class="btn ${o === '不投了' ? '' : 'pri'}" data-halt="${esc(g.id)}" data-option="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>` : '';
  return `<div class="card goal is-${esc(g.status)}"><div class="card-h">${face('team', 'f sm')}<span class="card-t">${esc(g.title)}</span><span class="st">${esc(g.label)}</span></div><ol class="legs">${legs}</ol>${halt}${g.result ? `<p class="res t-ok">${esc(g.result)}</p>` : ''}</div>`;
}
// 对话里一件活的小条：点了进任务标签里这件的卡片（不再切到一段任务对话）。
const taskLink = (id, title, st, mid = '') => { const tag = L.taskTag(st); return `<button type="button" class="t-link"${mid ? ` data-mid="${mid}"` : ''} data-task-open="${esc(id || '')}"><b>${esc(cut(title, 30))}</b>${tag ? `<span class="st t-${esc(tag.tone)}">${esc(tag.word)}</span>` : ''}</button>`; };
function msgHtml(m) {
  const mid = esc(m.id || '');
  // 接力那一行在任务卡片的「做了什么」里；旧对话里写进去的不画（文件不改）。
  if (m.kind === 'relay') return '';
  // 普通聊天里另开的一件活：一行小条，点了进那件活的对话（指向这段自己的不画）。
  if (m.kind === 'task_link') return taskLink(m.task, m.title || m.content, S.cards[m.task]?.word ? S.cards[m.task] : m, mid);
  // 旧卡现场拼出来的那段：每一步一行、交接单一行、结果和等你的问题一句话（答在输入框上面那一行，或「等你」里）。
  if (m.kind === 'task_step' || m.kind === 'task_handoff') return `<div class="relay" data-mid="${mid}">${face(m.kind === 'task_handoff' ? m.handoff?.from || 'you' : m.persona || 'team', 'f xs')}<b>${esc(nameOf(m.kind === 'task_handoff' ? m.handoff?.from || 'you' : m.persona || 'team'))}</b><span>${esc(cut(m.kind === 'task_handoff' ? String(m.content || '').replace(/^[^：]*：/, '') : m.content, 80))}</span>${(m.evidence || []).map(fileLink).join('')}</div>`;
  if (m.kind === 'task_result' || m.kind === 'task_ask') return `<div class="msg" data-mid="${mid}">${who(m.persona || 'team', m.at)}<div class="bubble ${m.bad ? 'bad' : ''}">${md(m.content)}</div></div>`;
  if (m.kind === 'writer') { const v = L.writerView(S.tasks[`writer:${m.id}`]); return `<div class="msg" data-mid="${mid}">${who('tailor', m.at)}${v.card ? cardHtml(v.card) : `<div class="bubble ${v.bad ? 'bad' : ''}">${md(v.text)}</div>`}</div>`; }
  if (m.role === 'user') return `<div class="msg me" data-mid="${mid}"><div class="bubble">${m.route?.at ? `<span class="at">@${esc(nameOf(m.route.at))}</span> ` : ''}${md(m.content)}</div><time>${esc(L.clock(m.at))}</time></div>`;
  if (m.kind === 'goal' || m.kind === 'card') {
    // 旧对话里的目标卡、单卡（服务端带上了 task、status）：只留一行小条，点了进任务标签里这件的卡片（卡和小条是同一件活，不画两遍）。
    const id = m.task || m.goal || m.card, strip = id && (m.task || m.status) ? taskLink(id, S.cards[id]?.title || m.title || '', S.cards[id]?.word ? S.cards[id] : m) : '';
    const extra = strip ? '' : m.kind === 'goal' ? goalHtml(L.goalView(S.cards[m.goal], S.cards)) : cardHtml(L.cardView(S.cards[m.card], { board: true }));
    return `<div class="msg" data-mid="${mid}">${who(m.persona, m.at)}${String(m.content || '').trim() ? `<div class="bubble">${md(m.content)}</div>` : ''}${extra}${strip}</div>`;
  }
  if (m.kind === 'receipt') {
    const c = m.command || {}, t = S.tasks[c.message_id || (c.op ? `op:${c.op.id}` : '')];
    return `<div class="msg" data-mid="${mid}">${who(m.persona, m.at)}<div class="bubble ${m.ok === false ? 'bad' : ''}">${md(m.content)}</div>${leadChips(m.leads)}${cardHtml(L.cardView(t))}</div>`;
  }
  if (m.role === 'assistant') {
    const acts = (m.actions || []).length ? `<div class="acts">${m.actions.map(a => `<button type="button" class="btn ${/^(发|投)/.test(a) ? 'pri' : ''}" data-act="${esc(a)}">${esc(L.actLabel(a))}</button>`).join('')}</div>` : '';
    // 换了模型答的：一行小字看得出是谁答的（和电脑上同一句）；一件活自己的对话里不放「交给团队去做」。
    const fb = Array.isArray(m.fallback_from) && m.fallback_from[0] ? `<small class="by">由 ${esc(m.fallback_to || m.model || m.backend || '下一个模型')} 回答（${esc(String(m.fallback_from[0].label || m.fallback_from[0].backend || '前一个模型').replace(/[（(][^）)]*[）)]\s*$/, '').trim())} 没调通）</small>` : '';
    const hand = !S.session?.task && m.handoff && !m.handoff.dispatched && S.hello?.device?.hand_off ? `<div class="acts"><button type="button" class="btn pri" data-handoff="${esc(m.handoff.text)}">交给团队去做</button></div>` : '';
    return `<div class="msg" data-mid="${mid}">${who(m.persona, m.at)}<div class="bubble ${m.error ? 'bad' : ''}">${md(m.content)}</div>${m.cut ? `<small class="cut">${esc(m.cut)}</small>` : ''}${fb}${leadChips(m.links)}${acts}${hand}</div>`;
  }
  if (m.role === 'executor') {
    const t = S.tasks[m.reply_key];
    if (t?.reply_id === m.id && t.status === 'done' && t.result) return '';
    return `<div class="msg" data-mid="${mid}">${who(m.persona || 'patch', m.at)}<div class="bubble">${md(m.content)}${m.evidence ? fileLink(m.evidence) : ''}</div></div>`;
  }
  if (m.handoff?.dispatched) { const t = S.tasks[m.handoff.message_id]; return `<div class="msg" data-mid="${mid}">${who(m.persona || t?.persona || 'patch', m.at)}${cardHtml(L.cardView(t))}</div>`; }
  return `<p class="note" data-mid="${mid}">${md(m.content)}</p>`;
}
function paintThread({ bottom = false } = {}) {
  const box = $('#thread'); if (!box) return;
  const title = S.fresh || !S.session ? '团队' : S.session.member ? nameOf(S.session.member) : S.session.title && S.session.title !== '新对话' ? cut(S.session.title, 18) : '团队';
  $('#t-name').innerHTML = esc(title);
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const ms = S.fresh ? [] : S.session?.messages || [];
  const out = ms.map(msgHtml);
  for (const p of S.pend) {
    if (!ms.some(m => m.role === 'user' && m.content === p.text && m.at >= p.at)) out.push(`<div class="msg me pending"><div class="bubble">${p.member ? `<span class="at">@${esc(nameOf(p.member))}</span> ` : ''}${md(p.text)}</div></div>`);
    out.push(`<div class="msg typing">${who(p.persona, null, '<span class="dots"><i></i><i></i><i></i></span>')}</div>`);
  }
  keep(box, () => { box.innerHTML = out.length ? out.join('') : `<div class="empty">${S.talkable.map(k => face(k, 'f')).join('')}</div>`; });
  if (bottom || near) box.scrollTop = box.scrollHeight;
  paintChips();
}
// 抬头（负责人 10-03）：这段对话在跟谁说，只有这一处。聊天里点一位就是接下来问他（团队 = 由 System 分派）；
// 输入框的提示跟着抬头那位走。任务的头和尾在任务标签的卡片上。
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const picked = () => S.to;
function paintCrew() {
  const el = $('#who'); if (!el) return;
  const cur = S.to || 'team';
  el.innerHTML = S.talkable.length ? L.whoRowHtml(cur, ['team', ...S.talkable], { name: nameOf, face: k => face(k, 'f sm'), tint: k => { const f = memberOf(k).face || {}; return HEX.test(f.fill || '') && HEX.test(f.ink || '') ? `--tm-fill:${f.fill};--tm-ink:${f.ink}` : ''; } }) : '';
  el.hidden = !el.innerHTML;
  const i = input(); if (i) i.placeholder = cur !== 'team' ? `问 ${nameOf(cur)}` : '';
}
function paintChips() {
  paintCrew();
  const el = $('#chips'); if (!el) return;
  el.innerHTML = S.focus ? `<span class="chip">${esc(L.focusLabel(S.focus))}${S.focus.company ? `<small>${esc(cut(S.focus.company, 14))}</small>` : ''}<button type="button" data-unfocus aria-label="拿掉">×</button></span>` : '';
}
function setErr(t) { const el = $('#c-err'); if (!el) return; el.textContent = t || ''; el.hidden = !t; }

// 说一句：你的话和「谁在看」马上出来；要发出去的先给你看一遍，确认了才发。
async function send(raw, { via = null, action = null } = {}) {
  const parsed = L.parseAt(raw, crewList()), at = { ...parsed, member: L.memberFor(raw, parsed, picked()) };
  if (at.leads.length && (!S.focus || S.focus.number !== at.leads[0])) { const n = at.leads[0]; S.focus = L.focusOf({ ...(S.refs[n] || {}), number: n }); }
  const text = at.text;
  if (!text) return true;
  if (P?.state().mac === false) { setErr(OFFLINE); return false; }
  setErr('');
  const p = { text, member: at.member, persona: at.member || hintNow()?.persona || lastSpeaker() || 'team', at: new Date().toISOString() };
  S.pend.push(p); paintThread({ bottom: true });
  const drop = () => { S.pend = S.pend.filter(x => x !== p); };
  const body = x => L.talkBody({ session_id: S.fresh ? null : S.sid, text: x.text, member: at.member, focus: S.focus, via, action, confirm: x.confirm });
  try {
    let r = await post('/api/talk', body({ text }));
    if (r.needs_confirm) {
      const v = L.confirmView(r.preview);
      if (!(await P.confirm({ title: v.title, lines: v.lines }))) { drop(); paintThread(); toast('没有发出'); return true; }
      r = await post('/api/talk', body({ text: r.confirm_text || text, confirm: true }));
    }
    drop(); adopt(r); setTimeout(loadTalk, 1500);
    return true;
  } catch (e) {
    drop(); paintThread();
    if (e.json?.cancelled) { toast('没有发出'); return true; }
    setErr(e.offline ? OFFLINE : e.message);
    return false;
  }
}

// ── 输入框：@ 选人、@# 找岗位、下面那一行 ───────────────────────────────────────
const input = () => $('#input');
function grow() { const i = input(); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 132) + 'px'; }
let parseTimer = null, parseSeq = 0, pickSeq = 0;
const parseKey = text => `${S.focus?.rid || S.focus?.number || ''}|${text}`;
function hintNow() {
  const raw = input()?.value.trim() || '';
  if (!raw) return null;
  const parsed = L.parseAt(raw, crewList()), at = { ...parsed, member: L.memberFor(raw, parsed, picked()) };
  return L.hintOf({ at, parse: S.parse.key === parseKey(at.text) ? S.parse.value : null });
}
function paintHint() {
  const h = hintNow(), el = $('#hint');
  el.innerHTML = h ? `<span class="arrow">→</span>${face(h.persona, 'f xs')}<b>${esc(nameOf(h.persona))}</b>${h.text ? `<span>${esc(h.text)}</span>` : ''}${h.confirm ? '<span class="eye" title="发出前给你看">⎋</span>' : ''}` : '';
}
async function parseLater() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(async () => {
    const raw = input().value.trim(), at = raw ? L.parseAt(raw, crewList()) : null;
    if (!at?.text || at.member) return paintHint();
    const key = parseKey(at.text), seq = ++parseSeq;
    if (S.parse.key !== key) {
      try { const v = await get(`/api/talk/parse?text=${encodeURIComponent(at.text.slice(0, 500))}${lastSpeaker() ? `&previous=${encodeURIComponent(lastSpeaker())}` : ''}${S.focus?.rid ? `&focus=${encodeURIComponent(S.focus.rid)}` : ''}`); if (seq === parseSeq) S.parse = { key, value: v }; } catch {}
    }
    paintHint();
  }, 180);
  paintHint();
}
async function picker() {
  const i = input(), tok = L.atToken(i.value, i.selectionStart), seq = ++pickSeq;
  if (!tok) { S.pick = null; return paintPick(); }
  let items;
  if (tok.lead) {
    const q = tok.q.replace(/^#/, '');
    items = [];
    if (q) { try { const d = await get(`/api/leads?q=${encodeURIComponent(q)}&limit=8&per_company=all`); items = (d.rows || []).filter(x => x.number != null && (!/^\d+$/.test(q) || String(x.number).startsWith(q))).slice(0, 6).map(x => ({ kind: 'lead', rid: x.record_id || x.id, number: x.number, company: x.company, role: x.role })); } catch {} }
    if (seq !== pickSeq) return;
  } else items = L.memberMatches(crewList(), tok.q).map(m => ({ kind: 'member', key: m.key, name: m.name, duty: m.title || '' }));
  S.pick = { tok, items }; paintPick();
}
function paintPick() {
  const el = $('#pick');
  if (!S.pick || !S.pick.items.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = S.pick.items.map((x, n) => x.kind === 'member'
    ? `<button type="button" role="option" data-pick="${n}">${face(x.key, 'f')}<b>${esc(x.name)}</b><small>${esc(x.duty)}</small></button>`
    : `<button type="button" role="option" data-pick="${n}"><span class="n">#${esc(x.number)}</span><b>${esc(x.company)}</b><small>${esc(cut(x.role, 28))}</small></button>`).join('');
  el.hidden = false;
}
function choosePick(n) {
  const x = S.pick?.items[n], i = input(); if (!x) return;
  const r = L.applyPick(i.value, S.pick.tok, x);
  i.value = r.text; if (r.focus) { S.focus = r.focus; paintChips(); }
  S.pick = null; paintPick(); grow(); i.focus(); try { i.setSelectionRange(r.caret, r.caret); } catch {}
  parseLater();
}

// ── 对话历史（标题旁边的 ▾）：按时间一列，先取最近的 50 段，滚到底再取下一页；搜交给电脑，搜得到全部 ──
const H = { next: null, loading: false, seq: 0, timer: null };
async function histPage({ reset = false } = {}) {
  if (!reset && (!H.next || H.loading)) return;
  const seq = ++H.seq; H.loading = true;
  try {
    const d = await get(L.pageUrl({ q: S.q, before: reset ? null : H.next }));
    if (seq !== H.seq) return;
    if (d.members) S.members = { ...d.members, ...S.members };
    S.history = reset ? d.sessions || [] : [...(S.history || []), ...(d.sessions || [])]; H.next = d.next || null;
  } catch {} finally { if (seq === H.seq) H.loading = false; }
  if (seq !== H.seq) return;
  paintHistory();
  const el = $('#h-list'); if (el && H.next && el.scrollHeight <= el.clientHeight + 4) histPage();
}
async function openHistory() {
  S.history = S.history || []; S.q = '';
  const bg = $('#hist');
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="对话"><div class="grab"></div><div class="h-top"><input type="search" id="h-q" placeholder="搜对话" aria-label="搜对话"><button type="button" class="btn pri" data-new>＋ 新对话</button></div><div class="h-list" id="h-list"></div></div>`;
  bg.hidden = false; paintHistory();
  $('#h-list').addEventListener('scroll', e => { const l = e.target; if (H.next && !H.loading && l.scrollHeight - l.scrollTop - l.clientHeight < 120) histPage(); });
  await histPage({ reset: true });
}
function closeHistory() { const bg = $('#hist'); bg.hidden = true; bg.innerHTML = ''; clearTimeout(H.timer); }
function searchHistory(v) { clearTimeout(H.timer); H.timer = setTimeout(() => { const q = String(v || '').trim(); if (q === S.q) return; S.q = q; S.history = []; H.next = null; paintHistory(); histPage({ reset: true }); }, 250); }
function paintHistory() {
  const el = $('#h-list'); if (!el) return;
  const rows = L.sessionRows(S.history || [], { q: S.q, current: S.sid, nameOf }), top = el.scrollTop;
  // 一件活带四态小标，聊天不带；有新消息一个小点（正在看的那段不放）。
  const mark = s => `${s.tag ? `<span class="st t-${esc(s.tag.tone)}">${esc(s.tag.word)}</span>` : ''}${s.id !== S.sid && L.isUnread(s) ? '<i class="h-dot" aria-label="有新消息"></i>' : ''}`;
  el.innerHTML = rows.length ? rows.map(s => `<div class="h-row ${s.id === S.sid && !S.fresh ? 'cur' : ''}"><button type="button" class="h-go" data-sid="${esc(s.id)}"><span class="h-f">${face(s.face, 'f sm')}</span><span class="h-t"><b>${esc(cut(s.label, 28))}</b>${s.hit ? `<small>${esc(s.hit)}</small>` : ''}</span>${mark(s)}<time>${esc(L.relTime(s.updated_at))}</time></button><button type="button" class="h-del" data-del="${esc(s.id)}" aria-label="删除">×</button></div>`).join('') + (H.next ? '<p class="h-more" aria-hidden="true"></p>' : '')
    : `<p class="empty-line">${S.q && !H.loading ? '没有找到' : ''}</p>`;
  el.scrollTop = top;
}
function newThread() { S.fresh = true; S.derived = null; S.sid = null; S.session = null; S.tasks = {}; S.cards = {}; S.focus = null; closeHistory(); history.replaceState(null, '', '#talk'); paintThread(); input().focus(); }

// ── 等你 ───────────────────────────────────────────────────────────────────
let waitSig = '';
// 取回来了回 true，取不到（电脑不在线……）回 false。
async function loadWait() {
  let ok = true;
  try {
    // 带上通知点进来要找的那一条：它还在收件箱里就一定在清单里（bin/serve.mjs、lib/hq.mjs phoneInbox）。
    const d = await get(`/api/inbox${S.target ? `?ask=${encodeURIComponent(S.target)}` : ''}`), sig = JSON.stringify([d.asks, d.inflight, d.focus_ids]);
    if (sig === waitSig && S.asks) return true; // 没变：不重画（正在写的字、滚动位置都不动）
    waitSig = sig; S.asks = d.asks || []; S.inflight = d.inflight || []; S.total = d.total ?? S.asks.length; S.focusAsks = d.focus_ids || null;
  } catch { ok = false; if (S.asks == null) S.asks = []; }
  for (const id of [...S.answered.keys()]) if (!S.asks.some(a => a.id === id)) S.answered.delete(id);
  paintBadge(); if (S.tab === 'wait') paintWait();
  return ok;
}
function paintBadge() { const b = $('#badge'), n = (S.asks || []).filter(a => !S.answered.has(a.id)).length; b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n; }
const askOf = id => (S.asks || []).find(a => a.id === id) || Object.values(S.tasks).map(t => t.ask).find(a => a?.id === id) || null;
function messageHtml(p = {}, summary = '') {
  const body = String(p.body ?? ''), full = !!body.trim(), text = full ? body : String(summary ?? '').trim();
  const received = p.received_at ? new Date(p.received_at) : null;
  const time = p.time_label || (received && Number.isFinite(received.getTime()) ? received.toLocaleString('zh-CN', { hour12: false }) : p.received_at || '');
  let url = '';
  try { const u = new URL(p.url); if (typeof p.url === 'string' && p.url.length <= 500 && /^https?:$/.test(u.protocol) && !u.username && !u.password) url = u.href; } catch {}
  const label = full ? (p.truncated ? '收到的消息（已截取）' : '收到的完整消息') : '来信摘要';
  return `<section class="pv received"><div class="received-meta"><b>${esc(cut(p.platform || '消息', 30))}</b>${p.from ? `<span>来自 ${esc(cut(p.from, 200))}</span>` : ''}${time ? `<time>${esc(cut(time, 80))}</time>` : ''}</div>${text ? `${full ? '' : '<p class="sub">来信摘要</p>'}<div class="received-body" aria-label="${label}">${esc(text)}</div>` : '<p class="sub">尚未获取到消息正文。</p>'}${full && p.truncated ? '<p class="sub">消息较长，后半部分在原对话中。</p>' : ''}${url ? `<a class="received-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开原对话</a>` : ''}</section>`;
}
function previewHtml(p) {
  if (!p || typeof p !== 'object') return '';
  if (p.kind === 'message') return messageHtml(p);
  if (p.kind === 'form') return `<details class="pv"><summary>填好的内容</summary><dl>${(p.fields || []).map(f => `<dt>${esc(f.label ?? f.key)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl></details>`;
  if (p.kind === 'draft') return `<details class="pv"><summary>${esc(p.to ? `发给 ${cut(p.to, 30)}` : '要发的内容')}</summary>${p.subject ? `<p><b>${esc(p.subject)}</b></p>` : ''}<pre>${esc(p.body)}</pre></details>${p.warning ? `<p class="sub">${esc(p.warning)}</p>` : ''}`;
  return '';
}
function askPreviewHtml(a) {
  if (a.preview?.kind === 'message') return messageHtml(a.preview, a.detail || a.said);
  return previewHtml(a.preview) || (a.said || a.kind === 'reply' || /^interview:reply:/.test(a.id) ? messageHtml({ url: a.url }, a.detail || a.said) : '');
}
function askBody(a) {
  if (S.answered.has(a.id)) return `<p class="res t-ok">✓ ${esc(cut(S.answered.get(a.id), 160))}</p>`;
  const mac = L.onMacLine(a), preview = askPreviewHtml(a);
  if (mac) return `${preview}<p class="on-mac"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM7 20h10M9 16v4M15 16v4"/></svg>${esc(mac)}</p>`;
  const pick = S.picks.get(a.id), busy = S.busy.has(a.id) ? 'disabled' : '', opts = L.phoneOptions(a), o = pick ? opts.find(x => String(x.key) === String(pick.key)) : null;
  const buttons = opts.length ? `<div class="opts">${opts.map(x => `<button type="button" class="btn ${x.primary ? 'pri' : ''} ${x.danger ? 'danger' : ''} ${pick?.key === x.key ? 'sel' : ''}" data-ask-id="${esc(a.id)}" data-opt="${esc(x.key)}" ${busy}>${esc(x.label)}</button>`).join('')}</div>` : '';
  let extra = '';
  if (pick?.stage === 'reason' && o) extra = `<div class="opts">${[...o.reasons, ''].map(r => `<button type="button" class="btn quiet" data-ask-id="${esc(a.id)}" data-reason="${esc(r)}" ${busy}>${esc(r || '不写原因')}</button>`).join('')}</div>`;
  if (pick?.stage === 'datetime') extra = `<div class="say"><input type="datetime-local" data-dt="${esc(a.id)}"><button type="button" class="btn pri" data-ask-id="${esc(a.id)}" data-dt-go ${busy}>记下</button></div>`;
  if (pick?.stage === 'fields') extra = `<div class="fields">${(a.form || []).map(f => `<label>${esc(f.label)}${f.type === 'choice' ? `<select data-field="${esc(f.key)}"><option value=""></option>${(f.options || []).map(x => `<option>${esc(x)}</option>`).join('')}</select>` : `<input data-field="${esc(f.key)}" type="${{ date: 'date', month: 'month', number: 'number' }[f.type] || 'text'}" value="${esc(f.value ?? '')}">`}</label>`).join('')}<button type="button" class="btn pri" data-ask-id="${esc(a.id)}" data-fields-go ${busy}>${esc(o?.label || '好了')}</button></div>`;
  const say = a.other ? `<div class="say"><input data-say="${esc(a.id)}" placeholder="${esc(a.other.placeholder || '')}" maxlength="1000" enterkeyhint="send"><button type="button" class="btn" data-ask-id="${esc(a.id)}" data-say-go ${busy} aria-label="发送">↑</button></div>` : '';
  const err = pick?.err ? `<p class="c-err">${esc(pick.err)}</p>` : '';
  return `<div class="ask" data-ask-body="${esc(a.id)}"><p class="q">${md(a.question)}</p>${a.note ? `<p class="sub">${md(a.note)}</p>` : ''}${preview}${buttons}${extra}${say}${err}</div>`;
}
function askCard(a) {
  const from = L.memberKey(a.from) || 'team';
  // 这封信属于哪件活：最下面一行它的名字，点了进那件活的对话。
  const t = L.askTask(a), task = t ? `<button type="button" class="ask-task" data-task-open="${esc(t.id)}"><span>${esc(cut(t.title || a.title, 30))}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6l-6 6"/></svg></button>` : '';
  return `<article class="card ask-card" data-ask="${esc(a.id)}"><div class="card-h">${face(from, 'f sm')}<span class="card-t">${esc(a.title)}</span>${a.due_at ? `<time>${esc(L.relTime(a.due_at))}</time>` : ''}</div>${(a.context || []).length ? `<p class="ctx">${a.context.map(esc).join(' · ')}</p>` : ''}${askBody(a)}${task}</article>`;
}
// 重画一块时，里面正在写的字和光标留着。
function keep(el, paint) {
  const vals = [...el.querySelectorAll('input[data-say],input[data-dt],[data-field]')].map(x => [x.closest('[data-ask-body]')?.dataset.askBody, Object.keys(x.dataset)[0], x.dataset[Object.keys(x.dataset)[0]], x.value]);
  const a = document.activeElement, focus = el.contains(a) && a.matches('input,select') ? [a.closest('[data-ask-body]')?.dataset.askBody, Object.keys(a.dataset)[0], a.dataset[Object.keys(a.dataset)[0]], a.selectionStart] : null;
  paint();
  const find = ([id, k, v]) => [...el.querySelectorAll(`[data-ask-body="${CSS.escape(id || '')}"] [data-${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}]`)].find(x => x.dataset[k] === v);
  for (const r of vals) { const x = r[0] && find(r); if (x && r[3]) x.value = r[3]; }
  if (focus?.[0]) { const x = find(focus); if (x) { x.focus(); try { x.setSelectionRange(focus[3], focus[3]); } catch {} } }
}
function paintWait() {
  const el = $('#wait'); if (!el) return;
  keep(el, () => paintWaitNow(el));
}
function paintWaitNow(el) {
  if (S.asks == null) { el.innerHTML = '<div class="spin"></div>'; return; }
  const flow = (S.inflight || []).slice(0, 8).map(x => `<li class="t-${esc(x.tone || '')}"><b>${esc(cut(x.label, 40))}</b><span>${esc(cut(x.stage || '', 60))}</span></li>`).join('');
  const gone = S.targetChecked && L.askGone(S.focusAsks || S.target, S.asks) ? `<p class="empty-line ask-gone">${esc(L.ASK_GONE)}</p>` : '';
  el.innerHTML = `${gone}${S.asks.length ? S.asks.map(askCard).join('') : '<p class="empty-line">没有等你的事</p>'}${flow ? `<h2>进行中</h2><ul class="flow">${flow}</ul>` : ''}`;
}
async function answer(a, extra = {}) {
  if (S.busy.has(a.id)) return;
  if (P?.state().mac === false) { S.picks.set(a.id, { ...(S.picks.get(a.id) || {}), err: OFFLINE }); return repaintAsk(); }
  S.busy.add(a.id); repaintAsk();
  const body = { id: a.id, ...(a.preview?.fingerprint ? { fingerprint: a.preview.fingerprint } : {}), ...extra };
  try {
    let r = await post('/api/inbox/answer', body);
    if (r.needs_confirm) {
      const v = L.confirmView(r.preview || a.preview, r.confirm_text || '确认');
      if (!(await P.confirm({ title: v.title, lines: v.lines.length ? v.lines : [r.confirm_text || a.title].filter(Boolean) }))) { S.picks.delete(a.id); return; }
      r = await post('/api/inbox/answer', { ...body, confirm: true });
    }
    S.picks.delete(a.id); S.answered.set(a.id, r.receipt || '好了');
    setTimeout(() => { loadWait(); if (S.tab === 'talk') loadTalk(); }, 1200);
  } catch (e) {
    if (e.json?.cancelled) S.picks.delete(a.id);
    else S.picks.set(a.id, { ...(S.picks.get(a.id) || {}), err: e.offline ? OFFLINE : e.message });
  } finally { S.busy.delete(a.id); repaintAsk(); paintBadge(); }
}
function repaintAsk() { if (S.tab === 'wait') paintWait(); else paintThread(); }
function choose(a, key) {
  const o = L.phoneOptions(a).find(x => String(x.key) === String(key)); if (!o) return;
  const need = L.optionNeeds(o), cur = S.picks.get(a.id);
  if (need) { S.picks.set(a.id, cur?.key === o.key && cur.stage === need ? null : { key: o.key, stage: need }); if (!S.picks.get(a.id)) S.picks.delete(a.id); return repaintAsk(); }
  answer(a, { option: o.key });
}

// ── 我的 ───────────────────────────────────────────────────────────────────
async function loadMe() {
  try { S.hello = await P.hello(); } catch {}
  try { S.version = await appVersion(); } catch {}
  try { S.supply = await get('/api/model/supply'); } catch {}
  paintMe();
  if (!S.prepared) {
    const c = await P.channel().catch(() => null);
    if (c) { S.prepared = await preparePush(c); paintMe(); }
  }
}
function paintMe() {
  const el = $('#me'); if (!el) return;
  const st = P?.state() || {}, on = st.mac === true && st.link === 'online', dev = S.hello?.device || {}, pushOn = S.push.on ?? dev.push === true;
  const seen = st.lastOk ? L.clock(new Date(st.lastOk).toISOString()) : '';
  el.innerHTML = `
    <div class="group">
      <div class="row"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM7 20h10M9 16v4M15 16v4"/></svg><span class="grow">电脑</span><span class="pill ${on ? 'on' : 'off'}"><i></i>${on ? '在线' : '不在线'}</span></div>
      ${seen ? `<div class="row sub"><span class="grow">最后联系</span><span>${esc(seen)}</span></div>` : ''}
    </div>
    ${S.supply?.show ? `<div class="group"><div class="row supply${S.supply.low || S.supply.empty ? ' low' : ''}" aria-label="${esc(S.supply.label || '')}"><svg class="ic bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/></svg><span class="grow">补给${S.supply.email ? `<small class="who">${esc(S.supply.email)}</small>` : ''}</span>${S.supply.days ? `<span class="pill soon">${esc(S.supply.days)}</span>` : ''}<b>${esc(S.supply.text)}</b></div></div>` : ''}
    <div class="group">
      ${S.renaming ? `<form class="row" id="rename"><input name="name" value="${esc(dev.name || '')}" maxlength="40" aria-label="这部手机的名字" enterkeyhint="done"><button type="submit" class="btn pri">好了</button></form>`
        : `<button type="button" class="row" data-rename><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2"/></svg><span class="grow">${esc(dev.name || '这部手机')}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6l-6 6"/></svg></button>`}
      <div class="row"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1"/></svg><span class="grow">通知</span><button type="button" class="switch" role="switch" aria-checked="${pushOn}" aria-label="通知" data-push ${S.push.busy ? 'disabled' : ''}><i></i></button></div>
      ${S.push.msg ? `<p class="row-note">${esc(S.push.msg)}</p>` : ''}
    </div>
    <div class="group"><button type="button" class="row danger" data-unpair><span class="grow">解除配对</span></button></div>
    <p class="ver">OfferCrew${S.version ? ` · ${esc(S.version)}` : ''}</p>`;
}
async function togglePush() {
  const dev = S.hello?.device || {}, on = S.push.on ?? dev.push === true;
  S.push = { ...S.push, busy: true, msg: '' }; paintMe();
  const c = await P.channel().catch(() => null);
  const r = !c ? { ok: false, message: OFFLINE } : on ? await disablePush(c) : await enablePush(c, S.prepared);
  S.push = { on: r.ok ? !on : on, busy: false, msg: r.ok ? '' : r.message || '没开成' };
  paintMe();
}
async function unpair() {
  if (!(await P.confirm({ title: '解除配对？', lines: ['要再用，得在电脑上重新配对'], go: '解除配对' }))) return;
  const id = S.hello?.device?.id;
  // 电脑解除这部手机后会断开它，答复可能回不来：最多等 4 秒。
  try { if (id) await Promise.race([post('/api/phone', { action: 'unpair', id }), new Promise(r => setTimeout(r, 4000))]); } catch {}
  try { const c = await P.channel(); await c.forget(); } catch {}
  try { const { clearApp } = await import('/p/shared.js'); await clearApp(); } catch {}
  location.replace('/app/'); // 配对页（/ 是产品介绍页）
}

// ── 事件 ───────────────────────────────────────────────────────────────────
document.addEventListener('click', async e => {
  const t = e.target, on = s => t.closest(s);
  let x;
  if ((x = on('#tabs a[data-tab]'))) { e.preventDefault(); return go({ tab: x.dataset.tab }); }
  if ((x = on('a.go-wait'))) { e.preventDefault(); const r = L.route(x.getAttribute('href')); return go(r); }
  if ((x = on('[data-lead]'))) { e.preventDefault(); const n = Number(x.dataset.lead); S.focus = L.focusOf({ ...(S.refs[n] || {}), number: n }); if (S.tab !== 'talk') go({ tab: 'talk' }); paintChips(); parseLater(); return; }
  if (on('[data-unfocus]')) { S.focus = null; paintChips(); parseLater(); return; }
  if ((x = on('[data-to]'))) { S.to = x.dataset.to === 'team' ? null : x.dataset.to; paintCrew(); parseLater(); return; }
  if (on('#t-title')) return openHistory();
  if (on('[data-new]')) return newThread();
  if ((x = on('[data-task-open]'))) { e.preventDefault(); return openCard(x.dataset.taskOpen); }
  if (on('[data-tasks-back]')) { S.card = null; return go({ tab: 'tasks' }); }
  if (on('[data-sub-new]')) { S.sub = { open: true, draft: '' }; paintTasks(); $('#k-sub textarea')?.focus(); return; }
  if (on('[data-sub-cancel]')) { S.sub = null; return paintTasks(); }
  if ((x = on('[data-fold]'))) { const k = x.dataset.fold; S.taskOpen.has(k) ? S.taskOpen.delete(k) : S.taskOpen.add(k); return paintTasks(); }
  // 看原因：System 就地在卡片上答（POST /api/tasks/<id>/why），不开对话。
  if ((x = on('[data-why]'))) { const id = x.dataset.why; S.why = { id, busy: true }; paintTasks(); try { const r = await post(`/api/tasks/${encodeURIComponent(id)}/why`, {}); S.why = { id, content: r.content || '说不上来' }; } catch (err) { S.why = { id, content: err.offline ? OFFLINE : err.message }; } return paintTasks(); }
  if ((x = on('[data-sid]'))) { S.sid = x.dataset.sid; S.derived = null; S.fresh = false; S.session = null; closeHistory(); history.replaceState(null, '', `#talk/${S.sid}`); paintThread(); await loadTalk(); paintThread({ bottom: true }); return; }
  if ((x = on('[data-del]'))) {
    const id = x.dataset.del;
    if (!(await P.confirm({ title: '删除这段对话？', lines: [], go: '删除' }))) return;
    try { await post('/api/chat/delete', { session_id: id }); S.history = S.history.filter(s => s.id !== id); if (id === S.sid) newThread(); else paintHistory(); } catch (err) { toast(err.message); }
    return;
  }
  if (t.id === 'hist') return closeHistory();
  if ((x = on('[data-pick]'))) { e.preventDefault(); return choosePick(Number(x.dataset.pick)); }
  if ((x = on('[data-act]'))) { x.disabled = true; await send(x.dataset.act, { via: 'action' }); x.disabled = false; return; }
  if ((x = on('[data-handoff]'))) { try { const r = await post('/api/chat/handoff', { session_id: S.sid, text: x.dataset.handoff }); adopt(r); loadTalk(); } catch (err) { toast(err.message); } return; }
  if ((x = on('[data-withdraw]'))) { try { const r = await post('/api/talk/withdraw', { session_id: S.sid, message_id: x.dataset.withdraw }); adopt(r); } catch (err) { toast(err.message); } return; }
  // 再试一次（放回排队）、撤回（取消）：手机上只放这两种移动，服务端按这件活现在的状态核对。
  if ((x = on('[data-move]'))) { x.disabled = true; try { await post(`/api/tasks/${encodeURIComponent(x.dataset.move)}/move`, { status: x.dataset.status }); if (S.tab === 'tasks' && S.task) { await loadCard(S.task); paintTasks(); } else await loadTalk(); } catch (err) { x.disabled = false; toast(err.message); } return; }
  if ((x = on('[data-halt]'))) { try { await post(`/api/tasks/${encodeURIComponent(x.dataset.halt)}/answer`, { option: x.dataset.option }); loadTalk(); } catch (err) { if (!err.json?.cancelled) toast(err.message); } return; }
  if ((x = on('[data-opt]'))) { const a = askOf(x.dataset.askId); if (a) choose(a, x.dataset.opt); return; }
  if ((x = on('[data-reason]'))) { const a = askOf(x.dataset.askId), p = a && S.picks.get(a.id); if (p) answer(a, { option: p.key, reason: x.dataset.reason }); return; }
  if ((x = on('[data-dt-go]'))) { const a = askOf(x.dataset.askId), p = a && S.picks.get(a.id), v = document.querySelector(`[data-dt="${CSS.escape(a?.id || '')}"]`)?.value; if (p && v) answer(a, { option: p.key, datetime: v.replace('T', ' ') }); return; }
  if ((x = on('[data-fields-go]'))) {
    const a = askOf(x.dataset.askId), p = a && S.picks.get(a.id); if (!p) return;
    const box = x.closest('.fields'), fields = {}; box.querySelectorAll('[data-field]').forEach(el => { fields[el.dataset.field] = el.value.trim(); });
    const miss = (a.form || []).find(f => !fields[f.key]);
    if (miss) { S.picks.set(a.id, { ...p, err: `「${miss.label}」还没填` }); return repaintAsk(); }
    return answer(a, { option: p.key, fields });
  }
  if ((x = on('[data-say-go]'))) { const a = askOf(x.dataset.askId), v = document.querySelector(`[data-say="${CSS.escape(a?.id || '')}"]`)?.value.trim(); if (a && v) answer(a, { option: 'other', text: v }); return; }
  if (on('[data-rename]')) { S.renaming = true; paintMe(); $('#rename input')?.focus(); return; }
  if (on('[data-push]')) return togglePush();
  if (on('[data-unpair]')) return unpair();
});
document.addEventListener('toggle', e => { const d = e.target; if (d.matches?.('details[data-open]')) (d.open ? S.open.add(d.dataset.open) : S.open.delete(d.dataset.open)); }, true);
document.addEventListener('input', e => {
  if (e.target.id === 'input') { grow(); setErr(''); picker(); parseLater(); }
  if (e.target.closest?.('#k-say')) S.sayDraft = e.target.value;
  if (e.target.closest?.('#k-sub') && e.target.name === 'text' && S.sub) { S.sub.draft = e.target.value; clearTimeout(subSuggest.t); subSuggest.t = setTimeout(() => subSuggest(e.target.value.trim()), 300); }
  if (e.target.id === 'h-q') searchHistory(e.target.value);
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  if (e.target.closest?.('#k-say') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.closest('form').requestSubmit(); }
  if (e.target.matches?.('[data-say]') && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.target.nextElementSibling?.click(); }
});
document.addEventListener('change', e => { if (e.target.matches?.('[data-sub-owner]') && S.sub) S.sub.owner = e.target.value || null; });
document.addEventListener('submit', async e => {
  e.preventDefault();
  // 给这件活下指令 / 加子任务：回来的卡片就地重画；没发出去的那句留在框里。
  if (e.target.id === 'k-say' || e.target.id === 'k-sub') {
    const id = S.card?.id, text = String(new FormData(e.target).get('text') || '').trim(); if (!id || !text) return;
    const say = e.target.id === 'k-say';
    if (say) { S.saying = true; S.sayErr = ''; } else S.sub.busy = true;
    paintTasks();
    try {
      const owner = !say && S.sub?.owner && S.sub.owner !== S.sub.suggest ? S.sub.owner : null;
      const url = `/api/tasks/${encodeURIComponent(id)}/${say ? 'say' : 'subtask'}`, body = { text, ...(owner ? { owner } : {}) };
      let r = await post(url, body);
      // 子任务是投递、联系：先确认（和电脑上同一份预览），取消就什么都不建。
      if (r?.needs_confirm) {
        const rows = (r.preview?.rows || []).map(x => `#${x.number} ${x.company || ''}${x.role ? ` · ${x.role}` : ''}`);
        if (await P.confirm({ title: r.confirm_text, lines: rows.length ? rows : [r.preview?.url].filter(Boolean), go: r.plan === 'contact' ? '确认，开始联系' : '确认，开始预填' })) r = await post(url, { ...body, confirm: true });
        else { toast(`好，先不${r.plan === 'contact' ? '联系' : '投'}了。什么都没做。`); r = null; }
      }
      if (r?.card?.id === id) S.card = r.card;
      if (say) { S.sayDraft = ''; S.sayReply = r?.reply?.text ? { id, who: r.reply.who || null, text: r.reply.text } : null; } else S.sub = null;
    } catch (err) { if (err.json?.cancelled) {} else if (say) S.sayErr = err.offline ? OFFLINE : err.message; else if (S.sub) S.sub.err = err.offline ? OFFLINE : err.message; }
    finally { S.saying = false; if (S.sub) S.sub.busy = false; }
    await loadCard(id); return paintTasks();
  }
  if (e.target.id === 'composer') {
    const i = input(), raw = i.value.trim(); if (!raw) return;
    i.value = ''; grow(); S.pick = null; paintPick(); $('#hint').innerHTML = '';
    if (!(await send(raw))) { if (!i.value) { i.value = raw; grow(); } }
    return;
  }
  if (e.target.id === 'rename') {
    const name = String(new FormData(e.target).get('name') || '').trim(), id = S.hello?.device?.id;
    S.renaming = false;
    if (name && id && name !== S.hello.device.name) { try { await post('/api/phone', { action: 'rename', id, name }); S.hello.device.name = name; } catch (err) { toast(err.message); } }
    paintMe();
  }
});
addEventListener('popstate', () => show(L.route(location.hash)));
addEventListener('hashchange', () => show(L.route(location.hash)));

// 电脑那边有变化（网关的推送经垫片变成 EventSource 的 update）：看得见时刷新对话和「等你」。
let refreshTimer = null;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (document.visibilityState === 'hidden') return; loadWait(); if (S.tab === 'talk') loadTalk(); if (S.tab === 'me') paintMe(); }, 250); }
function live() {
  const es = new EventSource('/api/events');
  es.addEventListener('ready', refreshSoon);
  es.addEventListener('update', refreshSoon);
}

// ── 启动 ───────────────────────────────────────────────────────────────────
(async () => {
  if (!P) return; // 不在手机 App 里（比如在电脑上直接打开这个文件）
  shell();
  P.on((type, e) => { if (type === 'mac' || type === 'link') { if (S.tab === 'me') paintMe(); if (type === 'mac' && e.online) setErr(''); } });
  // 同一条通知点第二次：地址没变不会有 hashchange，直接再走一遍。
  onPushOpen(url => { if (location.hash === url) show(L.route(url)); else location.hash = url; });
  const r = L.route(location.hash);
  P.hello().then(h => { S.hello = h; }).catch(() => {});
  show(r);
  await Promise.all([r.tab === 'talk' ? loadTalk().then(() => paintThread({ bottom: true })) : null, r.tab === 'wait' ? null : loadWait()]);
  live();
})();
