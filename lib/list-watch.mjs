// 只读列表来源（10-01 负责人：「Watcher 盯私信……脉脉照 BOSS 的做法只读看列表」）：BOSS 直聘的聊天列表（lib/boss-inbox.mjs）
// 和脉脉的消息列表（lib/maimai-inbox.mjs）共用这一套。每家只填一份说明（src）：地址、状态文件、开关、选择器、多久看一次。
//
// 做法（两家一样）：
// - 在 ego 浏览器里打开列表页，读每个对话的「谁、最后一句、未读数、最后一句是不是你自己的」，关掉任务空间。
//   **从不点开对话**（点开就把消息标成已读），不点任何按钮、不输入、不发送。脚本里只有 goto、waitForTimeout、evaluate、finish。
// - 第一次看的那一眼是底（baseline）：之后新出现的才算新消息，已读没回的旧对话不翻出来。
// - 对得上线索的登记成一条来信（state/inbox-events.ndjson，category 回复），线索记为已回复（lib/inbox.mjs recordReply），
//   信上的主按钮打开这家的消息页，你自己去回；对不上的合成一封信。同一句话不会提第二次。
// - 默认关（config/pipeline.json 里各家一个开关），09:00–21:00 按各家的间隔看，两家错开（BOSS 整点后 5 分钟，脉脉后 35 分钟，
//   由 bin/serve.mjs 传 minute 进来；手动跑不看分钟）。沙盒、Watcher 暂停、没登录都不看。
// - src.reportBlocks：碰到验证码或登录墙就停，在收件箱报一封信，不绕；你处理好了点「我处理好了」再接着看。
import fs from 'node:fs';
import { hash, read, write, lines, writeLines, file, today } from './store.mjs';
import { recordReply } from './inbox.mjs';
import { sandboxed } from './sandbox.mjs';
import { agentPaused } from './agents.mjs';
import { loadAccounts, sessionForKey } from './accounts.mjs';
import { localHour, TZ } from './tz.mjs';
import { event } from './events.mjs';
import { BRAND } from './brand.mjs';
import { stageText } from './lead-state.mjs';

export const DEFAULT_HOURS = [9, 21]; // 与 lib/app-schedule.mjs MAIL_POLL_HOURS 相同（测试核对）
export const HOUR_MS = 3600000;
const MINUTE_FMT = new Map();
export const localMinute = (now = Date.now(), tz = TZ) => {
  if (!MINUTE_FMT.has(tz)) MINUTE_FMT.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }));
  return Number(MINUTE_FMT.get(tz).format(now));
};

// ── 解析：列表上的一项 → 字段（纯函数，也会原样注入页面里跑，所以不能引用外面的任何东西） ──────────────
// raw = { text: 这一项的 innerText, badge: 未读角标的文字, names: 名字那一行里各个 span 的文字（可能没有） }
export function parseChatItem(raw) {
  const clean = s => String(s == null ? '' : s).replace(/[\u200b\u00a0]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const r = raw || {};
  const badge = clean(r.badge);
  const unread = /^\d+$/.test(badge) ? Number(badge) : /^\d+\+$/.test(badge) ? Number(badge.slice(0, -1)) : badge ? 1 : 0;
  const lines = String(r.text || '').split(/\n+/).map(clean).filter(Boolean);
  if (badge) { const i = lines.indexOf(badge); if (i >= 0) lines.splice(i, 1); }
  const TIME = '(?:\\d{1,2}:\\d{2}|昨天(?: ?\\d{1,2}:\\d{2})?|前天|星期[一二三四五六日天]|周[一二三四五六日天]|\\d{1,2}月\\d{1,2}日|\\d{1,2}[-/]\\d{1,2}|\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}|刚刚|\\d+ ?分钟前)';
  let time = '';
  const ti = lines.findIndex(l => new RegExp(`^${TIME}$`).test(l));
  if (ti >= 0) time = lines.splice(ti, 1)[0];
  const names = (Array.isArray(r.names) ? r.names : []).map(clean).filter(Boolean);
  if (names.length) { const joined = names.join(' '), glued = names.join(''); for (let i = lines.length - 1; i >= 0; i--) if (names.includes(lines[i]) || lines[i] === joined || lines[i] === glued) lines.splice(i, 1); }
  const MARK = /^\[(送达|已读)\]\s*/;
  let fromMe = false, preview = '';
  const mi = lines.findIndex(l => MARK.test(l));
  if (mi >= 0) {
    fromMe = true;
    const rest = lines[mi].replace(MARK, '');
    lines.splice(mi, 1);
    preview = rest || (mi < lines.length ? lines.splice(mi, 1)[0] : '');
  } else if (lines.length >= (names.length ? 1 : 2)) preview = lines.pop();
  let shown = names.length ? names.join(' ') : lines.join(' ');
  if (!time) { const m = shown.match(new RegExp(`\\s${TIME}$`)); if (m) { time = m[0].trim(); shown = shown.slice(0, -m[0].length).trim(); } }
  if (!shown) return null;
  let name = names[0] || '';
  if (!name) { const m = shown.match(/^\S{1,8}?(?:先生|女士|老师|同学|经理|总)/); name = m ? m[0] : shown.split(/[\s·|｜]+/)[0]; }
  const org = shown.slice(shown.indexOf(name) + name.length).replace(/^[\s·|｜]+/, '').trim();
  return { name: name.slice(0, 40), org: org.slice(0, 80), shown: shown.slice(0, 120), preview: preview.slice(0, 200), time: time.slice(0, 20), unread, from_me: fromMe };
}

// 一个对话的稳定 key：名字那一行去掉空白和分隔符（「王女士 Northwind招聘者」和「王女士Northwind招聘者」是同一个）。
export const conversationKey = (id, c) => hash([id, String(c?.shown || '').normalize('NFKC').toLowerCase().replace(/[\s·|｜/,，]+/g, '')]).slice(0, 16);

// ── 读：页面里跑的收集函数 ───────────────────────────────────────────────────────────────────
// sel = { lists: 列表项的候选选择器（按顺序试）, badge: 未读角标, nameBox: 名字行, fallback: 'li'（有头像、两行以上的 li）
// 或 'repeat'（同一个父元素下、样子相同、带时间的一排兄弟元素） }。只带回 parseChatItem 的字段，不带页面内容。
// spec（运行时）= { outUrl, outText: 登录页, blockUrl, blockText: 验证码 / 安全验证, limit }。
export function makeCollect(sel) {
  const repeat = sel.fallback === 'repeat' ? `
  if (!lis.length) {
    const TIME = /^(?:\\d{1,2}:\\d{2}|昨天(?: ?\\d{1,2}:\\d{2})?|前天|星期[一二三四五六日天]|周[一二三四五六日天]|\\d{1,2}月\\d{1,2}日|\\d{1,2}[-/]\\d{1,2}|\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}|刚刚|\\d+ ?分钟前)$/;
    const sig = e => e.tagName + '.' + String(typeof e.className === 'string' ? e.className : '').trim();
    const score = new Map();
    for (const t of Array.from(document.querySelectorAll('body *')).filter(e => !e.children.length && TIME.test(String(e.textContent || '').trim()))) {
      let n = t;
      for (let d = 0; d < 8 && n && n.parentElement; d++) {
        const p = n.parentElement;
        if (Array.from(p.children).filter(c => sig(c) === sig(n)).length >= 2) { score.set(n, p); break; }
        n = p;
      }
    }
    const parents = new Map();
    for (const [n, p] of score) parents.set(p, (parents.get(p) || new Set()).add(sig(n)));
    const best = Array.from(parents.entries()).sort((a, b) => b[1].size - a[1].size)[0];
    if (best) lis = Array.from(best[0].children).filter(c => String(c.innerText || '').split('\\n').filter(Boolean).length >= 2);
  }` : `
  if (!lis.length) lis = Array.from(document.querySelectorAll('li')).filter(li => li.querySelector('img') && String(li.innerText || '').split('\\n').filter(Boolean).length >= 2);`;
  const block = sel.block ? `
  if (spec.blockUrl && new RegExp(spec.blockUrl).test(path)) return { logged_out: false, blocked: 'captcha', items: [] };
  if (!lis.length && spec.blockText && new RegExp(spec.blockText).test(head)) return { logged_out: false, blocked: 'captcha', items: [] };` : '';
  return `(spec) => {
  const parse = ${parseChatItem.toString()};
  const path = location.pathname || '';
  const head = (document.body && document.body.innerText || '').slice(0, 1500);
  if (spec.outUrl && path.includes(spec.outUrl)) return { logged_out: true, items: [] };
  const lists = ${JSON.stringify(sel.lists)};
  let lis = [];
  for (const s of lists) { lis = Array.from(document.querySelectorAll(s)); if (lis.length) break; }${repeat}${block}
  if (!lis.length && spec.outText && new RegExp(spec.outText).test(head)) return { logged_out: true, items: [] };
  const items = [];
  for (const li of lis.slice(0, spec.limit)) {
    const badge = li.querySelector(${JSON.stringify(sel.badge)});
    const box = li.querySelector(${JSON.stringify(sel.nameBox)});
    const names = box ? Array.from(box.children).map(e => e.innerText) : [];
    const it = parse({ text: String(li.innerText || '').slice(0, 600), badge: badge ? ${sel.dotBadge ? `(String(badge.innerText || '').trim() || '•')` : 'badge.innerText'} : '', names });
    if (it) items.push(it);
  }
  return { logged_out: false, items };
}`;
}

export function chatListScript(src, { brand = 'OfferCrew', probe = {}, limit = 40 } = {}) {
  const spec = { outUrl: probe.logged_out_url || null, outText: probe.logged_out_text || null, limit, ...(src.block ? { blockUrl: src.block.url || null, blockText: src.block.text || null } : {}) };
  return `const task = await taskSpace(${JSON.stringify(`${brand} · ${src.taskName}`)});
const page = task.page("p1");
let navError = null;
await page.goto(${JSON.stringify(src.url)}, { timeout: 40000 }).catch(e => { navError = String(e && e.message || e).slice(0, 120); });
await page.waitForTimeout(${src.waitMs || 5000});
let out = null;
try { out = await page.evaluate("(" + ${JSON.stringify(src.collect)} + ")(" + ${JSON.stringify(JSON.stringify(spec))} + ")"); } catch (e) { out = { error: String(e && e.message || e).slice(0, 120) }; }
await task.finish({ keep: [] }).catch(() => {}); // 兜底：收尾关不掉不影响已经读到的内容
radarResult({ ...(out || {}), navError });`;
}

export async function readChatList(src, { run, brand, probe, limit } = {}) {
  const r = await run(chatListScript(src, { brand, probe, limit }), { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  const items = Array.isArray(r?.items) ? r.items.map(i => i && typeof i === 'object' ? {
    name: String(i.name || ''), org: String(i.org || ''), shown: String(i.shown || ''), preview: String(i.preview || ''), time: String(i.time || ''),
    unread: Math.max(0, Number(i.unread) || 0), from_me: i.from_me === true,
  } : null).filter(i => i?.shown) : [];
  const out = { logged_out: r?.logged_out === true, error: r?.error || null, navError: r?.navError || null, items: items.map(i => ({ ...i, key: conversationKey(src.id, i) })) };
  if (src.block && r?.blocked) out.blocked = String(r.blocked).slice(0, 20);
  return out;
}

// ── 对上线索 ───────────────────────────────────────────────────────────────────────────────────
export const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s·|｜]+/g, '');
// 公司名的几种写法：全称、括号前、括号里逗号分开的每一段（「某某科技（Brand，全称）」）。两个字以上才算。
export function companyTokens(company) {
  const c = String(company || '').normalize('NFKC');
  const parts = [c, c.replace(/[（(].*$/, ''), ...(c.match(/[（(]([^）)]*)[）)]/)?.[1] || '').split(/[,，、/]/)];
  return [...new Set(parts.map(norm).filter(t => t.length >= 2))];
}
export const liveLead = l => !l.superseded && !l.merged_into && l.status !== 'superseded';
// 这条线索是不是这家平台上的：链接在这家的域名上，或者来源写着这家。
const onPlatform = (src, l) => [l.url, l.contact_url, l.application_url, l.apply_url, l.source_url].some(u => src.host.test(String(u || ''))) || src.sourceName.test(String(l.source || ''));
const sentHere = (src, o) => src.host.test(String(o.to || '')) || src.sourceName.test(String(o.platform || ''));
export function linkConversation(src, conv, { leads = [], outbound = [] } = {}) {
  const head = norm(`${conv.shown} ${conv.org}`), who = norm(conv.name);
  const live = leads.filter(l => liveLead(l) && onPlatform(src, l));
  const byCompany = live.filter(l => companyTokens(l.company).some(t => head.includes(t)));
  if (!byCompany.length) return null;
  const byPerson = byCompany.filter(l => l.author && who && norm(l.author) === who);
  const pool = byPerson.length ? byPerson : byCompany;
  if (pool.length === 1) return pool[0];
  const id = l => l.record_id || l.id;
  const contacted = pool.filter(l => outbound.some(o => o.record_id === id(l) && sentHere(src, o)));
  return contacted.length === 1 ? contacted[0] : null;
}

// ── 这一眼里哪些是新的 ─────────────────────────────────────────────────────────────────────────
// 新消息 = 最后一句是对方的，并且和上次看到的不一样：换了一句话、上次最后一句是你的、或者未读数涨了。
// 第一次见到的对话只认有未读的（已读没回的旧对话不翻出来）。
export function isNew(conv, seen) {
  if (conv.from_me) return false;
  if (!seen) return conv.unread > 0;
  return conv.preview !== seen.preview || seen.from_me === true || conv.unread > (seen.unread || 0);
}
// 列表上分不出最后一句是不是你的（src.unreadOnly）：只认未读。你回过之后最后一句变了、但没有未读，不算对方来信。
export function isNewUnread(conv, seen) {
  if (conv.from_me || !(conv.unread > 0)) return false;
  if (!seen) return true;
  return conv.preview !== seen.preview || conv.unread > (seen.unread || 0) || !(seen.unread > 0);
}

// 第一次看（还没有底）一个都不算「对方主动找你」：那一眼就是底。
export const hasBaseline = (state = {}) => !!state.baseline_at || Object.keys(state.conversations || {}).length > 0;
// 对不上线索时，这个对话在「对方主动找你」这条路上的哪一段：这几段都不进合并的那封信（各有各的去处，lib/boss-inbound.mjs）。
const INBOUND_HELD = new Set(['unread', 'to_read', 'judging', 'ignored']);

// 看完一眼之后要做的事（纯函数）：raise 要登记的来信，answered 你已经回过的线索，unlinked 对不上线索、还没回的，state 新状态。
// inbound：新对话 key → 「对方主动找你」的结论（调用方事先算好；没有就当普通对话）。
export function planInbox(src, { items = [], state = {}, leads = [], outbound = [], now = Date.now(), inbound = {} } = {}) {
  // src.baselineOnly：第一次看的那一眼只记底，一条都不提（打开开关时平台上早就挂着的未读，不一下子全翻出来）。
  const fresh = src.baselineOnly && !hasBaseline(state) ? () => false : src.unreadOnly ? isNewUnread : isNew;
  const at = new Date(now).toISOString();
  const prev = state.conversations || {}, conversations = { ...prev };
  const raise = [], answered = [];
  let unlinked = (state.unlinked || []).slice();
  const byId = new Map(leads.map(l => [l.record_id || l.id, l]));
  for (const c of items) {
    const seen = prev[c.key];
    // 招聘方主动找你、已经进了池的：认那条线索，公司名写法和列表上不一样也认。
    const lead = linkConversation(src, c, { leads, outbound }) || (seen?.inbound?.status === 'lead' && byId.get(seen.inbound.record_id)) || null;
    const record_id = lead ? lead.record_id || lead.id : null;
    const entry = { shown: c.shown, preview: c.preview, time: c.time, unread: c.unread, from_me: c.from_me, record_id, seen_at: at, raised_at: seen?.raised_at || null, ...(seen?.inbound ? { inbound: seen.inbound } : {}) };
    if (!lead && !seen && inbound[c.key]) entry.inbound = { ...inbound[c.key], since: at };
    const ib = !lead && entry.inbound;
    if (ib && INBOUND_HELD.has(ib.status)) {
      // 还没读的：你读过了（角标没了，或者你已经回了）→ 下一步只读地看一眼。
      if (ib.status === 'unread' && (c.unread === 0 || c.from_me)) entry.inbound = { ...ib, status: 'to_read', read_seen_at: at };
      if (fresh(c, seen)) entry.raised_at = at;
      unlinked = unlinked.filter(u => u.key !== c.key);
      conversations[c.key] = entry;
      continue;
    }
    if (fresh(c, seen)) {
      entry.raised_at = at;
      if (lead) raise.push({ conv: c, record_id });
      else unlinked = [...unlinked.filter(u => u.key !== c.key), { key: c.key, shown: c.shown, preview: c.preview, time: c.time, at }];
    } else if (c.from_me) {
      unlinked = unlinked.filter(u => u.key !== c.key);
      const l = byId.get(record_id);
      if (l && l.reply_url === src.url && l.replied_at && !(Date.parse(l.reply_answered_at || '') > Date.parse(l.replied_at))) answered.push(record_id);
    }
    conversations[c.key] = entry;
  }
  return { raise, answered, unlinked: unlinked.slice(-30), state: { ...state, conversations, unlinked: unlinked.slice(-30), checked_at: at, status: 'ok', logged_out_at: null, ...(src.block ? { blocked: null } : {}), baseline_at: state.baseline_at || at } };
}

// 把 planInbox 的结果写进线索和来信（调用方持锁、负责落盘）。返回登记的条数。
export function applyPlan(src, plan, { leads = [], events = [], now = Date.now(), evidence = null } = {}) {
  const at = new Date(now).toISOString();
  const byId = new Map(leads.map(l => [l.record_id || l.id, l]));
  const base = {};
  let raised = 0;
  for (const { conv, record_id } of plan.raise) {
    const lead = byId.get(record_id);
    if (!lead) continue;
    const summary = `${conv.shown}：${conv.preview || '（新消息）'}`.slice(0, 240);
    events.push({ message_id: `${src.id}:${conv.key}:${at}`, record_id, number: lead.number ?? null, at, category: '回复', summary, from: conv.shown, subject: `${src.label} · ${conv.shown}`, source: src.eventSource, channel: 'platform_dm', ...(evidence ? { evidence } : {}) });
    if (recordReply(lead, { category: '回复', summary, at, source: src.eventSource })) {
      Object.assign(lead, { reply_channel: 'platform_dm', reply_url: src.url, ...(evidence ? { reply_evidence: evidence } : {}) });
      if (lead.record_id) base[lead.record_id] = { 阶段: [stageText(lead)], 回复摘要: summary };
      raised++;
    }
  }
  for (const id of plan.answered) { const l = byId.get(id); if (l) l.reply_answered_at = at; }
  return { raised, answered: plan.answered.length, base };
}

// ── 什么时候看 ─────────────────────────────────────────────────────────────────────────────────
// 返回 null = 该看了；否则是不看的原因（给日志用）。minute：常驻服务传进来，各家在整点后自己的那几分钟看（两家错开）；
// 手动跑、测试不传，不看分钟。
export function listGate(src, { now = Date.now(), enabled = false, sandbox = false, paused = false, session = null, state = {}, hour, minute, hours = DEFAULT_HOURS } = {}) {
  if (sandbox) return 'sandbox';
  if (!enabled) return 'off';
  if (src.verified === false) return 'unverified';
  if (paused) return 'paused';
  if (!(hour >= hours[0] && hour < hours[1])) return 'outside_hours';
  if (session?.logged_in !== true) return 'not_logged_in';
  // 上次看见的是登录页：等登录记录更新（你点「我登好了」或自动检测看到）再看。
  if (state.logged_out_at && !(Date.parse(session.verified_at || '') > Date.parse(state.logged_out_at))) return 'logged_out';
  // 上次碰到验证码：停着，等你在收件箱点「我处理好了」。
  if (src.block && state.blocked) return 'blocked';
  const every = src.everyHours || 1;
  if (Number.isFinite(minute) && (minute < (src.slotMinute || 0) || (hour - hours[0]) % every !== 0)) return 'not_due';
  if (Date.parse(state.checked_at || '') > now - every * HOUR_MS + 5 * 60000) return 'not_due';
  return null;
}

// ── 对不上线索的：一封信 ───────────────────────────────────────────────────────────────────────
export const unlinkedSig = list => hash(list.map(u => [u.key, u.preview])).slice(0, 16);
export function listAsks(src, { state = read(src.statePath, {}) || {} } = {}) {
  const list = (state.unlinked || []).filter(u => u?.key);
  if (!list.length) return [];
  const sig = unlinkedSig(list);
  return [{
    from: 'watch', id: `${src.askPrefix}:${sig}`, type: 'info', title: `${src.label} · 新消息`,
    question: `${list.length} 个对话对不上岗位`,
    context: [],
    affected: list.slice(-12).map(u => ({ id: u.key, label: `${u.shown} · ${u.preview || '（新消息）'}`.slice(0, 100) })),
    options: [
      { key: '1', label: src.openLabel, steps: [{ type: 'open', url: src.url }], primary: true },
      { key: '2', label: '知道了', steps: [{ type: src.stepType, action: 'ack', sig }] },
    ],
    other: null,
  }];
}
// 「知道了」：收起这封信（列表清空；之后再来的新消息另起一封）。信的内容变了（期间又来了一条）就不收。
export function ackList(src, sig) {
  const state = read(src.statePath, {}) || {};
  const list = (state.unlinked || []).filter(u => u?.key);
  if (list.length && unlinkedSig(list) !== String(sig)) throw Error('这期间又来了新消息，看一眼再收起');
  write(src.statePath, { ...state, unlinked: [] });
  return '收起了';
}

// 碰到验证码或登录墙（src.block）：停下，一封信。你处理好了点「我处理好了」，下一轮接着看。
export function blockedAsks(src, { state = read(src.statePath, {}) || {} } = {}) {
  if (!src.block) return [];
  const why = state.blocked?.kind === 'captcha' ? 'captcha' : state.logged_out_at ? 'login' : null;
  if (!why) return [];
  const since = state.blocked?.at || state.logged_out_at;
  return [{
    from: 'watch', id: `${src.askPrefix}-blocked:${hash([why, since]).slice(0, 12)}`, type: 'info', title: `${src.label} · 看消息停了`,
    question: why === 'captcha' ? '页面要验证，停下了' : '页面要登录，停下了',
    context: [],
    options: [
      { key: '1', label: `打开${src.label}`, steps: [{ type: 'open', url: why === 'login' && src.loginUrl ? src.loginUrl : src.url }], primary: true },
      { key: '2', label: '我处理好了', steps: [{ type: src.stepType, action: 'resume' }] },
    ],
    other: null,
  }];
}
export function resumeList(src) {
  const state = read(src.statePath, {}) || {};
  write(src.statePath, { ...state, blocked: null, logged_out_at: null });
  return '好，下一轮接着看';
}

// ── 跑一次：闸 → 读列表 → 持锁登记 ─────────────────────────────────────────────────────────────
// force = 操作台手动点的：不管到没到点、在不在时段，其余的闸照旧。
// src.inbound（可选）= { candidate, classify, confirm, max }：「对方主动找你」这一段（BOSS 有，lib/boss-inbound.mjs；脉脉留着口子）。
export const listEnabled = (src, pipeline = read('config/pipeline.json', {}) || {}) => pipeline[src.pipelineKey] === true;
export async function runList(src, { run, now = Date.now(), force = false, hours = DEFAULT_HOURS, minute, cfg = loadAccounts(), judgeFn = null, facts = undefined } = {}) {
  const state = read(src.statePath, {}) || {};
  const session = sessionForKey(src.family, read('config/portal-sessions.json', { domains: {} }) || { domains: {} }, cfg);
  const skip = listGate(src, { now, enabled: listEnabled(src), sandbox: sandboxed(), paused: agentPaused('owl'), session, state: force ? { ...state, checked_at: null } : state, hour: force ? hours[0] : localHour(now), minute: force ? undefined : minute, hours });
  if (skip) return { status: 'skipped', reason: skip };
  if (!run) ({ runBrowserScript: run } = await import('./browser-run.mjs'));
  const probe = cfg.families?.[src.family]?.probe || {};
  const seen = await readChatList(src, { run, brand: BRAND, probe });
  const at = new Date(now).toISOString();
  let result = null, toRead = [];
  {
    const cur = read(src.statePath, {}) || {};
    if (seen.blocked) {
      write(src.statePath, { ...cur, checked_at: at, status: 'blocked', reason: seen.blocked, blocked: { kind: seen.blocked, at } });
      event('owl', src.eventSource, 'skip', `${src.listName}：页面要验证，停下了，等你处理`);
      return { status: 'blocked', reason: seen.blocked };
    }
    if (seen.logged_out || seen.error || (seen.navError && !seen.items.length)) {
      write(src.statePath, { ...cur, checked_at: at, status: seen.logged_out ? 'logged_out' : 'failed', reason: seen.error || seen.navError || null, logged_out_at: seen.logged_out ? at : cur.logged_out_at || null });
      event('owl', src.eventSource, seen.logged_out ? 'skip' : 'fail', seen.logged_out ? `${src.listName}：没登录，等你登录后再看` : `${src.listName}没读成：${String(seen.error || seen.navError).slice(0, 80)}`);
      return { status: seen.logged_out ? 'logged_out' : 'failed', reason: seen.error || seen.navError || null };
    }
    const leads = lines('state/leads.ndjson'), outbound = lines('state/outbound.ndjson'), events = lines('state/inbox-events.ndjson');
    // 招聘方主动找你、还没读的：只看列表上的字粗筛，不点开。
    const inbound = {};
    if (src.inbound) for (const c of seen.items.filter(c => src.inbound.candidate(c, { state: cur, leads, outbound }))) {
      const v = await src.inbound.classify(c, { leads, outbound });
      if (v) inbound[c.key] = v;
    }
    const plan = planInbox(src, { items: seen.items, state: cur, leads, outbound, now, inbound });
    let evidence = null;
    if (plan.raise.length) {
      evidence = `runs/${today()}/${src.evidenceDir}/${at.replace(/[:.]/g, '-')}.json`;
      fs.mkdirSync(file(`runs/${today()}/${src.evidenceDir}`), { recursive: true });
      fs.writeFileSync(file(evidence), JSON.stringify({ at, url: src.url, items: seen.items }, null, 2));
    }
    const done = applyPlan(src, plan, { leads, events, now, evidence });
    if (done.raised || done.answered) writeLines('state/leads.ndjson', leads);
    if (done.raised) writeLines('state/inbox-events.ndjson', events);
    if (Object.keys(done.base).length) write('state/inbox-base-pending.json', { ...(read('state/inbox-base-pending.json', {}) || {}), ...done.base });
    write(src.statePath, plan.state);
    const fresh = plan.unlinked.filter(u => u.at === at).length;
    const asked = Object.values(inbound).filter(v => v.status === 'unread').length, screened = Object.values(inbound).filter(v => v.status === 'ignored').length;
    event('owl', src.eventSource, 'ok', `${src.listName}：${seen.items.length} 个对话，新消息 ${done.raised + fresh + asked + screened} 条${done.raised ? `（${done.raised} 条对上岗位）` : ''}${asked ? `，${asked} 个招聘方主动找你` : ''}${screened ? `，${screened} 个明显不合适没提` : ''}${done.answered ? `，你回过 ${done.answered} 条` : ''}`);
    result = { status: 'ok', conversations: seen.items.length, raised: done.raised, unlinked: plan.unlinked.length, answered: done.answered };
    if (asked || screened) result.inbound = { asked, screened };
    if (src.inbound) toRead = seen.items.filter(c => ['to_read', 'judging'].includes(plan.state.conversations[c.key]?.inbound?.status) && !c.unread).slice(0, src.inbound.max);
  }
  // 你读过的「对方主动找你」：只读地看一眼、交给 Judge（不持锁跑浏览器和判断）。
  for (const c of toRead) {
    const r = await src.inbound.confirm({ run, conv: c, now, probe, judgeFn, facts });
    (result.confirmed ||= []).push({ key: c.key, ...r });
    if (r.status === 'logged_out') break;
  }
  return result;
}
