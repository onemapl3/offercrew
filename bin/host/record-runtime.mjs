// 每次真正运行 CLI 后留下可读结果；不保存原始错误输出，不拿工具/网页错误冒充模型故障。
import fs from 'node:fs';
import { read, write } from '../../lib/store.mjs';
import { claudeErrors, codexErrors, localAiFailure } from '../../lib/local-ai-errors.mjs';
const [kind, exit, log, pid] = process.argv.slice(2), code = Number(exit);
if (!['claude', 'codex'].includes(kind)) throw Error('unknown runtime');
let text = '';
try { text = fs.readFileSync(log, 'utf8'); } catch (e) { console.error(`本机 AI 结果日志读不了：${e.code || 'read_error'}`); }
const own = (kind === 'claude' ? claudeErrors : codexErrors)(text).join('\n');
const result = { kind, pid: Number(pid), code, ok: code === 0, at: new Date().toISOString(), source: 'task', ...(code !== 0 ? localAiFailure(kind, { code, text: own }) : {}) };
const before = read('state/local-ai-attempts.json', {});
write('state/local-ai-attempts.json', { ...before, [kind]: result, last: result });
