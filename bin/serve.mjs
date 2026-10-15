import { sandboxed, sandboxModels, sandboxSkip } from '../lib/sandbox.mjs'; // 最先：演示 / 沙盒模式的闸（--sandbox、RADAR_SANDBOX=1 或 state/sandbox.json；--sandbox-models / RADAR_SANDBOX_MODELS=1 放行文字模型）
import { checkLocalCli } from '../lib/local-ai-check.mjs';
import { detectRuntimes } from '../lib/local-runtimes.mjs';
import '../lib/tool-path.mjs'; // 补齐 launchd 精简 PATH 里缺的工具目录（lark-cli 在 nvm 里）
import { showApplicationPage, checkKeptPages } from '../lib/application-page.mjs';
import { alertsPost } from '../lib/alert-rules.mjs';
import { recoverPortalSession } from '../lib/portal-recovery.mjs';
import { notFoundPage, isDocumentRequest } from '../lib/not-found.mjs';
import { BRAND } from '../lib/brand.mjs';
import { checkRequest, workbenchKey, keyInUrl, setCookie, LOCKED_PAGE } from '../lib/local-auth.mjs';
import {execFile, spawn} from '../lib/spawn.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { file, arg, lines, root, read } from '../lib/store.mjs';
import { snapshot, detail, queueFeedback, evidencePath, searchEvents } from '../lib/dashboard.mjs';
import { traceView, leadFile, resumeUsed, resumeDefault } from '../lib/lead-trace.mjs';
import { runLinkedInInbox, linkedinInboxView, linkedinThread } from '../lib/linkedin-inbox.mjs';
import { runBossInbox } from '../lib/boss-inbox.mjs';
import { runMaimaiInbox } from '../lib/maimai-inbox.mjs';
import { localMinute } from '../lib/list-watch.mjs';
import { rejudgeFilled, rejudgePendingTick, judgeOne, policyReviewTick } from '../lib/ops.mjs';
import { MAIL_POLL_HOURS } from '../lib/app-schedule.mjs';
import { agentProfile, portalSessionsView, commandCenter, hostJobView, leadsQuery, applicationPlanView, repairInputs } from '../lib/command-center.mjs';
import { autoRepair } from '../lib/system/repair.mjs';
import { dispatchCommand, unblockTask, updateHostJob, handToSystem, archiveItem, ensureLeadNumber } from '../lib/dispatch.mjs';
import { runOp, opLog, agentAction } from '../lib/ops.mjs';
import { agentPaused } from '../lib/agents.mjs';
import { draftView, editDraft, rewriteDraft, restoreDraft, cancelPausedDraft } from '../lib/draft-edit.mjs';
import { chatTurn, listSessions, pageSessions, loadSession, deleteSession, markSeen } from '../lib/chat.mjs';
import { askTasks, pageTask } from '../lib/task-chat.mjs';
import { taskChat, taskMessages } from '../lib/task-migrate.mjs';
import { ensureLedger as openJobs } from '../lib/jobs-migrate.mjs';
import { watch as watchJobs } from '../lib/jobs.mjs';
import { settleTasks, viewTasks } from '../lib/tasks.mjs';
import { compactCards } from '../lib/cards.mjs';
import { shownTitle } from '../lib/chat-title.mjs';
import { tasksGet, tasksPost, taskDeps, syncNow } from '../lib/task-api.mjs';
import { cardForHandoff } from '../lib/talk.mjs';
import { loadWorkspace } from '../lib/resume-assistant.mjs';
import { setAgentBackend, updateSettings, testModel, updateFact, setManualPreference, previewPreset, applyPreset } from '../lib/settings.mjs';
import { chatBackends } from '../lib/chat.mjs';
import { addNote, updateNote, deleteNote, listNotes } from '../lib/memory.mjs';
import { allStatuses, discoverModels, setProviderModels, setProviderLabel, addAccount, removeAccount, addProvider, updateProvider, removeProvider } from '../lib/backends.mjs';
import { exportBundle } from '../lib/migrate.mjs';
import { routeFreeform } from '../lib/intent.mjs';
import { runtimeFailure, tickRunNow, reconcileRunNow, notePid, stopExecutor, runNowLaunch, exitWords, STATE_PATH as RUN_NOW_STATE } from '../lib/run-now.mjs';
import { tickCatchup } from '../lib/cycle-catchup.mjs';
import { openForUser, inLoginBrowser, browserEngine, browserLabel } from '../lib/browser-run.mjs';
import { ownBrowser } from '../lib/open-where.mjs';
import { backfillJd } from '../lib/jd-backfill.mjs';
import { noteFallback } from '../lib/fallback.mjs';
import { checkHost, serveHostRequest } from '../lib/browser-host.mjs';
import { markPortalLoggedIn, portalSession } from '../lib/apply-channel.mjs';
import { publicError } from '../lib/api-errors.mjs';
import { writeLines } from '../lib/store.mjs';
import { beat, clearTask } from '../lib/executor-heartbeat.mjs';
import { event } from '../lib/events.mjs';
import { cachedLines, memoStats } from '../lib/state-cache.mjs';
import { scheduler, register } from '../lib/scheduler.mjs';
import { hostFeed, onChange, drain as drainChanges, watchFiles, stopWatching } from '../lib/changes.mjs';
import { dbExists, setMeta } from '../lib/db.mjs';
import { inboxView, answerAsk, answerMany, accountReadyFor, probeAccounts, accountReady, resumeSatisfied, openFailed } from '../lib/ask-actions.mjs';
import { tickLoginWatch, focusLogin, watchingAny } from '../lib/login-watch.mjs';
import { probeFor } from '../lib/login-probe.mjs';
import { inQuietHours } from '../lib/personas.mjs';
import { setupView } from '../lib/setup.mjs';
import { receiveUpload, extractDraft, draftReview, applyDraft, discardDraft, latestDraft, resumeUploadFile } from '../lib/resume-import.mjs';
import { profileView, saveProfile } from '../lib/profile.mjs';
import { templateView } from '../lib/direction-templates.mjs';
import { onboardingView, saveAnswers, saveChannels, applyCompanyPack, finishOnboarding, useModel } from '../lib/onboarding.mjs';
import { saveEntry } from '../lib/entry-sources.mjs';
import { onboardingState, markOnboarding } from '../lib/onboarding-state.mjs';
import { dismissUnlockTop } from '../lib/unlock.mjs';
import { phoneView, phoneAction, phoneQr, startPhone, stopPhone, phoneUpdate } from '../lib/phone.mjs';
import { makeTalk, COMMAND_OFF } from '../lib/phone/api.mjs';
import { pushItems } from '../lib/phone/push.mjs';
import { readCards } from '../lib/cards.mjs';
import { healthLedger } from '../lib/system/health.mjs';
import { watchTick, undoSystemAction } from '../lib/system/watch.mjs';
import { resumeView, resumeAction, resumeFile } from '../lib/resume-assistant.mjs';
import { tailorView, tailorAction } from '../lib/resume-tailor.mjs';
import { lettersView, letterAction, letterView } from '../lib/resume-letters.mjs';
import { leadMaterials } from '../lib/resume-choice.mjs';
import { withWriter } from '../lib/resume-writer.mjs';
import { teamView, workerDetail, WORKER_KEYS } from '../lib/team.mjs';
import { deskList, runningOp, deskView, runMemberOp, busyLine } from '../lib/crew-desk.mjs';
import { capabilities, runOrQueue, queueTick, cancelOp } from '../lib/ops.mjs';
import { hqView, deskInbox, phoneInbox } from '../lib/hq.mjs';
import { requestBrief } from '../lib/company-brief.mjs';
import { requestPrep } from '../lib/role-prep.mjs';
import { requestDossier } from '../lib/interview-dossier.mjs';
import { interviewMaterials, interviewMaterial, interviewMaterialFile } from '../lib/interview-materials.mjs';
import { talkState, talkTurn, parseTalk, withdrawTask, talkExamples, classifyTalk, handTurn, writerTailorTurn, writerLetterTurn } from '../lib/talk.mjs';
import { members } from '../lib/members.mjs';
import { renderShell, sandboxBadgeWanted } from '../lib/web-shell.mjs';
import { usageView, dayTotals, ensureLedger } from '../lib/usage.mjs';
import { budgetState, spendTier, limitText, TIERS, TIER_LABEL, TIER_NOTE } from '../lib/spend.mjs';
import { startAppSchedule, appSchedule } from '../lib/app-schedule.mjs';
import { appSchedules, mailReader } from '../lib/capabilities.mjs';
import { presetView, providerFromPreset } from '../lib/provider-presets.mjs';
import { freeModelView, freeQuotaView } from '../lib/free-model.mjs';
import { accountView, currentAccount, emailStart, emailVerify, googleStart, googleFinish, logout as accountLogout } from '../lib/account.mjs';
import { modelSourceView, useTextModel, startFreeModel, redeemFreeCode } from '../lib/model-choice.mjs';
import { modelCatalogView, refreshModelCatalog, addModelToCatalog } from '../lib/model-catalog.mjs';
import { codexStatus, codexAction } from '../lib/codex-app.mjs';
import { TZ } from '../lib/tz.mjs';
import { sourcesView, sourcesPost } from '../lib/sources.mjs';
import { mailView, mailPost } from '../lib/mail/api.mjs';
import { recordClientError } from '../lib/client-error.mjs';
import { judgeAvailable } from '../lib/judge.mjs';
// 页面本身是代码，跟着这份代码走；RADAR_ROOT 只换数据（用一份数据副本预览时页面也能打开）。
const webFile=f=>path.join(path.dirname(fileURLToPath(import.meta.url)),'..',f);
// 测试 / 沙盒：RADAR_WORKERS=off（或 --no-workers）只开网页，不跑反馈队列、飞书同步、即时执行器、自动修复，
// 也不去对账或终止执行器进程。飞书长连接不再连（命令行版 10-04 冻结），/api/perf 的 listener 恒为 false。
// 演示 / 沙盒模式（--sandbox、RADAR_SANDBOX=1，或 bin/demo-seed.mjs 写的 state/sandbox.json，lib/sandbox.mjs）：
// 后台任务默认关（RADAR_WORKERS=on 或 --workers 才开，开了也只在本机跑），飞书长连接不开，即时执行器不拉起。
const sandbox=sandboxed(), sandboxModelsOn=sandbox&&sandboxModels();
let workersOff=process.env.RADAR_WORKERS==='off'||process.argv.includes('--no-workers')||(sandbox&&process.env.RADAR_WORKERS!=='on'&&!process.argv.includes('--workers'));
// 端口：--port，其次 config/host.json 的 workbench_port（安装程序选了别的端口时写在这里，launchd 起的工作台也读它），都没有是 4321。
const port=Number(arg('--port',Number(read('config/host.json',{})?.workbench_port)||4321)), clients=new Set(), token=crypto.randomBytes(32).toString('hex');
// 打开页面要的钥匙（lib/local-auth.mjs）：App 给的，或者命令行装的存在 private/workbench-key 里的。
const localKey=workbenchKey();
const runtime={started_at:new Date().toISOString()};
// 页面文件（地址 → web/ 里的文件）。手机网关的页面代码包也按这张表取（除了 Gmail 授权页）。
const WEB_ROUTES={'/':'web/index.html','/app.js':'web/app.js','/sidebar.js':'web/sidebar.js','/evidence-view.js':'web/evidence-view.js','/evidence-view.css':'web/evidence-view.css','/codex-login.js':'web/codex-login.js','/model-settings.js':'web/model-settings.js','/model-settings.css':'web/model-settings.css','/labels.js':'web/labels.js','/command.js':'web/command.js','/inbox.js':'web/inbox.js','/setup.js':'web/setup.js','/onboarding.js':'web/onboarding.js','/mail-connect.js':'web/mail-connect.js','/linkedin-inbox.js':'web/linkedin-inbox.js','/hq.js':'web/hq.js','/hq-list.css':'web/hq-list.css','/trace.js':'web/trace.js','/tasks.js':'web/tasks.js','/team.js':'web/team.js','/talk.js':'web/talk.js','/panel.js':'web/panel.js','/face.js':'web/face.js','/company.js':'web/company.js','/usage.js':'web/usage.js','/account.js':'web/account.js','/crew-faces.js':'web/crew-faces.js','/prefs.js':'web/prefs.js','/entries.js':'web/entries.js','/phone.js':'web/phone.js','/first-run.js':'web/first-run.js','/desktop.js':'web/desktop.js','/morph.js':'web/morph.js','/live.js':'web/live.js','/style.css':'web/style.css','/favicon.svg':'web/favicon.svg','/favicon.ico':'web/favicon.svg','/resume.js':'web/resume.js','/phone/index.html':'web/phone/index.html','/phone/app.js':'web/phone/app.js','/phone/logic.js':'web/phone/logic.js','/phone/style.css':'web/phone/style.css','/phone/talk-text.js':'web/talk-text.js'};
Object.assign(WEB_ROUTES, Object.fromEntries(['stream', 'talk-text', 'evidence-summary'].map(name => [`/${name}.js`, `web/${name}.js`])));
Object.assign(WEB_ROUTES, { '/resume-pdf.js': 'web/resume-pdf.js', '/vendor/resume-pdfjs.mjs': 'node_modules/unpdf/dist/pdfjs.mjs' });
// 手机 App 的页面代码（经加密通道送到手机，lib/phone/gateway.mjs bundle）：web/phone/ 加上它用的成员的脸。
const PHONE_ROUTES=['/phone/index.html','/phone/app.js','/phone/logic.js','/phone/style.css','/face.js','/crew-faces.js','/phone/talk-text.js'];
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8','.log':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.svg':'image/svg+xml','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
// 全局 state 锁退役（第 2 步）：反馈排队写 state/feedback.ndjson 经 lib/store.mjs，别的进程同时写会合并。
function appendFeedback(body) { return queueFeedback(body); }
const server=http.createServer(async(req,res)=>{
  const host=req.headers.host, allowed=[`localhost:${port}`,`127.0.0.1:${port}`];
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // POST 是写：回之前让视图缓存失效（changeGen 加一）。页面紧接着就会再读，不能等文件监听那一拍才知道变了（沙盒新用户上手：
  // 刚存了方向，/api/setup 还给旧的「没写方向，按软件处理」）。
  const json=(data0,status0=200)=>{if(req.method==='POST')changeGen++;const [data,status]=publicError(data0,status0);if(status===404&&isDocumentRequest(req)){res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});return res.end(notFoundPage());}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  try{
    // 门（lib/local-auth.mjs）：Host、Origin 不对的拒；没带钥匙（cookie）也没带网关口令的拒。Gmail 授权回调、账户的 Google 登录回调另由 state 校验。
    const url0=new URL(req.url,'http://127.0.0.1');
    const gate=checkRequest(req,{port,key:localKey,token});
    // OfferCrew 账户的 Google 登录回调也一样：是系统浏览器跳回来的（带不上工作台的 cookie），只认工作台内存里刚发出去的 state（lib/account.mjs googleFinish）。
    if(!gate.ok&&!(gate.status===401&&['/api/account/google/cb'].includes(url0.pathname))){
      // 带钥匙的地址（node bin/open-workbench.mjs 打开的）：收下钥匙写进 cookie，跳回不带钥匙的地址。
      if(gate.status===401&&req.method==='GET'&&keyInUrl(url0,localKey)){url0.searchParams.delete('key');res.writeHead(303,{'Set-Cookie':setCookie(localKey),Location:url0.pathname+(url0.search||'')+(url0.hash||''),'Referrer-Policy':'no-referrer'});return res.end();}
      if(gate.status===401&&req.method==='GET'&&!url0.pathname.startsWith('/api/')){res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'});return res.end(LOCKED_PAGE);}
      return json({error:gate.error},gate.status);
    }
    const url=new URL(req.url,`http://${host}`);
    // 开始使用 · 导入简历：原始字节（不走下面 64 KB 的 JSON 通道），PDF / DOCX / TXT / MD ≤ 10 MB；来源与 token 校验同其它 POST。
    if(req.method==='POST'&&url.pathname==='/api/setup/resume'){if(!allowed.map(h=>`http://${h}`).includes(req.headers.origin)||req.headers['x-radar-token']!==token)return json({error:'origin_or_token_invalid'},403);const r=await receiveUpload(req);return json(r.body,r.status);}
    if(req.method==='POST'&&(/^\/api\/tasks(\/[^/]+\/(move|assign|run|answer|judge-first|release|edit|why|say|subtask|resume-prefill))?$/.test(url.pathname)||['/api/linkedin-inbox','/api/lead/jd','/api/feedback','/api/codex','/api/command','/api/ops','/api/unblock','/api/host-job','/api/system-fix','/api/system/undo','/api/open-url','/api/application-page','/api/archive','/api/draft','/api/chat','/api/chat/handoff','/api/chat/delete','/api/chat/seen','/api/talk','/api/talk/withdraw','/api/team/run','/api/team/queue','/api/settings','/api/settings/agent','/api/portal-session','/api/lead-number','/api/settings/test','/api/settings/local-ai/check','/api/settings/preset','/api/settings/providers','/api/model/free','/api/account','/api/model/source','/api/model/catalog','/api/facts','/api/preference','/api/memory','/api/inbox/answer','/api/agent','/api/account-ready','/api/setup/profile','/api/setup/resume/extract','/api/setup/resume/save','/api/setup/resume/discard','/api/company','/api/resume','/api/onboarding/answers','/api/onboarding/channels','/api/onboarding/entries','/api/onboarding/companies','/api/onboarding/finish','/api/onboarding/state','/api/unlock','/api/onboarding/model','/api/phone','/api/client-error'].includes(url.pathname))){
      if(!allowed.map(h=>`http://${h}`).includes(req.headers.origin)||req.headers['x-radar-token']!==token||req.headers['content-type']!=='application/json')return json({error:'origin_or_token_invalid'},403);
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>64000)return json({error:'内容过长'},413);}
      const parsed=JSON.parse(body);
      // 页面自己出的错（web/app.js pageError）：只写一条运行日志（lib/client-error.mjs），不做别的；比别的口子收得更小。
      if(url.pathname==='/api/client-error'){if(Buffer.byteLength(body)>8000)return json({error:'内容过长'},413);return json(recordClientError(parsed&&typeof parsed==='object'?parsed:{}));}
      // 任务板（lib/task-api.mjs）：手动建卡、挪卡、换人、运行、答、改成先判断。
      if(url.pathname.startsWith('/api/tasks')){try{const r=await tasksPost(url.pathname,parsed&&typeof parsed==='object'?parsed:{},tasksDeps(),{phone:!!req.headers['x-radar-phone'],limited:req.headers['x-radar-phone']==='limited',device:String(req.headers['x-radar-phone-device']||'').slice(0,40)||null});memoCache.clear();return json(r);}catch(e){return json({error:e.message},e.status||400);}}
      if(url.pathname==='/api/lead/jd'){const r=await backfillJd(parsed,{judge:judgeOne});memoCache.clear();return json(r);}
      // 操作台：与飞书指挥室同一套指令语法；发送 / 投递类指令第一次返回预览，带 confirm 才执行。
      if(url.pathname==='/api/command')return json(await dispatchCommand(parsed.text,{confirm:parsed.confirm===true,freeform:t=>routeFreeform(t)}));
      // 手机网关替没被允许交办的手机来答（x-radar-phone: limited）：目标停下来问的那一封答了，放行的下一棒照样停在电脑确认（lib/tasks.mjs answerGoal）。
      // 批量（跟进的「全部跟进 / 全部不跟」）：ids 一次交给服务端做完，离开页面也不停。
      if(url.pathname==='/api/inbox/answer'&&Array.isArray(parsed.ids))return json(await answerMany(parsed.ids.slice(0,50).map(x=>String(x)),String(parsed.option??''),{center:centerNow(),...(req.headers['x-radar-phone']==='limited'?{phone:{device:String(req.headers['x-radar-phone-device']||'').slice(0,40)||null}}:{})},{reason:String(parsed.reason||'').slice(0,60),confirm:parsed.confirm===true}));
      if(url.pathname==='/api/inbox/answer')return json(await answerAsk({id:String(parsed.id||''),option:String(parsed.option??''),text:String(parsed.text||'').slice(0,2000),reason:String(parsed.reason||'').slice(0,60),datetime:String(parsed.datetime||'').slice(0,40),confirm:parsed.confirm===true?true:typeof parsed.confirm==='string'?parsed.confirm.slice(0,128):false,fingerprint:typeof parsed.fingerprint==='string'?parsed.fingerprint.slice(0,128):null,answers:answersOf(parsed.answers),fields:parsed.fields&&typeof parsed.fields==='object'&&!Array.isArray(parsed.fields)?Object.fromEntries(Object.entries(parsed.fields).slice(0,10).map(([k,v])=>[String(k).slice(0,40),String(v??'').slice(0,500)])):null},{center:centerNow(),...(req.headers['x-radar-phone']==='limited'?{phone:{device:String(req.headers['x-radar-phone-device']||'').slice(0,40)||null}}:{})}));
      if(url.pathname==='/api/account-ready')return json(await accountReadyFor(String(parsed.account||''),{center:centerNow(),confirm:parsed.confirm===true,checkOnly:parsed.check_only===true}));
      // 岗位页「先判断」（op judge-one）：手上忙着就排着，跑完接着判（lib/ops.mjs judgeOne）。
      if(url.pathname==='/api/ops')return json(parsed.op==='judge-one'?judgeOne(String(parsed.record_id||'')):runOp(String(parsed.op||''), {record_id: parsed.record_id}),202);
      // 指挥台团队条 ⋯：暂停 / 恢复 / 立即跑一轮（lib/agents.mjs）。
      if(url.pathname==='/api/agent'){const r=agentAction(String(parsed.agent||''),String(parsed.action||''),{run:(op,o)=>runOrQueue(op,o)});memoCache.clear();return json(r);}
      // 团队页和面板里成员那一栏的「▶ 运行」（lib/crew-desk.mjs）：只收这位名下的操作，要模型的先查模型能不能用。
      if(url.pathname==='/api/linkedin-inbox'){if(parsed.action!=='check')return json({error:'未知的检查操作'},400);const thread=parsed.thread_url?linkedinThread(parsed.thread_url):null;if(parsed.thread_url&&!thread)return json({error:'需要 LinkedIn 原消息线程链接'},400);const active=linkedinInboxView();if(active.pending)return json({ok:true,already:true,queued:active.job_state==='queued',card:active.task_id,op:{id:active.queue_id,job_id:active.job_id},receipt:active.job_state==='queued'?'LinkedIn 检查已排队':'正在检查 LinkedIn，请等待本次结果'},202);const r=runMemberOp('owl','linkedin-inbox',{url:thread,record_id:parsed.record_id?String(parsed.record_id):null});memoCache.clear();return json(r,202);}
      if(url.pathname==='/api/team/run'){const r=runMemberOp(String(parsed.member||''),String(parsed.op||''));memoCache.clear();return json(r,202);}
      // 排着的那一项不跑了（lib/ops.mjs cancelOp）。
      if(url.pathname==='/api/team/queue'){const r=cancelOp(String(parsed.id||''));memoCache.clear();return json(r);}
      // Watch 的公司调研 / 怎么准备（lib/company-brief.mjs）：线索页和指挥台抽屉上的按钮，立刻排队、拉起即时执行器。
      if(url.pathname==='/api/company'){const a=String(parsed.action||''),rid=parsed.record_id?String(parsed.record_id).slice(0,80):null;if(!['brief','prep','interview'].includes(a))return json({error:'未知的操作'},400);if(a==='interview'){const r=await requestDossier({record_id:rid,via:'page'});try{await syncNow({...tasksDeps(),force:true});}catch{}memoCache.clear();return json(r);}const asked=Date.now(),company=String(parsed.company||'').slice(0,80);const r=a==='prep'?await requestPrep({record_id:rid}):await requestBrief({company,record_id:rid});let t=null;try{t=pageTask({action:a,record_id:rid,company,result:r,asked_at:asked});}catch{}memoCache.clear();return json(t?{...r,...t}:r);}
      if(url.pathname==='/api/unblock')return json(await unblockTask(String(parsed.key||'')));
      if(url.pathname==='/api/host-job')return json(await updateHostJob(String(parsed.id||''),String(parsed.action||''),{note:parsed.note,feedbackId:parsed.feedback_id}));
      if(url.pathname==='/api/system-fix')return json(await handToSystem(parsed.target||{},{note:String(parsed.note||'')}));
      // System 照标准做法做过的一件：团队页的「撤销」「恢复」（lib/system/watch.mjs undoSystemAction）。先改回去，再记一行。
      if(url.pathname==='/api/system/undo'){const r=await undoSystemAction(String(parsed.id||''));memoCache.clear();return json(r);}
      if(url.pathname==='/api/archive')return json(await archiveItem({action_id:parsed.action_id||null,key:parsed.key||null,note:String(parsed.note||'')}));
      // 用户要登录 / 授权：在专用 Chrome 里只弹出那一个页面并交给用户。
      // 指挥台顶上「还差 N 步」那一行的 ×（lib/unlock.mjs）：只关顶上这一行。
      if(url.pathname==='/api/unlock')return json(dismissUnlockTop());
      if(url.pathname==='/api/lead-number')return json(await ensureLeadNumber(parsed.record_id||parsed.id));
      if(url.pathname==='/api/portal-session'){if(parsed.confirm!==true)return json({ok:true,needs_confirm:true,preview:{kind:'record',text:'确认你已在浏览器里登录这个网站？会记为你本人确认，并恢复仍有有效批准的任务。'}});return json(await recoverPortalSession(parsed.host));}
      if(url.pathname==='/api/application-page')return json(await showApplicationPage(String(parsed.record_id||'')));
      // 从 App 里点开的外部链接（desktop/main.mjs，browse: true）：招聘网站在专用 Chrome 里新开一个标签；你自己账号的登录、
      // 我们的网站、下载页、演示模式，回 open_in: system，由 App 交给你平时用的浏览器（lib/open-where.mjs）。专用 Chrome 打不开
      // （没装、起不来）也回 system，并记进「换了」的账（lib/fallback.mjs）。
      if(url.pathname==='/api/open-url'&&parsed.browse===true){const target=String(parsed.url||'');
        if(ownBrowser(target)||sandbox)return json({ok:true,open_in:'system'});
        try{const r=await openForUser(target,{browse:true});event('user','room','ok',`工作台${inLoginBrowser()}打开 ${target.slice(0,120)}`);return json({ok:true,open_in:browserEngine(),navError:r.navError||null});}
        catch(e){try{noteFallback({kind:'open_url',from:browserEngine(),to:'system',why:e,from_label:browserLabel(),to_label:'你平时用的浏览器'});}catch{}return json({ok:true,open_in:'system',fallback:true,why:openFailed(e)});}
      }
      if(url.pathname==='/api/open-url'){const target=String(parsed.url||''),account=/^[a-z_]+(:[a-z0-9.-]+)?$/i.test(String(parsed.account||''))?String(parsed.account):null;let r;try{r=await openForUser(target,{name:String(parsed.name||`${BRAND} · 需要你处理`).slice(0,60),account});}catch(e){if(/http\(s\)/.test(String(e.message)))throw e;throw Error(openFailed(e));}event('user','room','ok',`工作台${inLoginBrowser()}打开 ${target.slice(0,120)}`);
        // 设置、收件箱的账号行上点的「打开登录页」带着账号：配了登录检查的，之后 10 分钟每 20 秒看一次，登好了自己继续（lib/login-watch.mjs）。
        const probe=account?probeFor(account):null;if(probe)focusLogin(account);
        return json({ok:true,...r,receipt:account?`已${inLoginBrowser()}打开，${probe&&probe.confirmed!==false?'登录好之后系统会自己发现':'登录好之后点「我登好了」'}。`:`已${inLoginBrowser()}打开，登录 / 处理完回来点「好了」或「重试」。`});}
      // 草稿：直接改、AI 重写（只返回提案）、回到上一版。
      if(url.pathname==='/api/draft'){
        const a=String(parsed.action||'');
        if(a==='cancel')return json(cancelPausedDraft({draft_id:String(parsed.draft_id||''),record_id:String(parsed.record_id||''),fingerprint:String(parsed.fingerprint||'')}));
        if(a==='edit')return json(await editDraft({draft_id:String(parsed.draft_id||''),subject:parsed.subject,body:parsed.body,to:parsed.to}));
        if(a==='rewrite')return json(await rewriteDraft({draft_id:String(parsed.draft_id||''),instruction:String(parsed.instruction||'').slice(0,1000)}));
        if(a==='restore')return json(await restoreDraft({draft_id:String(parsed.draft_id||'')}));
        return json({error:'未知的草稿操作'},400);
      }
      // 对话：一轮补全带当前系统状态；交给执行器走 host-jobs + run-now。
      if(url.pathname==='/api/chat')return json(await chatTurn({judgeOk:judgeAvailable({offlineOk:true}),session_id:parsed.session_id||null,persona:parsed.persona||null,text:parsed.text,backend:parsed.backend||parsed.model||null,center:chatCenter()}));
      // 交出去之前先分一下（lib/talk.mjs handTurn）：Writer 自己的活、表里已有的链接直接在对话里接；别的才排给本机 AI，补一张卡。
      if(url.pathname==='/api/chat/handoff'){const r=await handTurn({session_id:String(parsed.session_id||''),text:parsed.text,persona:parsed.persona||null},{kick:()=>syncNow({...tasksDeps(),force:true})});if(!r.routed)try{cardForHandoff({session_id:r.session.id,message_id:r.message_id,persona:parsed.persona||null,text:parsed.text});}catch{}return json(r);}
      if(url.pathname==='/api/chat/delete')return json(deleteSession(String(parsed.session_id||'')));
      // 看过这段对话了（任务即对话：对话历史上的小点；手机和电脑同一份）。
      if(url.pathname==='/api/chat/seen')return json(markSeen(String(parsed.session_id||'')));
      // 对话浮层（lib/talk.mjs）：认得的指令走上面 /api/command 同一个 dispatchCommand（确认照旧），别的话走对话；回执记进同一个会话。
      // 回来的时候带上这个会话里每件事的状态，页面一收到就能画出任务卡。
      // 手机网关替没被允许交办的手机来问时带 x-radar-phone: limited（和 x-radar-phone-device）：指令不执行、不交给执行器；
      // 卡照开，要开执行器或浏览器的那一棒停在「回电脑确认」（lib/tasks.mjs mac_hold）。
      if(url.pathname==='/api/talk'){const limited=req.headers['x-radar-phone']==='limited',refuse=async()=>({ok:false,error:COMMAND_OFF});const talkOut=r=>{if(!r.session)return r;const st=talkState({session_id:r.session.id,workers:!workersOff});return {...r,session:taskMessages(r.session),tasks:st.tasks,cards:st.cards,refs:st.refs};};const talkArgs=[{session_id:parsed.session_id||null,task:typeof parsed.task==='string'?parsed.task.slice(0,80):null,text:parsed.text,confirm:parsed.confirm===true,via:['action','example'].includes(parsed.via)?parsed.via:null,member:typeof parsed.member==='string'?parsed.member.slice(0,24):null,focus:talkFocus(parsed.focus),action:parsed.action&&typeof parsed.action==='object'&&(!limited||parsed.action.kind==='task_why')?{kind:String(parsed.action.kind||'').slice(0,40),message_id:String(parsed.action.message_id||'').slice(0,40),...(typeof parsed.action.task==='string'?{task:parsed.action.task.slice(0,80)}:{}),...(parsed.action.answers&&typeof parsed.action.answers==='object'&&!Array.isArray(parsed.action.answers)?{answers:Object.fromEntries(Object.entries(parsed.action.answers).slice(0,6).map(([k,v])=>[String(k).slice(0,8),{option:String(v?.option||'').slice(0,60),text:String(v?.text||'').slice(0,300)}]))}:{})}:null},{dispatch:limited?refuse:(t,o)=>dispatchCommand(t,o),center:()=>(chatCenter()),hq:hqNow,asks:()=>inboxNow().asks||[],tailoring:()=>loadWorkspace().tailoring.enabled,kick:()=>syncNow({...tasksDeps(),force:true}),...(limited?{agent:refuse,phone:{device:String(req.headers['x-radar-phone-device']||'').slice(0,40)||null}}:{})}];
      // 边生成边显示（10-03 L 线）：带 stream: true 的回 text/event-stream：delta（新到的字）……最后一条 done（和不流时同样的回答，加上导航栏 ⚡ 那一格 supply）；
      // 出错是一条 error。只给这台电脑的工作台：手机（x-radar-phone）照旧整段。对话以外的（指令、规则回答、Writer 的活）没有 delta，只有 done。
      if(parsed.stream===true&&!req.headers['x-radar-phone']){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive'});const say=(ev,d)=>{try{res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);}catch{}};try{const r=await talkTurn(talkArgs[0],{...talkArgs[1],onDelta:text=>say('delta',{text})});let supply={show:false};try{supply=freeQuotaView()?.nav||supply;}catch{}say('done',{...talkOut(r),supply});}catch(e){const [d]=publicError({error:e.message},400);say('error',d);}res.end();return;}
      const r=await talkTurn(talkArgs[0],talkArgs[1]);return json(talkOut(r));}
      if(url.pathname==='/api/talk/withdraw'){const r=await withdrawTask({session_id:String(parsed.session_id||''),message_id:String(parsed.message_id||'')});const st=talkState({session_id:r.session.id,workers:!workersOff});return json({...r,tasks:st.tasks,refs:st.refs});}
      // 配置、个人事实、手动偏好：白名单字段，写前备份。
      if(url.pathname==='/api/codex'){try{return json(await codexAction(String(parsed.action||'')),202);}catch(e){return json({error:e.message},e.status||400);}}
      if(url.pathname==='/api/settings/agent')return json(setAgentBackend(String(parsed.role||''),parsed.patch));
      if(url.pathname==='/api/settings'){const r=updateSettings(String(parsed.name||''),parsed.patch||{});if(r.changes?.some(c=>c.key.startsWith('recommend.'))){try{(await import('../lib/recommend-sweep.mjs')).sweepRecommendations();}catch(e){console.error('recommend sweep',e.message);}}return json(r);}
      if(url.pathname==='/api/settings/local-ai/check'){const r=await checkLocalCli(parsed.kind);memoCache.clear();return json(r);}
      if(url.pathname==='/api/settings/test')return json(await testModel({backend:parsed.backend||null,model:parsed.model||null,provider:parsed.provider||null,driver:parsed.driver||null}));
      if(url.pathname==='/api/settings/preset')return json(parsed.apply===true?applyPreset(String(parsed.name||'')):previewPreset(String(parsed.name||'')));
      // 供应商目录：探测模型、增删模型、改显示名、加 / 删账号。
      if(url.pathname==='/api/settings/providers'){
        const a=String(parsed.action||'');
        if(a==='discover')return json(await discoverModels(String(parsed.key||'')));
        if(a==='models')return json(setProviderModels(String(parsed.key||''),parsed.models));
        if(a==='label')return json(setProviderLabel(String(parsed.key||''),parsed.label));
        if(a==='account_add')return json(addAccount({base:String(parsed.base||''),name:String(parsed.name||''),label:parsed.label||null}));
        if(a==='account_remove')return json(removeAccount(String(parsed.key||'')));
        // 预设（lib/provider-presets.mjs）：用户只选服务商、粘贴 key，地址和模型取预设里的。
        if(a==='preset_add')return json(addProvider(providerFromPreset(String(parsed.preset||''),parsed.api_key)));
        if(a==='provider_add')return json(addProvider({key:parsed.key,label:parsed.label||null,kind:String(parsed.kind||''),base_url:parsed.base_url,api_key:parsed.api_key,models:parsed.models||[],wire_api:parsed.wire_api||'chat'}));
        if(a==='provider_update')return json(updateProvider(String(parsed.key||''),{label:parsed.label,base_url:parsed.base_url,api_key:parsed.api_key,models:parsed.models,wire_api:parsed.wire_api}));
        if(a==='provider_remove')return json(removeProvider(String(parsed.key||'')));
        return json({error:'未知的目录操作'},400);
      }
      // OfferCrew 账户（lib/account.mjs）：email_start { email } / email_verify { email, code } / google_start（回中转的地址，界面用系统浏览器打开）/ logout。
      if(url.pathname==='/api/account'){const a=String(parsed.action||'');const r=a==='email_start'?await emailStart({email:parsed.email}):a==='email_verify'?await emailVerify({email:parsed.email,code:parsed.code}):a==='google_start'?googleStart({redirect_uri:`http://127.0.0.1:${port}/api/account/google/cb`}):a==='logout'?await accountLogout():{status:400,body:{error:'未知的操作'}};memoCache.clear();return json(r.body,r.status);}
      // OfferCrew 补给（lib/free-model.mjs）：{ action: 'start' } 向中转领令牌（只在你选它时），加供应商 offercrew；用不了回 409 { error, reason }。
      // { action: 'redeem', code }：兑换码加点（本机先核校验位，再交给中转）。
      if(url.pathname==='/api/model/free'&&String(parsed.action||'')==='redeem'){const r=await redeemFreeCode({code:String(parsed.code||'').slice(0,64)});memoCache.clear();return json(r.body,r.status);}
      if(url.pathname==='/api/model/free'){if(String(parsed.action||'')!=='start')return json({error:'未知的操作'},400);const r=await startFreeModel({make_default:parsed.make_default===true,model:parsed.model==null?null:String(parsed.model).slice(0,80)});memoCache.clear();return json(r.body,r.status);}
      // 设置 → 模型：把某个模型换成文字模型和对话的默认（lib/model-choice.mjs）。
      if(url.pathname==='/api/model/catalog'){const a=String(parsed.action||'');const r=a==='discover'?await refreshModelCatalog(String(parsed.key||'')):a==='add'?addModelToCatalog(String(parsed.key||''),parsed.model):null;if(!r)return json({error:'未知的模型目录操作'},400);memoCache.clear();return json(r);}
      if(url.pathname==='/api/model/source'){try{const r=await useTextModel(parsed.use);memoCache.clear();return json(r);}catch(e){return json({error:e.message},e.status||400);}}
      if(url.pathname==='/api/facts')return json(updateFact(String(parsed.path||''),parsed.value));
      if(url.pathname==='/api/preference')return json(setManualPreference({key:parsed.key,weight:parsed.weight}));
      // 开始使用：个人资料按结构保存；简历草稿的整理 / 确认写入 / 放弃。写前校验白名单、核对版本、备份，保留注释。
      if(url.pathname.startsWith('/api/setup/')){try{
        // 补上了工作许可：只把当时因为缺它判成待核的那几条马上重判（lib/command-center.mjs rejudgeFilled）。
        if(url.pathname==='/api/setup/profile'){const r=saveProfile({base:parsed.base??null,set:parsed.set||{},rows:parsed.rows||{}});const op=await rejudgeFilled({changes:r.changes}).catch(()=>null);return json(op?{...r,rejudge:op.pending?{pending:true,why:op.why}:{op:op.op,label:op.label}}:r);}
        if(url.pathname==='/api/setup/resume/extract')return json(await extractDraft(String(parsed.id||''),{force:parsed.force===true}));
        if(url.pathname==='/api/setup/resume/save')return json(applyDraft(String(parsed.id||''),{base:parsed.base??null,accept:parsed.accept||{}}));
        if(url.pathname==='/api/setup/resume/discard')return json(discardDraft(String(parsed.id||'')));
      }catch(e){return json({error:e.message},e.status||400);}}
      // 开始使用 · 引导：答案写个人资料、真人渠道开关、公司包加入 / 去掉、走完（lib/onboarding.mjs）。写完清掉缓存，清单马上看得到。
      if(url.pathname.startsWith('/api/onboarding/')){try{
        let r;
        if(url.pathname==='/api/onboarding/answers')r=await saveAnswers({base:parsed.base??null,values:parsed.values||{}});
        else if(url.pathname==='/api/onboarding/channels')r=saveChannels({enabled:parsed.enabled||{}});
        else if(url.pathname==='/api/onboarding/entries')r=saveEntry({preset:parsed.preset==null?null:String(parsed.preset),key:String(parsed.key||''),action:String(parsed.action||'add')}); // 搜好的入口加成来源 / 撤掉（lib/entry-sources.mjs）
        else if(url.pathname==='/api/onboarding/companies')r=await applyCompanyPack({preset:parsed.preset,action:String(parsed.action||'add')});
        else if(url.pathname==='/api/onboarding/state')r=markOnboarding(String(parsed.action||''));
        else if(url.pathname==='/api/onboarding/model')r=await useModel({use:String(parsed.use||''),backend:parsed.backend==null?null:String(parsed.backend).slice(0,120),pick:parsed.pick==null?null:String(parsed.pick)});
        else r=finishOnboarding();
        memoCache.clear();return json(r);
      }catch(e){return json({error:e.message},e.status||400);}}
      // 连接手机（lib/phone.mjs，契约见桌面版方案附录 F）：配对、确认、取消、解除、改名、允许交给执行器。
      if(url.pathname==='/api/phone'){try{return json(await phoneAction(parsed));}catch(e){return json({error:e.message},e.status||400);}}
      // 简历助手（lib/resume-assistant.mjs）：导入、体检 / 改写（模型那一步不等）、接受 / 不要、锁定、追问、版本、导出、用于投递。
      if(url.pathname==='/api/resume'){try{const a=String(parsed.action||'');/* 「按岗位定制」「改一版」：Writer 在对话里先问（lib/talk.mjs），不经材料那几个模块往上叫对话 */return json(a==='tailor'?await writerTailorTurn({rid:String(parsed.rid||parsed.record_id||'')}):a==='letter_rewrite'?await writerLetterTurn({key:String(parsed.key||'')}):a.startsWith('tailor')?await tailorAction(parsed):/^(letter|intro)_/.test(a)?await letterAction(parsed):await resumeAction(parsed));}catch(e){return json({error:e.message},e.status||400);}}
      // 记忆库：网页上加、改、删；网页写入的作者固定为 user。
      if(url.pathname==='/api/memory'){
        const a=String(parsed.action||'');
        if(a==='add')return json(await addNote({by:'user',kind:parsed.kind,text:parsed.text,subject:parsed.subject,numbers:parsed.numbers,companies:parsed.companies,tags:parsed.tags,evidence:parsed.evidence,pinned:parsed.pinned===true}));
        if(a==='update')return json(await updateNote(String(parsed.id||''),{text:parsed.text,kind:parsed.kind,subject:parsed.subject,numbers:parsed.numbers,companies:parsed.companies,tags:parsed.tags,evidence:parsed.evidence,pinned:parsed.pinned}));
        if(a==='delete')return json(await deleteNote(String(parsed.id||'')));
        return json({error:'未知的记忆操作'},400);
      }
      return json(appendFeedback(parsed),202);
    }
    // Radar 的招聘源（lib/sources.mjs）：GET 列出每一家和它现在怎样；POST { action: add | update | remove | link } 加、改、删一家，
    // 或者交给 Radar 一个链接（招聘板首页加成招聘源，别的链接开一张收录卡）。来源与 token 校验同其它 POST。
    if(url.pathname==='/api/sources'){
      if(req.method!=='POST')return json({...sourcesView(),token});
      if(!allowed.map(h=>`http://${h}`).includes(req.headers.origin)||req.headers['x-radar-token']!==token||req.headers['content-type']!=='application/json')return json({error:'origin_or_token_invalid'},403);
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8000)return json({error:'内容过长'},413);}
      let parsed;try{parsed=JSON.parse(body);}catch{return json({error:'不是 JSON'},400);}
      try{const r=await sourcesPost(parsed&&typeof parsed==='object'?parsed:{});memoCache.clear();if(r.kind==='intake')try{await syncNow({...tasksDeps(),force:true});}catch{}return json(r);}catch(e){return json({error:e.message},e.status||400);}
    }
    // 告警「不用管这条」（lib/alert-rules.mjs）：POST { action: 'dismiss', key }，同类 24 小时内不再上来。来源与 token 校验同其它 POST。
    if(url.pathname==='/api/alerts'&&req.method==='POST'){
      if(!allowed.map(h=>`http://${h}`).includes(req.headers.origin)||req.headers['x-radar-token']!==token||req.headers['content-type']!=='application/json')return json({error:'origin_or_token_invalid'},403);
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2000)return json({error:'内容过长'},413);}
      let parsed;try{parsed=JSON.parse(body);}catch{return json({error:'不是 JSON'},400);}
      try{const r=alertsPost(parsed&&typeof parsed==='object'?parsed:{});memoCache.clear();return json(r);}catch(e){return json({error:e.message},e.status||400);}
    }
    // 内置邮箱（lib/mail/api.mjs）：GET 只回地址、哪种邮箱、连没连上；POST { action: detect | test | save | retest | disconnect }。
    // 来源与 token 校验同其它 POST。授权码只在内存里过一下：请求体不进日志，任何回复都不带它。
    if(url.pathname==='/api/mail'){
      if(req.method!=='POST')return json({...mailView(),token});
      if(!allowed.map(h=>`http://${h}`).includes(req.headers.origin)||req.headers['x-radar-token']!==token||req.headers['content-type']!=='application/json')return json({error:'origin_or_token_invalid'},403);
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4000)return json({error:'内容过长'},413);}
      let parsed;try{parsed=JSON.parse(body);}catch{return json({error:'不是 JSON'},400);}
      try{const r=await mailPost(parsed&&typeof parsed==='object'?parsed:{});memoCache.clear();return json(r);}catch(e){const known=e.status||/^(?:keychain|mail)_/.test(String(e.code||''));return json({error:known?e.message:'邮箱操作没做成',...(e.kind?{kind:e.kind}:{})},e.status||(known?409:500));}
    }
    if(req.method!=='GET'&&!(req.method==='HEAD'&&['/api/setup/resume/file','/api/materials/interview/file'].includes(url.pathname)))return json({error:'method_not_allowed'},405);
    // 左下角账户面板（lib/account.mjs accountView）：邮箱、补给还剩多少、哪天到期、最近用掉的。令牌不出这台电脑的 private/。
    // 还没登录时登录页要用 token 发请求（主界面的数据还没拉），和 /api/inbox 一样带上。
    if(url.pathname==='/api/account')return json({...await accountView({rows:url.searchParams.get('rows')!=='0'}),token});
    // Google 登录回到这里（中转 302 过来，带一次性的码和 state）：换成账户令牌，回一页「可以回到 OfferCrew 了」。
    if(url.pathname==='/api/account/google/cb'){
      res.setHeader('Referrer-Policy','no-referrer');
      const r=await googleFinish(url.searchParams);memoCache.clear();
      const say=r.status===200?'登录好了，可以回到 OfferCrew 了。':String(r.body.reason||'登录没成功');
      res.writeHead(r.status===200?200:400,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OfferCrew</title><body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1f2a27;background:#f6f7f5"><p>${say.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</p></body>`);
      return;
    }
    // 快照和指挥台按"被监视文件的签名"缓存：文件没变就不重算（一次重算要 0.5–2 秒、几百 MB 临时内存）。
    if(url.pathname==='/api/event-history')return json(await searchEvents({q:url.searchParams.get('q')||'',scope:Object.fromEntries(['run','job','action','task'].filter(k=>url.searchParams.get(k)).map(k=>[k,url.searchParams.get(k).slice(0,100)])),flow:url.searchParams.get('flow')||'all',leadOnly:url.searchParams.get('leadOnly')==='1',page:url.searchParams.get('page')}));
    if(url.pathname==='/api/snapshot')return json({...memo('snapshot',()=>withContentSig(snapshot(runtime))),token});
    // content_sig：页面据此判断内容有没有变，没变就不重绘（不丢滚动位置、展开状态和正在点的按钮）。
    if(url.pathname==='/api/command-center'){return json({...centerNow(),token});}
    // System 监工的健康账本（lib/system/health.mjs）：每样手好不好、归到哪位成员。告警用指挥台同一份缓存，不另算一遍。
    // App 的主进程要用工作台的口令去点开链接（POST /api/open-url）：过了门的才拿得到。
    if(url.pathname==='/api/session')return json({token});
    if(url.pathname==='/api/system/health')return json(healthLedger({alerts:centerNow().alerts||[]}));
    if(url.pathname==='/api/setup'){return json({...memo('setup',()=>setupView({runtime,leads:cachedLines('state/leads.ndjson')})),token});}
    if(url.pathname==='/api/setup/profile')return json(profileView());
    // Patch 的记账（lib/usage.mjs、lib/spend.mjs）：「运行与用量」整页；顶栏胶囊只要今天的合计。打开页面时先对一遍 Codex 会话记录（最多一分钟一次）。
    if(url.pathname==='/api/usage'){ensureLedger({codex:!sandbox});const b=budgetState();return json({...usageView(),budget:{...b,limit_text:limitText(b)},tier:spendTier(),tiers:TIERS.map(k=>({key:k,label:TIER_LABEL[k],note:TIER_NOTE[k]})),token});}
    if(url.pathname==='/api/usage/today'){ensureLedger({codex:!sandbox});const t=dayTotals(),b=budgetState({used:t});return json({day:t.day,tokens:t.tokens,cached_tokens:t.cached_tokens,uncached_tokens:t.uncached_tokens,cny:t.cny,usd:t.usd,subscription_tokens:t.subscription_tokens,api_tokens:t.api_tokens,credit_tokens:t.credit_tokens,credits:t.credits,unpriced_calls:t.unpriced_calls,tier:spendTier(),budget:{enabled:b.enabled,reached:b.reached,share:b.share,limit_text:limitText(b)}});}
    // 看示例：只读 candidate/templates/ 下按方向的三份示例（方向键查表，不拼路径；lib/direction-templates.mjs）。
    if(url.pathname==='/api/setup/template'){try{return json(templateView(url.searchParams.get('direction')));}catch(e){return json({error:e.message},e.status||400);}}
    // 引导走到哪了（lib/onboarding-state.mjs）：页面一打开先问这个，first_run 就进引导。
    if(url.pathname==='/api/onboarding/state'){try{return json({...onboardingState(),token});}catch(e){return json({error:e.message},500);}}
    if(url.pathname==='/api/phone'){try{return json(await phoneView());}catch(e){return json({error:e.message},500);}}
    // 配对二维码（本机生成的 PNG，内容就是 pairing.url；只在等手机扫的时候有）。
    if(url.pathname==='/api/phone/qr'){let png;try{png=phoneQr(url.searchParams.get('id'));}catch(e){return json({error:e.message},e.status||400);}res.writeHead(200,{'Content-Type':'image/png'});return res.end(png);}
    if(url.pathname==='/api/onboarding'){try{const t=url.searchParams.get('tracks');return json({...await onboardingView({preset:url.searchParams.get('preset'),tracks:t==null?null:t.split(',').filter(Boolean).slice(0,20)}),token});}catch(e){return json({error:e.message},e.status||400);}}
    if(url.pathname==='/api/materials/interviews'){try{return json(interviewMaterials());}catch(e){return json({error:e.message},e.status||400);}}
    if(url.pathname==='/api/materials/interview'){try{return json(interviewMaterial(url.searchParams.get('key')));}catch(e){return json({error:e.message},e.status||400);}}
    if(url.pathname==='/api/materials/interview/file'){
      let original;try{original=interviewMaterialFile(url.searchParams.get('key'),url.searchParams.get('asset'));}catch(e){return json({error:e.code==='ENOENT'?'本地资料文件不存在':e.message},e.status||400);}
      const {name,type,size}=original;res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.writeHead(200,{'Content-Type':type,'Content-Length':size,'Content-Disposition':`${original.inline?'inline':'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g,'_').replace(/"/g,'')}"; filename*=UTF-8''${encodeURIComponent(name)}`});
      if(req.method==='HEAD')return res.end();return fs.createReadStream(original.file).pipe(res);
    }
    if(url.pathname==='/api/resume'){try{return json({...withContentSig({...resumeView({doc:url.searchParams.get('doc')}),tailoring:tailorView(),letters:lettersView()}),token});}catch(e){return json({error:e.message},e.status||400);}}
    // 导出的简历：只给登记过的文件（candidate/resume/<编号>/<版本>/），以附件下载。
    if(url.pathname==='/api/resume/file'){let rel;try{rel=resumeFile(String(url.searchParams.get('doc')||''),String(url.searchParams.get('v')||''),String(url.searchParams.get('format')||''));}catch(e){return json({error:e.message},e.status||400);}const name=path.basename(rel);res.writeHead(200,{'Content-Type':rel.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="${name.replace(/[^\x20-\x7e]/g,'_').replace(/"/g,'')}"; filename*=UTF-8''${encodeURIComponent(name)}`});return fs.createReadStream(file(rel)).pipe(res);}
    if(url.pathname==='/api/setup/resume/draft'){try{const id=url.searchParams.get('id');return json(id?draftReview(id):{draft:latestDraft()});}catch(e){return json({error:e.message},e.status||400);}}
    // 上传原件的预览只按已登记 ID 读取，不导入材料、不触模型；与草稿同一个本机登录边界。
    if(url.pathname==='/api/setup/resume/file'&&['GET','HEAD'].includes(req.method)){let original;try{original=resumeUploadFile(String(url.searchParams.get('id')||''));}catch(e){return json({error:e.message},e.status||400);}const {name,type,size}=original;res.setHeader('Content-Security-Policy',"default-src 'none'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'");res.writeHead(200,{'Content-Type':type,'Content-Length':size,'Content-Disposition':`${url.searchParams.get('download')==='1'||type.includes('wordprocessingml')?'attachment':'inline'}; filename="${name.replace(/[^\x20-\x7e]/g,'_').replace(/"/g,'')}"; filename*=UTF-8''${encodeURIComponent(name)}`});if(req.method==='HEAD')return res.end();return fs.createReadStream(original.file).pipe(res);}
    // 收件箱页只放「需要你」（筛选、拟投、草稿、跟进在指挥台的行上答，lib/hq.mjs）。
    // 手机（网关带 x-radar-phone：on / limited）：「需要你」加上等你批准的草稿、投递和跟进，通知点进来的那一条（?ask=）也在（lib/hq.mjs phoneInbox）。
    if(url.pathname==='/api/inbox'&&req.headers['x-radar-phone']){const handOff=req.headers['x-radar-phone']!=='limited',focus=String(url.searchParams.get('ask')||'').slice(0,2000)||null,v=memo('inbox:phone:'+handOff,()=>withContentSig(phoneInbox(inboxNow(),{handOff})));return json({...(focus&&!v.asks.some(a=>a.id===focus)?phoneInbox(fullInboxNow(),{handOff,focus}):v),token});}
    if(url.pathname==='/api/inbox'){return json({...memo('inbox:blockers',()=>withContentSig(deskInbox(inboxNow()))),token});}
    // 指挥台 v2（lib/hq.mjs）：「需要你」、团队、每条线索一行（标签、八列、这一行上能答的信）；?worker=<key> 某位成员的日志和手上的事。都按文件签名缓存。
    if(url.pathname==='/api/hq'){
      
      const worker=url.searchParams.get('worker');
      if(worker!==null){if(!WORKER_KEYS.includes(worker))return json({error:'没有这个 worker',worker:worker.slice(0,40)},404);const inbox=inboxNow();return json({...memo('hq:worker:'+worker,()=>withContentSig(workerDetail(worker,centerNow(),inbox,{tally:hqNow().tally}))),token});}
      const inbox=inboxNow(), center=centerNow();
      return json({...memo('hq',()=>withContentSig(hqView({center,inbox,team:teamView(center,inbox)}))),token});
    }
    // 团队页（lib/crew-desk.mjs）：/api/team 六张卡；/api/team/<id> 一位的工作台（能做的事、任务、日志，在 workerDetail 上加）。
    if(url.pathname==='/api/team'||url.pathname.startsWith('/api/team/')){
      const id=url.pathname.slice('/api/team/'.length);
      if(url.pathname!=='/api/team'&&!WORKER_KEYS.includes(id))return json({error:'没有这位成员',member:id.slice(0,40)},404);
      const inbox=inboxNow(),center=centerNow();
      // 等你的事和指挥台 / 右侧面板同一份（lib/hq.mjs waiting，lib/crew-desk.mjs hqWaiting）。
      const hq=hqNow();
      if(url.pathname==='/api/team')return json({...memo('team',()=>withContentSig({members:deskList(center,inbox,{team:teamView(center,inbox),hq}),running_op:runningOp(center)})),busy_line:busyLine(center),caps:capabilities(null),token});
      const caps=capabilities(id);
      return json({...memo('team:'+id+':'+JSON.stringify(caps),()=>withContentSig(deskView(id,center,inbox,{caps,hq}))),token});
    }
    if(url.pathname==='/api/perf')return json({memo:[...memoCache].map(([k,v])=>({key:k,ms:v.ms,at:new Date(v.at).toISOString(),hits:v.hits||0})),views:memoStats(),rss_mb:Math.round(process.memoryUsage().rss/1048576),heap_mb:Math.round(process.memoryUsage().heapUsed/1048576),uptime_s:Math.round(process.uptime()),sse_clients:clients.size,sse_updates:sseUpdates,scheduler:scheduler.status(),workers:!workersOff,listener:false,sandbox,sandbox_models:sandboxModelsOn});
    if(url.pathname==='/api/ops/log')return json(opLog(url.searchParams.get('id')));
    if(req.method==='GET'&&url.pathname==='/api/host-job')return json(hostJobView(String(url.searchParams.get('id')||'')));
    if(url.pathname==='/api/leads')return json(leadsQuery(Object.fromEntries(url.searchParams)));
    if(url.pathname==='/api/application-plan')return json(applicationPlanView(url.searchParams.get('id')));
    if(url.pathname==='/api/settings/providers/status')return json(await allStatuses());
    if(url.pathname==='/api/settings/providers/presets')return json(presetView());
    // OfferCrew 补给：{ available, enabled, remaining_label, paused, reason, demo }；沙盒里不联网。
    if(url.pathname==='/api/model/free')return json(await freeModelView());
    // 导航栏和手机「我的」里的 ⚡ 余额：只读本机记下的（不联网）；文字模型不用补给时 show: false。
    // 补给那一格（手机「我的」）：余额、到期，加上登着的账户邮箱（10-03）。
    if(url.pathname==='/api/model/supply'){let nav={show:false};try{nav=freeQuotaView()?.nav||nav;}catch{}let email=null;try{email=currentAccount()?.email||null;}catch{}return json({...nav,email});}
    if(url.pathname==='/api/model/catalog')return json(modelCatalogView());
    if(url.pathname==='/api/model/source')return json(modelSourceView());
    if(url.pathname==='/api/local-runtimes'){const runtimes=detectRuntimes({fresh:url.searchParams.get('fresh')==='1'});if(url.searchParams.get('fresh')==='1')memoCache.clear();return json({runtimes});}
    // 「用 ChatGPT 账号登录」（lib/codex-app.mjs，方案附录 H）：只报装没装、版本、登上没有。
    if(url.pathname==='/api/codex')return json({...await codexStatus(),token});
    if(url.pathname==='/api/migrate/export'){
      // 下载是读：包打在系统临时目录里，传完就删，不落进数据目录、不记事件（读请求不写，契约第五节）。
      const ws=url.searchParams.get('state')==='1',wl=url.searchParams.get('logins')==='1',tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-export-'));
      const r=exportBundle({withState:ws,withLogins:wl,out:path.join(tmpDir,`radar-bundle-${new Date().toISOString().slice(0,10).replaceAll('-','')}${ws?'-state':''}${wl?'-logins':''}.tgz`),log:false});
      res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${path.basename(r.path)}"`,'Content-Length':String(r.bytes)});
      const done=()=>fs.rm(tmpDir,{recursive:true,force:true},()=>{});fs.createReadStream(r.path).on('close',done).pipe(res);return;
    }
    if(url.pathname==='/api/memory')return json(listNotes({q:url.searchParams.get('q')||'',kind:url.searchParams.get('kind')||null,by:url.searchParams.get('by')||null,number:url.searchParams.get('number')||null,company:url.searchParams.get('company')||null,limit:url.searchParams.get('limit')||50}));
    if(req.method==='GET'&&url.pathname==='/api/linkedin-inbox')return json(linkedinInboxView());
    if(req.method==='GET'&&url.pathname==='/api/agent')return json(agentProfile(url.searchParams.get('role')||'system'));
    if(req.method==='GET'&&url.pathname==='/api/portal-sessions')return json(portalSessionsView());
    if(url.pathname==='/api/draft')return json(draftView(String(url.searchParams.get('id')||''),{readonly:url.searchParams.get('readonly')==='1'}));
    // 对话里的小条和旧对话里的 goal / card 消息带上 task 和现算的状态（taskMessages）。列表只列对话（lib/chat.mjs listSessions / pageSessions 不列任务专用的那几种，行上不带任务）。
    // ?task=：T2 / T5 留下的那段任务对话还在就给它（只读着看）；任务的全部在卡片上（GET /api/tasks/<id>/card）。
    // 对话历史一页（?limit=&before=&q=，lib/chat.mjs pageSessions）；不带这几个参数照旧是全部。
    if(url.pathname==='/api/chat'){const one=x=>taskMessages({...x,title:shownTitle(x)});const task=url.searchParams.get('task');if(task){const t=taskChat(task);if(!t)return json({error:'这件事没有对话，看它的卡片'},404);return json({...one(loadSession(t.session_id)),task:t.task});}const id=url.searchParams.get('session');if(id)return json(one(loadSession(id)));const sp=url.searchParams;if(sp.has('limit')||sp.has('before')||sp.has('q')){const pg=pageSessions({limit:sp.get('limit'),before:sp.get('before'),q:sp.get('q')||''});return json({sessions:pg.sessions,next:pg.next,...chatBackends(),members:members()});}return json({sessions:listSessions(),...chatBackends(),members:members()});}
    // 对话浮层：手上的会话（不给就接着 6 小时内最近的那个）、每件事到哪了、团队在做几件、刚落地的回复；?examples=1 再带上空着时的例子。
    if(url.pathname==='/api/tasks'||url.pathname.startsWith('/api/tasks/')){try{return json({...await tasksGet(url.pathname,Object.fromEntries(url.searchParams),tasksDeps()),token});}catch(e){return json({error:e.message},e.status||400);}}
    if(url.pathname==='/api/talk'){const st=talkState({session_id:url.searchParams.get('session')||null,member:url.searchParams.get('member')||null,inbox:()=>inboxNow(),workers:!workersOff});if(url.searchParams.get('examples')==='1')st.examples=talkExamples(hqNow());if(st.session)st.session=taskMessages(st.session);return json({...st,token});}
    // 输入框下面那一行（按键时调，只读）：指令会动到哪几行，或者这句话会交给谁。
    if(url.pathname==='/api/talk/parse')return json(parseTalk(String(url.searchParams.get('text')||'').slice(0,500),{previous:url.searchParams.get('previous')||null,member:url.searchParams.get('member')||null,focus:talkFocus({rid:url.searchParams.get('focus')})}));
    if(url.pathname==='/api/lead'){const d=detail(url.searchParams.get('id'));if(d)try{d.resume_used=resumeUsed(d.lead);}catch{d.resume_used=[];}if(d)try{d.resume_default=d.resume_used.length?null:resumeDefault(d.lead);}catch{d.resume_default=null;}if(d)try{d.materials=leadMaterials(d.lead);}catch{d.materials=null;}return json(d||{error:'记录不存在'},d?200:404);}
    // 岗位页「进展」点开一步：这份证据说成人话（lib/lead-trace.mjs）；「材料」「进展」里的简历、截图从 /api/lead/file 读（只读、只给这条线索登记过的文件）。
    if(url.pathname==='/api/lead/trace'){try{return json(traceView(url.searchParams.get('id'),url.searchParams.get('file')));}catch(e){return json({error:e.code==='ENOENT'?'文件不存在':e.message},e.code==='ENOENT'?404:403);}}
    if(url.pathname==='/api/lead/file'){let lp;try{lp=leadFile(url.searchParams.get('id'),url.searchParams.get('file'));}catch(e){return json({error:e.code==='ENOENT'?'文件不存在':e.message},e.code==='ENOENT'?404:403);}const ext=path.extname(lp).toLowerCase(),name=path.basename(lp);if(ext==='.pdf')res.setHeader('Content-Security-Policy',"default-src 'none'; object-src 'self'; frame-ancestors 'none'");res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','Content-Disposition':`${ext==='.docx'?'attachment':'inline'}; filename="${name.replace(/[^\x20-\x7e]/g,'_').replace(/"/g,'')}"; filename*=UTF-8''${encodeURIComponent(name)}`});return fs.createReadStream(lp).pipe(res);}
    // 材料页（阶段三）：一版的内容（带 version）、Writer 的体检 / 改一句的结果；给了 proposal 再带上左右对比要的两份内容和改动。
    if(url.pathname==='/api/resume/letter'){try{return json({...letterView(String(url.searchParams.get('key')||'')),token});}catch(e){return json({error:e.message},e.status||400);}}
    if(url.pathname==='/api/resume/view'){try{const q=k=>url.searchParams.get(k)||null;return json({...withWriter(resumeView({doc:q('doc'),version:q('version'),saved:q('saved')==='1'}),{proposal:q('proposal'),compare:q('a')&&q('b')?{a:q('a'),b:q('b')}:null}),token});}catch(e){return json({error:e.message},e.status||400);}}
    if(url.pathname==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write(`event: ready\ndata: ${JSON.stringify({started_at:runtime.started_at})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    // 左栏「收件箱」后面的数字（每一页都有，web/app.js inboxBadge）：和收件箱页同一份缓存，只回一个数。
    // 「怎么拿授权码」（lib/mail/help.mjs）：引导和设置里那个链接打开的一页，不带脚本。
    if(url.pathname==='/help/mail-auth-code'){const {renderHelp}=await import('../lib/mail/help.mjs');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(renderHelp());}
    if(url.pathname==='/api/inbox/count')return json({total:memo('inbox:blockers',()=>withContentSig(deskInbox(inboxNow()))).total});
    let p;
    if(url.pathname==='/api/evidence'){p=evidencePath(url.searchParams.get('file'));if(!p)return json({error:'没有可展示的证据文件'},404);if(path.extname(p).toLowerCase()==='.pdf')res.setHeader('Content-Security-Policy',"default-src 'none'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'");}
    else {const pdfAsset=/^\/vendor\/pdfjs\/(?:cmaps\/[A-Za-z0-9_-]+\.bcmap|standard_fonts\/[A-Za-z0-9_-]+\.(?:pfb|ttf))$/.test(url.pathname);const route=WEB_ROUTES[url.pathname]||(/^\/settings\/[a-z-]+\.js$/.test(url.pathname)||pdfAsset?'web'+url.pathname:null);if(!route)return json({error:'not_found'},404);p=webFile(route);}
    // 浏览器会在内存里缓存 ES 模块，服务重启后旧页面拿不到新代码；给本地模块的 import 和入口脚本挂上本次启动的版本号。
    const ver=encodeURIComponent(runtime.started_at||'');
    if(/\.(html|js)$/.test(p)&&p.startsWith(webFile('web'))){let body=fs.readFileSync(p,'utf8');body=body.replace(/(from\s+['"])(\.{1,2}\/(?:[a-z-]+\/)?[a-z-]+\.js)(['"])/g,`$1$2?v=${ver}$3`).replace(/src="\/(app|command|chat)\.js"/g,`src="/$1.js?v=${ver}"`).replace(/import\(['"](\.\/[a-z-]+\.js)['"]\)/g,`import('$1?v=${ver}')`);if(p===webFile('web/index.html'))body=renderShell(body,{badge:sandboxBadgeWanted()&&url.searchParams.get('rec')!=='1'});res.writeHead(200,{'Content-Type':mime[path.extname(p)]});return res.end(body);}
    // 资源可能在升级途中缺失；打开成功才发 200，读取错误只影响这次请求，不能让引擎退出。
    const stream=fs.createReadStream(p);
    stream.once('error',e=>{if(res.headersSent||res.destroyed)return res.destroy();json({error:e.code==='ENOENT'?'文件不存在':'文件暂时无法读取'},e.code==='ENOENT'?404:500);});
    stream.once('open',()=>{if(res.destroyed)return stream.destroy();res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});stream.pipe(res);});
    res.once('close',()=>stream.destroy());
  }catch(e){json({error:e.code==='ENOENT'?'文件不存在':e.message,...(e.fix?{fix:e.fix}:{})},e.status||400);}
});
// 后台的事都由一个调度器驱动（lib/scheduler.mjs，05 第二节 2.4）：同名的不叠着跑，出错按退避重试，出错、恢复、卡住记运行日志，
// 谁在跑、上次结果在 /api/perf 的 scheduler 里，每半分钟记进账（meta.scheduler）。when 是「这一拍该不该跑」：后台任务关着、沙盒、成员暂停。
const execNode=(args,opts)=>new Promise((resolve,reject)=>execFile(process.execPath,args,{cwd:root,...opts},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr:String(stderr||'')})):resolve(stdout)));
const lockBusy=e=>String(e?.stderr||e?.message||e).includes('another_radar_writer_running');
// 页面上排队的反馈（标记、备注）：有排着的才起 pull-feedback；写锁被周期拿着就 30 秒后再看。
register('feedback-queue',{every:5000,label:'处理页面上的反馈',backoff:{min:30000,max:5*60000},
  when:()=>!workersOff&&cachedLines('state/feedback.ndjson').some(e=>e.source==='dashboard'&&e.status==='queued'),
  run:()=>execNode(['bin/pull-feedback.mjs','--dashboard-only'],{timeout:180000}).then(()=>null,e=>{if(lockBusy(e))return {again:30000};throw Error('反馈没处理成，请查看记录状态');})});
// 工作台重启时上一轮执行器可能还在跑（它现在是脱离进程组的，不会被一起杀掉），
// 也可能已经死了：把"运行中"记录和心跳对回真实情况，队列里的指令不再被堵住。
function reconcileExecutor(){
  const r=reconcileRunNow();
  if(!r)return;
  if(r.still_running){event('listener','run-now','fail',r.reason);return;}
  const hb=read('state/executor-heartbeat.json',{tasks:{}});
  for(const [key,t] of Object.entries(hb.tasks||{}))if(t.executor==='run-now'&&t.status==='working'&&(!r.since||t.task===r.since))clearTask({executor:'run-now',task:t.task});
  // 没做完的宿主任务还在 host-jobs 里，下一轮 host-work 会接着做；这里不重复排队，免得已完成的指令再回一遍。
  if(r.interrupted===false&&r.exit===0){event('listener','run-now','ok','上一轮本机 AI 已正常结束，记录已对回');return;}
  event('listener','run-now','fail',`上一轮本机 AI 没做完：${r.reason}${r.queue.length?`（这一轮合并了 ${r.queue.length} 条指令，没做完的下一轮继续）`:''}`);
}
if(!workersOff&&!sandbox)reconcileExecutor();
// System 自动修复：每 5 分钟看一次流程之外卡住的东西，按 config/host.json system_auto_repair 的节流交给执行器；启动 90 秒后先看一次。
register('auto-repair',{every:5*60000,first:90000,label:'System 自动修复',when:()=>!workersOff&&!agentPaused('patch'),
  run:()=>autoRepair({now:Date.now(),...repairInputs()}).catch(e=>{if(lockBusy(e)){event('system','auto-repair','skip','System 自动修复等状态写锁超时（另一个同步进程仍在写），5 分钟后再看');return null;}throw e;})});
// 对外动作（lib/actions.mjs，线 H）：每半分钟对一次账，有可领的（到点再试的、放回去重做的、「我登好了」放开的）就叫醒那一种 worker。
// 以前私信每分钟 kickSendDm、邮件每分钟 startMailSender 各兜一次底（02a 第四节第 3 条），现在只这一处。成员暂停时它的那几种不叫。
const ACTION_MEMBER={send_email:'quill',send_dm:'quill',prefill:'quill',submit:'quill',read_mail:'owl'};
register('actions',{every:30000,label:'对外动作的账',backoff:{max:2*60000},when:()=>!workersOff&&!sandbox,
  run:async()=>{const [A,K]=await Promise.all([import('../lib/actions.mjs'),import('../lib/action-kinds.mjs')]);const r=await K.tick({kick:k=>agentPaused(ACTION_MEMBER[k]||'quill')?false:A.kickWorker(k)});if(r?.kicked?.length||r?.orphaned||r?.verified||r?.requeued)memoCache.clear();return {kicked:r?.kicked?.length||0};}});
// 登录状态自己去看（lib/login-watch.mjs）：有账号正被盯着（刚点过「打开登录页」）每 5 秒一轮，平时 20 秒；
// 看到已登录就和你点「我登好了」一样继续，信自动消失。
let loginLast=0;
register('login-watch',{every:5000,label:'看登录状态',backoff:{max:60000},when:()=>!workersOff&&(watchingAny(Date.now())||Date.now()-loginLast>=20000),
  run:async()=>{loginLast=Date.now();const ib=inboxNow();const r=await tickLoginWatch({asks:ib.asks,resumable:ib.resumable||[],quiet:inQuietHours(Date.now()),probeMany:probeAccounts,ready:accountReady,resume:resumeSatisfied});if(r.changed)memoCache.clear();loginSay(r);}});
// 看到登好了：马上告诉开着的页面（SSE 的 login 事件，页面说「LinkedIn 登好了」、把那一行打勾），不等下一批变化（第 6b 轮）。
function loginSay(r){for(const d of r?.done||[])if(d.kind==='logged_in'){const data=JSON.stringify({label:d.label||d.keys?.[0]||'',keys:d.keys||[]});for(const res of clients){try{res.write(`event: login\ndata: ${data}\n\n`);}catch{}}}}
// System 监工（lib/system/watch.mjs）：每分钟一拍，照标准做法表（lib/system/playbook.mjs）做掉能做的，每做一下记一行。
// System 暂停时不动手；沙盒里只记一行不动手（tickWatch 自己看）。动作没做成、整拍没跑完都记事件（一天一行），连着几拍没跑完
// 健康账本里出「监工停了」（watchTick）。
register('system-watch',{every:60000,label:'System 监工',when:()=>!workersOff&&!agentPaused('patch'),
  run:async()=>{const r=await watchTick();if(r.done.length)memoCache.clear();if(r.error)console.error('system-watch',r.error);return {done:r.done.length};}});
// 专用 Chrome 的看门狗（lib/browser-host.mjs）：每分钟看一眼，Chrome 崩了或者你把它退出了就清掉状态，下次要用时再起，
// 不在这里重新拉起来（你自己关掉的，不该马上又弹出来）。闲着就关：10 分钟没用过、又没有给你看的标签页，就关掉（主会话 10-02）。
register('browser-idle',{every:60000,label:'看专用 Chrome',reach:'专用 Chrome',when:()=>!workersOff&&!sandbox&&browserEngine()==='chrome',
  run:async()=>{const r=await checkHost({idleMs:10*60000});if(r.idle_closed)event('system','browser','ok','专用 Chrome 闲了 10 分钟，已关掉；要用时再打开');}});
// 沙盒里的本机 AI 要用专用 Chrome：它留下请求（lib/browser-host.mjs requestHost），这里替它起。
register('browser-request',{every:2000,label:'替本机 AI 打开专用 Chrome',reach:'专用 Chrome',backoff:{max:60000},when:()=>!workersOff&&!sandbox,
  run:async()=>{const r=await serveHostRequest();if(r?.error)event('system','browser','error',`本机 AI 要用专用 Chrome，没打开：${r.error}`);}});
// BOSS 聊天列表（lib/boss-inbox.mjs）和脉脉消息列表（lib/maimai-inbox.mjs）：默认关；打开后 09:00–21:00 只读看列表，不点开对话。
// BOSS 每小时一次、整点后 5 分钟，脉脉每两小时一次、整点后 35 分钟：两家错开，同一时刻只开一个任务空间（lib/list-watch.mjs listGate 看 minute），
// BOSS 那一项在跑时脉脉这一拍不跑。闸在 runBossInbox / runMaimaiInbox 里（开关、时段、登录、Watcher 暂停、沙盒）。
register('linkedin-inbox',{every:60000,label:'检查 LinkedIn 网页消息',when:()=>!workersOff&&!sandbox,run:async()=>{const r=await runLinkedInInbox();if(r.status!=='skipped')memoCache.clear();}});
register('boss-inbox',{every:60000,label:'看 BOSS 聊天列表',when:()=>!workersOff,
  run:async()=>{try{const r=await runBossInbox({hours:MAIL_POLL_HOURS,minute:localMinute()});if(r.status==='ok')memoCache.clear();}catch(e){event('owl','boss-chat','fail',`BOSS 聊天列表没读成：${String(e?.message||e).slice(0,120)}`);}}});
register('maimai-inbox',{every:60000,label:'看脉脉消息列表',when:()=>!workersOff&&!scheduler.running('boss-inbox'),
  run:async()=>{try{const r=await runMaimaiInbox({hours:MAIL_POLL_HOURS,minute:localMinute()});if(r.status==='ok'||r.status==='blocked')memoCache.clear();}catch(e){event('owl','maimai-chat','fail',`脉脉消息列表没读成：${String(e?.message||e).slice(0,120)}`);}}});
// 即时执行器（本机 AI 跑 user_task、system_repair）：沙盒里请求照常排队（lib/run-now.mjs 记了 sandbox: skipped），执行器（bin/host/run-now.sh → Codex / Claude）
// 不拉起，也不去对账、终止别的进程。执行器在指挥台上被暂停了：排队的指令留在队列里，恢复后再拉起（lib/agents.mjs）。
register('run-now',{every:5000,label:'即时执行器',backoff:{max:60000},when:()=>!workersOff&&!sandbox&&!agentPaused('executor'),run:()=>{
  reconcileExecutor();
  // 只认 lib/capabilities.mjs localAiGate 那一道：本机 AI 没打开就不拉起，排着的留在队列里、每批记一条；打开了带上 App 自己的账号和受限运行的变量。
  let launch;try{launch=runNowLaunch({root});}catch{return;}if(!launch)return;
  tickRunNow({spawn:started=>new Promise(resolve=>{
    const task=started.running_since||new Date().toISOString();
    event('listener','run-now','ok',`即时执行器已拉起，合并 ${started.queue?.length||0} 条指令`);
    beat({executor:'run-now',task,step:'running',detail:(started.queue||[]).map(q=>q.reason).join(' / ').slice(0,160)});
    // 脱离工作台的进程组：工作台重启不会杀掉正在干活的执行器；30 分钟兜底超时。
    let done=false,killer;const finish=(code,errorText)=>{if(done)return;done=true;clearTimeout(killer);
      if(code!==0){const why=runtimeFailure(read(RUN_NOW_STATE,{}),code)||(code===75?'本机 AI 仍被上一轮占用':exitWords(code,{overdue:!!read(RUN_NOW_STATE,{}).overdue,signal:errorText}));event('listener','run-now','fail',`本机 AI 这一轮没做完：${why}`);beat({executor:'run-now',task,step:'exited',detail:why.slice(0,160),status:'failed'});}
      else clearTask({executor:'run-now',task});
      resolve({code,error:code!==0?String(errorText||`exit ${code}`).slice(0,200):null});};
    let child;
    try{child=spawn('/bin/zsh',['bin/host/run-now.sh'],launch);}catch(e){finish(1,e.message);return;}
    child.unref();notePid(child.pid);
    // 30 分钟兜底只由 reconcileRunNow 按清醒时间判断；这里原来的 setTimeout 按墙钟算（Node 的计时器在休眠里照走），
    // 合盖期间 DarkWake 拉起的执行器醒来就被杀（2026-09-23 exit 143）。
    child.on('error',e=>finish(1,e.message));
    child.on('exit',(code,signal)=>finish(code??1,signal?`signal ${signal}`:null));
  })});
}});
// 本机 AI 在成员页上被暂停时，上面那一项不跑：正在跑的那一轮照样按 30 分钟停下、对回记录（以前暂停期间没人对账，超时的一直挂着）。
register('run-now-watch',{every:30000,label:'本机 AI 对账',when:()=>!workersOff&&!sandbox&&agentPaused('executor'),run:()=>{reconcileExecutor();}});
// 合盖睡眠时跳过的定时周期（lib/cycle-catchup.mjs）：醒着就经操作台补一轮轻量周期，每个错过的时段最多一轮；
// 错过的是完整周期那一档（09:05 / 13:05 / 18:05）就带上判断和匹配（cycle-catchup，10-02 开箱第 3 轮 D）。
// 这一拍比预定晚很多（刚醒，或只是 DarkWake）就先不动，等下一拍准时再看（late 是调度器给的「这一拍晚了多少」）。沙盒和不开后台任务时不跑。
register('cycle-catchup',{every:30000,label:'补跑错过的周期',when:()=>!workersOff&&!sandbox,
  run:({now,late})=>{tickCatchup({now,late,start:({judge,discover}={})=>runOp(judge||discover?'cycle-catchup':'cycle-light',{now,discover:!!discover})});}});
// 桌面版（RADAR_SCHEDULER=app，lib/capabilities.mjs appSchedules）：到点拉起周期、每小时读信（lib/app-schedule.mjs 算到没到点，这里每半分钟问一次）；
// 不开后台任务时不跑。每小时读信那一项按能力表：引擎能读才排。
if(appSchedules()&&!workersOff){const appSched=startAppSchedule({root,tz:TZ,every:0,jobs:()=>appSchedule({mail:mailReader().worker==='engine'})});register('app-schedule',{every:30000,label:'定时周期',run:()=>{appSched.tick();}});}
// 旧规则判断：补齐全局队列，到期空闲时启动 Judge；遵守后台开关、沙盒和 Judge 暂停。
register('policy-review',{every:30000,label:'旧判断重判队列',when:()=>!workersOff&&!sandbox,run:()=>policyReviewTick()});
// 补了资料、当时手上有别的在跑而排着的重新判断（lib/command-center.mjs rejudgePendingTick，开箱第 4 轮 F06）：那一轮跑完就起。
// 它接的是你刚才那次保存，所以不看「不开后台任务」，和保存时直接起的那一次一样。
register('rejudge',{every:15000,label:'排着的重新判断',backoff:{max:5*60000},run:()=>rejudgePendingTick()});
// 排着的操作（lib/op-queue.mjs，成员页 / 团队页 / 对话里点的「跑一轮」「运行」）：手上那一项跑完、写锁放开，就起排在最前面的那一个。
// 你点的，所以不看「不开后台任务」；同步执行，同一时刻只会起一个。排队文件在 state/ 里，工作台重启了接着排。
register('op-queue',{every:3000,label:'排队的操作',backoff:{max:60000},run:()=>{queueTick();}});
register('company-search-queue',{every:5000,label:'接着找公司岗位',when:()=>!workersOff&&!sandbox&&!agentPaused('scout'),run:async()=>{const {retryCompanySearches}=await import('../lib/company-search.mjs');return retryCompanySearches();}});
const memoCache=new Map();
// Writer 先问的几句逐题的回答（收件箱、任务卡片上答）：最多 6 题，每题一个选项、一句话。
const answersOf=a=>a&&typeof a==='object'&&!Array.isArray(a)?Object.fromEntries(Object.entries(a).slice(0,6).map(([k,v])=>[String(k).slice(0,8),{option:String(v?.option||'').slice(0,60),text:String(v?.text||'').slice(0,300)}])):null;
const tasksDeps=()=>taskDeps({asks:()=>inboxNow().asks||[],workers:()=>!workersOff,overrides:{answer:b=>answerAsk({id:String(b.id||''),option:String(b.option??''),text:String(b.text||'').slice(0,2000),reason:String(b.reason||'').slice(0,60),confirm:b.confirm===true,answers:answersOf(b.answers)},{center:centerNow()})}});
// 账（lib/db.mjs、lib/jobs.mjs）：启动时建库、把旧记录迁进去（第一次先把 state/ 备份一份）。读请求不建库、不写。
try{compactCards();}catch(e){console.error('tasks compact',e.message);}
try{const r=openJobs();if(r.backup)event('system','jobs','ok',`旧记录迁进账里了，备份在 ${r.backup}`);}catch(e){event('system','jobs','fail',`账没打开：${String(e.message||e).slice(0,160)}`);console.error('jobs',e.message);}
// 城市中英文别名归一，保留顺序；有改动先备份，启动时运行，读页面不写资料。
try{const {upgradeCityNames}=await import('../lib/city-upgrade.mjs');const r=upgradeCityNames();if(r.upgraded)event('system','profile-upgrade','ok',`已统一 ${r.upgraded} 项城市写法，旧资料已备份`,{refs:[{file:r.backup}]});}catch(e){console.error('city names upgrade',e.message);event('system','profile-upgrade','fail','城市写法还没统一，下次启动会继续；原资料保留');}
// Radar 的旧失败按当时证据纠正；在第一次读页面前完成，不重新抓取，也不调用模型。
try{const {upgradeCycleHistory}=await import('../lib/cycle-history-upgrade.mjs');const {upgradeCompanySearches}=await import('../lib/company-search.mjs');const rounds=upgradeCycleHistory(), searches=upgradeCompanySearches();if(rounds.upgraded||searches.upgraded)event('system','radar-upgrade','ok',`已按原始证据更正 ${rounds.upgraded} 轮找岗，${searches.upgraded} 件公司找岗已接上补链接续办`);}catch(e){console.error('radar history upgrade',e.message);event('system','radar-upgrade','fail','旧找岗结果更正没完成，下次启动会继续');}
// 第一次读页面前接上旧“不跟了”，不等刷新后才翻状态；新版明确选择始终优先。
try{const {upgradeFollowupPreferences}=await import('../lib/followup-upgrade.mjs');const r=await upgradeFollowupPreferences();if(r.upgraded)event('system','followup','ok',`沿用旧版跟进提醒决定 ${r.upgraded} 条`);}catch(e){event('system','followup','fail',`旧跟进提醒决定没接上：${String(e.message||e).slice(0,160)}`);console.error('followup upgrade',e.message);}
// 旧版交给本机 AI 的活（host-jobs）：投递转成引擎的预填动作，别的记已取消（lib/legacy-hands.mjs）。不等看门把它们判成失败。
// 迁完（最多等 5 秒）才推第一次状态、才开始听端口：页面第一次打开看到的就是迁好的，不在几秒后整页变一次。
// 先把升级前的旧失败、「材料变了」的批准按现在的认法核对一遍（lib/inbox-recheck.mjs）：一键投递门户的旧失败改成交给你，不在方向里的批准收起来，其实没变的放回已批准、下面一起转成预填动作。
const legacyDone=import('../lib/inbox-upgrade.mjs').then(m=>m.upgradeInbox()).catch(e=>{event('system','inbox','fail',`旧提醒没收好：${e.message}`);console.error('inbox upgrade',e.message);}).then(()=>import('../lib/inbox-recheck.mjs')).then(async m=>{await m.recheckOldFailures();await m.recheckApprovals();}).catch(e=>console.error('inbox-recheck',e.message))
  // 旧版留下的失败发信（实测 10-04 #503）：升级成试满了的失败信，收件箱给三个选择（lib/mail/send.mjs upgradeOldFailures）。
  .then(()=>import('../lib/mail/send.mjs')).then(m=>m.upgradeOldFailures()).catch(e=>{event('system','send-approved','fail',`旧版没发出去的邮件没升级成：${String(e.message||e).slice(0,160)}`);console.error('old send failures',e.message);})
  .then(()=>import('../lib/legacy-hands.mjs')).then(m=>m.retireLegacyHostJobs().then(r=>{if(r.retired)event('system','jobs','ok',`旧版交给本机 AI 的活 ${r.retired} 件：新版由引擎做${r.prefill?`，${r.prefill} 件转成了预填`:''}`);})
  // 账上、卡上还在「等本机 AI」的旧活（L2）：引擎做的记已取消，文字能做的放回排队，只有本机 AI 能做的那一步进收件箱；即时执行器队列里没人等的去掉。
  // 旧版把「发 N」当成本机 AI 的活（F 节第 4 条）：转成引擎的发送动作，那封「要动电脑」的信收掉（lib/legacy-hands.mjs convertLegacySends）。
  .then(()=>m.convertLegacySends().then(r=>{if(r.converted||r.missing)event('system','jobs','ok',`旧版留下的「发」${r.converted+r.missing} 件改由引擎发送${r.held?`，${r.held} 件批准太久了，收件箱里等你再确认`:''}`);}).catch(e=>{event('system','jobs','fail',`旧版留下的「发」没转成：${String(e.message||e).slice(0,160)}`);}))
  // 上一版转「发 N」时被闸挡下、只记了事件的：草稿上补记号，收件箱出能操作的信（lib/legacy-hands.mjs recoverBlockedLegacySends）。
  .then(()=>m.recoverBlockedLegacySends().catch(e=>{event('system','jobs','fail',`旧版的「发」被挡下的那几封没补上信：${String(e.message||e).slice(0,160)}`);}))
  .then(()=>m.settleLocalAiWaits()).then(r=>{const n=r.cancelled+r.requeued+r.letters;if(n)event('system','jobs','ok',`旧版留下的活 ${n} 件：${[r.cancelled&&`${r.cancelled} 件改由引擎做`,r.requeued&&`${r.requeued} 件重新排了`,r.letters&&`${r.letters} 件要动电脑的进了收件箱`].filter(Boolean).join('，')}`);})).catch(e=>console.error('legacy-hands',e.message))
  // 批准超过 24 小时还没做的对外动作（旧版迁进来的、上面转成预填的、以前排着的）：一起来就摆成「等你」，收件箱出信；沙盒里也一样（只写账）。
  .then(()=>import('../lib/action-kinds.mjs')).then(()=>import('../lib/actions.mjs')).then(A=>{const r=A.holdStale();if(r.held)event('system','actions','ok',`${r.held} 件批准超过一天的对外动作没有自动做，等你在收件箱再确认`);}).catch(e=>{event('system','actions','fail',`批准太久的对外动作没摆好：${String(e.message||e).slice(0,120)}`);console.error('stale',e.message);})
  // 旧版没挂动作的投递卡：挂上这条线索的动作，或者照线索落定一次（lib/apply-retry.mjs）；以后卡只照账。
  .then(()=>import('../lib/apply-retry.mjs')).then(m=>{const r=m.settleLegacyApplyCards();if(r.settled)event('system','tasks','ok',`旧版的投递卡 ${r.settled} 张照线索上的记录落定了`);}).catch(e=>console.error('legacy apply cards',e.message))
  // 预填好、停在提交前的那几页还在不在专用 Chrome 里（O3）：没了就照实说、给「重新预填」（lib/application-page.mjs checkKeptPages）。
  .then(()=>checkKeptPages({from:'startup'})).catch(e=>console.error('kept pages',e.message));
// 任务卡推状态、接力、开工、回写（lib/tasks.mjs settleTasks）和看门（lib/jobs.mjs watch）：在这一项里做，不在读请求里做。
// 旧记录迁完（最多等 5 秒）就先跑一次：页面第一次打开看到的就是推好的状态，不在几秒后整页变一次。之后每 4 秒。
const legacyWait=Promise.race([legacyDone,new Promise(r=>setTimeout(r,5000).unref?.())]);
legacyWait.then(()=>register('tasks-settle',{every:4000,first:0,label:'任务同步',backoff:{max:60000},run:async()=>{await settleTasks(tasksDeps());watchJobs();}}));
// 收件箱里旧记录的重新判断（lib/inbox-recheck.mjs）：没编号的拟投补编号、「材料变了」重新核对……一分钟一次，旧记录迁完就先跑一次（不在读请求里写）。
legacyWait.then(()=>register('inbox-recheck',{every:60000,first:0,label:'收件箱旧记录核对',run:async()=>{const u=await import('../lib/inbox-upgrade.mjs');u.upgradeInbox();const m=await import('../lib/inbox-recheck.mjs');await m.numberWaiting(centerNow());await m.recheckOldFailures();await m.recheckApprovals();}}));
// 推荐闸（lib/recommend-sweep.mjs）：过了零点放今天的名额、方向补上以后放排队的、线改了以后按新线重核。一分钟一次，判断跑完也会跑。
legacyWait.then(()=>register('recommend-sweep',{every:60000,first:0,label:'推荐放量',run:async()=>{const m=await import('../lib/recommend-sweep.mjs');m.sweepRecommendations();}}));
// 只是告诉你一声的信（lib/notices.mjs）：写进运行日志、自己收起，不在收件箱里等你点「知道了」。
legacyWait.then(()=>register('notice-sweep',{every:60000,first:5000,label:'知会写进运行日志',run:async()=>{const m=await import('../lib/notices.mjs');const asks=inboxNow().asks||[];if(asks.some(m.noticeOnly))await m.sweepNotices(asks);}}));
const inboxNow=()=>memo('inbox',()=>withContentSig(askTasks(inboxView(centerNow())))); // 每封信带它属于的那件活（lib/task-chat.mjs askTasks）
// 推送及通知焦点读完整候选，不能让首页门户池的 40 条上限推进推荐水位。
const fullInboxNow=()=>memo('inbox:full',()=>inboxView(centerNow(),{poolLimit:Infinity}));
// 对话面板（lib/talk.mjs）：Desk 答「现在怎么样」要看指挥台同一份行和信；面板上「正在看」的那一条只收 rid / 编号。
const hqNow=()=>{const inbox=inboxNow(),center=centerNow();return memo('hq',()=>withContentSig(hqView({center,inbox,team:teamView(center,inbox)})));};
const talkFocus=f=>f&&typeof f==='object'&&(f.rid||f.number||f.resume)?{rid:String(f.rid||'').slice(0,80),number:Number(f.number)||null,...(f.resume&&typeof f.resume==='object'?{resume:{doc:String(f.resume.doc||'').slice(0,12),version:String(f.resume.version||'').slice(0,12),selection:Array.isArray(f.resume.selection)?f.resume.selection.slice(0,40).map(x=>String(x).slice(0,12)):[]}}:{})}:null; // 材料页的「正在看」（focus.resume）原样交给 lib/talk.mjs，那边核对
const chatCenter=()=>{const c=commandCenter(runtime),desk=hqNow();return {...c,tally:desk.tally,current_work:{asks:desk.waiting_ids.map(id=>desk.asks[id]).filter(Boolean),tasks:viewTasks({asks:()=>inboxNow().asks||[],workers:()=>!workersOff}).cards}};};
const centerNow=()=>memo('center',()=>withContentSig(commandCenter({...runtime,process:{rss_mb:Math.round(process.memoryUsage().rss/1048576),uptime_s:Math.round(process.uptime())}})));
// 视图缓存：没有变化（lib/changes.mjs：库的写、别的进程的写、盯着的文件）就复用，最多 60 秒（到期重算是为了「x 分钟前」、到期时间这类随时间变的字段）。
let changeGen=0;onChange(()=>{changeGen++;});
function memo(key,compute){
  const hit=memoCache.get(key);
  if(hit&&hit.gen===changeGen&&Date.now()-hit.at<60000){hit.hits=(hit.hits||0)+1;return hit.value;}
  const gen=changeGen, started=Date.now(), value=compute();
  memoCache.set(key,{gen,value,ms:Date.now()-started,at:Date.now(),hits:0});
  return value;
}
const VOLATILE=new Set(['ts','rss_mb','uptime_s','listener_checked_at','due_in_s','idle_minutes','sync_at']);
function withContentSig(value){
  const body=JSON.stringify(value,(k,v)=>VOLATILE.has(k)?undefined:v);
  return {...value,content_sig:crypto.createHash('sha1').update(body).digest('hex').slice(0,16)};
}
// 推给页面（05 第二节 2.3）：每 200 毫秒把攒下的变化合成一批，SSE 事件 changes：{tables: {jobs: [id…], leads: null, …}}（null 是整张表：
// 还在文件里的状态不知道哪几行）。页面上每一块只重拉、只重画自己关心的表（web/live.js）。
// 手机（lib/phone.mjs phoneUpdate）不分表，有变化就告诉它，最多 5 秒一次。
hostFeed();
let sseUpdates=0,phoneDue=false,phoneAt=0;
const sse=text=>{for(const res of clients){if(res.writableLength>100000){res.destroy();clients.delete(res);continue;}try{res.write(text);}catch{}}};
register('feed',{every:200,label:'推送变化',backoff:{min:1000,max:10000},run:()=>{
  const tables=drainChanges();
  if(tables){sseUpdates++;phoneDue=true;sse(`event: changes\ndata: ${JSON.stringify({tables})}\n\n`);}
  if(phoneDue&&Date.now()-phoneAt>=5000){phoneDue=false;phoneAt=Date.now();try{phoneUpdate();}catch{}}
}});
// 保活注释每 10 秒一次。
register('feed-ping',{every:10000,label:'推送保活',run:()=>{sse(': ping\n\n');}});
// 盯着还在文件里的状态（lib/changes.mjs watchFiles）：启动时挂上，之后每半分钟补挂（目录后来才有的、断了的）。
register('feed-files',{every:30000,first:0,label:'盯状态文件',run:()=>{const r=watchFiles();if(r.failed.length)throw Error(`${r.failed.map(f=>f.dir).join('、')} 没盯上：${r.failed[0].error}`);return {watching:r.watching.length};}});
// 调度器的状态记进账（meta.scheduler）：别的进程（体检、System）看得到谁在跑、上次结果。
register('scheduler-ledger',{every:30000,label:'记调度状态',when:()=>dbExists(),run:()=>{setMeta('scheduler',{at:new Date().toISOString(),pid:process.pid,tasks:scheduler.status()});}});
// 手机（lib/phone.mjs）：配过手机或正在配对时连中转；手机发来的请求只能看进度、回收件箱的信（同一个 answerAsk）、跟团队说话。
// 手机（加密通道）的「等你」和电脑是同一张单子（lib/hq.mjs phoneInbox → deskInbox）：只是告诉你一声的、指挥台行上的筛选不算。
const phoneDeps={inbox:()=>phoneInbox(inboxNow()),center:()=>centerNow(),answer:async(input,ctx)=>{const r=await answerAsk(input,ctx);memoCache.clear();return r;},
  talk:makeTalk({talkTurn,classifyTalk,dispatch:(t,o)=>dispatchCommand(t,{origin:'phone',...o}),center:chatCenter,hq:()=>hqNow()}),
  handoff:({session_id,text})=>handTurn({session_id,text},{kick:()=>syncNow({...tasksDeps(),force:true})}),
  // 手机上可以打开任意一件活的对话接着说（一台设备自己的那段照旧只有一段）。
  taskSession:id=>{try{return !!loadSession(String(id||'')).task;}catch{return false;}},
  // 第二阶段：手机上跑工作台自己的页面，请求经加密通道交给手机网关（lib/phone/gateway.mjs），网关带着口令来问本机这个端口。
  gateway:{port,token,webRoutes:PHONE_ROUTES,
    askById:id=>inboxView(centerNow(),{includeSnoozed:true,poolLimit:Infinity}).asks.find(a=>a.id===id)||null,
    taskAsk:async id=>{const card=readCards().find(c=>c.id===id);if(!card)return null;if(card.kind==='goal'&&card.halt&&!card.halt.answered)return {goal:true};return card.links?.ask_id||(await syncNow(tasksDeps())).cards.find(c=>c.id===id)?.links?.ask_id||null;},
    classifyTalk:t=>classifyTalk(t),info:()=>({sandbox,started_at:runtime.started_at})},
  // 新消息提醒（lib/phone/push.mjs，每分钟一拍由调度器叫，register 交给它）：对话里落地的回复 / 做完的事，收件箱里等你拍板的信；夜里先攒着。
  push:{register,items:()=>{const inbox=inboxNow();return pushItems({landed:talkState({inbox:()=>inbox,workers:!workersOff}).landed,asks:deskInbox(inbox).asks,recommendations:fullInboxNow().asks});},quiet:now=>inQuietHours(now,read('config/concierge.json',{}))}};
await legacyWait;
server.listen(port,'127.0.0.1',()=>{try{startPhone(phoneDeps);}catch(e){console.error('phone',e.message);}event('listener','web','ok',sandbox?`本地工作台已启动（演示 / 沙盒模式${sandboxModelsOn?' · 模型已开：只调文字模型，别的不会发出去':'：不会发出任何东西'}）· http://127.0.0.1:${port}`:`本地工作台已启动 · http://127.0.0.1:${port}`);console.log(`${BRAND}: http://127.0.0.1:${port}${sandbox?(sandboxModelsOn?' (sandbox, text models on: only model calls leave this machine)':' (sandbox: nothing leaves this machine)'):''}${workersOff?' (workers off)':''}`)});
server.on('error',e=>{console.error(e.message);scheduler.stop();stopWatching();process.exitCode=1;});
function shutdown(){try{stopPhone();}catch{}scheduler.stop();stopWatching();for(const r of clients)r.end();event('listener','web','skip','本地工作台已停止');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
// 材料（实施计划 3.1b）：开始监听以后，异步把这个 RADAR_ROOT 下旧格式的简历数据转成新格式一次（lib/resume-store.mjs，先整目录备份）。
// 不挡启动；日志只写一行；出错只记原因，服务照常，进程不退出（材料页打开时 resumeView 会再试一次，并显示原因）。
import { migrateWorkspace, migrationState, humanFs } from '../lib/resume-store.mjs';
import { migrateResumes as migrateResumesOnce } from '../lib/resume-assistant.mjs';
// 简历数据的迁移在启动时做一次（lib/resume-assistant.mjs migrateResumes；读请求只读，契约第五节）。另一处正在转（拿不到锁）：30 秒后再来；
// 有转不过来的（材料页显示原因）：10 分钟再试一次，你修好文件以后不用重启。
let resumeRetryAt=0;
function migrateResumes(){let r=null;try{r=migrateResumesOnce();}finally{const wait=r?.busy?30000:migrationState()?.status==='failed'?600000:0;resumeRetryAt=wait?Date.now()+wait:0;}return r;}
// 到点再试一次（调度器每半分钟问一次）。没转成的原因记在 migrationState 里，材料页显示。
register('resume-migrate',{every:30000,label:'转换简历数据',when:()=>resumeRetryAt>0&&Date.now()>=resumeRetryAt,run:()=>{try{migrateResumes();}catch{}}});
server.once('listening',()=>setImmediate(()=>{let line;try{const r=migrateResumes();line=r.migrated.length&&!r.failed?.length?`简历数据已转成新格式，备份在 ${r.backup}`:r.failed?.length||r.busy?`简历数据转换没完成：${migrationState()?.message||r.failed?.[0]?.error||'另一处正在转换，下次再试'}`:'简历数据已经是新格式';}catch(e){line=`简历数据转换没完成：${e?.code?humanFs(e):String(e?.message||e).split('\n')[0].slice(0,160)}。原来的文件没有改动`;}console.log(line);}));
// 材料页的几个脚本（web/resume*.js，2026-10-01）：追加进页面文件表。
// 页面和服务端共用的两张表（lib/routes.mjs 链接、lib/vocab.mjs 词表），浏览器按 /routes.js、/vocab.js 取同一个文件。
// 路由表、词表：页面和服务端同一个文件（web/routes.js、web/vocab.js 只是转一下 lib/ 里那份）。
Object.assign(WEB_ROUTES,{'/routes.js':'web/routes.js','/vocab.js':'web/vocab.js','/lib/routes.mjs':'lib/routes.mjs','/lib/vocab.mjs':'lib/vocab.mjs','/lib/event-reasons.mjs':'lib/event-reasons.mjs','/lib/event-search.mjs':'lib/event-search.mjs'});
Object.assign(WEB_ROUTES,{'/interview-materials.js':'web/interview-materials.js','/interview-materials.css':'web/interview-materials.css','/resume-api.js':'web/resume-api.js','/resume-paper.js':'web/resume-paper.js','/resume-editor.js':'web/resume-editor.js','/resume-letter.js':'web/resume-letter.js','/resume-compare.js':'web/resume-compare.js'});
// 内置邮箱（lib/mail/live.mjs）：工作台开着、后台任务开着时实时收新信——一条只读的常驻连接听着，有新信就跑一次读信
// （lib/mail/inbox.mjs，和每小时的巡检同一件事，按游标读，读过的不再读）。没连邮箱时它只每分钟看一眼账号文件。
import { startMailLive } from '../lib/mail/live.mjs';
import { runMailRead } from '../lib/mail/inbox.mjs';
server.once('listening',()=>{if(sandbox||workersOff)return;const live=startMailLive({run:async()=>{if(workersOff)return;const r=await runMailRead();if(r.status==='changed'){memoCache.clear();const {draftReplies}=await import('../lib/mail/draft.mjs');if((await draftReplies().catch(()=>({}))).drafted)memoCache.clear();}}});const end=()=>{live.stop().catch(()=>{});};process.once('SIGTERM',end);process.once('SIGINT',end);});
// 升级后同步公司包（lib/pack-sync.mjs）：开始监听以后对一遍新版自带的公司包；不联网，出错只记运行日志，不挡启动。
import { syncPacksOnStart } from '../lib/pack-sync.mjs';
// 随新版带来的招聘源改正（lib/source-fixes.mjs）：公司包对完以后对一遍；不联网，出错只记运行日志。
import { applySourceFixesSafely } from '../lib/source-fixes.mjs';
server.once('listening',()=>setImmediate(()=>{syncPacksOnStart().catch(()=>{}).finally(()=>applySourceFixesSafely());}));
