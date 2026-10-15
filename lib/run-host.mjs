import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from './spawn.mjs';
// Which machine runs the radar (config/host.json run_host). macOS gethostname()
// follows the network: on some Wi-Fi it becomes a DHCP name, and a workbench
// that compared only os.hostname() would stop its Feishu listener for good
// (2026-09-23). LocalHostName / HostName do not move with the network, so a
// machine is the run host when any of its names matches.
const short = (s) => String(s || '').trim().split('.')[0].toLowerCase();
// scutil 用绝对路径：launchd 起的服务 PATH 里没有 /usr/sbin，按名字找不到它，备用判断从来没生效过
// （重启后 gethostname 可能变成 IP，工作台就会每 10 秒起一次又退出）。
export function machineNames({ hostname = os.hostname(), platform = process.platform, scutil = (key) => execFileSync('/usr/sbin/scutil', ['--get', key], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  const names = new Set([short(hostname)]);
  if (platform === 'darwin') for (const key of ['LocalHostName', 'HostName']) { try { names.add(short(scutil(key))); } catch {} }
  names.delete('');
  return names;
}
// 公开版 config/host.json 里的示例值 your-mac.local 当作没填：谁照着样例装都不会因为主机名对不上
// 被挡在外面（工作台、周期、巡检、执行器全部静默退出）。要锁定机器就改成真实主机名。
export const PLACEHOLDER_RUN_HOST = 'your-mac.local';
export const isRunHost = (host, names = machineNames()) => !host || short(host) === short(PLACEHOLDER_RUN_HOST) || names.has(short(host));

// 这台机器能不能开工（兜底清单 I05：读不到、读坏了就不跑，不能悄悄当成「哪台都行」）。返回 { ok, why, other }：
//   config/host.json 不存在、没写 run_host、写的是示例值：照旧放行（照样例新装的不会被挡在外面，见上面）；
//   文件在但读不了、不是合法的 JSON、run_host 不是文字：不放行，why 写原因（other: false）；
//   run_host 是别的机器：不放行（other: true，和以前一样安静地让给那台）。
export function hostGate({ file = 'config/host.json', names = null } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { ok: true, why: null, other: false } : { ok: false, why: `config/host.json 读不了（${e.code || e.message}），先不开工`, other: false }; }
  let conf;
  try { conf = JSON.parse(text); } catch (e) { return { ok: false, why: `config/host.json 不是合法的 JSON（${e.message}），先不开工`, other: false }; }
  const host = conf && typeof conf === 'object' ? conf.run_host : undefined;
  if (host != null && typeof host !== 'string') return { ok: false, why: 'config/host.json 的 run_host 不是文字，先不开工', other: false };
  if (!host || short(host) === short(PLACEHOLDER_RUN_HOST)) return { ok: true, why: null, other: false };
  if (!(names || machineNames()).has(short(host))) return { ok: false, why: `run_host 是 ${host}，不是这台机器`, other: true };
  return { ok: true, why: null, other: false };
}
