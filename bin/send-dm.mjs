// 发你批准过的平台私信：命令行入口。做事的在 lib/send-dm.mjs（worker 也在进程里调它）。
import { isMain } from '../lib/is-main.mjs';
import { main } from '../lib/send-dm.mjs';
export * from '../lib/send-dm.mjs';

if (isMain(import.meta.url)) await main();
