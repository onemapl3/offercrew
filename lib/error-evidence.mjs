// Preserve the cause rather than the first 150 characters of a long command.
// 去掉钥匙、令牌、口令：Bearer 后面的、带名字的（api_key=、access_token:、"token":"…"、裸的 token=、cookie、session_id、password……），
// 还有不带名字的长串（32 位以上的十六进制，sk- 开头的钥匙）。宁可多去，证据里看得懂哪一步错了就够。
export const redact = value => String(value ?? '')
  .replace(/(Bearer\s+)[\w.\-~+/=]+/gi, '$1[redacted]')
  .replace(/((?:[a-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|_key)|key|cookie|authorization|session[_-]?id)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi, '$1[redacted]')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
  .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');
export function errorEvidence(error) {
  return { error: redact(error.message || error), code: error.code ?? error.status ?? null, signal: error.signal || null, stderr: redact(error.stderr), stdout: redact(error.stdout) };
}
