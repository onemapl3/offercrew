// 周期尾段的这一步归两位（lib/crew.mjs STAGE_MEMBERS）：
//   Owl   面试资料（lib/interview-dossier.mjs）：到了面试这一步、依据变了的线索，一条开一张 Watcher 的「面试资料」卡。
//   Lens  公司调研（lib/company-brief.mjs watchQueue：看指挥台的行——新线索 / 待批准里推荐或待核的公司、走到递出的线索），
//         一家开一张 Judge 的调研卡；「怎么准备」由 Judge 自己写（lib/role-prep.mjs）：放掉状态锁以后在时间预算里写，剩下的下一轮再写。
// 面试资料和调研都由引擎做（线 W，10-04；能力表 interview_prep、company_research 归引擎）：这一步只开卡，工作台里的引擎一张张做完
// （抓公开页面、用文字模型写，lib/task-do.mjs），卡和它的那件活在账上（lib/task-ledger.mjs）。不排宿主任务、不等本机 AI。
// 没有能用的文字模型（能力表给 null）：不开卡，数一下本来要开几张，记 no_model。
// 两位都暂停时周期整步跳过；只停一位（或「立即跑一轮」只跑另一位，RADAR_ONLY_MEMBER）就只做没停的那一段。
import {lock} from '../lib/lock.mjs';
import {lines,writeLines} from '../lib/store.mjs';
import {dossierWanted,openDossierCards} from '../lib/interview-dossier.mjs';
import {watchQueue,briefSettings,openResearchCards} from '../lib/company-brief.mjs';
import {writePreps} from '../lib/role-prep.mjs';
import {textReady} from '../lib/model.mjs';
import {whoDoes} from '../lib/capabilities.mjs';
import {loadTextProbe} from '../lib/text-probe.mjs';
import {budgetGate} from '../lib/spend.mjs';
import {commandCenter} from '../lib/command-center.mjs';
import {inboxView} from '../lib/ask-actions.mjs';
import {hqView} from '../lib/hq.mjs';
import {partSkipped} from '../lib/agents.mjs';
import { readCards } from '../lib/cards.mjs';
loadTextProbe(); // 能力表看得到文字模型配没配好（没配好就不开卡，记 no_model）
const leads=lines('state/leads.ndjson');
const owl=!partSkipped('owl'),lens=!partSkipped('lens');
const research_by=whoDoes('company_research'),dossier_by=whoDoes('interview_prep');
const jobs=lines('state/host-jobs.ndjson');
// 今天的花费上限到了（lib/spend.mjs）：不自动开新的调研、面试资料，不自动写「怎么准备」（名额当 0），已经结束的照常收掉；你点的不受影响。
const held=!!budgetGate('research');
// 面试资料：要写的线索（依据变了、还没开过卡的）。
let dossier={},wantDossier=[];
if(owl){try{wantDossier=dossierWanted(leads,readCards());dossier={wanted:wantDossier.length};}catch(e){dossier={error:String(e.message||e).slice(0,200)};}}
// 调研排队出错不挡面试资料：记下原因，这一步照常收尾。
let research={},want=[],toResearch=[];
if(lens){try{const center=commandCenter({}),rows=hqView({center,inbox:inboxView(center)}).rows;const {want:w,research:r,...q}=watchQueue({jobs,rows,leads,engine:!!research_by.worker,...(held?{settings:{...briefSettings(),per_cycle:0,prep_per_cycle:0}}:{})});want=w;toResearch=r;research={...q,...(held?{spend_held:true}:{})};}
catch(e){research={error:String(e.message||e).slice(0,200)};}}
writeLines('state/host-jobs.ndjson',jobs);
// 开卡（卡是追加写，不拿状态锁）：引擎在工作台里做。
if(toResearch.length){try{await openResearchCards(toResearch);}catch(e){research.error=String(e.message||e).slice(0,200);}}
if(owl&&wantDossier.length){
  if(held)dossier.spend_held=true;
  else if(!dossier_by.worker)dossier.no_model=wantDossier.length;
  else{try{const per=5,cards=await openDossierCards(wantDossier.slice(0,per));dossier.opened=cards.map(c=>c.leads?.[0]?.number??null);if(wantDossier.length>per)dossier.left=wantDossier.length-per;}catch(e){dossier.error=String(e.message||e).slice(0,200);}}
}
// 「怎么准备」：放掉状态锁以后一条条写（每条写好时才短暂拿一下锁），到了预算就停；没有能用的模型就不写，说一声。
if(want.length){const ready=textReady({role:'lens'});
  if(ready.ok){try{const r=await writePreps(want);research.role_prep={...research.role_prep,written:r.written,...(r.failed.length?{failed:r.failed}:{}),...(r.left?{left:r.left}:{})};}catch(e){research.role_prep={...research.role_prep,error:String(e.message||e).slice(0,200)};}}
  else research.role_prep={...research.role_prep,no_model:ready.note||'现在没有能用的模型'};}
const added=(research.company_briefs?.queued?.length||0)+(research.role_prep?.written?.length||0)+(dossier.opened?.length||0);
const skipped=[...(owl?[]:['owl']),...(lens?[]:['lens'])];
console.log(JSON.stringify({status:research.error||dossier.error?'degraded':added?'changed':'no_change',...research,...(owl?{interview_dossiers:dossier}:{}),...(skipped.length?{skipped_members:skipped}:{})}));
