// System 讲「为什么」（L 线第 2 批 2c，design/desktop-app/方案-System监工-第2批.md 第五节；方案-任务即对话.md 第六节「看原因」）。
// 你在对话里问「为什么推荐是 0」「怎么还没跑」「报错了」（lib/talk-route.mjs isWhyQuestion），或者点了 Writer 卡上的「看原因」：
//   1. 先分类（whyKind，规则）：判断结果 verdict · 没在跑 idle · 报错 error · 模型和额度 model · 登录 login · 本机 AI local_ai；
//      「看原因」是 task（一件活没做成）。问某一条的（「#12 为什么是待核」）是 verdict，由 Judge 说。
//      指挥台顶上挡路横条的「看原因」（「这是怎么回事：<横条上那句话>」）：按现在顶上是哪一条（lib/blockers.mjs）分类——
//      model → 模型和额度、alert → 报错、local_ai → 本机 AI、phone → 手机；横条已经没了才按那句话里的词猜。
//   2. 按类收集事实（collectFacts）：健康账本（lib/system/health.mjs）加上这一类自己的那几样，只读本机的文件和状态。
//   3. 去掉秘密、少放个人信息（redact）：token、授权码、key、Cookie 换成「（已隐藏）」，private/ 下的文件不进事实，
//      邮箱手机号打码，路径里的用户名换成 ~；简历正文、资料原文不进事实，只给「资料里看不出 Java」这种结论。
//   4. 回答 { 原因, 影响, 能怎么办 }：先按规则拼一版（ruleAnswer）；有模型就让模型只按事实把它写成人话（infer，role patch，
//      schema 校验，数字只能是事实里有的），不过就用规则版。没有模型、沙盒：规则版。
//      「能怎么办」的按钮只能从 fixButton 里挑：标准做法表里不对外的那几步（只读外面、只写本机），加上打开设置、资料、运行日志的链接。
// 这里不改任何东西；按钮点了才走对话里现成的那条路（「运行 match」→ dispatchCommand）。
import { coName } from '../vocab.mjs';
import { read, file } from '../store.mjs';
import fs from 'node:fs';
import { cachedLines } from '../state-cache.mjs';
import { CREW_IDS, crewName, memberOfEvent } from '../crew.mjs';
import { infer, textReady, backendsFor } from '../model.mjs';
import { modelConf } from '../text-conf.mjs';
import { loadProviders, backendLabel } from '../backends.mjs';
import { currentFacts } from '../facts.mjs';
import { firstRound, verifyGaps } from '../first-round.mjs';
import { pendingLead } from '../matcher.mjs';
import { appSchedule } from '../app-schedule.mjs';
import { appShell, appSchedules, SWITCH_GO, LOCAL_AI_UNSUPPORTED } from '../capabilities.mjs';
import { localAiStatus, localAiSummary } from '../local-ai-status.mjs';
import { agentPaused } from '../agents.mjs';
import { OPS } from '../ops-table.mjs';
import { scheduleView } from '../schedule-status.mjs';
import { CATCHUP_PATH, slotLabel } from '../cycle-catchup.mjs';
import { healthLedger } from './health.mjs';
import { RERUN_OPS } from './playbook.mjs';
import { blockers, alertDetail } from '../blockers.mjs';
import { notFailure } from '../alert-rules.mjs';
import { phoneLink } from '../phone-status.mjs';
import { BANNER_WHY } from '../intent.mjs';
import * as J from '../jobs.mjs';
import { TZ } from '../tz.mjs';
import { modelErrorKind, errorReason, explainFailure } from '../say-error.mjs';
import { noteSwallowed } from '../swallow.mjs';
import { tailEvents } from '../events.mjs';

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const T = s => Date.parse(s || '') || 0;
const clock = t => (T(t) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(T(t))) : '');
const uniq = a => [...new Set(a.filter(Boolean))];
const end = s => (/[。！？…]$/.test(s) ? s : `${s}。`);

// 给人看的说法（发布清单 P1「别露文件名」）：底座 id（供应商/模型）换成设置页上的那个名字（lib/backends.mjs backendLabel，
// 你给它起过名字就用你起的）；文件名、路径不进回答——要看原始记录，下面有「看运行日志」。
const DRIVER_NAME = { claude_code: 'Claude Code', codex_exec: 'Codex' };
function configured(providers) {
  const out = [];
  for (const role of [null, ...CREW_IDS]) { try { out.push(...backendsFor(modelConf('text'), providers, { role, purpose: 'text' })); } catch {} } // 兜底：这位成员的清单解析不了就跳过，别的成员照常认
  for (const b of read('config/chat.json', {})?.backends || []) out.push(b);
  return out;
}
export function modelName(id, { providers = null } = {}) {
  const s = String(id || '').trim();
  if (!s) return null;
  if (DRIVER_NAME[s]) return DRIVER_NAME[s];
  const bare = s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
  try { const ps = providers || loadProviders(), b = configured(ps).find(x => x && x.id === s); return backendLabel(b || s, ps) || bare; }
  catch { return bare; }
}
const PATHISH = /(?:~|\/Users\/[^\s/]+)?\/?\b(?:runs|state|config|private|candidate|logs?)\/[^\s，。；、：）)」]+|\b[\w.-]+\.(?:ndjson|json|log|txt|ya?ml|toml)\b/g;
// 底座 id 的样子：小写开头的「供应商/模型」（claude_gateway/claude-fable-5-1、deadlocal/demo-m1）；网址里的、路径里的不算。
const BACKEND_ID = /(?<![\w/:.])[a-z][a-z0-9_-]*\/[A-Za-z0-9][\w.:@-]*/g;
export function plainText(text, { providers = null } = {}) {
  let t = String(text || '').replace(/https?:\/\/\S+/g, u => `\u0000${encodeURIComponent(u)}\u0000`).replace(PATHISH, '');
  let ps = providers; try { ps ||= loadProviders(); } catch {} // 兜底：模型目录读不出来就没有底座名字可认，规则版照样说
  t = t.replace(BACKEND_ID, id => modelName(id, { providers: ps }) || id).replace(/\b(claude_code|codex_exec)\b/g, k => DRIVER_NAME[k]);
  t = t.replace(/\u0000([^\u0000]*)\u0000/g, (_, u) => decodeURIComponent(u));
  return t.replace(/[（(]\s*[）)]/g, '').replace(/[：:]\s*(?=[。；，]|$)/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

// ── 1. 分类 ───────────────────────────────────────────────────────────────────
export const WHY_KINDS = ['verdict', 'idle', 'error', 'model', 'login', 'local_ai', 'phone', 'task', 'facts'];
const BANNER_KIND = { facts: 'facts', model: 'model', alert: 'error', local_ai: 'local_ai', phone: 'phone' };
// 横条那句话 → 现在顶上的哪一条：一字不差的最好，其次同一类里排第一的；都没有（横条刚好消失了）就按词猜一类。
export function bannerOf(text, list = []) {
  const said = BANNER_WHY.exec(String(text || '').trim())?.[1]?.trim();
  if (!said) return null;
  // 「看原因」带来的是完整内容（detail）时按它认。
  const hit = list.find(b => b.text === said || (b.detail && b.detail === said)) || list.find(b => said.startsWith(String(b.text).slice(0, 12)));
  const guess = /资料/.test(said) ? 'facts' : /文字模型|补给|钥匙|额度|模型/.test(said) ? 'model' : /告警/.test(said) ? 'alert' : /本机\s*AI/.test(said) ? 'local_ai' : /手机/.test(said) ? 'phone' : 'alert';
  const b = hit || { kind: guess, text: said, gone: true };
  return { kind: b.kind, text: cut(b.text, 120), ...(b.gone ? { gone: true } : {}), ...(b.why ? { why: b.why } : {}), why_kind: BANNER_KIND[b.kind] || 'error' };
}
export function whyKind(text, { number = null } = {}) {
  const t = String(text || '');
  if (number) return 'verdict';
  if (/本机\s*AI|执行器|\bcodex\b|claude\s*code/i.test(t)) return 'local_ai';
  if (/登录|登陆|掉线|验证码|cookie/i.test(t)) return 'login';
  if (/模型|额度|补给|token|钥匙|\bkey\b|(?:model_http|openai_api|claude_api)_/i.test(t)) return 'model';
  if (/报错|出错|失败|错误|崩了|挂了/.test(t)) return 'error';
  if (/推荐|待核|排除|判断|判成|判了|没判|匹配|首轮|第一轮|是\s*0|为\s*0|没有.{0,6}(?:岗位|机会|推荐)|合适/.test(t)) return 'verdict';
  if (/没跑|没在跑|不跑|没动|不动|没开始|定时|周期|几点|暂停|停了|没反应|怎么还/.test(t)) return 'idle';
  return 'error';
}

// ── 3. 脱敏 ───────────────────────────────────────────────────────────────────
export const HIDDEN = '（已隐藏）';
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|apikey|cookie|authori[sz]ation|auth[_-]?code|credential|session[_-]?id|授权码|密码|密钥/i;
const RESUME_KEY = /^(?:resume|resume_text|cv|content|body|raw_text|full_text|jd_text|text_raw)$/i;
const PRIVATE = /(?:^|[\s/"'(（=:])private\//;
const SECRET_TEXT = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${HIDDEN}`],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|cookie|authorization|授权码|密码|密钥)["']?\s*[:=：]\s*["']?)[^\s"',，;；)）]+/gi, `$1${HIDDEN}`],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}\b/g, HIDDEN],
  [/[^\s"'<>()（），。；]*private\/[^\s"'<>，。；)）]*/g, HIDDEN],
  [/(?:\/Users|\/home)\/[^/\s"']+/g, '~'],
  [/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2'],
  [/(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2'],
];
export const redactText = s => SECRET_TEXT.reduce((t, [re, to]) => t.replace(re, to), String(s ?? ''));
// 事实整个走一遍：秘密的字段换掉，简历、正文那种字段整个不要，private/ 下的文件从列表里拿掉，字符串截短。
export function redact(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return cut(redactText(v), 300);
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.filter(x => !(typeof x === 'string' && PRIVATE.test(x))).map(x => redact(x, depth + 1));
  if (typeof v !== 'object') return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (RESUME_KEY.test(k)) continue;
    if (SECRET_KEY.test(k)) { out[k] = HIDDEN; continue; }
    if (typeof x === 'string' && PRIVATE.test(x) && /file|path|ref|log|evidence/i.test(k)) continue;
    out[k] = redact(x, depth + 1);
  }
  return out;
}

// ── 「能怎么办」能放的按钮 ───────────────────────────────────────────────────────
// act：点了在对话里说的那句（照常过 lib/talk.mjs classifyTalk → dispatchCommand）；href：打开那一页。
// say：有现成中文说法的（「Judge 跑一轮」，lib/talk.mjs crewCommand 认得）才有，只有它进回复的 actions——界面现在把 actions
// 原样画成按钮，「运行 match」这种操作名不能露出来；没有中文说法的只留在 why.buttons 里（T3 的界面按 label 画）。
// 重跑的只限标准做法表 P4 那几步（lib/system/playbook.mjs RERUN_OPS：没有对外动作，只读外面、只写本机），补判一轮是 P5。
// 清空、改设置、重判已判的、往外发的、会拉起本机 AI 的都不在这里。
const RERUN = [...new Set(Object.values(RERUN_OPS))];
const rerunOf = step => RERUN_OPS[step] || null;
const LINKS = {
  profile: { label: '打开资料', href: '#settings/profile' },
  materials: { label: '打开材料', href: '#materials' },
  model: { label: '设置模型', href: '#settings/model' },
  local_ai: { label: '本机 AI 开关', href: SWITCH_GO },
  inbox: { label: '看收件箱', href: '#inbox' },
  accounts: { label: '账号与连接', href: '#settings/accounts' },
  mail: { label: '邮箱设置', href: '#settings/accounts?hl=mail' },
  log: { label: '看运行日志', href: '#stream' },
  phone: { label: '手机设置', href: '#settings/notify' },
};
export function fixButton(id, { limit = 40 } = {}) {
  const k = String(id || '');
  if (k === 'rejudge') return { id: k, label: `现在再判 ${limit} 个`, act: '运行 match' };
  if (k === 'round-lens') { const say = `${crewName('lens')} 跑一轮`; return { id: k, label: say, act: say, say }; }
  if (k.startsWith('rerun:')) { const op = k.slice(6); return RERUN.includes(op) && OPS[op] ? { id: k, label: `重跑「${OPS[op].label}」`, act: `运行 ${op}` } : null; }
  return LINKS[k] ? { id: k, ...LINKS[k] } : null;
}
// 每一类除了规则挑的，模型还可以挑的链接。
const KIND_LINKS = { facts: ['profile', 'materials'], verdict: ['profile', 'materials'], idle: ['log'], error: ['log'], model: ['model'], login: ['accounts'], local_ai: ['inbox', 'local_ai'], phone: ['phone'], task: ['model', 'log'] };

// ── 2. 收集事实 ─────────────────────────────────────────────────────────────────
// 每样东西用到才读一次；读不到就当没有（null），不让一处坏了整句回答都没有。测试和调用方可以直接给（leads、ledger、events……）。
function sources({ now = Date.now(), ...given } = {}) {
  const memo = {};
  const center = () => (typeof given.center === 'function' ? given.center() : given.center) || {};
  const lazy = (k, f) => () => { if (!(k in memo)) { try { memo[k] = given[k] !== undefined ? given[k] : f(); } catch { memo[k] = null; } } return memo[k]; }; // 兜底：这一样事实拿不到就当没有，规则版照样说
  return {
    now,
    leads: lazy('leads', () => cachedLines('state/leads.ndjson')),
    ops: lazy('ops', () => read('state/ops.json', {}) || {}),
    profile: lazy('profile', () => currentFacts()),
    // 告警：指挥台算好的那一份（对话里传进来的 center；GET /api/system/health 也是这一份），没有就不收告警。
    alerts: lazy('alerts', () => center().alerts || []),
    ledger: lazy('ledger', () => healthLedger({ now, alerts: memo.alerts ?? (center().alerts || []) })),
    blockers: lazy('blockers', () => blockers({ alerts: center().alerts || [] })),
    phone: lazy('phone', () => phoneLink()),
    runNow: lazy('runNow', () => read('state/run-now.json', {}) || {}),
    events: lazy('events', () => tailEvents(1500)),
    schedule: lazy('schedule', () => scheduleView({ now })),
    pipeline: lazy('pipeline', () => read('config/pipeline.json', {}) || {}),
    catchup: lazy('catchup', () => read(CATCHUP_PATH, null)),
    paused: lazy('paused', () => CREW_IDS.filter(k => agentPaused(k))),
    local: lazy('local', () => localAiStatus()),
    // 只有本机 AI 能做、在等你定的那几件（账上原因码 needs_local_ai，lib/legacy-hands.mjs）：哪件事、哪一步、谁的、什么时候建的。
    localWaits: lazy('localWaits', () => J.list({ state: 'waiting_you', limit: 50 }).filter(j => j.reason_code === 'needs_local_ai').map(j => ({ title: j.title, member: j.member, need: /这一步要([^，,；;]+)，只有本机 AI/.exec(j.reason || '')?.[1] || null, at: j.created_at }))),
  };
}
// 还没判的什么时候判（和 lib/first-round.mjs backlogNow 同一套设置）。
function backlogOf(src) {
  const p = src.pipeline() || {};
  return { times: appSchedule().find(j => j.name === 'cycle')?.times || ['09:05', '13:05', '18:05'], app: appSchedules(), limit: Number(p.match_limit) || 40, economy: p.spend_tier === 'economy' };
}
const leftOf = leads => leads.filter(l => !l.superseded && pendingLead(l) && !l.prefilter_reason && !l.match_error_final).length;
const runningOp = src => { const c = src.ops()?.current; return c?.op ? { op: c.op, label: c.label || OPS[c.op]?.label || '一个操作', started_at: c.started_at || null } : null; };

// 判断结果：一条（number）或者一批（最近跑完的首轮；没有首轮就是最近一天判的）。待核的按差在哪一类数（一条每类算一次）。
function verdictFacts(src, { number = null } = {}) {
  const leads = src.leads() || [], profile = src.profile() || {}, now = src.now;
  const gapsOf = l => verifyGaps(l, profile).map(g => ({ key: g.key, label: g.text, ...(g.fill ? { fill: g.fill_label } : {}) }));
  if (number) {
    const l = leads.find(x => x.number === number && !x.superseded);
    if (!l) return { lead: { number, found: false } };
    const m = l.match || {}, reqs = m.must_haves || [];
    return {
      lead: {
        number, found: true, company: cut(coName(l.company), 30), role: cut(l.role, 40), verdict: m.verdict || null,
        gaps: m.verdict === 'verify' ? gapsOf(l) : [], unclear: reqs.filter(r => r.status === 'unknown' && r.critical !== false).length,
        conflict: reqs.filter(r => r.status === 'conflict').map(r => cut(r.req, 40)).slice(0, 3), biggest_gap: cut(m.biggest_gap, 60) || null,
        reasons: (m.reasons || []).slice(0, 2).map(r => cut(r, 40)),
      },
      left: leftOf(leads), schedule: backlogOf(src), running: runningOp(src),
    };
  }
  const fr = firstRound({ ops: src.ops() || {}, leads, now });
  const judged = fr ? fr.judged : leads.filter(l => !l.superseded && l.match?.verdict && now - T(l.matched_at) < 86400e3);
  const verdicts = { recommend: 0, verify: 0, exclude: 0 };
  for (const l of judged) if (Object.hasOwn(verdicts, l.match.verdict)) verdicts[l.match.verdict]++;
  const counts = new Map();
  for (const l of judged.filter(x => x.match.verdict === 'verify')) for (const g of gapsOf(l)) { const c = counts.get(g.key) || counts.set(g.key, { ...g, count: 0 }).get(g.key); c.count++; }
  return {
    scope: fr ? 'first_round' : 'recent', judged: judged.length, verdicts,
    gaps: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    excluded: judged.filter(l => l.match.verdict === 'exclude').map(l => cut(l.match.biggest_gap, 30)).filter(Boolean).slice(0, 3),
    left: leftOf(leads), schedule: backlogOf(src), running: runningOp(src),
  };
}
// 没在跑：定时表里的周期、上一档的开始和结束、合盖睡过的那一档、在跑的操作、暂停的成员。
function idleFacts(src) {
  const sch = src.schedule() || {};
  const cycle = (sch.items || []).filter(i => i.kind === 'cycle').map(i => ({ schedule: i.schedule || null, next_at: i.next_at || null, last_started_at: i.last_started_at || null, last_finished_at: i.last_finished_at || null, last_exit: i.last_exit ?? null, running: !!i.running }));
  const c = src.catchup();
  return { app: !!sch.app || appSchedules(), cycle, missed: c?.slot ? { slot: String(c.slot), at: c.missed_at || null } : null, running: runningOp(src), paused: (src.paused() || []).map(crewName) };
}
// 报错：账本里不好的那几条（不算模型，模型单独一类）、最近 6 小时没做成的事件、最新那次的日志尾巴（截短、脱敏）。
function errorFacts(src) {
  const rows = (src.ledger()?.rows || []).filter(r => !['ok', 'off'].includes(r.state) && !/^(model:|chat$|free$)/.test(r.hand));
  // 和告警同一套规矩（lib/alert-rules.mjs）：核对没过不算没做成；Mac 模式下没接过飞书的，飞书那几步不算。
  const fails = (src.events() || []).filter(e => e.status === 'fail' && src.now - T(e.ts) < 6 * 3600e3 && memberOfEvent(e) !== 'you' && !notFailure(e) && (!['listener', 'concierge'].includes(e.actor)))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 5)
    .map(e => ({ at: e.ts, member: crewName(memberOfEvent(e)), step: e.step || null, text: errorReason(e.error || e.msg), error_kind: e.step === 'model' ? modelErrorKind(e.error || e.msg).kind : null, files: (e.refs || []).map(r => r.file).filter(f => f && !PRIVATE.test(f)).slice(0, 2) }));
  const logRef = fails.flatMap(f => f.files).find(f => /^runs\/.+\.(?:log|txt)$/.test(f));
  let tail = null;
  if (logRef) { try { const t = fs.readFileSync(file(logRef), 'utf8'); tail = t.slice(-600); } catch {} } // 兜底：日志不在就不带最后几行
  // 横幅上「N 条严重告警」那个 N 数的就是这几条（lib/blockers.mjs 同一个筛法）：原样给出来，说几条就列几条（第 6 轮：System 说一共 10 条，
  // 具体只列了 6 条——它手里的「具体」是另一份账本，还只截了前 6 条）。太多的列满 12 条，再说另外还有几条。
  const errs = (src.alerts?.() || []).filter(a => a && a.level === 'error' && !a.recovered_at);
  const alerts = { total: errs.length, list: errs.slice(0, 12).map(a => ({ member: crewName(a.member || 'patch'), text: cut(alertDetail(a), 160), ...(a.fix ? { fix: a.fix.label } : {}) })), more: Math.max(0, errs.length - 12) };
  return { alerts, problems: rows.slice(0, 6).map(r => ({ member: crewName(r.member === 'overall' ? 'patch' : r.member), state: r.state, cause: r.cause, since: r.since || null, needs_you: r.needs_you || null, evidence: (r.evidence || []).filter(f => !PRIVATE.test(f)) })), fails, log_tail: tail, log: logRef || null };
}
function modelFacts(src) {
  const rows = (src.ledger()?.rows || []).filter(r => /^(model:|chat$|free$)/.test(r.hand));
  return { rows: rows.map(r => ({ member: r.hand === 'chat' ? '对话' : r.hand === 'free' ? 'OfferCrew 补给' : crewName(r.member), state: r.state, cause: r.cause, needs_you: r.needs_you || null, backend: r.backend || null })) };
}
function loginFacts(src) {
  return { rows: (src.ledger()?.rows || []).filter(r => /^login:/.test(r.hand)).map(r => ({ member: crewName(r.member), state: r.state, cause: r.cause, since: r.since || null })) };
}
// 本机 AI：开关和三个条件（lib/capabilities.mjs localAi：哪一条不满足就停在哪一条，后面的没看）。
const LOCAL_CONDITIONS = ['开关打开', '这一版支持受限运行', '这台电脑上装了它用的 Claude Code / Codex', '它已经登录'];
const localStop = x => !x.on ? 0 : x.ready ? LOCAL_CONDITIONS.length : x.why === LOCAL_AI_UNSUPPORTED ? 1 : /没找到/.test(x.why || '') ? 2 : 3;
function localFacts(src) {
  const raw = src.local() || {}, x = { ...raw, ready: raw.configured ?? raw.ready }, desktop = appShell();
  const stop = localStop(x);
  const hostJobs = new Map(cachedLines('state/host-jobs.ndjson').map(j => [j.id, j]));
  const queued = ((src.runNow() || {}).reasons || []).filter(r => !r?.job_ids?.length || r.job_ids.some(id => ['pending', 'working'].includes(hostJobs.get(id)?.status)));
  const items = [...(src.localWaits() || []).map(w => ({ what: w.title, step: w.need || '在这台电脑上操作的那一步', who: w.member ? crewName(w.member) : null, at: w.at })),
    ...queued.map(r => ({ what: String(r.reason || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 60), step: '整件要在这台电脑上做', who: null, at: r.at || null }))];
  return { ...(raw.runtimes ? { summary: localAiSummary(raw), selected: raw.selected, execution: raw.execution } : {}), desktop, on: !!x.on, ready: !!x.ready, why: x.why || null, waiting: items.length, items: items.slice(0, 6), conditions: LOCAL_CONDITIONS.map((text, i) => ({ text, ok: i < stop ? true : i === stop ? false : null })) };
}
// 一件活没做成（「看原因」）：卡上的原因（已经是人话）、连着几次，再从事件里找那次模型调用：哪个模型、记录在哪个文件。
function taskFacts(src, { failure = {} } = {}) {
  const who = failure.who || 'tailor', since = T(failure.at);
  const e = (src.events() || []).filter(x => x.step === 'model' && x.status === 'fail' && memberOfEvent(x) === who && (!since || T(x.ts) >= since - 1000))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0] || null;
  const ref = e ? (e.refs || []).map(r => r.file).find(f => /model-attempts\//.test(f || '') && !PRIVATE.test(f)) || null : null;
  const rec = ref ? read(ref, null) : null;
  const named = modelName(e?.backend || rec?.model || '') || '';
  return { who: crewName(who), reason: errorReason(failure.reason), tries: Number(failure.tries) || 1, error_kind: explainFailure(failure.reason).kind, model: e ? { backend: cut(named, 40) || null, at: e.ts } : failure.backend ? { backend: cut(modelName(failure.backend), 40) } : null, log: ref,
    ...(failure.switched_to ? { switched_to: cut(failure.switched_to, 40) } : {}) };
}
// 手机：配过的手机连不上中转（lib/phone.mjs phoneLink）。
function phoneFacts(src) {
  const p = src.phone() || {};
  return { paired: Number(p.paired) || 0, link: p.link || 'off' };
}
export function collectFacts(kind, deps = {}, { number = null, failure = null, banner = null } = {}) {
  const src = deps.src || sources(deps);
  const f = kind === 'facts' ? {} : kind === 'phone' ? phoneFacts(src) : kind === 'verdict' ? verdictFacts(src, { number }) : kind === 'idle' ? idleFacts(src) : kind === 'model' ? modelFacts(src) : kind === 'login' ? loginFacts(src) : kind === 'local_ai' ? localFacts(src) : kind === 'task' ? taskFacts(src, { failure }) : errorFacts(src);
  return redact({ kind, ...f, ...(banner ? { banner } : {}) });
}

// ── 4a. 规则版回答 ───────────────────────────────────────────────────────────────
const when = s => (s.app ? 'App 开着时' : '');
const backlogLine = (left, s) => !left ? '' : s.economy ? `还剩 ${left} 个没判：要你先按标题挑，留下的才判` : `还剩 ${left} 个没判，${when(s)}每天 ${s.times.join('、')} 各判 ${s.limit} 个`;
const answer = (cause, effect, fix, buttons = []) => ({ cause, effect, fix, buttons: uniq(buttons) });
const parts = text => Object.fromEntries(String(text).split('\n').map(l => /^(原因|影响|能怎么办)：([\s\S]*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));

function verdictRule(f) {
  const s = f.schedule || {}, left = f.left || 0, can = left && !f.running;
  if (f.lead) {
    const l = f.lead, tag = `#${l.number}${l.company ? ` ${l.company}` : ''}`;
    if (!l.found) return answer(`表上没有 #${l.number}`, '没有这一条，也就没有判断', '看一下编号对不对');
    if (!l.verdict) return answer(`${tag} 还没判`, backlogLine(left, s) || '下一档会判', can ? `不想等，可以现在再判 ${s.limit} 个` : '到点会判', can ? ['rejudge'] : []);
    if (l.verdict === 'verify') {
      const fill = l.gaps.filter(g => g.fill);
      return answer(
        `${tag} 判成待核：${l.gaps.length ? `从你的资料里看不出这几项——${l.gaps.map(g => g.label).join('、')}` : l.biggest_gap || '有要求说不清'}${l.unclear ? `（${l.unclear} 条要求说不清）` : ''}`,
        `待核的不会排进投递，也不会排除；${fill.length ? '资料里补上以后，这一条会重新判断' : '要你看过 JD 自己定'}`,
        fill.length ? `你确实有的（${uniq(fill.map(g => g.fill)).slice(0, 2).join('、')}），在资料里补上` : `看过 JD 觉得合适，就说「投 ${l.number}」`,
        fill.length ? ['profile'] : []);
    }
    if (l.verdict === 'exclude') return answer(`${tag} 排除了：${l.conflict[0] || l.biggest_gap || '有一条硬性要求对不上'}`, '这一条不会再推给你', `觉得判错了，说「${l.number} 重新打开」`);
    return answer(`${tag} 是推荐${l.reasons.length ? `：${l.reasons.join('；')}` : ''}`, '可以直接投，投之前还会给你看一遍', `要投就说「投 ${l.number}」`);
  }
  const v = f.verdicts || {}, which = f.scope === 'first_round' ? '第一轮' : '最近一天', gaps = f.gaps || [];
  if (!f.judged) return answer(`${which}还没有判出结果${f.running ? `：正在跑「${f.running.label}」` : ''}`, backlogLine(left, s) || '还没有等着判的岗位', can ? `不想等，可以现在再判 ${s.limit} 个` : '到点会判', can ? ['rejudge'] : []);
  const fill = gaps.filter(g => g.fill);
  const cause = `${which}看了 ${f.judged} 个岗位：推荐 ${v.recommend}、待核 ${v.verify}、排除 ${v.exclude}。`
    + (v.verify && gaps.length ? `待核的差在这几类（一个岗位可能差好几类）：${gaps.slice(0, 4).map(g => `${g.label} ${g.count} 个`).join('、')}，这些从你的资料里看不出来，所以没敢直接推荐。` : '')
    + (v.exclude && f.excluded?.length ? `排除的是硬性要求对不上（${f.excluded.slice(0, 2).join('；')}）。` : '');
  const effect = `${v.recommend ? `有 ${v.recommend} 个推荐可以直接投` : `${f.scope === 'first_round' ? '首轮' : '这一批'}没有能直接投的`}${left ? `；${backlogLine(left, s)}` : ''}。`;
  const fixes = [], buttons = [];
  if (fill.length) { fixes.push(`你确实有、但资料里没写的（比如${uniq(fill.map(g => g.fill)).slice(0, 2).join('、')}），在资料里补上，因为这一项待核的会重新判断`); buttons.push('profile'); }
  if (can) { fixes.push(`不想等下一档，可以现在再判 ${s.limit} 个`); buttons.push('rejudge'); }
  else if (f.running) fixes.push(`正在跑「${f.running.label}」，跑完接着判`);
  return answer(cause, effect, fixes.length ? fixes.join('；') + '。' : '不用你动手，下一档会接着判。', buttons);
}
function idleRule(f) {
  if (f.running) return answer(`正在跑「${f.running.label}」${f.running.started_at ? `（${clock(f.running.started_at)} 开始）` : ''}`, '它跑完之前，同一类的不会再开一轮', '等它跑完；进度在运行日志里', ['log']);
  if (f.paused?.length) return answer(`${f.paused.join('、')} 暂停着`, `${f.paused.join('、')} 的定时工作先不做，你自己说的照常做`, `说「恢复 ${f.paused[0]}」就接着做`);
  if (f.missed) return answer(`${/^\d{8}-\d{4}$/.test(f.missed.slot) ? slotLabel(f.missed) : '上一'} 那一档电脑合盖睡着，跳过了`, '醒来以后会补一轮', `不想等，可以让 ${crewName('lens')} 现在跑一轮`, ['round-lens']);
  const c = f.cycle?.[0];
  if (!c) return answer('定时表里没有周期', '到点不会自己跑', '可以让成员立即跑一轮');
  const last = c.last_started_at ? `上一档 ${clock(c.last_started_at)} 开始${c.last_finished_at ? `、${clock(c.last_finished_at)} 结束${c.last_exit ? '，没正常结束' : ''}` : c.running ? '，还在跑' : ''}` : '今天还没跑过';
  const bad = !!c.last_exit;
  return answer(`${last}${c.next_at ? `；下一档 ${clock(c.next_at)}` : ''}`, f.app ? '定时周期只在 App 开着时跑；合上电脑或退出 App，那一档就不跑' : '到点会自己跑',
    bad ? `上一档没正常结束：可以让 ${crewName('lens')} 现在跑一轮，原因在运行日志里` : '不用你动手，到点会跑', bad ? ['round-lens', 'log'] : []);
}
function errorRule(f) {
  // 问的是横幅上那几条严重告警：一共几条就列几条。
  const al = f.alerts;
  if (f.banner?.kind === 'alert' && al?.total > 1) {
    const listed = al.list.map((a, i) => `${i + 1}. ${a.member}：${a.text}`).join('；');
    return answer(`一共 ${al.total} 条严重告警：${listed}${al.more ? `；另外 ${al.more} 条在运行日志里` : ''}`, '这几处相关的活先停着，别的照常', '原始记录在运行日志里，一条条看', ['log']);
  }
  // 只有一条严重的：它有修的地方（lib/alert-rules.mjs），照实说在哪儿修。
  if (f.banner?.kind === 'alert' && al?.total === 1 && al.list[0].fix) return answer(al.list[0].text, '相关的活先停着，别的照常', `点顶上的「${al.list[0].fix}」处理`, ['log']);
  const top = f.problems?.[0] || (f.banner ? { cause: f.banner.text, member: crewName('patch'), state: 'warn' } : null), fail = f.fails?.[0];
  if (!top && !fail) return answer('最近 6 小时没看到出错的地方', '各位成员都照常', '还觉得不对，原始记录在运行日志里', ['log']);
  const buttons = [];
  if (fail && rerunOf(fail.step) && !top?.needs_you) buttons.push(`rerun:${rerunOf(fail.step)}`);
  if (fail?.error_kind && ['key', 'quota', 'missing', 'no_model', 'local_cli', 'region'].includes(fail.error_kind)) buttons.push('model');
  buttons.push('log');
  const cause = top ? top.cause : `${fail.member} 在${OPS[rerunOf(fail.step) || fail.step]?.label ? `「${OPS[rerunOf(fail.step) || fail.step].label}」` : ''}这一步没做成：${fail.text}`;
  const more = f.fails.length > 1 ? `（最近 6 小时一共 ${f.fails.length} 次没做成）` : '';
  const member = top?.member || fail.member;
  return answer(cause + more, top?.state === 'down' ? `${member} 的这类活停了，别的成员照常` : `${member} 的这一步先停着，别的照常`,
    top?.needs_you || (buttons[0]?.startsWith('rerun:') ? '多半是网络、锁或超时这类暂时的错，可以重跑这一步' : '原始记录在运行日志里'), buttons);
}
function modelRule(f) {
  // 顶上的横条（lib/blockers.mjs：免费额度用完、清单里没有能用的、你配的 X 钥匙失效了）说了而账本里看不出的：照横条那句拆成原因和影响。
  if (f.banner && !(f.rows || []).some(r => ['down', 'warn'].includes(r.state))) {
    const t = String(f.banner.text), i = t.lastIndexOf('，'), head = i > 0 ? t.slice(0, i) : t, tail = i > 0 ? t.slice(i + 1) : '判断和写信先停了';
    return answer(head, `${tail}，按钮和命令照常能用`, /钥匙/.test(head) ? '在设置里换一把钥匙（或换个模型）' : /补给/.test(head) ? '等额度恢复，或者在设置里换个模型' : '在设置里配一个能用的模型', ['model']);
  }
  const bad = (f.rows || []).filter(r => ['down', 'warn'].includes(r.state)), off = (f.rows || []).filter(r => r.state === 'off');
  if (!bad.length && off.length && off.length === f.rows.length) return answer('这是演示环境，不调用模型', '要模型的活都不做，按钮和命令照常能用', '换到正式的数据目录才会调用模型');
  if (!bad.length) return answer('现在各位成员的模型都能用', '不影响', '不用你动手');
  const down = bad.filter(r => r.state === 'down');
  return answer(bad.slice(0, 3).map(r => r.cause).join('；'),
    down.length ? `${uniq(down.map(r => r.member)).join('、')} 要用模型的活停在这一步，别的照常` : '会按清单换下一个模型再试，暂时不影响',
    bad.find(r => r.needs_you)?.needs_you || '再等一会儿；一直这样，就在「设置 → 模型」里换一个', ['model']);
}
function loginRule(f) {
  const rows = f.rows || [];
  if (!rows.length) return answer('登录看守没看到没登着的账号', '不影响', '不用你动手');
  return answer(rows.slice(0, 3).map(r => r.cause).join('；'), `${uniq(rows.map(r => r.member)).join('、')} 在这些网站上的事先停着，别的照常`, '收件箱里有要你登录的那一封，照它登录一次', ['accounts']);
}
function localRule(f) {
  // 只有一种身份（命令行版 10-04 冻结，lib/capabilities.mjs）：不再分「命令行装的」。
  if (f.ready) return answer(f.summary || '本机 AI 开着，条件都满足', '交给本机 AI 的活照常接手', '不用你动手');
  const why = f.on ? `本机 AI 已允许，但还用不了：${f.why || '有一个条件不满足'}` : '本机 AI 没打开';
  // 本机 AI 只是可选的加速：说清是哪几件、哪一步、为什么引擎做不了；办法先说收件箱里那封信（自己做、不做了），打开本机 AI 是其中一个选择。
  const items = f.items || [];
  if (!items.length) return answer(`${why}；现在没有在等它的事`, '引擎照常做所有的活，不受影响', '不用你动手', ['inbox']);
  const when = t => { const d = new Date(t || ''); return Number.isFinite(d.getTime()) ? `（${d.toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 建的）` : ''; };
  const list = items.map(i => `「${i.what}」${i.who ? `（${i.who}）` : ''}${when(i.at)}的「${i.step}」`).join('；');
  return answer(`${list}：这一步要在这台电脑上操作，这一步是本机文件或命令操作，超出了引擎的业务工具；${why}`,
    `只停这${items.length > 1 ? ` ${items.length} 件里的这一步` : '一步'}，别的活照常`,
    '收件箱里有一封信：这一步你自己做、这一步不做了，或者打开本机 AI 让它接手', ['inbox', 'local_ai']);
}
// switched_to：已经换到别的模型了（收件箱「你配的 X 钥匙失效了，暂时改用 Y」那封信，lib/system/breaker.mjs）：活照常，不说停了。
function taskRule(f) {
  const e = parts(explainFailure(f.reason, { who: null, switched_to: f.switched_to || null }).text), name = f.who || '这位成员';
  if (f.switched_to) return answer(`${f.model?.backend ? `你配的 ${f.model.backend}` : `${name} 的模型`}没调通：${f.reason}；已经暂时改用 ${f.switched_to}`, e['影响'], e['能怎么办'], ['model']);
  return answer(`${name} 这次没做成：${f.reason}${f.model?.backend ? `（模型 ${f.model.backend}）` : ''}${f.tries > 1 ? `，这件连着 ${f.tries} 次没做成` : ''}`,
    String(e['影响'] || '').replace(/^这位成员/, `${name} `), e['能怎么办'] || '再试一次',
    [['key', 'quota', 'missing', 'no_model', 'local_cli', 'region', 'timeout', 'json', 'cut'].includes(f.error_kind) ? 'model' : null, f.log ? 'log' : null]);
}
function phoneRule(f) {
  if (!f.paired) return answer('还没有配过手机', '不影响', '要在手机上看，在设置里配一台', ['phone']);
  if (f.link !== 'offline') return answer(f.link === 'connecting' ? '手机正在连中转服务' : '手机连着', '不影响', '不用你动手');
  return answer('配过的手机连不上中转服务', '手机上看不到新消息，电脑上照常', '看看这台电脑能不能上网；一直连不上，在设置里重新配一次手机', ['phone']);
}
// 资料文件（lib/facts-gate.mjs 的横条）：读坏了就重新导入简历或在设置里重新填（旧的留一份）；找不到就导入简历，或者在设置里填。
function factsRule(f) {
  // 横条是「出了什么事：怎么办；什么停了」：这里只取冒号前那半句，怎么办由下面说。
  const t = String(f.banner?.text || '资料文件有问题'), head = t.split(/[：；，]/)[0] || t;
  const broken = /读不了/.test(head);
  return answer(head, '判断、写信、填表先停了，别的照常', broken ? '在「材料」里重新导入简历，或者在「设置 → 资料」里重新填；原来那份会留一份旧版' : '在「材料」里重新导入简历，或者在「设置 → 资料」里把资料填上', ['profile', 'materials']);
}
const RULES = { facts: factsRule, phone: phoneRule, verdict: verdictRule, idle: idleRule, error: errorRule, model: modelRule, login: loginRule, local_ai: localRule, task: taskRule };
export const ruleAnswer = (kind, facts) => (RULES[kind] || errorRule)(facts || {});

// ── 4b. 模型写人话 ───────────────────────────────────────────────────────────────
export const whySchema = offered => ({
  type: 'object', additionalProperties: false, required: ['原因', '影响', '能怎么办', '按钮'],
  properties: { 原因: { type: 'string' }, 影响: { type: 'string' }, 能怎么办: { type: 'string' }, 按钮: { type: 'array', maxItems: 3, items: offered.length ? { type: 'string', enum: offered } : { type: 'string' } } },
});
export function whyPrompt(question, facts, draft, offered, { limit = 40 } = {}) {
  return [
    `你是 OfferCrew 团队里的 System（监工）。用户问：「${cut(redactText(question), 120)}」`,
    '只按下面的「事实」回答：事实里没有的数字、名字、原因一律不写，不猜。',
    '写三段，用简体中文的大白话、短句，对用户说「你」：',
    '- 原因：为什么会这样。能分类的写清是哪几类、各几个，不要只拿一条要求的原文当原因。',
    '- 影响：现在和接下来会怎样。',
    '- 能怎么办：用户能做的一两件事。',
    '「按钮」只能从「能放的按钮」里挑 id，最多 3 个；不需要就给空数组。',
    '不要贴报错原文、英文报错码、文件路径、操作名；不要说「安全」「不会被封」。按钮上的事，用按钮上的说法讲。',
    `事实：${JSON.stringify(facts)}`,
    `能放的按钮：${JSON.stringify(offered.map(id => ({ id, label: fixButton(id, { limit })?.label })))}`,
    `规则拼的草稿（可以照它改写得更清楚，数字不能改）：${JSON.stringify({ 原因: draft.cause, 影响: draft.effect, 能怎么办: draft.fix, 按钮: draft.buttons })}`,
  ].join('\n');
}
// 操作名（match、round-lens、discover……）不进给人看的话。
export const OP_NAME = new RegExp(`(?<![A-Za-z-])(?:${Object.keys(OPS).sort((a, b) => b.length - a.length).map(k => k.replace(/[-]/g, '\\-')).join('|')})(?![A-Za-z-])`, 'i');
const numbersIn = s => String(s).match(/\d+(?:\.\d+)?/g) || [];
// 模型回的过不过：三段都是中文的话、不长；没有报错码、路径、秘密、邮箱手机号；数字都是事实或草稿里有的；按钮都在能放的里头。
export function checkWhy(out, { facts, draft, offered }) {
  if (!out || typeof out !== 'object') return null;
  const [cause, effect, fix] = ['原因', '影响', '能怎么办'].map(k => (typeof out[k] === 'string' ? out[k].trim() : ''));
  const all = [cause, effect, fix].join('\n');
  if ([cause, effect, fix].some(p => p.length < 2 || p.length > 400 || !/[一-龥]/.test(p))) return null;
  if (/[A-Za-z]+_[A-Za-z0-9_]+|https?:\/\/|\/Users\/|\b(?:runs|state|private|config)\/|不会被封|安全/.test(all)) return null;
  if (redactText(all) !== all || all.includes(HIDDEN) || OP_NAME.test(all)) return null;
  const known = new Set(numbersIn(JSON.stringify(facts) + JSON.stringify(draft)));
  if (numbersIn(all).some(n => !known.has(n))) return null;
  const buttons = Array.isArray(out['按钮']) ? out['按钮'] : null;
  if (!buttons || buttons.some(b => !offered.includes(b))) return null;
  return { cause, effect, fix, buttons: uniq(buttons).slice(0, 3) };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => { const t = setTimeout(() => no(Error('timeout')), ms); t.unref?.(); })]);
// 默认的模型：System 自己的那份清单（role patch）里有能用的才用；沙盒、没配好返回 null（用规则版）。
const defaultModel = () => (textReady({ role: 'patch' }).ok ? infer : null);

// ── 合起来 ───────────────────────────────────────────────────────────────────
// text：你问的那句；number：问的是哪一条（lib/talk-route.mjs whyTarget）；failure：「看原因」那件活 { reason, who, at, tries }。
// model：infer 的替身（测试注入）；null 不用模型；不给就按 textReady 看有没有。别的（leads、ledger、events、schedule……）是事实的来源，不给就读本机。
// → 对话里的一条回复 { kind: 'why', content: '原因：…\n影响：…\n能怎么办：…', actions: [点了说的那句], why: { kind, by, buttons, model?, log? } }
export function bannerAnswer(banner, k = banner.why_kind) {
  const w = banner.why, say = x => end(plainText(String(x ?? '')) || String(x ?? ''));
  const buttons = (w.links || []).filter(l => l && /^#[a-z]/.test(String(l.href || ''))).map((l, i) => ({ id: `banner:${i}`, label: String(l.label), href: String(l.href) }));
  const content = [['哪件事', w.what], ['卡在哪一步', w.step], ['原因', w.cause], ['影响', w.effect], ['能怎么办', w.fix]].filter(([, v]) => v).map(([n, v]) => `${n}：${say(v)}`).join('\n');
  return { kind: 'why', content, actions: [], why: { kind: k, by: 'banner', buttons, banner: banner.kind } };
}
export async function explainWhy(text, { now = Date.now(), number = null, kind = null, failure = null, model, timeoutMs = 60000, ...deps } = {}) {
  const src = sources({ now, ...deps });
  const banner = failure ? null : bannerOf(text, src.blockers() || []);
  const k = failure ? 'task' : WHY_KINDS.includes(kind) ? kind : banner ? banner.why_kind : whyKind(text, { number });
  // 顶上那一条带着完整内容（lib/blockers.mjs why）：照它答——哪件事、卡在哪一步、原因、影响、能怎么办，证据和入口画成按钮。
  // 不交给模型改写（改写会缩回横条上那一句，0.1.6 负责人：「点『看原因』，出来的还是这句话」）。
  if (banner?.why) return bannerAnswer(banner, k);
  const facts = collectFacts(k, { src }, { number, failure, banner: banner && { kind: banner.kind, text: banner.text, ...(banner.gone ? { gone: true } : {}) } });
  const draft = ruleAnswer(k, facts), limit = facts.schedule?.limit || 40;
  const offered = uniq([...draft.buttons, ...(KIND_LINKS[k] || [])]).filter(id => fixButton(id, { limit }));
  let ans = draft, by = 'rule';
  const write = k === 'local_ai' ? null : model === undefined ? defaultModel() : model;
  if (typeof write === 'function') {
    try {
      const out = await withTimeout(Promise.resolve(write(whyPrompt(text || '看原因', facts, draft, offered, { limit }), `why-${k}-${now}`, whySchema(offered), { role: 'patch', step: 'explain', what: '讲原因' })), timeoutMs);
      const ok = checkWhy(out, { facts, draft, offered });
      if (ok) { ans = ok.buttons.length || !draft.buttons.length ? ok : { ...ok, buttons: draft.buttons }; by = 'model'; }
    } catch (e) { noteSwallowed('explain.model', e, { doing: '让模型说清原因', then: '用规则写的那一版' }); }
  }
  const buttons = ans.buttons.map(id => fixButton(id, { limit })).filter(Boolean);
  // 运行记录在哪个文件不写进回答（下面有「看运行日志」）；规则版拼进来的原因里带的底座 id、路径也换成人话。
  const say = x => end(plainText(x) || x);
  return {
    kind: 'why', content: `原因：${say(ans.cause)}\n影响：${say(ans.effect)}\n能怎么办：${say(ans.fix)}`,
    actions: buttons.filter(b => b.say).map(b => b.say),
    why: { kind: k, by, buttons, ...(banner ? { banner: banner.kind } : {}), ...(facts.model?.backend ? { model: facts.model.backend } : {}), ...(facts.log ? { log: facts.log } : {}), ...(facts.error_kind ? { error_kind: facts.error_kind } : {}) },
  };
}
