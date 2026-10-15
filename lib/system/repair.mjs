// System 自动修复（契约 05 第一节第 6 项，指挥台拆出来的第四块）：流程之外卡住的事（挡路的、告警），按 config/host.json system_auto_repair 的节流
// 交给执行器修。要看的视图由调用方算好传进来（bin/serve.mjs 的 auto-repair 那一项用 lib/command-center.mjs repairInputs），这里不引视图。
import { localAiGate } from '../capabilities.mjs';
import { crewName } from '../crew.mjs';
import { sameTarget, handToSystem } from '../dispatch.mjs';
import { event } from '../events.mjs';
import { reconcileHostJobs } from '../runtime-recovery.mjs';
import { sandboxed, sandboxSkip } from '../sandbox.mjs';
import { cachedLines } from '../state-cache.mjs';
import { read } from '../store.mjs';
import { playbookCovers } from './playbook.mjs';

const label = l => `${l.number ?? '待编号'} · ${l.company || '待核'} · ${l.role || ''}`;
// 视图只读：用按文件签名缓存的解析结果（lib/state-cache.mjs），不要改这些对象。
export const latestHostJobs = () => reconcileHostJobs([...new Map(cachedLines('state/host-jobs.ndjson').map(j => [j.id, j])).values()], cachedLines('state/leads.ndjson'), cachedLines('state/events.ndjson'));

// ── System 自动修复 ───────────────────────────────────────────────────────────
// System 是一直在跑的修复角色：流程之外走不下去的东西（needs=system 的阻塞项、
// 非网络抖动的错误告警）自动打包成 system_fix 交给执行器，不用用户来点；
// 只有执行器判定需要用户决策（waiting_user）时才进「等我处理」。
// 节流：同时最多 max_open 条未完成，每小时最多 per_hour 条新任务，同一目标
// cooldown_hours 内不重复；开关与阈值在 config/host.json system_auto_repair。
// local_ai：桌面版里也让本机 AI 帮着查（默认关；命令行装的不看它）。
export const AUTO_REPAIR_DEFAULTS = { enabled: true, local_ai: false, max_open: 1, per_hour: 2, cooldown_hours: 24 };
// 自动修复会在没人点的时候拉起执行器（Codex / Claude，不带沙箱；提示词不许它改代码，代码守卫兜底）。还没有
// config/host.json 的新装机器一律不开：得是装的人自己决定打开（config/host.example.json 里写的是 enabled: false，
// 设置页可开）。已有 host.json、没写这一项的机器照旧按缺省开着。
export function autoRepairConfig(host = read('config/host.json', null)) { return { ...AUTO_REPAIR_DEFAULTS, ...(host ? {} : { enabled: false }), ...(host?.system_auto_repair || {}) }; }
// 写锁竞争（another_radar_writer_running）也是瞬时的：project-journey / concierge 这类长同步持锁时别的写者等锁超时，下一轮自然恢复，不是要修的 bug。
export const TRANSIENT = /飞书|TLS|socket|ETIMEDOUT|重连|network|连接中|同步暂未完成|没有按时启动|超过 30 分钟|中断收尾|another_radar_writer_running|写锁/;
export const stripCount = t => String(t || '').replace(/（24 小时内 \d+ 次）/g, '').trim();
export function repairCandidates({ blocked = [], alerts = [] } = {}) {
  const out = [];
  for (const b of blocked) if (b.needs === 'system' && !(b.source === 'host_job' && b.kind === 'system_fix')) out.push({ source: b.source, label: b.label, reason: b.reason, evidence: b.evidence || null, key: b.key || null, id: b.id || null, record_id: b.record_id || null, number: b.number ?? null, company: b.company || null, step: b.step || null });
  for (const a of alerts) if (a.level === 'error' && !TRANSIENT.test(a.msg) && !a.system_job) out.push({ source: 'alert', label: a.msg, reason: (a.detail || []).join('；'), refs: (a.refs || []).map(r => r.file || r.screenshot).filter(Boolean).slice(0, 6), evidence: (a.refs || []).map(r => r.file).find(f => f && /\.(json|md|log)$/.test(f)) || null });
  return out;
}
// 自动排入的修复在任务说明里带这句话；名字从名册来，认的时候不看名字（改名前排的也认得出）。
export const AUTO_REPAIR_NOTE = `${crewName('patch')} 自动修复`;
export const AUTO_REPAIRED = /（[^（）]{1,24} 自动修复：无人点击/;
// 2b 改道（方案-System监工-第2批.md 第六节）：桌面版默认先走标准做法（lib/system/watch.mjs 每分钟一拍），表上没有的
// 不再打包成 system_fix 交给本机 AI，只返回记下了哪几条（健康账本照常列着，告诉你按注意力规矩来，横条是页面的事）。
// 本机 AI 打开了（localAiGate allowed）、你又在设置里开了 system_auto_repair.local_ai，才照旧交给它，标准做法管了的那几条不交。
// 命令行装的：行为不变（老用户的习惯不动）。
export async function autoRepair({ now = Date.now(), config = autoRepairConfig(), blocked = null, alerts = null, hand = handToSystem, gate = localAiGate() } = {}) {
  if (!config.enabled) return { status: 'disabled', queued: [] };
  const viaLocalAi = gate.allowed && config.local_ai === true; // 命令行版 10-04 冻结：只有一种身份
  // 卡住的事从视图来（挡路的、告警）：调用方算好传进来（bin/serve.mjs 用 lib/command-center.mjs repairInputs），这里不往上引视图。
  if (!blocked || !alerts) throw Error('自动修复要先算好挡路的事和告警再交进来');
  if (!viaLocalAi) return { status: 'playbook', queued: [], noted: repairCandidates({ blocked, alerts }).map(t => t.label) };
  const jobs = latestHostJobs().filter(j => j.kind === 'system_fix');
  const open = jobs.filter(j => ['pending', 'working'].includes(j.status)).length;
  const lastHour = jobs.filter(j => now - Date.parse(j.created_at || 0) < 3600000).length;
  const budget = Math.max(0, Math.min(config.max_open - open, config.per_hour - lastHour));
  const recent = t => jobs.some(j => (sameTarget(j.target || {}, t) || (t.source === 'alert' && j.target?.source === 'alert' && stripCount(j.target.label) === stripCount(t.label))) && (['pending', 'working'].includes(j.status) || now - Date.parse(j.completed_at || j.created_at || 0) < config.cooldown_hours * 3600000));
  const queued = [], skipped = [];
  for (const t of repairCandidates({ blocked, alerts })) {
    if (queued.length >= budget) break;
    if (gate.desktop && playbookCovers(t)) continue;
    // A timestamped run-now key identifies one historical execution. Its failed
    // heartbeat remains evidence after repair; cooldown expiry is not a new failure.
    // Manual handToSystem requests and new execution keys remain eligible.
    if (t.source === 'executor' && /^run-now:\d{4}-/.test(t.key || '') && jobs.some(j => j.status === 'completed' && j.target?.source === 'executor' && j.target.key === t.key)) continue;
    if (recent(t)) continue;
    // 演示 / 沙盒模式：自动修复不排任务、不交给执行器（Codex / Claude），只记一行（lib/sandbox.mjs）。
    if (sandboxed()) { sandboxSkip(`${crewName('patch')} 自动修复（交给执行器）：${t.label.slice(0, 80)}`, { actor: 'system' }); skipped.push(t.label); if (skipped.length >= budget) break; continue; }
    const r = await hand(t, { now, local: true, note: `（${AUTO_REPAIR_NOTE}：无人点击，按 system_auto_repair 规则排入）` });
    if (r.status === 'queued') queued.push({ job_id: r.job_id, label: t.label });
  }
  if (queued.length) event('system', 'auto-repair', 'ok', `${crewName('patch')} 自动排入 ${queued.length} 条修复：${queued.map(q => q.label.slice(0, 40)).join('；')}`);
  return { status: 'ok', open, budget, queued, ...(skipped.length ? { sandbox: skipped } : {}) };
}
