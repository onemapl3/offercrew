#!/usr/bin/env node
// 执行器报告任务结果的唯一入口（harness）。不要手改 state/host-jobs.ndjson。
//
//   node bin/job.mjs show <id>
//   node bin/job.mjs done <id> --result "做了什么、结果如何" [--evidence runs/...]
//   node bin/job.mjs need <id> login --account linkedin [--account xiaohongshu] [--url 登录页]
//   node bin/job.mjs need <id> info --title "补出生年月和现居城市" --question "申请表还缺两项" --field birth_month:出生年月:month --field city:现居城市
//   node bin/job.mjs need <id> decide --title "没找到联系人，怎么投？" --question "没找到联系人，怎么办？" --option 投官网 --option 先找内推 --option 不投了
//   node bin/job.mjs need <id> approve --title "核对申请表再提交" --question "表已填好停在提交前，请你核对后确认" [--url 申请页]
//   node bin/job.mjs blocked <id> --reason "查到哪一步、卡在哪" [--evidence runs/...]
//
// --title：短标题，约 20 个字的一句中文人话，不带代码名（卡片、成员卡上只放这一行；全文写在 --question）。可选，写了就校验。
// <id> 可以只写前 8 位以上（唯一即可）。need 可以连着写几次（先 login 再 info），同一件事只留最新一份。
// 公司调研（company_brief）和怎么准备（role_prep）：done 之前先用 node bin/company.mjs 写进去，否则拒收。
// 输出一行 JSON；参数不对时退出码 2，并说明怎么改。
// 记账：报完的结果同时记进指着这条任务的卡的那件活（lib/task-ledger.mjs mirrorHostJobs），任务卡只照账。
import { lines, writeLines, file } from '../lib/store.mjs';
import { validateNeed, attachNeeds, NEED_KINDS, FIELD_TYPES } from '../lib/needs.mjs';
import fs from 'node:fs';
import { isMain } from '../lib/is-main.mjs';

const USAGE = `用法：
  node bin/job.mjs show <id>
  node bin/job.mjs done <id> --result "…" [--evidence runs/…]
  node bin/job.mjs need <id> login --account <账号> [--account <账号>] [--url <登录页>]
  node bin/job.mjs need <id> info --title "…" --question "…" --field <key>:<名字>[:<类型>[:<选项1|选项2>]] …   类型：${FIELD_TYPES.join(' / ')}
  node bin/job.mjs need <id> decide --title "…" --question "…" --option <选项> --option <选项> …（2–5 个）
  node bin/job.mjs need <id> approve --title "…" --question "…" [--url <页面>]
  --title：约 20 个字的一句中文短标题，不带代码名（全文写在 --question）；可选
  node bin/job.mjs blocked <id> --reason "…" [--evidence runs/…]`;

export function parseArgs(argv) {
  const [cmd, id, ...rest] = argv, flags = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = rest[i + 1]; if (v == null || v.startsWith('--')) throw Error(`--${k} 后面缺值`); (flags[k] ||= []).push(v); i++; }
    else positional.push(a);
  }
  return { cmd, id, positional, flags };
}
const one = (flags, k) => flags[k]?.[flags[k].length - 1];
export function parseField(spec) {
  const [key, label, type, options] = String(spec).split(':');
  return { key, label: label || key, type: type || 'text', ...(options ? { options: options.split('|') } : {}) };
}

export async function runJob(argv, { now = Date.now() } = {}) {
  const { cmd, id, positional, flags } = parseArgs(argv);
  if (!['show', 'done', 'need', 'blocked'].includes(cmd)) throw Error(`不认识的命令「${cmd || ''}」`);
  if (!id || id.length < 8) throw Error('要给任务 id（至少前 8 位）');
  {
    const jobs = lines('state/host-jobs.ndjson');
    const hits = [...new Set(jobs.filter(j => j.id === id || String(j.id).startsWith(id)).map(j => j.id))];
    if (!hits.length) throw Error(`没有任务 ${id}`);
    if (hits.length > 1) throw Error(`id ${id} 对应多条任务，多写几位`);
    const job = jobs.findLast(j => j.id === hits[0]);
    const view = () => ({ ok: true, id: job.id, kind: job.kind, status: job.status, needs: job.needs || [], result: job.result || null });
    if (cmd === 'show') return view();
    const at = new Date(now).toISOString(), evidence = flags.evidence || [];
    if (cmd === 'done') {
      const result = String(one(flags, 'result') || '').trim();
      if (!result) throw Error('done 要写 --result（做了什么、结果如何）');
      // 公司调研、怎么准备：先经 bin/company.mjs 写进去（它会校验来源和 JD 引文），不能空着报完成。
      if (['company_brief', 'role_prep'].includes(job.kind)) (await import('../lib/company-brief.mjs')).doneGuard(job);
      Object.assign(job, { status: 'completed', completed_at: at, updated_at: at, result: result.slice(0, 4000), needs: [], waiting_user: null, blocked_reason: null });
      if (/^portal_login:/.test(job.resume_condition || '')) delete job.resume_condition;
      if (evidence.length) job.evidence = evidence.length === 1 ? evidence[0] : evidence;
    } else if (cmd === 'blocked') {
      const reason = String(one(flags, 'reason') || '').trim();
      if (!reason) throw Error('blocked 要写 --reason（查到哪一步、卡在哪）');
      // 不是你能解决的事：之前报过的「要你登录 / 补信息」一并作废，免得 System 页还写着要你登录、登录恢复时又把它拉起来。
      Object.assign(job, { status: 'blocked', updated_at: at, blocked_reason: reason.slice(0, 2000), result: reason.slice(0, 4000), needs: [], waiting_user: null });
      if (/^portal_login:/.test(job.resume_condition || '')) delete job.resume_condition;
      if (evidence.length) job.evidence = evidence.length === 1 ? evidence[0] : evidence;
    } else {
      const kind = positional[0];
      if (!NEED_KINDS.includes(kind)) throw Error(`need 后面写 ${NEED_KINDS.join(' / ')} 之一`);
      const base = { kind, url: one(flags, 'url'), note: one(flags, 'note'), question: one(flags, 'question'), title: one(flags, 'title') };
      const needs = kind === 'login'
        ? (flags.account || []).map(account => validateNeed({ ...base, account }, { now }))
        : [validateNeed({ ...base, fields: (flags.field || []).map(parseField), options: flags.option || [] }, { now })];
      if (!needs.length) throw Error('login 要写 --account（可以写几个）');
      attachNeeds(job, needs, { now });
      if (evidence.length) job.evidence = evidence.length === 1 ? evidence[0] : evidence;
    }
    writeLines('state/host-jobs.ndjson', jobs);
    // 记账（第 2 步 2X）：指着这条任务的卡，那件活跟着记做完 / 等你 / 卡住（lib/task-ledger.mjs mirrorHostJobs）。卡只照账。
    try {
      const [{ mirrorHostJobs }, { readCards }] = await Promise.all([import('../lib/task-ledger.mjs'), import('../lib/cards.mjs')]);
      mirrorHostJobs([job], readCards(), { now });
    } catch (e) { console.error(`[jobs] 任务 ${job.id} 记账出错（任务本身已经记下，工作台下一次同步再记）：${e.message}`); }
    return view();
  }
}

if (isMain(import.meta.url)) {
  try {
    const out = await runJob(process.argv.slice(2));
    // 任务板（lib/tasks.mjs）：指向这条交办任务的卡跟着变；做完了就按目标的路线接力（下一张卡由工作台开跑）。
    if (process.argv[2] !== 'show' && fs.existsSync(file('state/tasks.ndjson'))) {
      try { const { syncTasks } = await import('../lib/tasks.mjs'); const { relayLine } = await import('../lib/talk.mjs'); await syncTasks({ start: false, relayLine }); } catch (e) { console.error(`[tasks] 接力没接上（工作台下一次同步再接）：${e.message}`); }
    }
    console.log(JSON.stringify(out));
  }
  catch (e) { console.error(`错误：${e.message}\n${USAGE}`); process.exit(2); }
}
