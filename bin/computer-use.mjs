import { arg, lines } from '../lib/store.mjs';
import * as leads from '../lib/leads.mjs';
import { computerUseConfig, runComputerUse } from '../lib/computer-use.mjs';
import { applicationPlan, loadFacts } from '../lib/application-form.mjs';
import { applyUrl } from '../lib/apply-channel.mjs';
import { setApply, endedLead } from '../lib/lead-state.mjs';
import { noteSwallowed } from '../lib/swallow.mjs';
const id = arg('--record');
const lead = id ? lines('state/leads.ndjson').find(l => (l.record_id || l.id) === id) : null;
if (id && !lead) throw Error('lead_not_found');
if (lead && endedLead(lead)) throw Error('lead_closed');
const host = arg('--host', computerUseConfig().probe_host);
const url = lead ? applyUrl(lead) : arg('--url', host ? `https://${host}/` : null);
let plan; if (lead) { try { plan = applicationPlan(lead, loadFacts()); } catch (e) { noteSwallowed('computer-use.plan', e, { member: 'quill', doing: '算这个岗位的申请材料', then: '按没有材料往下走' }); } }
const result = await runComputerUse({ host: lead ? undefined : host, url, lead, plan });
if (lead && result.message !== 'disabled') {
  if (leads.get(id)) leads.update(id, current => {
    current.computer_use = { ...result, at: new Date().toISOString() };
    if (result.ok && !endedLead(current)) setApply(current, { ...current.auto_apply, status: 'prepared_for_user', evidence: result.evidence }, { source: 'computer-use' });
  });
}
console.log(JSON.stringify(result));
process.exitCode = result.ok || ['login_wall', 'captcha', 'needs_user'].includes(result.reached) || result.message === 'disabled' ? 0 : 1;
