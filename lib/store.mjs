import { sourceEventStatus } from './event-reasons.mjs';
// 最先：演示 / 沙盒模式的闸（lib/sandbox.mjs）。几乎每个入口都经过本模块，闸在它们自己的代码之前就位。
import "./sandbox.mjs";
import { event } from "./events.mjs";
import fs from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { TZ } from "./tz.mjs";
import * as leadsDb from "./leads.mjs";
import * as draftsDb from "./drafts.mjs";
import * as requestsDb from "./send-requests.mjs";
import * as receiptsDb from "./receipts.mjs";
import { merge3 } from "./merge3.mjs";
import { root, file, hash, wrote } from "./paths.mjs";
// 已经进库的四个旧文件（第 2 步）：老读法 lines(p)、老写法 writeLines(p, rows) 都转到库里，文件只读、不再写。
//   state/leads.ndjson → lib/leads.mjs；state/drafts.ndjson → lib/drafts.mjs；
//   state/send-requests.ndjson → lib/send-requests.mjs（发送请求并进 actions）；state/outbound.ndjson → lib/receipts.mjs（只追加）。
const DB_MODULES = [leadsDb, draftsDb, requestsDb, receiptsDb];
export const dbFile = (p) => DB_MODULES.find((m) => m.LEGACY_FILE === p) || null;
// 数据目录、路径、指纹在 lib/paths.mjs（库那几个模块直接引它）；这里转出去，老的调用方不用改。
export { root, file, hash, onWrite } from "./paths.mjs";
// 个人设置只在本机：这些文件不进仓库（.gitignore），仓库里的是同目录的中性模板
// config/<名>.example.<扩展名>。本机文件还没有时读模板；第一次写（设置页、发现回写、门户登录态）
// 就在本机建出这份文件。模板和本机文件都没有时（测试的临时 RADAR_ROOT）照旧用调用方的缺省值。
export const LOCAL_CONFIG = new Set([
  "config/concierge.json", "config/notify.json", "config/interview-guide.json",
  "config/roles.json", "config/chat.json", "config/model.json", "config/pipeline.json", "config/company-aliases.json", "config/providers.json",
  "config/watch-sites.json", "config/human-source-policy.json", "config/portal-sessions.json",
  "config/companies.yaml", "config/companies.archive.yaml", "config/computer-use.json", "config/prices.json", "config/phone.json",
]);
export const exampleOf = (p) => p.replace(/(\.[A-Za-z0-9]+)$/, ".example$1");
// 实际读的那份：本机文件，否则（个人设置才有）模板，否则 null。
export const configSource = (p) => (fs.existsSync(file(p)) ? p : LOCAL_CONFIG.has(p) && fs.existsSync(file(exampleOf(p))) ? exampleOf(p) : null);
// ── 不拿锁的写（第 2 步·锁退役）────────────────────────────────────────────────
// 还在文件里的共享状态（交办任务、收件箱事件、反馈、各种 .json）以前靠全局 state 锁防两个进程同时「读一份、改、写回」丢掉对方的改动。
// 锁退役以后靠这里：读的时候记下原文（BASE：读出来的那个对象 → 那一行 / 那整份原文；LAST：这个进程最近一次读到的整份），
// 写的时候先重读一遍：文件在我读了以后没被别人动过就直接写；动过就三方合并（lib/merge3.mjs：我没改的用现在的，别人没改的用我的）。
// 写是「写到自己的临时文件 → 改名」，改名之前再看一眼文件有没有又被换掉，换了就重来（最多 5 次）。不等、不拿锁（工作台进程里不许等，契约 2.7）。
// 剩下的空隙只有「最后看一眼」到「改名」之间几微秒；两个进程恰好同时改同一个文件的同一刻才会撞上。
const BASE = new WeakMap(), GEN = new WeakMap(), SEEN = new Map(), LAST = new Map();
let gens = 0;
const sigOf = (p) => { try { const s = fs.statSync(file(p)); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; } }; // 兜底：文件不在就没有签名（当作别人删了）
const textOf = (p) => { try { return fs.readFileSync(file(p), "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
export const read = (p, fallback = null) => {
  if (batched.get(p) !== undefined) flushBatched(p);
  if (fs.existsSync(file(p))) {
    const t = fs.readFileSync(file(p), "utf8"), v = JSON.parse(t);
    LAST.set(p, t);
    if (v && typeof v === "object") BASE.set(v, t);
    return v;
  }
  const src = LOCAL_CONFIG.has(p) ? configSource(p) : null;
  return src ? JSON.parse(fs.readFileSync(file(src), "utf8")) : fallback;
};
// ndjson：每一行记原文和是哪一次读出来的（GEN）；那一次读到了哪些行（SEEN），写的时候分得清「我这份里没有的那一行」是我删的，
// 还是我读了以后别人才加的（只看我这份里的行是哪几次读出来的）。每个文件只记最近 8 次。
function remember(p, strs) {
  const g = ++gens, l = SEEN.get(p) || [];
  l.unshift([g, new Set(strs)]); SEEN.set(p, l.slice(0, 8));
  return g;
}
export const lines = (p) => {
  if (dbFile(p)) return dbFile(p).all();
  const t = textOf(p);
  if (t == null) return [];
  const strs = t.split("\n").filter(Boolean), g = remember(p, strs);
  return strs.map((s) => {
    const l = JSON.parse(s);
    if (l.jd_gzip) {
      l.jd_text = gunzipSync(Buffer.from(l.jd_gzip, "base64")).toString("utf8");
      delete l.jd_gzip;
    }
    if (l && typeof l === "object") { BASE.set(l, s); GEN.set(l, g); }
    return l;
  });
};
const json = (v) => JSON.stringify(v, null, 2) + "\n";
export function write(p, data) {
  if (batched.has(p)) return void batched.set(p, data);
  if (typeof data === "string") return void save(p, data);
  // 我读过这个文件（BASE 或者这个进程最近一次读到的整份）：写之前看别人在那之后动过没有，动过就合并。
  const base = BASE.get(data) ?? LAST.get(p);
  if (base == null) return void save(p, json(data));
  saveMerged(p, (cur) => {
    if (cur == null || cur === base) return json(data);
    let theirs = null, was = null;
    try { theirs = JSON.parse(cur); was = JSON.parse(base); } catch { return json(data); } // 兜底：别人写了一半坏的、或者原文就不是 JSON：照我的写
    const v = merge3(was, data, theirs);
    return json(v === undefined ? data : v);
  });
}
// cur → 要写的全文；写之前、改名之前各看一眼文件签名，中间被换掉了就按新的那份重来。写完记下这一份是我最后看到的。
function saveMerged(p, build) {
  for (let i = 0; ; i++) {
    const sig = sigOf(p), cur = textOf(p), body = build(cur);
    const tmp = tmpOf(p);
    fs.mkdirSync(path.dirname(file(p)), { recursive: true });
    fs.writeFileSync(tmp, body);
    if (sigOf(p) !== sig && i < 4) { fs.unlinkSync(tmp); continue; }
    fs.renameSync(tmp, file(p));
    LAST.set(p, body); wrote(p);
    return;
  }
}
// 临时文件每个进程、每次一个名字（以前都叫 <文件>.tmp，两个进程同时写会写进同一个临时文件）。只用数字：
// lib/changes.mjs 认得 <文件>.<数字>.tmp 是临时文件，不当成一次变化。
let tmpSeq = 0;
// 写完一个文件告诉谁：在 lib/paths.mjs（lib/changes.mjs 挂上来，不引 store，免得同一层成环）。
const tmpOf = (p) => `${file(p)}.${process.pid}${String(++tmpSeq % 1e6).padStart(6, "0")}.tmp`;
function save(p, body) {
  const dest = file(p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = tmpOf(p);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, dest);
  LAST.set(p, body); wrote(p);
}
// 这个进程刚写了一个盯着的文件：马上发一条变化（lib/changes.mjs），视图缓存当场失效，不等目录监听慢一拍回来
// （以前全局锁文件进进出出顺带让缓存失效，锁退役以后要自己说）。
// Batched writes, for a JSON file a long run saves after every step
// (bin/concierge.mjs: the 1.4 MB state/action-receipts.json, once per action per
// sync). Inside `batchWrites(paths)`, `write` of a listed path only remembers the
// latest data; `flush()` writes each remembered file once — atomically, as above
// — and only if its content changed. A `read` of a remembered path flushes it
// first, so the process never reads an older copy than it wrote. `guard(obj)`
// is `obj` with every method flushing first — for calls with remote effects.
// `end()` flushes and returns the paths to plain writes.
const batched = new Map();
function flushBatched(p) {
  const data = batched.get(p);
  if (data === undefined) return;
  batched.set(p, undefined);
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  try { if (fs.readFileSync(file(p), "utf8") === body) return; } catch {} // 兜底：文件不在或读不出就照常写
  save(p, body);
}
export function batchWrites(paths) {
  for (const p of paths) if (!batched.has(p)) batched.set(p, undefined);
  const flush = () => { for (const p of paths) flushBatched(p); };
  const guard = (obj) => Object.fromEntries(Object.entries(obj).map(([k, f]) => [k, typeof f === "function" ? (...a) => (flush(), f(...a)) : f]));
  return { flush, guard, end: () => { flush(); for (const p of paths) batched.delete(p); } };
}
const lineOf = (p, x) => {
  if (p === "state/leads.ndjson" && x.jd_text?.length > 2048) {
    const { jd_text, ...rest } = x;
    return JSON.stringify({ ...rest, jd_gzip: gzipSync(jd_text).toString("base64") });
  }
  return JSON.stringify(x);
};
// 一行是哪一条：id（交办任务、反馈……）、message_id（收件箱事件）……认不出就按整行原文认。同一个 id 出现几次（交办任务按「最后一行为准」
// 追加新版本）按第几次出现对上。
const keyOf = (r) => (r && typeof r === "object" ? r.id ?? r.message_id ?? r.draft_id ?? null : null);
// 整份写回一个 ndjson：我这份里每一行
//   - 读出来以后没改过：用文件里现在那一行（别人可能刚改过；别人删了就不要了）；
//   - 改过：文件里那一行也没被别人动过就用我的，动过就三方合并；
//   - 新加的：照写。
// 文件里有、我这份里没有的：是我读出来的那几次里见过的，算我删的；没见过的（我读了以后别人加的）留着，接在后面。
function mergeLines(p, rows, cur) {
  const mine = rows.map((x) => lineOf(p, x));
  if (cur == null || !rows.some((r) => BASE.has(r))) return mine;
  const gens = new Set(rows.map((r) => GEN.get(r)).filter(Boolean));
  const seen = (s) => (SEEN.get(p) || []).some(([g, set]) => gens.has(g) && set.has(s));
  const now = cur.split("\n").filter(Boolean).map((s) => { let o = null; try { o = JSON.parse(s); } catch {} return { s, o, k: keyOf(o), used: false }; }); // 兜底：别人写了一半的坏行按原文留着
  const byText = new Map(), byKey = new Map();
  for (const c of now) { if (!byText.has(c.s)) byText.set(c.s, []); byText.get(c.s).push(c); if (c.k != null) { if (!byKey.has(c.k)) byKey.set(c.k, []); byKey.get(c.k).push(c); } }
  const take = (list) => { const c = (list || []).find((x) => !x.used); if (c) c.used = true; return c || null; };
  const out = [];
  rows.forEach((x, i) => {
    const b = BASE.get(x), k = keyOf(x);
    const c = (b != null && take(byText.get(b))) || (k != null ? take(byKey.get(k)) : null);
    if (b == null) { out.push(mine[i]); return; } // 新加的（或者另拼出来的一份）：我的为准
    if (mine[i] === b) { if (c) out.push(c.s); else if (k == null) out.push(mine[i]); return; } // 我没改：用现在的；别人删了就不要了
    if (!c || c.s === b || !c.o) { out.push(mine[i]); return; }
    const v = merge3(JSON.parse(b), x, c.o);
    out.push(v === undefined ? mine[i] : JSON.stringify(v));
  });
  for (const c of now) if (!c.used && !seen(c.s)) out.push(c.s); // 我读了以后别人加的
  return out;
}
export const writeLines = (p, rows) => {
  if (dbFile(p)) return void dbFile(p).saveAll(rows);
  if (batched.has(p)) return void write(p, rows.map((x) => lineOf(p, x)).join("\n") + (rows.length ? "\n" : ""));
  saveMerged(p, (cur) => { const out = mergeLines(p, rows, cur); return out.join("\n") + (out.length ? "\n" : ""); });
};
// 长跑的脚本（读网页、问模型，一跑几分钟）写回用这两个：写之前当场重读一份，只把这一次要改的改到新读的那份上再写。
// 不拿开头读的那份整份写回：合并兜得住别人加的、删的，可两边改了同一个值时以我为准，我那份是几分钟前的。
// fn 原地改（或返回新的一份）；返回 false 就不写。返回写下（或没写）的那一份。
export function patchLines(p, fn) {
  const rows = lines(p), r = fn(rows);
  if (r === false) return rows;
  const out = Array.isArray(r) ? r : rows;
  writeLines(p, out);
  return out;
}
export function patch(p, fallback, fn) {
  const v = read(p, fallback), r = fn(v);
  if (r === false) return v;
  const out = r === undefined || r === true ? v : r;
  write(p, out);
  return out;
}
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()).replaceAll("-", "");
export const arg = (name, fallback = null) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
// bin/cycle.mjs 给每个阶段的收尾点（RADAR_MATCH_DEADLINE，ISO 时间；名字沿用最早只给匹配用的开关）。
// 开始下一件事之前问一句：离收尾点不到 marginMs 就停，剩下的留给下一轮。手动运行没有收尾点。
export const deadlineNear = (marginMs) => !!process.env.RADAR_MATCH_DEADLINE && Date.now() + marginMs >= Date.parse(process.env.RADAR_MATCH_DEADLINE);
export const text = (p) => fs.readFileSync(file(LOCAL_CONFIG.has(p) ? configSource(p) || p : p), "utf8");
// 可选的本机文件（candidate/profile.md、candidate/resume.tex 这类不是人人都有的）：没有就当空串，不让新装的机器在第一步就崩。
export const optionalText = (p) => (fs.existsSync(file(p)) ? text(p) : "");
export function log(name, data) {
  const ref = `runs/${today()}/${name}-${Date.now()}.json`;
  write(ref, data);
  if (name !== "cycle") {
    const actor = /reach|send|draft|reconcile/.test(name) ? "postman" : /inbox|interview/.test(name) ? "nightwatch" : /discover|match|source|base/.test(name) ? "radar" : /feedback/.test(name) ? "user" : "heartbeat";
    event(actor, name, sourceEventStatus(data.sources, /error|degraded|fail/.test(data.status || "") ? "fail" : data.next_actions?.length ? "waiting_user" : data.status === "no_change" ? "skip" : "ok", !!data.error), `${name} · ${data.status || "完成"}`, { refs: [{ file: ref }], ...(data.record_id ? { lead_id: data.record_id } : {}) });
  }
  return data;
}
