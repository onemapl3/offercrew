// Watcher 看一眼 BOSS 直聘的聊天列表（lib/boss-inbox.mjs）：只读列表，不点开对话、不回复。
// 默认关（config/pipeline.json boss_chat_watch）；工作台每小时在 09:00–21:00 里自己看（bin/serve.mjs），
// 操作台「看 BOSS 消息」手动跑这个脚本（--now：不等到点、不看时段；开关、登录、暂停、沙盒照旧）。
import { runBossInbox } from '../lib/boss-inbox.mjs';
import { MAIL_POLL_HOURS } from '../lib/app-schedule.mjs';
const r = await runBossInbox({ force: process.argv.includes('--now'), hours: MAIL_POLL_HOURS });
console.log(JSON.stringify(r));
