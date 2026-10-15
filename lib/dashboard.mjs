import { eventMatches, eventInScope, eventGroups } from './event-search.mjs';
import { canonicalCompany, jobTitle } from './lead-fields.mjs';
import { eventReason, sourceName, sourceEventStatus } from './event-reasons.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { leadState, endedLead, archivedLead, stageText, feedbackText } from './lead-state.mjs';
import {currentJourney} from './journey.mjs';
import {scheduleStatus} from './schedule-status.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file, lines, read, hash, root } from './store.mjs';
import { parseFeedback } from './feedback.mjs';
import { bindSend, draftFingerprint } from './drafts.mjs';
import { currentMailbox } from './facts.mjs';
import { event, tailEvents, scanEvents } from './events.mjs';
import { leadCity, relocationCity } from './city.mjs';
import { sprintHold, citySprint } from './city-sprint.mjs';
import { cachedLines } from './state-cache.mjs';
import { possibleDuplicates } from './dedupe.mjs';
import { policyReviewNotice } from './judge-review.mjs';
import { PREFILTER_WORD } from './prefilter-words.mjs';
import { companyDetail, prepDetail, prepRecordView } from './company-brief.mjs';
import { dossierDetail } from './interview-dossier.mjs';
import { interviewMaterialsForLead } from './interview-materials.mjs';
import { TZ, dayOf } from './tz.mjs';
import { memberOfEvent, crewList, OWNER, faceOf, LEGACY } from './crew.mjs';
import { redact } from './error-evidence.mjs';
import { errorReason } from './say-error.mjs';
import { eventWords, dedupeEvents } from './event-words.mjs';
// 运行日志按成员筛、按成员显示：每条事件带上它是谁的（lib/crew.mjs；存量里的老 actor 不改写，读的时候换）。
// text：这一句的中文说法（lib/event-words.mjs），运行日志页显示它；msg 原文留着给搜索和排查。
// 运行日志页（#stream）：同一步记了两条的只留一条（lib/event-words.mjs dedupeEvents，QA 第 2 轮 #24）。
const reasonCache = new Map();
function evidenceReasons(e) {
  if (!['fail', 'skip', 'ok'].includes(e.status)) return { why: [], sources: [], otherFailure: false };
  const why = [], sources = []; let otherFailure = false;
  const visit = (x, depth = 0) => {
    if (!x || depth > 5 || why.length >= 30) return;
    if (typeof x !== 'object') return;
    if (Array.isArray(x.sources)) { sources.push(...x.sources); if (x.error) otherFailure = true; }
    for (const [k, v] of Object.entries(x)) {
      if (['error', 'reason', 'cause', 'message'].includes(k) && typeof v === 'string' && v.trim()) why.push([sourceName(x.source), eventWords(errorReason(eventReason(redact(v))), 180)].filter(Boolean).join('：'));
      else if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  for (const r of (e.refs || []).slice(0, 6)) {
    if (!/^runs\/[\w./-]+$/.test(r.file || '') || r.file.includes('..')) continue;
    let target = r.file;
    try { if (fs.statSync(file(target)).isDirectory()) target += '/sources.json'; } catch { continue; } // 兜底：历史证据可能已清理，保留原事件，不猜失败原因。
    if (!target.endsWith('.json')) continue;
    try {
      const st = fs.statSync(file(target)); if (st.size > 500000) continue;
      const sig = `${target}:${st.mtimeMs}:${st.size}`;
      if (reasonCache.has(sig)) { const hit = reasonCache.get(sig); why.push(...hit.why); sources.push(...hit.sources); otherFailure ||= hit.otherFailure; }
      else { const start = why.length, sourceStart = sources.length; visit(read(target, {})); if (reasonCache.size > 100) reasonCache.clear(); reasonCache.set(sig, { why: why.slice(start), sources: sources.slice(sourceStart), otherFailure }); }
    } catch { /* 兜底：摘要读取失败不影响原始证据入口；没有可读原因时不猜。 */ }
  }
  return { why: [...new Set(why)].filter(Boolean).slice(0, 4), sources, otherFailure };
}
const withMember = e => {
  const evidence = evidenceReasons(e), materialFailed = ['cover_letter', 'self_intro'].includes(e.step) && e.status === 'waiting_user' && /核对没过/.test(e.msg || '');
  const status = materialFailed ? 'fail' : sourceEventStatus(evidence.sources, e.status, evidence.otherFailure);
  const text = status === 'skip' && evidence.sources.length ? '已停用的来源，这次跳过' : status !== e.status && status === 'ok' ? '来源读取完成，停用的来源已跳过' : eventWords(e.msg, 200, { ...e, status }), causes = evidence.why.filter(r => !text.includes(r));
  return { ...e, status, member: memberOfEvent(e), text: [text, ...causes].filter(Boolean).join('；') || null };
};
// 页面上成员的名字、脸、小组都读这一张（改名只改名册）：{ scout: { name, label, face, group }, …, you: { … } }。
// 老编号（radar / watch / reacher / system …）→ 成员：页面上老会话、老收件箱项的发件人也按名册显示名字。
const crewLegacy = () => Object.fromEntries(Object.entries(LEGACY).filter(([, v]) => v.member).map(([k, v]) => [k, v.member]));
const crewTable = () => ({ ...Object.fromEntries(crewList().map(m => [m.key, { name: m.name, label: m.label, face: m.face, group: m.group_label }])), you: { name: OWNER.name, label: '你的反馈', face: faceOf('you') } });
import { loadEvaluation } from './evaluate.mjs';
import { quotaView, ledgerSince } from './usage.mjs';
// Codex 订阅额度：Patch 的账里最近一次从会话记录读到的本周已用百分比（lib/usage.mjs），读不到就照实说。
const codexQuota = () => { try { const q = quotaView(ledgerSince(Date.now() - 8 * 86400000)).codex; return q ? `已用 ${Math.round(q.used_percent)}%` : '还没读到'; } catch { return '还没读到'; } };
export const stages = ['发现','已筛选','材料就绪','已投递·已联系','已回复','面试中','Offer·拒绝·归档'];
const dateKey = x => dayOf(x);
const key = l => l.record_id || l.id;
// 事件日志的尾部在 lib/events.mjs（System 的健康账、看门也读它，不经视图）。
export { tailEvents };
export function boardStage(l, drafts, outbound) {
  const state = leadState(l);
  if (['offer', 'rejected', 'archived', 'passed', 'pass_pending'].includes(state)) return stages[6];
  if (['interview_scheduled', 'interview_done'].includes(state)) return stages[5];
  if (state === 'replied') return stages[4];
  if (['contacted', 'applied'].includes(state)) return stages[3];
  if (['outreach_ready', 'sending', 'apply_review', 'apply_paused', 'apply_queued', 'applying', 'apply_needs_user'].includes(state) || drafts.some(d => d.record_id === key(l) && d.status === 'ready')) return stages[2];
  if (state === 'contacting' || l.match?.verdict === 'recommend') return stages[1];
  return stages[0];
}

export function historyRuns(limit = 100) {
  const out=[];
  // 新装的系统还没有 runs/：没有运行记录，不是错误（原来整页报「文件不存在」）。
  if(!fs.existsSync(file('runs')))return out;
  for (const dir of fs.readdirSync(file('runs'),{withFileTypes:true}).filter(d=>d.isDirectory()&&/^\d{8}$/.test(d.name))) {
    for (const name of fs.readdirSync(file(`runs/${dir.name}`)).filter(n=>/^cycle-\d+\.json$/.test(n))) {
      const ref=`runs/${dir.name}/${name}`, r=read(ref,{});
      out.push({ts:new Date(Number(name.match(/\d+/)[0])).toISOString(),run_id:name.slice(0,-5),actor:'heartbeat',step:'cycle',status:r.status==='degraded'?'fail':r.status==='no_change'?'skip':r.status==='needs_host_connector'?'waiting_user':'ok',msg:`历史运行 · ${r.mode || 'light'} · ${r.status}`,refs:[{file:ref}],historical:true});
    }
  }
  return out.sort((a,b)=>a.ts.localeCompare(b.ts)).slice(-limit);
}
// 看板 / 运行日志只用到这些字段：整条线索（匹配明细、判断原文、JD）曾让 /api/snapshot 达到 17.8 MB。
// 默认只看"还能推进的"：没预筛掉、没判排除、没结束（pass / 归档 / 已排除 / 拒绝）、公司没被排除、在冲刺城市内；
// 已经联系 / 投递 / 回复 / 面试 / Offer 的照常显示。看板上有「显示全部」开关。
export function boardFlags(l, board_stage, ctx = {}) {
  const closed = ['rejected', 'archived', 'passed', 'pass_pending'].includes(leadState(l));
  const progressed = stages.indexOf(board_stage) >= 3 && !closed;
  let hold = false; try { hold = 'sprint' in ctx ? sprintHold(l, ctx.sprint) : sprintHold(l); } catch {}
  // 旧程序留下的记录（legacy）只要已经走到联系之后（比如 Offer）照样显示。
  const hidden = closed || (!progressed && (!!l.legacy || !!l.prefilter_reason || excludedCompany(l, ctx.pipeline) || l.match?.verdict === 'exclude' || hold));
  return { actionable: !hidden, closed, sprint_hold: hold && !progressed };
}
const PICK=['id','record_id','number','company','role','location','source_type','source','url','state','feedback_at','imported_at','discovered_at','followup_at','match','match_error_final','match_attempts'];
// stage、feedback 两格给页面（看板上的阶段字、你说过什么）：从 state 换算，线索上不再存。
const pick=l=>({...Object.fromEntries(PICK.filter(k=>l[k]!==undefined).map(k=>[k,l[k]])),stage:stageText(l),feedback:feedbackText(l)});
export function boardLead(l) {
  return { id: l.id, record_id: l.record_id, number: l.number ?? null, company: l.company, role: l.role, location: l.location, source_type: l.source_type, source: l.source, entry: l.entry, url: l.url || null,
    board_stage: l.board_stage, city: l.city, verdict: l.verdict, human: l.human, stage: l.stage || stageText(l), feedback: l.feedback === undefined ? feedbackText(l) : l.feedback || null,
    feedback_at: l.feedback_at || null, imported_at: l.imported_at || null, discovered_at: l.discovered_at || null, followup_at: l.followup_at || null,
    match: l.match ? { verdict: l.match.verdict || null, at: l.match.at || null, must_haves: (l.match.must_haves || []).map(h => ({ status: h.status })) } : null,
    match_error_final: l.match_error_final || null, match_attempts: l.match_attempts || null, actionable: l.actionable, sprint_hold: l.sprint_hold, pending_company: /^待核/.test(String(l.company || '')) };
}
export function snapshot(runtime = {}) {
  // 只读：按文件签名缓存的解析结果。
  const drafts=cachedLines('state/drafts.ndjson'), outbound=cachedLines('state/outbound.ndjson'), all=cachedLines('state/leads.ndjson');
  const events=tailEvents(), histories=historyRuns(), queue=cachedLines('state/feedback.ndjson').filter(e=>e.source==='dashboard'&&e.status==='queued');
  // 不展开整条线索（{...l} 会把每条压缩的 JD 都解压一遍）：只取看板要的字段，再补推导出来的几项。
  const ctx={pipeline:read('config/pipeline.json',{}),sprint:citySprint()};
  const leads=all.filter(l=>!l.superseded&&l.status!=='superseded'&&l.match_status!=='superseded').map(l=>{
    const excluded=excludedCompany(l,ctx.pipeline), board_stage=boardStage(l,drafts,outbound);
    const derived={board_stage,city:(leadCity(l)==='其他'?relocationCity(l):leadCity(l))||leadCity(l)||l.judgement?.posting?.city||'',verdict:(l.prefilter_reason||excluded)?'prefiltered':(l.match?.verdict||''),human:l.human===true||/真人|内推|HR直发/.test(l.source_type||''),...boardFlags(l,board_stage,ctx),entry:l.entry_type || (l.email?'邮箱':l.ats_type?`ATS · ${l.ats_type}`:/linkedin|脉脉|boss/i.test(l.source||'')?'平台私信':'待核实')};
    return boardLead({...pick(l),...derived});
  });
  const model=read('config/model.json',null), latestHeartbeat=[...histories,...events.filter(e=>e.actor==='heartbeat'&&e.step==='cycle')].sort((a,b)=>b.ts.localeCompare(a.ts))[0];
  const scheduler=scheduleStatus(), nextHeartbeat=scheduler.next_at;
  const journey=currentJourney(), waiting=journey.actions.filter(a=>!a.paused&&!(Date.parse(a.snooze_until||'')>Date.now())).map(a=>({id:a.record_id,number:a.number,company:a.company,role:a.role,type:a.title,detail:a.detail,to:a.kind==='send'?drafts.find(d=>d.draft_id===a.draft_id)?.to:undefined}));
  const today=dateKey(Date.now()), dayEvents=events.filter(e=>dateKey(e.ts)===today), modelEvents=events.filter(e=>e.step==='model'&&['ok','fail'].includes(e.status));
  const funnel=[['转发',new Set(dayEvents.filter(e=>e.actor==='listener'&&e.step==='message').map(e=>e.run_id)).size],['识别',dayEvents.filter(e=>e.step==='extract'&&e.status==='ok').length],['命中',dayEvents.filter(e=>e.step==='match'&&e.status==='ok').length],['材料就绪',drafts.filter(d=>d.verified_at&&dateKey(d.verified_at)===today).length],['已投 / 联系',outbound.filter(o=>(o.at||o.sent_at)&&dateKey(o.at||o.sent_at)===today).length],['回复',dayEvents.filter(e=>e.step==='reply'&&e.status==='ok').length],['面试',dayEvents.filter(e=>e.step==='interview'&&e.status==='ok').length]];
  return {ts:new Date().toISOString(),crew:crewTable(),crew_legacy:crewLegacy(),stages,leads:leads.map(boardLead),waiting,events:dedupeEvents([...histories,...events].sort((a,b)=>b.ts.localeCompare(a.ts))).map(withMember),queue:queue.map(({id,record_id,raw,at})=>({id,record_id,raw,at})),funnel,counts:{total:leads.length,archived:leads.filter(l=>l.board_stage===stages[6]).length,hidden:all.length-leads.length,recommended:leads.filter(l=>l.match?.verdict==='recommend').length,match_failed:leads.filter(l=>l.match_error_final&&!l.match).length},journey,health:{...runtime,scheduler,model:model?.text?.driver || model?.driver || '尚未切换（旧 HTTP 后端）',latestHeartbeat,nextHeartbeat,mailbox:currentMailbox(),chrome:fs.existsSync('/Applications/Google Chrome.app')?'已安装，登录与预填未验证':'未检测到',feishu:read('state/concierge-sync.json',{}).status==='degraded'?'飞书同步暂未完成，系统会重试':read('state/concierge-sync.json',{}).at?'主动提醒已接通；最近同步 '+new Date(read('state/concierge-sync.json').at).toLocaleTimeString('zh-CN',{timeZone:TZ,hour12:false}):'尚无新通知回执',lastModel:modelEvents.at(-1)},usage:{input_tokens:modelEvents.reduce((s,e)=>s+(e.model_usage?.input_tokens||0),0),output_tokens:modelEvents.reduce((s,e)=>s+(e.model_usage?.output_tokens||0),0),calls:modelEvents.length,failed:modelEvents.filter(e=>e.status==='fail').length,avg_ms:modelEvents.length?Math.round(modelEvents.reduce((s,e)=>s+(e.duration_ms||0),0)/modelEvents.length):0,quota:codexQuota(),window:'最近 1,500 条事件',trend:Array.from({length:7},(_,i)=>{const day=dateKey(Date.now()-(6-i)*86400000), es=[...histories,...events].filter(e=>dateKey(e.ts)===day);return {day,runs:new Set(es.filter(e=>e.step!=='heartbeat').map(e=>e.run_id)).size,errors:es.filter(e=>e.status==='fail').length,calls:es.filter(e=>e.step==='model'&&e.status!=='start').length};})}};
}
// 全局日志按需搜索完整账本；和岗位详情读同一条事件，并给旧准备补相同的采用说明。
export async function searchEvents({ q = '', scope = {}, flow = 'all', leadOnly = false, page = 1, limit = 20 } = {}) {
  q = String(q).trim().slice(0, 300).toLowerCase();
  limit = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 20));
  const all = cachedLines('state/leads.ndjson'), byId = new Map(all.flatMap(l => [l.id, l.record_id].filter(Boolean).map(id => [id, l]))), crew = crewTable(), matched = [];
  const collect = raw => {
    if (!eventInScope(raw, scope) || leadOnly && !raw.lead_id) return;
    let e = withMember(raw);
    if (!(flow === 'all' || flow === 'fail' && e.status === 'fail' || e.member === flow)) return;
    const lead = byId.get(e.lead_id);
    if (lead) e = prepRecordView(lead, e);
    if (!q || eventMatches(e, lead, q, crew[e.member]?.label || e.actor)) matched.push(e);
  };
  for await (const row of scanEvents()) collect(row);
  for (const row of historyRuns(Infinity)) collect(row);
  const events = dedupeEvents(matched.sort((a, b) => b.ts.localeCompare(a.ts))), groups = eventGroups(events), pages = Math.max(1, Math.ceil(groups.length / limit));
  page = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const rows = groups.slice((page - 1) * limit, page * limit).flatMap(([, rows]) => rows);
  const leads = [...new Set(rows.map(e => byId.get(e.lead_id)).filter(Boolean))].map(l => ({ id: l.id, record_id: l.record_id, number: l.number, company: l.company, role: l.role }));
  return { events: rows, leads, total: events.length, runs: groups.length, page, pages };
}
// 时间线要这条线索的全部事件：运行日志只看最后 1500 条，早于那的投递 / 联系记录和它们的截图原来一条都不显示。
export function detail(id) {
  const lead=cachedLines('state/leads.ndjson').find(l=>key(l)===id); if(!lead) return null;
  const c=read('config/feishu.json',{});
  // Watch 的公司调研和「怎么准备」（lib/company-brief.mjs）：详情页顶上两节。
  const jobs=cachedLines('state/host-jobs.ndjson');
  const prefilter = lead.prefilter_reason ? PREFILTER_WORD[lead.prefilter_reason] || '不符合筛选条件' : null;
  const failure = lead.match_error_final || lead.match_error;
  const judgement_display = { prefilter, issue: !prefilter && failure ? `${lead.match_error_final ? '判断已停止重试' : '这次判断未完成'}：${errorReason(redact(failure))}` : null };
  // 高级档的一页评估（lib/evaluate.mjs）：有就一起给。
  return {judgement_display,judgement_review:policyReviewNotice(lead),duplicates:possibleDuplicates(lead,cachedLines('state/leads.ndjson')),lead:{...lead,company:/^待核/.test(lead.company)?lead.company:canonicalCompany(lead.company),role:jobTitle(lead.applied_role||lead.role,lead.jd_text),stage:stageText(lead),feedback:feedbackText(lead)},company:companyDetail(lead,{jobs}),prep:prepDetail(lead,{jobs}),interview:dossierDetail(lead),interview_materials:interviewMaterialsForLead(lead),evaluation:loadEvaluation(lead),drafts:cachedLines('state/drafts.ndjson').filter(d=>d.record_id===id),outbound:cachedLines('state/outbound.ndjson').filter(o=>o.record_id===id),events:tailEvents(Infinity).filter(e=>e.lead_id===id).map(withMember).map(e=>prepRecordView(lead,e)),feedback:cachedLines('state/feedback.ndjson').filter(e=>e.record_id===id),base_url:lead.record_id?`https://feishu.cn/base/${c.base}?table=${c.table}&record=${lead.record_id}`:null};
}
export function queueFeedback({record_id,action,reason='',request_id,displayed_hash}) {
  if(!['联系','pass','跟进','备注','发'].includes(action)) throw Error('该操作尚未接通，请通过原入口处理');
  if(typeof reason!=='string'||reason.length>2000||typeof request_id!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(request_id)) throw Error('反馈格式不正确');
  const leads=lines('state/leads.ndjson'), l=leads.find(l=>key(l)===record_id);
  if(!l?.number||archivedLead(l)) throw Error('该记录无法反馈');
  if(action==='备注'&&!reason.trim()) throw Error('请填写备注');
  const id=hash(['dashboard',request_id]), history=lines('state/feedback.ndjson'), existing=history.find(e=>e.id===id);
  if(existing) return {id,status:existing.status,duplicate:true};
  const raw=action==='发'?`发 ${l.number}`:`${l.number} ${action}${reason?' '+reason:''}`;
  let binding;
  if(action==='发') {
    const drafts=lines('state/drafts.ndjson'), d=drafts.find(d=>d.record_id===record_id&&d.status==='ready');
    if(!d||displayed_hash!==draftFingerprint(d)) throw Error('草稿已变化，请刷新后重新审核');
    binding=bindSend(raw,'dashboard',request_id,drafts,lines('state/send-requests.ndjson'),lines('state/outbound.ndjson'));
    if(binding?.duplicate) throw Error('该草稿已授权或已发送，不重复操作');
  } else {const p=parseFeedback(raw,leads,{source:'dashboard',message_id:request_id});if(p.uncertain.length||p.events.length!==1||p.events[0].record_id!==record_id) throw Error('请一次反馈一个岗位');}
  fs.mkdirSync(file('state'),{recursive:true});
  fs.appendFileSync(file('state/feedback.ndjson'),JSON.stringify({id,record_id,number:l.number,action,reason,source:'dashboard',message_id:request_id,at:new Date().toISOString(),raw,status:'queued',...(binding?{draft_id:binding.draft_id,fingerprint:binding.fingerprint}:{})})+'\n');
  event('user','feedback','ok',`已收到 ${raw}，等待统一反馈入口处理`,{lead_id:record_id,run_id:`feedback-${id.slice(0,16)}`});
  return {id,status:'queued'};
}
export function evidencePath(ref) {
  const safe = value => typeof value === 'string' && value.startsWith('runs/') && !value.includes('\\') && !value.split('/').some(x => x.startsWith('.') || x.toLowerCase() === 'private');
  if (!safe(ref)) throw Error('不允许访问该文件');
  const p=fs.realpathSync(file(ref)), allowed=fs.realpathSync(file('runs'))+path.sep;
  const contained = target => target.startsWith(allowed) && safe('runs/' + path.relative(allowed, target).split(path.sep).join('/'));
  if (!contained(p)) throw Error('不允许访问该文件');
  const linked=[...tailEvents(Infinity),...historyRuns()].some(e=>(e.refs||[]).some(r=>r.file===ref||r.screenshot===ref)) || cachedLines('state/outbound.ndjson').some(o => o.evidence === ref) || cachedLines('state/host-jobs.ndjson').some(j => (Array.isArray(j.evidence) ? j.evidence : [j.evidence]).some(e => (typeof e === 'string' ? e : e?.file || e?.screenshot) === ref));
  // 终审截图、预填截图、停下时那一页的截图（lib/auto-apply.mjs 记在线索上：final_review / prefill / stop）也算登记过的证据。
  if(!linked && !cachedLines('state/leads.ndjson').some(l => [l.auto_apply?.final_review?.screenshot, l.auto_apply?.prefill?.screenshot, l.auto_apply?.stop?.screenshot].includes(ref))) throw Error('仅可打开事件或外发记录中登记的证据');
  // .log：一次运行的日志（state/ops.json 的 log，任务卡上的「日志」）；以前不在单子里，点了就是「不允许访问该文件」（10-04）。
  const extensions = ['.md', '.json', '.png', '.html', '.jpg', '.jpeg', '.webp', '.pdf', '.txt', '.log'];
  const readable = target => {
    if (!extensions.includes(path.extname(target).toLowerCase()) || !fs.statSync(target).isFile()) return false;
    try { fs.accessSync(target, fs.constants.R_OK); return true; } catch { return false; } // 兜底：读不了就是 false，调用方照实说打不开
  };
  if (!fs.statSync(p).isDirectory()) {
    if (!extensions.includes(path.extname(ref).toLowerCase())) throw Error('不允许访问该文件');
    return readable(p) ? p : null;
  }
  const entries = fs.readdirSync(p).filter(name => safe(ref.replace(/\/$/, '') + '/' + name) && extensions.includes(path.extname(name).toLowerCase()))
    .sort((a, b) => extensions.indexOf(path.extname(a).toLowerCase()) - extensions.indexOf(path.extname(b).toLowerCase()) || a.localeCompare(b));
  for (const name of entries) {
    let target;
    try { target = fs.realpathSync(path.join(p, name)); } catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) continue; throw error; }
    if (!contained(target)) throw Error('不允许访问该文件');
    if (readable(target)) return target;
  }
  return null;
}
