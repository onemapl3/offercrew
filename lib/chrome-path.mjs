// 这台电脑上的 Google Chrome 在哪（专用 Chrome 用的就是它，lib/browser-host.mjs）。能力表（lib/capabilities.mjs）问「装没装」也读这里，
// 不用把整个浏览器主机引进来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_DOWNLOAD = 'https://www.google.com/chrome/';
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } }; // 兜底：不在或读不到就当没有，换下一个路径

const CHROME_PATHS = {
  darwin: home => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
  linux: () => ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  win32: (home, env) => [
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Google/Chrome/Application/chrome.exe'),
  ],
};
// RADAR_CHROME_PATH 换一个可执行文件（测试用 Playwright 的无头 Chromium）；没装就是 null。
export function findChrome({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.RADAR_CHROME_PATH) return isFile(env.RADAR_CHROME_PATH) ? env.RADAR_CHROME_PATH : null;
  return (CHROME_PATHS[platform]?.(home, env) || []).find(isFile) || null;
}
