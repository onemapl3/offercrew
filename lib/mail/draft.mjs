// 起草（内置邮箱第 3 批，方案 §四.4）：Writer 用引擎自己的模型写邮件（lib/resume-letters.mjs writeLetter，kind 'email'，逐句核对出处），
// 核对通过的变成 state/drafts.ndjson 里的一份待发草稿——收件箱里现成的那封「发送 / 我来改 / 不发了」，批准照旧是「发 N」，
// 绑在正文指纹上（lib/drafts.mjs bindSend），发信走 lib/mail/send.mjs。核对没过的不变成草稿，只记一笔运行日志。
//
//   首联     接了内置邮箱时 bin/reach.mjs 改走这里：和原来同一套挑法（你标了「联系」、有核实过的邮箱、这个渠道没联系过、
//            没有别的草稿）。附件按 pickResume 的顺序：你选定的版本 → 采用的定制版 → 默认语言版（没导出的现导一份，
//            lib/resume-versions.mjs preparePick）；还没有「材料」就用设置里的投递文件（resume_routing）。一份都没有不起草。
//   回复     读信时对上岗位、接在我们发过的信后面的「回复」（lib/mail/inbox.mjs 登记 reply_draft: 'pending'，留下对方新写的那段）。
//            草稿接在原线程里（In-Reply-To / References），标题是「Re: 对方的标题」，不带附件；对方的原信只进「说公司」那一池，
//            引用的原信等核对通过以后由这里接在正文后面（不交给模型写、不参与核对）。同一个岗位只留最新的一份回复草稿。
//            面试邀请不在这里起草：由「安排面试时间」那封信的一键确认来回（下一步）。
//   改       「改 N …」（bin/action.mjs）：内置邮箱起草的那份记成 editing、带上你的话，Writer 在上一版的基础上重写、照样逐句核对，
//            新的一份替掉旧的（旧的作废，要你重新看过才能发）。「N 备注 …」写在等你回复的那条线索上：按你的话起草回复（已有回复草稿就是改它）。
//   次数     每次最多写 3 封首联、2 封回复、2 封改稿；同一封来信、同一份改稿最多试 3 次。模型只经过 lib/model.mjs（纯文字、无工具；沙盒里拒绝）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lines, writeLines, read, file, hash } from '../store.mjs';
import { event } from '../events.mjs';
import { assertFirstContact, draftFingerprint, mutateAll } from '../drafts.mjs';
import { leadClosure } from '../runtime-recovery.mjs';
import { closedByUser, contactLead, archivedLead, endedLead } from '../lead-state.mjs';
import { currentFacts, resumeFiles } from '../facts.mjs';
import { writeLetter } from '../resume-letters.mjs';
import { assertFactsUsable } from '../facts-gate.mjs';
import { letterPath, letterMaterial, letterMaterialCurrent } from '../resume-choice.mjs';
import { crewName } from '../crew.mjs';
import { TZ } from '../tz.mjs';
import { messagePath } from './inbox.mjs';
import { noteSwallowed } from '../swallow.mjs';

const leadKey = (l) => l?.record_id || l?.id || null;
const iso = (t) => new Date(t).toISOString();
const draftId = (key, now) => `mail-${hash([key, now]).slice(0, 12)}`;
const cjk = (s) => (String(s).match(/[一-鿿]/g) || []).length;

// 引用的原信：中文「—— 原邮件 ——」，英文「On …, … wrote:」，每行前加「> 」，最多 40 行。
export function quoteOf(original, lang = cjk(original?.text) * 2 > String(original?.text || '').length * 0.3 ? 'zh' : 'en') {
  const at = Date.parse(original?.at || '');
  const when = Number.isFinite(at) ? new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(at) : '';
  const who = String(original?.from_name || '').trim() ? `${original.from_name} <${original.from_address}>` : String(original?.from_address || '');
  const body = String(original?.text || '').split('\n').slice(0, 40).map((l) => `> ${l}`.trimEnd()).join('\n');
  return lang === 'zh'
    ? `\n\n—— 原邮件 ——\n发件人：${who}\n${when ? `时间：${when}\n` : ''}主题：${original?.subject || ''}\n\n${body}`
    : `\n\nOn ${when || 'an earlier date'}, ${who} wrote:\n${body}`;
}

// 首联附的简历：{ name, size, path, label }、{ error }（挑中了某一版却导不出它）或 null（一份都没有）。
// 导不出挑中的那一版就停下，不拿设置里的投递文件顶上——那可能不是你要用的那一版（兜底清单，邮件 6）。
// 还没有「材料」（pickResume 一份都没挑出来）时，才用设置里的投递文件。
export async function resumeFor(lead, { prepare = null } = {}) {
  let r;
  try { r = await (prepare || (await import('../resume-versions.mjs')).preparePick)(lead); } catch (e) { return { error: `导出简历出错：${String(e.message || e).slice(0, 120)}` }; }
  const pick = r?.pick || null;
  if (pick && !pick.file) return { error: r?.reason || '这一版的 PDF 没导出来' };
  let rel = pick?.file || null;
  if (!rel) {
    const files = resumeFiles(currentFacts());
    const { jobLanguage } = await import('../resume-choice.mjs');
    rel = jobLanguage(lead) === 'zh' ? files.chinese : files.english;
  }
  if (!rel) return null;
  const abs = path.isAbsolute(rel) ? rel : file(rel);
  try {
    const size = fs.statSync(abs).size;
    return size ? { name: path.basename(abs), size, path: rel, label: pick?.label || null, material: letterMaterial(lead, { pick: pick || { file: rel } }), sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') } : null;
  } catch (e) { noteSwallowed('mail.draftAttachment', e, { member: 'quill', doing: `找草稿要带的简历文件 ${rel}`, then: '当一份简历都没有' }); return null; }
}

// 写一封、核对通过的拿回来：{ rec } / { status, reason }。
async function write1(record_id, mail, model, material = null) {
  let r;
  try { r = await writeLetter({ kind: 'email', record_id, mail, material, ...(model ? { model } : {}) }); }
  catch (e) { return { status: 'failed', reason: String(e.message || e).slice(0, 160), code: e.code }; }
  if (r.status !== 'proposed') return { status: r.status, reason: r.error || null, key: r.key || null, code: r.code };
  const rec = read(letterPath(r.key), null);
  return rec ? { rec } : { status: 'failed', reason: 'letter_missing' };
}
function sameAttachment(rid, resume) {
  if (!letterMaterialCurrent({ record_id: rid, material: resume.material })) return false;
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.isAbsolute(resume.path) ? resume.path : file(resume.path))).digest('hex') === resume.sha256; }
  catch (e) { noteSwallowed('mail.draftAttachmentChanged', e, { member: 'tailor', doing: '核对写信时选定的附件', then: '不起草，等你重新确认材料' }); return false; }
}
const MATERIAL_CHANGED = '写信期间简历或附件已变更，请按当前材料重新起草并审阅';

// 草稿落盘（持锁）：同一个岗位同一种用途、还没发的旧草稿作废（「发 N」只能对上一份）。
async function addDraft(d, { replaceWhere = () => false, guard = () => {} } = {}) {
  mutateAll(drafts => {
    guard(drafts);
    for (const x of drafts) if (x.status === 'ready' && replaceWhere(x)) Object.assign(x, { status: 'cancelled', reason: 'superseded', cancelled_at: d.created_at });
    drafts.push(d);
  });
}

// ── 首联 ───────────────────────────────────────────────────────────────────
// 和 bin/reach.mjs 同一套挑法。record：只起草这一条（编号或 record_id）；否则挑所有待联系的。
export function firstContactLeads({ record = null, leads = lines('state/leads.ndjson'), outbound = lines('state/outbound.ndjson'), drafts = lines('state/drafts.ndjson') } = {}) {
  const blocked = read('state/mail-reconciliation-pending.json', []) || [];
  const open = (l) => !outbound.some((o) => o.record_id === leadKey(l) && o.channel === 'email') && !drafts.some((d) => d.record_id === leadKey(l) && d.channel === 'email' && d.status !== 'cancelled');
  if (record) {
    const l = leads.find((x) => x.record_id === record || String(x.number) === String(record) || x.id === record);
    if (!l) return { error: 'record_missing' };
    if (blocked.includes(l.record_id)) return { error: 'prior_contact_reconciliation_required' };
    if (!contactLead(l)) return { error: 'user_contact_label_required' };
    if (archivedLead(l)) return { error: 'record_archived' };
    if (!l.email) return { error: 'verified_email_required' };
    return { leads: [l] };
  }
  return { leads: leads.filter((l) => contactLead(l) && l.email && !leadClosure(l, 'verify_contact_entry') && l.merged_into == null && !blocked.includes(l.record_id) && open(l)) };
}

export async function draftFirstContacts({ record = null, model = null, prepare = null, budget = 3, now = () => Date.now() } = {}) {
  assertFactsUsable(); // 资料挡住了：不起草，409 带横条那句话（lib/facts-gate.mjs）；不白用掉每封信 3 次的机会
  const pick = firstContactLeads({ record });
  if (pick.error) return { status: 'failed', error: pick.error };
  const results = [];
  for (const lead of pick.leads.slice(0, budget)) {
    const rid = leadKey(lead), who = `#${lead.number ?? '—'} ${lead.company || ''}`.trim();
    const resume = await resumeFor(lead, { prepare });
    if (!resume || resume.error) { results.push({ record_id: rid, status: resume?.error ? 'resume_export_failed' : 'no_resume' }); event('tailor', 'email', 'fail', `${crewName('tailor')}：${who} 的首联没起草（${resume?.error ? `选定的那一版简历导不出来：${resume.error}` : '没有能附上的简历'}）`, { lead_id: rid }); continue; }
    const w = await write1(rid, { purpose: 'first_contact' }, model, resume.material);
    if (!w.rec) { results.push({ record_id: rid, status: w.status, reason: w.reason }); continue; }
    if (!sameAttachment(rid, resume)) { results.push({ record_id: rid, status: 'failed', reason: MATERIAL_CHANGED }); event('tailor', 'email', 'fail', MATERIAL_CHANGED, { lead_id: rid }); continue; }
    const t = now();
    const d = {
      number: lead.number ?? null, record_id: rid, channel: 'email', draft_id: draftId(w.rec.key, t), to: String(lead.email).trim(), subject: w.rec.subject, body: w.rec.text,
      attachments: [{ name: resume.name, size: resume.size, path: resume.path }], ...(resume.label ? { resume: resume.label } : {}),
      status: 'ready', purpose: 'first_contact', by: 'writer', letter_key: w.rec.key, material: w.rec.material, via: 'builtin-mail', created_at: iso(t),
    };
    try {
      await addDraft(d, { guard: (drafts) => {
        assertFirstContact(rid, 'email', lines('state/outbound.ndjson'), drafts);
        if (!sameAttachment(rid, resume)) throw Object.assign(Error(MATERIAL_CHANGED), { code: 'letter_material_changed' });
      } });
    } catch (e) {
      const changed = e.code === 'letter_material_changed';
      results.push({ record_id: rid, status: changed ? 'failed' : 'skipped', reason: e.message });
      if (changed) event('tailor', 'email', 'fail', MATERIAL_CHANGED, { lead_id: rid });
      continue;
    }
    results.push({ record_id: rid, status: 'drafted', draft_id: d.draft_id });
    event('tailor', 'email', 'waiting_user', `${crewName('tailor')}：${who} 的首联邮件写好了，等你看`, { lead_id: rid });
  }
  const drafted = results.filter((x) => x.status === 'drafted').length;
  return { status: drafted ? 'changed' : results.some((x) => x.status !== 'skipped') ? 'degraded' : 'no_change', drafted, results };
}

// ── 回复 ───────────────────────────────────────────────────────────────────
export async function draftReplies({ model = null, budget = 2, now = () => Date.now() } = {}) {
  assertFactsUsable(); // 资料挡住了：不起草，409 带横条那句话（lib/facts-gate.mjs）；不白用掉每封信 3 次的机会
  const pending = lines('state/inbox-events.ndjson').filter((e) => e.source === 'builtin-mail' && e.reply_draft === 'pending' && e.record_id);
  if (!pending.length) return { status: 'no_change', drafted: 0 };
  const results = [], marks = new Map();
  for (const ev of pending.slice(-budget)) {
    const leads = lines('state/leads.ndjson'), lead = leads.find((l) => leadKey(l) === ev.record_id);
    const original = read(messagePath(ev.message_id), null);
    // 线索被你结束了、已经进了面试 / 拒绝，或者之后你已经回过了：不再起草。
    const sentAfter = lines('state/outbound.ndjson').some((o) => o.record_id === ev.record_id && Date.parse(o.at) > Date.parse(ev.at));
    if (!lead || !original || endedLead(lead) || sentAfter) { marks.set(ev.message_id, { reply_draft: 'skipped' }); results.push({ status: 'skipped' }); continue; }
    const w = await write1(ev.record_id, { purpose: 'reply', original, ...(ev.reply_instruction ? { instruction: ev.reply_instruction } : {}) }, model);
    if (!w.rec) {
      // 沙盒里不调模型：留着。模型没成功、核对没过：下次再写一封，试满 3 次不再试（收件箱「决定如何回复」照旧在，你可以自己回）。
      if (w.status !== 'unavailable') { const tries = (Number(ev.reply_tries) || 0) + 1; marks.set(ev.message_id, tries >= 3 ? { reply_draft: 'failed', reply_tries: tries } : { reply_tries: tries }); }
      results.push({ status: w.status, reason: w.reason });
      continue;
    }
    const t = now();
    const parent = lines('state/outbound.ndjson').find((o) => o.id === ev.parent_outbound_id) || null;
    const lang = w.rec.lang === 'zh' ? 'zh' : 'en', quote = quoteOf(original, lang);
    const d = {
      number: lead.number ?? null, record_id: ev.record_id, channel: 'email', draft_id: draftId(w.rec.key, t), to: original.from_address, subject: w.rec.subject,
      body: `${w.rec.text}${quote}`, quote_len: quote.length, attachments: [], status: 'ready', purpose: 'reply',
      parent_outbound_id: ev.parent_outbound_id || null, parent_thread_id: parent?.thread_id || parent?.message_id || null, reply_message_id: original.rfc_id,
      in_reply_to: original.rfc_id, references: [...(original.references || []), original.rfc_id].slice(-10),
      by: 'writer', letter_key: w.rec.key, via: 'builtin-mail', created_at: iso(t),
    };
    await addDraft(d, { replaceWhere: (x) => x.record_id === ev.record_id && x.purpose === 'reply' && x.via === 'builtin-mail' });
    marks.set(ev.message_id, { reply_draft: d.draft_id });
    results.push({ status: 'drafted', draft_id: d.draft_id });
    event('tailor', 'email', 'waiting_user', `${crewName('tailor')}：#${lead.number ?? '—'} ${lead.company || ''} 的回复写好了，等你看`, { lead_id: ev.record_id });
  }
  if (marks.size) {
    const events = lines('state/inbox-events.ndjson');
    for (const e of events) if (e.source === 'builtin-mail' && marks.has(e.message_id)) Object.assign(e, marks.get(e.message_id));
    writeLines('state/inbox-events.ndjson', events);
  }
  const drafted = results.filter((x) => x.status === 'drafted').length;
  return { status: drafted ? 'changed' : 'no_change', drafted, results: results.map(({ status }) => ({ status })) };
}

// ── 改 ─────────────────────────────────────────────────────────────────────
const MAIL_DRAFT = (d) => d?.via === 'builtin-mail' && (d.channel || 'email') === 'email';
// 这封来信的原文（private/mail/messages/）：按 Message-ID 找到登记的那一行。
function originalFor(record_id, rfc, events = lines('state/inbox-events.ndjson')) {
  const ev = events.filter((e) => e.source === 'builtin-mail' && e.record_id === record_id && e.rfc_id === rfc).at(-1);
  return ev ? read(messagePath(ev.message_id), null) : null;
}

// 「改 N …」：把内置邮箱起草的那份记成 editing（调用方持锁、负责落盘）。回 true 表示接手了，否则照旧交给执行器。
export function markRevise(d, text, { now = Date.now() } = {}) {
  if (!MAIL_DRAFT(d) || !['ready', 'editing'].includes(d.status)) return false;
  Object.assign(d, { status: 'editing', revise_request: { text: String(text).slice(0, 600), at: iso(now) } });
  delete d.displayed_hash; delete d.notified_at; delete d.revise_tries;
  return true;
}

// 「N 备注 …」写在等你回复的那条线索上（调用方持锁）：有内置邮箱起草的回复草稿就改它，没有就按你的话起草一份。
// 回一句回执；这条线索没有能回的来信就回 null（照旧只记备注）。
export function requestReply(lead, text, { drafts, events, now = Date.now() }) {
  const rid = leadKey(lead);
  const ev = events.filter((e) => e.source === 'builtin-mail' && e.record_id === rid && e.category === '回复' && e.rfc_id).at(-1);
  if (!ev) return null;
  const d = drafts.filter((x) => x.record_id === rid && x.purpose === 'reply' && MAIL_DRAFT(x) && ['ready', 'editing'].includes(x.status)).at(-1);
  if (d) { markRevise(d, text, { now }); return `${crewName('tailor')} 按你的话改这封回复，改好再给你看`; }
  Object.assign(ev, { reply_draft: 'pending', reply_instruction: String(text).slice(0, 600), reply_tries: 0 });
  return `${crewName('tailor')} 按你的话起草回复，写好给你看`;
}

export async function reviseDrafts({ model = null, prepare = null, budget = 2, now = () => Date.now() } = {}) {
  assertFactsUsable(); // 资料挡住了：不起草，409 带横条那句话（lib/facts-gate.mjs）；不白用掉每封信 3 次的机会
  // 内置邮箱起草的那份，和以前留下的、对着某个岗位的邮件草稿（「改 N」由引擎改，lib/draft-revise.mjs）。
  const todo = lines('state/drafts.ndjson').filter((d) => (MAIL_DRAFT(d) || ((d.channel || 'email') === 'email' && d.record_id)) && d.status === 'editing' && d.revise_request);
  if (!todo.length) return { status: 'no_change', revised: 0 };
  const results = [], marks = new Map();
  const mark = (d, patch, result, notice = null, extra = {}) => {
    results.push(result);
    marks.set(d.draft_id, { original: d, patch, result, notice, ...extra });
  };
  for (const d of todo.slice(0, budget)) {
    const reply = d.purpose === 'reply';
    const original = reply ? originalFor(d.record_id, d.reply_message_id) : null;
    const lead = !reply && lines('state/leads.ndjson').find(l => leadKey(l) === d.record_id);
    const resume = lead && await resumeFor(lead, { prepare });
    const changed = !reply && (!resume || resume.error || !d.attachments?.some(a => a.path === resume.path));
    const previous = String(d.body || '').slice(0, Math.max(0, String(d.body || '').length - (Number(d.quote_len) || 0)));
    let w = changed ? { status: 'failed', reason: '草稿附件与当前所选简历不一致，请重新准备草稿', code: 'letter_material_changed' } : reply && !original ? { status: 'failed', reason: 'original_missing' }
      : await write1(d.record_id, { purpose: reply ? 'reply' : 'first_contact', ...(original ? { original } : {}), instruction: d.revise_request.text, previous }, model, resume?.material || null);
    if (w.rec && !reply && !sameAttachment(d.record_id, resume)) w = { status: 'failed', reason: MATERIAL_CHANGED, code: 'letter_material_changed' };
    if (!w.rec) {
      if (w.status === 'unavailable') { results.push({ status: 'unavailable' }); continue; }
      if (w.code === 'letter_material_changed') {
        // 材料错位不靠重试恢复旧稿的可发状态：保留旧文与附件，在现有暂停入口等本人重新准备。
        mark(d, { status: 'paused', paused_reason: w.reason, paused_at: iso(now()), revise_request: undefined },
          { status: 'failed', reason: w.reason }, ['fail', `${crewName('tailor')}：#${d.number ?? '—'} 的邮件已暂停（${w.reason}）`]);
        continue;
      }
      const tries = (Number(d.revise_tries) || 0) + 1;
      // 试满 3 次还没改成：原来那一版回到「等你看」（要重新看过才能发）。
      mark(d, tries >= 3 ? { status: 'ready', revise_failed_at: iso(now()), revise_request: undefined, revise_tries: tries } : { revise_tries: tries },
        { status: w.status, reason: w.reason }, tries >= 3 ? ['fail', `${crewName('tailor')}：#${d.number ?? '—'} 的邮件没按你的话改成，原来那一版还在`] : null, { resume });
      continue;
    }
    const t = now();
    const quote = reply ? quoteOf(original, w.rec.lang === 'zh' ? 'zh' : 'en') : '';
    const next = { ...d, draft_id: draftId(`${w.rec.key}:rev`, t), subject: reply ? d.subject : w.rec.subject, body: `${w.rec.text}${quote}`, ...(reply ? { quote_len: quote.length } : {}), status: 'ready', letter_key: w.rec.key, material: w.rec.material, created_at: iso(t), revised_from: d.draft_id };
    for (const k of ['revise_request', 'revise_tries', 'displayed_hash', 'notified_at', 'displayed_on', 'edited_at']) delete next[k];
    mark(d, { status: 'cancelled', reason: 'revised', cancelled_at: iso(t) }, { status: 'skipped', reason: '草稿尚未保存' },
      ['waiting_user', `${crewName('tailor')}：#${d.number ?? '—'} 的邮件按你的话改好了，等你看`], { next, resume });
  }
  if (marks.size) {
    const notices = mutateAll(drafts => {
      const notices = [];
      for (const [id, m] of marks) {
        const x = drafts.find(d => d.draft_id === id);
        // 模型等待及 SQLite 等锁期间，本人可能已取消、编辑或提出另一条改稿要求。
        if (!x || x.status !== 'editing' || draftFingerprint(x) !== draftFingerprint(m.original) || hash(x.revise_request ?? null) !== hash(m.original.revise_request ?? null)) {
          Object.assign(m.result, { status: 'skipped', reason: '草稿或改稿要求已变化，未覆盖当前版本' });
          continue;
        }
        if (m.resume && (m.next || m.patch.status === 'ready') && !sameAttachment(x.record_id, m.resume)) {
          m.patch = { status: 'paused', paused_reason: MATERIAL_CHANGED, paused_at: iso(now()), revise_request: undefined };
          m.next = null;
          Object.assign(m.result, { status: 'failed', reason: MATERIAL_CHANGED });
          m.notice = ['fail', `${crewName('tailor')}：#${x.number ?? '—'} 的邮件已暂停（${MATERIAL_CHANGED}）`];
        }
        for (const [k, v] of Object.entries(m.patch)) { if (v === undefined) delete x[k]; else x[k] = v; }
        if (m.next) {
          drafts.push(m.next);
          Object.assign(m.result, { status: 'revised', draft_id: m.next.draft_id }); delete m.result.reason;
        }
        if (m.notice) notices.push([...m.notice, x.record_id]);
      }
      return notices;
    });
    // 只有事务成功保存了相应状态，才记录完成或暂停；被取消的旧稿不会报「改好了」。
    for (const [status, text, rid] of notices) event('tailor', 'email', status, text, { lead_id: rid });
  }
  const revised = results.filter((x) => x.status === 'revised').length;
  return { status: revised ? 'changed' : 'no_change', revised, results };
}
