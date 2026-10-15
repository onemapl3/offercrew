// 工作台开着时实时收新信（方案-内置邮箱 §四.3「App 开着时再实时收新信」）：一条常驻的只读连接（EXAMINE INBOX + IDLE），
// 服务器说收件箱里多了信（EXISTS 变大），等一小会儿就跑一次读信（lib/mail/inbox.mjs runMailRead：自己另开一条短连接、
// 拿锁、按游标读，和每小时的巡检是同一件事，读过的不会再读）。这条常驻连接只听，不取信。
//   不开    没连邮箱、授权码失效或解不开（等你重新填）；演示 / 沙盒模式和不跑后台任务的工作台不启动它（bin/serve.mjs 决定）。
//   时段    只在收件箱巡检的时段里触发（lib/command-center.mjs MAIL_POLL_HOURS，09:00–21:00），Watcher 被暂停时不读；
//           窗口外到的信，下一次读信接着读。
//   频率    连上（含重连）时补读一次；新信来了等 debounce 再读，两次读信至少隔 minGap：QQ、163 限制登录频率。
//   断线    退避重连：1、2、5、15、30 分钟。
//   换号    每分钟看一眼账号和授权码文件：断开了、换了邮箱、重新填了授权码，就关掉旧连接，按新的来。
//   出错    连不上、断线、读信出错，连续 3 次记一行运行日志（说原因），恢复了再记一行（兜底清单 I08）；中间的不重复记。
import fs from 'node:fs';
import { file } from '../store.mjs';
import { TZ } from '../tz.mjs';
import { MAIL_POLL_HOURS } from '../app-schedule.mjs';
import { openInbox, routesFor, explain } from './connect.mjs';
import { loadAccount, loadSecret, SECRET_FILE } from './vault.mjs';
import { mailTarget, SKIP_STATUS } from './inbox.mjs';
import { agentPaused } from '../agents.mjs';
import { event } from '../events.mjs';

const hourOf = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(t));
export const inPatrolHours = (t = Date.now()) => { const h = hourOf(t); return h >= MAIL_POLL_HOURS[0] && h < MAIL_POLL_HOURS[1]; };
// 账号文件里只有 checked_at / status 变了（读信、测试会写）不算换号：只看地址、邮箱类型、登录名和授权码文件。
const identity = () => { const a = loadAccount(); try { return a ? [a.address, a.provider, a.login || '', a.imap_user || '', JSON.stringify(a.servers || null), fs.statSync(file(SECRET_FILE)).mtimeMs].join('|') : null; } catch { return null; } }; // 兜底：账号或密钥文件不在就没有身份，当没接邮箱

export function startMailLive({ run, inWindow = inPatrolHours, paused = () => agentPaused('owl'), now = Date.now, env = process.env, limits = {},
  backoff = [60000, 120000, 300000, 900000, 1800000], debounceMs = 15000, minGapMs = 60000, checkMs = 60000, idleMs = 2000,
  note = (status, msg) => event('owl', 'mail-live', status, msg) } = {}) {
  let client = null, who = null, stopped = false, fails = 0, closing = false, running = false, lastRun = 0, runFails = 0, told = { conn: false, run: false };
  // 连续出错到第 3 次说一声，恢复时再说一声。
  const failed = (what, err) => {
    const n = what === 'conn' ? fails : runFails;
    if (n < 3 || told[what]) return;
    told[what] = true;
    const why = err ? explain(err).reason || String(err.message || err).slice(0, 120) : '连接断了';
    note('fail', what === 'conn' ? `实时收信连续 ${n} 次连不上邮箱（${why}），每小时的巡检照常读` : `实时收信连续 ${n} 次读信出错（${why}），每小时的巡检照常读`);
  };
  const recovered = (what) => { if (told[what]) { told[what] = false; note('ok', what === 'conn' ? '实时收信重新连上邮箱了' : '实时收信读信恢复了'); } };
  let tickTimer = null, runTimer = null;
  const state = { connected: false, fails: 0, runs: 0 };

  const later = (ms) => { clearTimeout(tickTimer); if (!stopped) { tickTimer = setTimeout(tick, ms); tickTimer.unref?.(); } };
  const retry = (err) => { fails++; state.fails = fails; failed('conn', err); later(backoff[Math.min(fails, backoff.length) - 1]); };

  function trigger() {
    if (stopped || !inWindow(now())) return;
    clearTimeout(runTimer);
    runTimer = setTimeout(fire, Math.max(debounceMs, lastRun + minGapMs - now()));
    runTimer.unref?.();
  }
  async function fire() {
    if (stopped || paused()) return; // Watcher 在指挥台上被暂停了：和每小时的巡检一样不读
    if (running) return trigger();
    running = true; lastRun = now(); state.runs++;
    try { await run(); runFails = 0; recovered('run'); } catch (e) { runFails++; failed('run', e); } finally { running = false; }
  }
  async function close() {
    const c = client; client = null; who = null; state.connected = false;
    if (!c) return;
    closing = true;
    try { await c.logout(); } catch { try { c.close(); } catch {} } finally { closing = false; } // 兜底：连接已经断了就直接关
  }
  async function connect() {
    const account = loadAccount();
    if (!account || SKIP_STATUS.has(account.status)) return later(checkMs);
    const t = mailTarget(account);
    if (t.skip) return later(checkMs);
    let pass;
    try { pass = await loadSecret(account); } catch { return later(checkMs); }
    const opened = await openInbox(t.target, pass, { routes: routesFor('imap', t.target, { provider: t.provider, env }), limits, ...(account.imap_user ? { users: [account.imap_user] } : {}), options: { disableAutoIdle: false, autoIdleDelay: idleMs, maxIdleTime: 10 * 60000 } });
    if (stopped) { try { await opened.client.logout(); } catch {} return; } // 兜底：连接已经断了
    client = opened.client; who = identity(); fails = 0; state.fails = 0; state.connected = true; recovered('conn');
    client.on('exists', (e) => { if (e.count > e.prevCount) trigger(); });
    client.on('close', () => { if (closing || stopped) return; client = null; who = null; state.connected = false; retry(); });
    trigger(); // 连上（含重连）补读一次：断线那段时间到的信
    later(checkMs);
  }
  async function tick() {
    if (stopped) return;
    if (client) {
      if (identity() !== who) { await close(); return tick(); }
      return later(checkMs);
    }
    try { await connect(); } catch (e) { retry(e); }
  }
  tick();
  return {
    state,
    async stop() { stopped = true; clearTimeout(tickTimer); clearTimeout(runTimer); await close(); },
  };
}
