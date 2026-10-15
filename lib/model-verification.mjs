// 测试的是一份供应商凭据下的一个型号。目录有它不代表当前账号能调用它。
// 凭据/地址/CLI 登录目录变化后，旧的通过记录不再用于这份配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file, read, write, hash } from './store.mjs';
import { loadProviders, resolveBackend } from './backends.mjs';
import { redact } from './error-evidence.mjs';

const STATE = 'state/model-verifications.json';
const stamp = p => {
  try { const s = fs.statSync(p); return [s.mtimeMs, s.size]; }
  catch (e) {
    // 未登录的 CLI 可以还没有这些文件；权限、路径或磁盘错误不能沿用旧的验证状态。
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
const absolute = p => path.isAbsolute(p) ? p : file(p);
export function providerFingerprint(p) {
  if (!p) return null;
  const auth = p.auth_file ? read(p.auth_file, {}) : {};
  const home = p.codex_home ? absolute(p.codex_home) : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claude = p.config_dir ? absolute(p.config_dir) : path.join(os.homedir(), '.claude');
  return hash([p.kind, p.wire_api, p.model_wires, auth.base_url, auth.auth_token, auth.account_token, auth.api_key,
    p.kind === 'codex_exec' ? [home, stamp(path.join(home, 'auth.json')), stamp(path.join(home, 'config.toml'))] : null,
    p.kind === 'claude_code' ? [claude, stamp(path.join(claude, '.credentials.json')), stamp(path.join(claude, 'settings.json'))] : null]);
}
export function modelErrorFilter(p) {
  const tokens = () => { const a = p?.auth_file ? read(p.auth_file, {}) : {}; return [a.auth_token, a.account_token, a.api_key].filter(Boolean); };
  const startedWith = tokens();
  return error => {
    let msg = String(error?.message || error || '测试失败');
    // 请求没结束时用户可能已经换了 Key；旧钥匙也不能随上游报错回到页面。
    for (const token of [...startedWith, ...tokens()]) msg = msg.split(String(token)).join('[已隐藏]');
    return redact(msg).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 240);
  };
}
export const modelTestError = (error, p) => modelErrorFilter(p)(error);
export function recordModelVerification(ref, result, { providers = loadProviders(), fingerprint = null, now = Date.now() } = {}) {
  const b = resolveBackend(ref, providers), state = read(STATE, { models: {} }) || { models: {} };
  const row = { ok: result.ok === true, at: new Date(now).toISOString(), actual_model: result.actual_model || null,
    error: result.ok ? null : modelTestError(result.error, providers[b.provider]), ms: result.ms ?? null };
  write(STATE, { models: { ...(state.models || {}), [b.id]: { ...row, fingerprint: fingerprint || providerFingerprint(providers[b.provider]) } } });
  return row;
}
export function modelVerification(ref, { providers = loadProviders(), state = read(STATE, { models: {} }), fingerprint = null } = {}) {
  const b = resolveBackend(ref, providers);
  const row = state?.models?.[b.id];
  if (!row || row.fingerprint !== (fingerprint || providerFingerprint(providers[b.provider]))) return null;
  const { fingerprint: storedFingerprint, ...view } = row;
  return view;
}
