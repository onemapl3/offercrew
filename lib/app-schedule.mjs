// 桌面版的定时（替代 launchd）：在工作台进程里到点拉起周期和晚报。
// 电脑睡过去错过的，醒来后的第一拍每种只补一次（和 launchd 的 StartCalendarInterval 一样）；
// 合盖用电池时跳不跳由周期自己判断（bin/app-cycle.mjs，lib/cycle-catchup.mjs）。
//
// 只有引擎的那一段（命令行版 10-04 冻结）：周期跑 bin/app-cycle.mjs → bin/scheduled.mjs，不起 bin/host/radar-cycle.sh，
// 不排飞书晚报，不拉起本机 AI。读信由能力表说了算（lib/capabilities.mjs mailReader，工作台算好传进来）：引擎能读就每小时整点
// 跑一次 bin/mail-read.mjs --patrol（只在巡检时段、Watcher 没暂停时读，经 requestAction('read_mail') 记账）。
// 这里不引 lib/capabilities.mjs：桌面壳的主进程也加载这个文件，只为读周期的时间。
import { spawn as nodeSpawn } from './spawn.mjs';

const TIMES = { cycle: ['09:05', '13:05', '18:05'] };
// 这一拍的表。cmd 不写就是 /bin/zsh；周期是 node 脚本，用工作台自己的 node（桌面版里是 App 自带的那个）。
// mail：引擎能读信（工作台按能力表算好传进来）。
export function appSchedule({ mail = false } = {}) {
  return [
    { name: 'cycle', times: TIMES.cycle, cmd: process.execPath, args: ['bin/app-cycle.mjs'] },
    ...(mail ? [{ name: 'mail', hourly: true, cmd: process.execPath, args: ['bin/mail-read.mjs', '--patrol'] }] : []),
  ];
}
// 桌面壳（desktop/main.mjs）读周期的时间；表本身每一拍按 appSchedule() 重算。
export const APP_SCHEDULE = appSchedule();
const minuteClock = tz => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fires = (job, hhmm) => job.hourly ? hhmm.endsWith(':00') : job.times.includes(hhmm);
// 'YYYYMMDD-HHMM'，和补跑标记 state/cycle-catchup.json 的 slot 同一个写法（lib/cycle-catchup.mjs）。
const slotKey = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
};

// (prev, now] 之间到点的任务，和每种最后到点的那一档（{ cycle: '20261002-0905' }）。按分钟走一遍，最多看 36 小时
// （再长的睡眠也只补一次）。睡过好几档的，补的那一轮算最后一档的。
export function dueSlots({ prev, now, tz, jobs = APP_SCHEDULE }) {
  const due = {};
  const clock = minuteClock(tz);
  const start = Math.max(prev, now - 36 * 3600000);
  for (let t = Math.floor(start / 60000) * 60000 + 60000; t <= now; t += 60000) {
    const hhmm = clock.format(t);
    for (const j of jobs) if (fires(j, hhmm)) due[j.name] = t;
  }
  return Object.fromEntries(Object.entries(due).map(([name, t]) => [name, slotKey(t, tz)]));
}
export const dueJobs = opts => Object.keys(dueSlots(opts));

export function startAppSchedule({ root, spawn = nodeSpawn, now = Date.now, every = 30000, tz, jobs = () => appSchedule() }) {
  const running = new Map();
  let prev = now();
  const tick = () => {
    const t = now(), table = jobs();
    for (const [name, slot] of Object.entries(dueSlots({ prev, now: t, tz, jobs: table }))) {
      const cur = running.get(name);
      if (cur && cur.exitCode === null) continue;
      const job = table.find(j => j.name === name);
      // RADAR_SLOT：这一轮是为哪一档跑的。醒来补跑时按它定带不带判断（bin/scheduled.mjs，lib/cycle-mode.mjs），合盖跳过时
      // 补跑标记也记这一档（bin/app-cycle.mjs），而不是醒来的钟点。
      const child = spawn(job.cmd || process.execPath, job.args, { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, RADAR_SLOT: slot } });
      child.unref?.();
      running.set(name, child);
    }
    prev = t;
  };
  const timer = every ? setInterval(tick, every) : null;
  timer?.unref?.();
  return { tick, stop: () => timer && clearInterval(timer) };
}

// 收件箱巡检（bin/host/mail-poll.sh）只在本地时间 [09:00, 21:00) 里跑：launchd 每小时拉起一次，窗口外的那几次一进来就退出、
// 不记日志（09-30 #27：负责人定的时段，和手机 21:00 起的夜间静默对上）。几处写法一致由 tests/mail-poll-hours.test.mjs 看着。
export const MAIL_POLL_HOURS = [9, 21];
// 展示实际整点：窗口右端不包含，21:00 已停止，最后一轮是 20:00。
export const mailPollScheduleText = () => `每天 ${String(MAIL_POLL_HOURS[0]).padStart(2, '0')}:00–${String(MAIL_POLL_HOURS[1] - 1).padStart(2, '0')}:00，每小时整点`;

// 页面与调度器共用同一张表和本地时区，下一档也照实际触发规则算。
export function nextSchedule(job, { now = Date.now(), tz } = {}) {
  // 每次扫描共用一个 ICU 格式化器；睡眠补跑/隔夜计划不能每分钟分配一份原生对象。
  const clock = minuteClock(tz);
  for (let t = Math.floor(now / 60000) * 60000 + 60000; t <= now + 25 * 3600000; t += 60000) {
    const hm = clock.format(t);
    if (fires(job, hm) && (!job.hourly || (+hm.slice(0, 2) >= MAIL_POLL_HOURS[0] && +hm.slice(0, 2) < MAIL_POLL_HOURS[1]))) return new Date(t).toISOString();
  }
  return null;
}
