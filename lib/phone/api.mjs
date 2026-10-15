// 手机能做的事（经端到端加密通道，lib/phone/service.mjs 解开后交到这里）。只有四个：
//   status        一小段进度：几件等你拍板、进行中的几件走到哪了
//   inbox.list    收件箱里等你回的信（和工作台同一份 inboxView，去掉内部步骤、本机文件路径）
//   inbox.answer  回一封信：走和工作台同一个 answerAsk；先核对你看到的是不是现在这一版（version），
//                 发送、提交、投递这类要确认的，先回一个预览和一次性确认码，手机上点了「确认」带着确认码再来一次才执行
//   talk          跟团队说一句（进对话面板，记在这部手机的会话里）；指令和交给执行器只有这部手机被允许（hand_off）时才行，默认不行
// 没有设置、没有文件、没有密钥：其余任何方法都答「回电脑处理」。
import crypto from 'node:crypto';
import { inlineConfirm } from '../asks.mjs';
import { crewName } from '../crew.mjs';
import { errorReason } from '../say-error.mjs';
import { ASK_TYPES } from '../asks.mjs';

export const METHODS = ['status', 'inbox.list', 'inbox.answer', 'talk'];
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const str = (s, n) => (s == null ? null : cut(s, n));
const httpUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u) ? cut(u, 500) : null);
const fail = (code, message) => Object.assign(Error(message), { code });

// 只在电脑上才能做的选项：打开页面、切到投递页、改稿编辑器、飞书扫码。手机上照样能点（电脑上会打开），但标出来。
const MAC_ONLY = new Set(['open', 'application_page', 'reveal_resume', 'draft_editor', 'feishu_login', 'navigate']); // navigate：跳到工作台里的某一页（定制版的「打开看看」）
export function phonePreview(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'message') return { kind: 'message', platform: str(p.platform, 30), from: str(p.from, 200), body: str(p.body, 8000), received_at: str(p.received_at, 40), time_label: str(p.time_label, 80), url: typeof p.url === 'string' && p.url.length <= 500 ? httpUrl(p.url) : null, truncated: p.truncated === true || String(p.body ?? '').length > 8000 };
  if (p.kind === 'draft') return { kind: 'draft', channel: str(p.channel, 30), platform: str(p.platform, 30), to: str(p.to, 200), subject: str(p.subject, 300), body: str(p.body, 8000), attachments: (p.attachments || []).slice(0, 5).map(a => cut(typeof a === 'string' ? a : a?.name, 120)), warning: str(p.warning, 300) };
  if (p.kind === 'form') return { kind: 'form', url: httpUrl(p.url), filled_at: str(p.filled_at, 40), resume: str(p.resume, 120), fields: (p.fields || []).slice(0, 40).map(f => ({ label: cut(f.label ?? f.key, 120), value: cut(f.value, 1000) })) };
  return { kind: str(p.kind, 30) };
}
// 发送 / 投递的确认预览（dispatchCommand 的 needs_confirm）。
export function confirmPreview(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'send') return { kind: 'send', drafts: (p.drafts || []).slice(0, 10).map(d => ({ number: d.number ?? null, company: str(d.company, 80), channel: str(d.channel, 30), to: str(d.to, 200), subject: str(d.subject, 300), body: str(d.body, 8000), attachments: (d.attachments || []).slice(0, 5).map(a => cut(a?.name ?? a, 120)) })), missing: (p.missing || []).slice(0, 20) };
  if (p.kind === 'queue_apply') return { kind: 'queue_apply', rows: (p.rows || []).slice(0, 20).map(r => ({ number: r.number ?? null, company: str(r.company, 80), role: str(r.role, 120), city: str(r.city, 40), channel: str(r.channel, 40), reason: str(r.reason, 200), in_proposal: !!r.in_proposal })), missing: (p.missing || []).slice(0, 20) };
  return { kind: str(p.kind, 30) };
}
export function phoneAsk(a = {}) {
  return {
    id: a.id, version: a.version, type: a.type, type_label: ASK_TYPES[a.type]?.label || null,
    from: a.from || null, from_name: a.from ? crewName(a.from) : null,
    title: cut(a.title, 120), question: cut(a.question, 600), context: (a.context || []).slice(0, 6).map(x => cut(x, 60)),
    note: str(a.note, 400), detail: str(a.detail, 1200), said: str(a.said, 300), due_at: str(a.due_at, 40),
    lead: a.lead ? { number: a.lead.number ?? null, company: str(a.lead.company, 80), role: str(a.lead.role, 120) } : null,
    task: a.task ? { id: cut(a.task, 40), title: str(a.task_title, 60), session_id: str(a.task_session, 32) } : null, // 这封信属于哪件活，点了进它的对话
    url: httpUrl(a.url), preview: phonePreview(a.preview),
    form: Array.isArray(a.form) ? a.form.slice(0, 10).map(f => ({ key: cut(f.key, 40), label: cut(f.label, 120), type: str(f.type, 20), options: Array.isArray(f.options) ? f.options.slice(0, 20).map(o => cut(o, 80)) : null })) : null,
    options: (a.options || []).map(o => ({ key: String(o.key), label: cut(o.label, 60), hint: str(o.hint, 200), primary: !!o.primary, danger: !!o.danger, reasons: Array.isArray(o.reasons) ? o.reasons.slice(0, 10) : null, input: o.input || null, confirm: inlineConfirm(o), on_mac: !!o.steps?.length && o.steps.every(s => MAC_ONLY.has(s.type)) })),
    other: a.other ? { placeholder: cut(a.other.placeholder, 120) } : null,
  };
}

export function phoneStatus(view = {}) {
  const counts = Object.entries(view.counts || {}).filter(([, n]) => n > 0).map(([type, n]) => ({ type, label: ASK_TYPES[type]?.label || type, n }));
  const inflight = (view.inflight || []).slice(0, 8).map(x => ({ label: cut(x.label, 120), what: str(x.what, 30), stage: str(x.stage, 160), tone: str(x.tone, 10), at: str(x.at, 40) }));
  return { waiting: view.total ?? (view.asks || []).length, counts, inflight, in_progress: (view.inflight || []).length, generated_at: view.generated_at || new Date().toISOString() };
}

// 一次性确认码：绑定这部手机、这一问的这一版、这个选项和你填的内容；10 分钟有效，用一次就没。
export class ConfirmTokens {
  constructor({ ttlMs = 600000 } = {}) { this.map = new Map(); this.ttlMs = ttlMs; }
  static bind(device, ask, input) { return crypto.createHash('sha256').update(JSON.stringify([device, ask.id, ask.version, input.option, input.reason || '', input.datetime || '', input.text || '', input.fields || null])).digest('hex'); }
  issue(device, ask, input, now = Date.now()) {
    for (const [k, v] of this.map) if (v.exp < now) this.map.delete(k);
    const token = crypto.randomBytes(18).toString('base64url');
    this.map.set(token, { bind: ConfirmTokens.bind(device, ask, input), exp: now + this.ttlMs });
    return token;
  }
  take(token, device, ask, input, now = Date.now()) {
    const t = typeof token === 'string' && this.map.get(token);
    if (!t) return false;
    this.map.delete(token);
    return t.exp >= now && t.bind === ConfirmTokens.bind(device, ask, input);
  }
}

const DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;
function cleanInput(a = {}) {
  const fields = a.fields && typeof a.fields === 'object' && !Array.isArray(a.fields) ? Object.fromEntries(Object.entries(a.fields).slice(0, 10).map(([k, v]) => [cut(k, 40), cut(v ?? '', 500)])) : null;
  const dt = DATETIME.exec(String(a.datetime || '').trim());
  return { id: cut(a.id || '', 200), version: cut(a.version || '', 40), option: cut(a.option ?? '', 20), reason: cut(a.reason || '', 60), text: cut(a.text || '', 2000).trim(), datetime: dt ? `${dt[1]} ${dt[2]}` : '', fields };
}

// deps：{ inbox(): inboxView 的结果, center(): 指挥台, answer: answerAsk, talk({ text, session_id }), handoff({ session_id, text }), tokens: ConfirmTokens, save(dev) }
export async function handleRequest(dev, req = {}, deps) {
  const m = String(req.m || ''), a = req.a && typeof req.a === 'object' ? req.a : {};
  if (!METHODS.includes(m)) throw fail('unknown_method', '回电脑处理');
  if (m === 'status') return phoneStatus(deps.inbox());
  if (m === 'inbox.list') { const v = deps.inbox(); return { asks: (v.asks || []).map(phoneAsk), total: v.total ?? (v.asks || []).length, generated_at: v.generated_at || null }; }
  if (m === 'inbox.answer') return answer(dev, a, deps);
  if (m === 'talk') return talk(dev, a, deps);
}

async function answer(dev, raw, deps) {
  const input = cleanInput(raw), view = deps.inbox();
  const ask = (view.asks || []).find(x => x.id === input.id);
  if (!ask) return { state: 'gone', message: '这一项已经处理过了（在电脑上或别的地方）。' };
  if (input.version !== ask.version) return { state: 'stale', message: '这一项刚变了，看一眼再选。', ask: phoneAsk(ask) };
  let o = null;
  if (input.option === 'other') {
    if (!ask.other) return { state: 'error', message: '这一项不接受文字回答，请点上面的选项。' };
    if (!input.text) return { state: 'error', message: '请写点什么。' };
  } else {
    o = (ask.options || []).find(x => String(x.key) === input.option);
    if (!o) return { state: 'error', message: '没有这个选项。' };
    if (o.reasons?.length && !o.reasons.includes(input.reason)) return { state: 'reasons', message: '选一个原因。', option: o.key, reasons: o.reasons };
    if (o.input === 'datetime' && !input.datetime) return { state: 'error', message: '请填面试时间（年-月-日 时:分）。' };
  }
  const bound = { option: input.option, reason: input.reason, datetime: input.datetime, text: input.option === 'other' ? input.text : '', fields: input.fields };
  const confirmed = raw.confirm_token ? deps.tokens.take(raw.confirm_token, dev.id, ask, bound) : false;
  if (raw.confirm_token && !confirmed) return { state: 'stale', message: '确认已经过期或内容变了，再看一眼。', ask: phoneAsk(ask) };
  // 确认提交、发送这类选项：先把这一版给手机看，手机带着确认码再来。
  if (o && inlineConfirm(o) && !confirmed) return { state: 'confirm', kind: 'inline', option: o.key, label: o.label, preview: phonePreview(ask.preview), confirm_token: deps.tokens.issue(dev.id, ask, bound) };
  let r;
  try { r = await deps.answer({ id: ask.id, option: input.option, text: bound.text, reason: input.reason, datetime: input.datetime, confirm: confirmed, fields: input.fields, ...(confirmed && ask.preview?.kind === 'message' ? { fingerprint: ask.version } : {}) }, { center: deps.center(), ...(dev.hand_off !== true ? { phone: { device: dev.id || null } } : {}) }); } // 没被允许交办的：目标那一问答了，放行的下一棒停在电脑确认
  catch (e) { return { state: 'error', message: errorReason(e) }; } // 手机上不露原始报错
  if (r?.needs_confirm) return { state: 'confirm', kind: 'command', option: input.option, label: o?.label || '其他', confirm_text: str(r.confirm_text, 200), preview: confirmPreview(r.preview), confirm_token: deps.tokens.issue(dev.id, ask, bound) };
  if (r?.client?.draft_editor) return { state: 'on_mac', message: '改稿在电脑上的工作台里做；也可以点「其他」直接说怎么改。' };
  return { state: 'done', receipt: cut(r?.receipt || '已处理', 600) };
}

// 手机上说的话进同一个对话面板（lib/talk.mjs talkTurn，会话标 via: 'phone'）。这部手机没被允许交给执行器时，
// 指令一律不执行（很多指令会拉起执行器）：先按对话面板同一套规则认一下，是指令就只回一句说明；万一漏认，
// 派指令和暂停 / 恢复成员这两个口子也都是拒绝的。任务板照样开卡，但要开执行器或浏览器的那一棒（收录、找内推、填表、执行器的几类）
// 停在「回电脑确认」，在电脑上点了才跑（lib/tasks.mjs mac_hold）。允许了也不带确认：发送、投递照样要先看预览再确认。
export const COMMAND_OFF = '手机上不直接执行指令。回信请在「等你回的信」里点；要从手机让团队动手，先在电脑的「设置 → 手机」里打开「允许这部手机把活交给本机 AI」。';
export function makeTalk({ talkTurn, classifyTalk, dispatch, center, hq }) {
  const refuse = async () => ({ ok: false, error: COMMAND_OFF });
  return async ({ text, session_id = null, hand_off = false, device = null }) => {
    if (!hand_off && classifyTalk(text).kind === 'command') return { session_id, reply: { content: COMMAND_OFF, persona: null }, blocked: true };
    const r = await talkTurn({ session_id, text, via: 'phone' }, { dispatch: hand_off ? (t, o = {}) => dispatch(t, { ...o, origin: 'phone', confirm: false }) : refuse, center, hq, ...(hand_off ? {} : { agent: refuse, phone: { device } }) });
    if (r.needs_confirm) return { session_id, reply: { content: '发送和投递要先确认：请在「等你回的信」里点，或者回到电脑上确认。', persona: r.persona || null } };
    const reply = r.reply || r.receipt || {};
    return { session_id: r.session?.id || session_id, reply: { content: reply.content || '', persona: reply.persona || r.persona || null, handoff: reply.handoff || null, error: !!r.error } };
  };
}

async function talk(dev, raw, deps) {
  const text = cut(raw.text || '', 2000).trim();
  if (!text) throw fail('empty', '请写点什么');
  if (raw.hand_off === true) {
    if (dev.hand_off !== true) throw fail('hand_off_off', '这部手机不能把活交给本机 AI。要打开，在电脑上「设置 → 手机」里勾选。');
    let session_id = dev.chat_session || null;
    if (!session_id) { const t = await deps.talk({ text, session_id: null, hand_off: true }); session_id = t.session_id; }
    const h = await deps.handoff({ session_id, text });
    if (dev.chat_session !== session_id) { dev.chat_session = session_id; deps.save(dev); }
    // 引擎自己能做的（lib/talk.mjs handTurn：Writer 的活、表里已有的链接）没排给执行器，回执照实说。
    // 本机 AI 跑不了时交给团队（routed: team）：引擎自己做，结果在那件任务的卡片上。
    const receipt = h?.routed === 'tailor' ? `交给 ${crewName('tailor')} 了，做好后在电脑的对话里给你看` : h?.routed === 'known' ? cut(h.reply?.content || '', 300) : h?.routed === 'team' ? `交给 ${crewName(h.owner || 'patch')} 了，做好后在任务里看` : '已交给本机 AI，做好后在电脑的对话里给你看';
    return { handed_off: true, session_id: h?.session?.id || session_id, receipt, ...(h?.routed ? { routed: h.routed } : {}) };
  }
  // 点开的是一件活的对话（session_id 是那件活的）：就在那段里说，这台设备自己的那段不变。
  const task = raw.session_id && raw.session_id !== dev.chat_session && deps.taskSession?.(raw.session_id) ? String(raw.session_id) : null;
  const t = await deps.talk({ text, session_id: task || dev.chat_session || null, hand_off: dev.hand_off === true, device: dev.id });
  if (!task && dev.chat_session !== t.session_id) { dev.chat_session = t.session_id; deps.save(dev); }
  const reply = t.reply || {};
  return { session_id: t.session_id, reply: { text: cut(reply.content || '', 4000), from: reply.persona || null, from_name: reply.persona ? crewName(reply.persona) : null, error: !!reply.error }, can_hand_off: dev.hand_off === true, suggested_hand_off: dev.hand_off === true && reply.handoff?.text ? cut(reply.handoff.text, 500) : null };
}
