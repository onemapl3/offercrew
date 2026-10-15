// 手机网关（手机第二里程碑，design/phone-m2/实施方案.md 第二、四、十节、附录 B）：手机上跑的是专门的手机 App（web/phone/，对话 / 等你 / 我的），
// 它的请求经端到端加密通道（lib/phone/service.mjs 解开）交到这里，由这台 Mac 替手机去问本机的工作台。
//
// 手机发来的方法（请求帧 { id, m, a }，中转上都标 live：电脑不在线就不排队）：
//   hello         { }                                       → { protocol, bundle, mac, device: { id, name, hand_off, push }, limits }
//   bundle        { version? }                              → { version, same: true } 或 { version, files: { 路径: { type, body | b64 } } }（手机 App 的代码）
//   http          { method, path, headers?, body? }         → { status, headers: { content-type, content-disposition? }, body | b64 }
//   events        { op: subscribe | keepalive | unsubscribe } → { ok, ttl_ms }；订阅了的手机在工作台有更新时收到推送 { push: 'update' }
//   push.key      { }                                       → { key }（这台 Mac 的 VAPID 公钥，lib/phone/push.mjs）
//   push.subscribe { endpoint, keys: { p256dh, auth } }     → { ok, push: true }；endpoint 只认真正的推送服务
//   push.unsubscribe { }                                    → { ok, push: false }
// （第一版的 status / inbox.list / inbox.answer / talk 在 lib/phone/api.mjs。）
// 答复（lib/phone/service.mjs）：{ ok, data } 或 { ok: false, code, error }，gzip 后按块切开，每块单独封一帧 { re, part, parts, z }。
//
// 把关：
//   · 白名单 ROUTES（附录 B：对话要的那几个接口），名单外一律 403「回电脑处理」（on_mac: true）；新加的接口默认手机用不了。
//   · 工作台的口令（x-radar-token）只在本机用：网关自己带上；回答里顶层的 token 删掉；万一哪里还带着口令，整条答复作废。
//   · 往外生效的（对话里的指令、回信、任务卡上的答）要一次性确认令牌，见 outward()。
//   · 交给执行器的（/api/chat/handoff，以及对话里的指令）只有这部手机被允许 hand_off 才行。没被允许的手机说的话照样开卡，
//     要开执行器或浏览器的那一棒停在「回电脑确认」；放行它的 POST /api/tasks/*/release 只在电脑上点，这里明确拒绝。
//   · 替手机问工作台的每个请求都带 x-radar-phone（on / limited），工作台据此拒绝只在电脑上做的事。
//   · 「我的」里给这部手机改名、解除配对：POST /api/phone 只认 rename / unpair，而且只能是这部手机自己。
//   · 限速按手机算：每分钟 300 个请求、往外生效的 10 个。
//   · 每个请求在 private/phone/access.ndjson 记一行（不记查询参数和内容），按天滚动，留 30 天；POST 另在运行日志里记一句。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { file } from '../store.mjs';
import { event } from '../events.mjs';
import { inlineConfirm } from '../asks.mjs';
import { dayOf } from '../tz.mjs';
import { ownWorkbench } from '../sandbox.mjs';
import { COMMAND_OFF } from './api.mjs';
import { noteSwallowed } from '../swallow.mjs';

export const METHODS = ['hello', 'bundle', 'http', 'events', 'push.key', 'push.subscribe', 'push.unsubscribe'];
export const PROTOCOL = 2;
export const PART_BYTES = 24 * 1024; // 每块 gzip 后的原始字节；base64url 再加密后约 43 KB，离中转 64 KB 的一帧上限还远
export const REPLY_MAX = 12 * 1024 * 1024;
export const RATE = { all: 300, outward: 10 };
export const SUBSCRIBE_MS = 120000;
export const CONFIRM_TTL_MS = 600000;
export const NOT_ON_PHONE = '回电脑处理';
export const HAND_OFF_OFF = '这部手机不能把活交给本机 AI。要打开，在电脑上「设置 → 手机」里勾选。';
// 手机「等你」里这几类的「其他」要交办（和 lib/hq.mjs PHONE_ALSO 同几类：草稿、投递、跟进）。
export const HAND_OFF_OTHER = /^(draft|apply|followup):/;
export const STALE = '要发出去的内容变了，或者确认已经过期，再看一眼再确认';

const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// 键排好序的 JSON：同一份内容永远得到同一串（绑定确认令牌用）。
export const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
export const canonical = body => { const { confirm, ...rest } = obj(body); return stable(rest); };

// ── 答复打包：gzip → 切块（每块 base64url）。手机那边（relay/phone/public/client.js）拼回来、解压、解析。 ──
export async function packReply(envelope) {
  const gz = await gzip(Buffer.from(JSON.stringify(envelope)));
  const parts = [];
  for (let i = 0; i < gz.length; i += PART_BYTES) parts.push(gz.subarray(i, i + PART_BYTES).toString('base64url'));
  return parts.length ? parts : [''];
}
export async function unpackReply(parts) { return JSON.parse((await gunzip(Buffer.concat(parts.map(p => Buffer.from(p, 'base64url'))))).toString('utf8')); }

// ── 白名单（附录 B：对话优先）。一行一条：方法、地址（* 是一段）、规则；when 看内容再定规则。 ──
//   allow 放行 · outward 往外生效（一次性确认令牌）· hand_off 这部手机被允许交办才行 · refuse 回电脑处理
const R = (method, p, rule = 'allow', extra = {}) => ({ method, path: p, rule, re: new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`), ...extra });
// 「我的」：给这部手机自己改名、解除配对。别的动作（配对、交办开关）和别的手机都回电脑。
// 手机上一件活能做的移动：没做成 → 再试一次（queued），在做 → 撤回（cancelled）。
export const PHONE_MOVES = ['queued', 'cancelled'];
const PHONE_MOVE = ({ body }) => (PHONE_MOVES.includes(body?.status) ? 'allow' : 'refuse');
const OWN_PHONE = ({ body, dev }) => (['rename', 'unpair'].includes(body?.action) && body.id === dev?.id ? 'allow' : 'refuse');
export const ROUTES = [
  // 看：对话（当前这段、历史列表）、输入框下面那一行、@# 找岗位、等你的事、任务卡、@ 名单、证据截图
  ...['/api/talk', '/api/talk/parse', '/api/chat', '/api/leads', '/api/inbox', '/api/tasks/*', '/api/team', '/api/evidence', '/api/model/supply'].map(p => R('GET', p)),
  R('GET', '/api/tasks'), R('GET', '/api/tasks/*/card'), // 任务标签：目录和一件的卡片（任务卡片 L 线 10-03），只读
  R('GET', '/api/events', 'refuse'), // 由网关的推送代替
  // 做：撤回一件事、删一段对话
  R('POST', '/api/talk/withdraw'),
  R('POST', '/api/chat/delete'),
  R('POST', '/api/chat/seen'), // 看过这段对话了（对话历史上的小点，和电脑同一份）
  // 往外生效：对话里的一句（指令要确认；没被允许交办的手机，指令只回一句说明）、回信、任务卡上的答
  R('POST', '/api/talk', 'outward', { kind: 'talk' }),
  R('POST', '/api/inbox/answer', 'outward', { kind: 'inbox' }),
  R('POST', '/api/tasks/*/answer', 'outward', { kind: 'task' }),
  // 交办
  R('POST', '/api/chat/handoff', 'hand_off'),
  // 一件活的「再试一次」「撤回」（主会话 10-03）：只认这两种移动，别的移动（标完成、标卡住、放回待认领）照旧回电脑。
  // 是不是真的没做成 / 在做、连着几次了，工作台按这件活现在的状态核对（lib/task-api.mjs phoneMove）。
  R('POST', '/api/tasks/*/move', 'allow', { when: PHONE_MOVE }),
  // 卡片上的「看原因」（主会话 10-03）：System 就地答一句这件为什么没做成，只读、不开对话，手机和电脑一样。
  R('POST', '/api/tasks/*/why'),
  // 卡片上接着做：下一句指令、加子任务（任务卡片第四节）。要开本机 AI 或浏览器的，工作台按这部手机能不能交办停在「回电脑确认」。
  R('POST', '/api/tasks/*/say'), R('POST', '/api/tasks/*/subtask'),
  // 手机上开的卡里要开执行器 / 浏览器的那一棒：只在电脑上确认（名单外本来就拒绝，这里写明）
  R('POST', '/api/tasks/*/release', 'refuse'),
  // 这部手机自己
  R('POST', '/api/phone', 'allow', { when: OWN_PHONE }),
];
// 卡片上下指令、加子任务：没被允许交办的手机带上 limited，工作台按它停在「回电脑确认」（lib/task-say.mjs）。
const CARRY_LIMIT = /^\/api\/tasks\/[^/?]+\/(?:say|subtask)(?:\?|$)/;
export function matchRoute(method, pathname) { return ROUTES.find(r => r.method === method && r.re.test(pathname)) || null; }

// 往外生效的事给人看的几行：发给谁、发什么。
const CHANNEL = { email: '邮件', platform_dm: '平台私信', boss: 'BOSS 直聘', wechat: '微信', linkedin: '领英', portal: '公司招聘站' };
const host = u => { try { return new URL(u).host; } catch { return cut(u, 60); } };
export function previewLines(p) {
  if (!p || typeof p !== 'object') return { title: '确认', lines: [] };
  if (p.kind === 'send') return { title: '确认发出', lines: [...(p.drafts || []).flatMap(d => [`#${d.number ?? '?'} ${cut(d.company, 40)} · ${CHANNEL[d.channel] || cut(d.channel || '', 20)} → ${cut(d.to || '对方', 80)}`, ...(d.subject ? [`主题：${cut(d.subject, 120)}`] : [])]), ...((p.missing || []).length ? [`这些编号现在不能发：${p.missing.join('、')}`] : [])] };
  if (p.kind === 'queue_apply') return { title: '确认投递', lines: [...(p.rows || []).flatMap(r => [`投递 #${r.number ?? '?'} ${cut(r.company, 40)} · ${cut(r.role, 60)}${r.city ? `（${cut(r.city, 20)}）` : ''}`, ...(r.warn ? [r.warn] : [])]), ...((p.missing || []).length ? [`这些编号现在不能投：${p.missing.join('、')}`] : [])] };
  if (p.kind === 'draft') return { title: '确认发出', lines: [`发给：${cut(p.to || '对方', 120)}${p.platform || p.channel ? `（${CHANNEL[p.channel] || cut(p.platform || p.channel, 20)}）` : ''}`, ...(p.subject ? [`主题：${cut(p.subject, 120)}`] : []), ...(p.body ? [`正文：${cut(String(p.body).replace(/\s+/g, ' '), 160)}`] : []), ...((p.attachments || []).length ? [`附件：${p.attachments.map(a => cut(typeof a === 'string' ? a : a?.name, 60)).join('、')}`] : [])] };
  if (p.kind === 'form') return { title: '确认提交', lines: [...(p.url ? [`提交到：${host(p.url)}`] : []), ...(p.fields || []).slice(0, 12).map(f => `${cut(f.label ?? f.key, 40)}：${cut(f.value, 80)}`), ...(p.resume ? [`简历：${cut(p.resume, 80)}`] : [])] };
  return { title: '确认', lines: [] };
}
const leadLine = a => (a?.lead ? `#${a.lead.number ?? '?'} ${cut(a.lead.company, 40)}${a.lead.role ? ` · ${cut(a.lead.role, 60)}` : ''}` : cut(a?.title, 80));

// ── 访问记录：private/phone/access.ndjson，一行一个请求；每天第一次写时把昨天的改名 access-<日期>.ndjson，只留 30 天。 ──
export class AccessLog {
  constructor({ now = () => Date.now(), keepDays = 30 } = {}) { this.now = now; this.keepDays = keepDays; this.day = null; }
  write(row) {
    try {
      const dir = file('private/phone'), cur = path.join(dir, 'access.ndjson'), now = this.now(), today = dayOf(now);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (this.day == null) { try { this.day = dayOf(fs.statSync(cur).mtimeMs); } catch { this.day = today; } }
      if (this.day !== today) {
        try { fs.renameSync(cur, path.join(dir, `access-${this.day}.ndjson`)); } catch {} // 兜底：昨天的已经被别的进程改过名或不在了
        this.day = today; this.prune(dir, now);
      }
      fs.appendFileSync(cur, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (e) { noteSwallowed('phone.accessLog', e, { doing: '写手机的访问记录', then: '这次请求照常处理，记录少一行' }); }
  }
  prune(dir, now) {
    const oldest = dayOf(now - this.keepDays * 86400000);
    for (const n of fs.readdirSync(dir)) { const m = /^access-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(n); if (m && m[1] < oldest) try { fs.unlinkSync(path.join(dir, n)); } catch {} } // 兜底：旧记录删不掉就留着，下次再删
  }
}

// ── 一次性确认令牌（只在这台 Mac 上）──
// remembered：页面第一次（不带确认）请求时工作台给了预览，记下「这部手机、这个请求、这一版预览」，等页面带着 confirm 再来。
// issued：页面自己弹确认、没先问工作台要预览的（或直接带 confirm 来的），网关发一个令牌给手机的确认卡，手机带着 x-phone-confirm 再来。
// 都是 10 分钟、只能用一次。
class Confirms {
  constructor(now, ttl = CONFIRM_TTL_MS) { this.now = now; this.ttl = ttl; this.remembered = new Map(); this.issued = new Map(); }
  gc() {
    const t = this.now();
    for (const m of [this.remembered, this.issued]) { for (const [k, v] of m) if (v.exp < t) m.delete(k); while (m.size > 1000) m.delete(m.keys().next().value); }
  }
  key(device, p, canon) { return sha(`${device}\n${p}\n${canon}`); }
  cap(m, device) { const mine = [...m].filter(([, v]) => v.device === device); for (const [k] of mine.slice(0, Math.max(0, mine.length - 50))) m.delete(k); } // 每部手机最多留 50 条，挤不掉别的手机的
  remember(device, p, canon, data) { this.gc(); this.remembered.set(this.key(device, p, canon), { ...data, device, exp: this.now() + this.ttl }); this.cap(this.remembered, device); }
  consume(device, p, canon) { this.gc(); const k = this.key(device, p, canon), v = this.remembered.get(k); this.remembered.delete(k); return v || null; }
  issue(data) { this.gc(); const token = crypto.randomBytes(18).toString('base64url'); this.issued.set(token, { ...data, exp: this.now() + this.ttl }); this.cap(this.issued, data.device); return token; }
  take(token) { const v = this.issued.get(token); this.issued.delete(token); return v || null; }
  forget(device) { for (const m of [this.remembered, this.issued]) for (const [k, v] of m) if (v.device === device) m.delete(k); }
}

const jsonReply = (status, j) => ({ ok: true, data: { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(j) } });
const TEXTISH = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;
const LABEL = { '/api/inbox/answer': '回信', '/api/command': '指令', '/api/talk': '跟团队说', '/api/talk/withdraw': '撤回', '/api/settings': '改设置', '/api/settings/agent': '改设置', '/api/settings/providers': '改模型设置', '/api/settings/test': '测试模型', '/api/settings/preset': '改设置', '/api/model/free': '改模型设置', '/api/model/source': '改模型设置', '/api/facts': '改个人资料', '/api/preference': '改偏好', '/api/memory': '改记忆库', '/api/setup/profile': '改个人资料', '/api/setup/resume': '传简历', '/api/resume': '简历', '/api/phone': '手机设置', '/api/tasks': '建卡', '/api/team/run': '让成员跑一轮', '/api/agent': '成员暂停 / 恢复', '/api/ops': '跑一轮', '/api/company': '公司调研', '/api/archive': '归档', '/api/draft': '改草稿', '/api/chat': '对话', '/api/chat/handoff': '交给本机 AI', '/api/host-job': '宿主任务', '/api/system-fix': '交给 System 修复', '/api/open-url': '在电脑上打开页面', '/api/codex': 'ChatGPT 登录', '/api/gmail/start': 'Gmail 授权' };
const labelOf = (p, body) => { const t = /^\/api\/tasks\/[^/]+\/([a-z-]+)$/.exec(p); if (t) return `任务卡 · ${t[1]}`; const l = LABEL[p] || p; return p === '/api/inbox/answer' ? `${l}${body?.id ? `（${cut(body.id, 60)}）` : Array.isArray(body?.ids) ? `（${body.ids.length} 条）` : ''}` : l; };

// deps：askById(id) 收件箱里的这一封（含被推迟的）；taskAsk(cardId) 这张任务卡上要答的：信的 id、{ goal: true }（目标卡停下来问的「还投 / 不投了」）或 null；
//       classifyTalk(text) 对话面板认指令的那一套；info() { sandbox, started_at }。
export class PhoneGateway {
  constructor({ port, token, deps = {}, webRoutes = [], now = () => Date.now(), log = new AccessLog({ now }), bundleMs = 5000, push = null, onTalk = null } = {}) {
    this.push = push; this.onTalk = onTalk;
    if (!port || !token) throw Error('gateway needs port and token');
    Object.assign(this, { port, token, deps, webRoutes, now, log, bundleMs });
    this.hits = new Map(); this.subs = new Map(); this.confirms = new Confirms(now); this.bundleCache = null;
  }
  forget(id) { this.hits.delete(id); this.subs.delete(id); this.confirms.forget(id); }
  subscribed() { const t = this.now(), out = []; for (const [id, at] of this.subs) { if (t - at < SUBSCRIBE_MS) out.push(id); else this.subs.delete(id); } return out; }
  over(id, kind) {
    const t = this.now(), h = this.hits.get(id) || {}, list = (h[kind] || []).filter(x => t - x < 60000);
    list.push(t); h[kind] = list; this.hits.set(id, h);
    return list.length > RATE[kind];
  }

  // 处理一个请求。返回答复（{ ok, data } / { ok: false, code, error }）；这部手机中途被解除配对就返回 null，什么都不回。
  async handle(dev, req = {}, { alive = () => true } = {}) {
    const t0 = this.now(), m = String(req.m || ''), a = obj(req.a), row = {};
    if (!alive()) return null;
    let env;
    try { env = await this.dispatch(dev, m, a, alive, row); }
    catch (e) { env = { ok: false, code: 'error', error: cut(e.message || e, 300) }; }
    if (env == null) return null;
    const status = row.status ?? (env.ok ? env.data?.status ?? 200 : env.code === 'rate' ? 429 : 400);
    this.log.write({ at: new Date(t0).toISOString(), device: dev.id, m: cut(m, 40), ...(row.method ? { method: cut(row.method, 10), path: cut(row.path, 200) } : {}), status, ms: this.now() - t0 });
    return env;
  }
  async dispatch(dev, m, a, alive, row) {
    if (!METHODS.includes(m)) return { ok: false, code: 'unknown_method', error: NOT_ON_PHONE };
    if (this.over(dev.id, 'all')) {
      row.status = 429;
      return m === 'http' ? jsonReply(429, { error: '太频繁了，稍等一下再试' }) : { ok: false, code: 'rate', error: '太频繁了，稍等一下再试' };
    }
    if (m === 'hello') { const b = await this.bundle(); return { ok: true, data: { protocol: PROTOCOL, bundle: b.version, mac: this.deps.info?.() || {}, device: { id: dev.id, name: dev.name, hand_off: dev.hand_off === true, push: dev.push === true }, limits: { part_bytes: PART_BYTES, reply_max: REPLY_MAX } } }; }
    if (m === 'bundle') { const b = await this.bundle(); return { ok: true, data: typeof a.version === 'string' && a.version === b.version ? { version: b.version, same: true } : { version: b.version, files: b.files } }; }
    if (m === 'events') {
      const op = String(a.op || 'subscribe');
      if (op === 'unsubscribe') this.subs.delete(dev.id);
      else if (['subscribe', 'keepalive'].includes(op)) this.subs.set(dev.id, this.now());
      else return { ok: false, code: 'bad_request', error: '没有这个操作' };
      return { ok: true, data: { ok: true, ttl_ms: SUBSCRIBE_MS } };
    }
    if (m.startsWith('push.')) {
      if (!this.push) return { ok: false, code: 'not_ready', error: '电脑上的 OfferCrew 还在启动，稍等再试' };
      try { return { ok: true, data: await this.push.handle(dev, m, a) }; }
      catch (e) { return { ok: false, code: e.code || 'error', error: cut(e.message || e, 200) }; }
    }
    return this.http(dev, a, alive, row);
  }

  // ── 本机工作台 ──
  local(method, pathQ, { body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      // 演示 / 沙盒模式也要能问本机的工作台：只放行到 127.0.0.1 的 http（lib/sandbox.mjs ownWorkbench），别的地方照样拦。
      const req = ownWorkbench(() => http.request({ host: '127.0.0.1', port: this.port, method, path: pathQ, timeout: 300000, headers: {
        host: `127.0.0.1:${this.port}`, origin: `http://127.0.0.1:${this.port}`, 'x-radar-token': this.token, 'x-radar-phone': 'on',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}), ...headers,
      } }));
      req.on('response', res => {
        const chunks = []; let n = 0;
        res.on('data', c => { n += c.length; if (n > REPLY_MAX) { res.destroy(); req.destroy(); reject(Object.assign(Error('too_big'), { code: 'too_big' })); } else chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Error('timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  // 本机的回答 → 给手机的 http 答复：只留 content-type / content-disposition；JSON 顶层的 token 删掉；口令哪里都不许出现。
  toHttp(res, { shape = null, ctx = {} } = {}) {
    const type = String(res.headers['content-type'] || ''), out = { status: res.status, headers: { 'content-type': type } };
    if (res.headers['content-disposition']) out.headers['content-disposition'] = String(res.headers['content-disposition']);
    let text = null, json;
    if (/json/i.test(type)) { try { json = JSON.parse(res.buf.toString('utf8')); } catch {} } // 兜底：不是 JSON 就按原样当文字转
    if (json !== undefined) {
      if (json && typeof json === 'object' && !Array.isArray(json)) delete json.token;
      shape?.(json, ctx);
      text = JSON.stringify(json);
    } else if (TEXTISH.test(type)) text = res.buf.toString('utf8');
    if (text != null ? text.includes(this.token) : res.buf.includes(this.token)) return { reply: jsonReply(500, { error: '电脑上的回答出了问题，没有发给手机' }), json: undefined, status: 500 };
    if (text != null) out.body = text; else out.b64 = res.buf.toString('base64url');
    return { reply: { ok: true, data: out }, json, status: res.status };
  }
  async forward(method, pathQ, { body = undefined, headers = {}, shape = null, ctx = {}, alive = () => true } = {}) {
    if (!alive()) return null; // 这部手机刚被解除配对：不再替它做任何事
    let res;
    try { res = await this.local(method, pathQ, { body: body === undefined ? null : JSON.stringify(body), headers }); }
    catch (e) { const big = e.code === 'too_big'; return { reply: jsonReply(big ? 413 : 502, { error: big ? '内容太大，手机上打不开' : '电脑上的 OfferCrew 没有回答' }), status: big ? 413 : 502 }; }
    return this.toHttp(res, { shape, ctx });
  }

  // ── http：页面的一个 fetch ──
  async http(dev, a, alive, row) {
    const method = String(a.method || 'GET').toUpperCase(), raw = String(a.path || '');
    let u = null;
    try { u = new URL(raw, 'http://phone.invalid'); } catch {} // 兜底：地址解析不了就是 null，下一行按「地址不对」拒掉
    if (!u || u.origin !== 'http://phone.invalid' || !raw.startsWith('/') || raw.startsWith('//')) { row.status = 400; return jsonReply(400, { error: '地址不对' }); }
    Object.assign(row, { method, path: u.pathname });
    const done = (r, label) => { if (r) row.status = r.status; if (method === 'POST' && r && label !== false) event('user', 'phone', r.status < 400 ? 'ok' : 'fail', `手机「${dev.name}」：${labelOf(u.pathname, body)} · ${r.status}`); return r ? r.reply : null; };
    const refuse = (status, j) => done({ reply: jsonReply(status, j), status });
    let body;
    if (method === 'POST') {
      if (a.body != null && typeof a.body !== 'string') return refuse(400, { error: '请求格式不对' });
      if ((a.body || '').length > 64000) return refuse(413, { error: '内容过长' });
      try { body = a.body ? JSON.parse(a.body) : {}; } catch { return refuse(400, { error: '请求格式不对' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, { error: '请求格式不对' });
    } else if (method !== 'GET') return refuse(405, { error: NOT_ON_PHONE, on_mac: true });
    const route = matchRoute(method, u.pathname), pathQ = u.pathname + u.search;
    const rule = !route ? 'refuse' : route.when ? route.when({ query: u.searchParams, body, dev }) : route.rule;
    if (rule === 'refuse') return refuse(403, { error: NOT_ON_PHONE, on_mac: true });
    if (rule === 'hand_off' && dev.hand_off !== true) return refuse(403, { error: HAND_OFF_OFF, hand_off: false });
    if (rule === 'outward') {
      const r = await this.outward(dev, route.kind, u, body, obj(a.headers), alive);
      // 这部手机在这段对话里说过话：之后这段对话有新回复、交代的事做完了，给它发提醒（lib/phone/push.mjs）。
      if (u.pathname === '/api/talk' && r?.status === 200 && typeof r.json?.session?.id === 'string') { try { this.onTalk?.(dev.id, r.json.session.id); } catch (e) { noteSwallowed('phone.onTalk', e, { doing: '记下这部手机在这段对话里说过话', then: '这段对话有新回复时可能不给它发提醒' }); } }
      return done(r);
    }
    // 没被允许交办的手机来看（GET）：工作台看到的是 limited（手机「等你」里据此不给那几类的「其他：说怎么改」，lib/hq.mjs phoneInbox）。
    return done(await this.forward(method, pathQ, { body, headers: dev.hand_off !== true && (method === 'GET' || CARRY_LIMIT.test(pathQ)) ? { 'x-radar-phone': 'limited', 'x-radar-phone-device': String(dev.id || '') } : {}, shape: route.shape, ctx: { body }, alive }));
  }

  // ── 往外生效的事 ──
  // 1. 普通请求（不带 confirm、不是「页面自己弹确认」的选项）照常交给工作台；工作台回了预览（needs_confirm），
  //    就记下「这部手机 + 页面带着 confirm 会再发的那个请求 + 这一版预览（+ 信的版本）」。
  // 2. 带 confirm 再来：找到记下的那一条（用掉），让工作台不带 confirm 重新算一次预览，逐字一样、信的版本没变，才带着 confirm 放行。
  // 3. 没记过的（页面自己弹确认的选项、批量、直接带 confirm 来的）：回 428 和一张确认卡 { token, title, lines }，
  //    手机带着 x-phone-confirm: <token> 再发同一个请求；核对同一部手机、同样的内容、那一版没变，才放行。
  async outward(dev, kind, u, body, hdrs, alive) {
    const p = u.pathname, pathQ = p + u.search, now = this.now();
    const limited = dev.hand_off !== true, refuse = (status, j) => ({ reply: jsonReply(status, j), status });
    // 认不出这句话是不是指令：不放行（没被允许交办的手机不能借着认错下指令），记一笔。
    if (limited && kind === 'talk') { let c = null; try { c = this.deps.classifyTalk?.(String(body.text || '')); } catch (e) { noteSwallowed('phone.classifyTalk', e, { doing: '认手机发来的这句话是不是指令', then: '没有交出去' }); return refuse(500, { error: '电脑上认这句话时出了问题，没有交出去，稍后再试' }); } if (c?.kind === 'command') return refuse(403, { error: COMMAND_OFF, blocked: true }); }
    // 没被允许交办的手机：对话、回信、卡上的答都带上 limited（工作台据此把目标停下来问的那一问答了以后放行的下一棒停在电脑确认，lib/tasks.mjs answerGoal）。
    const headers = limited ? { 'x-radar-phone': 'limited', 'x-radar-phone-device': String(dev.id || '') } : {};
    const pass = b => this.forward('POST', pathQ, { body: b, headers, alive });
    // 这个请求动到的信（收件箱、任务卡）。查不到就不交给工作台：它晚一点可能查到一封要确认的信，那样就绕过了确认。
    let asks = null;
    if (kind === 'inbox' || kind === 'task') {
      let ids;
      if (kind === 'task') {
        let t = null; try { t = await this.deps.taskAsk?.(decodeURIComponent(p.split('/')[3])); } catch {} // 兜底：查不到就当这张卡不用答，下面拒掉，不放行
        if (t && typeof t === 'object' && t.goal) return pass(body); // 目标卡停下来问的「还投 / 不投了」：不往外发
        if (typeof t !== 'string' || !t) return refuse(409, { error: '这张卡现在不用你答，刷新看看' });
        ids = [t];
      } else ids = Array.isArray(body.ids) ? body.ids.slice(0, 50).map(String) : [String(body.id || '')];
      const key = String(body.option ?? '');
      asks = ids.map(id => { let ask = null; try { ask = this.deps.askById?.(id) || null; } catch {} return { id, ask, opt: !ask ? null : key === 'other' ? ask.other || null : (ask.options || []).find(o => String(o.key) === key) || null }; }); // 兜底：查不到这封信就是 null，下一行拒掉，不放行
      if (!asks.length || asks.some(x => !x.ask)) return refuse(409, { error: '这一项已经处理过或刚刚变了，请刷新' });
      // 等你批准的草稿、投递、跟进上的「其他」（改写、另说一件事）是交给执行器的新活：和对话里一样，要这部手机被允许交办。
      // 批准、不发、pass 这些拍板的选项不在此列，照常走下面的确认。
      if (key === 'other' && dev.hand_off !== true && asks.some(x => HAND_OFF_OTHER.test(x.id))) return refuse(403, { error: HAND_OFF_OFF, hand_off: false });
    }
    const inline = !!asks?.some(x => x.opt && inlineConfirm(x.opt)), confirming = body.confirm === true, batch = kind === 'inbox' && Array.isArray(body.ids);
    const header = typeof hdrs['x-phone-confirm'] === 'string' ? hdrs['x-phone-confirm'] : null;
    const canon = canonical(body), versions = () => Object.fromEntries((asks || []).map(x => { let a = null; try { a = this.deps.askById?.(x.id) || null; } catch {} return [x.id, a?.version ?? null]; })); // 兜底：查不到就是 null，版本对不上会按「刚刚变了」拒掉
    if (!inline && !confirming && !header) {
      const r = await pass(body);
      const j = r?.json;
      if (r && r.status === 200 && j?.needs_confirm) {
        const next = kind === 'talk' ? canonical({ ...body, text: j.confirm_text ?? body.text }) : canon;
        this.confirms.remember(dev.id, p, next, { hash: sha(stable({ preview: j.preview ?? null, confirm_text: j.confirm_text ?? null })), versions: versions() });
      }
      return r;
    }
    if (this.over(dev.id, 'outward')) return { reply: jsonReply(429, { error: '往外发的太频繁了，稍等一下再试' }), status: 429 };
    const mode = inline || batch ? 'ask' : 'rerun';
    const stale = why => ({ reply: jsonReply(409, { error: STALE, phone_confirm_error: why }), status: 409 });
    // 这一版要发出去的内容：ask = 按信（版本、选项、步骤、预览）；rerun = 让工作台不带 confirm 再算一次预览。
    const current = async () => {
      if (mode === 'ask') {
        const live = (asks || []).map(x => { let a = null; try { a = this.deps.askById?.(x.id) || null; } catch {} const key = String(body.option ?? ''); const o = !a ? null : key === 'other' ? a.other || null : (a.options || []).find(y => String(y.key) === key) || null; return { id: x.id, a, o }; }); // 兜底：查不到就是 null，下面按「已经处理过」拒掉
        if (!live.some(x => x.a)) return { none: true };
        const hash = sha(stable(live.map(x => ({ id: x.id, version: x.a?.version ?? null, option: String(body.option ?? ''), steps: x.o?.steps ?? null, preview: x.a?.preview ?? null }))));
        let view;
        if (live.length === 1 && live[0].a) {
          const pv = previewLines(live[0].a.preview), label = String(live[0].o?.label || '');
          view = { title: label ? (label.startsWith('确认') ? label : `确认${label}`) : pv.title, lines: [leadLine(live[0].a), ...pv.lines] };
        } else {
          const label = String(live.find(x => x.o)?.o?.label || '回信');
          view = { title: `确认${label}（${live.filter(x => x.a).length} 条）`, lines: live.filter(x => x.a).map(x => `${leadLine(x.a)}：${cut(x.o?.label || label, 30)}`) };
        }
        return { hash, view };
      }
      const r = await pass(JSON.parse(canon));
      if (!r) return { revoked: true };
      if (!(r.status === 200 && r.json?.needs_confirm)) return { response: r };
      return { hash: sha(stable({ preview: r.json.preview ?? null, confirm_text: r.json.confirm_text ?? null })), view: previewLines(r.json.preview) };
    };
    const same = (a, b) => stable(a || {}) === stable(b || {});
    // 3. 带着手机上的确认令牌来
    if (header) {
      const t = this.confirms.take(header);
      const why = !t ? 'unknown' : t.exp < now ? 'expired' : t.device !== dev.id ? 'device' : t.path !== p || t.canon !== canon || t.mode !== mode ? 'changed' : null;
      if (why) return stale(why);
      const c = await current();
      if (c.revoked) return null;
      if (c.response) return c.response;
      if (c.none || c.hash !== t.hash || !same(versions(), t.versions)) return stale('changed');
      return pass(body);
    }
    // 2. 带 confirm，之前记下过预览
    if (confirming && mode === 'rerun') {
      const t = this.confirms.consume(dev.id, p, canon);
      if (t) {
        const c = await current();
        if (c.revoked) return null;
        if (c.response) return c.response;
        if (c.hash !== t.hash || !same(versions(), t.versions)) return stale('changed');
        return pass({ ...JSON.parse(canon), confirm: true });
      }
    }
    // 3. 发一张确认卡
    const c = await current();
    if (c.revoked) return null;
    if (c.response) return c.response; // 不需要确认的事：刚才那一次就是它本身，做完了
    if (c.none) return refuse(409, { error: '这一项已经处理过或刚刚变了，请刷新' });
    const token = this.confirms.issue({ device: dev.id, path: p, canon, mode, hash: c.hash, versions: versions() });
    return { reply: jsonReply(428, { error: '要先在手机上确认', phone_confirm: { token, title: c.view.title, lines: c.view.lines.filter(Boolean).slice(0, 24).map(x => cut(x, 200)) } }), status: 428 };
  }

  // ── 页面代码包：手机 App 的文件（web/phone/ 和它用的成员的脸，从本机取，和工作台发的一模一样）──
  async bundle() {
    const c = this.bundleCache;
    if (c && this.now() - c.at < this.bundleMs) return c;
    const files = {};
    for (const p of this.webRoutes) {
      const res = await this.local('GET', p);
      if (res.status !== 200) continue;
      const type = String(res.headers['content-type'] || 'application/octet-stream');
      if (res.buf.includes(this.token)) throw Error('页面代码里有不该有的东西，没有发给手机');
      if (TEXTISH.test(type)) {
        files[p] = { type, body: res.buf.toString('utf8') };
      } else files[p] = { type, b64: res.buf.toString('base64url') };
    }
    const version = sha(Object.keys(files).sort().map(p => `${p}\0${files[p].body ?? files[p].b64}`).join('\n')).slice(0, 12);
    this.bundleCache = { at: this.now(), version, files };
    return this.bundleCache;
  }
}
