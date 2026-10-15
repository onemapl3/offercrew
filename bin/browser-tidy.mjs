#!/usr/bin/env node
// 收拾专用 Chrome（lib/browser-run.mjs runBrowserScript）：结束所有 Agent 自己开的任务空间（关掉它们的页面），
// 只保留预填好的申请页、旧版留下的给你开登录页的空间（state/ego-user-space.json）和你自己的页面。
// 执行器每轮新开空间又不收尾时，窗口会越积越多；这个脚本一键清掉。
import fs from 'node:fs';
import { file, read } from '../lib/store.mjs';
import { runBrowserScript } from '../lib/browser-run.mjs';
let keep = null; try { keep = JSON.parse(fs.readFileSync(file('state/ego-user-space.json'), 'utf8')).spaceId ?? null; } catch {} // 兜底：旧的保留记录不在就没有要留的
const applicationSpaces = Object.values(read('state/application-pages.json', {})).map(p => p.spaceId).filter(Number.isInteger);
const script = `const applicationSpaces = ${JSON.stringify(applicationSpaces)};
const keep = ${JSON.stringify(keep)};
const spaces = await listTaskSpaces();
const closed = [], kept = [], failed = [];
for (const s of spaces) {
  if (applicationSpaces.includes(s.id) || s.id === keep || s.createdBy !== "agent") { kept.push({ id: s.id, name: s.name, ownership: s.ownership }); continue; }
  try { let t = await taskSpace(s.id); if (t.ownership && t.ownership !== "agent") t = await takeOverTaskSpace(s.id); await t.finish({ keep: [] }); closed.push({ id: s.id, name: s.name }); }
  catch (e) { failed.push({ id: s.id, name: s.name, error: String(e.message || e).slice(0, 80) }); }
}
radarResult({ closed, kept, failed });`;
const r = await runBrowserScript(script, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
console.log(JSON.stringify({ status: r.closed.length ? 'changed' : 'no_change', closed: r.closed.length, kept: r.kept.length, failed: r.failed.length, detail: r }));
