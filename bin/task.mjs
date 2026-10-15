#!/usr/bin/env node
// 成员给同事开一张卡（任务板，lib/tasks.mjs；执行器和以后「一件事一个短会话」用）。
//
//   node bin/task.mjs show <卡片 id>
//   node bin/task.mjs pass <卡片 id> --to <成员> --kind <类型> [--next "这一次要做成的事"] [--file <路径>]…
//
// 只能开给管这类事的那位（lib/crew.mjs KINDS）：Reacher 不会给 Judge 开一张「求职信」的卡。新卡附交接单
// （config/crew/shared.md 第 3 节的格式），原卡记一笔「开了一张卡给 …」，开始这件事的那个对话里多一行接力。
// 输出一行 JSON；参数不对、交给了不管这类事的成员时退出码 2，并说明怎么改。
import { passCard } from '../lib/tasks.mjs';
import { handoffText } from '../lib/card-ops.mjs';
import { readCards } from '../lib/cards.mjs';
import { relayLine } from '../lib/talk.mjs';
import { KINDS } from '../lib/crew.mjs';
import { isMain } from '../lib/is-main.mjs';

const USAGE = `用法：
  node bin/task.mjs show <卡片 id>
  node bin/task.mjs pass <卡片 id> --to <成员> --kind <类型> [--next "…"] [--file <路径>]…
  类型：${Object.keys(KINDS).filter(k => KINDS[k].member).join(' / ')}`;
export function parseArgs(argv) {
  const [cmd, id, ...rest] = argv, flags = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z]+)$/.exec(rest[i]);
    if (!m || rest[i + 1] == null) throw Error(`看不懂的参数：${rest[i]}`);
    (flags[m[1]] ||= []).push(rest[++i]);
  }
  return { cmd, id, flags };
}
export function runTask(argv) {
  const { cmd, id, flags } = parseArgs(argv);
  if (!['show', 'pass'].includes(cmd) || !id) throw Error('第一个参数写 show 或 pass，第二个写卡片 id');
  const found = readCards().filter(c => c.id === id || (id.length >= 6 && c.id.startsWith(id)));
  if (found.length !== 1) throw Error(found.length ? `前缀 ${id} 对上了好几张卡，多写几位` : `没有这张卡：${id}`);
  const card = found[0];
  if (cmd === 'show') return { card, handoff: handoffText(card.handoff) };
  const to = flags.to?.[0], kind = flags.kind?.[0];
  if (!to || !kind) throw Error('pass 要写 --to 和 --kind');
  const r = passCard(card.id, { to, kind, next: flags.next?.[0] || '', files: flags.file || [] });
  if (card.from?.session_id) relayLine({ session_id: card.from.session_id, from: r.from.owner, to: r.card.owner, card: r.card.id, text: r.line });
  return { ok: true, card: r.card.id, owner: r.card.owner, line: r.line, handoff: handoffText(r.card.handoff) };
}
if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(runTask(process.argv.slice(2)))); }
  catch (e) { console.error(`错误：${e.message}\n${USAGE}`); process.exit(2); }
}
