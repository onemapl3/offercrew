// 加了你自己的 Anthropic key 以后，成员默认用哪个 Claude（负责人 10-10）：
//   claude-haiku-5-5   Judge 匹配和评估、Watcher 读信分类、System 看原因、起标题
//   claude-sonnet-5-5  Writer（改简历、定制、求职信）、Reacher 起草和 AI 缩短、公司调研、怎么准备、对话
//   claude-opus-5-5    只在目录里当可选项，不默认给谁
// 写在哪：文字模型清单（config/model.json text.backends）第一个是 Haiku，对话默认（config/chat.json）是 Sonnet，
// 每位成员的文字模型（config/roles.json roles.<成员>.text），Judge 的调研、怎么准备和 System 的起标题另写在那位的 steps 里
// （lib/roles.mjs）。之后在团队页改哪位的模型就照你改的（steps 一起清掉）。原来能用的别的模型留在清单后面当后备。
// 什么时候写：这家 Anthropic 供应商刚接上、被选成文字模型的时候（lib/model-choice.mjs useTextModel、lib/onboarding.mjs useModel）。
import { event } from './events.mjs';
import { loadProviders, resolveBackend, textBackendUsable, dropUnpickedLocal } from './backends.mjs';
import { CLAUDE_MODELS } from './claude-api.mjs';
import { ROLES, setRoleSteps } from './roles.mjs';
import { textConf } from './text-conf.mjs';

export const MEMBER_TIER = { lens: 'light', scout: 'light', owl: 'light', patch: 'light', tailor: 'write', quill: 'write' };
// 同一位成员里换档的那几步：步骤名照 infer / complete 传的 step。
export const STEP_TIER = { lens: { 'company-brief': 'write', 'role-prep': 'write' }, patch: { title: 'light' } };

const officialHost = base => { try { return /(^|\.)anthropic\.com$/i.test(new URL(base).hostname); } catch { return false; } }; // 兜底：地址写得不对就当不是
// 这家供应商是不是你自己的 Anthropic key（Messages 接口、官方地址），并且目录里有 Haiku 5.5 和 Sonnet 5.5。
export function isClaudeKey(p, auth = null) {
  if (!p || p.kind !== 'anthropic_http' || !p.user) return false;
  const models = p.models || [];
  if (!models.includes(CLAUDE_MODELS.light) || !models.includes(CLAUDE_MODELS.write)) return false;
  return auth ? officialHost(auth.base_url) : true;
}
// 这家要写的默认值（不写文件）：{ text, chat, members: { 成员: [ref] }, steps: { 成员: { 步骤: [ref] } } }
export function claudeDefaults(key) {
  const ref = tier => ({ provider: key, model: CLAUDE_MODELS[tier] });
  return {
    text: ref('light'), chat: `${key}/${CLAUDE_MODELS.write}`,
    members: Object.fromEntries(ROLES.map(m => [m, [ref(MEMBER_TIER[m] || 'light')]])),
    steps: Object.fromEntries(Object.entries(STEP_TIER).map(([m, s]) => [m, Object.fromEntries(Object.entries(s).map(([st, t]) => [st, [ref(t)]]))])),
  };
}
// 写进去。走设置页同一个入口（校验、备份）。返回 { status: 'saved', key } 或 { status: 'skipped' }。
export async function applyClaudeDefaults(key, { providers = loadProviders() } = {}) {
  const p = providers[key];
  if (!isClaudeKey(p)) return { status: 'skipped' };
  const { updateSettings } = await import('./settings.mjs');
  const d = claudeDefaults(key), spec = x => ({ provider: x.provider, model: x.model, ...(x.effort ? { effort: x.effort } : {}) });
  // 文字模型清单：Haiku 在前；原来能用、又不是这一家的留作后备（最多 4 个）。
  let chain = [];
  try { chain = dropUnpickedLocal((textConf({ providers }).backends || []).map(r => { try { return resolveBackend(r, providers); } catch { return null; } }).filter(Boolean)); } catch {} // 兜底：读不出原来的清单就只写这一家
  const rest = chain.filter(b => b.provider !== key && textBackendUsable(b)).map(spec);
  updateSettings('model', { 'text.backends': [d.text, ...rest].slice(0, 4) });
  updateSettings('chat', { default: d.chat });
  updateSettings('roles', Object.fromEntries(Object.entries(d.members).map(([m, list]) => [`roles.${m}.text`, list])));
  for (const m of ROLES) setRoleSteps(m, d.steps[m] || null);
  event('user', 'settings', 'ok', '设置 → 模型：用你的 Anthropic key，判断、读信、看原因用 Haiku 5.5，写东西和对话用 Sonnet 5.5');
  return { status: 'saved', key };
}
