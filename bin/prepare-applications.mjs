import { shelved } from '../lib/shelf.mjs';
import { directionSet } from '../lib/recommend-gate.mjs';
import {read,lines,writeLines,hash} from '../lib/store.mjs';
import {applyChannel,verdictReady} from '../lib/apply-channel.mjs';
import {leadClosure} from '../lib/runtime-recovery.mjs';
import {whoDoes} from '../lib/capabilities.mjs';
import {stopIfFactsBad} from '../lib/facts-gate.mjs';
import { contactLead, endedLead } from '../lib/lead-state.mjs';
stopIfFactsBad('prepare-applications'); // 资料文件读坏了、或者引导走完以后不见了：不排材料包（lib/facts-gate.mjs）
const leads=lines('state/leads.ndjson'),jobs=lines('state/host-jobs.ndjson'),outbound=lines('state/outbound.ndjson');
// An application letter is only worth writing for a route where a person reads
// it: email and real-recruiter posts, plus anything the user explicitly chose.
// Account-free ATS forms are submitted by bin/auto-apply.mjs with their own
// targeted letter, and account portals are submitted by the user in their own
// session, so neither needs a packet queued for review.
const wanted=l=>{
  if (!directionSet() || shelved(l)) return false;
  const channel=applyChannel(l);
  if(channel==='ats_form')return false;
  // The user's standing rules end the lead before any letter is written: an
  // over-band title (a "Senior Python Backend Engineer" lead got a packet and a
  // 「投」 button from 联系), an excluded company, a pass. A lead merged into a
  // thread already open with the same person gets no second first contact.
  if(leadClosure(l,'prepare_application_packet')||l.merged_into!=null)return false;
  if(contactLead(l))return true;
  return channel==='email'&&verdictReady(l);
};
const batch=Math.max(1,Number(read('config/pipeline.json',{}).application_preparation_batch||12));let created=0;
// App 的开关关着时（主会话 10-02 定的 4.4，lib/capabilities.mjs localAiReady）：投递材料包要本机 AI 核实入口、建草稿，这一轮不排，
// 记进 local_ai_skipped（周期一轮只记一行）。内置执行方式和内置邮箱接上以后再接回来。
// 能力表：投递只由引擎做（预填动作），旧版交给本机 AI 的材料包不再排，也不记「跳过」（不是没做，是换了做法）。
const off=whoDoes('prefill').worker!=='local_ai';
for(const l of leads.filter(l=>l.record_id&&l.number&&wanted(l)&&!l.superseded&&!endedLead(l)&&!outbound.some(o=>o.record_id===l.record_id))){
  const basis=hash([l.url,l.jd_text,l.match]),id=hash(['prepare_application_packet',l.record_id,basis]);
  if(l.application_packet?.basis===basis||jobs.some(j=>j.id===id))continue;
  if(created>=batch)break;
  created++;
  if(off)continue;
  jobs.push({id,kind:'prepare_application_packet',record_id:l.record_id,number:l.number,company:l.company,basis,channel:applyChannel(l),status:'pending',created_at:new Date().toISOString(),instructions:'不必等待用户先点有兴趣：核实仍开放的官方申请入口，基于候选人事实与该岗位完整JD准备有针对性的申请材料（岗位/地点、两点匹配证据、真实缺口、简历语言、简洁自我介绍/附信、已知筛选问题答案与未知项）。这条属于邮箱/真人招聘通道，材料要能直接作为邮件正文，收件人是真人 recruiter。保存 lead.application_packet（basis、body、resume、application_url、prepared_at、evidence），并按 reach/草稿流程建立 Gmail 草稿，独立回读后飞书展示全文供用户回「发 编号」。准备不等于投递；不得伪造用户兴趣或发送/提交回执。'});
}
writeLines('state/host-jobs.ndjson',jobs);
console.log(JSON.stringify({status:jobs.some(j=>j.kind==='prepare_application_packet'&&j.status==='pending')?'needs_host_connector':'no_change',next_actions:jobs.filter(j=>j.kind==='prepare_application_packet'&&['pending','working'].includes(j.status))}));
