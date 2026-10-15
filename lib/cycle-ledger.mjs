// 周期记账（线 S；主会话 10-04 定的规矩，线 H 照同一条）：一次周期在账上只有一件活，每一步是它下面的一件。
//   哪一件   子进程环境里有 RADAR_JOB_ID（runOp 起的，卡自己那件活）就用它：start、finish、fail 都记在它身上，不另开；
//            没有（定时、补跑、命令行）就自己建一件，ref cycle:<这次运行的 id>。
//   每一步   跑的那一步建一件子活（parent = 周期那件，kind = 步骤名，成员按 lib/crew.mjs STAGE_MEMBERS），跑完按结果收
//            （lib/tasks.mjs stageOutcome）。跳过的步不记（没做事）。指挥台「现在在跑什么」、成员卡的在做、告警的恢复都查这些。
//   pid      都记周期自己的 pid：周期被杀了，看门（jobs.watch）把还在 running 的判「进程意外退出」。
// 记账出错不影响这一轮：只打一行错误。
import * as J from './jobs.mjs';
import { STAGE_MEMBERS, isMember } from './crew.mjs';
import { stageLabel, stageOutcome } from './tasks.mjs';
import { identity } from './capabilities.mjs';
import { discoveryOutcome, DISCOVERY_STAGES } from './discovery-outcome.mjs';

// 这一步交给了本机 AI（stage_status needs_host_connector），可这台机器上没人接（App 里本机 AI 没开或跑不了）：按契约 2.2 记失败，
// 原因写清、大声报（负责人 10-04：「为什么还在卡在本地 AI？不是不用吗现在？」——不把这种步推给你）。这类步由线 H 从 App 的周期里拿掉；
// 还出现就是漏了。命令行装的（本机 AI 就是宿主）和演示不算。
export const UNMANNED = '没人接：这一步要本机 AI，App 里没有';
const unmanned = r => {
  if (r?.status !== 'needs_host_connector') return null;
  try { const I = identity(); if (!I.app || I.sandbox || I.local_ai.ready) return null; } catch { return null; } // 兜底：认不出这是不是 App 就不说「没人接」
  console.error(`[jobs] ${stageLabel(r.stage)}${UNMANNED}`);
  return `${stageLabel(r.stage)}${UNMANNED}`;
};

const safe = (what, fn) => { try { return fn(); } catch (e) { console.error(`[jobs] 周期记账出错（${what}）：${e.message}`); return null; } };
// 整轮记在谁名下：只跑某几位（--only，操作台「X 跑一轮」「找第一批岗位」）记第一位；整轮定时的是 System 的。
const memberOf = only => String(only || '').split(',').find(isMember) || 'patch';

export function openCycle({ runId, only = '', title = '定时周期', env = process.env, pid = process.pid, now = Date.now() } = {}) {
  return safe('开始', () => {
    let j = env.RADAR_JOB_ID ? J.get(env.RADAR_JOB_ID) : null;
    if (env.RADAR_JOB_ID && !j) console.error(`[jobs] RADAR_JOB_ID ${env.RADAR_JOB_ID} 在账上没有，另记一件`);
    if (!j) {
      j = J.create({ kind: 'cycle', member: memberOf(only), title, origin: env.RADAR_SLOT ? 'schedule' : 'system', ref: `cycle:${runId}`, now });
      if (!['queued', 'running'].includes(j.state)) j = J.create({ kind: 'cycle', member: memberOf(only), title, origin: 'system', now }); // 同一个运行 id 又跑一次
    }
    if (j.state === 'queued') j = J.transition(j.id, 'start', { pid, now });
    return j;
  });
}

// 周期整轮结束：找岗的一部分源失败而其它源读通，记部分完成，保留失败来源；其它步骤失败或没人接仍记失败。
// failed 给的是那几步的结果行（{ stage, status, error… }）时，每一步带上自己的原因（stageOutcome：「扫真人帖没跑全：LinkedIn 动态……」，
// 10-10 补跑那一轮因为 Radar 失败，要说清是哪一步、什么原因）；只给步骤名的老调用照旧只写哪几步。
export const unmannedStages = results => results.filter(r => r?.status === 'needs_host_connector').map(unmanned).filter(Boolean);
export function closeCycle(job, { failed = [], unmanned: none = [], results = [], summary = '跑完了', now = Date.now() } = {}) {
  if (!job) return null;
  return safe('收尾', () => {
    const cur = J.get(job.id);
    if (!cur || cur.state !== 'running') return cur;
    const named = failed.filter(f => typeof f === 'string'), rows = failed.filter(f => f && typeof f === 'object');
    const scan = discoveryOutcome(results);
    if (scan.status === 'partial' && !named.length && !none.length && rows.every(r => DISCOVERY_STAGES.has(r.stage)))
      return J.transition(job.id, 'finish', { result: { summary: scan.text, counts: { ...scan.counts, partial: true } }, now });
    const why = [named.length ? `${named.map(stageLabel).join('、')}没跑成` : '', ...rows.map(r => `${stageLabel(r.stage)}${stageOutcome(r).reason || '没跑成'}`), ...none].filter(Boolean);
    return why.length || scan.status === 'failed' ? J.transition(job.id, 'fail', { reason: why.join('；') || scan.text, now }) : J.transition(job.id, 'finish', { result: { summary: results.some(r => DISCOVERY_STAGES.has(r.stage)) ? scan.text : summary }, now });
  });
}
// 没开始就停了（资料挡住）：那件活判失败，原因照实写。
export function failCycle(job, reason, { now = Date.now() } = {}) {
  if (!job) return null;
  return safe('停下', () => (J.get(job.id)?.state === 'running' || J.get(job.id)?.state === 'queued' ? J.transition(job.id, 'fail', { reason, now }) : null));
}

export function openStage(cycle, stage, { runId, pid = process.pid, now = Date.now() } = {}) {
  if (!cycle) return null;
  return safe(stage, () => {
    const member = (STAGE_MEMBERS[stage] || [])[0] || 'patch';
    const j = J.create({ kind: stage, member, title: stageLabel(stage), origin: cycle.origin, parent: cycle.id, ref: `cycle:${runId}:${stage}:${cycle.id}`, now });
    return j.state === 'queued' ? J.transition(j.id, 'start', { pid, now }) : j;
  });
}
// r：周期 results 的那一行（{ stage, status, errors… }）。
export function closeStage(job, r, { now = Date.now() } = {}) {
  if (!job) return null;
  return safe(r?.stage || job.kind, () => {
    const o = stageOutcome(r), none = unmanned(r);
    if (none) return J.transition(job.id, 'fail', { reason: none, now });
    return o.state === 'failed' ? J.transition(job.id, 'fail', { reason: o.reason, now }) : J.transition(job.id, 'finish', { result: { summary: o.summary, ...(o.counts ? { counts: o.counts } : {}) }, now });
  });
}
