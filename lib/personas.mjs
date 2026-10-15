// The four roles of the command room (plans/20260915-command-room.md).
//
// One Feishu bot speaks as four named roles. A role is a fixed header (name and
// emoji), a fixed colour, a fixed target chat, and a signature on the first body
// line, so a card can be attributed at a glance without reading it. Radar, Watch
// and Reacher report into the command room; System reports into the log chat.
import { read } from './store.mjs';
import { localHour } from './tz.mjs';

export const PERSONAS = {
  radar: { key: 'radar', name: 'Radar', emoji: '🛰️', duty: '发现与匹配', template: 'blue', icon: 'search_outlined', tint: 'blue-50', chat: 'command_room_chat_id' },
  watch: { key: 'watch', name: 'Watch', emoji: '📮', duty: '收件箱与面试', template: 'red', icon: 'mail_outlined', tint: 'red-50', chat: 'command_room_chat_id' },
  reacher: { key: 'reacher', name: 'Reacher', emoji: '✉️', duty: '投递与联络', template: 'green', icon: 'share_outlined', tint: 'green-50', chat: 'command_room_chat_id' },
  system: { key: 'system', name: 'System', emoji: '⚙️', duty: '运行日志', template: 'grey', icon: 'setting_outlined', tint: 'grey-50', chat: 'system_log_chat_id' },
};
export const personaOf = key => PERSONAS[key] || PERSONAS.system;
// The signature the role writes on the first line of every card it sends.
export const signature = key => `${personaOf(key).emoji} **${personaOf(key).name}**（${personaOf(key).duty}）`;

// Which role owns which journey action. Discovery and triage are Radar's; the
// mailbox, replies and everything interview-shaped are Watch's; anything that
// leaves the house — a letter, a form, a follow-up — is Reacher's.
export const PERSONA_BY_KIND = {
  job_list: 'radar', human_leads: 'radar', screen: 'radar', decide: 'radar',
  reply: 'watch', schedule: 'watch', attend: 'watch', dossier: 'watch', review: 'watch', clarify: 'watch', mail: 'watch',
  send: 'reacher', submit: 'reacher', followup: 'reacher', auto_apply: 'reacher', status: 'reacher', apply_batch: 'reacher',
  daily_brief: 'radar', cycle: 'system',
};
export const personaForKind = kind => PERSONA_BY_KIND[kind] || 'system';

// Quiet hours (21:00–09:00) hold everything except Watch's interview and
// verification-code traffic: a code that arrives at midnight is useless at 09:00,
// and an interview time can move overnight. A scheduled interview's own reminder
// is handled by `notificationDue`'s urgency window rather than listed here, so a
// card about a meeting two days out still waits for 09:00.
export const QUIET_EXCEPTION_KINDS = new Set(['schedule']);
export const QUIET_EXCEPTION_CATEGORIES = new Set(['interview', 'code']);
export function quietException({ kind = null, category = null } = {}) {
  return QUIET_EXCEPTION_KINDS.has(kind) || QUIET_EXCEPTION_CATEGORIES.has(category);
}
// 名字沿用旧的：按的是 config/host.json 的时区（lib/tz.mjs，缺省 Asia/Shanghai）。
export const shanghaiHour = now => localHour(now);
export function inQuietHours(now, config = {}) {
  const hour = shanghaiHour(now);
  return hour < Number(config.quiet_end ?? 9) || hour >= Number(config.quiet_start ?? 21);
}


export const md = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);




