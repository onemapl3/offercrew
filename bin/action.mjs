import { recordOwnerSubmission } from '../lib/manual-submission.mjs';
import {arg,read,write,lines,writeLines,hash,root} from '../lib/store.mjs';
import {currentJourney,actionSummary} from '../lib/journey.mjs';
import {leadKey,localTime} from '../lib/journey.mjs';
import {BRAND} from '../lib/brand.mjs';
import {execFileSync} from '../lib/spawn.mjs';
import { applyEvent, setApply, stateLabel, archivedLead, appliedLead } from '../lib/lead-state.mjs';
import { deriveJourney } from '../lib/journey.mjs';
import { applyUrl, applyChannel } from '../lib/apply-channel.mjs';
import { TZ, zonedTime, utcOffset, daysLaterAt } from '../lib/tz.mjs';
import { loadAccount } from '../lib/mail/vault.mjs';
import { requestReply } from '../lib/mail/draft.mjs';
import { markForRevise } from '../lib/draft-revise.mjs';
import { whoDoes } from '../lib/capabilities.mjs';
import { crewName } from '../lib/crew.mjs';
import { cancelPausedDraft } from '../lib/draft-edit.mjs';
import { draftFingerprint } from '../lib/drafts.mjs';
const input=arg('--input','').trim(),source=arg('--source','codex'),messageId=arg('--message-id')||hash([source,input]);
if(!['codex','feishu_im','dashboard'].includes(source))throw Error('untrusted_action_source');
const done=read('state/action-inputs.json',{});
// 工作台（App，source dashboard）里说的「N 准备 / N 面试 … / N 复盘 …」：面试资料由引擎写、存在 App 里（lib/interview-dossier.mjs，
// 线 W 10-04），这里只记下线索上的变化，输出 dossier（线索 id），工作台照它开一张 Watcher 的卡。不排 prepare_interview /
// interview_review 宿主任务——那是命令行版（飞书文档）的路，10-04 冻结，只在飞书来的话（feishu_im）里照旧走。
const inApp=source==='dashboard';let dossierFor=null;
const reply=(receipt,data={})=>{console.log(JSON.stringify({status:'processed',receipt,...data}));};
// 「这条不推进」（pass N 原因）的回执：说清楚不推进了、原因记没记（09-30 #25：以前回的是通用的「反馈已记录。需要准备的内容会继续处理……」）。
const passReceipt=ds=>{const tag=d=>`${d.number!=null?`#${d.number} `:''}${d.company||''}`.trim();
  if(ds.length===1){const d=ds[0];return `${tag(d)} 这条不推进了。${d.reason?`原因记下了：${d.reason}。`:'没记原因。'}`;}
  const why=ds.filter(d=>d.reason);return `${ds.map(tag).join('、')} 这 ${ds.length} 条不推进了。${why.length?`原因记下了：${why.map(d=>`${d.number!=null?`#${d.number}`:tag(d)} ${d.reason}`).join('；')}。`:'没记原因。'}`;};
if(done[messageId]){reply(done[messageId].receipt,{duplicate:true});process.exit(0);}
const j=currentJourney(),leads=lines('state/leads.ndjson');let receipt='';
const m=input.match(/^(\d+)\s*(进展|准备好了|这步好了|卡住了|查看准备|准备|面试完成|复盘|offer|面试|明天提醒|后天提醒|晚点提醒|暂停提醒|恢复提醒|修改|不发|改|归档|结束|重新打开)\s*([\s\S]*)$/i);
const jobs=lines('state/host-jobs.ndjson');
const enqueue=(kind,l,details)=>{
  const id=hash([messageId,kind,leadKey(l)]);if(!jobs.some(x=>x.id===id))jobs.push({id,kind,record_id:leadKey(l),number:l.number,company:l.company,details,source,message_id:messageId,created_at:new Date().toISOString(),status:'pending'});
  writeLines('state/host-jobs.ndjson',jobs);
};
if(/^(我的待办|待办|进展|目前进展|今日进展|招聘进展|状态|有什么要做|帮助)$/.test(input))receipt=actionSummary(j);
else if(m){
  // 被合并掉的旧行（superseded）不再按编号认；「重新打开」要能找到已归档的线索。
  const l=leads.find(l=>l.number===Number(m[1])&&!l.superseded&&(m[2]==='重新打开'||!archivedLead(l)));if(!l)throw Error('岗位编号不存在，请回复“我的待办”查看');
  const action=m[2],detail=m[3].trim(),at=new Date().toISOString();
  if(action==='进展'){const c=j.cases.find(c=>c.id===leadKey(l));receipt=`${l.number} · ${l.company}\n当前：${c.stage}\n下一步：${c.next}\n处理人：${{user:'你',system:BRAND,recruiter:'招聘方',none:'已结束'}[c.owner]}`;}
  if(['准备','查看准备'].includes(action)&&inApp){dossierFor=leadKey(l);receipt=`${l.number} · ${l.company} 的面试资料在岗位页「公司」那一栏；${crewName('owl')} 照最新的情况整理。`;}
  else if(['准备','查看准备'].includes(action)){
    if(l.interview_dossier?.status==='published'&&l.interview_dossier.verified_at)receipt=`${l.company} · 面试准备文档\n${l.interview_dossier.url}\n公司产品、动态、面经证据、岗位准备和历轮记录都在这里，可并行准备。`;
    else{enqueue('prepare_interview',l,'检索公司产品、近期动态、真实面经，整理成面试准备文档');receipt='已安排整理有来源的公司面试准备文档，完成后发固定链接。';}
  }
  if(action==='准备好了'){if(!l.interview_at)throw Error('请先提供该岗位的面试时间');l.prep_reviewed_at=at;receipt=`${l.company} 已记为准备完成。面试前仍会提醒你。`;}
  if(action==='这步好了'&&!l.interview_at){
    // 收件箱的「我已提交 / 我已在页面上提交了」（终审信、预填信、本人提交信）：还没到面试这一步时，这句话是说你已经
    // 在页面上亲自提交了。记一条人工投递回执、线索记为已投递：信不再出现，系统也不会再提交第二次（priorSubmission 认回执）。
    receipt=recordOwnerSubmission(l,{source});
  }
  else if(action==='这步好了'){
    receipt='已改为自主安排的文档准备，不再逐步打卡。'+(l.interview_dossier?.url?'\n'+l.interview_dossier.url:'文档整理好后会发固定链接。');
  }
  // 准备面试时卡住的点（L 线第 1b 批，本机AI依赖清单 #9）：以前排一条 interview_material_question，可没有谁处理这种任务。
  // 现在记在线索上（interview_stuck，最多 10 条，同一句不记两次），算进面试资料的输入（lib/interview-dossier.mjs：下次整理时补上），
  // Judge 写「怎么准备」时也照顾到（lib/company-brief.mjs prepInput）。
  if(action==='卡住了'){
    if(detail){const t=detail.slice(0,200);l.interview_stuck=[...(l.interview_stuck||[]).filter(x=>x.text!==t),{text:t,at,source}].slice(-10);receipt=`记下了：「${t.slice(0,40)}」。整理面试资料时会补进去，写「怎么准备」时也会照顾到。`;if(inApp&&l.interview_at)dossierFor=leadKey(l);}
    else receipt='把具体想补充的主题发来即可，我会补到准备文档里。';
  }
  if(action==='面试完成'){if(!l.interview_at)throw Error('请先提供该岗位的面试时间');const early=Date.parse(l.interview_at)>Date.now();l.interview_completed_at=at;applyEvent(l,'interview_completed',{},{at,source});receipt=(early?'记录时间尚未到，已按你的确认记为完成。':'')+`${l.company} 面试已完成。方便时回复“${l.number} 复盘 …”，我会整理下一步与待补强项。`;}
  if(action.toLowerCase()==='offer'){l.offer_at=l.offer_at||at;applyEvent(l,'offer',{},{at,source});receipt=`${l.company} 已记录 Offer，本轮推进已结案。`;}
  if(action==='复盘'){if(!detail)throw Error('请在复盘后写下问题、表现和下一步');l.interview_review=detail;l.interview_review_at=at;if(inApp){dossierFor=leadKey(l);receipt=`复盘记下了，${crewName('owl')} 照它整理下一轮准备和跟进建议。`;}else{enqueue('interview_review',l,detail);receipt='复盘已保存，我会整理下一轮准备与跟进建议。';}}
  if(action==='面试'){
    const t=detail.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::00)?(?:\s*(Z|[+-]\d{2}:\d{2}))?$/);
    if(!t)throw Error(`请回复“${l.number} 面试 YYYY-MM-DD HH:mm”，默认北京时间。`);
    const value=t[1]+'T'+t[2]+':00'+(t[3]||utcOffset(zonedTime(t[1],t[2]+':00')));
    if(!Number.isFinite(Date.parse(value))||new Date(t[1]+'T00:00:00Z').toISOString().slice(0,10)!==t[1]||Date.parse(value)<=Date.now())throw Error('面试时间需为有效的未来时间');
    if(l.interview_at!==value){if(l.interview_at)l.interview_history=[...(l.interview_history||[]),{round:l.interview_round||'面试',at:l.interview_at,completed_at:l.interview_completed_at||null,review:l.interview_review||null}];l.prep_step=0;delete l.prep_reviewed_at;delete l.interview_completed_at;delete l.interview_review;delete l.interview_review_at;delete l.interview_end;}
    l.interview_at=value;l.interview_timezone=TZ;l.interview_round=l.interview_round||'技术面试';l.interview_time_source={source,message_id:messageId,raw:input,at};applyEvent(l,'interview_scheduled',{},{at,source});
    if(inApp){dossierFor=leadKey(l);receipt=`已记录 ${l.company}：${localTime(value)}（北京时间）。${crewName('owl')} 照新的时间整理面试资料。`;}
    else{enqueue('prepare_interview',l,'面试时间已确认：'+value);receipt=`已记录 ${l.company}：${localTime(value)}（北京时间）。我会准备材料，并安排面试前提醒。`;}
  }
  // 归档 N [原因]：这条线索到此结束（面试完了、不想跟了、已经有结果）。状态置「已归档」，
  // 它所有待办都算完成，以后不再出现，也不再提醒；线索本身保留可查。
  // 重新打开 N：归档 / pass / 拒绝之后再拿回来。状态回到新线索，
  // 归档时压下去的待办（action-overrides 里的 archived_at / completed_at）一并撤掉，它的待办重新出现。
  if(action==='重新打开'){
    const r=applyEvent(l,'reopen',{note:detail},{at,source});
    if(!r.ok)receipt=`${l.number} · ${l.company} 现在是「${stateLabel(r.from)}」，不用重新打开。`;
    else{
      for(const k of ['archived_at','archived_by','archive_reason'])delete l[k];
      const os=read('state/action-overrides.json',{});let freed=0;
      for(const a of deriveJourney({leads:[l],drafts:lines('state/drafts.ndjson'),outbound:lines('state/outbound.ndjson'),requests:lines('state/send-requests.ndjson'),overrides:{}}).actions){const o=os[a.id];if(o&&(o.archived_at||o.completed_at)){delete os[a.id];freed++;}}
      if(freed)write('state/action-overrides.json',os);
      receipt=`${l.number} · ${l.company} 已重新打开（${stateLabel(r.from)} → 新线索），它的待办会重新出现。`;
    }
  }
  if(['归档','结束'].includes(action)){
    const os=read('state/action-overrides.json',{});
    for(const a of j.actions.filter(a=>a.record_id===leadKey(l)))os[a.id]={...(os[a.id]||{}),completed_at:at,archived_at:at,archived_by:source,paused:true};
    write('state/action-overrides.json',os);
    l.archived_at=at;l.archived_by=source;if(detail)l.archive_reason=detail;applyEvent(l,'archive',{note:detail},{at,source});
    receipt=`${l.number} · ${l.company} 已归档${detail?'（'+detail+'）':''}。它的待办和提醒都结束了；线索保留，看板「归档」里能找到。`;
  }
  if(['明天提醒','后天提醒','晚点提醒','暂停提醒','恢复提醒'].includes(action)){
    // 行上没有当前提醒（旧跟进请求没有落成草稿）也要记住“不跟”。
    // 只暂停跟进提醒，不挡对方新回复与面试；恢复提醒仍是原来的入口。
    if(action==='暂停提醒'||action==='恢复提醒'){
      l.followup_paused=action==='暂停提醒';
      l.followup_preference={paused:l.followup_paused,at,source,message_id:messageId};
    }
    const os=read('state/action-overrides.json',{});
    for(const a of j.actions.filter(a=>a.record_id===leadKey(l)&&a.kind!=='attend')){
      const o=os[a.id]||{};
      if(action==='暂停提醒')o.paused=true;
      else if(action==='恢复提醒'){o.paused=false;o.snooze_until=null;}
      else{
        let target=Date.now()+(action==='晚点提醒'?2*3600000:86400000);
        if(action==='明天提醒'){const day=new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(target);target=zonedTime(day,'09:00:00');}
        // 后天提醒（收件箱「过两天再说」）：就是后天 09:00，你明确说了过两天，不按当天 22:00 的待办期限提前。
        if(action==='后天提醒')target=daysLaterAt(2,'09:00:00');
        else if(a.due_at)target=Math.min(target,Date.parse(a.due_at));
        o.snooze_until=new Date(Math.max(Date.now()+60000,target)).toISOString();o.paused=false;
      }os[a.id]=o;
    }
    write('state/action-overrides.json',os);receipt=action==='后天提醒'?`#${l.number} ${l.company} 后天 9:00 再提醒你。`:`#${l.number} ${l.company} 已${action==='暂停提醒'?'暂停普通提醒':action==='恢复提醒'?'恢复提醒':'调整提醒时间'}。已安排的面试到期提醒仍保留。`;
  }
  if(action==='不发'){
    // Dropping a letter is a decision, not an error. The draft stops being a
    // send candidate, and the old displayed version can no longer be authorized.
    const drafts=lines('state/drafts.ndjson'),candidates=drafts.filter(d=>d.record_id===leadKey(l)&&['ready','editing','paused'].includes(d.status));
    if(candidates.length>1)throw Error(candidates.some(d=>d.status==='paused')?'这个岗位有多份草稿；如要取消暂停的旧稿，请在岗位「材料」里打开那份暂停稿，选择「取消旧稿」。':'这个岗位有多份待确认草稿，无法按编号确定要取消哪一份；请先逐份核对。旧稿均未改变。');
    const d=candidates[0];
    if(!d)receipt=`${l.company} 目前没有待确认的草稿，不需要取消。`;
    else if(d.status==='paused')receipt=cancelPausedDraft({draft_id:d.draft_id,record_id:leadKey(l),fingerprint:draftFingerprint(d),source}).message;
    else{d.status='cancelled';d.cancelled_at=at;delete d.displayed_hash;writeLines('state/drafts.ndjson',drafts);receipt=`${l.company} 这封不发了，草稿已作废。需要重写回复“${l.number} 联系”。`;}
  }
  if(['改','修改'].includes(action)){
    // The card's 改 button cannot carry text, so an empty 改 asks for it in the
    // thread rather than failing.
    if(!detail){done[messageId]={receipt:`收到。请在这张卡片的话题里回复“改成……”，说明要改哪部分，我改好后重新发全文给你确认。`,at};write('state/action-inputs.json',done);reply(done[messageId].receipt);process.exit(0);}
    const drafts=lines('state/drafts.ndjson'),d=drafts.find(d=>d.record_id===leadKey(l)&&d.status==='ready');
    // 能力表 revise_draft 归引擎（Writer 加文字模型，lib/draft-revise.mjs）：邮件、私信、脉脉附言都由它按你的话改，不交给本机 AI。
    // 工作台收到回执后马上在后台改（lib/command-center.mjs startRevise）；没有能用的模型就照实说改不了，旧的一版不动。
    const who=whoDoes('revise_draft');
    if(!d)receipt=`${l.company} 现在没有等你看的草稿，没什么可改的。`;
    else if(!who.worker)receipt=`改不了：${who.reason}。旧的那一版没动。`;
    else if(markForRevise(d,detail)){writeLines('state/drafts.ndjson',drafts);receipt=`修改要求已收到，旧版发送确认已失效。${crewName('tailor')} 改好后把整份重新给你看。`;}
    else receipt='这一份现在改不了（不是等你看的草稿）。';
  }
  writeLines('state/leads.ndjson',leads);
}else{
  const r=JSON.parse(execFileSync(process.execPath,['bin/apply-feedback.mjs','--input',input,'--source',source,'--message-id',messageId],{cwd:root,encoding:'utf8',timeout:180000}));
  // 「N 备注 …」写在等你回复的那条线索上、接了内置邮箱：Writer 按你的话起草（或改）回复（lib/mail/draft.mjs requestReply）。
  const note=input.match(/^(\d+)\s*备注\s+([\s\S]+)$/),noteLead=note&&loadAccount()?leads.find(l=>l.number===Number(note[1])&&!l.superseded&&!archivedLead(l)):null;
  let mailReceipt=null;
  if(noteLead){const drafts=lines('state/drafts.ndjson'),events=lines('state/inbox-events.ndjson');mailReceipt=requestReply(noteLead,note[2].trim(),{drafts,events});if(mailReceipt){writeLines('state/drafts.ndjson',drafts);writeLines('state/inbox-events.ndjson',events);}}
  if(r.uncertain?.length){
    // --record-id / --number：收件箱里就某条线索写的话，任务挂到那条线索上（收件箱据此把那一问收起来，等它办完）。
    const rid=arg('--record-id')||null,num=arg('--number')!=null&&/^\d+$/.test(arg('--number'))?Number(arg('--number')):null,about=rid?leads.find(l=>(l.record_id||l.id)===rid):null;
    const id=hash([source,messageId]);if(!jobs.some(x=>x.id===id)){jobs.push({id,kind:'user_request',details:input,source,message_id:messageId,...(rid?{record_id:rid,number:num??about?.number??null,company:about?.company||null}:{}),created_at:new Date().toISOString(),status:'pending'});writeLines('state/host-jobs.ndjson',jobs);}
    receipt='已收到这条说明，我会结合岗位记录处理。已有待办可回复“我的待办”查看。';
  }else if(r.decided?.length&&r.decided.every(d=>d.action==='pass'))receipt=passReceipt(r.decided);
  else if(mailReceipt)receipt=mailReceipt;
  else receipt=r.status==='queued'?'发送确认已记录，正在安排发送。尚未发送；完成后会把结果发来。':r.status==='already_recorded'?'这条确认已处理过，不会重复发送。':'反馈已记录。需要准备的内容会继续处理，完成后通知你。';
}
done[messageId]={receipt,at:new Date().toISOString()};write('state/action-inputs.json',done);reply(receipt,dossierFor?{dossier:dossierFor}:{});
