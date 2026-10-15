// 只把程序自己的错误归因给本机 AI；网页/工具返回的 403 不在这里当模型故障。
export const LOCAL_AI_NAMES = { claude: 'Claude Code', codex: 'Codex' };
export function codexErrors(text) {
  return String(text ?? '').split('\n').map(l => l.trim()).filter(l => /^(?:\[[^\]]*\]\s*)?(?:ERROR\b|stream (?:error|disconnected)\b)/.test(l));
}
export function claudeErrors(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim(); if (!s) continue;
    let e; try { e = JSON.parse(s); } catch { out.push(s); continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'system' && e.subtype === 'api_retry') out.push(`api_retry status=${e.error_status ?? ''} ${typeof e.error === 'string' ? e.error : JSON.stringify(e.error ?? '')}`);
    else if (e.type === 'result' && (e.is_error || e.subtype !== 'success')) out.push(`${e.subtype ?? 'result'} ${typeof e.result === 'string' ? e.result : ''}`);
  }
  return out;
}
// 输出固定文案，不把原始 stderr（可能夹凭据）放进页面或错误记录。裸 403 不能推断余额不足。
export function localAiFailure(kind, { code = 1, text = '', signal = null } = {}) {
  const name = LOCAL_AI_NAMES[kind] || '本机 AI', s = String(text), status = /\b(401|402|403|429|5\d\d)\b/.exec(s)?.[1], http = status ? `（${status}）` : '';
  const result = (layer, reason, remedy) => ({ layer, reason, remedy });
  if (code === 127 || code === 'ENOENT' || /command not found|spawn .*ENOENT/i.test(s)) return result('installation', `找不到本机 ${name} 的命令`, `安装 ${name}，或在设置中检查命令路径，然后重新检查。`);
  if (/insufficient (?:account )?balance|credit balance.*(?:low|insufficient)|余额不足/i.test(s)) return result('billing', `本机 ${name} 使用的 key 余额不足${http}`, `给该 key 所属账户充值，或在 ${name} 中换成可用凭据，再重新检查。CLI 的 key 可能优先于订阅登录；OfferCrew 文字模型的 API 设置不用改。`);
  if (/not logged in|please (?:run|use).*login|authentication required|invalid.*(?:api.?key|token)|unauthorized|\b401\b/i.test(s)) return result('authentication', `本机 ${name} 没登录或凭据无效${http}`, `在终端运行 ${kind === 'claude' ? 'claude auth login' : 'codex login'}，若使用 key，请检查该 CLI 的凭据，再重新检查。`);
  if (status === '403') return result('permission', `本机 ${name} 的服务拒绝访问（403）`, `检查该 CLI 的账户权限、key 和服务地址；这条错误没有说明余额不足。`);
  if (/usage limit|quota|rate.?limit|\b429\b/i.test(s)) return result('quota', `本机 ${name} 的服务额度或频率受限${http}`, '等限额恢复，或在该 CLI 中换成可用账户后重试。');
  if (code === 124 || code === 125 || code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(s)) return result('timeout', `本机 ${name} 等待超时`, '检查网络和该 CLI 的服务是否可用，然后重试。');
  if (/ECONN|ENOTFOUND|fetch failed|error sending request|stream disconnected|overloaded|\b5\d\d\b/i.test(s)) return result('connection', `本机 ${name} 没连通模型服务${http}`, '检查该 CLI 的网络、代理和服务地址，然后重试。');
  if (signal || code === 137 || code === 143) return result('process', `本机 ${name} 被中途停止`, '检查是否退出或手动停止过任务；需要时重新运行。');
  return result('execution', `本机 ${name} 启动或执行失败${Number.isInteger(code) ? `（退出码 ${code}）` : ''}`, '查看本机 AI 的运行日志，处理对应错误后重新检查。');
}
