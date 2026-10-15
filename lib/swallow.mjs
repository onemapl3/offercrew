// 吞下的错误记一笔（05 契约第一节第 9 项；01-问题考古 根 6「出错时悄悄兜底」）。
// 有些地方出错了也只能接着走（读不出缓存就当没有、清理没做成也不挡正事），但不能不留痕：
//   noteSwallowed(where, err, { member, doing, then })
// 在运行日志（state/events.ndjson）记一条 status 'warn'、step 'swallowed' 的事件：
//   msg       一句人话：「<doing>没做成（<原因>），<then>」
//   where     哪一处（模块.函数 之类的稳定名字），System 的健康账本按它归拢
//   evidence  原文留作证据：报错（脱敏、截断）和错误码
// 同一处、同一个原因，一个进程 10 分钟内只记一次，免得热路径把日志刷满。
// 记日志本身失败（磁盘满、目录没权限）不能把正常路径拖垮，所以这里自己吞，也不往外抛。
// 只依赖 events.mjs，底层模块（store、tz、model、chat……）也能用，不成环。
import { event } from './events.mjs';

export const SWALLOW_STEP = 'swallowed';
const QUIET_MS = 10 * 60000;
const seen = new Map();
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// 原文脱敏：钥匙、令牌、密码、授权码不进日志。
export function redact(text) {
  return String(text ?? '')
    .replace(/(Bearer\s+)[\w.\-~+/=]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|x-api-key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|auth[_-]?code)\s*["']?\s*[=:]\s*["']?)[^\s"'&,}]+/gi, '$1[redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g, '$1-[redacted]')
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '[redacted]');
}

// 原因：一句人话。报错本身是中文的就用它；否则按常见的错误码说；都认不出就说「意外的错」（原文在证据里）。
// 报错里什么都没有时是 null，整句不带括号（不拿「原因没记下来」这类兜底词充数，lib/wait-reason.mjs）。
export function swallowReason(err) {
  const code = err?.code || '', m = String(err?.message ?? err ?? '').trim();
  if (!m && !code) return null;
  if (/[一-龥]{2,}/.test(m) && !/[A-Za-z]+_[a-z0-9_]+/.test(m)) return cut(m, 60);
  if (code === 'ENOENT') return '文件不在';
  if (code === 'EACCES' || code === 'EPERM') return '没有权限';
  if (code === 'ENOSPC') return '磁盘满了';
  if (code === 'EBUSY' || code === 'EAGAIN') return '文件正被占用';
  if (err instanceof SyntaxError || /JSON/.test(m)) return '内容读不懂（不是有效的 JSON）';
  if (code === 'ETIMEDOUT' || /time ?out|timed out|AbortError|aborted/i.test(`${err?.name || ''} ${m}`)) return '等太久超时了';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(`${code} ${m}`)) return '连不上';
  if (/Target (page|closed)|has been closed|Session closed|detached/i.test(m)) return '浏览器页面已经关了';
  return '意外的错';
}

export function noteSwallowed(where, err, { member = 'patch', doing = '', then = '', now = Date.now() } = {}) {
  try {
    const reason = swallowReason(err), key = `${where}|${reason ?? ''}`;
    if (now - (seen.get(key) || 0) < QUIET_MS) return reason;
    seen.set(key, now);
    const msg = `${doing || '这一步'}没做成${reason ? `（${reason}）` : ''}${then ? `，${then}` : ''}`;
    event(member || 'patch', SWALLOW_STEP, 'warn', msg, { where, evidence: { error: cut(redact(err?.message ?? err), 300), code: err?.code ?? err?.status ?? null } });
    return reason;
  } catch { /* 兜底：记日志本身失败（磁盘满、目录没权限）不能拖垮调用的那条正常路径 */ return null; }
}

// 给 promise 用：.catch(swallowTo(null, 'where', { doing, then }))，记一笔再换成 value。
export const swallowTo = (value, where, opts) => err => { noteSwallowed(where, err, opts); return value; };
