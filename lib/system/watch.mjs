// System 监工的一拍（L 线第 2 批 2b）：拿健康账本那几样手的现状（招聘源、任务卡、心跳、操作台、各步的事件）对照标准做法表
// （lib/system/playbook.mjs），做掉能做的；每做一下记一行（lib/system/actions.mjs recordAction：运行日志 + 动作账）。
// bin/serve.mjs 每分钟调一次。沙盒里不动手，每样只记一行「sandbox: skipped …」（lib/sandbox.mjs，10 分钟内不重复）。
// 要用的东西都能注入：测试给假的 runOp、事件、卡，不起真脚本。
import { lines, read, write } from '../store.mjs';
import { event, tailEvents } from '../events.mjs';
import { errorReason } from '../say-error.mjs';
import { dayOf } from '../fallback.mjs';
import { sandboxed, sandboxSkip } from '../sandbox.mjs';
import { moveCard } from '../card-ops.mjs';
import { readCards, saveCards, addStep } from '../cards.mjs';
import { updateSource, sourceEntries } from '../sources.mjs';
import { PATH as HEARTBEAT_PATH, clearTask } from '../executor-heartbeat.mjs';
import { opsStatus, runOp, opLog } from '../ops.mjs';
import { OPS } from '../ops-table.mjs';
import { alive } from '../browser-host.mjs';
import { agentPaused } from '../agents.mjs';
import { stageHeld } from '../spend.mjs';
import { textReady } from '../model.mjs';
import { ACTIONS_PATH, recordAction, WATCH_STATE, loadWatch } from './actions.mjs';
import { playbookConfig, undoPlay, planSources, planTasks, planReruns } from './playbook.mjs';

const DEPS = { updateSource, sourceEntries, saveCards, addStep, moveCard, clearTask, opsStatus, runOp };
const tail = rec => { try { return opLog(rec.id, 2000).tail; } catch { return ''; } }; // 兜底：运行记录不在就没有最后几行

// 备一份 ctx：给了就用给的，没给读本机。
export function watchContext({ now = Date.now(), deps = {}, ...given } = {}) {
  return {
    now, config: given.config || playbookConfig(),
    actions: given.actions || lines(ACTIONS_PATH),
    entries: given.entries || sourceEntries(),
    report: given.report || read('state/discovery-sources.json', {}) || {},
    cards: given.cards || readCards(),
    heartbeat: given.heartbeat || read(HEARTBEAT_PATH, { tasks: {} }) || { tasks: {} },
    ops: given.ops || read('state/ops.json', { current: null, history: [] }) || {},
    events: given.events || tailEvents(4000),
    opTail: given.opTail || tail,
    alive: given.alive || alive,
    opRole: given.opRole || (op => OPS[op]?.role || 'patch'),
    paused: given.paused || (m => agentPaused(m)),
    held: given.held || (op => !!stageHeld(op, { quiet: true })),
    ready: given.ready || (role => textReady({ role }).ok),
    deps: { ...DEPS, ...deps },
  };
}

// 监工自己出错（兜底清单复核 N04）：以前动作没做成只收进 failed、整拍抛错只打一行 console，谁都看不见。
// 现在：每个动作没做成，同一个动作一天记一行事件；整拍抛错也一天一行；连着几拍都抛错，健康账本里出一行「监工停了」
// （lib/system/actions.mjs watchDown，健康账本读它）。记在 state/system-watch.json：{ day, said: [当天说过的], tick_errors }。
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const saveWatch = s => { try { write(WATCH_STATE, s); } catch {} }; // 兜底：存不进去最多同一件事再说一次
// 同一件事（key）同一天只说一次；说了返回 true。
function sayOnce(state, key, now, say) {
  const day = dayOf(now);
  if (state.day !== day || !Array.isArray(state.said)) { state.day = day; state.said = []; }
  if (state.said.includes(key)) return false;
  state.said.push(key);
  try { say(); } catch {} // 兜底：记事件本身失败不影响监工接着做
  return true;
}

// 一拍。返回 { done: [动作账的行], sandbox: [只记了一行的], failed: [{ play, hand, error }] }。
export async function tickWatch({ now = Date.now(), sandbox = sandboxed(), ...rest } = {}) {
  const ctx = watchContext({ now, ...rest });
  const plans = [...planSources(ctx), ...planTasks(ctx), ...planReruns(ctx)];
  const done = [], skipped = [], failed = [];
  for (const p of plans) {
    if (sandbox) { sandboxSkip(`System 标准做法 ${p.play}：${p.text}`, { actor: 'system' }); skipped.push(p.text); continue; }
    // 动不了（脚本通道刚被占、锁等不到）：这一拍不记，下一拍再看。
    try { await p.act(); } catch (e) { failed.push({ play: p.play, hand: p.hand, text: p.text, error: String(e?.message || e).slice(0, 200) }); continue; }
    done.push(recordAction({ play: p.play, hand: p.hand, member: p.member, why: p.why, before: p.before, undo: p.undo, text: p.text, now }));
  }
  if (failed.length) {
    const st = loadWatch();
    let said = false;
    for (const f of failed) said = sayOnce(st, `act:${f.play}:${f.hand}`, now, () => event('system', 'system-watch', 'fail', `监工想做的一件事没做成：${cut(f.text, 60)}（${errorReason(f.error)}），下一拍再试`, { play: f.play, hand: f.hand, error: cut(f.error, 200) })) || said;
    if (said) saveWatch(st);
  }
  return { done, sandbox: skipped, failed };
}

// bin/serve.mjs 每分钟调这个：一拍跑完清掉连错的数；整拍抛错就数一下，一天记一行事件。不往外抛。
export async function watchTick(opts = {}) {
  const now = opts.now ?? Date.now(), run = opts.tick || tickWatch;
  try {
    const r = await run(opts);
    const st = loadWatch();
    if (st.tick_errors) { delete st.tick_errors; saveWatch(st); }
    return r;
  } catch (e) {
    const st = loadWatch(), why = errorReason(e), prev = st.tick_errors || {};
    st.tick_errors = { streak: (Number(prev.streak) || 0) + 1, since: prev.since || new Date(now).toISOString(), last_at: new Date(now).toISOString(), why: cut(why, 120) };
    sayOnce(st, 'tick', now, () => event('system', 'system-watch', 'fail', `监工这一拍没跑完（${why}），下一分钟再试`, { error: cut(String(e?.message || e), 200) }));
    saveWatch(st);
    return { done: [], sandbox: [], failed: [], error: String(e?.message || e).slice(0, 200) };
  }
}

// 团队页的「撤销」「恢复」（POST /api/system/undo）。
export const undoSystemAction = (id, { by = 'you', now = Date.now(), deps = {} } = {}) => undoPlay(id, { by, now, deps: { ...DEPS, ...deps } });
