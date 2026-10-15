// 自动更新从哪里取（10-03 负责人：放在自己的域名上，不用 GitHub）。
// electron-updater 的 generic 方式：先读 <地址>latest-mac.yml，再按里面写的文件名取 zip（<地址><zip 名>）。
// 文件在 R2 存储桶里，由 relay/phone 的 Worker 只读地发（/updates/mac/*）；发版用 desktop/release.mjs 上传。
export const DEFAULT_UPDATE_URL = 'https://offercrew.onemaple.cc/updates/mac/';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// 打包时写进 App 的地址：默认上面那个，OFFERCREW_UPDATE_URL 可以换。只认 https（本机试验可以 http://127.0.0.1），末尾补上 /。
export function updateFeedUrl(v = process.env.OFFERCREW_UPDATE_URL) {
  const raw = String(v ?? '').trim() || DEFAULT_UPDATE_URL;
  let u;
  try { u = new URL(raw); } catch { throw Error(`更新地址不是网址：${raw}`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw Error(`更新地址要用 https（本机试验可以用 http://127.0.0.1）：${raw}`);
  if (u.search || u.hash || u.username || u.password) throw Error(`更新地址不能带参数或账号：${raw}`);
  return u.href.endsWith('/') ? u.href : `${u.href}/`;
}
// electron-builder 的 publish 配置：Worker 只发单段 Range，差量下载就一段一段地取（不发多段 Range）。
export const publishConfig = (url = updateFeedUrl()) => [{ provider: 'generic', url, useMultipleRangeRequest: false }];

// 运行时换地址（只给本机试验用）：OFFERCREW_UPDATE_URL 指向这台电脑（wrangler dev）时，App 改从那里查更新，沙盒里也查。
// 别的地址一律不认：装好的 App 不能被一个环境变量引到别处去取更新。
export function localFeedOverride(v = process.env.OFFERCREW_UPDATE_URL) {
  if (!v) return null;
  try { const url = updateFeedUrl(v); return LOOPBACK.has(new URL(url).hostname) ? url : null; } catch { return null; }
}
