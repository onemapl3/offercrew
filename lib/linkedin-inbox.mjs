// 登录后的专用 Chrome 直接读 LinkedIn 原线程。只导航/取 DOM，不打字、不发送；打开线程可能被网站标为已读。
import { read, write, lines, writeLines, hash } from './store.mjs';
import { lock, waitForLock } from './lock.mjs';
import { sandboxed } from './sandbox.mjs';
import { agentPaused } from './agents.mjs';
import { alive, liveHost } from './browser-host.mjs';
import { loadAccounts, sessionForKey } from './accounts.mjs';
import { localHour } from './tz.mjs';
import { event } from './events.mjs';
import * as J from './jobs.mjs';
import { recordReply } from './inbox.mjs';
import { liveLead } from './list-watch.mjs';
import { linkMessage } from './linkedin-mail.mjs';
import { linkedinThread, messageText, personKey, sameLinkedInNotification } from './linkedin-message-identity.mjs';
export { linkedinThread };
export const INBOX_URL = 'https://www.linkedin.com/messaging/';
export const STATE_PATH = 'state/linkedin-browser-inbox.json';
export const MESSAGES_PATH = 'state/linkedin-browser-messages.ndjson';
export const SOURCE = 'linkedin-browser';
export const INTERVAL_MS = 10 * 60000;
const keyOf = l => l.record_id || l.id;
const atOf = now => new Date(now).toISOString();

// 原样注入网页；只读已呈现的消息，不把列表摘要当完整正文。
export function collectLinkedInPage() {
  const text = (document.body?.innerText || '').slice(0, 2000), url = location.href;
  if (/\/checkpoint\/|\/challenge\//.test(location.pathname) || /security verification|安全验证|安全检查/i.test(text)) return { status: 'verification_required', url };
  if (/\/login|\/uas\/login|\/authwall/.test(location.pathname) || document.querySelector('input[name="session_password"]')) return { status: 'login_required', url };
  const links = [...new Set([...document.querySelectorAll('a[href*="/messaging/thread/"]')].map(a => a.href))];
  const nodes = [...document.querySelectorAll('.msg-s-event-listitem[data-event-urn]')];
  let sender = '', profile = '', direction = 'unknown', day = '', clock = '';
  const messages = [];
  for (const el of nodes) {
    const parent = el.closest('li.msg-s-message-list__event');
    day = parent?.querySelector('.msg-s-message-list__time-heading')?.innerText?.trim() || day;
    const name = el.querySelector('.msg-s-message-group__name')?.innerText?.trim();
    const link = el.querySelector('a.msg-s-event-listitem__link[href*="/in/"], a[href*="/in/"]')?.href;
    const time = el.querySelector('.msg-s-message-group__timestamp');
    clock = time?.innerText?.trim() || clock;
    if (name) { sender = name; profile = link || ''; direction = el.classList.contains('msg-s-event-listitem--other') ? 'inbound' : link ? 'outbound' : 'unknown'; }
    else if ((el.classList.contains('msg-s-event-listitem--other') && direction !== 'inbound') || (!el.classList.contains('msg-s-event-listitem--other') && direction !== 'outbound')) { sender = ''; profile = ''; direction = 'unknown'; }
    const body = el.querySelector('.msg-s-event-listitem__body')?.innerText?.trim();
    if (!body) continue;
    messages.push({ id: el.getAttribute('data-event-urn'), body, from: sender, profile_url: profile, direction,
      time_label: [day, clock].filter(Boolean).join(' '), sent_at: time?.getAttribute('datetime') || null });
  }
  const shell = !!document.querySelector('.msg-conversations-container, .msg-conversation-listitem, .msg-conversations-container__conversations-list, .msg-s-message-list');
  const empty = /no messages yet|no conversations|还没有消息|暂无消息/i.test(text);
  return { status: shell || empty || messages.length ? 'ok' : 'failed', url, links, messages,
    empty, history_limited: !!document.querySelector('.msg-s-message-list__load-earlier') };
}
export function linkedInScript({ targets = [], maxThreads = 12, cursor = 0, onlyTarget = false, hidden = false } = {}) {
  return `const task = await taskSpace('OfferCrew · 读取 LinkedIn 来信', {hidden:${hidden}});
const page = task.page('p1');
const collect = ${collectLinkedInPage.toString()};
const canonical = ${linkedinThread.toString()};
const out = {status:'ok',threads:[],errors:[],discovered:[],partial:false};
const deadline=Date.now()+200000;
try {
  let list={status:'ok',links:[]};
  if(!${onlyTarget}){
    await page.goto(${JSON.stringify(INBOX_URL)}, {timeout:30000,waitUntil:'domcontentloaded'});
    for(let i=0;i<5;i++){await page.waitForTimeout(1000);list=await page.evaluate(collect);if(list.status!=='failed')break;}
  }
  if(list.status!=='ok'){out.status=list.status;}
  else {
    out.discovered=[...new Set((list.links||[]).map(canonical).filter(Boolean))];
    const listed=out.discovered.length?[...out.discovered.slice(${cursor}%out.discovered.length),...out.discovered.slice(0,${cursor}%out.discovered.length)]:[];
    const known=${JSON.stringify(targets)};
    const all=[...new Set([...known.slice(0,6),...listed.slice(0,6),...known.slice(6),...listed.slice(6)])];
    out.partial=all.length>${maxThreads};
    for(const url of all.slice(0,${maxThreads})) {
      if(Date.now()>deadline){out.partial=true;break;}
      try {
        await page.goto(url,{timeout:25000,waitUntil:'domcontentloaded'});
        let t;
        for(let i=0;i<5;i++){await page.waitForTimeout(800);t=await page.evaluate(collect);if(t.status==='login_required'||t.status==='verification_required'||t.messages?.length||t.empty)break;}
        if(t.status==='login_required'||t.status==='verification_required'){out.status=t.status;break;}
        if(t.status!=='ok'||canonical(t.url)!==url||(!t.messages.length&&!t.empty))throw Error('thread_not_readable');
        out.threads.push({url,messages:t.messages,history_limited:t.history_limited});
      }catch(e){out.errors.push({url,error:String(e.message||e).slice(0,160)});if(/site_check:/.test(String(e))){out.status='verification_required';break;}}
    }
    if(!all.length&&!list.empty)out.status='failed';
  }
} catch(e){out.status=/site_check:/.test(String(e))?'verification_required':'failed';out.errors.push({error:String(e.message||e).slice(0,200)});}
finally {await task.finish({keep:[]}).catch(e=>{out.cleanup_error=String(e.message||e).slice(0,120);});}
radarResult(out);`;
}
const profileKey = s => { try { const u = new URL(s); return /^(?:www\.)?linkedin\.com$/.test(u.hostname) && /^\/in\/[^/]+\/?$/.test(u.pathname) ? u.pathname.replace(/\/$/, '').toLowerCase() : null; } catch { return null; } }; // 兜底：缺少有效个人主页时，只用线程或唯一姓名关联。
export function linkLinkedInThread(thread, { leads = [], events = [], state = {} } = {}) {
  const url = linkedinThread(thread.url); if (!url) return null;
  const live = leads.filter(liveLead);
  const senders = new Set(thread.messages.filter(m=>m.direction==='inbound'&&m.from).map(m=>personKey(m.from)));
  if(senders.size>1)return null; // 多人线程不能仅凭旧 URL 把其他人的来信归给一位联系人。
  const ids = new Set(events.filter(e => linkedinThread(e.thread_url || e.url) === url && e.record_id).map(e => e.record_id));
  if (state.threads?.[url]?.record_id) ids.add(state.threads[url].record_id);
  const exact = live.filter(l => ids.has(keyOf(l)) || [l.linkedin_thread_url,l.reply_url,l.url,l.contact_url].some(u => linkedinThread(u) === url));
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const incoming = thread.messages.filter(m => m.direction === 'inbound' && m.from);
  const names = new Set(incoming.map(m => personKey(m.from)));
  if (names.size !== 1) return null; // 群聊或方向不明不猜归属。
  const profiles = new Set(incoming.map(m => profileKey(m.profile_url)).filter(Boolean));
  const sameProfile = live.filter(l => [l.contact_url,l.url,l.author_url,l.linkedin_url].some(u => profileKey(u) && profiles.has(profileKey(u))));
  if (sameProfile.length) return sameProfile.length === 1 ? sameProfile[0] : null;
  return linkMessage({ name: incoming.at(-1)?.from, headline: '', company: '', kind: 'message' }, { leads: live });
}

// 纯登记：所有可确认方向的消息保留原文。首次只提醒每个已有线程最后一条来信，历史不逐条轰炸。
export function recordLinkedInThreads(threads, { leads = [], events = [], messages = [], state = {}, now = Date.now() } = {}) {
  const at = atOf(now), saved = new Map(messages.map(m => [m.id,m])), bindings = { ...(state.threads || {}) };
  const unlinked = new Map((state.unlinked || []).map(m => [m.id,m]));
  const out = { conversations: 0, received: 0, raised: 0, reconciled: 0, unlinked: 0, unknown: 0 };
  // 同一个 URN 后续才展开的正文可以补全；方向、归属或原文不一致时不能靠更长就覆盖。
  const complete = (previous,m) => {
    if (!previous || linkedinThread(previous.thread_url || previous.url)!==m.thread_url || personKey(previous.from)!==personKey(m.from)) return false;
    const before=messageText(previous.body), after=messageText(m.body);
    if (!before || after.length<=before.length || !after.startsWith(before)) return false;
    previous.body=m.body;
    return true;
  };
  for (const thread of threads) {
    const url = linkedinThread(thread.url); if (!url) continue;
    const valid = [], local = new Set();
    for (const raw of thread.messages || []) {
      if (!raw?.id || local.has(raw.id) || typeof raw.body !== 'string' || !raw.body.trim()) continue;
      local.add(raw.id);
      const m = { ...raw, id: String(raw.id), thread_url: url, source: SOURCE, observed_at: at,
        sent_at: raw.sent_at && Number.isFinite(Date.parse(raw.sent_at)) ? new Date(raw.sent_at).toISOString() : null };
      if (!['inbound','outbound'].includes(m.direction) || !m.from) { out.unknown++; continue; }
      valid.push(m);
      if (!saved.has(m.id)) { messages.push(m); saved.set(m.id,m); if (m.direction === 'inbound') out.received++; }
      else if (saved.get(m.id).direction===m.direction) complete(saved.get(m.id),m);
    }
    out.conversations++;
    const incoming = valid.filter(m => m.direction === 'inbound');
    const lead = linkLinkedInThread({ ...thread, messages: valid }, { leads, events, state: { ...state, threads: bindings } });
    for (const m of incoming) {
      const ev=events.find(e=>e.platform_message_id===m.id&&e.direction==='inbound');
      if (complete(ev,m)) ev.summary=`${ev.from}：${ev.body}`;
      if (lead?.reply_message?.message_id===m.id && complete(lead.reply_message,m)) lead.reply_summary=`${lead.reply_message.from}：${lead.reply_message.body}`;
      complete(unlinked.get(m.id),m);
    }
    const existing = bindings[url];
    const knownIds=new Set(existing?.seen_ids || []), lastKnown=valid.findLastIndex(m=>m.direction==='inbound'&&knownIds.has(m.id));
    // 已知来信之前补加载的旧历史不能冒充新回复；我方尾句不能挡住漏读的较后来信。
    const candidates = existing?.checked_at ? valid.filter((m,i)=>m.direction==='inbound'&&(unlinked.has(m.id)||(!knownIds.has(m.id)&&i>lastKnown))) : incoming.slice(-1);
    for (const m of candidates) {
      const persisted = events.find(e => e.platform_message_id === m.id);
      if (persisted) {
        // 上一轮原文已落盘但随后线索写失败：补齐原关联，不能把已存消息当作没来过。
        if (lead && !existing?.seen_ids?.includes(m.id) && lead.reply_message?.message_id !== m.id) {
          recordReply(lead,{category:'回复',summary:persisted.summary,at:persisted.at,source:SOURCE});
          Object.assign(lead,{reply_channel:'platform_dm',reply_url:url,linkedin_thread_url:url,reply_message:{platform:'LinkedIn',body:m.body,from:m.from,received_at:m.sent_at,url,time_label:m.time_label || '',message_id:m.id,source:SOURCE,observed_at:at}});
        }
        continue;
      }
      if (!lead) { if (!unlinked.has(m.id)) out.unlinked++; unlinked.set(m.id, m); continue; }
      const prior = events.filter(e => e.source === 'linkedin-mail' && !e.platform_message_id && e.record_id === keyOf(lead) && sameLinkedInNotification(e, { url, name:m.from,first:m.body,at:m.sent_at || at }));
      // 多条候选不猜是哪封通知；原始邮件保留，不造第二份岗位提醒。
      if (prior.length > 1) { unlinked.set(m.id,{...m,reason:'多条通知都可能对应这条消息，未猜测合并'}); out.unknown++; continue; }
      const ev = prior.length === 1 ? prior[0] : { message_id: `linkedin:${hash(m.id).slice(0,24)}` };
      const alreadyNotified = prior.length > 0;
      Object.assign(ev, { platform_message_id: m.id, record_id: keyOf(lead), number: lead.number ?? null,
        at: ev.at || m.sent_at || at, observed_at: at, sent_at: m.sent_at, time_label: m.time_label || '',
        category: '回复', summary: `${m.from}：${m.body}`, body: m.body, from:m.from, direction:'inbound',
        source: SOURCE, sources: [...new Set([...(ev.sources || [ev.source]).filter(Boolean),SOURCE])],
        channel:'platform_dm',url,thread_url:url,profile_url:m.profile_url || '' });
      if (!events.includes(ev)) events.push(ev);
      unlinked.delete(m.id);
      // 邮件已提醒过时只补完整原文；不把已答复的旧通知重新打开。
      const pending = !lead.reply_answered_at || Date.parse(lead.reply_answered_at) < Date.parse(lead.replied_at || '');
      if (!alreadyNotified) { recordReply(lead,{category:'回复',summary:ev.summary,at:m.sent_at || at,source:SOURCE}); out.raised++; }
      if (!alreadyNotified || pending) {
        Object.assign(lead,{reply_channel:'platform_dm',reply_url:url,linkedin_thread_url:url,reply_summary:ev.summary,
          reply_message:{platform:'LinkedIn',body:m.body,from:m.from,received_at:m.sent_at,url,time_label:m.time_label || '',message_id:m.id,source:SOURCE,observed_at:at}});
      }
    }
    // 旧版曾把后补的历史来信当新消息，留下较早正文的当前投影。即使全部 URN 已见过，
    // 当前页面仍能证明哪条在后；只恢复已存事件的显示，不重新登记回复或改已处理/状态时间。
    const current=lead?.reply_message, currentIndex=incoming.findIndex(m=>m.id===current?.message_id), latest=incoming.at(-1);
    if (current?.source===SOURCE && linkedinThread(current.url)===url && currentIndex>=0 && currentIndex<incoming.length-1 && knownIds.has(latest.id)) {
      const ev=events.find(e=>e.platform_message_id===latest.id && e.record_id===keyOf(lead) && e.source===SOURCE && e.direction==='inbound' && linkedinThread(e.thread_url || e.url)===url && personKey(e.from)===personKey(latest.from));
      const body=messageText(ev?.body), visible=messageText(latest.body);
      if (body && visible && (body.startsWith(visible) || visible.startsWith(body))) {
        lead.reply_summary=ev.summary;
        lead.reply_message={platform:'LinkedIn',body:ev.body,from:ev.from,received_at:ev.sent_at || null,url,time_label:ev.time_label || '',message_id:ev.platform_message_id,source:SOURCE,observed_at:ev.observed_at,
          action_message_id:current.action_message_id || current.message_id}; // 只纠正显示，保留待办的已读/归档身份；真正新来信另开身份。
        out.reconciled++;
      }
    }
    bindings[url] = { checked_at: at, ...(lead ? { record_id:keyOf(lead) } : {}), history_limited: !!thread.history_limited, seen_ids: [...new Set([...(existing?.seen_ids || []),...valid.map(m=>m.id)])] };
  }
  return { ...out, state:{...state,threads:bindings,unlinked:[...unlinked.values()]} };
}
export const linkedInEnabled = (pipeline = read('config/pipeline.json', {}) || {}) => pipeline.linkedin_chat_watch !== false;
export function linkedinInboxView({ state = read(STATE_PATH,{}) || {}, pipeline } = {}) {
  const ops=read('state/ops.json',{}) || {}, queue=read('state/op-queue.json',{}) || {};
  const queued=(queue.items || []).find(x=>x.op==='linkedin-inbox');
  const running=ops.current?.op==='linkedin-inbox'?ops.current:null;
  const latest=[...(ops.history || []).filter(x=>x.op==='linkedin-inbox'),...(queue.done || []).filter(x=>x.op==='linkedin-inbox'&&['cancelled','dropped'].includes(x.status))].sort((a,b)=>String(b.finished_at || b.ended_at).localeCompare(String(a.finished_at || a.ended_at)))[0];
  let tracked=queued || running || latest, job=tracked?.job_id?J.get(tracked.job_id):tracked?.card_id?J.byRef(`card:${tracked.card_id}`):null;
  const stateJob=state.job_id?J.get(state.job_id):null;
  const stateAt=Date.parse(state.started_at || state.checked_at || '') || 0;
  const trackedAt=Date.parse(tracked?.started_at || tracked?.at || tracked?.finished_at || tracked?.ended_at || '') || 0;
  // 自动检查不进操作队列；较早的手动历史不能覆盖它当前那件活或带回旧任务入口。
  if(stateJob&&(!tracked||(stateJob.id!==job?.id&&stateAt>trackedAt))){job=stateJob;tracked=null;}
  const selectedQueue=tracked===queued&&queued;
  const job_state=selectedQueue?'queued':tracked?.status==='cancelled'?'cancelled':tracked?.status==='dropped'?'failed':job?.state || null;
  const interrupted=state.status==='checking'&&['failed','cancelled'].includes(job_state);
  return { enabled:linkedInEnabled(pipeline),status:interrupted?'failed':state.status || 'never_checked',checked_at:state.checked_at || null,
    started_at:state.started_at || null,reason:interrupted?(job?.reason || '本次检查中断，尚未确认是否有新消息'):state.reason || '还没有检查 LinkedIn 网页消息',
    conversations:state.conversations || 0,received:state.received || 0,raised:state.raised || 0,unlinked:state.unlinked?.length || 0,
    partial:!!state.partial,job_id:job?.id || state.job_id || null,job_state,pending:!!selectedQueue || job_state==='running',queue_id:selectedQueue?.id || null,task_id:tracked?.card_id || (job?.ref?.startsWith('card:')?job.ref.slice(5):null),task_reason:job?.reason || tracked?.why || null,manual_available:true,interval_minutes:10,hours:[9,21],
    next_retry_at:state.next_retry_at || null,consecutive_failures:state.consecutive_failures || 0,reads_mark_seen:true };
}
const linkedinSession = () => sessionForKey('linkedin',read('config/portal-sessions.json',{domains:{}}),loadAccounts());
export function linkedinInboxGate({force=false,now=Date.now(),state={},enabled=linkedInEnabled(),paused=agentPaused('owl'),sandbox=sandboxed(),hour=localHour(now),session=linkedinSession()}={}) {
  if(sandbox)return '演示模式不读取 LinkedIn';
  if(force)return null;
  if(!enabled)return 'LinkedIn 自动检查已关闭';
  if(paused)return 'Watcher 已暂停自动检查';
  if(hour<9||hour>=21)return '09:00–21:00 之外不自动检查';
  if((read('state/op-queue.json',{})?.items || []).some(x=>x.op==='linkedin-inbox'))return '手动 LinkedIn 检查正在排队，自动检查稍后再看';
  const manual=read('state/ops.json',{})?.current;
  if(manual?.op==='linkedin-inbox'&&alive(manual.pid))return '正在手动检查 LinkedIn，自动检查稍后再看';
  if(session?.logged_in!==true)return 'LinkedIn 尚未确认登录，登录后自动检查；也可以手动检查';
  if(state.logged_out_at&&!(Date.parse(session.verified_at || '')>Date.parse(state.logged_out_at)))return 'LinkedIn 会话已退出，等待登录状态更新';
  if(Date.parse(state.next_retry_at || '')>now)return 'LinkedIn 上次检查未完成，等待退避后重试；仍可手动检查';
  if(now-Date.parse(state.started_at || state.checked_at || 0)<INTERVAL_MS)return '还没到下次检查时间';
  return null;
}
const REASON = {login_required:'LinkedIn 未登录，请在专用浏览器登录后重新检查',verification_required:'LinkedIn 要求安全验证，请本人处理后重新检查',failed:'LinkedIn 页面没有读成，不能确定是否有新消息'};
function retryState(state, status, now, errors = []) {
  const failed = status === 'failed' || status === 'verification_required' || (status === 'partial' && errors.length);
  const consecutive_failures = failed ? Math.min((state.consecutive_failures || 0) + 1, 6) : 0;
  const delay = status === 'verification_required' ? 60 * 60000 : Math.min(20 * 60000 * 2 ** (consecutive_failures - 1), 60 * 60000);
  return { consecutive_failures, next_retry_at: failed ? atOf(now + delay) : null };
}
export async function runLinkedInInbox({force=false,now=Date.now(),run=null,thread_url=null,record_id=null,job_id=process.env.RADAR_JOB_ID || null,session=linkedinSession()}={}) {
  let state=read(STATE_PATH,{}) || {};
  const skip=linkedinInboxGate({force,now,state,session});
  if(skip)return {status:'skipped',reason:skip};
  if(!force&&!run&&!await liveHost())return {status:'skipped',reason:'专用 Chrome 已关闭，自动检查等待下次由你打开'};
  const url=thread_url ? linkedinThread(thread_url) : null;
  if(thread_url&&!url)throw Object.assign(Error('需要 LinkedIn 原消息线程链接'),{status:400});
  const leadRows=lines('state/leads.ndjson');
  if(record_id&&!leadRows.some(l=>keyOf(l)===record_id))throw Object.assign(Error('没有这条线索'),{status:404});
  let release;
  try {release=lock('linkedinread');} catch(e){if(e.message!=='another_radar_writer_running')throw e;return {status:'skipped',reason:'另一轮正在检查 LinkedIn，请等待它完成'};}
  let job;
  try {
    job=job_id ? J.get(job_id) : J.create({kind:'linkedin-inbox',member:'owl',title:'检查 LinkedIn 网页消息',origin:force?'card':'schedule',target:record_id,now});
    if(!job)throw Error('检查任务不存在');
    if(job.state==='queued')J.transition(job.id,'start',{pid:process.pid,now});
    write(STATE_PATH,{...state,status:'checking',reason:'正在读取 LinkedIn 原线程',started_at:atOf(now),job_id:job.id});
    const known=[...new Set([...Object.keys(state.threads || {}),...lines('state/inbox-events.ndjson').filter(e=>e.record_id).map(e=>linkedinThread(e.thread_url || e.url)).filter(Boolean),...leadRows.flatMap(l=>[l.linkedin_thread_url,l.reply_url,l.url,l.contact_url]).map(linkedinThread).filter(Boolean)])];
    const offset=(state.cursor || 0)%Math.max(known.length,1), rotated=[...known.slice(offset),...known.slice(0,offset)];
    if(!run)({runBrowserScript:run}=await import('./browser-run.mjs'));
    const result=await run(linkedInScript({targets:url?[url]:rotated,cursor:state.cursor || 0,maxThreads:url?1:12,onlyTarget:!!url,hidden:!force}),{timeout:240000,maxBuffer:8*1024*1024,...(!force?{env:{...process.env,RADAR_BROWSER_EXISTING_ONLY:'1'}}:{})});
    if(!result || !Array.isArray(result.threads))throw Error('LinkedIn 读取结果格式不完整');
    if(!result.threads.length&&result.status==='ok'&&(result.errors?.length||url))result.status='failed';
    const releaseIngest=await waitForLock('linkediningest',{timeout:10000,interval:25});
    let r;
    try {
    const events=lines('state/inbox-events.ndjson'), leads=lines('state/leads.ndjson'), messages=lines(MESSAGES_PATH);
    if(record_id&&url&&result.threads.length){const t=result.threads.find(t=>linkedinThread(t.url)===url);const linked=t&&linkLinkedInThread(t,{leads,events,state});if(!linked||keyOf(linked)!==record_id)throw Error('该 LinkedIn 线程无法唯一关联到指定线索，未写入来信');}
    r=recordLinkedInThreads(result.threads,{leads,events,messages,state,now:Date.now()});
    if(result.threads.length){writeLines(MESSAGES_PATH,messages);writeLines('state/inbox-events.ndjson',events);writeLines('state/leads.ndjson',leads);}
    } finally {releaseIngest();}
    const status=REASON[result.status]?result.status:result.errors?.length||result.partial||r.unknown?'partial':'ok';
    const timedOut=status==='failed'&&result.errors?.some(e=>/timeout|timed out/i.test(e.error || ''));
    const reason=(timedOut?'LinkedIn 网页打开超时，尚未确认是否有新消息':REASON[status]) || `检查了 ${r.conversations} 个线程，${r.raised ? `${r.raised} 条新来信已关联岗位` : '没有新来信提醒'}${r.reconciled ? `，${r.reconciled} 条历史来信显示已纠正` : ''}${r.unlinked ? `，${r.unlinked} 条待确认关联` : ''}${status==='partial'?'；部分线程未读完，下次继续':''}`;
    const checkedAt=Date.now(),retry=retryState(state,status,checkedAt,result.errors || []);
    state={...r.state,status,reason:reason+(retry.next_retry_at?`；自动重试至少间隔 ${Math.round((Date.parse(retry.next_retry_at)-checkedAt)/60000)} 分钟，仍可手动检查`:''),checked_at:atOf(checkedAt),started_at:atOf(now),job_id:job.id,...retry,
      conversations:r.conversations,received:r.received,raised:r.raised,logged_out_at:status==='login_required'?atOf(now):null,partial:status==='partial',cursor:(state.cursor || 0)+6,errors:result.errors || []};
    write(STATE_PATH,state);
    const links=[{label:'收件箱',href:'#inbox'},{label:'LinkedIn 消息',href:INBOX_URL}];
    if(['login_required','verification_required'].includes(status))J.drive(job.id,'waiting_you',{reason,what:{label:'打开 LinkedIn 登录与消息',href:INBOX_URL}});
    else if(status==='failed')J.drive(job.id,'failed',{reason});
    else J.drive(job.id,'done',{result:{summary:reason,counts:{conversations:r.conversations,received:r.received,raised:r.raised,unlinked:r.unlinked},links}});
    event('owl','linkedin-inbox',status==='failed'?'fail':'ok',reason,{job_id:job.id});
    return {...linkedinInboxView({state}),job_id:job.id};
  } catch(e) {
    const status=/site_check:/.test(String(e.message))?'verification_required':'failed',reason=REASON[status]+`：${String(e.message || e).slice(0,180)}`;
    const checkedAt=Date.now(),retry=retryState(state,status,checkedAt);
    write(STATE_PATH,{...state,status,reason:reason+`；自动重试至少间隔 ${Math.round((Date.parse(retry.next_retry_at)-checkedAt)/60000)} 分钟，仍可手动检查`,checked_at:atOf(checkedAt),started_at:atOf(now),job_id:job?.id || null,...retry});
    if(job&&['queued','running'].includes(J.get(job.id)?.state))J.drive(job.id,'failed',{reason});
    event('owl','linkedin-inbox','fail',reason,{job_id:job?.id});
    return {...linkedinInboxView(),job_id:job?.id || null};
  } finally {release();}
}
export function linkedinBrowserAsks({state=read(STATE_PATH,{}) || {}}={}) {
  const unlinked=state.unlinked || [];
  if(!unlinked.length)return [];
  const sig=hash(unlinked.map(m=>m.id)).slice(0,16);
  if(state.ack===sig)return [];
  return [{from:'watch',id:`linkedin-browser:${sig}`,type:'info',title:'LinkedIn · 待关联来信',question:`${unlinked.length} 条真实来信未能唯一对上岗位`,
    detail:unlinked.map(m=>`${m.from}：${m.body}`).join('\n\n'),
    options:[{key:'1',label:'打开 LinkedIn 消息',primary:true,steps:[{type:'open',url:unlinked.length===1?unlinked[0].thread_url:INBOX_URL}]},
      {key:'2',label:'知道了',steps:[{type:'linkedin_browser',sig}]}],other:null}];
}
export function ackLinkedInBrowser(sig){const state=read(STATE_PATH,{}) || {};write(STATE_PATH,{...state,ack:sig});return '已收起来；下次有新来信再提醒';}
