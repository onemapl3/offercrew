import { taskReceipt, receiptWords } from './task-receipt.mjs';
import { taskChoices, controlled, BOARD_CONTROLS } from './task-control.mjs';
import { interventionOf } from './intervention.mjs';
import { prepTaskResult, briefForLead, findLead } from './company-brief.mjs';
// 任务卡片（L 线 10-03，design/handoff/L-任务卡片-接口.md 第二节）：任务页里一件活的一张卡，和任务目录上那一行多出来的几个字段。
// 全是读的时候算（syncTasks 推好的卡 + 收件箱里现在的信），不存、不调模型。卡片从上到下：
//   标题加状态 → 字段（要做成什么、要求、岗位、派给）→ 接下来（等你的那一句和按钮 / 没做成的原因 / 在做、排队的那一句，之后几步一行）
//   → 子任务（路线，每步带状态）→ 做了什么（lib/task-migrate.mjs historyOf）→ 底（从哪来、看运行日志）。
// 「等你」和收件箱里的信是同一封（ask_id）：卡片上答了，收件箱那封自己消失。
import { coName } from './vocab.mjs';
import { read } from './store.mjs';
import { crewName, crewOf, kindLabel, KINDS } from './crew.mjs';
import { DO, restartable, routineSendReason, legacyResourceWait } from './card-ops.mjs';
import { overlay, jobOfCard } from './task-ledger.mjs';
import { taskFailure } from './task-failure.mjs';
import { currentOwner, assignOf, sixOf, headline, stuckText } from './cards.mjs';
import { STATE, chipOf } from './status.mjs';
import { autoSubmitOn } from './apply-channel.mjs';
import { SWITCH_GO } from './capabilities.mjs';
import { taskStatus, shownCard, failingCard, taskTries, MAX_TRIES, topCard } from './task-chat.mjs';
import { historyOf } from './task-migrate.mjs';
import { plainText, plainIds, cleanLinks, cleanUrl, leadWord } from './plain-words.mjs';
import { writerChain } from './task-writer.mjs';
import { writerTask, writerTries, MAX_TRIES as WRITER_TRIES } from './resume-talk.mjs';
import { tailEvents } from './events.mjs';
import { href } from './routes.mjs';

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const sessionOf = id => /^[a-z0-9]{8,32}$/.test(String(id || '')) ? read(`state/chat/${id}.json`, null) : null;
const st6 = c => { const { status, state, word, tone } = taskStatus(c); return { status, state, word, tone }; };
export const leadTag = l => l ? `#${l.number ?? '—'} ${coName(l.company)}`.trim() : null;

// ── 从哪来 ──────────────────────────────────────────────────────────────────
// chat：普通聊天里说的（from.session_id，点得回去）· page：岗位页 · inbox：收件箱里答了一封信 · cycle：定时周期、System 排的修复 · you：任务页上新建的。
export function originBy(c, jobs = []) {
  const f = c?.from || {};
  if (f.via === 'page') return 'page';
  if (f.session_id && f.via !== 'tasks') return 'chat';
  if (c?.links?.job_id && jobs.find(j => j.id === c.links.job_id)?.source === 'inbox') return 'inbox';
  if (f.by === 'cycle' || f.by === 'repair' || c?.routine) return 'cycle';
  return 'you';
}
const ORIGIN_LABEL = { page: '岗位页', inbox: '收件箱', cycle: '定时周期', you: '你新建的' };
function originOf(c, jobs) {
  const by = originBy(c, jobs), f = c.from || {};
  if (by !== 'chat') return { by, label: f.by === 'repair' ? `${crewName('patch')} 排的修复` : ORIGIN_LABEL[by] };
  return { by, label: sessionOf(f.session_id)?.title || '对话', session_id: f.session_id, ...(f.message_id ? { message_id: f.message_id } : {}) };
}

// ── 任务目录上那一行多的字段 ────────────────────────────────────────────────────
// status 换成六态（排队连待认领），原来的七种留在 raw_status；need：等你时的那一句。
export function rowFields(c, { jobs = [], all = [] } = {}) {
  const st = st6(c), who = currentOwner(c), label = leadWord(c.leads?.[0]), p = t => (t ? plainText(t, { label, nameOf: crewName }) : t);
  return {
    ...c, ...st, title: p(c.title), short: p(c.short), detail: p(c.detail), result: p(c.result), reason: p(c.reason), wait_note: p(c.wait_note), need_title: p(c.need_title), ...(c.what ? { what: { ...c.what, label: p(c.what.label) } } : {}), raw_status: c.status, owner_name: who ? crewName(who) : null, lead_tag: leadTag(c.leads?.[0]),
    need: st.status === 'needs_you' ? cut(plainText((c.halt && !c.halt.answered ? c.halt.question : null) || c.need_title || c.detail, { nameOf: crewName }), 60) || null : null,
    origin_by: originBy(c, jobs), board: boardOf(c, all),
  };
}

// 同一份约束给拖拽、键盘菜单和 POST 用。恢复安排先看真实执行记录，不拿手动“完成”当外发回执，
// 也不把已结束的发送重新开一遍。这里只读，真正开工仍走已有 run / retry / resume-prefill。
const executionCard = c => controlled(c) ? overlay({ ...c, ...c.owner_control.previous, owner_control: null }) : c;
export function boardStart(c, all = []) {
  if (!c || c.legacy || c.links?.ledger_id) return { reason: '这是一条执行记录，打开任务查看下一步' };
  const actual = executionCard(c);
  const blocked = routineSendReason(actual);
  if (blocked) return { reason: blocked };
  if (actual.kind === 'goal') {
    if (actual.halt && !actual.halt.answered) return { reason: actual.halt.question || '先回答这件任务的问题' };
    const child = (actual.route || []).filter(s => s.state !== 'skip').map(s => all.find(x => x.id === s.card)).find(x => x && !['done', 'cancelled'].includes(sixOf(executionCard(x).status)));
    return child ? boardStart(child, all) : { reason: '打开任务，查看当前步骤' };
  }
  const state = sixOf(actual.status), plan = action => ({ task_id: actual.id, action });
  if (actual.mac_hold) return plan('release');
  if (state === 'running') return plan('existing');
  if (state === 'needs_you') return actual.resume_prefill ? plan('resume-prefill') : { reason: actual.detail || actual.need_title || '先打开任务，处理它正在等的信息' };
  if (!actual.owner) return { reason: '先打开任务，派给一位成员' };
  if (['done', 'cancelled'].includes(state)) {
    // 明确拖回进行中可以重新跑阅读/写材料等内部工作；发出或申请的旧回执不能当成新一轮批准。
    return !['send', 'apply'].includes(actual.kind) && restartable(actual) ? plan('retry') : { reason: '这次执行已经结束；重新做请新建任务' };
  }
  if (state === 'stuck') {
    const attempts = actual.links?.writer ? writerBits(actual).failed : taskTries(actual) + 1;
    if (!legacyResourceWait(actual) && attempts >= (actual.links?.writer ? WRITER_TRIES : MAX_TRIES)) return { reason: `已经连着 ${attempts} 次没做成，先看看原因` };
    return actual.links?.writer || actual.kind === 'apply' || restartable(actual) ? plan('retry') : { reason: '打开任务，按失败原因继续处理' };
  }
  if (actual.links?.job_id) return { reason: '这件任务已交到后台，打开任务查看领取情况' };
  if (actual.links?.op_id || actual.links?.queue_id || actual.links?.do_at || actual.links?.apply_at) return plan('existing');
  if (KINDS[actual.kind]?.op || ['prep', 'apply', 'send'].includes(actual.kind) || DO.has(actual.kind)) return plan('run');
  return { reason: '打开任务，完成当前步骤后继续' };
}
export function boardOf(c, all = []) {
  const start = boardStart(c, all), column = st6(c).state;
  const labels = { queued: '待做', running: '进行中', waiting_you: '等你', done: '完成', failed: '没做成', cancelled: '不做了' };
  return { column, moves: Object.entries(labels).map(([key, label]) => {
    const reason = key === column ? '任务已在这一列' : key === 'waiting_you' ? '需要你补充信息或确认时，任务会出现在这里' : key === 'failed' ? '执行失败时，任务会出现在这里' : key === 'running' ? start.reason : null;
    return { column: key, label, disabled: !!reason, ...(reason ? { reason: plainText(receiptWords(reason), { nameOf: crewName }) } : {}), ...(BOARD_CONTROLS[key] ? { control: BOARD_CONTROLS[key] } : {}) };
  }) };
}

// ── Writer 的活：它在那段对话里先问的那一问、最后那条 ─────────────────────────────────
function writerBits(card) {
  const s = sessionOf(card.session_id), chain = s ? writerChain(s, card.links.writer, card.links.writer_next) : [];
  const ask = chain.filter(m => ['ask', 'letter_ask'].includes(m.writer?.kind)).at(-1) || null, t = ask ? writerTask(ask, s) : null;
  const answered = !!t && (t.buttons || []).some(b => b.kind === 'resume_answers' && b.used);
  const last = chain.at(-1) || null;
  return { s, ask: t?.questions?.length ? t : null, answered, last, failed: last ? writerTries(last, s).failed : 0 };
}

// 完成卡交付已存在的产物；旧记录只读补入口，不把“做完了”文字当作版本或报告证明。
function completedOutputs(card, w) {
  if (card.status !== 'done' || card.manual || controlled(card)) return card.outputs || [];
  if (card.outputs?.length) return card.outputs;
  if (card.links?.op === 'linkedin-inbox') {
    const job = jobOfCard(card);
    return job?.state === 'done' && ['mail', 'linkedin-inbox'].includes(job.kind) && Array.isArray(job.result?.links) && job.result.links.some(l => l?.href === '#inbox')
      ? [{ label: '查看收件箱', href: '#inbox' }] : [];
  }
  if (w?.last) {
    const result = writerTask(w.last, w.s);
    if (result?.status !== 'done' || result.bad) return [];
    return (result.buttons || []).filter(b => b.kind === 'resume_open' && b.href).map(b => ({ label: result.card ? `查看改稿${result.card.version ? ` · ${result.card.version}` : ''}` : '查看成果', href: b.href }));
  }
  if (card.kind !== 'research') return [];
  const job = jobOfCard(card), rid = card.leads?.[0]?.rid || card.leads?.[0]?.record_id;
  const lead = rid && findLead(rid);
  if (!lead || job?.state !== 'done' || job.kind !== 'research' || job.target !== `lead:${rid}`) return [];
  const brief = briefForLead(lead);
  if (brief?.status !== 'ready') return [];
  const at = Date.parse(brief.updated_at), same = brief.summary?.text === card.answer?.text && at >= Date.parse(job.started_at) && at <= Date.parse(job.finished_at);
  return [{ label: same ? '查看公司调研' : '查看当前公司调研', href: href.lead(rid, { tab: 'co' }) }];
}

// ── 之后几步（「你终审 → Reacher 提交 → Watcher 等回信」）────────────────────────────────
// 每类活的几步；at：这一棒现在走到第几步。目标卡把路线上剩下的几棒接上，最后一棒按它这类活展开。
const step = (who, text) => ({ who, text });
function seqOf(kind, owner) {
  const me = owner || null;
  if (kind === 'apply') return autoSubmitOn() ? [step('quill', '填表'), step('you', '终审'), step('quill', '提交'), step('owl', '等回信')] : [step('quill', '预填申请表'), step('you', '终审并提交'), step('owl', '等回信')];
  if (kind === 'resume' || kind === 'tailor') return [step('you', '答几个问题'), step('tailor', '改写'), step('you', '看改稿')];
  if (kind === 'letters') return [step('you', '答几个问题'), step('tailor', '写信'), step('you', '看信')];
  if (kind === 'draft') return [step('quill', '写消息'), step('you', '等你批准'), step('quill', '发出')];
  if (kind === 'send') return [step('you', '等你批准'), step('quill', '发出')];
  return [step(me, kindLabel(kind) || '做这件事')];
}
const NOT_ASKED = { mail: '接上邮箱', local_ai: '打开本机 AI' };
function seqFrom(card, { asked = false } = {}) {
  const seq = seqOf(card.kind, card.owner), s = sixOf(card.status);
  if (s === 'done' || s === 'cancelled') return [];
  if (['resume', 'tailor', 'letters'].includes(card.kind)) return seq.slice(s === 'needs_you' && asked ? 0 : 1);
  if (s === 'needs_you' && card.wait === 'login') return [step('you', '登录'), ...seq]; // 先登录，登好了这一棒从头接着走
  // 等的不是一个问题，是你去接上一样东西（邮箱、本机 AI 开关）：这一格写那件事，不写「回答」。
  if (s === 'needs_you' && NOT_ASKED[card.wait]) return [step('you', NOT_ASKED[card.wait]), ...seq];
  if (s === 'needs_you') { const i = seq.findIndex(x => x.who === 'you'); return i >= 0 ? seq.slice(i) : [step('you', '回答'), ...seq]; }
  return seq;
}
function thenOf(top, shown, all, w) {
  if (['done', 'cancelled'].includes(sixOf(shown.status))) return [];
  if (top.kind !== 'goal') return seqFrom(shown, { asked: !!w?.ask && !w.answered });
  const out = [];
  if (top.halt && !top.halt.answered) out.push(step('you', '回答'));
  const rest = (shown.route || []).filter(s => s.state !== 'skip' && s.state !== 'done' && s.status !== 'done');
  rest.forEach((s, i) => {
    const k = s.card && all.find(c => c.id === s.card);
    if (i === rest.length - 1) out.push(...(k ? seqFrom(k) : seqOf(s.kind, s.owner)));
    else out.push(step(s.owner, kindLabel(s.kind)));
  });
  return out.filter((x, i) => !i || x.who !== out[i - 1].who || x.text !== out[i - 1].text);
}

// ── 接下来 ──────────────────────────────────────────────────────────────────
const KIND_OF = { needs_you: 'you', stuck: 'bad', running: 'run', queued: 'queued', done: 'done', cancelled: 'done' };
// 标题分类与回答入口必须读同一个正在等人的步骤（含目标卡下面的子任务）。
function waitingOf(top, shown, all, asks) {
  const halt = top.kind === 'goal' && top.halt && !top.halt.answered;
  const waiting = top.kind === 'goal' ? all.find(c => c.id === shown.waiting_card) || (shown.route || []).map(s => all.find(c => c.id === s.card)).find(c => c && !['done', 'cancelled'].includes(c.status)) || top : top;
  const askId = halt ? `goal:${top.id}` : waiting.links?.ask_id || null;
  const ask = (askId && asks?.find(a => a.id === askId)) || (waiting.ask?.id === askId ? waiting.ask : null);
  return { halt, waiting, askId, ask };
}

function nextOf(top, shown, all, { asks = null, w = null } = {}) {
  const st = sixOf(shown.status), who = currentOwner(shown), name = who ? crewName(who) : '团队', then = thenOf(top, shown, all, w);
  const open = top.kind === 'goal' ? (shown.route || []).map(s => s.card && all.find(c => c.id === s.card)).filter(Boolean).find(c => !['done', 'cancelled'].includes(c.status)) || null : top;
  const out = (text, buttons = []) => ({ text: cut(text, 300), kind: KIND_OF[st], buttons, then });
  if (controlled(top)) return { ...out(top.owner_control.note), then:[] };
  if (top.links?.ledger_id) {
    const r = taskReceipt(top);
    return out(r.next || r.reason || r.summary || shown.detail, (r.links || []).map(l => ({
      act: 'open', label: l.href?.startsWith('#talk') ? '补充招聘页链接' : /^https?:/.test(l.href || '') ? '打开招聘页' : l.label,
      // 补链按会话续办；裸 #talk 既不会打开面板，也不能从另一段对话回到原请求。
      href: l.href === '#talk' && top.from?.session_id ? href.talk({ session: top.from.session_id, m: top.from.message_id }) : l.href,
    })));
  }
  const blocked = routineSendReason(shown);
  if (blocked && ['stuck', 'queued', 'needs_you'].includes(st)) {
    const failure = st === 'stuck' ? { ...taskFailure(top.id, all).why, impact: '这条记录不会作为新的发送任务执行。', remedy: blocked } : null;
    return { ...out([failure?.reason, blocked].filter(Boolean).join('；'), [{ act: 'open', label: '打开收件箱', href: href.inbox() }]), then: [], ...(failure ? { failure } : {}) };
  }
  if (st === 'needs_you') {
    const { halt, waiting, askId, ask } = waitingOf(top, shown, all, asks);
    const buttons = [];
    if (waiting?.resume_prefill) return { ...out(`等你：${waiting.detail}`, [{ act: 'resume_prefill', task_id: waiting.id, label: '继续预填' }]), then: [step('quill', '使用已存答案继续预填'), step('you', '检查后亲自提交'), step('owl', '等回信')] };
    if (askId) buttons.push({ act: 'answer', ask_id: askId, ...(halt ? { options: (top.halt.options || []).map((o, i) => ({ key: String(i + 1), label: o })) } : ask?.options?.length ? { options: ask.options.filter(o => o.steps?.length || !o.href).map(o => ({ key: o.key, label: o.label })) } : {}), ...(ask?.questions ? { questions: ask.questions } : {}) });
    for (const o of ask?.options || []) if (o.href && !o.steps?.length) buttons.push({ act: 'open', label: o.label, href: o.href });
    // 在对话里起的 Writer 的活：问题就在发起它的那段对话里，点了回到那一条。
    if (!askId && top.links?.writer && w?.s && !w.s.origin) buttons.push({ act: 'open', label: '在对话里答', href: `#talk?session=${w.s.id}${w.ask ? `&m=${w.ask.anchor}` : ''}` });
    // 要动电脑、本机 AI 没打开（lib/task-do.mjs）：一个直达开关的按钮；打开以后同步时自己接着做。
    // 跑完了、可这一轮缺一样东西（Watcher 没读信：邮箱还没接上）：卡上一个直达的入口（lib/tasks.mjs 推的 go）。
    if (!askId && waiting?.go?.href) buttons.push({ act: 'open', label: waiting.go.label, href: waiting.go.href });
    if (!askId && waiting?.wait === 'model' && !buttons.some(b => b.href === '#settings/model')) buttons.push({ act: 'open', label: '设置模型', href: '#settings/model' });
    if (!askId && waiting?.wait_code === 'model_credentials') buttons.push({ act: 'retry', label: '更新配置后继续' });
    if (!askId && waiting?.wait === 'local_ai') buttons.push({ act: 'open', label: '打开本机 AI', href: SWITCH_GO }, { act: 'withdraw' });
    // 没有收件箱或对话入口的旧等待卡，也能在这里收掉；不能只有一句「等你」而无可做的事。
    if (!askId && !top.legacy && !buttons.some(b => b.act === 'withdraw')) buttons.push({ act: 'withdraw' });
    const q = halt ? top.halt.question : waiting?.detail || shown.detail || ask?.question || waiting?.need_title || shown.need_title || '';
    const questions = ask?.questions || (w?.ask && !w.answered ? w.ask.questions : null);
    return { ...out(`等你：${q}`, buttons), ...(questions?.length ? { questions } : {}) };
  }
  if (st === 'stuck') {
    const bad = failingCard(top, all);
    const spent = top.links?.writer ? (w?.failed || 0) >= WRITER_TRIES : !legacyResourceWait(bad) && taskTries(bad) + 1 >= MAX_TRIES; // 和「再试一次」的核对同一个数（lib/task-api.mjs checkMove）
    // 没有能用的模型（lib/task-do.mjs wait: model）：先给配模型的地方，再试一次照旧。
    return { ...out(stuckText(bad, bad.detail || shown.detail, { spent }), [...(bad.wait === 'model' ? [{ act: 'open', label: '设置模型', href: '#settings/model' }] : []), { act: 'why' }, { act: 'retry', ...(spent ? { disabled: true } : {}) }]), failure: taskFailure(top.id, all).why };
  }
  // System 照标准做法放回去再试一次的（lib/system/playbook.mjs P3）：写明是它放回去的，免得以为还停在上一次的「没做成」。
  const again = (open || shown)?.retry?.by === 'patch' ? `${crewName('patch')} 放回去再试一次` : null;
  if (st === 'running') { const d = open?.detail || '', t = d ? `${name}：${d}` : `${name} 在${kindLabel(open?.kind || top.kind)}`; return { ...out(again ? `${again}：${t}` : t, [{ act: 'withdraw' }]), ...(again ? { again: true } : {}) }; }
  if (st === 'queued') { const note = open?.wait_note || shown.wait_note; return { ...out(again ? (note && !/马上开始/.test(note) ? `${again}，${note}` : again) : note || `排队中：等 ${name} 接手`, [{ act: 'withdraw' }]), ...(again ? { again: true } : {}) }; }
  if (st === 'cancelled') return out(STATE.cancelled.word);
  return out(prepTaskResult(shown) || '做完了', (shown.outputs || []).filter(x => x.href).map(x => ({ act: 'open', label: x.label, href: x.href })));
}

// ── 子任务 ──────────────────────────────────────────────────────────────────
const sub = (kind, label, owner, status, detail = null, card = null, src = null) => ({ kind, label, owner: owner || null, status, ...chipOf(src && sixOf(src.status) === status ? src : { status }), detail: detail ? cut(detail, 140) : null, card });
// card：这一步自己的卡 id（点了打开它的卡片）；路线上还没开出来的一棒是 null。你加的子任务（parent_task）接在后面，各带自己的状态。
function routeOf(top, shown, all, w) {
  return [...ownRoute(top, shown, all, w), ...all.filter(c => c.parent_task === top.id).sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0)).map(c => {
    const x = shownCard(c, all), st = sixOf(x.status);
    return sub(c.kind, headline(c.title), currentOwner(x), st, st === 'done' ? prepTaskResult(x) : st === 'queued' ? x.wait_note : x.detail, c.id, x);
  })];
}
function ownRoute(top, shown, all, w) {
  if (top.kind === 'goal') return (shown.route || []).filter(s => s.state !== 'skip').map(s => {
    const k = s.card && all.find(c => c.id === s.card), st = k ? sixOf(k.status) : s.state === 'done' ? 'done' : 'queued';
    return sub(s.kind, kindLabel(s.kind), s.owner, st, k ? (k.status === 'done' ? prepTaskResult(k) : k.status === 'queued' ? k.wait_note : k.detail) : null, k?.id || null, k || null);
  });
  const st = sixOf(shown.status), label = top.kind === 'ask' ? cut(top.title, 40) : kindLabel(top.kind);
  // Writer 先问了几句：先问是一步，改写 / 写信是一步。
  if (w?.ask) return [sub('ask', '先问你几句', 'tailor', w.answered ? 'done' : st === 'cancelled' ? 'cancelled' : 'needs_you', null, top.id), sub(top.kind, top.kind === 'letters' ? '写信' : '改写', 'tailor', w.answered ? st : st === 'cancelled' ? 'cancelled' : 'queued', w.answered ? shown.result || shown.detail : null, top.id)];
  return [sub(top.kind, label, currentOwner(top), st, st === 'done' ? prepTaskResult(shown) : st === 'queued' ? shown.wait_note : shown.detail, top.id, shown)];
}

// 子任务的卡片能点回上一级（parent_task，lib/task-say.mjs addSubtask）。
function parentOf(top, all) { const p = top.parent_task && all.find(c => c.id === top.parent_task); return p ? { id: p.id, title: headline(p.title) } : null; }
// 卡片上的输入框（第四节）：撤回的、旧记录不给；提示照状态写。
const SAY_HINT = { queued: '开始时照这句做…', running: '给这件活下指令…', needs_you: '直接回答它…', done: '接着做…', stuck: '照这句再做一次…', cancelled: '' };
// 等你接邮箱、打开本机 AI 的卡没有要回答的问题：输入框就是平常的下指令。
const sayOf = (shown, top) => { const st = sixOf(shown.status), on = st !== 'cancelled' && !top.legacy, plain = st === 'needs_you' && NOT_ASKED[shown.wait]; return { enabled: on, placeholder: on ? SAY_HINT[plain ? 'running' : st] : '' }; };
// 一张卡片。id 可以是子卡：给它最上面那张（目标卡一件活一张卡片）。all：syncTasks 推好的卡（加上旧记录）；asks：收件箱里现在的信；jobs：交办任务。
// 卡片上给人看的字：接下来那一句、子任务的说明、模型写的结果里的链接（标题、要求、做了什么在 lib/tasks.mjs plainCard、task-migrate 里已经换过）。
const plain = t => (t == null ? t : plainText(receiptWords(t), { nameOf: crewName }));
function plainView(v) {
  const label = leadWord(v.lead);
  for (const f of ['title', 'requirement']) if (v[f]) v[f] = plainText(v[f], { label, nameOf: crewName });
  if (v.next?.failure) v.next.failure = { ...v.next.failure, reason: receiptWords(v.next.failure.reason) };
  if (v.next?.text) v.next = { ...v.next, text: plain(v.next.text) };
  v.history = (v.history || []).map(s => ({...s, text:receiptWords(s.text)}));
  v.route = (v.route || []).map(s => ({ ...s, label: plain(s.label), detail: plain(s.detail) }));
  if (v.answer?.text) v.answer = { ...v.answer, text: plainIds(cleanLinks(v.answer.text), crewName) };
  if (v.proof?.url) v.proof = { ...v.proof, url: cleanUrl(v.proof.url) };
  if (v.parent?.title) v.parent = { ...v.parent, title: plain(v.parent.title) };
  return v;
}
function taskLog(top, shown, events) {
  const links = { ...top.links, ...shown.links }, l = top.leads?.[0];
  const history_href = l?.rid ? href.lead(l.rid, { tab: 'prog' }) : null;
  const run = links.cycle_run || links.run_id || (links.op_id ? `ops-${links.op_id}` : null);
  if (run) return { href: href.stream({ run }), history_href };
  for (const [key, id] of [['job', links.job_id], ['action', links.action_id], ['task', shown.id], ['task', top.id]]) {
    if (id && events.some(e => e[`${key}_id`] === id)) return { href: href.stream({ [key]: id }), history_href };
  }
  return { href: null, note: '当前保留的日志里没有找到这件任务的关联记录。', history_href };
}
export const cardView = (id, o = {}) => plainView(cardOf(id, o));
function cardOf(id, { all = [], asks = null, jobs = [], events = tailEvents(5000) } = {}) {
  const c0 = all.find(x => x.id === id);
  if (!c0) throw Object.assign(Error('没有这件事'), { status: 404 });
  const top = topCard(c0, all), shown = shownCard(top, all), w = top.links?.writer ? writerBits(top) : null;
  const delivered = { ...shown, outputs: completedOutputs(shown, w) };
  const who = currentOwner(shown), l = top.leads?.[0];
  const waiting = waitingOf(top, shown, all, asks);
  const question = waiting.ask || (waiting.halt ? { type: 'decide' } : { questions: w?.ask && !w.answered ? w.ask.questions : null });
  const kindWord = top.kind === 'goal' ? String(top.title || '').split(' ')[0] || '目标' : kindLabel(top.kind);
  return {
    id: top.id, kind: top.kind, kind_label: kindWord,
    title: top.title, requirement: top.requirement || null,
    lead: l ? { number: l.number ?? null, company: coName(l.company), role: l.role || '', rid: l.rid || null } : null,
    owner: who ? { id: who, name: crewName(who) } : null,
    receipt_only: !!top.links?.ledger_id,
    assign: top.links?.ledger_id ? { fixed:true, owner:{id:'scout',name:crewName('scout')} } : assignOf(top),
    ...st6(shown),
    next: nextOf(top, delivered, all, { asks, w }),
    controls: taskChoices(top),
    board: boardOf(top, all),
    intervention: shown.status === 'needs_you' ? interventionOf(question, waiting.waiting) : null,
    // 引擎自己用模型做的结果（lib/task-do.mjs）：正文和照什么做的。
    answer: (shown.answer || top.answer) ? { text: (shown.answer || top.answer).text, basis: (shown.answer || top.answer).basis || [], at: (shown.answer || top.answer).at || null, by: (shown.answer || top.answer).by || null } : null,
    route: routeOf(top, shown, all, w),
    receipt: taskReceipt(delivered, events),
    history: historyOf(top, { all, asks, jobs }),
    origin: originOf(top, jobs),
    parent: parentOf(top, all),
    say: top.links?.ledger_id ? {enabled:false,placeholder:''} : sayOf(shown, top),
    // 投递停下来的那一页（lib/tasks.mjs deriveCard 推的 proof）：截图、地址、停在哪一步、原始的码。
    proof: shown.proof || top.proof || null,
    log: taskLog(top, shown, events),
    updated_at: shown.updated_at || top.updated_at || null,
  };
}
