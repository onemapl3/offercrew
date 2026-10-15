#!/usr/bin/env node
// Watch 的公司调研和「怎么准备」：执行器写入的唯一入口（lib/company-brief.mjs）。写错了整份拒收，并逐条说怎么改。
//
//   node bin/company.mjs template brief|prep                 打印要填的 JSON 骨架
//   node bin/company.mjs show <公司|编号>                      这家公司现在的调研和状态
//   node bin/company.mjs brief <公司|编号> --file <json> [--check] [--by claude|codex]
//   node bin/company.mjs prep-input <编号>                     写「怎么准备」要用的：JD 原文、判断的缺口、公司调研
//   node bin/company.mjs prep <编号> --file <json> [--check] [--by claude|codex]
//   node bin/company.mjs request <公司|编号> [--prep]          现在就排调研（--prep：Judge 为这条线索写怎么准备，等它写完）
//
// --check 只校验、不写入。写入成功会把开着的同一家公司的调研任务（或这条线索的「怎么准备」任务）记为完成；
// 执行器随后照常 node bin/job.mjs done <任务id>。输出一行 JSON；参数不对、校验不过时退出码 2。
import fs from 'node:fs';
import { lines, writeLines } from '../lib/store.mjs';
import { cachedLines } from '../lib/state-cache.mjs';
import { TEMPLATES, BRIEF_KIND, PREP_KIND, validateBrief, saveBrief, briefFor, briefPath, companyKey, companyState, validatePrep, savePrep, prepPath, prepInput, closeJobs, requestBrief, loadBriefs } from '../lib/company-brief.mjs';
import { requestPrep } from '../lib/role-prep.mjs';
import { isMain } from '../lib/is-main.mjs';

const USAGE = `用法：
  node bin/company.mjs template brief|prep
  node bin/company.mjs show <公司|编号>
  node bin/company.mjs brief <公司|编号> --file <json> [--check] [--by claude|codex]
  node bin/company.mjs prep-input <编号>
  node bin/company.mjs prep <编号> --file <json> [--check] [--by claude|codex]
  node bin/company.mjs request <公司|编号> [--prep]`;

class Rejected extends Error { constructor(errors) { super(`没有写入，${errors.length} 处要改：\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`); this.errors = errors; } }
export function parseArgs(argv) {
  const [cmd, ...rest] = argv, flags = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (['--check', '--prep'].includes(a)) { flags[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) { const v = rest[i + 1]; if (v == null || v.startsWith('--')) throw Error(`${a} 后面缺值`); flags[a.slice(2)] = v; i++; }
    else positional.push(a);
  }
  return { cmd, target: positional.join(' ').trim(), flags };
}
const liveLeads = () => cachedLines('state/leads.ndjson').filter(l => !l.superseded);
// 编号（12、#12）或线索 id（还没编号的线索）认成线索；别的认成公司名。
function leadOf(target) {
  const t = String(target || '').trim(), m = /^#?(\d+)$/.exec(t);
  if (!m) return liveLeads().find(x => (x.record_id || x.id) === t) || null;
  const l = liveLeads().find(x => x.number === Number(m[1]));
  if (!l) throw Error(`没有编号 ${m[1]} 的线索`);
  return l;
}
const companyOf = target => { const l = leadOf(target); return l ? l.company : String(target || '').trim(); };
function readInput(p) {
  if (!p) throw Error('要写 --file <json 文件>');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { throw Error(`读不到 ${p}`); }
  try { return JSON.parse(text); } catch (e) { throw new Rejected([`${p} 不是合法的 JSON：${e.message}`]); }
}
const by = flags => ['claude', 'codex', 'user'].includes(flags.by) ? flags.by : null;

export async function runCompany(argv, { now = Date.now() } = {}) {
  const { cmd, target, flags } = parseArgs(argv);
  if (cmd === 'template') {
    if (!['brief', 'prep'].includes(target)) throw Error('template 后面写 brief 或 prep');
    return TEMPLATES[target];
  }
  if (cmd === 'show') {
    if (!target) throw Error('show 后面写公司名或线索编号');
    const name = companyOf(target), st = companyState(name, { jobs: cachedLines('state/host-jobs.ndjson'), now });
    return { ok: true, company: name, key: st.key, state: st.state, open: st.open, job: st.job ? { id: st.job.id, status: st.job.status, created_at: st.job.created_at } : null, path: st.brief ? briefPath(st.brief.key) : null, brief: st.brief };
  }
  if (cmd === 'brief') {
    if (!target) throw Error('brief 后面写公司名（或线索编号）');
    // 这个名字是已有调研的别名（「ByteDance」对「字节跳动」）：写进那一份，不另开一份。
    const asked = companyOf(target), canonical = briefFor(asked), name = canonical && canonical.key !== companyKey(asked) ? canonical.company : asked;
    const { brief, errors } = validateBrief(readInput(flags.file), { company: name, now });
    if (brief && name !== asked) brief.aliases = [...new Set([...brief.aliases, asked])];
    // 已经有一份像样的调研：这次没查到东西不能把它冲掉。
    if (brief?.status === 'not_found' && canonical?.status === 'ready') errors.push(`${canonical.company} 已经有一份调研（${String(canonical.updated_at || '').slice(0, 10)}）：这次没查到新东西就把旧内容照原样写回（node bin/company.mjs show 看），查不下去就报 blocked，不要写 not_found`);
    const others = loadBriefs();
    for (const a of brief?.aliases || []) { const k = companyKey(a); if (k && k !== brief.key && others.has(k)) errors.push(`aliases 里的「${a}」已经是另一份调研（${others.get(k).company}）的公司名：两家公司不要并成一份`); }
    if (errors.length) throw new Rejected(errors);
    const claims = ['business', 'scale', 'hiring', 'tech', 'news', 'culture', 'interview', 'salary', 'red_flags'].reduce((n, k) => n + (brief[k]?.length || 0), 0) + (brief.summary ? 1 : 0);
    if (flags.check) return { ok: true, check: true, company: brief.company, key: brief.key, status: brief.status, claims, sources: brief.sources.length };
    const saved = saveBrief(brief, { now, by: by(flags) }), jobs = lines('state/host-jobs.ndjson');
    const closed = closeJobs(jobs, { kind: BRIEF_KIND, keys: [saved.key, ...saved.aliases.map(companyKey)].filter(Boolean), now, evidence: briefPath(saved.key),
      result: saved.status === 'not_found' ? `查过了，${saved.company} 的公开资料很少：${saved.note}` : `${saved.company} 的公司调研已写入：${claims} 条说法、${saved.sources.length} 个来源` });
    if (closed.length) writeLines('state/host-jobs.ndjson', jobs);
    return { ok: true, company: saved.company, key: saved.key, status: saved.status, claims, sources: saved.sources.length, path: briefPath(saved.key), revision: saved.revision, jobs_closed: closed };
  }
  if (cmd === 'prep-input') {
    const l = leadOf(target);
    if (!l) throw Error('prep-input 后面写线索编号（还没编号的写线索 id）');
    return prepInput(l);
  }
  if (cmd === 'prep') {
    const l = leadOf(target);
    if (!l) throw Error('prep 后面写线索编号（还没编号的写线索 id）');
    const brief = briefFor(l.company), { prep, errors } = validatePrep(readInput(flags.file), { lead: l, brief });
    if (errors.length) throw new Rejected(errors);
    const count = prep.review.length + prep.pitch.length + prep.company.length;
    if (flags.check) return { ok: true, check: true, number: l.number, items: count };
    const saved = savePrep(l, prep, { brief, now, by: by(flags) }), jobs = lines('state/host-jobs.ndjson');
    const closed = closeJobs(jobs, { kind: PREP_KIND, record_id: saved.record_id, now, evidence: prepPath(saved.record_id), result: `${l.number != null ? `#${l.number}` : l.company || '这个岗位'} 的「怎么准备」已写入：${count} 条` });
    if (closed.length) writeLines('state/host-jobs.ndjson', jobs);
    return { ok: true, number: l.number, record_id: saved.record_id, items: count, path: prepPath(saved.record_id), jobs_closed: closed };
  }
  if (cmd === 'request') {
    if (!target) throw Error('request 后面写公司名或线索编号');
    const l = leadOf(target);
    // 「怎么准备」由 Judge 自己写（lib/role-prep.mjs）：命令行等它写完再退出（进程一退，后台写就断了）。
    if (flags.prep) { if (!l) throw Error('--prep 要写线索编号'); return { ok: true, ...(await requestPrep({ record_id: l.record_id || l.id, source: 'cli', now, wait: true })) }; }
    return { ok: true, ...(await requestBrief({ company: l ? l.company : target, record_id: l ? (l.record_id || l.id) : null, source: 'cli', now })) };
  }
  throw Error(`不认识的命令「${cmd || ''}」`);
}

// 直接运行时（bin/ 可能是软链接：演示目录、Mac App 的数据目录里都是）。
if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await runCompany(process.argv.slice(2)))); }
  catch (e) { console.error(e instanceof Rejected ? e.message : `错误：${e.message}\n${USAGE}`); process.exit(2); }
}
