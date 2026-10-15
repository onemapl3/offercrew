// 引擎自己读信（第 2 批，方案-内置邮箱 §四.3）：连上的邮箱里新到的信 → 配线索 → 文字模型判断是哪一类 → 更新线索、登记来信。
// 替代 Codex 的收件箱巡检（bin/host/mail-poll.sh 接了内置邮箱就改跑 bin/mail-read.mjs）；Codex 的 Gmail 连接器照样可选。
//
//   哪些信    只看求职相关的：配上了线索的（线程、发件人、公司），或者看着像招聘来信的（发件人、标题里有投递 / 面试这类词，
//            或者从招聘系统发来）。别的信（银行、购物、私人、群发的职位推荐）不登记、不交给模型，只记个数。
//            对不上线索的，模型判成「其他」也不登记。
//   配线索    先看 In-Reply-To / References 是不是我们发过的信（outbound.message_id），Gmail 再看会话编号（outbound.thread_id），
//            再看发件人是不是线索上的联系人（lead.email，只对上一条才算），最后按公司（lib/inbox.mjs associate）。
//   判断      LinkedIn 私信通知交给 lib/linkedin-mail.mjs（不用模型）；招聘系统发来的验证码按规则认（不用模型）；
//            其余交给文字模型四选一（lib/mail/classify.mjs）。一次最多 MODEL_BUDGET 次，剩下的下一次接着读。
//   写回      配上线索的：lib/inbox.mjs recordReply（面试邀请 → 面试中，拒信 → 拒绝，回复 → 已回复，其他不动线索）；
//            journey 再按阶段出「安排面试时间」「决定如何回复」。日历邀请里的时间记在 interview_proposed，等你确认，不直接当面试时间。
//            每封都登记一行 state/inbox-events.ndjson（source builtin-mail），Watch 按它发卡片；飞书表格的更新交给
//            state/inbox-base-pending.json（bin/project-journey.mjs 补同步），这里不直接连飞书。
//   锁       连邮箱、调模型的时候不占数据锁；最后拿一下锁，重新读线索再写回。同一时间只跑一次（private/mailread.lock）。
//   游标     每封信登记完才往前挪（lib/mail/read.mjs）；中途出错，没登记的下次还会读到。
//   不跑     没连邮箱；上次是授权码不对或者解不开（等你重新填，别拿一个坏的码反复登录，QQ、163 会限制登录）。
import fs from 'node:fs';
import { lines, read, write, writeLines, file, today, hash } from '../store.mjs';
import { lock, waitForLock } from '../lock.mjs';
import { event } from '../events.mjs';
import { noteSwallowed } from '../swallow.mjs';
import { noteFallback } from '../fallback.mjs';
import { TZ } from '../tz.mjs';
import { associate, recordReply, reminders, RECRUITING, ATS_SENDER } from '../inbox.mjs';
import { linkedinKind, recordLinkedInMail, STATE_PATH as LINKEDIN_STATE } from '../linkedin-mail.mjs';
import { PROVIDERS, providerFor } from './providers.mjs';
import { loadAccount, loadSecret, markChecked } from './vault.mjs';
import { explainAttempts, localOnly } from './connect.mjs';
import { fetchNew, loadCursor, saveCursor, PER_RUN } from './read.mjs';
import { classifyMail, KIND_CATEGORY, isReceipt } from './classify.mjs';
import { excerpt, newestPart } from './parse.mjs';
import { addUnlinked } from './asks.mjs';
import { stageText } from '../lead-state.mjs';

export const SOURCE = 'builtin-mail';
export const STATUS_FILE = 'state/mail-builtin.json';
export const MODEL_BUDGET = 10;
// 招聘系统、网站发来的验证码：按规则认，不交给模型；摘要里留着码（和以前 Codex 巡检一样），Watch 只私发给你。
const CODE = /验证码|校验码|动态码|verification code|security code|one[- ]time (?:pass(?:word|code)|code)|\bOTP\b|login code|sign[- ]in code/i;
const codeIn = (m) => (`${m.subject}\n${String(m.body || '').slice(0, 600)}`.match(/(?<![\d-])(\d{4,8})(?![\d-])/) || [])[1] || null;

function saveMessages(list) {
  if (!list.length) return;
  for (const m of list) write(messagePath(m.id), m);
  const dir = file(MESSAGES_DIR);
  const all = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(`${dir}/${n}`).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of all.slice(60)) fs.rmSync(`${dir}/${x.n}`, { force: true });
}
const norm = (v) => String(v || '').trim().replace(/^<|>$/g, '').toLowerCase();
const leadKey = (l) => l?.record_id || l?.id || null;
function uniqueLead(ids, leads) {
  const u = [...new Set(ids.filter(Boolean))];
  return u.length === 1 ? leads.find((l) => leadKey(l) === u[0]) || null : null;
}

// 这封信是哪条线索的：{ lead, via } 或 { lead: null, ambiguous }。
export function matchLead(m, { leads = [], outbound = [] } = {}) {
  const refs = new Set([m.in_reply_to, ...(m.references || [])].filter(Boolean).map(norm));
  const thread = outbound.filter((o) => (o.message_id && refs.has(norm(o.message_id))) || (m.thread_id && (o.thread_id === m.thread_id || o.external_id === m.thread_id)));
  const threadIds = [...new Set(thread.map((o) => o.record_id).filter(Boolean))];
  if (threadIds.length === 1) { const lead = uniqueLead(threadIds, leads); if (lead) return { lead, via: 'thread' }; }
  if (threadIds.length > 1) return { lead: null, ambiguous: true };
  const from = String(m.from_address || '').toLowerCase();
  const senders = from ? leads.filter((l) => String(l.email || '').trim().toLowerCase() === from) : [];
  if (senders.length === 1) return { lead: senders[0], via: 'sender' };
  if (senders.length > 1) return { lead: null, ambiguous: true };
  const lead = associate({ ...m, body: '' }, outbound, leads);
  return lead ? { lead, via: 'company' } : { lead: null };
}

// 求职相关吗：配上了线索、像招聘来信、或者从招聘系统发来。群发的信（List-Id 之类）没配上线索就不算，除非是招聘系统发的。
export function jobRelated(m, matched) {
  if (matched?.lead) return true;
  const ats = ATS_SENDER.test(m.from_address || '');
  if (m.auto && !ats) return false;
  return ats || RECRUITING.test(`${m.from} ${m.subject}`);
}

// 先决定每封怎么登记（连邮箱、调模型都在这里，不占数据锁）。回 plans：{ m, kind: 'skip' | 'linkedin' | 'mail', … }。
// 调模型的次数用完就停（stopAt：从这一封起留给下一次）。
export async function decide(messages, { leads, outbound, self = [], infer, modelBudget = MODEL_BUDGET } = {}) {
  const plans = [];
  let calls = 0;
  for (const m of messages) {
    if (self.includes(m.from_address)) { plans.push({ m, kind: 'skip', why: 'own' }); continue; }
    if (linkedinKind(m)) { plans.push({ m, kind: 'linkedin' }); continue; }
    const matched = matchLead(m, { leads, outbound });
    if (!jobRelated(m, matched)) { plans.push({ m, kind: 'skip', why: 'not_job' }); continue; }
    if (CODE.test(m.subject || '') || (CODE.test(String(m.body || '').slice(0, 600)) && !matched.lead)) {
      const code = codeIn(m);
      plans.push({ m, kind: 'mail', category: '验证码', by: 'rules', summary: code ? `验证码 ${code}，来自 ${m.from_name || m.from_address}` : (m.subject || '验证码') });
      continue;
    }
    if (calls >= modelBudget) return { plans, stopAt: m, calls };
    calls++;
    const c = await classifyMail(m, { infer, linked: !!matched.lead });
    // 对不上线索、又只是「其他」的（别家的自动回执、招聘系统的推广）：不登记，免得收件箱里堆杂信。
    if (!matched.lead && c.kind === 'other') { plans.push({ m, kind: 'skip', why: 'other_unlinked' }); continue; }
    const category = c.kind === 'other' && isReceipt(m) ? '申请确认' : KIND_CATEGORY[c.kind];
    plans.push({ m, kind: 'mail', category, mail_kind: c.kind, by: c.by, ...(c.error ? { error: c.error } : {}) });
  }
  return { plans, stopAt: null, calls };
}

// 日历邀请里还没过去、没取消的时间。
const proposals = (m, now) => (m.calendar || []).filter((e) => e.method !== 'CANCEL' && Date.parse(e.start) > now - 3600000)
  .map((e) => ({ at: e.start, ...(e.end ? { end: e.end } : {}), ...(e.summary ? { title: e.summary.slice(0, 120) } : {}), ...(e.location ? { location: e.location.slice(0, 160) } : {}), source: 'calendar', message_id: m.id }));

// 回复招聘方（第 3 批）：对上岗位的「回复」（接在我们发过的信后面的，或者招聘方直接来信、对得上某条线索的），留下对方新写的那段（private/mail/messages/，最多 60 封，
// 不进仓库、不上传），登记 reply_draft: 'pending'，由 lib/mail/draft.mjs 让 Writer 起草回复。不收信的地址（no-reply）不起草。
export const MESSAGES_DIR = 'private/mail/messages';
const NO_REPLY = /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?)(?:[._+-]|@)/i;
export const messagePath = (id) => `${MESSAGES_DIR}/${hash([id]).slice(0, 16)}.json`;
function replyParent(m, lead, outbound) {
  const refs = new Set([m.in_reply_to, ...(m.references || [])].filter(Boolean).map(norm));
  return outbound.filter((o) => o.record_id === leadKey(lead) && (o.channel || 'email') === 'email' && ((o.message_id && refs.has(norm(o.message_id))) || (m.thread_id && (o.thread_id === m.thread_id || o.external_id === m.thread_id)))).at(-1) || null;
}
// 没有模型时的关键词粗分（兜底清单 D01）：只当一个猜测，不改线索阶段、不起草、不来「对不上岗位」的信。
// 这封记成「待确认」（category '待确认'，guess 是猜的那一类），留下原文（private/mail/messages/），下次读信时有模型就重新分类；
// 一直没模型的，收件箱里一天最多一封「没判断的信」（lib/mail/asks.mjs guessAsks）。
export const UNSURE = '待确认';
const stash = (m) => ({ id: m.id, rfc_id: m.message_id || null, in_reply_to: m.in_reply_to || null, references: (m.references || []).slice(-10), thread_id: m.thread_id || null, from: m.from || '', from_address: m.from_address || '', from_name: m.from_name || '', subject: m.subject || '', at: m.at, text: newestPart(m.body || '').slice(0, 4000) });
// 对不上岗位、要你看一眼的：招聘方回复、面试邀请（合成一封信，lib/mail/asks.mjs）。拒信不算（只记运行日志）。
const NEEDS_YOU = new Set(['回复', '面试邀约']);
// 把决定写进线索和来信（纯函数，调用方持锁、负责落盘）。
// 回 { recorded, raised, skipped, linkedin, base, last_uid, kinds, unlinked, rejections }。
export function applyPlans(plans, { leads, outbound, events, linkedinState = {}, now = Date.now() } = {}) {
  const out = { recorded: 0, raised: 0, skipped: 0, linkedin: null, base: {}, last_uid: null, kinds: {}, unlinked: [], rejections: [], messages: [], guessed: [] };
  const seen = new Set(events.map((e) => e.message_id));
  const li = [];
  for (const p of plans) {
    const m = p.m;
    out.last_uid = Math.max(out.last_uid || 0, Number(m.uid) || 0);
    if (p.kind === 'skip' || seen.has(m.id)) { out.skipped++; continue; }
    if (p.kind === 'linkedin') { li.push({ id: m.id, thread_id: m.thread_id, from: m.from, subject: m.subject, body: m.body, at: m.at }); continue; }
    const { lead } = matchLead(m, { leads, outbound });
    const summary = p.summary || excerpt(m.body) || m.subject || '';
    if (p.by === 'rules' && p.category !== '验证码') {
      events.push({ message_id: m.id, category: UNSURE, guess: p.category, from: m.from, subject: m.subject, summary, at: m.at, record_id: leadKey(lead), number: lead?.number ?? null, source: SOURCE, by: 'rules', ...(p.error ? { error: p.error } : {}), ...(m.thread_id ? { thread_id: m.thread_id } : {}) });
      seen.add(m.id);
      out.recorded++;
      out.kinds[UNSURE] = (out.kinds[UNSURE] || 0) + 1;
      out.guessed.push({ number: lead?.number ?? null, guess: p.category, error: p.error || '' });
      out.messages.push(stash(m));
      continue;
    }
    const proposed = p.category === '面试邀约' ? proposals(m, now) : [];
    const ev = {
      message_id: m.id, category: p.category, from: m.from, subject: m.subject, summary, at: m.at,
      record_id: leadKey(lead), number: lead?.number ?? null, source: SOURCE, by: p.by,
      ...(m.thread_id ? { thread_id: m.thread_id } : {}),
      ...(proposed.length ? { proposed_times: proposed.map((x) => x.at) } : {}),
    };
    // 回复接在对方这封信的线程里；我们发过的那封（有的话）记作 parent_outbound_id。招聘方直接来信的，锚点就是这封信（lib/drafts.mjs bindSend 认）。
    // 面试邀请也留下原文和锚点，但不让 Writer 起草：由「安排面试时间」那封信一键「确认并回复」（lib/mail/interview.mjs）。
    if (lead && ['回复', '面试邀约'].includes(p.category) && m.message_id && m.from_address && !NO_REPLY.test(m.from_address)) {
      const parent = replyParent(m, lead, outbound);
      Object.assign(ev, { rfc_id: m.message_id, from_address: m.from_address, parent_outbound_id: parent?.id || null, ...(p.category === '回复' ? { reply_draft: 'pending' } : {}) });
      out.messages.push(stash(m));
    }
    events.push(ev);
    seen.add(m.id);
    out.recorded++;
    out.kinds[p.category] = (out.kinds[p.category] || 0) + 1;
    if (p.category === '拒绝') out.rejections.push({ number: lead?.number ?? null, company: lead?.company || m.from_name || m.from_address, role: lead?.role || null });
    if (!lead && NEEDS_YOU.has(p.category)) out.unlinked.push({ key: m.id, shown: m.from_name || m.from_address || '招聘方', subject: m.subject, preview: summary.slice(0, 120), category: p.category, at: m.at });
    if (lead && recordReply(lead, { category: p.category, summary, at: m.at, source: SOURCE })) {
      out.raised++;
      if (proposed.length) lead.interview_proposed = proposed;
      if (p.category === '面试邀约' && m.scheduling_url && !lead.interview_scheduling_url) lead.interview_scheduling_url = m.scheduling_url;
      if (lead.record_id) out.base[lead.record_id] = { 阶段: [stageText(lead)], 回复摘要: summary };
    }
  }
  if (li.length) {
    const r = recordLinkedInMail(li, { leads, outbound, events, state: linkedinState, now });
    out.linkedin = r;
    out.raised += r.raised;
    Object.assign(out.base, r.base);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
function localStamp(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
// 和 bin/host/mail-poll.sh 同一个日志（lib/command-center.mjs 从这里读收件箱巡检上次跑的时间和结果）。
export function pollLine(rc, note = '') {
  const dir = file(`runs/${today()}/mail-poll`);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(`${dir}/poll.log`, `[${localStamp()}] mail-poll exit=${rc}${note ? ` ${note}` : ''}\n`);
}

// 授权码不对、解不开、被拒（Unsafe Login）：等你重新填，不再拿它登录。
export const SKIP_STATUS = new Set(['auth', 'secret', 'unsafe']);
// 保存的账号连哪里：沙盒里存的本机服务器，否则按邮箱类型现取预设。回 { target, provider } 或 { skip }。
export function mailTarget(account) {
  if (account.servers && !localOnly()) return { skip: 'test_servers_outside_sandbox' };
  const preset = account.servers ? null : providerFor(account.address);
  const provider = preset?.supported ? preset : PROVIDERS[account.provider] ? { provider: account.provider, ...PROVIDERS[account.provider] } : null;
  const target = account.servers ? { ...account, imap: account.servers.imap, smtp: account.servers.smtp } : { ...account, imap: provider?.imap, smtp: provider?.smtp };
  return target.imap ? { target, provider } : { skip: 'provider_unknown' };
}
// 一次读信。回一行给日志和调用方看的结果（不含信的内容）。
export async function runMailRead({ now = () => new Date(), infer, env = process.env, limits = {}, perRun = PER_RUN, modelBudget = MODEL_BUDGET, expectedAddress = null } = {}) {
  const account = loadAccount();
  if (expectedAddress && account?.address?.toLowerCase() !== String(expectedAddress).toLowerCase()) return { status: 'skipped', reason: 'mailbox_changed' };
  if (!account) return { status: 'no_change', reason: 'not_connected' };
  // 跳过的也写进 poll.log（兜底清单 I07）：团队页「收件箱巡检」上次的结果能看到为什么没读。
  const skip = (reason) => { try { pollLine(0, `skipped:${reason}`); } catch (e) { noteSwallowed('mail-inbox.poll-log', e, { member: 'owl', doing: '把「这次没读」记进巡检日志', then: '团队页上看不到这一次为什么没读' }); } return { status: 'skipped', reason }; };
  if (SKIP_STATUS.has(account.status)) return skip(`waiting_for_new_code:${account.status}`);
  let release;
  try { release = lock('mailread'); } catch { return skip('another_mail_read_running'); }
  try {
    const t = mailTarget(account);
    if (t.skip) return skip(t.skip);
    const { target, provider } = t;
    let pass;
    try { pass = await loadSecret(account); } catch (e) {
      markChecked({ ok: false, kind: 'secret', reason: e.message });
      event('owl', 'mail-read', 'fail', `读邮件没成：${e.message}`);
      pollLine(1, 'secret');
      return { status: 'failed', kind: 'secret' };
    }
    let got;
    try { got = await fetchNew(target, pass, loadCursor(), { provider, env, limits, perRun, now: now() }); } catch (e) {
      const r = await explainAttempts(e, { step: 'imap', provider, host: target.imap.host, port: target.imap.port, secrets: [pass] });
      markChecked({ ok: false, ...r });
      event('owl', 'mail-read', 'fail', `读邮件没成：${r.reason}`);
      pollLine(1, r.kind);
      return { status: 'failed', kind: r.kind };
    }
    if (account.status !== 'ok') markChecked({ ok: true });
    if (got.recovery?.from === 'proxy' && got.recovery?.to === 'direct') event('owl', 'mail-read', 'ok', `代理连接没成功，已改用直连完成收信检查；${got.baseline ? '从当前最新一封往后读，历史邮件未读取' : got.messages.length ? `读到 ${got.messages.length} 封新信` : '这次没有新信'}`, { mail_recovery: got.recovery });
    if (got.baseline) {
      saveCursor(got.cursor);
      write(STATUS_FILE, { checked_at: got.cursor.checked_at, address: account.address, baseline: true, ...(got.reset ? { reset: true } : {}) });
      event('owl', 'mail-read', 'ok', got.reset ? '邮箱换了编号（UIDVALIDITY），从现在的最新一封往后读' : '邮箱接上了，从现在的最新一封往后读，以前的信不读');
      pollLine(0, 'baseline');
      return { status: 'baseline', reset: !!got.reset };
    }
    const self = [account.address, account.login].filter(Boolean).map((x) => String(x).toLowerCase());
    const { plans, stopAt, calls = 0 } = await decide(got.messages, { leads: lines('state/leads.ndjson'), outbound: lines('state/outbound.ndjson'), self, infer, modelBudget });
    // 以前按关键词猜的「待确认」：这次有模型就重新分类（用剩下的模型次数）。
    const again = await reclassify({ infer, budget: Math.max(0, modelBudget - calls) });
    let r;
    const releaseLinkedIn=await waitForLock('linkediningest',{timeout:10000,interval:25});
    try {
      const leads = lines('state/leads.ndjson'), outbound = lines('state/outbound.ndjson'), events0 = lines('state/inbox-events.ndjson');
      // 重新分类成功的：去掉原来那行「待确认」，按新的类别和新信一起走一遍。
      const redo = new Set(again.map((x) => x.m.id)), events = events0.filter((e) => !(redo.has(e.message_id) && e.category === UNSURE));
      r = applyPlans([...again, ...plans], { leads, outbound, events, linkedinState: read(LINKEDIN_STATE, {}) || {}, now: now().getTime() });
      if (r.recorded || (r.linkedin && r.linkedin.events)) writeLines('state/inbox-events.ndjson', events);
      if (r.raised) writeLines('state/leads.ndjson', leads);
      if (r.linkedin) write(LINKEDIN_STATE, r.linkedin.state);
      if (Object.keys(r.base).length) write('state/inbox-base-pending.json', { ...(read('state/inbox-base-pending.json', {}) || {}), ...r.base });
      write('state/followups.json', reminders(leads, outbound, now()));
      addUnlinked(r.unlinked, { now: now().getTime() });
      saveMessages(r.messages);
      // 登记完的才算读过：模型额度用完停下的那一封和它后面的，下次接着读。
      const last = r.last_uid ?? got.cursor.last_uid;
      saveCursor({ ...got.cursor, last_uid: Math.max(Number(got.cursor.last_uid) || 0, Number(last) || 0) });
    } finally {releaseLinkedIn();}
    const more = got.more || !!stopAt;
    const status = { checked_at: got.cursor.checked_at, address: account.address, read: got.messages.length, recorded: r.recorded, raised: r.raised, skipped: r.skipped, linkedin: r.linkedin?.seen || 0, kinds: r.kinds, more };
    write(STATUS_FILE, status);
    // 每次走关键词这条路都记一笔（D01，lib/fallback.mjs：按天计数，同一个原因一天只出一行运行日志）。
    // 状态已经写完，记账出错不能把后面的事件带走。
    for (const x of r.guessed) try { noteFallback({ kind: 'mail-classify', from: 'model', to: 'keywords', why: x.error, member: 'owl', from_label: '模型判断邮件', to_label: '按关键词猜（记成待确认，不改阶段）' }); } catch (e) { noteSwallowed('mail-inbox.fallback-note', e, { member: 'owl', doing: '记下这封信是按关键词猜的', then: '信照样记成待确认' }); }
    if (again.length) event('owl', 'mail-read', 'ok', `${again.length} 封待确认的邮件重新判断过了`);
    if (r.recorded || r.raised || r.linkedin?.seen) event('owl', 'mail-read', 'ok', `读了 ${got.messages.length} 封新信：${r.recorded} 封求职相关${r.raised ? `，${r.raised} 封对上岗位` : ''}${more ? '，还有没读完的，下次接着读' : ''}`);
    // 拒信不来信（注意力规矩）：阶段已经改了，这里记一笔运行日志。
    for (const x of r.rejections) event('owl', 'mail-read', 'ok', `${x.number != null ? `#${x.number} ` : ''}${x.company}${x.role ? ` · ${x.role}` : ''}：来了拒信${x.number != null ? '，阶段改成「拒绝」' : ''}`);
    pollLine(0);
    return { status: r.recorded || r.raised ? 'changed' : 'no_change', ...status };
  } finally { release(); }
}

// 「待确认」的信重新分类：留着原文的、对得上的才试；模型照样用不了就不动。回要重新走一遍的 plans。
export async function reclassify({ infer, budget = MODEL_BUDGET, events = lines('state/inbox-events.ndjson') } = {}) {
  const out = [];
  for (const e of events.filter((x) => x.source === SOURCE && x.category === UNSURE)) {
    if (out.length >= budget) break;
    const saved = read(messagePath(e.message_id), null);
    if (!saved) continue;
    const m = { ...saved, message_id: saved.rfc_id, body: saved.text };
    const c = await classifyMail(m, { infer, linked: !!e.record_id });
    if (c.by !== 'model') break; // 模型还是用不了：这次都不试了
    // 对不上线索、其实是「其他」的：这行待确认直接去掉（和新信一样不登记）。
    if (!e.record_id && c.kind === 'other') { out.push({ m, kind: 'skip' }); continue; }
    const category = c.kind === 'other' && isReceipt(m) ? '申请确认' : KIND_CATEGORY[c.kind];
    out.push({ m, kind: 'mail', category, mail_kind: c.kind, by: 'model', summary: e.summary });
  }
  return out;
}
