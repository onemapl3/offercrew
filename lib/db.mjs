// 账（线 S，design/architecture-review/04-改造契约与分工.md 2.1）：一件活的状态只有这一处出处。
//   文件      state/offercrew.db，建在数据目录里（RADAR_ROOT）；测试用自己的数据目录，和别的 state 文件一样隔离。
//   引擎      Node 自带的 node:sqlite（DatabaseSync），不要原生模块；WAL，busy_timeout 5 秒。
//   迁移      按 PRAGMA user_version 一版一版走（MIGRATIONS 只往后加，不改已有的）。
//   谁能开    只有这个模块打开数据库；别的模块经 lib/jobs.mjs、lib/actions.mjs 读写。
// 线索在 leads 表（第 6 版，lib/leads.mjs）；草稿、发送请求、回执在第 7 版（lib/drafts.mjs、lib/send-requests.mjs、lib/receipts.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { file } from './paths.mjs';
import { watchDb } from './changes.mjs';

export const DB_PATH = 'state/offercrew.db';

// node:sqlite 在 Node 22–25 上还会报一句 ExperimentalWarning：只压这一句，别的警告照常。
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const msg = typeof w === 'string' ? w : w?.message;
    if (/SQLite is an experimental feature/.test(String(msg || ''))) return;
    return emit.call(process, w, ...rest);
  };
  try { return process.getBuiltinModule('node:sqlite'); } finally { process.emitWarning = emit; }
}

const STATES = "'queued','running','done','failed','waiting_you','cancelled'";
const ACTION_STATES = "'requested','approved','claimed','done','uncertain','failed','cancelled'";

// 一版一条（下标 + 1 = 这一版的 user_version）。只往后加。
export const MIGRATIONS = [
  // 1：jobs、job_events、actions（契约 2.2、2.3）。
  //   jobs 在契约的列以外多三列：what（等你时要你做什么，JSON）、pid（running 时做事的进程，看门用）、
  //   ref（外部记号，比如旧记录迁进来的「card:t-…」，唯一，迁移和重复建靠它不重）。
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     member TEXT,
     title TEXT NOT NULL DEFAULT '',
     target TEXT,
     origin TEXT NOT NULL DEFAULT 'system',
     state TEXT NOT NULL CHECK (state IN (${STATES})),
     reason TEXT,
     result TEXT,
     what TEXT,
     parent TEXT,
     attempt INTEGER NOT NULL DEFAULT 1,
     pid INTEGER,
     ref TEXT UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT
   );
   CREATE INDEX jobs_state ON jobs(state, updated_at);
   CREATE INDEX jobs_member ON jobs(member, updated_at);
   CREATE INDEX jobs_target ON jobs(target);
   CREATE INDEX jobs_parent ON jobs(parent);
   CREATE TABLE job_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL,
     event TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT NOT NULL,
     at TEXT NOT NULL,
     data TEXT
   );
   CREATE INDEX job_events_job ON job_events(job_id, seq);
   CREATE TABLE actions (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     job_id TEXT NOT NULL,
     target TEXT,
     payload TEXT,
     fingerprint TEXT,
     idem_key TEXT UNIQUE,
     state TEXT NOT NULL CHECK (state IN (${ACTION_STATES})),
     worker TEXT,
     claimed_by INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     receipt TEXT,
     reason TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX actions_state ON actions(state, updated_at);
   CREATE INDEX actions_job ON actions(job_id);`,
  // 2：meta（一次性的事做没做过，比如旧记录迁没迁）。
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, at TEXT NOT NULL);`,
  // 3（主会话 10-04 契约增补）：等的东西用列说清，不让状态撒谎、不用字符串对接。
  //   actions.hold        空，或者 'needs_login:<账号>' 这类：挡着它的那件事；有 hold 的不领。
  //   actions.not_before  ISO 时间：这之前不领（发信连不上，隔一会儿再试）。
  //   jobs.not_before     ISO 时间：排着、到点才开始；看门不判「没人接」，页面写「排队中 · 几点开始」。
  //   领走的条件：state = 'approved' AND hold IS NULL AND (not_before IS NULL OR not_before <= 现在)（CLAIMABLE）。
  `ALTER TABLE actions ADD COLUMN hold TEXT;
   ALTER TABLE actions ADD COLUMN not_before TEXT;
   ALTER TABLE jobs ADD COLUMN not_before TEXT;
   CREATE INDEX actions_claim ON actions(state, hold, not_before);`,
  // 4（线 F，升级前的红线）：actions.approved_at  你批准这一份的时间。往外的动作（发信、私信、预填、提交）批准超过 24 小时还没领走的
  //   不再自动做，等你再看一眼（lib/actions.mjs STALE_MS）。旧版迁进来、时间不明的（payload.legacy）留空，算「旧版里批准的」。
  `ALTER TABLE actions ADD COLUMN approved_at TEXT;
   UPDATE actions SET approved_at = created_at WHERE payload IS NULL OR payload NOT LIKE '%"legacy":%';`,
  // 5（L2，0.1.6「原因见详情、原因见详情要本机 AI 来做……」）：jobs.reason_code  停着的原因码（lib/wait-reason.mjs），
  //   reason 是配它的那一句人话。迁移、收件箱、「看原因」按码认，不再拿句子里的词去猜。
  `ALTER TABLE jobs ADD COLUMN reason_code TEXT;`,
  // 6（第 2 步，契约 05 2.1）：线索进库。leads 一行一条线索（id = leadKey；旧文件里同一个 key 出现两次的，第二条起 key 后面加 #2…），
  //   seq 是在列表里的顺序；doc 是整条线索（不含 JD 正文），state / apply / judgement 和几列常用的是从 doc 拆出来、给查询用的。
  //   JD 正文另存 lead_texts。lead_events 每次状态转移记一条（lib/leads.mjs，只经 lead-state 的 applyEvent）。
  `CREATE TABLE leads (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL, number INTEGER,
     company TEXT, role TEXT, location TEXT, url TEXT, source TEXT, channel TEXT,
     state TEXT, apply TEXT, judgement TEXT, doc TEXT NOT NULL,
     created_at TEXT, updated_at TEXT);
   CREATE INDEX leads_number ON leads(number);
   CREATE INDEX leads_seq ON leads(seq);
   CREATE TABLE lead_texts (id TEXT PRIMARY KEY, jd_text TEXT);
   CREATE TABLE lead_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, at TEXT, event TEXT, from_state TEXT, to_state TEXT, source TEXT, note TEXT);
   CREATE INDEX lead_events_lead ON lead_events(lead_id, seq);`,
  // 7（第 2 步·对外记录，契约 05 2.2）：草稿、发送请求、回执进库（lib/drafts.mjs、lib/send-requests.mjs、lib/receipts.mjs）。
  //   drafts       一份草稿一行（id = draft_id）：全文（body）、指纹（这一版内容算出来的）、渠道、字数、状态、对应的线索和动作；
  //                doc 是整份草稿（不含 body），seq 是在列表里的顺序。
  //   actions.delivery / request_id  发送请求并进动作：发信、发私信那一条动作的投递记录（以前 send-requests.ndjson 的一行）。
  //                request_id 唯一：一条发送请求只挂在一条动作上（你说「再发一次」时挪到新的那一条）。
  //                旧文件里已经结束、又没有动作的（命令行时代的发送）挂在 job_id = '' 的历史动作上，不另开活。
  //   receipts     每次对外动作的回执（发出的信、私信、投递），只追加：同一条回执再记一次就是新的一行（rev + 1），读的时候取最新的。
  //                改、删一律被触发器挡住；只有「旧文件在库外被换掉、整份重导」（演示重灌、测试夹具，先备份）开 meta receipts_unlock 那一下。
  `CREATE TABLE drafts (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL, number INTEGER, record_id TEXT, action_id TEXT,
     channel TEXT, purpose TEXT, status TEXT, fingerprint TEXT, chars INTEGER, to_addr TEXT, subject TEXT, body TEXT,
     doc TEXT NOT NULL, created_at TEXT, updated_at TEXT);
   CREATE INDEX drafts_seq ON drafts(seq);
   CREATE INDEX drafts_record ON drafts(record_id);
   CREATE INDEX drafts_number ON drafts(number);
   ALTER TABLE actions ADD COLUMN delivery TEXT;
   ALTER TABLE actions ADD COLUMN request_id TEXT;
   CREATE UNIQUE INDEX actions_request ON actions(request_id) WHERE request_id IS NOT NULL;
   CREATE TABLE receipts (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
     record_id TEXT, channel TEXT, kind TEXT, action_id TEXT, draft_id TEXT,
     verified TEXT, evidence TEXT, at TEXT, doc TEXT NOT NULL, recorded_at TEXT NOT NULL);
   CREATE INDEX receipts_id ON receipts(id, seq);
   CREATE INDEX receipts_record ON receipts(record_id);
   CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipts_unlock')
     BEGIN SELECT RAISE(ABORT, 'receipts_append_only'); END;
   CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipts_unlock')
     BEGIN SELECT RAISE(ABORT, 'receipts_append_only'); END;`,
];
// 能领走的对外动作（lib/actions.mjs 用）：参数是现在的 ISO 时间。
export const CLAIMABLE = "state = 'approved' AND hold IS NULL AND (not_before IS NULL OR not_before <= ?)";
// 批准太久的往外动作不领（参数是 24 小时前的 ISO 时间）：和 CLAIMABLE 一起用，领走的那一条 UPDATE 里就挡住，不靠事先扫过。
export const FRESH = "(kind NOT IN ('send_email', 'send_dm', 'prefill', 'submit') OR COALESCE(approved_at, '') >= ?)";

let cached = null; // { path, db, feed }
let inTx = false;

// 升级前先备份（红线：迁移一律先备份）：库里已经有数据、要往上迁时，先 VACUUM INTO 出一份快照
// state/backups/offercrew-v<旧版>-<时间>.db（一致的快照，不怕别的进程正在写）。备份不成就不迁，原样报错。
function backupBefore(db, have) {
  if (!have || have >= MIGRATIONS.length) return null;
  const dir = path.join(path.dirname(file(DB_PATH)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, `offercrew-v${have}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  return to;
}
function migrate(db) {
  const have = db.prepare('PRAGMA user_version').get().user_version;
  backupBefore(db, have);
  for (let v = have; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // 另一个进程可能刚迁过：拿到写锁以后再看一眼。
      if (db.prepare('PRAGMA user_version').get().user_version > v) { db.exec('COMMIT'); continue; }
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } /* 兜底：回滚失败说明事务已经不在了；真正的错在后面原样抛出 */
  }
}

// 打开（同一进程里按路径缓存一个连接）。数据目录换了（测试换 RADAR_ROOT 不会，因为 store.root 在加载时定了）照路径重开。
export function db() {
  const p = file(DB_PATH);
  // 文件被挪走了（测试清数据目录、你手动删了）：重开一个，不往已经删掉的文件里写。
  if (cached?.path === p && cached.db.isOpen !== false && fs.existsSync(p)) return cached.db;
  if (cached) try { cached.db.close(); } catch {} /* 兜底：旧连接已经关了或坏了，换一个新的就是 */
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const d = new DatabaseSync(p);
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA synchronous = NORMAL');
  migrate(d);
  // 每次写都发出 {table, ids, op}（lib/changes.mjs，05 第二节 2.3）：每张表挂临时触发器，迁移以后挂，新加的表也有。
  const feed = watchDb(d, { inTx: () => inTx });
  cached = { path: p, db: d, feed };
  return d;
}

// 一段要么全成、要么全不成的写：BEGIN IMMEDIATE 先拿写锁（别的进程等 busy_timeout），fn 同步跑完再提交。
// 事务里的变化提交以后才发，回滚的不发。
export function tx(fn) {
  const d = db(), feed = cached.feed;
  d.exec('BEGIN IMMEDIATE');
  inTx = true;
  try { const r = fn(d); d.exec('COMMIT'); inTx = false; feed.commit(); return r; }
  catch (e) { inTx = false; try { d.exec('ROLLBACK'); } catch {} feed.rollback(); throw e; } /* 兜底：回滚失败说明事务已经不在了；真正的错在后面原样抛出 */
}

// 有没有这个库（读请求用：还没建过就当没有活，不为了读去建文件）。
export const dbExists = () => fs.existsSync(file(DB_PATH));

export const getMeta = key => (dbExists() ? fromJson(db().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null) : null);
export const setMeta = (key, value) => db().prepare('INSERT INTO meta (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').run(key, toJson(value), new Date().toISOString());

export function closeDb() { if (cached) { try { cached.db.close(); } catch {} cached = null; } } /* 兜底：已经关了 */

// JSON 列：存的时候转字符串，读的时候转回来；坏的当没有。
export const toJson = v => (v == null ? null : JSON.stringify(v));
export const fromJson = s => { if (s == null || s === '') return null; try { return JSON.parse(s); } catch { return null; } }; /* 兜底：JSON 列坏了当没有（这一列的读法就是这样约定的，写的时候都是 toJson） */
