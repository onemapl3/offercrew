// Radar 上一次真的找过岗位（扫官方源 bin/discover.mjs 读通了）是什么时候；多久没找了算「太久」；醒来补跑要不要带上找岗位。
//
// 10-10 负责人真实数据：最后一次找岗位是 10-06 02:33，之后 4 天一个新岗位都没有。合盖错过 09:05 / 13:05 / 18:05 这几档完整周期，
// 醒来只补轻量周期（带判断，不找岗位），笔记本天天这样，Radar 就天天不找；团队页上只写着 10-06 那次「扫真人帖没跑成」。
//
// 记在 state/discover-last.json：
//   ok_at / ok_added   最近一次读通（至少一个源读到了、不是整机断网）的时间和新收几条
//   tried_at / tried_ok / tried_why   最近一次试的结果（没读通时一句人话原因）
// 写的人：bin/discover.mjs 每次扫完（只扫一家的 --company 不算）；周期里这一步崩了、超时了，bin/cycle.mjs 记一次没读通。
// 老数据没有这个文件：从 runs/<日期>/discover-<毫秒>.json（bin/discover.mjs 的 log）往回找最近一次读通的，最多看 21 天。
//
// 两条线（主会话 10-10 让我定）：
//   补跑带不带找岗位（discoverDue）：上一次读通早于最近一档已经过了的完整周期（discovery_hours 的 :05），那一档的找岗位就丢了，补。
//     比「超过 N 小时」准：18:05 读通、第二天 08:40 醒来不补（09:05 还没到）；09:05 那档没找成、10:20 醒来就补。
//   页面上说「太久没找」（staleText）：超过 24 小时没读通。一天三档，偶尔错过一档是常事，不吓人；整整一天没找到才直说。
import fs from 'node:fs';
import { read, write, file } from './store.mjs';
import { TZ } from './tz.mjs';
import { fullHour } from './cycle-mode.mjs';

export const DISCOVER_LAST = 'state/discover-last.json';
export const STALE_MS = 24 * 3600000;
const HOUR = 3600000, DAY = 24 * HOUR, LOOKBACK_DAYS = 21;
const T = x => { const t = Date.parse(x || ''); return Number.isFinite(t) ? t : null; };

// 一次扫官方源（bin/discover.mjs 的结果）算不算读通：读到了岗位，或者没有整机断网、而且至少有一个源这次没出错。
// 一个源都没配（新装、全关了）也算：它照常跑完了，没有可读的。
export function discoverRead(r = {}) {
  if (!r || typeof r !== 'object') return false;
  if (Number(r.raw) > 0) return true;
  if (r.network_outage) return false;
  const n = Array.isArray(r.sources) ? r.sources.length : 0;
  if (!n) return true;
  return (Number(r.broken) || 0) + (Number(r.failing) || 0) < n;
}
// 没读通时的一句原因（人话；页面上接在「那次没扫成：」后面）。
export function discoverWhy(r = {}) {
  if (r?.network_outage) return '这台电脑当时连不上网';
  const n = Array.isArray(r?.sources) ? r.sources.length : 0;
  return n ? `${n} 个官方源一个都没读通` : '没跑完';
}

// bin/discover.mjs 扫完：记一笔。返回写下的那份。
export function noteDiscover(result, { now = Date.now() } = {}) {
  const prev = read(DISCOVER_LAST, {}) || {}, at = new Date(now).toISOString(), ok = discoverRead(result);
  const next = { ...prev, tried_at: at, tried_ok: ok, tried_why: ok ? null : discoverWhy(result), ...(ok ? { ok_at: at, ok_added: Number(result?.added) || 0 } : {}) };
  write(DISCOVER_LAST, next);
  return next;
}
// 周期里扫官方源这一步崩了、超时了、被预算挤掉了（bin/discover.mjs 自己没来得及记）：记一次没读通。why 是人话。
export function noteDiscoverMiss(why, { now = Date.now() } = {}) {
  const prev = read(DISCOVER_LAST, {}) || {};
  const next = { ...prev, tried_at: new Date(now).toISOString(), tried_ok: false, tried_why: String(why || '没跑完').slice(0, 120) };
  write(DISCOVER_LAST, next);
  return next;
}

// 老数据（还没有 state/discover-last.json）：runs/<YYYYMMDD>/discover-<毫秒>.json 里最近一次读通的。
function fromRuns(now) {
  let days = [];
  try { days = fs.readdirSync(file('runs')).filter(d => /^\d{8}$/.test(d)).sort().reverse(); } catch { return null; } // 兜底：还没有 runs 目录就是没扫过
  const floor = now - LOOKBACK_DAYS * DAY;
  for (const d of days) {
    let names = [];
    try { names = fs.readdirSync(file(`runs/${d}`)).filter(n => /^discover-\d+\.json$/.test(n)).sort((a, b) => Number(b.slice(9, -5)) - Number(a.slice(9, -5))); } catch { continue; } // 兜底：这一天的目录读不了，看前一天
    for (const n of names) {
      const at = Number(n.slice(9, -5));
      if (at > now + 60000) continue;
      if (at < floor) return null;
      const r = read(`runs/${d}/${n}`, null);
      if (discoverRead(r)) return { ok_at: new Date(at).toISOString(), ok_added: Number(r.added) || 0 };
    }
  }
  return null;
}
// 最近一次读通 { at, added }，和最近一次试的结果 { tried_at, tried_ok, tried_why }；从没读通过 at 是 null。
export function lastDiscover({ now = Date.now(), state = null } = {}) {
  const s = state || read(DISCOVER_LAST, null) || {};
  const ok = s.ok_at ? s : fromRuns(now) || {};
  return { at: ok.ok_at || null, added: ok.ok_added ?? null, tried_at: s.tried_at || null, tried_ok: s.tried_ok ?? null, tried_why: s.tried_why || null };
}

// 本地时区里这一刻是几点（0–23）。
const hourIn = t => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(t));
// 最近一档已经到了的完整周期（discovery_hours 那几个钟点的 :05）。往回最多看两天。
export function lastFullSlot(now = Date.now(), pipeline = {}) {
  const top = Math.floor(now / HOUR) * HOUR;
  for (let k = 0; k <= 48; k++) {
    const t = top - k * HOUR + 5 * 60000;
    if (t <= now && fullHour(hourIn(t), pipeline)) return t;
  }
  return null;
}
// 补跑（醒来、错过的定时周期补上来的那一轮）要不要带上找岗位：上一次读通早于最近一档完整周期。
export function discoverDue({ now = Date.now(), pipeline = {}, last = null } = {}) {
  const at = T((last || lastDiscover({ now })).at);
  const slot = lastFullSlot(now, pipeline);
  return at == null || (slot != null && at < slot);
}

// ── 页面上那一句（团队页 Radar 卡、成员页头上）────────────────────────────────
const parts = t => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t).map(x => [x.type, x.value]));
const dayKey = t => { const p = parts(t); return `${p.year}-${p.month}-${p.day}`; };
// 「今天 09:41」「昨天 18:07」「10-06 02:33」（不是今年的带年份）。
export function whenText(at, now = Date.now()) {
  const t = T(at);
  if (t == null) return '';
  const p = parts(t), hm = `${p.hour}:${p.minute}`;
  if (dayKey(t) === dayKey(now)) return `今天 ${hm}`;
  if (dayKey(t) === dayKey(now - DAY)) return `昨天 ${hm}`;
  return `${p.year === parts(now).year ? '' : `${p.year}-`}${p.month}-${p.day} ${hm}`;
}
const ageText = ms => ms >= 2 * DAY ? `${Math.floor(ms / DAY)} 天` : `${Math.floor(ms / HOUR)} 小时`;

// { stale, tag, text, at }：stale 时 text 直说多久没找、上次是什么时候，最近一次试过却没读通的加上那次的原因。
export function discoverLine({ now = Date.now(), last = null } = {}) {
  const L = last || lastDiscover({ now }), at = T(L.at);
  const failed = L.tried_ok === false && T(L.tried_at) != null && (at == null || T(L.tried_at) > at) ? `；${whenText(L.tried_at, now)} 那次没扫成：${L.tried_why || '没跑完'}` : '';
  if (at == null) return { stale: true, tag: '没找过', text: `还没找到过岗位${failed}`, at: null };
  const ago = now - at, added = L.added == null ? '' : L.added > 0 ? `，新收 ${L.added} 条` : '，没有新的';
  if (ago > STALE_MS) return { stale: true, tag: '太久没找', text: `${ageText(ago)}没找新岗位了，上次是 ${whenText(L.at, now)}${failed}`, at: L.at };
  return { stale: false, tag: '上次找岗位', text: `${whenText(L.at, now)}${added}`, at: L.at };
}
