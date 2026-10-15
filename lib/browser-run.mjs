// 网页上的活只在专用 Chrome 里做（10-04：ego 浏览器那条路删掉，App 只留专用 Chrome；原 lib/ego-browser.mjs）。
//   runBrowserScript(script)：跑一段浏览器脚本（写法见 lib/browser-compat.mjs，taskSpace、page.goto / evaluate / click / fill……），
//     取回它用 radarResult 交出来的那一个结果；经 node bin/browser.mjs -e 在专用 Chrome 上跑。
//     出错报 ego_browser_failed:…（调用方按这个前缀认浏览器出错，旧数据里也是这个码；超时多一行 timeout），原因在后面。
//   openForUser(url)：要你登录 / 授权时，只打开那一个页面交给你（lib/browser-host.mjs openUserTab）。
import { execFile } from './spawn.mjs';
import { fileURLToPath } from 'node:url';
import { errorEvidence } from './error-evidence.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';
import { openUserTab } from './browser-host.mjs';
import { landingUrl } from './landing.mjs';

export const RESULT_PREFIX = 'RADAR_BROWSER_RESULT:';
// 现在只有一个：专用 Chrome。留着这几个名字，调用方和记录里的 browser 字段照旧。
export const browserEngine = () => 'chrome';
export const inLoginBrowser = () => '在专用 Chrome 里';
export const browserLabel = () => '专用 Chrome';

// 浏览器脚本先读标准输入再跑 -e：无人值守的子进程要给它 EOF，不然什么都不做，一直等到超时。
export function executeClosedInput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
    child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin?.end();
  });
}

// 输出里可能夹着别的诊断：只认带前缀的那一行，而且必须正好一行。
export function parseBrowserResult({ stdout = '', stderr = '' }) {
  const results = `${stdout}\n${stderr}`.split(/\r?\n/).filter(line => line.startsWith(RESULT_PREFIX));
  if (results.length !== 1) throw Error(`ego_browser_result_count:${results.length}`);
  try { return JSON.parse(results[0].slice(RESULT_PREFIX.length)); }
  catch { throw Error('ego_browser_result_invalid_json'); }
}

const BROWSER_CLI = fileURLToPath(new URL('../bin/browser.mjs', import.meta.url));
export async function runBrowserScript(script, options = {}) {
  const { engine: _engine, ...execOptions } = options;
  const source = `const radarResult = value => console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(value));\n${script}`;
  // 沙盒里连进程都不起。
  if (sandboxed()) throw Object.assign(Error(`ego_browser_failed:${sandboxSkip('在专用 Chrome 里跑浏览器脚本')}`), { code: 'sandbox' });
  let output;
  // RADAR_BROWSER_CLI 只给测试用：换成一个假的浏览器程序（照 `<程序> nodejs -e <脚本>` 调），不起真的 Chrome。
  const fake = (execOptions.env || process.env).RADAR_BROWSER_CLI;
  const [command, args] = fake ? [fake, ['nodejs', '-e', source]] : [process.execPath, [BROWSER_CLI, '-e', source]];
  try { output = await executeClosedInput(command, args, execOptions); }
  catch (error) { throw browserFailure(error); }
  return parseBrowserResult(output);
}

export function browserFailure(error) {
  const evidence = errorEvidence(error);
  // 有些桥接器把错误写在 stdout；退出码只是结果，不能盖掉真正的错误。
  const detail = evidence.stderr.trim() || browserErrorDetail(evidence.stdout) || String(evidence.code || evidence.error || 'unknown');
  const message = `ego_browser_failed:${error.killed ? 'timeout\n' : ''}${detail}`;
  return Object.assign(new Error(message, { cause: error }), evidence, { message });
}

export function browserErrorDetail(raw) {
  const rows = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (const row of rows) {
    try { const r = JSON.parse(row); if (r?.error) return typeof r.error === 'string' ? r.error : r.error.message || null; } catch { /* 兜底：诊断不一定是 JSON，下面继续按纯文字错误行提取原因 */ }
  }
  return rows.find(s => /^(?:\w*Error:|error:|page\.|browserType\.|locator\.|Protocol error|chrome_|cdp_)/i.test(s)) || null;
}

// 需要你登录 / 授权时：固定用一个给你看的标签页，拉到最前面。
// account：为哪个账号打开的登录页（收件箱的登录信带着）；登录检查据此知道你是不是还停在登录页上。
// 已知会落空的岗位链接先改成能打开的写法（lib/landing.mjs landingUrl，网易招聘要带 lang=zh）。
// inspect：开好以后读回落在哪（{ landed }），给「打开申请页」核对。
export async function openForUser(url, { activate = true, account = null, browse = false, inspect = false } = {}) {
  const u = landingUrl(String(url || '').trim());
  if (!/^https?:\/\//i.test(u)) throw Error('只能打开 http(s) 链接');
  // 演示 / 沙盒模式：不开浏览器，照常回"已打开"（lib/sandbox.mjs）。
  if (sandboxed()) { sandboxSkip(`在专用 Chrome 打开 ${u.slice(0, 160)}`, { actor: 'user' }); return { ok: true, sandbox: true, spaceId: null, url: u, navError: null }; }
  return openUserTab(u, { account, activate, browse, inspect });
}
