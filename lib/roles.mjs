// 每位成员用什么底座（config/roles.json）。
//
// 成员 = 团队名册的 6 位（lib/crew.mjs）：Scout、Lens、Tailor、Quill、Owl、Patch。每位可以单独指定两样：对话时默认用哪个
// 底座（chat，一个）、这位的文字生成按什么顺序试（text，清单）。没设的先沿用它接手的那个老角色——config/roles.json 里
// 2026-09-29 之前按 radar / watch / reacher / system 写的设置照样生效（scout、lens ← radar；tailor、quill ← reacher；
// owl ← watch；patch ← system）——再跟随全局：对话跟 config/chat.json 的 default，文字跟 config/model.json 的 text.backends。
// 这位自己写了哪一样就只用它自己的（写成空 = 明确跟随全局，不再沿用老设置）。
// 落地点：对话页按角色取默认；匹配（Lens）、来信摘要（Owl）、草稿改写（Quill）调 infer 时带 role，lib/model.mjs 按它选清单。
// 周期 / 巡检 / 即时执行器是一整个进程，不按成员拆，仍走 config/host.json。
import { read, write } from './store.mjs';
import { loadProviders, resolveBackend, backendLabel } from './backends.mjs';
import { CREW_IDS, MEMBERS, LEGACY, isMember, crewOf, crewMember } from './crew.mjs';

export const ROLES_PATH = 'config/roles.json';
export const ROLES = CREW_IDS;
export const ROLE_LABEL = Object.fromEntries(CREW_IDS.map(id => [id, crewMember(id).label]));
export const ROLE_USES = Object.fromEntries(CREW_IDS.map(id => [id, MEMBERS[id].models_for]));
const str = v => typeof v === 'string' && v.trim() ? v.trim() : null;
const arr = v => Array.isArray(v) && v.length ? v : null;

// { 成员: { chat, text, from: { chat, text } } }：from 写这一样是从哪个老角色沿用来的（没沿用就不写）。
export function loadRoles(raw = read(ROLES_PATH, { roles: {} })) {
  const R = raw?.roles || {}, out = {};
  for (const id of CREW_IDS) {
    const own = R[id] && typeof R[id] === 'object' ? R[id] : null, oldKey = MEMBERS[id].legacy, old = R[oldKey] || {};
    const pick = f => own && f in own ? [f === 'chat' ? str(own.chat) : arr(own.text), null] : [f === 'chat' ? str(old.chat) : arr(old.text), (f === 'chat' ? str(old.chat) : arr(old.text)) ? oldKey : null];
    const [chat, cf] = pick('chat'), [text, tf] = pick('text');
    // steps：这位成员某几件事单独用的清单（{ 步骤: [底座…] }）。目前只有加 Anthropic key 时自动写（lib/claude-defaults.mjs）：
    // 例如 Judge 判断用 Haiku，同是 Judge 做的公司调研、怎么准备用 Sonnet。你在团队页改这位的文字模型时一起清掉（lib/settings.mjs setAgentBackend）。
    const steps = own?.steps && typeof own.steps === 'object' && !Array.isArray(own.steps) ? Object.fromEntries(Object.entries(own.steps).filter(([k, v]) => /^[a-z][a-z0-9-]{0,40}$/.test(k) && arr(v))) : null;
    out[id] = { chat, text, ...(steps && Object.keys(steps).length ? { steps } : {}), ...(cf || tf ? { from: { ...(cf ? { chat: LEGACY[cf].name } : {}), ...(tf ? { text: LEGACY[tf].name } : {}) } } : {}) };
  }
  return out;
}
export function saveRoles(roles) { write(ROLES_PATH, { ...read(ROLES_PATH, {}), roles, updated_at: new Date().toISOString() }); }
// 调用方给的角色（成员编号，或者老编号：radar → Scout 那一份，照沿用规则也就是原来 radar 的设置）→ 成员。
const memberOf = role => isMember(role) ? role : crewOf(role);
// 对话默认底座 id，或 null（跟随全局）。解析不了的当没设，避免一个坏配置把对话卡死。
export function roleChatBackend(role, providers = loadProviders()) {
  const v = loadRoles()[memberOf(role)]?.chat;
  if (!v) return null;
  try { return resolveBackend(v, providers).id; } catch { return null; } // 兜底：解析不了的那一项就是 null
}
// 这位成员文字生成的清单（已解析），或 null（跟随全局）。
export function roleTextBackends(role, providers = loadProviders()) {
  const list = loadRoles()[memberOf(role)]?.text;
  if (!list) return null;
  const out = [];
  for (const b of list) { try { out.push(resolveBackend(b, providers)); } catch {} } // 兜底：解析不了的那一项跳过（和对话的清单同一条规矩）
  return out.length ? out : null;
}
// 这位成员做这一步单独用的清单（已解析），或 null（照这位的文字清单）。
export function roleStepBackends(role, step, providers = loadProviders()) {
  if (!step) return null;
  const list = loadRoles()[memberOf(role)]?.steps?.[step];
  if (!list) return null;
  const out = [];
  for (const b of list) { try { out.push(resolveBackend(b, providers)); } catch {} } // 兜底：解析不了的那一项跳过
  return out.length ? out : null;
}
// 写 / 清掉某位成员的 steps（null 清掉）。只动这一位的 steps，别的原样留着。
export function setRoleSteps(member, steps) {
  const raw = read(ROLES_PATH, { roles: {} }) || { roles: {} }, roles = { ...(raw.roles || {}) };
  const own = { ...(roles[member] || {}) };
  if (steps && Object.keys(steps).length) own.steps = steps; else delete own.steps;
  roles[member] = own;
  write(ROLES_PATH, { ...raw, roles, updated_at: new Date().toISOString() });
}
export function roleSummary(providers = loadProviders()) {
  const roles = loadRoles();
  // 解析不了的（供应商不在目录里、写法不对）标 ✗：设置页和指挥台据此告警（lib/settings.mjs stackSummary）。
  const label = ref => { try { resolveBackend(ref, providers); return backendLabel(ref, providers); } catch { return `${typeof ref === 'string' ? ref : `${ref?.provider}/${ref?.model}`} ✗`; } };
  return Object.fromEntries(CREW_IDS.map(r => [r, { label: ROLE_LABEL[r], uses: ROLE_USES[r], chat: roles[r].chat, chat_label: roles[r].chat ? label(roles[r].chat) : null, text: roles[r].text, text_labels: (roles[r].text || []).map(label), ...(roles[r].from ? { from: roles[r].from } : {}) }]));
}
