// 分派（契约 05 第一节第 6 项，指挥台拆出来的第二块）：你说的一句指令（认法在 lib/intent.mjs）交给对的执行：对外动作走 lib/action-entry.mjs，
// 「运行 <脚本>」走 lib/ops.mjs，反馈、备注、面试时间交给 bin/action.mjs；还有收件箱、任务卡上的那几下：收起一项、交给 System、改宿主任务、补编号。
// domain 层：不引视图（lib/layers.json）。
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { outboundCommand } from './action-entry.mjs';
import { applyFreeze, rememberApplyWish } from './apply-freeze.mjs';
import { localAiGate, SWITCH_GO, whoDoes } from './capabilities.mjs';
import { crewName } from './crew.mjs';
import { event, withEventRun, eventRunId } from './events.mjs';
import { PATH as HEARTBEAT_PATH, clearTask } from './executor-heartbeat.mjs';
import { resolveCommand, followupAsk } from './intent.mjs';
import { draftFollowup } from './followup-draft.mjs';
import * as J from './jobs.mjs';
import { archivedLead } from './lead-state.mjs';
import { QUEUED_LINE } from './op-queue.mjs';
import { OPS } from './ops-table.mjs';
import { busyRetryMs, runOrQueue } from './ops.mjs';
import { sendProposal, applyProposal } from './reacher.mjs';
import { requestRunNow } from './run-now.mjs';
import { execFile } from './spawn.mjs';
import { cachedLines } from './state-cache.mjs';
import { lines, read, write, writeLines, hash, root } from './store.mjs';
import { swallowTo } from './swallow.mjs';
import { topPicks } from './top-picks.mjs';
import { queueEngineTask } from './task-entry.mjs';
import { localToolNeed } from './task-tools.mjs';

const iso = x => new Date(x).toISOString();
const leadKey = l => l.record_id || l.id;
const label = l => `${l.number ?? '待编号'} · ${l.company || '待核'} · ${l.role || ''}`;
const execFileP = promisify(execFile);
// 排查结论包含末尾的用户操作要求，必须保留全文；折叠由界面负责。
export const requiredUserAction = j => {
  for (const value of [j.waiting_user, j.question, j.resume_condition]) { const t = typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.question || value.text || value.message || '') : ''; if (t.trim()) return t.trim(); }
  return String(j.result || j.error || '').match(/(?:需要用户|仍需用户|还需用户|需要你做的事|需要你|请用户)[：:]\s*([\s\S]+)$/)?.[1]?.trim() || '';
};

// ── 归档一项 ───────────────────────────────────────────────────────────────────
// 「需要我做的」里每一项都能手动归档：待办项写进 state/action-overrides.json（archived_at，
// journey 以后不再生成它）；阻塞 / 确认类的行写进 state/dismissed.json（按稳定 key）。
// 整条线索结束用指令「归档 N」（bin/action.mjs）。
export const DISMISSED_PATH = 'state/dismissed.json';
export const dismissKey = b => b.key ? `executor:${b.key}` : b.id ? `job:${b.id}` : b.record_id ? `lead:${b.record_id}:${b.action || 'blocked'}` : `label:${b.label}`;
export async function archiveItem({ action_id = null, key = null, note = '', now = Date.now() } = {}) {
  const at = iso(now), reason = String(note || '').slice(0, 200);
  if (!action_id && !key) throw Error('没有指定要归档的项');
  if (action_id) {
    const os = read('state/action-overrides.json', {});
    os[action_id] = { ...(os[action_id] || {}), archived_at: at, archived_by: 'dashboard', paused: true, ...(reason ? { archive_reason: reason } : {}) };
    write('state/action-overrides.json', os);
  }
  if (key) {
    const d = read(DISMISSED_PATH, {});
    d[key] = { at, by: 'dashboard', ...(reason ? { reason } : {}) };
    write(DISMISSED_PATH, d);
  }
  event('user', 'room', 'ok', `操作台归档一项：${action_id ? 'action ' + action_id.slice(0, 8) : key}${reason ? ' · ' + reason : ''}`);
  return { status: 'archived', receipt: '已归档，这一项不再出现。整条线索要结束的话回「归档 N」。' };
}
export function dismissed() { return read(DISMISSED_PATH, {}); }
export const sameTarget = (t = {}, b = {}) => (t.key && t.key === b.key) || (t.id && t.id === b.id) || (t.record_id && t.record_id === b.record_id && t.source === b.source) || (t.run_id && t.run_id === b.run_id);

// ── 交给 System 修 ─────────────────────────────────────────────────────────────
// 默认开引擎修复卡：先检查恢复规则，再用所选模型解释实际证据。显式 local 才用可选本机工具。
// 同一目标只保留一条未完成的任务；保留旧宿主任务接口供明确开启的自动修复使用。
export async function handToSystem(target = {}, { now = Date.now(), note = '', local = false } = {}) {
  const t = { source: String(target.source || 'blocked'), label: String(target.label || '').slice(0, 200), reason: String(target.reason || '').slice(0, 600), evidence: target.evidence || null, key: target.key || null, id: target.id || null, record_id: target.record_id || null, run_id: target.run_id || null, number: target.number ?? null, company: target.company || null, step: target.step || null, refs: Array.isArray(target.refs) ? target.refs.slice(0, 8) : [] };
  if (!t.label) throw Error('没有要修的东西');
  // 能力表决定引擎或显式选择的本机工具；查询状态不会走这里。
  const who = whoDoes('system_repair', { local });
  if (who.worker === 'engine') {
    const { makeCard, readCards, saveCards } = await import('./cards.mjs');
    const key = hash(['system_fix', t.source, t.key || t.id || t.record_id || t.run_id || t.label]);
    const existing = readCards().find(c => c.repair_key === key && !['done', 'cancelled'].includes(c.status));
    if (existing) return { status: 'already', card_id: existing.id, receipt: `这件事已交给 ${crewName('patch')}，结果在任务里。` };
    const card = makeCard({ kind: 'ask', owner: 'patch', title: `排查：${t.label}`, from: { by: note.includes('无人点击') ? 'repair' : 'you', via: 'system' }, auto: true, now });
    Object.assign(card, { repair_key: key, repair_target: t, requirement: note || null });
    saveCards([card]);
    return { status: 'queued', card_id: card.id, receipt: `已交给 ${crewName('patch')}：先检查引擎恢复规则，再给出排查结果。` };
  }
  if (who.worker !== 'local_ai') { const g = localAiGate(); throw Object.assign(Error(`${crewName('patch')} 现在没法交给本机 AI 修：${g.why || '本机 AI 没打开'}`), { status: 409, fix: { label: '打开本机 AI', href: g.go || SWITCH_GO } }); }
  const id = hash(['system_fix', t.source, t.key || t.id || t.record_id || t.run_id || t.label]);
  let status = 'queued';
  {
    const jobs = lines('state/host-jobs.ndjson');
    const open = jobs.find(j => j.id === id && ['pending', 'working'].includes(j.status));
    if (open) status = 'already';
    else jobs.push({ id, kind: 'system_fix', local_tool: true, details: `${t.label}：${t.reason}${note ? '。用户补充：' + String(note).slice(0, 300) : ''}`, target: t, number: t.number, company: t.company, source: 'dashboard', created_at: iso(now), status: 'pending', thread: { channel: 'web', persona: 'system' } });
    if (status === 'queued') writeLines('state/host-jobs.ndjson', jobs);
  }
  if (status === 'queued') {
    requestRunNow({ reason: `[操作台] 交给 ${crewName('patch')} 修：${t.label.slice(0, 120)}`, job_ids: [id], now });
    event('user', 'room', 'ok', `操作台把「${t.label.slice(0, 80)}」交给 ${crewName('patch')} 处理`, { lead_id: t.record_id || undefined });
  }
  return { status, job_id: id, receipt: status === 'queued' ? `已交给 ${crewName('patch')}：${t.label}。本机 AI 约一分钟后开始，结果会回到这一行。` : `这条已经在 ${crewName('patch')} 的队列里了（${id.slice(0, 8)}）。` };
}
// 后台同步（concierge / pull-feedback）会短暂持有状态写锁；碰上就等一等再试，最多 20 秒。
export async function exec(args, run_id, { retryMs = 20000 } = {}) {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try { return await execFileP(process.execPath, args, { cwd: root, env: { ...process.env, RADAR_RUN_ID: run_id }, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (e) {
      const delay = busyRetryMs(e);
      if (delay == null || Date.now() >= deadline) throw e;
      await new Promise(r => setTimeout(r, Math.min(delay, deadline - Date.now())));
    }
  }
}
// 子进程的报错：去掉堆栈行和 Node 版本尾巴，留下真正的那一句。
export const lastLine = e => busyRetryMs(e) != null ? '后台正在同步岗位状态，暂时无法记录这次操作；已自动等待重试，请稍后重试。' : String(e.stderr || e.message || '').split('\n').map(l => l.trim()).filter(l => l && !/^at\s/.test(l) && !/^Node\.js v/.test(l) && !/^\^+$/.test(l)).map(l => l.replace(/^(\w*Error|throw):?\s*/, '')).filter(Boolean).pop()?.replace(/another_radar_writer_running/, '另一个进程正在写状态，请稍后再试').slice(0, 300) || '这条没能处理，请换一种说法。';
// thread：对话浮层下的指令（lib/talk.mjs）带上会话和消息 id，排给即时执行器时一起交过去，执行器把结果写回这个会话。
// origin：这条指令从哪来（lib/jobs.mjs ORIGINS：inbox / card / chat / phone / schedule / system），对外动作那件活记它。
export const dispatchCommand = (text, options = {}) => withEventRun('action', () => dispatchOne(text, options));
async function dispatchOne(text, { source = 'dashboard', confirm = false, execute = exec, freeform = null, now = Date.now(), lead = null, thread = null, origin = 'chat', job_id = null, writerModel = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 2000) throw Error('请输入一条指令');
  const follow = followupAsk(raw, { number: lead?.number });
  if (follow) return { kind: 'action', verb: 'feedback', input: `${follow} 跟进`, ...await draftFollowup(follow, { now, model: writerModel, origin, instruction: raw }) };
  const messageId = `dashboard-${crypto.randomUUID()}`, run_id = eventRunId();
  let cmd = resolveCommand(raw), routed = null;
  if (cmd.kind === 'freeform' && freeform) {
    routed = await freeform(raw).catch(swallowTo(null, 'command-center.freeform', { doing: '认这句话要做什么', then: '按原话处理' }));
    if (routed?.canonical) cmd = { ...resolveCommand(routed.canonical), routed_from: raw };
    else if (routed?.confirm || routed?.receipt) return { ok: true, kind: 'freeform', verb: routed.verb, receipt: routed.receipt || routed.confirm, confirm_only: !!routed.confirm && !routed.receipt };
  }
  if (cmd.kind === 'ignore') throw Error('这条指令是空的');
  // 「运行 <脚本>」：对话里的角色把脚本当工具用（ACTIONS 里给出，用户点了才跑），走与操作面板相同的 runOp。
  // （认法在 lib/intent.mjs resolveCommand：kind 'op'。）
  // 手上有别的在跑：和成员页按钮一样排到后面（lib/ops.mjs runOrQueue），回执说排上了。
  if (cmd.kind === 'op') {
    const op = cmd.op; if (!OPS[op]) throw Error(`没有叫 ${op} 的脚本；可用：${Object.keys(OPS).join('、')}`);
    const r = runOrQueue(op, { by: 'talk', now });
    if (r.queued) return { ok: true, kind: 'op', verb: op, input: raw, receipt: `「${r.label}」${r.dup ? '已经排着了，' : ''}${QUEUED_LINE}${r.ahead ? `（前面还有 ${r.ahead} 个）` : ''}`, op: { id: r.id, label: r.label, queued: true, dup: !!r.dup, ahead: r.ahead || 0 } };
    if (r.already) return { ok: true, kind: 'op', verb: op, input: raw, receipt: `「${r.label}」正在跑`, already: true, op: { id: r.id, label: r.label } };
    return { ok: true, kind: 'op', verb: op, input: raw, receipt: `已开始「${r.label}」（${OPS[op].desc}），日志 ${r.log}`, op: r };
  }
  // 替本人记完成前先确认：命令、收件箱、任务共用这道门。
  if (!confirm && /^\d+\s*(?:这步好了|准备好了|面试完成|offer|面试\s|暂停提醒)/i.test(cmd.input || raw)) return { ok: true, needs_confirm: true, confirm_text: '确认记下这件事？', preview: { kind: 'record', text: /^\d+\s*这步好了/.test(cmd.input || raw) ? '确认你已在网站上提交？这里只记录本人提交，不会替你点网站的提交。误记可撤回。' : `确认记录：${cmd.input || raw}` } };
  const reply = (extra = {}) => ({ ok: true, kind: cmd.kind, verb: cmd.verb, input: cmd.input || raw, ack: cmd.ack || null, ...extra });
  if (cmd.kind === 'freeform') {
    const c = queueEngineTask({ text: cmd.input || raw, owner: thread?.persona || 'patch', leads: lead ? [lead] : [], from: { by: 'you', via: 'command', ...(thread || {}) }, now });
    return reply({ card_id: c.id, run_now: false, receipt: '已交给团队，结果会回到任务里。' });
  }
  if (cmd.kind === 'brief') { const l = cachedLines('state/leads.ndjson').find(l => l.number === cmd.number && !archivedLead(l)); if (!l) throw Error(`没有编号 ${cmd.number} 这条记录`); return reply({ receipt: `${label(l)} 的详情`, navigate: `#lead/${encodeURIComponent(leadKey(l))}` }); }
  if (cmd.kind === 'top_picks') { const p = topPicks({}); return reply({ receipt: `重点岗位 ${p.rows.length} 个`, data: { top_picks: p.rows } }); }
  if (cmd.kind === 'send_list') { const p = sendProposal({}); return reply({ receipt: `拟发清单 ${p.rows.length} 封`, data: { send_proposal: p.rows } }); }
  if (cmd.kind === 'apply_list') { const p = applyProposal({ leads: cachedLines('state/leads.ndjson') }); return reply({ receipt: `拟投清单 ${p.rows.length} 条`, data: { apply_proposal: p.rows } }); }
  // 投递冻结：「投 N」不排队，只记下编号。
  if (cmd.kind === 'queue_apply') { const fz = applyFreeze(); if (fz) { const nums = cmd.all ? [] : (cmd.numbers || []); const w = nums.length ? rememberApplyWish(nums, { source }) : read('state/apply-freeze-wishlist.json', { numbers: [] }); return reply({ receipt: `投递冻结中（${fz.reason}）。${nums.length ? `已记下要投的编号：${nums.join('、')}（累计 ${w.numbers.length} 条），` : ''}解冻后再排队，不会真的提交。`, data: { frozen: true, wishlist: w.numbers } }); } }
  // 对外动作（投、发、发全部）：一条条走 requestAction（lib/action-entry.mjs），确认、闸、谁来做都在那边；
  // 不再起 bin/queue-apply.mjs、bin/action.mjs 把文字再解析一遍，也不再交给即时执行器（02 W4，01 根 5）。
  if (cmd.kind === 'queue_apply' || cmd.kind === 'send_all' || cmd.verb === 'send') {
    const r = await outboundCommand(cmd, { confirm, origin, now, job_id });
    if (r.needs_confirm) return reply({ needs_confirm: true, confirm_text: raw, preview: r.preview, ...(r.changed ? { changed: r.changed, receipt: r.receipt } : {}) });
    event('user', 'room', r.ok ? 'ok' : 'fail', `操作台指令：${cmd.input || raw}（${String(r.receipt || '').split('\n')[0].slice(0, 80)}）`, { run_id });
    return reply({ ok: r.ok !== false, receipt: r.receipt, confirmed: !!confirm, ...(r.applied ? { applied: r.applied } : {}), ...(r.jobs && Object.keys(r.jobs).length ? { jobs: r.jobs } : {}), ...(r.open ? { open: r.open } : {}), ...(r.navigate ? { navigate: r.navigate } : {}) });
  }
  let receipt = null;
  try {
    if (cmd.input) {
      // 收件箱里对某条线索说的话（「其他」）：交给执行器的任务带上这条线索，收件箱据此知道这一问已经有人在办。
      const about = cmd.kind === 'freeform' && lead?.record_id ? ['--record-id', String(lead.record_id), ...(lead.number != null ? ['--number', String(lead.number)] : [])] : [];
      const out = await execute(['bin/action.mjs', '--input', cmd.input, '--source', source, '--message-id', messageId, ...about], run_id);
      const parsed = JSON.parse(out.stdout);
      receipt = parsed.receipt || null;
      // 「N 准备 / N 面试 … / N 复盘 …」：面试资料由引擎写（lib/interview-dossier.mjs），开一张 Watcher 的卡；不排给本机 AI。
      if (parsed.dossier) try { await (await import('./interview-dossier.mjs')).requestDossier({ record_id: parsed.dossier, via: origin === 'phone' ? 'phone' : 'chat', now }); } catch (e) { event('owl', 'interview', 'fail', `面试资料的卡没开成：${String(e.message || e).slice(0, 120)}`); }
    }
  } catch (e) { return reply({ ok: false, receipt: lastLine(e) }); }
  let queued = false;
  // 交给本机 AI 的只剩「你交代的事」（能力表 user_task 归它时：打开了、条件都满足）；否则不排即时执行器，
  // 记下的反馈由引擎的周期接着做（01 根 2：以前排给关着的本机 AI，没人接）。
  // 「改 N …」：能力表 revise_draft 归引擎（Writer 加模型），马上在后台改，改好的一份进收件箱等你看；不排给本机 AI。
  if (cmd.verb === 'revise' && receipt) startRevise({ now, origin });
  else if (cmd.needs_run_now && whoDoes('user_task').worker === 'local_ai') { requestRunNow({ reason: `[操作台] ${cmd.input || raw}`, now, ...(thread ? { thread } : {}) }); queued = true; }
  event('user', 'room', receipt ? 'ok' : 'waiting_user', `操作台指令：${cmd.input || raw}${queued ? '（已排队给即时执行器）' : ''}`, { run_id });
  // 批准了，却都卡在登录上（一个也没排上）：直接带你到收件箱里那个账号的登录信，不是只弹一句几秒就消失的提示（10-01 开箱测试）。
  return reply({ receipt, run_now: queued });
}

// 改稿那件活：在做 → 改好了（等你看）/ 没改成（原因）。改不了（没有能用的模型）就直接记失败，说清去哪设置。
export function startRevise({ now = Date.now(), origin = 'chat' } = {}) {
  // 记账出错不挡改稿，但照实记一行（不静默吞掉）。
  const ledger = (what, f) => { try { return f(); } catch (e) { event('tailor', 'revise', 'fail', `改稿那件活${what}没记上：${String(e.message || e).slice(0, 120)}`); return null; } };
  const job = ledger('建', () => J.create({ kind: 'revise_draft', member: 'tailor', title: '按你的话改草稿', origin: J.ORIGINS.includes(origin) ? origin : 'chat', now }));
  const drive = (state, data) => job && ledger(state, () => J.drive(job.id, state, data));
  const who = whoDoes('revise_draft');
  if (!who.worker) { drive('failed', { reason: `改不了：${who.reason}` }); return; }
  drive('running', {});
  import('./draft-revise.mjs').then(m => m.reviseNow()).then(r => {
    if (r.revised) drive('done', { result: { summary: `改好了 ${r.revised} 份，等你看`, links: { inbox: '#inbox' } } });
    else drive('failed', { reason: r.failed?.[0]?.reason ? `没改成：${r.failed[0].reason}` : '没改成：这一份已经不在改了' });
  }, e => drive('failed', { reason: `没改成：${String(e.message || e).slice(0, 100)}` }));
}

// ── 操作台：解除阻塞 ──────────────────────────────────────────────────────────
export async function unblockTask(key, { now = Date.now() } = {}) {
  const state = read(HEARTBEAT_PATH, { tasks: {} }), t = state.tasks?.[key];
  if (!t) throw Error('没有这项任务');
  const messageId = `dashboard-${crypto.randomUUID()}`, run_id = eventRunId();
  // 不是可恢复的投递任务：只清掉这条心跳记录，不产生任何外部动作。
  { clearTask({ executor: t.executor, task: t.task }); }
  event('user', 'room', 'ok', `操作台清除执行器记录 ${key}`, { run_id });
  return { status: 'cleared', receipt: `已清除「${t.executor} · ${t.task}」的心跳记录；如果它还有事没做完，会在下一轮重新出现。`, run_now: false };
}
export async function updateHostJob(id, action, { now = Date.now(), note = '', feedbackId = null } = {}) {
  if (!['retry', 'drop', 'feedback', 'resolve'].includes(action)) throw Error('未知操作');
  const feedback = String(note || '').trim();
  if (action === 'feedback' && (!feedback || feedback.length > 5000)) throw Error('请填写反馈内容（1–5000 字）');
  if (feedbackId != null && (typeof feedbackId !== 'string' || !feedbackId || feedbackId.length > 120)) throw Error('反馈标识无效');
  const jobs = lines('state/host-jobs.ndjson'), j = jobs.findLast(j => j.id === id);
  if (!j) throw Error('没有这条宿主任务');
  if (action === 'feedback' && feedbackId && j.user_feedback?.some(f => f.id === feedbackId)) return { status: j.status, run_now: false, duplicate: true, receipt: '这条反馈已保存在原任务中，无需重复提交。' };
  if (action === 'feedback' && j.status === 'working') throw Error('任务正在处理中，请等本轮结束后再补充反馈；输入内容已保留。');
  if (!['blocked', 'waiting_user', 'pending', 'working'].includes(j.status)) throw Error(`任务状态是 ${j.status}，不能改`);
  if (action === 'feedback') {
    j.user_feedback = [...(j.user_feedback || []), { id: feedbackId || crypto.randomUUID(), text: feedback, at: iso(now), source: 'dashboard', question: requiredUserAction(j) }];
    Object.assign(j, { status: 'pending', resumed_at: iso(now), resume_source: 'dashboard_feedback', previous_status: j.status });
    // 答过的事不再挂在跑起来的任务上（执行器读 next_actions 时只看到回答，不再看到「还在等你」）；问过什么留在 answered_needs 和 user_feedback.question 里。
    if (j.needs?.length) j.answered_needs = [...(j.answered_needs || []), ...j.needs.map(n => ({ ...n, answered_at: iso(now) }))].slice(-10);
    j.needs = []; j.waiting_user = null;
  } else if (action === 'retry') Object.assign(j, { status: 'pending', resumed_at: iso(now), resume_source: 'dashboard', previous_status: j.status });
  // 收件箱里你已经用一条指令拍了板（投 / pass / 我登好了……），问题本身就答完了：记为完成，不再让执行器重跑一轮。
  else if (action === 'resolve') Object.assign(j, { status: 'completed', completed_at: iso(now), updated_at: iso(now), resolved_by: 'inbox', previous_status: j.status, waiting_user: null, result: [feedback || '已在收件箱处理', j.result ? `（原结果：${String(j.result).slice(0, 600)}）` : ''].join('') });
  else Object.assign(j, { status: 'dropped', dropped_at: iso(now), dropped_by: 'dashboard', previous_status: j.status });
  writeLines('state/host-jobs.ndjson', jobs);
  const native = j.local_tool === true || !!localToolNeed(j.details || '');
  const local = native && whoDoes('user_task', { local: true }).worker === 'local_ai';
  if (!['drop', 'resolve'].includes(action) && !native) {
    const { readCards, saveCards, leadRef, jobTitle } = await import('./cards.mjs');
    let card = readCards().find(c => c.links?.job_id === id || c.links?.old_job_id === id);
    const lead = lines('state/leads.ndjson').find(l => j.record_id ? l.record_id === j.record_id || l.id === j.record_id : j.number != null && l.number === j.number)
      || (j.record_id || j.number != null ? { record_id: j.record_id, number: j.number, company: j.company, role: j.role } : null);
    if (!card) card = queueEngineTask({ text: j.details || jobTitle(j), owner: j.thread?.persona || 'patch', leads: lead ? [lead] : [], from: { by: 'you', via: 'host-job', ...(j.thread || {}) }, now });
    if (!card.leads?.length && lead) card.leads = [leadRef(lead)];
    const links = { ...card.links, old_job_id: id }; delete links.job_id; delete links.do_at;
    card = { ...card, ...(j.result && !card.answer ? { answer: { text: j.result, basis: ['此前排查'], at: iso(now), by: 'patch' } } : {}), kind: 'ask', links, status: 'queued', auto: true, manual: false, wait: null, wait_code: null, detail: '', says: [...(card.says || []), ...(feedback ? [{ text: feedback, at: iso(now), by: 'you' }] : [])], ...(j.kind === 'system_fix' ? { repair_target: j.target || { label: j.details } } : {}) };
    saveCards([card]);
    Object.assign(j, { status: 'dropped', dropped_by: 'engine', moved_to_card: card.id, result: j.result || '改由引擎接着做', migration_reason: '改由引擎接着做', updated_at: iso(now) });
    writeLines('state/host-jobs.ndjson', jobs);
    return { status: 'pending', run_now: false, card_id: card.id, receipt: '记下了，团队会用引擎接着处理。' };
  }
  if (!['drop', 'resolve'].includes(action) && local) requestRunNow({ reason: `[操作台] ${action === 'feedback' ? '已反馈，核验后继续' : '重试'}宿主任务 ${id.slice(0, 8)}`, job_ids: [id], now });
  event('user', 'room', 'ok', `操作台${action === 'feedback' ? '反馈' : action === 'retry' ? '重试' : action === 'resolve' ? '处理完' : '放弃'}宿主任务 ${id.slice(0, 8)}`);
  return { status: action === 'drop' ? 'dropped' : action === 'resolve' ? 'completed' : 'pending', run_now: local && !['drop', 'resolve'].includes(action), receipt: !local && !['drop', 'resolve'].includes(action) ? '记下了；本机 AI 没打开，打开后接着处理' : action === 'feedback' ? '反馈已保存在原任务中，已排队让本机 AI 核验并继续处理。' : undefined };
}

// 没编号的线索也要能操作（pass / 联系）：编号本来由 bin/project-base.mjs 投影时分配（最大号 + 1），
// 这里按同一规则当场补一个并落盘，project-base 之后看到已有编号就不会再改。
export async function ensureLeadNumber(id) {
  const key = String(id || '');
  if (!key) throw Error('缺少线索 id');
  const rows = lines('state/leads.ndjson');
  const l = rows.find(x => leadKey(x) === key || x.id === key || x.record_id === key);
  if (!l) throw Error('线索不存在');
  if (Number.isInteger(l.number) && l.number > 0) return { number: l.number, assigned: false, record_id: leadKey(l) };
  l.number = Math.max(0, ...rows.map(x => Number(x.number) || 0)) + 1;
  l.numbered_at = iso(Date.now());
  writeLines('state/leads.ndjson', rows);
  return { number: l.number, assigned: true, record_id: leadKey(l) };
}
