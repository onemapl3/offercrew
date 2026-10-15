#!/usr/bin/env node
// 一条线索是怎么走到投递这一步的（实测 10-04 第 13 条：#515 酒店前台类岗位挂在「要你登录 Workday」上）。只读，什么都不写：
//   node bin/why-lead.mjs 515
// 列出：判断（结论、第一条理由、什么时候判的、谁判的）、方向规则现在怎么说（lib/matcher.mjs prefilter）、批准从哪儿来（来源、时间、批次）、
// 在不在拟投清单里、线索上的状态记录（最近 12 条）。在主会话的终端里跑，输出只给主会话看。
import { lines, read } from '../lib/store.mjs';
import { prefilter, outOfScopeNow } from '../lib/matcher.mjs';
import { screening } from '../lib/screening.mjs';
import { stageText, leadState } from '../lib/lead-state.mjs';

const n = Number(process.argv[2]);
if (!Number.isInteger(n)) { console.error('用法：node bin/why-lead.mjs <编号>'); process.exit(2); }
const l = lines('state/leads.ndjson').find(x => Number(x.number) === n);
if (!l) { console.error(`没有 #${n}`); process.exit(1); }
const a = l.auto_apply || {}, m = l.match || {}, S = (() => { try { return screening(); } catch { return {}; } })(); // 兜底：只读的诊断：规则读不出就当空的
const proposal = read('state/apply-proposal.json', {});
let rule = null; try { rule = prefilter(l); } catch (e) { rule = `读不了：${e.message}`; }
const out = {
  lead: { number: l.number, company: l.company, role: l.role, location: l.location, stage: stageText(l), state: leadState(l), source: l.source_type || l.source || null, found_at: l.created_at || l.discovered_at || null },
  judge: { verdict: m.verdict || null, first_reason: (m.reasons || [])[0] || null, gap: m.biggest_gap || null, at: l.matched_at || m.at || null, by: m.model || m.backend || m.driver || l.judgement?.model || null, posting_family: l.judgement?.posting?.job_family || null, family_confident: l.judgement?.posting?.family_confident ?? null, prefilter_reason_then: l.prefilter_reason || null },
  rules_now: { prefilter: rule, out_of_scope_now: (() => { try { return outOfScopeNow(l); } catch { return null; } })(), profile: { general: !!S.general, allow: S.allow ? [...S.allow] : null, families: S.families || null } }, // 兜底：只读的诊断：算不出就是 null
  approval: { status: a.status || null, approved_at: a.approved_at || null, source: a.approval_source || null, by: a.approved_by || null, batch: a.approval_batch_id || null, message: a.approval_message_id || null, closed_reason: a.closed_reason || null },
  in_apply_proposal: (proposal.rows || []).some(r => Number(r.number) === n),
  history: (l.history || []).slice(-12),
};
console.log(JSON.stringify(out, null, 2));
