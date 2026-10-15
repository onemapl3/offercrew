// 旧记录迁进 jobs（线 S，契约第三节「旧数据」）。
//   时机    工作台启动时（bin/serve.mjs ensureLedger）。第一次先把 state/ 整个复制到 state-backup-<时间>/，再迁。
//   迁什么  任务卡（tasks.ndjson，目标卡先迁，下面的卡挂在它下面）；没有卡的交办任务（host-jobs）；还排着、没挂卡的操作排队（op-queue）；
//           正在跑、没挂卡的那一次操作（ops.json current）。发送请求由 lib/send-requests.mjs 导入时并进 actions。
//           即时执行器（run-now.json）排的就是交办任务，迁交办任务时已经算上。
//   怎么重  每一条按 ref（card:<id>、hostjob:<id>、queue:<id>、op:<id>、sendreq:<id>）只建一次；再跑一遍什么都不改。旧文件留着、只读。
import fs from 'node:fs';
import { file, lines, read } from './store.mjs';
import { db, getMeta, setMeta, DB_PATH } from './db.mjs';
import * as J from './jobs.mjs';
import { fromLegacy } from './status.mjs';
import { cardSpec, cardState } from './task-ledger.mjs';

const T = x => Date.parse(x || '') || 0;
const lastRev = rows => { const m = new Map(); for (const r of rows) if (r?.id) m.set(r.id, r); return [...m.values()]; };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const MEMBER = new Set(['scout', 'lens', 'tailor', 'quill', 'owl', 'patch']);

// ── 交办任务、排队、操作、发送请求 → 活 ─────────────────────────────────────────
const JOB_TITLE = j => cut(j.title || (j.number != null ? `#${j.number} ${j.company || ''} · ${j.kind}` : j.details) || j.kind || '交办的事', 200);
function hostJobState(j) {
  const state = fromLegacy(j.status) || 'queued', data = { now: T(j.updated_at || j.completed_at || j.created_at) || undefined };
  if (state === 'done') data.result = { summary: cut(String(j.result || '').split('\n')[0] || '做完了', 200) };
  if (state === 'failed') data.reason = cut(j.blocked_reason || j.result || '原因没记下来', 200);
  if (state === 'waiting_you') { const q = typeof j.waiting_user === 'string' ? j.waiting_user : j.waiting_user?.question || j.required_action || '要你看一下'; data.reason = cut(q, 400); data.what = { label: cut(q, 40), href: '#inbox' }; }
  return { state, data };
}

function put(spec, target, created_at) {
  const had = J.byRef(spec.ref);
  if (had) return { job: had, created: false };
  const job = J.create({ ...spec, now: created_at || Date.now() });
  const j = target.state === 'queued' ? job : J.drive(job.id, target.state, target.data) || job;
  return { job: j, created: true };
}

// 迁一遍。返回每类建了几件（再跑一遍全是 0）。
export function migrateLegacy({ now = Date.now(), backup = true } = {}) {
  const counts = { cards: 0, hostjobs: 0, queue: 0, ops: 0, sendreqs: 0, actions: 0, backup: null };
  if (backup && !getMeta('legacy_backup')) {
    const dir = `state-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    if (fs.existsSync(file('state'))) fs.cpSync(file('state'), file(dir), { recursive: true, filter: src => !src.includes(DB_PATH.split('/').pop()) });
    db(); setMeta('legacy_backup', { dir, at: new Date(now).toISOString() });
    counts.backup = dir;
  }
  db();
  // 任务卡：目标卡先迁，下面的卡挂在它的活下面。
  const cards = lastRev(lines('state/tasks.ndjson')).filter(c => c?.id && !c.legacy);
  const goals = new Map();
  for (const c of [...cards.filter(c => c.kind === 'goal'), ...cards.filter(c => c.kind !== 'goal')]) {
    const parent = c.goal ? goals.get(c.goal) || null : null;
    const r = put(cardSpec(c, parent), cardState(c), T(c.created_at));
    if (c.kind === 'goal') goals.set(c.id, r.job.id);
    counts.cards += r.created ? 1 : 0;
  }
  const used = new Set(cards.flatMap(c => [c.links?.job_id, c.links?.old_job_id]).filter(Boolean));
  for (const j of lastRev(lines('state/host-jobs.ndjson'))) {
    if (!j?.id || used.has(j.id)) continue;
    const r = put({ kind: j.kind || 'host_job', member: null, title: JOB_TITLE(j), target: j.record_id ? `lead:${j.record_id}` : null, origin: 'system', ref: `hostjob:${j.id}` }, hostJobState(j), T(j.created_at));
    counts.hostjobs += r.created ? 1 : 0;
  }
  const cardOps = new Set(cards.map(c => c.links?.op_id).filter(Boolean)), cardQueue = new Set(cards.map(c => c.links?.queue_id).filter(Boolean));
  const q = read('state/op-queue.json', null) || {};
  for (const it of Array.isArray(q.items) ? q.items : []) {
    if (!it?.id || it.card_id || cardQueue.has(it.id)) continue;
    const r = put({ kind: it.op || 'op', member: MEMBER.has(it.member) ? it.member : null, title: cut(it.label || it.op, 200), target: it.record_id ? `lead:${it.record_id}` : null, origin: it.by === 'you' ? 'card' : 'system', ref: `queue:${it.id}` }, { state: 'queued', data: {} }, T(it.at));
    counts.queue += r.created ? 1 : 0;
  }
  const cur = (read('state/ops.json', null) || {}).current;
  if (cur?.id && cur.status === 'running' && !cardOps.has(cur.id)) {
    const r = put({ kind: cur.op || 'op', member: null, title: cut(cur.label || cur.op, 200), target: cur.record_id ? `lead:${cur.record_id}` : null, origin: 'system', ref: `op:${cur.id}` }, { state: 'running', data: { now: T(cur.started_at) || undefined, pid: cur.pid || null } }, T(cur.started_at));
    counts.ops += r.created ? 1 : 0;
  }
  // 还没完结的发送请求：读的时候就已经并进 actions 了（lib/send-requests.mjs 导入旧文件时按同一套规矩补活和动作，ref sendreq:<id>）。
  // 这里只读一遍、让导入先跑（导了几条记在 meta send-requests_import）。
  lines('state/send-requests.ndjson');
  setMeta('legacy_migrated', { at: new Date(now).toISOString(), counts });
  return counts;
}

// 工作台启动时调（bin/serve.mjs）：建库、迁旧记录（第一次先备份）。读请求不调它。
export function ensureLedger(opts = {}) { db(); return migrateLegacy(opts); }
