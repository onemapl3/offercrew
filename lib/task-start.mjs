// 什么时候算「开始干活」（design/desktop-app/方案-任务即对话.md 第三节，负责人 10-03 批）：全是规则，不调模型。
// 一句话分三类：
//   ask      只是问：只在对话里答，不开活（isQuestion、「现在怎么样」、别的闲聊）
//   instant  当场办完的指令：pass、归档、稍后再说、暂停 / 恢复成员……对话里一条回执，不进任务面板
//   work     会在后台留下一件要等的事：planTalk 认得的（投、联系、调研、怎么准备、收录、材料）、Writer 要动手的
//            （writerAsk / letterAsk，先问问题的也算）、排了宿主任务或即时执行的指令（投 N、Radar 跑一轮、发 N）
// 对话（lib/talk.mjs talkTurn）、手机（lib/phone/api.mjs 经 talkTurn）都走这里；飞书里的指令建成宿主任务，由任务板补卡时开对话
// （lib/tasks.mjs syncTasks → lib/task-chat.mjs）。
// 一句话里说了几件事（「，再」「然后」「另外」「还有」「；」、换行）：每一段都是 work 才拆开，各自一件活（splitWork）。
// 这句开不开活、拆不拆只在 lib/intent.mjs 认（4a）；这里转出去，老的调用方不用改。这一轮真开出来了什么（workOfResult）还在这里。
import { startsWork as startsWorkOf, splitParts, splitWork } from './intent.mjs';
export { splitParts, splitWork };
const verdict = (work, why) => ({ work, why });
// result：这一轮做完以后的结果（talkTurn 的返回）——给了就按真开出来的东西算，不再猜。
export const startsWork = (text, { classify = null, result = null } = {}) => result ? workOfResult(result) : startsWorkOf(text, { classify });
// 这一轮真开出来了什么：目标卡、单张卡、Writer 的活、指令排下的事。
export function workOfResult(r = {}) {
  if (r.needs_confirm) return verdict('ask', 'confirm');
  if (r.goal || r.card) return verdict('work', 'plan');
  if (r.reply?.kind === 'writer' && r.reply.writer) return verdict('work', 'writer');
  const cmd = r.receipt?.command;
  if (cmd) {
    if (cmd.card_id) return verdict('work', 'engine');
    const applied = cmd.kind === 'queue_apply' && r.receipt.ok !== false && (r.receipt.leads || []).some(x => x.to);
    return cmd.op?.id || cmd.run_now || applied ? verdict('work', cmd.op?.id ? 'op' : applied ? 'apply' : 'run_now') : verdict('instant', cmd.verb || 'command');
  }
  return verdict('ask', r.kind || 'chat');
}
