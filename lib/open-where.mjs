// 从 App 里点开的外部链接在哪个浏览器里开（第 4 轮开箱 F10，主会话 10-03 定）：招聘网站——看原帖、登录、预填——都在专用 Chrome
// 里开，求职用的登录状态留在一处，和你平时用的 Chrome 分开。你自己账号的登录（OpenAI / ChatGPT、Google、微软）、我们自己的网站、
// 下载页、飞书文档，照旧在你平时用的浏览器里开：那些是你的账号，不是求职网站，而且专用 Chrome 带着自动化标记，有的登录页会拦它。
// 不是 http(s) 的（mailto: 这类）也照旧交给系统。
const OWN = ['openai.com', 'chatgpt.com', 'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'onemaple.cc', 'lite.ego.app', 'feishu.cn', 'larksuite.com', 'github.com'];
const OWN_PATHS = [/^https?:\/\/(www\.)?google\.com\/chrome\b/i];
export function ownBrowser(url) {
  let u; try { u = new URL(String(url)); } catch { return true; } // 兜底：解析不了的地址交给你自己的浏览器，不在专用 Chrome 里开
  if (!/^https?:$/.test(u.protocol)) return true;
  const host = u.hostname.toLowerCase();
  // 飞书招聘的岗位、登录和申请页共用租户域；这些是招聘门户，不是飞书文档。
  if (host === 'jobs.feishu.cn' || host.endsWith('.jobs.feishu.cn')) return false;
  return OWN.some(d => host === d || host.endsWith(`.${d}`)) || OWN_PATHS.some(re => re.test(u.href));
}
