// 「在访达里显示简历」（要你本人提交的门户那封信，lib/asks.mjs submitAsk）：这条线索这次要传的那份简历，在访达里选中它，
// 回执写出完整路径（网页上传框里可以直接粘贴）。那一版还没导出 PDF 就先导（lib/resume-versions.mjs preparePick，和投递前同一步）。
import fs from 'node:fs';
import path from 'node:path';
import { lines, file } from './store.mjs';
import { execFile } from './spawn.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';
import { resumePick } from './application-form.mjs';

const reveal = abs => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin') return reject(Error('只有 Mac 上能在访达里显示'));
  const child = execFile('/usr/bin/open', ['-R', abs], { timeout: 10000 }, e => (e ? reject(e) : resolve()));
  child?.stdin?.end?.();
});

export async function revealResume(rid, { prepare = null, show = reveal } = {}) {
  const lead = lines('state/leads.ndjson').find(l => (l.record_id || l.id) === rid);
  if (!lead) throw Error('这条线索不在了');
  let pick = null, why = null;
  try {
    const { preparePick } = await import('./resume-versions.mjs');
    const r = await (prepare || preparePick)(lead);
    why = r?.reason || null;
  } catch (e) { why = String(e.message || e).slice(0, 120); }
  pick = resumePick(lead);
  if (!pick?.file) throw Error(`这份简历还没有能传的 PDF${why ? `（${why}）` : ''}，在「材料」里导出一份再试`);
  const abs = file(pick.file);
  if (!fs.existsSync(abs)) throw Error(`找不到简历文件 ${path.basename(abs)}，在「材料」里重新导出一份`);
  if (sandboxed()) { sandboxSkip(`在访达里显示 ${path.basename(abs)}`, { actor: 'user', lead_id: rid }); return `已在访达里选中「${path.basename(abs)}」：${abs}`; }
  await show(abs);
  return `已在访达里选中「${path.basename(abs)}」：${abs}`;
}
