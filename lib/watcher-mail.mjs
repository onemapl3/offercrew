// Watcher 读信走哪条路，读完怎么说（0.1.4，负责人 10-04 在 0.1.2 的 App 上测出：接了内置邮箱，「Watcher 跑一轮」
// 却走宿主连接器，2 秒「完成」，一封没读）。
//
//   谁来读：问能力表（lib/capabilities.mjs mailReader / whoDoes('read_mail')）：接了内置邮箱就是引擎自己读（bin/mail-read.mjs），
//                   没接就没有谁会读（本机 AI 不碰邮箱，命令行版的 Gmail 连接器 10-04 冻结），照实说没读、给「接上邮箱」
//   mailOutcome(r)  bin/mail-read.mjs（lib/mail/inbox.mjs runMailRead）或周期 inbox 那一步的输出 → { read, text, go? }：
//                   读了几封、有没有求职相关的；没读、为什么。运行日志、成员页「上次」、任务卡都用这一句。
//   opSummary(op, log)  操作台跑完（lib/command-center.mjs runOp）：从这次运行日志最后一行 JSON 取出上面那一句。
import { MAIL_SETUP } from './capabilities.mjs';
import { crewName } from './crew.mjs';

export const MAIL_NOT_CONNECTED = 'mail_not_connected';
export const CONNECT_GO = { label: '接上邮箱', href: MAIL_SETUP };
export const RECONNECT_GO = { label: '重新连接邮箱', href: MAIL_SETUP };


const SKIPPED = {
  another_mail_read_running: '另一次读信还没完',
  outside_patrol_hours: '09:00–21:00 之外不巡检',
  test_servers_outside_sandbox: '邮箱设置不全',
  provider_unknown: '认不出这个邮箱的服务器',
};
const FAILED = {
  auth: '授权码不对', secret: '存的授权码读不出来', unsafe: '邮箱拒绝了这次登录', throttle: '邮箱限制了登录次数',
  network: '连不上邮箱', timeout: '连不上邮箱', proxy: '连不上邮箱', tls: '连不上邮箱', server: '邮箱服务器出错', sandbox: '演示模式不连邮箱',
};
const CODE_KINDS = new Set(['auth', 'secret', 'unsafe']);

export function mailOutcome(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.reason === 'not_connected' || r.reason === MAIL_NOT_CONNECTED) return { read: false, text: '没读邮件：邮箱还没接上', go: CONNECT_GO };
  if (r.status === 'baseline') return { read: true, text: r.reset ? '邮箱换了编号，从最新一封往后读' : '邮箱刚接上，从最新一封往后读，以前的信不读' };
  if (r.status === 'skipped') {
    const why = String(r.reason || '');
    if (why.startsWith('waiting_for_new_code')) return { read: false, text: '没读邮件：授权码要重新填', go: RECONNECT_GO };
    if (why === 'mailbox_changed') return { read: false, text: '邮箱在开始读取前已变更，请连接这件任务对应的邮箱', go: RECONNECT_GO };
    if (why === 'watcher_paused') return { read: false, text: `没读邮件：${crewName('owl')} 暂停了` };
    if (why === 'another_mail_read_running') return { read: false, waiting_resource: true, text: '另一轮正在读信，排队后自动接着读' };
    return { read: false, text: `没读邮件：${SKIPPED[why] || '这次跳过了'}`, ...(why === 'provider_unknown' || why === 'test_servers_outside_sandbox' ? { go: RECONNECT_GO } : {}) };
  }
  if (r.status === 'failed') return { read: false, text: `没读成：${FAILED[r.kind] || '连邮箱出错了'}`, ...(CODE_KINDS.has(r.kind) ? { go: RECONNECT_GO } : {}), ...(['network', 'timeout', 'proxy', 'tls', 'server', 'throttle'].includes(r.kind) ? { retryable: true } : {}) };
  if (r.status === 'error') return { read: false, text: '没读成：读信出错了，原因在日志里' };
  if (['changed', 'no_change'].includes(r.status) && r.read != null) {
    const n = Number(r.read) || 0, job = Number(r.recorded) || 0, hit = Number(r.raised) || 0;
    if (!n) return { read: true, text: '读了邮箱，没有新信' };
    return { read: true, text: `读了 ${n} 封新信，${job ? `${job} 封求职相关${hit ? `，${hit} 封对上岗位` : ''}` : '没有求职相关的'}${r.more ? '；还有没读完的，下次接着读' : ''}` };
  }
  return null;
}

// 周期（bin/cycle.mjs）的结果里 Watcher 读信那一步：先看引擎读信（mail-read），没有就看 inbox 说没读的那一条。
export function cycleMailOutcome(results = []) {
  const read = results.find(x => x?.stage === 'mail-read');
  if (read) return mailOutcome(read);
  const inbox = results.find(x => x?.stage === 'inbox');
  return inbox?.reason === MAIL_NOT_CONNECTED ? mailOutcome(inbox) : null;
}

// 这次运行的日志（stdout、stderr 混在一起）里最后一行 JSON。
export function lastJson(text = '') {
  const rows = String(text).split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    const s = rows[i].trim();
    if (!s.startsWith('{')) continue;
    try { const j = JSON.parse(s); if (j && typeof j === 'object') return j; } catch {} // 兜底：不是 JSON 就往下按文字认
  }
  return null;
}
// 只给 Watcher 读信的两项写这一句：收件箱巡检（接了内置邮箱时跑 bin/mail-read.mjs）、Watcher 跑一轮（周期 --only owl）。
export const SUMMARY_OPS = new Set(['mail-poll', 'round-owl', 'linkedin-inbox']);
export function opSummary(op, text) {
  if (!SUMMARY_OPS.has(op)) return null;
  const j = lastJson(text);
  if (!j) return null;
  if (op === 'linkedin-inbox') return {read:['ok','partial'].includes(j.status),text:j.reason || 'LinkedIn 检查结果未完整返回',...(['login_required','verification_required'].includes(j.status)?{go:{label:'打开 LinkedIn 消息',href:'https://www.linkedin.com/messaging/'}}:{})};
  return Array.isArray(j.results) ? cycleMailOutcome(j.results) : mailOutcome(j);
}
