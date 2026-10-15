// Watch: the mailbox role of the command room.
//
// The 15-minute Codex poll no longer pushes anything itself. It appends what it
// found to state/inbox-events.ndjson and stops; this module turns each genuinely
// new message into one Watch card, so delivery, de-duplication, quiet hours and
// receipts are decided by code that can be tested rather than by a prompt
// (plans/20260915-command-room.md §二).
import { read, write, lines, hash } from './store.mjs';

import { judgeAvailable } from './judge.mjs';
import { classifyMail } from './judgements.mjs';
import { dayOf } from './tz.mjs';

// Jev's reading of a mail → delivery class. A low-confidence reading returns
// null and the regex below decides, so nothing is lost when the model demurs.
export const JUDGED_CLASS = { interview: 'interview', reply: 'reply', needs_material: 'reply', rejection: 'rejection', receipt: 'confirmation', code: 'code', unrelated: 'other' };
export function judgedMailClass(judgement) {
  if (!judgement) return null;
  if (judgement.has_code) return 'code';
  return JUDGED_CLASS[judgement.kind] || null;
}
// Classify the new events with Jev when it is available. Each event keeps its
// judgement so the receipt can say why it went where it went.
export async function classifyNewMail(events) {
  if (!judgeAvailable()) return events;
  const out = [];
  for (const e of events) {
    try {
      const judgement = e.judgement || await classifyMail({ ...e, body: e.body || e.summary }, { request_id: `mail-${String(e.message_id).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)}` });
      out.push({ ...e, judgement, mail_class: judgedMailClass(judgement) || e.mail_class });
    } catch { out.push(e); }
  }
  return out;
}

// Categories the pipeline writes for its own bookkeeping. They are not mail.
export const INTERNAL_CATEGORIES = new Set(['用户反馈', '进展', '无关']);
// Category text (written by the poll prompt or bin/inbox.mjs) → delivery class.
export function mailClass(category = '', mail = {}) {
  const c = String(category);
  if (/验证码|安全|verification|code/i.test(c)) return 'code';
  if (/面试|interview|改期|邀约|邀请/.test(c)) return 'interview';
  if (/拒绝|谢绝|不合适|reject/i.test(c)) return 'rejection';
  // An automatic "we received your application" is a receipt, not a reply.
  const text = `${mail.subject || ''} ${mail.summary || ''}`;
  if (/已收到(你的)?申请|收到您的申请|application (has been )?received|thank you for (your )?apply|thank you for applying|we have received your application|自动回复|auto[- ]?reply|no[- ]?reply confirmation/i.test(text) || /确认|receipt|confirmation/i.test(c)) return 'confirmation';
  if (/回复|需补材料|reply/.test(c)) return 'reply';
  return 'other';
}
// 粗判（兜底清单 D03）：这一类不是模型或 Jev 定的——按关键词猜的（by: 'rules'），或者没有 Jev 时只凭标题里像「已收到申请」的字认成自动确认。
// 卡片上如实写「粗判」。
export const roughClass = (e, cls = e.mail_class || mailClass(e.category, e)) => !e.judgement && (e.by === 'rules' || (cls === 'confirmation' && !/确认|receipt|confirm/i.test(String(e.category || ''))));
const CLASS_LABEL = { code: '验证码 / 安全提醒', interview: '面试邀请或改期', reply: '招聘方回复', rejection: '拒信', confirmation: '申请已收到（自动确认）', other: '其他新邮件' };
// The room only ever sees mail the user has to act on or would want to know
// about. A verification code is private; an automatic receipt is a log line;
// anything else is recorded and not pushed (the user's 2026-09-15 rule).
// 注意力规矩（负责人 10-02 22:4x）：拒信不用你动手，只改阶段、记运行日志，飞书群里也不推（主会话 10-02）。
export const ROOM_CLASSES = new Set(['reply', 'interview']);
export const PRIVATE_CLASSES = new Set(['code']);
export const DIGEST_CLASSES = new Set(['confirmation']);
export const mailDestination = cls => (ROOM_CLASSES.has(cls) ? 'room' : PRIVATE_CLASSES.has(cls) ? 'private' : DIGEST_CLASSES.has(cls) ? 'digest' : 'record');




// How many automatic receipts and other silent messages arrived today, for the
// System log card. These never reach the command room.
export function watchDigest({ receipts = read('state/watch-receipts.json', {}) , now = Date.now() } = {}) {
  const day = dayOf(now);
  const today = Object.values(receipts).filter(r => r.at && dayOf(r.at) === day);
  return {
    date: day,
    confirmations: today.filter(r => r.mail_class === 'confirmation').length,
    other: today.filter(r => r.destination === 'record').length,
    private: today.filter(r => r.destination === 'private').length,
    room: today.filter(r => r.destination === 'room').length,
  };
}
