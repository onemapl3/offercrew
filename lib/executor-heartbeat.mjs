// Is the executor still moving?
//
// An auto-apply run or a run-now pass can stall: a page waits for a verification
// code, a portal asks for real-name identity, a daily submission cap is reached,
// or the process dies. Silence then looks exactly like progress. Every executor
// writes a step here, and the resident service turns a task with no new step for
// ten minutes — or one that ended badly, or one parked on something only the
// user can do — into one message in the command room, and stops retrying it
// until the user says it is unblocked (the user's 2026-09-15 rule).
import { read, write, hash } from './store.mjs';

import { TZ } from './tz.mjs';

export const PATH = 'state/executor-heartbeat.json';
export const STUCK_MS = 10 * 60000;
export const CHECK_MS = 5 * 60000;
// Steps that are not a stall but a handover: only the user can finish them.
export const NEEDS_USER = {
  verification_code: '需要邮箱验证码',
  identity: '需要实名认证',
  captcha: '需要人工过验证码图形验证',
  login: '需要重新登录该门户',
  quota: '触发对方的投递上限',
  payment: '需要本人确认付费或订阅',
};
export const needsUserLabel = step => NEEDS_USER[step] || null;

// One step of one task. `task` is stable for the life of that task (the lead
// number for a submission, the run id for the immediate executor).
// history：最近几步（给对话浮层的任务卡看「谁在做什么」：Pilot：打开申请页 → 填好 12 栏 → 停在终审）。
export const HISTORY = 12;
export function beat({ executor, task, step, detail = '', status = 'working', now = Date.now(), path = PATH } = {}) {
  const state = read(path, { tasks: {} });
  const key = `${executor}:${task}`;
  const prior = state.tasks[key] || { executor, task, started_at: new Date(now).toISOString(), steps: 0 };
  const at = new Date(now).toISOString(), text = String(detail).slice(0, 200);
  state.tasks[key] = {
    ...prior,
    executor, task, step, detail: text, status,
    steps: (prior.steps || 0) + 1,
    updated_at: at,
    history: [...(prior.history || []), { step, detail: text, status, at }].slice(-HISTORY),
    ...(status === 'done' || status === 'failed' ? { finished_at: at } : {}),
  };
  write(path, state);
  return state.tasks[key];
}

// 收掉一项时它走过的步留在 finished 里（最近 30 项）：任务卡在事情做完之后还能展开看它是怎么做的。
export const FINISHED = 30;
export const clearTask = ({ executor, task, now = Date.now(), path = PATH } = {}) => {
  const state = read(path, { tasks: {} });
  const key = `${executor}:${task}`, t = state.tasks[key];
  if (t?.history?.length) state.finished = [...(state.finished || []).filter(f => f.key !== key), { key, executor: t.executor, task: t.task, started_at: t.started_at || null, finished_at: new Date(now).toISOString(), status: t.status, history: t.history }].slice(-FINISHED);
  delete state.tasks[key];
  write(path, state);
};

// Tasks that need saying out loud, and tasks that started moving again.
export function stuckTasks({ state = read(PATH, { tasks: {} }), now = Date.now(), timeoutMs = STUCK_MS } = {}) {
  const stuck = [], recovered = [];
  for (const [key, t] of Object.entries(state.tasks || {})) {
    const idle = now - Date.parse(t.updated_at || t.started_at || 0);
    const needsUser = needsUserLabel(t.step);
    const reason = needsUser
      ? { kind: 'needs_user', label: needsUser }
      : t.status === 'failed'
        ? { kind: 'failed', label: `本机 AI 异常退出：${t.detail || '原因未记录'}` }
        : t.status !== 'done' && idle >= timeoutMs
          ? { kind: 'idle', label: `已有 ${Math.round(idle / 60000)} 分钟没有新进展，停在「${t.step || '未记录步骤'}」` }
          : null;
    if (reason && !t.alerted_at) stuck.push({ key, ...t, reason });
    // Alerted, then moved again or finished: the user hears that too.
    if (t.alerted_at && (t.status === 'done' || (!reason && idle < timeoutMs))) recovered.push({ key, ...t });
  }
  return { stuck, recovered };
}





// A task the alert marked blocked is not retried by the executors.
export const blockedTasks = ({ state = read(PATH, { tasks: {} }) } = {}) =>
  new Set(Object.values(state.tasks || {}).filter(t => t.blocked_at).map(t => String(t.task)));
