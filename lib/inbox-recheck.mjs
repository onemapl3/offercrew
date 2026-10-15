// 收件箱里旧记录的重新判断（实测 10-04，U2）。工作台启动时跑一次，之后在循环里隔一会儿跑一次（bin/serve.mjs）；
// 读请求（GET /api/inbox）不进这里，这里写的东西只在这里写。每一项都能重复跑：处理过的不再是要处理的样子。
//   numberWaiting     等你批准的投递还没有编号：补上编号再进收件箱（lib/hq.mjs deskInbox 不放没编号的）。
//   recheckApprovals  「材料变了」（awaiting_batch_review）的批准按现在的算法重新核对：其实没变的（10-02 改了批准认法留下的误报）
//                     放回「已批准」接着预填（批准超过一天的照规矩摆成「批准很久了」等你再确认）；真变了的，记下是哪一样变了。
//   recheckOldFailures 升级前失败的投递重新判断：
//     · 一键投递的门户（lib/one-click-apply.mjs，阿里招聘这类：岗位页点一下就投出去，没有表）上「没找到提交按钮」这类旧失败
//       （实测第 11 条 #444）：改成新版的交接——记「等你」，信上给「打开申请页」「我已经投了」「这条不推进」（lib/needs.mjs）；
//     · 按你现在的方向规则根本不在方向里的岗位（实测第 13 条 #515：酒店前台类岗位挂在「要你登录 Workday」上）：批准收起来
//       （状态 closed，原因 out_of_direction，批准的记录留着），不再挡路；要投照样能再「投」。
import { lines, writeLines } from './store.mjs';
import { numberVisibleLead } from './lead-numbering.mjs';
import { event } from './events.mjs';
import { applicationPlan, loadFacts, planProblem } from './application-form.mjs';
import { approvalFor, approvalOf } from './submission-policy.mjs';
import { approvalChange, changeSig, changeWords } from './approval-change.mjs';
import { setApply, endedLead } from './lead-state.mjs';
import { applyFreeze } from './apply-freeze.mjs';
import { familyOf, loadAccounts } from './accounts.mjs';
import { applyUrl } from './apply-channel.mjs';
import { prefilter } from './matcher.mjs';
import { read, write } from './store.mjs';

const leadKey = l => l.record_id || l.id;

// center：指挥台的数据（lib/command-center.mjs commandCenter）。拟投清单里没有编号的那几条，按「最大编号 + 1」依次补上。
export async function numberWaiting(center = {}, { now = Date.now() } = {}) {
  const want = new Set(Object.values(center.roles || {}).flatMap(r => r.queue || []).filter(q => q.kind === 'apply_proposal' && q.lead?.number == null && q.lead?.record_id).map(q => q.lead.record_id));
  if (!want.size) return { numbered: [] };
  const rows = lines('state/leads.ndjson'), at = new Date(now).toISOString(), numbered = [];
  for (const l of rows) if (want.has(leadKey(l)) && numberVisibleLead(l, rows, { at })) numbered.push(l.number);
  if (numbered.length) { writeLines('state/leads.ndjson', rows); event('system', 'inbox', 'ok', `等你批准的投递补上了编号：${numbered.map(n => '#' + n).join('、')}`); }
  return { numbered };
}

const ended = l => l.superseded || endedLead(l);
// planFor / kick：测试传假的。kick 和登录恢复同一条路（lib/action-entry.mjs continuePrefill）：放开或补一条预填动作，
// 批准超过 24 小时的在那里被摆成「批准很久了」（lib/actions.mjs holdStale），不自动做。
export async function recheckApprovals({ now = Date.now(), planFor = null, kick = null } = {}) {
  const at = new Date(now).toISOString(), back = [], noted = [];
  let facts = null;
  const plan = l => { if (planFor) return planFor(l); facts ||= loadFacts(); return applicationPlan(l, facts); };
  const rows = lines('state/leads.ndjson');
  for (const l of rows) {
    const a = l.auto_apply;
    if (a?.status !== 'awaiting_batch_review' || !a.approved_at || ended(l)) continue;
    let p = null, problem = null;
    try { p = plan(l); } catch (e) { problem = planProblem(e.message); }
    if (p && approvalFor(p, [approvalOf(l)])) {
      const { approval_stale, error, ...rest } = a;
      setApply(l, { ...rest, status: 'approved', approval_rechecked_at: at, approval_rechecked_from: approval_stale || null }, { at, source: 'inbox-recheck', note: 'recheck' });
      back.push(l);
      continue;
    }
    const changes = problem ? [{ what: 'plan', text: problem }] : approvalChange(l, p), sig = changeSig(changes);
    if (a.approval_stale?.changed_sig === sig) continue;
    setApply(l, { ...a, approval_stale: { ...(a.approval_stale || {}), changed: changes, changed_sig: sig, checked_at: at } });
    noted.push(l);
  }
  if (back.length || noted.length) writeLines('state/leads.ndjson', rows);
  if (back.length) event('system', 'inbox', 'ok', `${back.map(l => '#' + (l.number ?? '—')).join('、')} 的投递批准核对过了，材料其实没变，接着按原批准做`);
  for (const l of noted) event('system', 'inbox', 'waiting_user', `#${l.number ?? '—'} 批准以后：${changeWords(l.auto_apply.approval_stale.changed)}`, { lead_id: l.record_id || l.id });
  const rids = back.map(l => l.record_id || l.id);
  if (rids.length && !applyFreeze()) {
    try { const go = kick || ((r, o) => import('./action-entry.mjs').then(m => m.continuePrefill(r, { origin: 'system', ...o }))); await go(rids, { now }); } catch (e) { event('system', 'inbox', 'fail', `核对过的批准没接上预填：${String(e.message || e).slice(0, 120)}`); }
  }
  return { back: back.map(l => l.number ?? null), noted: noted.map(l => l.number ?? null) };
}

// 一键投递的门户：账号家族上写了 one_click_apply、地址是岗位页（pages）的那几条。
export function oneClickOf(l, cfg = loadAccounts()) {
  const url = applyUrl(l) || l.url || '', fam = familyOf(url, cfg), spec = fam?.one_click_apply;
  if (!spec?.button || (spec.pages && !String(url).includes(spec.pages))) return null;
  return { portal: spec.name || String(fam.label).replace(/（.*）$/, ''), button: spec.button, family: fam.key, url };
}
// 方向规则（lib/matcher.mjs prefilter）现在说这个岗位类别不在你的方向里的那几种原因。级别、地点、公司这些另有收法（lib/runtime-recovery.mjs）。
// 只认说得确定的几种（和 STALE_PREFILTER_REASONS 一致）：「标题里没有工程类的词」（non_target_role）不算——「大模型研究平台方向」这种标题也会落进去。
export const OFF_DIRECTION = new Set(['non_software_role', 'outside_target_specialty', 'excluded_role']);
const OPEN = new Set(['approved', 'queued', 'pending', 'needs_login', 'awaiting_batch_review', 'failed', 'paused', 'waiting_user']);
export async function recheckOldFailures({ now = Date.now(), cfg = null, judge = prefilter } = {}) {
  const at = new Date(now).toISOString(), handed = [], closed = [];
  const accounts = cfg || loadAccounts();
  const rows = lines('state/leads.ndjson');
  for (const l of rows) {
    const a = l.auto_apply;
    if (!a || !OPEN.has(a.status) || ended(l)) continue;
    let why = null; try { why = judge(l); } catch {} // 兜底：规则读不了这一条（缺字段）就当没说不在方向里，不收批准
    if (OFF_DIRECTION.has(why)) {
      setApply(l, { ...a, status: 'closed', closed_reason: 'out_of_direction', closed_rule: why, closed_at: at, previous_status: a.status }, { at, source: 'inbox-recheck', note: 'out_of_direction' });
      closed.push(l); continue;
    }
    if (a.status !== 'failed') continue;
    const one = oneClickOf(l, accounts);
    if (!one) continue;
    const { stop: _stop, ...kept } = a;
    setApply(l, { ...kept, status: 'waiting_user', error: `one_click_portal:${one.family}`, one_click: { portal: one.portal, button: one.button }, url: a.url || one.url, previous_error: a.error || null, rechecked_at: at }, { at, source: 'inbox-recheck', note: 'one_click_portal' });
    handed.push(l);
  }
  if (handed.length || closed.length) {
    writeLines('state/leads.ndjson', rows);
    // 执行器心跳上同一条的「失败」也收掉，不再在别处说「预填没成」。
    const hb = read('state/executor-heartbeat.json', { tasks: {} });
    let hbChanged = false;
    for (const l of [...handed, ...closed]) if (hb.tasks?.[`auto-apply:${l.number}`]) { delete hb.tasks[`auto-apply:${l.number}`]; hbChanged = true; }
    if (hbChanged) write('state/executor-heartbeat.json', hb);
  }
  if (handed.length) event('system', 'inbox', 'waiting_user', `${handed.map(l => '#' + (l.number ?? '—')).join('、')} 是一键投递的门户，改成交给你在岗位页上自己投`);
  for (const l of closed) event('system', 'inbox', 'ok', `#${l.number ?? '—'} ${l.company || ''} · ${l.role || ''}：按你现在的方向规则不在方向里，投递的批准收起来了，没有提交`, { lead_id: l.record_id || l.id });
  return { handed: handed.map(l => l.number ?? null), closed: closed.map(l => l.number ?? null) };
}
