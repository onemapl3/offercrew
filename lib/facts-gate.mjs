// 资料文件读坏或缺了就停（2026-10-03，兜底清单 G02）：candidate/facts.yaml 解析失败，或者引导走完以后文件不见了，
// 判断、写信、填表、周期都不跑，指挥台顶上挂一条「挡路大事」（lib/blockers.mjs 的 facts）。
// 还在引导里（onboardingState().first_run）没有这个文件是正常的：新用户还没填。内容少（只填了几项）不算坏。
// 引导每一步都能跳过（跳过不写资料），所以走完引导也不一定有这个文件：缺文件那句只说「找不到你的资料」，不说「不见了」。
// 「看原因」由 System 讲怎么补（lib/system/explain.mjs factsRule：重新导入简历，或者在设置里填）。
// 61 处读资料的地方不一处处改：只挡「会拿资料去干活」的入口——
//   bin/cycle.mjs（整轮）、bin/judge-leads.mjs、bin/match.mjs、bin/evaluate.mjs（判断）、
//   bin/prepare-applications.mjs、bin/tailor-resumes.mjs、lib/resume-letters.mjs（写信、材料）、bin/auto-apply.mjs（填表、预填）、
//   lib/mail/draft.mjs（起草、改邮件）、lib/mail/interview.mjs（面试「确认并回复」）、
//   执行器（bin/host/radar-cycle.sh 看周期的退出码，bin/host/run-now.sh 和 lib/run-now.mjs 拉起之前问一次）。
// 设置页、引导这些「读资料给你改」的地方不挡：坏文件要能在那里看到原因、修好（lib/setup.mjs 的 BROKEN）。
import { factsHealth } from './facts.mjs';
import { onboardingState } from './onboarding-state.mjs';
import { log } from './store.mjs';
import { event } from './events.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STOPPED = '判断、写信、填表先停了';
// 资料挡住时整轮周期（bin/cycle.mjs）和宿主脚本的退出码：和出错就停的那几道闸（兜底清单 E05 执行器权限档、I05 run_host）同一个 78。
// 调用方认它（bin/host/radar-cycle.sh 不拉起执行器）；定时、补跑、操作台都不拿它重试（lib/cycle-catchup.mjs 先认领再跑）。
export const FACTS_EXIT = 78;

// 有问题给 { kind: 'facts', state: 'broken' | 'missing', text }，没问题给 null。输入都能传进来（测试、或者调用方已经算过）。
// 横条说出了什么事、怎么办、什么停了，不出现文件名和行号（主会话 10-03，和资料编辑器 lib/profile.mjs BROKEN_TEXT 一个口径）；
// 读不了的原因（health.reason，带文件名、行号）放在 detail 里，只进运行日志。
export function factsBlocker({ health = factsHealth(), onboarding = null } = {}) {
  if (health.state === 'broken') return { kind: 'facts', state: 'broken', text: `资料文件读不了：重新导入简历，或者到设置 → 资料重新填；${STOPPED}`, detail: health.reason || null };
  if (health.state === 'missing' && !(onboarding || onboardingState()).first_run) return { kind: 'facts', state: 'missing', text: `找不到你的资料：导入简历，或者到设置 → 资料填一下；${STOPPED}` };
  return null;
}

// 脚本入口用：资料有问题就写一行「没做，因为资料……」（和花费上限、判断不可用一样记 no_change），以 0 退出。
export function stopIfFactsBad(name, extra = {}) {
  const b = factsBlocker();
  if (!b) return;
  console.log(JSON.stringify(log(name, { status: 'no_change', reason: `facts_${b.state}`, detail: b.detail ? `${b.text}（${b.detail}）` : b.text, ...extra })));
  process.exit(0);
}

// 库函数入口用（写信这类由界面直接调的）：资料有问题就抛 409，原因就是横条那句话。
export function assertFactsUsable() {
  const b = factsBlocker();
  if (b) throw Object.assign(Error(b.text), { status: 409, code: `facts_${b.state}` });
}

// 宿主脚本拉起执行器之前问一次（bin/host/run-now.sh、radar-cycle.sh）：node lib/facts-gate.mjs <step>（数据目录和 lib/store.mjs 一样看 RADAR_ROOT）。
// 资料能用：以 0 退出。挡住了：横条那句话打到 stdout，记一条 skip 事件，以 78 退出。记 skip 不记 fail：横条已经在说这件事，
// fail 会进告警（每一档周期、每一次即时执行器各一条）、还会被自动修复排成任务。
// 按真实路径比：数据目录里的 lib 是链接，/tmp 是 /private/tmp。
const realArg = () => { try { return fs.realpathSync(path.resolve(process.argv[1])); } catch { return null; } }; // 兜底：路径解析不了就是 null
if (process.argv[1] && realArg() === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const b = factsBlocker();
  if (b) {
    console.log(b.text);
    event('system', process.argv[2] || 'facts', 'skip', `${b.text}，这一次没有拉起执行器`, { reason: `facts_${b.state}` });
    process.exit(FACTS_EXIT);
  }
}
