// Pure HTTP evidence helpers, shared by the App and the Worker. Never keep request headers/body.
import { redact } from './error-evidence.mjs';
export const RELAY_USER_AGENT = 'OfferCrew/0.1';
const header = (h, k) => String(h?.get ? h.get(k) || '' : h?.[k] || '');
export function relayDiagnostic(status, headers, text) {
  const ray = header(headers, 'cf-ray');
  const body = String(text || '');
  const code = /error\s*code\s*[:：]?\s*((?:10|11)\d{2})\b/i.exec(body)?.[1]
    || /<[^>]*class=["'][^"']*\bcf-error-code\b[^"']*["'][^>]*>\s*((?:10|11)\d{2})\s*</i.exec(body)?.[1];
  return { status, ...(code ? { cloudflare_code: code } : {}), ...(/^[a-f0-9]{8,32}(?:-[A-Z]{3})?$/i.test(ray) ? { cf_ray: ray } : {}), ...(header(headers, 'server').toLowerCase() === 'cloudflare' ? { server: 'cloudflare' } : {}) };
}
// Scrub exact sent values and common personal/credential fields BEFORE truncation; JSON shape and error wording remain.
export function scrubRelayBody(text, request = null, secrets = []) {
  let s = String(text || '');
  try {
    s = JSON.stringify(JSON.parse(s), (key, value) => /token|secret|password|passwd|api[_-]?key|cookie|authorization/i.test(key) ? '[redacted]' : /^(?:request|prompt|input|messages|content|body)$/i.test(key) ? '[request removed]' : value);
  } catch {} // 兜底：纯文本/HTML 错误继续用下方文本脱敏，保留可诊断的原文。

  const remove = v => {
    if (typeof v === 'string') {
      for (const part of [v, ...v.split(/\r?\n/)].filter(x => x.length >= 8)) {
        s = s.split(part).join('[request removed]').split(JSON.stringify(part).slice(1, -1)).join('[request removed]');
      }
    } else if (v && typeof v === 'object') Object.values(v).forEach(remove);
  };
  remove(request);
  for (const secret of secrets.filter(Boolean)) s = s.split(String(secret)).join('[redacted]');
  s = redact(s)
    .replace(/\b(?:oc|oca)_[a-z0-9]+\b/gi, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, '[phone]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[url]')
    .replace(/\/(?:Users|home)\/[^\s"<>]+/g, '[path]');
  return s.length > 4096 ? s.slice(0, 4096) + '…[truncated]' : s;
}
// Retry only an explicit failed HTTP response, before any answer was delivered. Never retry quota/login/config or a known firewall refusal.
export function temporaryRelayFailure(status, text) {
  let b = {}; try { b = JSON.parse(text) || {}; } catch {} // 兜底：非 JSON 的网关错误按状态码判断。
  if (/\b10(?:10|20)\b/.test(String(b?.diagnostic?.cloudflare_code || '')) || /error\s*code\s*:\s*10(?:10|20)/i.test(text)) return false;
  if (b.error && !['upstream_error', 'upstream_unreachable'].includes(b.error)) return false;
  if (/^(?:no_key|wire|http_40[01])$/.test(b.why || '') || b.upstream_status === 401 || b.upstream_status === 400) return false;
  return [408, 429, 500, 502, 503, 504, 522, 524].includes(status) && (status !== 429 || b.error === 'upstream_error');
}
