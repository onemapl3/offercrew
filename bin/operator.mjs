// 手动试内置操作员（2026-09-28）：打开一个网址，按你写的目标一步步操作，打印每一步，停在提交前。
//
//   node bin/operator.mjs --url <网址> --goal "<要做的事>" [--data data.json | --data-json '{…}']
//     [--backend playwright|host] [--headless] [--channel auto|chrome|chromium] [--model 供应商/模型] [--vision]
//     [--allow-host a.com,b.com] [--max-steps 25] [--no-recipes] [--screenshots <目录>] [--keep-open]
//     [--script actions.json] [--json]
//
// 没写的选项用 config/computer-use.json 的 operator 段。--script 给一串写好的动作代替模型（演示、排查用）。
// 永远不提交：终审闸门没有开关。有头模式停在终审或要你登录时，窗口留着，按回车才关；--keep-open 则让
// 浏览器单独起进程，命令结束窗口还在。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { arg, file, today } from '../lib/store.mjs';
import { runTask, scriptedModel } from '../lib/operator/agent.mjs';
import { openBrowser } from '../lib/operator/browser.mjs';
import { computerUseSettings, operatorModelRef } from '../lib/operator/config.mjs';

const flag = name => process.argv.includes(name);
const url = arg('--url'), goal = arg('--goal');
if (!url || !goal || flag('--help')) {
  console.error('用法：node bin/operator.mjs --url <网址> --goal "<要做的事>" [--data data.json] [--backend playwright|host] [--headless] [--model 供应商/模型] [--script actions.json] [--json]');
  process.exit(url && goal ? 0 : 2);
}
const op = computerUseSettings().operator;
const readJson = p => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const data = arg('--data') ? readJson(arg('--data')) : arg('--data-json') ? JSON.parse(arg('--data-json')) : {};
const backendName = arg('--backend', op.backend || 'playwright');
const headless = flag('--headless') || (!!op.headless && !flag('--headful'));
const keepOpen = flag('--keep-open');
const script = arg('--script');
const model = script ? scriptedModel(readJson(script), { label: `script:${path.basename(script)}` })
  : arg('--model') ? { ref: arg('--model'), vision: flag('--vision') || !!op.vision } : operatorModelRef(op);
const shots = arg('--screenshots') ? path.resolve(arg('--screenshots')) : file(`runs/${today()}/operator`);
const json = flag('--json');
const say = (...a) => { if (!json) console.log(...a); };

const mark = s => (s.stopped ? '⏸ 停在终审（没有点）' : s.refused ? `✗ 拒绝：${s.message || s.refused}` : s.ok ? '✓' : `✗ ${s.error || ''}`);
const shown = v => (v == null || v === '' ? '' : ` = ${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)}`);
const onStep = s => say(`#${s.i} ${s.replay ? '[回放] ' : ''}${s.action}${s.id != null ? ` [${s.id}]` : ''}${s.label ? ` 「${String(s.label).slice(0, 40)}」` : ''}${s.action === 'click' ? '' : shown(s.value)} ${mark(s)}`);

let page;
try { page = await openBrowser({ backend: backendName, headless, channel: arg('--channel', op.channel || 'auto'), profile_dir: op.profile_dir || 'private/operator-profile', keep_open: keepOpen && backendName === 'playwright' }); }
catch (e) { console.error(`打不开浏览器：${e.message}`); process.exit(1); }
let result, review = false;
try {
  say(`内置操作员 · ${backendName}${headless ? '（无头）' : ''} · 模型 ${model?.label || model?.ref || model?.model || '（无：只能回放配方）'}`);
  say(`目标：${goal}\n起点：${url}\n`);
  result = await runTask({ goal, start_url: url, data, page, model, onStep, allow_hosts: arg('--allow-host') ? arg('--allow-host').split(',').map(s => s.trim()).filter(Boolean) : null, max_steps: Number(arg('--max-steps', op.max_steps || 25)), recipes: !flag('--no-recipes') && op.recipes !== false, screenshot_dir: shots, stop_before: op.stop_before || null });
} finally {
  // 页面是这里开的：停在终审 / 要你登录时，有头窗口等你看完再关。
  review = !!result && ['ready_for_review', 'need_user'].includes(result.status);
  if (review && keepOpen) await page.close({ keep: true }).catch(() => {}); // 兜底：关不掉就留着给你看，不影响这次的结果
  else {
    if (review && !headless && process.stdin.isTTY) {
      console.log('\n浏览器留着给你检查（系统没有提交）。看完按回车关闭。');
      await new Promise(resolve => { const rl = readline.createInterface({ input: process.stdin }); rl.once('line', () => { rl.close(); resolve(); }); });
    }
    await page.close({ keep: false }).catch(() => {}); // 兜底：浏览器已经关了
  }
}
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`\n结果：${result.status}${result.reason ? `（${result.reason}）` : ''}`);
  console.log(`页面：${result.url || '-'}`);
  if (result.filled.length) console.log(`填了：\n${result.filled.map(f => `  · ${f.label}：${typeof f.value === 'boolean' ? (f.value ? '已勾选' : '未勾选') : f.value}`).join('\n')}`);
  if (result.stop) console.log(`停在：「${result.stop.label}」——你检查无误后自己点。`);
  if (result.screenshot) console.log(`截图：${result.screenshot}`);
  console.log(`模型调用 ${result.model_calls} 次${result.replayed ? '（整段按配方回放）' : ''}${result.recipe?.saved ? ' · 已记成配方' : ''}${keepOpen && review ? ' · 窗口留着' : ''}`);
}
process.exitCode = ['ready_for_review', 'done', 'need_user'].includes(result.status) ? 0 : 1;
