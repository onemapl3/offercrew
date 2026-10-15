// 系统的本地时区：runs/<YYYYMMDD> 分目录、「今天」、安静时段、每天几点跑、卡片和看板上的时间
// 都按它算。来自 config/host.json `timezone`，没写（或写了不认识的名字）就是 Asia/Shanghai ——
// 本人在上海，缺省值就是改动之前写死在各处的那个时区，行为不变；公开版的用户改 host.json 一处即可。
//
// 进程启动时读一次，和以前改代码一样要重启才生效：日期目录、去重窗口在一次运行里不能换时区。
// 只依赖 node 自带模块——store.mjs 的 today() 也用它，这里不能反过来 import store.mjs。
// bin/host/*.sh 用同一条规则自己读（node -e），见 radar-cycle.sh 开头。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayIn } from './vocab.mjs';

export const DEFAULT_TZ = 'Asia/Shanghai';
const root = process.env.RADAR_ROOT || fileURLToPath(new URL('../', import.meta.url));

export function validZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return true; } catch { return false; } // 兜底：不认识的时区就不用它
}
// `host` 给测试直接传一份 host.json；不传就读 RADAR_ROOT 下的文件。
export function configuredZone(host) {
  if (host === undefined) { try { host = JSON.parse(fs.readFileSync(path.join(root, 'config/host.json'), 'utf8')); } catch { host = {}; } } // 兜底：没有 host.json 就用默认时区
  return validZone(host?.timezone) ? host.timezone.trim() : DEFAULT_TZ;
}
export const TZ = configuredZone();
// 那一刻是当地哪一天（YYYY-MM-DD；认不出的时间给空串）。全系统「今天」「按天分组」都用它（rebuild7/one-source：以前十来份各写各的，有的按 UTC）。
export const dayOf = (x, tz = TZ) => dayIn(x, tz);

// 给人和对话模型看的绝对时间；数据仍保存 ISO，展示时才转换。
export function localTime(value, tz = TZ) {
  if (value == null || value === '') return '';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return String(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
// 相对日按两端的本地日历算；午夜和夏令时都不按相差几小时猜。
export function relativeDay(value, now = Date.now(), tz = TZ) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : dayOf(value, tz), current = dayOf(now, tz);
  if (!day || !current) return '';
  const n = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${current}T00:00:00Z`)) / 86400000;
  return ({ '-1': '昨天', 0: '今天', 1: '明天' })[n] || day;
}
// 模型给绝对日期附相对词时，仍按本轮时钟核对；历史消息原文不重写。
export function relativeDates(text, now = Date.now(), tz = TZ) {
  return String(text || '').replace(/(\d{4}-\d{2}-\d{2})\s*[（(](?:今天|明天|昨天)[）)]/g, (_, day) => {
    const word = relativeDay(day, now, tz);
    return word === day ? day : `${day}（${word}）`;
  });
}
export function localTimes(value) {
  if (typeof value === 'string') return value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, at => localTime(at));
  if (Array.isArray(value)) return value.map(localTimes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, localTimes(v)]));
  return value;
}

const HOUR_FMT = new Map(), OFFSET_FMT = new Map();
const formatter = (cache, tz, options) => { let f = cache.get(tz); if (!f) cache.set(tz, f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...options })); return f; };
// 当地的小时（0–23）。
export const localHour = (now = Date.now(), tz = TZ) => Number(formatter(HOUR_FMT, tz, { hour: '2-digit', hourCycle: 'h23' }).format(now));
// 那一刻当地相对 UTC 的偏移，如 '+08:00'。
// 无效时刻按现在算（调用方随后自己判无效，报错不变）。
export function utcOffset(at = Date.now(), tz = TZ) {
  const when = Number.isFinite(new Date(at).getTime()) ? new Date(at) : new Date();
  const name = formatter(OFFSET_FMT, tz, { timeZoneName: 'longOffset' }).formatToParts(when).find((p) => p.type === 'timeZoneName')?.value || '';
  const m = name.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  return m ? `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}` : '+00:00';
}
const offsetMs = (at, tz) => { const [, sign, h, m] = utcOffset(at, tz).match(/([+-])(\d{2}):(\d{2})/); return (sign === '-' ? -1 : 1) * (Number(h) * 60 + Number(m)) * 60000; };
// 当地某一天（YYYY-MM-DD）某个钟点（HH:mm[:ss]）对应的时刻，毫秒。以前各处写
// Date.parse(`${day}T00:00:00+08:00`)；上海没有夏令时，结果逐毫秒相同。有夏令时的时区按那一刻的偏移换算。
// 当地「几天后的某个钟点」的时刻（毫秒）：「过两天再说」= 后天 09:00。
export function daysLaterAt(days, time = '09:00:00', now = Date.now(), tz = TZ) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  return zonedTime(new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10), time, tz);
}
export function zonedTime(day, time = '00:00:00', tz = TZ) {
  const naive = Date.parse(`${day}T${time}Z`);
  if (!Number.isFinite(naive)) return NaN;
  const guess = naive - offsetMs(naive, tz);
  return naive - offsetMs(guess, tz);
}
