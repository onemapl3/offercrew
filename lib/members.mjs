// 对话面板用的成员表：团队名册（lib/crew.mjs）上的一层薄皮，自己不存任何名字、脸、职责。
// 名字（NAMES）、脸（FACES：{ icon, fill, ink }，web/crew-faces.js 画）、小组、职责都从名册来；改名、换脸只改 lib/crew.mjs。
// 这里只多三样：你（you）和团队（team）也在表里；老编号（radar / reacher / watch / system / executor）指向同一位；
// 每位带 aliases（显示名、id、09-29 那一版的名字 Scout / Lens / Tailor / Quill / Owl / Patch），@ 选人和命令按它认。
// 执行器不是成员：它是大家共用的手，谁请它做的事就记在谁名下（任务卡上「Reacher · 用浏览器：…」）。
import { CREW_IDS, FORMER_NAMES, LEGACY, OWNER, TEAM, crewMember, crewOf, faceOf } from './crew.mjs';

export const MEMBER_IDS = CREW_IDS;
// 老编号 → 成员（会话、回执、飞书卡片、操作台脚本表里存的都是老的）。radar 拆成了 scout 和 lens，旧记录都算 scout。
export const ALIAS = Object.fromEntries(Object.entries(LEGACY).filter(([, L]) => L.member).map(([old, L]) => [old, L.member]).concat([['executor', 'patch']]));
export const memberId = id => (typeof id === 'string' && id ? crewOf(id) : null) || null;
// 对话的口吻：lib/chat.mjs 的系统提示词和按角色裁剪的状态还按旧的四个角色写（名册的 legacy）。
export const voiceOf = id => ({ scout: 'radar', lens: 'radar', tailor: 'reacher', quill: 'reacher', owl: 'watch', patch: 'system' })[memberId(id)] || 'system';
const FORMER = Object.fromEntries(Object.entries(FORMER_NAMES).map(([n, id]) => [id, n]));

// 一位：{ key, name, title, duty, group, group_label, face, aliases }。
function row(id) {
  const m = crewMember(id);
  return { key: id, name: m.name, title: m.title, duty: m.duty, group: m.group, group_label: m.group_label, face: m.face, aliases: [...new Set([m.name, id, FORMER[id]].filter(Boolean))] };
}
// { id: row }：六位、你、团队；老编号也在里面（指向同一位，key 是新 id），页面直接按消息里存的 id 查。
export function members() {
  const out = {};
  for (const id of MEMBER_IDS) out[id] = row(id);
  out.you = { key: 'you', name: OWNER.name, title: '', duty: '', group: '', group_label: '', face: faceOf('you'), aliases: ['你'] };
  out.team = { key: 'team', name: TEAM.name, title: '', duty: '整个团队', group: '', group_label: '', face: faceOf('team'), aliases: ['团队'] };
  for (const [old, id] of Object.entries(ALIAS)) out[old] = out[id];
  return out;
}
export const memberName = id => { if (id === 'team') return TEAM.name; const k = memberId(id); return k ? crewMember(k).name : String(id || ''); };
export const memberDuty = id => { const k = memberId(id); return k ? crewMember(k).duty : ''; };
// 文字里提到的成员（显示名、id、老名字，大小写都认）→ id；认不出是 null。命令「暂停 Radar」「Judge 跑一轮」按它认。
export function memberByWord(word) {
  const w = String(word || '').trim().replace(/^@/, '').toLowerCase();
  if (!w) return null;
  for (const id of MEMBER_IDS) if (row(id).aliases.some(a => a.toLowerCase() === w)) return id;
  return null;
}
// 能单独说话的成员：面板上「和谁说」的那一排，就是这六位。
export const TALKABLE = MEMBER_IDS;
