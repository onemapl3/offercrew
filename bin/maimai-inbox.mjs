// Watcher 看一眼脉脉的消息列表（lib/maimai-inbox.mjs）：只读列表，不点开对话、不回复。
// 默认关（config/pipeline.json maimai_chat_watch）；工作台在 09:00–21:00 每两小时自己看（bin/serve.mjs），
// 操作台「看脉脉消息」手动跑这个脚本（--now：不等到点、不看时段；开关、登录、暂停、沙盒照旧）。
import { runMaimaiInbox } from '../lib/maimai-inbox.mjs';
import { MAIL_POLL_HOURS } from '../lib/app-schedule.mjs';
const r = await runMaimaiInbox({ force: process.argv.includes('--now'), hours: MAIL_POLL_HOURS });
console.log(JSON.stringify(r));
