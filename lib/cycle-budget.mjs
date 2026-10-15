// 周期的时间预算（2026-09-23）。
//
// 以前各阶段超时相加约 5 小时，bin/scheduled.mjs 却只给整轮 60 分钟。电脑在周期中途合盖
// 睡眠时，每个阶段都睡到自己的超时才被杀（project-base 5 分钟用了 16 分钟墙钟、
// find-contacts 30 分钟用了 50 分钟），守卫在 find-referrers 里把整轮杀掉，后面的看板、
// 进度、清单、飞书同步和指标一个都没跑。
//
// 现在整轮按墙钟给预算：尾段（TAIL）每段预留一格、必跑；其余阶段只能用到「截止 − 后面尾段的
// 预留」，剩不到一分钟就跳过，没做完的线索、公司留在状态里等下一轮。bin/scheduled.mjs 的守卫
// 取同一份预算加余量，所以守卫只在周期本身卡死时才出手。
export const TAIL = ['prepare-interviews', 'host-work', 'metrics'];
// bin/scheduled.mjs：守卫 SIGTERM 周期后等多久再 SIGKILL（周期退出前要先收掉在跑的阶段，最多
// STAGE_KILL_GRACE_MS，见 lib/stage-runner.mjs，所以这里更长）；bin/cycle.mjs：阶段之间写进度时最多等状态锁多久。
export const KILL_GRACE_MS = 30000, PROGRESS_WAIT_MS = 5000;
const MIN = 60000;
// 单阶段上限（分钟），实际给的是它与剩余预算中较小的一个。2026-09-21：飞书网络抖动时 pull-feedback
// 的多次 lark-cli（各 60 s）会累计超过 5 分钟。2026-09-23：匹配只兜 Jev 没判成的线索（近几轮 0–2 分钟），
// 60 → 20；judge-leads 每轮有条数上限（pipeline.judge_limit），30 → 15；宽扫描通常 3 分钟，30 → 20。
const CAPS = { 'pull-feedback': 10, 'discover': 15, 'discover-human-browser': 30, 'judge-leads': 15, 'match': 20, 'evaluate': 15, 'find-contacts': 30, 'find-referrers': 30, 'auto-apply': 30, 'mail-read': 10 };
export const stageCap = (stage, { wide = false } = {}) => (stage === 'discover' && wide ? 20 : CAPS[stage] || 5) * MIN;

// config/pipeline.json `cycle_budget`：full_minutes / light_minutes / tail_slot_seconds / guard_margin_minutes。
export function cycleBudget(mode, pipeline = {}) {
  const c = pipeline.cycle_budget || {};
  const total = (Number(c[`${mode}_minutes`]) || (mode === 'full' ? 45 : 20)) * MIN;
  // 尾段预留最多占预算一半：预算配小了也不至于把前面的阶段全挤掉。
  const slot = Math.min((Number(c.tail_slot_seconds) || 90) * 1000, total / 2 / TAIL.length);
  return { total, slot, guard: total + (Number(c.guard_margin_minutes) || 10) * MIN };
}

// stages[i] 此刻能用多少毫秒；0 = 预算已用完，跳过。尾段至少一格。
export function stageTimeout(stages, i, { end, slot, now = Date.now(), wide = false }) {
  const cap = stageCap(stages[i], { wide });
  const left = end - now - slot * stages.slice(i + 1).filter((s) => TAIL.includes(s)).length;
  if (TAIL.includes(stages[i])) return Math.min(cap, Math.max(slot, left));
  if (left < Math.min(MIN, slot)) return 0;
  // Deeper browser discovery must leave time to judge what it finds in this
  // same cycle. Only reserve when a judgement stage actually follows: an
  // explicit Scout-only run keeps its whole share. On short cycles scale the
  // reserve down, preserving both discovery and the existing tail slots.
  const judgingNext = stages.slice(i + 1).some(s => s === 'judge-leads' || s === 'match');
  const reserve = stages[i] === 'discover-human-browser' && judgingNext ? Math.min(5 * MIN, Math.max(Math.min(MIN, slot), left / 3)) : 0;
  if (left - reserve < Math.min(MIN, slot)) return 0;
  return Math.floor(Math.min(cap, left - reserve));
}
