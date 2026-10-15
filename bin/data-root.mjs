#!/usr/bin/env node
// 把引擎挂进一个独立的数据目录（lib/data-root.mjs）：node bin/data-root.mjs <数据目录>
// 桌面版每次启动都调一次；开发时也可以用它给演示数据准备一个目录。只在本机建链接、写 Mac 版的默认模型表，不联网、不调模型。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkEngine, seedDesktopDefaults, dataVersionCheck, recordDataVersion } from '../lib/data-root.mjs';

const code = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const data = process.argv[2];
if (!data) { console.log(JSON.stringify({ ok: false, code: 'usage', error: '用法：node bin/data-root.mjs <数据目录>' })); process.exit(1); }
// 这些数据是更新的版本写的：什么都不做，告诉外壳（code: data_newer），由它说清楚「请打开新版」。
const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')).version || null; } catch { return null; } })(); // 兜底：读不到版本号就不写
const check = version ? dataVersionCheck({ data: path.resolve(data), version }) : { ok: true };
if (!check.ok) { console.log(JSON.stringify({ ok: false, code: 'data_newer', data_version: check.stored, app_version: version, error: `这些数据是 OfferCrew ${check.stored} 写的，比这个 App（${version}）新` })); process.exit(1); }
try {
  const r = linkEngine({ code, data: path.resolve(data) });
  // Mac 版的默认模型：不放这台电脑上的 Claude Code、Codex（lib/data-root.mjs seedDesktopDefaults，只在还没有这份文件时写）。
  const seeded = seedDesktopDefaults({ code, data: path.resolve(data) });
  if (version) recordDataVersion({ data: path.resolve(data), version });
  console.log(JSON.stringify({ ok: true, data: path.resolve(data), ...r, seeded, version }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code || 'error', error: String(e.message) }));
  process.exit(1);
}
