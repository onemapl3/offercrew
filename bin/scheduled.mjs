import '../lib/tool-path.mjs'; // 最先：补齐 launchd 精简 PATH 里缺的工具目录（lark-cli 在 nvm 里）
import { spawn } from "../lib/spawn.mjs";
import { root,read } from "../lib/store.mjs";
import { cycleBudget, KILL_GRACE_MS } from "../lib/cycle-budget.mjs";
import { TZ } from "../lib/tz.mjs";
import { scheduledArgs, budgetMode } from "../lib/cycle-mode.mjs";
import { discoverDue } from "../lib/discover-fresh.mjs";
const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const config=read('config/pipeline.json',{});
// 完整还是轻量按现在的钟点（config/pipeline.json discovery_hours）；App 的定时还告诉这一轮是为哪一档跑的（RADAR_SLOT，
// lib/app-schedule.mjs）：睡过完整档、醒来已经出了那个钟点，补的轻量周期带上判断（lib/cycle-mode.mjs，10-02 开箱第 3 轮 D）。
// 上一次读通的找岗位早于最近一档完整周期（lib/discover-fresh.mjs）：轻量的这一轮也带上找岗位（10-10）。
let stale = false;
try { stale = discoverDue({ pipeline: config }); } catch (e) { console.error(`[scheduled] 看不出上次找岗位是什么时候：${e.message}`); }
const args = scheduledArgs({ hour, slot: process.env.RADAR_SLOT || null, pipeline: config, stale }), mode = args[1];
// 守卫与阶段预算同源（lib/cycle-budget.mjs）：cycle.mjs 自己按墙钟预算收尾、尾段必跑，这里只防它卡死，
// 所以比预算多一段余量，并且只算醒着的时间（每拍最多记两拍长，合盖睡眠不算）。旧守卫
// （execFileSync 60 分钟）按墙钟计时，Mac 睡眠醒来后即使只醒了几分钟也会动手，连同没跑的尾段一起杀掉。
const { guard } = cycleBudget(budgetMode(mode, args.includes('--judge')), config), beat = Math.min(10000, guard / 4);
const child = spawn(process.execPath, ["bin/cycle.mjs", ...args], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
let out = "", awake = 0, last = Date.now(), stopped = false;
child.stdout.on("data", (d) => { out += d; });
const tick = setInterval(() => {
  const now = Date.now();
  awake += Math.min(now - last, 2 * beat); last = now;
  if (stopped || awake < guard) return;
  stopped = true;
  console.error(`[scheduled] cycle.mjs 醒着运行超过 ${Math.round(guard / 60000)} 分钟仍未结束，已终止`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
}, beat);
child.on("close", (code) => {
  clearInterval(tick);
  process.stdout.write(out);
  process.exitCode = stopped ? 124 : code ?? 1;
});
