// 对话面板（web/talk.js，2026-09-29）的服务端：在哪一页都能按 ⌘K 跟团队说话，说完能看到回音。
//   一句话进来按规则分给六位成员中的一位（lib/talk-route.mjs，是代码不是角色；成员见 lib/members.mjs）：
//     lib/intent.mjs 认得的指令 → 指挥室同一条路（dispatchCommand；发送 / 投递照样先给预览、要你确认），
//                                   回执是管这件事的那位用第一人称说的，写清动了哪几行
//     「现在怎么样、我该做什么」   → Scout 按当前状态直接答（statusDigest），带着能点的下一步
//     「为什么推荐是 0」「怎么还没跑」→ System 讲原因、影响、能怎么办（lib/system/explain.mjs；问某一条的 Judge 说）
//     贴来的岗位链接              → Scout 收录（TODO：feat/capture 的 POST /api/capture）
//     别的话                      → 交给关键词指向的那位（lib/chat.mjs chatTurn）
//   @ 一位成员（member，布局 v3.1）：只这一条交给那位，不换会话、不开新会话；下一句没 @ 就照常分派。
//   会话都是团队的：新会话不挂成员。以前单独和一位说的老会话（带 member）照样能接着说，但不再锁在那位身上。
//   你正看着一条（「正在看 #12」，focus）：短指令补上编号（「投」→「投 12」），对话里模型知道「这个」是哪条。
//   指令的回执也记进同一个对话会话（state/chat/<id>.json），和对话页读写的是同一份。
// 交出去的事现在到哪了、谁在做什么，全看执行器自己的报告，不从文字里猜：
//   即时执行器队列 state/run-now.json    reasons 排队中 · queue 在做 · failed 连续失败、停了
//   宿主任务 state/host-jobs.ndjson       执行器用 bin/job.mjs done / need / blocked 写的 status、needs、result
//   执行器的心跳 state/executor-heartbeat.json  每一步 beat({ step, detail })（lib/executor-heartbeat.mjs，任务卡上的步骤）
//   执行器写回的话 state/web-replies.ndjson（并进会话，lib/chat.mjs mergeReplies）
//   操作台脚本 state/ops.json             current 在跑 · history 跑完了
import { coName, coTbd, leadByUrl } from './vocab.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { read, write, lines, writeLines, file } from './store.mjs';
import { cachedLines } from './state-cache.mjs';
import { recognize, resolveCommand, LETTER_MENTION, FIX_VERB, followsLetter, resumePart } from './intent.mjs';
import { agentAction } from './ops.mjs';
import { OPS } from './ops-table.mjs';
import { queueRecord, queued as queuedItems, cancelQueued, setCard, QUEUED_LINE } from './op-queue.mjs';
import { chatTurn, complete, modelState, workRows, loadSession, newSession, saveSession, sessionExists, newSessionId, validId, CHAT_DIR } from './chat.mjs';
import { ruleTitle, shownTitle, linkOnly, cleanModelTitle, TITLE_SYSTEM, titlePrompt } from './chat-title.mjs';
import { STATE_PATH as RUN_NOW } from './run-now.mjs';
import { PATH as BEATS } from './executor-heartbeat.mjs';
import { lastRev } from './cards.mjs';
import { askKind, askOut, isPipeline, runProgress, TABS } from './hq.mjs';
import { sandboxed } from './sandbox.mjs';
import { agentPaused } from './agents.mjs';
import { members, memberName, memberId, TALKABLE } from './members.mjs';
import { memberOfJob, crewOf } from './crew.mjs';
import { jobOfCard, overlay } from './task-ledger.mjs';
import { controlled } from './task-control.mjs';
import { byRef } from './jobs.mjs';
import { view, chipOf, fromLegacy } from './status.mjs';
import { holdOf, waitNote, viewCard, applyCards } from './tasks.mjs';
import { isQuestion, isLocalAiQuestion, materialRequestText, rejectsMaterial } from './intent.mjs';
import { planTalk, startGoal, controlCard } from './card-ops.mjs';
import { readCards, deriveGoal, makeCard, saveCards, leadRef, headline, leadInText } from './cards.mjs';
import { KINDS, crewName } from './crew.mjs';
import { startsWork, splitWork, workOfResult } from './task-start.mjs';
import { taskLink, topCard, shownCard, taskStatus, failingCard, taskTries } from './task-chat.mjs';
import { allCards, findTask } from './task-migrate.mjs';
import { writerCard, writerKind, letterKindOf, writerChain } from './task-writer.mjs';
import { leadOfLetter, defaultWriterTarget, resumeFocus, targetContent, wantsWriter, writerAsk, letterAsk, writerIntent, writerTarget, writerStart, writerTask, writerTries, writerAgain, MAX_TRIES, writerButton, writerResults, resumeBrief, tailorTarget, rewriteMessage, letterRewriteMessage, writerLetterStart, writerLetterTurnFor } from './resume-talk.mjs';
import { errorReason, sayError } from './say-error.mjs';
import { event, withEventRun } from './events.mjs';
import { textReady } from './model.mjs';
import { routePersona, commandPersona, commandNumbers, verbLabel, commandNote, receiptLine, captureUrl, STATUS_MEMBER, CAPTURE_MEMBER, BANNER_WHY } from './talk-route.mjs';
import { explainWhy } from './system/explain.mjs';
import { localAiSummary } from './local-ai-status.mjs';
import { archivedLead } from './lead-state.mjs';
import { judgeAvailable } from './judge.mjs';
import { startCompanySearch, companySearchReceipt } from './company-search.mjs';
import { RECENT_MS, WATCH_MS, recentSessions, pickSession } from './talk-sessions.mjs';

const iso = t => new Date(t).toISOString();
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const rid = () => crypto.randomBytes(6).toString('hex');
const rid_ = rid; // 参数叫 rid（线索编号）的地方用它
// 第一句话进来时先按规则起标题（lib/chat-title.mjs）；有模型时第一轮回复以后再换成模型概括的（nameSession）。
const autoTitle = (session, text) => { if (session.title === '新对话') { session.title = ruleTitle(text); session.title_by = 'rule'; } };

// ── 一句话是什么、交给谁 ─────────────────────────────────────────────────────
// member：单独说话的那位（有就不分派）；focus：{ number } 你正看着的那一条。
// 这句话要做什么在 lib/intent.mjs recognize 认（4a）；这里只定交给谁：指令给管这件事的那位，「现在怎么样」团队答，
// 「为什么」问某一条的 Judge、别的 System，贴来的链接 Radar 收录，别的话按关键词分给成员（lib/talk-route.mjs）。
export function classifyTalk(text, { previous = null, focus = null, member = null } = {}) {
  const raw = String(text ?? '').trim(), r = recognize(raw, { focus });
  const canon = r.canonical ? { canonical: r.canonical } : {};
  if (r.intent === 'empty') return { kind: 'empty' };
  if (r.intent === 'company_search') return { kind: 'company_search', persona: 'scout', company: r.company, url: r.url };
  if (r.intent === 'agent') return { kind: 'command', cmd: { kind: 'agent', verb: r.verb, member: r.member, input: raw }, persona: r.member, numbers: [] };
  if (r.intent === 'local_ai_status') return { kind: 'local_ai_status', persona: 'patch' };
  if (r.intent === 'status') return { kind: 'status', persona: member || STATUS_MEMBER };
  if (r.intent === 'why') return { kind: 'why', persona: r.number ? 'lens' : 'patch', number: r.number };
  if (r.intent === 'capture') return { kind: 'capture', persona: CAPTURE_MEMBER, url: r.url };
  if (r.cmd) {
    const cmd = r.cmd.kind === 'op' ? { ...r.cmd, role: OPS[r.cmd.op]?.role || 'system', label: OPS[r.cmd.op]?.label || null } : r.cmd;
    return { kind: 'command', cmd, persona: commandPersona(cmd), numbers: r.numbers, ...canon };
  }
  return { kind: 'chat', persona: member || routePersona(raw, { previous }) };
}
// 这个会话里上一位说话的成员：接着聊「那 13 呢」时不换人。
export const lastSpeaker = s => memberId([...(s?.messages || [])].reverse().find(m => m.role === 'assistant' && m.persona)?.persona) || null;
const needsConfirm = cmd => cmd.kind === 'queue_apply' || cmd.kind === 'send_all' || cmd.verb === 'send';

// 编号 → 这一行是谁（给预览、回执、「查看 #12」的链接用）。
function leadIndex(leads = null) {
  const m = new Map();
  for (const l of leads || cachedLines('state/leads.ndjson')) if (l.number != null && !l.superseded && (!m.has(l.number) || archivedLead(m.get(l.number)))) m.set(l.number, l);
  return m;
}
const rowOf = l => ({ number: l.number, rid: l.record_id || l.id, company: coName(l.company) || '公司待核', role: l.role || '' });
const rowsFor = (numbers, index) => numbers.map(n => index.get(n)).filter(Boolean).map(rowOf);
// 页面传来的「正在看」：只认库里真有的那一条（按 rid，其次编号）。
function focusOf(focus, index) {
  if (!focus || typeof focus !== 'object') return null;
  const want = String(focus.rid || ''), n = Number(focus.number);
  for (const l of index.values()) if ((want && (l.record_id === want || l.id === want)) || (!want && l.number === n)) return rowOf(l);
  return null;
}
const threadOf = member => TALKABLE.includes(memberId(member)) ? memberId(member) : null;
// 显式选团队与未指定成员不同；历史默认分派继续沿用原行为。
const recipientOf = member => member === 'team' ? 'team' : threadOf(member);

// 输入框下面那一行：「→ 投 2 条：#12 …」，或者「→ 交给 Quill」。按键时调，只读。
export function parseTalk(text, { previous = null, leads = null, focus = null, member = null } = {}) {
  const index = leadIndex(leads), f = focusOf(focus, index);
  const c = classifyTalk(text, { previous, focus: f, member: recipientOf(member) });
  const task = taskShape(String(text ?? '').trim(), c);
  if (c.kind !== 'command') return c.kind === 'capture' ? { kind: 'capture', persona: c.persona, url: c.url, task } : { ...c, task };
  const rows = rowsFor(c.numbers, index);
  return { task, kind: 'command', persona: c.persona, verb: verbLabel(c.cmd), note: commandNote(c.cmd), confirm: needsConfirm(c.cmd), all: !!c.cmd.all, rows, missing: c.numbers.filter(n => !rows.some(r => r.number === n)), ...(c.canonical ? { canonical: c.canonical } : {}) };
}

// ── 说一句 ───────────────────────────────────────────────────────────────────
// dispatch：dispatchCommand（服务端传进来，测试传假的）；center：commandCenter() 或返回它的函数（只有对话那一轮要看系统状态）；
// hq：hqView 或返回它的函数（答「现在怎么样」时要看）。via：这句话从哪来（'action' 是点了回复里的按钮）。
// member：这一条 @ 的那位（只管这一条；会话不记它）。focus：{ rid, number } 你正看着的那一条。
export const talkTurn = (args = {}, deps = {}) => withEventRun('talk', () => talkScoped(args, deps));
async function talkScoped(args = {}, deps = {}) {
  const r = await workTurn(args, deps);
  // 这段对话的第一轮：有模型时在后台起个标题（不等它，回复先回去）。
  if (r?.session?.messages.at(-2)?.route?.kind !== 'local_ai_status' && r?.session?.title_by === 'rule' && r.session.messages.filter(m => m.role === 'user').length === 1) naming = nameSession(r.session.id, deps);
  return r;
}
// ── 标题：第一轮以后用模型概括第一句话（lib/chat-title.mjs）────────────────────
// titleFn：async text => 标题（测试传假的；false 不起）。不给时：传了 completeFn 的（测试里假的对话模型）不起，
// 否则现在有能用的模型就走对话同一条路（lib/chat.mjs complete，记进用量账 step: title）。
// 只贴了一个链接的不问模型：规则标题会在收录对上后变成「收录 公司 · 职位」，比模型猜得准。失败了就留着规则标题。
let naming = Promise.resolve(null);
export const titleSettled = () => naming;
export async function nameSession(session_id, { titleFn = undefined, completeFn = null, config = null, now = Date.now() } = {}) {
  try {
    let fn = typeof titleFn === 'function' ? titleFn : null;
    if (!fn && titleFn !== false && !completeFn && modelState({ now }).ok) fn = async text => (await complete({ system: TITLE_SYSTEM, messages: titlePrompt(text), max_tokens: 60, ...(config ? { config } : {}), meta: { member: 'patch', step: 'title' } })).text;
    if (!fn || !sessionExists(session_id)) return null;
    const first = String(loadSession(session_id).messages.find(m => m.role === 'user')?.content || '');
    if (!first || linkOnly(first)) return null;
    const title = cleanModelTitle(await fn(first));
    if (!title) return null;
    const s = loadSession(session_id);
    if (s.title_by !== 'rule') return null;
    s.title = title; s.title_by = 'model';
    saveSession(s);
    return title;
  } catch { return null; } /* 兜底：起标题没成（没有模型、模型出错）就留着按规则起的那个标题，不挡对话 */
}

// ── 在对话里起活（任务卡片，L 线 10-03，design/handoff/L-任务卡片-接口.md 第一节第 5 条）─────────────────────
// 这一句开不开活按规则认（lib/task-start.mjs startsWork）。开出来的活是任务页里的一张卡；对话还是这段对话：
//   不变成任务对话、不另开一段。这一轮照常做完以后，起活的那句后面原地一条 task_link 小条（规则开的目标 / 单卡，那条回复本身就是小条：
//   它带着 goal / card，读的时候和小条一样带上 task 和现算的状态）。卡上 from.session_id / message_id 记从哪句起的。
//   Writer 先问的几句就在这段里问、在这里答；同一件 Writer 的活接着说（同一类、没换岗位）还是那张卡，换了一件另起一张。
//   一句话里说了几件事（splitWork）：一件一件照常说，每件各自的回复和小条。
const classifier = (s, thread) => t => classifyTalk(t, { previous: thread || lastSpeaker(s), member: thread });
async function workTurn(args = {}, deps = {}) {
  const raw = String(args.text ?? '').trim();
  if (args.action || !raw || raw.length > 2000 || (args.session_id && !validId(args.session_id))) return turnOnce(args, deps);
  const s = args.session_id && sessionExists(args.session_id) ? loadSession(args.session_id) : null;
  const classify = classifier(s, recipientOf(args.member)), now = deps.now ?? Date.now();
  const parts = splitWork(raw, { classify });
  if (parts) { const r = await splitTurn({ args, deps, parts, s, raw, classify, now }); if (r) return r; }
  if (startsWork(raw, { classify }).work !== 'work') return turnOnce(args, deps);
  const before = new Set((s?.messages || []).map(m => m.id));
  return settleTask(await turnOnce(args, deps), { before, now });
}
// 要先确认的（投、发）最多一件，先给它的预览（这时还什么都没做，什么都不记）；确认了再整句来一次。两件以上要确认的不拆。
const confirmPart = (p, classify) => { const c = classify(p); return (c.kind === 'command' && needsConfirm(c.cmd)) || planTalk(p)?.type === 'apply'; };
async function splitTurn({ args, deps, parts, s, raw, classify, now }) {
  const confirms = parts.filter(p => confirmPart(p, classify));
  if (confirms.length > 1) return null;
  if (confirms.length && !args.confirm) { const r = await turnOnce({ ...args, text: confirms[0] }, deps); if (r.needs_confirm) return { ...r, confirm_text: raw }; }
  const session = s || newSession({ persona: 'scout', now });
  const tasks = [], turns = [];
  for (const p of parts) {
    const before = new Set(loadSession(session.id).messages.map(m => m.id));
    let r;
    try { r = await turnOnce({ ...args, text: p, session_id: session.id }, { ...deps, onDelta: null }); } // 拆开的几件各回各的，不往同一处流
    catch (e) { turns.push({ text: p, error: cut(e.message, 120) }); continue; }
    const t = settleTask(r, { before, now });
    turns.push({ text: p, kind: r.kind, ...(t.task ? { task: t.task } : {}) });
    if (t.task) tasks.push(t.task);
  }
  const out = loadSession(session.id), link = [...out.messages].reverse().find(m => m.kind === 'task_link' || m.goal || m.card) || null;
  return { kind: 'split', persona: 'team', session: out, reply: link, tasks, parts: turns };
}
// 指令排下的事也是一张卡：投（和自动投递那条任务是同一张，lib/tasks.mjs coveredJob）、运行一个脚本（看它那一轮跑得怎样）。
// 要即时执行器接着做的（发、改稿）不在这里开卡：交办任务建出来以后由任务板补卡（发出类的卡归 2a）。
function commandCard(r, session, user, now) {
  const cmd = r.receipt?.command;
  if (!cmd || r.receipt.ok === false) return null;
  const from = { by: 'you', session_id: session.id, message_id: user?.id || null };
  if (cmd.card_id) { const card = readCards().find(c => c.id === cmd.card_id); return card ? { card, existing: true, from } : null; }
  if (cmd.op?.id) {
    const op = /^(?:运行|跑|run)\s+([a-z][a-z0-9-]*)$/i.exec(String(cmd.text || ''))?.[1]?.toLowerCase() || null;
    const kind = Object.keys(KINDS).find(k => KINDS[k].op && KINDS[k].op === op) || 'round';
    // 碰上忙、排上了（lib/crew-desk.mjs runOrQueue）：排队那一步已经开了卡（links.queue_id），用那一张，不另开；
    // 那一张还没建成（写锁被别的进程拿着）就在这里建，同样用 queue_id 指向排队记录。q- 开头的是排队 id，不是运行记录，不进 op_id。
    if (cmd.op.queued) {
      const q = queueRecord(cmd.op.id), have = q?.card_id ? readCards().find(c => c.id === q.card_id) : null;
      if (have) return { card: have, existing: true, from: cmd.op.dup ? null : from };
      const card = makeCard({ kind, title: cmd.op.label || cmd.label || kindLabelOf(kind), owner: r.persona, from, links: { op, queue_id: cmd.op.id }, how: 'script', now });
      card.detail = QUEUED_LINE;
      return { card, queue_id: cmd.op.id };
    }
    // 同一项已经在跑：开跑那一下已经有卡（成员页、上一句对话）就用那一张。
    const running = readCards().find(c => c.links?.op_id === cmd.op.id);
    if (running) return { card: running, existing: true };
    return makeCard({ kind, title: cmd.op.label || cmd.label || kindLabelOf(kind), owner: r.persona, from, links: { op, op_id: cmd.op.id }, status: 'running', now });
  }
  const rows = (r.receipt.leads || []).filter(x => x.to);
  // 投：每个编号一张卡，就是动作建的那件活（lib/tasks.mjs applyCards，一件活一张卡）；这条岗位已有投递卡就用那一张。卡在那里存好。
  if (cmd.kind === 'queue_apply' && rows.length) {
    const card = applyCards(rows.map(x => ({ rid: x.rid, number: x.number, company: x.company, role: x.role })), { from, now });
    return card ? { card, existing: true } : null;
  }
  return null;
}
const kindLabelOf = k => KINDS[k]?.label || '跑一轮';
// 这段对话里最近那件 Writer 的活（还没被下一件接上的那张）；同一类（求职信和自我介绍是两类）、没换岗位就是接着说。
const lastWriterCard = (s, all) => all.filter(c => c.session_id === s.id && c.links?.writer && !c.links.writer_next && c.status !== 'cancelled').sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0)).at(-1) || null;
function sameWriter(card, reply) {
  const w = reply.writer, kind = writerKind(w), n = w.lead?.number ?? null;
  if (card.kind !== kind || (kind === 'letters' && (card.letter_kind || 'cover_letter') !== letterKindOf(w))) return false;
  return n == null || (card.leads || []).some(l => l.number === n);
}
// 这一轮开出了活：建卡（规则开的已经建好了），原地留小条。before：这一轮之前这段对话里已有的消息。→ 原样的 r，多带 task。
function settleTask(r, { before = new Set(), now = Date.now() } = {}) {
  if (!r?.session || r.needs_confirm || workOfResult(r).work !== 'work') return r;
  const s = r.session, all = readCards();
  if (r.goal || r.card) { const c = all.find(x => x.id === (r.goal || r.card)); return { ...r, task: (c && topCard(c, all).id) || r.goal || r.card }; }
  const user = s.messages.filter(m => !before.has(m.id)).find(m => m.role === 'user') || null;
  const writer = r.reply?.kind === 'writer' && r.reply.writer ? r.reply : null;
  let card, saved = false;
  const also = r.also?.kind === 'writer' && r.also.writer ? r.also : null;
  if (writer) {
    const prev = lastWriterCard(s, all);
    if (prev && sameWriter(prev, writer) && !also) return { ...r, task: prev.id }; // 同一件接着说：还是那张卡（状态看这段对话里它那几条 Writer 消息）
    card = writerCard(writer, s, { said: user, now });
    if (prev && prev.id !== card?.id) saveCards([{ ...prev, links: { ...prev.links, writer_next: writer.id } }]); // 上一件到这里为止
  } else {
    const got = commandCard(r, s, user, now);
    card = got?.card || got;
    // 已有的那张（排队时开的、在跑的）：不另存一张；排队时开的还没记是哪段对话起的，补上（重复说的那次不改）。
    if (got?.existing) { saved = true; if (got.from && !card.from?.session_id) saveCards([{ ...card, from: { ...(card.from || {}), ...got.from } }]); }
    else if (got?.queue_id) { saved = true; saveCards([card]); setCard(got.queue_id, card.id); }
  }
  if (!card) return r;
  if (!saved) saveCards([card]);
  s.messages.push(taskLink(card, { now, after: user?.id || null }));
  // 同一句里的第二件（「定制简历 + 英文求职信」）：自己一张卡，第一张到它为止。
  let extra = null;
  if (writer && also) {
    extra = writerCard(also, s, { said: user, now });
    if (extra) { saveCards([{ ...card, links: { ...card.links, writer_next: also.id } }, extra]); s.messages.push(taskLink(extra, { now, after: user?.id || null })); }
  }
  s.updated_at = iso(now);
  saveSession(s);
  return { ...r, session: s, task: card.id, ...(extra ? { tasks: [card.id, extra.id] } : {}) };
}
// 岗位页「按岗位定制」、信页「改一版」起的 Writer 的活：没有发起它的对话。Writer 先问的那几句记在这件活自己的那段里
// （origin: page，不进对话历史，lib/chat.mjs taskOnly），问题进收件箱（lib/task-writer.mjs writerAsks），卡片上答是同一封。
// Writer 没开口（没有模型、信不在了）：不建卡、不建对话，照实回那一句。→ { task, session_id, message_id } 或 {}
function pageWriter({ text, reply, action, focus = null, via = 'page', now = Date.now() }) {
  if (!reply?.writer) return {};
  const session = newSession({ persona: 'tailor', now });
  session.origin = { by: 'page', action };
  const user = { id: rid_(), role: 'user', content: text, at: iso(now), via: 'page', route: { to: 'tailor', kind: 'writer' }, ...(focus ? { focus } : {}) };
  const r0 = directTurn(session, user, reply, 'tailor');
  const card = writerCard(r0.reply, r0.session, { said: user, now });
  card.from = { by: 'you', via };
  saveCards([card]);
  r0.session.task = card.id; r0.session.title = headline(card.title) || r0.session.title; r0.session.title_by = 'task';
  saveSession(r0.session);
  return { task: card.id, session_id: session.id, message_id: r0.reply.id };
}
// 任务页上新建的一句是 Writer 的活（改简历、写求职信或自我介绍，writerJob 认得的）：和岗位页上起的一样（pageWriter，via 'tasks'），
// 问题进收件箱。→ { task } ；不是 Writer 的活 → null；Writer 没开口（没有模型、编号对不上）→ 抛 409，说的是 Writer 那一句。
export async function writerTaskFromText(text, { writerModel = null, now = Date.now() } = {}) {
  const raw = String(text || '').trim();
  if (!writerAsk(raw) && !letterAsk(raw) && planTalk(raw)?.type !== 'materials') return null;
  const w = await writerJob({ raw, index: leadIndex() }, { writerModel, now });
  if (!w?.reply) return null;
  if (!w.reply.writer) throw Object.assign(Error(w.reply.content || 'Writer 这次没接'), { status: 409 });
  const first = pageWriter({ text: raw, reply: w.reply, action: 'tasks', via: 'tasks', now });
  // 同一句里的第二样也开一件；开不了的，那一句原因跟着回去（不悄悄丢掉）。
  if (!w.also) return first;
  if (w.also.writer) { const second = pageWriter({ text: raw, reply: w.also, action: 'tasks', via: 'tasks', now }); return { ...first, tasks: [first.task, second.task].filter(Boolean) }; }
  return { ...first, note: w.also.content || null };
}
// 这句话会建成哪类活、派给谁能不能换（GET /api/talk/parse 的 task，任务页新建框用；和卡片上的 assign 同一个形状）。
// 认得出的：规则路线（投、联系、调研、怎么准备、收录）、Writer 的活、投 N / 跑脚本的指令、贴来的链接。认不出要干活的是 null。
function taskShape(raw, c) {
  const fixed = (kind, label, who) => ({ kind, kind_label: label, owner: { id: who, name: crewName(who) }, assign: { fixed: true, owner: { id: who, name: crewName(who) } } });
  if (c.kind === 'company_search') return fixed('company_search', '找公司岗位', 'scout');
  if (c.kind === 'command') {
    if (c.cmd?.kind === 'queue_apply') return fixed('apply', KINDS.apply.label, 'quill');
    const k = c.cmd?.kind === 'op' ? Object.keys(KINDS).find(x => KINDS[x].op && KINDS[x].op === c.cmd.op) : null;
    return k && KINDS[k].member ? fixed(k, KINDS[k].label, KINDS[k].member) : null;
  }
  if (letterAsk(raw)) return fixed('letters', KINDS.letters.label, 'tailor');
  if (writerAsk(raw)) return fixed('resume', KINDS.resume.label, 'tailor');
  const plan = planTalk(raw);
  if (plan) { const first = plan.route.find(x => x.state === 'planned'); return plan.route.length > 1 ? { ...fixed('goal', plan.title, first.owner), kind_label: plan.title } : fixed(first.kind, KINDS[first.kind]?.label || plan.title, first.owner); }
  return c.kind === 'capture' ? fixed('intake', KINDS.intake.label, 'scout') : null;
}
// 收件箱里、卡片上答 Writer 先问的那几句（「就这样改」「直接改」），卡片上的「再试一次」：在这件活那段对话里照点了那个按钮做。
// text：收件箱「其他」里写的一句，当第一题的回答（逐题的回答页面用 answers 带）。
const materialClarify = { content: '这次要处理哪份材料：简历、求职信，还是自我介绍？确认后再做。', bad: true };
// 回答哪张问题卡、继续哪件活，就沿用它的文档与已完成版本；不受后来打开的材料影响。
function writerResumeFocus(s, m) {
  if (!m?.writer?.doc) return null;
  const t = writerTask(m, s);
  return resumeFocus({ doc: m.writer.doc, version: t?.card?.version || t?.writer?.version || m.writer.version });
}
export async function writerAnswer({ session_id, message_id, kind, answers = null, text = '', now = Date.now() } = {}, { writerModel = null } = {}) {
  const raw = { resume_answers: '就这样改', resume_skip: '直接改', resume_retry: '再试一次' }[kind];
  if (!raw) throw Error('不认得这个按钮');
  const s = loadSession(String(session_id || ''));
  if (String(text || '').trim() && (writerAsk(text) || letterAsk(text) || rejectsMaterial(text))) {
    const rf = writerResumeFocus(s, s.messages.find(m => m.id === message_id));
    const r = writerAsk(text) || letterAsk(text) ? await talkTurn({ session_id: s.id, text, member: 'tailor', focus: rf ? { resume: rf } : null }, { writerModel, now, titleFn: false }) : directTurn(s, { id: rid(), role: 'user', content: text, at: iso(now), route: { to: 'tailor', kind: 'writer' } }, materialClarify, 'tailor');
    return { ...r, redirected: true };
  }
  let a = answers;
  if (kind === 'resume_answers' && !a && String(text || '').trim()) { const m = s.messages.find(x => x.id === message_id), q = m ? writerTask(m, s)?.questions?.[0] : null; a = q ? { [q.id]: { text: cut(text, 300) } } : null; }
  return writerActionTurn({ s, raw, action: { kind, message_id, ...(a ? { answers: a } : {}) }, now }, { writerModel });
}
// 卡片上的指令接着做 Writer 的活（lib/task-say.mjs）：照这句再改一版——简历从最近那一版直接改，信照这句改那封信。
// 记在这件活那段对话里（你这句加 Writer 的回复），这件活的卡跟着最后那条 Writer 消息走。
export async function writerFollow({ card, text, now = Date.now() } = {}, { writerModel = null } = {}) {
  if (!card?.session_id || !sessionExists(card.session_id)) return { content: '这件活的那段对话不在了', bad: true };
  const s = loadSession(card.session_id), m = writerChain(s, card.links?.writer, card.links?.writer_next).filter(x => x.writer?.doc || x.writer?.letter).at(-1);
  if (writerAsk(text) || letterAsk(text) || rejectsMaterial(text)) {
    if (!writerAsk(text) && !letterAsk(text)) return materialClarify;
    const rf = writerResumeFocus(s, m);
    const r = await talkTurn({ session_id: card.session_id, text, member: 'tailor', focus: rf ? { resume: rf } : null }, { writerModel, now, titleFn: false });
    return { ...r.reply, redirected: true };
  }
  if (!m) return { content: '还没有能接着改的那一版', bad: true };
  const ms = writerReady(writerModel);
  if (!ms.ok) return writerNoModel(ms);
  const w = m.writer, rec = writerResults()[m.id] || {};
  let reply;
  try { reply = /^letter_/.test(w.kind) ? (w.letter ? letterRewriteMessage({ key: w.letter, title: w.title, instruction: text, lead: w.lead }, { model: writerModel, now }) : { content: '这封信还没写出来，等它写好再改', bad: true }) : await rewriteMessage({ target: writerResumeFocus(s, m) || { doc: w.doc, version: rec.to_vid || w.version, name: w.name }, instruction: text, lead: w.lead || null }, { model: writerModel, now }); }
  catch (e) { event('tailor', 'resume', 'fail', `Writer 照卡片上的指令改没起来：${cut(e.message, 160)}`); return { content: sayError(e, { who: 'tailor' }), bad: true }; }
  if (reply?.writer) reply.writer.follow_of = m.id; // 记在对话末尾：这件活认它（lib/task-writer.mjs writerChain），不算到后面那件头上
  const user = { id: rid_(), role: 'user', content: text, at: iso(now), via: 'task', route: { to: 'tailor', kind: 'writer' } };
  directTurn(s, user, reply, 'tailor');
  return reply;
}
// 卡片上的「看原因」（POST /api/tasks/<id>/why）：用这件活自己的事实答（和对话里那件活尾上的「看原因」同一套，taskWhyReply）。
export async function taskWhy(id, { now = Date.now() } = {}) {
  const all = allCards(), top = findTask(String(id || ''), all);
  if (!top) throw Object.assign(Error('没有这件事'), { status: 404 });
  const s = top.session_id && sessionExists(top.session_id) ? loadSession(top.session_id) : { messages: [] };
  return await taskWhyReply(s, { task: top.id, now }) || { content: '这件活已经不在任务清单里了。' };
}

async function turnOnce({ session_id = null, text, confirm = false, via = null, member = null, focus = null, action = null } = {}, { dispatch, center = {}, hq = null, completeFn = null, config = null, now = Date.now(), leads = null, agent = null, tailoring = null, kick = null, cards = true, phone = null, writerModel = null, onDelta = null, companySearch = startCompanySearch } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 2000) throw Error('请输入内容（2000 字以内）');
  if (session_id && !validId(session_id)) throw Error('无效的会话 id');
  const s = session_id && sessionExists(session_id) ? loadSession(session_id) : null;
  const thread = threadOf(member), recipient = recipientOf(member); // 本轮明确选择优先于旧会话与页面
  const index = leadIndex(leads), f = focusOf(focus, index);
  // 材料页开着的那一版简历（focus.resume）：认不出（没有这份、没有这一版）就当没带。
  const rf = resumeFocus(focus?.resume);
  // 点了 Writer 回复里的按钮（撤销、按这几条改一版）：不分派，按那条消息做（lib/resume-talk.mjs writerButton）。
  // 一件活尾上的「看原因」（带着卡 id）：用这件活自己的事实答，不去全局找最近的失败（看图问题 1，10-03）。
  if (action?.kind === 'task_why' && s) {
    const user = { id: rid(), role: 'user', content: raw, at: iso(now), via: 'action', action: { kind: 'task_why', task: action.task || s.task || null }, route: { to: 'patch', kind: 'why' }, question: true };
    return directTurn(s, user, await taskWhyReply(s, { task: action.task, now }) || { content: '这件活已经不在任务清单里了。' }, 'patch');
  }
  if (action && typeof action === 'object' && s) return writerActionTurn({ s, raw, action, now }, { writerModel });
  let c = classifyTalk(raw, { previous: recipient || lastSpeaker(s), focus: f, member: recipient });
  if (c.kind !== 'company_search') c = companyFollow(s, raw) || c;
  // 你说的这句记下：写明分给了谁（页面上「Lens 接手」；@ 的那一条多记一个 at）；正看着哪一条也记下。
  // question：这句是在问（lib/tasks.mjs isQuestion）。问的只在对话里答，回话下面不放「交给团队去做」。
  // 「现在怎么样了」（status）也是问：团队按状态答完就完了（10-01 第 1 轮验收第 33 条：状态回答下面挂着「交给团队去做」）。
  const said = extra => ({ id: rid(), role: 'user', content: raw, at: iso(now), ...(via ? { via } : {}), ...((c.kind === 'chat' && isQuestion(raw)) || c.kind === 'status' ? { question: true } : {}), route: { to: c.persona, kind: c.kind, ...(recipient ? { at: recipient } : {}) }, ...(f ? { focus: { rid: f.rid, number: f.number } } : {}), ...(rf ? { resume: { doc: rf.doc, version: rf.version, selection: rf.selection } } : {}), ...extra });
  if (c.kind === 'company_search') return companyTurn({ s, c, user: said(), now }, { companySearch });
  if (c.kind === 'command') return commandTurn({ s, raw, confirm, via, c, thread, said }, { dispatch, now, index, writerModel, ...(agent ? { agent } : {}) });
  // 交给 Writer 的材料的事（设计说明 4.2 / 5.4；L 线 10-02）：简历的体检、改一句、改一版（含定制），求职信、自我介绍，Writer 直接做
  // （writerJob）；别的话照旧聊天，只是 Writer 用自己的身份、带着这一版简历回答。投递、联系、调研这类按规则开卡的照旧。
  if (c.kind === 'chat' && (!recipient || recipient === 'tailor' || writerAsk(raw) || letterAsk(raw))) {
    const w = await writerJob({ raw, rf, thread, persona: c.persona, f, index, s }, { writerModel, now });
    if (w?.reply) {
      const session = s || newSession({ persona: 'tailor', now });
      return directTurn(session, said({ route: { to: 'tailor', kind: 'writer', ...(thread ? { at: thread } : {}) } }), w.reply, 'tailor', w.also || null);
    }
    if (w) return chatOnce({ s, raw, c: { ...c, persona: 'tailor' }, said, now, f, rf: w.target }, { completeFn, config, center, onDelta });
  }
  // 任务板（lib/tasks.mjs）：认得出的事（投递、联系、调研、材料、收一个链接）按规则开卡，不靠模型。
  // 和团队说：开一个目标、只开第一棒；单独和一位成员说：它给自己开一张卡，不拆。
  // phone：{ device }——没被允许交给执行器的手机（lib/phone/gateway.mjs、lib/phone/api.mjs makeTalk）：卡照开，
  // 要开执行器或浏览器的那一棒停在「回电脑确认」（lib/tasks.mjs mac_hold）。cards: false：不开卡。
  if (cards && ['chat', 'capture'].includes(c.kind)) {
    const plan = planFor(raw, { index, focus: f, thread, tailoring });
    // 投递第一棒就是批准（库里已有这一条，也不先定制简历）：照「投 N」走，先给同一个预览、等你确认（09-30 #21）。
    const apply = plan?.plan.type === 'apply' && plan.lead?.number != null && plan.plan.route.find(x => x.state === 'planned')?.kind === 'apply' ? `投 ${plan.lead.number}` : null;
    if (apply) { const cmd = resolveCommand(apply); return commandTurn({ s, raw, confirm, via, c: { kind: 'command', cmd, persona: commandPersona(cmd), numbers: commandNumbers(cmd), canonical: apply }, thread, said }, { dispatch, now, index, writerModel, ...(agent ? { agent } : {}) }); }
    if (plan) return planTurn({ s, raw, thread, said, now, phone, ...plan }, { kick });
  }
  const session = s || newSession({ persona: c.persona, now });
  if (c.kind === 'why') {
    // 在一件活自己的对话里问「这件为什么没做成」：先看这段是哪件活；这件没做成就用它自己的原因答。
    const own = s?.task && !c.number && !BANNER_WHY.test(raw) && !isLocalAiQuestion(raw) ? await taskWhyReply(s, { now, stuckOnly: true }) : null;
    if (own) return directTurn(session, said({ question: true, route: { to: 'patch', kind: 'why' } }), own, 'patch');
    return directTurn(session, said({ question: true }), await explainWhy(raw, { number: c.number, now, center, ...(leads ? { leads } : {}) }), c.persona);
  }
  if (c.kind === 'local_ai_status') return directTurn(session, said({ question: true }), { kind: 'status', content: localAiSummary() }, 'patch');
  if (c.kind === 'status') return directTurn(session, said(), statusDigest(typeof hq === 'function' ? hq() : hq || {}, { member: thread, working: talkState({ now, leads }).working, now }), c.persona);
  // 贴来的链接（planFor 没接的那几种：表里已经有、@ 了别的成员、链接前后多说了几个字）：表里有的说是哪一条；没有的照直接贴链接那样
  // 交给 Radar 收录（lib/tasks.mjs planTalk 的收录卡，脚本做），不请本机 AI 去读（L 线 10-02）。
  if (c.kind === 'capture') {
    const l = knownLink(c.url, index), plan = !l && cards ? planTalk(`收录 ${c.url}`) : null;
    if (plan) return planTurn({ s: session, raw, thread, said, now, phone, plan, lead: null }, { kick });
    return directTurn(session, said(), l ? knownReply(l) : captureReply(c.url), c.persona);
  }
  // 没有能用的模型（沙盒、没配）：不调模型，明明白白回一句，告诉你哪些照常能用。上一轮失败的（failing）还是去试。
  const ms = completeFn ? { ok: true } : modelState({ now });
  if (!ms.ok && ms.why !== 'failing') return directTurn(session, said(), noModelReply(ms), c.persona);
  return chatOnce({ s: session, raw, c, said, now, f, rf: c.persona === 'tailor' ? writerTarget(rf) : null }, { completeFn, config, center, ready: true, onDelta });
}
// 公司请求只走 Radar 的读岗入口；投递批准仍由岗位上的正常流程处理。
const searchReceipt = m => m?.company_search?.job_id ? companySearchReceipt(m.company_search.job_id) || m.company_search : m?.company_search;
function companyContent(r) {
  const links = (r.links || []).filter(x => /^#lead\/[a-zA-Z0-9_-]+$/.test(x.href || ''));
  return [r.content, ...links.map(x => `[${String(x.label || '查看岗位').replace(/[\[\]\\]/g, '')}](${x.href})`)].join('\n\n');
}
function companyFollow(s, raw) {
  const last = [...(s?.messages || [])].reverse().find(m => m.role === 'assistant' && m.company_search);
  const r = searchReceipt(last), url = captureUrl(raw);
  // 只认明确补链接；否定、问句或另一个指令不能沿用旧公司。
  if (r?.status !== 'needs_url' || !url || isQuestion(raw.replace(url, ''))) return null;
  const rest = raw.replace(url, '').replace(/[\s：:，,。.!！]/g, '');
  if (!/^(?:招聘页(?:链接)?|官网(?:招聘页)?|链接|这是招聘页)?$/.test(rest)) return null;
  return { kind: 'company_search', persona: 'scout', company: r.company, url };
}
async function companyTurn({ s, c, user, now }, { companySearch = startCompanySearch } = {}) {
  const session = s || newSession({ persona: 'scout', now });
  let receipt;
  try { receipt = await companySearch({ company: c.company, url: c.url || null, session_id: session.id, message_id: user.id, now }); }
  catch (e) {
    event('scout', 'company-search', 'fail', `公司找岗入口没启动：${cut(e.message, 160)}`);
    receipt = { ok: false, status: 'failed', company: c.company, url: c.url || null, job_id: null, needs: null, counts: { read: 0, added: 0, judged: 0 }, links: [], content: sayError(e, { who: 'scout', doing: '找岗位' }) };
  }
  return directTurn(session, user, { kind: 'company_search', content: companyContent(receipt), company_search: receipt }, 'scout');
}
function companyReplies(s) {
  return s ? { ...s, messages: (s.messages || []).map(m => {
    const r = searchReceipt(m);
    return r ? { ...m, content: companyContent(r), company_search: r } : m;
  }) } : s;
}

// 一轮对话（lib/chat.mjs chatTurn）。和 Writer 聊：提示词里带上这一版简历（rf：正在看的那一版，没有就是默认投递的那一版）。
// onDelta：边生成边显示（POST /api/talk 带 stream: true，bin/serve.mjs）；只有这一路是流的，指令、规则回答、Writer 的活照旧整段。
async function chatOnce({ s, raw, c, said, now, f, rf = null }, { completeFn = null, config = null, center = {}, ready = false, onDelta = null } = {}) {
  const session = s || newSession({ persona: c.persona, now });
  if (!ready) { const ms = completeFn ? { ok: true } : modelState({ now }); if (!ms.ok && ms.why !== 'failing') return directTurn(session, said(), noModelReply(ms), c.persona); }
  // 后台结果给模型看的也必须是最新回执，不能只让页面看到已完成。
  if (session.messages.some(m => m.company_search?.job_id)) saveSession(companyReplies(loadSession(session.id)));
  const r = await chatTurn({ session_id: session.id, persona: c.persona, text: raw, center: typeof center === 'function' ? center() : center, judgeOk: judgeAvailable({ offlineOk: true }), now, focus: f?.number ?? null, ...(rf ? { resume: resumeBrief(rf) } : {}), ...(completeFn ? { completeFn } : {}), ...(config ? { config } : {}), ...(onDelta ? { onDelta } : {}) });
  // chatTurn 记下了你的话：补上分给了谁和你正看着的那条。
  const u = [...r.session.messages].reverse().find(m => m.role === 'user' && m.content === raw);
  if (u) { Object.assign(u, said({ id: u.id, at: u.at })); saveSession(r.session); }
  return { kind: 'chat', persona: r.session.persona, session: r.session, reply: r.reply, error: r.error || null };
}
const resumeContent = t => targetContent(t);

// ── Writer 自己做的活（L 线 10-02：和本机 AI 解耦）────────────────────────────────────────
// 认出来是 Writer 要动手的：→ { reply }（Writer 回的那一句：在做的卡、先问的几个问题，或者一句直接的话）；
// 只是跟 Writer 聊材料（问一句、说说看法）：→ { target }（照旧聊天，提示词里带这一版简历）；不是 Writer 的事：→ null。
// 全是规则，不问模型：
//   简历  规则里的「改简历」（lib/tasks.mjs planTalk）、@Writer 或开着材料页说简历的事（wantsWriter），或者说到简历又有改的动词
//         （writerAsk，不用开着材料页）。体检、改一句、改一版照 writerIntent 分；writerAsk 认得、writerIntent 只当聊天的，当改一版做，
//         你的原话就是要求（照旧先问几句）。
//   信    求职信、自我介绍（letterAsk）：写一封新的，或者改已有的那封（先问）。求职信要对着一个岗位，编号对不上就照实说。
//         只是提到、没说要写要改的，照旧聊天（以前开一张没人接的卡）。
// 投递、联系、调研（planTalk 认得的别的几类）照旧排在前面，不归这里。
// Writer 动手之前先看有没有能用的文字模型（lib/model.mjs textReady，和 infer 选底座同一条路）：没有就回「没有模型」那句
// （writerNoModel：一句加「设置模型」按钮），不开 Writer 的活，也不排给本机 AI。只是聊天的，照旧由 chatOnce 看对话模型。
const writerReady = writerModel => writerModel ? { ok: true } : textReady({ role: 'tailor' });
// 这段对话已经绑着的那件 Writer 的活（第 6 轮：在一封信的对话里说「按原简历修正、存成新版本」，Writer 回「要对着一个岗位写」）：
// 最近一条带着信、简历或岗位的 Writer 消息。→ { kind: 'letter' | 'resume', letter, lead, title } | null
export function boundWriter(s) {
  const res = writerResults();
  for (const m of [...(s?.messages || [])].reverse()) {
    const w = m.role === 'assistant' ? m.writer : null;
    if (!w) continue;
    const isLetter = /^letter_/.test(w.kind), letter = w.letter || (isLetter ? res[m.id]?.key || null : null);
    if (letter || w.lead || w.doc) return { kind: isLetter ? 'letter' : 'resume', letter, lead: w.lead || (letter ? leadOfLetter(letter) : null), title: w.title || null };
  }
  return null;
}
// 只有作为处理对象的「默认…简历」才切换；保护默认/原件的约束不是选文档。
// 语言和版本也只读这个对象短语，不能拿副本或输出要求里提到的英文、vN 换目标。
function requestedDefaultResume(raw, fallbackLang) {
  for (const clause of materialRequestText(raw).split(/[，。；,;\n]/)) {
    const m = /(?:(英文|English|中文|Chinese)\s*)?(?:默认|default)\s*(?:的\s*)?(?:(英文|English|中文|Chinese)\s*(?:版\s*)?)?(?:简历|履历|resume\b|CV\b)(?:\s*(v\d+)\b)?/i.exec(clause);
    if (!m || /保留|保持|维持|保护|参考|参照|对照|对比|不动|不要|不用|别|不(?:再|去)?(?:更换|切换|修改|改|动|换|碰)|\b(?:keep|leave|don't|do not|compare)\b/i.test(clause.slice(0, m.index))) continue;
    if (/^\s*(?:保持|保留|维持|不变|不改|不动|别动|不要)/.test(clause.slice(m.index + m[0].length)) && !/体检|检查|查看|诊断|\b(?:review|inspect)\b/i.test(clause.slice(0, m.index))) continue;
    const language = m[1] || m[2], lang = language ? /英文|English/i.test(language) ? 'en' : 'zh' : fallbackLang;
    if (lang) return { lang, version: m[3]?.toLowerCase() || null };
  }
  return null;
}
// s：这段对话（有的话）。→ { reply, also? }：also 是同一句里要的第二样（一句话要了两样就做两样；做不了的那样也回一句原因，不悄悄丢掉）。
export async function writerJob({ raw, rf = null, thread = null, persona = null, f = null, index = leadIndex(), s = null }, { writerModel = null, now = Date.now() } = {}) {
  const p0 = planTalk(raw, { member: thread });
  if (p0 && p0.type !== 'materials') return null;
  // 「定制简历 + 英文求职信」：信那半句没有「写」「改」这类动词，以前只认成改简历，信悄悄没了；说到了信、又是在要 Writer 干活，就当也要了信。
  const letter = letterAsk(raw) || (writerAsk(raw) && LETTER_MENTION.test(materialRequestText(raw)) ? letterAsk(`写${raw}`) : null), bound = s ? boundWriter(s) : null;
  const both = !!letter && writerAsk(raw);
  if (both && !/(?:简历|履历|resume|CV)[^，。；]{0,40}(?:和|及|与|[+＋])[^，。；]{0,40}(?:求职信|自我介绍|cover\s*letter|self[- ]?intro)|(?:求职信|自我介绍|cover\s*letter|self[- ]?intro)[^，。；]{0,40}(?:和|及|与|[+＋])[^，。；]{0,40}(?:简历|履历|resume|CV)/i.test(materialRequestText(raw))) return { reply: materialClarify };
  // 话里没点名信、没点名岗位，这段对话又正绑着一封信：接着改那封信（沿用它的岗位），不再问是哪一条。
  const named = letter && (letter.number != null || letter.bare != null);
  if (!both && !named && !f && bound?.kind === 'letter' && bound.letter && (letter ? letter.revise || FIX_VERB.test(raw) : followsLetter(raw))) {
    const ms = writerReady(writerModel);
    if (!ms.ok) return { reply: writerNoModel(ms) };
    return { reply: letterRewriteMessage({ key: bound.letter, title: bound.title, instruction: raw, lead: bound.lead }, { model: writerModel, now }) };
  }
  // 这段对话最近一件是简历的活（改一版、定制），接着说要改（「再改一版，更精简」，话里不一定有「简历」两个字）：还是 Writer 改这份简历。
  const followsResume = !letter && bound?.kind === 'resume' && FIX_VERB.test(raw) && !isQuestion(raw) && !LETTER_MENTION.test(raw);
  const resume = (!letter || both) && (p0?.route?.[0]?.kind === 'resume' || wantsWriter(raw, { thread, persona, rf }) || writerAsk(raw) || followsResume);
  if (!letter && !resume && !p0) return null;
  const lastWriter = [...(s?.messages || [])].reverse().find(m => m.role === 'assistant' && m.writer);
  let target = writerTarget(rf || writerResumeFocus(s, lastWriter));
  const requested = resume && requestedDefaultResume(raw, target?.lang);
  if (requested) {
    const { lang, version } = requested;
    const chosen = defaultWriterTarget(lang);
    if (!chosen || chosen.lang !== lang) return { reply: { content: `没找到默认投递的${lang === 'en' ? '英文' : '中文'}简历，请在材料页选中这份简历再说。` } };
    if (version && version !== chosen.version) return { reply: { content: `当前默认投递的是 ${chosen.version}，你说的是 ${version}；要处理哪一版？` } };
    if (target?.doc !== chosen.doc || target?.version !== chosen.version) target = chosen;
  }
  let intent = null;
  if (resume) {
    intent = writerIntent(both ? resumePart(raw) : raw, { selection: target?.selection || [], content: target ? resumeContent(target) : null });
    if (intent.kind === 'chat' && (writerAsk(raw) || followsResume)) intent = { kind: 'rewrite', number: null };
    if (intent.kind === 'chat' && !letter) return { target };
  }
  if (!letter && !intent) return { target };
  // 信对着哪一条：先对编号（不用模型就能说清的先说：表上没有这一条、求职信没说是哪一条）；都没有就沿用这段对话绑着的岗位。
  const boundLead = bound?.lead?.number != null ? index.get(bound.lead.number) || null : null;
  const lead = letter ? index.get(letter.number) || (letter.bare != null ? index.get(letter.bare) : null) || (f ? index.get(f.number) : null) || (letter.kind === 'cover_letter' ? boundLead : null) || null : null;
  if (letter?.number != null && !index.get(letter.number)) return { reply: { content: `表上没有 #${letter.number}，没法对着它写。` } };
  if (letter?.kind === 'cover_letter' && !lead) return { reply: { content: '求职信要对着一个岗位写：告诉我是哪一条，比如「给 #12 写封求职信」。' } };
  // 改一版没点名岗位：同一句里信对着的那一条，或者这段对话绑着的那一条（接着定制，不再问）。
  if (intent?.kind === 'rewrite' && intent.number == null) intent = { ...intent, number: (both ? lead?.number : null) ?? (!writerAsk(raw) && bound?.kind === 'resume' ? bound.lead?.number : null) ?? null };
  const ms = writerReady(writerModel);
  if (!ms.ok) return { reply: writerNoModel(ms) };
  try {
    if (!letter) return { reply: await writerStart({ intent, target, text: raw }, { model: writerModel, now }) };
    const reply = writerLetterTurnFor({ ...letter, lead }, { model: writerModel, now });
    if (!both) return { reply };
    // 第二样：简历。认不出要怎么改的也照「改一版」开（你的原话就是要求）；开不了就是 Writer 的一句原因（比如还没有简历）。
    const ri = intent && intent.kind !== 'chat' ? intent : { kind: 'rewrite', number: lead?.number ?? null };
    const also = await writerStart({ intent: ri, target, text: resumePart(raw) }, { model: writerModel, now });
    return { reply, also: also?.content || also?.writer ? also : { content: '简历这半句我没认出要怎么改，单独说一句就开工。' } };
  } catch (e) { event('tailor', 'resume', 'fail', `Writer 没做成：${cut(e.message, 160)}`); return { reply: { content: sayError(e, { who: 'tailor' }), bad: true } }; } // 原文只进运行日志
}

// ── 「交给团队去做」：先看是不是引擎自己就能做的（L 线 10-02）────────────────────────────────
// POST /api/chat/handoff（面板上模型建议的「交给团队去做」、每条回话下面的小按钮、模型没回时的「直接交给团队去做」）和手机交出去的话都走这里。
//   Writer 的活（writerJob 认得的：改简历、写求职信或自我介绍）：在这段对话里直接交给 Writer；
//   表里已经有的岗位链接：直接说是哪一条。
// 这两种都不写宿主任务、不排给本机 AI：你点的那一下记成「点了回复里的按钮」的一句话，模型那条建议标成接了（按钮不再出来）。
// 别的照旧交给团队（lib/chat.mjs handoff：一条宿主任务 + 即时执行器，本机 AI 来做）。
// → { session, reply, routed: 'tailor' | 'known' } | handoff() 的结果 { session, message_id }
// 第 5 轮开箱 B3：别的也不直接写宿主任务：开一张「你交代的事」的卡（和任务页新建的同一条路，lib/task-do.mjs），引擎自己用文字模型做，
// 要动电脑的那张卡交给本机 AI（开着）或等你打开（没开）；对话里原地一条小条（task_link）。kick：马上同步一次（开跑）。
export async function handTurn({ session_id, text, persona = null, now = Date.now() } = {}, { writerModel = null, leads = null, kick = null, companySearch = startCompanySearch } = {}) {
  const task = String(text || '').trim();
  if (!task || task.length > 2000) throw Error('任务描述不能为空');
  const s = loadSession(String(session_id || ''));
  const c = classifyTalk(task);
  if (c.kind === 'company_search') {
    for (const m of s.messages) if (m.handoff && !m.handoff.dispatched && m.handoff.text === task) Object.assign(m.handoff, { dispatched: true, dispatched_at: iso(now), routed: 'company_search' });
    const user = { id: rid(), role: 'user', content: task, at: iso(now), via: 'action', route: { to: 'scout', kind: 'company_search' } };
    return { ...await companyTurn({ s, c, user, now }, { companySearch }), routed: 'company_search' };
  }
  const index = leadIndex(leads), url = captureUrl(task), known = url ? knownLink(url, index) : null;
  const w = known ? null : await writerJob({ raw: task, index, s }, { writerModel, now });
  // 主会话 10-03：本机 AI 开着也一样先让引擎做（省额度）；要动电脑的由那张卡交给本机 AI（lib/task-do.mjs startDo）。
  if (!known && !w?.reply) return teamTurn({ s, task, persona, now }, { kick });
  const at = iso(now), routed = known ? 'known' : 'tailor', who = known ? CAPTURE_MEMBER : 'tailor';
  const before = new Set(s.messages.map(m => m.id));
  for (const m of s.messages) if (m.handoff && !m.handoff.dispatched && m.handoff.text === task) Object.assign(m.handoff, { dispatched: true, dispatched_at: at, routed });
  const user = { id: rid(), role: 'user', content: task, at, via: 'action', route: { to: who, kind: known ? 'capture' : 'writer' } };
  const r0 = directTurn(s, user, known ? knownReply(known) : w.reply, who, known ? null : w.also || null);
  const r = known ? r0 : settleTask({ ...r0, kind: 'writer' }, { before, now }); // Writer 一开口就是一件活（lib/task-writer.mjs），就在这段对话里
  return { session: r.session, reply: r0.reply, routed, ...(r.task ? { task: r.task } : {}) };
}
// 交给团队、本机 AI 跑不了：一张「你交代的事」的卡（自己开跑），负责人是说话的那位；模型那条建议标成接了，原地一条小条。
async function teamTurn({ s, task, persona = null, now = Date.now() }, { kick = null } = {}) {
  const at = iso(now), hint = [...s.messages].reverse().find(m => m.handoff && !m.handoff.dispatched && m.handoff.text === task) || null;
  const owner = crewOf(persona || hint?.persona || s.member || s.persona) || crewOf(routePersona(task)) || 'patch';
  const lead = leadInText(task);
  const card = makeCard({ kind: null, title: task, leads: lead ? [lead] : [], owner, from: { by: 'you', session_id: s.id, message_id: hint?.id || null }, auto: true, now });
  card.kind = 'ask';
  saveCards([card]);
  for (const m of s.messages) if (m.handoff && !m.handoff.dispatched && m.handoff.text === task) Object.assign(m.handoff, { dispatched: true, dispatched_at: at, routed: 'team', task: card.id });
  s.messages.push(taskLink(card, { now, after: hint?.id || null }));
  s.updated_at = at;
  saveSession(s);
  if (kick) try { await kick(); } catch {} /* 兜底：叫醒没成：卡已经存下了，任务同步那一拍（4 秒）照样会接 */
  return { session: sessionExists(s.id) ? loadSession(s.id) : s, routed: 'team', task: card.id, owner };
}
// 点了 Writer 回复里的按钮：你这一下记成「点了回复里的按钮」的一句话（带着是哪条消息的哪个按钮），Writer 回一句。
async function writerActionTurn({ s, raw, action, now }, { writerModel = null } = {}) {
  const kind = String(action.kind || ''), message_id = String(action.message_id || '');
  const user = { id: rid(), role: 'user', content: raw, at: iso(now), via: 'action', action: { kind, message_id }, route: { to: 'tailor', kind: 'writer' } };
  let reply;
  const answers = action.answers && typeof action.answers === 'object' && !Array.isArray(action.answers) ? action.answers : null; // 「开始改」带的回答
  if (kind === 'resume_why') return directTurn(s, { ...user, route: { to: 'patch', kind: 'why' } }, await whyReply(s, message_id, { now }), 'patch');
  if (kind === 'resume_retry') return directTurn(s, user, await retryReply(s, message_id, { writerModel, now }), 'tailor');
  try { reply = await writerButton({ session: s, message_id, kind, answers }, { model: writerModel, now }); }
  catch (e) { event('tailor', 'resume', 'fail', `Writer 按钮「${kind}」没做成：${cut(e.message, 160)}`); reply = { content: sayError(e, { who: 'tailor' }), bad: true }; }
  return directTurn(s, user, reply, 'tailor');
}
// Writer 的活没做成（lib/resume-talk.mjs writerTask 的 why）：「看原因」由 System 在同一段对话里讲原因、影响、能怎么办；
// 「再试一次」用同样的输入再做一次，新的那条记 retry_of（最早那条的 id）。连着 MAX_TRIES 次没成就不再接「再试一次」。
const failedWriter = (s, message_id) => { const m = (s.messages || []).find(x => x.id === message_id && x.kind === 'writer'); return m ? { m, t: writerTask(m, s) } : null; };
// 原因由 System 讲（lib/system/explain.mjs，2c）：卡上的原因当事实，再带上是哪个模型、运行记录在哪；有模型写人话，没有照旧规则版。
async function whyReply(s, message_id, { now = Date.now() } = {}) {
  const x = failedWriter(s, message_id);
  if (!x?.t?.why) return { content: x ? '这件没出问题，不用查原因。' : '这条消息已经不在这个对话里了。' };
  const { failed } = writerTries(x.m, s);
  const r = await explainWhy('看原因', { now, failure: { reason: x.t.why.reason, who: 'tailor', at: x.m.at, tries: failed } });
  return { ...r, why: { ...r.why, of: message_id } };
}
// 一件活的「看原因」：这件活自己的事实——Writer 的活走那条没写成的 Writer 消息（whyReply）；
// 别的活用没做成的那张卡（目标卡是它下面没做成的那一棒）：卡上的原因、谁、连着几次。
// stuckOnly：你自己打字问的，这件没做成才这样答（不然照常按你问的那句答）。→ 回复，或者 null（不是一件活、或者没做成之外的 stuckOnly）。
async function taskWhyReply(s, { task = null, now = Date.now(), stuckOnly = false } = {}) {
  let all, top;
  try { all = allCards(); top = findTask(String(task || s?.task || ''), all); } catch { return null; } /* 兜底：卡读不出来就当不是在问一件活，照常按你问的那句答 */
  if (!top) return null;
  const shown = shownCard(top, all), st = taskStatus(shown);
  const wm = [...(s?.messages || [])].reverse().find(m => m.kind === 'writer' && writerTask(m, s)?.why);
  if (wm && (top.links?.writer || top.owner === 'tailor')) { const r = await whyReply(s, wm.id, { now }); return { ...r, why: { ...(r.why || {}), task: top.id } }; }
  if (st.status !== 'stuck') return stuckOnly ? null : { content: `这件现在${st.withdrawn ? '撤回了' : st.word}，没出问题。` };
  const bad = failingCard(top, all);
  const said = [...(s?.messages || [])].reverse().find(m => m.role === 'assistant' && m.bad && m.content);
  const reason = bad.detail || shown.detail || said?.content || '';
  const r = await explainWhy('看原因', { now, failure: { reason, who: bad.owner && bad.owner !== 'team' ? bad.owner : 'patch', at: bad.started_at || bad.created_at, tries: taskTries(bad) + 1 } });
  return { ...r, why: { ...(r.why || {}), task: top.id } };
}
async function retryReply(s, message_id, { writerModel = null, now = Date.now() } = {}) {
  const x = failedWriter(s, message_id);
  if (!x) return { content: '这条消息已经不在这个对话里了。', bad: true };
  if (!x.t?.why?.retry) return { content: x.t?.why ? '这个原因换一次也不会好，先看看原因。' : '这件没出问题，不用再试。' };
  const { origin, chain, failed } = writerTries(x.m, s);
  if (failed >= MAX_TRIES) return { content: `已经连着 ${failed} 次没做成，先看看原因。` };
  const later = chain.find(y => y.id !== x.m.id && Date.parse(y.at) > Date.parse(x.m.at));
  if (later) return { content: '这件已经在重做了，看下面那条。' };
  const ms = writerReady(writerModel);
  if (!ms.ok) return writerNoModel(ms);
  // 同样的输入：最早那条前面你说的那句；是点按钮开出来的（不是打字说的），就照那条消息自己记下的输入再做。
  const msgs = s.messages, at = msgs.findIndex(y => y.id === origin), said = at > 0 ? msgs.slice(0, at).reverse().find(y => y.role === 'user') : null;
  let reply = null;
  try {
    if (said && !said.action && said.content) {
      const index = leadIndex(), f = said.focus ? focusOf(said.focus, index) : null;
      reply = (await writerJob({ raw: said.content, rf: resumeFocus(said.resume), thread: said.route?.at || null, f, index }, { writerModel, now }))?.reply || null;
    }
    if (!reply?.writer) reply = await writerAgain(msgs[at] || x.m, { model: writerModel, now });
  } catch (e) { event('tailor', 'resume', 'fail', `Writer 再试一次没起来：${cut(e.message, 160)}`); return { content: sayError(e, { who: 'tailor' }), bad: true }; }
  if (reply?.writer) reply.writer.retry_of = origin;
  return reply;
}

// 岗位页「按岗位定制」（POST /api/resume {action:'tailor', rid}，lib/resume-tailor.mjs）：Writer 先问（lib/resume-talk.mjs writerStart），
// 以和岗位同语言的默认投递那一版为底。不是在对话里起的（pageWriter）：问题进收件箱。→ { task, message_id, status }（Writer 没开口时带 content）
export async function writerTailorTurn({ rid, now = Date.now() } = {}, { writerModel = null, leads = null } = {}) {
  const all = leads || cachedLines('state/leads.ndjson'), lead = all.filter(l => String(l.record_id || l.id || '') === String(rid || '') && !l.superseded).at(-1);
  if (!lead || lead.number == null) throw Object.assign(Error('找不到这条线索'), { status: 404 });
  const target = tailorTarget(lead);
  if (!target) throw Object.assign(Error('还没有默认投递的简历版本：先在「材料」里把一版设为默认投递'), { status: 422 });
  const text = `按 #${lead.number} 定制一份`;
  const reply = await writerStart({ intent: { kind: 'rewrite', number: lead.number }, target, text }, { model: writerModel, now });
  const r = pageWriter({ text, reply, action: 'tailor', focus: { rid: String(rid), number: lead.number }, now });
  return { ...r, status: reply.writer ? 'asking' : 'said', ...(reply.writer ? {} : { content: reply.content }) };
}
// 信 / 自我介绍页上的「改一版」（POST /api/resume {action:'letter_rewrite', key}）：Writer 先问几句（lib/resume-talk.mjs writerLetterStart，
// 不跑模型）；答完才写。和「按岗位定制」一样不在对话里：问题进收件箱。→ { task, message_id, status }
export async function writerLetterTurn({ key, now = Date.now() } = {}) {
  const reply = writerLetterStart({ key }, { now });
  if (!reply.writer) throw Object.assign(Error(reply.content || '这封信不在了'), { status: 404 });
  return { ...pageWriter({ text: `改一版：${reply.writer.title}`, reply, action: 'letter', now }), status: 'asking' };
}
// 这句话能不能按规则开卡：编号对上库里的那一条（或你正看着的那条）；链接已经收过的就当那一条。
function planFor(raw, { index, focus, thread, tailoring }) {
  const on = typeof tailoring === 'function' ? tailoring() : tailoring;
  let plan = planTalk(raw, { member: thread, tailoring: !!on });
  if (!plan) return null;
  let lead = plan.number != null ? index.get(plan.number) || null : null;
  if (!lead && plan.url) lead = leadByUrl(index.values(), plan.url);
  if (!lead && focus && plan.type !== 'intake' && plan.number == null && !plan.url) lead = index.get(focus.number) || null;
  if (plan.type !== 'intake' && plan.type !== 'materials' && !lead && !plan.url) return null; // 编号对不上：交给原来的分派
  if (lead) plan = planTalk(raw.replace(plan.url || '\u0000', `#${lead.number}`), { member: thread, tailoring: !!on, lead }) || plan;
  if (plan.type === 'intake' && lead) return null; // 已经收过了：照原来的回法
  return { plan, lead };
}
async function planTurn({ s, raw, thread, said, now, plan, lead, phone = null }, { kick = null } = {}) {
  const first = plan.route.find(x => x.state === 'planned');
  const persona = thread || (plan.route.length > 1 ? 'team' : first.owner);
  const session = s || newSession({ persona: thread || first.owner, now });
  const user = said({ route: { to: persona, kind: !thread && plan.route.length > 1 ? 'goal' : 'card', ...(thread ? { at: thread } : {}) } }); // 记下真正接手的（整个团队，或那一张卡的主人）
  const { goal, card } = startGoal(plan, { lead: lead ? leadRef(lead) : null, origin: { session_id: session.id, message_id: user.id, member: thread, ...(phone ? { phone } : {}) }, text: raw, now, single: !!thread });
  const at = iso(Date.now());
  const reply = { id: rid(), role: 'assistant', persona, at, kind: goal ? 'goal' : 'card', content: goal ? '好，这件事分成几棒。' : `开了一张卡：${card.title}`, ...(goal ? { goal: goal.id } : {}), card: card.id };
  session.messages.push(user, reply);
  autoTitle(session, raw);
  session.updated_at = at;
  saveSession(session);
  if (kick) try { await kick(); } catch {} /* 兜底：叫醒没成：卡已经存下了，任务同步那一拍（4 秒）照样会接 */
  return { kind: reply.kind, persona, session, reply, goal: goal?.id || null, card: card.id };
}
// 接力那一行（「Radar → Writer：…」）：记在接棒那张卡上（card.relay），在任务卡片的「做了什么」里出现（lib/task-migrate.mjs historyOf）；
// 不再写进发起它的那段聊天（主会话 10-03：对话栏只留人说的话、成员的回答和任务小条）。一张卡只记一次。
// lib/tasks.mjs syncTasks 开卡时自己就记上了；这里给 bin/task.mjs pass 这类手动交接用。
export function relayLine(r = {}) {
  const c = r.card ? readCards().find(x => x.id === r.card) : null;
  if (!c || c.relay) return false;
  saveCards([{ ...c, relay: { from: r.from || null, to: r.to || null, text: String(r.text || '') } }]);
  return true;
}
// 「交给团队去做」（lib/chat.mjs handoff）交出去的那件事也是一张卡：负责人是说话的那位，指向那条交办任务。
export function cardForHandoff({ session_id, message_id, persona = null, text = '', now = Date.now() } = {}) {
  const j = lastRev(lines('state/host-jobs.ndjson')).find(x => x.thread?.message_id === message_id);
  if (!j || readCards().some(c => c.links?.job_id === j.id)) return null;
  const s = sessionExists(session_id) ? loadSession(session_id) : null;
  const owner = crewOf(persona || s?.member || s?.persona);
  const card = makeCard({ kind: null, title: cut(text, 80), owner: owner || null, from: { by: 'you', session_id, message_id, ...(s?.member ? { member: s.member } : {}) }, links: { job_id: j.id }, how: 'executor', now });
  card.kind = 'ask';
  saveCards([card]);
  return card;
}
// 这个会话里提到的目标和卡（目标卡、接力行、交给团队的事）：推好状态给面板画。
function sessionCards(s, ctx) {
  const ids = new Set();
  for (const m of s?.messages || []) { if (m.goal) ids.add(m.goal); if (m.card) ids.add(m.card); if (m.kind === 'task_link' && m.task) ids.add(m.task); }
  if (s?.task) ids.add(s.task); // 这段对话自己的那件活
  const all = readCards();
  const mids = new Set((s?.messages || []).map(m => m.handoff?.message_id).filter(Boolean));
  for (const c of all) if (c.from?.message_id && (mids.has(c.from.message_id))) ids.add(c.id);
  if (!ids.size) return {};
  const tctx = { now: ctx.now, jobs: ctx.jobs, ops: ctx.ops, leads: cachedLines('state/leads.ndjson'), runNow: ctx.runNow, asks: ctx.asks, ...(ctx.env || {}), model: ctx.model || { ok: true } };
  const goals = new Set(all.filter(c => ids.has(c.id) && c.kind === 'goal').map(c => c.id));
  const derived = all.filter(c => ids.has(c.id) || goals.has(c.goal)).map(c => c.kind === 'goal' ? c : viewCard(c, tctx)); // 状态读账，不在这里推
  const out = {};
  for (const c of derived) out[c.id] = c.kind === 'goal' ? deriveGoal(c, derived) : c;
  return out;
}

async function commandTurn({ s, raw, confirm, via, c, thread, said }, { dispatch, now, index, agent = agentAction, writerModel = null }) {
  // 会话 id 先定好：排给即时执行器时带上它，执行器做完把话写回这个会话（config/run-now-prompt.md 5b）。
  const sid = s?.id || newSessionId(), message_id = `talk-${sid}-${crypto.randomBytes(4).toString('hex')}`;
  const thread_ = { channel: 'web', session_id: sid, message_id, persona: c.persona };
  const text = c.canonical || raw;
  let res;
  try { res = c.cmd.kind === 'agent' ? await agent(c.cmd.member, c.cmd.verb) : await dispatch(text, { confirm: !!confirm, thread: thread_, ...(writerModel ? { writerModel } : {}) }); }
  catch (e) { event(c.persona || 'patch', 'talk', 'fail', `指令「${cut(text, 40)}」没办成：${cut(e.message, 160)}`); res = { ok: false, error: errorReason(e) }; } // 原文只进运行日志
  // 发送 / 投递：先给你看预览（和指挥台同一个确认框）；这时还什么都没做，不记。
  if (res?.needs_confirm) return { kind: 'command', persona: c.persona, needs_confirm: true, confirm_text: res.confirm_text, preview: res.preview };
  const session = s || newSession({ id: sid, persona: c.persona, now });
  // 动到的行：点名的编号；「投 全部」是实际排上 / 等登录的那几个；清单类（重点、拟投清单）列出清单里的。
  const listed = res.data?.top_picks || res.data?.apply_proposal || res.data?.send_proposal || null;
  const applied = res.applied ? [...(res.applied.queued || []), ...(res.applied.waiting_login || [])] : [];
  const named = c.numbers.length ? c.numbers : applied;
  const rows = rowsFor(named.length ? named : (listed || []).map(x => Number(x.number)).filter(Number.isInteger).slice(0, 12), index);
  const line = receiptLine(c.cmd, res, named.length ? rows : []);
  const backend = String(res.receipt || res.ack || '').trim();
  const at = iso(Date.now());
  const user = said(c.canonical ? { resolved: c.canonical } : {});
  if (!user.via) user.via = 'command';
  const receipt = {
    id: rid(), role: 'assistant', kind: 'receipt', persona: c.persona, content: line.text, at, ok: line.ok,
    ...(backend && backend !== line.text && line.ok && !res.op?.queued && !res.already ? { detail: backend } : {}), // 排上了 / 在跑：正文已经说了，不再挂一遍
    command: { text, verb: c.cmd.verb, kind: c.cmd.kind, label: verbLabel(c.cmd), ...(res.card_id ? { card_id: res.card_id } : {}), run_now: !!res.run_now, message_id: res.run_now ? message_id : null, op: res.op?.id ? { id: res.op.id, label: res.op.label, log: res.op.log, ...(res.op.queued ? { queued: true, dup: !!res.op.dup } : {}) } : null, navigate: res.navigate || null, open: Array.isArray(res.open) ? res.open.slice(0, 3) : null },
    leads: rows.map(r => ({ ...r, to: line.per?.[r.number] ?? (line.ok && named.length ? line.to : null) })),
  };
  session.messages.push(user, receipt);
  autoTitle(session, raw);
  session.persona = c.persona; session.updated_at = at;
  saveSession(session);
  return { kind: 'command', persona: c.persona, session, receipt };
}

// 不经模型、直接答的一句：状态汇总、收下链接。
// also：同一句里要的第二样（Writer 的另一件活，或者做不了的那一句原因），紧跟在第一条后面。
function directTurn(session, user, reply, persona, also = null) {
  const at = iso(Date.now());
  const msg = { id: rid(), role: 'assistant', persona, at, ...reply };
  const more = also ? { id: rid(), role: 'assistant', persona, at, ...also } : null;
  session.messages.push(user, msg, ...(more ? [more] : []));
  autoTitle(session, user.content);
  session.updated_at = at;
  saveSession(session);
  return { kind: reply.kind, persona, session, reply: msg, ...(more ? { also: more } : {}) };
}
// 没有模型时的那一句：说清楚对话停了，再列出不经模型照样能用的命令（名字从名册来）。
export const NO_MODEL_LINE = '现在没有能用的模型：对话先停，按钮和命令照常能用';
export function noModelReply(ms = {}) {
  const a = memberName('scout'), b = memberName('lens');
  return { kind: 'nomodel', content: `${NO_MODEL_LINE}。${ms.note ? `（${ms.note}）` : ''}\n这句话我先记下了，没有交给模型。现在能直接用的：\n· 投 12、跟进 18、18 联系、pass 44 原因\n· 暂停 ${a}、恢复 ${a}\n· ${b} 跑一轮\n· 表格和收件箱里的按钮\n要接上模型，去「设置」里选一个对话模型。` };
}
// Writer 要动手、可没有能用的文字模型（写信、改信、改简历）：一句说清，配的地方给一个按钮（和「看原因」的按钮同一种画法），不列命令。
export const SETTINGS_MODEL = { id: 'model', label: '设置模型', href: '#settings/model' };
export function writerNoModel(ms = {}) {
  const who = memberName('tailor');
  if (ms.why === 'sandbox') return { kind: 'nomodel', content: `现在没有能用的模型（${ms.note || '演示 / 沙盒模式不调用模型'}），${who} 先不动手。` };
  return { kind: 'nomodel', content: `现在没有能用的模型${ms.note ? `（${ms.note}）` : ''}，${who} 先不动手：在「设置 → 模型」里接上一个就能写。`, why: { kind: 'model', buttons: [SETTINGS_MODEL] } };
}
// 贴来的岗位链接：Scout 收下（收录你交来的岗位是它的事）。
// TODO(feat/capture)：POST /api/capture 合进来以后，这里直接交给收件口（查重、收录成线索、交给 Lens 判断），
// 回执写收录的结果；在那之前，一键「交给团队去做」让执行器去读这个链接（和飞书里转发链接走同一种宿主任务）。
function captureReply(url) {
  return { kind: 'capture', content: `收到这个链接。自动收录还没接上，我先请团队去读：打开看是什么岗位、有没有重复，收成一条线索再判断。点一下就交出去。`, url, handoff: { text: `读一下这个岗位链接，收录成线索（先查有没有重复），再判断值不值得投：${url}`, dispatched: false } };
}
// 贴来的链接表里已经有了：说是哪一条，不再请团队去读一遍（L 线 10-02）。只认有编号的那几条（和 planFor 同一个范围）。
const knownLink = (url, index) => leadByUrl(index.values(), url); // 链接找线索只有一种写法（lib/vocab.mjs）
function knownReply(l) {
  const r = rowOf(l);
  return { kind: 'capture', content: `这个岗位已经收过了：#${r.number} ${r.company}${r.role ? ` · ${r.role}` : ''}。`, links: [{ rid: r.rid, number: r.number, label: `#${r.number} ${cut(r.company, 16)}` }] };
}

// ── 「现在怎么样、我该做什么」：按当前状态答（hqView 的行、「需要你」、团队手上在做的），不经模型 ──────────
// member：单独说话的那位时只说它管的那几段。actions 是能直接点的指令（发送 / 投递照样先确认），links 打开那一条的详情。
// 标签的叫法和数都是指挥台那一份（lib/hq.mjs TABS / hqView tabs）：不问成员时直接照抄标签上的数。
const TAB_WORD = Object.fromEntries(TABS.filter(([k]) => !['ended', 'all'].includes(k)));
// 一行算谁的由服务端定（lib/hq.mjs rowMembers，团队名册按当前这一步算，r.members）；Patch 还管出了错的那几行。
export function statusDigest(view = {}, { member = null, working = [], now = Date.now() } = {}) {
  member = memberId(member);
  view = view && typeof view === 'object' ? view : {};
  const rows = workRows(view.rows), asks = Object.fromEntries(workRows(view.asks).map(a => [a.id, a])), tabs = Object.keys(TAB_WORD);
  const mine = r => !member || (Array.isArray(r.members) ? r.members : []).includes(member) || (member === 'patch' && r.trouble);
  const live = rows.filter(r => !r.ending && mine(r));
  const count = tabs.map(k => [k, !member && view.tabs ? view.tabs[k] || 0 : live.filter(r => r.tab === k).length]).filter(([, n]) => n);
  // 等你的事 = 收件箱那张单子（lib/hq.mjs waiting_ids，和侧栏角标、收件箱「全部」同一份）；单独问一位时只说算在它名下的（a.member）。
  const wait = view.waiting_ids || view.blockers, ids = Array.isArray(wait) ? wait : wait && typeof wait === 'object' ? Object.values(wait) : [];
  const blockers = ids.map(id => asks[id]).filter(Boolean).filter(a => !member || (a.member ? a.member === member : memberId(a.from) === member));
  const doing = workRows(working).filter(w => !member || memberId(w.persona) === member);
  const running = workRows(view.workers).filter(w => w.state === 'running' && (!member || memberId(w.key) === member) && w.now).map(w => `${memberName(w.key)}：${cut(w.now, 40)}`);
  const lines_ = [];
  // 正在跑的那一项（lib/hq.mjs runningNow，和指挥台同一份）：首轮还没出推荐时行是空的，照样说找到几个、判了几个。
  const r0 = view.running, run = r0 && (!member || member === r0.member || (member === 'lens' && r0.judged != null)) ? r0 : null;
  if (run) {
    const p = runProgress(run, { long: true, sep: '，' });
    lines_.push(`${run.op ? `正在跑「${run.label}」` : `${run.member_name} ${run.label}`}${run.started_at ? `（${sinceWord(run.started_at, now)}）` : ''}${p ? `：${p}` : ''}。`);
  }
  // 首轮跑完的结果（lib/first-round.mjs，指挥台顶上同一句）：首轮多半全是待核，只说「没有在推进的线索」会让人以为没跑成。
  const fr = !member || member === 'lens' || member === 'scout' ? view.first_round : null;
  if (fr && !run) lines_.push(`${fr.line}${fr.left_text ? `；${fr.left_text}` : ''}。`);
  const liveN = !member && view.tabs ? count.reduce((n, [, c]) => n + c, 0) : live.length;
  if (liveN || !run) lines_.push(liveN ? `${member ? '我手上' : '现在在推进'} ${liveN} 条${count.length ? '：' + count.map(([k, n]) => `${TAB_WORD[k]} ${n}`).join(' · ') : ''}。` : `${member ? '我手上' : '现在'}没有在推进的线索。`);
  if (blockers.length) {
    lines_.push(`要你定的 ${blockers.length} 件，先看这几件：`);
    for (const a of blockers.slice(0, 3)) lines_.push(`· ${a.lead?.number != null ? `#${a.lead.number} ` : ''}${cut(a.lead?.company ? coName(a.lead.company) : a.title, 24)}：${cut(a.line || a.question, 44)}`);
  } else lines_.push('现在没有卡住等你的事。');
  if (doing.length) lines_.push(`团队手上在做 ${doing.length} 件：${doing.slice(0, 3).map(w => `${cut(w.title, 24)}（${w.word || chipOf(w).word}）`).join('、')}${doing.length > 3 ? ' 等' : ''}。`);
  else if (running.length && !run) lines_.push(`正在跑：${running.slice(0, 2).join('；')}。`);
  // 下一步：先回卡住的；再批推荐的新线索（投）；没有就看要不要跟进。
  const fresh = live.filter(r => ['triage', 'apply'].includes(r.pipe_kind) && r.number != null && r.verdict === 'recommend').sort((a, b) => b.number - a.number).slice(0, 2);
  const follow = live.find(r => r.pipe_kind === 'followup' && r.number != null);
  const actions = [fresh.length ? `投 ${fresh.map(r => r.number).join(' ')}` : null, follow ? `${follow.number} 跟进` : null].filter(Boolean);
  const first = blockers[0];
  const advice = [first?.lead?.number != null ? `先处理 #${first.lead.number} 的「${a2t(first)}」` : first ? `先处理「${cut(first.title, 16)}」` : '', fresh.length ? `再看要不要批 ${fresh.map(r => '#' + r.number).join(' ')} 的投递（点下面的按钮，发出前还会给你看一遍）` : follow ? `#${follow.number} 该跟进了` : ''].filter(Boolean);
  // 待核的差的是设置里能补的（工作许可没填）：先补它，补上以后下一轮重新判断。
  const fill = !first && !fresh.length ? live.filter(r => r.tab === 'verify' && r.gap?.fill) : [];
  // 能在资料里补的：按缺口归类，先补最多的那一类（lib/first-round.mjs verifyGap 的 key、fill_label）。
  if (fill.length) { const by = new Map(); for (const r of fill) by.set(r.gap.key, [...(by.get(r.gap.key) || []), r]); const [most] = [...by.values()].sort((a, b) => b.length - a.length); advice.push(`先补${most[0].gap.fill_label || most[0].gap.text.replace(/没填$/, '')}：补上以后这 ${most.length} 个会重新判断`); }
  if (advice.length) lines_.push(`我建议${advice.join('，')}。`);
  const links = blockers.slice(0, 3).filter(a => a.lead?.rid).map(a => ({ rid: a.lead.rid, number: a.lead.number ?? null, label: `#${a.lead.number ?? '—'} ${cut(coName(a.lead.company), 16)}` }));
  return { kind: 'status', content: lines_.join('\n'), actions, links, ...(blockers.length ? { inbox: blockers.length } : {}) };
}
const a2t = a => cut(a.tag || a.line || a.question || '', 10);
const sinceWord = (at, now) => { const m = Math.floor((now - Date.parse(at)) / 60000); return !Number.isFinite(m) || m < 1 ? '刚开始' : m < 60 ? `已 ${m} 分钟` : `已 ${Math.floor(m / 60)} 小时 ${m % 60} 分`; };

// ── 交出去的事到哪了、谁在做什么 ─────────────────────────────────────────────
// status：queued 排队中 · running 在做 · done 做完 · needs_you 需要你 · stuck 卡住了 · withdrawn 撤回了
// steps：执行器一步步报的进展（心跳），最后是它用 bin/job.mjs 交的结果；给人看的话，不是模型的思考过程。
const find = (list, mid) => (list || []).find(r => r.thread?.message_id === mid) || null;
// 执行器问你的那封信（收件箱 / 指挥台「需要你」里同一封）：need:job:<id>:…、job:<id>，或者挡住它的登录。
const jobAsks = (job, asks) => asks.filter(a => String(a.id).includes(job.id) || (a.affected || []).some(x => x.job_id === job.id));
// 投了之后这几行上出来的「需要你」（终审、预填好了、材料变了、要你登录……），不算流水线上的四种。
const leadAsks = (rids, asks, kindOf) => asks.filter(a => !isPipeline(kindOf(a)) && (rids.includes(a.lead?.record_id) || (a.affected || []).some(x => rids.includes(x.record_id))));
// 心跳是谁的：执行器不是成员，它替请它做事的那位干活——步骤记在那位名下，写成「Quill · 用浏览器：…」（tool）。
// 自动投递是 Quill 自己用浏览器填表。
const BEAT_TOOL = { 'run-now': 'browser', 'auto-apply': 'browser' };
const STEP_WORD = { running: '接手开始做', submitting: '开始提交', login: '要你登录', exited: '这一轮没正常结束', failed: '没做成', done: '做完了' };
const EVIDENCE = /runs\/[^\s，。；;、）)"']+\.(?:png|jpe?g|webp|json|md|log|txt)/g;
const stepOf = (h, who, tool, prefix = '') => ({ who, tool, text: prefix + (h.step === 'running' ? STEP_WORD.running : (h.detail || STEP_WORD[h.step] || h.step || '')), at: h.at || null, status: h.status || null, evidence: [...new Set(String(h.detail || '').match(EVIDENCE) || [])] });
function beatSteps(t, { beats = {}, runNow = {}, job = null, numbers = [], done_at = null } = {}) {
  const out = [], who = memberId(t.persona) || 'patch';
  const history = key => beats.tasks?.[key]?.history || (beats.finished || []).filter(f => f.key === key).at(-1)?.history || [];
  // 即时执行器：这件事在做的那一轮（在跑的那轮，或者结果落在它起止时间里的、已经收掉的那一轮）。
  if (t.status === 'running' && runNow.running_since) out.push(...history(`run-now:${runNow.running_since}`).map(h => stepOf(h, who, BEAT_TOOL['run-now'])));
  else if (done_at) {
    const f = (beats.finished || []).filter(x => x.executor === 'run-now' && Date.parse(x.task) <= Date.parse(done_at) + 1000 && Date.parse(done_at) <= Date.parse(x.finished_at) + 120000).at(-1);
    if (f) out.push(...f.history.map(h => stepOf(h, who, BEAT_TOOL['run-now'])));
  }
  // 自动投递：每一条线索自己的心跳（#27 填表 → 停在终审）。
  for (const n of numbers) out.push(...history(`auto-apply:${n}`).map(h => stepOf(h, 'quill', BEAT_TOOL['auto-apply'], `#${n} `)));
  out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  // 最后一步：执行器交的结果（bin/job.mjs）。
  if (job?.status === 'waiting_user' && job.waiting_user) out.push({ who, tool: null, text: `停下来问你：${cut(job.waiting_user, 60)}`, at: job.updated_at || null, status: 'waiting_user', evidence: [] });
  if (job?.status === 'blocked') out.push({ who, tool: null, text: `卡住了：${cut(errorReason(job.blocked_reason || job.result), 60)}`, at: job.updated_at || null, status: 'blocked', evidence: [] });
  if (job?.status === 'completed' && job.result) out.push({ who, tool: null, text: `做完：${cut(String(job.result).split('\n')[0], 60)}`, at: job.completed_at || null, status: 'done', evidence: [] });
  return out.slice(-12);
}
// 截图和证据：执行器交的 evidence、写回的话带的、心跳里写到的 runs/ 下的文件。
const evidenceOf = (...xs) => [...new Set(xs.flat().filter(Boolean).map(String).filter(p => /^runs\//.test(p)))].slice(0, 8);
// 对话里的一件事在账上的那一行（lib/jobs.mjs）：挂着它的卡（交办任务、运行、排队）那件活；没挂卡的运行、排队是 op:<id> / queue:<id> 那件活；
// 有任务板以前的交办任务是 hostjob:<id>。小条的状态只从这一行来，不再从交办任务、即时执行器队列、操作记录各推一遍。
const CHIP = { queued: 'queued', running: 'running', waiting_you: 'needs_you', done: 'done', failed: 'stuck', cancelled: 'withdrawn' };
function ledgerOf({ job = null, op = null, card_id = null, message_id = null, session_id = null }, cards) {
  const c = cards.find(c => (card_id && c.id === card_id) || (message_id && c.from?.message_id === message_id && c.from?.session_id === session_id)
    || (job && (c.links?.job_id === job.id || c.links?.old_job_id === job.id || c.id === job.moved_to_card)) || (op && (c.links?.op_id === op.id || c.links?.queue_id === op.id)));
  if (c) return { card: c, j: jobOfCard(c) };
  const q = op?.queued ? queueRecord(op.id) : null;
  return { card: null, j: op ? byRef(`queue:${op.id}`) || byRef(`op:${op.id}`) || (q?.op_id ? byRef(`op:${q.op_id}`) : null) : job ? byRef(`hostjob:${job.id}`) : null };
}
function fromLedger(t, j, card, { reply = null, ask = () => null } = {}) {
  const v = card ? overlay(card, j) : view(j);
  Object.assign(t, { status: CHIP[v.state], state: v.state, word: v.word, tone: v.tone, reason: v.reason, updated_at: (controlled(card) ? card.updated_at : j.updated_at) || t.updated_at, ...(card ? { task: card.id, persona: memberId(card.owner) || card.owner || t.persona } : {}) });
  if (v.state === 'done') { t.result = reply?.content || (controlled(card) ? card.result : j.result?.summary) || null; t.evidence = reply?.evidence || null; }
  if (v.state === 'failed' || v.state === 'waiting_you') t.detail = v.reason || '';
  if (v.state === 'waiting_you') t.ask = ask(j.what?.ask_id) || null;
  if (v.state === 'running') t.since = j.started_at || t.since;
}
// asks：收件箱的信（数组，或者用到时才算的函数——算一次收件箱要几百毫秒，只有卡片要「需要你」时才算）。
export function sessionTasks(s, { runNow = {}, jobs = [], ops = {}, asks = [], beats = {}, now = Date.now(), index = null, env = null } = {}) {
  const out = {};
  if (!s?.messages?.length) return out;
  const allAsks = typeof asks === 'function' ? asks : () => asks;
  const byThread = new Map(jobs.filter(j => j.thread?.message_id).map(j => [j.thread.message_id, j]));
  const kinds = new Map(jobs.map(j => [j.id, j.kind])), kindOf = a => askKind(a, { jobKind: id => kinds.get(id) });
  const compact = a => a ? askOut(a, kindOf(a)) : null;
  let cards = null; const cardsNow = () => (cards ??= readCards());
  let writer = null; // Writer 的活（体检、改一句、改一版）：在做 → 做完，结果看 lib/resume-talk.mjs 记下的和 doc.proposals
  for (const m of s.messages) {
    if (m.kind === 'writer') { const t = writerTask(m, s, { results: (writer ??= writerResults()), now }); if (t) out[t.id] = t; continue; }
    const handoff = m.handoff?.dispatched ? m.handoff : null, command = m.kind === 'receipt' ? m.command : null;
    const mid = handoff?.message_id || command?.message_id || null, op = command?.op || null;
    if (!mid && !op) continue;
    const job = mid ? byThread.get(mid) || null : null;
    const t = { id: mid || `op:${op.id}`, anchor: m.id, kind: handoff ? 'handoff' : op ? 'op' : 'command', persona: (job && memberOfJob(job)) || memberId(m.persona) || m.persona || s.persona || 'system', title: handoff ? handoff.text : op ? op.label : `${command.label}${(m.leads || []).length ? ' ' + m.leads.map(r => '#' + r.number).join(' ') : ''}`, since: m.at, updated_at: m.at, status: 'queued', detail: '', result: null, evidence: null, evidence_files: [], steps: [], fire_at: null, attempts: 0, behind: false, can_withdraw: false, ask: null, answer: null, reply_id: null, leads: m.leads || [] };
    const askById = id => (id ? compact(allAsks().find(a => a.id === id)) : null) || (job ? compact(jobAsks(job, allAsks())[0]) : null);
    if (op) {
      const { card, j } = ledgerOf({ op }, cardsNow());
      if (j) fromLedger(t, j, card, { ask: askById });
      if (t.status === 'queued' && op.queued) { const ahead = queuedItems().findIndex(x => x.id === op.id); t.can_withdraw = ahead >= 0; t.hold = ahead > 0 ? `前面还有 ${ahead} 个` : null; }
      out[t.id] = t; continue;
    }
    // 队列里认这件事：带着这个会话消息的那一条，或者点名了它宿主任务的那一条（你答完之后续跑的请求只带任务 id）。
    const mine = r => r.thread?.message_id === mid || (!!job && (r.job_ids || []).includes(job.id));
    const own = find(runNow.reasons, mid), queued = (runNow.reasons || []).find(mine) || null, running = runNow.running ? (runNow.queue || []).find(mine) || null : null, failed = find(runNow.failed, mid);
    // 你在「需要你」里答过（收件箱、指挥台或这张卡片上）：执行器带着这句接着做，卡片上写出来。
    const said = (job?.user_feedback || []).at(-1)?.text;
    if (said) t.answer = cut(said, 80);
    const reply = [...s.messages].reverse().find(x => x.role === 'executor' && x.reply_key === mid) || null;
    if (reply) t.reply_id = reply.id;
    if (job?.record_id && index?.get(job.number)) t.leads = [rowOf(index.get(job.number))];
    const { card, j } = ledgerOf({ job, card_id: m.card, message_id: mid, session_id: s.id }, cardsNow());
    const answer = card?.says?.filter(x => x.by === 'you').at(-1)?.text;
    if (answer) t.answer = cut(answer, 80);
    if (j) fromLedger(t, j, card, { reply, ask: askById });
    else if (handoff?.withdrawn_at) { t.status = 'withdrawn'; t.updated_at = handoff.withdrawn_at; }
    else if (!job && reply) { t.status = 'done'; t.result = reply.content; t.evidence = reply.evidence || null; t.updated_at = reply.at; }
    // 还没记账（刚交出去，排队循环几秒内补上卡和账）：排队中。
    if (t.status === 'queued') {
      const engine = !!card && !card.links?.job_id;
      t.can_withdraw = !!handoff && (engine ? j?.state === 'queued' && !controlled(card) : !!find(runNow.reasons, mid));
      if (env) { const h = engine ? { text: waitNote(overlay(card, j), env) } : holdOf({ executor: true }, env); t.hold = h?.text || null; if (h?.go) t.hold_go = h.go; }
    }
    // 投了之后：表填好停在终审、要你登录……那几行上出来的「需要你」就是这件事的结果。
    if (command?.kind === 'queue_apply' && t.status === 'done') {
      const a = leadAsks((m.leads || []).map(r => r.rid), allAsks(), kindOf)[0];
      if (a) { t.status = 'needs_you'; t.ask = compact(a); t.detail = a.question || ''; }
    }
    // 谁在做什么：心跳一步步的进展 + 执行器交的结果。投递的按每一条线索看自动投递自己的心跳。
    const numbers = command?.kind === 'queue_apply' ? (m.leads || []).map(r => r.number) : [];
    t.steps = beatSteps(t, { beats, runNow, job, numbers, done_at: ['done', 'needs_you', 'stuck'].includes(t.status) ? (job?.completed_at || job?.updated_at || reply?.at || t.updated_at) : null });
    t.evidence_files = evidenceOf(t.evidence, reply?.evidence, t.steps.map(x => x.evidence));
    out[t.id] = t;
  }
  // 小标的词和色调（lib/status.mjs）：账上那一行给的就用它；还没记账、或者上面按收件箱改成了等你的，照现在的状态码给。页面不自己换算。
  for (const t of Object.values(out)) if (!t.word || t.state !== fromLegacy(t.status)) Object.assign(t, chipOf({ status: t.status }));
  return out;
}

// ── 面板要的全部状态 ─────────────────────────────────────────────────────────
// 会话里提到的编号（#12）是哪一行：页面把它们画成链接（查看 #12）。
function mentioned(s, tasks = {}, index) {
  const refs = {}, add = text => { for (const m of String(text || '').matchAll(/#(\d{1,6})(?!\d)/g)) { const l = index.get(Number(m[1])); if (l) refs[m[1]] = rowOf(l); } };
  for (const m of s?.messages || []) { add(m.content); add(m.detail); for (const r of [...(m.leads || []), ...(m.links || [])]) if (r.number != null) refs[r.number] = { number: r.number, rid: r.rid, company: r.company || '', role: r.role || '' }; }
  for (const t of Object.values(tasks)) { add(t.result); add(t.detail); add(t.title); for (const x of t.steps || []) add(x.text); }
  return refs;
}
// 你在对话里说过话没有（F6：「比如 …」只在第一次、还没说过一句时出现）：最近一天的会话里有就够了，没有再一个个翻 state/chat/，翻到一句就停。
export function saidBefore(recent = []) {
  const yours = s => (s?.messages || []).some(m => m.role === 'user');
  if (recent.some(yours)) return true;
  const dir = file(CHAT_DIR);
  if (!fs.existsSync(dir)) return false;
  for (const n of fs.readdirSync(dir)) { if (!/^[a-z0-9]{8,32}\.json$/.test(n)) continue; try { if (yours(read(`${CHAT_DIR}/${n}`, null))) return true; } catch {} } /* 兜底：这份会话文件读不了：当没说过，接着看下一份 */
  return false;
}
// inbox：返回 inboxView() 的函数（「需要你」的信；任务卡上就地回答用同一封），只在有卡片要它时才调。
export function talkState({ session_id = null, member = null, now = Date.now(), inbox = () => ({}), leads = null, workers = undefined } = {}) {
  if (session_id && !validId(session_id)) throw Error('无效的会话 id');
  const index = leadIndex(leads);
  let asks = null;
  const ctx = { env: { sandbox: sandboxed(), workers, executorPaused: agentPaused('executor') }, runNow: read(RUN_NOW, {}), jobs: lastRev(cachedLines('state/host-jobs.ndjson')), ops: read('state/ops.json', {}), beats: read(BEATS, { tasks: {} }), asks: () => (asks ??= (typeof inbox === 'function' ? inbox() : inbox)?.asks || []), now, index };
  const recent = recentSessions({ now });
  const session = companyReplies(pickSession({ session_id, member: threadOf(member), recent, now }));
  const pool = new Map(recent.map(s => [s.id, s])); if (session) pool.set(session.id, session);
  let tasks = {};
  const working = [], landed = [], searches = new Set();
  for (const s of pool.values()) {
    for (const m of s.messages || []) {
      const r = searchReceipt(m);
      if (!r?.job_id || searches.has(r.job_id) || !['queued', 'running'].includes(r.status)) continue;
      searches.add(r.job_id);
      working.push({ session_id: s.id, member: null, id: r.job_id, anchor: m.id, title: `找 ${r.company} 的在招岗位`, persona: 'scout', status: r.status, step: r.content });
    }
    const ts = sessionTasks(s, ctx);
    if (s.id === session?.id) tasks = ts;
    for (const t of Object.values(ts)) {
      if (['queued', 'running'].includes(t.status)) working.push({ session_id: s.id, member: s.member || null, id: t.id, anchor: t.anchor, title: cut(t.title, 60), persona: t.persona, status: t.status, step: t.steps.at(-1)?.text || null });
      else if (['done', 'needs_you', 'stuck'].includes(t.status) && now - Date.parse(t.updated_at || 0) < WATCH_MS) landed.push({ key: `task:${t.id}:${t.status}`, kind: t.status, session_id: s.id, member: s.member || null, anchor: t.anchor, persona: t.persona, at: t.updated_at, title: cut(t.title, 60) });
    }
    // 已经并进任务卡的回报（web/talk.js 不单独画它）只报一次，就是上面那张卡的「做完」。
    const folded = new Set(Object.values(ts).filter(t => t.status === 'done' && t.reply_id && t.result).map(t => t.reply_id));
    for (const m of s.messages || []) if (m.role === 'executor' && !folded.has(m.id) && now - Date.parse(m.at || 0) < WATCH_MS) landed.push({ key: `reply:${m.id}`, kind: 'reply', session_id: s.id, member: s.member || null, anchor: m.id, persona: m.persona || 'system', at: m.at, text: cut(m.content, 80) });
  }
  landed.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const model = modelState({ now });
  const cards = session ? sessionCards(session, { ...ctx, model }) : {};
  // 交给团队的事：任务卡上带着它那张卡的 id（「在任务板上看这件事」）。
  for (const t of Object.values(tasks)) { const c = Object.values(cards).find(x => x.from?.message_id === t.id); if (c) t.card = c.id; }
  // 标题给显示用的（lib/chat-title.mjs shownTitle）：老会话的网址标题改写，收录对上了换成公司和职位。
  const shown = session ? { ...session, title: shownTitle(session) } : null;
  return { members: members(), talkable: TALKABLE, session: shown, member: session?.member || threadOf(member), tasks, cards, refs: mentioned(session, tasks, index), active: working.length, working, landed: landed.slice(-30), sandbox: sandboxed(), model, recent_ms: RECENT_MS, said: saidBefore(recent) };
}

// ── 撤回：还在排队（60 秒去抖里、执行器没拉起）的「交给团队」可以撤 ────────────────
// 只动两处，在同一把状态锁里、同步写完：即时执行器队列里拿掉这一条，宿主任务记为放弃（和收件箱「放弃这项任务」同一个状态）。
// 已经开始做的撤不回来；指令（投、发……）不在这里撤——它们的决定已经记下了，要反悔用「N 不发」「pass N」这些指令。
export async function withdrawTask({ session_id, message_id, now = Date.now() } = {}) {
  const s = loadSession(String(session_id || ''));
  // 「运行 X」排着等的那一项（opTask 的 op:<排队 id>）：撤回 = 从队列里拿掉，什么都不跑。
  const qm = /^op:(q-.+)$/.exec(String(message_id || ''));
  if (qm) {
    if (!s.messages.some(x => x.kind === 'receipt' && x.command?.op?.queued && x.command.op.id === qm[1])) throw Error('这个对话里没有这件事');
    if (!cancelQueued(qm[1], { now, by: 'talk' })) throw Error('已经开始跑了，撤不回来了');
    return { session: s, withdrawn: true };
  }
  const m = s.messages.find(x => x.handoff?.dispatched && x.handoff.message_id === message_id);
  if (!m) throw Error('这个对话里没有这件事');
  if (m.handoff.withdrawn_at) return { session: s, withdrawn: true };
  const card = readCards().find(c => c.id === m.card || (c.from?.message_id === message_id && c.from?.session_id === s.id));
  if (card && !card.links?.job_id) {
    if (card.status !== 'cancelled') {
      if (jobOfCard(card)?.state !== 'queued' || controlled(card)) throw Error('已经开始做了，撤不回来了');
      controlCard(card.id, { action: 'cancelled', now });
    }
    m.handoff.withdrawn_at = iso(now); s.updated_at = iso(now); saveSession(s);
    return { session: s, withdrawn: true };
  }
  const rn = read(RUN_NOW, {});
  if (rn.running && find(rn.queue, message_id)) throw Error('已经开始做了，撤不回来了');
  if (!find(rn.reasons, message_id)) throw Error('它已经不在队列里了，撤不回来了');
  const jobs = lines('state/host-jobs.ndjson'), j = jobs.findLast(x => x.thread?.message_id === message_id);
  if (j && j.status !== 'pending') throw Error('已经接手了，撤不回来了');
  if (j) { Object.assign(j, { status: 'dropped', dropped_at: iso(now), dropped_by: 'talk', previous_status: 'pending', updated_at: iso(now) }); writeLines('state/host-jobs.ndjson', jobs); }
  const reasons = (rn.reasons || []).filter(r => r.thread?.message_id !== message_id);
  write(RUN_NOW, { ...rn, reasons, pending: reasons.length ? !!rn.pending : false });
  m.handoff.withdrawn_at = iso(now);
  s.updated_at = iso(now);
  saveSession(s);
  return { session: s, withdrawn: true };
}

// ── 空着的时候给的例子（原来在指挥台指令栏，web/hq.js）：两条推荐的新线索、一条资深岗、一家新公司 ──
const primaryLabel = a => (a?.options || []).find(o => ['投递', '联系', '跟进一次'].includes(o.label))?.label || null;
const cutRole = r => { const t = String(r || '').trim(); return t.length > 24 ? t.slice(0, 23) + '…' : t; };
export function talkExamples(view = {}) {
  const rows = view.rows || [], asks = view.asks || {};
  const verb = a => a?.kind === 'apply' ? '批准投递' : primaryLabel(a) === '投递' ? '投' : primaryLabel(a) === '跟进一次' ? '跟进' : '联系';
  const fresh = rows.filter(r => ['triage', 'apply'].includes(r.pipe_kind) && r.number != null && r.verdict === 'recommend' && verb(asks[r.pipe]) !== '联系').sort((a, b) => b.number - a.number);
  // 只看岗位名里的资深字样（理由里提到职级的不算）。
  const senior = rows.find(r => r.pipe_kind === 'triage' && r.number != null && /资深|高级|\bSenior\b|\bStaff\b|\bPrincipal\b/i.test(String(r.role || '')));
  const co = rows.find(r => r.tab === 'new' && !coTbd(r.company))?.company;
  // 编号后面带上是哪一条（10-01：「投 481 480」让人看不懂）；公司或岗位名缺了就不给这一条。括号里的注认指令时会去掉（lib/commands.mjs）。
  const named = r => r && r.company && r.role && !coTbd(r.company) ? `${r.number}（${r.company} · ${cutRole(r.role)}）` : null;
  const apply = named(fresh[0]), pass = named(senior);
  return ['现在怎么样了，我该做什么？', apply ? `投 ${apply}` : null, pass ? `pass ${pass}太资深` : null, co ? `扫一下 ${co}` : null].filter(Boolean);
}
