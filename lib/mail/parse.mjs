// 把从收件箱取来的一封信（imapflow 的 FETCH 结果，原文用 postal-mime 解析）整理成读信要用的样子（第 2 批）。
// 信的内容一律是不可信的文字：这里只做确定的事——拆信头、取正文文字、认日历邀请里的时间和预约链接，不执行、不打开任何链接。
//   id          去重用：Gmail 用它自己的邮件编号（和 Gmail 网页、以前经 Codex 读到的同一个，换着读也不会记两遍），
//               别家用信头的 Message-ID，都没有用「UIDVALIDITY:UID」。
//   thread_id   Gmail 的会话编号（十六进制，和以前经 Codex 发信记下的 thread_id 一样）；别家没有，靠 In-Reply-To / References 配。
//   body        正文文字（没有纯文字就把 HTML 去掉标签），最多 12000 字；quote 之前那段是对方新写的（excerpt 用它）。
//   calendar    日历邀请（text/calendar）里的时间：面试邀请多半带着，比让模型去猜时间可靠。
import PostalMime from 'postal-mime';
import { zonedTime, TZ } from '../tz.mjs';
import { noteSwallowed } from '../swallow.mjs';

const BODY_MAX = 12000;
const clean = (s) => String(s == null ? '' : s).replace(/[​‌‍﻿]/g, '').replace(/ /g, ' ');

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
export function htmlToText(html) {
  return clean(String(html || '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16) || 32);
      if (/^#\d/.test(e)) return String.fromCodePoint(Number(e.slice(1)) || 32);
      return ENTITIES[e.toLowerCase()] ?? m;
    }))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 对方新写的那段：引用的旧信（> 开头、「On … wrote:」「在 … 写道：」「-----Original Message-----」「发件人：」这类）之前。
const QUOTE_START = /^(?:>|On .{4,200}wrote:\s*$|在.{2,120}写道[：:]\s*$|-{2,}\s*(?:Original Message|原始邮件|Forwarded message|转发的邮件)\s*-{2,}|(?:From|发件人|寄件者)\s*[:：].+$)/i;
export function newestPart(text) {
  const lines = String(text || '').split('\n');
  const cut = lines.findIndex((l, i) => i > 0 && QUOTE_START.test(l.trim()));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}
export function excerpt(text, max = 200) {
  return newestPart(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// ── 日历邀请 ─────────────────────────────────────────────────────────────────────
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }; // 兜底：不认识的时区就不用它
// 「名字;参数:值」：参数里带引号的值（TZID="(UTC+08:00) Beijing"）可能有冒号，找引号外的第一个冒号。
function splitProp(prop) {
  let quoted = false;
  for (let i = 0; i < prop.length; i++) {
    if (prop[i] === '"') quoted = !quoted;
    else if (prop[i] === ':' && !quoted) return [prop.slice(0, i), prop.slice(i + 1).trim()];
  }
  return [prop, ''];
}
function icsTime(prop) {
  if (!prop) return null;
  const [head, value] = splitProp(prop);
  if (/VALUE=DATE(?!-)/i.test(head) || /^\d{8}$/.test(value)) return null; // 整天的事不是面试时间
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}:${m[6] || '00'}`;
  if (m[7]) return new Date(`${day}T${time}Z`).toISOString();
  const tzid = (head.match(/TZID=("?)([^;:"]+)\1/i) || [])[2];
  const ms = zonedTime(day, time, tzid && validTz(tzid) ? tzid : TZ);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
// METHOD:REQUEST / PUBLISH 的 VEVENT：{ start, end, summary, location, url, method }。CANCEL 的也带出来（method 照写），调用方自己看。
export function calendarEvents(ics) {
  const text = String(ics || '').replace(/\r?\n[ \t]/g, '');
  const method = (text.match(/^METHOD:(.+)$/m) || [])[1]?.trim().toUpperCase() || null;
  const out = [];
  for (const block of text.split(/BEGIN:VEVENT/).slice(1)) {
    const body = block.split(/END:VEVENT/)[0];
    const prop = (name) => body.split(/\r?\n/).find((l) => new RegExp(`^${name}(?:;[^:]*)?:`, 'i').test(l)) || null;
    const value = (name) => { const p = prop(name); return p ? splitProp(p)[1].replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim().slice(0, 300) : null; };
    const start = icsTime(prop('DTSTART'));
    if (!start) continue;
    out.push({ start, end: icsTime(prop('DTEND')), summary: value('SUMMARY'), location: value('LOCATION'), url: value('URL'), method });
  }
  return out.slice(0, 3);
}

// 预约面试时间的链接（Calendly 这类）：只认几家常见的预约服务，认出来给收件箱那封信当入口；不打开它。
const SCHEDULERS = /https:\/\/(?:calendly\.com|cal\.com|app\.cal\.com|[\w-]+\.goodtime\.io|scheduling\.greenhouse\.io|app\.greenhouse\.io\/(?:interview|scheduling)|hire\.lever\.co\/interviews?|[\w-]+\.ashbyhq\.com\/[^\s"'<>]*schedul|calendar\.app\.google|outlook\.office365\.com\/(?:owa\/)?calendar\/[^\s"'<>]*bookings|zcal\.co|savvycal\.com|meetings\.hubspot\.com)\/?[^\s"'<>)\]]*/i;
export const schedulingLink = (text) => (String(text || '').match(SCHEDULERS) || [null])[0];

const normId = (v) => String(v || '').trim().replace(/^<|>$/g, '').toLowerCase();
const refsOf = (v) => (String(v || '').match(/<[^<>\s]+>/g) || []).map(normId).filter(Boolean).slice(-20);
const hexOf = (dec) => { try { return BigInt(String(dec)).toString(16); } catch { return null; } }; // 兜底：不是数字就没有十六进制写法
const nameAddress = (a) => (a?.address ? (a.name ? `${clean(a.name)} <${a.address}>` : a.address) : '');
const flatten = (list) => (Array.isArray(list) ? list.flatMap((a) => (a?.group ? a.group : [a])) : []);

// f：imapflow 的 FETCH 结果（uid、envelope、internalDate、size、emailId、threadId、source）。
export async function toMessage(f, { uidvalidity, gmail = false, maxBytes = Infinity } = {}) {
  let email = {};
  try { email = await PostalMime.parse(f.source || Buffer.alloc(0), { maxNestingDepth: 50, maxRfc822NestingDepth: 2 }); } catch (e) { noteSwallowed('mail.parse', e, { member: 'owl', doing: '解析一封信的正文', then: '这封只按信头（发件人、标题）看' }); email = {}; }
  const header = (k) => (email.headers || []).find((h) => h.key === k)?.value || '';
  const from = email.from?.group ? email.from.group[0] : email.from || (f.envelope?.from || [])[0] || null;
  const text = clean(email.text || '').trim() || htmlToText(email.html);
  const calendar = (email.attachments || []).filter((a) => /^text\/calendar$/i.test(a.mimeType || '') || /\.ics$/i.test(a.filename || ''))
    .flatMap((a) => calendarEvents(typeof a.content === 'string' ? a.content : new TextDecoder().decode(a.content)));
  const messageId = normId(email.messageId || f.envelope?.messageId);
  const gmailId = gmail && /^\d+$/.test(String(f.emailId || '')) ? hexOf(f.emailId) : null;
  const dateIso = (() => { const t = Date.parse(email.date || ''); if (Number.isFinite(t)) return new Date(t).toISOString(); const i = f.internalDate ? new Date(f.internalDate) : null; return i && !Number.isNaN(i.getTime()) ? i.toISOString() : new Date().toISOString(); })();
  // 群发 / 自动发出的信：Auto-Submitted 不是 no、带 List-Id / List-Unsubscribe、Precedence 是 bulk / list / junk。
  const autoSubmitted = header('auto-submitted').trim().toLowerCase();
  const auto = (!!autoSubmitted && autoSubmitted !== 'no') || !!header('list-id') || !!header('list-unsubscribe') || /^(?:bulk|list|junk)$/i.test(header('precedence').trim());
  return {
    id: gmailId || messageId || `uid:${uidvalidity}:${f.uid}`,
    uid: f.uid, uidvalidity: String(uidvalidity),
    message_id: messageId || null,
    thread_id: gmail && /^\d+$/.test(String(f.threadId || '')) ? hexOf(f.threadId) : null,
    in_reply_to: normId(email.inReplyTo) || null,
    references: refsOf(email.references),
    from: nameAddress(from), from_address: String(from?.address || '').toLowerCase(), from_name: clean(from?.name || ''),
    to: flatten(email.to).map((a) => String(a.address || '').toLowerCase()).filter(Boolean).slice(0, 20),
    subject: clean(email.subject ?? f.envelope?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    at: dateIso,
    body: text.slice(0, BODY_MAX),
    auto,
    calendar,
    scheduling_url: schedulingLink(`${text}\n${email.html || ''}`),
    truncated: Number(f.size) > maxBytes,
  };
}
