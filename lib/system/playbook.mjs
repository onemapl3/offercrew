// System 照现成的标准做法自己处理（L 线第 2 批 2b，design/desktop-app/方案-System监工-第2批.md 第三、六、九节）。
// 一条一个情形：什么情况下做、做什么（只用现有的操作）、上限和冷却、记一行什么、怎么撤销。
// 只收能撤销、或者只读外面只写本机的；表上没有的一律不做（NEVER），按第四节交给你。
//
//   PLAYBOOK        这张表（团队页、「看原因」读得到每条的说法）
//   planSources     P2 停一直失败的招聘源 / 到点恢复
//   planTasks       P3 卡住的任务重新排、心跳没动静的收进历史、进程不在的标成丢了
//   planReruns      P4 没有对外动作的几步，因为暂时的错失败了就重跑
//   undoPlay        团队页的「撤销」「恢复」：先把状态改回去，再在动作账上记一行（lib/system/actions.mjs undoAction）
//   playbookCovers  autoRepair 改道用：这一条标准做法已经管了，不再交给本机 AI
// P1（模型熔断）在 lib/model.mjs 选底座时做（lib/system/breaker.mjs），这里只写表、管撤销。
//
// 每个 plan* 只算「要做什么」，返回 [{ play, hand, member, why, before, undo, text, act }]；动手、记账的是 lib/system/watch.mjs tickWatch。
// ctx 由 tickWatch 备好（测试直接传）：{ now, config, actions, entries, report, cards, heartbeat, ops, events, opTail, alive, opRole, paused, held, ready, deps }。
import { lines, read } from '../store.mjs';
import { dayOf } from '../tz.mjs';
import { crewName, KINDS } from '../crew.mjs';
import { sourceReason, problemKind, held } from '../discovery-source.mjs';
import { needsUserLabel, STUCK_MS } from '../executor-heartbeat.mjs';
import { ACTIONS_PATH, undoAction } from './actions.mjs';
import { closeBreaker, BREAKER_DEFAULTS } from './breaker.mjs';
import { restartable, RESTART_LINKS } from '../card-ops.mjs';

export const PLAYBOOK = [
  { id: 'P1', title: '模型按清单换下一个', when: '一个底座钥匙失效（401、403），或者连续 3 次不可重试的错（按底座算，哪位成员调都一样）', does: '这个底座先跳过 30 分钟，按清单试下一个；到点下一次真实调用先试它，好了就用回它。钥匙、额度、模型不存在、没配好这几类换了就同时来信，不悄悄换', limit: '每个底座 30 分钟；清单里只剩它一个时不跳过；一个底座一封信', log: '「X 钥匙失效，先换清单里的下一个，10:30 再试」', undo: '团队页点「恢复」：清掉熔断，下一次照清单的顺序先试它' },
  { id: 'P2', title: '停一直读不到的招聘源', when: '一个招聘源连续 3 轮读不到；整台电脑断网的那几轮不算', does: '暂停这个源 24 小时（paused 写「System：连续 3 轮读不到（原因）」），到点自动恢复，下一轮再读一次', limit: '每天最多停 3 个', log: '「招聘源 X 连续 3 轮读不到（原因），先停 24 小时」', undo: '团队页或来源页点「恢复」' },
  { id: 'P3', title: '卡住的任务重新排', when: '任务卡因为暂时的原因卡住（脚本通道忙、模型超时、锁被占）；本机 AI 的心跳十分钟没动静；操作台的脚本进程已经不在了', does: '卡放回排队一次；心跳那一行收进历史；进程不在的那一项标成丢了', limit: '同一张卡 24 小时内只重排一次', log: '「X 的卡因为脚本通道忙卡住，放回排队再试一次」', undo: '卡上「标为卡住」；心跳那一行会自己回来' },
  { id: 'P4', title: '重跑没有对外动作的一步', when: 'discover、discover-human、judge-leads、match、project-journey、metrics、preferences-rebuild、inbox 因为暂时的错（网络、锁、超时）失败了', does: '用操作台重跑这一步', limit: '同一步每天最多 2 次；预算或额度停着的时候不跑', log: '「match 因为超时没跑完，重跑一次（今天第 1 次）」', undo: '不用撤销：这几步只读外面、只写本机' },
];
// 不在表上的：v0.1 一律不自己做。
export const NEVER = ['清空、重置、删除', '改设置', '重新判断已经判过的线索', '丢弃宿主任务', '所有往外发的', '所有会拉起本机 AI 的'];

// 数字都在 config/host.json system_playbook（模板 config/host.example.json 里有缺省值）。
export const PLAYBOOK_DEFAULTS = { ...BREAKER_DEFAULTS, source_pause_hours: 24, source_pause_rounds: 3, source_pauses_per_day: 3 };
export function playbookConfig(host = read('config/host.json', {})) {
  const c = { ...PLAYBOOK_DEFAULTS, ...(host?.system_playbook || {}) }, n = (v, d) => Math.max(1, Number(v) || d);
  return { source_pause_hours: n(c.source_pause_hours, 24), source_pause_rounds: n(c.source_pause_rounds, 3), source_pauses_per_day: Math.max(0, Number(c.source_pauses_per_day ?? 3)), model_breaker_minutes: n(c.model_breaker_minutes, 30), model_breaker_failures: n(c.model_breaker_failures, 3) };
}
// 定死的上限（负责人没要求做成配置）：一张卡 24 小时只重排一次，一步每天最多重跑 2 次，只看最近 3 小时的失败。
export const CARD_REQUEUE_MS = 24 * 3600e3;
export const RERUNS_PER_DAY = 2;
export const RERUN_WINDOW_MS = 3 * 3600e3;

// 周期里那一步（事件的 step）→ 操作台的操作。只有这几步：只读外面、只写本机，不发信、不投递、不拉起本机 AI。
export const RERUN_OPS = { discover: 'discover', 'discover-human': 'discover-human', 'judge-leads': 'judge-leads', match: 'match', metrics: 'metrics', 'preferences-rebuild': 'preferences-rebuild', inbox: 'inbox' };
const MODEL_STEPS = new Set(['judge-leads', 'match']);
// 暂时的错：网络、锁、超时、脚本通道忙。
export const TRANSIENT = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONN(?:REFUSED|RESET)|ETIMEDOUT|socket hang up|network|TLS|网络|another_radar_writer_running|写锁|另一个写入进程|一次只跑一个|还在运行|timeout|timed out|超时|未结束|没按时/i;
// 卡：只重排脚本和模型做的；投递、发出（往外的）、本机 AI 做的（executor）、目标不碰。
const REQUEUE_KINDS = new Set(Object.entries(KINDS).filter(([k, v]) => ['script', 'model'].includes(v.how) && !['apply', 'send'].includes(k)).map(([k]) => k));

const T = s => Date.parse(s || '') || 0;
const iso = t => new Date(t).toISOString();
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const mine = (ctx, play) => (ctx.actions || []).filter(a => a.play === play && !a.undo_of);
const bySystem = p => typeof p === 'string' && /^System/.test(p);

// ── P2 招聘源 ───────────────────────────────────────────────────────────────
export function planSources(ctx) {
  const { now, config: cfg, entries = [], report = {}, deps } = ctx, out = [];
  const pauses = mine(ctx, 'P2').filter(a => a.undo?.how === 'resume_source');
  const lastPause = name => pauses.filter(a => a.undo.name === name).at(-1);
  // 到点：System 停的、停满了的，恢复扫描，让下一轮马上再读一次。
  for (const e of entries) {
    if (!bySystem(e.paused)) continue;
    const p = lastPause(e.name);
    if (!p || T(p.undo.until) > now) continue;
    out.push({ play: 'P2', hand: `source:${e.name}`, member: 'scout', why: `停满 ${cfg.source_pause_hours} 小时`, before: { paused: e.paused }, undo: null,
      text: `招聘源 ${e.name} 停满 ${cfg.source_pause_hours} 小时，恢复扫描，下一轮再读一次`, act: () => deps.updateSource({ name: e.name, set: { paused: false, retest: true }, by: 'system', now }) });
  }
  // 停：连续 N 轮读不到（扫描在整台电脑断网的那几轮不往上数，lib/discovery-source.mjs recordOutage）；最近这一轮是整体断网，这一拍谁都不停。
  if (report?.network_outage) return out;
  let left = cfg.source_pauses_per_day - pauses.filter(a => dayOf(a.at) === dayOf(now)).length;
  for (const e of entries) {
    if (left <= 0) break;
    const n = Number(e.consecutive_failures) || 0;
    if (e.paused || n < cfg.source_pause_rounds) continue;
    // 官网有反爬、或者没有能自动读的列表：扫描本来就一周才看一次，停它没有用（10-05）。
    if (held(problemKind(e.last_error))) continue;
    // 停过又恢复的：恢复以后又读失败了才再停（停着的那段时间没读，失败次数还是停之前的）。
    const p = lastPause(e.name);
    if (p && !(T(e.last_error_at) > T(p.at))) continue;
    const why = sourceReason(e.last_error) || '原因没记下', until = now + cfg.source_pause_hours * 3600e3;
    out.push({ play: 'P2', hand: `source:${e.name}`, member: 'scout', why: `连续 ${n} 轮没读到：${cut(e.last_error, 120) || why}`,
      before: { consecutive_failures: n, last_error: cut(e.last_error, 160) || null, status: e.status || null }, undo: { how: 'resume_source', name: e.name, until: iso(until) },
      text: `招聘源 ${e.name} 连续 ${n} 轮读不到（${why}），先停 ${cfg.source_pause_hours} 小时，到点自动再试`,
      act: () => deps.updateSource({ name: e.name, set: { paused: cut(`System：连续 ${n} 轮读不到（${why}）`, 60) }, by: 'system', now }) });
    left--;
  }
  return out;
}

// ── P3 卡住的任务 ────────────────────────────────────────────────────────────
export function planTasks(ctx) {
  const { now, cards = [], heartbeat = { tasks: {} }, ops = {}, deps } = ctx, out = [];
  const requeued = new Set(mine(ctx, 'P3').filter(a => a.undo?.how === 'mark_stuck' && now - T(a.at) < CARD_REQUEUE_MS).map(a => a.undo.card));
  for (const c of cards) {
    if (c.status !== 'stuck' || c.manual || c.mac_hold || !REQUEUE_KINDS.has(c.kind) || requeued.has(c.id)) continue;
    // 跑过脚本、脚本自己失败的（links.op_id）原因在日志里，归 P4 看那一步；这里只管没开起来的（通道忙、锁被占、模型超时）。
    if (c.links?.op_id || c.links?.job_id || !TRANSIENT.test(c.detail || '')) continue;
    // 放回排队真能再开一次的才重排（第 6 轮开箱 11：Writer 的卡记了「放回排队再试一次」，卡还是「没做成」，其实什么也没再做）：
    // Writer 的活状态看对话里那几条消息，再试一次是对话里的按钮，由你点（一次长改写要花一次模型额度）；没有固定做法的几类（写消息、改简历……）放回去也没人接。
    if (!restartable(c)) continue;
    const who = crewName(c.owner) || '团队';
    out.push({ play: 'P3', hand: `card:${c.id}`, member: c.owner || 'patch', why: cut(c.detail, 120), before: { status: c.status, detail: cut(c.detail, 120), tries: c.tries || 0 }, undo: { how: 'mark_stuck', card: c.id },
      text: `${who} 的卡「${cut(c.title || c.kind, 24)}」因为暂时的原因卡住，放回排队再试一次`,
      act: () => {
        const x = { ...c, links: { ...(c.links || {}) }, steps: [...(c.steps || [])] };
        Object.assign(x, { status: 'queued', tries: 0, manual: false, auto: true, detail: '', retry: { by: 'patch', at: iso(now), why: cut(c.detail, 60) } });
        for (const f of RESTART_LINKS) delete x.links[f]; // 不摘掉，同步时还是照上一次的结果推出「没做成」
        deps.addStep(x, `System：刚才卡在「${cut(c.detail, 40)}」，是暂时的，放回排队再试一次`, { who: 'patch', at: now });
        deps.saveCards([x]);
      } });
  }
  // 本机 AI 的心跳十分钟没动静：那一行收进历史（要你做的那几步不算，那是在等你）。
  for (const [key, t] of Object.entries(heartbeat.tasks || {})) {
    if (['done', 'failed'].includes(t.status) || needsUserLabel(t.step) || now - T(t.updated_at || t.started_at) < STUCK_MS) continue;
    const min = Math.round((now - T(t.updated_at || t.started_at)) / 60000);
    out.push({ play: 'P3', hand: `task:${key}`, member: 'patch', why: `${min} 分钟没有新进展，停在「${cut(t.step, 30) || '没记下的一步'}」`, before: { status: t.status, step: t.step || null, updated_at: t.updated_at || null }, undo: null,
      text: `本机 AI 的「${cut(t.task, 30)}」${min} 分钟没动静，这一行收进历史；它再报进展会自己回来`, act: () => deps.clearTask({ executor: t.executor, task: t.task, now }) });
  }
  // 操作台那个一次只跑一个的脚本：进程已经不在了，记录还停在运行中 → 标成丢了（现有的 opsStatus）。
  const cur = ops.current;
  if (cur?.pid && !ctx.alive(cur.pid))
    out.push({ play: 'P3', hand: `op:${cur.op}`, member: 'patch', why: '进程已经不在了，记录还停在运行中', before: { op: cur.op, pid: cur.pid, started_at: cur.started_at || null }, undo: null,
      text: `「${cut(cur.label || cur.op, 30)}」的进程已经不在了，标成丢了，脚本通道空出来`, act: () => deps.opsStatus() });
  return out;
}

// ── P4 重跑一步 ─────────────────────────────────────────────────────────────
// 最近 3 小时里、这一步最新的那一下是失败（周期的事件，或者操作台的记录），错是暂时的，就重跑。
export function latestFailures(ctx) {
  const { now, events = [], ops = {} } = ctx, last = new Map();
  for (const e of events) {
    const op = RERUN_OPS[e.step];
    if (!op || !['fail', 'ok', 'skip', 'start', 'waiting_user'].includes(e.status)) continue;
    if (!last.has(op) || T(e.ts) >= T(last.get(op).at)) last.set(op, { op, at: e.ts, failed: e.status === 'fail', error: e.error || e.msg || '' });
  }
  for (const h of ops.history || []) {
    const op = RERUN_OPS[h.op] === h.op ? h.op : null, at = h.finished_at || h.started_at;
    if (!op || (last.has(op) && T(last.get(op).at) > T(at))) continue;
    last.set(op, { op, at, failed: h.status === 'fail', rec: h });
  }
  return [...last.values()].filter(f => f.failed && now - T(f.at) < RERUN_WINDOW_MS);
}
export function planReruns(ctx) {
  const { now, ops = {}, deps } = ctx;
  if (ops.current) return []; // 脚本通道忙着：下一拍再看
  const done = mine(ctx, 'P4');
  for (const f of latestFailures(ctx)) {
    const handled = done.some(a => a.hand === `op:${f.op}` && a.before?.failed_at === f.at);
    const today = done.filter(a => a.hand === `op:${f.op}` && dayOf(a.at) === dayOf(now)).length;
    if (handled || today >= RERUNS_PER_DAY) continue;
    const error = f.rec ? (ctx.opTail?.(f.rec) || '') : f.error;
    if (!TRANSIENT.test(error)) continue;
    const role = ctx.opRole?.(f.op) || 'patch';
    if (ctx.paused?.(role)) continue; // 这位成员你暂停了
    if (MODEL_STEPS.has(f.op) && (ctx.held?.(f.op) || !ctx.ready?.(role))) continue; // 预算到了、额度停着、没有能用的模型
    const kind = /another_radar_writer_running|写锁|另一个写入进程|一次只跑一个|还在运行/.test(error) ? '锁被占着' : /timeout|timed out|超时|未结束|没按时/i.test(error) ? '超时' : '网络不通';
    // 要模型的那两步超时了不重跑：周期整轮的预算用完时掐掉的也记成超时，分不出来；重跑一次最长 60 分钟、要花模型额度
    // （负责人 10-03 在控制额度）。网络、锁照旧重跑；超时的留给下一轮周期接着判。
    if (MODEL_STEPS.has(f.op) && kind === '超时') continue;
    return [{ play: 'P4', hand: `op:${f.op}`, member: role, why: `${f.op} 因为${kind}没跑完：${cut(error, 120)}`, before: { failed_at: f.at, error: cut(error, 160) }, undo: null,
      text: `${f.op} 因为${kind}没跑完，重跑一次（今天第 ${today + 1} 次）`, act: () => deps.runOp(f.op, { now }) }];
  }
  return [];
}

// ── autoRepair 改道 ──────────────────────────────────────────────────────────
// 这一条标准做法已经管了：本机 AI 打开了也不再打包成 system_fix（P3 收掉没动静的心跳那一行）。
export function playbookCovers(t = {}) {
  return t.source === 'executor' && !/异常退出|blocked/.test(`${t.reason || ''}`);
}

// ── 撤销 ─────────────────────────────────────────────────────────────────────
// 先把状态改回去，再记一行。deps：{ updateSource, sourceEntries, moveCard }（团队页传真的，测试传假的）。
export async function undoPlay(id, { by = 'you', now = Date.now(), deps = {} } = {}) {
  const all = lines(ACTIONS_PATH), row = all.find(r => r.id === id && !r.undo_of);
  if (!row) throw Error('没有这一条');
  if (!row.undo) throw Error('这一条不用撤销');
  if (all.some(r => r.undo_of === id)) return { already: true, row };
  const u = row.undo;
  let text = null;
  if (u.how === 'close_breaker') { closeBreaker(u.key); text = `恢复了：${u.key} 照清单的顺序先试`; }
  else if (u.how === 'resume_source') {
    const e = (deps.sourceEntries?.() || []).find(x => x.name === u.name);
    if (e && bySystem(e.paused)) await deps.updateSource({ name: u.name, set: { paused: false, retest: true }, by: by === 'you' ? 'user' : 'system', now });
    text = `恢复了招聘源 ${u.name}，下一轮再读一次`;
  } else if (u.how === 'mark_stuck') { try { deps.moveCard(u.card, { status: 'stuck', now }); } catch (e) { if (e.status !== 404) throw e; } text = '撤销了重排：这张卡标回卡住'; }
  else throw Error('这一条撤销不了');
  return undoAction(id, { by, now, text });
}
