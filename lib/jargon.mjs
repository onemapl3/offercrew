// 页面上给人看的话里，内部的说法换成人话（原 lib/command-center.mjs，第 4 步 4b 挪出来；workflow、hq、team、crew-desk 都用）。
import { applyWord } from './apply-channel.mjs';

// 给人看的一句话：去掉内部字段名，长文放「展开」里。
export const JARGON = [[/queue[_-]auto[_-]apply|auto[_-]apply/gi, () => applyWord()], [/waiting_user/gi, '等你回复'], [/system_fix/gi, '系统修复'], [/host[_ -]?job|宿主任务/gi, '任务'], [/run-now|即时执行器|(?:Claude Code |Claude |Codex )?执行器/gi, '本机 AI'], [/本机 AI(?=[\u4e00-\u9fff])/g, '本机 AI '], [/ego lite|ego 浏览器|\bego\b/gi, '浏览器'], [/指纹/g, '版本'], [/awaiting_batch_review/gi, '等你重新确认'], [/needs_login/gi, '需要登录'], [/queue-apply/gi, '投递队列']];
export const plainText = t => JARGON.reduce((x, [re, to]) => x.replace(re, to), String(t || '')).replace(/\s+/g, ' ').trim();
