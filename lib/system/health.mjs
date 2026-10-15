// System 当监工（L 线第 2 批 2a，design/desktop-app/方案-System监工-第2批.md 第一、二节）：一本健康账本。
// 每样「手」（文字模型按成员、对话模型、免费额度、招聘源、专用 Chrome、邮箱、各平台登录、定时周期和各步、任务、本机 AI）
// 看一眼现在好不好，再归到成员身上。全是规则：只读本机的文件和状态，不调模型、不联网、不改任何东西
// （动手的是 lib/system/playbook.mjs，2b）。指挥台已经算好的告警（lib/command-center.mjs alertsView）直接收进来，不另算一遍。
//
// 一条账：{ hand, member, state: 'ok' | 'warn' | 'down' | 'off', since, cause, evidence: [], auto, needs_you }
//   member  归到谁（lib/crew.mjs 的成员 id）；证据不够、说不清是谁的，写 'overall'（整体），cause 里写还缺什么
//   off     这只手没在用（没接邮箱、本机 AI 开关关着、演示模式不调模型），不算毛病
import { read, lines } from '../store.mjs';
import { CREW_IDS, crewName, memberOfEvent } from '../crew.mjs';
import { textReady, backendsFor } from '../model.mjs';
import { textConf } from '../text-conf.mjs';
import { loadProviders } from '../backends.mjs';
import { modelState } from '../chat.mjs';
import { freeQuotaView, freeBlocked } from '../free-model.mjs';
import { sourcesView } from '../sources.mjs';
import { findChrome, alive, CHROME_NAME } from '../browser-host.mjs';
import { mailView } from '../mail/status.mjs';
import { loginWatchState } from '../login-watch.mjs';
import { loadAccounts } from '../accounts.mjs';
import { stuckTasks } from '../executor-heartbeat.mjs';
import { localAiStatus } from '../local-ai-status.mjs';
import { recentActions, watchDown, WATCH_STATE } from './actions.mjs';
import { openBreakers } from './breaker.mjs';
import { modelErrorKind as errorKind } from '../say-error.mjs';
import { fallbacksOn } from '../fallback.mjs';
import { SWALLOW_STEP, noteSwallowed } from '../swallow.mjs';
import { tailEvents } from '../events.mjs';

export const MODEL_WINDOW_MS = 30 * 60000;
const CHROME_WINDOW_MS = 6 * 3600000;
const iso = t => new Date(t).toISOString();
const T = s => Date.parse(s || '') || 0;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const RANK = { down: 0, warn: 1, ok: 2, off: 3 };
const worst = rows => rows.reduce((w, r) => (RANK[r.state] < RANK[w] ? r.state : w), 'ok');

// ── 模型的错是哪一类 ─────────────────────────────────────────────────────────────
// 事件里的 error（lib/model.mjs infer 记的）→ 哪一类、给人看的一句：和对话里说人话的是同一张表（lib/say-error.mjs）。
// 沙盒拦下来的不算毛病（null）。
export function modelErrorKind(error) { const k = errorKind(error); return k.kind === 'sandbox' ? null : k; }

// 这位成员最近 30 分钟的模型调用：每个底座从最新往回数连续失败几次（中间成功一次就断）。
export function modelFailures(member, events, { now = Date.now(), windowMs = MODEL_WINDOW_MS } = {}) {
  const mine = events.filter(e => e.step === 'model' && (e.status === 'fail' || e.status === 'ok') && memberOfEvent(e) === member && now - T(e.ts) < windowMs)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const by = new Map();
  for (const e of mine) {
    const b = String(e.backend || e.model_usage?.driver || '默认底座');
    const g = by.get(b) || { backend: b, fails: 0, closed: false, last_error: null, last_at: null, since: null, kinds: new Set(), refs: [] };
    if (g.closed) continue;
    if (e.status === 'ok') { g.closed = true; by.set(b, g); continue; }
    const k = modelErrorKind(e.error || e.msg);
    if (!k) continue;
    g.fails++; g.kinds.add(k.kind); g.since = e.ts; g.last_at ||= e.ts; g.last_error ||= { ...k, raw: cut(e.error || e.msg, 160) };
    for (const r of e.refs || []) if (r.file && g.refs.length < 3) g.refs.push(r.file);
    by.set(b, g);
  }
  return [...by.values()].filter(g => g.fails).map(({ closed, kinds, ...g }) => ({ ...g, kinds: [...kinds] }));
}

function modelRow(member, { events, now, ready = textReady, backends = null }) {
  const name = crewName(member), hand = `model:${member}`;
  const r = ready({ role: member });
  if (r.why === 'sandbox') return { hand, member, state: 'off', since: null, cause: `${name}：${r.note}`, evidence: [], auto: null, needs_you: false };
  if (!r.ok) return { hand, member, state: 'down', since: null, cause: `${name} 没有能用的文字模型：${r.note}`, evidence: ['config/model.json'], auto: null, needs_you: '在「设置 → 模型」里配一个能用的文字模型' };
  const fails = modelFailures(member, events, { now });
  let list = backends;
  if (!list) { try { list = backendsFor(textConf(), loadProviders(), { role: member, purpose: 'text' }).map(b => b.id); } catch (e) { noteSwallowed('health.modelList', e, { member, doing: '读这位成员的文字模型清单', then: '账本这一行不写在用哪几个' }); list = []; } }
  // 熔断着的（标准做法 P1，lib/system/breaker.mjs，按底座算）：这位成员的清单里用到的那几个，每位都照实写 System 在做的那一句。
  let auto = null;
  try { const br = openBreakers({ now }).filter(b => list.includes(b.backend)); if (br.length) auto = `先跳过 ${br.map(b => b.label || b.backend).join('、')}，${new Date(Math.min(...br.map(b => Date.parse(b.until)))).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 再试`; } catch {} // 兜底：熔断账读不出来就不写「先跳过谁」，这一行照常
  if (!fails.length) return { hand, member, state: 'ok', since: null, cause: `${name} 的文字模型能用`, evidence: [], auto, needs_you: false };
  const f = fails.sort((a, b) => b.fails - a.fails)[0];
  const alone = list.length <= 1, key = f.kinds.includes('key');
  const state = (key && alone) || f.fails >= 3 && alone ? 'down' : 'warn';
  const times = f.fails > 1 ? `连续 ${f.fails} 次` : '刚才一次';
  return {
    hand, member, state, since: f.since, backend: f.backend, kind: f.last_error.kind,
    cause: `${name} 的模型 ${f.backend} ${times}没调通：${f.last_error.text}${alone ? '，清单里没有别的可换' : ''}`,
    evidence: [...f.refs, 'state/events.ndjson'], auto,
    needs_you: key ? `${f.backend} 的钥匙失效了：在「设置 → 模型」里换一把${alone ? '，或者再加一个模型' : ''}` : false,
  };
}

// ── 别的手 ─────────────────────────────────────────────────────────────────────
function chatRow({ now, state = modelState }) {
  const s = state({ now });
  if (s.ok) return { hand: 'chat', member: 'patch', state: 'ok', since: null, cause: '对话模型能用', evidence: [], auto: null, needs_you: false };
  if (s.why === 'sandbox') return { hand: 'chat', member: 'patch', state: 'off', since: null, cause: s.note, evidence: [], auto: null, needs_you: false };
  return { hand: 'chat', member: 'patch', state: s.why === 'failing' ? 'warn' : 'down', since: null, cause: `对话：${s.note}`, evidence: [], auto: null, needs_you: s.why === 'no_backend' ? '在「设置 → 模型」里配一个对话模型' : false };
}

function freeRow({ now }) {
  const v = freeQuotaView({ now });
  if (!v) return null;
  const b = freeBlocked({ now });
  if (!b) return { hand: 'free', member: 'patch', state: 'ok', since: null, cause: `OfferCrew 补给：${v.label}`, evidence: [], auto: null, needs_you: false };
  const until = b.until ? `，${new Date(b.until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 再试` : '';
  return { hand: 'free', member: 'patch', state: b.kind === 'bad_token' ? 'down' : 'warn', since: b.at || null, cause: `OfferCrew 补给被拒着：${cut(b.reason || b.kind, 80)}${until}`, evidence: [], auto: null, needs_you: b.kind === 'bad_token' ? '在「设置 → 模型」里重新领取 OfferCrew 补给' : false };
}

// 招聘源：只列不对的那几个（几百个源不逐个上账），外加一行总数。你暂停的不算毛病；System 停的照实写。
function sourceRows({ now, view = null }) {
  let v = view;
  if (!v) { try { v = sourcesView({ now }); } catch (e) { noteSwallowed('health.sources', e, { member: 'scout', doing: '读招聘源的状态', then: '账本里这次没有招聘源那几行' }); return []; } }
  const rows = [];
  for (const s of v.sources || []) {
    const bySystem = typeof s.paused === 'string' && /^System/.test(s.paused);
    if (!(s.bad || s.state === 'failing' || bySystem)) continue;
    rows.push({ hand: `source:${s.name}`, member: 'scout', state: 'warn', since: s.at || null, cause: `招聘源 ${s.name}：${s.text}`, evidence: ['state/discovery-sources.json'], auto: bySystem ? s.paused : null, needs_you: false });
  }
  const human = read('state/human-discovery-check.json', {}) || {};
  for (const s of (human.sources || []).filter(s => ['blocked', 'partial'].includes(s.status)))
    rows.push({ hand: `source:${s.source}`, member: 'scout', state: 'warn', since: human.at || null, cause: `真人帖来源 ${s.source} 被拦：${cut(s.error, 60) || s.status}`, evidence: ['state/human-discovery-check.json'], auto: null, needs_you: false });
  return rows;
}

// 专用 Chrome：要用时才起，没开着不算毛病。只看两件事：装没装 Chrome（有人要用它的时候）、最近 6 小时有没有起不来、连不上。
// 归到用它的那位（事件的 actor：投递预填、私信是 Reacher，要登录的真人帖来源是 Radar，BOSS、脉脉的消息看守是 Watcher）。
const CHROME_FAIL = /chrome_(not_found|start|launch|host_busy|timeout|exited|profile)|cdp_|专用 Chrome/i;
function chromeRows({ events, now, find = findChrome }) {
  const fails = events.filter(e => e.status === 'fail' && now - T(e.ts) < CHROME_WINDOW_MS && CHROME_FAIL.test(`${e.error || ''} ${e.msg || ''}`));
  const byMember = new Map();
  for (const e of fails) { const m = memberOfEvent(e); if (m === 'you') continue; const g = byMember.get(m) || []; g.push(e); byMember.set(m, g); }
  const rows = [];
  for (const [m, es] of byMember) {
    const last = es.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
    const later = events.some(e => memberOfEvent(e) === m && e.step === last.step && e.status === 'ok' && T(e.ts) > T(last.ts));
    if (later) continue;
    rows.push({ hand: 'chrome', member: m, state: es.length >= 2 ? 'down' : 'warn', since: es.at(-1).ts, cause: `${crewName(m)} 用的${CHROME_NAME}${es.length >= 2 ? `最近 ${es.length} 次` : '刚才'}没起来：${cut(last.error || last.msg, 80)}`, evidence: (last.refs || []).map(r => r.file).filter(Boolean).slice(0, 3), auto: null, needs_you: false });
  }
  if (rows.length && !find()) for (const r of rows) Object.assign(r, { state: 'down', needs_you: `这台电脑上没找到 Chrome：装一个才能用${CHROME_NAME}` });
  return rows;
}

// 邮箱（Watcher）：没接就不上账。授权失败（auth、secret、unsafe）要你重新粘贴授权码，别的错按退避重测。
const MAIL_YOURS = new Set(['auth', 'secret', 'unsafe', 'config']);
function mailRow({ view = null }) {
  let v = view;
  if (!v) { try { v = mailView(); } catch (e) { noteSwallowed('health.mail', e, { member: 'owl', doing: '读邮箱的状态', then: '账本里这次没有邮箱那一行' }); return null; } }
  if (!v?.address || (!v.connected && !v.status)) return null;
  // 只收信（收信通、发信不通，第 6b 轮）：读信照常，发信停着——算「降级」，不算断了。
  if (v.connected && v.receive_only) return { hand: 'mail', member: 'owl', state: 'warn', since: v.checked_at || null, cause: `邮箱只收信：${cut(v.send_problem || '发信不通', 120)}`, evidence: [], auto: null, needs_you: '换个不封发信端口的节点，在「设置 → 邮箱」点「重新测试」' };
  if (v.connected) return { hand: 'mail', member: 'owl', state: 'ok', since: null, cause: `邮箱 ${v.label || ''}连着`.replace(/\s+连/, '连'), evidence: [], auto: null, needs_you: false };
  const yours = MAIL_YOURS.has(v.status);
  return { hand: 'mail', member: 'owl', state: yours ? 'down' : 'warn', since: v.checked_at || null, cause: `邮箱没连上：${cut(v.problem || v.status, 80)}`, evidence: [], auto: null, needs_you: yours ? '邮箱授权失败：在「设置 → 邮箱」里重新粘贴授权码' : false };
}

// 各平台的登录：登录看守（lib/login-watch.mjs）看过、又确实没登着的账号。要你登录的信已经在收件箱里，这里只是归到成员。
const WATCHER_ACCOUNTS = /boss|zhipin|maimai/i;
function loginRows({ now, state = null }) {
  const st = state || loginWatchState(now), fams = loadAccounts().families || {};
  const rows = [];
  for (const [key, v] of Object.entries(st || {})) {
    if (!v || typeof v !== 'object' || !(v.logged_in === false || v.stuck || v.blocked_at)) continue;
    const label = fams[key]?.label || key.replace(/^host:/, '');
    const member = WATCHER_ACCOUNTS.test(key) ? 'owl' : 'quill';
    const cause = v.stuck ? `${label}：看到你已登录，任务还是说要登录（多半要再验证一次）` : v.blocked_at ? `${label}：网站要先验证，先歇一阵再看` : `${label} 没登着：${cut(v.reason, 60) || '登录过期了'}`;
    rows.push({ hand: `login:${key}`, member, state: 'warn', since: v.checked_at || null, cause, evidence: ['state/login-watch.json'], auto: null, needs_you: false });
  }
  return rows;
}

// 任务：执行器心跳十分钟没动静（给人看的一句说「本机 AI」）、操作台那个一次只跑一个的脚本进程没了。卡住的卡（state/tasks.ndjson）各归各的主人。
function taskRows({ now, localOn = true }) {
  const rows = [];
  for (const t of localOn ? stuckTasks({ now }).stuck : []) if (t.reason.kind !== 'needs_user')
    rows.push({ hand: `task:${t.key}`, member: 'patch', state: 'warn', since: t.updated_at || t.started_at || null, cause: String(t.reason.label || '').replace(/执行器/g, '本机 AI'), evidence: ['state/executor-heartbeat.json'], auto: null, needs_you: false });
  const ops = read('state/ops.json', { current: null }) || {};
  if (ops.current?.pid && (localOn || !['host-work', 'run-now'].includes(ops.current.op)) && !alive(ops.current.pid)) rows.push({ hand: `op:${ops.current.op}`, member: 'patch', state: 'warn', since: ops.current.started_at || null, cause: `「${ops.current.label || ops.current.op}」的进程已经不在了，记录还停在运行中`, evidence: [ops.current.log].filter(Boolean), auto: null, needs_you: false });
  const latest = new Map(); for (const c of lines('state/tasks.ndjson')) latest.set(c.id, c);
  for (const c of [...latest.values()].filter(c => c.status === 'stuck' && c.kind !== 'goal' && now - T(c.updated_at || c.created_at) < 3 * 86400e3).slice(-10))
    rows.push({ hand: `card:${c.id}`, member: CREW_IDS.includes(c.owner) ? c.owner : 'overall', state: 'warn', since: c.updated_at || c.created_at || null, cause: `卡住的卡「${cut(c.title || c.kind, 30)}」：${cut(c.detail, 80) || '原因没写'}`, evidence: ['state/tasks.ndjson'], auto: null, needs_you: false });
  return rows;
}

// 指挥台的告警（alertsView）：模型和招聘源上面已经逐条算了，这里不重复；已恢复的、只是提示的不上账。
const COVERED = a => a.step === 'model' || (a.source === 'scout' && /官方招聘源读不到|真人帖来源被拦/.test(a.msg));
function alertRows(alerts = []) {
  return alerts.filter(a => !a.recovered_at && a.level !== 'info' && !COVERED(a)).map(a => {
    const member = CREW_IDS.includes(a.source) ? a.source : 'overall';
    return { hand: `alert:${a.step || a.source || 'run'}`, member, state: a.level === 'error' ? 'down' : 'warn', since: a.at || null, cause: cut(a.msg, 160), evidence: (a.refs || []).map(r => r.file).filter(Boolean).slice(0, 3), auto: a.system_job ? `已交给本机 AI 查（${a.system_job.status}）` : null, needs_you: false, ...(member === 'overall' ? { missing: '告警没写是哪一步出的，归不到哪位成员' } : {}) };
  });
}

// 今天「换了一种做法」的（lib/fallback.mjs）：每个 kind + from 一行，归到调的那位；说不清是谁的写整体。
function fallbackRows({ now }) {
  let list = [];
  try { list = fallbacksOn({ now }); } catch (e) { noteSwallowed('health.fallbacks', e, { doing: '读今天「换了一种做法」的记录', then: '账本里这次没有那几行' }); return []; }
  return list.map(f => {
    const member = CREW_IDS.includes(f.member) ? f.member : 'overall';
    return { hand: `fallback:${f.kind}:${f.from}`, member, state: 'warn', since: null, cause: `今天换了 ${f.count} 次：${f.from_label || f.from} → ${f.to_label || f.to}${f.why_text ? `（${f.why_text}）` : ''}`, evidence: ['state/fallbacks.json', 'state/events.ndjson'], auto: null, needs_you: false, ...(member === 'overall' ? { missing: '调用的地方没写是哪位成员' } : {}) };
  });
}

// 近 24 小时出错被跳过的（lib/swallow.mjs noteSwallowed）：每位成员一行，说几处、最常见的那一处。
// 偶尔一次只记在账上（ok），同一处 24 小时里出了 3 次以上才算毛病（warn）：零星的不惊动人，老出的要看。
export function swallowRows({ events, now }) {
  const by = new Map();
  for (const e of events) {
    if (e.step !== SWALLOW_STEP || now - T(e.ts) > 24 * 3600000) continue;
    const member = CREW_IDS.includes(e.actor) ? e.actor : 'overall';
    const g = by.get(member) || { n: 0, where: new Map(), since: e.ts };
    const w = g.where.get(e.where || e.msg) || { n: 0, msg: e.msg };
    w.n++; w.msg = e.msg; g.where.set(e.where || e.msg, w); g.n++;
    if (String(e.ts) < String(g.since)) g.since = e.ts;
    by.set(member, g);
  }
  return [...by].map(([member, g]) => {
    const top = [...g.where.values()].sort((a, b) => b.n - a.n)[0];
    return { hand: `swallowed:${member}`, member, state: top.n >= 3 ? 'warn' : 'ok', since: g.since, cause: `近 24 小时 ${g.n} 次出错后跳过，${g.where.size} 处；最多的：${cut(top.msg, 80)}（${top.n} 次）`, evidence: ['state/events.ndjson'], auto: null, needs_you: false, ...(member === 'overall' ? { missing: '记的时候没写是哪位成员' } : {}) };
  });
}

// 监工自己停了（兜底清单复核 N04）：连着几拍都没跑完，归 System。
function watchRow({ now }) {
  const d = watchDown({ now });
  return d ? { hand: 'system:watch', member: 'patch', state: 'warn', since: d.since, cause: `监工停了：连着 ${d.streak} 拍没跑完${d.why ? `（${d.why}）` : ''}`, evidence: [WATCH_STATE, 'state/events.ndjson'], auto: '每分钟再试一拍', needs_you: false } : null;
}

// ── 整本账 ────────────────────────────────────────────────────────────────────
// alerts：指挥台算好的（GET /api/system/health 从 commandCenter 拿，同一份缓存）；不给就不收告警这一块。
// 测试可以传 events、ready（textReady 的替身）、sources、mail、logins。
export function healthLedger({ now = Date.now(), events = null, alerts = [], ready = textReady, chat = modelState, sources = null, mail = null, logins = null, backends = null } = {}) {
  const evs = events || tailEvents(4000), x = localAiStatus();
  const rows = [
    ...CREW_IDS.map(m => modelRow(m, { events: evs, now, ready, backends: backends?.[m] || null })),
    chatRow({ now, state: chat }),
    freeRow({ now }),
    ...sourceRows({ now, view: sources }),
    ...chromeRows({ events: evs, now }),
    mailRow({ view: mail }),
    ...loginRows({ now, state: logins }),
    ...taskRows({ now, localOn: x.on }),
    ...alertRows(alerts.filter(a => x.on || !/^(run-now|host-work|executor)$/.test(a.step || ''))),
    ...fallbackRows({ now }),
    ...swallowRows({ events: evs, now }),
    watchRow({ now }),
  ].filter(Boolean);
  // K43：和设置 → 高级读同一个状态、同一句话；开关开着只是还用不了，不说成「没打开」。
  const local_ai = { desktop: true, on: x.on, ready: x.configured, selected: x.selected, running: x.running, execution: x.execution, text: x.sentence };
  const members = Object.fromEntries([...CREW_IDS, 'overall'].map(m => { const mine = rows.filter(r => r.member === m && r.state !== 'off'); return [m, { state: mine.length ? worst(mine) : 'ok', problems: mine.filter(r => r.state !== 'ok').length }]; }));
  const live = rows.filter(r => r.state !== 'off');
  return { at: iso(now), state: worst(live), rows: rows.sort((a, b) => RANK[a.state] - RANK[b.state]), members, local_ai, needs_you: rows.filter(r => r.needs_you).map(r => ({ hand: r.hand, member: r.member, text: r.needs_you })), actions: recentActions({ limit: 10 }) };
}
