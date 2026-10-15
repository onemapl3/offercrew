import { ownerState, controlled } from './task-control.mjs';
// 任务卡本身（第 4 步收口，按卡的一生分层：这一层最底下）：卡存在哪、怎么读写、长什么样、卡上一步步记了什么、从旧记录认回来的卡。
// 不开工、不推状态、不叫成员：那些在上面几层（lib/card-ops.mjs 建卡挪卡答卡，各成员的活 task-do / task-say / task-migrate…，lib/tasks.mjs 推状态、开工）。
// 各成员的活引这一层，不引 lib/tasks.mjs，免得 tasks ↔ 成员的活成环。
import { coName, leadByUrl as urlLead } from './vocab.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { autoSubmitOn } from './apply-channel.mjs';
import { KINDS, CREW_IDS, crewOf, crewName, memberOfJob, JOB_CARD_KIND, kindLabel, isMember } from './crew.mjs';
import * as J from './jobs.mjs';
import { appliedLead } from './lead-state.mjs';
import { lock } from './lock.mjs';
import { needShort } from './needs.mjs';
import { shortTitle, textWidth } from './short-title.mjs';
import { file, lines } from './store.mjs';
import { syncCardJobs, overlay } from './task-ledger.mjs';

export const byRef = J.byRef;

export const TASKS_PATH = 'state/tasks.ndjson';
export const STATUSES = ['unclaimed', 'queued', 'running', 'needs_you', 'stuck', 'done', 'cancelled'];
export const FROM_BY = ['you', 'team', 'member', 'cycle', 'repair'];
// 六态（任务卡片，L 线 10-03，design/handoff/L-任务卡片-接口.md 第一节第 2 条）：任务目录、卡片、对话里的小条都用这一个换算。
// 排队（排队、待认领）· 在做 · 等你 · 做完 · 没做成（卡住了）· 撤回（取消）。排队不算在做；以前 T2 的四态（排队算在做）作废。
export const TASK_STATUS = { queued: 'queued', unclaimed: 'queued', running: 'running', needs_you: 'needs_you', done: 'done', stuck: 'stuck', cancelled: 'cancelled' };
export const SIX = ['queued', 'running', 'needs_you', 'done', 'stuck', 'cancelled'];
export const sixOf = st => TASK_STATUS[st] || 'queued';
export const TERMINAL = new Set(['done', 'cancelled']);
export const iso = t => new Date(t).toISOString();
export const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const newId = (prefix = 't') => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
export const T = x => Date.parse(x || '') || 0;
export { coName }; // 公司名清洗只在 lib/vocab.mjs 一处
// 投递前停下来问你的那一句：哪一条、在哪，确认以后会发生什么（和「投 N」的确认框说的一样）。
export const applyQuestion = l => `要投 ${l?.number != null ? `#${l.number} ` : ''}${[coName(l?.company), l?.role].filter(Boolean).join(' · ')}${l?.location && !/^(?:未标注|未知)$/.test(l.location) ? `（${l.location}）` : ''} 吗？确认以后${autoSubmitOn() ? '系统填好表停在提交前，等你终审' : '系统预填好认得出的项，停在提交前，你在页面上检查后自己提交'}。`;

// ── 存取 ─────────────────────────────────────────────────────────────────────
// 读的时候跳过写了一半的那一行（别的进程正在追加），不报错。
export const cardRows = () => { let t = ''; try { t = fs.readFileSync(file(TASKS_PATH), 'utf8'); } catch { return []; } const out = []; for (const s of t.split('\n')) { if (!s) continue; try { out.push(JSON.parse(s)); } catch {} } return out; };
export const readCards = () => lastRev(cardRows()).map(ownerState);
// 存卡不拿锁、不等（工作台进程里不许 Atomics.wait，契约 2.7）：tasks.ndjson 本来就是「同一个 id 以最后一行为准」，
// 存几张卡就是在文件末尾追加这几行（一次 append 写完）。压掉旧版本（compactCards）只在工作台启动时、还没起任何子进程之前做：
// 追加的人不拿锁，压缩「读完 → 写新文件 → 改名」中间有人追加就会丢那一行，所以不在有人写的时候压。
// 改交办任务（host-jobs.ndjson）不拿全局锁（第 2 步·锁退役）：经 lib/store.mjs writeLines 写，别的进程同时改了会合并。
// 工作台启动时调（bin/serve.mjs，起任何子进程之前）。旧版本不到一半就不压。
export function compactCards() {
  let release;
  try { release = lock('tasks'); } catch { return; }
  try {
    const rows = cardRows(), all = lastRev(rows);
    if (rows.length < 2 * Math.max(50, all.length)) return;
    // 万一这时有别的进程（命令行）追加了（文件变长了）：这次不压。
    const size = fs.statSync(file(TASKS_PATH)).size, tmp = file(`${TASKS_PATH}.tmp`);
    fs.writeFileSync(tmp, all.map(c => JSON.stringify(c)).join('\n') + '\n');
    if (fs.statSync(file(TASKS_PATH)).size === size) fs.renameSync(tmp, file(TASKS_PATH)); else fs.unlinkSync(tmp);
  } finally { release(); }
}
// 存几张卡：按 id 追加新版本。
export function saveCards(list) {
  if (!list.length) return;
  const rows = cardRows(), prevOf = new Map(rows.map(c => [c.id, c]));
  // 这件活的对话（session_id、parent_task，lib/task-chat.mjs）只增不减：同步时手上那份是旧的也不把它冲掉。
  const out = list.map(c => { let x = { ...c }; const prev = prevOf.get(c.id); if (prev?.owner_control && (prev.owner_control.rev || 0) >= (x.owner_control?.rev || 0)) { x.owner_control = prev.owner_control; const history = new Map([...(prev.steps || []), ...(x.steps || [])].map(s => [`${s.at}:${s.text}`, s])); x.steps = [...history.values()].sort((a,b)=>String(a.at).localeCompare(String(b.at))).slice(-40); } x = ownerState(x); for (const k of ['session_id', 'parent_task']) if (prev?.[k] && !x[k]) x[k] = prev[k]; return x; });
  fs.mkdirSync(file('state'), { recursive: true });
  fs.appendFileSync(file(TASKS_PATH), out.map(c => JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>!DERIVED_ONLY.includes(k))))).join('\n') + '\n');
  syncCardJobs(out); // 卡上的状态记进账（带着只算不存的 need_title，等你的那件事写得出来）（lib/task-ledger.mjs）：页面只读账
}
// 只在读的时候算、不存的字段。
export const DERIVED_ONLY = ['proof', 'go', 'ask', 'legacy', 'children', 'wait_note', 'handoff_text', 'owner_name', 'lead_rows', 'short', 'need_title', 'run_steps', 'used_model', 'login_label', 'resume_prefill'];
// 卡上那一行（短标题）：标题本来就短就是它；执行器的长指令、带代号的说法推一句人话（lib/short-title.mjs）。全文在详情里。
export const headline = t => { const s = String(t ?? '').trim(); return textWidth(s) <= 24 && !/[a-z][a-z0-9]*[-_][a-z0-9]/.test(s) ? s : shortTitle(s, { max: 22 }) || s; };

// ── 开一张卡 ──────────────────────────────────────────────────────────────────
// 负责人：给了就是它（null = 待认领）；没给按类型（KINDS 的 member）。做法（how）按类型，没有类型就是手动。
export const leadTag = l => l ? `#${l.number ?? '—'} ${coName(l.company)}` : '';
export const leadRef = l => l ? { rid: l.record_id || l.id || l.rid, number: l.number ?? null, company: coName(l.company) || '', role: l.role || '' } : null;
export function makeCard({ kind = null, title = '', leads = [], owner, from = { by: 'you' }, goal = null, route = null, how = null, links = {}, handoff = null, status = null, auto = false, url = null, email = null, note = '', now = Date.now() } = {}) {
  const k = KINDS[kind] ? kind : kind === 'goal' ? 'goal' : null;
  const who = owner !== undefined ? (owner === 'team' ? 'team' : crewOf(owner)) : (k && k !== 'goal' ? KINDS[k].member : null);
  const at = iso(now);
  const card = {
    id: k === 'goal' ? newId('goal') : newId('t'), kind: k || 'ask', title: cut(title || [leadTag(leads[0]), kindLabel(k)].filter(Boolean).join(' · ') || '新卡片', 120),
    leads: leads.filter(Boolean).map(leadRef), owner: who || null, from, goal, ...(route ? { route } : {}),
    status: status || (who ? 'queued' : 'unclaimed'), how: how || (k === 'goal' ? 'manual' : KINDS[k]?.how || 'manual'),
    links: { ...links }, ...(handoff ? { handoff } : {}), items: [], steps: [], result: null, next: [],
    created_at: at, claimed_at: who ? at : null, started_at: null, updated_at: at, done_at: null, cost: null,
    ...(auto ? { auto: true } : {}), ...(url ? { url } : {}), ...(email ? { email } : {}), ...(note ? { note } : {}),
  };
  if (who && who !== 'team') card.steps.push({ at, who, text: `${crewName(who)} 认领了` });
  return card;
}
// ── 手机上开的卡：会拉起执行器、会开浏览器的那几类，回电脑确认了才跑（负责人 09-30）──────────
// 没被允许交给执行器的手机（设备 hand_off: false）照样能开卡；卡上这类一棒记 mac_hold，引擎不开跑，
// 直到你在电脑上点「在这台电脑上运行」（POST /api/tasks/<id>/release，手机网关不放行）。from.mac_confirm 顺着目标往下传：
// 后面接力开出来的卡也一样停。收录（add-lead 可能要用浏览器打开页面）、找内推（浏览器）、填表（自动投递）、执行器的几类。
export const MAC_RUNS = { intake: '打开链接收录岗位', referrers: '用浏览器找内推人', apply: '用浏览器打开申请页填表' };
export function macRunLabel(kind) {
  const k = KINDS[kind];
  if (!k) return null;
  if (MAC_RUNS[kind]) return MAC_RUNS[kind];
  // 写谁来做（「Judge · 公司调研」），不写「交给执行器」（第 2 轮新 38）。
  return k.how === 'executor' || k.how === 'browser' ? (k.member && crewName(k.member) ? `${crewName(k.member)} · ${k.label}` : k.label) : null;
}
// 按 from（mac_confirm、device）给这张卡记上 mac_hold；不是这几类就不动。
export function holdOnMac(card, from = card.from, now = Date.now()) {
  const label = from?.mac_confirm ? macRunLabel(card.kind) : null;
  if (label) card.mac_hold = { label, at: iso(now), ...(from.device ? { device: from.device } : {}) };
  return card;
}
export const macFrom = f => (f?.mac_confirm ? { via: 'phone', mac_confirm: true, ...(f.device ? { device: f.device } : {}) } : {});
export const addStep = (c, text, { who = c.owner, at = Date.now(), tool = null, evidence = [] } = {}) => { c.steps = [...(c.steps || []), { at: iso(at), who, text, ...(tool ? { tool } : {}), evidence }].slice(-40); c.updated_at = iso(at); return c; };
export const JOB_STATUS = { pending: 'queued', working: 'running', waiting_user: 'needs_you', blocked: 'stuck', completed: 'done', done: 'done', dropped: 'cancelled' };
export const leadOf = (ctx, ref) => { if (!ref) return null; const rid = ref.rid || ref.record_id; return ctx.leads.find(l => (rid && (l.record_id === rid || l.id === rid)) || (!rid && ref.number != null && l.number === ref.number)) || null; };
export const leadByUrl = (ctx, url) => urlLead(ctx.leads, url); // 链接找线索只有一种写法（lib/vocab.mjs）
export const applied = l => !!l && (appliedLead(l) || !!l.applied_at);
// 这条岗位投过没有：线索上记着投了，或者账上这条线索的提交做完了（lib/actions.mjs submit，target lead:<rid>）。
export const appliedBefore = (ctx, ref) => {
  const l = leadOf(ctx, ref), rid = l ? (l.record_id || l.id) : ref?.rid || ref?.record_id || null;
  return applied(l) || !!(rid && J.latest({ target: `lead:${rid}`, kind: 'submit', state: 'done' }));
};
export const closed = l => !!l && (l.posting_closed === true || l.closed === true || !!l.closed_at);
// 路线上「改成先判断」：判断那一棒变成真的一张卡；后面已经开出来、还没开跑的那张先取消。
// 「改成先判断」还来得及吗：判断那一棒跳过了，而且它后面没有一棒开始做（卡都还排着、没跑脚本、没开始填表）。
// 来不及了就不给这个按钮（页面上不留一个点了只会报错的按钮）；judgeFirst 照样再查一遍。
export function canJudgeFirst(g, kids = []) {
  const i = (g.route || []).findIndex(s => s.kind === 'judge');
  if (i < 0 || g.route[i].state !== 'skip') return false;
  const after = g.route.slice(i + 1);
  if (after.some(s => s.state === 'done')) return false;
  return !after.some(s => { const c = s.card && kids.find(k => k.id === s.card); return c && (c.status !== 'queued' || c.links?.op_id || c.links?.apply_at); });
}
// 目标卡：由它下面的卡推出来。任意一张等你就是等你；卡住同理；路线上每一棒都做完（或跳过）就是完成。
export function deriveGoal(goal, children) {
  const g = { ...goal, route: (goal.route || []).map(s => ({ ...s })) };
  if (controlled(g)) return ownerState(g);
  if (g.status === 'cancelled') return g;
  const kids = children.filter(c => c.goal === g.id);
  for (const s of g.route) { const k = s.card && kids.find(c => c.id === s.card); if (k) { s.status = k.status; if (k.mac_hold && k.status === 'queued') s.mac_hold = k.mac_hold.label; } }
  g.can_judge_first = canJudgeFirst(g, kids);
  if (g.halt && !g.halt.answered) { g.status = 'needs_you'; g.detail = g.halt.question; return g; }
  const any = st => kids.some(c => c.status === st);
  const allDone = g.route.every(s => s.state === 'skip' || s.state === 'done' || (s.card && kids.find(c => c.id === s.card)?.status === 'done'));
  if (allDone && g.route.length) {
    g.status = 'done';
    const done = kids.filter(c => c.status === 'done'), start = T(g.created_at), end = Math.max(...done.map(c => T(c.done_at || c.updated_at)), start);
    g.result = `${done.length} 张卡，用时 ${Math.max(1, Math.round((end - start) / 60000))} 分钟`; g.done_at = g.done_at || iso(end);
  } else {
    // 开了头的目标（有一棒做完了、或者有一棒开着）在两棒之间也是「进行中」，不是回到「排队中」：账上 running 回不到 queued（转移表），
    // 以前每个目标接力时都报一次「想从 running 改成 queued，走不到」（线 F，10-04）。
    const begun = g.route.some(s => s.state === 'done' || (s.card && kids.some(c => c.id === s.card && !['queued', 'unclaimed'].includes(c.status))));
    g.status = any('needs_you') ? 'needs_you' : any('stuck') ? 'stuck' : any('running') || begun ? 'running' : 'queued';
  }
  const waiting = kids.find(c => c.status === 'needs_you');
  if (waiting) { g.detail = waiting.detail; g.ask = waiting.ask || null; g.waiting_card = waiting.id; }
  return g;
}

// 一件活现在由谁做：单卡是它的主人；目标卡是路线上开着的那一棒的主人（都没开就是下一棒，都做完了是最后一棒）。
export function currentOwner(card) {
  if (card?.kind !== 'goal') return card?.owner && card.owner !== 'team' ? card.owner : null;
  const r = (card.route || []).filter(s => s.state !== 'skip');
  return (r.find(s => s.state === 'open') || r.find(s => s.state === 'planned') || r.at(-1))?.owner || null;
}
// 派给谁（接口第一节第 4 条）：只列能做这类活的成员（KINDS 的 member）。每类活只有一位能做：直接写名字、不能换（fixed）。
// 只有「你交代的事」（kind ask）不限人：列全部六位，System 建议的那位（suggested，建卡时按 lib/talk-route.mjs routePersona 定）预先选上。
// 目标卡由路线上的各位接着做，也不能换。
export function assignOf(c) {
  if (c?.kind !== 'ask') { const who = currentOwner(c) || KINDS[c?.kind]?.member || null; return { fixed: true, owner: who ? { id: who, name: crewName(who) } : null }; }
  return { fixed: false, options: CREW_IDS.map(id => ({ id, name: crewName(id) })), suggested: c.suggested || (isMember(c.owner) ? c.owner : null) };
}
// 等你的那一行（syncTasks 进等你时记进步骤；lib/task-migrate.mjs historyOf 认它，不再拼收件箱的原话）。
export const waitLine = c => `等你：${cut(c.detail || c.need_title || '要你看一下', 80)}`;
// 这件再试过：System 照标准做法放回去的（card.retry，lib/system/playbook.mjs P3），或者你点过「再试一次」（你放回排队的那一行）。
export const retried = c => c?.retry?.by === 'patch' || (c?.steps || []).some(s => s.who === 'you' && /放回排队/.test(String(s.text || '')));
// 没做成的那一句：原因里自己已经说了没成（「没改成：网络不通」「Writer 这次没写成：…」「上次没做完」），就不再在前面加一个「没做成：」。
export const badText = (detail, head = '没做成') => { const d = String(detail || '').trim(), lead = d.split(/[：:]/)[0]; return d && /没.{0,3}[成完]|卡住|失败/.test(lead) ? d : `${head}：${d || '这次没有留下失败原因，可以再试一次；仍失败就联系支持'}`; };
// 没做成的那一句，再试过的说「又没…」（第 6 轮开箱 11：失败卡一边写没做成、一边写放回排队，看不出是在重试还是停了）。
// spent：能不能再试（undefined 不说）。
export function stuckText(c, detail, { spent } = {}) {
  let t = badText(detail);
  if (!retried(c)) return t;
  const lead = t.split(/[：:]/)[0];
  t = /没/.test(lead) ? t.replace(/没/, '又没') : `又没做成：${t}`;
  if (spent === true) return `${t.replace(/[，,]?\s*可以再试一次$/, '')}，先看看原因`;
  if (spent === false && !/再试/.test(t)) return `${t}，可以再试一次`;
  return t;
}
// 接力那一行的头：两棒是两位，写「Radar → Writer」；同一位接着做（找内推 → 预填申请表都是 Reacher），写两步的名字。
export const relayHead = (a, b) => a.owner === b.owner ? `${kindLabel(a.kind)} → ${kindLabel(b.kind)}` : `${crewName(a.owner)} → ${crewName(b.owner)}`;
export const relayGist = (c, lead) => c.kind === 'intake' ? `${lead?.number != null ? `#${lead.number} ` : ''}收好了，还在招` : cut(c.result || '做完了', 40).replace(/[。.]$/, '');
// 任务页上「+ 新建」（接口第二节 POST /api/tasks { text, owner?, lead? }）：说一句话，System 按规则建议由谁做——
// planTalk 认得的（投、联系、调研、怎么准备、收录）照它的路线开，和对话里说的一样；投递那一棒不替你批准：先停下来问你
// （和接力到投递时同一句，答「确认，开始预填」才开卡）。认不出的是「你交代的事」（kind ask）：建议的人照 routePersona（suggest 传进来），
// 给了 owner 就用它（只能是六位里的）。lead：岗位那一条（leads.ndjson 的行）。→ 最上面那张卡（目标或单卡）
// 话里的「#N」对上库里的哪一条（没有就是 null）。
export function leadInText(text) {
  const m = /#\s?(\d{1,6})(?!\d)/.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return lines('state/leads.ndjson').filter(l => !l.superseded && l.number === n).at(-1) || null;
}

// ── 交办任务 → 卡：标题、来源 ─────────────────────────────────────────────────
// 任务板上线的时候（2026-09-30 凌晨）。这之前建的交办任务是旧记录（只读）；之后建的没卡就补一张真卡。
export const BOARD_SINCE = '2026-09-29T18:00:00.000Z';
export const AUTO_REPAIRED = /（[^（）]{1,24}自动修复：无人点击/;
// 一条交办任务给人看的标题：有编号「#N 公司 · 这类事」，公司调研「公司 · 公司调研」，其余从它的说明推一句（不露代号）。
export function jobTitle(j = {}) {
  // 交办任务按它自己的种类说（准备投递材料、核实联系入口……），投递按卡的说法（跟着自动提交开关：预填申请表 / 填表并提交）。
  const k = JOB_CARD_KIND[j.kind], what = (j.kind === 'queue_auto_apply' ? kindLabel(k) : JOB_KIND[j.kind]) || kindLabel(k) || '交办的事', co = coName(j.company);
  if (j.kind === 'system_fix') return headline(j.details || j.target?.label) || what;
  if (j.number != null) return `#${j.number} ${co} · ${what}`.replace(/\s+·/, ' ·');
  if (co && k && j.kind !== 'user_request') return `${co} · ${what}`;
  const said = j.title || j.details;
  return (said && headline(said)) || JOB_KIND[j.kind] || what;
}
// 这件事是谁起的头：System 自动排的修复是 System，不是你；你批准的投递、你在对话 / 收件箱 / 指挥台交代的是你；其余是定时周期。
export function jobFrom(j = {}) {
  // 修复：你在指挥台 / 收件箱点了「交给 System 修」的是你；自动修复排入的、System 自己开的（source: system）是 System。
  if (j.kind === 'system_fix') return !AUTO_REPAIRED.test(j.details || '') && ['dashboard', 'inbox', 'talk'].includes(j.source) ? { by: 'you' } : { by: 'repair', member: 'patch' };
  if (j.kind === 'queue_auto_apply' || j.kind === 'user_request' || j.thread?.message_id || ['dashboard', 'inbox', 'room', 'talk'].includes(j.source)) return { by: 'you', ...(j.thread?.session_id ? { session_id: j.thread.session_id, message_id: j.thread.message_id || null } : {}) };
  return { by: 'cycle' };
}
// 投递卡（目标路线上的那一棒）开跑时会发「投 N」，由此建出来的投递任务就是这张卡本身，不再另开一张。
export const APPLY_JOBS = new Set(['queue_auto_apply', 'prepare_application_packet', 'sync_application_review']);
export const coveredJob = (j, cards) => APPLY_JOBS.has(j.kind) && cards.some(c => c.kind === 'apply' && c.links?.apply_at && c.status !== 'cancelled' && (c.leads || []).some(l => (j.record_id && l.rid === j.record_id) || (j.number != null && l.number === j.number)) && T(c.links.apply_at) <= T(j.created_at) + 60000);
export const isOld = j => !j.created_at || T(j.created_at) < T(BOARD_SINCE);
export const legacyJob = id => { try { return byRef(`hostjob:${id}`); } catch { return null; } };
export function legacyCard(j) {
  return ({
    id: `job:${j.id}`, legacy: true, kind: JOB_CARD_KIND[j.kind] || 'ask', title: cut(jobTitle(j), 120), short: jobTitle(j),
    leads: j.record_id ? [{ rid: j.record_id, number: j.number ?? null, company: coName(j.company) || '', role: j.role || '' }] : [], owner: memberOfJob(j),
    from: jobFrom(j), goal: null, status: JOB_STATUS[j.status] || 'queued', how: 'executor', links: { job_id: j.id },
    items: [], steps: [], result: j.status === 'completed' ? cut(String(j.result || '').split('\n')[0], 140) : null, detail: j.status === 'blocked' ? cut(j.blocked_reason || j.result, 140) : j.status === 'waiting_user' ? cut(typeof j.waiting_user === 'string' ? j.waiting_user : j.waiting_user?.question || '', 400) : '', next: [],
    ...(j.status === 'waiting_user' ? { need_title: (() => { const n = (j.needs || []).find(x => x.kind !== 'login') || (j.needs || [])[0]; return n ? needShort(n) : shortTitle(j.waiting_user, { max: 22, ask: true }) || null; })() } : {}),
    created_at: j.created_at || null, updated_at: j.updated_at || j.completed_at || j.created_at || null, done_at: j.completed_at || null,
  });
}

// ── 旧记录：有任务板之前的交办任务 ─────────────────────────────────────────────
export function legacyCards(jobs, cards) {
  const used = new Set(cards.flatMap(c => [c.links?.job_id, c.links?.old_job_id]).filter(Boolean));
  return jobs.filter(j => j.id && !used.has(j.id) && isOld(j) && !coveredJob(j, cards)).map(j => legacyCard(j)).map(c => overlay(c, legacyJob(c.links.job_id)));
}

export const lastRev = rows => { const m = new Map(); for (const r of rows) m.set(r.id, r); return [...m.values()]; };
export const JOB_KIND = { discover_human_opportunities: '真人帖扫描', system_fix: '系统修复', verify_contact_entry: '核实联系入口', prepare_application_packet: '准备投递材料', queue_auto_apply: '投递', reply_on_thread: '回复对方', user_request: '你交代的事', prepare_followup: '准备跟进', research_interview_dossier: '准备面试资料', prepare_interview: '准备面试', company_brief: '公司调研', role_prep: '写怎么准备', read_forwarded_source: '读你转发的链接', read_incremental: '读新消息', host_cycle_review: '周期复查', sync_application_review: '同步投递审核' };
