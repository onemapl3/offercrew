// 内置邮箱现在怎样（GET /api/mail 回的就是它，lib/mail/api.mjs 转出去）：地址、哪种邮箱、连没连上，连不上时一句原因。从不回授权码。
// System 的健康账（lib/system/health.mjs）也读这一份，所以放在这里，不经 /api/mail 那一层。
import { currentMailbox } from '../facts.mjs';
import { normalizeAddress, providerFor, providerSummary, PROVIDERS } from './providers.mjs';
import { loadAccount } from './vault.mjs';

export function mailView() {
  const a = loadAccount();
  if (!a) {
    const address = normalizeAddress(currentMailbox());
    return { connected: false, address: address || null, ...(address ? providerSummary(providerFor(address)) : {}) };
  }
  const p = PROVIDERS[a.provider];
  return {
    connected: a.status === 'ok', address: a.address, provider: a.provider, label: p?.label || '测试邮箱',
    checked_at: a.checked_at || null,
    ...(a.status !== 'ok' ? { status: a.status, problem: a.problem || null } : {}),
    ...(a.status === 'ok' && a.send?.ok === false ? { receive_only: true, send_problem: a.send.reason || null } : {}),
    ...(a.login ? { login: a.login } : {}),
  };
}
