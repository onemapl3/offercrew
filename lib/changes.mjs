// 变化（05 第二节 2.3）：哪张表、哪几行变了，攒成一批推给页面。代替以前每 2 秒比较 39 个文件签名、推一句「有变化」。
//
//   emit({table, ids, op})  一条变化。ids 是这几行的 id；null 是「整张表」（还在文件里的状态，不知道哪几行）。
//                           op：insert / update / delete / write（文件整份写过）。
//   onChange(fn)            进程内订阅，一条一条收（工作台拿它让视图缓存失效）。
//   drain()                 攒下的合成一批：{ jobs: [id…], leads: null, … }，没有就是 null。工作台每 200 毫秒取一次推 SSE。
//
// 三个来源，同一个形状：
//   库    lib/db.mjs 打开库时给每张表挂临时触发器（watchDb），每次写都发；新加的表（leads、drafts、receipts……）打开时一起挂上，
//         不用改这里。事务回滚的不发。
//   别的进程  周期、worker、bin/job.mjs 也写这个库。它们把变化追加到 state/changes.ndjson（一批一行）；工作台（hostFeed）
//         每次 drain 读新追加的那几行。工作台自己不往里写（进程内直接收）。
//   文件  还没进库的状态（第 2 步做完前的线索、草稿、回执，还有配置）：工作台盯着这几个目录（watchFiles），文件一变就按
//         FILE_TABLES 发一条整张表的变化。哪个进程写的都一样收得到，写文件的地方不用改。
import fs from 'node:fs';
import path from 'node:path';
import { file, onWrite } from './paths.mjs';

export const JOURNAL = 'state/changes.ndjson';
const JOURNAL_ROTATE = 1 << 20;   // 工作台读到超过 1 MB 就换一份新的
const JOURNAL_CAP = 4 << 20;      // 超过 4 MB 说明没有工作台在读：不再往里写
const MAX_IDS = 500;              // 一批里同一张表超过这么多行，就当整张表变了

const listeners = new Set();
let host = false;
let pending = new Map();          // table -> Set(id) | null（整张表）
let outbox = [];                  // 不是工作台的进程：这一拍要追加到日志的变化

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// 工作台自己刚写了一个盯着的文件（lib/store.mjs）：马上发一条，视图缓存当场失效，不等目录监听慢一拍回来（第 2 步·锁退役：
// 以前全局锁文件进进出出顺带让缓存失效）。别的进程写的文件照旧由工作台的目录监听收，不往日志里多记。
onWrite(p => { if (!host) return; const t = tableOfFile(p); if (t) emit({ table: t, ids: null, op: 'write' }); });

export function emit(change) {
  const table = String(change?.table || '');
  if (!table) return;
  const ids = Array.isArray(change.ids) ? change.ids.filter(x => x != null).map(String) : null;
  const c = { table, ids, op: change.op || 'write' };
  note(c);
  if (!host) { if (!outbox.length) queueMicrotask(writeOutbox); outbox.push(c); }
}
// 写完库马上 process.exit() 的脚本：微任务来不及跑，退出前补写。
process.once('exit', () => { if (!host) writeOutbox(); });

function note(c) {
  const have = pending.get(c.table);
  if (have === null || c.ids === null) pending.set(c.table, null);
  else {
    const set = have || new Set();
    for (const id of c.ids) set.add(id);
    pending.set(c.table, set.size > MAX_IDS ? null : set);
  }
  for (const fn of listeners) { try { fn(c); } catch (e) { console.error('changes listener', String(e?.message || e).slice(0, 160)); } }
}

// 一批变化：一个微任务里攒下的（同一个事务里的几次写）合成一行。
function writeOutbox() {
  const batch = outbox; outbox = [];
  if (!batch.length) return;
  try {
    const p = file(JOURNAL);
    let size = 0;
    try { size = fs.statSync(p).size; } catch {} // 兜底：日志文件还没有就从 0 开始
    if (size > JOURNAL_CAP) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), changes: batch }) + '\n');
  } catch (e) { console.error('changes journal', String(e?.message || e).slice(0, 160)); }
}

// ---- 工作台这一侧 ----
let offset = 0, rest = '';
// 这个进程是推给页面的那一个：不再往日志里写；从现在的末尾开始读（以前的变化页面打开时已经拉过了）。
export function hostFeed() {
  host = true;
  outbox = [];
  try { offset = fs.statSync(file(JOURNAL)).size; } catch { offset = 0; } // 兜底：日志文件还没有就从 0 开始
  rest = '';
}

function readJournal() {
  const p = file(JOURNAL);
  let size;
  try { size = fs.statSync(p).size; } catch { offset = 0; rest = ''; return; }
  if (size < offset) { offset = 0; rest = ''; }   // 被换过了
  if (size > offset) {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = rest + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      rest = text.slice(cut + 1);
      for (const line of text.slice(0, cut + 1).split('\n')) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row?.pid === process.pid) continue;
        for (const c of row?.changes || []) if (c?.table) note({ table: String(c.table), ids: Array.isArray(c.ids) ? c.ids.map(String) : null, op: c.op || 'write' });
      }
    } finally { fs.closeSync(fd); }
  }
  // 读完了、又够大了：挪到 .old 再从头读新的。挪走之前别人刚追加的那一点，下次 drain 不会丢：先把 .old 里剩下的读完。
  if (offset >= JOURNAL_ROTATE && !rest) {
    const old = p + '.old';
    try {
      fs.renameSync(p, old);
      const tail = fs.readFileSync(old).subarray(offset).toString('utf8');
      offset = 0;
      for (const line of tail.split('\n')) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row?.pid === process.pid) continue;
        for (const c of row?.changes || []) if (c?.table) note({ table: String(c.table), ids: Array.isArray(c.ids) ? c.ids.map(String) : null, op: c.op || 'write' });
      }
    } catch (e) { if (e.code !== 'ENOENT') console.error('changes rotate', String(e?.message || e).slice(0, 160)); }
  }
}

// 攒下的变化合成一批（{ 表: [id…] | null }），没有就是 null。
export function drain() {
  if (host) readJournal();
  if (!pending.size) return null;
  const out = {};
  for (const [t, ids] of pending) out[t] = ids === null ? null : [...ids];
  pending = new Map();
  return out;
}

// ---- 库：每张表挂临时触发器 ----
// 临时触发器只在这一个连接上、不进库文件，不用迁移；打开时照库里现有的表挂，以后新加的表下次打开自动有。
// 改了又改回原样的 UPDATE（所有列都没变）不算变化。meta 是内部记录，不推。
const SKIP_TABLES = new Set(['meta']);
const q = s => `"${String(s).replaceAll('"', '""')}"`;
export function watchDb(d, { inTx }) {
  if (typeof d.function !== 'function') throw Error('这个版本的 Node 不支持数据库函数（要 22.13 以上），页面收不到变化');
  let txBuf = [];
  d.function('radar_changed', { deterministic: false, directOnly: false }, (table, id, op) => {
    const c = { table, ids: id == null ? null : [String(id)], op };
    if (inTx()) txBuf.push(c); else emit(c);
    return null;
  });
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).filter(n => !SKIP_TABLES.has(n));
  for (const t of tables) {
    const cols = d.prepare(`PRAGMA table_info(${q(t)})`).all();
    const pk = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk);
    const key = pk.length === 1 ? q(pk[0].name) : 'rowid';
    const differs = cols.map(c => `OLD.${q(c.name)} IS NOT NEW.${q(c.name)}`).join(' OR ') || '1';
    const name = op => q(`radar_feed_${t}_${op}`);
    d.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name('ins')} AFTER INSERT ON main.${q(t)} BEGIN SELECT radar_changed('${t.replaceAll("'", "''")}', NEW.${key}, 'insert'); END;
            CREATE TEMP TRIGGER IF NOT EXISTS ${name('upd')} AFTER UPDATE ON main.${q(t)} WHEN ${differs} BEGIN SELECT radar_changed('${t.replaceAll("'", "''")}', NEW.${key}, 'update'); END;
            CREATE TEMP TRIGGER IF NOT EXISTS ${name('del')} AFTER DELETE ON main.${q(t)} BEGIN SELECT radar_changed('${t.replaceAll("'", "''")}', OLD.${key}, 'delete'); END;`);
  }
  return {
    commit() { const b = txBuf; txBuf = []; for (const c of b) emit(c); },
    rollback() { txBuf = []; },
  };
}

// ---- 文件：还没进库的状态 ----
// 路径（相对数据目录）→ 表名。表名和页面上各块订阅的一致（web/live.js）；第 2 步进库的线索、草稿、回执用将来表的名字，
// 进了库以后由库那一路发，页面不用改。对不上的文件不推（和以前一样：只推页面会用到的）。
export const FILE_TABLES = [
  [/^state\/(referrers|feedback)\.ndjson$|^state\/(top-picks|company-contacts|followups)\.json$|^state\/(company-briefs|role-prep|interview-dossiers)\//, 'leads'],
  [/^state\/action-(overrides|inputs)\.json$/, 'actions'],
  [/^state\/(tasks|host-jobs)\.ndjson$|^state\/(run-now|executor-heartbeat|op-queue|ops|rejudge-pending|cycle-progress|match-progress)\.json$|^private\/cycle\.lock$/, 'jobs'],
  [/^state\/(events|system-actions)\.ndjson$/, 'events'],
  [/^state\/(inbox-events|ask-answers)\.ndjson$|^state\/(login-watch|apply-proposal|send-proposal|ask-snooze|dismissed|alerts-dismissed|unlock-dismissed)\.json$/, 'asks'],
  [/^state\/web-replies\.ndjson$|^state\/chat\//, 'talk'],
  [/^candidate\/(resume\/|resume\.tex$|uploads\/)|^candidate\/.+\.(pdf|docx)$/i, 'resume'],
  [/^config\/|^candidate\/(facts\.(yaml|json)|profile\.md)$|^state\/(preferences|agent-pause|onboarding)\.json$|^state\/memory\//, 'config'],
];
export const tableOfFile = rel => {
  if (!rel || /\.tmp(-\d+)?$|\.\d+\.tmp$|\.broken-|\.bad-/.test(rel)) return null;
  for (const [re, t] of FILE_TABLES) if (re.test(rel)) return t;
  return null;
};
// 盯着的目录：state、config、candidate 连子目录；private 只看这一层（只为两个锁文件，只看名字，不读内容）。
const WATCH_DIRS = [['state', true], ['config', true], ['candidate', true], ['private', false]];
const watchers = new Map();
// 挂上还没挂的（目录这时才有的、上次出错断了的）。返回 { watching: [...], failed: [{dir, error}] }。工作台定时叫它补挂。
export function watchFiles() {
  const failed = [];
  for (const [dir, recursive] of WATCH_DIRS) {
    if (watchers.has(dir)) continue;
    const abs = file(dir);
    if (!fs.existsSync(abs)) continue;
    try {
      const w = fs.watch(abs, { recursive, persistent: false }, (_type, name) => {
        if (!name) return;
        const rel = `${dir}/${String(name).split(path.sep).join('/')}`;
        const t = tableOfFile(rel);
        if (t) emit({ table: t, ids: null, op: 'write' });
      });
      w.on('error', e => { try { w.close(); } catch {} watchers.delete(dir); console.error('changes watch', dir, String(e?.message || e).slice(0, 120)); }); // 兜底：监听已经断了（下面照样从表里拿掉并打印原因）
      watchers.set(dir, w);
    } catch (e) { failed.push({ dir, error: String(e?.message || e).slice(0, 120) }); }
  }
  return { watching: [...watchers.keys()], failed };
}
export function stopWatching() { for (const w of watchers.values()) { try { w.close(); } catch {} } watchers.clear(); } // 兜底：监听已经断了
