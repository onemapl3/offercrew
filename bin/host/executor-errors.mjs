// 执行器自己报的错（兜底清单 E02）：判断「是不是供应商故障、要不要换下一个」只看这些行，不扫整段日志尾巴。
// 日志里还有执行器跑的命令和抓的网页的输出：网站回了 403、页面里写着 quota……都不是供应商出了问题，不能因此换一个
// 执行器把整件事再做一遍。
//   codex   文本日志：只取 Codex 自己的报错行——行首（可带 [时间] 前缀）是大写的 ERROR，或者是 stream error / stream disconnected。
//   claude  stream-json 日志：只取不是 JSON 的行（Claude Code 自己写到输出里的报错）、api_retry 事件、出错的最终 result。
//           命令和网页的输出都在 JSON 事件里（tool_result），一律不看。
// 只用 node 自带的模块。读不了文件就什么都不输出：判断随之是「不是供应商故障」，不换（出错就停）。
// 用法：node bin/host/executor-errors.mjs <codex|claude> <日志文件|->  → 每行一条，最多最后 20 条（- 从标准输入读：只看这一步新写的那段）
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { codexErrors, claudeErrors } from '../../lib/local-ai-errors.mjs';
export { codexErrors, claudeErrors };

const main = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (main) {
  const [kind, file] = process.argv.slice(2);
  let text = '';
  try { text = fs.readFileSync(file === '-' ? 0 : file, 'utf8'); } catch {}
  const lines = kind === 'claude' ? claudeErrors(text) : kind === 'codex' ? codexErrors(text) : [];
  if (lines.length) console.log(lines.slice(-20).join('\n'));
}
