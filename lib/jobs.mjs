// 一件活（线 S，契约 2.2）：一件活一条记录、一台状态机。所有入口和页面只经这里读写它的状态。
//   状态      queued、running、done、failed、waiting_you、cancelled（「没有」就是没有这一行）。
//   改状态    只经 transition(id, event, data)；转移表 MOVES 写在这一处，不合法的转移直接报错；每次转移追加一行 job_events。
//   看门      watch()：queued 超过 10 分钟没人领 → failed「没人接这件活：…」；running 的进程已经不在了 → failed「进程意外退出」。
//   读        get / byRef / list / events：数据库还没建过（新装、读请求）就当没有活，不为了读去建文件。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { file } from './paths.mjs';
import { db, tx, dbExists, toJson, fromJson } from './db.mjs';
import { STATES, TERMINAL } from './status.mjs';
import { reasonOf } from './wait-reason.mjs';

export { STATES, TERMINAL };
export const MEMBERS = ['scout', 'lens', 'tailor', 'quill', 'owl', 'patch', 'user'];
export const ORIGINS = ['inbox', 'card', 'chat', 'phone', 'schedule', 'system'];

// 事件 → { from: 允许的起点, to: 终点, need: 必须带的字段 }。create 没有起点。
export const MOVES = {
  create: { from: [], to: 'queued' },
  start: { from: ['queued'], to: 'running' },
  finish: { from: ['running'], to: 'done', need: ['result'] },
  fail: { from: ['queued', 'running'], to: 'failed', need: ['reason'] },
  wait: { from: ['queued', 'running'], to: 'waiting_you', need: ['reason', 'what'] },
  resume: { from: ['waiting_you'], to: 'queued' },
  retry: { from: ['failed'], to: 'queued' },
  // 这一次没做成、放回去过一会儿再做（发信连不上：隔 10 分钟再试，最多 3 次）：running 直接回 queued，带 not_before（几点再试）
  // 和这一次的原因。不经过 failed——以前要 fail 再 retry，历史里留一条假的「失败」，卡上一边写失败一边写排队。试满了才 fail。
  requeue: { from: ['running'], to: 'queued' },
  cancel: { from: ['queued', 'running', 'waiting_you'], to: 'cancelled' },
};
export const STALE_QUEUED_MS = 10 * 60 * 1000;
// 周期事件的 actor 固定是 heartbeat，归属要认这次运行的账；手点的周期沿用 op 那件活。
export function forRun(runId) {
  if (typeof runId !== 'string' || !runId || !dbExists()) return null;
  const direct = byRef(`cycle:${runId}`) || (runId.startsWith('ops-') ? byRef(`op:${runId.slice(4)}`) : null);
  if (direct) return direct;
  // 从任务卡启动的整轮 ref 是 card:，运行 ID 留在子步骤上；成员历史也必须找到同一笔更正后的账。
  const prefix = `cycle:${runId}:`;
  const parents = db().prepare('SELECT DISTINCT parent FROM jobs WHERE parent IS NOT NULL AND substr(ref, 1, ?) = ? LIMIT 2').all(prefix.length, prefix);
  return parents.length === 1 ? get(parents[0].parent) : null;
}

const iso = t => new Date(t ?? Date.now()).toISOString();
const isoOrNull = t => (t == null || t === '' ? null : (() => { const d = new Date(typeof t === 'number' ? t : Date.parse(t)); if (!Number.isFinite(d.getTime())) throw bad('not_before 要是时间', 'bad_time'); return d.toISOString(); })());
// j_ + 按时间排序的随机串：毫秒时间（36 进制，补到 9 位）+ 8 位随机。
export const newJobId = (now = Date.now()) => `j_${Math.floor(now).toString(36).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`;

const bad = (msg, code = 'bad_transition') => Object.assign(Error(msg), { code, status: 409 });

function row(r) {
  if (!r) return null;
  return { ...r, result: fromJson(r.result), what: fromJson(r.what) };
}

// 结果：{ summary, counts, links }。summary 是一句人话；「没有新的」也是 done，summary 写清。
function cleanResult(result) {
  if (result == null) return null;
  if (typeof result === 'string') return { summary: result };
  if (typeof result !== 'object') throw bad('result 要是 { summary, counts, links }', 'bad_result');
  const summary = String(result.summary ?? '').trim();
  if (!summary) throw bad('做完了要写清结果（result.summary）', 'bad_result');
  return { summary, ...(result.counts ? { counts: result.counts } : {}), ...(result.links ? { links: result.links } : {}) };
}
function cleanWhat(what) {
  if (!what || typeof what !== 'object' || !String(what.label || '').trim() || !(what.href || what.ask_id)) throw bad('等你要写清要你做什么：what: { label, href 或 ask_id }', 'bad_what');
  return { label: String(what.label).trim(), ...(what.href ? { href: String(what.href) } : {}), ...(what.ask_id ? { ask_id: String(what.ask_id) } : {}) };
}

function addEvent(d, job_id, event, from, to, at, data) {
  d.prepare('INSERT INTO job_events (job_id, event, from_state, to_state, at, data) VALUES (?, ?, ?, ?, ?, ?)').run(job_id, event, from, to, at, toJson(data));
}

// 建一件活（state = queued）。ref 给了且已经有这一行：原样返回那一行（重复建不另开）。
export function create({ kind, member = null, title = '', target = null, origin = 'system', parent = null, ref = null, not_before = null, now = Date.now() } = {}) {
  if (!kind) throw bad('活要有种类（kind）', 'bad_create');
  if (member != null && !MEMBERS.includes(member)) throw bad(`没有这位成员：${member}`, 'bad_create');
  if (!ORIGINS.includes(origin)) throw bad(`不认得这个来源：${origin}`, 'bad_create');
  return tx(d => {
    if (ref) { const have = d.prepare('SELECT * FROM jobs WHERE ref = ?').get(ref); if (have) return row(have); }
    const id = newJobId(now), at = iso(now);
    d.prepare(`INSERT INTO jobs (id, kind, member, title, target, origin, state, parent, attempt, ref, not_before, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, ?, ?)`).run(id, String(kind), member, String(title || ''), target, origin, parent, ref, isoOrNull(not_before), at, at);
    addEvent(d, id, 'create', null, 'queued', at, null);
    return row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  });
}

// 改状态的唯一入口。data：result（finish）、reason（fail / wait / cancel 可带）、what（wait）、pid（start）、note、now。
export function transition(id, event, data = {}) {
  const move = MOVES[event];
  if (!move || event === 'create') throw bad(`不认得这个事件：${event}`);
  for (const k of move.need || []) if (data[k] == null || data[k] === '') throw bad(`${event} 要带 ${k}`, 'bad_transition_data');
  const result = event === 'finish' ? cleanResult(data.result) : null;
  const what = event === 'wait' ? cleanWhat(data.what) : null;
  // 原因：一句人话（字符串），或者 { code, text }（lib/wait-reason.mjs）。一律洗过再存：兜底词不拼进句子、片段不重复；
  // 整句只有兜底词的照原话存（显示的地方单独说），不因为洗空了就报错。
  const why = reasonOf(data.reason, data.reason_code || null), raw = typeof data.reason === 'object' && data.reason ? data.reason.text : data.reason;
  const reason = why.text || (raw != null && String(raw).trim() ? String(raw).trim() : null), reason_code = why.code || null;
  if (move.need?.includes('reason') && !reason) throw bad(`${event} 要带 reason`, 'bad_transition_data');
  return tx(d => {
    const cur = d.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!cur) throw Object.assign(Error(`没有这件活：${id}`), { code: 'no_job', status: 404 });
    // 旧卡/操作的 kind 可以是 mail 或 inbox；精确关联的实际读信动作才是等待依据。
    if (data.resource_wait && (typeof data.resource_wait !== 'string' || !d.prepare("SELECT 1 FROM actions WHERE id = ? AND job_id = ? AND kind = 'read_mail' AND state IN ('claimed','approved')").get(data.resource_wait, id))) throw bad('只有读信锁等待可以保留尝试次数', 'bad_transition_data');
    if (!move.from.includes(cur.state)) throw bad(`这件活现在是 ${cur.state}，不能 ${event}`);
    const at = iso(data.now), set = { state: move.to, updated_at: at };
    if (event === 'start') { set.started_at = at; set.pid = data.pid ?? null; set.not_before = null; set.reason = null; set.reason_code = null; }
    if (event === 'requeue') { set.pid = null; set.started_at = null; set.attempt = cur.attempt + (data.resource_wait ? 0 : 1); set.reason = reason; set.reason_code = reason_code; set.not_before = data.not_before === undefined ? null : isoOrNull(data.not_before); }
    if ((event === 'resume' || event === 'retry') && data.not_before !== undefined) set.not_before = isoOrNull(data.not_before);
    if (event === 'finish') { set.result = toJson(result); set.finished_at = at; set.reason = null; set.reason_code = null; set.what = null; set.pid = null; }
    if (event === 'fail') { set.reason = reason; set.reason_code = reason_code; set.finished_at = at; set.pid = null; }
    if (event === 'wait') { set.reason = reason; set.reason_code = reason_code; set.what = toJson(what); set.pid = null; }
    if (event === 'resume') { set.reason = null; set.reason_code = null; set.what = null; }
    if (event === 'retry') { set.attempt = cur.attempt + 1; set.reason = null; set.reason_code = null; set.result = null; set.finished_at = null; set.started_at = null; }
    if (event === 'cancel') { set.finished_at = at; set.pid = null; set.what = null; set.reason = reason; set.reason_code = reason_code; }
    const cols = Object.keys(set);
    d.prepare(`UPDATE jobs SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => set[c]), id);
    addEvent(d, id, event, cur.state, move.to, at, { ...(reason ? { reason } : {}), ...(reason_code ? { reason_code } : {}), ...(result ? { result } : {}), ...(what ? { what } : {}), ...(data.note ? { note: String(data.note) } : {}), ...(data.pid ? { pid: data.pid } : {}) });
    return row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  });
}

// 换一句原因（不改状态、不记事件）：已经失败、正等你的那件活，原因要按现在的说法说清（升级旧数据，lib/mail/send.mjs upgradeOldFailures）。
export function reword(id, reason, { code = null, now = Date.now() } = {}) {
  const why = reasonOf(reason, code);
  if (!why.text) throw bad('reword 要带 reason', 'bad_transition_data');
  return tx(d => {
    const r = d.prepare("UPDATE jobs SET reason = ?, reason_code = ?, updated_at = ? WHERE id = ? AND state IN ('failed', 'waiting_you')").run(why.text, why.code || null, iso(now), id);
    return r.changes ? row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) : null;
  });
}

// 升级时按同一次运行的证据纠正旧结果。不是重跑：保留起止时间、attempt 和 updated_at；
// 旧行及证据在同一事务的事件里留档。调用方必须给出刚读到的整行，用户其间改过就不覆盖。
export function correctHistoricalResult(expected, { state, result = null, reason = null, migration, evidence, now = Date.now() } = {}) {
  if (!migration || !evidence || !['done', 'failed'].includes(state)) throw bad('历史更正要带迁移名、证据和结束状态');
  const cleaned = cleanResult(result);
  if (state === 'done' && !cleaned || state === 'failed' && !reason) throw bad('历史更正要带结果或失败原因');
  return tx(d => {
    const cur = row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(expected?.id));
    if (!cur || !['done', 'failed'].includes(cur.state) || JSON.stringify(cur) !== JSON.stringify(expected)) return null;
    if (d.prepare("SELECT data FROM job_events WHERE job_id = ? AND event = 'correct_history'").all(cur.id).some(e => fromJson(e.data)?.migration === migration)) return null;
    d.prepare('UPDATE jobs SET state = ?, result = ?, reason = ?, reason_code = NULL, what = NULL WHERE id = ?').run(state, toJson(cleaned), state === 'failed' ? String(reason) : null, cur.id);
    addEvent(d, cur.id, 'correct_history', cur.state, state, iso(now), { migration, evidence, previous: cur, result: cleaned, reason });
    return row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(cur.id));
  });
}

// 从现在的状态走到 target，只用转移表里的事件（比如 queued → done 是 start、finish）。
// 走不到（做完了又要放回排队）返回 null、什么都不改。data 里按需带 result / reason / what。已经在 target 且内容一样：不动。
const ROUTES = {
  queued: { failed: ['retry'], waiting_you: ['resume'], running: ['requeue'] },
  running: { queued: ['start'], failed: ['retry', 'start'], waiting_you: ['resume', 'start'] },
  done: { queued: ['start', 'finish'], running: ['finish'], failed: ['retry', 'start', 'finish'], waiting_you: ['resume', 'start', 'finish'] },
  failed: { queued: ['fail'], running: ['fail'], waiting_you: ['resume', 'fail'] },
  waiting_you: { queued: ['wait'], running: ['wait'], failed: ['retry', 'wait'], waiting_you: ['resume', 'wait'] },
  cancelled: { queued: ['cancel'], running: ['cancel'], waiting_you: ['cancel'], failed: ['retry', 'cancel'] },
};
export function routeTo(from, target) { return from === target && target !== 'waiting_you' ? [] : ROUTES[target]?.[from] || null; }
export function drive(id, target, data = {}) {
  const cur = get(id);
  if (!cur) throw Object.assign(Error(`没有这件活：${id}`), { code: 'no_job', status: 404 });
  if (cur.state === target) {
    // 等你的事换了一件（登好了，又要你确认材料）：resume 再 wait，事件流里看得出来。别的同态不动。
    const want = reasonOf(data.reason, data.reason_code || null);
    const same = target !== 'waiting_you' || ((cur.reason === want.text || (!want.text && cur.reason === String(data.reason ?? '').trim())) && (cur.reason_code || null) === want.code && JSON.stringify(cur.what) === JSON.stringify(data.what ? cleanWhat(data.what) : null));
    if (same) return cur;
  }
  const steps = routeTo(cur.state, target);
  if (!steps) return null;
  let j = cur;
  for (const e of steps) j = transition(id, e, e === 'start' ? { now: data.now, pid: data.pid } : e === 'retry' || e === 'resume' ? { now: data.now, note: data.note } : e === 'requeue' ? { now: data.now, note: data.note, reason: data.reason, not_before: data.not_before, resource_wait: data.resource_wait } : data);
  return j;
}

// 改标题、成员、目标这类不算状态的字段（比如收录完知道了是哪一条）。状态不经这里改。
const EDITABLE = ['title', 'member', 'target', 'not_before']; // not_before：还排着的活改到点时间（比如登录好了提前、夜里推到早上）
export function annotate(id, fields = {}, { now = Date.now() } = {}) {
  const set = Object.fromEntries(Object.entries(fields).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined));
  if (set.member != null && !MEMBERS.includes(set.member)) throw bad(`没有这位成员：${set.member}`, 'bad_update');
  if ('not_before' in set) set.not_before = isoOrNull(set.not_before);
  if (!Object.keys(set).length) return get(id);
  return tx(d => {
    const cols = Object.keys(set);
    const r = d.prepare(`UPDATE jobs SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => set[c]), iso(now), id);
    if (!r.changes) throw Object.assign(Error(`没有这件活：${id}`), { code: 'no_job', status: 404 });
    return row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  });
}
// 做完 / 取消了的那件，同一张卡又要做一轮（你在卡上说了一句重新打开、放回排队）：转移表里走不回去，另起一件，attempt 加一。
// 卡的 ref 挪到新的这件上；旧的那件改名（ref#旧 id）留着当历史。只对 done、cancelled 有效，别的原样返回 null。
export function again(id, { now = Date.now() } = {}) {
  return tx(d => {
    const old = row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    if (!old || !['done', 'cancelled'].includes(old.state)) return null;
    const at = iso(now), nid = newJobId(now);
    d.prepare("UPDATE jobs SET ref = CASE WHEN ref IS NULL THEN NULL ELSE ref || '#' || id END WHERE id = ?").run(id);
    d.prepare(`INSERT INTO jobs (id, kind, member, title, target, origin, state, parent, attempt, ref, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(nid, old.kind, old.member, old.title, old.target, old.origin, old.parent, (old.attempt || 1) + 1, old.ref, at, at);
    addEvent(d, nid, 'create', null, 'queued', at, { note: `again:${id}` });
    return row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(nid));
  });
}

// 没挂卡的一件活补上卡（lib/task-ledger.mjs adoptActionJobs）：ref 只在还空着时写一次，父活也只补空的。不改 updated_at（不算这件活有动静）。
export function adopt(id, { ref, parent = null } = {}) {
  return tx(d => {
    const r = d.prepare('UPDATE jobs SET ref = ?, parent = COALESCE(parent, ?) WHERE id = ? AND ref IS NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE ref = ?)').run(ref, parent, id, ref);
    return r.changes ? row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) : null;
  });
}

// 一张卡改跟另一件活（道理和 again 一样，主会话 10-04）：投递卡预填做完以后终审提交另起的那件、例行卡当天又跑一轮的那一步。
// ref 挪到 id 这件上（它原来的 ref 是空的或者周期子活的记号），原来拿着这个 ref 的那件改名 ref#旧 id 留作历史；父活只补空的。
// 不改 updated_at、不记事件（状态没变）。id 这件不在 → null。
export function rebind(id, ref, { parent = null } = {}) {
  return tx(d => {
    const cur = row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    if (!cur || !ref) return null;
    if (cur.ref === ref) return cur;
    d.prepare("UPDATE jobs SET ref = ref || '#' || id WHERE ref = ?").run(ref);
    d.prepare('UPDATE jobs SET ref = ?, parent = COALESCE(parent, ?) WHERE id = ?').run(ref, parent, id);
    return row(d.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  });
}

// ── 读 ───────────────────────────────────────────────────────────────────────
export function get(id) { return dbExists() ? row(db().prepare('SELECT * FROM jobs WHERE id = ?').get(id)) : null; }
export function byRef(ref) { return dbExists() && ref ? row(db().prepare('SELECT * FROM jobs WHERE ref = ?').get(ref)) : null; }
// q：{ state（一个或数组）, member, kind, target, origin, parent, since（updated_at 之后）, active（排队 + 进行中 + 等你）, limit }。新的在前。
export function list(q = {}) {
  if (!dbExists()) return [];
  const where = [], args = [];
  const many = (col, v) => { const a = [].concat(v).filter(x => x != null); if (a.length) { where.push(`${col} IN (${a.map(() => '?').join(', ')})`); args.push(...a); } };
  if (q.state) many('state', q.state);
  if (q.active) many('state', ['queued', 'running', 'waiting_you']);
  if (q.member) many('member', q.member);
  if (q.kind) many('kind', q.kind);
  if (q.target) many('target', q.target);
  if (q.origin) many('origin', q.origin);
  if (q.parent) many('parent', q.parent);
  if (q.unbound) where.push('ref IS NULL'); // 没挂卡、没挂周期的（对外动作自己建的那件）
  if (q.since) { where.push('updated_at >= ?'); args.push(iso(typeof q.since === 'number' ? q.since : Date.parse(q.since))); }
  const limit = Math.max(1, Math.min(Number(q.limit) || 500, 5000));
  return db().prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`).all(...args).map(row);
}
// 这件活上挂着的对外动作（lib/actions.mjs 写的 actions 表；这里只读，给卡认「这件活由动作带着走」、找它是哪条岗位）。
export function actionsOf(id) { return dbExists() && id ? db().prepare('SELECT kind, target, payload, state FROM actions WHERE job_id = ? ORDER BY created_at').all(id).map(a => ({ ...a, payload: fromJson(a.payload) })) : []; }
// 某个目标上最近的一件（比如 target = 'lead:123' 的投递现在怎样）。
export function latest(q = {}) { return list({ ...q, limit: 1 })[0] || null; }
export function events(id) {
  if (!dbExists()) return [];
  return db().prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY seq').all(id).map(e => ({ ...e, data: fromJson(e.data) }));
}

// ── 看门 ─────────────────────────────────────────────────────────────────────
// 排队循环里定时调（不在读请求里调）。alive(pid)：这个进程还在不在；测试传假的。返回这次判失败的那几件。
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function watch({ now = Date.now(), staleMs = STALE_QUEUED_MS, alive = pidAlive, log = console.warn } = {}) {
  if (!dbExists()) return [];
  const out = [];
  // 真实持久队列正在等操作锁：不算无人接手，且不能把截止时间伪装成计划开始时间。
  let queuedRefs = new Set();
  try { const q = JSON.parse(fs.readFileSync(file('state/op-queue.json'), 'utf8')); queuedRefs = new Set((q.items || []).filter(x => x.card_id && Date.parse(x.expires_at) > now).map(x => `card:${x.card_id}`)); }
  catch (e) { if (e.code !== 'ENOENT') log?.(`[jobs] 操作队列读不了，按原看门规则核查：${e.message}`); } // 兜底：没有有效排队记录，就不能假称仍在等待资源。
  // 到点才开始的（not_before 还没到）不算没人接；到点以后从那个时间算 10 分钟。
  const old = db().prepare("SELECT * FROM jobs WHERE state = 'queued' AND max(updated_at, coalesce(not_before, '')) < ?").all(iso(now - staleMs)).map(row);
  for (const j of old) {
    if (queuedRefs.has(j.ref)) continue;
    try { out.push(transition(j.id, 'fail', { reason: `没人接这件活：${j.title || j.kind}排了 ${Math.round((now - Math.max(Date.parse(j.updated_at), Date.parse(j.not_before || '') || 0)) / 60000)} 分钟没人开始`, note: 'watch:stale', now })); }
    catch (e) { if (e.code !== 'bad_transition') throw e; } // 刚好被人领走了
    log?.(`[jobs] 没人接的活：${j.id} ${j.kind}（${j.title}）`); // 有能力表以后不该发生，发生了要大声报
  }
  const running = db().prepare("SELECT * FROM jobs WHERE state = 'running' AND pid IS NOT NULL").all().map(row);
  for (const j of running) {
    if (alive(j.pid)) continue;
    try { out.push(transition(j.id, 'fail', { reason: '进程意外退出', note: `watch:pid ${j.pid}`, now })); }
    catch (e) { if (e.code !== 'bad_transition') throw e; }
  }
  return out;
}
