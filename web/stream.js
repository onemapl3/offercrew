// 日志只展示事实，搜索的范围和屏幕上看得到的内容一致。
import { runLabel } from './labels.js';
import { leadWords } from '../lib/event-search.mjs';
export { leadWords, eventMatches, eventInScope, eventGroups } from '../lib/event-search.mjs';
export function eventTitle(id, rows, crew, leads = new Map()) {
  if (/^(?:ops-)?round-|^cycle|^judge/.test(id)) return runLabel(id, crew);
  const material = rows.find(e => ['cover_letter', 'self_intro'].includes(e.step) && e.status !== 'start');
  if (material) return material.text || material.msg;
  const applying = rows.find(e => e.step === 'auto-apply' && e.lead_id);
  if (applying) { const lead = leads.get(applying.lead_id); return `投递${lead ? ` ${leadWords(lead)}` : ''}`; }
  const first = [...rows].reverse().find(e => e.actor === 'user' && e.step !== 'web') || rows.at(-1);
  return first?.text || first?.msg || '一次操作';
}
export function recovery(rows) {
  const failed = rows.filter(e => e.status === 'fail');
  const cause = failed.map(e => e.text || e.msg || '').join(' ');
  if (!cause) return null;
  if (/额度|quota|补给|余额/.test(cause)) return { label: '查看模型与补给', href: '#settings/model' };
  if (/SMTP|IMAP|邮箱授权|mail.*auth/i.test(cause)) return { label: '检查邮箱连接', href: '#settings/accounts/mail' };
  if (/未登录|没登录|掉线|登录过期|login_required|验证码/.test(cause)) return { label: '检查网站账号', href: '#settings/accounts' };
  if (/代理|网络|ECONN|超时/.test(cause)) return { label: '检查连接设置', href: '#settings/advanced' };
  if (/本机 AI.*(?:关|授权)|执行器.*(?:关|不可用)/.test(cause)) return { label: '检查本机 AI', href: '#settings/advanced?hl=hands' };
  return null;
}
