#!/usr/bin/env node
// 执行器跑完记一笔用量（Patch 的记账，lib/usage.mjs）。bin/host/run-now.sh、radar-cycle.sh、mail-poll.sh 每次尝试跑完调一次；
// 出错只丢这一笔，不影响执行器本身（脚本里 >/dev/null 2>&1）。沙盒里这几个脚本一开头就退出，走不到这里。
//
//   node bin/host/record-usage.mjs --kind codex|claude --log <这次的日志> --launcher cycle|run-now|mail-poll
//                                  [--provider <模型目录里的 key>] [--backend claude_code|anthropic_http] [--codex-home <这次用的登录目录>]
//
// 执行器不是成员，它的会话记到请它做事的成员名下（lib/usage.mjs crewMember）：
//   run-now    这一批任务（state/run-now.json 的 queue → state/host-jobs.ndjson 的任务种类，或对话的角色）都是同一位成员的，
//              就记到那一位；几位成员合用、或者认不出，记到 Patch 并写明。只做了公司调研 /「怎么准备」的，步骤记成 research。
//   cycle      定时周期的大会话，几位成员的活一起做：记到 Patch（定时运行），写明原因。
//   mail-poll  Owl。
// Codex：从日志抬头认出这次开了哪几个会话（session id），去 Codex 自己的会话记录里读那几个会话的总用量和本周额度
// （只读数字字段，lib/usage.mjs readRollout）。--codex-home 空着就按 codex 自己的规则（CODEX_HOME，没设就是 ~/.codex）找这次用的目录，只看这几个会话号的文件。日志末尾的「tokens used」只是没命中缓存的输入加输出，不用它。
// Claude：读日志里最后那条 result（我们自己的 stream-json 日志）。
import fs from 'node:fs';
import path from 'node:path';
import { crewName } from '../../lib/crew.mjs';
const { read, lines } = await import('../../lib/store.mjs');
const U = await import('../../lib/usage.mjs');

const flags = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const v = process.argv[i + 1]; flags[a.slice(2)] = v != null && !v.startsWith('--') ? (i++, v) : ''; } }
const log = flags.log ? path.resolve(flags.log) : null;
if (!log || !fs.existsSync(log)) { console.log(JSON.stringify({ recorded: 0, reason: 'no_log' })); process.exit(0); }
const launcher = ['cycle', 'run-now', 'mail-poll'].includes(flags.launcher) ? flags.launcher : 'run-now';

// 请执行器做事的是谁。
function requester() {
  if (launcher === 'mail-poll') return { member: 'owl', step: 'mail-poll' };
  if (launcher === 'cycle') return { member: 'patch', step: 'cycle', member_note: U.CYCLE_NOTE };
  const queue = read('state/run-now.json', {})?.queue || [];
  const jobs = new Map(lines('state/host-jobs.ndjson').map(j => [j.id, j]));
  const job_ids = [...new Set(queue.flatMap(q => q.job_ids || []))];
  const kinds = job_ids.map(id => jobs.get(id)?.kind).filter(Boolean);
  const who = [...job_ids.map(id => jobs.get(id)).filter(Boolean).map(j => U.crewMember({ job_kind: j.kind, role: j.thread?.persona || null }).member),
    ...queue.filter(q => !(q.job_ids || []).length).map(q => (q.thread?.persona ? U.crewMember({ role: q.thread.persona }).member : null))];
  const members = [...new Set(who.filter(Boolean))], research = kinds.length > 0 && kinds.every(k => ['company_brief', 'role_prep'].includes(k));
  const step = research ? 'research' : 'run-now';
  if (members.length === 1 && !who.includes(null)) return { member: members[0], step, job_ids };
  return { member: 'patch', step, job_ids, member_note: members.length > 1 ? `几位成员合用这次会话（${members.map(crewName).join('、')}），先记在 ${crewName('patch')} 名下` : U.UNKNOWN_EXECUTOR_NOTE };
}
const who = { launcher, ...requester() };
const kind = flags.kind || (/\.jsonl$/.test(log) ? 'claude' : 'codex');
let recorded = 0;
if (kind === 'claude') recorded = U.recordRows(U.claudeLogRows({ log, ...who, provider: flags.provider || null, backend: flags.backend || 'claude_code' }));
else {
  const sessions = U.parseCodexLog(fs.readFileSync(log, 'utf8'));
  const attribution = Object.fromEntries(sessions.map(s => [s.session, { ...who, provider: flags.provider || null, model: s.model }]));
  if (sessions.length) recorded = U.syncCodexSessions({ sessions: sessions.map(s => s.session), attribution, homes: [...new Set([flags['codex-home'] || process.env.CODEX_HOME || U.DEFAULT_CODEX_HOME, ...U.codexHomes()].filter(Boolean))] });
}
console.log(JSON.stringify({ recorded, ...who }));
