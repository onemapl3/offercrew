#!/usr/bin/env node
// 在浏览器里打开本机工作台（命令行装的用；Mac 版 App 自己会开窗口）。工作台只认带钥匙的浏览器（lib/local-auth.mjs）：
// 这里打开一个带钥匙的地址，工作台收下钥匙写进这个浏览器的 cookie，以后直接打开 http://127.0.0.1:<端口> 就行。
//   node bin/open-workbench.mjs            用默认浏览器打开
//   node bin/open-workbench.mjs --print    只打出地址（里面有钥匙，别发给别人）
import { execFile } from '../lib/spawn.mjs';
import { read } from '../lib/store.mjs';
import { storedKey, workbenchLink } from '../lib/local-auth.mjs';

const port = Number(read('config/host.json', {})?.workbench_port) || 4321;
const key = storedKey();
if (!key) { console.error('工作台还没启动过：先启动它（node bin/serve.mjs，或者装好的定时任务），再运行这个命令。'); process.exit(1); }
const link = workbenchLink(port, key);
if (process.argv.includes('--print')) { console.log(link); process.exit(0); }
execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], (e) => {
  if (e) { console.error(`没能打开浏览器：${e.message}。用 --print 打出地址，自己复制到浏览器里。`); process.exit(1); }
  console.log(`已在浏览器里打开工作台（http://127.0.0.1:${port}）。`);
});
