// 用户的任务安排独立于执行回执；后台不能用旧状态覆盖，标完成不伪造发送/提交证明。
export const TASK_CHOICES = [
  { action: 'done', label: '完成了' }, { action: 'cancelled', label: '不做了' },
  { action: 'later', label: '晚点再说' }, { action: 'self', label: '我自己来' },
  { action: 'todo', label: '放回待做' },
];
// 看板只把可安排的目的列映射为用户选择；进行中必须真的开工，等你/失败由执行结果产生。
export const BOARD_CONTROLS = { queued: 'todo', done: 'done', cancelled: 'cancelled' };
export const controlled = c => !!c?.owner_control && c.owner_control.action !== 'resume';
export function ownerState(c) {
  const o = c?.owner_control;
  if (!controlled(c)) return c;
  const status = { done: 'done', cancelled: 'cancelled', todo: 'queued', later: 'queued', self: 'needs_you' }[o.action];
  if (!status) return c;
  return { ...c, status, manual: true, auto: false, detail: o.note, result: status === 'done' ? o.note : c.result, done_at: status === 'done' ? o.at : null, updated_at: o.at };
}
export function taskChoices(c) { return [...TASK_CHOICES, ...(controlled(c) && ['todo','later','self'].includes(c.owner_control.action) ? [{action:'resume',label:'恢复原任务'}] : [])].map(x => ({ ...x, task_id: c.id })); }
export function heldAsk(c, now = Date.now()) {
  return controlled(c) && (c.owner_control.action !== 'later' || Date.parse(c.owner_control.until) > now);
}
