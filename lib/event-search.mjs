// 日志搜索与分组：服务端完整历史和页面使用同一规则。
export const leadWords = l => l ? [`#${l.number ?? '—'}`, l.company, l.role].filter(Boolean).join(' ') : '';
export const eventMatches = (e, lead, query, actor = '') => {
  const q = String(query || '').trim().toLowerCase();
  if (/^#?\d+$/.test(q)) {
    const number = q.replace(/^#/, '');
    if (lead?.number != null && String(lead.number) === number) return true;
    // 岗位编号按完整词认；任务编号 3162430f、814316b5 不是 #316。
    return new RegExp(`(?<![\\w])#?${number}(?![\\w])`).test([e.text, e.msg].filter(Boolean).join(' '));
  }
  return [e.text || e.msg, leadWords(lead), actor].join(' ').toLowerCase().includes(q);
};
// 链接带来的任务/运行范围按关联字段精确筛，不混进正文搜索。
export const eventInScope = (e, scope = {}) => ['run', 'job', 'action', 'task'].every(k => !scope[k] || e[`${k}_id`] === scope[k]);
export function eventGroups(events) {
  const groups = new Map();
  for (const [i, e] of events.entries()) {
    // 老工作台的 run-* 是进程编号，不能把整天的设置修改和操作合成一轮。
    const id = e.job_id ? `job:${e.job_id}` : e.action_id ? `action:${e.action_id}` : /^run-/.test(e.run_id || '') || !e.run_id ? `event:${e.ts}:${i}` : e.run_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(e);
  }
  return [...groups];
}
