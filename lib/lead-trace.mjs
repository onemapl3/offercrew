// 岗位页「进展」「材料」可追溯（负责人 2026-09-30）：每一步的证据说成人话，不再把人扔到一页 JSON 上。
//   traceView(rid, ref)  一份证据 → { kind, rows, body, quote, attachments, images, fields, links, raw }：
//                        email 发出（或收到）的那封信：收件人、主题、时间、正文、附件（简历能打开）、「在邮箱里打开」；
//                        dm    平台私信：发了什么、对话里读回的那一段、「在平台打开」；
//                        form  预填 / 投递：截图、读回的字段、回执；
//                        kv    别的 JSON：键和值（去掉 token、cookie 一类）；text 纯文本；log 日志（页面给原始链接）。
//   resumeUsed(lead)     这个岗位用的是哪份简历：邮件附件、申请表上传的那份；还没投时按规则会用的那份。
//   leadFile(rid, ref)   只读文件：这条线索用过的简历（candidate/ 下）和登记在这条线索上的证据（runs/ 下）；不碰 private/。
// 读的记录：state/outbound.ndjson、drafts、host-jobs、事件（lib/dashboard.mjs detail），线索上的 auto_apply。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file } from './store.mjs';
import { cachedLines } from './state-cache.mjs';
import { detail } from './dashboard.mjs';
import { currentFacts, mailboxOf } from './facts.mjs';
import { chosenTailored, resumeLabel } from './resume-choice.mjs';
import { resumeFor } from './application-form.mjs';

const key = l => String(l?.record_id || l?.id || '');
const str = v => (v == null ? '' : String(v));
const cut = (s, n) => { const x = str(s); return x.length > n ? x.slice(0, n) + '…' : x; };
const IMAGE = ['.png', '.jpg', '.jpeg', '.webp'], TEXT = ['.txt', '.md'], RESUME_EXT = ['.pdf', '.docx'];
const SERVE = [...IMAGE, ...TEXT, '.pdf', '.docx', '.json'];
const SECRET = /token|secret|cookie|password|passwd|authorization|auth_?code|api_?key|credential|session|picture|fingerprint|signature/i;

// ── Gmail：打开发出去的那一封（按信箱选账号，/u/<信箱>/）。有 RFC 822 Message-ID 就按它搜，否则按 Gmail 的十六进制 id 打开。
const HEX = /^[0-9a-f]{10,24}$/i;
export function gmailLink({ mailbox, rfc822, id, thread_id } = {}) {
  const u = /^[^\s/@#?%]+@[^\s/@#?%]+\.[^\s/@#?%]+$/.test(str(mailbox)) ? mailbox : '0', base = `https://mail.google.com/mail/u/${u}/`;
  const mid = str(rfc822).trim().replace(/^<|>$/g, '');
  if (mid && /^[^\s<>]+@[^\s<>]+$/.test(mid)) return `${base}#search/rfc822msgid%3A${encodeURIComponent(mid)}`;
  const hex = [id, thread_id].map(str).find(x => HEX.test(x));
  return hex ? `${base}#all/${hex}` : null;
}

// ── 路径：只认仓库里 runs/ 和 candidate/ 下的相对路径，不认 . 开头的段和 private。
const safeRel = ref => typeof ref === 'string' && /^(runs|candidate)\//.test(ref) && !ref.includes('\\') && !ref.includes('\0') && !ref.split('/').some(x => x === '' || x.startsWith('.') || x.toLowerCase() === 'private');
function realInside(ref) {
  if (!safeRel(ref)) throw Error('不允许访问该文件');
  const top = ref.split('/')[0], base = fs.realpathSync(file(top)) + path.sep, p = fs.realpathSync(file(ref));
  if (!p.startsWith(base) || !safeRel(top + '/' + path.relative(base, p).split(path.sep).join('/'))) throw Error('不允许访问该文件');
  return p;
}
const fileUrl = (rid, ref) => `/api/lead/file?id=${encodeURIComponent(rid)}&file=${encodeURIComponent(ref)}`;
const rawUrl = ref => `/api/evidence?file=${encodeURIComponent(ref)}`;
const exists = rel => { try { return fs.statSync(file(rel)).isFile(); } catch { return false; } }; // 兜底：文件不在或读不出就是没有
const sha = rel => { try { return crypto.createHash('sha256').update(fs.readFileSync(file(rel))).digest('hex'); } catch { return null; } }; // 兜底：文件不在就没有指纹
const readJson = abs => { try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; } }; // 兜底：文件不在或读坏了就当没有这条记录

// ── 这条线索登记过的证据（发出记录、投递、主机任务、草稿、事件），和它们目录下的文件。
const refsOf = v => [v].flat().map(x => typeof x === 'string' ? x : x?.file || x?.screenshot || null).filter(x => typeof x === 'string' && x.startsWith('runs/'));
function leadRefs(rid, d) {
  const l = d.lead, a = l.auto_apply || {}, out = new Set();
  const add = v => refsOf(v).forEach(x => out.add(x.replace(/\/$/, '')));
  for (const o of d.outbound || []) { add(o.evidence); add(o.screenshot); }
  for (const x of d.drafts || []) for (const k of ['evidence', 'sent_evidence', 'readback_evidence', 'reply_evidence', 'verification_evidence']) add(x[k]);
  for (const e of d.events || []) add(e.refs);
  add(a.evidence); add(a.final_review?.screenshot); add(a.prefill?.screenshot);
  for (const j of cachedLines('state/host-jobs.ndjson')) if (j.record_id === rid) add(j.evidence);
  for (const r of cachedLines('state/send-requests.ndjson')) if (r.record_id === rid) add(r.evidence);
  return out;
}
const perLeadDir = dir => /\/(auto-apply|platform-dm)\/[^/]+$/.test(dir);
function registered(rid, ref, d) {
  const refs = leadRefs(rid, d), clean = ref.replace(/\/$/, '');
  if (refs.has(clean)) return true;
  const dir = path.posix.dirname(clean);
  // 登记的是目录：它下面一层的文件；登记的是某次投递目录里的一个文件（终审截图）：同一目录的文件。
  if (refs.has(dir)) return true;
  if (perLeadDir(dir) && [...refs].some(x => path.posix.dirname(x) === dir)) return true;
  return false;
}

// ── 简历：附件名 → candidate/ 下的文件（草稿上记的路径、投递简历、定制版、candidate/ 下同名的 PDF / DOCX）。
function candidateFiles() {
  const out = [], walk = (rel, depth) => {
    let names; try { names = fs.readdirSync(file(rel), { withFileTypes: true }); } catch { return; } // 兜底：目录不在就没有
    for (const e of names) {
      if (e.name.startsWith('.') || e.name.toLowerCase() === 'private') continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < 4) walk(r, depth + 1);
      else if (e.isFile() && RESUME_EXT.includes(path.extname(e.name).toLowerCase())) out.push(r);
    }
  };
  walk('candidate', 0);
  return out;
}
function resolveResume(att, lead, facts, pool) {
  const name = str(att?.name || (typeof att === 'string' ? path.basename(att) : '')), p = str(att?.path || (typeof att === 'string' ? att : ''));
  if (p && safeRel(p) && p.startsWith('candidate/') && exists(p)) return p;
  if (!name) return null;
  const known = [att?.path, chosenTailored(lead)?.file, lead.auto_apply?.final_review?.resume, lead.auto_apply?.prefill?.resume, ...Object.values(facts?.resume_routing || {})].map(str);
  const same = [...new Set([...known.filter(x => x.startsWith('candidate/') && exists(x)), ...(pool.list ||= candidateFiles())])].filter(x => path.basename(x) === name && safeRel(x));
  if (att?.sha256) { const hit = same.find(x => sha(x) === att.sha256); if (hit) return hit; }
  return same[0] || null;
}
const isResumeName = n => RESUME_EXT.includes(path.extname(str(n)).toLowerCase());
function sentAttachments(o, rid) {
  // 发出记录的证据文件里这条线索那一封的附件（只有 id 的回执也常带附件名）。
  const ref = refsOf(o.evidence)[0];
  if (!ref || !ref.endsWith('.json')) return [];
  let abs; try { abs = realInside(ref); } catch { return []; } // 兜底：路径在数据目录外或不在，就不列（不读目录外的东西）
  const j = readJson(abs), m = (j?.sent || []).find(x => x.record_id === rid || (o.external_id && x.id === o.external_id));
  return (m?.attachments || []).filter(a => isResumeName(a?.name));
}
export function resumeUsed(lead, { facts = currentFacts() } = {}) {
  if (!lead) return [];
  const rid = key(lead), drafts = cachedLines('state/drafts.ndjson').filter(d => d.record_id === rid), outbound = cachedLines('state/outbound.ndjson').filter(o => o.record_id === rid && o.status !== 'corrected');
  const pool = {}, out = [], seen = new Set();
  const push = (att, via, state, extra = {}) => {
    const f = resolveResume(att, lead, facts, pool), name = str(att?.name) || (f ? path.basename(f) : '');
    if (!name || seen.has(`${via}|${f || name}`)) return;
    seen.add(`${via}|${f || name}`);
    const lab = resumeLabel(f || name) || {}, routing = facts?.resume_routing || {};
    if (lab.kind === 'file' && f) lab.label = f === str(routing.english_pdf) ? '投递用英文版' : f === str(routing.chinese_pdf) ? '投递用中文版' : lab.label;
    out.push({ name, file: f, url: f ? fileUrl(rid, f) : null, kind: lab.kind || 'file', label: lab.label || '', via, state, ...extra });
  };
  // 邮件：发出去的草稿的附件；草稿没记附件时看发出回执。
  const emails = outbound.filter(o => o.channel === 'email' && o.purpose !== 'reply');
  const sentDrafts = drafts.filter(d => (d.channel || 'email') === 'email' && (d.status === 'sent' || emails.some(o => o.draft_id && o.draft_id === d.draft_id)));
  for (const d of sentDrafts) for (const a of (d.attachments || []).filter(a => isResumeName(a?.name || a?.path || a))) push(a, 'email', 'sent', { at: d.sent_at || emails.find(o => o.draft_id === d.draft_id)?.at || null, to: d.to || '' });
  if (!out.length) for (const o of emails) for (const a of sentAttachments(o, rid)) push(a, 'email', 'sent', { at: o.at || o.sent_at || null, to: o.to || '' });
  // 申请表：终审 / 预填时记下的那份；已提交却没记路径的老记录，按规则当时会用的那份。
  const a = lead.auto_apply || {}, formState = a.status === 'submitted' || outbound.some(o => o.channel === 'ats_form' || /^portal/.test(o.channel || '')) ? 'submitted' : a.status === 'awaiting_final_review' ? 'review' : ['submitting', 'uncertain'].includes(a.status) ? 'submitting' : null;
  if (formState) {
    const rec = a.final_review?.resume || a.prefill?.resume || null;
    let f = rec; if (!f) try { f = resumeFor(lead, facts); } catch { f = null; } // 兜底：算不出会用哪份就不列这一行
    if (f) push({ name: path.basename(f), path: f }, 'form', formState, { at: a.submitted_at || (formState === 'review' ? a.final_review?.at : a.at) || null, recorded: !!rec });
  }
  if (out.length) return out;
  // 还没发、没投：等你审的草稿带的那份，或者投递排上了按规则会用的那份。
  for (const d of drafts.filter(d => ['ready', 'editing'].includes(d.status))) for (const x of (d.attachments || []).filter(x => isResumeName(x?.name || x?.path || x))) push(x, 'email', 'ready', { to: d.to || '' });
  // 已经预填过（停在提交前交给你）：写预填上去的那一份，不是现在按规矩会选的那一份。
  if (!out.length && (a.status || a.user_requested_at || lead.application_packet)) { let f = a.status === 'prepared_for_user' ? a.prefill?.resume || null : null; if (!f) try { f = resumeFor(lead, facts); } catch {} if (f) push({ name: path.basename(f), path: f }, 'form', 'planned', a.prefill?.resume && f === a.prefill.resume ? { recorded: true } : {}); }
  return out;
}

// 还没为这条线索定下哪份（没批准、没草稿）：按规则投递时会用的那份（为它改过的、或按 JD 语言选的投递版）。岗位页「材料」用。
export function resumeDefault(lead, { facts = currentFacts() } = {}) {
  if (!lead) return null;
  let f = null; try { f = resumeFor(lead, facts); } catch {} // 兜底：算不出会用哪份就当还没定
  return f ? { name: path.basename(String(f)), file: String(f) } : null;
}

// ── 只读文件：这条线索用过的简历，或者登记在这条线索上的证据。
export function leadFile(rid, ref) {
  const d = detail(String(rid || ''));
  if (!d) throw Error('记录不存在');
  const p = realInside(String(ref || ''));
  const ext = path.extname(p).toLowerCase();
  if (!SERVE.includes(ext) || !fs.statSync(p).isFile()) throw Error('不允许访问该文件');
  if (ref.startsWith('candidate/')) { if (!RESUME_EXT.includes(ext) || !resumeUsed(d.lead).some(u => u.file === ref)) throw Error('不允许访问该文件'); return p; }
  if (!registered(rid, ref, d)) throw Error('仅可打开这条线索登记的证据');
  return p;
}

// ── 证据 → 人能看的样子。
const pairsOf = (headers) => Array.isArray(headers) ? headers.map(h => [str(h?.name).toLowerCase(), str(h?.value)]) : Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), str(v)]);
const header = (headers, name) => pairsOf(headers).find(([k]) => k === name.toLowerCase())?.[1] || '';
const decode = b => { try { return Buffer.from(str(b), 'base64url').toString('utf8'); } catch { return ''; } }; // 兜底：解不开就当空的
function mailParts(payload, acc = { text: '', html: '', files: [] }) {
  if (!payload || typeof payload !== 'object') return acc;
  const mt = str(payload.mime_type || payload.mimeType).toLowerCase(), body = payload.body || {}, name = str(payload.filename);
  const content = typeof body.content === 'string' ? body.content : body.base64_url_content || body.data ? decode(body.base64_url_content || body.data) : '';
  if (name) acc.files.push({ name, size: body.size || 0 });
  else if (mt === 'text/plain' && content && !acc.text) acc.text = content;
  else if (mt === 'text/html' && content && !acc.html) acc.html = content;
  for (const p of payload.parts || []) mailParts(p, acc);
  return acc;
}
const htmlText = s => str(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
function emailView(m, { rid, lead, facts, mailbox, draft, out }) {
  const heads = m.headers || m.payload?.headers, parts = mailParts(m.payload);
  const to = str(m.to || header(heads, 'to') || draft?.to), from = str(m.from || header(heads, 'from'));
  const subject = str(m.subject || header(heads, 'subject') || draft?.subject);
  const body = str(m.body || parts.text || htmlText(parts.html) || draft?.body || m.snippet);
  const at = m.at || (m.internal_date && /^\d+$/.test(m.internal_date) ? new Date(Number(m.internal_date)).toISOString() : null) || header(heads, 'date') || out?.at || out?.sent_at || null;
  const incoming = !!from && mailbox && !from.includes(mailbox) && to.includes(mailbox);
  const pool = {}, used = new Set(resumeUsed(lead, { facts }).map(u => u.file).filter(Boolean));
  const atts = (m.attachments?.length ? m.attachments : parts.files.length ? parts.files : draft?.attachments || []).map(a => {
    const f = isResumeName(a?.name) ? resolveResume(a, lead, facts, pool) : null;
    return { name: str(a?.name || a), size: a?.size || 0, url: f && used.has(f) ? fileUrl(rid, f) : null };
  });
  const link = gmailLink({ mailbox, rfc822: m.rfc822 || header(heads, 'message-id'), id: m.id || m.message_id || out?.external_id, thread_id: m.thread_id || out?.thread_id });
  return { kind: 'email', at, rows: [[incoming ? '发件人' : '收件人', incoming ? from : to], ['主题', subject]].filter(([, v]) => v), body: cut(body, 12000), attachments: atts, links: link ? [{ label: '在邮箱里打开', url: link }] : [] };
}
function excerpt(thread, body) {
  const t = str(thread).replace(/\s+/g, ' ').trim(), note = str(body).replace(/\s+/g, ' ').trim();
  return note && t.includes(note) ? str(body).trim() : '';
}
const PROOF_KEYS = { status: '结果', result: '结果', reason: '原因', summary: '说明', message: '说明', step: '步骤', url: '页面', at: '时间', created_at: '时间', confirmation: '回执', count: '数量' };
function kvRows(j) {
  return Object.entries(PROOF_KEYS).filter(([k]) => j?.[k] != null && ['string', 'number', 'boolean'].includes(typeof j[k])).map(([k, label]) => [label, cut(j[k], 400)]);
}

const fieldRows = fs0 => (fs0 || []).map(f => [str(f?.key || f?.label), cut(f?.value, 300)]).filter(([k]) => k);
function formView(rid, lead, files, { url, fields, confirmation, at }) {
  const imgs = files.filter(f => IMAGE.includes(path.extname(f).toLowerCase()));
  const order = n => /final|prefill/.test(n) ? 0 : /submitted/.test(n) ? 2 : 1;
  imgs.sort((a, b) => order(path.basename(a)) - order(path.basename(b)) || a.localeCompare(b));
  return { kind: 'form', at: at || null, rows: [['回执', cut(str(confirmation).trim(), 500)]].filter(([, v]) => v), images: imgs.map(f => fileUrl(rid, f)), fields: fieldRows(fields), links: url ? [{ label: '申请页', url }] : [] };
}
export function traceView(rid, ref) {
  rid = String(rid || ''); ref = String(ref || '').replace(/\/$/, '');
  const d = detail(rid);
  if (!d) throw Error('记录不存在');
  const abs = realInside(ref);
  if (!registered(rid, ref, d)) throw Error('仅可打开这条线索登记的证据');
  const lead = d.lead, facts = currentFacts(), a = lead.auto_apply || {};
  const out = (d.outbound || []).find(o => refsOf([o.evidence, o.screenshot]).some(x => x.replace(/\/$/, '') === ref)) || null;
  const draft = (d.drafts || []).find(x => out?.draft_id && x.draft_id === out.draft_id) || (d.drafts || []).find(x => x.status === 'sent' && (x.channel || 'email') === (out?.channel || 'email')) || null;
  const mailbox = mailboxOf(facts);
  const base = { raw: rawUrl(ref) }, ext = path.extname(ref).toLowerCase();
  const withBase = v => ({ ...base, ...v, at: v.at || out?.at || out?.sent_at || null });
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const names = fs.readdirSync(abs).filter(n => !n.startsWith('.') && fs.statSync(path.join(abs, n)).isFile()), files = names.map(n => `${ref}/${n}`);
    if (names.includes('approved.json') || names.includes('thread.json') || /platform|maimai|dm/.test(out?.channel || '')) {
      const ap = readJson(path.join(abs, 'approved.json')) || {}, th = readJson(path.join(abs, 'thread.json')) || {}, dr = ap.draft || draft || {};
      const body = str(dr.body || out?.body || out?.body_preview);
      const friend = (dr.channel || out?.channel) === 'maimai_friend_request';
      return withBase({ kind: 'dm', rows: [['平台', str(dr.platform || out?.platform)], ['对方', str(out?.to && !/^https?:/.test(out.to) ? out.to : '')], [friend ? '好友申请' : '读回', th.delivered === true ? (friend ? '好友申请附言已提交' : '对话里找到了这条') : th.error ? cut(th.error, 80) : '']].filter(([, v]) => v), body, quote: friend ? '' : excerpt(th.thread, body), links: /^https:\/\//.test(str(th.url || dr.to)) ? [{ label: '在平台打开', url: str(th.url || dr.to) }] : [] });
    }
    const pre = readJson(path.join(abs, 'prefilled.json')) || {};
    const conf = names.includes('confirmation.txt') ? fs.readFileSync(path.join(abs, 'confirmation.txt'), 'utf8') : out?.confirmation;
    if (names.some(n => IMAGE.includes(path.extname(n).toLowerCase())) || names.includes('prefilled.json') || conf)
      return withBase(formView(rid, lead, files, { url: pre.url || out?.url || a.final_review?.url, fields: pre.fields || a.final_review?.fields || a.prefill?.fields, confirmation: conf, at: out?.at }));
    return withBase({ kind: 'kv', rows: names.slice(0, 30).map(n => ['文件', n]) });
  }
  if (ext === '.log') return withBase({ kind: 'log' });
  if (IMAGE.includes(ext)) {
    const inForm = /\/auto-apply\//.test(ref) || a.final_review?.screenshot === ref || out?.channel === 'ats_form' || /^portal/.test(out?.channel || '');
    const fields = a.final_review?.screenshot === ref ? a.final_review?.fields : a.prefill?.screenshot === ref ? a.prefill?.fields : inForm ? (readJson(path.join(path.dirname(abs), 'prefilled.json'))?.fields || a.final_review?.fields) : null;
    return withBase(inForm ? formView(rid, lead, [ref], { url: out?.url || a.final_review?.url, fields, confirmation: out?.confirmation }) : { kind: 'image', images: [fileUrl(rid, ref)] });
  }
  if (TEXT.includes(ext)) return withBase({ kind: 'text', body: cut(fs.readFileSync(abs, 'utf8'), 8000) });
  if (ext !== '.json') return withBase({ kind: 'file' });
  const j = readJson(abs);
  if (!j || typeof j !== 'object') return withBase({ kind: 'file' });
  const box = str(j.profile?.email || j.mailbox) || mailbox, ctx = { rid, lead, facts, mailbox: box, draft, out };
  const mine = x => x && (x.record_id === rid || (out?.external_id && x.id === out.external_id) || (lead.number != null && x.number === lead.number) || (draft?.draft_id && x.draft_id === draft.draft_id));
  if (Array.isArray(j.sent)) { const m = j.sent.find(mine); if (m) return withBase(emailView(m, { ...ctx, draft: (d.drafts || []).find(x => x.draft_id && x.draft_id === m.draft_id) || draft })); }
  if (Array.isArray(j.messages)) { const m = j.messages.find(mine); if (m) return withBase(emailView(m, ctx)); }
  if (j.headers && (j.body || j.message_id)) return withBase(emailView(j, ctx));
  if (j.draft && typeof j.draft === 'object' && j.draft.body) return withBase({ kind: 'dm', rows: [['平台', str(j.draft.platform)]].filter(([, v]) => v), body: str(j.draft.body) });
  if (typeof j.thread === 'string') return withBase({ kind: 'dm', rows: [], body: str(draft?.body || out?.body), quote: excerpt(j.thread, draft?.body || out?.body) });
  if (Array.isArray(j.fields)) return withBase(formView(rid, lead, j.screenshot && safeRel(j.screenshot) ? [j.screenshot] : [], { url: j.url, fields: j.fields, confirmation: j.confirmation }));
  if (Array.isArray(j.sent) || Array.isArray(j.messages)) return withBase({ kind: 'kv', rows: [['说明', '这份回执里没有这条线索的邮件']] });
  return withBase({ kind: 'kv', rows: kvRows(j) });
}
