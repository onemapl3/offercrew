// 发信（内置邮箱第 3 批，方案 §四.4）：只发你批准的那一版——批准号（state/send-requests.ndjson）加正文指纹（lib/gmail.mjs draftFingerprint）。
// 接了内置邮箱时 bin/send-approved.mjs 改走这里，不交给 Gmail 连接器。
//
//   发之前   再核一遍（checkRequest，和 bin/send-approved.mjs 同一套规矩）：草稿还在、还是 ready、指纹和批准时一样、给你看过；
//            线索没被你结束；回复 / 跟进的上一封有回执；首联没发过；收件人是一个像样的地址；附件就是批准时的那几个文件
//            （名字、大小都对得上，只认数据目录里的文件）。有一条不对就不发：needs_review / cancelled，照实记原因。
//   发       先拿锁把请求记成 sending（再发），一封信的原文由 MailComposer 拼好：发出去的和存进「已发送」的是同一份字节。
//            Message-ID 由批准号算出来，同一个批准永远是同一个 Message-ID，对账按它找。回复带 In-Reply-To / References，
//            对方看到的是同一个对话。不加 X-Mailer，EHLO 不报这台 Mac 的名字（lib/mail/connect.mjs smtpOptions）。
//   结果     正文交出去之前就失败的（连不上、授权码不对、收件人被拒）肯定没发出去：网络、授权码的问题留在队列里下次再试，
//            收件人被拒、服务器拒收的记 failed。正文开始交付以后出的错（断线、超时）不确定发没发出去：记 uncertain，
//            不重发；下一次去「已发送」里按 Message-ID 找，找到了补记回执，找不到就一直留着给你看。
//   已发送   Gmail 自己存；别家先在「已发送」里按 Message-ID 找一下（有的邮箱自己会存），没有才放进去（APPEND，标成已读）。
//            这是唯一一处往邮箱里写东西，只写「已发送」这一个文件夹。
//   回执     state/outbound.ndjson 一行（external_id、message_id 都是这个 Message-ID）；请求、草稿改成 sent；首联把线索推进到
//            「已联系」；飞书表格交给 state/inbox-base-pending.json。
//   测试     只连本机的假 SMTP / IMAP（lib/mail/connect.mjs checkServer：测试、沙盒里连不了本机以外的服务器）。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import { lines, writeLines, read, write, file, root, hash } from '../store.mjs';
import { lock } from '../lock.mjs';
import { event } from '../events.mjs';
import { noteSwallowed } from '../swallow.mjs';
import { getAction, listActions, settle as settleAction } from '../actions.mjs';
import { SEND_TRIES, RETRY_MS, KIND_WORDS, UNKNOWN_WHY, gaveUpLine } from './send-words.mjs';
import { reword } from '../jobs.mjs';
import { dbExists, db } from '../db.mjs';
import { draftFingerprint, followupParent } from '../drafts.mjs';
import { closedByUser, applyEvent, endedLead } from '../lead-state.mjs';
import { currentFacts, resumeList } from '../facts.mjs';
import { loadAccount, loadSecret, markChecked } from './vault.mjs';
import { mailTarget, SKIP_STATUS } from './inbox.mjs';
import { smtpOpen, routesFor, explainAttempts, openInbox, checkServer } from './connect.mjs';
export { tunnel } from './connect.mjs';
import { ADDRESS, domainOf } from './providers.mjs';

export const SENDING = 'sending', UNCERTAIN = 'uncertain';
export { SEND_TRIES, RETRY_MS };
const fail = (code, message) => Object.assign(Error(message), { code });
const wrap = (id) => { const s = String(id || '').trim().replace(/^<|>$/g, ''); return s ? `<${s}>` : ''; };
const rfcId = (id) => /@/.test(String(id || ''));
// 证据里留的原文：错误码 + 第一行消息，去掉授权码，最多 160 字。
const scrubRaw = (e, pass) => { const t = [e?.code, String(e?.message || e || '').split('\n')[0]].filter(Boolean).join(' ').replace(new RegExp(String(pass || '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***'); return t.slice(0, 160) || null; };

// 同一个批准永远是同一个 Message-ID（不确定发没发出去时，按它去「已发送」里找）。
export const messageIdFor = (request, address) => `<oc.${hash([request.id, request.draft_id]).slice(0, 24)}@${domainOf(address) || 'offercrew.invalid'}>`;

// 一个批准现在能不能发。回 { ok, d, lead } / { status, reason } / { hold }（先不动，下一次再看）。
export function checkRequest(r, { drafts = [], outbound = [], leads = [], pending = [], events = [] } = {}) {
  const d = drafts.find((x) => x.draft_id === r.draft_id);
  const prior = outbound.filter((o) => o.record_id === r.record_id && (o.channel || 'email') === 'email');
  if ((!['followup', 'reply'].includes(r.purpose) && prior.length) || prior.some((o) => o.draft_id === r.draft_id)) return { status: 'sent', reason: 'already_sent' };
  // 回复接在我们发过的那封后面，或者接在招聘方直接发来、登记过的那封信后面。
  const anchored = r.reply_message_id && events.some((e) => e.source === 'builtin-mail' && e.record_id === r.record_id && e.rfc_id === r.reply_message_id);
  if (r.purpose === 'reply' && !anchored && !prior.some((o) => [r.parent_outbound_id].filter(Boolean).includes(o.id) || (r.parent_thread_id && [o.thread_id, o.to, o.message_id].includes(r.parent_thread_id)))) return { status: 'needs_review', reason: 'reply_parent_missing' };
  const lead = leads.find((l) => (l.record_id || l.id) === r.record_id) || null;
  if (closedByUser(lead)) return { status: 'cancelled', reason: 'lead_closed' };
  if (r.purpose === 'followup' && (d?.purpose !== 'followup' || d.record_id !== r.record_id || (d.channel || 'email') !== 'email' || d.parent_thread_id !== r.parent_thread_id || d.reply_message_id !== r.reply_message_id)) return { status: 'needs_review', reason: 'draft_changed' };
  const followup = r.purpose === 'followup' ? followupParent({ ...r, to: d?.to }, outbound) : null;
  if (r.purpose === 'followup' && (!followup || followup.duplicate)) return { status: 'needs_review', reason: 'followup_parent_or_duplicate' };
  if (!d || d.status !== 'ready' || draftFingerprint(d) !== r.fingerprint || !d.notified_at || d.displayed_hash !== r.fingerprint) return { status: 'needs_review', reason: 'draft_changed' };
  if (pending.includes(r.record_id)) return { hold: 'prior_contact_reconciliation_required' };
  if (!ADDRESS.test(String(d.to || '').trim()) || /[,;]/.test(String(d.to))) return { status: 'needs_review', reason: 'bad_recipient' };
  return { ok: true, d, lead };
}

// 批准时的附件：名字和大小都要对得上；只认数据目录里的文件（不在 private/ 下），路径没写就按名字在 resume_routing 的简历里找。
export function attachmentFiles(d, { facts = currentFacts() } = {}) {
  const base = fs.realpathSync(root);
  const inside = (p) => { try { const real = fs.realpathSync(p); return (real === base || real.startsWith(base + path.sep)) && !real.startsWith(path.join(base, 'private') + path.sep) && fs.statSync(real).isFile() ? real : null; } catch { return null; } }; /* 兜底：文件不在、读不了就是 null：下面按「附件找不到了」拦下，不发 */
  const known = resumeList(facts).map((p) => (path.isAbsolute(p) ? p : file(p)));
  return (Array.isArray(d.attachments) ? d.attachments : []).map((a) => {
    const name = String(a?.name || '').trim();
    const wanted = a?.path ? (path.isAbsolute(a.path) ? a.path : file(a.path)) : known.find((p) => path.basename(p) === name);
    const real = wanted ? inside(wanted) : null;
    if (!name || !real) throw fail('attachment_missing', `附件「${name || '?'}」找不到了`);
    const size = fs.statSync(real).size;
    if (!size || (a.size != null && Number(a.size) !== size)) throw fail('attachment_changed', `附件「${name}」和批准时不一样了`);
    return { filename: name, path: real };
  });
}

// 回复接在哪封信后面：草稿上写的（in_reply_to / references，起草时从那封来信带过来）；跟进接在我们上一封后面。
function threading(d, r, outbound) {
  let parent = d.in_reply_to || null;
  if (!parent && r.purpose === 'followup') parent = outbound.find((o) => (o.external_id || o.message_id) === r.reply_message_id && rfcId(o.message_id))?.message_id || null;
  if (!parent || !rfcId(parent)) return {};
  const refs = [...(Array.isArray(d.references) ? d.references : []), parent].filter(rfcId).map(wrap);
  return { inReplyTo: wrap(parent), references: [...new Set(refs)].join(' ') };
}

// 拼一封信的原文（Buffer）。发信人的名字：正文是中文用中文名，否则用英文名。
export async function composeRaw(d, r, account, { files = [], outbound = [], now = new Date(), messageId } = {}) {
  const id = currentFacts()?.identity || {};
  const cjk = /[一-鿿]/.test(String(d.body || ''));
  const name = String((cjk ? id.name_zh : id.name_en) || id.name_en || id.name_zh || '').trim();
  const mail = {
    from: name ? { name, address: account.address } : account.address,
    to: String(d.to).trim(),
    subject: String(d.subject || ''),
    text: String(d.body || ''),
    messageId, date: now,
    attachments: files.map((f) => ({ filename: f.filename, path: f.path })),
    ...threading(d, r, outbound),
  };
  return new Promise((resolve, reject) => new MailComposer(mail).compile().build((e, buf) => (e ? reject(e) : resolve(buf))));
}

// 用 SMTP 发一封原文。started：服务器回了 354、正文开始交付（这之后出错就是不确定）。
// routes：线路（lib/mail/connect.mjs routesFor）；连接阶段不通换下一条，那时一个字都没发，不会发两遍。不给就只走 proxy 这一条。
// 回 { ok: true, info, route } / { ok: false, error, uncertain, rejected }。连不上时 error 上挂着每条线路的结果（explainAttempts 用）。
export async function smtpSend(target, pass, raw, envelope, { proxy = null, routes = null, limits = {} } = {}) {
  let open;
  try { open = await smtpOpen(target, pass, { routes, proxy, limits }); } catch (error) { return { ok: false, error, uncertain: false, rejected: false }; }
  const { conn, opts, closed, route } = open;
  let started = false;
  const body = new Readable({ read() { if (!started) { started = true; this.push(raw); this.push(null); } } });
  const r = await Promise.race([
    closed.then((error) => ({ ok: false, error })),
    new Promise((resolve) => conn.login(opts.auth, (e) => {
      if (e) return resolve({ ok: false, error: e });
      conn.send(envelope, body, (e2, info) => resolve(e2 ? { ok: false, error: e2 } : { ok: true, info }));
    })),
  ]);
  try { conn.quit(); } catch { /* 兜底：连接已经断了，说再见失败不影响这封的结局（上面已经定了） */ }
  setTimeout(() => { try { conn.close(); } catch { /* 兜底：连接已经关了 */ } }, 2000).unref?.();
  if (r.ok) return { ...r, route };
  const code = String(r.error?.code || '');
  // 信封被拒（EENVELOPE：MAIL FROM / RCPT TO / DATA 被拒，正文是被 nodemailer 自己倒掉的）、服务器对正文明确拒收（EMESSAGE）：肯定没发出去。
  const rejected = code === 'EENVELOPE' || code === 'EMESSAGE';
  return { ...r, route, rejected, uncertain: started && !rejected };
}

// 「已发送」文件夹：特殊用途 \Sent，没有就按常见的名字认。
async function sentFolder(client) {
  const list = await client.list();
  const hit = list.find((f) => f.specialUse === '\\Sent')
    || list.find((f) => /^(?:sent|sent messages|sent items|sent mail|已发送|已发送邮件)$/i.test(String(f.name || '')));
  return hit?.path || null;
}
// 在「已发送」里按 Message-ID 找；save 时找不到就放进去。回 { found } / { appended, folder } / { skipped }。
export async function sentCopy(target, pass, messageId, { provider = null, env = process.env, limits = {}, raw = null, waitMs = 3000 } = {}) {
  const { client } = await openInbox(target, pass, { routes: routesFor('imap', target, { provider, env }), limits, member: 'quill', ...(target.imap_user ? { users: [target.imap_user] } : {}) });
  try {
    const folder = await sentFolder(client);
    if (!folder) return { skipped: 'no_sent_folder' };
    if (raw && waitMs) await new Promise((r) => setTimeout(r, waitMs)); // 有的邮箱发完自己存一份，等它一下再找
    const box = await client.getMailboxLock(folder, { readOnly: true });
    let found = false;
    try { found = (((await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []).length) > 0; } finally { box.release(); }
    if (found || !raw) return { found, folder };
    if (provider?.provider === 'gmail') return { skipped: 'gmail_saves_itself', folder };
    // imapflow 只附带所选文件夹允许的标记，只读打开的文件夹一个都不许：先关掉它再放（只读时 CLOSE 不删任何信，RFC 3501 6.4.2）。
    await client.mailboxClose();
    await client.append(folder, raw, ['\\Seen'], new Date());
    return { appended: true, folder };
  } finally { await client.logout().catch(() => {}); /* 兜底：退出登录失败不影响已经找到 / 放进去的结果 */ }
}

const nowIso = (now) => new Date(now).toISOString();
// 不确定的那封什么时候再去「已发送」里找：两周以内，每封最多每小时一次（QQ、163 限制登录频率）。
export const recheckDue = (r, now) => now - Date.parse(r.uncertain_at || 0) < 14 * 86400000 && !(now - Date.parse(r.recheck_at || 0) < 3600000);
// 发完写回（调用方持锁、负责落盘）：请求、草稿、回执、线索、飞书。
function settle(x, { requests, drafts, outbound, leads, base, now }) {
  const req = requests.find((q) => q.id === x.id);
  if (!req) return null;
  const at = nowIso(now);
  if (x.status === 'sent') {
    const d = drafts.find((q) => q.draft_id === req.draft_id);
    Object.assign(req, { status: 'sent', external_id: x.message_id, message_id: x.message_id, sent_at: at, via: 'builtin-mail' });
    delete req.sending_at;
    if (!outbound.some((o) => o.external_id === x.message_id)) {
      outbound.push({ id: `mail-${hash([x.message_id]).slice(0, 16)}`, record_id: req.record_id, channel: 'email', external_id: x.message_id, message_id: x.message_id, at,
        to: d?.to || null, evidence: x.evidence || 'smtp', purpose: req.purpose || 'first_contact', draft_id: req.draft_id, approval_id: req.id, action_id: req.action_id || null, via: 'builtin-mail',
        ...(req.parent_thread_id ? { thread_id: req.parent_thread_id } : {}) });
    }
    if (d) { d.status = 'sent'; d.sent_at = at; }
    const lead = leads.find((l) => (l.record_id || l.id) === req.record_id);
    const first = (req.purpose || 'first_contact') === 'first_contact';
    if (lead && first && !lead.replied_at && !lead.interview_at && !endedLead(lead)) {
      applyEvent(lead, 'sent', {}, { at, source: 'builtin-mail' });
      if (lead.record_id) base[lead.record_id] = { 阶段: ['已联系'] };
    }
    return { ...x, lead };
  }
  if (x.status === UNCERTAIN) { const again = req.status === UNCERTAIN; Object.assign(req, { status: UNCERTAIN, message_id: x.message_id, uncertain_at: req.uncertain_at || at, recheck_at: at, reason: x.reason || null }); delete req.sending_at; return { ...x, again }; }
  // 连不上（网络、超时、代理、授权码）：记下原因（一句人话 + 证据里的原文），留在队列里过一会儿再试；试满 SEND_TRIES 次就落成失败，
  // 收件箱给「再试一次」「我自己发了」「这封不发了」（lib/mail/asks.mjs sendAsks，实测 10-04 #503：一直排着、原因只有一个 timeout）。
  if (x.status === 'queued') {
    const tries = (Number(req.tries) || 0) + 1;
    Object.assign(req, { last_error: x.reason || null, last_reason: x.why || null, last_error_raw: x.raw || null, last_try_at: at, tries });
    delete req.sending_at;
    if (tries >= SEND_TRIES) { Object.assign(req, { status: 'failed', reason: x.reason || 'unreachable', unreachable: true, failed_at: at }); return { ...x, status: 'failed' }; }
    req.status = 'queued';
    return { ...x, tries };
  }
  Object.assign(req, { status: x.status, reason: x.reason || null, [`${x.status}_at`]: at });
  delete req.sending_at;
  return x;
}

// 一次发信。回 { status, sent, uncertain, failed, held, errors, results }（不含信的内容）。
async function holdForSend(at) {
  const requests = lines('state/send-requests.ndjson');
  let n = 0;
  for (const r of requests) if (r.status === 'queued' && (r.channel || 'email') === 'email' && r.held_reason !== 'send_blocked') { Object.assign(r, { held_at: r.held_at || nowIso(at), held_reason: 'send_blocked' }); n++; }
  if (n) writeLines('state/send-requests.ndjson', requests);
  return { status: 'skipped', reason: 'receive_only', held: n };
}
// only：只发这几条发送请求（lib/workers.mjs 从 actions 领走的那几条）。不给就发队列里所有的（命令行周期那一步，App 里不跑）。
//   App 里一定给：以前不给，领走一封新信就会把旧版留下的、几天前批准的排队信一起发出去（线 F）。
export async function sendQueued({ now = () => Date.now(), env = process.env, limits = {}, waitMs = 3000, only = null } = {}) {
  const account = loadAccount();
  if (!account) return { status: 'no_change', reason: 'not_connected' };
  if (SKIP_STATUS.has(account.status)) return { status: 'skipped', reason: `waiting_for_new_code:${account.status}` };
  const t = mailTarget(account);
  if (t.skip) return { status: 'skipped', reason: t.skip };
  // 只收信（第 6b 轮：收信通、发信端口被代理拦了）：不去连发信服务器、不悄悄一直重试。排着的信记下停在这儿和为什么，
  // 收件箱来一封信（lib/mail/asks.mjs sendBlockedAsks）：重新测试、自己在邮箱里发、或者不发了。重新测试过了就照批准的那一版发。
  if (account.send?.ok === false) return holdForSend(now());
  let release;
  try { release = lock('mailsend'); } catch { return { status: 'skipped', reason: 'another_mail_send_running' }; }
  try {
    const { target, provider } = t;
    checkServer(target.smtp, 'SMTP'); checkServer(target.imap, 'IMAP');
    // 没有要发的、要对账的，就不去读钥匙串。
    if (!sendDue({ now: now() })) return { status: 'no_change', sent: 0 };
    let pass;
    try { pass = await loadSecret(account); } catch (e) { markChecked({ ok: false, kind: 'secret', reason: e.message }); return { status: 'failed', kind: 'secret' }; }

    // 1. 拿锁挑出要发的，记成 sending；该作废、该复核的照实改掉。
    const picked = [], settled = [];
    const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), outbound = lines('state/outbound.ndjson'), leads = lines('state/leads.ndjson');
    const pending = read('state/mail-reconciliation-pending.json', []) || [], events = lines('state/inbox-events.ndjson');
    let recheck = 0;
    for (const r of requests) {
      if ((r.channel || 'email') !== 'email') continue;
      // 上一次没收尾的（发到一半进程没了）和不确定的：只去「已发送」里找，不重发。不确定的只找两周内的，每次最多 3 封。
      if (r.status === SENDING) { picked.push({ r: { ...r }, check: false }); continue; }
      if (r.status === UNCERTAIN) { if (recheckDue(r, now()) && recheck < 3) { recheck++; picked.push({ r: { ...r }, check: false }); } continue; }
      if (r.status !== 'queued' || (only && !only.includes(r.id))) continue;
      const c = checkRequest(r, { drafts, outbound, leads, pending, events });
      if (c.hold) continue;
      // 这个渠道已经联系过、这一份已经有回执：和 bin/send-approved.mjs 一样记成已处理，不补回执。
      if (c.status === 'sent') { Object.assign(r, { status: 'sent', reason: c.reason }); continue; }
      if (!c.ok) { settled.push(settle({ id: r.id, status: c.status, reason: c.reason }, { requests, drafts, outbound, leads, base: {}, now: now() })); continue; }
      let files;
      try { files = attachmentFiles(c.d); } catch (e) { settled.push(settle({ id: r.id, status: 'needs_review', reason: e.code || 'attachment' }, { requests, drafts, outbound, leads, base: {}, now: now() })); continue; }
      const message_id = messageIdFor(r, account.address);
      delete r.held_reason; // 只收信时停下的那几封：发信通了，照批准的那一版发
      Object.assign(r, { status: SENDING, sending_at: nowIso(now()), message_id, via: 'builtin-mail' });
      picked.push({ r: { ...r }, d: c.d, files, outbound: [...outbound], check: true });
    }
    writeLines('state/send-requests.ndjson', requests);

    // 2. 发（不占锁）。上一次没收尾的 sending / uncertain 不重发，只去「已发送」里找。
    const results = [];
    const smtpRoutes = routesFor('smtp', target, { provider, env });
    for (const p of picked) {
      const message_id = p.r.message_id;
      if (!p.check) {
        let found = false;
        // 兜底：「已发送」里找不了（连不上、没登上）就当没找到——记不确定，不当成发出去了，也不重发；下一次再找（recheckDue）。
        try { found = !!(await sentCopy(target, pass, message_id, { provider, env, limits, waitMs: 0 })).found; } catch (e) { noteSwallowed('mail-send.sent-folder', e, { member: 'quill', doing: '去「已发送」里核对那封不确定的信', then: '还记不确定，过一会儿再找，不重发' }); }
        if (found) results.push({ id: p.r.id, status: 'sent', message_id, evidence: 'sent-folder' });
        else results.push({ id: p.r.id, status: UNCERTAIN, message_id, reason: p.r.reason || 'interrupted' });
        continue;
      }
      let raw;
      try { raw = await composeRaw(p.d, p.r, account, { files: p.files, outbound: p.outbound, now: new Date(now()), messageId: message_id }); }
      catch (e) { results.push({ id: p.r.id, status: 'needs_review', reason: `compose:${String(e.message).slice(0, 80)}` }); continue; }
      const s = await smtpSend(target, pass, raw, { from: account.address, to: [String(p.d.to).trim()] }, { routes: smtpRoutes, limits });
      if (s.ok) {
        let saved = null;
        try { saved = await sentCopy(target, pass, message_id, { provider, env, limits, raw, waitMs }); } catch (e) { saved = { error: String(e.message).slice(0, 80) }; }
        results.push({ id: p.r.id, status: 'sent', message_id, evidence: `smtp:${String(s.info?.response || '').slice(0, 120)}`, saved });
        continue;
      }
      const why = await explainAttempts(s.error, { step: 'smtp', provider, host: target.smtp.host, port: target.smtp.port, proxy: s.route?.proxy || null, secrets: [pass] });
      if (s.uncertain) results.push({ id: p.r.id, status: UNCERTAIN, message_id, reason: why.kind });
      else if (s.rejected) results.push({ id: p.r.id, status: 'failed', reason: why.server || why.kind });
      else {
        if (why.kind === 'auth') markChecked({ ok: false, ...why });
        results.push({ id: p.r.id, status: 'queued', reason: why.kind, why: why.reason || null, raw: scrubRaw(s.error, pass) });
      }
    }

    // 3. 拿锁写回。
    const base = {};
    let done = [];
    if (results.length) {
      const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), outbound = lines('state/outbound.ndjson'), leads = lines('state/leads.ndjson');
      done = results.map((x) => settle(x, { requests, drafts, outbound, leads, base, now: now() })).filter(Boolean);
      writeLines('state/send-requests.ndjson', requests);
      if (done.some((x) => x.status === 'sent')) {
        writeLines('state/outbound.ndjson', outbound); writeLines('state/drafts.ndjson', drafts); writeLines('state/leads.ndjson', leads);
        const sentIds = new Set(done.filter((x) => x.status === 'sent').map((x) => requests.find((q) => q.id === x.id)?.record_id).filter(Boolean));
        write('state/mail-reconciliation-pending.json', (read('state/mail-reconciliation-pending.json', []) || []).filter((id) => !sentIds.has(id)));
      }
      if (Object.keys(base).length) write('state/inbox-base-pending.json', { ...(read('state/inbox-base-pending.json', {}) || {}), ...base });
    }
    const count = (s) => [...done, ...settled].filter((x) => x?.status === s).length;
    const out = { sent: count('sent'), uncertain: count(UNCERTAIN), failed: count('failed'), needs_review: count('needs_review'), cancelled: count('cancelled'), retry: count('queued') };
    for (const x of done.filter((y) => y.status === 'sent')) {
      const who = x.lead ? `#${x.lead.number ?? ''} ${x.lead.company || ''} 的` : '一封';
      // 发出去了，但没放进「已发送」（连不上、没找到那个文件夹）：如实说（兜底清单，邮件 7）。Gmail 自己存，不算。
      const missed = x.saved?.error ? `连邮箱出错：${x.saved.error}` : x.saved?.skipped === 'no_sent_folder' ? '邮箱里没找到「已发送」文件夹' : null;
      event('quill', 'send-approved', missed ? 'fail' : 'ok', `${who}邮件发出去了${x.saved?.appended ? '，已放进「已发送」' : missed ? `，但没放进「已发送」（${missed}）` : ''}`);
    }
    const fresh = done.filter((x) => x.status === UNCERTAIN && !x.again).length;
    if (fresh) event('quill', 'send-approved', 'fail', `${fresh} 封邮件不确定发出去了没有：不会重发，去「已发送」里看一眼`);
    const gaveUp = done.filter((y) => y.status === 'failed' && y.why), refused = out.failed - gaveUp.length;
    if (refused) event('quill', 'send-approved', 'fail', `${refused} 封邮件被对方服务器拒了，没发出去`);
    for (const y of gaveUp) event('quill', 'send-approved', 'fail', `一封邮件试了 ${SEND_TRIES} 次都没发出去：${y.why}`);
    for (const y of done.filter((z) => z.status === 'queued')) event('quill', 'send-approved', 'waiting_user', `一封邮件这次没发出去（第 ${y.tries}/${SEND_TRIES} 次），过 ${Math.round(RETRY_MS / 60000)} 分钟再试：${y.why || KIND_WORDS[y.reason] || '连不上发信服务器'}`);
    return { status: out.sent ? 'changed' : out.uncertain || out.failed || out.needs_review ? 'degraded' : 'no_change', ...out };
  } finally { release(); }
}

// ── 收件箱那几封信的按钮（lib/mail/asks.mjs）：你说发出去了 / 重新排队 / 不发了 ─────────────────────
// 你在「已发送」里看到了：补记回执（evidence: user），和自动对上的一样推进线索。
export async function userSettle(id, action, { now = Date.now() } = {}) {
  const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), outbound = lines('state/outbound.ndjson'), leads = lines('state/leads.ndjson');
  const req = requests.find((q) => q.id === id);
  if (!req || ![UNCERTAIN, 'failed'].includes(req.status)) throw Error('这封邮件的状态已经变了，刷新看一眼');
  const base = {};
  if (action === 'sent') {
    // 连不上、试满了次数的那封你在自己的邮箱里发了：记回执（evidence: user），和自动对上的一样推进线索。被对方拒收的不行。
    if (req.status !== UNCERTAIN && !req.unreachable) throw Error('被拒的信不能记成发出去了');
    settle({ id, status: 'sent', message_id: req.message_id || `user-${id}`, evidence: req.unreachable ? 'user_sent_by_hand' : 'user' }, { requests, drafts, outbound, leads, base, now });
    writeLines('state/outbound.ndjson', outbound); writeLines('state/drafts.ndjson', drafts); writeLines('state/leads.ndjson', leads);
    if (Object.keys(base).length) write('state/inbox-base-pending.json', { ...(read('state/inbox-base-pending.json', {}) || {}), ...base });
  } else if (action === 'requeue') {
    // 以前的「再发一次」只把请求放回队列，没有动作接它，写的「马上再发一次」不成立。现在信上的按钮走 requestAction（lib/mail/asks.mjs）；
    // 页面上还开着的旧信点到这里：不改任何东西，请你刷新拿新信。
    throw Error('这封信过期了，刷新以后再点「再发一次」');
  } else if (action === 'drop') {
    Object.assign(req, { status: 'cancelled', reason: req.status === 'failed' ? 'refused_dropped' : 'uncertain_dropped', cancelled_at: nowIso(now) });
  } else throw Error('不认识的操作');
  writeLines('state/send-requests.ndjson', requests);
  // 那条动作跟着落定（卡上不再写「失败」「等你」）：你自己发了 / 算发出去了 → 做完；不发了 → 取消。
  if (req.action_id) {
    const a = getAction(req.action_id);
    if (a && a.state !== 'done' && a.state !== 'cancelled') {
      if (action === 'sent') settleAction(a.id, 'done', { summary: req.unreachable ? '你自己在邮箱里发了' : '你看过了，这封发出去了', receipt: { request_id: req.id, evidence: req.unreachable ? 'user_sent_by_hand' : 'user' }, now });
      else settleAction(a.id, 'cancelled', { reason: '你说这封不发了', now });
    }
  }
  return action === 'sent' ? (req.unreachable || req.evidence === 'user_sent_by_hand' ? '记下了：这封你自己发了' : '记下了：这封算发出去了') : '好，这封不发了';
}

// 有没有要发、要对账的（只读一个小文件）。quiet：工作台每分钟问的那一次，上次因为网络、授权码没发成的，10 分钟内不再连。
export function sendDue({ now = Date.now(), requests = lines('state/send-requests.ndjson'), quiet = false } = {}) {
  return requests.some((r) => (r.channel || 'email') === 'email' && (
    (r.status === 'queued' && !(quiet && r.last_error && now - Date.parse(r.last_try_at || 0) < 600000))
    || r.status === SENDING || (r.status === UNCERTAIN && recheckDue(r, now))));
}
// 以前这里有 startMailSender（工作台每分钟把队列里所有排着的信发一遍，不经动作领走）：App 里早已不调，只走 worker
// （lib/workers.mjs 只发领走的那几封）。删掉，免得哪天又被接上、把旧版留下的排队信一起发出去。

// ── 升级：旧代码留下的失败发信（实测 10-04 #503）─────────────────────────────────────
// 旧版发信连不上时，请求留在队列里（queued，只记了 last_error），动作和那件活却落成了失败：列表写「失败」、详情写「稍后再发」，
// 可再也没人会发它；收件箱也没有信。启动时把这几封升级成现在的样子：
//   - 请求记成试满了的失败（unreachable），收件箱给「再试一次」「我自己发了」「这封不发了」（lib/mail/asks.mjs sendAsks）；
//   - 原因照旧记下的类别说（超时、代理……）；旧版没记下的，照实说没记下，不编；
//   - 停在「在发」（sending）的：发没发出去说不准，记成不确定，信上给「发出去了」「再发一次」「不发了」；
//   - 动作和那件活的原因换成同一句。只改还对不上的那几封，重复跑什么都不动。
export async function upgradeOldFailures({ now = Date.now() } = {}) {
  if (!dbExists()) return { upgraded: 0 };
  const failed = listActions({ kind: 'send_email', state: 'failed', limit: 5000 });
  if (!failed.length) return { upgraded: 0 };
  const requests = lines('state/send-requests.ndjson'), at = nowIso(now), fixed = [];
  for (const a of failed) {
    const r = requests.find((q) => q.action_id === a.id);
    // 上一版升级时拿动作被领走的次数当成「试了几次」写进了请求（没有 last_try_at：发信那一步从没记过）。去掉这个数，原因照实重说。
    if (r?.upgraded_at && r.status === 'failed' && r.unreachable && r.tries && !r.last_try_at) { delete r.tries; fixed.push({ a, line: gaveUpLine(r) }); continue; }
    if (!r || (r.channel || 'email') !== 'email' || ![SENDING, 'queued'].includes(r.status)) continue;
    r.via ||= 'builtin-mail';
    if (r.status === SENDING) {
      Object.assign(r, { status: UNCERTAIN, uncertain_at: r.sending_at || at, recheck_at: at, reason: 'interrupted', upgraded_at: at });
      delete r.sending_at;
      fixed.push({ a, line: '发出去了没有没核对上；去「已发送」里看一眼' });
      continue;
    }
    const known = KIND_WORDS[r.last_error] ? r.last_error : null;
    // 试了几次：只照发送请求上记下的（lib/mail/send.mjs 每连一次加一）。动作的 attempts 是被领走的次数（领走了不一定连过服务器），
    // 不拿它充数；没记下就不写数字（实测：只试了 2 次的那封写成了「试了 3 次」）。
    const tries = Number(r.tries) || null;
    Object.assign(r, { status: 'failed', unreachable: true, reason: known || 'unknown', last_reason: known ? KIND_WORDS[known] : (r.last_reason || UNKNOWN_WHY), failed_at: r.failed_at || a.updated_at || at, upgraded_at: at, ...(tries ? { tries } : {}) });
    if (!tries) delete r.tries;
    fixed.push({ a, line: gaveUpLine(r) });
  }
  if (!fixed.length) return { upgraded: 0 };
  writeLines('state/send-requests.ndjson', requests);
  for (const { a, line } of fixed) {
    db().prepare('UPDATE actions SET reason = ?, updated_at = ? WHERE id = ?').run(line, at, a.id);
    if (a.job_id) reword(a.job_id, line, { now });
  }
  event('quill', 'send-approved', 'ok', `旧版留下的 ${fixed.length} 封没发出去的邮件：收件箱里给了「再试一次」「我自己发了」「这封不发了」`);
  return { upgraded: fixed.length };
}
