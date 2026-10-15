// 自由交办使用引擎已有的浏览器，和文字模型的协议、CLI 开关无关。
// 这里只打开/读取/截图；填写、发送、提交仍走业务动作的批准流程。
import { runBrowserScript, openForUser } from './browser-run.mjs';
import { loadAccounts } from './accounts.mjs';
import { file } from './store.mjs';
import { doablePart } from './intent.mjs';

export const taskText = c => [c.title, c.requirement, ...(c.says || []).map(x => x.text)].filter(Boolean).join('；');
// 只有用户明确交代的本机文件/命令才选可选工具。模型一句 needs_computer 不能替用户打开它。
export function localToolNeed(text) {
  const t = doablePart(text).replace(/(?:不要|不必|不用|无需|别|不许|禁止|不是要)[^，,。；;\n]*/g, ' ');
  const file = /(?:检查|读取|查看|查找|列出|修改|编辑|写入|创建|删除|移动|重命名|整理|打开|修复).{0,20}(?:本机|本地|电脑上).{0,12}(?:文件|目录|脚本)/;
  const command = /(?:终端|命令行).{0,20}(?:运行|执行|命令|脚本)|(?:运行|执行).{0,12}(?:本机|本地).{0,12}(?:命令|脚本)|(?:Claude Code|Codex).{0,12}(?:运行|执行|修改)/i;
  // “上传本地简历文件”属于已批准材料的浏览器流程，不能只因“本地文件”几个字要求 CLI。
  return t.split(/[；;。\n]/).some(s => file.test(s) || command.test(s)) ? '操作本机文件或命令' : null;
}
export function taskUrl(card, lead = null) {
  const text = taskText(card), explicit = text.match(/https?:\/\/[^\s<>"“”]+/i)?.[0]?.replace(/[）)、，；。！？,.!?;]+$/, '');
  const account = Object.entries(loadAccounts().families || {}).find(([key, a]) => text.toLowerCase().includes(key.toLowerCase()) || (a.label && text.includes(a.label)));
  const raw = explicit || card.url || lead?.url || account?.[1]?.login_url;
  try { const u = new URL(raw); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } // 兜底：没有明确网址时请用户补链接，不猜地址。
}
export async function browserTask(card, { lead = null, need, run = runBrowserScript, open = openForUser } = {}) {
  const url = taskUrl(card, lead), text = taskText(card);
  if (!url) return { wait: 'input', text: '还缺要打开的网页链接，补上后接着做。' };
  if (need === '登录网站') {
    await open(url, { activate: true });
    return { wait: 'browser', url, text: '已在专用 Chrome 打开网页，等你完成登录或验证。' };
  }
  if (/上传|下载/.test(doablePart(text))) return { wait: 'input', url, text: '还需要明确要上传或下载的文件及页面位置；岗位材料与预填可在对应岗位继续。' };
  const screenshot = /截(?:个)?图/.test(text) ? `runs/task-browser/${String(card.id).replace(/[^\w-]/g, '_')}.png` : null;
  const result = await run(`
const task = await taskSpace(${JSON.stringify(`OfferCrew task ${card.id}`)});
const page = await task.newPage();
await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' });
const result = await page.evaluate(() => ({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 12000) }));
${screenshot ? `await page.screenshot({ path: ${JSON.stringify(file(screenshot))}, fullPage: true });` : ''}
radarResult(result);`, { timeout: 60000, maxBuffer: 1024 * 1024 });
  return { ...result, ...(screenshot ? { screenshot } : {}), used: '引擎浏览器' };
}
