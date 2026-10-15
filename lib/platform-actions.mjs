// 扫描许可和对外动作许可各自保存。BOSS/脉脉只有明确打开动作开关才放行；扫描、登录不代替授权。
import { read } from './store.mjs';
import { familySession, hostOf } from './accounts.mjs';
export const PLATFORM_ACTIONS = { boss: { label: 'BOSS 直聘', domain: 'zhipin.com' }, maimai: { label: '脉脉', domain: 'maimai.cn' } };
export const PLATFORM_ACTIONS_GO = '#settings/prefs/channels';
export const MAIMAI_SYNC_UNAVAILABLE = '脉脉消息同步暂不可用';
// 好友申请有独立执行器；普通私信还没有可靠的收件人定位和回读，不能借用通用发送器。
export function platformMessageBlock(d = {}) {
  if (d?.channel !== 'platform_dm' || !/(^|\.)maimai\.cn$/i.test(hostOf(d.to) || '')) return null;
  return { gate: 'unsupported_channel', reason: '脉脉私信暂不支持自动发送与回读', fix: { label: '打开脉脉聊天', href: 'https://maimai.cn/chat' } };
}
export const platformActionsEnabled = (key, policy = read('config/human-source-policy.json', {})) => !PLATFORM_ACTIONS[key] || policy?.[key]?.actions_enabled === true;
export function platformActionReason(key, kind = 'send_dm') {
  const p = PLATFORM_ACTIONS[key];
  const session = familySession(p.domain, read('config/portal-sessions.json', {}));
  const login = session?.logged_in === true ? `${p.label}登录没问题。` : `${p.label}登录状态尚未确认。`;
  const action = key === 'maimai' && kind === 'send_dm' ? '发送好友申请' : kind === 'send_dm' ? '发私信' : kind === 'prefill' ? '预填申请' : '提交申请';
  return `${login}在${/^[A-Za-z]/.test(p.label) ? ' ' : ''}${p.label}上${action}的开关你还没打开。`;
}
