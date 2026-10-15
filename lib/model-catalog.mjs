// 设置页的可搜索型号目录与生效配置。只读本机；拉列表和真实测试均由用户动作触发。
import { read, write } from './store.mjs';
import { loadProviders, resolveBackend, discoverModels, saveProviders, textBackendUsable, catalog } from './backends.mjs';
import { modelVerification, providerFingerprint, modelErrorFilter } from './model-verification.mjs';
import { modelConf } from './text-conf.mjs';
import { backendsFor } from './model.mjs';
import { chatConfig } from './chat.mjs';
import { loadRoles, roleChatBackend, ROLES, ROLE_LABEL, ROLE_USES } from './roles.mjs';
import { ledgerSince } from './usage.mjs';
import { freeBlocked, FREE_PROVIDER } from './free-model.mjs';
import { sandboxNote } from './model-truth.mjs';

const DISCOVERY = 'state/model-discovery.json';
const modelName = value => { const s = String(value || '').trim(); if (!s || s.length > 200 || /[\s\u0000-\u001f]/.test(s)) throw Error('模型名须为 1–200 个字符，不能含空格或换行'); return s; };
const ready = b => !sandboxNote() && textBackendUsable(b) && !(b.provider === FREE_PROVIDER && freeBlocked());

export function modelCatalogView({ now = Date.now() } = {}) {
  const providers = loadProviders(), verification = read('state/model-verifications.json', {}), discovery = read(DISCOVERY, {});
  const conf = modelConf('text', { providers }), chat = chatConfig(), roles = loadRoles();
  const fingerprints = Object.fromEntries(Object.entries(providers).map(([key, p]) => [key, providerFingerprint(p)]));
  const readiness = Object.fromEntries(Object.entries(providers).map(([key, p]) => [key, ready({ ...p, provider: key })]));
  const seen = new Map(Object.keys(providers).map(key => [key, new Map()]));
  const view = ref => {
    let b; try { b = resolveBackend(ref, providers); } catch (e) {
      if (!e.unknown_provider) throw e;
      // 角色或对话仍可能引用已删除的供应商：保留原选择并明确标记缺失，不当成继承默认。
      const s = typeof ref === 'string' ? ref : `${ref?.provider}/${ref?.model}`;
      return { ref: s, provider: s.split('/')[0], provider_label: s.split('/')[0], model: s.slice(s.indexOf('/') + 1), ready: false, listed: false, source: 'configured', verification: null, missing: true };
    }
    const p = providers[b.provider], listed = (p.discovered || []).includes(b.model);
    const row = { ref: b.id, provider: b.provider, provider_label: p.label, model: b.model, ready: readiness[b.provider], listed, provider_ready: p.model_readiness?.[b.model] ?? null,
      source: listed ? 'discovered' : (p.manual_models || []).includes(b.model) ? 'manual' : 'configured', verification: modelVerification(b.id, { providers, state: verification, fingerprint: fingerprints[b.provider] }) };
    seen.get(b.provider).set(b.id, row); return row;
  };
  for (const p of Object.values(providers)) for (const model of p.models || []) view({ provider: p.key, model });
  // 解析失败交给 API / 页面显示；不能把已配置但损坏的链显示成「还没有默认模型」。
  const effective = (role = null, step = null) => backendsFor(conf, providers, { role, step }).map(view);
  const text = effective(), def = chat.default ? view(chat.default) : null;
  const roleRows = ROLES.map(key => {
    const r = roles[key], ownChat = roleChatBackend(key, providers), ownText = r.text || [];
    return { key, label: ROLE_LABEL[key], uses: ROLE_USES[key], chat: r.chat ? view(r.chat) : null, text: ownText.map(view),
      effective_chat: ownChat ? view(ownChat) : def, effective_text: effective(key), inherits_chat: !ownChat, inherits_text: !ownText.length,
      steps: Object.entries(r.steps || {}).map(([step, models]) => ({ step, models: models.map(view), effective: effective(key, step) })), ...(r.from ? { from: r.from } : {}) };
  });
  // 不把一次连通性测试冒充业务正在使用，也不把 CLI 外部会话计为本应用回答。
  const recent = ledgerSince(now - 7 * 86400000).filter(r => r.status === 'ok' && r.step !== 'test' && !['executor', 'codex-session'].includes(r.launcher) && ['openai_http', 'anthropic_http', 'codex_exec', 'claude_code'].includes(r.backend) && r.provider && r.model).at(-1);
  const lastResponse = recent ? { at: recent.at, provider: recent.provider, model: recent.reported_model || recent.model, model_reported: !!recent.reported_model,
    requested_model: recent.requested_model || null, member: recent.member, step: recent.step, fallback_from: recent.fallback_from || null } : null;
  return { default: { chat: chat.default ? def : null, text, effective_text: text.find(m => m.ready) || null }, roles: roleRows, last_response: lastResponse,
    providers: catalog(providers).map(p => ({ ...p, ready: readiness[p.key],
      discovery_error: discovery[p.key]?.fingerprint === fingerprints[p.key] ? discovery[p.key]?.error || null : null,
      models: [...seen.get(p.key).values()] })) };
}

export async function refreshModelCatalog(key) {
  const providers = loadProviders(), p = providers[key];
  if (!p) throw Error('不在目录里');
  const fingerprint = providerFingerprint(p), safeError = modelErrorFilter(p), at = new Date().toISOString();
  let result;
  try { result = { ok: true, ...(await discoverModels(key, providers)) }; }
  catch (e) { result = { ok: false, key, error: safeError(e), models: p.models || [] }; }
  write(DISCOVERY, { ...read(DISCOVERY, {}), [key]: { at, fingerprint, error: result.ok ? null : result.error } });
  return result;
}

export function addModelToCatalog(key, value) {
  const providers = loadProviders(), p = providers[key];
  if (!p) throw Error('不在目录里');
  const model = modelName(value);
  p.models = [...new Set([...(p.models || []), model])];
  p.manual_models = [...new Set([...(p.manual_models || []), model])];
  saveProviders(providers);
  return { ok: true, ref: `${key}/${model}` };
}
