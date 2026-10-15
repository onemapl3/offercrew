// 提问以当前回执为准；保留旧记录，不把未知的发送结果当成可以再发。
import { lines, writeLines, hash } from './store.mjs';
import { appliedLead, applyEvent } from './lead-state.mjs';
import { delivered } from './delivery.mjs';
import { TZ } from './tz.mjs';
import { coName } from './vocab.mjs';
import { heldAsk, taskChoices } from './task-control.mjs';
import { interventionOf } from './intervention.mjs';

const DM = new Set(['platform_dm', 'maimai_friend_request']);
const UNCERTAIN = /not_in_thread|delivery_unconfirmed|dispatch_unconfirmed|dm_unconfirmed|timeout|connection|browser.*closed/;
export function uncertainDelivery(d, requests = lines('state/send-requests.ndjson')) {
  if (!d?.draft_id) return null; // 空键不是关联：旧孤儿草稿不能借另一条发送请求生成核实信。
  const r = requests.findLast(x => x.draft_id === d?.draft_id);
  if (!r || !DM.has(r.channel || d?.channel)) return null;
  const beforeSend = /^(?:draft_changed|input_mismatch|chat_input_not_found|no_message_box|maimai_note_too_long|verified_absent)$/;
  if (['needs_review','failed'].includes(r.status) && r.dispatched_at && !beforeSend.test(r.reason || '')) return r;
  return r.status === 'uncertain' || (['needs_review', 'failed', 'queued'].includes(r.status) && UNCERTAIN.test([r.reason, r.retry_reason, r.last_error].filter(Boolean).join(' '))) ? r : null;
}
const applied = (l, outbound) => appliedLead(l) || outbound.some(o => o.record_id === (l.record_id || l.id) && /ats_form|portal/.test(o.channel || '') && delivered(o, l));
const sameCompany = (a, b) => coName(a).trim().toLowerCase() === coName(b).trim().toLowerCase();
export function taskOfAsk(a, cards) {
  return cards.find(c => (c.id && (c.id === (a.card || a.task_id) || a.job_ref === `card:${c.id}`)) || (a.job_id && c.links?.job_id === a.job_id) || (a.id && c.links?.ask_id === a.id));
}
function currentLogin(a, cards, now) {
  const affected = a.affected.filter(i => {
    const byJob = i.job_id ? cards.filter(c => c.links?.job_id === i.job_id) : [];
    const owners = byJob.length ? byJob : cards.filter(c => c.links?.ask_id === a.id && (c.leads || []).some(l => i.record_id && l.rid === i.record_id));
    return !owners.length || owners.some(c => !c.superseded && !heldAsk(c, now));
  });
  if (!affected.length) return null;
  const keep = key => new Set(affected.map(i => i[key]).filter(Boolean));
  const jobs = keep('job_id'), leads = keep('record_id'), hosts = keep('host');
  const heldJobs = new Set(cards.filter(c => c.superseded || heldAsk(c, now)).map(c => c.links?.job_id).filter(Boolean));
  // 登录是账号的共用问题，不把它挂给任意第一张卡；恢复参数也只能包含仍在等的项。
  const count = s => String(s || '').replace(/(挡住了|恢复这)\s*\d+\s*项/g, `$1 ${affected.length} 项`);
  const step = s => {
    if (s.type !== 'account_ready') return s;
    const out = { ...s };
    for (const [key, allowed] of [['jobs', jobs], ['leads', leads], ['hosts', hosts]]) if (Array.isArray(s[key])) out[key] = s[key].filter(id => allowed.has(id));
    if (Array.isArray(s.superseded)) out.superseded = s.superseded.filter(id => !heldJobs.has(id));
    return out;
  };
  return { ...a, affected, question: count(a.question), options: (a.options || []).map(o => ({ ...o, ...(o.hint ? { hint: count(o.hint) } : {}), steps: (o.steps || []).map(step) })) };
}
export function currentAsks(asks, { cards = [], leads = [], drafts = [], requests = [], outbound = [], now = Date.now(), trace = null } = {}) {
  const out = [], verified = new Set();
  for (const a0 of asks) {
    const sharedLogin = a0.type === 'login' && a0.affected?.length;
    const a = sharedLogin ? currentLogin(a0, cards, now) : { ...a0 };
    if (!a) { trace?.(a0, 'currentAsks', 'drop:login_tasks_owner_control'); continue; }
    const c = sharedLogin ? null : taskOfAsk(a, cards), l = a.lead?.record_id ? leads.find(l => (l.record_id || l.id) === a.lead.record_id) : null;
    if (c?.superseded || (c && heldAsk(c, now))) { trace?.(a, 'currentAsks', c.superseded ? 'drop:task_superseded' : 'drop:task_owner_control'); continue; }
    const push = /^(?:apply|prefilled|final|reapprove|stalled|pool|auto-apply|job|blocked|handoff|need|city):/.test(a.id) || a.options?.some(o => o.steps?.some(s => ['apply_confirm','prefill','apply','requeue_apply'].includes(s.type) || (s.type === 'action' && ['prefill','submit'].includes(s.kind))));
    // 收起的是有时间凭据的旧失败，不是用户刚发起的精确计划确认。
    const confirmation = a.options?.some(o => o.steps?.some(s => s.type === 'apply_confirm'));
    const attempt = l?.auto_apply?.inbox_retired?.attempt_at;
    const retired = attempt && attempt === l.auto_apply.at && l.auto_apply.status === 'failed';
    if (!a.notice && l && push && (applied(l, outbound) || (retired && !confirmation))) { trace?.(a, 'currentAsks', applied(l, outbound) ? 'drop:application_delivered' : 'drop:dated_old_failure'); continue; }
    if (l?.auto_apply?.status === 'failed' && push) { const at=l.auto_apply.at, when=Number.isFinite(Date.parse(at || '')) ? String(at).slice(0,10) : '未记录时间'; a.question=String(a.question || '').replace(/自动预填没成（第\s*\d+\s*次）/g, `上次预填没成（${when}）`); }
    // 无草稿的投递确认、招聘方来信、登录、简历选择，不能匹配 draft_id:null 的旧孤儿草稿。
    const did = a.draft_id || (/^draft:/.test(a.id) ? a.id.slice(6) : null), d = did ? drafts.find(x => x.draft_id === did) : null;
    if (d && (d.status === 'sent' || requests.some(r => r.draft_id === did && r.status === 'sent') || outbound.some(o => o.draft_id === did && delivered(o, l)))) { trace?.(a, 'currentAsks', 'drop:draft_delivered'); continue; }
    const r = d && uncertainDelivery(d, requests);
    if (r) {
      if (verified.has(did)) { trace?.(a, 'currentAsks', 'drop:duplicate_verification'); continue; }
      verified.add(did);
      trace?.(a, 'currentAsks', 'replace:verify_send'); out.push(verificationAsk(d, r, d.record_id ? leads.find(x => (x.record_id || x.id) === d.record_id) : l)); continue;
    }
    if (l && !a.notice && push) {
      const done = leads.filter(x => x.number !== l.number && !x.superseded && sameCompany(x.company, l.company) && applied(x, outbound)).map(x => x.number).filter(n => n != null).sort((a,b)=>a-b);
      if (done.length) a.context = [...(a.context || []), `${coName(l.company)} 你已经交了 ${[...new Set(done)].map(n=>`#${n}`).join('、')}`];
    }
    if (!a.notice) a.intervention = interventionOf(a, c || {});
    if (c && !a.notice) {
      a.card = c.id;
      a.intervention = interventionOf(a, c);
      a.options = (a.options || []).filter(o => !o.steps?.some(s => s.type === 'localai' && ['self','drop'].includes(s.action))).map((o,i) => [...String(o.label || '')].length > 18 && o.steps?.every(s => s.type === 'request' || (s.type === 'job' && s.action === 'feedback')) ? { ...o, label:`选择方案 ${i+1}`, hint:[o.label,o.hint].filter(Boolean).join('；') } : o);
      a.options.push(...taskChoices(c).filter(x => !['todo','resume'].includes(x.action)).map(x => ({ key:`task_${x.action}`, label:x.label, steps:[{type:'task_control', card:c.id, action:x.action}] })));
    }
    trace?.(a, 'currentAsks', 'keep');
    out.push(a);
  }
  for (const c of cards) if (c.owner_control?.action === 'later' && !heldAsk(c, now) && !out.some(a=>a.card===c.id)) out.push({id:`task-later:${c.id}`,card:c.id,from:c.owner || 'patch',type:'decide',title:c.title,question:'你放到今天再处理的任务。',intervention:interventionOf(),options:taskChoices(c).filter(x=>x.action!=='todo').map(x=>({key:`task_${x.action}`,label:x.label,steps:[{type:'task_control',card:c.id,action:x.action}]}))});
  // 请求还在、旧草稿已不在推荐队列，也必须有核实入口。
  for (const d of drafts) {
    const r = uncertainDelivery(d, requests);
    if (!r || verified.has(d.draft_id) || ['sent','cancelled'].includes(d.status)) continue;
    out.push(verificationAsk(d, r, d.record_id ? leads.find(l => (l.record_id || l.id) === d.record_id) : null));
  }
  return out;
}
function verificationAsk(d, r, l) {
  const number = l?.number ?? d.number ?? null;
  const at=r.dispatched_at || r.at || r.created_at;
  const when=Number.isFinite(Date.parse(at || '')) ? `上次发送：${new Date(at).toLocaleString('zh-CN',{timeZone:TZ,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}` : '上次发送时间未记录';
  const options = [{ key:'open', label:'打开原对话核实', href:d.to, steps:[] }, ...[['sent','已核实，发出了'],['not_sent','已核实，没发出']].map(([outcome,label]) => ({key:outcome,label,steps:[{type:'verify_delivery',request:r.id,outcome}]})), {key:'later',label:'晚点再说',steps:[{type:'snooze',hours:24}]}];
  const checking = r.channel === 'platform_dm' && r.delivery_check?.outcome !== 'unknown';
  return {id:`verify-send:${r.id}`,notice:checking,from:'quill',type:'review',draft_id:d.draft_id,lead:{record_id:d.record_id,number,company:l?.company || d.company},title:`${number != null ? `#${number} ` : ''}${l?.company || d.company || ''} · 核实发送结果`,question:checking ? '你已经点过发送，正在自动核对原对话，核实之前不会再发。' : (r.result || '这个平台的发送结果还无法自动核实；请查看原对话，确认之前不会再发。'),context:[when],options:checking ? [] : options,other:null};
}
export function settleDelivery(id, outcome, {now = Date.now()} = {}) {
  if (!['sent','not_sent'].includes(outcome)) throw Error('请先核实是否发出');
  const requests=lines('state/send-requests.ndjson'), r=requests.find(r=>r.id===id), drafts=lines('state/drafts.ndjson'), d=drafts.find(d=>d.draft_id===r?.draft_id);
  if (!r || !d || !uncertainDelivery(d, requests)) throw Error('发送记录变了，请刷新');
  const at=new Date(now).toISOString();
  r.delivery_checked={outcome,at,by:'owner'};
  r.status=outcome==='sent'?'sent':'cancelled'; r.result=outcome==='sent'?'你核实原对话后确认已发出':'你核实原对话后确认没发出；重新发送需要再批准';
  if (outcome==='sent') {
    d.status='sent'; d.sent_at=at;
    const outbound=lines('state/outbound.ndjson');
    outbound.push({id:hash(['owner-send',r.id]),record_id:d.record_id,number:d.number,draft_id:d.draft_id,channel:d.channel,to:d.to,at,readback:'owner_confirmed',confirmed_by:'owner',body_preview:String(d.body || '').slice(0,200)});
    writeLines('state/outbound.ndjson',outbound);
    const leads=lines('state/leads.ndjson'), l=leads.find(x=>(x.record_id||x.id)===d.record_id);
    if(l && !appliedLead(l) && !['offer','archived','rejected'].includes(l.state)) { applyEvent(l,'sent',{}, {at,source:'owner-verification'}); writeLines('state/leads.ndjson',leads); }
  } else { d.status='ready'; delete d.displayed_hash; delete d.notified_at; }
  writeLines('state/send-requests.ndjson',requests); writeLines('state/drafts.ndjson',drafts);
  return r.result;
}
