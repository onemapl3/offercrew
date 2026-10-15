// 收件箱巡检认出的 LinkedIn 私信 / InMail 通知邮件（lib/linkedin-mail.mjs）：对上线索的登记成来信（「对方在 LinkedIn 上回了你」），
// 对不上的合成一封信。输入和 bin/inbox.mjs 一样：--input runs/<日>/mail-poll/linkedin-<时间>.json，内容 {"messages":[{id,thread_id,from,subject,body,at}]}。
// 没有输入、文件不在、一封都没有：什么都不做，照常退出（LinkedIn 的邮箱和通知改好之前一封都不会有）。
import { waitForLock } from '../lib/lock.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { arg, read, write, lines, writeLines, file } from '../lib/store.mjs';
import { event } from '../lib/events.mjs';
import { recordLinkedInMail, STATE_PATH } from '../lib/linkedin-mail.mjs';
import { noteSwallowed } from '../lib/swallow.mjs';

const input = arg('--input');
let messages = [];
const where = input ? (path.isAbsolute(input) ? input : file(input)) : null;
if (where && fs.existsSync(where)) { let j = {}; try { j = JSON.parse(fs.readFileSync(where, 'utf8')); } catch (e) { noteSwallowed('linkedin-mail.read', e, { member: 'owl', doing: `读 LinkedIn 消息文件 ${where}`, then: '当没有消息' }); } messages = Array.isArray(j?.messages) ? j.messages : Array.isArray(j) ? j : []; }
if (!messages.length) { console.log(JSON.stringify({ status: 'no_change', linkedin: 0 })); process.exit(0); }
let r;
const releaseLinkedIn=await waitForLock('linkediningest',{timeout:10000,interval:25});
try {
  const leads = lines('state/leads.ndjson'), outbound = lines('state/outbound.ndjson'), events = lines('state/inbox-events.ndjson');
  r = recordLinkedInMail(messages, { leads, outbound, events, state: read(STATE_PATH, {}) || {} });
  if (r.raised) writeLines('state/leads.ndjson', leads);
  if (r.events) writeLines('state/inbox-events.ndjson', events);
  if (Object.keys(r.base).length) write('state/inbox-base-pending.json', { ...(read('state/inbox-base-pending.json', {}) || {}), ...r.base });
  write(STATE_PATH, r.state);
} finally {releaseLinkedIn();}
if (r.seen) event('owl', 'linkedin-mail', 'ok', `LinkedIn 通知邮件：${r.seen} 封${r.raised ? `，${r.raised} 封对上岗位` : ''}${r.unlinked ? `，${r.unlinked} 封对不上` : ''}`);
console.log(JSON.stringify({ status: r.seen ? 'changed' : 'no_change', linkedin: r.seen, raised: r.raised, unlinked: r.unlinked, skipped: r.skipped }));
