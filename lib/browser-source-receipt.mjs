import { read } from './store.mjs';
import { browserSourceName, browserSourceWhy } from './human-browser.mjs';
import { browserErrorDetail } from './browser-run.mjs';
// 登录检查是一笔独立证据，不用一次扫描失败把它改写为「没登录」。
export function sourceFailureReceipt(source, raw) {
  const watched = read('state/login-watch.json', {})[source.name];
  const portal = read('config/portal-sessions.json', { domains: {} }).domains?.[source.domain];
  const login = watched?.logged_in != null ? { logged_in: watched.logged_in, checked_at: watched.checked_at || null } : portal?.logged_in != null ? { logged_in: portal.logged_in, checked_at: portal.verified_at || null } : null;
  return { ...(login ? { login_check: login } : {}), say: browserSourceWhy(source.name, raw, { login }) };
}

// 页面重读原始证据，让旧回执的笼统 say 也能显示实际原因；只认扫描自己写的 runs 路径。
export function browserReceiptWhy(row, name, login = null) {
  // 帖子详情中途停下仍保留已经读到的内容；旧 say 可能只写了「没扫成」。
  if (row.detail_errors?.length) {
    const progress = [row.posts != null ? `已看 ${row.posts} 条帖子` : '', row.rejections?.accepted != null ? `筛选接受 ${row.rejections.accepted} 条` : '', row.detail_opened != null ? `打开 ${row.detail_opened} 个详情，读通 ${row.detail_filled ?? 0} 个` : ''].filter(Boolean).join('，');
    const reason = row.detail_stop_reason === 'detail_consecutive_failures' && row.detail_errors.slice(-2).length === 2 && row.detail_errors.slice(-2).every(e => e.error === 'detail_body_missing')
      ? '连续两次没读到详情正文，后面的详情先停下'
      : row.detail_errors.map(e => browserSourceWhy(name, e.error, { login: row.login_check || login })).filter(Boolean).join('；');
    return `${browserSourceName(name)}：${progress}${progress ? '；' : ''}${reason}`;
  }
  let raw = row.reason || row.error || '';
  if (/^runs\/\d{8}\/human-discovery\/[a-z]+\/failure-\d+\.json$/.test(row.error_evidence || '')) {
    try {
      const e = read(row.error_evidence, null);
      if (e) raw = browserErrorDetail(e.stderr) || browserErrorDetail(e.stdout) || e.error || raw;
    } catch (e) { console.warn(`[browser receipt] 无法读取扫描证据 ${row.error_evidence}: ${e.message}`); } // 证据损坏时保留回执原因，不让整个成员页打不开
  }
  return browserSourceWhy(name, raw, { login: row.login_check || login }) || row.say || '浏览器没有记下原因';
}
