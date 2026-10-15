#!/usr/bin/env node
// 引擎自己读一次信（内置邮箱第 2 批，lib/mail/inbox.mjs）：连上的邮箱里新到的信 → 配线索 → 文字模型判断 → 更新线索、登记来信。
// 每小时的收件箱巡检（bin/host/mail-poll.sh）接了内置邮箱就跑它；也可以手动跑。输出一行 JSON（不含信的内容）。
//   没连邮箱：什么都不做。上次是授权码不对：等你重新填，不拿坏的码反复登录。另一次读信还没完：这次跳过。
//   --patrol：App 的定时（lib/app-schedule.mjs）每小时整点拉起时带上，和 bin/host/mail-poll.sh 一样只在巡检时段（09:00–21:00）、
//   Watcher 没被暂停时读；命令行安装经 mail-poll.sh 来，那边已经看过了。
import { pollLine } from '../lib/mail/inbox.mjs';
import { requestAction } from '../lib/action-kinds.mjs';
import { runWorker } from '../lib/workers.mjs';
import { identity } from '../lib/capabilities.mjs';
import { inPatrolHours } from '../lib/mail/live.mjs';
import { agentPaused } from '../lib/agents.mjs';

if (process.argv.includes('--patrol') && (!inPatrolHours() || agentPaused('owl'))) {
  const reason = inPatrolHours() ? 'watcher_paused' : 'outside_patrol_hours';
  if (reason === 'watcher_paused') try { pollLine(0, `skipped:${reason}`); } catch { /* 兜底：只是巡检日志少一行「暂停着没读」，读信本来就没做 */ } // 巡检时段外不记：每天夜里本来就不读
  console.log(JSON.stringify({ status: 'skipped', reason }));
  process.exit(0);
}
// 读信是一个动作（契约 2.3、2.5）：经 requestAction 记一条 read_mail（不用确认；同一时间只排一次），就在这个进程里由 worker 领走、
// 读、回执（lib/workers.mjs runWorker）。整点巡检、周期里那一步、成员页「收件箱巡检」都走这一条，账上都看得到「N 封新回复」「没有新的」。
//   RADAR_JOB_ID：操作台起它时带上的那件活（任务卡自己那件）：动作挂在它上面，不另开。周期里当一步跑（--stage）时不挂：那件活是整轮的。
const stage = process.argv.includes('--stage');
const origin = process.argv.includes('--patrol') || stage ? 'schedule' : process.env.RADAR_JOB_ID ? 'card' : 'system';
const req = await requestAction('read_mail', {}, { origin, confirm: false, kick: () => false, job_id: stage ? null : process.env.RADAR_JOB_ID || null });
let r;
if (req.sandbox) r = { status: 'failed', kind: 'sandbox' };
else if (req.blocked) {
  const I = identity();
  r = !I.mail.connected ? { status: 'no_change', reason: 'not_connected' } : I.sandbox ? { status: 'failed', kind: 'sandbox' } : { status: 'skipped', reason: 'blocked', why: req.reason };
} else {
  let w = {};
  try { w = await runWorker('read_mail'); } catch (e) { w = { claimed: 1, error: String(e.message || e).slice(0, 200) }; }
  r = w.result || (w.claimed ? { status: 'error' } : { status: 'skipped', reason: 'another_mail_read_running' });
}
console.log(JSON.stringify(r));
// --stage：周期（bin/cycle.mjs）里当一步跑，没读成写在输出里（status failed），不以非零退出——周期按输出写「没读成：…」。
if (r.status === 'failed' && !process.argv.includes('--stage')) process.exitCode = 1;
