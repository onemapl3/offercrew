// 「换了一种做法」的统一记录（兜底清单 design/handoff/hub/兜底清单.md 第一节「怎么一次性治」第 1 条）。
// 底座链换了下一个（A01 / A02）、执行器链换了下一项、浏览器引擎换了一个……所有「出错就换别的」的地方都调 noteFallback：
//   计数  state/fallbacks.json，按天：日期 → kind → from → { member, from_label, to: { <to>: { label, why: { <原因类别>: 次数 } } } }，
//         外加这一天见过的原因类别 → 给人看的那个短语（why_text）。只存数字和名字，不存内容、不存原始报错。
//   事件  同一处（kind + from + to）、同一个原因类别，一天只记一行：actor 是 member，「X 没调通（原因），改用 Y」，
//         带 kind、from、to、why_kind，why 只留过了 errorReason 的那一小段（不露原始报错、钥匙）。
// System 的健康账本（lib/system/health.mjs fallbackRows）读计数：今天换过的，每个 kind + from 一行。
// 写入：读、加、写；先写带进程号的临时文件再改名。几个进程同时写可能丢一次计数，无妨。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file } from './store.mjs';
import { event } from './events.mjs';
import { dayOf as tzDay } from './tz.mjs';
import { modelErrorKind, errorReason } from './say-error.mjs';
import { noteSwallowed } from './swallow.mjs';

export const FALLBACK_PATH = 'state/fallbacks.json';
const KEEP_DAYS = 7;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const dayOf = t => tzDay(t);
// 记录本身读坏了（兜底清单复核 N02）：不能让一份坏文件把所有「换了」都关掉。坏文件挪到旁边（.broken-<时间>）留着查，
// 记一条事件，从空的重新计；这一次的计数和事件照常。
function load() {
  const p = file(FALLBACK_PATH);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { days: {} }; }
  try { const s = JSON.parse(raw); if (s && typeof s === 'object' && !Array.isArray(s)) return s.days && typeof s.days === 'object' && !Array.isArray(s.days) ? s : { days: {} }; } catch {} // 兜底：读坏了往下走：坏文件挪开，记一条事件，从空的重新计
  const now = Date.now();
  // 别的进程刚挪走了：它记过事件，这里不再记。
  try { fs.renameSync(p, `${p}.broken-${now}`); } catch (e) { if (e.code === 'ENOENT') return { days: {} }; }
  try { event('system', 'fallback-ledger', 'error', `「换了一种做法」的记录读不出来，从空的重新计（坏文件留在 ${FALLBACK_PATH}.broken-${now}）`, { kind: 'fallbacks_unreadable' }); } catch {} // 兜底：记事件本身失败不影响「换了」照常计数
  return { days: {} };
}
function save(state) {
  const p = file(FALLBACK_PATH), tmp = `${p}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
  fs.renameSync(tmp, p);
}

// 原因类别：lib/say-error.mjs 那张表；表里没有的 5xx（对方服务器出错）在这里补一类，免得都成了「这次没做成」。
export function whyKind(why) {
  const k = modelErrorKind(why), m = String(why?.message ?? why ?? '');
  // 你配的兼容服务不认流式的 stream_options（lib/chat.mjs openaiComplete）：同一个模型去掉它再试，不是模型坏了。
  if (/^stream_options_unsupported\b/.test(m)) return { kind: 'stream_options', text: '不认 stream_options' };
  return k.kind === 'other' && /(?<!\d)5\d\d(?!\d)/.test(m) ? { kind: 'server', text: '对方服务出错' } : k;
}
// why：报错（Error 或一句话）。原因类别用 lib/say-error.mjs 的同一张表；沙盒拦下来的不算「换了」，不记。
// from / to：底座 id 之类的稳定名字；from_label / to_label：给人看的名字（不给就用 from / to）。
export function noteFallback({ kind, from, to, why = '', member = null, from_label = null, to_label = null, now = Date.now() } = {}) {
  if (!kind || !from || !to) return null;
  const k = whyKind(why);
  if (k.kind === 'sandbox') return null;
  const state = load(), day = dayOf(now), d = (state.days[day] ||= { why_text: {} });
  const place = ((d[kind] ||= {})[from] ||= { member: member || null, from_label: from_label || null, to: {} });
  if (member && !place.member) place.member = member;
  const target = (place.to[to] ||= { label: to_label || null, why: {} });
  const n = (target.why[k.kind] || 0) + 1;
  target.why[k.kind] = n;
  d.why_text = { ...(d.why_text || {}), [k.kind]: k.text };
  for (const old of Object.keys(state.days).sort().slice(0, -KEEP_DAYS)) delete state.days[old];
  try { save(state); } catch (e) { noteSwallowed('fallback.save', e, { member: member || 'patch', doing: '把「换了一种做法」记进计数', then: '这一次没计上，事件照记' }); }
  if (n === 1) {
    const X = from_label || from, Y = to_label || to;
    try { event(member || 'system', 'fallback', 'ok', `${X} 没调通（${k.text}），改用 ${Y}`, { kind, from, to, why_kind: k.kind, why: cut(errorReason(why), 80) }); } catch {} // 兜底：记事件本身失败不影响「换了」照常计数
  }
  return { day, kind, from, to, why_kind: k.kind, count: n };
}

// 今天（或某一天）换过的：每个 kind + from 一条 { kind, from, from_label, member, count, to, to_label, why_kind, why_text }，
// to / why 取次数最多的那个。
export function fallbacksOn({ now = Date.now(), state = load() } = {}) {
  const d = state.days[dayOf(now)] || {}, out = [];
  for (const [kind, places] of Object.entries(d)) {
    if (kind === 'why_text' || !places || typeof places !== 'object') continue;
    for (const [from, p] of Object.entries(places)) {
      let count = 0, top = null, whys = {};
      for (const [to, t] of Object.entries(p.to || {})) {
        const n = Object.values(t.why || {}).reduce((a, b) => a + b, 0);
        count += n;
        if (!top || n > top.n) top = { to, label: t.label, n };
        for (const [w, c] of Object.entries(t.why || {})) whys[w] = (whys[w] || 0) + c;
      }
      if (!count) continue;
      const why_kind = Object.entries(whys).sort((a, b) => b[1] - a[1])[0][0];
      out.push({ kind, from, from_label: p.from_label || null, member: p.member || null, count, to: top.to, to_label: top.label || null, why_kind, why_text: d.why_text?.[why_kind] || null });
    }
  }
  return out;
}
