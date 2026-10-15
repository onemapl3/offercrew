// LinkedIn 通知邮件补充网页收信；同一实际消息只提醒一次。网页检查无需先收到邮件。
import { hash, read, write } from './store.mjs';
import { recordReply } from './inbox.mjs';
import { norm, liveLead } from './list-watch.mjs';
import { stageText } from './lead-state.mjs';
import { sameLinkedInNotification, linkedinThread } from './linkedin-message-identity.mjs';

export const STATE_PATH = 'state/linkedin-inbox.json';
export const INBOX_URL = 'https://www.linkedin.com/messaging/';
export const SOURCE = 'linkedin-mail';

const clean = s => String(s == null ? '' : s).replace(/[\u200b\u00a0]/g, ' ').replace(/[ \t]+/g, ' ').trim();
const addressOf = from => (String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '').match(/[^\s<>"]+@[^\s<>"]+/)?.[0] || '').toLowerCase();
const displayOf = from => clean(String(from || '').replace(/<[^>]*>/, '').replace(/^"|"$/g, ''));

const MESSAGE_SENDERS = new Set(['messages-noreply', 'messaging-digest-noreply', 'inmail-hit-reply', 'hit-reply', 'messaging-noreply']);
const SUBJECT = [
  /^(.+?)\s+(?:has\s+)?sent you (?:a |an )?(?:new )?(?:message|InMail)s?\b/i,
  /^(.+?)\s+just messaged you\b/i,
  /^(?:New|You have a new) message from\s+(.+?)\s*$/i,
  /^(.+?)\s*(?:刚刚)?(?:给|向)(?:你|您)发(?:送)?了(?:一条|\d+ ?条)?(?:新)?(?:消息|私信|InMail)/i,
  /^(?:来自)\s*(.+?)\s*的(?:新)?(?:消息|私信|InMail)/i,
];
const DIGEST = /^You have \d+ new messages?\b|sent new messages\b|(?:你|您)有 ?\d+ ?条新消息/i;

// 这封是不是 LinkedIn 的私信 / InMail 通知。返回 'message' | 'inmail' | 'digest' | null。
export function linkedinKind(m = {}) {
  const addr = addressOf(m.from), [local, domain = ''] = addr.split('@');
  if (!/(?:^|\.)linkedin\.com$/.test(domain)) return null;
  const subject = clean(m.subject);
  if (/inmail/.test(local)) return 'inmail';
  if (DIGEST.test(subject)) return 'digest';
  if (MESSAGE_SENDERS.has(local)) return 'message';
  // 别的发件人（通知、职位提醒）只有标题明明白白是一条新消息才算。
  if (/^(?:notifications-noreply|messages)$/.test(local) && SUBJECT.some(re => re.test(subject))) return 'message';
  return null;
}

const BOILER = [
  /^(?:View|Read|Reply|See) (?:message|conversation|all messages)|^(?:Reply|Accept|Ignore|View profile)$/i,
  /^You have (?:\d+|a|an) (?:new|unread) (?:message|InMail)s?/i,
  /^(?:Unsubscribe|Help|Learn why we included this|This email was intended for|You are receiving|You're receiving|LinkedIn Corporation|© ?\d{4} LinkedIn|LinkedIn and the LinkedIn logo)/i,
  /^(?:查看消息|回复|查看全部|退订|帮助|这封邮件发给)/,
  /^InMail\b|^Sponsored\b|^Premium\b/i,
  /^[-_=*·•|]{2,}$/,
];
const isBoiler = l => BOILER.some(re => re.test(l)) || /^https?:\/\//i.test(l) || /\bunsubscribe\b/i.test(l);
// 头衔里的公司：「Title at Company」「Title @ Company」「Company 的 Title」取不准的就不取。
function companyIn(headline) {
  const h = clean(headline);
  const m = h.match(/\s(?:at|@)\s+(.+)$/i) || h.match(/^[^@]*@\s*(.+)$/);
  if (!m) return '';
  return clean(m[1].split(/\s[|·•]\s|\s[-–—]\s/)[0]).slice(0, 80);
}
const firstSentence = s => { const t = clean(s); const m = t.match(/^(.{4,}?(?:[。！？!?]|\.(?=\s|$)))/); return (m ? m[1] : t).slice(0, 120); };

// 对话链接：去掉跟踪参数，/comm/ 换成正常的地址。没有就给消息首页。
export function threadUrl(text) {
  const m = String(text || '').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:comm\/)?messaging\/thread\/([A-Za-z0-9_\-=%.:,]+)/i);
  return m ? `https://www.linkedin.com/messaging/thread/${m[1].replace(/[.,]+$/, '')}/` : INBOX_URL;
}

// 取字段：对方名字、第一句、公司（有的话）、对话链接。只看这几样，正文的其余部分不留。
export function parseLinkedInMail(m = {}) {
  const kind = linkedinKind(m);
  if (!kind) return null;
  const subject = clean(m.subject), display = displayOf(m.from).replace(/\s+(?:via|通过)\s+(?:LinkedIn|领英)\s*$/i, '').replace(/[（(]通过(?:LinkedIn|领英)[)）]$/, '').trim();
  let name = '';
  for (const re of SUBJECT) { const x = subject.match(re); if (x) { name = clean(x[1]); break; } }
  if (!name && display && !/^linkedin$|^领英$/i.test(display)) name = display;
  if (kind === 'digest') name = '';
  const body = String(m.body || m.text || '');
  const lines_ = body.split(/\r?\n+/).map(clean).filter(Boolean).filter(l => !isBoiler(l));
  let i = name ? lines_.findIndex(l => norm(l) === norm(name) || norm(l).startsWith(norm(name))) : -1;
  let headline = '';
  if (i >= 0) {
    const rest = lines_[i].slice(name.length).replace(/^[\s,，·|-]+/, '');
    if (rest) headline = rest;
    else if (lines_[i + 1] && (/\s(?:at|@)\s|@|\s[|·]\s/i.test(lines_[i + 1]) || lines_[i + 1].length <= 80 && i + 2 < lines_.length)) { headline = lines_[i + 1]; i++; }
  }
  const after = (i >= 0 ? lines_.slice(i + 1) : lines_).filter(l => l !== subject && norm(l) !== norm(name));
  const first = kind === 'digest' ? '' : firstSentence(kind === 'inmail' && subject && !SUBJECT.some(re => re.test(subject)) ? (after[0] || subject) : after[0] || '');
  let company = companyIn(headline);
  if (!company && kind === 'inmail') company = companyIn(` ${subject}`);
  return { kind, name: name.slice(0, 60), headline: headline.slice(0, 120), company, first, subject: subject.slice(0, 160), url: threadUrl(body) };
}

// ── 对上线索：人名优先，其次公司；对不上一条就不猜 ──────────────────────────────────────────────
const words = s => ` ${String(s || '').normalize('NFKC').toLowerCase().replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}&]+/gu, ' ').trim()} `;
// 公司名的几种写法：全称、括号前、括号里逗号分开的每一段。中文按字比，英文按整词比（「Northwind」不会配上「Northwindows」）。
function companyForms(company) {
  const c = String(company || '').normalize('NFKC');
  return [...new Set([c, c.replace(/[（(].*$/, ''), ...(c.match(/[（(]([^）)]*)[）)]/)?.[1] || '').split(/[,，、/]/)].map(s => s.trim()).filter(s => norm(s).length >= 2))];
}
const has = (hay, form) => /[\u4e00-\u9fff]/.test(form) ? norm(hay).includes(norm(form)) : words(hay).includes(words(form));
const people = l => [l.author, l.contact_name, l.referrer_name, l.recruiter, l.inbound?.recruiter].map(norm).filter(n => n.length >= 2);
const sentOnLinkedIn = (o, id) => o.record_id === id && (/linkedin/i.test(String(o.platform || o.channel || '')) || /linkedin\.com/i.test(String(o.to || o.url || '')));
export function linkMessage(p, { leads = [], outbound = [] } = {}) {
  if (!p) return null;
  const live = leads.filter(liveLead), who = norm(p.name);
  const url = linkedinThread(p.url);
  const exact = url ? live.filter(l => [l.linkedin_thread_url,l.reply_url,l.url,l.contact_url].some(u => linkedinThread(u) === url)) : [];
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  // 公司只从头衔和标题里认（正文里的常见词太多，会误配）。
  const where = `${p.headline} ${p.company} ${p.kind === 'inmail' ? p.subject : ''}`;
  const byCompany = live.filter(l => companyForms(l.company).some(f => has(where, f)));
  const byPerson = who.length >= 2 ? live.filter(l => people(l).includes(who)) : [];
  const both = byPerson.filter(l => byCompany.includes(l));
  for (const pool of [both, byPerson, byCompany]) {
    if (pool.length === 1) return pool[0];
    if (pool.length > 1) {
      const id = l => l.record_id || l.id;
      const here = pool.filter(l => outbound.some(o => sentOnLinkedIn(o, id(l))));
      return here.length === 1 ? here[0] : null;
    }
  }
  return null;
}

// ── 登记：一批 LinkedIn 通知邮件 → 来信 / 对不上的那封信（纯函数，调用方持锁、负责落盘） ──────────────
// messages：巡检交来的 { id, thread_id, from, subject, body, at }。已经登记过的（同一个 id）跳过；
// 巡检自己已经追加过的普通一行（source mail-poll）就地换成这一行，不重复。
export function recordLinkedInMail(messages = [], { leads = [], outbound = [], events = [], state = {}, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  let unlinked = (state.unlinked || []).slice();
  const out = { seen: 0, raised: 0, unlinked: 0, skipped: 0, events: 0, base: {} };
  for (const m of messages) {
    const p = parseLinkedInMail(m);
    if (!p || !m?.id) { out.skipped++; continue; }
    out.seen++;
    const id = String(m.id);
    if (events.some(e => e.notification_ids?.includes(id))) continue;
    const browserMatches = events.filter(e => e.source === 'linkedin-browser' && !e.notification_ids?.length && sameLinkedInNotification(e,{url:p.url,name:p.name,first:p.first,at:m.at || at}));
    if (browserMatches.length === 1) { browserMatches[0].notification_ids = [...new Set([...(browserMatches[0].notification_ids || []),id])]; out.events++; continue; }
    const prior = events.findIndex(e => e.message_id === id);
    if (prior >= 0 && events[prior].source === SOURCE) continue;
    if (unlinked.some(u => u.key === id)) continue;
    const when = m.at || at;
    const lead = linkMessage(p, { leads, outbound });
    const shown = p.name ? `${p.name}${p.company ? ` · ${p.company}` : ''}` : 'LinkedIn';
    if (!lead) {
      unlinked = [...unlinked, { key: id, shown, preview: p.first || p.subject, url: p.url, at: when }];
      out.unlinked++;
      continue;
    }
    const summary = `${shown}：${p.first || p.subject || '（新消息）'}`.slice(0, 240);
    const ev = { message_id: id, record_id: lead.record_id || lead.id, number: lead.number ?? null, at: when, category: '回复', summary, from: p.name || m.from || 'LinkedIn', subject: `LinkedIn · ${shown}`, message_preview:p.first, direction:'inbound', source: SOURCE, channel: 'platform_dm', url: p.url, ...(m.thread_id ? { thread_id: m.thread_id } : {}) };
    if (prior >= 0) events[prior] = { ...events[prior], ...ev }; else events.push(ev);
    out.events++;
    if (recordReply(lead, { category: '回复', summary, at: when, source: SOURCE })) {
      Object.assign(lead, { reply_channel: 'platform_dm', reply_url: p.url });
      delete lead.reply_message; // 新通知只有摘要；不能沿用上一条网页来信的正文。
      if (lead.record_id) out.base[lead.record_id] = { 阶段: [stageText(lead)], 回复摘要: summary };
      out.raised++;
    }
  }
  return { ...out, state: { ...state, unlinked: unlinked.slice(-30), checked_at: at } };
}

// ── 对不上线索的：一封信 ───────────────────────────────────────────────────────────────────────
const sigOf = list => hash(list.map(u => [u.key, u.preview])).slice(0, 16);
export function linkedinAsks({ state = read(STATE_PATH, {}) || {} } = {}) {
  const list = (state.unlinked || []).filter(u => u?.key);
  if (!list.length) return [];
  const sig = sigOf(list), last = list[list.length - 1];
  return [{
    from: 'watch', id: `linkedin-mail:${sig}`, type: 'info', title: 'LinkedIn · 新消息',
    question: `${list.length} 条消息对不上岗位`,
    context: [],
    affected: list.slice(-12).map(u => ({ id: u.key, label: `${u.shown} · ${u.preview || '（新消息）'}`.slice(0, 100) })),
    options: [
      { key: '1', label: '打开 LinkedIn 消息', steps: [{ type: 'open', url: list.length === 1 ? last.url || INBOX_URL : INBOX_URL }], primary: true },
      { key: '2', label: '知道了', steps: [{ type: 'linkedin_mail', action: 'ack', sig }] },
    ],
    other: null,
  }];
}
export function ackLinkedIn(sig) {
  const state = read(STATE_PATH, {}) || {};
  const list = (state.unlinked || []).filter(u => u?.key);
  if (list.length && sigOf(list) !== String(sig)) throw Error('这期间又来了新消息，看一眼再收起');
  write(STATE_PATH, { ...state, unlinked: [] });
  return '收起了';
}
