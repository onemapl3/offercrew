import '../lib/tool-path.mjs'; // 最先：补齐 launchd 精简 PATH 里缺的工具目录（lark-cli 在 nvm 里）
import { event, runId } from "../lib/events.mjs";
process.env.RADAR_RUN_ID = runId;
import { lock } from "../lib/lock.mjs";
lock('cycle');
import { root, arg, log, read, write, lines } from "../lib/store.mjs";
import { recordPolicyReview, reviewBudgetHold, reviewSnapshot } from '../lib/judge-review.mjs';
import { cycleBudget, stageTimeout, PROGRESS_WAIT_MS } from "../lib/cycle-budget.mjs";
import { execStage, killStagesSync, sleepMeter } from "../lib/stage-runner.mjs";
import { agentPauses, stagePausedBy, stagesOf, pausedName, validOnly } from "../lib/agents.mjs";
import { isMember, crewName } from "../lib/crew.mjs";
import { clearCatchup } from "../lib/cycle-catchup.mjs";
import { stageHeld, spendTier } from "../lib/spend.mjs";
import { localAiLine, mailReader, whoDoes } from "../lib/capabilities.mjs";
import { budgetMode } from "../lib/cycle-mode.mjs";
import { factsBlocker, FACTS_EXIT } from "../lib/facts-gate.mjs";
import { judgeAvailable } from "../lib/judge.mjs";
import { mailOutcome, MAIL_NOT_CONNECTED } from "../lib/watcher-mail.mjs";
import { noteSwallowed } from '../lib/swallow.mjs';
import { noteDiscoverMiss } from "../lib/discover-fresh.mjs";
const mode = arg("--mode", "light"), wide = process.argv.includes('--wide'), only = arg("--only", "");
// 合盖睡过完整周期那一档（09:05 / 13:05 / 18:05）以后补的那一轮（lib/cycle-mode.mjs：bin/scheduled.mjs 按 App 定时的 RADAR_SLOT
// 加，lib/cycle-catchup.mjs 的补跑也加）：照旧是轻量周期（09-29 负责人：醒来补一轮轻量的），但带上判断和匹配，那一档该判的不丢。
// 10-10：上一次读通的找岗位早于最近一档完整周期（lib/discover-fresh.mjs discoverDue），补的这一轮再带上找岗位（--discover，
// 带找岗位就一定带判断）：合盖天天错过完整档的笔记本，Radar 也照样每天找。
const discoverToo = mode === "light" && process.argv.includes("--discover");
const judge = mode === "light" && (process.argv.includes("--judge") || discoverToo);
// 首轮（op round-first）：判断这一步先判和你的技能对得上的（bin/match.mjs --fit-first，lib/matcher.mjs byFirstRound）。
const firstRound = process.argv.includes('--first-round');
// 这一轮匹配几个：首轮（op round-first）传 --match-limit 15，其余按 config/pipeline.json 的 match_limit。
const matchLimit = Math.max(1, Number(arg("--match-limit", "")) || Number(read('config/pipeline.json',{}).match_limit) || 30);
if (!["full", "light"].includes(mode)) throw Error("invalid_mode");
if (only && !validOnly(only)) throw Error("invalid_agent");
// 资料文件读坏了、或者引导走完以后不见了（lib/facts-gate.mjs）：这一轮整轮不跑，不对着空候选人判断、写信、填表、发消息。
// 指挥台顶上的横条说原因（lib/blockers.mjs facts）；补跑标记不清，修好以后照常补。
// 以 78 退出（FACTS_EXIT，和 E05 / I05 同一个）：bin/host/radar-cycle.sh 见到它就不拉起执行器（以前是 0，执行器照样拿渲染不全的提示词跑整轮）。
const factsBad = factsBlocker();
if (factsBad) {
  event("heartbeat", "cycle", "skip", `本轮没跑：${factsBad.text}`);
  console.log(JSON.stringify(log("cycle", { mode, status: "no_change", reason: `facts_${factsBad.state}`, detail: factsBad.text, results: [], next_actions: [] })));
  console.error(`cycle stopped: ${factsBad.text}`);
  { const L = await import("../lib/cycle-ledger.mjs"); L.failCycle(L.openCycle({ runId, only }), `没跑：${factsBad.text}`); } // 账上那件活照实记失败
  process.exit(FACTS_EXIT);
}
// People before forms: contacts and referrers are looked up right after the
// judgement, so the application stages see them (the user's 2026-09-19 rule).
let stages =
  mode === "full"
    ? ["pull-feedback", "reach", "discover", "judge-leads", "match", "find-contacts", "find-referrers", "prepare-applications", "inbox", "prepare-interviews", "host-work", "metrics"]
    : ["pull-feedback", "reach", ...(discoverToo ? ["discover"] : []), ...(judge ? ["judge-leads", "match"] : []), "prepare-applications", "inbox", "prepare-interviews", "host-work", "metrics"];
// 按岗位定制简历（A11，默认关；candidate/resume/workspace.json 的 tailoring.enabled）：打开了才在「准备投递材料」后面多这一步。
if(stages.includes('prepare-applications')&&read('candidate/resume/workspace.json',{})?.tailoring?.enabled===true)stages.splice(stages.indexOf('prepare-applications')+1,0,'tailor-resumes');
// 步骤表从能力表来（主会话 10-04，lib/capabilities.mjs）：
//   发信、发私信、预填是对外动作，只由引擎的 worker 领 actions 去做（工作台每半分钟叫醒），周期里没有这几步；
//   要本机 AI 的（host-work 排宿主任务、prepare-applications 排材料包）只在能力表把「你交代的事」归它时排；
//   首联起草（reach）要有人读写邮箱（内置邮箱接上；命令行版的 Gmail 连接器 10-04 冻结）。
const STAGE_NEEDS = { 'host-work': 'local_ai', 'prepare-applications': 'local_ai', reach: 'mail' };
stages = stages.filter(s => STAGE_NEEDS[s] === 'local_ai' ? whoDoes('user_task').worker === 'local_ai' : STAGE_NEEDS[s] === 'mail' ? !!mailReader().worker : true);
// Real-recruiter posts convert best, so they are gathered before matching: the
// public boards, then the sources that need the user's logged-in browser.
if((mode==='full'||discoverToo)&&read('config/pipeline.json',{}).human_discovery_daily)stages.splice(stages.indexOf(stages.includes('judge-leads')?'judge-leads':'match'),0,'discover-human','discover-human-browser');
// 高级档（lib/spend.mjs）：判断、匹配之后给推荐的岗位写一页评估（bin/evaluate.mjs）；别的档位没有这一步。
if ((mode === "full" || judge) && spendTier() === "premium") stages.splice(stages.indexOf("match") + 1, 0, "evaluate");
// 有人读信（lib/capabilities.mjs mailReader：接了内置邮箱是引擎，演示里是模拟）：整理邮件之前先用引擎自己的读信读一遍（bin/mail-read.mjs），不经本机 AI、
// 不再交给宿主连接器（0.1.4）。定时的周期带 --patrol，和整点巡检一样只在 09:00–21:00 读；「Watcher 跑一轮」是你点的（--mail-now），马上读。
// 读信自己有锁和游标（private/mailread.lock、读到哪一封），和整点巡检撞上了这次跳过，读过的不会再处理一遍。
const mailNow = process.argv.includes("--mail-now");
if (stages.includes("inbox") && process.env.RADAR_EXTERNAL_POLICY !== "base-and-cards" && mailReader().worker) stages.splice(stages.indexOf("inbox"), 0, "mail-read");
// 「立即跑一轮」（指挥台团队条 ⋯）：只跑这位成员的那几步（lib/crew.mjs）。一步归两位的，阶段自己看 RADAR_ONLY_MEMBER
// 只做这位的那一段（bin/prepare-interviews.mjs）。
if (only) stages = stagesOf(only, stages);
// 暂停了的成员，它的那几步这一轮跳过（你自己的反馈照常处理）。
const pauses = agentPauses();
const reviewBefore = reviewSnapshot(lines('state/leads.ndjson'));
const reviewHeld = (stage, blocked, hold = {}) => {
  if (stage !== 'match') return;
  const rows = lines('state/leads.ndjson');
  const review = recordPolicyReview({ before: reviewBefore, after: rows, blocked, ...hold });
  if (review.remaining.length) { results.at(-1).review_summary = review.summary; event('lens', 'policy-review', 'skip', review.summary); }
};
event("heartbeat", "cycle", "start", `开始 ${mode} 运行${discoverToo ? "（带找岗位和判断）" : judge ? "（带判断）" : ""}${only ? `（只跑 ${only.split(",").map(crewName).join("、")}）` : ""}`);
// 这一轮开始了：合盖睡眠时跳过的那一轮不用再补（lib/cycle-catchup.mjs）。只跑一位成员的那一轮不算整轮，不清。
if (!only) { try { clearCatchup(); } catch (e) { noteSwallowed('cycle.clearCatchup', e, { doing: '清掉「错过了要补跑」的记号', then: '下次醒来可能多补跑一轮' }); } }
const cycleStarted = Date.now();
// 记账（lib/cycle-ledger.mjs）：这一轮一件活（runOp 给了 RADAR_JOB_ID 就是那一件），每一步一件子活。
const ledger = await import("../lib/cycle-ledger.mjs");
const cycleJob = ledger.openCycle({ runId, only, title: `${mode === "full" ? "完整周期" : discoverToo ? "轻量周期（补找岗位）" : "轻量周期"}${only ? `（只跑 ${only.split(",").map(crewName).join("、")}）` : ""}` });
// 2026-09-29：13:07 那轮墙钟跑了 80 分钟（预算 45），project-base「超过 90 秒」用了 990 秒。不是阶段卡住：
// 合盖用电池睡眠，整轮只在每 16–17 分钟一次、每次约 2 秒的 DarkWake 里醒着（pmset -g log），每个阶段都在
// 过点后第一次醒来的 1.5–4.6 秒内被结束。ms 是墙钟、含睡眠；睡了多久记在 slept_ms（每个阶段和整轮各一个），
// 看结果就分得清是睡过去的还是卡住的。
// 测试旋钮（tests/stage-runner.test.mjs 传短的值；没设就是 lib/stage-runner.mjs 里的默认：宽限 5 秒，睡眠计每拍 1 秒、迟到超过 5 秒才算睡过）。
const knob = (name) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : undefined);
const stageGraceMs = knob("RADAR_STAGE_GRACE_MS"), meterOptions = { step: knob("RADAR_SLEEP_STEP_MS"), slack: knob("RADAR_SLEEP_SLACK_MS") };
const cycleSleep = sleepMeter(meterOptions), sleptField = (meter) => { const ms = meter.stop(); return ms ? { slept_ms: ms } : {}; };
// 整轮预算（lib/cycle-budget.mjs）：到 cycleEnd 为止，按墙钟算。
const budget = cycleBudget(budgetMode(mode, judge), read('config/pipeline.json', {})), cycleEnd = cycleStarted + budget.total;
const results = [],
  next_actions = [];
// 进度文件只给工作台看：写不成（磁盘满之类）就跳过这一次，整轮不因此卡住或中断。不拿全局锁（第 2 步·锁退役）：这个文件只有周期写。
async function saveProgress(){try{write('state/cycle-progress.json',{at:new Date().toISOString(),results});}catch(e){noteSwallowed('cycle.saveProgress',e,{doing:'写这一轮的进度',then:'这一步的进度没写进去，周期照常往下跑'});}}
await saveProgress();
// 周期被 SIGTERM（scheduled.mjs 的守卫、工作台超时）时 lock() 直接 exit(143)；正在跑的阶段连同它启动的
// 进程一起结束（整个进程组：SIGTERM，最多等 5 秒再 SIGKILL），不留孤儿：否则周期被杀后，在跑的阶段
// （如 find-referrers）会自己接着跑，和宿主那一步同时写状态。
process.on('exit', () => killStagesSync(stageGraceMs));
// 2026-09-22：lib/lock.mjs 给每个阶段装了 SIGTERM 处理器，它要等同步调用（execFileSync / Atomics.wait）
// 返回、事件循环转一圈才能跑，所以 execFileSync 的 timeout 发出 SIGTERM 后阶段常常继续跑：09-21 那轮
// discover 15 分钟超时实际跑了 103 分钟、pull-feedback 10 分钟超时跑了 17 分钟，整轮 125 分钟。
// 这里自己计时（lib/stage-runner.mjs）。状态文件都是 tmp+rename 原子写、锁文件由 lock() 按 pid 存活
// 回收，强杀不会留下坏数据。stderr 照旧透传到周期日志。
// 2026-09-23：到点按墙钟判断，且最多每 10 秒看一次表。本机 Node 的计时（performance.now、定时器
// 的「现在」）含睡眠时间，但进程空闲等待时内核只按醒着的时间走：一个长 setTimeout 在合盖后要等
// 某次 I/O 把事件循环叫醒才发现过点（Codex 那一步 50 分钟的定时器墙钟走了 177 分钟）。
// 2026-09-29：每个阶段自成进程组，超时整组 SIGTERM、5 秒后仍在的 SIGKILL，组里没有进程了就收尾，
// 不等别人占着的管道；以前只杀阶段本身，它启动的 lark-cli 等会留下来，阶段自己退出而子进程还占着
// 输出时，周期会一直等下去（tests/stage-runner.test.mjs）。
// 状态锁被占时重试，但不超过 5 分钟，也不超过这个阶段自己的时间。
async function runStage(args,options){
  const deadline=Date.now()+options.timeout,lockDeadline=Math.min(deadline,Date.now()+300000);
  for(;;){try{return await execStage(args,{...options,timeout:Math.max(1000,deadline-Date.now()),graceMs:stageGraceMs});}catch(e){
    if(!String(e.stderr||e.message).includes('another_radar_writer_running')||Date.now()>=lockDeadline)throw e;
    await new Promise(resolve=>setTimeout(resolve,500));
  }}
}
for (const [i, stage] of stages.entries()) {
  const started = Date.now(), actor = ["reach", "send-approved", "send-dm", "auto-apply", "find-contacts", "find-referrers"].includes(stage) ? "postman" : ["inbox", "mail-read"].includes(stage) ? "nightwatch" : ["discover", "judge-leads", "match", "evaluate", "project-base", "job-list", "discover-human-browser"].includes(stage) ? "radar" : "heartbeat";
  // 单阶段上限与剩余预算取小；尾段至少一格。前面的阶段超时或 Mac 睡过头，预算用完的阶段跳过（线索、公司
  // 留在状态里等下一轮），尾段照跑。
  const pausedBy = stagePausedBy(stage, pauses);
  if (pausedBy) {
    results.push({ stage, status: "skipped", reason: "agent_paused", agent: pausedBy, ms: 0 });
    reviewHeld(stage, 'Judge 已暂停，这轮没有重判；恢复后才继续');
    await saveProgress();
    event(actor, stage, "skip", `${stage} · ${pausedName(pausedBy)} 已暂停，这一步跳过`);
    continue;
  }
  // 今天的花费上限到了（lib/spend.mjs）：判断、匹配、一页评估、找人这几步不开新的，线索留到明天；发送、投递、来信照常。
  const held = stageHeld(stage, { quiet: true });
  if (held) {
    results.push({ stage, status: "skipped", reason: "spend_cap", ms: 0 });
    reviewHeld(stage, null, reviewBudgetHold(held));
    await saveProgress();
    event(actor, stage, "skip", `${stage} · 今天的花费上限到了，留到明天`);
    continue;
  }
  // 没有 Jev（App 里都没有）：judge-leads 什么都做不了，判断由后面的 match 用文字模型做。安静跳过：不记给人看的事件，结果行照旧留原因。
  if (stage === "judge-leads" && !judgeAvailable({ offlineOk: true })) {
    results.push({ stage, status: "skipped", reason: "judge_unavailable", ms: 0 });
    await saveProgress();
    continue;
  }
  // Browser discovery also leaves a runnable share for judgement when it is
  // actually in this selected stage list (Scout-only runs keep their share).
  const timeout = stageTimeout(stages, i, { end: cycleEnd, slot: budget.slot, now: started, wide });
  if (!timeout) {
    results.push({ stage, status: "skipped", reason: "cycle_budget", ms: 0 });
    reviewHeld(stage, '本轮时间预算已用完，旧判断继续排队');
    await saveProgress();
    event(actor, stage, "skip", `${stage} · 本轮时间预算已用完，留到下一轮`);
    continue;
  }
  event(actor, stage, "start", `开始 ${stage}`);
  const stageJob = ledger.openStage(cycleJob, stage, { runId });
  const sleep = sleepMeter(meterOptions);
  try {
    // 阶段自己的收尾点：judge-leads、match、discover、find-contacts、find-referrers 开始下一件事之前看它
    // （lib/store.mjs deadlineNear），比强杀早一截；手动设了 RADAR_MATCH_DEADLINE 就取较早的。
    const soft = Math.min(started + timeout - Math.min(90000, timeout / 5), Date.parse(process.env.RADAR_MATCH_DEADLINE || '') || Infinity);
    const stdout = await runStage([`bin/${stage}.mjs`, ...(stage === "pull-feedback" ? ["--dashboard-only"] : stage === "reach" ? ["--pending"] : stage === "match" ? ["--limit",String(matchLimit),...(firstRound?["--fit-first"]:[])] : stage === "judge-leads" ? ["--limit",String(read('config/pipeline.json',{}).judge_limit||500)] : stage==='discover'&&wide?['--wide']:stage==='mail-read'?['--stage',...(mailNow?[]:['--patrol'])]:[])], {
      cwd: root,
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RADAR_MATCH_DEADLINE: new Date(soft).toISOString(), RADAR_ONLY_MEMBER: only },
    });
    const r = JSON.parse(stdout), asleep = sleptField(sleep);
    results.push({ stage, ...r, ms: Date.now() - started, ...asleep });
    ledger.closeStage(stageJob, results.at(-1));
    await saveProgress();
    // Watcher 读信那一步（引擎读信，或者 Mac 版没接邮箱时 inbox 说没读）：写读了几封、有没有新的，或者没读、为什么。
    const mail = stage === "mail-read" || r.reason === MAIL_NOT_CONNECTED ? mailOutcome(r) : null;
    event(actor, stage, ["error", "degraded", "failed"].includes(r.status) ? "fail" : r.next_actions?.length ? "waiting_user" : ["no_change", "skipped"].includes(r.status) && (mail || r.status === "no_change") ? "skip" : "ok", mail ? `${stage} · ${mail.text}` : `${stage} · ${r.status || "完成"}`, { duration_ms: Date.now() - started, stage_status: r.status || null, ...asleep });
    next_actions.push(...(r.next_actions || []));
  } catch (e) {
    const asleep = sleptField(sleep);
    // 扫官方源这一步崩了、超时了：bin/discover.mjs 自己没来得及记，这里记一次没读通（lib/discover-fresh.mjs）。
    if (stage === "discover") try { noteDiscoverMiss(e.killed || /timeout|timed out|SIGTERM/i.test(e.message) ? `跑了 ${Math.round(timeout / 60000)} 分钟没跑完` : "中途出错停了"); } catch (err) { noteSwallowed('cycle.noteDiscoverMiss', err, { member: 'scout', doing: '记下这次找岗位没跑成', then: '团队页上的「上次找岗位」这次没更新' }); }
    results.push({ stage, status: "error", error: e.message.slice(0, 300), ms: Date.now() - started, ...asleep });
    reviewHeld(stage, e.killed || /timeout|timed out|SIGTERM/i.test(e.message) ? "本轮超时停止，旧判断继续排队" : "本轮判断进程出错，旧判断继续排队");
    ledger.closeStage(stageJob, results.at(-1));
    await saveProgress();
    event(actor, stage, "fail", e.message.slice(0, 300), { duration_ms: Date.now() - started, ...asleep });
  }
}
const { discoveryOutcome, DISCOVERY_STAGES } = await import('../lib/discovery-outcome.mjs');
const scanOutcome = discoveryOutcome(results);
const unmanned = ledger.unmannedStages(results);
const partial = scanOutcome.status === 'partial' && !unmanned.length && !results.some(r => !DISCOVERY_STAGES.has(r.stage) && ['error','degraded','failed'].includes(r.status));
const changed = results.some((r) => ["changed", "sent", "prepared"].includes(r.status) || r.applied > 0),
  failed = results.some((r) => ["error", "degraded", "failed"].includes(r.status)),
  skipped = results.filter((r) => r.status === "skipped" && r.reason === "cycle_budget").map((r) => r.stage),
  held = results.filter((r) => r.reason === "spend_cap").map((r) => r.stage),
  cycleAsleep = sleptField(cycleSleep),
  // App 的开关关着时各步没排的、只有本机 AI 能做的事（lib/capabilities.mjs localAiReady）：一轮只记一行（主会话 10-02）。
  localLine = localAiLine(results);
if (localLine) event("heartbeat", "cycle", "skip", localLine);
event("heartbeat", "cycle", partial ? "ok" : failed || scanOutcome.status === 'failed' ? "fail" : changed ? "ok" : next_actions.length ? "waiting_user" : "skip", `${partial ? scanOutcome.text : `本轮${failed ? "存在失败" : changed ? "有更新" : next_actions.length ? "等待宿主处理" : "无变化"}`}${skipped.length ? `；时间预算用完，跳过 ${skipped.join("、")}` : ""}${held.length ? `；今天的花费上限到了，${held.join("、")} 留到明天` : ""}`, { duration_ms: Date.now() - cycleStarted, ...cycleAsleep });
ledger.closeCycle(cycleJob, { results, failed: results.filter((r) => ["error", "degraded", "failed"].includes(r.status)), unmanned, summary: `本轮${changed ? "有更新" : "没有新的"}${skipped.length ? `；时间预算用完，跳过 ${skipped.length} 步` : ""}${held.length ? `；花费上限到了，${held.length} 步留到明天` : ""}` });
// 每一步一张例行卡（lib/tasks.mjs cycleRoutines，方案-任务即对话 第二节 4），卡就是这一轮那一步的子活：建不成不影响这一轮。
try { await (await import("../lib/tasks.mjs")).cycleRoutines(results, { cycle: cycleJob?.id || null }); } catch (e) { noteSwallowed('cycle.routines', e, { doing: '把这一轮各步的结果记到任务卡上', then: '这一轮照常结束，任务页上少几张卡' }); }
console.log(JSON.stringify(log("cycle", { mode, ...(judge ? { judge: true } : {}), ...(discoverToo ? { discover: true } : {}), status: partial ? 'partial' : failed || scanOutcome.status === 'failed' ? "degraded" : changed ? "changed" : next_actions.length ? "needs_host_connector" : "no_change", ...(results.some(r => DISCOVERY_STAGES.has(r.stage)) ? { discovery: scanOutcome, summary: scanOutcome.text } : {}), budget_ms: budget.total, elapsed_ms: Date.now() - cycleStarted, ...cycleAsleep, ...(skipped.length ? { skipped } : {}), ...(localLine ? { local_ai_skipped: localLine } : {}), ...(held.length ? { spend_held: held } : {}), results, next_actions })));
