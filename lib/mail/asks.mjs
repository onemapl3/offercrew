// 内置邮箱读到、却对不上岗位的招聘来信（第 2 批）：合成一封信放进收件箱（lib/ask-actions.mjs 收进来），和 LinkedIn、BOSS 那几封一样。
// 注意力规矩（负责人 10-02 22:4x）：只有要你动手的才来信——对不上岗位的招聘方回复、面试邀请算（你得自己看一眼、回一下）；
// 拒信不来信（只记运行日志）；对得上岗位的回复和面试邀请，由 journey 按线索阶段出「决定如何回复」「安排面试时间」。
//   state/mail-unlinked.json  { unlinked: [{ key, shown, subject, preview, category, at }], checked_at }，最多留 30 封。
import { read, write, hash, lines, writeLines } from '../store.mjs';
import { TZ } from '../tz.mjs';
import { loadAccount, accountBroken } from './vault.mjs';
import { domainOf } from './providers.mjs';
import { appShell } from '../capabilities.mjs';
import { gaveUpLine } from './send-words.mjs';

export const UNLINKED_FILE = 'state/mail-unlinked.json';
const KEEP = 30;

// 网页版邮箱：信里给一个「打开邮箱」。
export function webmailUrl(account = loadAccount()) {
  const p = account?.provider, d = domainOf(account?.address);
  if (p === 'qq') return 'https://mail.qq.com';
  if (p === 'netease') return `https://mail.${d || '163.com'}`;
  if (p === 'icloud') return 'https://www.icloud.com/mail';
  if (p === 'gmail') return 'https://mail.google.com/mail/u/0/#inbox';
  if (p === 'yahoo') return 'https://mail.yahoo.com';
  return null;
}

export function addUnlinked(items, { now = Date.now() } = {}) {
  if (!items.length) return;
  const state = read(UNLINKED_FILE, {}) || {};
  const have = new Set((state.unlinked || []).map((u) => u.key));
  const unlinked = [...(state.unlinked || []), ...items.filter((u) => u.key && !have.has(u.key))].slice(-KEEP);
  write(UNLINKED_FILE, { ...state, unlinked, checked_at: new Date(now).toISOString() });
}

const sigOf = (list) => hash(list.map((u) => [u.key, u.subject])).slice(0, 16);
export function mailAsks({ state = read(UNLINKED_FILE, {}) || {}, account = loadAccount() } = {}) {
  const list = (state.unlinked || []).filter((u) => u?.key);
  if (!list.length) return [];
  const sig = sigOf(list), url = webmailUrl(account);
  const interviews = list.filter((u) => u.category === '面试邀约').length;
  return [{
    from: 'watch', id: `builtin-mail:${sig}`, type: 'info', title: '邮箱 · 招聘来信',
    question: `${list.length} 封招聘来信对不上岗位${interviews ? `，其中 ${interviews} 封是面试邀请` : ''}`,
    context: [],
    affected: list.slice(-12).map((u) => ({ id: u.key, label: `${u.category === '面试邀约' ? '面试邀请 · ' : ''}${u.shown} · ${u.subject || u.preview || '（无标题）'}`.slice(0, 100) })),
    options: [
      ...(url ? [{ key: '1', label: '打开邮箱', steps: [{ type: 'open', url }], primary: true }] : []),
      { key: url ? '2' : '1', label: '知道了', steps: [{ type: 'builtin_mail', action: 'ack', sig }] },
    ],
    other: null,
    // 没有面试邀请：告诉你一声，写进运行日志（lib/notices.mjs）；有面试邀请的留在收件箱。
    notice: !interviews,
  }];
}

export function ackMail(sig) {
  const state = read(UNLINKED_FILE, {}) || {};
  const list = (state.unlinked || []).filter((u) => u?.key);
  if (list.length && sigOf(list) !== String(sig)) throw Error('这期间又来了新信，看一眼再收起');
  write(UNLINKED_FILE, { ...state, unlinked: [] });
  return '收起了';
}

// 发信没个准信的（lib/mail/send.mjs）：一封一封来信，要你看一眼「已发送」再定。
//   uncertain  正文交出去以后断了：发出去了 / 再发一次（走 requestAction：先确认这一版、再排进发信；同一个 Message-ID）/ 不发了
//   failed     对方服务器明确拒收：再发一次 / 不发了
const SEND_WORDS = { uncertain: '不确定发出去了没有', failed: '被对方的邮件服务器拒收了' };
export function sendAsks({ requests = lines('state/send-requests.ndjson'), leads = lines('state/leads.ndjson'), drafts = lines('state/drafts.ndjson'), account = loadAccount() } = {}) {
  if (!account) return [];
  const url = webmailUrl(account);
  return requests.filter((r) => (r.channel || 'email') === 'email' && r.via === 'builtin-mail' && ['uncertain', 'failed'].includes(r.status)).slice(-10).map((r) => {
    const lead = leads.find((l) => (l.record_id || l.id) === r.record_id) || null;
    const d = drafts.find((x) => x.draft_id === r.draft_id) || {};
    const who = lead ? `#${lead.number ?? ''} ${[lead.company, lead.role].filter(Boolean).join(' · ')}`.trim() : (d.to || '一封邮件');
    const step = (action) => [{ type: 'builtin_mail', action, id: r.id }];
    const uncertain = r.status === 'uncertain';
    // 连不上、试满了次数（lib/mail/send.mjs SEND_TRIES，实测 10-04 #503）：照实说为什么，给「再试一次」「我自己发了」「这封不发了」。
    if (r.unreachable) return {
      from: 'reacher', id: `builtin-mail-send:${r.id}:unreachable`, type: 'decide', title: '邮箱 · 发信', draft_id: r.draft_id || null,
      question: `${who}：${gaveUpLine(r)}`,
      context: [d.to ? `收件人 ${d.to}` : null, d.subject ? `标题 ${d.subject}` : null].filter(Boolean),
      ...(lead ? { lead: { record_id: lead.record_id || lead.id, number: lead.number, company: lead.company, role: lead.role } } : {}),
      detail: r.last_error_raw ? `原文：${r.last_error_raw}` : '',
      options: [
        // 再试一次：和你批准时同一条路（requestAction），先给你看一眼这封现在的样子、按它的指纹确认，再排进发信。
        { key: '1', label: '再试一次', steps: [{ type: 'action', kind: 'send_email', input: { draft_id: r.draft_id } }], primary: true },
        { key: '2', label: '我自己发了', steps: step('sent') },
        { key: '3', label: '这封不发了', steps: step('drop'), danger: true },
        ...(url ? [{ key: '4', label: '打开邮箱', steps: [{ type: 'open', url }] }] : []),
      ],
      other: null,
    };
    return {
      from: 'reacher', id: `builtin-mail-send:${r.id}:${r.status}`, type: 'decide', title: '邮箱 · 发信', draft_id: r.draft_id || null,
      question: `${who}：${SEND_WORDS[r.status]}`,
      context: [d.to ? `收件人 ${d.to}` : null, d.subject ? `标题 ${d.subject}` : null, !uncertain && r.reason ? `对方说 ${String(r.reason).slice(0, 120)}` : null].filter(Boolean),
      ...(lead ? { lead: { record_id: lead.record_id || lead.id, number: lead.number, company: lead.company, role: lead.role } } : {}),
      options: [
        ...(uncertain ? [{ key: '1', label: '发出去了', steps: step('sent') }] : []),
        // 再发一次：和批准时同一条路（requestAction）——先给你看这封现在的样子、按指纹确认，再排进发信（不确定的那封带 resend：你看过「已发送」了）。
        { key: uncertain ? '2' : '1', label: '再发一次', steps: [{ type: 'action', kind: 'send_email', input: { draft_id: r.draft_id, ...(uncertain ? { resend: true } : {}) } }], ...(uncertain ? {} : { primary: true }) },
        { key: uncertain ? '3' : '2', label: '不发了', steps: step('drop') },
        ...(url ? [{ key: uncertain ? '4' : '3', label: '打开邮箱', steps: [{ type: 'open', url }] }] : []),
      ],
      other: null,
    };
  });
}

// 没判断的信（兜底清单 D01）：没有模型时按关键词猜的那几封，阶段没动、记成「待确认」。一直没模型，就一天合成一封信请你看一眼；
// 「知道了」收起到明天（还有没判断的才再来）。有模型以后读信时会自己重新判断，这封信跟着没了。
const GUESS_ACK = 'state/mail-guess-ack.json';
const GUESS_WORD = { 拒绝: '可能是拒信', 面试邀约: '可能是面试邀请', 回复: '可能是回复', 申请确认: '可能是申请确认' };
const dayOf = (t) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(t);
export function guessAsks({ events = lines('state/inbox-events.ndjson'), leads = lines('state/leads.ndjson'), account = loadAccount(), now = Date.now() } = {}) {
  if (!account) return [];
  const list = events.filter((e) => e.source === 'builtin-mail' && e.category === '待确认');
  const day = dayOf(now);
  if (!list.length || (read(GUESS_ACK, {}) || {}).day === day) return [];
  const url = webmailUrl(account);
  const who = (e) => { const l = leads.find((x) => (x.record_id || x.id) === e.record_id); return l ? `#${l.number ?? ''} ${l.company || ''}`.trim() : String(e.from || '').replace(/\s*<.*$/, '') || '招聘方'; };
  return [{
    from: 'watch', id: `builtin-mail-guess:${day}`, type: 'info', title: '邮箱 · 没判断的信',
    question: `${list.length} 封求职邮件没能判断（没有能用的模型），阶段没动`,
    context: [],
    affected: list.slice(-12).map((e) => ({ id: e.message_id, label: `${who(e)} · ${GUESS_WORD[e.guess] || '没认出'} · ${e.subject || '（无标题）'}`.slice(0, 100) })),
    options: [
      ...(url ? [{ key: '1', label: '打开邮箱', steps: [{ type: 'open', url }], primary: true }] : []),
      { key: url ? '2' : '1', label: '知道了', steps: [{ type: 'builtin_mail', action: 'guess_ack', day }] },
    ],
    other: null,
    notice: true, // 告诉你一声（lib/notices.mjs）

  }];
}
export function ackGuess(day) { write(GUESS_ACK, { day: String(day || '') }); return '收起了，明天还有没判断的再提醒'; }

// 内置邮箱断开了（或账号文件坏了），已批准的内置邮箱的信停在队列里（bin/send-approved.mjs，兜底清单复核 N01）：一封信说明原因和下一步。
// 重新连上邮箱以后照批准的那一版发出，这封信跟着没了；「不发了」把这几封作废。
const heldOf = (requests, drafts) => requests.filter((r) => r.status === 'queued' && r.held_at && (r.channel || 'email') === 'email' && (r.via === 'builtin-mail' || drafts.find((d) => d.draft_id === r.draft_id)?.via === 'builtin-mail'));
export function heldAsks({ requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), leads = lines('state/leads.ndjson'), account = loadAccount() } = {}) {
  if (account) return [];
  const held = heldOf(requests, drafts);
  if (!held.length) return [];
  const broken = accountBroken();
  return [{
    from: 'reacher', id: `builtin-mail-held:${hash(held.map((r) => r.id)).slice(0, 12)}`, type: 'decide', title: '邮箱 · 发信',
    question: `${held.length} 封已批准的邮件没发出去：内置邮箱${broken ? '的设置读不出来了' : '断开了'}`,
    context: ['不会换别的邮箱发；重新连上邮箱以后，照你批准的那一版发出'],
    affected: held.slice(-12).map((r) => { const l = leads.find((x) => (x.record_id || x.id) === r.record_id); const d = drafts.find((x) => x.draft_id === r.draft_id); return { id: r.id, label: `${l ? `#${l.number ?? ''} ${l.company || ''}`.trim() : ''}${d?.to ? ` → ${d.to}` : ''}`.trim() || r.id }; }),
    options: [
      { key: '1', label: '重新连接邮箱', primary: true, steps: [{ type: 'navigate', to: '#settings/accounts/mail' }] },
      { key: '2', label: '不发了', steps: [{ type: 'builtin_mail', action: 'held_drop', ids: held.map((r) => r.id) }] },
    ],
    other: null,
  }];
}
// 只收信（第 6b 轮：收信通、发信端口被代理拦了）：已批准的内置邮箱的信停在队列里（lib/mail/send.mjs holdForSend）。一封信说清为什么、能怎么办：
// 换个不封发信的节点后重新测试（过了就照批准的那一版发出）；或者自己在邮箱里发（这几封不再自动发，免得发两遍）；或者不发了。
const blockedOf = requests => requests.filter((r) => r.status === 'queued' && r.held_reason === 'send_blocked' && (r.channel || 'email') === 'email');
export function sendBlockedAsks({ requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), leads = lines('state/leads.ndjson'), account = loadAccount() } = {}) {
  if (!account || account.send?.ok !== false) return [];
  const held = blockedOf(requests);
  if (!held.length) return [];
  const url = webmailUrl(account), ids = held.map((r) => r.id);
  return [{
    from: 'reacher', id: `builtin-mail-send-blocked:${hash(ids).slice(0, 12)}`, type: 'decide', title: '邮箱 · 发信',
    question: `${held.length} 封已批准的邮件没发出去：现在只能收信，发信不通`,
    context: [String(account.send.reason || '发信服务器连不上').slice(0, 300), '草稿在岗位页上，自己发的话把正文复制过去'],
    affected: held.slice(-12).map((r) => { const l = leads.find((x) => (x.record_id || x.id) === r.record_id); const d = drafts.find((x) => x.draft_id === r.draft_id); return { id: r.id, label: `${l ? `#${l.number ?? ''} ${l.company || ''}`.trim() : ''}${d?.to ? ` → ${d.to}` : ''}`.trim() || r.id }; }),
    options: [
      { key: '1', label: '重新测试邮箱', primary: true, steps: [{ type: 'navigate', to: '#settings/accounts/mail' }] },
      { key: '2', label: '我自己在邮箱里发', hint: '这几封不再自动发', steps: [...(url ? [{ type: 'open', url }] : []), { type: 'builtin_mail', action: 'held_by_hand', ids }] },
      { key: '3', label: '不发了', steps: [{ type: 'builtin_mail', action: 'held_drop', ids }] },
    ],
    other: null,
  }];
}
// Mac 版还没接邮箱，可你已经批准了要发的邮件（第 6b 轮：Reacher 要发信时，没人说邮箱还没接）：一封信，点「接上邮箱」直接到接邮箱那一页
// （lib/unlock.mjs MAIL_GO）；接上以后这几封照你批准的那一版发出去。命令行装的走自己的发信路子，不来这封。
export function noMailboxAsks({ requests = lines('state/send-requests.ndjson'), leads = lines('state/leads.ndjson'), account = loadAccount(), desktop = appShell() } = {}) {
  if (!desktop || account) return [];
  const waiting = requests.filter((r) => r.status === 'queued' && (r.channel || 'email') === 'email');
  if (!waiting.length) return [];
  return [{
    from: 'reacher', id: 'builtin-mail-none', type: 'decide', title: '邮箱 · 发信',
    question: `${waiting.length} 封已批准的邮件在等：还没接邮箱，发不出去`,
    context: ['接上以后照你批准的那一版发出去'],
    affected: waiting.slice(-12).map((r) => { const l = leads.find((x) => (x.record_id || x.id) === r.record_id); return { id: r.id, label: l ? `#${l.number ?? ''} ${l.company || ''}`.trim() : r.to || '' }; }),
    options: [
      { key: '1', label: '接上邮箱', primary: true, hint: '招聘方的回信也会自动读进来', steps: [{ type: 'navigate', to: '#settings/accounts/mail' }] },
      { key: '2', label: '明天再说', steps: [{ type: 'snooze', hours: 24 }] },
    ],
    other: null,
  }];
}
// 「我自己在邮箱里发」：这几封记成你自己发（不再自动发，免得发两遍）。
export async function handHeld(ids, { now = Date.now() } = {}) {
  const want = new Set((ids || []).map(String)), requests = lines('state/send-requests.ndjson');
  let n = 0;
  for (const r of blockedOf(requests)) if (want.has(r.id)) { Object.assign(r, { status: 'cancelled', reason: 'sent_by_hand', cancelled_at: new Date(now).toISOString() }); n++; }
  if (n) writeLines('state/send-requests.ndjson', requests);
  return n ? `${n} 封记成你自己发，系统不再发` : '没有要改的';
}
export async function dropHeld(ids, { now = Date.now() } = {}) {
  const want = new Set((ids || []).map(String)), requests = lines('state/send-requests.ndjson');
  let n = 0;
  for (const r of [...new Set([...heldOf(requests, lines('state/drafts.ndjson')), ...blockedOf(requests)])]) if (want.has(r.id)) { Object.assign(r, { status: 'cancelled', reason: 'held_dropped', cancelled_at: new Date(now).toISOString() }); n++; }
  writeLines('state/send-requests.ndjson', requests);
  return n ? `好，这 ${n} 封不发了` : '这几封的状态已经变了，刷新看一眼';
}
