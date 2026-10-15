import { excludedCompany } from './discovery-policy.mjs';
import { previousContact } from './recipient-contact.mjs';
import { priority as leadPriority, outOfScopeNow } from './matcher.mjs';
import { hash } from './store.mjs';
import { draftFingerprint } from './drafts.mjs';
import { businessDays } from './inbox.mjs';
import { jobBrief } from './job-brief.mjs';
import { applyWord, autoSubmitOn, applyChannel, applyUrl, autoApplyReady, autoApplyExhausted, autoSubmittable, portalSession, loadPortalSessions, applyPolicy, AUTO_APPLY_MAX_ATTEMPTS, ownerApproved, applyBlockers } from './apply-channel.mjs';
import { titlePolicyReason } from './submission-policy.mjs';
import { blockedTasks } from './executor-heartbeat.mjs';
import { sprintAllows, sprintHoldReason } from './city-sprint.mjs';
import { TZ, zonedTime } from './tz.mjs';
import { leadApplyWords } from './apply-words.mjs';
import { cachedLines, cachedRead } from './state-cache.mjs';
import { scheduleStatus } from './schedule-status.mjs';
import { BRAND } from './brand.mjs';
import { leadState, passedLead, contactLead, decidedLead } from './lead-state.mjs';
import { heldRec, heldApplySuggestion, directionSet } from './recommend-gate.mjs';
// 结束了的线索在旅程上的那一格字（以前直接用阶段文字）。
const ENDED_WORD = { archived: '归档', rejected: '拒绝', offer: 'Offer' };

export const leadKey = l => l.record_id || l.id;
const LOCAL_FMT = new Intl.DateTimeFormat('zh-CN', {timeZone:TZ,month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const localTime = at => LOCAL_FMT.format(new Date(at));
const valid = at => at && Number.isFinite(Date.parse(at));
const iso = n => new Date(n).toISOString();
// lead.waiting_user：旧记录是一句话，执行器新写的是 {question|text|message, at, evidence}。
export const waitingText=w=>{
  if(w==null||w===false)return '';
  if(typeof w==='string')return w.trim();
  if(typeof w==='object'){for(const k of ['question','text','message','ask','detail','reason'])if(typeof w[k]==='string'&&w[k].trim())return w[k].trim();return '';}
  return String(w);
};
// Kinds that are a decision only the user can make. Each gets a native todo.
export const DECISION_KINDS = new Set(['send','submit','clarify','followup','review','reply']);
// 22:00 local time (lib/tz.mjs) today, or tomorrow once today's deadline has passed.
export function decisionDue(now=Date.now()){
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(now);
  const at=zonedTime(day,'22:00:00');
  return iso(at>now?at:at+86400000);
}
// 你在平台上自己回过（BOSS 聊天列表上最后一句变成你的，lib/boss-inbox.mjs 记 reply_answered_at）也算回过。
const answeredReply=(l,sent)=>!!l.replied_at&&((!!sent&&sent.status!=='failed'&&Date.parse(sent.at||sent.sent_at||'')>Date.parse(l.replied_at))||Date.parse(l.reply_answered_at||'')>Date.parse(l.replied_at));
// Only an unstarted draft gains visibility outside the sprint. Old delivery
// timestamps and verification flags still own the handover, even on a ready row.
const sendUnsettled=r=>['approved','queued','claimed','dispatched','sending','uncertain','needs_review','sent'].includes(r.status)||r.requires_verification||r.retry_disabled||r.dispatched_at||r.sending_at||r.sent_at||r.uncertain_at||r.external_id;
export function deriveJourney({leads=[],drafts=[],outbound=[],requests=[],overrides={},portalSessions=loadPortalSessions(),blockedApplications=blockedTasks(),now=Date.now()}={}) {
  now=Number(new Date(now));
  const cases=[], actions=[];
  for(const l of leads.filter(l=>!l.superseded && l.status!=='superseded' && l.match_status!=='superseded')) {
    const id=leadKey(l), sent=outbound.filter(o=>o.record_id===id).sort((a,b)=>String(b.at).localeCompare(String(a.at)))[0];
    const d=drafts.find(d=>d.record_id===id&&d.status==='ready'&&!previousContact(d,drafts)&&(!sent||['followup','reply'].includes(d.purpose)));
    const queued=requests.find(r=>r.record_id===id&&['queued','dispatched'].includes(r.status));
    const sprintReview=d?.draft_id&&!l.contact_hold&&!(l.followup_paused&&d.purpose==='followup')&&
      !['submitting','uncertain'].includes(l.auto_apply?.status)&&!sendUnsettled(d)&&
      !requests.some(r=>(r.record_id===id||r.draft_id===d.draft_id||(d.action_id&&r.action_id===d.action_id)||(d.request_id&&r.id===d.request_id)||(d.send_request_id&&r.id===d.send_request_id))&&sendUnsettled(r));
    const c={id,number:l.number,company:l.company,role:l.role,stage:'待核实',owner:'system',next:'核实岗位要求与行动入口',actions:[]};
    const channel=applyChannel(l),session=portalSession(l,portalSessions);
    const add=(kind,title,detail,{due_at=null,priority=50,version='',native_task=false,remind_minutes=0,...extra}={})=>{
      // Anything waiting on the user's decision also becomes a native Feishu todo
      // due 22:00 the same day, so it is visible outside the chat and completes
      // itself when the decision arrives (plans/20260915-command-room.md §5).
      if(DECISION_KINDS.has(kind)&&!due_at){due_at=decisionDue(now);native_task=true;}
      const action={id:hash([id,kind,version]).slice(0,32),record_id:id,number:l.number,company:l.company,role:l.applied_role||l.role,kind,title,detail,due_at,priority,native_task,remind_minutes,channel,...extra};
      const o=overrides[action.id]||{};
      action.snooze_until=o.snooze_until||null; action.paused=!!o.paused;
      if(o.completed_at||o.archived_at)return;
      // The brief is display material: refreshing a posting's text must not
      // invalidate a card the user is holding.
      const {brief:_brief,...versioned}=extra;
      action.version=hash([kind,title,detail,due_at,versioned,version]).slice(0,24);
      actions.push(action);c.actions.push(action.id);return action;
    };
    const st=leadState(l);
    if(passedLead(l)){c.stage='已排除';c.owner='none';c.next=l.note||'已按你的反馈排除';}
    else if(ENDED_WORD[st]){c.stage=ENDED_WORD[st];c.owner='none';c.next='已结束本轮推进';}
    // 排除的公司不再有新联系与投递；但招聘方约了面试或回了信，那是实质进展，照常提醒（taskQueue 也放行面试 / 回复类）。
    else if(!sent&&excludedCompany(l)&&!valid(l.interview_at)&&!/^interview_/.test(st)&&!l.replied_at){c.stage='已排除';c.owner='none';c.next='已按扫描设置排除这家公司，暂停新联系与投递';}
    else if(waitingText(l.waiting_user)){
      // 执行器现在把问题写成 {question, at, evidence}；老记录是纯文本。两种都只取问题正文，不能出现 [object Object]。
      // version 仍用原值：action id = hash(记录, 类型, version)，改了会让已归档 / 已暂缓的这一项重新冒出来。
      const question=waitingText(l.waiting_user);
      c.stage='需要补充信息';c.owner='user';c.next=question;
      add('clarify','补充一项信息',question,{priority:105,version:l.waiting_user,...(typeof l.waiting_user==='object'&&l.waiting_user?.evidence?{evidence:String(l.waiting_user.evidence)}:{})});
    }else if(valid(l.interview_at)){
      const at=Date.parse(l.interview_at), end=valid(l.interview_end)?Date.parse(l.interview_end):at+2*3600000;
      c.stage=l.interview_completed_at?'面试已完成':'面试已安排';c.owner='user';c.next=`${localTime(at)} · ${l.interview_round||'面试'}（北京时间）`;
      const dossier=l.interview_dossier;
      if(!l.interview_completed_at&&dossier?.status==='published'&&dossier.url&&dossier.verified_at){
        add('dossier','公司面试准备材料',`${localTime(at)} · ${l.applied_role||l.role}\n${dossier.summary||'公司产品与动态、岗位准备、项目证据、待确认项和历轮记录，集中保存在同一份飞书文档。'}\n按自己的安排并行准备，文档会随面试进展补充。`,{priority:92,version:dossier.document_id,url:dossier.url,content_version:dossier.content_hash,meeting_at:l.interview_at});
      }else if(!l.interview_completed_at&&now<at){
        c.next+='；系统正在整理有来源的公司准备文档';
      }
      if(!l.interview_completed_at){
        add('attend','参加面试',`${localTime(at)}（北京时间）\n面试官：${l.interviewer||'待确认'}\n${l.interview_join_url?'会议入口：'+l.interview_join_url:'请提前确认邀请中的会议链接或地址。'}\n面试结束后回复“${l.number} 面试完成”。`,{version:l.interview_at,due_at:l.interview_at,priority:95,native_task:true,remind_minutes:30,url:l.interview_join_url||null});
      }
      if((l.interview_completed_at||now>=end)&&!l.interview_review){
        c.next=l.interview_completed_at?'等结果；可补充本轮复盘':'记录面试结果与需要补强的问题';
        add('review','补充本轮面试记录','可直接在准备文档中记录问题、反馈和下一轮要求，也可回复“'+l.number+' 复盘 …”，我会补入同一份文档。',{version:l.interview_at,priority:90,url:dossier?.url});
      }
      if(l.interview_completed_at){c.owner='recruiter';c.next=l.interview_review?'等结果':'等结果；可补充本轮复盘';}
    }else if(/^interview_/.test(st)){
      c.stage='收到面试邀请';c.owner='user';c.next='选择面试时间';
      add('schedule','安排面试时间','收到邀请后选择方便的时间；预约完成请回复“'+l.number+' 面试 2026-09-14 19:00”，时间默认北京。',{priority:100,native_task:true,url:l.interview_scheduling_url||null});
    }else if((l.replied_at||st==='replied')&&!['followup','reply'].includes(d?.purpose)){
      c.stage='收到回复';
      // 对方回复之后你已经回过了（这条线索有一条比对方回复更新、没失败的外发）：不再问「你想怎么回」（09-29：#181 14:28 已回，信还挂着）。
      if(answeredReply(l,sent)){c.owner='recruiter';c.next='你已经回过对方了，等对方的下一步';}
      else{c.owner='system';c.next='阅读回复并准备下一步';
      add('reply','决定如何回复',l.reply_summary||'招聘方已回复，系统将整理需要你确认的内容。',{priority:85,native_task:false,...(l.reply_message?.source==='linkedin-browser'?{version:l.reply_message.action_message_id || l.reply_message.message_id}:{}),...(l.reply_url?{url:l.reply_url}:{})});}
    }else if(queued){c.stage='发送处理中';c.next='已记录发送确认，完成后会推送结果';}
    else if(!sent&&!sprintReview&&!sprintAllows(l)&&!ownerApproved(l)){
      // Hold new work outside the sprint, but keep an existing ready draft in
      // the normal review flow. A pending/unknown send is not another review;
      // showing a draft never approves it or changes the sending guards.
      c.stage='Backlog';c.hold=true;c.owner='none';c.next=sprintHoldReason(l);
    }else if(!sent&&titlePolicyReason(l)==='title_excluded_by_user_policy'){
      // The owner never applies to Senior / 资深 / 高级 / Lead / 架构师 titles (2026-09-15):
      // no letter to review and no submit card for them, whatever was prepared before the rule.
      c.stage='已排除';c.owner='none';c.next='标题超出你的职级规则（资深 / 高级 / Lead 等），不投递';
    }else if(d){
      const friendRequest=d.channel==='maimai_friend_request';
      const platformMessage=d.channel==='platform_dm'||friendRequest;
      c.stage='材料待确认';c.owner='user';c.next=friendRequest?'审核加好友附言（发送需本人协助）':platformMessage?'审核平台私信后确认发送':'审核邮件后确认发送';
      // The letter is shown with the brief of the job it is for, so the user is
      // not asked to approve a letter to a posting they cannot place.
      add('send',friendRequest?'审核加好友附言':platformMessage?'审核并发送平台私信':d.purpose==='followup'?'审核并发送跟进邮件':'审核并发送邮件',platformMessage?`平台：${d.platform||'招聘平台'}\n联系人入口：${d.to}${friendRequest?'\n对方通过好友申请后才能私聊；当前仅准备草稿，发送需本人协助。':''}`:`收件人：${d.to}\n主题：${d.subject}${d.purpose==='followup'?'\n回复已核实的原邮件线程，不重复首联。':''}`,{priority:80,brief:jobBrief(l).text,version:draftFingerprint(d),draft_id:d.draft_id,fingerprint:draftFingerprint(d),body:d.body,attachments:d.attachments,...(platformMessage?{channel:d.channel}:{})});
    }else if(sent){
      c.stage='已联系';c.owner='recruiter';c.next='等待招聘方回复，定时检查到新消息后通知';
      if(l.contact_hold||l.followup_paused){c.next=l.contact_hold?'按你的要求暂停联系，等待招聘方回复':'按你的要求不再提醒跟进，等待招聘方回复';}
      else if(valid(l.follow_up_at)&&Date.parse(l.follow_up_at)>Date.parse(sent.at)){c.owner='system';c.next='正在准备跟进内容，待你审核后发送';}
      else if(valid(sent.at)&&businessDays(sent.at,iso(now))>=5){
        c.owner='user';c.next='决定是否发一次跟进';
        add('followup','是否跟进一次',`已联系五个工作日以上，系统中没有新回复。确认后先准备跟进内容供你审核。`,{priority:40,version:sent.at});
      }
    }else if(l.auto_apply?.approved_at&&blockedApplications.has(String(l.number))){
      // An approved request can still be paused by the executor. Keep the
      // original approval, but do not advertise a retry that cannot run.
      // The executor's existing alert owns the handover; do not send a second card.
      c.stage='投递已暂停';c.owner='user';
      c.next='本机 AI 已暂停，尚无成功投递回执。请在原阻碍卡片处理后回复“好了”恢复；无需重新批准原投递。';
    }else if(l.auto_apply?.status==='waiting_user'&&l.auto_apply?.approved_at){
      // 投递停在只有你能做的一步（表上缺答案、验证码、登录）：信在收件箱里（lib/needs.mjs），这里不再出「投不投」。
      c.stage='需要补充信息';c.owner='user';c.next=`${applyWord()}停在一步只有你能做的事上，见收件箱`;
    }else if(['submitting','uncertain'].includes(l.auto_apply?.status)){
      // 提交已经发出、结果还没核对：不是新岗位，不能再问你「投不投」（autoApplyReady 对这两种是 false，会落到下面的筛选分支）。
      c.stage='投递中';c.owner='system';c.next=l.auto_apply.status==='uncertain'?'提交结果不确定，系统在核对，不会重复提交':'正在提交';
    }else if(heldRec(l)){
      // 放量先于填表能力：新推荐有了方向、实际放行以后，才生成系统投递建议。
      c.stage='推荐排队中';c.owner='system';c.next=!directionSet()?'求职方向选好以后再推荐':'按匹配度排队，名额到了再推荐';
    }else if(!heldApplySuggestion(l)&&autoApplyReady(l,portalSessions)&&!autoApplyExhausted(l)){
      // A public form with no account behind it. The user asked for these to be
      // submitted for them, with no letter to review first.
      const attempts=Number(l.auto_apply?.attempts||0);
      // Nothing is submitted until the user approves the batch: Reacher posts a
      // 拟投清单 and the user replies 投 …（the user's 2026-09-15 rule）。
      // An approval is only good for the plan it was given on: when the executor
      // recorded a different plan fingerprint (entry URL or resume changed), the
      // lead waits for the user again, and the card says so.
      // 恢复队列核验也会发现批准失效；已经明确等重新批准时，不因缺旧指纹漏掉确认入口。
      const stale=!!l.auto_apply?.approved_at&&l.auto_apply?.status==='awaiting_batch_review';
      const awaiting=stale||!!applyPolicy().require_batch_review&&!l.auto_apply?.approved_at;
      c.stage=`待${applyWord()}`;c.owner='system';// 自动提交关着（v0.1 默认）只预填、你来提交：这几句跟着开关说（09-30 #30）。
      const sub=autoSubmitOn(),verb=sub?'提交':'预填';
      c.next=awaiting?(stale?`你批准后申请入口或简历变了，需要再回一次「投 编号」才${verb}`:`已列入拟投清单，等你回「投 全部」或「投 编号」后才${verb}`):attempts?`上次${verb}没成功：${leadApplyWords(l.auto_apply).reason}，系统会再试一次`:(sub?'系统将按你的事实自动填写并提交这份官方申请表':'系统按你的资料预填这份官方申请表，停在提交前，你检查后自己提交');
      add('auto_apply',`${applyWord()}官方申请表`,`${l.company} · ${l.role}\n${applyUrl(l)}\n${attempts?`已尝试 ${attempts}/${AUTO_APPLY_MAX_ATTEMPTS} 次，上次原因：${leadApplyWords(l.auto_apply).reason}`:(channel==='portal'?`门户 ${session?.domain||''}`:(sub?'无需账号的官方表单，系统直接提交；提交结果会单独通知。':'无需账号的官方表单：系统预填，停在提交前，你检查后自己提交。'))}`,{owner:'system',priority:60,version:hash([l.matched_at||'',applyUrl(l),attempts,awaiting]).slice(0,16),url:applyUrl(l),attempts,awaiting_batch_review:awaiting});
    }else if(!heldApplySuggestion(l)&&autoApplyReady(l,portalSessions)&&autoApplyExhausted(l)){
      // Bounded retries. A form this system could not finish goes back to a person.
      c.stage='申请材料就绪';c.owner='user';c.next=`${applyWord()}多次未成功，请本人打开表单确认并提交`;
      add('submit',`${applyWord()}未成功，请本人提交`,`${l.company} · ${l.role}\n系统尝试 ${AUTO_APPLY_MAX_ATTEMPTS} 次仍未提交成功，最后一次原因：${leadApplyWords(l.auto_apply).reason}\n表单与材料已备好，请打开入口确认并提交。`,{priority:70,version:String(l.auto_apply?.at||''),url:applyUrl(l)});
    }else if(st==='outreach_ready'&&!l.email){
      c.stage='申请材料就绪';c.owner='user';c.next='打开申请入口，确认材料并提交；提交后把确认结果发来';
      add('submit',l.entry_type==='LinkedIn 私信'?'审核并发送平台私信':'确认申请材料并提交',l.contact_material?.content||c.next,{priority:70,url:l.application_url||l.url});
    }else if(contactLead(l)){
      c.stage='准备联系';c.next=l.email?'正在准备联系材料，准备好后请你确认':'正在核实原帖与申请入口，需要本人操作时会提醒';
    }else if(channel==='portal'&&['recommend','verify'].includes(l.match?.verdict)&&!l.legacy&&!l.prefilter_reason&&!outOfScopeNow(l)){
      // Workday / 飞书招聘 / 网易 / 腾讯 / SmartRecruiters all require a candidate
      // account. No card: these are listed in the daily job list for the user to
      // work through in their own session.
      c.stage='需本人门户投递';c.owner='user';
      // The blocker text promises a submission after login, so it is only for leads the owner already approved (投).
      c.next=(ownerApproved(l)&&applyBlockers(l,portalSessions)[0]?.text)||`需登录 ${session?.domain||'门户'}`;
    }else if(l.match?.verdict==='verify'&&!decidedLead(l)&&!l.legacy&&!outOfScopeNow(l)){
      c.stage='待你筛选';c.owner='user';c.next='选择联系或 pass，系统继续核实你想推进的岗位';
      add('screen','筛选待核岗位',l.match.biggest_gap||'部分岗位条件仍待核实',{priority:20,version:l.matched_at||'',url:l.url,location:l.location,ranking:leadPriority(l),content_version:hash([l.number,l.company,l.role,l.location,l.match.biggest_gap,l.url])});
    }else if(l.match?.verdict==='recommend'&&l.number){
      c.stage='待你选择';c.owner='user';c.next='决定是否争取这个机会';
      add('decide',l.application_packet?'申请材料已备好，是否推进':'是否争取这个机会',`${(l.match.reasons||[]).join('\n')}\n需要留意：${l.match.biggest_gap||'待核实'}${l.application_packet?'\n\n准备好的申请介绍：\n'+l.application_packet.body:''}`,{priority:30,version:l.matched_at||'',url:l.application_packet?.application_url||l.url,location:l.location});
    }else if(l.match?.verdict==='exclude'||l.prefilter_reason||outOfScopeNow(l)){
      c.stage='已排除';c.owner='none';c.next=l.match?.biggest_gap||l.prefilter_reason||'岗位超出目标范围';
    }
    cases.push(c);
  }
  actions.sort((a,b)=>b.priority-a.priority||String(a.due_at||'z').localeCompare(String(b.due_at||'z')));
  return {at:iso(now),cases,actions,counts:{user:actions.filter(a=>!a.paused&&a.owner!=='system').length,system:cases.filter(c=>c.owner==='system').length,recruiter:cases.filter(c=>c.owner==='recruiter').length,interviews:cases.filter(c=>c.stage==='面试已安排').length}};
}



const md=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const block=content=>({tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,padding:'12px',background_style:'grey-50',elements:[{tag:'markdown',content}]}]});

// 现在的进展（原在 lib/concierge.mjs，飞书指挥室 10-04 删掉后挪到这里）。
// 只读推导：用按文件签名缓存的解析结果（工作台进程里一次指挥台刷新要推导好几遍）。
export function currentJourney(now=Date.now()){
  return deriveJourney({leads:cachedLines('state/leads.ndjson'),drafts:cachedLines('state/drafts.ndjson'),outbound:cachedLines('state/outbound.ndjson'),requests:cachedLines('state/send-requests.ndjson'),overrides:cachedRead('state/action-overrides.json',{})||{},now});
}
export function actionSummary(j=currentJourney()){
  const active=j.actions.filter(a=>!a.paused&&a.owner!=='system'&&!(Date.parse(a.snooze_until||'')>Date.now()));
  const schedule=scheduleStatus();
  return [`${BRAND} · 全部进展`,active.length?'可以并行处理，自行选择：':'目前没有需要你处理的事项。',...active.map(a=>`${a.number} · ${a.company}：${a.title}${a.due_at?'（'+new Date(a.due_at).toLocaleString('zh-CN',{timeZone:TZ,hour12:false})+'）':''}${a.kind==='dossier'?'\n'+a.url:''}`),`后台处理 ${j.counts.system} 个；等待招聘方 ${j.counts.recruiter} 个。`,schedule.label+(schedule.next_at?'，下一次检查 '+new Date(schedule.next_at).toLocaleString('zh-CN',{timeZone:TZ,hour12:false}):''),'可一次回复多个编号的选择；“编号 进展”查看详情。'].join('\n');
}
