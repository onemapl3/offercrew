import { CHANNEL_LIMITS } from './message-limits.mjs';
// 草稿的直接编辑、AI 重写与回退。
//
// 两类草稿，两种边界：
// - 本地草稿（平台私信 dm-*、内推请求 ref-*、脉脉附言）：正文只在 state/drafts.ndjson，
//   改完立即生效。改后换一个 draft_id（edt-*），旧的发送授权自然失效；用户刚看过
//   并写下的这段文字就是"已展示"的版本，所以直接记 displayed_hash，可以马上「发 N」。
// - Gmail 草稿（draft_id 形如 r4381…）：正文在 Gmail 里，发送前宿主会逐字核对。本地
//   改动先记为 pending_edit、状态 editing，交给即时执行器把 Gmail 草稿更新并独立回读，
//   回读通过后才回到 ready；在此之前不能发。
import crypto from 'node:crypto';
import { lines, writeLines, hash, read } from './store.mjs';
import { draftFingerprint, cancelPaused } from './drafts.mjs';
import { infer, plainModelError } from './model.mjs';
import { jobBrief } from './job-brief.mjs';
import { loadFacts, jdLanguage } from './application-form.mjs';
import { candidateEvidence } from './judgements.mjs';
import { requestRunNow } from './run-now.mjs';
import { whoDoes } from './capabilities.mjs';
import { event } from './events.mjs';
import { recall, renderNotes } from './memory.mjs';
import { platformMessageBlock } from './platform-actions.mjs';

export const GMAIL_ID = /^r-?\d{8,}$/;
export const isGmailDraft = d => (d?.channel || 'email') === 'email' && GMAIL_ID.test(String(d?.draft_id || ''));
export const LIMITS = CHANNEL_LIMITS;
export const CHANNEL_LABEL = { email: '邮件', platform_dm: '平台私信', maimai_friend_request: '脉脉加好友附言', platform_application: '平台申请' };
export const EDITABLE = new Set(['ready', 'editing', 'needs_platform_action', 'blocked']);
const leadKey = l => l.record_id || l.id;
const chars = s => [...String(s || '')].length;
const iso = x => new Date(x).toISOString();

export function draftLimit(d = {}) { return LIMITS[d.channel] || null; }
export function checkBody(d, body) {
  if (!String(body || '').trim()) throw Error('正文不能为空');
  const limit = draftLimit(d);
  if (limit && chars(body) > limit) throw Error(`${CHANNEL_LABEL[d.channel] || d.channel}最多 ${limit} 字，现在 ${chars(body)} 字`);
}
export function findDraft(draft_id, drafts = lines('state/drafts.ndjson')) {
  const d = drafts.find(x => x.draft_id === draft_id);
  if (!d) throw Error('没有这份草稿');
  return d;
}
// 给网页的完整视图：草稿 + 所属线索的摘要，不含 JD 全文之外的大字段。
export function draftView(draft_id, { readonly = false } = {}) {
  const d = findDraft(draft_id);
  const lead = lines('state/leads.ndjson').find(l => leadKey(l) === d.record_id) || null;
  return {
    draft: d, gmail: isGmailDraft(d), limit: draftLimit(d), editable: !readonly && EDITABLE.has(d.status), fingerprint: draftFingerprint(d),
    lead: lead ? { id: leadKey(lead), number: lead.number, company: lead.company, role: lead.role, location: lead.location, url: lead.url, verdict: lead.match?.verdict || null, gap: lead.match?.biggest_gap || null, reasons: lead.match?.reasons || [] } : null,
    previous: d.previous || null, pending_edit: d.pending_edit || null, send_blocked: platformMessageBlock(d),
  };
}

// 取消不会发信、删除 Gmail 草稿或重新起草。后续仍走原来的联系 / Writer 流程。
export function cancelPausedDraft(input = {}) {
  for (const name of ['leads', 'send-requests', 'outbound']) lines(`state/${name}.ndjson`);
  const { draft, repeated } = cancelPaused(input);
  let message = isGmailDraft(draft)
    ? '旧稿的本地待发已取消，Gmail 中的草稿未删除。旧正文、附件和审批历史保留；尚未准备新稿。'
    : '旧稿的待发已取消，正文、附件和审批历史保留；尚未准备新稿。';
  let log_error = null;
  if (!repeated) try { event('user', 'draft', 'ok', `${draft.number == null ? '' : '#' + draft.number + ' '}取消旧暂停稿：${draft.subject || '消息草稿'}。${message}`, { lead_id: draft.record_id, draft_id: draft.draft_id }); }
  catch (e) { log_error = String(e.message || e).slice(0, 200); message += ' 进展日志未写入，材料中的取消记录已保存，请刷新查看。'; } // 兜底：取消事务已成功；将日志失败明确返回，不把已取消说成失败或恢复旧稿。
  return { status: 'cancelled', draft_id: draft.draft_id, record_id: draft.record_id, repeated, message, ...(log_error ? { log_error } : {}) };
}

export async function editDraft({ draft_id, subject, body, to, source = 'dashboard', now = Date.now() } = {}) {
  const drafts = lines('state/drafts.ndjson'), d = findDraft(draft_id, drafts);
  if (!EDITABLE.has(d.status)) throw Error(`草稿状态是 ${d.status}，不能改`);
  const next = { subject: subject == null ? d.subject : String(subject).trim(), body: body == null ? d.body : String(body).replace(/\r\n/g, '\n').trim(), to: to == null ? d.to : String(to).trim() };
  checkBody(d, next.body);
  if (d.channel === 'email' && next.to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.to)) throw Error('收件人不是有效邮箱');
  if (isGmailDraft(d) && next.to !== d.to) throw Error('Gmail 草稿的收件人请在改正文后由本机 AI 一并处理：先记备注');
  if (next.subject === (d.subject || '') && next.body === d.body && next.to === d.to) return { status: 'unchanged', draft_id };
  const at = iso(now);
  const previous = { subject: d.subject, body: d.body, to: d.to, draft_id: d.draft_id, at: d.edited_at || d.created_at || null };
  if (isGmailDraft(d)) {
    Object.assign(d, { status: 'editing', pending_edit: { ...next, at, by: source }, previous, edited_at: at, edited_by: source });
    delete d.displayed_hash;
    writeLines('state/drafts.ndjson', drafts);
    const jobs = lines('state/host-jobs.ndjson'), id = hash(['sync_draft', draft_id, next.subject, next.body]);
    if (!jobs.some(j => j.id === id)) {
      jobs.push({ id, kind: 'revise_material', record_id: d.record_id, number: d.number, company: d.company || null, draft_id, source, message_id: `dashboard-${crypto.randomUUID()}`, created_at: at, status: 'pending',
        details: `用户已在工作台亲自改好这封邮件（编号 ${d.number}，Gmail 草稿 ${draft_id}）。请把该 Gmail 草稿的主题和正文更新成下面的内容——原样使用，不要再改写、不要加内容；附件保持不变。然后独立回读核对，把 state/drafts.ndjson 里 draft_id=${draft_id} 这条的 subject/body 改成新内容、删掉 pending_edit、status 改回 ready，再按草稿展示流程重新展示全文等用户「发 ${d.number}」。\n主题：${next.subject}\n正文：\n${next.body}` });
      writeLines('state/host-jobs.ndjson', jobs);
    }
    // Gmail 草稿（命令行版留下的）：只有本机 AI 能同步（能力表 user_task 归它时）；没打开就留着这条任务，打开后接着做。
    if (whoDoes('user_task').worker === 'local_ai') requestRunNow({ reason: `[操作台] 把 ${d.number} 号邮件草稿的修改同步到 Gmail 并回读`, now });
    event('user', 'draft', 'waiting_user', `${d.number} 号邮件草稿已改，等执行器同步到 Gmail`, { lead_id: d.record_id });
    return { status: 'pending_sync', draft_id, message: '已保存。这封是 Gmail 草稿，正文改动要由本机 AI 同步到 Gmail 并回读，回读通过后会重新出现在待发清单；在那之前不能发。' };
  }
  // 本地草稿：换 id，旧授权作废；新文本就是用户看过的版本。
  const newId = 'edt-' + hash([d.record_id, d.draft_id, next.body, at]).slice(0, 24);
  Object.assign(d, next, { draft_id: newId, previous_draft_id: d.draft_id, previous, status: 'ready', edited_at: at, edited_by: source, notified_at: at, displayed_on: 'dashboard' });
  d.displayed_hash = draftFingerprint(d);
  writeLines('state/drafts.ndjson', drafts);
  event('user', 'draft', 'ok', `${d.number} 号${CHANNEL_LABEL[d.channel] || ''}草稿已在工作台改好`, { lead_id: d.record_id });
  const unsupported = platformMessageBlock(d);
  return { status: 'saved', draft_id: newId, previous_draft_id: previous.draft_id, displayed_hash: d.displayed_hash, message: unsupported ? `文案已保存；${unsupported.reason}，请在脉脉聊天中手动处理。` : '已保存，看一眼就可以发。' };
}

export async function restoreDraft({ draft_id, source = 'dashboard', now = Date.now() } = {}) {
  const drafts = lines('state/drafts.ndjson'), d = findDraft(draft_id, drafts);
  if (d.status === 'cancelled' && d.cancellation?.from === 'paused') throw Error('这份旧稿已取消，请重新准备新稿，不能恢复旧版待发');
  if (!d.previous) throw Error('这份草稿没有上一版');
  const p = d.previous, at = iso(now);
  if (isGmailDraft(d) && d.pending_edit) {
    // 还没同步出去：撤回待同步的修改即可。
    delete d.pending_edit; delete d.previous; d.status = 'ready'; d.restored_at = at;
    const jobs = lines('state/host-jobs.ndjson');
    for (const j of jobs) if (j.draft_id === draft_id && j.kind === 'revise_material' && j.status === 'pending') Object.assign(j, { status: 'dropped', dropped_at: at, dropped_by: source });
    writeLines('state/host-jobs.ndjson', jobs);
    writeLines('state/drafts.ndjson', drafts);
    return { status: 'restored', draft_id, message: '已撤回未同步的修改，草稿回到原来的版本。' };
  }
  const current = { subject: d.subject, body: d.body, to: d.to, draft_id: d.draft_id, at: d.edited_at || null };
  Object.assign(d, { subject: p.subject, body: p.body, to: p.to, previous: current, edited_at: at, edited_by: source, restored_at: at });
  if (!isGmailDraft(d)) { d.draft_id = 'edt-' + hash([d.record_id, d.draft_id, p.body, at]).slice(0, 24); d.notified_at = at; d.displayed_on = 'dashboard'; d.displayed_hash = draftFingerprint(d); d.status = 'ready'; }
  writeLines('state/drafts.ndjson', drafts);
  return { status: 'restored', draft_id: d.draft_id, message: '已恢复上一版。' };
}

// AI 重写：只给模型事实（岗位简报、候选人证据、当前稿、用户要求），返回一份提案，
// 不落盘；用户看过、改过、点保存才生效。
// 你在编辑框前等着（10-04 实测 #429：「模型正在重写」挂了几分钟没结果）：整件事最多 REWRITE_MS——排队（模型调用默认一次一个，
// 前面可能排着判断、改简历）和调用都算在里面；到点了照实说没按时写出来，框里给「再试一次」。不交给本机 AI 的任务队列，就是一次文字调用。
// 有字数上限的渠道（BOSS / 脉脉私信 300 字、脉脉附言 50 字）：写出来还超，时间够就带着超了多少再要一次；还超就照实标出来，保存时 checkBody 照样拦。
export const REWRITE_MS = 90000;
const deadline = (p, ms) => { let t; return Promise.race([p.finally(() => clearTimeout(t)), new Promise((_, no) => { t = setTimeout(() => no(Error('rewrite_timeout')), ms); t.unref?.(); })]); };
export async function rewriteDraft({ draft_id, instruction = '', model = infer, now = Date.now(), limit_ms = REWRITE_MS } = {}) {
  const started = Date.now(), left = () => limit_ms - (Date.now() - started);
  try { return await deadline(rewriteOnce({ draft_id, instruction, model, now, left }), limit_ms); }
  catch (e) { throw Object.assign(Error(/没有这份草稿|模型没有返回正文/.test(e.message) ? e.message : plainModelError(e.message)), { retry: true }); }
}
async function rewriteOnce({ draft_id, instruction, model, now, left }) {
  const d = findDraft(draft_id);
  const lead = lines('state/leads.ndjson').find(l => leadKey(l) === d.record_id) || { company: d.company, role: d.subject };
  const facts = loadFacts();
  const brief = jobBrief(lead, { facts });
  const evidence = candidateEvidence(facts).map(e => `- ${e.text}`).join('\n');
  const limit = draftLimit(d), lang = jdLanguage(lead);
  const kind = CHANNEL_LABEL[d.channel] || '邮件';
  const purpose = { referral: '请对方帮忙内推', followup: '对已发邮件的跟进', inquiry: '询问岗位与联系方式', first_contact: '第一次联系招聘方', application: '正式申请该岗位' }[d.purpose] || '申请该岗位';
  const rules = [
    `这是一封${kind}，目的：${purpose}。`,
    limit ? `严格不超过 ${limit} 个字符（含标点）。` : lang === 'zh' ? '正文 150–260 字，分 2–3 段。' : 'Body 120–200 English words, 2–3 short paragraphs.',
    limit ? '要缩短就删掉次要的内容，不要把专有名词、产品名、技术词压缩、意译或自造成新词（比如把一个英文接口名译成说不通的中文）；保留的每一句都要是通顺的完整句子。' : '',
    lang === 'zh' ? '用中文。' : 'Write in English (the posting is in English).',
    '只能使用下面「候选人事实」里出现的经历、项目和数字；不得编造年限、职位、成果或未列出的技能。',
    '开头一句先说明身份与来意；随后用 2–3 点对应岗位要求的具体证据；结尾一句明确请求（回复 / 内推 / 约聊）。',
    '不写套话，不吹捧对方公司，不提本系统或自动化工具，不出现「作为 AI」之类字样。',
    d.channel === 'email' ? '主题保持简洁：岗位 + 姓名（沿用当前主题的信息即可，可微调）。' : '主题字段照抄当前主题，不用改。',
    d.referrer ? `对方是${d.referrer.author || '内推人'}（关系：${d.referrer.relationship || '未知'}），语气礼貌简短。` : '',
    instruction ? `用户的修改要求（最高优先级）：${instruction}` : '用户没有额外要求：在保留事实的前提下让它更具体、更短、更像本人写的。',
  ].filter(Boolean).join('\n');
  const memory = recall({ numbers: [d.number].filter(Boolean), companies: [lead.company || d.company].filter(Boolean), text: `${lead.company || ''} ${d.purpose || ''} 求职信 写法`, kinds: ['company', 'preference', 'lesson', 'decision', 'fact'], limit: 8, chars: 2500, now });
  const prompt = `请重写下面这封求职${kind}。\n\n## 规则\n${rules}${memory.length ? `\n\n## 相关记忆（用户偏好与已知情况，优先于默认写法，但不得据此编造事实）\n${renderNotes(memory)}` : ''}\n\n## 岗位简报\n${brief.text}\n\n## 候选人事实（唯一可用的事实来源）\n${evidence}\n\n## 当前草稿\n收件人：${d.to}\n主题：${d.subject || ''}\n正文：\n${d.body}\n\n## 输出\n返回 JSON：{"subject": 主题, "body": 正文, "notes": 一句话说明改了什么}`;
  const schema = { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' }, notes: { type: 'string' } }, required: ['subject', 'body', 'notes'], additionalProperties: false };
  const ask = (text, tag) => model(text, `rewrite-${hash([draft_id, instruction, now, tag]).slice(0, 20)}`, schema, { role: 'quill', parallel: true, wait_ms: Math.max(1000, left() - 5000) });
  let r = await ask(prompt, 1), body = String(r.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw Error('模型没有返回正文');
  // 超了上限、还剩得下一次调用的时间：带着这次的稿子和超了多少再要一次，取短的那份。
  if (limit && chars(body) > limit && left() > 30000) {
    try {
      const again = await ask(`${prompt}\n\n## 上一次的结果超了\n上一次写了 ${chars(body)} 字，上限是 ${limit} 字。这次正文必须少于 ${Math.floor(limit * 0.9)} 字，意思不变：\n${body}`, 2);
      const b2 = String(again.body || '').replace(/\r\n/g, '\n').trim();
      if (b2 && chars(b2) < chars(body)) { r = again; body = b2; }
    } catch {} // 兜底：第二次没写出来，交出第一次的稿子，框里照实标「超过上限」
  }
  return { draft_id, subject: d.channel === 'email' ? String(r.subject || d.subject || '').trim() : d.subject, body, notes: String(r.notes || '').slice(0, 300), limit, chars: chars(body), over_limit: !!limit && chars(body) > limit, language: lang };
}

// ── AI 缩短：缩完回读一遍再交（负责人 10-05 O1：#498 缩出「微软配对接口」，读不通还交了） ─────────────────────
// 先按渠道上限重写（rewriteDraft），再把原文和缩短版一起交给模型核一遍：意思变没变、有没有原文里没有的说法、读不读得通、
// 有没有生造的词。没过、或者核对本身没做成：不交，原文不动，照实说为什么。过了才回去由调用方存成新草稿。
// → { ok: true, …rewriteDraft 的结果, check } 或 { ok: false, reason, chars?, limit? }。
export async function shortenDraft({ draft_id, model = infer, now = Date.now(), limit_ms = REWRITE_MS } = {}) {
  const d0 = findDraft(draft_id), limit = draftLimit(d0);
  const started = Date.now();
  const r = await rewriteDraft({ draft_id, instruction: limit ? `缩短到 ${limit} 字以内，意思不变` : '缩短一些，意思不变', model, now, limit_ms });
  if (r.over_limit) return { ok: false, reason: `AI 缩短以后还有 ${r.chars} 字，超过上限 ${r.limit} 字；原文没动`, chars: r.chars, limit: r.limit };
  let check;
  try { check = await deadline(readBack({ before: d0.body, after: r.body, model, draft_id, now }), Math.max(15000, limit_ms - (Date.now() - started))); }
  catch (e) { return { ok: false, reason: `缩短版没核对成（${/rewrite_timeout/.test(e.message) ? '等太久了' : plainModelError(e.message)}），没换，原文没动` }; }
  if (!check.ok) return { ok: false, reason: `缩短版读不通，没换，原文没动：${check.problem}`, check };
  return { ok: true, ...r, check };
}
// 回读核对：只回 { ok, problem }。模型说不清楚（没给 ok）按没过算。
async function readBack({ before, after, model, draft_id, now }) {
  const prompt = `下面是同一段求职消息的原文和缩短版。只做核对，不要改写。\n\n逐条检查缩短版：\n1. 意思和原文一致，没有加进原文里没有的经历、项目、数字或说法；\n2. 每一句都读得通，是自然的完整句子；\n3. 专有名词、产品名、技术词没有被压缩、意译成说不通的词或者生造的新词（比如把英文的接口名硬译成中文）。\n任何一条不满足就 ok=false，problem 用一句中文说清是哪一处、哪里不对；都满足 ok=true，problem 留空。\n\n## 原文\n${before}\n\n## 缩短版\n${after}\n\n## 输出\n返回 JSON：{"ok": true 或 false, "problem": 一句话}`;
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, problem: { type: 'string' } }, required: ['ok', 'problem'], additionalProperties: false };
  const v = await model(prompt, `shorten-check-${hash([draft_id, before, after, now]).slice(0, 20)}`, schema, { role: 'quill', parallel: true });
  const ok = v?.ok === true, problem = String(v?.problem || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { ok, problem: ok ? '' : problem || '核对没说清楚哪里对不上' };
}
