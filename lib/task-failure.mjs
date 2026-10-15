import { failingCard } from './task-chat.mjs';
import { plainWords } from './asks.mjs';

export function taskFailure(id, all = []) {
  const top = all.find(c => c.id === id);
  if (!top) throw Object.assign(Error('没有这张卡'), { status: 404 });
  const c = failingCard(top, all) || top;
  const raw = c.detail || c.reason || c.error || c.steps?.filter(s => /fail|error|stuck/.test(s.status || '')).at(-1)?.detail || '';
  const reason = c.failure?.reason ? plainWords(c.failure.reason) : raw ? plainWords(raw) : '这次没有留下失败原因。';
  const network = /network|fetch failed|连接|网络|超时|timeout/i.test(raw);
  const login = /login|登录|验证码|安全验证/i.test(raw);
  const model = c.wait === 'model' || /模型|model|quota|额度|密钥/i.test(raw);
  const remedy = c.failure?.remedy || (login ? '打开对应网站完成登录或验证，再试一次。' : model ? '在设置里检查可用模型与额度，再试一次。' : network ? '检查网络后再试一次。' : '可以再试一次；仍失败就联系支持，并附这件任务的运行记录。');
  const impact = ['send', 'apply'].includes(c.kind) ? '这一步没完成，后续停着。对外结果尚未核实，重试前先查回执，避免重复发出。' : '这一步没完成，后续步骤停着。';
  return { content: `原因：${reason}\n影响：${impact}\n办法：${remedy}`, why: { reason, impact, remedy, task: c.id, recorded: !!raw, ...(c.failure?.kind ? { kind: c.failure.kind } : {}) } };
}
