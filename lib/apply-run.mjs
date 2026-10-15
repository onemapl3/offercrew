// 执行已批准的投递（预填；自动提交打开时提交）：每一条三段：读一份快照 → 开浏览器填表（每次浏览器调用最长 4 分钟）→ 把这一条这期间改了的字段
// 合回库里现在那一行（lib/leads.mjs merge，一行一个事务；你这期间在页面上做的改动不被盖掉）。
// only：只做这几条（lib/workers.mjs 从 actions 领走的，record_id）；不给就按原来的规则挑出全部已批准的（周期里那一步）。
// 中途要写一下（比如点提交前记「提交中」）：当场合回去（动作表里这件已经是 claimed，
// 进程没了由 lib/actions.mjs reconcile 记成不确定，不会当成没提交再提交一次）。
import { chromeApplyDriver } from './chrome-apply.mjs';
import { playwrightApplyDriver } from './playwright-apply.mjs';
import { noteSwallowed } from './swallow.mjs';
import { lines, read, write, writeLines, today, optionalText } from './store.mjs';
import { merge as mergeLeadRow } from './leads.mjs';
import { deriveJourney, leadKey } from './journey.mjs';
import { ownerApproved, autoApplyReady, autoApplyExhausted, applyUrl } from './apply-channel.mjs';
import { runAutoApply, pickApplyDriver } from './auto-apply.mjs';
import { applyWords } from './apply-words.mjs';
import { loadFacts } from './application-form.mjs';
import { beat, clearTask, blockedTasks } from './executor-heartbeat.mjs';
import { applyFreeze } from './apply-freeze.mjs';
import { dryApplyDriver, dryApplyWanted } from './apply-dry.mjs';
import { factsBlocker } from './facts-gate.mjs';
import YAML from 'yaml';

function pendingOf(leads, only) {
  const journey = deriveJourney({ leads, drafts: lines('state/drafts.ndjson'), outbound: lines('state/outbound.ndjson'), requests: lines('state/send-requests.ndjson'), overrides: read('state/action-overrides.json', {}) });
  // 先审后投：还在等你「投」的不提交；已经报过卡住的，等你说解决了再试。
  const proposed = journey.actions.filter((a) => a.kind === 'auto_apply');
  // 批准就是队列，哪怕看板上这条在别处；runAutoApply 提交前还会拿批准对一遍现在的计划。
  for (const l of leads)
    if (ownerApproved(l) && (['approved', 'queued', 'pending', 'failed', undefined].includes(l.auto_apply?.status) || (l.auto_apply?.status === 'awaiting_batch_review' && l.auto_apply?.approval_key)) && autoApplyReady(l) && !autoApplyExhausted(l) && !proposed.some((a) => a.record_id === leadKey(l)))
      proposed.push({ kind: 'auto_apply', record_id: leadKey(l), number: l.number, company: l.company, url: applyUrl(l), awaiting_batch_review: false, source: 'approval' });
  const blocked = blockedTasks();
  return { proposed, pending: proposed.filter((a) => !a.awaiting_batch_review && !blocked.has(String(a.number)) && (!only || only.includes(a.record_id))) };
}
const recordSessions = (found = []) => {
  if (!found.length) return;
  const sessions = read('config/portal-sessions.json', { domains: {} });
  for (const f of found) if (f.domain) sessions.domains[f.domain] = { ...(sessions.domains[f.domain] || {}), logged_in: false, verified_at: new Date().toISOString().slice(0, 10), last_probe: f.reason };
  write('config/portal-sessions.json', sessions);
};
const RESULT_KEYS = ['submitted', 'failed', 'needs_login', 'awaiting_review', 'skipped', 'uncertain', 'awaiting_final', 'needs_info', 'prepared'];

export async function applyApproved({ only = null, dryRun = false, space = null } = {}) {
  const b = factsBlocker();
  if (b) return { status: 'no_change', reason: `facts_${b.state}`, detail: b.text, submitted: 0, failed: 0 };
  const freeze = applyFreeze();
  if (freeze) return { status: 'no_change', skipped: 'apply_freeze', reason: freeze.reason, submitted: 0, failed: 0 };
  if (process.env.RADAR_EXTERNAL_POLICY === 'base-and-cards') return { status: 'no_change', skipped: 'external_policy', submitted: 0, failed: 0 };
  let picked;
  picked = pendingOf(lines('state/leads.ndjson'), only);
  const { proposed, pending } = picked;
  const limit = Number(read('config/pipeline.json', {}).auto_apply_batch || 6);
  const result = Object.fromEntries(RESULT_KEYS.map(k => [k, []]));
  if (dryRun) return { status: 'no_change', pending: pending.length, planned: pending.map((a) => ({ number: a.number, company: a.company, url: a.url })) };
  for (const a of pending) beat({ executor: 'auto-apply', task: a.number, step: 'submitting', detail: `${a.company} · ${a.url || ''}` });
  // 浏览器脚本驱动（lib/chrome-apply.mjs）：专用 Chrome；RADAR_APPLY=dry（演示）不开浏览器。
  const which = dryApplyWanted() ? 'dry' : pickApplyDriver({ mode: read('config/pipeline.json', {}).auto_apply_driver });
  const active = which === 'dry' ? dryApplyDriver({ leads: lines('state/leads.ndjson'), companies: YAML.parse(optionalText('config/companies.yaml') || '[]') || [] }) : which === 'chrome' ? chromeApplyDriver({ space }) : playwrightApplyDriver();
  try {
    for (const a of pending.slice(0, limit)) {
      // 1. 快照。
      const leads = lines('state/leads.ndjson'), outbound = lines('state/outbound.ndjson');
      const lead = leads.find((l) => leadKey(l) === a.record_id);
      if (!lead) continue;
      const before = structuredClone(lead), outIds = new Set(outbound.map((o) => o.id));
      let flushed = structuredClone(before);
      // 合回去：只把这条线索上从上一次合回去（第一次是开头那份）到现在改了的字段，合进库里现在那一行（lib/leads.mjs merge，
      // 一行一个事务）。这一轮跑着的时候你在页面上点的「不推进」、加的备注留着：历史两边都留，状态两边都改了以你的为准。回执只追加。
      const flush = () => {
        mergeLeadRow(a.record_id, flushed, lead);
        const freshOut = lines('state/outbound.ndjson'), have = new Set(freshOut.map((o) => o.id));
        const added = outbound.filter((o) => !outIds.has(o.id) && !have.has(o.id));
        if (added.length) writeLines('state/outbound.ndjson', [...freshOut, ...added]);
        flushed = structuredClone(lead);
        return true;
      };
      // 2. 开浏览器填表（中途的 save 当场合回去）。
      const r = await runAutoApply({ leads, outbound, actions: [a], facts: loadFacts(), driver: active, limit: 1, date: today(), save: () => { try { flush(); } catch (e) { noteSwallowed('apply-run.flush', e, { member: 'quill', doing: '把填到一半的进度先存下', then: '填完以后再存一次' }); } }, saveEvidence: (p, data) => write(p, data) });
      for (const k of RESULT_KEYS) result[k].push(...(r[k] || []));
      // 3. 合回去。
      flush();
      recordSessions(r.needs_login || []);
    }
  } finally { await active.close?.(); }
  for (const s of result.submitted) clearTask({ executor: 'auto-apply', task: s.number });
  for (const n of result.needs_login) if (n.number) beat({ executor: 'auto-apply', task: n.number, step: 'login', detail: n.reason || n.domain || '', status: 'waiting_user' });
  for (const f of result.failed) {
    const step = /验证码|captcha|verification/i.test(String(f.error)) ? 'verification_code' : /实名|identity/i.test(String(f.error)) ? 'identity' : /上限|limit|quota|too many/i.test(String(f.error)) ? 'quota' : 'failed';
    // 给人看的那一句（lib/apply-words.mjs）；原始的码在线索的 auto_apply.error / stop 里。
    beat({ executor: 'auto-apply', task: f.number, step, detail: applyWords(f.error).line.slice(0, 160), status: step === 'failed' ? 'failed' : 'waiting_user' });
  }
  for (const a of pending) if (![...result.submitted, ...result.needs_login, ...result.failed].some((x) => x.number === a.number)) clearTask({ executor: 'auto-apply', task: a.number });
  return {
    status: result.failed.length ? 'degraded' : result.submitted.length ? 'changed' : 'no_change', driver: which, pending: pending.length, awaiting_review: proposed.length - pending.length,
    submitted: result.submitted.length, failed: result.failed.length, needs_login: result.needs_login.length, awaiting_final_review: result.awaiting_final.length, prepared_for_user: result.prepared.length, details: result,
  };
}
