import {bindCommand,openDraftEditor,setHelpers,bindActions,sysfixButton} from './command.js';
import {inboxPage,bindInbox,bindInboxKeys,initInboxFilter,inboxSig,inboxShown,inboxNow,inboxPrefetch,paintBadge} from './inbox.js';
import './setup.js';
import { initSidebar } from './sidebar.js';
import {eventGroups,eventTitle,recovery} from './stream.js';
import {bindEvidenceLinks} from './evidence-view.js';
import {visibleEvidenceRef} from './evidence-summary.js';
import {evidenceLabel} from './labels.js';
import {askConfirm} from './settings/ask.js';
import './codex-login.js';
import './model-settings.js';
import {guidePage,bindGuide} from './onboarding.js';
import {settingsPage,bindSettingsPage,legacyTarget,settingsToken,settingsNow} from './settings/shell.js';
import {loadFirstRun,firstRunState,bootTarget,setupTarget} from './first-run.js';
import {paintPill} from './usage.js';
import {initAccount,openLogin,loginGate} from './account.js';
import {hqPage,bindHq,hqSig,initHq,crewRefresh,leadPage,bindLead,leadSig,setViewing,leadFromPage,leadOriginHas,setLeadOrigin,hqNow,leadNow} from './hq.js';
import {initTalk,talkUpdate,talkPaint} from './talk.js';
import {initPanel} from './panel.js';
import {mountAppUpdate} from './desktop.js';
import {resumePage,bindResume,resumeSig,resumeNow,resumeMorphs} from './resume.js';
import {teamPage,bindTeam,teamSig,teamNow,teamPrefetch} from './team.js';
import {tasksPage,tasksAfter,tasksSig,initTasks,tasksNow,tasksPrefetch,holdTasksPaint} from './tasks.js';
import {morph} from './morph.js';
import {resolve} from './routes.js';
import {block,changed,parseChange,ALL} from './live.js';
const $=s=>document.querySelector(s), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 本地时区：bin/serve.mjs 把 config/host.json 的时区（lib/tz.mjs）写进 <meta name="radar-tz">；没有就用浏览器所在时区。
const TZ=(typeof document!=='undefined'&&document.querySelector('meta[name="radar-tz"]')?.content)||undefined;
const fmt=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:TZ,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'暂无记录';
const clock=x=>x?new Date(x).toLocaleTimeString('zh-CN',{timeZone:TZ,hour:'2-digit',minute:'2-digit'}):'—';
const safeUrl=x=>{try{const u=new URL(x);return ['http:','https:'].includes(u.protocol)?esc(u.href):'';}catch{return '';}};
const link=(url,label)=>safeUrl(url)?`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`:esc(label);
const leadUrl=id=>`#lead/${encodeURIComponent(id)}`;
const names={team:'团队',tasks:'任务',inbox:'收件箱',materials:'材料',onboarding:'开始使用',command:'指挥台',stream:'运行日志',settings:'设置',lead:'岗位'}, actorOf=e=>data?.crew?.[e.member]?.label||e.actor,crewName=id=>data?.crew?.[id]?.name||data?.crew?.[data?.crew_legacy?.[id]]?.name||id, statuses={start:'进行中',ok:'完成',fail:'失败',skip:'无变化',waiting_user:'等待下一步'};
let prevPage=null, prevHash='#command', data, busy=false, dirty=false, page='command', flow='all', actionState;
// action：{label, run}，在提示后面放一个按钮（比如回执里的「打开登录页」，不把整条链接印出来）。
function toast(s,action=null){const t=$('#toast');t.textContent=s;if(action){const b=document.createElement('button');b.type='button';b.className='toast-act';b.textContent=action.label;b.onclick=()=>{t.style.display='none';action.run();};t.append(b);}t.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display='none',action?12000:6000);}
// 页面自己出的错（换页、就地更新、绑按钮）：不再只变成一条提示就完了（静默兜底，3a 的「解除配对」就是被它藏住的）。
// 给你一句人话；控制台记原文、哪一页、哪一步。服务端发来的错（接口回的中文原因）照原话说；连不上本机服务的亮「本地服务离线」。
// 原文也记进运行日志（/api/client-error），归 System。
const offline=e=>e instanceof TypeError&&/fetch|network|load failed/i.test(String(e.message));
const serverSaid=e=>e?.name==='Error'&&/[\u4e00-\u9fff]/.test(String(e.message||''));
function pageError(step,e,p=pageOfHash()){
  if(offline(e)){setConnection(false);console.error('[OfferCrew 页面]',{page:p,step,hash:location.hash,offline:true},e);return;}
  console.error('[OfferCrew 页面]',{page:p,step,hash:location.hash},e);
  /* 同样的内容记进运行日志（bin/serve.mjs /api/client-error，服务端去掉钥匙、10 分钟同一句只记一次）；记不进去不再报，免得错上加错 */if(data?.token)fetch('/api/client-error',{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':data.token},body:JSON.stringify({page:names[p]||p,step,message:String(e?.message||e).slice(0,1000),stack:String(e?.stack||'').slice(0,3000)})}).catch(()=>{});
  // 后台每推一次就再错一次的：同一页、同一步、同一句一分钟内只说一次（控制台每次都记）。
  const k=`${p}|${step}|${e?.message}`;if(pageError.last?.k===k&&Date.now()-pageError.last.at<60000)return;pageError.last={k,at:Date.now()};
  toast(serverSaid(e)?e.message:`「${names[p]||'这一页'}」没显示完整：页面出了错，刷新一下再看。`);
}
// 指挥台页面用到的公共助手；post 带同源 token，与岗位反馈同一套校验。
// 连接只在断了的时候说一句（右上角一个小条）；连着的时候什么都不显示。
// 左栏「收件箱」后面的数字：指挥台和收件箱自己拉的数据里就有（web/hq.js、web/inbox.js），别的页拉一个数（视觉验收第 10 条）。
function inboxBadge(){fetch('/api/inbox/count').then(r=>r.ok?r.json():null).then(d=>{if(d)paintBadge(d.total);}).catch(()=>{});}
function setConnection(ok,more=''){const el=$('#connection');if(!el)return;el.hidden=ok;el.innerHTML=ok?'':`<span class="dot fail"></span> 本地服务离线${more?' · '+more:''}`;}
const helpers={esc,fmt,clock,link,leadUrl,toast,crewName,pageError:(step,e)=>pageError(step,e),token:()=>data?.token||'',refresh:o=>refresh(o),post:async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':data.token},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d;}};
setHelpers(helpers)
initAccount(helpers);
initInboxFilter();
// 右侧面板（web/panel.js）只放对话（web/talk.js，⌘K、/、右下角「问」都打开它）；岗位详情在主区的岗位页（web/hq.js）。
// 旧的 #chat 链接打开面板里的那段对话。它们自己拉状态，跟着下面的 SSE 更新。
// 第 5 轮：没登录时这些都不起、不拉数据（以前退出以后，整页登录门后面的旧对话还在页面里，辅助功能读得到）。
let gatePassed=false;const gated=loginGate().then(()=>{gatePassed=true;initPanel();initHq(helpers);initTalk(helpers);initTasks();initSidebar();mountAppUpdate();});
function heading(k,title,sub,extra=''){return `<div class="page-heading"><div>${k?`<span class="eyebrow">${k}</span>`:''}<h1>${title}</h1>${sub?`<p class="subtitle">${sub}</p>`:''}</div>${extra}</div>`;}
function panel(title,body,extra='',cls=''){return `<section class="panel ${cls}"><div class="panel-heading"><h2>${title}</h2>${extra}</div>${body}</section>`;}
function refs(rs=[]){return `<div class="refs">${rs.map(r=>{const f=r.file||r.screenshot;return visibleEvidenceRef(f)?`<a href="/api/evidence?file=${encodeURIComponent(f)}" target="_blank" rel="noopener">${esc(evidenceLabel(f))}</a>`:r.url?link(r.url,'原始页面'):f?'<span class="muted small">内部记录，不在这里预览</span>':'';}).join('')}</div>`;}
function eventRow(e){return `<div class="event-row ${esc(e.status)}"><span class="event-dot"></span><div class="event-text"><p>${esc(e.text||e.msg||e.step)}</p><small>${esc(actorOf(e))} · ${esc(statuses[e.status]||e.status)}${e.duration_ms!=null?' · '+(e.duration_ms/1000).toFixed(1)+'s':''}${e.historical?' · 旧日志读取':''}</small>${refs(e.refs)}${e.lead_id?`<a href="${leadUrl(e.lead_id)}">查看岗位 →</a>`:''}</div><time class="event-time">${fmt(e.ts)}</time></div>`;}
function health(label,value,note,state='warn'){return `<div class="health"><div class="health-label">${label}</div><div class="health-value"><span class="dot ${state}"></span>${esc(value)}</div><small>${esc(note)}</small></div>`;}
let streamQ='', streamScope={}, streamPage=1, streamLeadOnly=false, streamResult=null, streamLoad=null;
const streamQuery=()=>new URLSearchParams({q:streamQ.trim(),flow,...streamScope,leadOnly:streamLeadOnly?'1':'0',page:String(streamPage)}).toString();
function stream(){
  const byId=new Map();for(const l of [...data.leads,...(streamResult?.leads||[])]){if(l.id)byId.set(l.id,l);if(l.record_id)byId.set(l.record_id,l);}
  const es=streamResult?.events||[], groups=eventGroups(es), pages=streamResult?.pages||1;
  streamPage=streamResult?.page||streamPage;
  const slice=groups;
  const pager=`<div class="pager"><span class="muted small">${streamResult?.total||0} 条事件 · ${streamResult?.runs||0} 次运行${pages>1?` · 第 ${streamPage} / ${pages} 页`:''}</span><span class="grow"></span>${pages>1?`<button type="button" class="chip act" data-stream-page="${streamPage-1}" ${streamPage<=1?'disabled':''}>‹ 上一页</button><button type="button" class="chip act" data-stream-page="${streamPage+1}" ${streamPage>=pages?'disabled':''}>下一页 ›</button>`:''}</div>`;
  const runActions=(id,rows)=>{const next=recovery(rows);return next?`<span class="run-actions"><a class="secondary mini" href="${esc(next.href)}">${esc(next.label)}</a></span>`:'';};
  const leadActions=e=>{const l=e.lead_id&&byId.get(e.lead_id);if(!l)return '';return `<span class="event-lead"><a href="${leadUrl(l.record_id||l.id)}">${l.number!=null?`#${esc(l.number)} `:''}${esc(l.company||'')}</a> <span class="muted">${esc(l.role||'')}</span></span>`;};
  const eventRowX=e=>`<div class="event-row ${esc(e.status)}"><span class="event-dot"></span><div class="event-text"><p>${esc(e.text||e.msg||e.step)}</p><small>${esc(actorOf(e))} · ${esc(statuses[e.status]||e.status)}${e.duration_ms!=null?' · '+(e.duration_ms/1000).toFixed(1)+'s':''}${e.historical?' · 旧日志读取':''}</small>${refs(e.refs)}${leadActions(e)}</div><time class="event-time">${clock(e.ts)}</time></div>`;
  return heading('高级 · 排查问题','运行日志','按时间追溯每一步的执行与失败；任务进度和业务结果回到对应任务查看。','<a class="secondary" href="#tasks">查看任务</a>')+(Object.keys(streamScope).length?'<div class="stream-scope"><span>只看这件任务的运行记录</span><button type="button" class="chip act" data-stream-clear-scope>全部日志</button></div>':'')+`<div class="filters"><select id="flow-filter" aria-label="过滤运行日志">${[['all','全部事件'],['fail','仅失败'],...Object.entries(data.crew||{}).map(([v,c])=>[v,c.label])].map(([v,n])=>`<option value="${v}" ${flow===v?'selected':''}>${n}</option>`).join('')}</select><input id="stream-q" type="search" placeholder="搜一句话、岗位编号或公司" aria-label="搜运行日志" value="${esc(streamQ)}"><label class="chip quiet stream-lead"><input type="checkbox" id="stream-lead-only" ${streamLeadOnly?'checked':''}>只看涉及岗位的</label></div>`+pager+(slice.map(([id,rows],i)=>`<details class="run" data-run="${esc(id)}" ${i<2?'open':''}><summary><span class="dot ${rows.some(e=>e.status==='fail')?'fail':''}"></span>${esc(eventTitle(id,rows,data.crew,byId))}<small>${fmt(rows[0].ts)} · ${rows.length} 步 · ${rows.filter(e=>e.status==='fail').length} 次失败</small>${runActions(id,rows)}</summary><div class="timeline">${[...rows].reverse().map(eventRowX).join('')}</div></details>`).join('')||'<div class="empty">这个筛选下还没有事件。</div>')+(slice.length>5?pager:'');
}
// 岗位页（#lead/<rid>）在 web/hq.js 的 leadPage：原来的完整详情和指挥台右侧抽屉合成一页（布局 v3.1）。
// 换页（第 3 步「页面」）：点菜单、改地址，主区当场换成这一页——手上有这一页的数据就按它先画（各页的 xxxNow），
// 没有就先放这一页的标题；拉回来的新数据按 id 就地更新（web/morph.js），不整页重画，选中、滚动、焦点、输入的字都留着。
// 离开一页时把画好的 DOM 连同滚动位置收起来（kept），五分钟内回到同一个地址、主区宽度没变，直接放回去。
// shownSig：主区现在这份是按哪个内容签名画的（后台刷新跟它比，签名没变就不动）。
let shownSig='';
// lastHashOf[页]：这一页最后一次画的是哪个地址。放回收起来的 DOM 时，模块里的状态（设置的分类、团队页的成员、任务页的筛选）要对得上。
const lastHashOf={};
const KEEP=new Set(['command','team','tasks','inbox','materials','settings']), KEEP_MS=5*60000, kept=new Map();
const sigNow=p=>({command:hqSig,lead:leadSig,tasks:tasksSig,inbox:inboxSig,materials:resumeSig,team:teamSig}[p]?.()??'');
// 每页关心哪几张表（web/live.js）：推来的变化不碰这些表，这一页不重拉。设置、记忆什么都看。
const PAGE_TABLES={command:['jobs','actions','leads','drafts','asks','events'],lead:['leads','actions','drafts','asks','jobs','receipts'],tasks:['jobs','actions','asks','leads','drafts'],inbox:['asks','actions','drafts','leads','jobs'],team:['jobs','actions','events','config','leads'],materials:['resume','drafts','config'],stream:['events','jobs'],settings:ALL,onboarding:[]};
// 岛（web/morph.js）：设置的右半边由各分类自己用 addEventListener 绑，不往里比，变了整块换、换了才重绑。
const ISLANDS={settings:'.st-page'};
// 整块换的页：引导页，材料的编辑 / 对比 / 信（可编辑区和它们自己的事件）。内容没变就不动，变了照旧整块换。
const replaceMode=p=>p==='onboarding'||(p==='materials'&&!resumeMorphs());
const teamSub=()=>decodeURIComponent(location.hash.split('?')[0].split('/')[1]||'')||null;
// 手上有数据就同步拼出这一页（没有返回 null）。看板、运行日志本来就是同步画的，不在这里。
function instant(p){try{return ({command:hqNow,lead:()=>leadNow(decodeURIComponent(resolve(location.hash)?.rest[0] || '')),tasks:tasksNow,inbox:inboxNow,team:()=>teamNow(teamSub()),materials:resumeNow,settings:settingsNow}[p]?.())??null;}catch(e){/* 先画失败：照旧去拉，拉回来的会画上；只记控制台，不打扰 */console.error('[OfferCrew 页面]',{page:p,step:'先画',hash:location.hash},e);return null;}}
const skeleton=p=>`<div class="page-heading page-loading" aria-busy="true"><div><h1>${esc(names[p]||'')}</h1></div></div>`;
function stashPage(){const main=$('#main'),h=main.dataset.renderHash,p=main.dataset.page;if(!h||!KEEP.has(p)||!main.firstChild||main.querySelector('.page-loading'))return;const scroll=[...main.querySelectorAll('[data-scroll-key]')].map(e=>[e.dataset.scrollKey,e.scrollTop,e.scrollLeft]);const frag=document.createDocumentFragment();frag.append(...main.childNodes);kept.delete(h);kept.set(h,{frag,page:p,sig:shownSig,html:main.__html,onclick:main.onclick,scroll,y:window.scrollY,w:main.clientWidth,at:Date.now()});while(kept.size>KEEP.size)kept.delete(kept.keys().next().value);}
function restorePage(h,p){const e=kept.get(h),main=$('#main');kept.delete(h);if(!e||e.page!==p||lastHashOf[p]!==h||Date.now()-e.at>KEEP_MS||e.w!==main.clientWidth||document.querySelector('dialog[open]'))return false;
// 历史预览只局部换版，不改地址；带 v 的材料首页必须重新按地址选版，不能还原该地址下后来选过的旧 DOM。
const r=p==='materials'?resolve(h):null;if(r&&!r.rest.length&&r.params.get('v'))return false;
stashPage();main.replaceChildren(e.frag);main.__html=e.html;main.dataset.renderHash=h;main.dataset.page=p;shownSig=e.sig;main.onclick=e.onclick;
for(const [k,top,left] of e.scroll){const el=main.querySelector(`[data-scroll-key="${CSS.escape(k)}"]`);if(el){el.scrollTop=top;el.scrollLeft=left;}}window.scrollTo(0,e.y);
prevPage=p;prevHash=h;
// 主区正在看的岗位：收件箱报它选中的那封，别的页没有（和下面画完以后一样）。指挥台再绑一次（只是属性赋值；从岗位页「←」回来的滚动位置）。
if(p==='inbox')inboxShown();else setViewing(null);if(p==='command')bindHq();talkPaint();return true;}
// 把一页画进主区。同一页：按 id 就地更新（整块换的页内容没变就不动）；换了页：清空再放。画完绑这一页的按钮（各页的绑定可以重复调）。
function paint(html,renderHash,p,{skel=false}={}){
if(p==='tasks'&&holdTasksPaint(renderHash))return; // 正在拖动时连普通 refresh 也等松手后再画，导航仍照常。
const main=$('#main'),samePage=main.dataset.page===p&&!!main.firstChild,scrollY=window.scrollY;let swapped=null,bound=true;
if(!samePage){stashPage();kept.delete(renderHash);main.innerHTML='';}
if(skel){main.innerHTML=html;main.__html=null;}
else if(replaceMode(p)){if(!samePage||main.__html!==html){const sc=samePage?[...main.querySelectorAll('[data-scroll-key]')].map(e=>[e.dataset.scrollKey,e.scrollTop,e.scrollLeft]):[];main.innerHTML=html;for(const [k,t,l] of sc){const el=main.querySelector(`[data-scroll-key="${CSS.escape(k)}"]`);if(el){el.scrollTop=t;el.scrollLeft=l;}}}else bound=false;}
else{try{swapped=morph(main,html,{islands:ISLANDS[p]||null});}catch(e){/* 就地更新出错：整块换成新的（内容是对的），照样报出来 */pageError('就地更新',e,p);main.innerHTML=html;swapped=null;}}
if(!skel)main.__html=html;
main.dataset.renderHash=renderHash;main.dataset.page=p;lastHashOf[p]=renderHash;prevPage=p;prevHash=renderHash;
if(!skel){shownSig=sigNow(p);if(bound){try{bindPage(p,swapped);}catch(e){pageError('绑按钮',e,p);}}}
// 主区正在看的岗位（对话里的「正在看 #12」）：岗位页、收件箱自己报；别的页没有。
if(skel||!['lead','inbox'].includes(p))setViewing(null);
talkPaint();
if(!samePage)window.scrollTo(0,0);else if(replaceMode(p))window.scrollTo(0,scrollY);
}
function bindPage(p,swapped){
if(p==='settings')bindCommand()
if(p==='settings')bindSettingsPage(swapped);
if(p==='command'){bindHq();}
if(p==='inbox'){bindInbox();bindInboxKeys()}
if(p==='onboarding')bindGuide();
if(p==='materials')bindResume();
if(p==='team')bindTeam();
if(p==='tasks')tasksAfter();
if(p==='stream'){bindActions();const scopeClear=$('[data-stream-clear-scope]');if(scopeClear)scopeClear.onclick=()=>{streamScope={};streamPage=1;render();};const qi=$('#stream-q');if(qi){qi.oninput=()=>{streamQ=qi.value;streamPage=1;clearTimeout(qi._t);qi._t=setTimeout(()=>render(),250);};}const lo=$('#stream-lead-only');if(lo)lo.onchange=()=>{streamLeadOnly=lo.checked;streamPage=1;render();};document.querySelectorAll('[data-stream-page]').forEach(b=>b.onclick=()=>{streamPage=Number(b.dataset.streamPage);render();});document.querySelectorAll('[data-rerun]').forEach(b=>b.onclick=async()=>{if(!(await askConfirm({title:'重跑一次轻量周期？',lines:['团队把这一轮再走一遍：读新消息、推进手上的线索，不调匹配模型。'],go:'重跑'})))return;b.disabled=true;try{const r=await helpers.post('/api/ops',{op:b.dataset.rerun});toast(`已开始「${r.label}」`);}catch(e){toast(e.message);b.disabled=false;}});$('#flow-filter').onchange=e=>{flow=e.target.value;render();};}
if(p==='lead')bindLead();
}
// 没打开过的页先把数据拉下来（第一次点过去也能当场画）：首屏画完后空闲时按顺序拉一遍，鼠标移到左栏上时再补。
const PREFETCH={tasks:tasksPrefetch,inbox:inboxPrefetch,team:teamPrefetch};
const prefetch=p=>PREFETCH[p]?.(helpers)??Promise.resolve();
let prefetched=false;
function prefetchIdle(){if(prefetched)return;prefetched=true;const go=async()=>{for(const p of ['tasks','inbox','team'])if(pageOfHash()!==p)await prefetch(p);};(window.requestIdleCallback||(f=>setTimeout(f,1500)))(()=>go().catch(()=>{}),{timeout:4000});}
document.querySelectorAll('nav a[data-page]').forEach(a=>{a.addEventListener('pointerenter',()=>{if(gatePassed)prefetch(a.dataset.page).catch(()=>{});});});
// 各页模块要「按现在手上的数据马上重画一次」时调（点了筛选、换了一件：先画，新数据回来再就地更新）。
helpers.paintNow=html=>{const main=$('#main');if(!main||!main.dataset.page)return;paint(html,location.hash,main.dataset.page);};
// soft=true 来自后台更新（推送）：内容签名没变就什么都不动。
async function render({soft=false}={}){if(!gatePassed)return;if(holdTasksPaint(location.hash))return;{const t=legacyTarget(location.hash);if(t)history.replaceState(null,'',t);}
// 地址落在哪一页：lib/routes.mjs 一张表（旧页名 #board #memory #log #resume #usage #overview #wait/ 在那里换成现在的地址，参数照带）。
// 认不出的页名：地址也换成 #command（以前主区画指挥台、地址还留着那个名字，两样对不上）。面板地址（#chat、#talk）只开对话，主区回到原来那页。
{const r=resolve(location.hash);const to=!r?'#command':r.panel?(prevHash||'#command'):r.hash;if(location.hash&&to!==location.hash&&!r?.handled)history.replaceState(null,'',to);}
// 运行日志的 flow / run / q（任务卡「看运行日志」、成员页的链接）：认一次，填进筛选，地址换回 #stream。
{const r=resolve(location.hash);if(r?.page==='stream'&&[...r.params.keys()].length){const p=r.params;flow=p.get('flow')||'all';streamLeadOnly=false;streamScope=Object.fromEntries(['run','job','action','task'].filter(k=>p.get(k)).map(k=>[k,p.get(k)]));streamQ=p.get('q')||'';streamPage=1;history.replaceState(null,'','#stream');}else if(r?.page==='stream'&&page!=='stream'){streamScope={};}}
let renderHash=location.hash;page=(location.hash.slice(1).split(/[/?]/)[0]||'command');if(page==='setup'){location.replace(setupTarget(firstRunState()));return;}if(soft&&page==='onboarding')return;if(page==='login'){openLogin();location.replace(prevHash&&prevHash!=='#login'?prevHash:'#command');return;}if(!names[page])page='command';document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('active',a.dataset.page===page||(page==='lead'&&a.dataset.page===leadFromPage())));if(!data)return;if(!soft&&KEEP.has(page)&&restorePage(renderHash,page)){render({soft:true}).catch(e=>pageError('后台更新',e));return;}const renderedPage=page;let html;
if(page==='lead'){const id=decodeURIComponent(resolve(location.hash)?.rest[0] || '');if(prevPage&&prevPage!=='lead'&&!leadOriginHas(id))setLeadOrigin({hash:prevHash,label:names[prevPage]||'指挥台',list:[id],rid:id});}
// 立刻换：先画手上有的，再去拉。
if(!soft&&page!=='stream'){const now=instant(page);if(now!=null)paint(now,renderHash,page);else if($('#main').dataset.page!==page)paint(skeleton(page),renderHash,page,{skel:true});}
if(page==='lead'){const id=decodeURIComponent(resolve(location.hash)?.rest[0] || ''),before=leadSig();html=await leadPage(helpers,id,{tab:resolve(renderHash)?.params.get('tab')});if(location.hash!==renderHash)return;if(soft&&before&&before===leadSig()&&shownSig===before&&$('#main').dataset.renderHash===renderHash)return}
else if(page==='command'){const before=hqSig(),same=soft&&$('#main').dataset.renderHash===renderHash;html=await hqPage(helpers,{unless:same?shownSig:null});if(html===null||same&&before&&before===hqSig()&&shownSig===before)return}
// 设置（web/settings/）：左栏分类 + 一类一页 + 搜索；后台刷新时内容没变就不动。
else if(page==='settings'){const r=await settingsPage(helpers,{soft:soft&&$('#main').dataset.renderHash===renderHash});if(r===null)return;if(settingsToken()&&data)data.token=settingsToken();html=r;}
else if(page==='onboarding'){html=await guidePage(helpers)}
else if(page==='materials'){
  const before=resumeSig();
  html=await resumePage({...helpers,adoptHash:(from,to)=>{
    // 已有草稿把 vN 解析为 dN：只同步本轮仍在看的地址，导航跳走仍由下方守卫拒绝。
    if(location.hash!==from||renderHash!==from)return false;
    history.replaceState(null,'',to);renderHash=to;return true;
  }});
  if(html===null||soft&&before&&before===resumeSig()&&shownSig===before&&$('#main').dataset.renderHash===renderHash)return;
}
else if(page==='team'){const before=teamSig();html=await teamPage(helpers,teamSub());if(soft&&before&&before===teamSig()&&shownSig===before&&$('#main').dataset.renderHash===renderHash)return}
else if(page==='tasks'){const before=tasksSig();html=await tasksPage(helpers);if(soft&&before&&before===tasksSig()&&shownSig===before&&$('#main').dataset.renderHash===renderHash)return}
else if(page==='inbox'){const before=inboxSig();html=await inboxPage(helpers);if(soft&&before&&before===inboxSig()&&shownSig===before&&$('#main').dataset.renderHash===renderHash)return}
else {
  const query=streamQuery(), key=`${query}:${data?.content_sig||''}`;
  if(streamLoad?.key!==key)streamLoad={key,promise:fetch(`/api/event-history?${query}`).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'运行日志读取失败');return d;})};
  let result;try{result=await streamLoad.promise;}catch(e){if(streamLoad?.key===key)streamLoad=null;throw e;}
  if(query!==streamQuery()||location.hash!==renderHash)return;
  streamResult=result;html=stream();
}
if(location.hash!==renderHash)return;
paint(html,renderHash,renderedPage);
}
// 整份快照（20 MB 线索文件的全量读取）只有岗位看板、运行日志、运行与用量三页用；其余页自己拉自己的，快照只在首次加载时拉。
// 在别的页上收到「有更新」时快照就旧了（snapStale）：回到这三页先用手上的画出来，紧接着重新拉一次，内容变了再重画
// （10-02 开箱第 2 轮 N14：首轮跑完以后切回运行日志，一直是 13:08 那份）。
const SNAP_PAGES=['stream'], pageOfHash=()=>location.hash.slice(1).split(/[/?]/)[0]||'command';
let snapStale=false;
async function refresh({soft=false,force=false}={}){if(busy){dirty=force?'force':true;return;}busy=true;try{
const needSnapshot=!data||SNAP_PAGES.includes(page)||SNAP_PAGES.includes(pageOfHash());
let unchanged=false;if(needSnapshot){const res=await fetch('/api/snapshot');if(!res.ok)throw Error('数据读取失败');const next=await res.json();unchanged=soft&&!!data&&!!next.content_sig&&next.content_sig===data.content_sig;data=next;snapStale=false;{const ec=$('#event-count');if(ec)ec.textContent=data.events.filter(e=>!e.historical).length||'';}}
setConnection(true);paintPill(helpers).catch(()=>{});if(!['command','inbox'].includes(page))inboxBadge();// 主区里正在打字、或有弹窗开着时不重绘；右侧栏在主区之外，它的输入框不算（见 typing()）。
if(unchanged&&page==='stream')return;/* 就地更新不碰正在打字的框，打字时照样更新；只有弹窗开着、或者在整块换的地方打字时等一等（关了、离开了再更新）。force：打字本身要的那一次（任务页的搜索框） */if(!force&&(document.querySelector('dialog[open]')||typing())){pendingUpdate=true;return;}await render({soft});prefetchIdle();}catch(e){/* 连不上只亮「本地服务离线」；页面自己的错照实报（以前也一并当成离线，错就藏住了） */if(offline(e)||e?.message==='数据读取失败')setConnection(false);else pageError(soft?'后台更新':'刷新',e);}finally{busy=false;if(dirty){const f=dirty==='force';dirty=false;refresh({force:f});}}}
/* 面板、对话的地址监听（#chat… 先由它们处理）在登录以后才挂上，这一个排在它们后面，顺序和以前一样 */gated.then(()=>window.addEventListener('hashchange',()=>render().then(()=>{if(snapStale&&SNAP_PAGES.includes(page))return refresh({soft:true});}).catch(e=>pageError('换页',e))));$('#cancel').onclick=()=>$('#action-dialog').close();$('#action-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const r=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':data.token},body:JSON.stringify({...actionState,reason:$('#reason').value})}),d=await r.json();if(!r.ok)throw Error(d.error);$('#action-dialog').close();toast('已加入队列，服务空闲时约 5 秒内开始处理；尚未发送邮件。');await refresh();}catch(err){toast(err.message);}finally{b.disabled=false;}};
// 第一次打开（还没做完引导的新用户，lib/onboarding-state.mjs）：先换到 #onboarding 再画，不会先闪一下指挥台（web/first-run.js）。
// 10-03 负责人：不登录看不到主界面，登录在最前面（web/account.js loginGate；没配中转、演示沙盒不拦）。
const booted=gated.then(()=>loadFirstRun()).then(s=>{const t=bootTarget(s,location.hash);if(t)history.replaceState(null,'',t);}).catch(()=>{});
// 服务重启（代码更新）后自动刷新页面，避免老标签页跑旧脚本。
let serverStartedAt=null;
const source=new EventSource('/api/events');source.addEventListener('ready',e=>{let started=null;try{started=JSON.parse(e.data||'{}').started_at||null;}catch{}if(serverStartedAt&&started&&started!==serverStartedAt){const typing=(document.querySelector('#talk-input')?.value||'').trim()||(document.querySelector('#cmd')?.value||'').trim()||document.querySelector('dialog[open]');/* 工作台换了新进程：不弹提示（负责人 10-02：进度和状态不打扰），没在输入就直接刷新；正在输入，等输入框空了、对话框关了再刷 */if(typing){serverStartedAt=started;/* 新进程的 token 变了：不换的话「发完这条」就是 403 */fetch('/api/inbox').then(r=>r.json()).then(d=>{if(d.token&&data)data.token=d.token;}).catch(()=>{});const idle=setInterval(()=>{const busy=(document.querySelector('#talk-input')?.value||'').trim()||(document.querySelector('#cmd')?.value||'').trim()||document.querySelector('dialog[open]');if(!busy){clearInterval(idle);location.reload();}},2000);}else{location.reload();return;}}serverStartedAt=started||serverStartedAt;setConnection(true);booted.then(()=>refresh());});let pendingUpdate=false;
// 面板「对话」里打字不挡主区刷新（输入框不在主区里）；「详情」里正在填的回答会被重画冲掉，所以算。
// 在整块换的地方打字（引导页、材料的编辑、设置右半边）：重画会冲掉，要等。别处就地更新不碰正在打字的框，不用等。
function typing(){const a=document.activeElement,main=$('#main');if(!a||!main?.contains(a)||!(['INPUT','TEXTAREA','SELECT'].includes(a.tagName)||a.isContentEditable))return false;const p=main.dataset.page;return replaceMode(p)||!!(ISLANDS[p]&&a.closest(ISLANDS[p]));}
// 登录看守看到登好了（bin/serve.mjs loginSay）：说一句「LinkedIn 登好了」，告诉引导页（offercrew:login），页面跟着刷新打勾（第 6b 轮）。
source.addEventListener('login',e=>{if(!gatePassed)return;let d={};try{d=JSON.parse(e.data||'{}');}catch{}if(d.label)toast(`${d.label} 登好了`);try{window.dispatchEvent(new CustomEvent('offercrew:login',{detail:d}));}catch{}refresh({soft:true});});
// 后台变化（web/live.js）：每一块只管自己关心的表。服务端每 200 毫秒推一批 changes（哪张表、哪几行）；不带表的 update 当作全变了。
const onChange=e=>{if(!gatePassed)return;changed(parseChange(e.data));};
source.addEventListener('update',onChange);source.addEventListener('changes',onChange);
block('page',()=>PAGE_TABLES[pageOfHash()]??ALL,()=>refresh({soft:true}));
block('snapshot',['leads','events','jobs'],()=>{snapStale=true;});
block('talk',['jobs','actions','asks','drafts','leads','talk'],()=>talkUpdate());
block('crew',['leads','jobs','asks','actions'],()=>{crewRefresh();});
// 弹窗关了、离开了整块换的输入框：补上刚才等着的那次更新。
const catchUp=()=>setTimeout(()=>{if(pendingUpdate&&!typing()&&!document.querySelector('dialog[open]')){pendingUpdate=false;refresh({soft:true});}},0);
// 电脑休眠后切回来主动核对状态，不等旧 SSE 连接自己超时。
const wakeRefresh=()=>{if(document.visibilityState==='visible'&&gatePassed){snapStale=true;refresh({soft:true});talkUpdate();}};
document.addEventListener('visibilitychange',wakeRefresh);window.addEventListener('pageshow',wakeRefresh);
document.addEventListener('focusout',catchUp);document.addEventListener('close',catchUp,true);source.onerror=()=>{snapStale=true;setConnection(false,'重连中');};booted.then(()=>refresh());
// 各页自己的点击、局部重画里没接住的错：只管我们自己的脚本（别的扩展、浏览器插件的不算）。
const ours=e=>{const st=String(e?.stack||'');return st.includes(location.origin);};
window.addEventListener('error',ev=>{if(ev.filename?.startsWith(location.origin)||ours(ev.error))pageError('点击或局部更新',ev.error||Error(ev.message));});
window.addEventListener('unhandledrejection',ev=>{if(ours(ev.reason)||serverSaid(ev.reason))pageError('点击或局部更新',ev.reason);});
// 证据和日志在页面里看，不开新窗口（web/evidence-view.js）。
bindEvidenceLinks(document, { leads: () => data?.leads || [] });
