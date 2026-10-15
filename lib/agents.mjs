// 「暂停」（指挥台团队条 ⋯ 里的 暂停 / 恢复 / 立即跑一轮）：成员是谁、各管哪几步在 lib/crew.mjs，这里只管暂停记录。
//   暂停 X = X 的定时工作先不做，直到你恢复：周期里 X 管的那几步跳过（bin/cycle.mjs；一步归两位的，两位都停才整步跳过，
//   只停一位就跳过它那一段，bin/prepare-interviews.mjs）；Quill 暂停时私信不自动发（bin/serve.mjs）；Owl 暂停时收件箱
//   巡检不跑（bin/host/mail-poll.sh）；Patch 暂停时飞书同步和自动修复不跑（bin/serve.mjs）。
//   你自己的反馈（pull-feedback：飞书里回的「联系 / pass」）照常处理，暂停谁都不挡它。
//   立即跑一轮 = 先恢复，再只跑它那几步（bin/cycle.mjs --only <成员>）。
// 执行器不是成员，它的开关还叫 executor（安装时选「以后再说」写的就是它）：暂停时即时执行器不拉起（bin/serve.mjs）、
//   宿主整轮不跑 Codex 那一步（bin/host/radar-cycle.sh）。页面上在 Patch 的 ⋯ 里开关（Patch 管运行）。
// 状态只有一个小文件 state/agent-pause.json：{ scout: { at, by }, executor: { at, by } }，只由工作台和安装程序写。
// 老记录按老编号写（{ radar: … }），照样生效：老编号原来管的那几步照旧跳过（lib/crew.mjs LEGACY_STAGE），页面上显示成
//   接手它的几位暂停了（LEGACY.pause：radar → Scout、Lens）。你在页面上动任何一位时，文件里的老编号先换成新编号再改。
import { read, write } from './store.mjs';
import { LEGACY, LEGACY_STAGE, isMember, crewName, stageMembers, stagesOfMember } from './crew.mjs';

// 暂停谁都照跑的步骤：处理你自己的反馈。
export const ALWAYS_RUN = new Set(['pull-feedback']);
export const PAUSE_PATH = 'state/agent-pause.json';
export const EXECUTOR = 'executor';
export const agentPauses = () => { const s = read(PAUSE_PATH, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
const on = (pauses, key) => !!pauses?.[key]?.at;
// 这位成员现在算不算暂停：自己的记录，或者接手的那个老编号的记录。executor 是执行器的开关。
export function agentPaused(key, pauses = agentPauses()) {
  if (key === EXECUTOR) return on(pauses, EXECUTOR);
  if (!isMember(key)) return on(pauses, key);
  return on(pauses, key) || Object.entries(LEGACY).some(([old, L]) => L.pause.includes(key) && on(pauses, old));
}
// 老编号 → 新编号（写之前做一次）：radar 的记录变成 scout、lens 各一条（时间和谁按的照抄），executor 和新编号原样。
export function migratePauses(pauses = agentPauses()) {
  const out = {};
  for (const [k, v] of Object.entries(pauses)) {
    if (!v?.at) continue;
    if (isMember(k) || k === EXECUTOR) out[k] = v;
    else if (Object.hasOwn(LEGACY, k)) for (const m of LEGACY[k].pause) if (!out[m]) out[m] = { ...v, from: k };
  }
  return out;
}
export function setAgentPaused(key, paused, { now = Date.now(), by = 'workbench' } = {}) {
  if (!isMember(key) && key !== EXECUTOR) throw Error('没有这位成员');
  const s = migratePauses(agentPauses());
  if (paused) s[key] = { at: new Date(now).toISOString(), by }; else delete s[key];
  write(PAUSE_PATH, s);
  return s;
}
// 这一步因为谁暂停而跳过（没有就是 null）：它的几位主人都停了（返回第一位），或者它原来那个老编号的记录还在（返回老编号）。
export function stagePausedBy(stage, pauses = agentPauses()) {
  if (ALWAYS_RUN.has(stage)) return null;
  const owners = stageMembers(stage);
  if (owners.length && owners.every(m => agentPaused(m, pauses))) return owners[0];
  const old = LEGACY_STAGE[stage];
  return old && on(pauses, old) ? old : null;
}
// 一步里这位成员那一段要不要跳过（一步归两位的，比如 prepare-interviews：Owl 的面试资料、Lens 的公司调研）。
// only：这一轮只跑哪位（立即跑一轮，bin/cycle.mjs 经 RADAR_ONLY_MEMBER 传下来）。
// only 可以写几位，用逗号隔开（新装走完引导的「找第一批岗位」是 scout,lens）。
const onlyList = only => String(only || '').split(',').map(s => s.trim()).filter(Boolean);
export const partSkipped = (member, { pauses = agentPauses(), only = process.env.RADAR_ONLY_MEMBER || '' } = {}) => (onlyList(only).length > 0 && !onlyList(only).includes(member)) || agentPaused(member, pauses);
// 「立即跑一轮」：只留这几位成员的步骤，顺序照周期。
export const stagesOf = (member, stages) => { const ms = onlyList(member); return stages.filter(s => ms.some(m => stagesOfMember(m, [s]).length)); };
export const validOnly = only => onlyList(only).length > 0 && onlyList(only).every(isMember);
// 暂停记录里写的是谁：成员的名字，老编号写「原来的 Radar」。
export const pausedName = key => isMember(key) ? crewName(key) : key === EXECUTOR ? '本机 AI' : Object.hasOwn(LEGACY, key) ? `原来的 ${LEGACY[key].name}` : String(key);
