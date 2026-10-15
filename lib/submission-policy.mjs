import {hash,read,lines} from './store.mjs';
import {canonicalUrl} from './dedupe.mjs';
import {screening,levelText} from './screening.mjs';
import { postingClosed } from './lead-state.mjs';

export const loadSubmissionPolicy=()=>read('config/concierge.json',{}).auto_apply_policy||{};
// Where an approval may come from. `base` is the 用户反馈 column of the Feishu
// Base set to 「投」(bin/pull-feedback.mjs); the others are the room, the
// dashboard and the scheduled Codex run acting on a room reply.
export const APPROVAL_SOURCES=['codex','feishu_im','dashboard','base'];
// Titles above the band the user targets. The list in config/concierge.json
// wins; this is the fallback when that file has no list at all.
export const DEFAULT_EXCLUDE_TITLES=['senior','sr\\.','staff','lead','principal','architect','资深','高级','专家','负责人','架构师','总监','经理'];
// 没写清单时按候选人的级别给（lib/screening.mjs）：不到 5 年就是上面这一串（作者本人这一档，和以前一样）；
// 5–8 年只挡管理和高管；8 年以上只挡高管。做产品的人，「产品经理」是岗位名，不算级别。
const TITLES_BY_LEVEL={early:DEFAULT_EXCLUDE_TITLES,senior:['manager','director','\\bvp\\b','head of','总监','经理','首席'],staff:['director','\\bvp\\b','head of','总监','首席']};
// 通用路径（金融、市场……）：这些行业的级别词。「Staff Accountant」是会计的入门岗，staff 不挡；银行的 VP 是资深档。
const GENERAL_TITLES_BY_LEVEL={early:['\\bsenior\\b','\\bsr\\.','\\blead\\b(?!\\s*gen)','\\bprincipal\\b','vice president','\\bvp\\b','\\bdirector\\b','head of','\\bpartner\\b(?!\\s*(?:marketing|success|operations|relations|ships?))','\\bmanager\\b','资深','高级','专家','主管','负责人','总监','经理'],senior:['\\bdirector\\b','head of','\\bpartner\\b(?!\\s*(?:marketing|success|operations|relations|ships?))','\\bchief\\b','总监','首席','合伙人'],staff:['managing director','head of','\\bpartner\\b(?!\\s*(?:marketing|success|operations|relations|ships?))','\\bchief\\b','首席','合伙人']};
export const defaultExcludeTitles=(S=screening())=>(S.general?GENERAL_TITLES_BY_LEVEL:TITLES_BY_LEVEL)[S.level];
// The one place a title is tested against the user's grade policy. Both
// `titlePolicyReason` (machine reason) and apply-channel's `titleExcluded`
// (sentence for a card) wrap this, so they can never disagree.
export function titlePolicyHit(lead={},policy=loadSubmissionPolicy()){
 const raw=String(lead.applied_role||lead.role||'');
 if(!raw)return null;
 const own=policy.exclude_title_patterns,S=own?null:screening(),title=own?raw:levelText(raw,S);
 for(const pattern of own||defaultExcludeTitles(S)){
  try{if(new RegExp(pattern,'i').test(title))return {pattern};}
  catch{return {pattern,invalid:true};}
 }
 return null;
}
export const loadSubmissionApprovals=()=>lines('state/leads.ndjson').filter(l=>l.auto_apply?.approved_at).map(approvalOf);
export const approvalOf=l=>({record_id:l.record_id||l.id,status:'approved',plan_fingerprint:l.auto_apply?.approved_plan_fingerprint,approval_key:l.auto_apply?.approval_key||null,source:l.auto_apply?.approval_source,message_id:l.auto_apply?.approval_message_id,batch_id:l.auto_apply?.approval_batch_id});
// What the user approved: this posting, this entry URL, this resume file and
// the factual answers. The cover letter is not part of it — the user never
// reviews letters for automatic submissions (2026-09-15 policy), and its text
// changes whenever candidate/facts.yaml changes, which used to silently turn an
// approved lead back into `awaiting_batch_review`.
export const planFingerprint=plan=>{
 const {cover_letter,cover_letter_words,...fields}=plan.fields||{};
 return hash({record_id:plan.record_id,url:plan.url,fields:{...fields,previously_applied:'resolved_from_current_application_history'},resume_sha256:plan.resume_sha256});
};
// What a 「投 N」 binds to since 2026-09-23: this posting, this entry URL and
// this résumé file. The owner's own fact updates (a refreshed résumé PDF under
// the same name, a new salary expectation in candidate/facts.yaml) are the
// material he wants used, not a reason to ask again: exactly that churn used to
// turn every pending approval stale while nothing about the posting had
// changed. planFingerprint stays the evidence of what was sent.
// Since 2026-10-02 the résumé part is the routing slot for the posting's
// language (plan.resume.slot, lib/application-form.mjs), not the file name: the
// version picked for a job is exported under its own name just before the
// form is filled, and a 「投」 given while the plan still showed the routing
// file must not go stale over that. Content changes are caught by the final
// review fingerprint. Keys written by file name before then still match.
const legacyKey=plan=>hash({record_id:plan.record_id,url:canonicalUrl(plan.url)||plan.url||null,resume:String(plan.fields?.resume_path||'').split('/').pop()||null});
export const approvalKey=plan=>plan.resume?.slot?hash({record_id:plan.record_id,url:canonicalUrl(plan.url)||plan.url||null,resume_slot:plan.resume.slot}):legacyKey(plan);
// Every key a 「投」 for this posting, this entry URL and this résumé slot could
// have been written with (10-04 实测第 10 条, U2). Since 10-02 the plan uploads
// the picked version's own export, so plan.fields.resume_path is no longer the
// routing file a pre-10-02 key was written with: those approvals went stale
// with nothing changed. The routing file the slot points at now
// (plan.resume_routed) is what they named, so it counts too; so does the URL
// as stored when canonicalUrl gave nothing. A different URL, a different slot
// or a different routing file still does not match.
const base=f=>String(f||'').split('/').pop()||null;
export function approvalKeys(plan,{url=plan.url,slot=plan.resume?.slot}={}){
 const urls=[...new Set([canonicalUrl(url)||url||null,url||null])];
 const files=[...new Set([base(plan.fields?.resume_path),...(plan.resume_routed?[base(plan.resume_routed)]:[])])];
 return urls.flatMap(u=>[...(slot?[hash({record_id:plan.record_id,url:u,resume_slot:slot})]:[]),...files.map(f=>hash({record_id:plan.record_id,url:u,resume:f}))]);
}
export function titlePolicyReason(lead,policy=loadSubmissionPolicy()){
 const hit=titlePolicyHit(lead,policy);
 return hit?hit.invalid?'invalid_title_policy':'title_excluded_by_user_policy':null;
}
const trustedApproval=a=>a.status==='approved'&&APPROVAL_SOURCES.includes(a.source)&&a.message_id&&a.batch_id;
// 用户确实批准过这条申请（不同于只有状态/时间的旧系统建议）。继续或重新确认不再要求先选求职方向；
// 是否仍可按旧材料执行，另外由 approvalFor / 当前预览指纹核验。
export const hasApplicationApproval = l => !!l?.auto_apply?.approved_at && !['closed', 'withdrawn'].includes(l.auto_apply.status) &&
 !!trustedApproval(approvalOf(l)) && !!(l.auto_apply.approval_key || l.auto_apply.approved_plan_fingerprint);
// An approval with an approval_key matches on the key; older approvals (before
// 2026-09-23) only carry the full fingerprint and match exactly or not at all.
const matches=(a,plan)=>a.approval_key?approvalKeys(plan).includes(a.approval_key):a.plan_fingerprint===planFingerprint(plan);
export function approvalFor(plan,approvals=loadSubmissionApprovals()){
 return approvals.find(a=>a.record_id===plan.record_id&&trustedApproval(a)&&matches(a,plan))||null;
}
// An approval for this record whose plan has since changed (entry URL, resume
// file or a factual answer). It is not a licence to submit, but it is not the
// same as never having been approved either: the user should be asked again,
// and told why, instead of the lead quietly dropping back into the queue.
export function staleApprovalFor(plan,approvals=loadSubmissionApprovals()){
 return approvals.find(a=>a.record_id===plan.record_id&&trustedApproval(a)&&(a.approval_key||a.plan_fingerprint)&&!matches(a,plan))||null;
}
export function submissionPolicyReason(lead,plan,policy=loadSubmissionPolicy(),approvals=loadSubmissionApprovals()){
 if(postingClosed(lead))return 'posting_closed';
 const title=titlePolicyReason(lead,policy);if(title)return title;
 if(policy.require_batch_review&&!approvalFor(plan,approvals))return staleApprovalFor(plan,approvals)?'approval_stale':'batch_review_required';
 return null;
}
const targetUrl=u=>canonicalUrl(u)?.replace(/\/application\/?$/,'')||null;
export function priorSubmission(lead,url,outbound,leads){
 const target=targetUrl(url);
 return outbound.filter(o=>o.status!=='corrected').find(o=>o.record_id===(lead.record_id||lead.id)||target&&[
  o.url,o.application_url,
  ...leads.filter(l=>(l.record_id||l.id)===o.record_id).flatMap(l=>[l.url,l.application_url,l.application_packet?.application_url])
 ].filter(Boolean).some(u=>targetUrl(u)===target))||null;
}
