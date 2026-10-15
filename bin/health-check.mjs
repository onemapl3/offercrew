#!/usr/bin/env node
// 真实数据体检（第二阶段契约 05 第三节第 4 条）：只读，只输出计数和编号，结果是 0 才算过。
//
//   node bin/health-check.mjs [--root <数据目录>] [--json] [--now <ISO 时间>]
//   数据目录默认是 RADAR_ROOT，没设就是这份代码所在的目录。
//
// 查五样：
//   卡和账对不上      卡没有账上那件活、账上有活却没有那张卡、卡上的状态和账不一样、
//                     对外的卡（投递、发送）说自己排着 / 在做、却没有挂对外动作（没有东西真的在做它），
//                     或者在等你、却没说等你做哪一件（没指着收件箱的信或者一处页面）。
//                     等你批准的发送卡（批准前就是没有动作）、停在提交前等你的投递卡（指着终审 / 预填好了那封信）、
//                     没做成的（你点「再试一次」才开新的动作）都是账上记好了的样子，不算（第 2 步 2X：卡只读账以后，状态不再从线索推）。
//   等了很久没人接    排着超过 10 分钟没人领的活、批准了超过 10 分钟没人领的对外动作、领走 30 分钟没回音的对外动作、
//                     等「本机 AI」的活（App 里本机 AI 不接对外的事）、没迁进账的旧交办任务还排着
//   原因空着或拼坏    失败 / 等你的活没写原因，或者原因是兜底词（原因没记下来、原因见详情…）、同一句重复、拼进了 undefined 之类
//   重复卡            同一种活、同一个标题、同一个对象，没取消的有两张以上，而且一起开着或者前后 10 分钟内建的
//   带原始错误码      原因、要你做的事里有 snake_case 的错误码
//
// 只读：不经 lib/db.mjs（它一打开就设 WAL、跑迁移），数据库先复制到临时目录再开，数据目录里一个字节都不改（tests/health-check.test.mjs）。
// 不打开、不打印任何内容：只打印卡的编号（t-…）、活的编号（j_…）、动作的编号（a_…）和岗位号（#N）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROOT = path.resolve(opt('--root') || process.env.RADAR_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const NOW = Date.parse(opt('--now') || '') || Date.now();
const MIN = 60000;
const T = x => Date.parse(x || '') || 0;

// ── 只读的读法 ───────────────────────────────────────────────────────────────
const at = p => path.join(ROOT, p);
function rows(p) {
  let text; try { text = fs.readFileSync(at(p), 'utf8'); } catch { return []; } // 兜底：文件不在就是没有，体检只读
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} } // 兜底：坏的一行跳过，体检只数能读的
  return out;
}
const lastRev = list => { const m = new Map(); for (const r of list) if (r?.id) m.set(r.id, r); return [...m.values()]; };
const json = s => { if (s == null || s === '') return null; try { return JSON.parse(s); } catch { return null; } }; // 兜底：拼坏的 JSON 按空的算，下面会算进「原因空或拼坏」

// 数据库：连同 -wal 复制到临时目录再开（开一个 WAL 库会动 -shm，复制的那份怎么动都不碰数据目录）。
// 复制时 App 正好在写：前后看一眼大小和修改时间，变了就重来，最多三次。
function openLedger() {
  const src = at('state/offercrew.db');
  if (!fs.existsSync(src)) return null;
  const { DatabaseSync } = quietSqlite();
  const sig = () => ['', '-wal'].map(s => { try { const st = fs.statSync(src + s); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; } }).join('|');
  for (let i = 0; i < 3; i++) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-health-'));
    try {
      const before = sig();
      fs.copyFileSync(src, path.join(tmp, 'h.db'));
      if (fs.existsSync(src + '-wal')) fs.copyFileSync(src + '-wal', path.join(tmp, 'h.db-wal'));
      if (sig() !== before && i < 2) continue;
      const d = new DatabaseSync(path.join(tmp, 'h.db'));
      const has = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
      const jobs = has.has('jobs') ? d.prepare('SELECT * FROM jobs').all().map(r => ({ ...r })) : [];
      const actions = has.has('actions') ? d.prepare('SELECT * FROM actions').all().map(r => ({ ...r })) : [];
      d.close();
      return { jobs, actions };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return null;
}
function quietSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) { if (/SQLite is an experimental feature/.test(String(typeof w === 'string' ? w : w?.message))) return; return emit.call(process, w, ...rest); };
  try { return process.getBuiltinModule('node:sqlite'); } finally { process.emitWarning = emit; }
}

// ── 规则 ─────────────────────────────────────────────────────────────────────
// 卡的状态 → 账上该在的状态（lib/task-ledger.mjs cardState 的同一张表；待认领、手机上开的等电脑确认算「等你」）。
const CARD_STATE = { unclaimed: 'waiting_you', queued: 'queued', running: 'running', needs_you: 'waiting_you', stuck: 'failed', done: 'done', cancelled: 'cancelled' };
const cardWants = c => (c.status === 'queued' && c.mac_hold ? 'waiting_you' : CARD_STATE[c.status] || 'queued');
const OPEN = new Set(['queued', 'running', 'waiting_you', 'failed']);
const OUTBOUND_CARD = new Set(['apply', 'send']);
const OUTBOUND_ACTION = new Set(['send_email', 'send_dm', 'prefill', 'submit']);
const FALLBACK = /原因没记下来|原因见详情|原因不明|未知原因|未知错误|出了点问题|发生错误|详见日志|要你看一下$|unknown error|something went wrong/i;
const BROKEN = /\bundefined\b|\bnull\b|\[object Object\]|\bNaN\b|^[、，,：:；;]|[、，,：:]$|……$/;
const SNAKE = /(?<![\w./@:-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w./@-])/;
const URLISH = /\bhttps?:\/\/\S+|(?:[\w.-]+\/)+[\w.-]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LOCAL_AI = /本机\s*AI/;
// 同一句重复：按标点切开，相邻两段一样（「原因见详情、原因见详情」）。
const repeats = s => { const parts = String(s).split(/[、，,；;。]/).map(x => x.trim()).filter(x => x.length >= 2); return parts.some((p, i) => i && p === parts[i - 1]); };
const textOf = v => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export function check({ cards: rawCards = [], ledger = null, hostJobs = [], now = NOW } = {}) {
  // 并进别的卡的（merged_into，升级时并的）不算：列表上不出现，那件活也收掉了。
  const cards = lastRev(rawCards).filter(c => c?.id && !c.legacy && !c.merged_into);
  const num = c => { const n = c?.leads?.[0]?.number; return n != null ? `#${n}` : null; };
  const cardId = c => [c.id, num(c)].filter(Boolean).join(' ');
  const out = {
    card_ledger: { name: '卡和账对不上', parts: { no_job: [], no_card: [], state_differs: [], outbound_without_action: [] } },
    stale: { name: '等了很久没人接', parts: { queued_job: [], unclaimed_action: [], claimed_silent: [], waits_local_ai: [], hostjob_pending: [] } },
    bad_reason: { name: '原因空着或拼坏', parts: { empty: [], fallback: [], broken: [] } },
    duplicates: { name: '重复卡', parts: { groups: [] } },
    raw_code: { name: '带原始错误码', parts: { jobs: [], actions: [], cards: [] } },
  };
  const jobs = ledger?.jobs || [], actions = ledger?.actions || [];
  const byRef = new Map(jobs.filter(j => j.ref).map(j => [j.ref, j]));
  const actsOf = new Map(); for (const a of actions) actsOf.set(a.job_id, [...(actsOf.get(a.job_id) || []), a]);

  // 卡和账
  if (ledger) {
    const ids = new Set(lastRev(rawCards).map(c => c?.id)); // 并进别的卡的那几张也是卡：它们的活不算没卡
    for (const c of cards) {
      const j = byRef.get(`card:${c.id}`);
      if (!j) { out.card_ledger.parts.no_job.push(cardId(c)); continue; }
      // 目标卡的状态由下面的卡推（lib/task-ledger.mjs syncCardJobs），文件里存的那个不作数。
      if (c.kind !== 'goal' && cardWants(c) !== j.state) out.card_ledger.parts.state_differs.push(`${cardId(c)}=${j.id}`);
      const w = json(j.what), unheld = ['queued', 'running'].includes(j.state) || (j.state === 'waiting_you' && !(w?.ask_id || w?.href));
      if (OUTBOUND_CARD.has(c.kind) && unheld && !(actsOf.get(j.id) || []).length) out.card_ledger.parts.outbound_without_action.push(`${cardId(c)}=${j.id}`);
    }
    for (const j of jobs) if (/^card:/.test(j.ref || '') && !ids.has(j.ref.slice(5).split('#')[0])) out.card_ledger.parts.no_card.push(j.id);
  }

  // 等了很久没人接
  for (const j of jobs) {
    const free = !j.not_before || T(j.not_before) <= now;
    if (j.state === 'queued' && free && now - T(j.updated_at) > 10 * MIN) out.stale.parts.queued_job.push(j.id);
    if (OPEN.has(j.state) && j.state !== 'failed' && LOCAL_AI.test(`${textOf(j.reason)} ${textOf(j.what)}`)) out.stale.parts.waits_local_ai.push(j.id);
  }
  for (const a of actions) {
    const free = !a.hold && (!a.not_before || T(a.not_before) <= now);
    if (a.state === 'approved' && free && now - T(a.updated_at) > 10 * MIN) out.stale.parts.unclaimed_action.push(a.id);
    if (a.state === 'claimed' && OUTBOUND_ACTION.has(a.kind) && now - T(a.updated_at) > 30 * MIN) out.stale.parts.claimed_silent.push(a.id);
  }
  const migrated = new Set(jobs.map(j => j.ref).filter(r => /^hostjob:/.test(r || '')).map(r => r.slice(8)));
  for (const h of lastRev(hostJobs)) if (['pending', 'working', 'open'].includes(h.status) && !migrated.has(h.id) && now - T(h.updated_at || h.created_at) > 10 * MIN) out.stale.parts.hostjob_pending.push(h.id);

  // 原因
  const judge = (id, state, reason, what) => {
    if (!['failed', 'waiting_you'].includes(state)) return;
    const r = String(reason ?? '').trim();
    if (!r) out.bad_reason.parts.empty.push(id);
    else if (FALLBACK.test(r)) out.bad_reason.parts.fallback.push(id);
    else if (BROKEN.test(r) || repeats(r) || (state === 'waiting_you' && what && !what.label)) out.bad_reason.parts.broken.push(id);
  };
  for (const j of jobs) judge(j.id, j.state, j.reason, json(j.what));
  for (const a of actions) if (['failed', 'uncertain'].includes(a.state)) judge(a.id, 'failed', a.reason, null);

  // 原始错误码
  const coded = s => SNAKE.test(String(s ?? '').replace(URLISH, ' '));
  for (const j of jobs) if (OPEN.has(j.state) && (coded(j.reason) || coded(json(j.what)?.label))) out.raw_code.parts.jobs.push(j.id);
  for (const a of actions) if (['failed', 'uncertain', 'requested', 'approved'].includes(a.state) && coded(a.reason)) out.raw_code.parts.actions.push(a.id);
  for (const c of cards) if (!['done', 'cancelled'].includes(c.status) && (coded(c.detail) || coded(c.need_title) || (c.status === 'stuck' && coded(c.result)))) out.raw_code.parts.cards.push(cardId(c));

  // 重复卡
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const groups = new Map();
  for (const c of cards) {
    if (c.status === 'cancelled') continue;
    const l = c.leads?.[0], target = l?.rid || (l?.number != null ? `#${l.number}` : '') || c.url || '';
    const k = `${c.kind}|${norm(c.title)}|${target}`;
    groups.set(k, [...(groups.get(k) || []), c]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const open = list.filter(c => !['done', 'cancelled'].includes(c.status));
    const times = list.map(c => T(c.created_at)).sort((a, b) => a - b);
    const close = times.some((t, i) => i && t - times[i - 1] <= 10 * MIN);
    if (open.length >= 2 || close) out.duplicates.parts.groups.push(list.map(cardId).join('+'));
  }

  for (const v of Object.values(out)) v.count = Object.values(v.parts).reduce((n, l) => n + l.length, 0);
  return out;
}

// ── 跑 ───────────────────────────────────────────────────────────────────────
let main = false; try { main = fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {} // 兜底：路径解析不了就不是直接运行
if (main) {
  if (!fs.existsSync(at('state'))) { console.error(`没有数据目录：${ROOT}/state`); process.exit(2); }
  const ledger = openLedger();
  const result = check({ cards: rows('state/tasks.ndjson'), ledger, hostJobs: rows('state/host-jobs.ndjson') });
  const total = Object.values(result).reduce((n, v) => n + v.count, 0);
  if (argv.includes('--json')) console.log(JSON.stringify({ root: ROOT, ledger: !!ledger, total, checks: result }, null, 2));
  else {
    console.log(`OfferCrew 数据体检（只读）  ${new Date(NOW).toISOString()}`);
    console.log(`数据目录：${ROOT}${ledger ? '' : '（还没有账：state/offercrew.db 不在，卡和账没法对）'}`);
    for (const v of Object.values(result)) {
      console.log(`${v.name.padEnd(8, '　')}  ${v.count}`);
      for (const [k, list] of Object.entries(v.parts)) if (list.length) console.log(`    ${k} ${list.length}：${list.slice(0, 40).join('  ')}${list.length > 40 ? `  …另 ${list.length - 40} 个` : ''}`);
    }
    console.log(`合计 ${total}${total ? '' : '，过了'}`);
  }
  process.exit(total ? 1 : 0);
}
