// 面试时间一键确认（内置邮箱，第 3 批之后）：招聘方的面试邀请里带了时间（日历邀请，lead.interview_proposed），收件箱「安排面试时间」
// 那封信直接给出这个时间和一封写好的短回复，按钮「确认并回复」「换个时间」（lib/asks.mjs interviewAsk）。
//   回复     代码按模板写（不调模型）：确认这个时间、署名，接在对方那封邀请的线程里（In-Reply-To / References），后面附上引用的原信。
//            信上显示的就是要发的这一版：草稿编号由线索、邀请的 Message-ID 和时间算出来，指纹在显示时就定了。
//   确认     你点「确认并回复」：再算一遍，指纹和你看到的一样才算数——草稿记成给你看过（notified_at、displayed_hash），
//            加一条绑在这个指纹上的发送批准（和「发 N」同一种，lib/mail/send.mjs 发），面试时间照「N 面试 …」记下（下一步命令）。
//            时间或对方的信变了，指纹对不上：不发，请你刷新再看。
//   换个时间 打开对话（#…?talk=1），你说想约什么时候，Writer 起草回复给你看。
import { lines, writeLines, read, hash } from '../store.mjs';
import { draftFingerprint } from '../drafts.mjs';
import { currentFacts } from '../facts.mjs';
import { factsBlocker, assertFactsUsable } from '../facts-gate.mjs';
import { TZ, utcOffset } from '../tz.mjs';
import { loadAccount } from './vault.mjs';
import { messagePath } from './inbox.mjs';
import { quoteOf } from './draft.mjs';

const leadKey = (l) => l?.record_id || l?.id || null;
const cjk = (s) => (String(s).match(/[一-鿿]/g) || []).length;
const parts = (at, locale, opts) => Object.fromEntries(new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));

// 信里怎么写这个时间：中文「10月8日（周二）15:00（北京时间）」，英文「Tue, Oct 8, 3:00 PM (UTC+08:00)」。
export function whenText(at, lang) {
  const off = utcOffset(at);
  if (lang === 'zh') {
    const p = parts(at, 'zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return `${p.month}月${p.day}日（${p.weekday}）${p.hour}:${p.minute}（${TZ === 'Asia/Shanghai' ? '北京时间' : `UTC${off}`}）`;
  }
  return `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))} (UTC${off})`;
}
// 「N 面试 YYYY-MM-DD HH:mm」用的本地时间（bin/action.mjs 按 TZ 读）。
export const localStamp = (at) => { const p = parts(at, 'sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };

// 这条线索现在能不能一键确认：{ at, when, draft, fingerprint, number } 或 null。
export function interviewReply(record_id, { leads = lines('state/leads.ndjson'), events = lines('state/inbox-events.ndjson'), account = loadAccount(), facts = currentFacts(), now = Date.now() } = {}) {
  if (!account) return null;
  if (factsBlocker()) return null; // 资料挡住了：不起草这封回复（会没有署名），收件箱照旧只有「记录面试时间」，横条说原因（lib/facts-gate.mjs）
  const lead = leads.find((l) => leadKey(l) === record_id);
  if (!lead || lead.interview_at) return null;
  const p = (lead.interview_proposed || []).filter((x) => Date.parse(x.at) > now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!p) return null;
  const ev = events.filter((e) => e.source === 'builtin-mail' && e.record_id === record_id && e.category === '面试邀约' && e.rfc_id && e.from_address).at(-1);
  const original = ev ? read(messagePath(ev.message_id), null) : null;
  if (!original) return null;
  const lang = cjk(original.text) * 2 > String(original.text || '').replace(/\s/g, '').length * 0.3 ? 'zh' : 'en';
  const id = facts?.identity || {}, name = String((lang === 'zh' ? id.name_zh || id.name_en : id.name_en || id.name_zh) || '').trim();
  const when = whenText(p.at, lang);
  const text = lang === 'zh' ? `您好，\n\n${when}的面试我可以参加，到时见。谢谢！${name ? `\n\n${name}` : ''}` : `Hi,\n\n${when} works for me. I look forward to speaking with you.${name ? `\n\nBest,\n${name}` : ''}`;
  const quote = quoteOf(original, lang);
  const subject = /^(re|回复|答复)\s*[:：]/i.test(String(original.subject || '')) ? original.subject : `Re: ${original.subject || ''}`;
  const draft = {
    number: lead.number ?? null, record_id, channel: 'email', draft_id: `mail-iv-${hash([record_id, ev.rfc_id, p.at]).slice(0, 12)}`,
    to: original.from_address, subject, body: `${text}${quote}`, quote_len: quote.length, attachments: [], status: 'ready', purpose: 'reply',
    parent_outbound_id: ev.parent_outbound_id || null, parent_thread_id: null, reply_message_id: ev.rfc_id,
    in_reply_to: ev.rfc_id, references: [...(original.references || []), ev.rfc_id].slice(-10),
    by: 'code', via: 'builtin-mail', interview_at: p.at,
  };
  return { at: p.at, when, draft, fingerprint: draftFingerprint(draft), number: lead.number ?? null };
}

// 「确认并回复」：指纹对得上才记下草稿，发送和别的信一样走 requestAction（lib/actions.mjs：过闸、按你确认的指纹记批准、叫醒发信）。
// 以前这里直接往发送请求里加一行，App 里没有动作接它，写的「马上发出」不成立。回一句回执。
export async function confirmInterview({ record_id, fingerprint }, { now = Date.now(), request = null } = {}) {
  assertFactsUsable(); // 资料挡住了：不记草稿、不排发送，409 带横条那句话（lib/facts-gate.mjs）
  let ir, d;
  {
    ir = interviewReply(String(record_id || ''), { now });
    if (!ir || ir.fingerprint !== fingerprint) throw Error('面试时间或这封回复刚变了，刷新再看一眼');
    const at = new Date(now).toISOString();
    const drafts = lines('state/drafts.ndjson');
    for (const x of drafts) if (x.record_id === record_id && x.purpose === 'reply' && x.via === 'builtin-mail' && ['ready', 'editing'].includes(x.status) && x.draft_id !== ir.draft.draft_id) Object.assign(x, { status: 'cancelled', reason: 'superseded', cancelled_at: at });
    const existing = drafts.find((x) => x.draft_id === ir.draft.draft_id);
    d = existing || { ...ir.draft, created_at: at };
    if (!existing) drafts.push(d);
    if (d.status !== 'sent') Object.assign(d, { status: 'ready', notified_at: d.notified_at || at, displayed_hash: fingerprint, displayed_on: 'inbox' });
    writeLines('state/drafts.ndjson', drafts);
  }
  const ask = request || (await import('../action-kinds.mjs')).requestAction;
  const r = await ask('send_email', { draft_id: d.draft_id }, { origin: 'inbox', confirm: fingerprint, now });
  if (r.needs_confirm) throw Error('这封回复刚变了，刷新再看一眼');
  if (r.blocked) throw Object.assign(Error(r.reason), { status: 409, ...(r.fix ? { fix: r.fix } : {}) });
  if (r.duplicate) return '这封回复已经排上了，不会重复发';
  return r.sandbox ? r.receipt : `回复排上了，马上从你的邮箱发出（${ir.when}）`;
}

// 收件箱「安排面试时间」那封信的样子：问题、预览、按钮；不能一键确认就回 null（照旧只有「记录面试时间」）。
export function interviewConfirmAsk(q) {
  const rid = q?.lead?.record_id;
  const ir = rid ? interviewReply(rid) : null;
  if (!ir) return null;
  const n = q.lead.number;
  return {
    question: `招聘方约了 ${ir.when} 面试`,
    preview: { kind: 'draft', channel: 'email', to: ir.draft.to, subject: ir.draft.subject, body: ir.draft.body, attachments: [], fingerprint: ir.fingerprint },
    options: [
      { key: '1', label: '确认并回复', primary: true, needs: ['preview'], hint: '从你的邮箱发出这封回复，面试时间一并记下', steps: [{ type: 'builtin_mail', action: 'interview_confirm', record_id: rid, fingerprint: ir.fingerprint }, { type: 'command', text: `${n} 面试 ${localStamp(ir.at)}` }] },
      { key: '2', label: '换个时间', steps: [{ type: 'navigate', to: '#inbox?talk=1' }] },
      { key: '3', label: '记录面试时间', steps: [{ type: 'command', text: `${n} 面试 {datetime}` }], input: 'datetime' },
    ],
  };
}
