// trycua/cua（MIT）的可选接入（2026-09-28）：只做检测，不依赖、不自动安装。
//
// 2026-09-28 核实过的（本机装着 cua-driver 0.21.0，/Applications/CuaDriver.app，~/.local/bin/cua-driver 是软链）：
//   · cua-driver 是"驱动"，不是代理：它自己不带模型，给别的代理当手（MCP 或命令行）。
//   · 只读命令：manifest（JSON：binary_version、mcp_invocation、subcommands）、status（守护进程在不在）、
//     list-tools（每行「工具名: 说明」）、describe <tool>（输入 JSON schema）。
//   · 调工具：cua-driver call <tool> '<json>'，要先有 cua-driver serve 起着的守护进程；MCP 用 cua-driver mcp。
//   · 浏览器工具的输入格式核对过（describe）：browser_prepare（allow_launch + profile.mode=isolated_new/
//     isolated_named 起一个独立 Chromium，不碰你的配置文件）→ get_browser_state（pid + window_id 绑定，
//     再按 target_id + tab_id 取快照，元素引用形如 p<快照>:<序号>）→ browser_navigate / browser_click /
//     browser_type（replace=true 覆盖）/ browser_set_input_files / browser_pointer（scroll）/ browser_dialog。
// 没核实的：这些工具的返回格式（文档只给了字段名：prepared_pid、status、binding_quality、mutation_allowed、
// 每个引用的 actions），以及真正跑一遍——那会在你的电脑上开浏览器、动鼠标，测试里不能做。
// Python 的代理 SDK（PyPI cua-agent 0.8.4，自带多模型的 ComputerAgent）本机没装，文档站打不开，没核实。
// 所以这里：检测装没装、列出能力、提供 cua-driver call 的薄封装；浏览器后端和 runComputerUse 的 cua 驱动
// 明确报"未验证"，不假装能用。等返回格式核实了，照 browser.mjs 的 Page 接口补一个 CuaPage 即可。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from '../spawn.mjs';

export const CUA_INSTALL = {
  driver: '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"',
  permissions: 'cua-driver permissions grant（辅助功能 + 屏幕录制授权）',
  daemon: 'cua-driver serve',
  docs: 'https://github.com/trycua/cua/tree/main/libs/cua-driver',
  agent_sdk: 'pip install cua-agent（Python 代理 SDK，未核实）',
};
export const CUA_VERIFIED = {
  at: '2026-09-28', version: '0.21.0',
  commands: ['manifest', 'status', 'list-tools', 'describe <tool>', 'call <tool> <json>', 'mcp'],
  browser_tools: ['browser_prepare', 'get_browser_state', 'browser_navigate', 'browser_click', 'browser_type', 'browser_set_input_files', 'browser_pointer', 'browser_dialog'],
  not_verified: ['工具的返回格式', '真实浏览器上跑通一遍', 'Python 代理 SDK（cua-agent）'],
};
const run = (cmd, args, { timeout = 15000 } = {}) => new Promise(resolve => {
  const child = execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, code: error ? error.code ?? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!error?.killed }));
  child.stdin?.end();
});

// 找 cua-driver：配置里写的路径 → PATH → 安装脚本的默认位置。
export function findCuaDriver({ binary = 'cua-driver', env = process.env } = {}) {
  if (path.isAbsolute(binary)) return fs.existsSync(binary) ? binary : null;
  const dirs = [...String(env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local/bin'), '/Applications/CuaDriver.app/Contents/MacOS'];
  for (const d of dirs) { const p = d && path.join(d, binary); try { if (p && fs.statSync(p).isFile()) return p; } catch {} } // 兜底：这个目录里没有就看下一个
  return null;
}

export async function detectCua({ binary = 'cua-driver', exec = run, env = process.env } = {}) {
  const bin = findCuaDriver({ binary, env });
  if (!bin) return { installed: false, binary: null, adapter: 'none', message: `没装 cua-driver。要用的话：${CUA_INSTALL.driver}，再 ${CUA_INSTALL.permissions}`, install: CUA_INSTALL, verified: CUA_VERIFIED };
  const [manifest, status, tools] = await Promise.all([exec(bin, ['manifest']), exec(bin, ['status']), exec(bin, ['list-tools'])]);
  let m = null; try { m = JSON.parse(manifest.stdout); } catch {} // 兜底：输出不是 JSON 就是 null，下面照实说读不到清单
  const names = tools.stdout.split('\n').map(l => (l.match(/^([a-z][a-z0-9_]*)\s*:/) || [])[1]).filter(Boolean);
  const statusText = `${status.stdout}${status.stderr}`.trim();
  const daemon = /not running/i.test(statusText) ? 'not_running' : /running/i.test(statusText) ? 'running' : 'unknown';
  const browser = CUA_VERIFIED.browser_tools.every(t => names.includes(t));
  return {
    installed: true, binary: bin, version: m?.binary_version || null, schema_version: m?.schema_version || null,
    mcp: m?.mcp_invocation || { command: bin, args: ['mcp'] }, daemon, tools: names, browser_tools: browser,
    // 能力核实到命令行这一层；浏览器动作的返回格式没核实，所以不接成操作员后端。
    adapter: 'detect_only',
    message: `cua-driver ${m?.binary_version || '?'} 已安装（守护进程${daemon === 'running' ? '在运行' : daemon === 'not_running' ? '没起：cua-driver serve' : '状态未知'}${browser ? '，浏览器工具齐全' : '，缺浏览器工具'}）；浏览器动作的返回格式还没核实，内置操作员暂不经它操作`,
    install: CUA_INSTALL, verified: CUA_VERIFIED,
  };
}

// cua-driver call <tool> '<json>'：核实过的命令行形式。返回解析后的 JSON（不是 JSON 就给原文）。
// 这里只提供封装；本仓库没有任何地方拿它去动真实的浏览器或桌面。
export async function cuaCall(tool, args = {}, { binary = 'cua-driver', exec = run, timeout = 30000, socket = null } = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(tool))) throw Error('cua_bad_tool_name');
  const bin = findCuaDriver({ binary });
  if (!bin) throw Error('cua_not_installed');
  const r = await exec(bin, ['call', tool, JSON.stringify(args), ...(socket ? ['--socket', socket] : [])], { timeout });
  if (!r.ok) throw Object.assign(Error(`cua_call_failed:${tool}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`), { code: r.code });
  try { return JSON.parse(r.stdout); } catch { return { text: r.stdout.trim() }; }
}

export async function openCuaPage() {
  throw Object.assign(Error('cua_browser_not_verified：cua-driver 的浏览器工具返回格式还没核实，内置操作员暂不经它操作浏览器；先用 playwright 或 ego 后端（见 docs/operator.md）'), { code: 'cua_not_verified' });
}

// runComputerUse 的 cua 驱动：报告 unavailable 和原因（没装 / 未验证），驱动列表里有下一个就换下一个。
export async function runCuaComputerTask(task, { detect = detectCua } = {}) {
  const d = await detect().catch(e => ({ installed: false, message: String(e.message).slice(0, 160) }));
  return { reached: 'unavailable', final_url: task?.url || '', authenticated: false, application: false, submitted: false, tool_calls: 0, browser: 'cua', steps: [d.installed ? d.message : `Cua Driver 不可用：${d.message}`], cua: { installed: !!d.installed, version: d.version || null, daemon: d.daemon || null } };
}
