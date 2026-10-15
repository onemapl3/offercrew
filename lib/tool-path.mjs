// 外部命令（lark-cli、codex、claude、ego-browser）的查找路径。
//
// launchd 起的服务只带安装时的 PATH。换机器或重装之后，工作台的 PATH 里可能没有
// nvm 的 bin 目录，而 lark-cli 只装在那里：工作台里的飞书卡片同步、关卡片、回消息会全部
// `spawn lark-cli ENOENT`，而且不容易发现。入口脚本最先 import 本模块，把常见的工具目录
// 补到 PATH 末尾（已有的不重复，原有顺序不变）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function toolDirs(home = os.homedir()) {
  const nvm = path.join(home, '.nvm/versions/node');
  let versions = [];
  try { versions = fs.readdirSync(nvm).filter(v => /^v\d+/.test(v)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })); } catch {} // 兜底：没装 nvm 就没有这些版本
  return [path.join(home, '.local/bin'), ...versions.map(v => path.join(nvm, v, 'bin')), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}
export function withToolPath(current = process.env.PATH || '', dirs = toolDirs()) {
  const have = current.split(':').filter(Boolean);
  return [...have, ...dirs.filter(d => !have.includes(d) && fs.existsSync(d))].join(':');
}
process.env.PATH = withToolPath();
// 「用 ChatGPT 账号登录」装的那份官方 codex（lib/codex-app.mjs，在数据目录的 tools/bin 下）：有就优先用它。
// 用 RADAR_CODEX_BIN 指过去：引擎和宿主脚本（bin/host/*.sh）都认这个变量，脚本自己改 PATH 也不受影响。
{
  const appCodex = path.join(process.env.RADAR_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'tools/bin/codex');
  if (!process.env.RADAR_CODEX_BIN && fs.existsSync(appCodex)) process.env.RADAR_CODEX_BIN = appCodex;
}
