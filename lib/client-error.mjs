// 页面自己出的错记进运行日志（POST /api/client-error，web/app.js pageError）。
// 运行日志里一句人话：「页面『任务』在『后台更新』这一步出了错」，归 System；原文（去掉钥匙、令牌）存成证据文件挂在这一条上。
// 同一页、同一步、同一句话 10 分钟只记一次：后台每推一批就再错一次的，不刷屏。
import { event } from './events.mjs';
import { write, today } from './store.mjs';
import { redact } from './error-evidence.mjs';

const WINDOW_MS = 10 * 60000;
const seen = new Map(); // key -> 上次记的时间
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// 页面、步骤名进日志那一句：只留中文、字母、数字和常见标点，别的（引号、尖括号、链接）去掉；没有就说「某一页」「某一步」。
const label = (v, fallback) => clean(v, 30).replace(/[^\p{Script=Han}A-Za-z0-9 ·、（）()/-]/gu, '').trim() || fallback;

export function recordClientError({ page, step, message, stack } = {}, { now = Date.now() } = {}) {
  const p = label(page, '某一页'), s = label(step, '某一步'), raw = clean(message, 2000);
  const key = `${p}|${s}|${raw}`;
  for (const [k, at] of seen) if (now - at >= WINDOW_MS) seen.delete(k);
  if (seen.has(key)) return { ok: true, logged: false };
  seen.set(key, now);
  const ref = `runs/${today()}/client-error-${now}.json`;
  write(ref, { page: p, step: s, at: new Date(now).toISOString(), message: redact(raw), stack: redact(clean(stack, 4000)) });
  event('system', 'client-error', 'fail', `页面「${p}」在「${s}」这一步出了错`, { refs: [{ file: ref }] });
  return { ok: true, logged: true };
}
