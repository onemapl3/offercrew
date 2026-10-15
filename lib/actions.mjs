// 对外动作（线 H，design/architecture-review/04-改造契约与分工.md 2.3、2.5）：发信、发私信、预填、提交、读信。
//
// 一条路：
//   入口（收件箱 / 任务卡 / 对话 / 手机 / 指挥台 / 定时）
//     → requestAction(kind, input, { origin, confirm })：只在这里认要做什么、过闸
//     → lib/capabilities.mjs whoDoes(kind)：谁来做（App 和命令行都一样：引擎）；做不了就 blocked 加 fix
//     → actions 表：approved → claimed → done | uncertain | failed | cancelled（表由 lib/db.mjs 建）
//     → worker（bin/worker.mjs，引擎自己起，不经本机 AI）：claim() 领走 → 做（不占全局锁）→ 核对对面真的变了 → settle() 回执
//     → 一件活（lib/jobs.mjs）：动作的状态一变，就经 jobs.transition 带动它（drive）
//
// requestAction 返回四种之一：
//   { needs_confirm, preview, fingerprint }   还没确认，或者确认的那一份和现在的对不上（changed: true）
//   { blocked, reason, fix }                  过不了闸：能力、红线、资料、额度、平台字数……
//   { queued, job_id, action_id }             排上了，worker 已经叫起来
//   { done, job_id, receipt }                 同一件已经做完了（idem_key 一样）
//
// 闸都挂在这里，从哪个入口进来都得过（01 根 5：以前守在入口上，换个入口就漏）：
//   能力（whoDoes）→ 这一种动作自己的准备（找草稿、找岗位、算预览和指纹）→ 红线（BOSS、脉脉默认关；自动提交关着不提交）
//   → 资料门 → 额度 → 平台字数（脉脉附言 50 字）→ 确认绑指纹（confirm 必须等于你看到的那一份的指纹）。
//   批准了就发，夜里也一样（静默时段只是不监听、不提醒；负责人 10-06）。not_before 只给「隔一会儿再试」用。
//
// 每一种动作的细节（草稿在哪、怎么写旧文件）在 lib/action-kinds.mjs 注册：{ kind, member, confirm, prepare, commit }。
import { spawnChild } from './spawn.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, tx, dbExists, toJson, fromJson, CLAIMABLE, FRESH } from './db.mjs';
import * as jobs from './jobs.mjs';
import { whoDoes, identity } from './capabilities.mjs';
import { root, file, today } from './store.mjs';
import { sandboxed } from './sandbox.mjs';
import { event } from './events.mjs';

export const KINDS = ['send_email', 'send_dm', 'prefill', 'submit', 'read_mail'];
export const STATES = ['requested', 'approved', 'claimed', 'done', 'uncertain', 'failed', 'cancelled'];
export const OPEN = ['requested', 'approved', 'claimed', 'uncertain'];
// 演示 / 沙盒里模拟完成的回执（lib/capabilities.mjs whoDoes 给的 'sandbox' 执行者）。
export const SANDBOX_DONE = { send_email: '演示：没有真的发出邮件', send_dm: '演示：没有真的发出私信', prefill: '演示：没有真的填表', submit: '演示：没有真的提交', read_mail: '演示：没有真的读信' };
const iso = t => new Date(t ?? Date.now()).toISOString();
export const newActionId = (now = Date.now()) => `a_${Math.floor(now).toString(36).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`;
const row = r => r && { ...r, payload: fromJson(r.payload), receipt: fromJson(r.receipt) };
// 压住（hold：'needs_login:<账号>' 这样）和到点（not_before）是 actions 的两列；领走的条件是 db.mjs 的 CLAIMABLE。
const holdOf = a => a?.hold || null;

// ── 批准太久的不自动做（升级前的红线，线 F）─────────────────────────────────────
// 往外的动作（发信、私信、预填、提交）批准超过 24 小时还没被领走：不自动做，压成 hold 'stale:'，那件活「等你」，收件箱来一封
// 「这是 N 天前批准的，还要发 / 投吗？」（lib/stale-approvals.mjs）。你点一下按现在的内容重新确认、指纹重新绑；也可以不要了。
// 来源都一样：旧版迁进来的发送请求（lib/jobs-migrate.mjs）、旧版批准了没预填的投递（lib/legacy-hands.mjs，批准时间照线索上的）、
// 平常排着排过了 24 小时的（夜里压着、等登录、放回去重做……）。批准时间是 approved_at 列；空的（旧版里时间不明）一律算太久。
// 领走那一条 UPDATE 里就带着 FRESH 条件，事先没扫到也领不走；扫（holdStale）只是把它摆成「等你」、让你看见。
export const STALE_MS = 24 * 3600000;
export const OUTBOUND = ['send_email', 'send_dm', 'prefill', 'submit'];
export const STALE = 'stale';
const cutoff = now => iso(now - STALE_MS);
export const isStaleHeld = a => String(a?.hold || '').startsWith(`${STALE}:`);
export const isStale = (a, now = Date.now()) => !!a && OUTBOUND.includes(a.kind) && a.state === 'approved' && (!a.approved_at || a.approved_at < cutoff(now));
export const staleWhat = id => ({ label: '再看一眼', ask_id: `${STALE}:${id}` });
const daysAgo = (a, now) => (a.approved_at ? Math.max(1, Math.floor((now - Date.parse(a.approved_at)) / 86400000)) : null);
export const staleReason = (a, now = Date.now()) => `${daysAgo(a, now) ? `这是 ${daysAgo(a, now)} 天前批准的` : '这是旧版里批准的'}，要你再确认一次`;
// 把太久的摆成「等你」。ids：只看这几条。返回压住了几条。
export function holdStale({ now = Date.now(), ids = null } = {}) {
  if (!dbExists()) return { held: 0, ids: [] };
  const rows = (ids ? [].concat(ids).map(getAction) : db().prepare(`SELECT * FROM actions WHERE state = 'approved' AND hold IS NULL AND kind IN (${OUTBOUND.map(() => '?').join(', ')})`).all(...OUTBOUND).map(row))
    .filter(a => a && !a.hold && isStale(a, now));
  const out = [];
  for (const a of rows) {
    const r = db().prepare("UPDATE actions SET hold = ?, claimed_by = NULL, updated_at = ? WHERE id = ? AND state = 'approved' AND hold IS NULL").run(`${STALE}:${a.approved_at || ''}`, iso(now), a.id);
    if (!r.changes) continue;
    driveOrSay(a.job_id, 'waiting_you', { reason: staleReason(a, now), what: staleWhat(a.id), now }, `压住太久的 ${a.id}`);
    out.push(a.id);
  }
  return { held: out.length, ids: out };
}

// ── 每一种动作的规格 ─────────────────────────────────────────────────────────
// prepare(input, ctx) → { title, target, payload, preview, fingerprint, idem, platform?, words?, receipt? } 或 { blocked, reason, fix }
// commit(action, prepared, ctx)：批准记下以后，写旧文件里那一份（这一轮草稿、回执还在原来的文件里）。可以返回 { held } 把动作压住等你。
const SPECS = new Map();
export function registerKind(spec) { SPECS.set(spec.kind, spec); return spec; }
export const specOf = kind => SPECS.get(kind) || null;
// 规格由 lib/action-kinds.mjs 登记（它在 domain，引了很多旧模块；这里是 core，不往上引它）。要用规格的几样（requestAction、reconcile、
// tick、specOf）从 lib/action-kinds.mjs 引：引到它们就一定先登记好了。测试可以先 registerKind 假的。
function needSpecs() { if (!SPECS.size) throw Error('对外动作的规格还没登记：requestAction / reconcile / tick 从 lib/action-kinds.mjs 引'); }

// ── 共用的闸（按顺序）：每个返回 null 或 { reason, fix } ─────────────────────
export const GATES = [];
export function registerGate(name, fn) { GATES.push({ name, fn }); }

// ── 叫醒 worker ──────────────────────────────────────────────────────────────
// 默认：detached 起 bin/worker.mjs --kind <kind>；同一进程里同一种只起一个，另一个进程里的由 claim() 的原子领取挡住重复。
const children = new Map();
let kicker = null;
export function setKicker(fn) { kicker = fn; }
export function kickWorker(kind, { spawnFn = spawnChild } = {}) {
  if (kicker) return kicker(kind);
  // 演示 / 沙盒：不起 worker；排着的（放开的、到点的）就地模拟完成。
  if (sandboxed()) { for (const a of claimAll(kind)) settle(a.id, 'done', { summary: SANDBOX_DONE[kind] || '演示：没有真的做', receipt: { sandbox: true } }); return false; }
  const c = children.get(kind);
  if (c && c.exitCode === null && !c.killed) return true;
  try {
    fs.mkdirSync(file(`runs/${today()}/worker`), { recursive: true });
    const out = fs.openSync(file(`runs/${today()}/worker/${kind}-${Date.now()}.log`), 'a');
    const child = spawnFn(process.execPath, ['bin/worker.mjs', '--kind', kind], { cwd: root, detached: true, stdio: ['ignore', out, out] });
    child.unref?.();
    children.set(kind, child);
    return true;
  } catch (e) { console.error(`[actions] 起 ${kind} worker 没成（动作留着，下一拍 tick 再起）：${e.message}`); return false; }
}

// ── 带动那件活 ───────────────────────────────────────────────────────────────
// 动作的状态一变，那件活跟着走到对应的状态；中间要经过哪几步按转移表补齐（比如 failed → 重试 → queued → running）。
const PATH = {
  queued: { failed: ['retry'], waiting_you: ['resume'], running: ['requeue'], cancelled: null, done: null },
  running: { queued: ['start'], failed: ['retry', 'start'], waiting_you: ['resume', 'start'] },
  done: { running: ['finish'], queued: ['start', 'finish'], failed: ['retry', 'start', 'finish'], waiting_you: ['resume', 'start', 'finish'] },
  failed: { running: ['fail'], queued: ['fail'], waiting_you: ['resume', 'fail'] },
  waiting_you: { running: ['wait'], queued: ['wait'], failed: ['retry', 'wait'] },
  cancelled: { running: ['cancel'], queued: ['cancel'], waiting_you: ['cancel'], failed: ['retry', 'cancel'] },
};
export function drive(jobId, to, data = {}) {
  const j = jobs.get(jobId);
  if (!j || j.state === to) return j;
  const steps = PATH[to]?.[j.state];
  if (!steps) return j; // 到了终点的不再动（做完了的不会因为晚到的回执变回去）
  let cur = j;
  for (const ev of steps) {
    const d = ev === 'finish' ? { result: data.result, now: data.now } : ev === 'fail' ? { reason: data.reason, now: data.now }
      : ev === 'wait' ? { reason: data.reason, what: data.what, now: data.now } : ev === 'start' ? { pid: data.pid ?? null, now: data.now }
      : ev === 'cancel' ? { reason: data.reason, now: data.now } : ev === 'requeue' ? { reason: data.reason, not_before: data.not_before, resource_wait: data.resource_wait, now: data.now }
      : { now: data.now, note: data.note };
    cur = jobs.transition(jobId, ev, d);
  }
  return cur;
}

// 带动那件活失败了（转移表走不到、活不见了）：不吞——记一条看得见的事件，再把错抛出去，让这一次领走 / 回执 / 放开一起失败（J 扫描，根 3：
// 以前吞掉，动作和那件活对不上，卡片说一套、动作是另一套）。
function driveOrSay(jobId, to, data, what) {
  try { return drive(jobId, to, data); }
  catch (e) {
    const msg = `动作带不动那件活（${what} → ${to}）：${String(e.message || e).slice(0, 120)}`;
    try { event('system', 'actions', 'fail', msg); } catch (e2) { console.error('[actions] 事件也没记下：', e2.message); }
    throw Object.assign(Error(msg), { cause: e });
  }
}

// ── 读 ───────────────────────────────────────────────────────────────────────
export const getAction = id => dbExists() ? row(db().prepare('SELECT * FROM actions WHERE id = ?').get(id)) : null;
export const byIdem = key => dbExists() && key ? row(db().prepare('SELECT * FROM actions WHERE idem_key = ?').get(key)) : null;
export function listActions({ kind = null, state = null, job_id = null, limit = 500 } = {}) {
  if (!dbExists()) return [];
  const where = [], args = [];
  const many = (col, v) => { const a = [].concat(v).filter(x => x != null); if (a.length) { where.push(`${col} IN (${a.map(() => '?').join(', ')})`); args.push(...a); } };
  many('kind', kind); many('state', state); many('job_id', job_id);
  return db().prepare(`SELECT * FROM actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id LIMIT ${Math.max(1, Math.min(limit, 5000))}`).all(...args).map(row);
}
// 一张卡 / 一条线索上还没完的那件（入口用来回「已经排着了」）。
export const heldOf = holdOf;
// 往动作的 payload 里补字段（比如批准后记下的发送请求 id，worker 按它找那一行）。
export function setPayload(id, patch, { now = Date.now() } = {}) {
  const a = getAction(id);
  if (!a) return null;
  db().prepare('UPDATE actions SET payload = ?, updated_at = ? WHERE id = ?').run(toJson({ ...(a.payload || {}), ...patch }), iso(now), id);
  return getAction(id);
}
export const openFor = (kind, target) => listActions({ kind, state: OPEN }).filter(a => a.target === target);
// 这个对象上有没有过这几种动作（不管什么状态）：旧批准转预填（lib/legacy-hands.mjs）只转账上从没有过动作的。
export const everFor = (kinds, target) => dbExists() && !!target && !!db().prepare(`SELECT 1 FROM actions WHERE target = ? AND kind IN (${[].concat(kinds).map(() => '?').join(', ')}) LIMIT 1`).get(target, ...[].concat(kinds));

// 你要同一件再做一遍（投递卡「再试一次」、预填好的那一页关了「重新预填」，lib/apply-retry.mjs）：这个对象上做完 / 失败 / 取消了的
// 那几条让出 idem_key（改成 idem_key#id，记录留着），下一次 requestAction 才会另起一条，不回「已经做完了」。开着的不动。
export function retireDone(kind, target, { now = Date.now() } = {}) {
  if (!dbExists() || !target) return 0;
  return db().prepare("UPDATE actions SET idem_key = idem_key || '#' || id, updated_at = ? WHERE kind = ? AND target = ? AND state IN ('done', 'failed', 'cancelled') AND idem_key NOT LIKE '%#%'")
    .run(iso(now), kind, target).changes;
}

// 给你看过的那一份（同一个工作台进程里，30 分钟内有效）。
const SHOWN = new Map(), SHOWN_MS = 30 * 60000;
const shownSet = (key, fp, now) => { SHOWN.set(key, { fp, at: now }); if (SHOWN.size > 500) SHOWN.delete(SHOWN.keys().next().value); };
const shownGet = (key, now) => { const x = SHOWN.get(key); return x && now - x.at < SHOWN_MS ? x.fp : null; };
// 页面在别处已经把这一份给你看过（比如收件箱的信上就是全文）：记下来，之后「确认」认它。
export function markShown(kind, target, fingerprint, { now = Date.now() } = {}) { if (fingerprint) shownSet(`${kind}:${target}`, fingerprint, now); }

// ── 入口：requestAction ─────────────────────────────────────────────────────
const blocked = (reason, fix = null, extra = {}) => ({ blocked: true, reason, fix, ...extra });
// job_id：这件事已经有一件活（任务卡自己那件、操作台这一次的那件）：动作挂在它上面，不另开。
// 被拦下（blocked）而这件事已经有一件活（job_id，任务卡自己那件）：那件活照实落下——要你做点什么（有 fix）记「等你」并带上去处，
// 否则记「失败」带上原因（J 旅程 8b：投递被拒，卡上却一直写「排队中」）。没有 job_id 的不开新活。
export async function requestAction(kind, input = {}, opts = {}) {
  const r = await requestOne(kind, input, opts);
  const j = r?.blocked && opts.job_id ? jobs.get(opts.job_id) : null;
  if (j && !['done', 'failed', 'cancelled'].includes(j.state)) {
    const now = opts.now ?? Date.now();
    if (r.fix) driveOrSay(j.id, 'waiting_you', { reason: r.reason, what: { label: r.fix.label, href: r.fix.href }, now }, `拦下 ${kind}`);
    else driveOrSay(j.id, 'failed', { reason: r.reason, now }, `拦下 ${kind}`);
  }
  return r;
}
// legacy：旧版留下的批准（比如命令行时代你回的「发 498」，lib/legacy-hands.mjs）：照样按你当时看到的那一版指纹确认，
//   批准时间是当时的（approved_at，不知道就空着＝算太久）——不当成刚刚批准的；超过 24 小时的记下但不做，收件箱里等你再确认。
async function requestOne(kind, input = {}, { origin = 'system', confirm = null, now = Date.now(), ident = null, kick = kickWorker, job_id = null, legacy = false, approved_at = null } = {}) {
  needSpecs();
  if (kind === 'send') kind = specOf('send_dm')?.kindFor?.(input) || 'send_email'; // 发哪一份草稿：按它的渠道（发送的规格带 kindFor）
  const spec = specOf(kind);
  if (!spec) throw Object.assign(Error(`不认得这个动作：${kind}`), { status: 400 });
  const ctx = { origin, now, input };
  // 1. 能力：这台机器、这种身份下谁来做；做不了就带上去哪接上。
  //    演示 / 沙盒：执行者是 'sandbox'，预览、确认照常，最后模拟完成（见第 7 步前）。
  const I = ident || identity();
  const who = whoDoes(spec.capability || kind, { ident: I });
  if (!who.worker) return blocked(who.reason, who.fix);
  // 2. 这一种动作自己的准备：找到要发的、要投的，算出预览和指纹。
  const p = await spec.prepare(input, ctx);
  if (p?.blocked) return blocked(p.reason, p.fix || null, p.extra || {});
  // 已经做过、正排着的同一件：不另开，原样回去。
  const idem = p.idem || `${kind}:${p.target}:${p.fingerprint || ''}`;
  const have = byIdem(idem);
  if (have && have.state === 'done') return { done: true, job_id: have.job_id, action_id: have.id, receipt: have.receipt, duplicate: true };
  // 同一个对象上批准太久、压着等你再确认的（stale）：你在这里按现在的内容确认，就是重新确认它（第 5 步原地刷新）；
  // 没经你确认的（preapproved：接着做、旧批准转来的）不放开它。
  const stale = p.target ? openFor(kind, p.target).filter(isStaleHeld) : [];
  const fresh = spec.confirm !== false && !p.preapproved;
  if (stale.length && !fresh) return { queued: true, held: true, duplicate: true, job_id: stale[0].job_id, action_id: stale[0].id, receipt: staleReason(stale[0], now), what: staleWhat(stale[0].id) };
  // 「再发一次」（input.resend）：上次那一封不确定发出没有（uncertain），你看过「已发送」以后要再发——不算重复，往下走、照样过闸、照样确认。
  const resend = !!input.resend && have?.state === 'uncertain' && spec.resend !== false;
  if (have && OPEN.includes(have.state) && !isStaleHeld(have) && !resend) return { queued: true, job_id: have.job_id, action_id: have.id, duplicate: true, receipt: p.dup_receipt || '已经排着了' };
  // 3. 共用的闸：红线、资料、额度、平台字数……
  for (const g of GATES) { const b = await g.fn(kind, p, ctx); if (b) return blocked(b.reason, b.fix || null, { gate: g.name }); }
  // 4. 确认绑指纹：你看到、批准的就是要做的这一份。
  //    confirm 是指纹：页面带回来的、你看到的那一份。confirm 是 true（老页面只回「确认」）：认这里上一次给你看的那一份（SHOWN），
  //    不是点下去那一刻现算的——中间改过就再给你看一眼（02a 第四节第 7 条：以前是拿当前比当前）。
  //    p.preapproved：你早先批准的那一份还有效（比如预填停下来等你补一项，补完接着做；批准按 approval_key 复核过），不再问一遍。
  if (spec.confirm !== false && !p.preapproved) {
    const key = `${kind}:${p.target}`;
    if (!confirm) { shownSet(key, p.fingerprint, now); return { needs_confirm: true, preview: p.preview, fingerprint: p.fingerprint }; }
    const said = confirm === true ? shownGet(key, now) : typeof confirm === 'object' ? confirm.fingerprint : String(confirm);
    if (!said) { shownSet(key, p.fingerprint, now); return { needs_confirm: true, preview: p.preview, fingerprint: p.fingerprint }; }
    if (said !== p.fingerprint) { shownSet(key, p.fingerprint, now); return { needs_confirm: true, changed: true, reason: '内容和你看到的那一版不一样了，请再看一眼', preview: p.preview, fingerprint: p.fingerprint }; }
  }
  // 5. 记下：一件活 + 一条动作（approved）。同一件（idem_key）只记一次；失败、取消过的同一件重新批准时另起一条。
  //    批准时间（approved_at）：就是现在；接着做的（preapproved）照你早先那次批准的时间（p.approved_at，不知道就空着＝算太久）。
  //    压着等你再确认的（stale）：原地刷新那一条——内容、指纹换成你这次看到的，批准时间是现在，放开，那件活回到排队。
  const id0 = stale.find(a => a.id === have?.id)?.id || stale[0]?.id || null;
  const at = iso(now), approvedAt = p.preapproved ? (p.approved_at ? iso(p.approved_at) : null) : legacy ? (approved_at ? iso(approved_at) : null) : at;
  let job, id;
  if (id0) {
    for (const a of stale) if (a.id !== id0) settle(a.id, 'cancelled', { reason: '你重新批准了另一份', now });
    id = id0; job = jobs.get(getAction(id0).job_id);
    tx(d => {
      if (have && have.id !== id0) d.prepare("UPDATE actions SET idem_key = idem_key || '#' || id, updated_at = ? WHERE id = ?").run(at, have.id);
      d.prepare(`UPDATE actions SET payload = ?, fingerprint = ?, idem_key = ?, worker = ?, not_before = ?, approved_at = ?, hold = NULL, reason = NULL, updated_at = ?
                 WHERE id = ? AND state = 'approved'`).run(toJson({ ...(getAction(id0).payload || {}), ...(p.payload || {}) }), p.fingerprint || null, idem, who.worker, p.not_before || null, approvedAt, at, id0);
    });
    driveOrSay(job.id, 'queued', { now }, `重新确认 ${id0}`);
  } else if (resend) {
    // 不确定的那一条原地放回去：内容、指纹换成你这次确认的，批准时间是现在；那件活从「等你」回到排队（旧版留下、没有活的补一件）。
    id = have.id; job = have.job_id ? jobs.get(have.job_id) : null;
    if (!job) job = jobs.create({ kind, member: spec.member || 'quill', title: p.title || kind, target: p.target || null, origin, now });
    tx(d => d.prepare(`UPDATE actions SET state = 'approved', job_id = ?, payload = ?, fingerprint = ?, worker = ?, not_before = ?, approved_at = ?, hold = NULL, claimed_by = NULL, reason = NULL, updated_at = ?
                       WHERE id = ? AND state = 'uncertain'`).run(job.id, toJson({ ...(have.payload || {}), ...(p.payload || {}) }), p.fingerprint || null, who.worker, p.not_before || null, at, at, id));
    driveOrSay(job.id, 'queued', { now }, `再发一次 ${id}`);
  } else {
    const mine = job_id ? jobs.get(job_id) : null;
    // 同一件（idem_key 一样）上次失败了、你重新批准：还是那件活，失败 → 重试 → 排队（卡上那件接着走，不另开一张）。
    const failedJob = !mine && have?.state === 'failed' && have.job_id ? jobs.get(have.job_id) : null;
    job = mine && !jobs.TERMINAL.has(mine.state) ? mine
      : failedJob?.state === 'failed' ? jobs.transition(failedJob.id, 'retry', { now, note: `again:${have.id}` })
      : jobs.create({ kind, member: spec.member || 'quill', title: p.title || kind, target: p.target || null, origin, now, ...(p.not_before ? { not_before: p.not_before } : {}) });
    if (p.not_before && job.state === 'queued' && failedJob) jobs.annotate(job.id, { not_before: p.not_before }, { now });
    id = newActionId(now);
    const old = have; // 失败 / 取消过的旧动作：idem_key 让出来，留着记录
    tx(d => {
      if (old) d.prepare("UPDATE actions SET idem_key = idem_key || '#' || id, updated_at = ? WHERE id = ?").run(at, old.id);
      d.prepare(`INSERT INTO actions (id, kind, job_id, target, payload, fingerprint, idem_key, state, worker, attempts, not_before, approved_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, 0, ?, ?, ?, ?)`).run(id, kind, job.id, p.target || null, toJson(p.payload || {}), p.fingerprint || null, idem, who.worker, p.not_before || null, approvedAt, at, at);
    });
  }
  let action = getAction(id);
  // 6. 写旧文件里的那一份（发送请求、线索上的批准）。写不成就是失败，照实说。
  let c = null;
  try { c = spec.commit ? await spec.commit(action, p, ctx) : null; }
  catch (e) { settle(id, 'failed', { reason: String(e.message || e).slice(0, 200), now }); return blocked(String(e.message || e).slice(0, 200)); }
  if (c?.held) { hold(id, c.held, { now }); return { queued: true, held: true, job_id: job.id, action_id: id, receipt: c.receipt || c.held.reason, what: c.held.what || null, ...(c.open ? { open: c.open } : {}) }; }
  if (c?.settled) { settle(id, c.settled.state, { ...c.settled, now }); action = getAction(id); return action.state === 'done' ? { done: true, job_id: job.id, action_id: id, receipt: action.receipt } : blocked(action.reason || '没做成'); }
  // 早先批准、已经超过 24 小时的（接着做、旧批准转来的）：记下，但不做，等你再看一眼（演示里也一样，不模拟完成）。
  if (holdStale({ now, ids: [id] }).held) { action = getAction(id); return { queued: true, held: true, job_id: job.id, action_id: id, receipt: staleReason(action, now), what: staleWhat(id) }; }
  // 演示 / 沙盒：不叫 worker，就地记成做完，回执写明是演示（什么都没有发出去）。
  if (who.worker === 'sandbox') {
    settle(id, 'done', { summary: SANDBOX_DONE[kind] || '演示：没有真的做', receipt: { sandbox: true }, now });
    return { done: true, sandbox: true, job_id: job.id, action_id: id, receipt: SANDBOX_DONE[kind] || '演示：没有真的做' };
  }
  // 7. 叫醒 worker。
  try { kick(kind); } catch (e) { console.error(`[actions] 叫醒 ${kind} worker 没成（动作已记下，下一拍 tick 再叫）：${e.message}`); }
  return { queued: true, job_id: job.id, action_id: id, receipt: c?.receipt || p.receipt || '排上了', ...(c?.open ? { open: c.open } : {}) };
}

// ── worker 用：领走、回执、压住、放开 ────────────────────────────────────────
// 领走一条：一条 UPDATE … WHERE CLAIMABLE，只有一个执行者能领到。压着的（hold）和没到点的（not_before）不领。
//   批准超过 24 小时的往外动作不领（FRESH），先摆成「等你」（holdStale）。
export function claim(kind, { pid = process.pid, now = Date.now(), id = null } = {}) {
  if (!dbExists()) return null;
  if (OUTBOUND.includes(kind)) holdStale({ now });
  const at = iso(now);
  const r = db().prepare(`UPDATE actions SET state = 'claimed', claimed_by = ?, attempts = attempts + 1, updated_at = ?
    WHERE id = (SELECT id FROM actions WHERE kind = ? ${id ? 'AND id = ?' : ''} AND ${CLAIMABLE} AND ${FRESH} ORDER BY created_at, id LIMIT 1)
    AND state = 'approved' AND ${FRESH} RETURNING *`).get(pid, at, kind, ...(id ? [id] : []), at, cutoff(now), cutoff(now));
  if (!r) return null;
  const a = row(r);
  driveOrSay(a.job_id, 'running', { pid, now }, `领走 ${a.id}`);
  return a;
}
export function claimAll(kind, opts = {}) { const out = []; for (let a; (a = claim(kind, opts));) out.push(a); return out; }

// 回执：done / uncertain / failed / cancelled。done 要带 summary（一句人话，进那件活的 result）。
//   uncertain：做了，但对面变没变核对不上——那件活「等你」（去看一眼），对账核对上了再改。
//   done 带 wait（{ reason, what }）：这个动作做完了，可那件活停在等你（预填好了停在终审 / 等你在页面上提交，第 2 步 2X）：
//   动作记 done，那件活记 waiting_you；你提交、自己投了、不投了，再由那一侧落定（lib/leads.mjs settleApplyWait）。
export function settle(id, state, { receipt = null, reason = null, summary = null, counts = null, links = null, what = null, wait = null, now = Date.now() } = {}) {
  if (!['done', 'uncertain', 'failed', 'cancelled'].includes(state)) throw Error(`bad_action_state:${state}`);
  const a = getAction(id);
  if (!a) throw Object.assign(Error(`没有这个动作：${id}`), { status: 404 });
  if (a.state === 'done' && state !== 'done') return a; // 做完的不倒退
  const rc = receipt ?? (summary ? { summary } : null);
  db().prepare('UPDATE actions SET state = ?, receipt = COALESCE(?, receipt), reason = ?, updated_at = ? WHERE id = ?')
    .run(state, toJson(rc), state === 'done' ? null : reason, iso(now), id);
  const sum = summary || rc?.summary || reason || '';
  if (state === 'done' && wait) drive(a.job_id, 'waiting_you', { reason: wait.reason, what: wait.what, now });
  else if (state === 'done') drive(a.job_id, 'done', { result: { summary: sum || '做完了', ...(counts ? { counts } : {}), ...(links ? { links } : {}) }, now });
  else if (state === 'failed') drive(a.job_id, 'failed', { reason: reason || '没做成', now });
  else if (state === 'cancelled') drive(a.job_id, 'cancelled', { reason, now });
  else drive(a.job_id, 'waiting_you', { reason: reason || '做了，但还没核对上对面有没有变', what: what || { label: '看一眼', href: '#inbox' }, now });
  return getAction(id);
}
// 压住：要你先做一件事（登录门户、登录平台）。动作回到 approved、hold = '<code>:<key>'，那件活「等你」，what 写要你做什么。
//   held：{ code: 'needs_login', key: '<账号>', reason: '要先登录 LinkedIn', what: { label: '登录', ask_id: 'login:linkedin' } }
export function hold(id, held, { now = Date.now() } = {}) {
  const a = getAction(id);
  if (!a || !['approved', 'claimed'].includes(a.state)) return a;
  const h = `${held.code}:${held.key || ''}`;
  db().prepare("UPDATE actions SET state = 'approved', claimed_by = NULL, hold = ?, updated_at = ? WHERE id = ?").run(h, iso(now), id);
  drive(a.job_id, 'waiting_you', { reason: held.reason || '要你先处理一下', what: held.what || { label: '处理', href: '#inbox' }, now });
  return getAction(id);
}
// 放开压着的（「我登好了」）：code、key 对上的那几条回到可领，那件活回到排队，叫醒 worker。返回放开了几条、哪几种。
//   ids：直接点名放开哪几条（不管压着的原因），比如「门户要你处理」那一步你做完了。
export function release({ code = 'needs_login', key = null, ids = null, kinds = null, now = Date.now(), kick = kickWorker } = {}) {
  if (!dbExists()) return { released: 0, kinds: [] };
  const want = key == null ? `${code}:%` : `${code}:${key}`;
  // 批准太久压住的（stale）只由你在收件箱里重新确认放开（lib/stale-approvals.mjs），「我登好了」、补完一项这类放开不碰它。
  const rows = (ids ? [].concat(ids).map(getAction).filter(a => a?.state === 'approved' && a.hold)
    : db().prepare("SELECT * FROM actions WHERE state = 'approved' AND hold LIKE ?").all(want).map(row)).filter(a => (!kinds || kinds.includes(a.kind)) && isStaleHeld(a) === (code === STALE));
  const ks = new Set();
  for (const a of rows) {
    db().prepare('UPDATE actions SET hold = NULL, updated_at = ? WHERE id = ?').run(iso(now), a.id);
    driveOrSay(a.job_id, 'queued', { now }, `放开 ${a.id}`);
    ks.add(a.kind);
  }
  for (const k of ks) try { kick(k); } catch (e) { console.error(`[actions] 叫醒 ${k} worker 没成（下一拍 tick 再叫）：${e.message}`); }
  return { released: rows.length, kinds: [...ks] };
}
// worker 这一次做不了、要放回去下次再领（比如浏览器暂时打不开、自动重发）：attempts 超过上限就记失败。
// retry_at：到这个时间再领（发信连不上：隔一会儿再试，不是 30 秒一次地连），那件活记「排队中，几点再发」（lib/status.mjs 照 not_before 说）。
export function requeue(id, { reason = null, max = 3, now = Date.now(), retry_at = null, resource_wait = false } = {}) {
  const a = getAction(id);
  if (!a || a.state !== 'claimed') return a;
  if (resource_wait && a.kind !== 'read_mail') throw Error('只有读信锁等待可以归还领取次数');
  if (!resource_wait && a.attempts >= max) return settle(id, 'failed', { reason: reason || `试了 ${a.attempts} 次都没成`, now });
  db().prepare("UPDATE actions SET state = 'approved', claimed_by = NULL, reason = ?, not_before = COALESCE(?, not_before), attempts = max(0, attempts - ?), updated_at = ? WHERE id = ?").run(reason, retry_at, resource_wait ? 1 : 0, iso(now), id);
  // 那件活 running → queued（jobs 的 requeue），带着几点再试和这一次的原因；历史里不留一条假的「失败」。
  driveOrSay(a.job_id, 'queued', { reason: reason || '这次没成，等下一次', not_before: retry_at, resource_wait: resource_wait ? a.id : false, now }, `放回 ${a.id}`);
  return getAction(id);
}
// 取消（你在收件箱里说「不发了」）：还没领走的直接取消；已经领走的不抢，由 worker 做完再说。
export function cancel(id, { reason = '你取消了', now = Date.now() } = {}) {
  const a = getAction(id);
  if (!a || !['requested', 'approved'].includes(a.state)) return a;
  return settle(id, 'cancelled', { reason, now });
}

// ── 对账 ─────────────────────────────────────────────────────────────────────
// 领走它的进程已经不在了：
//   发信、发私信（发没发出去说不准）→ uncertain，交给这一种的核对去查；
//   预填、读信（再做一遍不会多发东西）→ 放回去再领。
// uncertain 的：这一种注册了 verify(action) 就去核对 → 'done' | 'not_done' | 'unknown'。
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const RISKY = new Set(['send_email', 'send_dm', 'submit']);
export async function reconcile({ now = Date.now(), alive = pidAlive, kick = kickWorker } = {}) {
  needSpecs();
  const out = { orphaned: 0, verified: 0, requeued: 0 };
  for (const a of listActions({ state: 'claimed' })) {
    if (a.claimed_by && alive(a.claimed_by)) continue;
    out.orphaned++;
    if (RISKY.has(a.kind)) settle(a.id, 'uncertain', { reason: '做到一半进程没了，发没发出去要核对', now });
    else { requeue(a.id, { reason: '做到一半进程没了，重新排上', now }); kick(a.kind); out.requeued++; }
  }
  for (const a of listActions({ state: 'uncertain' })) {
    const verify = specOf(a.kind)?.verify;
    if (!verify) continue;
    let v = 'unknown';
    try { v = await verify(a, { now }); } catch (e) { console.error(`[actions] 核对 ${a.id} 出错，按核对不了算：${e.message}`); } // unknown：留着下次再核对
    if (v === 'done' || v?.state === 'done') { settle(a.id, 'done', { summary: v?.summary || '核对过了，对面确实收到了', now }); out.verified++; }
    else if (v === 'not_done' || v?.state === 'not_done') {
      // 确认没发出去：放回去重发（同一份批准，不要你再点一次）。
      db().prepare("UPDATE actions SET state = 'approved', claimed_by = NULL, reason = NULL, updated_at = ? WHERE id = ?").run(iso(now), a.id);
      driveOrSay(a.job_id, 'queued', { now }, `核对后重发 ${a.id}`);
      kick(a.kind); out.requeued++;
    }
  }
  return out;
}

// 旧版夜里批准的私信压到了早上 9 点（10-04 线 H 做的，负责人 10-06：没有这条规矩，夜里只是不监听）。升级上来还压着、
// 一次都没领过的（attempts = 0；隔一会儿再试的领过、attempts ≥ 1，不碰）：放开，这一拍就叫 worker 发。
export function releaseNightDms({ now = Date.now() } = {}) {
  if (!dbExists()) return 0;
  const rows = db().prepare("SELECT id, job_id FROM actions WHERE kind = 'send_dm' AND state = 'approved' AND attempts = 0 AND not_before IS NOT NULL AND not_before > ?").all(iso(now));
  for (const a of rows) {
    db().prepare('UPDATE actions SET not_before = NULL, updated_at = ? WHERE id = ?').run(iso(now), a.id);
    if (a.job_id) try { jobs.annotate(a.job_id, { not_before: null }, { now }); } catch (e) { console.error(`[actions] 私信 ${a.id} 那件活的到点时间没清掉（动作已放开）：${e.message}`); }
  }
  return rows.length;
}

// ── 工作台每半分钟一次 ───────────────────────────────────────────────────────
// 对账；有可领的（到点再试的、放回去重做的、刚放开的）就叫醒那一种 worker。不建库：库还没有就什么都不做。
export async function tick({ now = Date.now(), kick = kickWorker, alive } = {}) {
  if (!dbExists()) return { kicked: [] };
  const out = await reconcile({ now, kick, ...(alive ? { alive } : {}) });
  out.night = releaseNightDms({ now });
  out.stale = holdStale({ now }).held;
  const kinds = db().prepare(`SELECT DISTINCT kind FROM actions WHERE ${CLAIMABLE} AND ${FRESH}`).all(iso(now), cutoff(now)).map(r => r.kind);
  for (const k of kinds) try { kick(k); } catch (e) { console.error(`[actions] 叫醒 ${k} worker 没成（下一拍再叫）：${e.message}`); }
  return { ...out, kicked: kinds };
}
