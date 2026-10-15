// 「检查更新」的结果怎么说（主会话 10-04：照实说，查不到就一句人话原因）。菜单栏的弹窗和「设置 → 关于」用的是同一句。
// check：{ state, version, percent, error, manual }。发现新版后等用户点下载；Squirrel 接收完成才算 ready。
export function checkText(check = {}, current = '') {
  const { state, version, error, manual } = check;
  if (state === 'checking') return '正在检查…';
  if (state === 'available') return `发现新版本 ${version}，可下载更新`;
  if (state === 'downloading') return `正在下载 ${version}${Number.isFinite(check.percent) ? ` · ${check.percent}%` : ''}`;
  if (state === 'preparing') return `正在准备 ${version}，完成后可重启`;
  if (state === 'ready') return `${version} 已下好`;
  if (state === 'latest') return manual ? `已是最新版本 ${current}` : '';
  if (state === 'error') return manual || version ? error || '更新没完成，点击重试' : '';
  if (state === 'off') return '这个版本不自动更新';
  return '';
}

// electron-updater 报的错 → 一句人话。原文照旧写进 App 日志。
const REASONS = [
  [/ENOSPC|no space left/i, '磁盘空间不够，下载不了新版'],
  [/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|net::ERR_|socket hang up|network/i, '连不上更新服务器，检查网络后再试'],
  [/signature|code ?sign|not signed|sha512 checksum mismatch/i, '下载的新版没通过校验，没有装'],
];
export function updateErrorText(e) {
  const m = String(e?.code || '') + ' ' + String(e?.message || e || '');
  const specific = REASONS.find(([re]) => re.test(m));
  if (specific) return specific[1];
  const status = Number(e?.statusCode || e?.status || /(?:HttpError\s*:\s*|HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?\s*[:=]?\s*)([45]\d\d)\b/i.exec(m)?.[1]);
  if ([401, 403].includes(status)) return `更新服务器拒绝访问（${status}），这次没取得新版信息`;
  if (status === 404) return '更新服务器上没找到新版的信息（404），这次没取得新版信息';
  if (status >= 500 && status <= 599) return `更新服务器返回了错误（${status}），这次没取得新版信息；过一会儿再试`;
  return '没查成，过一会儿再试';
}
