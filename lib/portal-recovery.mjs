import { lines, read, write, writeLines } from './store.mjs';
import { markPortalLoggedIn, portalSession, applyUrl, autoApplyExhausted } from './apply-channel.mjs';
import { applicationPlan, loadFacts } from './application-form.mjs';
import { approvalFor, approvalOf, planFingerprint } from './submission-policy.mjs';
import { setApply, endedLead } from './lead-state.mjs';
import { continuePrefill } from './action-entry.mjs';
import { applyFreeze } from './apply-freeze.mjs';
import { familyOf } from './accounts.mjs';
import { noteSwallowed } from './swallow.mjs';
import { readCards } from './cards.mjs';
import { controlled } from './task-control.mjs';

// 登录恢复了、原批准经复核还有效的那几条：放掉状态锁以后接着做那几条预填动作（lib/action-entry.mjs continuePrefill：
// 压着的放开，没有动作的按原批准再排一条），不另起预填脚本、不经即时执行器（契约 2.5）。kick(rids)：测试传假的。
export async function recoverPortalSession(host, { now = Date.now(), planFor = l => applicationPlan(l, loadFacts()), by = 'user_dashboard', probe = null, kick = (rids, o) => continuePrefill(rids, { origin: 'system', ...o }) } = {}) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]+$/.test(host)) throw Error('无效站点');
  const at = new Date(now).toISOString();
  let out;
  {
    const session = markPortalLoggedIn(host, { now: new Date(now), by, probe }), leads = lines('state/leads.ndjson');
    // 同一账号家族（阿里集团各招聘站这类统一登录）一起恢复；按租户分开的账号（Workday 等）只认这一个站点。
    const fam = familyOf(host), covers = h => !!h && (h === host || (!!fam?.shared_login && familyOf(h)?.key === fam.key));
    const jobs = lines('state/host-jobs.ndjson'), hb = read('state/executor-heartbeat.json', { tasks: {} });
    const cards = readCards().filter(c => !c.superseded && c.kind === 'apply');
    let reset = 0, review = 0, manual = 0;
    const resumed = [];
    for (const l of leads) {
      const a = l.auto_apply;
      if (!a || !['needs_login', 'paused', 'awaiting_batch_review', 'failed'].includes(a.status) || endedLead(l)) continue;
      const owners = cards.filter(c => c.leads?.some(r => r.rid === (l.record_id || l.id)));
      if (owners.length && owners.every(controlled)) continue; // 共用账号登录成功不撤销另一项任务的取消/暂缓。
      const domain = portalSession(l)?.domain;
      let exact; try { exact = new URL(applyUrl(l)).hostname; } catch { continue; }
      if (!covers(exact) && !covers(domain)) continue; // No sibling-tenant promotion.
      let plan; try { plan = planFor(l); } catch (e) { noteSwallowed('portal-recovery.plan', e, { member: 'quill', doing: '算这个岗位的申请材料', then: '按没有材料处理' }); }
      const approvals = [approvalOf(l)];
      const valid = plan && approvalFor(plan, approvals);
      setApply(l, { ...a, needs_login_cleared_at: at });
      if (portalSession(l)?.never_auto || autoApplyExhausted(l)) {
        manual++; continue; // Login does not erase the failed-attempt ceiling.
      }
      if (valid) {
        const { error: _was, ...kept } = l.auto_apply;
        setApply(l, { ...kept, status: 'approved' }, { at, source: 'portal-recovery' }); reset++; resumed.push(l.record_id || l.id);
      } else {
        setApply(l, { ...l.auto_apply, status: 'awaiting_batch_review', ...(plan ? { plan_fingerprint: planFingerprint(plan) } : {}) }, { at, source: 'portal-recovery' }); review++;
      }
      for (const j of jobs) if ((j.record_id === (l.record_id || l.id) || j.number === l.number) && /apply|application/.test(j.kind || '') && ['waiting_user', 'blocked'].includes(j.status) && (/^portal_login:/.test(j.resume_condition || '') || ['needs_login', 'register_by_owner'].includes(j.blocked_reason) || /登录|login|paused/i.test([j.result, j.details].join(' ')))) {
        if (valid && j.kind === 'queue_auto_apply') Object.assign(j, { status: 'pending', resumed_at: at, waiting_user: null, blocked_reason: null, result: '登录已恢复，原批准经复核仍有效，排队等待提交' });
        else { j.status = 'completed'; j.completed_at = at; j.result = valid ? '登录已恢复，原批准经材料指纹复核，等待执行' : '登录已恢复，当前材料仍需用户重新确认'; }
      }
      delete hb.tasks?.[`auto-apply:${l.number}`];
    }
    writeLines('state/leads.ndjson', leads); writeLines('state/host-jobs.ndjson', jobs); write('state/executor-heartbeat.json', hb);
    out = { resumed, session, reset, review, manual, receipt: `已记录 ${fam?.shared_login ? fam.label : host} 登录恢复；${reset} 条恢复排队，${review} 条需重新审核材料${manual ? `，${manual} 条仍需本人处理` : ''}${applyFreeze() ? '（投递冻结中）' : ''}` };
  }
  const { resumed, ...rest } = out;
  if (resumed.length && !applyFreeze()) await kick(resumed, { now });
  return rest;
}
