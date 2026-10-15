// 只是告诉你一声、不用你点头也不用你动手的信（负责人 10-10 第 6 条）：不进收件箱，写进运行日志，自己收起。
// 收件箱只留要你点头或动手的。哪几封算「告诉你一声」由出信的地方标 notice: true：
//   recovered:          卡住的东西恢复了，因它卡住的提醒可以关掉（lib/asks.mjs）
//   codeguard:          本机 AI 改了代码、已经全部还原（没能全部还原的照旧进收件箱，lib/code-guard.mjs）
//   builtin-mail:       招聘来信对不上岗位、里面没有面试邀请（有面试邀请的照旧进收件箱，lib/mail/asks.mjs）
//   builtin-mail-guess: 没有能用的模型、几封求职邮件没能判断（lib/mail/asks.mjs）
//   model-fault:        你配的模型额度用完、暂时换了别的底座（额度会自己恢复；钥匙失效、模型名不对的照旧进收件箱，lib/system/breaker.mjs）
// 收起用信上那个「知道了 / 关掉」的同一步（只认下面几种步子，别的不动）。没有这一步的（model-fault 那种，情况变了自己消失）：
// 同一封只写一次运行日志（记在 state/notices-logged.json），不进收件箱。
import { event } from './events.mjs';
import { read, write } from './store.mjs';
import { ackCodeGuard } from './code-guard.mjs';
import { ackMail, ackGuess } from './mail/asks.mjs';
import { updateHostJob } from './dispatch.mjs';
import { noteSwallowed } from './swallow.mjs';

export const noticeOnly = (a = {}) => a?.notice === true;
const MEMBER = { system: 'patch', watch: 'owl', radar: 'scout', reacher: 'quill' };

async function run(step, now) {
  if (step.type === 'codeguard') return ackCodeGuard(step.id);
  if (step.type === 'builtin_mail' && step.action === 'guess_ack') return ackGuess(step.day);
  if (step.type === 'builtin_mail' && (!step.action || step.action === 'ack')) return ackMail(step.sig);
  if (step.type === 'job' && step.action === 'resolve') {
    try { await updateHostJob(step.id, 'resolve', { note: step.note || '', now }); } catch (e) { if (!/不能改|没有这条/.test(e.message)) throw e; }
    return null;
  }
  return null;
}
// asks：收件箱那一份（inboxView 的 asks）。返回收起了几封。
const LOGGED = 'state/notices-logged.json';
export async function sweepNotices(asks = [], { now = Date.now(), log = event } = {}) {
  let done = 0;
  const notices = asks.filter(noticeOnly), logged = read(LOGGED, {}) || {}, live = new Set(notices.map(a => a.id));
  let dirty = Object.keys(logged).some(id => !live.has(id));
  for (const id of Object.keys(logged)) if (!live.has(id)) delete logged[id];
  for (const a of notices) {
    const opt = (a.options || []).find(o => (o.steps || []).length && o.steps.every(s => ['codeguard', 'builtin_mail', 'job'].includes(s.type)));
    if (!opt) {
      const sig = `${a.title}|${a.question}`;
      if (logged[a.id] !== sig) { log(MEMBER[a.from] || a.from || 'patch', 'notice', 'ok', `${a.title}：${a.question}`, { refs: [] }); logged[a.id] = sig; dirty = true; done++; }
      continue;
    }
    try {
      for (const s of opt.steps) await run(s, now);
      log(MEMBER[a.from] || a.from || 'patch', 'notice', 'ok', `${a.title}：${a.question}`, { refs: [] });
      done++;
    } catch (e) { noteSwallowed('notices.sweep', e, { member: 'patch', doing: `收起「${a.title}」`, then: '下一分钟再试' }); }
  }
  if (dirty) write(LOGGED, logged);
  return done;
}
