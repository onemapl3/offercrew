#!/usr/bin/env node
// 在专用 Chrome 上跑一段浏览器脚本：
//   node bin/browser.mjs -e '<脚本>'          （也认 node bin/browser.mjs nodejs -e '<脚本>'）
//   node bin/browser.mjs <<'EOF' … EOF        （没有 -e 就从标准输入读）
// 脚本的写法：taskSpace、task.page("p1")、page.goto / evaluate / click / fill……（lib/browser-compat.mjs）。
//   node bin/browser.mjs --stop               关掉专用 Chrome（App 退出时调，desktop/main.mjs）
// 脚本自己用 console.log 输出结果；出错时错误写到标准错误，退出码 1。
// 不躲检测：专用 Chrome 带着标准的自动化开关；网站要登录、要验证时，脚本停下来交给你，不绕过去。
const args = process.argv.slice(2);
if (args[0] === '--stop') {
  const { stopHost } = await import('../lib/browser-host.mjs');
  const r = await stopHost().catch(e => ({ stopped: false, error: String(e?.message || e).slice(0, 200) }));
  console.log(JSON.stringify(r));
  process.exit(0);
}
const { runCompatScript } = await import('../lib/browser-compat.mjs');
if (args[0] === 'nodejs') args.shift();
const readStdin = () => new Promise(resolve => {
  if (process.stdin.isTTY) return resolve('');
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { s += c; });
  process.stdin.on('end', () => resolve(s));
  process.stdin.on('error', () => resolve(s));
});
const i = args.indexOf('-e');
const source = i >= 0 ? args[i + 1] : await readStdin();
if (!String(source || '').trim()) {
  process.stderr.write('用法：node bin/browser.mjs -e \'<脚本>\'（写法见 lib/browser-compat.mjs：taskSpace、task.page("p1")、page.goto……）\n');
  process.exit(2);
}
try {
  await runCompatScript(source);
  process.exit(0);
} catch (e) {
  process.stderr.write(`${String(e?.stack || e?.message || e).split('\n').slice(0, 6).join('\n')}\n`);
  process.exit(1);
}
