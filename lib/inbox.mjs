import { applyEvent, endedLead, leadState } from './lead-state.mjs';
// 一封招聘方来信落到线索上（邮件巡检 bin/inbox.mjs 和 BOSS 聊天列表 lib/boss-inbox.mjs 共用）：记下回复时间和摘要、
// 线索状态走 reply（面试邀约 → 面试已安排，拒绝 → 已拒绝，其余 → 已回复，lib/lead-state.mjs 的转移表）。不是回复的（无关、申请确认、验证码）不动线索。
export const NOT_REPLY = ["无关", "申请确认", "验证码"];
export function recordReply(lead, { category, summary, at, source = "inbox" }) {
  if (NOT_REPLY.includes(category)) return false;
  lead.replied_at = at;
  lead.reply_summary = summary;
  applyEvent(lead, "reply", { category, note: summary }, { at, source });
  return true;
}
export function associate(message, outbound, leads) {
  const exact = message.thread_id ? outbound.filter((o) => o.external_id === message.thread_id || o.thread_id === message.thread_id) : [];
  const ids = [...new Set(exact.map((o) => o.record_id))];
  if (ids.length === 1) return leads.find((l) => (l.record_id || l.id) === ids[0]) || null;
  if (ids.length > 1) return null;
  return byCompany(message, outbound, leads);
}
// 官网表单 / 门户投出去的申请没有邮件会话：回信（常从 no-reply 地址来）按公司名对（2026-09-30 真实链路测试）。
// 只看发件人和标题：正文里常见词太多，公司名是常见英文词时会误配。这家公司最近 90 天投过表单 / 门户，
// 而且只对上一条才算；同一家投了好几个岗位就不猜，照旧等你认。中文公司名不按词边界比。
const FORM_CHANNEL = /^(?:ats_form|portal)/;
const words = (s) => ` ${String(s || '').normalize('NFKC').toLowerCase().replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}&]+/gu, ' ').trim()} `;
// 还得像一封招聘来信：发件人或标题里有投递 / 申请这类词，或者从招聘系统发来。「Your order ships right away」不算。
export const RECRUITING = /\b(?:appl(?:y|ied|ying|ications?)|candida(?:te|cy)|positions?|roles?|interviews?|recruit(?:ing|er|ment)?|talent|hiring|careers?|jobs?)\b|投递|申请|面试|岗位|职位|招聘|简历|应聘/i;
export const ATS_SENDER = /(?:lever\.co|ashbyhq\.com|greenhouse\.io|myworkday(?:jobs)?\.com|smartrecruiters\.com|workablemail\.com|workable\.com|mokahr\.com|zhipin\.com)\b/i;
function byCompany(message, outbound, leads) {
  const at = Date.parse(message.at || '') || Date.now(), raw = `${message.from || ''} ${message.subject || ''}`, head = words(raw);
  if (!RECRUITING.test(raw) && !ATS_SENDER.test(String(message.from || ''))) return null;
  const recent = outbound.filter((o) => FORM_CHANNEL.test(String(o.channel || '')) && Date.parse(o.at || '') > at - 90 * 86400000 && Date.parse(o.at || '') <= at + 86400000);
  const ids = [...new Set(recent.map((o) => o.record_id))];
  const hits = ids.map((id) => leads.find((l) => (l.record_id || l.id) === id)).filter((l) => {
    const c = words(l?.company).trim();
    if (c.length < 2) return false;
    return /[\u4e00-\u9fff]/.test(c) ? head.includes(c) : head.includes(` ${c} `);
  });
  return hits.length === 1 ? hits[0] : null;
}
export function businessDays(start, end) {
  let days = 0;
  const d = new Date(start);
  d.setUTCHours(0, 0, 0, 0);
  const until = new Date(end);
  until.setUTCHours(0, 0, 0, 0);
  while (d < until) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days++;
  }
  return days;
}
// Closed threads (Offer, rejection, pass, archive) never ask for a follow-up:
// a lead already at Offer used to get "面试后3天无新消息".
const closed = (l) => endedLead(l) || l.superseded;
export function reminders(leads, outbound, now = new Date()) {
  const due = leads
    .filter((l) => !closed(l) && !l.contact_hold)
    .flatMap((l) => {
      const sent = outbound.filter((o) => o.record_id === (l.record_id || l.id)).sort((a, b) => b.at.localeCompare(a.at))[0];
      if (l.interview_at && now - new Date(l.interview_at) >= 3 * 86400000 && !l.interview_response_at)
        return [{ record_id: l.record_id || l.id, summary: `${l.company} 面试后3天无新消息，是否跟进 ${l.number}` }];
      if (sent && !["replied", "interview_scheduled", "interview_done"].includes(leadState(l)) && businessDays(sent.at, now) >= 5)
        return [{ record_id: l.record_id || l.id, company: l.company, at: sent.at, number: l.number, silent: true }];
      return [];
    });
  // One silence reminder per company: five applications to one company are one decision,
  // not five. The summary keeps ending with a lead number (the workbench's 跟进 button reads it).
  const byCompany = new Map();
  for (const r of due.filter((r) => r.silent)) {
    const key = String(r.company || r.record_id).toLowerCase();
    (byCompany.get(key) || byCompany.set(key, []).get(key)).push(r);
  }
  const silent = [...byCompany.values()].map((rows) => {
    const [first, ...rest] = rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { record_id: first.record_id, summary: `${first.company} 联系后5个工作日未回复${rest.length ? `（同公司另有 ${rest.map((r) => r.number).join("、")}）` : ""}，是否跟进 ${first.number}` };
  });
  return [...due.filter((r) => !r.silent), ...silent];
}
