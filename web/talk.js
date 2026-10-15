import { renderTalkText } from './talk-text.js';
// 对话（2026-09-29，右侧面板的「对话」标签；面板本身在 web/panel.js）：在哪一页都能跟团队说话，说完能看到回音。
// 面板里只有这一个输入框：指挥台底部那一栏、侧栏的「对话」页都没有了（#chat 的旧链接打开面板里的那段对话）。
// 背后是 lib/talk.mjs：认得的指令走指挥室同一条路（发送 / 投递照样先弹同一个确认框），别的话交给关键词指向的那位成员；
// 指令的回执、交给团队的事、执行器写回的话都在同一个对话会话里。
// 回音分三拍：
//   收到   发出去的那一刻你的话先出现，下面是「<成员> 在看…」；指令的回执是管这件事的那位说的，写清动了哪几行
//   进行中 交出去的事是一张任务卡：谁在做、做到哪一步（执行器的心跳，一行；展开细节是带时间的每一步和证据）；
//          排队中（60 秒内可撤回）→ 在做 → 做完 / 需要你 / 卡住了，全看执行器自己的报告，从不显示模型的思考过程
//   结果   一句话加链接（查看 #12：指挥台上滚到那一行闪一下）；需要你的就在卡片上答（和收件箱里同一封信）
// 会话（10-03 负责人）：标题行的按钮写这段对话的标题（没有就是「新对话」），点开是对话历史：所有对话按最后说话的时间排成一列
//   （任务和聊天混在一起，任务带四态小标），先取 50 段、滚到底取下一页，搜交给服务端（GET /api/chat?limit=&before=&q=）；+ 新对话。
//   抬头（#tk-thead）是唯一一排成员：这段对话你在跟谁说。聊天里默认团队（System 分派），点一位 = 之后的话都交给它（带 member）；
//   打的 @ 只管那一句，比抬头选的优先。输入框的提示跟着抬头那位走。
// 任务（10-03 负责人「任务卡片」）：对话栏只放对话。聊天里起的活原地一行小条（task_link），点了在主区域打开它的卡片
//   （任务页，web/tasks.js openTaskCard）；旧对话里的目标卡、单卡消息下面同样一行小条。任务的头、尾、换人都不在这里。
//   这一页的主人先选好：材料页 Writer；岗位页按这一条走到哪一步（oc:viewing 的 stage：
//   发现 Radar、判断 / 筛选 Judge、准备到递出 Reacher、回复 / 面试 Watcher）；别的页不选。换了页，点的那位就不跟过去。
//   「比如 …」的例子只在第一次、还没说过一句话时出现（服务端 /api/talk 的 said，加上这台浏览器的 localStorage oc.talk.said）。
//   @#128 把那一条岗位带上（「正在看 #128」，指令里的「这个」就是它）。
//   主区看着哪条岗位（window 上的 oc:viewing 事件，或 hq.js focusLead()），输入框上面自动带着「正在看 #12」，点 × 拿掉；
//   输入框里有字时这个标签锁住不换，字清空了再跟上。
// 面板关着时有回音落地：右下角「问团队」圆按钮上一个点，外加一条提示「Quill 回复了 · 查看」。在做的事不闪、不数。
// 从页面外面叫出来（桌面壳的全局快捷键用这几个）：都只是打开面板、预填，从不替你发——发出去永远要你自己按 Enter。
//   地址   任何一页的 hash 带 talk=1（#command?talk=1）就打开；talk=<一句话> 打开并把这句填进输入框。
//          读完就从地址里拿掉（刷新、后退不会再弹）；页面照常是那一页。
//   事件   window.dispatchEvent(new CustomEvent('offercrew:talk', { detail: { text } }))，text 可省
//   函数   window.OfferCrew.openTalk(text)，text 可省；window.OfferCrew.panel.open({ tab: 'talk', thread, member, text })
//          （member：抬头选中这一位，之后问的由它回答；'team' 是团队）
import { confirmPreview, openDraftEditor } from './command.js';
import { openEditor } from './setup.js';
// hq.js 用命名空间取：团队一排（crewTalk）正在拿掉，哪天它不导出了这里照样能加载。
import * as hq from './hq.js';
import { openPanel, closePanel, panelTab } from './panel.js';
import { faceHtml } from './face.js';
import { askConfirm } from './settings/ask.js';

let h = null, root = null, token = '', members = {}, talkable = [], sid = null, session = null, tasks = {}, cards = {}, refs = {}, active = 0, working = [], examples = null, sandbox = false, modelOk = true;
let fresh = false, unread = null, dirty = false, seeded = false, held = false, stateSeq = 0, lastState = 0, stateTimer = null, pollTimer = null, ticker = null;
let focus = null, focusOff = null, viewing, auto = null, sessions = null, sessionsAt = 0, pick = null, pickSeq = 0;
const seen = new Set(), pendings = [], picks = new Map(), answered = new Map(), busyAsk = new Set(), unfolded = new Set();
let parsed = { key: null, value: null }, parseSeq = 0, parseTimer = null;
let target_, pageAt = null, said = false, examplesGone = false;
// 现场拼出来的只读对话（旧卡、job:<id> 只读卡没有自己的对话文件，GET /api/chat?task= 给 derived: true）：{ task, session }。
// 在里面说一句，POST /api/talk 带它的 id，服务端这时才真建文件；回来的就是普通对话了。
let derived = null;
const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = t => { try { return h.clock(t); } catch { return ''; } };
const isOpen = () => panelTab() === 'talk';
const typingIn = el => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type)));
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ── 成员：名字和脸只读服务端给的那一份（团队名册）；服务端没给「你」和「团队」时用这两个 ──
const FACE = { you: { key: 'you', name: '你', duty: '' }, team: { key: 'team', name: '团队', duty: '找对的成员来回答' } };
const memberOf = k => members[k] || FACE[k] || { key: k, name: k === 'executor' ? '本机 AI' : String(k || '团队'), duty: '' };
const face = (k, cls = '') => faceHtml(memberOf(k), `talk-av ${cls}`);
const nameOf = k => memberOf(k).name;
const lastSpeaker = () => [...(session?.messages || [])].reverse().find(m => m.role === 'assistant' && m.persona)?.persona || null;
const keyOfMember = k => members[k]?.key || (talkable.includes(k) ? k : null);
const crewTalk = x => { try { hq.crewTalk?.(x); } catch {} };
const revealRow = (rid, o) => { try { return hq.revealRow?.(rid, o) || false; } catch { return false; } };
const leadByNumber = q => { try { return hq.leadByNumber?.(q) || []; } catch { return []; } };
// 头像：title 写「名字 · 一句职责」；点它不跳页、不换会话。
const signed = (k, cls = '') => { const m = memberOf(k); return face(k, cls).replace(/^<(\w+) /, `<$1 title="${esc(m.name)}${m.duty ? ' · ' + esc(m.duty) : ''}" `); };

// ── 纯函数（tests/talk-panel.test.mjs 在 vm 里跑）──────────────────────────────
// 输入框里的 @：「@Writer 帮我改简历」→ 只发给 Writer（id、老名字 @Tailor 也认，名册的 aliases）；「@#128 值得投吗」→ 带上 #128（话里留下「#128」）；
// 「@团队」回到整个团队。认不出的 @ 原样留着（邮箱地址里的 @ 前面不是空白，不算）。
export function parseAt(text, list = []) {
  const byName = new Map();
  for (const m of list) { if (!m?.key) continue; for (const a of [m.key, m.name, ...(m.aliases || [])]) if (a) byName.set(String(a).toLowerCase(), m.key); }
  byName.set('团队', 'team'); byName.set('team', 'team');
  let who = null;
  const leads = [];
  let out = String(text ?? '').replace(/(^|\s)@#?(\d{1,6})(?![\d\w])/g, (all, pre, n) => { if (!leads.includes(Number(n))) leads.push(Number(n)); return `${pre}#${n}`; });
  out = out.replace(/(^|\s)@([A-Za-z一-鿿][\w一-鿿]*)/g, (all, pre, name) => { const k = byName.get(name.toLowerCase()); if (!k || who) return all; who = k; return pre; });
  return { member: who, leads, text: out.replace(/[ \t]{2,}/g, ' ').trim() };
}
// 下一步按钮上的字：给人看的话（「批准投递 #28、#29」「跟进 #18」），按钮背后照旧是那条指令（「投 29 28」「18 跟进」）。
// 认不出的指令原样显示。
export function actLabel(cmd) {
  const t = String(cmd ?? '').trim(), nums = s => [...new Set(String(s).match(/\d{1,6}/g) || [])].map(Number).sort((a, b) => a - b).map(n => '#' + n).join('、');
  let m;
  if ((m = /^(?:投|投递)\s+([\d\s,，]+)$/.exec(t))) return `批准投递 ${nums(m[1])}`;
  if ((m = /^(?:发|发送)\s+([\d\s,，]+)$/.exec(t))) return `发出 ${nums(m[1])} 的草稿`;
  if ((m = /^pass\s+([\d\s,，]+)(?:\s+\D.*)?$/i.exec(t))) return `不投 ${nums(m[1])}`;
  if ((m = /^详情\s+(\d{1,6})$/.exec(t))) return `看 #${m[1]} 的详情`;
  const WORD = { 跟进: '跟进', 联系: '联系', 不跟: '不再跟进', 归档: '归档', 不发: '不发', 重新打开: '重新打开' };
  if ((m = /^(\d{1,6})\s*(跟进|联系|不跟|归档|不发|重新打开)$/.exec(t)) || (m = /^(跟进|联系)\s+(\d{1,6})$/.exec(t))) { const [n, w] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]]; return `${WORD[w]} #${n}`; }
  if ((m = /^运行\s+(?:round-)?([a-z-]+)$/.exec(t))) return /^(?:radar|reacher|watch|system|scout|lens|tailor|quill|owl|patch)$/.test(m[1]) ? `${(() => { const id = ({ radar: 'scout', reacher: 'quill', watch: 'owl', system: 'patch' })[m[1]] || m[1], n = nameOf(id); return n === id ? ({ scout: 'Radar', lens: 'Judge', tailor: 'Writer', quill: 'Reacher', owl: 'Watcher', patch: 'System' })[id] : n; })()} 跑一轮` : '运行这项操作';
  return t;
}
// 光标前面正在打的 @（弹出选人）：{ q, start, end }；不在打就是 null。
export function atToken(text, caret) {
  const before = String(text ?? '').slice(0, caret ?? String(text ?? '').length);
  const m = /(^|\s)@(#?[\w一-鿿]*)$/.exec(before);
  return m ? { q: m[2], start: before.length - m[2].length - 1, end: before.length } : null;
}
// 相对时间：刚刚 / N 分钟前 / N 小时前（今天）/ 昨天 21:40 / 9月27日。
const two = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000), d = new Date(t), today = new Date(now), y = new Date(now - 86400000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (dayKey(d) === dayKey(today)) return `${Math.floor(s / 3600)} 小时前`;
  if (dayKey(d) === dayKey(y)) return `昨天 ${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
// 一件活的小标：词和色调是服务端给的（lib/status.mjs，卡、小条、对话行上的 word / tone），和任务页（web/tasks.js dirChip）同一份。
// SIX 只用来判断按钮和提示（状态码 → 状态码），不出字。
const SIX = { unclaimed: 'queued', queued: 'queued', running: 'running', needs_you: 'needs_you', stuck: 'stuck', done: 'done', cancelled: 'cancelled', withdrawn: 'cancelled' };
export const sixOf = st => SIX[st] || null;
export const taskChip = x => x?.word ? `<span class="tb-st is-${esc(x.tone || 'mute')}">${esc(x.word)}</span>` : '';
// 有新消息：这段对话最后的动静晚于你看过的那一下（seen_at 记在服务端，手机和电脑同一份）。
export const isUnread = s => !!s?.updated_at && (!s.seen_at || String(s.updated_at) > String(s.seen_at));
// 对话历史（负责人 10-03）：最外层只有对话，按最后说话的时间排成一列，任务和聊天混在一起（任务带四态小标，聊天不带）。
// 一页一页从服务端取（GET /api/chat?limit=&before=&q=，lib/chat.mjs pageSessions），搜也交给服务端：这里只排、只去重。
// 空会话不列（正在看的那段除外）；定时周期的那几段只在搜的时候出来。
export const PAGE = 50;
export function sessionRows(list = [], { q = '', current = null } = {}) {
  const searching = !!String(q || '').trim(), seen = new Set();
  return list.filter(s => s && !seen.has(s.id) && seen.add(s.id) && (s.messages || s.id === current) && (!s.routine || searching || s.id === current))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || String(b.id).localeCompare(String(a.id)));
}
// 新取回来的第一页并进已经翻过的几页：同一段以新的为准（状态、时间变了），更早的几页留着。
export const mergePage = (fresh = [], old = []) => { const ids = new Set(fresh.map(s => s.id)); return [...fresh, ...old.filter(s => !ids.has(s.id))]; };
export const pageUrl = ({ q = '', before = null, limit = PAGE } = {}) => { const u = new URLSearchParams({ limit: String(limit) }); if (String(q).trim()) u.set('q', String(q).trim()); if (before) u.set('before', before); return '/api/chat?' + u; };
// 旧的对话页链接：#chat、#chat/<会话>、#chat/<成员或旧角色>、#chat?persona=<…> → 面板里的那段对话；页面回到 back。
const OLD_ROLE = { radar: 'scout', reacher: 'quill', watch: 'owl', system: 'patch' }, CREW = ['scout', 'lens', 'tailor', 'quill', 'owl', 'patch'];
export function chatRedirect(hash, back = '#command') {
  const [head, query = ''] = String(hash || '').split('?');
  if (!/^#chat(\/|$)/.test(head)) return null;
  const q = new URLSearchParams(query), rest = decodeURIComponent(head.slice(6) || '').trim().toLowerCase(), persona = String(q.get('persona') || '').toLowerCase();
  const asMember = x => CREW.includes(x) ? x : OLD_ROLE[x] || null;
  const m = asMember(rest) || asMember(persona);
  const thread = !m && /^[a-z0-9]{8,32}$/.test(rest) ? rest : null;
  return { thread, member: m, text: q.has('talk') && q.get('talk') !== '1' ? String(q.get('talk') || '').trim().slice(0, 2000) : '', hash: back && !/^#chat(\/|\?|$)/.test(back) ? back : '#command' };
}

// ── 和服务端说话：自己拿 token（/api/talk 每次都带），页面其它数据还没到时也能用 ──
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Radar-Token': token }, body: JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch {}
  if (r.status === 403 && !post.retried) { post.retried = true; try { await refreshState(); return await post(path, body); } finally { post.retried = false; } }
  if (!r.ok) throw Error(d.error || '请求失败');
  return d;
}
// 边生成边显示：带 stream: true，服务端回 text/event-stream（delta 一块块的字 → done 整个回答，和 post 回的一样）。
// 回的不是流（老的服务端、403 之类）就照 post 读。done 里带着导航栏 ⚡ 那一格（supply），交给 app.js 画（oc:supply）。
async function postStream(path, body, onDelta) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Radar-Token': token }, body: JSON.stringify({ ...body, stream: true }) });
  if (!/event-stream/.test(r.headers?.get?.('content-type') || '') || !r.body?.getReader) {
    let d = {}; try { d = await r.json(); } catch {}
    if (r.status === 403 && !post.retried) { post.retried = true; try { await refreshState(); return await postStream(path, body, onDelta); } finally { post.retried = false; } }
    if (!r.ok) throw Error(d.error || '请求失败');
    return d;
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', done = null, bad = null;
  const take = block => {
    let ev = 'message', data = '';
    for (const l of block.split('\n')) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
    let d = null; try { d = JSON.parse(data); } catch { return; }
    if (ev === 'delta' && typeof d?.text === 'string') onDelta(d.text);
    else if (ev === 'done') done = d;
    else if (ev === 'error') bad = d?.error || '请求失败';
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const b of parts) take(b);
  }
  if (buf.trim()) take(buf);
  if (bad) throw Error(bad);
  if (!done) throw Error('连接断了');
  if (done.supply) try { window.dispatchEvent(new CustomEvent('oc:supply', { detail: done.supply })); } catch {}
  return done;
}

// ── 骨架（面板的「对话」标签里）────────────────────────────────────────────────
function build() {
  root = $('#panel-talk');
  if (!root) return false;
  root.innerHTML = `<div class="tk-thead" id="tk-thead" hidden></div><div class="talk-thread" id="talk-thread" role="log" aria-live="polite" aria-label="对话记录"><div class="tk-msgs" id="tk-msgs"></div></div>
    <div class="tk-foot">
      <div class="tk-tfoot" id="tk-tfoot" hidden></div>
      <div class="tk-pick" id="tk-pick" role="listbox" aria-label="选一位成员或一条岗位" hidden></div>
      <p class="tk-nomodel" id="tk-nomodel" role="status" hidden></p>
      <div class="tk-chips" id="tk-chips"></div>
      <form class="talk-form" id="talk-form" autocomplete="off"><textarea id="talk-input" rows="1" maxlength="2000" placeholder="问团队，或 @ 一位成员" aria-label="和团队说话"></textarea><button type="submit" class="talk-send" aria-label="发送（Enter）">↑</button></form>
      <div class="talk-hint" id="talk-hint"></div>
    </div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', e => { if (e.target.matches?.('[data-say]') && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.target.closest('.tk-say')?.querySelector('[data-say-go]')?.click(); } });
  root.addEventListener('input', e => { if (e.target.matches?.('[data-wq-text]')) keepDraft(e.target); }); // Writer 先问时你写的那句：重画也不丢
  // 展开过的「后台回执原文」「展开细节」重画后还开着。
  root.addEventListener('toggle', e => { const k = e.target?.dataset?.more; if (k) e.target.open ? unfolded.add(k) : unfolded.delete(k); }, true);
  root.addEventListener('focusout', () => setTimeout(() => { if (held && !($('#talk-thread')?.contains(document.activeElement) && typingIn(document.activeElement))) { held = false; paint({ keep: true }); } }, 0));
  const input = $('#talk-input');
  input.addEventListener('input', () => { grow(); schedulePreview(); picker(); });
  input.addEventListener('click', () => picker());
  input.addEventListener('keydown', e => {
    if (pick && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick.i = (pick.i + (e.key === 'ArrowDown' ? 1 : -1) + pick.items.length) % pick.items.length; paintPick(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && pick.items.length) { e.preventDefault(); choosePick(pick.items[pick.i]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closePick(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#talk-form').requestSubmit(); }
  });
  $('#talk-form').addEventListener('submit', e => { e.preventDefault(); const t = input.value.trim(); if (!t) return; if (!canSend()) { note('等上一句有了回音再说下一句（新对话的第一句要先建好会话）。'); return; } input.value = ''; grow(); closePick(); paintHint(); send(t); });
  // 标题行：会话切换、新对话（按钮在 web/panel.js 画的标题行里）。
  $('#pn-title')?.addEventListener('click', () => toggleSwitcher());
  document.querySelector('#panel [data-pn-new]')?.addEventListener('click', () => newThread());
  const pop = $('#pn-pop');
  pop?.addEventListener('click', onSwitcherClick);
  pop?.addEventListener('input', e => { if (e.target.id === 'sw-q') swSearch(); });
  pop?.addEventListener('scroll', swScroll, true); // 滚到底取下一页
  pop?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); $('#pn-title')?.focus(); }
    if (e.key === 'Enter' && e.target.id === 'sw-q') { e.preventDefault(); pop.querySelector('[data-sw]')?.click(); }
  });
  document.addEventListener('pointerdown', e => { if (!pop?.hidden && !e.target.closest?.('#pn-pop, #pn-title')) closeSwitcher(); if (pick && !e.target.closest?.('#tk-pick, #talk-input')) closePick(); });
  return true;
}
const grow = () => { const i = $('#talk-input'); if (!i) return; i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 160) + 'px'; };
const canSend = () => !!sid || !pendings.length;

// ── 打开对话：换会话、换成员、预填、光标 ───────────────────────────────────────
// detail（面板 oc:talk 事件）：{ thread, member, text, focus, session_id, anchor }。什么都不给就是接着手上的那段。
function onTalk(detail = {}) {
  if (!root) return;
  let at = detail.session_id ? { session_id: detail.session_id, anchor: detail.anchor || null } : null;
  // 没说要哪段、有没看的回音：打开到那段、那条。
  if (!at && !detail.thread && !detail.member && unread && (detail.focus || detail.text !== undefined)) at = unread;
  // 「按岗位定制」「改一版」从页面上开的对话（detail.pick）：那一位先选好，问题就在面板里。
  if (detail.pick) { target(); target_ = detail.pick; }
  // 叫一位成员（成员页「和它说」、指挥台「看原因」、旧的 #chat/<成员> 链接，都是 open({ member })）：不换会话，
  // 抬头那排选中这一位，之后的话都交给它（send 里的 to）；member: 'team' 选回团队。名册还没拉回来就等拉回来再认一次。
  const ask = () => { const m = String(detail.member), k = m === 'team' ? null : keyOfMember(m) || (members[m] ? members[m].key || m : null); if (k || m === 'team') { target(); target_ = k; paintCrew(); } return k || m === 'team'; };
  const asked = detail.member ? ask() : false;
  if (detail.thread || at?.session_id) { const id = detail.thread || at.session_id; if (id !== sid) { sid = id; session = null; tasks = {}; } fresh = false; }
  unread = null; paintBar();
  paint({ anchor: at?.anchor || null });
  refreshState({ examples: !examples && !gone() }).then(() => { if (detail.member && !asked) ask(); paint({ anchor: at?.anchor || null, keep: !at?.anchor }); });
  const t = typeof detail.text === 'string' ? detail.text.trim().slice(0, 2000) : '';
  if (detail.member) detail = { ...detail, focus: true };
  const i = $('#talk-input');
  if (t && i) { i.value = t; grow(); schedulePreview(); }
  if ((detail.focus || t) && i) setTimeout(() => { i.focus({ preventScroll: true }); if (t) try { i.setSelectionRange(i.value.length, i.value.length); } catch {} }, 0);
}
function newThread() { sid = null; session = null; tasks = {}; derived = null; fresh = true; focus = null; picks.clear(); closeSwitcher(); openPanel({ tab: 'talk' }); paint(); $('#talk-input')?.focus(); }
// 换到一段会话（对话历史里点的）。@ 不换会话。等状态拉回来：发出去的话要落在对的会话里。
async function switchThread({ thread = null } = {}) {
  if (!thread) return;
  if (thread !== sid) { sid = thread; session = null; tasks = {}; }
  derived = null; fresh = false; closeSwitcher(); paint();
  await refreshState();
  paint({ keep: false });
}
// 一件活在主区域打开它的卡片（任务页，web/tasks.js openTaskCard）；对话栏不再切到一段任务对话（负责人 10-03）。
const openCard = id => { if (!id) return; window.OfferCrew?.openTaskCard?.(id); setTimeout(() => paint({ keep: true }), 0); };
const openTaskNow = () => { try { return window.OfferCrew?.openTaskId?.() || null; } catch { return null; } };
// 头和尾上的按钮做完以后：现场拼的那段重新拼一次，别的照常拉状态。
const reload = () => refreshState();

// ── 画 ───────────────────────────────────────────────────────────────────────
function paint({ anchor = null, keep = false } = {}) {
  if (!root) return;
  paintTitle(); paintCard(); paintChips(); paintTask();
  const box = $('#talk-thread'), msgs = $('#tk-msgs'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80, top = box.scrollTop;
  // 内容没变就不动 DOM（每 5 秒一次的状态刷新不该让动画重来、滚动乱跳）；倒计时这种每秒变的字由 tick() 直接改。
  const html = threadHtml(), changed = html !== paint.last;
  if (changed) { msgs.innerHTML = html; paint.last = html; }
  if (!changed && !anchor) { paintHint(); tick(); return; }
  if (anchor) { const el = box.querySelector(`[data-mid="${CSS.escape(anchor)}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 1800); } else box.scrollTop = box.scrollHeight; }
  else box.scrollTop = keep && !near ? top : box.scrollHeight;
  paintHint();
  tick();
}
// 标题行：这段对话的标题（没有就是「新对话」），不挂哪一位成员的脸。
export const threadTitle = (s, pending = null) => { const t = s?.title && s.title !== '新对话' ? s.title : String((s?.messages || []).find(m => m.role === 'user')?.content || pending || '').replace(/\s+/g, ' ').trim(); return t ? cut(t, 40) : '新对话'; };
function paintTitle() {
  const f = $('#pn-face'), n = $('#pn-name'); if (!f || !n) return;
  f.innerHTML = ''; f.hidden = true;
  n.innerHTML = `<span class="pn-tt">${esc(threadTitle(session, pendings[0]?.text))}</span>`;
  n.closest('#pn-title')?.setAttribute('title', '对话历史');
}

// 抬头那一排小头像（只在普通聊天里，负责人 10-03）：对话栏只放对话，任务的头和尾在任务页的卡片上。
function paintTask() {
  const head = $('#tk-thead'), foot = $('#tk-tfoot'); if (!head) return;
  const selected = target(), html = chatHeadHtml(selected, talkable);
  if (head.innerHTML !== html) head.innerHTML = html;
  head.hidden = !html;
  const input = $('#talk-input');
  if (input) { input.placeholder = placeholder(selected); input.setAttribute('aria-label', selected ? `和 ${nameOf(selected)} 说话` : '和团队说话'); }
  if (foot && !foot.hidden) { foot.innerHTML = ''; foot.hidden = true; }
}
// 没有能用的模型（沙盒、没配、上一轮没调通）：输入框上面一行说清楚；命令和按钮照常能用（lib/talk.mjs crewCommand、commands.mjs）。
function paintModel(ms) {
  const el = $('#tk-nomodel'); if (!el) return;
  // 沙盒不写这一行：左上角的「演示 / 沙盒模式」已经说了（负责人 10-02）。没配、上一轮没调通照写。
  const off = ms && ms.ok === false && ms.why !== 'sandbox';
  el.hidden = !off;
  // 沙盒里写和设置 → 模型、团队页同一句（lib/model-truth.mjs）；别的原因写「现在没有能用的模型」。
  el.textContent = off ? '现在没有能用的模型：对话先停，按钮和命令照常能用' : '';
  el.title = off ? `${ms.note || ''}${ms.note ? '。' : ''}能用的命令：投 12、跟进 18、暂停 / 恢复 <成员>、<成员> 跑一轮` : '';
  paintTitle();
}
// 名册交给 hq.js（团队一排正在拿掉；crewTalk 成了空操作或不导出了也没事）。问谁看抬头那排选着的那位（target()），会话本身不记成员。
export function paintCard() {
  if (paintCard.done) return;
  paintCard.done = true;
  crewTalk({ members, ids: talkable, working, member: null });
}
// 输入框上面：正在看的那一条。@#128 手动带上的优先；否则跟着主区（oc:viewing，没收到过就问 hq.focusLead()）。
// 输入框里有字时不跟：问题不会带错岗位。字清空了再跟上。
const mainLead = () => { if (viewing !== undefined) return viewing; try { return hq.focusLead?.() || null; } catch { return null; } };
// 材料页开着一版简历（web/resume-editor.js 发的 oc:viewing { kind:'resume', doc, version, name, selection }）：
// 「正在看 简历 v4 · 通用版 · 选中 N 行」。同一版上选中的行变了，输入框里有字也跟上（「这几行……」就是说刚选的）。
export const focusKey = x => !x ? null : x.kind === 'resume' ? `resume:${x.doc}:${x.version}` : x.rid || null;
function fromMain(d) {
  if (d?.kind === 'resume') return d.doc && d.version ? { kind: 'resume', doc: String(d.doc), version: String(d.version), name: String(d.name || ''), selection: Array.isArray(d.selection) ? d.selection.map(String).slice(0, 40) : [] } : null;
  return d && (d.rid || d.number != null) ? { rid: d.rid || null, number: d.number, company: d.company || '', role: d.role || '' } : null;
}
function follow() {
  const i = $('#talk-input'), next = fromMain(mainLead()), was = focusKey(auto);
  const sameResume = next?.kind === 'resume' && focusKey(next) === was, moved = sameResume && JSON.stringify(next.selection) !== JSON.stringify(auto.selection);
  if (i && i.value.trim() && !sameResume) return false;
  auto = next;
  if (focusKey(auto) !== was) focusOff = null;
  return focusKey(auto) !== was || moved;
}
function focusNow() {
  if (focus) return focus;
  return auto && focusKey(auto) !== focusOff ? { ...auto, auto: true } : null;
}
export function viewingChanged(detail) { viewing = detail && typeof detail === 'object' ? detail : null; if (follow()) { paintChips(); schedulePreview(); } else paintCrew(); }
// 标签上的字：「正在看 简历 v4 · 通用版 · 选中 1 行」「正在看 #12 Contoso」；还没编号的线索（没接飞书时编号要等点开才补）
// 只写公司和职位：「正在看 网易 · 后端工程师」（开箱第 2 轮 N10）。
const numbered = n => n != null && n !== '';
export function chipParts(f) {
  if (!f) return null;
  if (f.kind === 'resume') { const n = (f.selection || []).length; return { what: `简历 ${f.version}${f.name ? ` · ${f.name}` : ''}`, more: n ? `选中 ${n} 行` : '', title: '' }; }
  const title = `${f.company || ''} · ${f.role || ''}`;
  if (!numbered(f.number)) return { what: cut(f.company || f.role || '岗位', 14), more: '', rest: f.company && f.role ? `· ${cut(f.role, 18)}` : '', title };
  return { what: `#${f.number}`, more: '', rest: cut(f.company || '', 14), title };
}
function paintChips() {
  follow();
  paintCrew();
  const box = $('#tk-chips'); if (!box) return;
  const c = chipParts(focusNow()), th = $('#talk-thread'), near = th && th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  // 标签出现、换行会把输入框顶高：对话本来停在最底下的，还停在最底下（最后一句不被盖住）。
  queueMicrotask(() => { if (near && th) th.scrollTop = th.scrollHeight; });
  box.innerHTML = c ? `<span class="tk-chip"${c.title ? ` title="${esc(c.title)}"` : ''}>正在看 <b>${esc(c.what)}</b>${c.rest ? ` ${esc(c.rest)}` : ''}${c.more ? ` · ${esc(c.more)}` : ''}<button type="button" data-focus-off aria-label="不带这一条">×</button></span>` : '';
}
// ── 输入框上面那一排成员（F6）──────────────────────────────────────────────────
// 这一页的主人：材料页 Writer；岗位页看这一条走到哪一步（web/hq.js setViewing 的 stage，是 lib/workflow.mjs STEPS 的 key，
// 关了的是 ended）；别的页（指挥台、收件箱、团队……）没有。
const STAGE_MEMBER = { found: 'scout', judged: 'lens', screened: 'lens', reply: 'owl', interview: 'owl', result: 'owl' };
const REACH_STEPS = ['prepare', 'contact', 'referrer', 'first_draft', 'dm_draft', 'ref_draft', 'app_draft', 'approve', 'review', 'fill', 'final', 'submitted', 'sent'];
export function pageMember(hash, v) {
  const page = String(hash || '').replace(/^#/, '').split(/[/?]/)[0];
  if (page === 'materials') return 'tailor';
  if (page !== 'lead') return null;
  const st = v?.stage;
  return Object.hasOwn(STAGE_MEMBER, st || '') ? STAGE_MEMBER[st] : REACH_STEPS.includes(st) ? 'quill' : null;
}
// 现在选着谁：你点的（null 是点掉了），没点过就是这一页的主人。换了一页（地址变了），点的就作废。
const hashNow = () => { try { return typeof location !== 'undefined' ? String(location.hash || '') : ''; } catch { return ''; } };
const placeholder = (selected = target()) => selected ? `问 ${nameOf(selected)}` : '问团队';
function target() {
  const h = hashNow(), key = h.split('?')[0];
  if (key !== pageAt) { pageAt = key; target_ = undefined; }
  const k = target_ === undefined ? pageMember(h, mainLead()) : target_;
  return k && (talkable.includes(k) || members[k]) ? k : null;
}
// 请求里的 team 是明确选择；null 才是让服务端自动分派。@团队同样覆盖页面和旧成员。
export const talkRecipient = (mention, selected, explicitTeam = false) => mention || selected || (explicitTeam ? 'team' : null);
function recipient() { const selected = target(); return talkRecipient(null, selected, target_ === null); }
// 抬头那一排跟着换（选的那位、这一页的主人变了），输入框的提示跟着抬头那位走。
function paintCrew() { paintTask(); }
// 例子：说过一句话就不再出现。服务端说过（said）或这台浏览器记着（localStorage 读不了也照常画）。
function gone() {
  if (examplesGone) return true;
  try { examplesGone = globalThis.localStorage?.getItem('oc.talk.said') === '1'; } catch { examplesGone = false; }
  return examplesGone;
}
function spoke() { said = true; examplesGone = true; try { globalThis.localStorage?.setItem('oc.talk.said', '1'); } catch {} }
function threadHtml() {
  const ms = session?.messages || [];
  const out = ms.map(msgHtml);
  for (const p of pendings) {
    const landed = ms.slice(p.base).some(m => m.role === 'user' && m.content === p.text);
    if (!landed) out.push(`<div class="tk-msg is-me is-pending"><div class="tk-bubble">${atTag(p.to)}${md(p.text)}</div><time>刚刚 · 收到</time></div>`);
    if (p.said) { out.push(`<div class="tk-msg is-live">${who(p.persona, p.at)}<div class="tk-bubble">${md(p.said)}</div></div>`); continue; }
    out.push(`<div class="tk-msg tk-typing"><div class="tk-who">${face(p.persona)}<b>${esc(nameOf(p.persona))}</b><span>${p.stage === 'confirm' ? '等你确认…（确认框里看清楚再点）' : p.kind === 'command' ? '在办…' : '在看…'}</span><span class="tk-dots" aria-hidden="true"><i></i><i></i><i></i></span><time data-since="${esc(p.at)}"></time></div></div>`);
  }
  if (out.length) return out.join('');
  // 空着就空着：「比如 …」的例子不放了（负责人 10-02：不放教你怎么用的提示）；输入框上面那排成员就是入口。
  return '<div class="tk-empty"></div>';
}
// 正文：转义后认 `代码`、**粗体**、链接，和 #12 这样的编号（点了在指挥台上看那一行）；模型回的「### 小标题」整行加粗，不露井号。
function md(s) { return renderTalkText(s, { lead: n => refs[n] }); }

// 你 @ 过的那一条：气泡开头留着「@名字」。
const atTag = k => k ? `<b class="tk-at">@${esc(nameOf(k))}</b> ` : '';
const who = (k, at, extra = '') => `<div class="tk-who">${signed(k)}<b>${esc(nameOf(k))}</b>${extra}<time>${esc(clock(at))}</time></div>`;
function rowsHtml(rows = []) {
  if (!rows.length) return '';
  return `<ul class="tk-rows">${rows.map(r => `<li><a href="#lead/${encodeURIComponent(r.rid)}" data-reveal="${esc(r.rid)}" class="tk-row">${numbered(r.number) ? `<b>#${esc(r.number)}</b> ${esc(r.company)}` : `<b>${esc(r.company)}</b>`}<small>${esc(cut(r.role, 40))}</small></a>${r.to ? `<span class="tk-to">→ ${esc(r.to)}</span>` : ''}</li>`).join('')}</ul>`;
}
// ── 任务板（lib/tasks.mjs）：目标卡、接力那一行、单独一张卡 ─────────────────────────
// 手机上开的卡里要开执行器 / 浏览器的那一棒（lib/tasks.mjs mac_hold）：写要跑什么，点了才跑。
const macRun = c => c?.mac_hold && c.status === 'queued' ? `<button type="button" class="tk-btn is-pri" data-tb-release="${esc(c.id)}" title="${esc(c.mac_hold.label)}">在这台电脑上运行</button>` : '';
const STEP_LABEL = { intake: '收录并核验', judge: '判断', tailor: '定制简历', apply: '找内推 / 填表', referrers: '找内推', draft: '写消息', send: '发出', research: '公司调研', prep: '怎么准备', resume: '改简历', letters: '求职信' };
export function goalCardHtml(g, all = {}, { name = nameOf, faceOf = face, board = true } = {}) {
  if (!g) return '';
  const steps = (g.route || []).map(s => ({ ...s, c: s.card ? all[s.card] : null }));
  const segs = steps.filter(s => s.state !== 'skip').map(s => `<i class="is-${s.c ? s.c.status : 'planned'}"></i>`).join('');
  const rows = steps.map(s => {
    const st = s.state === 'skip' ? 'skip' : s.c ? s.c.status : 'planned';
    const hold = macRun(s.c);
    const right = hold ? `<span class="tk-gst is-needs_you">等你确认</span>` : s.state === 'skip' ? (g.can_judge_first ? `<button type="button" class="tk-btn is-quiet" data-tb-judge="${esc(g.id)}">改成先判断</button>` : '') : `<span class="tk-gst is-${esc(st)}">${esc(s.c ? s.c.word || '' : '等上一棒')}</span>`;
    // 这一棒现在做到哪、在等什么：排着的写等什么（沙盒不跑、后台任务关着、等执行器领取…），在做的写最近一步。
    const now = hold ? s.c.mac_hold.label : s.c ? (s.c.status === 'queued' ? bareQueued(s.c.wait_note) : s.c.status === 'running' ? (s.c.steps || []).at(-1)?.text || s.c.detail : '') : '';
    return `<li class="tk-gs is-${esc(st)}"${s.c ? ` data-tb-open="${esc(s.c.id)}"` : ''}>${faceOf(s.owner, 'is-mini')}<b>${esc(name(s.owner))}</b><span>${esc(STEP_LABEL[s.kind] || s.kind)}</span>${s.state === 'skip' && s.why ? `<small>${esc(s.why)}</small>` : ''}${right}${now ? `<small class="tk-gnow">${esc(cut(now, 60))}</small>` : ''}${hold}</li>`;
  }).join('');
  const wait = steps.find(s => s.c?.status === 'needs_you')?.c;
  const need = g.halt && !g.halt.answered ? `<div class="tk-gneed"><p>${esc(g.halt.question)}</p><button type="button" class="tk-btn is-pri" data-tb-open="${esc(g.id)}">回答</button></div>` : wait ? `<div class="tk-gneed"><p>${esc(wait.detail || '要你看一眼')}</p>${wait.wait === 'local_ai' ? '' : `<button type="button" class="tk-btn is-pri" data-tb-open="${esc(wait.id)}">${wait.wait === 'final' ? '终审' : '回答'}</button>`}</div>` : '';
  return `<div class="tk-goal is-${esc(g.status)}" data-goal="${esc(g.id)}"><div class="tk-gh"><b>${esc(g.title)}</b><span class="tk-gst is-${esc(g.status)}">${esc(g.word || '')}</span></div><div class="tk-gbar" aria-hidden="true">${segs}</div><ol class="tk-gsteps">${rows}</ol>${need}${g.status === 'done' && g.result ? `<small class="tk-gres">${esc(g.result)}</small>` : ''}${board ? `<a class="tk-link" href="#tasks?goal=${encodeURIComponent(g.id)}">在任务板上看这件事 →</a>` : ''}</div>`;
}
// 普通聊天里起的一件活：原地一行小条（谁在做、活的标题、现算的状态），点了在主区域打开这件的卡片（data-open-task）。
// 卡片正开着的那一条描一道边（is-open）。
export function taskLinkHtml(m, c = null, { faceOf = face, open = null } = {}) {
  const id = m.task || c?.id || '';
  const who = c?.owner && c.owner !== 'team' ? faceOf(c.owner, 'is-mini') : '';
  return `<button type="button" class="tk-tlink${id && id === open ? ' is-open' : ''}" data-mid="${esc(m.id || '')}" data-open-task="${esc(id)}">${who}<b>${esc(c?.short || m.title || c?.title || '')}</b>${taskChip(c?.word ? c : m)}</button>`;
}
// 旧对话里的目标卡、单卡消息（带 task、status）：卡下面一行同样的小条，点了也是打开卡片。
export function cardLinkHtml(m, c = null, { open = null } = {}) {
  const id = m.task || m.goal || m.card;
  if (!id || !(m.task || m.status || m.task_session)) return '';
  const k = c?.word ? c : { ...(c || {}), id: c?.id || id, status: c?.status || m.status, state: m.state, word: m.word, tone: m.tone };
  return taskLinkHtml({ task: id, title: c?.short || c?.title || m.title || '' }, k, { open });
}
// 抬头（负责人 10-03）：这段对话你在跟谁说话，一排小头像——当前那位带名字、高亮，其他几位点一下就换。
// 普通聊天：默认团队（System 分派），换一位就是接下来问他（data-to）。临时问别人照旧在输入框里 @。
const HEX = /^#[0-9a-fA-F]{3,8}$/;
export function whoRowHtml(cur, keys = [], { attr = () => '', name = nameOf, faceOf = face, label = null } = {}) {
  const tint = k => { const f = memberOf(k).face || {}; return HEX.test(f.fill || '') && HEX.test(f.ink || '') ? ` style="--tm-fill:${f.fill};--tm-ink:${f.ink}"` : ''; };
  const one = (k, on) => `<button type="button" class="tk-who-b${on ? ' is-on' : ''}"${on ? `${tint(k)} aria-pressed="true"` : ` aria-pressed="false" ${attr(k)}`} title="${esc(name(k))}">${faceOf(k, 'is-mini')}${on ? `<b>${esc(label || name(k))}</b>` : ''}</button>`;
  return `<span class="tk-who" role="toolbar" aria-label="在跟谁说">${one(cur, true)}${keys.filter(k => k !== cur).map(k => one(k, false)).join('')}</span>`;
}
export function chatHeadHtml(cur, keys = [], { name = nameOf, faceOf = face } = {}) {
  if (!keys.length) return '';
  return `<div class="tk-th">${whoRowHtml(cur || 'team', ['team', ...keys], { attr: k => `data-to="${esc(k)}"`, name, faceOf })}</div>`;
}
// 旧卡现场拼出来的那段（lib/task-migrate.mjs derivedSession）：每一步一行小字、交接单一行（全文折起来）、结果一句话。
// 等你的问题：尾上已经给了这封信（或目标停下来问的）选项，就不在中间再说一遍。
export function derivedHtml(m, c = null, { name = nameOf, faceOf = face } = {}) {
  const mid = esc(m.id || ''), files = (m.evidence || []).map(f => ` <a class="tk-link" href="/api/evidence?file=${encodeURIComponent(f)}" target="_blank" rel="noopener">证据 ↗</a>`).join('');
  // 步骤文字里已经有名字（「Judge 认领了」）的，前面不再写一遍名字。
  if (m.kind === 'task_step') { const n = name(m.persona || 'team'), named = n && String(m.content || '').startsWith(n); return `<div class="tk-relay tk-dstep" data-mid="${mid}"><time>${esc(clock(m.at))}</time>${faceOf(m.persona || 'team', 'is-mini')}${named ? '' : `<b>${esc(n)}</b>：`}${esc(m.content)}${files}</div>`; }
  if (m.kind === 'task_handoff') { const h = m.handoff || {}; return `<div class="tk-relay" data-mid="${mid}"><time>${esc(clock(m.at))}</time>${faceOf(h.from || 'you', 'is-mini')}<b>${esc(name(h.from || 'you'))}</b> <span class="tk-ar">→</span> ${faceOf(h.to || 'team', 'is-mini')}<b>${esc(name(h.to || 'team'))}</b>：${esc(String(m.content || '').replace(/^[^：]*：/, ''))}${m.handoff_text ? `<details class="tk-more" data-more="${mid}" ${unfolded.has(m.id) ? 'open' : ''}><summary>交接单</summary><small class="tk-detail">${md(m.handoff_text)}</small></details>` : ''}</div>`; }
  if (m.kind === 'task_ask' && c && sixOf(c.status) === 'needs_you' && ((c.ask && c.ask.id === m.ask_id) || String(m.ask_id || '').startsWith('goal:'))) return '';
  return `<div class="tk-msg" data-mid="${mid}">${who(m.persona || 'team', m.at)}<div class="tk-bubble${m.bad ? ' is-bad' : ''}">${md(m.content)}</div></div>`;
}
// 换了模型答的（lib/chat.mjs complete：前面的没调通，换下一个）：回复下面一行小字，看得出是谁答的。
export const answeredBy = m => {
  const x = Array.isArray(m?.fallback_from) ? m.fallback_from[0] : null;
  if (!x) return '';
  const y = m.fallback_to || m.model || m.backend || '';
  const was = String(x.label || x.backend || '前一个模型').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
  return `<small class="tk-by">由 ${esc(y || '下一个模型')} 回答（${esc(was)} 没调通）</small>`;
};
function msgHtml(m) {
  const mid = esc(m.id || m.reply_key || '');
  // 接力那一行（「Radar → Writer：…」）在任务卡片的「做了什么」里；旧对话里写进去的不画（文件不改）。
  if (m.kind === 'relay') return '';
  if (m.kind === 'task_link') return taskLinkHtml(m, cards[m.task] || (m.status ? { status: m.status } : null), { open: openTaskNow() });
  if (m.kind === 'task_origin') return `<div class="tk-origin" data-mid="${mid}">${esc(m.content)}</div>`;
  if (/^task_(step|handoff|result|ask)$/.test(m.kind || '')) return derivedHtml(m, cards[session?.task]);
  if (m.kind === 'writer') return writerHtml(m, tasks[`writer:${m.id}`]);
  if (m.kind === 'goal' || m.kind === 'card') {
    // 有小条（点了在主区域打开这件活的卡片）时只留小条：卡和小条的标题、状态是同一件活的，画两遍看着重复。
    const c = cards[m.card], link = cardLinkHtml(m, cards[m.goal || m.card], { open: openTaskNow() });
    if (link) return `<div class="tk-msg" data-mid="${mid}">${who(m.persona, m.at)}${String(m.content || '').trim() ? `<div class="tk-bubble">${md(m.content)}</div>` : ''}${link}</div>`;
    const one = m.kind === 'card' && c ? `<div class="tk-goal is-${esc(c.status)}"><div class="tk-gh">${face(c.owner, 'is-mini')}<b>${esc(c.title)}</b><span class="tk-gst is-${esc(macRun(c) ? 'needs_you' : c.status)}">${esc(macRun(c) ? '等你确认' : c.word || '')}</span></div>${macRun(c) ? `<small class="tk-gres">${esc(c.mac_hold.label)}</small>${macRun(c)}` : (c.status === 'queued' && bareQueued(c.wait_note)) || c.result || c.detail ? `<small class="tk-gres">${esc((c.status === 'queued' && bareQueued(c.wait_note)) || c.result || c.detail)}</small>` : ''}${link ? '' : `<a class="tk-link" href="#tasks?card=${encodeURIComponent(c.id)}">在任务板上看 →</a>`}</div>` : '';
    return `<div class="tk-msg" data-mid="${mid}">${who(m.persona, m.at)}${String(m.content || '').trim() ? `<div class="tk-bubble">${md(m.content)}</div>` : ''}${m.kind === 'goal' ? goalCardHtml(cards[m.goal], cards, { board: !link }) : one}${link}</div>`;
  }
  if (m.role === 'user') return `<div class="tk-msg is-me" data-mid="${mid}">${m.via === 'action' ? '<small class="tk-via">点了回复里的按钮</small>' : ''}<div class="tk-bubble">${String(m.content || '').trim().toLowerCase().startsWith(`@${nameOf(m.route?.at)}`.toLowerCase()) ? '' : atTag(m.route?.at)}${md(m.content)}</div><time>${esc(clock(m.at))}</time></div>`;
  if (m.kind === 'receipt') {
    const c = m.command || {}, t = tasks[c.message_id || (c.op ? `op:${c.op.id}` : '')];
    const nav = c.navigate ? `<div class="tk-acts"><a class="tk-link" href="${esc(c.navigate)}">打开${/^#lead\//.test(c.navigate) ? '详情' : ''} →</a></div>` : '';
    const opens = (c.open || []).length ? `<div class="tk-acts">${c.open.map(o => `<button type="button" class="tk-btn" data-open-url="${esc(o.url)}">${esc(o.label || '打开')}</button>`).join('')}</div>` : '';
    return `<div class="tk-msg" data-mid="${mid}">${who(m.persona, m.at, `<span class="tk-tag">${esc(c.label || '指令')}</span>`)}<div class="tk-bubble ${m.ok === false ? 'is-bad' : ''}">${md(m.content)}${detailHtml(m.detail, m.id)}</div>${rowsHtml(m.leads)}${nav}${opens}${taskHtml(t)}</div>`;
  }
  if (m.role === 'assistant') {
    // 点过的按钮（后面有一条「点了回复里的按钮」的同一句）打个勾；还能再点，发送 / 投递照样先确认。
    const used = a => (session?.messages || []).some(x => x.role === 'user' && x.via === 'action' && x.content === a && String(x.at) >= String(m.at));
    const wb = Array.isArray(m.why?.buttons) && m.why.buttons.length ? `<div class="tk-acts">${m.why.buttons.map(b => b.href ? `<a class="tk-btn" href="${esc(b.href)}">${esc(b.label)}</a>` : b.act ? `<button type="button" class="tk-btn ${used(b.act) ? 'is-used' : ''}" data-act="${esc(b.act)}">${esc(b.label)}</button>` : '').join('')}</div>` : '';
    const acts = wb || ((m.actions || []).length ? `<div class="tk-acts">${m.actions.map(a => `<button type="button" class="tk-btn ${used(a) ? 'is-used' : /^(发|投)/.test(a) ? 'is-pri' : ''}" data-act="${esc(a)}" title="${used(a) ? '已经点过了' : `点了会执行：${esc(actLabel(a))}`}">${esc(actLabel(a))}</button>`).join('')}</div>` : '');
    // 一件活自己的对话：这件已经交给团队了，「交给团队去做」不出。
    const own = !!session?.task;
    const hand = !own && m.handoff && !m.handoff.dispatched ? `<div class="tk-hand"><button type="button" class="tk-btn is-pri" data-handoff="${esc(m.handoff.text)}" data-persona="${esc(m.persona || '')}">交给团队去做</button><span>${esc(cut(m.handoff.text, 80))}</span></div>` : '';
    // 模型没回：你的原话照样可以交给团队，不会就此断了。
    const asked = m.error ? [...(session?.messages || [])].reverse().find(x => x.role === 'user' && x.at <= m.at) : null;
    const fallback = !own && m.error && asked && !asked.question && !(session?.messages || []).some(x => x.handoff?.text === asked.content) ? `<div class="tk-hand"><button type="button" class="tk-btn" data-handoff="${esc(asked.content)}" data-persona="${esc(m.persona || '')}">直接交给团队去做</button></div>` : '';
    // 中途断了：说出来的那部分留着，下面一句「这句没说完：连接断了」。
    const cutNote = m.cut ? `<small class="tk-cut">${esc(m.cut)}</small>` : '';
    return `<div class="tk-msg" data-mid="${mid}">${who(m.persona, m.at)}<div class="tk-bubble ${m.error ? 'is-bad' : ''}">${md(m.content)}</div>${cutNote}${answeredBy(m)}${remembered(m)}${acts}${hand}${fallback}</div>`;
  }
  // 交出去的那件事做完了：结果就写在它的任务卡上（和卡片同一位成员），回报不再单独重复一遍。
  if (m.role === 'executor' && tasks[m.reply_key]?.reply_id === m.id && tasks[m.reply_key].status === 'done' && tasks[m.reply_key].result) return '';
  if (m.role === 'executor') return `<div class="tk-msg" data-mid="${mid}">${who(m.persona || 'patch', m.at, '<span class="tk-tag is-exec">回报</span>')}<div class="tk-bubble is-report">${md(m.content)}${m.evidence ? ` <a class="tk-link" href="/api/evidence?file=${encodeURIComponent(m.evidence)}" target="_blank" rel="noopener">证据 ↗</a>` : ''}</div></div>`;
  if (m.handoff?.dispatched) { const t = tasks[m.handoff.message_id]; return `<div class="tk-msg" data-mid="${mid}">${who(m.persona || t?.persona || 'patch', m.at, '<span class="tk-tag">交给团队</span>')}<div class="tk-bubble">好，我交给团队去做。</div>${taskHtml(t, m.handoff.text)}</div>`; }
  return `<div class="tk-note" data-mid="${mid}">${md(m.content)}</div>`;
}
// ── Writer 的活（lib/resume-talk.mjs）：在做的时候是一张任务卡；做完是 Writer 的一句话和按钮（样稿 v4-1）──────────
//   体检：几条（点一条，简历上那几行闪一下）+「按这几条改一版」；改一句：「改好了，简历上标黄的那句。」+「撤销」；
//   改一版 / 定制（10-02）：先问——每个问题一排能点的选项和一个自己写的框，一个「开始改」（没答的算跳过）；改完是一张版本卡片：
//   哪一版、改了几处，「打开」和小的「和上一版对比」。按钮点过就灰掉。旧的「查看对比」（Writer 的新版）照旧能开。
// 每张卡上最要紧的那一下（开始改、打开、按这几条改一版）是实心按钮，其余是描边的，对比是一个小字链接。
const WACT_PRI = new Set(['resume_answers', 'resume_open', 'resume_rewrite_from_check']);
export function writerButtonsHtml(t, mid) {
  return (t?.buttons || []).map(b => b.kind === 'resume_compare'
    ? `<a class="tk-wact" href="#materials/compare?doc=${encodeURIComponent(b.doc)}&amp;p=${encodeURIComponent(b.proposal_id)}">${esc(b.label)}</a>`
    : b.href ? `<a class="tk-wact${b.kind === 'resume_versions_compare' ? ' is-small' : WACT_PRI.has(b.kind) ? ' is-pri' : ''}" href="${esc(b.href)}">${esc(b.label)}</a>`
    : `<button type="button" class="tk-wact${b.used ? ' is-used' : WACT_PRI.has(b.kind) ? ' is-pri' : ''}" data-wbtn="${esc(b.kind)}" data-wmsg="${esc(mid)}" data-label="${esc(b.label)}" ${b.used ? 'disabled' : ''}>${esc(b.label)}</button>`).join('');
}
// 先问的那几个问题：选项点一下选中（再点取消），框里自己写的优先；答过以后照你答的样子灰着。
// 还没答时你点的、写的记在 wqDraft（按消息 id）：面板定时重画也不丢。
const wqDraft = new Map(), FILL = '我来填', wqSending = new Set();
export function questionsHtml(t, mid = '', draft = wqDraft.get(mid)) {
  const done = (t.buttons || []).some(b => b.used), ans = (done ? t.answers : draft) || {};
  return `<ol class="tk-wq" data-wq="${esc(mid)}">${(t.questions || []).map(q => {
    const a = ans[q.id] || {};
    // 「我来填」只是去写：点了光标进框，不算选了它（事实只能你自己写，lib/resume-writer.mjs FACT_OPTIONS）。
    const opts = (q.options || []).map(o => o === FILL ? `<button type="button" class="tk-wq-opt is-fill" data-wq-fill ${done ? 'disabled' : ''}>${esc(o)}</button>` : `<button type="button" class="tk-wq-opt${a.option === o ? ' is-on' : ''}" data-wq-opt="${esc(o)}" aria-pressed="${a.option === o}" ${done ? 'disabled' : ''}>${esc(o)}</button>`).join('');
    return `<li data-qid="${esc(q.id)}"><span class="tk-wq-q">${esc(q.text)}</span>${q.about?.text ? `<q class="tk-wq-about">${esc(q.about.text)}</q>` : ''}<div class="tk-wq-opts">${opts}</div><input class="tk-wq-text" data-wq-text maxlength="300" placeholder="自己写" aria-label="${esc(q.text)}" value="${esc(a.text || '')}" ${done ? 'disabled' : ''}></li>`;
  }).join('')}</ol>`;
}
// 版本卡片：改出来的那一版（lib/resume-talk.mjs writerTask 的 card）。
// 第二行（result 的第二行）：比如改的时候你又改过底本——你改的那些不在新版里（card.base_changed）。
const cardNote = t => String(t.result || '').split('\n').slice(1).join(' ').trim() || (t.card?.base_changed ? '你在上一版上后来改的那些不在新版里。' : '');
export const versionCardHtml = (t, mid = '') => `<div class="tk-vcard${t.card.base_changed ? ' is-moved' : ''}"><div class="tk-vcard-h"><b>${esc(t.card.label)}</b>${t.card.kind === 'letter' ? (t.card.note ? `<span class="is-bad">${esc(t.card.note)}</span>` : '') : `<span>${t.card.changes ? `改了 ${t.card.changes} 处` : '没有改动'}</span>`}</div>${t.card.kind !== 'letter' && cardNote(t) ? `<p class="tk-vcard-n">${esc(cardNote(t))}</p>` : ''}<div class="tk-wacts">${writerButtonsHtml(t, mid)}</div></div>`;
export function writerBodyHtml(t, mid = '') {
  const w = t.writer || {}, goto = ids => ids?.length ? ` data-rgoto="${esc(ids.join(' '))}" data-doc="${esc(w.doc)}" data-version="${esc(w.version)}"` : '';
  if (t.card) return `<div class="tk-bubble">${versionCardHtml(t, mid)}</div>`;
  const text = t.items ? `<p>${esc(t.head || '')}</p>${t.items.length ? `<ol class="tk-wlist">${t.items.map(i => `<li${goto(i.line_ids)}>${md(i.text)}</li>`).join('')}</ol>` : ''}${t.rewrite ? `<p>示例改写（只作示例）</p><p><q>${esc(t.rewrite.before)}</q></p><p>${md(t.rewrite.text)}</p>` : ''}${t.note ? `<p class="tk-wnote">${esc(t.note)}</p>` : ''}`
    : t.questions ? `<p>${esc(t.head || '')}</p>${questionsHtml(t, mid)}` : md(t.result || '');
  const acts = writerButtonsHtml(t, mid);
  return `<div class="tk-bubble${t.bad ? ' is-bad' : ''}">${text}${acts ? `<div class="tk-wacts">${acts}</div>` : ''}</div>`;
}
function writerHtml(m, t) {
  const mid = esc(m.id || '');
  if (!t) return `<div class="tk-msg" data-mid="${mid}">${who('tailor', m.at)}</div>`;
  // 在做：和交给团队的事同一张卡（在做 · 已 N 分钟）；做完是 Writer 的一句话（改一版是版本卡片）。旧的改一版（没有卡片）照旧是任务卡 +「查看对比」。
  if (t.status === 'running' || (t.writer?.kind === 'rewrite' && !t.bad && !t.card)) { const acts = writerButtonsHtml(t, m.id); return `<div class="tk-msg" data-mid="${mid}">${who('tailor', m.at)}${taskHtml(t)}${acts ? `<div class="tk-wacts is-card">${acts}</div>` : ''}</div>`; }
  return `<div class="tk-msg" data-mid="${mid}">${who('tailor', t.updated_at || m.at)}${writerBodyHtml(t, m.id)}</div>`;
}
const keepDraft = el => { const ol = el?.closest?.('.tk-wq'); if (ol) wqDraft.set(ol.dataset.wq, collectAnswers(ol).answers); };
// 「开始改」：这条消息里每个问题选中的选项和自己写的那句（没答的不带，服务端算跳过）。→ { answers, text }（text 是记在对话里的那一句）。
export function collectAnswers(root) {
  const answers = {}, said = [];
  for (const li of root?.querySelectorAll?.('li[data-qid]') || []) {
    const option = li.querySelector('.tk-wq-opt.is-on')?.dataset.wqOpt || '', text = (li.querySelector('[data-wq-text]')?.value || '').trim();
    if (!option && !text) continue;
    answers[li.dataset.qid] = { ...(option ? { option } : {}), ...(text ? { text } : {}) };
    said.push(text || option);
  }
  return { answers, text: said.length ? `开始改：${said.join('；')}` : '开始改' };
}
// 回话下面不再挂模型、token、秒数那一行（负责人 09-30：用量在「运行与用量」）。
const asked0 = m => [...(session?.messages || [])].reverse().find(x => x.role === 'user' && x.at <= m.at) || null;
// 后台脚本的原话：短的跟在后面；长的（投递的逐条说明）折起来，要看再点开。
const detailHtml = (d, mid = '') => !d ? '' : d.length > 80 || /\n/.test(d) ? `<details class="tk-more" data-more="${esc(mid)}" ${unfolded.has(mid) ? 'open' : ''}><summary>后台回执原文</summary><small class="tk-detail">${md(d)}</small></details>` : `<small class="tk-detail">${md(d)}</small>`;
// 记进记忆库的：你自己说的「记住：…」照原话回一句；模型顺手记下的不念原文（10-01：原文里有「waiting_user」这种代号），
// 只说记下了，记忆库里能看能删。
const remembered = m => (m.remembered || []).length ? `<small class="tk-mem">${m.role === 'user' ? m.remembered.map(r => `★ 记住了：${esc(r.text)}`).join('<br>') : `★ 已记下${m.remembered.length > 1 ? ` ${m.remembered.length} 条` : '一条'}经验（<a href="#settings/advanced/memory">记忆库</a>里可以看、可以删）`}</small>` : '';

// ── 任务卡：谁在做、做到哪一步；状态词是服务端给的（lib/talk.mjs sessionTasks 带 word / tone）──────────────
const STEP_AT = { queued: 1, running: 2, done: 4, needs_you: 3, stuck: 3, withdrawn: 1 };
const TOOL = { browser: '用浏览器' };
// 一步给人看的样子：「Quill · 用浏览器：填表 9/12」。只有执行器报的进展和交的结果，没有模型的思考过程。
const stepText = s => `${esc(nameOf(s.who))}${s.tool && TOOL[s.tool] ? ` · ${TOOL[s.tool]}` : ''}：${md(cut(s.text, 90))}`;
export function taskHtml(t, title = null) {
  if (!t) return '';
  const steps = t.steps || [], last = steps.at(-1);
  const live = t.status === 'queued' && t.fire_at ? `data-fire="${esc(t.fire_at)}"` : t.status === 'running' ? `data-run="${esc(t.since)}"` : '';
  const head = `<div class="tk-task-h">${face(t.persona, 'is-mini')}<b>${esc(nameOf(t.persona))}</b><span class="tk-task-t" title="${esc(title || t.title)}">${esc(cut(title || t.title, 60))}</span><span class="tk-st"><span class="tk-dot"></span>${esc(t.word || '')}</span></div>`;
  const bar = `<div class="tk-bar" aria-hidden="true">${[1, 2, 3, 4].map(i => `<i class="${i <= (STEP_AT[t.status] ?? 1) ? 'is-on' : ''}"></i>`).join('')}</div>`;
  const now = last && ['running', 'queued'].includes(t.status) ? `<div class="tk-nowline"><span class="tk-dot"></span>${stepText(last)}</div>` : '';
  const when = `<div class="tk-whenrow"><span class="tk-when" data-task-when="${esc(t.id)}" ${live}>${live ? '' : esc(whenText(t))}</span>${t.can_withdraw ? `<button type="button" class="tk-btn is-quiet" data-withdraw="${esc(t.id)}">撤回</button>` : ''}</div>`;
  const key = `steps:${t.id}`;
  const files = (t.evidence_files || []).map(f => `<a class="tk-link" href="/api/evidence?file=${encodeURIComponent(f)}" target="_blank" rel="noopener">${/\.(png|jpe?g|webp|gif)$/i.test(f) ? '截图' : /\.log$/i.test(f) ? '日志' : '证据'} ↗</a>`).join(''); // 写它是什么，不写文件名
  const log = steps.length || files ? `<details class="tk-more tk-log-d" data-more="${esc(key)}" ${unfolded.has(key) ? 'open' : ''}><summary>展开细节${steps.length ? `（${steps.length} 步）` : ''}</summary>${steps.length ? `<ol class="tk-log">${steps.map(s => `<li class="${s.status === 'blocked' || s.status === 'failed' ? 'is-bad' : s.status === 'waiting_user' ? 'is-you' : ''}"><time>${esc(clock(s.at))}</time><span>${stepText(s)}${(s.evidence || []).map(f => ` <a class="tk-link" href="/api/evidence?file=${encodeURIComponent(f)}" target="_blank" rel="noopener">证据 ↗</a>`).join('')}</span></li>`).join('')}</ol>` : ''}${files ? `<div class="tk-links">${files}</div>` : ''}</details>` : '';
  return `<div class="tk-task is-${esc(t.status)}" data-task="${esc(t.id)}">${head}${bar}${now}${when}${resultHtml(t)}${log}</div>`;
}
const secs = iso => Math.round((Date.parse(iso) - Date.now()) / 1000);
// 排着的那一行：状态小标已经写了「排队中」，说明里不再以它开头（「排队中：等 Writer 接手」→「等 Writer 接手」）。
const bareQueued = t => String(t || '').replace(/^排队中[：:，,\s]*/, '');
function whenText(t) {
  if (t.status === 'queued') {
    if (t.behind) return '等上一轮做完就开始';
    if (t.fire_at) { const s = secs(t.fire_at); if (s > 0 && !t.hold) return `${t.can_withdraw ? '60 秒内可撤回 · ' : ''}还有 ${s} 秒开始`; }
    // 服务端写的真话（lib/tasks.mjs holdReason）：沙盒不跑、后台任务关着、执行器暂停、等执行器领取；排着的操作「前面还有 N 个」。
    const hold = bareQueued(t.hold);
    if (hold) return `${hold}${t.can_withdraw ? ' · 可撤回' : ''}`;
    return t.attempts ? `第 ${t.attempts + 1} 次` : '';
  }
  if (t.status === 'running') { const m = Math.max(0, Math.round((Date.now() - Date.parse(t.since)) / 60000)); return m ? `已 ${m} 分钟` : '刚开始'; }
  return clock(t.updated_at);
}
function resultHtml(t) {
  const links = [...(t.leads || []).map(r => `<a href="#lead/${encodeURIComponent(r.rid)}" class="tk-link" data-reveal="${esc(r.rid)}">查看 ${numbered(r.number) ? `#${esc(r.number)}` : esc(r.company || '岗位')}</a>`), t.evidence ? `<a class="tk-link" href="/api/evidence?file=${encodeURIComponent(t.evidence)}" target="_blank" rel="noopener">证据 ↗</a>` : '', t.reply_id && !(t.status === 'done' && t.result) ? `<a href="#" class="tk-link" data-jump="${esc(t.reply_id)}">看它的回报</a>` : ''].filter(Boolean).join('');
  if (t.status === 'done') return `<p class="tk-result">${md(cut(t.result || '做完了', 160))}</p>${links ? `<div class="tk-links">${links}</div>` : ''}`;
  if (t.status === 'stuck') return `<p class="tk-result is-bad">${md(cut(t.detail || '没做成，原因没写下来', 200))}</p><div class="tk-links">${links}<a class="tk-link" href="#stream">看运行日志</a></div>`;
  if (t.status === 'withdrawn') return '<p class="tk-result is-mute">撤回了，这件事不做了。</p>';
  if (t.status === 'needs_you') return askHtml(t) + (links ? `<div class="tk-links">${links}</div>` : '');
  const said = t.answer ? `<p class="tk-result is-mute">你答了：${esc(t.answer)}</p>` : '';
  // 桌面版本机 AI 没打开（服务端 lib/tasks.mjs holdOf 给的 hold_go）：排着的卡上直达设置里那个开关。
  const toSwitch = t.status === 'queued' && t.hold_go ? `<div class="tk-links"><a class="tk-link" href="${esc(t.hold_go)}">本机 AI 开关 →</a></div>` : '';
  return said + (links && t.status === 'running' ? `<div class="tk-links">${links}</div>` : '') + toSwitch;
}
// 需要你：就在卡片上答。选项、原因、时间、要补的几项、「自己说一句」，和收件箱里是同一封信（/api/inbox/answer）。
function askHtml(t) {
  const a = t.ask;
  // 等打开本机 AI 的（迁到引擎做、要动电脑的那件）：没有要答的问题，只给开关。
  if (!a && t.wait === 'local_ai') return `<p class="tk-result">${md(t.detail || '')}</p>${t.hold_go ? `<div class="tk-links"><a class="tk-link" href="${esc(t.hold_go)}">本机 AI 开关 →</a></div>` : ''}`;
  if (!a) return `<p class="tk-result">${md(t.detail || '在等你回答')}</p><div class="tk-links"><a class="tk-link" href="#inbox">回答 →</a></div>`;
  if (answered.has(a.id)) return `<p class="tk-result is-ok">✓ ${esc(cut(answered.get(a.id), 160))}</p>`;
  const p = picks.get(a.id), dis = busyAsk.has(a.id) ? 'disabled' : '';
  const o = p ? a.options.find(x => String(x.key) === String(p.key)) : null;
  const fields = a.form?.length && a.options.some(x => x.input === 'fields') ? `<div class="tk-fields">${a.form.map(f => `<label>${esc(f.label)}${f.type === 'choice' ? `<select data-field="${esc(f.key)}"><option value="">请选择</option>${(f.options || []).map(x => `<option ${x === f.value ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<input data-field="${esc(f.key)}" value="${esc(f.value ?? '')}" type="${{ date: 'date', number: 'number' }[f.type] || 'text'}" autocomplete="off">`}</label>`).join('')}</div>` : '';
  const opts = `<div class="tk-opts">${a.options.map(x => `<button type="button" class="tk-btn ${x.primary ? 'is-pri' : ''} ${x.danger ? 'is-danger' : ''} ${p?.key === x.key ? 'is-sel' : ''}" data-opt="${esc(x.key)}" title="${esc(x.hint || '')}" ${dis}>${esc(x.label)}${x.reasons ? ' ▾' : ''}</button>`).join('')}</div>`;
  const reasons = p?.stage === 'reason' ? `<div class="tk-opts">${[...o.reasons, '不填原因'].map(x => `<button type="button" class="tk-btn is-quiet" data-reason="${esc(x === '不填原因' ? '' : x)}" ${dis}>${esc(x)}</button>`).join('')}</div>` : '';
  const dt = p?.stage === 'datetime' ? `<div class="tk-say"><input type="datetime-local" data-dt><button type="button" class="tk-btn is-pri" data-dt-go ${dis}>记下</button></div>` : '';
  const confirm = p?.stage === 'confirm' ? `<div class="tk-confirm"><span>${esc(p.text || o?.hint || '确认？')}${p.server ? '' : '（提交后撤不回来）'}</span><button type="button" class="tk-btn is-pri" data-go ${dis}>确认${esc(o?.label || '')}</button><button type="button" class="tk-btn is-quiet" data-cancel-pick>取消</button></div>` : '';
  const say = a.other ? `<div class="tk-say"><input data-say placeholder="${esc(a.other.placeholder || '或者直接说一句')}" maxlength="1000"><button type="button" class="tk-btn" data-say-go ${dis}>发送</button></div>` : '';
  return `<div class="tk-ask" data-ask="${esc(a.id)}"><p class="tk-q">${md(a.question)}</p>${a.note ? `<p class="tk-note-s">${md(a.note)}</p>` : ''}${fields}${opts}${reasons}${dt}${confirm}${say}</div>`;
}
function askById(id) { for (const t of [...Object.values(tasks), ...Object.values(cards)]) if (t?.ask?.id === id) return t.ask; return null; }
async function answer(a, key, extra = {}) {
  if (busyAsk.has(a.id)) return;
  busyAsk.add(a.id); paint({ keep: true });
  try {
    const res = await post('/api/inbox/answer', { id: a.id, option: key, ...(a.preview?.fingerprint ? { fingerprint: a.preview.fingerprint } : {}), ...extra });
    if (res.needs_confirm) { picks.set(a.id, { key, stage: 'confirm', server: true, text: res.confirm_text || '' }); return; }
    if (res.client?.draft_editor) { openDraftEditor(res.client.draft_editor); return; }
    // 跳到站内某一页、打开资料编辑器（「补信息」）：和收件箱、指挥台一样做，不再只说一句「已打开」。
    if (res.client?.navigate) { location.hash = res.client.navigate; return; }
    if (res.client?.profile_editor) { openEditor(res.client.profile_editor, h, res.client.profile_context); return; }
    // 只打开了页面（登录页、投递页）：卡片和选项留着（「我登好了」还要点），只说一句做了什么。
    if (res.done === false) { picks.delete(a.id); note(res.receipt || '已打开'); return; }
    picks.delete(a.id); answered.set(a.id, res.receipt || '已答复'); dirty = true;
    setTimeout(() => reload(), 1200);
  } catch (e) { note(e.message); } // 服务端的话本身说清了（打开页面没成、要你先确认……），不再一律加「没交上去」
  finally { busyAsk.delete(a.id); paint({ keep: true }); }
}
function choose(a, key) {
  const o = a.options.find(x => String(x.key) === String(key)); if (!o) return;
  if (o.reasons?.length) { const p = picks.get(a.id); picks.set(a.id, p?.key === o.key && p.stage === 'reason' ? null : { key: o.key, stage: 'reason' }); if (!picks.get(a.id)) picks.delete(a.id); paint({ keep: true }); return; }
  if (o.input === 'datetime') { picks.set(a.id, { key: o.key, stage: 'datetime' }); paint({ keep: true }); return; }
  if (o.input === 'fields') { const box = root.querySelector(`.tk-ask[data-ask="${CSS.escape(a.id)}"]`), values = {}; box?.querySelectorAll('[data-field]').forEach(el => { values[el.dataset.field] = el.value.trim(); }); const miss = (a.form || []).find(f => !values[f.key]); if (miss) { note(`「${miss.label}」还没填`); return; } answer(a, o.key, { fields: values }); return; }
  if (o.confirm === 'inline') { picks.set(a.id, { key: o.key, stage: 'confirm' }); paint({ keep: true }); return; }
  answer(a, o.key);
}

// ── 输入框下面那一行：空着说谁会回你；打字时说这句会怎么办 ────────────────────────
function schedulePreview() { clearTimeout(parseTimer); parseTimer = setTimeout(preview, 140); }
const parseKey = (text, member = recipient()) => `${member || ''}|${focusKey(focusNow()) || ''}|${text}`;
async function parseOf(text, member = recipient()) {
  const key = parseKey(text, member);
  if (parsed.key === key && parsed.value) return parsed.value;
  const seq = ++parseSeq, f = focusNow();
  try { const r = await fetch(`/api/talk/parse?text=${encodeURIComponent(text.slice(0, 500))}${member ? '&member=' + encodeURIComponent(member) : ''}${lastSpeaker() ? '&previous=' + lastSpeaker() : ''}${f?.rid ? '&focus=' + encodeURIComponent(f.rid) : ''}`); const v = await r.json(); if (seq === parseSeq) parsed = { key, value: v }; return v; }
  catch { return null; }
}
async function preview() { const t = $('#talk-input')?.value.trim() || ''; const at = t ? parseAt(t, crewList()) : null; if (at?.text) await parseOf(at.text, at.member || recipient()); paintHint(); }
function paintHint() {
  const box = $('#talk-hint'); if (!box) return;
  const raw = $('#talk-input')?.value.trim() || '', at = raw ? parseAt(raw, crewList()) : null;
  if (!raw) { box.innerHTML = ''; return; }
  const v = parsed.key === parseKey(at?.text || raw, at?.member || recipient()) ? parsed.value : null;
  if (!at?.text) { box.innerHTML = ''; return; }
  if (!v) { box.innerHTML = '<span class="tk-parse is-mute">…</span>'; return; }
  if (v.kind === 'command') {
    const rows = (v.rows || []).map(r => `#${r.number} ${esc(r.company)}${r.role ? ' · ' + esc(cut(r.role, 28)) : ''}`).join('；');
    const n = (v.rows || []).length, miss = (v.missing || []).length ? `（${v.missing.map(x => '#' + x).join(' ')} 不在表上）` : '';
    box.innerHTML = `<span class="tk-parse">→ <b>${esc(v.verb)}${n ? ` ${n} 条` : ''}</b>${rows ? '：' + rows : ''}${miss}${v.note ? `<span class="tk-parse-note">（${esc(cut(v.note, 30))}）</span>` : ''}</span><span class="talk-grow"></span><span class="tk-who-s">${face(v.persona, 'is-mini')}${esc(nameOf(v.persona))} 去办${v.confirm ? ' · 发出前还会给你看一遍' : ''}</span>`;
    return;
  }
  const who_ = v.kind === 'company_search' ? v.persona : v.kind === 'chat' && (at.member || recipient()) === 'team' ? 'team' : at.member || target() || (v.kind === 'chat' && toWriter(at.text, focusNow()) ? 'tailor' : v.persona);
  box.innerHTML = `<span class="tk-parse is-mute">→ 交给 ${face(who_, 'is-mini')}<b>${esc(nameOf(who_))}</b>${memberOf(who_).duty ? `（${esc(memberOf(who_).duty)}）` : ''}回你</span>`;
}
// 带着一版简历的「正在看」时，服务端把简历的事交给 Writer（lib/resume-talk.mjs wantsWriter）；这里照着同样的词给输入框下面那一行。
const RESUME_TALK = /这(?:几|一|两|三)?(?:行|句|段|条)|体检|诊断|检查一下|改一版|重写|定制|改简历|润色|措辞/, EDIT_WORD = /改|写|换|突出|精简|简洁|删|加上|加粗|润色|调整|缩短|简短|强调|措辞|具体|量化|动词|通顺|翻译|去掉/;
export const toWriter = (text, f) => f?.kind === 'resume' && (RESUME_TALK.test(String(text || '')) || ((f.selection || []).length > 0 && EDIT_WORD.test(String(text || ''))));

// ── @ 选人：成员（团队一排里的这几位）和岗位（@# 加编号或公司名）──────────────────
const crewList = () => talkable.map(k => ({ ...memberOf(k), key: memberOf(k).key || k }));
async function picker() {
  const i = $('#talk-input'); if (!i) return;
  const tok = atToken(i.value, i.selectionStart);
  if (!tok) { closePick(); return; }
  const seq = ++pickSeq, q = tok.q.toLowerCase();
  let items;
  if (q.startsWith('#') || /^\d/.test(q)) {
    const n = q.replace(/^#/, '');
    items = (await leadsLike(n)).map(r => ({ kind: 'lead', ...r }));
    if (seq !== pickSeq) return;
    if (!items.length) items = [{ kind: 'none', text: n ? `没有 #${n}` : '打编号或公司名' }];
  } else {
    items = [...crewList().filter(m => !q || [m.key, m.name, ...(m.aliases || [])].some(a => String(a || '').toLowerCase().startsWith(q))).map(m => ({ kind: 'member', key: m.key, name: m.name, duty: m.duty })),  ...(!q ? [{ kind: 'hint', text: '@# 加编号，带上一条岗位' }] : [])];
  }
  pick = { tok, items, i: Math.min(pick?.i || 0, Math.max(0, items.filter(x => x.kind === 'member' || x.kind === 'lead').length - 1)) };
  pick.items = items.filter(x => x.kind === 'member' || x.kind === 'lead');
  pick.extra = items.filter(x => x.kind === 'hint' || x.kind === 'none');
  paintPick();
}
// 岗位：先看指挥台已经拉到的行（编号、公司、岗位），再问服务端（/api/leads，只读）。
async function leadsLike(q) {
  const local = leadByNumber(q);
  if (local.length >= 6 || !q) return local.slice(0, 6);
  try { const r = await fetch(`/api/leads?q=${encodeURIComponent(q)}&limit=8&per_company=all`); const d = await r.json(); const more = (d.rows || []).map(x => ({ rid: x.record_id || x.id, number: x.number, company: x.company, role: x.role })).filter(x => x.number != null && !local.some(y => y.number === x.number)); return [...local, ...more].filter(x => !/^\d+$/.test(q) || String(x.number).startsWith(q)).slice(0, 6); }
  catch { return local.slice(0, 6); }
}
function paintPick() {
  const box = $('#tk-pick'); if (!box) return;
  if (!pick) { box.hidden = true; box.innerHTML = ''; return; }
  const rows = pick.items.map((x, n) => x.kind === 'member'
    ? `<button type="button" role="option" class="tk-pi ${n === pick.i ? 'is-on' : ''}" data-pick="${n}" aria-selected="${n === pick.i}">${face(x.key, 'is-mini')}<b>${esc(x.name)}</b><small>${esc(x.duty || '')}</small></button>`
    : `<button type="button" role="option" class="tk-pi ${n === pick.i ? 'is-on' : ''}" data-pick="${n}" aria-selected="${n === pick.i}"><span class="tk-pi-n">#${esc(x.number)}</span><b>${esc(x.company)}</b><small>${esc(cut(x.role, 30))}</small></button>`).join('');
  box.innerHTML = `${rows}${(pick.extra || []).map(x => `<div class="tk-pi-hint">${esc(x.text)}</div>`).join('')}`;
  box.hidden = false;
}
function closePick() { pick = null; paintPick(); }
async function choosePick(x) {
  const i = $('#talk-input'); if (!i || !pick || !x) return;
  const { start, end } = pick.tok, before = i.value.slice(0, start), after = i.value.slice(end).replace(/^\s+/, '');
  closePick();
  if (x.kind === 'member') {
    // @ 一位成员：在输入框里写上「@名字 」，这一条发出去时交给它；不换会话。
    i.value = `${before}@${x.name} ${after}`; grow();
  } else {
    focus = { rid: x.rid, number: x.number, company: x.company, role: x.role }; focusOff = null;
    i.value = `${before}#${x.number} ${after}`; grow(); paintChips();
  }
  i.focus(); const p = i.value.length; try { i.setSelectionRange(p, p); } catch {}
  schedulePreview();
}

// ── 会话切换（标题行左边的 ▾）：搜索、按时间一列、+ 新对话 ────────────────────────
// sessions：最近的一页（小提示、↩ 起头那段的标题都读它）。sw：切换器里正显示的（翻过的几页，或者搜到的）。
const sw = { q: '', rows: [], next: null, loading: false, seq: 0, timer: null };
async function loadSessions(force = false) {
  if (!force && sessions && Date.now() - sessionsAt < 8000) return sessions;
  try {
    const r = await fetch(pageUrl()); const d = await r.json(); sessions = d.sessions || []; sessionsAt = Date.now(); if (d.members) members = { ...d.members, ...members };
    if (!sw.q) { const more = !!sw.rows.length; sw.rows = mergePage(sessions, sw.rows); if (!more) sw.next = d.next || null; }
  } catch { sessions = sessions || []; }
  return sessions;
}
// 切换器里取一页：reset 从头取（打开、搜的字变了），否则接着 next 往下取（滚到底）。
async function swPage({ reset = false } = {}) {
  if (!reset && (!sw.next || sw.loading)) return;
  const seq = ++sw.seq, q = sw.q; sw.loading = true;
  if (!reset) paintSwitcher();
  try {
    const r = await fetch(pageUrl({ q, before: reset ? null : sw.next })), d = await r.json();
    if (seq !== sw.seq) return;
    if (d.members) members = { ...d.members, ...members };
    const rows = d.sessions || [];
    sw.rows = reset ? rows : [...sw.rows, ...rows]; sw.next = d.next || null;
    if (reset && !q) { sessions = rows; sessionsAt = Date.now(); }
  } catch {} finally { if (seq === sw.seq) sw.loading = false; }
  if (seq !== sw.seq) return;
  paintSwitcher();
  // 一页没把列表撑满（屏幕高）：接着取，不用等滚动
  const l = $('#sw-list'); if (l && sw.next && l.scrollHeight <= l.clientHeight + 4) swPage();
}
function swSearch() { clearTimeout(sw.timer); sw.timer = setTimeout(() => { const q = ($('#sw-q')?.value || '').trim(); if (q === sw.q) return; sw.q = q; sw.rows = []; sw.next = null; paintSwitcher(); swPage({ reset: true }); }, 220); }
function swScroll(e) { const l = e.target; if (l?.id !== 'sw-list' || !sw.next || sw.loading) return; if (l.scrollHeight - l.scrollTop - l.clientHeight < 80) swPage(); }
function toggleSwitcher() { const pop = $('#pn-pop'); if (!pop) return; pop.hidden ? openSwitcher() : closeSwitcher(); }
async function openSwitcher() {
  const pop = $('#pn-pop'); if (!pop) return;
  if (panelTab() !== 'talk') openPanel({ tab: 'talk' });
  pop.innerHTML = `<div class="sw"><input class="sw-q" id="sw-q" type="search" placeholder="搜会话" aria-label="搜会话" autocomplete="off"><div class="sw-list" id="sw-list"><p class="sw-empty">正在读取…</p></div><button type="button" class="sw-new" data-sw-new>＋ 新对话</button></div>`;
  const tb = $('#pn-title')?.getBoundingClientRect(), pb = $('#panel')?.getBoundingClientRect();
  if (tb && pb) pop.style.top = Math.round(tb.bottom - pb.top + 4) + 'px';
  pop.hidden = false; $('#pn-title')?.setAttribute('aria-expanded', 'true');
  $('#sw-q')?.focus();
  sw.q = ''; if (sw.rows.length) paintSwitcher();
  await swPage({ reset: true });
}
function closeSwitcher() { const pop = $('#pn-pop'); if (!pop || pop.hidden) return; pop.hidden = true; pop.innerHTML = ''; clearTimeout(sw.timer); $('#pn-title')?.setAttribute('aria-expanded', 'false'); }
// 一行上回过话的成员（老的单人会话那位在最前）。
export function sessionFaces(s, max = 4) { return [...new Set([s?.member, ...(s?.crew || [])].filter(Boolean))].slice(0, max); }
// 一行的头像：一件活是管它的那位（目标卡是团队）；聊天是单独说话的那位，只有一位回过话就是那位，不然是团队。
export const rowFace = s => s?.task ? (s.owner && s.owner !== 'team' ? s.owner : 'team') : s?.member || ((s?.crew || []).length === 1 ? s.crew[0] : 'team');
// 一行：头像、标题（搜到的是内容时下面一小段）、任务的四态小标、有新消息的小点（正在看的那段不放）、时间。
export function swRowHtml(s, { current = null, faceOf = signed } = {}) {
  const mark = `${s.task ? taskChip(s) : ''}${s.id !== current && isUnread(s) ? '<i class="sw-dot" title="有新消息"></i>' : ''}`;
  return `<div class="sw-row ${s.id === current ? 'is-cur' : ''}"${s.task ? ' data-kind="task"' : ''}><button type="button" class="sw-go" data-sw="${esc(s.id)}"><span class="sw-crew">${faceOf(rowFace(s), 'is-mini')}</span><span class="sw-t">${esc(s.title && s.title !== '新对话' ? s.title : s.first || '新对话')}${s.hit ? `<small class="sw-hit">${esc(s.hit)}</small>` : ''}</span>${mark}<time>${esc(relTime(s.updated_at))}</time></button><button type="button" class="sw-del" data-sw-del="${esc(s.id)}" title="删除这段会话" aria-label="删除这段会话">×</button></div>`;
}
function paintSwitcher() {
  const list = $('#sw-list'); if (!list) return;
  const rows = sessionRows(sw.rows, { q: sw.q, current: sid }), top = list.scrollTop;
  list.innerHTML = rows.length ? rows.map(s => swRowHtml(s, { current: sid })).join('') + (sw.next ? `<p class="sw-more" aria-hidden="true">${sw.loading ? '…' : ''}</p>` : '')
    : `<p class="sw-empty">${sw.loading ? '正在读取…' : sw.q ? `没有说到「${esc(sw.q)}」的会话` : '还没有会话'}</p>`;
  list.scrollTop = top;
}
async function onSwitcherClick(e) {
  const t = e.target, on = s => t.closest(s);
  let x;
  if (on('[data-sw-new]')) { newThread(); return; }
  if ((x = on('[data-sw-del]'))) {
    const id = x.dataset.swDel;
    if (!(await askConfirm({ title: '删除这段会话？', lines: ['里面交给团队的事照样在做，只是这段记录没了，找不回来。'], go: '删除', danger: true }))) return;
    try { await post('/api/chat/delete', { session_id: id }); sessions = (sessions || []).filter(s => s.id !== id); sw.rows = sw.rows.filter(s => s.id !== id); if (id === sid) { sid = null; session = null; tasks = {}; fresh = true; paint(); } paintSwitcher(); }
    catch (err) { note(err.message); }
    return;
  }
  if ((x = on('[data-sw]'))) { await switchThread({ thread: x.dataset.sw }); paint({ keep: false }); $('#talk-input')?.focus(); }
}

// ── 说一句：收到（马上）→ 回执 / 回复（服务端）；发送 / 投递先弹同一个确认框 ─────────
async function send(text, { via = null, action = null } = {}) {
  // 打的 @：@成员 只让这一条交给那位（带 member，不换会话）；@#128 带上那一条。
  // 没打 @ 就交给输入框上面选着的那位（点的，或这一页的主人）；打了 @团队 就是整个团队。
  const at = action ? { member: null, leads: [], text } : parseAt(text, crewList()), to = action ? null : talkRecipient(at.member, target(), target_ === null);
  if (at.leads.length) { const n = at.leads[0], hit = leadByNumber(String(n)).find(x => x.number === n) || (refs[n] ? { ...refs[n] } : null); focus = hit ? { rid: hit.rid, number: n, company: hit.company, role: hit.role } : { rid: null, number: n }; focusOff = null; paintChips(); }
  text = at.text;
  if (!text) { $('#talk-input')?.focus(); return; }
  // 收到：你的话和「<成员> 在看…」立刻出来。是谁先用打字时已经拿到的预览；没有就先猜上一位，预览回来再改（通常几十毫秒）。
  const known = parsed.key === parseKey(text, to) ? parsed.value : null, f = focusNow();
  const p = { text, via, to, persona: (known?.kind === 'company_search' ? known.persona : null) || to || (action ? (action.kind === 'task_why' ? 'patch' : 'tailor') : null) || known?.persona || lastSpeaker() || 'scout', kind: known?.kind || 'chat', at: new Date().toISOString(), base: session?.messages?.length || 0, stage: null };
  pendings.push(p); fresh = false; spoke(); paint();
  if (!known && !action) parseOf(text, to).then(v => { if (v?.persona && pendings.includes(p) && !p.stage) { p.persona = v.persona; p.kind = v.kind; paint({ keep: true }); } });
  const drop = () => { const i = pendings.indexOf(p); if (i >= 0) pendings.splice(i, 1); };
  const body = x => ({ session_id: sid, text: x, ...(to ? { member: to } : {}), ...(f?.kind === 'resume' ? { focus: { resume: { doc: f.doc, version: f.version, selection: f.selection || [] } } } : f && (f.rid || f.number) ? { focus: { rid: f.rid || null, number: f.number || null } } : {}), ...(via ? { via } : {}), ...(action ? { action } : {}) });
  try {
    // 回复边来边显示：新到的字接在「<成员>」那一格里（一帧最多画一次）。
    const live = piece => { p.said = (p.said || '') + piece; if (!p.frame) p.frame = requestAnimationFrame(() => { p.frame = 0; paint({ keep: true }); }); };
    let r = await postStream('/api/talk', body(text), live);
    if (p.frame) { cancelAnimationFrame(p.frame); p.frame = 0; }
    if (r.needs_confirm) {
      p.stage = 'confirm'; p.persona = r.persona || p.persona; paint();
      const ok = await confirmPreview(r);
      if (!ok) { drop(); paint(); note(`好，先不${r.preview?.kind === 'send' ? '发' : '投'}了。什么都没做。`); return; }
      p.stage = null; paint();
      r = await post('/api/talk', { ...body(r.confirm_text), confirm: true });
    }
    // 回来的没有对话（F05）：不能只把「收到」那条拿掉——输入框已经清空，你的话就没了。当没发出去，放回输入框。
    if (!r?.session) throw Error('没收到回复');
    drop(); adopt(r); dirty = true;
    if (r.reply?.changed) resumeChanged({ ...r.reply.changed, kind: 'undo' });
    if (focus && !focus.auto) focus = null;
    paintChips();
  } catch (e) {
    // 已经在出字了才断（和这台电脑的工作台之间断了）：你的话已经到了，不放回输入框，等对话刷新回来。
    if (p.said) { drop(); paint(); note('这句没说完：连接断了'); refreshState(); return; }
    drop(); paint();
    note(`没发出去：${e.message}。你的话放回输入框了。`);
    const i = $('#talk-input'); if (i && !i.value.trim()) { i.value = text; grow(); }
  }
}
// Writer 改完了一句（或撤销了、改一版做完了）：材料页那一版重新载入，改过的行标黄（web/resume-editor.js 听 oc:resume-changed）。
const writerSeen = new Map();
function resumeChanged(detail) { try { window.dispatchEvent(new CustomEvent('oc:resume-changed', { detail })); } catch {} }
export function writerLanded(list = {}, seen = writerSeen, { now = Date.now(), fresh: live = true } = {}) {
  const out = [];
  for (const t of Object.values(list || {})) {
    if (t?.kind !== 'writer') continue;
    const was = seen.get(t.id);
    seen.set(t.id, t.status);
    if (t.status === 'running' || was === t.status || !live) continue;
    if (was === 'running' || (!was && now - Date.parse(t.updated_at || 0) < 60000)) out.push({ doc: t.writer?.doc, version: t.writer?.version, from: t.writer?.from, kind: t.writer?.kind });
  }
  return out;
}
function noteWriter(list) { for (const d of writerLanded(list, writerSeen, { fresh: seeded })) if (d.doc && ['edit', 'rewrite'].includes(d.kind)) resumeChanged(d); }
function adopt(r) {
  if (!r?.session) return;
  derived = null; sid = r.session.id; session = r.session; if (r.tasks) { tasks = r.tasks; noteWriter(tasks); } if (r.cards) cards = r.cards; if (r.refs) refs = r.refs;
  for (const m of session.messages || []) seen.add(`reply:${m.id}`);
  sessions = null;
  paint({ keep: false });
  refreshState();
}
function note(text) { h?.toast && !isOpen() ? h.toast(text) : flashNote(text); }
function flashNote(text) { const box = $('#talk-hint'); if (!box) return; box.innerHTML = `<span class="tk-parse is-warn">${esc(text)}</span>`; clearTimeout(flashNote.t); flashNote.t = setTimeout(paintHint, 5000); }

// ── 交给团队、撤回、回复里的按钮 ─────────────────────────────────────────────
async function handoff(text, persona) {
  if (!sid) return;
  try { const r = await post('/api/chat/handoff', { session_id: sid, text, persona: persona || null }); adopt({ session: r.session }); dirty = true; }
  catch (e) { note(e.message); }
}
async function withdraw(id) {
  try { const r = await post('/api/talk/withdraw', { session_id: sid, message_id: id }); adopt(r); }
  catch (e) { note(e.message); refreshState(); }
}
// 「查看 #12」：面板留着，指挥台上滚到那一行闪一下，详情标签也备好这一条；不在流水线上就开完整详情。窄屏的 sheet 先收起来。
async function reveal(rid) {
  if (!rid) return;
  if (window.innerWidth < 900) closePanel();
  if ((location.hash.slice(1).split(/[/?]/)[0] || 'command') !== 'command') {
    location.hash = '#command';
    for (let i = 0; i < 40 && !($('#main')?.dataset.page === 'command' && $('#hq-rows')); i++) await new Promise(r => setTimeout(r, 100));
  }
  if (!revealRow(rid, { detail: true })) location.hash = '#lead/' + encodeURIComponent(rid);
}
function onClick(e) {
  const t = e.target, on = s => t.closest(s);
  let x;
  if ((x = on('[data-tb-release]'))) { x.disabled = true; post(`/api/tasks/${encodeURIComponent(x.dataset.tbRelease)}/release`, {}).then(() => talkUpdate()).catch(err => { x.disabled = false; note(err.message); }); return; }
  if ((x = on('[data-tb-judge]'))) { post(`/api/tasks/${encodeURIComponent(x.dataset.tbJudge)}/judge-first`, {}).then(() => talkUpdate()).catch(err => note(err.message)); return; }
  if ((x = on('[data-tb-open]')) && !on('button:not([data-tb-open])')) { window.OfferCrew?.openCard?.(x.dataset.tbOpen); return; }
  if (on('.hq-mc')) return; // 成员卡片上的按钮归 web/hq.js
  // 抬头：换问谁（团队 = 由 System 分派）。
  if ((x = on('[data-to]'))) { const k = x.dataset.to === 'team' ? null : x.dataset.to; target(); target_ = k; paintCrew(); schedulePreview(); $('#talk-input')?.focus?.({ preventScroll: true }); return; }
  if (on('[data-focus-off]')) { const f = focusNow(); if (f?.auto) focusOff = focusKey(f); focus = null; paintChips(); schedulePreview(); return; }
  if ((x = on('[data-pick]'))) { choosePick(pick?.items[Number(x.dataset.pick)]); return; }
  if ((x = on('[data-reveal]'))) { e.preventDefault(); reveal(x.dataset.reveal); return; }
  if ((x = on('[data-jump]'))) { e.preventDefault(); paint({ anchor: x.dataset.jump }); return; }
  if ((x = on('[data-ex]'))) { const i = $('#talk-input'); i.value = x.dataset.ex; grow(); i.focus(); preview(); return; }
  if ((x = on('[data-thread]')) && x.dataset.thread) { switchThread({ thread: x.dataset.thread }); return; }
  if ((x = on('[data-open-task]')) && x.dataset.openTask) { if (window.innerWidth < 900) closePanel(); openCard(x.dataset.openTask); return; }
  if ((x = on('[data-act]'))) { if (!canSend()) return; x.disabled = true; send(x.dataset.act, { via: 'action' }); return; }
  if ((x = on('[data-wq-opt]'))) { const li = x.closest('li'); const was = x.classList.contains('is-on'); for (const b of li.querySelectorAll('.tk-wq-opt')) { b.classList.remove('is-on'); b.setAttribute('aria-pressed', 'false'); } if (!was) { x.classList.add('is-on'); x.setAttribute('aria-pressed', 'true'); } keepDraft(x); return; }
  if ((x = on('[data-wq-fill]'))) { x.closest('li')?.querySelector('[data-wq-text]')?.focus(); return; }
  // 开始改（旧卡片上的直接改同样处理）：不在页面上自己变灰——Writer 正忙时卡片还能再答，灰不灰看服务端的 buttons[].used；只挡住同一下连点。
  if ((x = on('[data-wbtn="resume_answers"], [data-wbtn="resume_skip"]'))) { const k = x.dataset.wmsg; if (!canSend() || wqSending.has(k)) return; wqSending.add(k); const skip = x.dataset.wbtn === 'resume_skip'; const r = skip ? null : collectAnswers(document.querySelector(`.tk-wq[data-wq="${CSS.escape(k)}"]`)); Promise.resolve(send(skip ? x.dataset.label : r.text, { via: 'action', action: { kind: x.dataset.wbtn, message_id: k, ...(skip ? {} : { answers: r.answers }) } })).finally(() => wqSending.delete(k)); return; }
  if ((x = on('[data-wbtn]'))) { if (!canSend()) return; x.disabled = true; send(x.dataset.label, { via: 'action', action: { kind: x.dataset.wbtn, message_id: x.dataset.wmsg } }); return; }
  if ((x = on('[data-rgoto]'))) { window.dispatchEvent(new CustomEvent('oc:resume-goto', { detail: { doc: x.dataset.doc, version: x.dataset.version, line_ids: x.dataset.rgoto.split(' ') } })); return; }
  if ((x = on('[data-handoff]'))) { x.disabled = true; handoff(x.dataset.handoff, x.dataset.persona); return; }
  if ((x = on('[data-withdraw]'))) { x.disabled = true; withdraw(x.dataset.withdraw); return; }
  if ((x = on('[data-open-url]'))) { post('/api/open-url', { url: x.dataset.openUrl }).then(r => flashNote(r.receipt || '已在浏览器里打开')).catch(err => note(err.message)); return; }
  if (on('a[href^="#"]:not([href="#"])') && window.innerWidth < 900) { closePanel(); return; } // 窄屏：跳页时收起 sheet
  const card = on('.tk-ask'), a = card ? askById(card.dataset.ask) : null;
  if (!a) return;
  if ((x = on('[data-opt]'))) { choose(a, x.dataset.opt); return; }
  if ((x = on('[data-reason]'))) { const p = picks.get(a.id); if (p) answer(a, p.key, { reason: x.dataset.reason }); return; }
  if (on('[data-dt-go]')) { const v = card.querySelector('[data-dt]')?.value; const p = picks.get(a.id); if (!v) { flashNote('先选个时间'); return; } if (p) answer(a, p.key, { datetime: v.replace('T', ' ') }); return; }
  if (on('[data-go]')) { const p = picks.get(a.id); if (p) answer(a, p.key, p.server ? { confirm: true } : {}); return; }
  if (on('[data-cancel-pick]')) { picks.delete(a.id); paint({ keep: true }); return; }
  if (on('[data-say-go]')) { const v = card.querySelector('[data-say]')?.value.trim(); if (!v) { card.querySelector('[data-say]')?.focus(); return; } answer(a, 'other', { text: v }); return; }
}

// ── 状态：进页面拉一次；之后跟着 SSE 的 update（执行器改了队列、任务、回复都会触发），有事在做时再每 5 秒兜一次 ──
async function refreshState({ examples: withExamples = false } = {}) {
  const seq = ++stateSeq;
  const q = new URLSearchParams(); if (sid && !derived) q.set('session', sid); if (withExamples) q.set('examples', '1');
  let st;
  try { const r = await fetch('/api/talk' + (q.size ? '?' + q : '')); st = await r.json(); if (!r.ok) throw Error(st.error || '读取失败'); }
  catch { return; }
  if (st.examples) examples = st.examples;
  if (st.said) said = true;
  if (seq !== stateSeq) return; // 后面又拉了一次：以那次为准
  lastState = Date.now();
  token = st.token || token; members = st.members || members; talkable = st.talkable || talkable; sandbox = !!st.sandbox; active = st.active || 0; working = st.working || [];
  modelOk = st.model?.ok !== false; paintModel(st.model);
  // 现场拼的那段（derived）没有文件：服务端的「当前对话」不是它，不拿来换。
  if (!fresh && !derived) {
    if (!sid) sid = st.session?.id || null;
    if (st.session && st.session.id === sid) { session = st.session; tasks = st.tasks || {}; cards = st.cards || {}; refs = st.refs || {}; noteWriter(tasks); }
    else if (!st.session && !pendings.length) { sid = null; session = null; tasks = {}; } // 6 小时没说话了，或者会话被删了：下一句开新的
  }
  crewTalk({ members, ids: talkable, working, member: null }); paintCard.done = true;
  for (const e of st.landed || []) seen.add(e.key);
  // 成员回复了、做完了、卡住了：不再弹提示、不再亮未读点（负责人 10-02：要你决定的在收件箱，进度在运行日志）。
  seeded = true;
  // 你正在卡片里打字（回答执行器）：先不重画，离开输入框再画，免得字被冲掉。
  if ($('#talk-thread')?.contains(document.activeElement) && typingIn(document.activeElement)) held = true; else paint({ keep: true });
  paintBar();
  if (!$('#pn-pop')?.hidden) paintSwitcher();
  markSeen(); loadSessions().then(r => { watchTasks(r); if (!$('#pn-pop')?.hidden && !sw.q) paintSwitcher(); }).catch(() => {});
  clearInterval(pollTimer); pollTimer = active || pendings.length ? setInterval(() => refreshState(), 5000) : null;
}
// 你看着这段对话：告诉服务端看过了（POST /api/chat/seen，手机和电脑同一份）。同一段没有新动静不再说。
const seenSent = new Map();
function markSeen() {
  if (derived || !isOpen() || !session?.id || !session.updated_at || seenSent.get(session.id) === session.updated_at) return;
  seenSent.set(session.id, session.updated_at);
  const row = (sessions || []).find(x => x.id === session.id); if (row) row.seen_at = session.updated_at;
  post('/api/chat/seen', { session_id: session.id }).catch(() => seenSent.delete(session.id));
}
// 小提示只在三种时候弹（方案第九节）：你今天起的活变成等你、没做成、做完。定时周期的、System 的、不是你起的（岗位页以外补的卡）从来不弹。
const taskWas = new Map();
let tasksSeeded = false;
export function taskLanded(rows = [], was = taskWas, { now = Date.now(), live = true } = {}) {
  const out = [], today = dayKey(new Date(now));
  for (const r of rows) {
    if (!r?.task || r.routine || r.owner === 'patch' || (r.origin && r.origin !== 'page')) continue;
    const st = sixOf(r.status), prev = was.get(r.id);
    was.set(r.id, st);
    if (live && prev && prev !== st && ['needs_you', 'stuck', 'done'].includes(st) && dayKey(new Date(Date.parse(r.created_at || r.updated_at || 0))) === today) out.push({ id: r.id, title: r.title, status: st, word: r.word || '' });
  }
  return out;
}
function watchTasks(rows) {
  for (const t of taskLanded(rows, taskWas, { live: tasksSeeded })) if (t.id !== sid || !isOpen()) note(`${cut(t.title || '一件活', 20)}${t.word ? `：${t.word}` : ''}`);
  tasksSeeded = true;
}
// SSE update 来了（app.js 调）：离上次拉不到 1.5 秒就等一等再拉，免得一次同步里连着拉几遍。
export function talkUpdate() {
  clearTimeout(stateTimer);
  const wait = Math.max(0, 1500 - (Date.now() - lastState));
  stateTimer = setTimeout(() => refreshState(), wait);
}
// 倒计时、「已 N 分钟」、「在看… 12 秒」：面板开着时每秒改一下这几个字，不重画。
function tick() {
  clearInterval(ticker); ticker = null;
  if (!isOpen() || !root) return;
  const run = () => {
    let expired = false;
    root.querySelectorAll('[data-fire],[data-run]').forEach(el => { const t = tasks[el.dataset.taskWhen]; if (t) el.textContent = whenText(t); if (el.dataset.fire && secs(el.dataset.fire) === 0) expired = true; });
    root.querySelectorAll('.tk-typing [data-since]').forEach(el => { const s = Math.round((Date.now() - Date.parse(el.dataset.since)) / 1000); el.textContent = s >= 3 ? `${s} 秒` : ''; });
    if (expired) talkUpdate();
  };
  run();
  if (root.querySelector('[data-fire],[data-run],.tk-typing')) ticker = setInterval(run, 1000);
}

// ── 面板关着时：入口按钮（左栏「问团队」、窄屏右下角的「问」）上，有没看的回音时一个不动的点（在做的事不在这里数）─────────
export function paintBar() {
  for (const bar of [$('#talk-bar'), $('.sb-ask [data-talk-bar]')]) if (bar) bar.innerHTML = unread ? '<span class="talk-dot" title="有新的回音"></span>' : '';
}
// app.js 每画完一页调一次：右下角的按钮是同一个，这里只把状态画回去；详情里换了一条，「正在看」跟着换。
export function talkPaint() { paintBar(); paintChips(); }

// ── 从页面外面叫出来 ─────────────────────────────────────────────────────────
// hash 里的 talk 参数：{ text, hash }（text 是要预填的话，talk=1 时为空；hash 是拿掉 talk 之后的地址）；没有 talk 返回 null。
export function talkFromHash(hash) {
  const [head, query = ''] = String(hash || '').split('?');
  const q = new URLSearchParams(query);
  if (!q.has('talk')) return null;
  const v = q.get('talk') || '';
  q.delete('talk');
  const rest = q.toString();
  return { text: v === '1' ? '' : v.trim().slice(0, 2000), hash: (head && head !== '#' ? head : '#command') + (rest ? '?' + rest : '') };
}
// 材料页的「体检」按钮（只看、不改，设计说明 4.2）：打开对话、直接发出去，带着这一版的「正在看」（你之前点 × 拿掉的也带上）。
export function talkSay(text = '') {
  const t = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
  if (!t || !root) return;
  openPanel({ tab: 'talk' });
  focusOff = null; follow(); paintChips();
  if (canSend()) send(t);
}
// 打开面板的对话；给了话就填进输入框、光标放在最后，等你改或按 Enter。
export function summonTalk(text = '') {
  const t = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
  openPanel({ tab: 'talk', text: t, focus: true });
}
function fromHash(e) {
  const back = e?.oldURL ? (new URL(e.oldURL).hash || '#command') : '#command';
  const c = chatRedirect(location.hash, back);
  if (c) { history.replaceState(history.state, '', location.pathname + location.search + c.hash); openPanel({ tab: 'talk', ...(c.thread ? { thread: c.thread } : c.member ? { member: c.member } : {}), text: c.text, focus: true }); return; }
  const x = talkFromHash(location.hash);
  if (!x) return;
  history.replaceState(history.state, '', location.pathname + location.search + x.hash);
  summonTalk(x.text);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
export function initTalk(helpers) {
  h = helpers;
  if (root) return;
  if (!build()) return;
  // 面板叫对话（⌘K、右下角的按钮、详情旁边的标签、别处的 open()）。
  window.addEventListener('oc:talk', e => onTalk(e.detail || {}));
  window.addEventListener('oc:panel', e => { if (!e.detail?.open) { closeSwitcher(); closePick(); clearInterval(ticker); ticker = null; if (dirty) { dirty = false; h?.refresh?.(); } } else if (e.detail.tab === 'talk') { tick(); if (!e.detail.width) requestAnimationFrame(() => { const b = $('#talk-thread'); if (b && !$('#talk-thread .is-flash')) b.scrollTop = b.scrollHeight; }); } });
  // 主区看的岗位变了：「正在看」跟着换（输入框里有字时锁住）。oc:crew 是旧的详情抽屉发的，也听着。
  window.addEventListener('oc:viewing', e => viewingChanged(e.detail ?? null));
  window.addEventListener('oc:crew', () => paintChips());
  $('#talk-input')?.addEventListener('input', () => { if (!$('#talk-input').value.trim()) paintChips(); });
  // 「/」：焦点不在输入框里时。挂在 window 上（最后收到）：页面自己用了 /（收件箱）就不抢。
  window.addEventListener('keydown', e => {
    if (e.key !== '/' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target) || typingIn(document.activeElement) || document.querySelector('dialog[open]')) return;
    e.preventDefault(); openPanel({ tab: 'talk', focus: true });
  });
  // 从页面外面叫：地址里的 talk=、旧的 #chat 链接、offercrew:talk 事件、window.OfferCrew.openTalk()。这个 hashchange 比 app.js 的先注册，
  // 先把 talk= 拿掉（#chat 换回原来那一页），页面再按干净的地址画。
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('offercrew:talk', e => summonTalk(e?.detail?.text || ''));
  window.OfferCrew = Object.assign(window.OfferCrew || {}, { openTalk: text => summonTalk(text || ''), talkSay: text => talkSay(text || ''), talkSession: () => sid || null, openThread: async (id, { wide = false, task = null, anchor = null } = {}) => { if (task) return openCard(task); openPanel({ tab: 'talk', wide }); await switchThread({ thread: id }); if (anchor) paint({ anchor }); }, openTask: id => openCard(id),
    // 卡片上的「看原因」：问 System 这件为什么没做成（带这件活的 id，lib/system/explain.mjs），在对话栏里答。点了才发。
    taskWhy: id => { if (!id) return; openPanel({ tab: 'talk' }); if (canSend()) send('这件为什么没做成', { via: 'action', action: { kind: 'task_why', task: id } }); } });
  // 主区域换了一件卡片（或离开任务页）：对话里那条小条的「正开着」跟着变。
  window.addEventListener('hashchange', () => setTimeout(() => paint({ keep: true }), 0));
  paint(); paintHint();
  refreshState({ examples: !gone() });
  fromHash();
}
