// 操作表（第 4 步 4b，从 lib/command-center.mjs 拆出来）：团队页、成员页、对话里能跑的脚本（OPS），怎么跑（runOp）、跑到哪了（opsStatus、opLog），
// 成员暂停 / 恢复 / 跑一轮（agentAction），补了资料以后的重新判断（rejudge*），手上有别的在跑时排到后面（runOrQueue、queueTick、cancelOp，原在 lib/crew-desk.mjs）。
// domain 层：不引视图（lib/layers.json）。
import fs from 'node:fs';
import path from 'node:path';
import { agentPaused, setAgentPaused, EXECUTOR } from './agents.mjs';
import { applyUrl, loadPortalSessions } from './apply-channel.mjs';
import { mailReader, localAiGate, MAIL_SETUP } from './capabilities.mjs';
import { computerUseConfig, computerUseGate } from './computer-use.mjs';
import { LEGACY, isMember, crewName } from './crew.mjs';
import { event } from './events.mjs';
import * as J from './jobs.mjs';
import { judgeAvailable, loadJudgeConfig } from './judge.mjs';
import { QUEUED_LINE, enqueue, setCard, cancelQueued, queueState, queueTick as tickQueue } from './op-queue.mjs';
import { requestRunNow, exitWords } from './run-now.mjs';
import { sandboxed, sandboxSkip, sandboxModels } from './sandbox.mjs';
import { logReason } from './say-error.mjs';
import { spawn } from './spawn.mjs';
import { file, lines, read, write, writeLines, root } from './store.mjs';
import { noteSwallowed } from './swallow.mjs';
import { TZ, dayOf } from './tz.mjs';
import { opSummary, SUMMARY_OPS, lastJson } from './watcher-mail.mjs';
import { discoveryOutcome } from './discovery-outcome.mjs';
import { loadProviders, backendLabel, textBackendUsable } from './backends.mjs';
import { FREE_PROVIDER, freeBlocked, BLOCK_TITLE } from './free-model.mjs';
import { offlineWanted } from './judge-offline.mjs';
import { backendsFor } from './model.mjs';
import { makeCard, saveCards } from './cards.mjs';
import { textConf } from './text-conf.mjs';
import { OPS, OPS_PATH, opFor as opForTable, LABEL, opLabel, OP_NEEDS, opMember } from './ops-table.mjs';
// 没有 Jev 时「判断全部新岗位」跑的是匹配：调用方没给 judgeOk 就问判断层现在能不能用。
export const opFor = (op, judgeOk = null) => opForTable(op, judgeOk ?? judgeAvailable({ offlineOk: true }));

// 格式化器只建一次：每次 new Intl.DateTimeFormat 约 30 µs，一次指挥台刷新要按日期分一万多次。
export { dayOf };
const iso = x => new Date(x).toISOString();
const leadKey = l => l.record_id || l.id;
const label = l => `${l.number ?? '待编号'} · ${l.company || '待核'} · ${l.role || ''}`;
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// 指挥台团队条 ⋯：暂停 / 恢复 / 立即跑一轮（lib/agents.mjs）。立即跑一轮先恢复它，再只跑它在周期里的那几步。
// key 是成员（lib/crew.mjs）；executor 是执行器的开关（不是成员，页面上在 Patch 的 ⋯ 里）：立即跑一轮 = 把排队的交办任务
// 交给即时执行器（没有排队的就不拉起）。老编号（radar …）也认：暂停 / 恢复落到接手它的几位，立即跑一轮跑它换成的那一位。
export function agentAction(key, action, { now = Date.now(), run = (op, o) => runOp(op, o), kick = requestRunNow, jobs = null } = {}) {
  const keys = isMember(key) || key === EXECUTOR ? [key] : LEGACY[key]?.pause?.length ? LEGACY[key].pause : null;
  if (!keys) throw Error('没有这位成员');
  const name = keys.map(k => k === EXECUTOR ? '本机 AI' : crewName(k)).join('、');
  if (action === 'pause' || action === 'resume') {
    for (const k of keys) setAgentPaused(k, action === 'pause', { now });
    event('user', 'ops', 'ok', `指挥台：${action === 'pause' ? '暂停' : '恢复'} ${name}`);
    return { ok: true, paused: action === 'pause', receipt: action === 'pause' ? `${name} 暂停了：${key === EXECUTOR ? '交办任务先排着，不拉起本机 AI' : '它的定时工作先不做'}；恢复后继续定时工作（你自己的反馈照常处理）` : `${name} 恢复了，下一轮照常做` };
  }
  if (action !== 'run') throw Error('未知的操作');
  const k = keys[0], was = agentPaused(k);
  if (was) setAgentPaused(k, false, { now });
  const back = was ? `${k === EXECUTOR ? '本机 AI' : crewName(k)} 恢复了；` : '';
  if (k === EXECUTOR) {
    const latest = new Map(); for (const j of jobs || lines('state/host-jobs.ndjson')) latest.set(j.id, j);
    const open = [...latest.values()].filter(j => j.status === 'pending').length;
    if (!open) return { ok: true, receipt: `${back}现在没有排队的交办任务，本机 AI 不用跑` };
    kick({ reason: `[指挥台] 立即跑一轮（${open} 件排队的交办任务）`, now });
    event('user', 'ops', 'ok', `指挥台：让执行器立即跑一轮（${open} 件）`);
    return { ok: true, receipt: `${back}已让本机 AI 接着做 ${open} 件排队的交办任务` };
  }
  const r = run(`round-${k}`, { now });
  // 手上有别的在跑：排到后面（lib/crew-desk.mjs runOrQueue），跑完自动接着跑。
  if (r?.queued) return { ok: true, op: r, queued: true, receipt: `${back}「${r.label}」${r.dup ? '已经排着了，' : ''}${QUEUED_LINE}${r.ahead ? `（前面还有 ${r.ahead} 个）` : ''}` };
  if (r?.already) return { ok: true, op: null, receipt: `${back}「${r.label}」正在跑` };
  return { ok: true, op: r, receipt: `${back}已开始「${r.label}」` };
}
export function opsStatus() {
  const s = read(OPS_PATH, { current: null, history: [] });
  if (s.current && !alive(s.current.pid)) { s.history.unshift({ ...s.current, status: 'lost', finished_at: iso(Date.now()) }); s.current = null; write(OPS_PATH, { ...s, history: s.history.slice(0, 20) }); }
  return { current: s.current, history: (s.history || []).slice(0, 12), catalog: Object.entries(OPS).map(([op, o]) => ({ op, role: o.role || 'patch', label: o.label, desc: o.desc, heavy: o.heavy })) };
}
export function opLog(id, bytes = 12000) {
  if (!/^[a-z0-9-]{8,60}$/.test(String(id))) throw Error('无效的操作 id');
  const s = read(OPS_PATH, { current: null, history: [] });
  const rec = s.current?.id === id ? s.current : (s.history || []).find(h => h.id === id);
  if (!rec) throw Error('没有这个操作记录');
  const p = fs.realpathSync(file(rec.log)), allowed = fs.realpathSync(file('runs')) + path.sep;
  if (!p.startsWith(allowed)) throw Error('不允许访问该文件');
  const t = fs.readFileSync(p, 'utf8');
  return { ...rec, tail: t.length > bytes ? '…' + t.slice(-bytes) : t };
}
// 日志的最后一截（周期的结果是最后一行 JSON；只读末尾，不把整份日志读进来）。
export function tailOf(p, max = 1024 * 1024) {
  const fd = fs.openSync(p, 'r');
  try { const size = fs.fstatSync(fd).size, n = Math.min(size, max), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); return buf.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
// 记账（契约 2.2）：这一次操作是哪件活。job_id 给了就用它；有任务卡（card_id）就用卡的那件（ref card:<id>，卡还没存下来就先按这个 ref 建，
// 存卡时 lib/task-ledger.mjs 认得同一件）；都没有就自己建一件（ref op:<这次的 id>）。不另开第二件。
export function opJob(op, o, { job_id, card_id, origin, id, now }) {
  try {
    if (job_id && J.get(job_id)) return J.get(job_id);
    if (card_id) return J.byRef(`card:${card_id}`) || J.create({ kind: op, member: o.role || OPS[op]?.role || 'patch', title: String(o.label || op).slice(0, 200), origin: origin || 'card', ref: `card:${card_id}`, now });
    return J.create({ kind: op, member: o.role || OPS[op]?.role || 'patch', title: String(o.label || op).slice(0, 200), origin: origin || 'system', ref: `op:${id}`, now });
  } catch (e) { console.error(`[jobs] 操作「${o.label || op}」记账出错：${e.message}`); return null; }
}
// 子进程退出时那件活还没被它自己记完（RADAR_JOB_ID 那一层还没接上记账的脚本）：按退出码收尾。子进程自己记过了的不动。
export function closeOpJob(jobId, { ok, sum, label, signal, sandbox = false, op = null, log = null, why = null }) {
  if (!jobId) return;
  try {
    const j = J.get(jobId);
    if (!j || J.TERMINAL.has(j.state) || j.state === 'waiting_you') return;
    // 读信动作已安排等待/重试或仍在运行，由动作负责最终结果；CLI 退出码不能覆盖它。
    if (J.actionsOf(jobId).some(a => a.kind === 'read_mail' && ['approved', 'claimed'].includes(a.state))) return;
    if (ok && sum && sum.read === false && sum.go) J.drive(jobId, 'waiting_you', { reason: sum.text, what: sum.go });
    else if (ok) J.drive(jobId, 'done', { result: { summary: sum?.text || `跑完了${sandbox ? '（沙盒里没真跑）' : ''}` } });
    // 没跑成：一句人话原因（日志尾巴里取，lib/say-error.mjs logReason），不叫你去看日志；收录没成说清是链接的事（线 S 10-04）。
    // why：超时、本机 AI 自己报的退出原因（runOp finish），照实说，不写成「被停下了」。
    else J.drive(jobId, 'failed', { reason: why ? `「${label}」${why}` : signal ? `「${label}」跑到一半被停下了` : op === 'add-lead' ? '没收成：链接打不开，或者不是岗位页' : `「${label}」没跑成：${log ? logReason(log) : '中途出错停了'}` });
  } catch (e) { console.error(`[jobs] 操作「${label}」收尾记账出错：${e.message}`); }
}
export function runOp(op, { spawner = spawn, now = Date.now(), record_id, url = null, email = null, job_id = null, card_id = null, origin = null, discover = false } = {}) {
  op = opFor(op);
  let o = OPS[op];
  if (op === 'linkedin-inbox') {
    o = { ...o, args: [...o.args, ...(url ? ['--thread',String(url)] : []), ...(record_id ? ['--record',String(record_id)] : [])] };
  }
  if (op === 'round-tailor' && record_id) {
    o = { ...o, args: [process.execPath, 'bin/tailor-resumes.mjs', '--record', String(record_id)] };
  }
  // 任务板的「收录并核验」卡（lib/tasks.mjs）：收一个你贴来的链接。不在 OPS 里（没有链接跑不了，成员工作台上不列）。
  if (op === 'add-lead') {
    if (!/^https?:\/\//.test(String(url || ''))) throw Error('收录要一个链接');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw Error('邮箱格式不对');
    o = { role: 'scout', label: '收录并核验', args: [process.execPath, 'bin/add-lead.mjs', '--url', String(url), '--source', 'forwarded', ...(email ? ['--email', String(email)] : [])], timeout_ms: 5 * 60000 };
  }
  // 补上工作许可以后，只重判当时因为缺它才判成待核的那几条（lib/first-round.mjs rejudgeReady；bin/match.mjs --rejudge-filled）。
  // 不在 OPS 里：不是一个能单独点的操作，保存资料时自己起（rejudgeFilled）。
  // 「先判断」：只判一条（bin/match.mjs --record）。不在 OPS 里，收件箱、岗位页上的信起。
  if (op === 'judge-one') {
    if (!record_id) throw Error('要判哪一条？');
    const ids = [record_id].flat().map(String).filter(Boolean);
    o = { role: 'lens', label: ids.length > 1 ? `判断这 ${ids.length} 条` : '判断这一条', args: [process.execPath, 'bin/match.mjs', '--record', ids.join(',')], timeout_ms: 10 * 60000 };
  }
  if (op === 'rejudge-filled') o = { role: 'lens', label: '重新判断', args: [process.execPath, 'bin/match.mjs', '--rejudge-filled'], timeout_ms: 20 * 60000 };
  // 合盖睡过完整周期那一档（09:05 / 13:05 / 18:05）以后，醒来补的那一轮（lib/cycle-catchup.mjs）：轻量周期带上判断和匹配
  // （bin/cycle.mjs --judge，10-02 开箱第 3 轮 D）。不在 OPS 里：不是一个能单独点的操作，工作台醒来后自己起。
  // 10-10：上一次读通的找岗位早于最近一档完整周期（lib/discover-fresh.mjs discoverDue），补的这一轮再带上找岗位（discover）。
  if (op === 'cycle-catchup') o = discover
    ? { role: 'patch', label: '轻量周期（带找岗位和判断）', args: [process.execPath, 'bin/cycle.mjs', '--mode', 'light', '--judge', '--discover'], timeout_ms: 75 * 60000 }
    : { role: 'patch', label: '轻量周期（带判断）', args: [process.execPath, 'bin/cycle.mjs', '--mode', 'light', '--judge'], timeout_ms: 60 * 60000 };
  if (op === 'computer-use-record') {
    const l = lines('state/leads.ndjson').find(l => leadKey(l) === record_id);
    if (!l) throw Error('没有这个岗位');
    const url = applyUrl(l); let host; try { host = new URL(url).hostname; } catch {} /* 兜底：地址不是有效网址：拿不到域名，这一行不按门户归拢 */
    const reason = computerUseGate({ url, host, config: computerUseConfig(), sessions: loadPortalSessions() });
    if (reason) throw Error(`电脑操作暂不可用：${reason}`);
    o = { label: `引擎浏览器处理 #${l.number ?? ''} ${l.company || ''}`, args: [process.execPath, 'bin/computer-use.mjs', '--record', record_id], timeout_ms: 5 * 60000 };
  }
  if (!o) throw Error('未知操作');
  // 读信那一项先问能力表（lib/capabilities.mjs）：邮箱没接就说清楚、带「接上邮箱」（团队页上同样显示成不可用，lib/crew-desk.mjs opGate）。
  if (op === 'mail-poll') { const w = mailReader(); if (!w.worker) throw Object.assign(Error(`「${o.label}」现在跑不了：${w.reason}`), { status: 409, ...(w.fix ? { fix: w.fix } : {}) }); }
  // 联系人识别可走所选文字模型或独立接口；直接调用同样检查，不能把没有检索的退出 0 记成完成。
  if (OP_NEEDS[op] === 'contacts' || op === 'maimai-inbox') {
    const gate = opGate(op, capabilities(opMember(op)));
    if (!gate.ok) throw Object.assign(Error(`「${opLabel(op)}」现在跑不了：${gate.why}`), { status: 409, ...(gate.go ? { fix: gate.go } : {}) });
  }
  const busy = opBusy();
  if (busy) throw Object.assign(Error(busy), { code: 'OP_BUSY' });
  const day = dayOf(now).replaceAll('-', ''), id = `${op}-${now}`;
  const job = opJob(op, o, { job_id, card_id, origin, id, now });
  const logRef = `runs/${day}/ops/${id}.log`;
  fs.mkdirSync(file(`runs/${day}/ops`), { recursive: true });
  const out = fs.openSync(file(logRef), 'a');
  fs.writeSync(out, `[${new Date(now).toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}] ${o.label} · ${o.args.join(' ')}\n`);
  // 演示 / 沙盒模式：宿主脚本（zsh → Codex / Claude）不启动；这一项照常记成跑完，原因写进它的日志（lib/sandbox.mjs）。
  // node 的脚本照常跑：它们自己在沙盒里，对外的那一步各自跳过。
  if (sandboxed() && o.args[0] !== process.execPath) {
    const msg = sandboxSkip(`${o.label}（${o.args.slice(1).join(' ')}）`, { actor: OPS[op]?.role === 'owl' ? 'nightwatch' : 'system' });
    fs.writeSync(out, msg + '\n'); fs.closeSync(out);
    const done = { id, op, record_id: record_id || null, label: o.label, pid: null, started_at: iso(now), log: logRef, status: 'ok', exit: 0, signal: null, finished_at: iso(now), sandbox: true, ...(job ? { job_id: job.id } : {}) };
    if (job) { try { J.drive(job.id, 'running', { now }); } catch (e) { noteSwallowed('command-center.op-start', e, { doing: '把这件活记成在做', then: '照样按演示收尾' }); } closeOpJob(job.id, { ok: true, label: o.label, sandbox: true }); }
    const s = read(OPS_PATH, { current: null, history: [] });
    write(OPS_PATH, { ...s, history: [done, ...(s.history || [])].slice(0, 20) });
    return done;
  }
  // RADAR_JOB_ID：那件活交给直接起的这一层，它自己 start / finish / fail（lib/spawn.mjs 不让孙进程继承）。
  const child = spawner(o.args[0], o.args.slice(1), { cwd: root, env: { ...process.env, RADAR_RUN_ID: `ops-${id}`, ...(job ? { RADAR_JOB_ID: job.id } : {}) }, stdio: ['ignore', out, out], detached: false });
  const rec = { id, op, record_id: record_id || null, label: o.label, ...(o.role && !OPS[op] ? { role: o.role } : {}), pid: child.pid, started_at: iso(now), log: logRef, status: 'running', ...(job ? { job_id: job.id } : {}) };
  if (job) try { if (J.get(job.id)?.state === 'queued' || J.get(job.id)?.state === 'failed') J.drive(job.id, 'running', { pid: child.pid ?? null, now }); } catch (e) { noteSwallowed('command-center.op-start', e, { doing: '把这件活记成在做', then: '进程照样跑，结束时照退出码收尾' }); }
  const s = read(OPS_PATH, { current: null, history: [] });
  write(OPS_PATH, { ...s, current: rec });
  event('user', 'ops', 'start', `操作台触发「${o.label}」`, { run_id: `ops-${id}`, refs: [{ file: logRef }] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, o.timeout_ms); /* 兜底：进程已经自己退出了，杀不到就是不用杀 */
  timer.unref();
  const finish = (code, signal) => {
    clearTimeout(timer);
    try { fs.closeSync(out); } catch {} /* 兜底：日志文件已经关过了 */
    const cur = read(OPS_PATH, { current: null, history: [] });
    // Watcher 读信的两项：这次读了几封、有没有新的，或者没读、为什么（lib/watcher-mail.mjs，从这次日志最后一行 JSON 取）。
    let sum = null;
    if (SUMMARY_OPS.has(op)) try { sum = opSummary(op, tailOf(file(logRef))); } catch {} /* 兜底：这次日志最后一行不是摘要：结果照退出码记，只是少一句「读了几封」 */
    if (op === 'round-scout' || op === 'round-first') try {
      const result = lastJson(tailOf(file(logRef)));
      if (Array.isArray(result?.results)) { const scan = discoveryOutcome(result.results); sum = { text: scan.text, read: scan.counts.read > 0, partial: scan.status === 'partial' }; }
    } catch (e) { noteSwallowed('ops.discovery-summary', e); }
    const done = { ...rec, status: code === 0 ? 'ok' : 'fail', exit: code ?? null, signal: signal || null, finished_at: iso(Date.now()), ...(sum ? { summary: sum.text, read: sum.read, ...(sum.go ? { go: sum.go } : {}) } : {}) };
    write(OPS_PATH, { current: cur.current?.id === id ? null : cur.current, history: [done, ...(cur.history || [])].slice(0, 20) });
    // 跑满时间被这里停下的说「跑满 N 分钟」；本机 AI（Codex 处理等）自己退出的按退出码说人话（lib/run-now.mjs exitWords）。
    const localAi = OP_NEEDS[op] === 'executor' || o.args[0] !== process.execPath;
    const why = code === 0 ? null : timedOut ? `跑满 ${Math.round(o.timeout_ms / 60000)} 分钟没做完，停下了` : localAi && [124, 125, 127, 137, 143].includes(code) ? exitWords(code, { signal }).replace(/^本机 AI/, '：本机 AI') : null;
    closeOpJob(job?.id, { ok: code === 0, sum, label: o.label, signal, op, log: file(logRef), why });
    event('user', 'ops', code === 0 ? 'ok' : 'fail', `「${o.label}」${code === 0 ? '完成' : why ? why : `结束（exit ${code ?? signal}）`}${sum ? `：${sum.text}` : ''}`, { run_id: `ops-${id}`, refs: [{ file: logRef }] });
  };
  child.once('exit', finish);
  child.once('error', e => { try { fs.writeSync(out, `\n启动失败：${e.message}\n`); } catch {} finish(127, null); }); /* 兜底：日志写不进去也照样按启动失败收尾（finish 127） */
  return rec;
}

// ── 操作台：与飞书指挥室相同的指令 ─────────────────────────────────────────────
// 文本走 lib/intent.mjs resolveCommand 的同一套语法；发送与投递类指令先返回预览，第二次带
// confirm 才执行，确保用户在网页上看过要发的全文或要投的清单。
// action.mjs 返回结构化 busy；其他旧脚本仍抛锁异常。只重试明确的锁冲突，
// 此时脚本尚未执行操作，沿用原 message-id，避免把其他执行失败重复提交。
export const busyRetryMs = e => {
  for (const output of [e.stderr, e.stdout, e.message]) {
    const text = String(output || '');
    if (text.includes('another_radar_writer_running')) return 500;
    for (const line of text.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value?.error === 'busy') return Math.min(5000, Math.max(500, (Number(value.retry_after_s) || 1) * 1000));
      } catch {} /* 兜底：这一行不是 JSON：接着看下一行 */
    }
  }
  return null;
};

// 保存了个人资料（/api/setup/profile）：当时因为资料里缺东西才判成待核的线索（工作许可、技能、经历、学历，lib/first-round.mjs
// rejudgeReady），现在补上了，马上只重判这几条（主会话 10-02；第 3 轮扩到技能、经历、学历）。
// 别的线索不碰，也不跑整轮。操作台上有别的在跑、或者周期占着写锁，就不起（下一轮周期照样会重判它们）。返回起了的那一项，没起是 null。
//
// 开箱第 4 轮 F06：以前手上有别的在跑（首轮正在判、周期占着写锁）就不起、也不记，那几条一直挂着「已补，等重新判断」，要等
// 下一档定时周期——新用户多半正是在首轮跑着的时候补的。现在不起时记一笔 state/rejudge-pending.json，手上那一轮跑完，
// 工作台的定时检查（rejudgePendingTick，bin/serve.mjs 每 15 秒）马上起。返回起了的那一项；排着等的返回 { pending, why }；
// 没有要重判的、或者起不了（不是因为忙）返回 null。
export async function rejudgeFilled({ run = runOp, now = Date.now(), busy = opBusy, changes = [] } = {}) {
  const { rejudgeReady, rememberLocationGap, REJUDGE_PENDING } = await import('./first-round.mjs');
  const { readFacts } = await import('./facts.mjs');
  const facts = readFacts(); // 刚写的文件：不用 currentFacts 一秒内的缓存
  const rows = lines('state/leads.ndjson');
  let changed = false;
  for (const l of rows) if (rememberLocationGap(l, facts, changes)) changed = true;
  if (changed) writeLines('state/leads.ndjson', rows);
  const due = rows.filter(l => rejudgeReady(l, facts));
  const clear = () => { try { fs.rmSync(file(REJUDGE_PENDING), { force: true }); } catch {} }; /* 兜底：文件本来就不在（force），删不掉的下一轮再删，不挡判断 */
  if (!due.length) { clear(); return null; }
  const why = busy();
  if (why) { write(REJUDGE_PENDING, { at: iso(now), leads: due.length, why }); return { pending: true, why }; }
  clear();
  try { return run('rejudge-filled', { now }); } catch (e) { event('system', 'ops', 'fail', `补了资料以后的重新判断没起来：${String(e.message || e).slice(0, 120)}`); return null; }
}
// 旧规则复查有真实的持久队列；到期、空闲且 Judge 没暂停时，启动正常 Judge 轮次。
// 不走 --record，保留批量上限、预算与每条失败退避；正常周期也消费同一批旧判断。
export async function policyReviewTick({ run = runOp, now = Date.now(), busy = opBusy, paused = agentPaused('lens') } = {}) {
  const { syncPolicyReviewQueue, deferPolicyReviewQueue } = await import('./judge-review.mjs');
  const queue = syncPolicyReviewQueue(lines('state/leads.ndjson'), { now, paused });
  if (paused || busy() || !(queue.remaining || []).some(e => !e.stopped && !e.paused && Date.parse(e.next_at) <= now && Date.parse(e.not_before) <= now)) return null;
  const records = deferPolicyReviewQueue('已交给正常 Judge 轮次，等待本轮回执', { now });
  try { return run('round-lens', { now }); }
  catch (e) { deferPolicyReviewQueue(`Judge 未启动：${String(e.message || e).slice(0, 120)}`, { now, records }); event('lens', 'policy-review', 'fail', `旧判断重判未启动：${String(e.message || e).slice(0, 120)}`); return null; }
}
// 排着等的重新判断（state/rejudge-pending.json）：手上没有在跑的了就起。没排着的、还在忙的：null。
// 「先判断」排着的那几条（state/judge-pending.json，judgeOne）也在这里起。
export async function rejudgePendingTick({ run = runOp, now = Date.now(), busy = opBusy } = {}) {
  const { REJUDGE_PENDING } = await import('./first-round.mjs');
  if (busy()) return null;
  if (fs.existsSync(file(JUDGE_PENDING))) {
    const ids = read(JUDGE_PENDING, {})?.records || [];
    try { fs.rmSync(file(JUDGE_PENDING), { force: true }); } catch {} /* 兜底：删不掉下一拍再起一次，同几条重判一遍无害 */
    if (ids.length) { try { return run('judge-one', { now, record_id: ids }); } catch (e) { event('lens', 'ops', 'fail', `排着的「先判断」没起来：${String(e.message || e).slice(0, 120)}`); } }
  }
  if (!fs.existsSync(file(REJUDGE_PENDING))) return null;
  return rejudgeFilled({ run, now, busy });
}
// 「先判断」（收件箱、岗位页上没判完的岗位）：手上没在跑的就马上判这一条；忙着就记下，手上那一轮跑完接着判（rejudgePendingTick）。
export const JUDGE_PENDING = 'state/judge-pending.json';
export function judgeOne(record_id, { run = runOp, now = Date.now(), busy = opBusy } = {}) {
  const why = busy();
  if (!why) { run('judge-one', { now, record_id }); return { started: true }; }
  const cur = read(JUDGE_PENDING, {}) || {};
  write(JUDGE_PENDING, { at: iso(now), records: [...new Set([...(cur.records || []), String(record_id)])].slice(-40), why });
  return { pending: true, why };
}
// 操作台现在能不能再起一项：有一项在跑、或者周期 / 执行器占着写锁，返回那一句原因；能起：null。
export function opBusy() {
  const status = opsStatus();
  if (status.current) return `「${OPS[status.current.op]?.label || status.current.label || status.current.op}」还在运行，一次只跑一个`;
  if (lockHeld()) return '另一个写入进程正在跑（周期或本机 AI），请等它结束';
  return null;
}
// 周期锁被别的进程拿着（private/cycle.lock，bin/cycle.mjs 整轮拿着；App 定时起的周期）：操作台上没有这一项（runningOp 看不到），
// 可这时也起不了新的（opBusy）——起的若是「跑一轮」，它自己的周期拿不到周期锁就直接退出了。全局 state 锁退役了（第 2 步），不再看它。
export function lockHeld() {
  return ['private/cycle.lock'].some(p => { const lock = file(p); try { return fs.existsSync(lock) && alive(fs.readFileSync(lock, 'utf8').trim()); } catch { return false; } }); // 兜底：锁文件刚被删、读不出就是没人拿着
}

// ── 模型能不能用（只看本机文件）────────────────────────────────────────────────
// 和「设置 → 模型」（lib/model-choice.mjs）同一个判断：lib/backends.mjs textBackendUsable（凭据文件、登录目录、PATH 上的
// claude / codex），OfferCrew 补给再看中转是不是正拒着（lib/free-model.mjs freeBlocked）。这里多一层：按这位成员自己的清单
// （lib/model.mjs backendsFor 的 role，没单独设就是全局那一份）。
export const SANDBOX_WHY = '演示 / 沙盒模式不调用模型';
export const abs = p => (p ? (path.isAbsolute(p) ? p : file(p)) : null);
export const usable = b => textBackendUsable(b) && !(b.provider === FREE_PROVIDER && freeBlocked());
export const labelOf = (b, providers) => { try { return backendLabel(b, providers); } catch { return b.id || b.model || ''; } };
export function textModel(member, providers) {
  let order = [];
  try { order = backendsFor(textConf({ providers }), providers, { role: member }); } catch (e) { noteSwallowed('crew-desk.textModel', e, { member, doing: '读这位成员的文字模型清单', then: '先当没有能用的模型' }); }
  if (!order.length) return { ok: false, why: '还没有能用的模型（设置 → 模型）' };
  const good = order.find(usable);
  if (good) return { ok: true, label: labelOf(good, providers) };
  const blk = order.some(b => b.provider === FREE_PROVIDER) ? freeBlocked() : null;
  return { ok: false, why: blk && order.every(b => b.provider === FREE_PROVIDER || !textBackendUsable(b)) ? BLOCK_TITLE[blk.kind] || 'OfferCrew 补给现在用不了' : `${labelOf(order[0], providers)}：没有登录或没有 key（设置 → 模型）` };
}
export function executorState(providers) {
  if (agentPaused(EXECUTOR)) return { ok: false, why: '这台电脑接手的事暂停了（System 的 ⋯ 里恢复）' };
  // 本机 AI 只认设置 → 高级 的开关（lib/capabilities.mjs localAiGate）。
  const gate = localAiGate();
  if (!gate.allowed) return { ok: false, why: gate.why };
  const host = read('config/host.json', null);
  if (!host) return { ok: false, why: '还没设置这台电脑用哪个程序接手（设置 → 高级）' };
  const claude = host.executor === 'claude', kind = claude ? 'claude_code' : 'codex_exec';
  const p = (claude && providers[host.claude_provider]) || Object.values(providers).find(x => x.kind === kind);
  if (!p) return { ok: false, why: `没有${claude ? ' Claude' : ' Codex'} 的登录` };
  return textBackendUsable({ ...p, codex_home: p.codex_home ? abs(p.codex_home) : null }) ? { ok: true, label: claude ? 'Claude' : 'Codex' } : { ok: false, why: `${claude ? 'Claude Code' : 'Codex'} 没装或没登录` };
}
export function judgeState() {
  let offline = false; try { offline = offlineWanted(loadJudgeConfig()); } catch (e) { noteSwallowed('crew-desk.judgeConfig', e, { member: 'lens', doing: '读判断岗位的设置', then: '当没开离线规则' }); }
  if (offline) return { ok: true, label: '离线规则', offline: true };
  let ok = false; try { ok = judgeAvailable(); } catch (e) { noteSwallowed('crew-desk.judgeAvailable', e, { member: 'lens', doing: '看判断岗位的模型能不能用', then: '先当用不了' }); }
  // 这是独立的 Jev 接口；Judge 还可使用文字模型（opFor），不能把这个连接缺失说成整个判断模型不可用。
  return ok ? { ok: true, label: '独立判断接口' } : loadJudgeConfig().enabled === false
    ? { ok: false, why: '联系人识别服务已关闭，这一项暂时不能用', go: { label: '服务设置', href: '#settings/crew/lens' } }
    : { ok: false, why: '联系人识别服务还没接上，这一项暂时不能用' };
}
// 一位成员现在能用的：{ model, judge, executor }，每样 { ok, label?, why? }。沙盒里三样都不能用（判断岗位的离线规则除外）。
export function capabilities(member, { providers = null, sandbox = sandboxed(), models = sandboxModels() } = {}) {
  // 沙盒开了「可以调文字模型」（RADAR_SANDBOX_MODELS=1）：模型和判断照常看配置，执行器仍然不跑。
  if (sandbox && models) {
    const P = providers || loadProviders();
    return { model: textModel(member, P), judge: judgeState(), executor: { ok: false, why: SANDBOX_WHY }, sandbox: true };
  }
  if (sandbox) {
    let offline = false; try { offline = offlineWanted(loadJudgeConfig()) || process.env.RADAR_JUDGE === 'offline'; } catch (e) { noteSwallowed('crew-desk.judgeConfig', e, { member: 'lens', doing: '读判断岗位的设置', then: '当没开离线规则' }); }
    const no = { ok: false, why: SANDBOX_WHY };
    return { model: no, judge: offline ? { ok: true, label: '离线规则', offline: true } : no, executor: no, sandbox: true };
  }
  const P = providers || loadProviders();
  return { model: textModel(member, P), judge: judgeState(), executor: executorState(P), sandbox: false };
}
// 一个操作现在能不能跑：{ ok, why }。some 总能跑（说明哪几步会跳过）；judge-leads 在离线规则下也能跑。
// 跑不了时给的入口（按钮上的字不以「去」开头）。
export const GO_LABEL = { [MAIL_SETUP]: '接上邮箱' };
export function opGate(op, caps) {
  if (op === 'maimai-inbox') return { ok: false, why: '脉脉消息同步暂不可用' };
  if (OP_NEEDS[op] === 'contacts') {
    if (caps.model?.ok || (caps.judge?.ok && !caps.judge.offline)) return { ok: true, why: '' };
    return { ok: false, why: caps.model?.why || '还没有能用的文字模型', go: { label: '模型设置', href: '#settings/model' } };
  }
  // 读信先问能力表：邮箱没接就跑不了、带「接上邮箱」（服务端 runOp 也拦）；接了是引擎自己读，模型可有可无（没有就按关键词粗分）。
  if (OP_NEEDS[op] === 'mail') {
    const w = mailReader();
    if (!w.worker) return { ok: false, why: w.reason, ...(w.fix ? { go: { label: GO_LABEL[w.fix.href] || w.fix.label, href: w.fix.href } } : {}) };
    return { ok: true, why: caps.model.ok ? '' : `这次按关键词粗分（${caps.model.why}）`, builtin: true };
  }
  const need = OP_NEEDS[opFor(op, caps.judge?.ok)] ?? null; // 没有 Jev 时「判断全部新岗位」跑的是匹配，要的是文字模型
  if (!need || need === 'some') return { ok: true, why: need === 'some' && !caps.model.ok ? `要模型的那几步这次会跳过（${caps.model.why}）` : '' };
  const c = caps[need];
  if (op !== 'judge-leads' && need === 'judge' && c.offline) return { ok: false, why: '离线规则只能判断岗位；这一项需要接上联系人识别服务', go: { label: '服务设置', href: '#settings/crew/lens' } };
  return c.ok ? { ok: true, why: '' } : { ok: false, why: c.why, ...(c.go ? { go: c.go } : {}) };
}

// ── 排队（lib/op-queue.mjs）──────────────────────────────────────────────────────
// 成员页、团队页的「立即跑一轮」「▶ 运行」，对话里的「运行 X」「Radar 跑一轮」都走这里：手上空着就直接起（run，默认 runOp）；
// 有别的在跑（操作台上一项、或者写锁 / 周期锁被别的进程拿着，opBusy）就排到后面，开一张「排队」的任务卡，返回 { queued, id, label, dup, ahead }。
// 同一项已经在跑：{ already }，不再排。排之前先过一遍 opGate（现在就跑不了的不排，直接说为什么）。
export function runOrQueue(op, { member = opMember(op), by = 'you', now = Date.now(), run = runOp, busy = opBusy, caps = null, record_id = null, card_id = null, url = null, email = null } = {}) {
  if (!OPS[op] && op !== 'add-lead') throw Error('未知操作');
  if (op === 'add-lead' && (!/^https?:\/\//.test(String(url || '')) || email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)))) throw Error('收录需要有效的网页链接和邮箱');
  const boundCard = card_id && J.byRef(`card:${card_id}`) ? card_id : null;
  const cur = opsStatus().current;
  if (!boundCard && !url && !email && (!record_id || record_id === cur?.record_id) && cur && (cur.op === op || cur.op === opFor(op))) return { already: true, id: cur.id, label: opLabel(op) };
  let why = busy();
  if (!why) {
    try { return run(op, { now, ...(record_id ? { record_id } : {}), ...(card_id ? { card_id } : {}), ...(url ? { url } : {}), ...(email ? { email } : {}) }); }
    catch (e) { if (e.code !== 'OP_BUSY') throw e; why = e.message; }
  }
  const gate = opGate(op, caps || capabilities(member));
  if (!gate.ok) throw Object.assign(Error(`「${opLabel(op)}」现在跑不了：${gate.why}`), { status: 409 });
  const q = enqueue(op, { label: op === 'add-lead' ? '收录并核验' : opLabel(op), member, by, now, record_id, card_id: boundCard, url, email });
  if (!q.dup) {
    const card = boundCard ? null : queuedCard(q.item, { now, timeout: 1500 });
    if (card) setCard(q.item.id, card.id);
    event('user', 'ops', 'ok', `「${opLabel(op)}」排在后面：${why}`);
  }
  return { queued: true, id: q.item.id, op, label: opLabel(op), dup: q.dup, ahead: q.ahead, why };
}
// 排着的那一项的任务卡（任务页「排队」）：状态由排队记录推（lib/tasks.mjs deriveCard 的 links.queue_id）。写不进去（写锁被别的进程拿着）
// 就先不建，queueTick 下一次再补。
export function queuedCard(item, { now = Date.now(), timeout = 0 } = {}) {
  try {
    const c = makeCard({ kind: OP_KIND[item.op] || (/^cycle-/.test(item.op) ? 'cycle' : 'round'), title: LABEL[item.op] || OPS[item.op]?.label || item.label, owner: item.member || opMember(item.op), from: { by: 'you', ...(item.by === 'talk' ? { via: 'talk' } : {}) }, how: 'script', links: { op: item.op, queue_id: item.id }, now });
    c.detail = QUEUED_LINE;
    saveCards([c], { timeout });
    return c;
  } catch (e) { noteSwallowed('crew-desk.queuedCard', e, { doing: `给排着的「${item.label || item.op}」建任务卡`, then: '下一次排队检查再补' }); return null; }
}
// 工作台每 3 秒一次（bin/serve.mjs）：排着的、手上空了就起最前面那一个；开跑前再过一遍 opGate（模型、本机 AI 开关），过不了就不跑，
// 卡上和成员页上写原因（运行日志也记一笔）。还没有任务卡的（建的时候写锁被拿着）先补上。
export function queueTick({ now = Date.now(), run = runOp, busy = opBusy, gate = op => opGate(op, capabilities(opMember(op))) } = {}) {
  const Q = queueState();
  if (!Q.items.length) return null;
  for (const item of Q.items.filter(x => !x.card_id)) { const c = queuedCard(item, { now }); if (c) setCard(item.id, c.id); }
  const r = tickQueue({ busy, gate, start: (op, o) => run(op, o), now });
  for (const d of r?.dropped || []) event('user', 'ops', 'fail', `排着的「${d.label}」没跑：${d.why}`);
  if (r?.started) event('user', 'ops', 'ok', `排着的「${r.item.label}」轮到了，开始跑`);
  return r;
}
// 取消排着的：什么都不跑；任务卡跟着变成取消（deriveCard 看排队记录）。已经起了的取消不了。
export function cancelOp(id, { now = Date.now() } = {}) {
  const item = cancelQueued(String(id || ''), { now });
  if (!item) throw Object.assign(Error('已经开始跑了，取消不了'), { status: 409 });
  event('user', 'ops', 'ok', `取消了排着的「${item.label}」`);
  return { ok: true, cancelled: item.id, receipt: `「${item.label}」不跑了` };
}
// 按钮点一次就是一张卡：负责人是这位，提的人是你，做法是脚本；卡指向这次运行（状态跟着它走）。
export const OP_KIND = { discover: 'scan-ats', 'discover-wide': 'scan-ats', 'discover-human': 'scan-posts', match: 'judge', 'judge-leads': 'judge', 'find-contacts': 'contacts', 'find-referrers': 'referrers', 'prepare-applications': 'apply', inbox: 'mail', 'mail-poll': 'mail', 'linkedin-inbox': 'mail', 'boss-inbox': 'mail', 'maimai-inbox': 'mail', concierge: 'sync', metrics: 'ledger', 'preferences-rebuild': 'preferences' };
// 卡先建好（不存）：id 先给 runOp，那件活从一开始就是这张卡的（ref card:<id>），不另开；排上了（没跑）就不用它。
export function newOpCard(id, op) {
  try {
    const kind = OP_KIND[op] || (/^round-/.test(op) ? 'round' : /^cycle-/.test(op) ? 'cycle' : 'round');
    return makeCard({ kind, title: LABEL[op] || OPS[op]?.label || op, owner: id, from: { by: 'you' }, how: 'script', links: { op } });
  } catch (e) { noteSwallowed('crew-desk.newOpCard', e, { member: id, doing: `给「${LABEL[op] || op}」建任务卡`, then: '这次照常跑，任务页上没有这张卡' }); return null; }
}
