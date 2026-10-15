// 标准做法 P1：模型熔断（方案-System监工-第2批.md 第三节；负责人 10-02 定的规矩，主会话 10-03 改成按底座算、要来信）。
// 一个底座钥匙失效（401、403），或者连续 N 次不可重试的错，就先跳过它 M 分钟，按清单试下一个；用到它的成员一起跳过，
// 动作账上只记一行。到点不另外调模型去探，下一次真实调用照常先试它：好了就恢复，又错一次就再停 M 分钟。
// 清单里只剩它一个时不跳过（也不停：停了也没有别的可换），只数次数。撤销 = 团队页的「恢复」（lib/system/playbook.mjs undoPlay）。
//
// 不悄悄换模型（负责人 10-03「把兜底去掉，不然出了问题很难排查」）：钥匙失效、没配好、模型不存在、额度用完这几类要你出手的错，
// 换了下一个就同时在收件箱来一封信（modelFaultAsks）：「你配的 X 钥匙失效了，暂时改用 Y」。一个底座一封，状态变了改那一封；
// 底座好了、或者你改了配置（模型、成员、供应商的设置，或者这个底座的钥匙文件），信就没了。网络、5xx 这类暂时的错只进运行日志。
//
// 状态在 state/model-breaker.json：{ "<底座 id>": { backend, label, provider, auth_file, members, fails, kind, last_error, last_at,
//   opened_at, until, action_id, fault: { kind, at, to, to_label }, sig } }。sig：记下时配置的指纹，配置一改这一条就作废。
// 几个进程（工作台、周期里的各步）会同时写：读、改、写在一把锁里（wx 锁文件、短超时，等不到这一次就不记），
// 写的时候先写带进程号的临时文件再改名。这里只依赖本机的文件（lib/model.mjs 每次调用都要过它）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { read, file } from '../store.mjs';
import { crewName } from '../crew.mjs';
import { modelErrorKind } from '../say-error.mjs';
import { FREE_PROVIDER } from '../free-model.mjs';
import { recordAction } from './actions.mjs';
import { noteSwallowed } from '../swallow.mjs';

export const BREAKER_PATH = 'state/model-breaker.json';
const LOCK_PATH = 'state/model-breaker.lock';
// model_breaker_failures：不可重试的错连续几次；model_breaker_retryable_failures：404、429、5xx 这类「可重试」的错连续几次（兜底清单 A05：
// 以前它们不算数，一个一直 503 的底座每次都先试、失败、再换，永远停不下来）。
export const BREAKER_DEFAULTS = { model_breaker_minutes: 30, model_breaker_failures: 3, model_breaker_retryable_failures: 3 };
export function breakerConfig(host = read('config/host.json', {})) {
  const c = { ...BREAKER_DEFAULTS, ...(host?.system_playbook || {}) };
  return { minutes: Math.max(1, Number(c.model_breaker_minutes) || 30), failures: Math.max(1, Number(c.model_breaker_failures) || 3), retryable: Math.max(1, Number(c.model_breaker_retryable_failures) || 3) };
}
const load = () => {
  const s = read(BREAKER_PATH, {});
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  // Old bare-403 classifier could persist a false key fault. Discard only when its saved evidence disproves that class.
  return Object.fromEntries(Object.entries(s).filter(([, e]) => !(e.kind === 'key' && e.last_error && modelErrorKind(e.last_error).kind !== 'key')));
};
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hhmm = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const idOf = b => (typeof b === 'string' ? b : b?.id) || null;
const labelOf = b => (typeof b === 'string' ? b : b?.label || (b?.model ? `${b.model} · ${b.provider_label || b.provider || ''}`.replace(/ · $/, '') : b?.id)) || '';

// ── 锁和原子写 ────────────────────────────────────────────────────────────────
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// 不等：模型调用也在工作台进程里发生，Atomics.wait 会把整个工作台卡住（线 S，契约第五节）。别的进程正拿着锁就这一次不记。
function lock() {
  const p = file(LOCK_PATH), mine = JSON.stringify({ pid: process.pid, at: Date.now(), n: Math.random() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  for (;;) {
    try { fs.writeFileSync(p, mine, { flag: 'wx' }); return () => { try { if (fs.readFileSync(p, 'utf8') === mine) fs.rmSync(p, { force: true }); } catch {} }; } // 兜底：锁已经被别人清掉了，不用再放
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let raw = '', held = null;
    try { raw = fs.readFileSync(p, 'utf8'); held = JSON.parse(raw); } catch {} // 兜底：另一个进程正在写或刚删，读不出就当锁没人持有，下面只删刚才读到的那一份
    // 持锁的进程没了、或者锁放了 10 秒还在：当它是死锁，只删刚才读到的那一份。
    if (!held || !alive(held.pid) || Date.now() - held.at > 10000) { try { if (fs.readFileSync(p, 'utf8') === raw) fs.rmSync(p, { force: true }); } catch {} continue; } // 兜底：读和删之间锁被别人换了或已经删了，不动它
    return null;
  }
}
function save(state) {
  const p = file(BREAKER_PATH), tmp = `${p}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
// 读、改、写一气呵成；锁等不到就这一次不记（少数一次失败，不拖住模型调用）。fn 返回 false 表示没改，不写。
function mutate(fn) {
  const release = lock();
  if (!release) return null;
  try { const state = load(), out = fn(state); if (out !== false) save(state); return out; } finally { release(); }
}

// 配置的指纹：模型、成员、供应商的设置原文，加上这个底座钥匙文件的修改时间（只看时间，不读钥匙）。你改了哪一样，记下的就作废。
export function configSig(authFile = null) {
  const h = crypto.createHash('sha1');
  for (const p of ['config/model.json', 'config/roles.json', 'config/providers.json']) { try { h.update(fs.readFileSync(file(p))); } catch { h.update('-'); } h.update('\n'); }
  if (authFile) { try { h.update(String(fs.statSync(file(authFile)).mtimeMs)); } catch { h.update('-'); } }
  return h.digest('hex').slice(0, 16);
}
const current = (e, sigs = new Map()) => { const k = e.auth_file || ''; if (!sigs.has(k)) sigs.set(k, configSig(e.auth_file)); return e.sig === sigs.get(k); };

// ── 选底座 ───────────────────────────────────────────────────────────────────
// 正停着的那一条（到点了的不算停着：下一次真实调用就是探一次；配置改过的也不算：新钥匙马上试）。
export function openBreakers({ now = Date.now(), state = load() } = {}) {
  const sigs = new Map();
  return Object.values(state).filter(b => Date.parse(b.until || '') > now && current(b, sigs));
}
// 跳过停着的；跳完一个不剩就照原样（清单里只剩它一个时不跳过）。按底座算，哪位成员调都一样。
export function skipBroken(order, member, { now = Date.now(), state = load() } = {}) {
  if (!Object.keys(state).length) return { order, skipped: [] };
  const open = new Set(openBreakers({ now, state }).map(b => b.backend));
  const keep = order.filter(b => !open.has(b.id)), byId = new Map(Object.values(state).map(e => [e.backend, e]));
  return keep.length ? { order: keep, skipped: order.filter(b => !keep.includes(b)).map(b => b.id), why: Object.fromEntries(order.filter(b => !keep.includes(b)).map(b => [b.id, byId.get(b.id)?.last_error || ''])) } : { order, skipped: [] };
}

// 钥匙失效：不管这个错算不算可重试（本机 codex 退出码非零一律算可重试，可里面写着 401），一次就停。
// 要你出手的错：钥匙、没配好、模型不存在、额度。清单里还有别的就换下一个试，同时来信。
const YOURS = new Set(['key', 'no_model', 'missing', 'quota', 'region']);
const kindOf = msg => modelErrorKind(msg).kind;
export function backendFault(e) {
  if (!e || e.sandbox || e.code === 'ESANDBOX') return false;
  return YOURS.has(kindOf(String(e.message || e)));
}

// 「可重试」的错里，哪些是这个底座自己的问题（对方回了 404、429、5xx）：照次数算（A05）。
const SERVER = /(?<!\d)(?:404|429|5\d\d)(?!\d)/;
// 网络不通、超时、本机程序没起来：可能是整台电脑断网，也可能只是这一个底座连不上。只有同一次调用里后面的底座调通了
// （confirmed，lib/model.mjs 在调通以后补记）才算到它头上；全都失败多半是这台电脑的网断了，不算、也不清零。
export const isLocalOrNetwork = e => !!e?.retryable && !SERVER.test(String(e?.message ?? e ?? '')) && !e?.free_blocked;
// 一次失败。b：底座（infer 里的那一个）；others：清单里除了它还有没有别的（没有就只数，不停）。返回这次停下的那一条，或者 null。
export function noteFailure({ member, backend: b, error, others = false, confirmed = false, now = Date.now(), config = breakerConfig() } = {}) {
  const id = idOf(b);
  if (!id || error?.sandbox || error?.code === 'ESANDBOX') return null;
  const msg = String(error?.message ?? error ?? ''), kind = kindOf(msg), key = kind === 'key';
  // 免费额度被拒有它自己的那封信（lib/spend.mjs freeModelAsks），这里不另写。
  const yours = YOURS.has(kind) && b?.provider !== FREE_PROVIDER, counted = !error?.retryable || key;
  // 免费额度被中转拒着有它自己的状态（lib/free-model.mjs freeBlocked），不算到熔断上。
  const soft = !counted && !error?.free_blocked && (SERVER.test(msg) || (confirmed && isLocalOrNetwork(error)));
  if (!counted && !soft && !yours) return null; // 没确认的网络、超时：运行日志里已经有了，不算、也不清零
  const auth = typeof b === 'object' ? b.auth_file || null : null, sig = configSig(auth);
  let trip = null;
  mutate(state => {
    let e = state[id];
    if (e && e.sig !== sig) e = null; // 你改过配置：从头数
    e ||= { backend: id, label: labelOf(b), provider: b?.provider || null, auth_file: auth, members: [], fails: 0 };
    Object.assign(e, { sig, kind, last_error: cut(msg, 160), last_at: new Date(now).toISOString() });
    if (member && !e.members.includes(member)) e.members.push(member);
    if (counted) e.fails = (e.fails || 0) + 1;
    if (soft) e.soft = (e.soft || 0) + 1;
    if (yours && others) e.fault = e.fault?.kind === kind ? e.fault : { kind, at: new Date(now).toISOString(), to: null, to_label: null };
    const open = Date.parse(e.until || '') > now, probing = !!e.until && !open; // 停过、到了点：这一次就是探，错了马上再停
    if (others && (counted || soft) && !open && (key || probing || e.fails >= config.failures || e.soft >= config.retryable)) {
      const until = now + config.minutes * 60000;
      Object.assign(e, { opened_at: new Date(now).toISOString(), until: new Date(until).toISOString() });
      trip = { e, until, why: key ? '钥匙失效（401 / 403）' : probing ? '到点再试还是不行' : `连续 ${Math.max(e.fails || 0, e.soft || 0)} 次没调通` };
    }
    state[id] = e;
  });
  if (!trip) return null;
  // 动作账只记一行（不管几位成员在用它）；记完把这一行的编号写回去，撤销用。
  try {
    const { e, until, why } = trip;
    const row = recordAction({ play: 'P1', hand: `backend:${id}`, member: e.members[0] || member || 'patch', why: `${id}：${why}；最后的错 ${e.last_error}`, before: { backend: id, fails: e.fails, members: e.members }, undo: { how: 'close_breaker', key: id, until: e.until },
      text: `${e.label || id} ${why}，先换清单里的下一个，${hhmm(until)} 再试`, now });
    mutate(state => { if (!state[id]) return false; state[id].action_id = row.id; });
  } catch (err) { noteSwallowed('breaker.recordTrip', err, { doing: `把「先停用 ${id}」记进 System 的动作账`, then: '照样停用，动作账里少一行、撤销不了' }); }
  return trip.e;
}

// 一次成功。used：这次调通的底座；failed：这次在它前面失败过的那几个（要你出手的，信上写「暂时改用 used」）。
export function noteSuccess({ member, backend: used, failed = [], now = Date.now() } = {}) {
  const id = idOf(used);
  if (!id) return null;
  const peek = load(), ids = failed.map(idOf).filter(x => x && peek[x]?.fault);
  if (!peek[id] && !ids.length) return null;
  let back = null;
  mutate(state => {
    if (state[id]) { back = state[id]; delete state[id]; }
    for (const x of ids) { const e = state[x]; if (!e?.fault) continue; Object.assign(e.fault, { to: id, to_label: labelOf(used) }); if (member && !e.members.includes(member)) e.members.push(member); }
  });
  if (back?.until) try { recordAction({ play: 'P1', hand: `backend:${id}`, member: back.members?.[0] || member || 'patch', why: `${id} 到点再试，调通了`, before: { backend: id, until: back.until }, undo: null, text: `${back.label || id} 又能用了，照清单的顺序用回它`, now }); } catch (e) { noteSwallowed('breaker.recordBack', e, { doing: `把「${id} 又能用了」记进 System 的动作账`, then: '照样用回它' }); }
  return back;
}

// 撤销（团队页「恢复」）：清掉这一条，下一次调用照清单的顺序先试它。
export function closeBreaker(id) {
  return !!mutate(state => { if (!state[id]) return false; delete state[id]; return true; });
}

// 现在还算数的、要你出手才好的那几条（钥匙失效、模型不存在、没配好；额度会自己恢复，不算）：给顶上的横条用（lib/blockers.mjs）。
// 底座调通了这一条就删了；你改了配置（指纹变了）就不算数：和收件箱那封信同一个判断。
const BLOCKING = new Set(['key', 'missing', 'no_model', 'region']);
export function yourFaults({ state = load() } = {}) {
  const sigs = new Map();
  return Object.values(state).filter(e => BLOCKING.has(e.kind) && current(e, sigs));
}
export const FAULT_WORDS = { key: '钥匙失效了', quota: '额度用完了', missing: '不存在', no_model: '没配好', region: '连不上（这台电脑所在的地区要开代理）' };

// ── 收件箱：你配的模型要你出手 ─────────────────────────────────────────────────
const FAULT_TEXT = FAULT_WORDS;
export function modelFaultAsks({ now = Date.now(), state = load() } = {}) {
  const sigs = new Map();
  return Object.values(state).filter(e => e.fault?.to && current(e, sigs)).map(e => {
    const names = (e.members || []).map(m => crewName(m) || m).join('、') || '团队';
    const open = Date.parse(e.until || '') > now;
    return {
      from: 'patch', id: `model-fault:${e.backend}`, type: 'info', tag: '模型',
      title: `你配的 ${e.label || e.backend} ${FAULT_TEXT[e.fault.kind] || '用不了'}，暂时改用 ${e.fault.to_label || e.fault.to}`,
      question: `改好之前，${names}要用它的活都由 ${e.fault.to_label || e.fault.to} 做。`,
      context: ['设置 → 模型'],
      facts: [{ k: '用到它的', v: names }, ...(open ? [{ k: '下次再试', v: hhmm(e.until) }] : [])],
      options: [
        { key: '1', label: '看原因', steps: [{ type: 'explain', reason: e.last_error, who: e.members?.[0] || null, backend: e.label || e.backend, switched_to: e.fault.to_label || e.fault.to }] },
        { key: '2', label: '打开设置', primary: true, steps: [{ type: 'navigate', to: '#settings/model' }] },
      ],
      other: null,
      // 额度用完会自己恢复（不算你的错，见上面 BLOCKING）：只是告诉你一声，写进运行日志（lib/notices.mjs）。钥匙、模型名、地区要你改的照旧进收件箱。
      notice: !BLOCKING.has(e.fault.kind),
    };
  });
}
