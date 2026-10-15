import { currentAsks, settleDelivery } from './inbox-lifecycle.mjs';
import { controlCard } from './card-ops.mjs';
// 收件箱的数据和动作：inboxView 把指挥台已算好的「等我处理」队列交给 lib/asks.mjs 变成提问；
// answerAsk 执行你选的那个选项。
//
// 网页只回传「哪一项、第几个选项、你写的字」，要执行的步骤由服务端按当前数据重新算出来，
// 网页没法塞进任意指令。每一步都走已有入口（dispatchCommand / updateHostJob / recoverPortalSession
// / openForUser），发与投照旧要二次确认；草稿发送前核对你看到的正是现在要发的这一版。
import fs from 'node:fs';
import { autoApplyNeeds } from './needs.mjs';
import { followupSource } from './followup-state.mjs';
import { href } from './routes.mjs';
import { PASS_REASONS } from './feedback.mjs';
import { canCorrectSubmission, correctOwnerSubmission } from './manual-submission.mjs';
import { lines, read, write, writeLines, file } from './store.mjs';
import { cachedLines } from './state-cache.mjs';
import { buildAsks, leadChannel, jobQuestion, leadFacts, poolAsks, askVersion, plainWords, RESUME_ON_PAGE, draftAsk, infoAsk } from './asks.mjs';
import { inflightView } from './team.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { acceptableCity } from './city.mjs';
import { seniorTitle } from './command-center.mjs';
import { dispatchCommand, updateHostJob, ensureLeadNumber } from './dispatch.mjs';
import { runOp } from './ops.mjs';
import { answerBudget, skimAsks, pickTitles, freeModelAsks, budgetAsks } from './spend.mjs';
import { codeGuardAsks, ackCodeGuard } from './code-guard.mjs';
import { packSyncAsks, answerPackSync } from './pack-sync.mjs';
import { modelFaultAsks } from './system/breaker.mjs';
import { tailoredAsks, acceptTailored, declineTailored } from './resume-tailor.mjs';
import { bossInboxAsks, ackBossInbox } from './boss-inbox.mjs';
import { maimaiInboxAsks, ackMaimaiInbox, resumeMaimaiInbox } from './maimai-inbox.mjs';
import { linkedinBrowserAsks, ackLinkedInBrowser } from './linkedin-inbox.mjs';
import { linkedinAsks, ackLinkedIn } from './linkedin-mail.mjs';
import { mailAsks, ackMail, sendAsks, guessAsks, ackGuess, heldAsks, dropHeld, sendBlockedAsks, handHeld, noMailboxAsks } from './mail/asks.mjs';
import { bossInboundAsks, ignoreBossConversation } from './boss-inbound.mjs';
import { judgeAvailable } from './judge.mjs';
import { routeFreeform, recognize } from './intent.mjs';
import { draftFingerprint } from './drafts.mjs';
import { noteSwallowed } from './swallow.mjs';
import { openForUser, inLoginBrowser } from './browser-run.mjs';
import { openJobPage } from './open-job-page.mjs';
import { canonicalUrl } from './dedupe.mjs';
import { probeAccount } from './login-probe.mjs';
import { siteCheckAsks } from './site-check-asks.mjs';
import { showApplicationPage, pageGone } from './application-page.mjs';
import { recoverPortalSession } from './portal-recovery.mjs';
import { markPortalLoggedIn, loadPortalSessions, applyUrl, applyChannel } from './apply-channel.mjs';
import { familyOf, accountsView, hostOf, loadAccounts } from './accounts.mjs';
import { accountTable } from './account-table.mjs';
import { requestAction, specOf } from './action-kinds.mjs';
import { legacyPreview, continuePrefill } from './action-entry.mjs';
import { staleAsks, reconfirmStale, dropStale } from './stale-approvals.mjs';
import { localAiAsks, answerLocalAi } from './legacy-hands.mjs';
// 接着预填（lib/action-entry.mjs continuePrefill）：放开这条线索上压着的预填动作，没有就按你早先的批准再排一条。测试传假的。
const goOn = (rids, { now = Date.now(), origin = 'inbox' } = {}) => continuePrefill(rids, { now, origin });
import { autoSubmitEnabled } from './auto-apply.mjs';
import { event } from './events.mjs';
import { setApply, endedLead, appliedLead, contactLead, decidedLead } from './lead-state.mjs';
import { shelved } from './shelf.mjs';
import { requeueApply } from './action-entry.mjs';
import { loginWatchState, focusLogin, resetLoginWatch } from './login-watch.mjs';
import { remember, loadBook, lookup } from './answer-book.mjs';
import { cleanFieldLabel } from './needs.mjs';
import { TZ } from './tz.mjs';
import { uploadedResume, resumeNotes } from './resume-choice.mjs';
export { uploadedResume } from './resume-choice.mjs';
import { crewName } from './crew.mjs';
import { goalAsks, answerGoal, confirmApply, applyClaims } from './card-ops.mjs';
import { readCards } from './cards.mjs';
import { jobOfCard } from './task-ledger.mjs';
import { controlled } from './task-control.mjs';
import { hasApplicationApproval } from './submission-policy.mjs';
import { writerAsks } from './task-writer.mjs';
import { firstRoundAsk } from './first-round.mjs';
import { unlockAsk } from './unlock.mjs';
import { skippedGuideAsk, onboardingState } from './onboarding-state.mjs';
import { currentFacts } from './facts.mjs';
import { directionSet, heldRec } from './recommend-gate.mjs';

const SNOOZE_PATH = 'state/ask-snooze.json';
// 排除的公司也算结束：「没找到联系人，换个方式推进？」和终审「确认提交」都会让你去投它（journey 已经是 已排除）。
const settledLead = l => !!l && (l.superseded || excludedCompany(l) || endedLead(l) || appliedLead(l));
const NO_CONTACT = /(?:未|没有?)(?:找到|发现|公开)[^。；]{0,16}(?:联系人|邮箱|招聘人|联系入口|联系方式)/;
const PLATFORM_NAME = { 'maimai.cn': '脉脉', 'zhipin.com': 'BOSS 直聘', 'linkedin.com': 'LinkedIn', 'liepin.com': '猎聘' };
const platformOf = u => { const h = hostOf(u); const k = Object.keys(PLATFORM_NAME).find(d => h === d || h.endsWith('.' + d)); return k ? PLATFORM_NAME[k] : null; };

// 最新的找人任务已经完成且明确没找到联系人，才需要你决定换条路。
// 旧的联系决定、排队时长不代表找过；这些进度只留在岗位行和任务里，不补成收件箱信。
export function stalledAsks({ leads = [], jobs = [], seen = new Set() } = {}) {
  const latest = new Map();
  // 你在这里选了新办法（收件箱交给执行器的 user_request 带着 record_id）之后，以那条为准：还在做就不再问，也没找到人才再回来。
  for (const j of jobs) if (/^(verify_contact_entry|prepare_application_packet)$/.test(j.kind || '') && (j.record_id || j.number != null) || (j.kind === 'user_request' && j.record_id)) latest.set(j.record_id || `n:${j.number}`, j);
  const out = [];
  for (const l of leads) {
    const rid = l.record_id || l.id;
    if (!rid || seen.has(rid) || settledLead(l) || !contactLead(l) || l.number == null) continue;
    const j = latest.get(rid) || latest.get(`n:${l.number}`);
    if (!j || j.status !== 'completed' || !NO_CONTACT.test(j.result || '')) continue;
    const channel = leadChannel(l), platform = platformOf(applyUrl(l)) || platformOf(l.url), n = l.number;
    const lead = { number: n, company: l.company, role: l.role, record_id: rid };
    const options = [];
    if (channel === 'portal' || channel === 'ats_form') options.push({ key: '1', label: '投递官网', steps: [{ type: 'action', kind: 'prefill', input: { number: n } }], primary: true, preview: 'form', hint: '按你的资料填写申请，材料变了会再问你' });
    if (platform) options.push({ key: String(options.length + 1), label: `在${platform}上直接沟通`, steps: [{ type: 'request', number: n, record_id: rid, details: `#${n} ${l.company}「${l.role}」：官网没有公开邮箱，改在${platform}上联系发布这个岗位的招聘者。按平台首联规范起草一段首次沟通的话，写成 platform_dm 草稿（to 用岗位链接 ${applyUrl(l) || l.url}），不要发送，交给我在收件箱审核。` }], primary: !options.length, hint: '系统起草一段首次沟通的话，发送前给你看' });
    if (!options.length) options.push({ key: '1', label: '打开申请入口，我自己来', steps: [{ type: 'open', url: applyUrl(l) || l.url }], primary: true });
    options.push({ key: String(options.length + 1), label: '不推进', steps: [{ type: 'command', text: `pass ${n} {reason}` }], reasons: ['方向不对', '城市不对', '年限或级别不符', '公司不想去', '薪资不符'], danger: true });
    out.push({ from: 'reacher', id: `stalled:${rid}`, type: 'decide', title: `#${n} ${l.company}`, question: '你让系统联系，但没找到公开的联系人，事情就停在这了。换个方式推进吗？', context: [String(l.role || '').slice(0, 40)].filter(Boolean), note: `${String(j.completed_at || j.created_at || '').slice(5, 10)} 核过入口：${plainWords(j.result).slice(0, 120)}`, detail: plainWords(j.result), options, other: { placeholder: '告诉系统怎么做', steps: [{ type: 'command', text: `关于 ${n} 号 ${l.company}：{text}` }] }, lead, url: applyUrl(l) || l.url || null, form_preview: rid, facts: leadFacts(l) });
  }
  return out;
}

// 终审信上「这次上传：…」和附注（没用上的那一版、还在等你看的定制版）：lib/resume-choice.mjs uploadedResume / resumeNotes，预填信（lib/asks.mjs）也用。
// 终审：表单已经填好、停在提交前（lib/auto-apply.mjs awaiting_final_review），截图和读回的字段给你看。
// 之前填好的那一页关了（打开申请页时发现的，lib/application-page.mjs pageGone）：多一个「重新预填」。
export const refillOption = (rid, key) => ({ key: String(key), label: '重新预填', steps: [{ type: 'refill', record_id: rid }] });
export function finalReviewAsks({ leads = [] } = {}) {
  return leads.filter(l => l.auto_apply?.status === 'awaiting_final_review' && !settledLead(l) && l.number != null).map(l => {
    const f = l.auto_apply.final_review || {}, n = l.number, rid = l.record_id || l.id;
    const info = autoApplyNeeds(l).find(n => n.kind === 'info');
    if (info) return infoAsk({ lead: { record_id: rid, number: n, company: l.company, role: l.role } }, l, null, info);
    // 自动提交关着（默认）：以前停在终审的也不再由系统提交——页面上检查后你自己提交。
    if (!autoSubmitEnabled()) return {
      from: 'reacher', id: `final:${rid}`, type: 'review', title: `#${n} ${l.company}`, question: `#${n} ${l.company} 已在浏览器里预填好。${f.resume_on_page ? `${RESUME_ON_PAGE}。` : ''}检查后在页面上提交`,
      context: [String(l.role || '').slice(0, 40), leadChannel(l) === 'portal' ? '门户' : '官方表单'].filter(Boolean),
      ...(resumeNotes(f, l) ? { note: resumeNotes(f, l) } : {}),
      preview: { kind: 'form', screenshot: f.screenshot || null, fields: f.fields || [], url: f.url || applyUrl(l), filled_at: f.at || null, resume: uploadedResume(f) },
      options: [
        { key: '1', label: '打开申请页', steps: f.dry ? [{ type: 'open', url: f.url || applyUrl(l) }] : [{ type: 'application_page', record_id: rid }], primary: true },
        { key: '2', label: '我已在页面上提交了', steps: [{ type: 'command', text: `${n} 这步好了` }] },
        { key: '3', label: '这条不推进', steps: [{ type: 'command', text: `pass ${n} {reason}` }], reasons: ['方向不对', '城市不对', '年限或级别不符', '公司不想去', '薪资不符'], danger: true },
        ...(pageGone(rid) ? [refillOption(rid, 4)] : []),
      ],
      lead: { number: n, company: l.company, role: l.role, record_id: rid }, url: f.url || applyUrl(l), facts: leadFacts(l),
    };
    return {
      from: 'reacher', id: `final:${rid}`, type: 'review', title: `#${n} ${l.company}`, question: `申请表已经按你的资料填好，停在提交前。${f.resume_on_page ? `${RESUME_ON_PAGE}。` : ''}看一眼截图和字段，没问题就提交。`,
      context: [String(l.role || '').slice(0, 40), leadChannel(l) === 'portal' ? '门户' : '官方表单'].filter(Boolean),
      ...(resumeNotes(f, l) ? { note: resumeNotes(f, l) } : {}),
      preview: { kind: 'form', screenshot: f.screenshot || null, fields: f.fields || [], url: f.url || applyUrl(l), filled_at: f.at || null, resume: uploadedResume(f) },
      options: [
        { key: '1', label: '确认提交', steps: [{ type: 'action', kind: 'submit', input: { record_id: rid }, fingerprint: l.auto_apply.plan_fingerprint, confirm: 'inline' }], confirm_inline: true, primary: true, hint: '系统按这一版材料点提交，并截下回执；材料变了会再给你看' },
        { key: '2', label: '我去页面上看 / 自己改', steps: [{ type: 'application_page', record_id: rid }], hint: '切到填好的那一页；你自己提交后回来点「我已提交」' },
        { key: '3', label: '我已在页面上提交了', steps: [{ type: 'command', text: `${n} 这步好了` }] },
        { key: '4', label: '不投了', steps: [{ type: 'command', text: `pass ${n} {reason}` }], reasons: ['方向不对', '城市不对', '年限或级别不符', '公司不想去', '薪资不符'], danger: true },
        ...(pageGone(rid) ? [refillOption(rid, 5)] : []),
      ],
      other: { placeholder: '哪里填得不对？说清楚，系统改好再填一遍给你看', steps: [{ type: 'command', text: `关于 ${n} 号 ${l.company}：终审发现问题——{text}` }] },
      lead: { number: n, company: l.company, role: l.role, record_id: rid }, url: f.url || applyUrl(l), facts: leadFacts(l),
    };
  });
}
// 待发的平台私信卡在登录上（send-dm 遇到登录页后把请求放回队列、标 needs_login）。
function blockedSends({ requests = [], drafts = [] } = {}) {
  const byId = new Map(drafts.filter(d => d.draft_id).map(d => [d.draft_id, d]));
  return requests.filter(r => r.status === 'queued' && r.blocked === 'needs_login').map(r => { const d = byId.get(r.draft_id) || {}; return { host: hostOf(d.to), label: `待发：#${d.number ?? '—'} ${d.company || ''} ${platformOf(d.to) || ''}私信`.trim(), number: d.number ?? null, record_id: r.record_id }; }).filter(x => x.host);
}

// 动作的种类 → 哪位成员的事（和 lib/action-kinds.mjs 注册的 member 一致；页面上用旧的叫法 reacher / watch）。
const ACTION_SENDER = { send_email: 'reacher', send_dm: 'reacher', prefill: 'reacher', submit: 'reacher', read_mail: 'watch' };
const STEP_SENDER = { stale: 'reacher', application_page: 'reacher', refill: 'reacher', set_link: 'reacher' };
export function senderByAction(a = {}) {
  const found = new Set();
  for (const o of a.options || []) for (const s of o.steps || []) {
    const m = s.type === 'action' ? ACTION_SENDER[s.kind] : s.type === 'builtin_mail' && s.action !== 'ack' && s.action !== 'guess_ack' ? 'reacher' : STEP_SENDER[s.type];
    if (m) found.add(m);
  }
  return found.size === 1 ? [...found][0] : null; // 一封信里几种都有（少见）：不改，照原来的
}
// 没有方向的那一封（id need:direction:info → 收件箱的「补充信息」）：新用户第一次打开还在引导里、跳过引导的有「还没告诉团队」那一封，都不出。
export function directionAsk({ leads = [], facts = currentFacts(), state = onboardingState() } = {}) {
  if (!state.facts || state.first_run || directionSet(facts)) return null;
  const n = leads.filter(l => heldRec(l) && l.rec_queue?.reason === 'no_direction').length;
  return {
    from: 'lens', id: 'need:direction:info', type: 'info', title: '求职方向还没选',
    question: n ? `没有方向，${n} 个推荐先不放出来。` : '没有方向，先不推荐岗位。',
    options: [{ key: '1', label: '选方向', steps: [{ type: 'navigate', to: '#settings/prefs?hl=direction' }], primary: true }],
  };
}
export function inboxView(center = {}, { now = Date.now(), includeSnoozed = false, poolLimit = 40, trace = null } = {}) {
  const outbound = cachedLines('state/outbound.ndjson');
  const queue = Object.values(center.roles || {}).flatMap(r => r.queue || []).filter(q => q.kind !== 'followup' || !followupSource(q.lead || {}, outbound).reason);
  const leads = cachedLines('state/leads.ndjson'), drafts = cachedLines('state/drafts.ndjson'), jobs = cachedLines('state/host-jobs.ndjson');
  const requests = cachedLines('state/send-requests.ndjson');
  const snoozed = includeSnoozed ? {} : read(SNOOZE_PATH, {});
  // 卡在登录上的待发私信，变成一行"阻塞"交给 buildAsks 按账号合并。
  const sendRows = blockedSends({ requests, drafts }).map(b => ({ id: `send-blocked:${b.record_id}`, kind: 'blocked', role: 'reacher', channel_key: 'platform_dm', lead: { number: b.number, company: '', role: '', record_id: null }, actions: [], refs: { url: `https://${b.host}/` }, summary: `${b.label}：平台需要登录`, detail: `${b.label}：平台需要登录`, login_required: true, host_job: null, title: b.label }));
  const sessions = loadPortalSessions(), watch = loginWatchState();
  const built = buildAsks({ queue: [...queue, ...sendRows], leads, drafts, jobs, snoozed, now, sessions, watch, trace });
  const seen = new Set(queue.map(q => q.lead?.record_id).filter(Boolean));
  // 暂缓的也要算进「已暂缓 N」：原来只数了 buildAsks 那部分，门户岗位池、停住的线索暂缓后既看不见也不计数。
  const isSnoozed = a => !includeSnoozed && Date.parse(snoozed[a.id] || '') > now;
  let snoozedMore = 0;
  const live = list => list.filter(a => { trace?.(a, 'sources', isSnoozed(a) ? 'drop:snoozed' : 'generated'); return isSnoozed(a) ? (snoozedMore++, false) : true; });
  const extra = live(stalledAsks({ leads, jobs, seen }));
  extra.push(...leads.filter(l => !l.superseded && canCorrectSubmission(l)).map(l => ({ id: `owner-submit:${l.record_id || l.id}`, from: 'reacher', type: 'info', companion: true, notice: true, title: `#${l.number} ${l.company}`, question: '已记为你本人提交。', options: [{ key: '1', label: '撤回误记的提交', steps: [{ type: 'correct_submission', record_id: l.record_id || l.id }] }], lead: { record_id: l.record_id || l.id, number: l.number, company: l.company, role: l.role } }))); 
  // Patch 的记账（lib/spend.mjs）：今天的花费上限到了（排在最前面）；省钱档里等你按标题挑的新线索（排在拍板的信后面）。
  // OfferCrew 补给被中转拒了、文字模型只剩它（lib/free-model.mjs）：和花费上限一样排在最前面。
  const spend = [...live(freeModelAsks({ now })), ...budgetAsks({ now })], skim = live(skimAsks({ leads, now }));
  // 任务板上停下来问你「还投吗」的目标（lib/tasks.mjs goalAsks）：和执行器的问题排在一起。
  // 任务板读一次，目标那几封和下面「同一个岗位只问一次」共用。读不了（文件坏了）：大声记一笔，这一次当作任务板是空的——
  // 收件箱别的信照常出，只是少了目标停下来问的那几封、也不按任务板挡系统建议的投递信。
  let cards;
  try { cards = readCards(); }
  catch (e) { noteSwallowed('ask-actions.read-cards', e, { member: 'patch', doing: '读任务板', then: '这次收件箱里没有任务卡停下来问你的信，同一岗位的投递信也可能多出一封' }); cards = []; }
  extra.push(...live(goalAsks({ cards })));
  // 岗位页、信页上起的 Writer 的活先问你的那几句（没有发起它的对话，lib/task-writer.mjs writerAsks）：卡片上答是同一封。
  extra.push(...live(writerAsks()));
  // 首轮里要你补信息才能判的待核：合成一封，多半卡在哪，带「补充」（lib/first-round.mjs firstRoundAsk）。
  // 第 3 轮负责人：不挂在指挥台顶上；不用你动手就不来信。
  const firstRound = firstRoundAsk({ ops: center.ops || read('state/ops.json', {}) || {}, leads, facts: currentFacts(), now });
  if (firstRound) extra.push(...live([firstRound]));
  // 引导走完以后还差的几步（登录勾过的网站、接邮箱、可选配对手机）：一封清单信，做完一行打一个勾，都做完就收起来（lib/unlock.mjs）。
  const unlock = unlockAsk();
  if (unlock) extra.push(...live([unlock]));
  // 跳过了引导：「还没告诉团队你想找什么」（以前是指挥台上的小卡片）。
  const guide = skippedGuideAsk();
  if (guide) extra.push(...live([guide]));
  // 方向必填（负责人 10-10）：老用户资料里没写方向（以前按软件处理），现在不推荐，先来一封「补充信息」请你选。不能暂缓。
  else { const dir = directionAsk({ leads }); if (dir) extra.push(dir); }
  // 代码守卫拦下执行器改代码（bin/host/code-guard.mjs）：改了什么、存在哪、还原了没有（lib/code-guard.mjs）。
  extra.push(...live(codeGuardAsks()));
  // 升级后公司包里去掉的几家：删不删你的清单里那几条（lib/pack-sync.mjs）。
  extra.push(...live(packSyncAsks()));
  // 你配的模型钥匙失效、额度用完、不存在、没配好，System 换了下一个：一个底座一封，说清换成了谁（lib/system/breaker.mjs）。
  extra.push(...live(modelFaultAsks({ now })));
  // Writer 做好的定制版，等你点「用这版」（lib/resume-tailor.mjs tailoredAsks）。
  extra.push(...live(tailoredAsks()));
  // BOSS 聊天列表里对不上岗位的新消息：合成一封（lib/boss-inbox.mjs）。
  extra.push(...live(bossInboxAsks()));
  // 脉脉消息列表（lib/maimai-inbox.mjs）：对不上岗位的合成一封；碰到验证码、登录墙停下的一封。
  extra.push(...live(maimaiInboxAsks()));
  // LinkedIn 私信通知邮件里对不上岗位的：合成一封（lib/linkedin-mail.mjs）。
  extra.push(...live(linkedinAsks()));
  extra.push(...live(linkedinBrowserAsks()));
  // 内置邮箱读到、对不上岗位的招聘方回复和面试邀请：合成一封（lib/mail/asks.mjs）。
  extra.push(...live(mailAsks()));
  // 内置邮箱发信不确定发出去没有、被对方拒收的：一封一封（lib/mail/asks.mjs sendAsks）。
  extra.push(...live(sendAsks()));
  // 批准超过 24 小时还没做的发信、私信、预填、提交：一条一封「这是 N 天前批准的，还要发 / 投吗？」（lib/stale-approvals.mjs）。
  extra.push(...live(staleAsks({ now })));
  // 没有模型时只按关键词猜了的信：一天最多一封（lib/mail/asks.mjs guessAsks，兜底清单 D01）。
  extra.push(...live(guessAsks({ now })));
  // 内置邮箱断开了、已批准的信停着：一封信说明（lib/mail/asks.mjs heldAsks，兜底清单复核 N01）。
  extra.push(...live(heldAsks()));
  // 只收信时已批准的信停着：一封信说明发信为什么不通、能怎么办（第 6b 轮）。
  extra.push(...live(sendBlockedAsks()));
  extra.push(...live(noMailboxAsks()));
  // 网站要你验证、而它是你打开或绑定了的来源：「请你接手」（lib/site-check-asks.mjs）。
  extra.push(...live(siteCheckAsks({ now })));
  // 只有本机 AI 能做的那一步（要在这台电脑上操作）：一件一封，你自己做、打开本机 AI，或者这一步不做了（lib/legacy-hands.mjs）。
  // 本机 AI 只是可选的加速：这些不上指挥台顶上那一行。
  extra.push(...live(localAiAsks()));
  // 招聘方主动找你、你还没读的：一个对话一封（lib/boss-inbound.mjs）。
  extra.push(...live(bossInboundAsks().map(a => ({ ...a, options: [{ key: '3', label: '起草回复', primary: true, steps: [{ type: 'inbound_reply', title: a.title, message: a.question }], hint: '写好在任务里给你看，由你检查后在 BOSS 聊天发送' }, ...a.options.map(o => ({ ...o, primary: false }))] }))));
  const finals = finalReviewAsks({ leads }).filter(a => !built.asks.some(b => b.lead?.record_id && b.lead.record_id === a.lead.record_id && b.type === 'review'));
  const asks = [...built.asks];
  const firstReview = asks.findIndex(a => a.type === 'review');
  asks.splice(firstReview < 0 ? asks.findIndex(a => !['interview', 'login'].includes(a.type)) : firstReview, 0, ...finals);
  const at = asks.findIndex(a => !['interview', 'login', 'review', 'decide'].includes(a.type));
  asks.splice(at < 0 ? asks.length : at, 0, ...extra, ...skim);
  asks.unshift(...spend);
  // 门户岗位池接在筛选的最后（先处理真人帖和执行器问的），待核的门户岗位也放进来（10-02 N13）。
  // 附带的通知（「定制版好了」这类 companion 信）不算「这条线索已经有信了」：它不能把这条线索要你拍板的筛选信挤掉。
  const inAsks = new Set(asks.filter(a => !a.companion).map(a => a.lead?.record_id).filter(Boolean));
  asks.push(...live(poolAsks({ leads, seen: new Set([...seen, ...inAsks]), limit: poolLimit, allChannels: poolLimit === Infinity, verify: true, isExcluded: l => excludedCompany(l) || seniorTitle(l), cityOk: l => acceptableCity(l) })));
  for (const a of asks) trace?.(a, 'assembled', 'candidate');
  // 你就某条线索写了「其他」（或选了新办法）交给执行器：在办的这一天里，这条线索别的提问先收起来，
  // 办完（或一天没人接）再按当时的情况问。执行器反问你的那一问、要你审的草稿、面试照常出现。
  const OPEN = new Set(['pending', 'running', 'dispatched', 'queued', 'in_progress', 'waiting_user']);
  const working = new Map();
  for (const j of new Map(jobs.map(j => [j.id, j])).values()) if (j.kind === 'user_request' && j.record_id && OPEN.has(j.status) && now - Date.parse(j.created_at || 0) < 86400000) working.set(j.record_id, j.id);
  // 新交办直接进引擎；按任务账确认正在处理，暂停、结束或等用户时不能继续遮住问题。
  for (const c of cards) if (c.kind === 'ask' && c.from?.by === 'you' && !c.links?.job_id && !controlled(c)
    && now - Date.parse(c.created_at || 0) < 86400000 && ['queued', 'running'].includes(jobOfCard(c)?.state)) {
    for (const l of c.leads || []) if (l.rid || l.record_id) working.set(l.rid || l.record_id, c.id);
  }
  for (let i = asks.length - 1; i >= 0; i--) { const a = asks[i], w = working.get(a.lead?.record_id); if (w && a.job_id !== w && !['review', 'interview', 'login'].includes(a.type)) { trace?.(a, 'working', 'drop:active_user_request'); asks.splice(i, 1); } }
  // 同一个帖子、同一个岗位被收成了两条线索（#227 / #241 是同一个 v2ex 帖）：筛选只问一次——
  // 另一条已经有人处理过（联系 / pass / 批准），或编号更小的那条还在等你，这条就不再问。一个帖子里的几个不同岗位照样分开问。
  const postKey = l => String(applyUrl(l) || l.url || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
  const roleKey = r => String(r || '').replace(/[\s…/·|，,。.]+/g, '').toLowerCase();
  const sameRole = (x, y) => { const a = roleKey(x), b = roleKey(y); return a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a)); };
  const byPost = new Map(), leadById = new Map();
  for (const l of leads) { if (l.superseded) continue; leadById.set(l.record_id || l.id, l); const k = postKey(l); if (k) (byPost.get(k) || byPost.set(k, []).get(k)).push(l); }
  const acted = l => decidedLead(l) || !!l.auto_apply || settledLead(l);
  const duplicatePost = a => {
    const l = a.type === 'triage' && leadById.get(a.lead?.record_id);
    if (!l) return false;
    return (byPost.get(postKey(l)) || []).some(o => o !== l && sameRole(o.role, l.role) && (acted(o) || (o.number ?? Infinity) < (l.number ?? Infinity)));
  };
  for (let i = asks.length - 1; i >= 0; i--) if (duplicatePost(asks[i])) { trace?.(asks[i], 'duplicate_post', 'drop:same_post_and_role'); asks.splice(i, 1); }
  // 同一个岗位只问一次投不投：任务板上的目标 / 投递卡已经管着它（lib/card-ops.mjs applyClaims），系统建议的「投递」那一封
  // （拟投、筛选、门户岗位池、材料变了再确认）不再出，只留目标那一封；你在那一封答了，这一封也不回来。
  { const claim = applyClaims({ cards });
    const claimed = a => (a.lead?.record_id && claim.rids.has(a.lead.record_id)) || (a.lead?.number != null && claim.numbers.has(Number(a.lead.number)));
    const asksApply = a => (a.options || []).some(o => (o.steps || []).some(s => s.type === 'action' && s.kind === 'prefill'));
    for (let i = asks.length - 1; i >= 0; i--) if (!String(asks[i].id).startsWith('goal:') && asksApply(asks[i]) && claimed(asks[i])) { trace?.(asks[i], 'apply_claims', 'drop:task_claims_application'); asks.splice(i, 1); } }
  // 用户交办的投递在排队/运行时也有去处；只读那件活的真实状态，不把它再变成系统建议「投不投」。
  // 终审、登录、补信息、过期批准已经有专门的信时不重复。没有新动作而被拦下的卡也说清失败原因。
  const coveredApply = new Set(asks.filter(a => !a.companion).map(a => a.lead?.record_id).filter(Boolean));
  for (const c of cards.filter(c => c.kind === 'apply' && !c.legacy && c.status !== 'cancelled')) {
    const rid = c.leads?.[0]?.rid, l = leads.find(l => (l.record_id || l.id) === rid);
    if (!l || coveredApply.has(rid) || settledLead(l) || (!hasApplicationApproval(l) && c.from?.by !== 'you')) continue;
    const j = jobOfCard(c);
    if (!j || !['queued', 'running', 'failed', 'waiting_you'].includes(j.state)) continue;
    const question = j.state === 'queued' ? `你交办的预填排队中${j.reason ? `：${plainWords(j.reason)}` : '，引擎会接着处理'}。`
      : j.state === 'running' ? '正在预填，填好停在提交前给你检查。'
      : j.state === 'failed' ? `预填没有做成：${plainWords(j.reason || '没有留下原因')}。`
      : `预填在等你：${plainWords(j.reason || '请在任务中查看要处理的事')}。`;
    asks.push({ from: 'reacher', id: `apply-work:${rid}`, type: 'info', work_state: j.state, title: `#${l.number} ${l.company}`, question,
      lead: { record_id: rid, number: l.number, company: l.company, role: l.role }, card: c.id,
      options: [{ key: '1', label: '查看投递任务', steps: [{ type: 'navigate', to: `#tasks?card=${encodeURIComponent(c.id)}` }], primary: true }], other: null });
    coveredApply.add(rid);
  }
  // 「系统需要你确认」只是在重复别的提问：它点名的线索各自都有提问（或之后你已经处理过），
  // 或者它卡的就是另一问正卡着的同一个浏览器 / 登录（resume_condition 相同）——不再单独出现。
  const jobById = new Map(jobs.map(j => [j.id, j])), byNumber = new Map(leads.filter(l => l.number != null).map(l => [l.number, l]));
  const openNumbers = new Set(asks.filter(a => a.lead?.number != null).map(a => a.lead.number));
  const UNIT = /[字次个条项天年月日时点分秒岁周倍份位名家轮小]/;
  const leadRefs = t => { const out = new Set(); const x = plainWords(t);
    for (const re of [/#(\d{1,4})/g, /发\s*(\d{1,4})/g, /(\d{1,4})\s*号/g]) for (const m of x.matchAll(re)) out.add(Number(m[1]));
    for (const m of x.matchAll(/(?<![\d:：.#\w])(\d{1,4})(?=[\u4e00-\u9fff])/g)) if (!UNIT.test(x[m.index + m[1].length])) out.add(Number(m[1]));
    return [...out].filter(n => byNumber.has(n)); };
  const handledSince = (n, since) => { const l = byNumber.get(n); return settledLead(l) || [l.feedback_at, l.auto_apply?.answered_at, l.auto_apply?.approved_at].some(t => t && String(t) > String(since || '')); };
  const repeats = a => {
    const j = a.from === 'system' && !a.lead?.record_id && jobById.get(a.job_id);
    if (!j) return false;
    if (j.resume_condition && asks.some(b => b !== a && b.job_id && jobById.get(b.job_id)?.resume_condition === j.resume_condition)) return true;
    const refs = leadRefs(jobQuestion(j, jobs) || a.question);
    return refs.length > 0 && refs.every(n => openNumbers.has(n) || working.has(byNumber.get(n).record_id || byNumber.get(n).id) || handledSince(n, j.updated_at || j.created_at));
  };
  for (let i = asks.length - 1; i >= 0; i--) if (repeats(asks[i])) { trace?.(asks[i], 'system_repeat', 'drop:covered_or_handled'); asks.splice(i, 1); }
  // 每一问带上版本（问题 + 选项文字 + 预览指纹），飞书卡片据此认出过期的点击（lib/ask-cards.mjs）。
  // 发送被闸挡下的草稿（旧版的「发 N」、worker 发之前再核时，lib/action-kinds.mjs markSendBlocked）：草稿还在、还没发、没作废，
  // 又没有别的信在说它，就按草稿现在的样子出一封（lib/asks.mjs draftAsk：超字数「AI 缩短 / 我自己改 / 这条不发了」，平台关着
  // 「打开设置 / 这条不发了」，已经改好的「发送」）。实测 10-05 #498：只记了一条事件，收件箱里看不到。
  { const have = new Set(asks.map(a => a.id));
    for (const d of drafts) {
      if (!d?.send_blocked || ['sent', 'cancelled'].includes(d.status) || have.has(`draft:${d.draft_id}`)) continue;
      const l = leads.find(x => (x.record_id || x.id) === d.record_id) || {};
      const n = d.number ?? l.number ?? null;
      if (n == null) continue;
      const q = { lead: { number: n, company: l.company || d.company || '', role: l.role || '', record_id: d.record_id }, channel_key: d.channel === 'email' ? 'email' : 'platform_dm', refs: { draft_id: d.draft_id, url: l.url || null } };
      const a = draftAsk(q, l, d);
      if (!isSnoozed(a)) { asks.push({ ...a, from: 'reacher' }); have.add(a.id); }
    } }
  // 同一封邮件只留一封信（实测 10-05 #503：「怎么推进」里一封发信失败，「草稿待批准」里又一封「看完就可以发」）：
  // 发信失败 / 不确定的那封在，就不再出这份草稿的「草稿待批准」；那封信上的「再试一次 / 再发一次」照样先给你看草稿再确认。
  { const failing = new Set(asks.filter(a => /^builtin-mail-send:/.test(a.id) && a.draft_id).map(a => a.draft_id));
    for (let i = asks.length - 1; i >= 0; i--) if (failing.has(asks[i].draft_id) && /^draft:/.test(asks[i].id)) { trace?.(asks[i], 'mail_failure', 'drop:covered_by_mail_failure'); asks.splice(i, 1); } }
  // 信挂在谁名下：按信上要做的动作的种类（发信、私信、预填、提交是 Reacher 的事，读信是 Watcher 的）。以前不少发信、投递的信
  // 挂在「Watcher 来信」下（实测：#503 的发信失败、旧版留下的投递事件），因为它们是 info 类、或者旧活记在 Watcher 名下。
  // 收起来的线索（lib/shelf.mjs：不是岗位、不对口，又没真发出去过）：不再问你投不投、联系不联系、草稿发不发、还推不推。
  // 已经预填好停在提交前的（终审）照常出：那一步已经在浏览器里了，要你看一眼。
  { const PUSH = /^(?:apply|draft|stalled|reapprove|stale|pool):/;
    for (let i = asks.length - 1; i >= 0; i--) { const a = asks[i], l = a.lead?.record_id && leadById.get(a.lead.record_id); if (l && (a.type === 'triage' || PUSH.test(a.id)) && shelved(l)) { trace?.(a, 'shelf', 'drop:shelved_lead'); asks.splice(i, 1); } } }
  for (let i = asks.length - 1; i >= 0; i--) { const l = asks[i].lead?.record_id && leadById.get(asks[i].lead.record_id); if (l && endedLead(l) && !asks[i].notice) { trace?.(asks[i], 'ended', 'drop:ended_lead'); asks.splice(i, 1); } }
  for (const a of asks) trace?.(a, 'before_currentAsks', 'candidate');
  asks.splice(0, asks.length, ...currentAsks(asks, { cards, leads, drafts, requests, outbound, now, trace }).filter(a => { trace?.(a, 'final', isSnoozed(a) ? 'drop:snoozed' : 'visible'); return !isSnoozed(a); }));
  for (const a of asks) { const m = senderByAction(a); if (m) a.from = m; }
  for (const a of asks) a.version = askVersion(a);
  const counts = Object.fromEntries(Object.keys(built.types).map(t => [t, asks.filter(a => a.type === t).length]));
  // 账号表只有一张（lib/account-table.mjs）：设置、System 页读的是同一份。
  const accounts = accountTable({ leads, sessions, watch, now });
  for (const a of accounts) a.waiting = asks.filter(x => x.type === 'login' && x.account?.key === a.key).reduce((n, x) => n + (x.affected?.length || 0), 0);
  // 进行中：你拍板之后的事走到了哪一步（lib/team.mjs）。收件箱的「进行中」和指挥台共用。
  const inflight = inflightView({ leads, drafts, requests, jobs, asks, now });
  return { asks, counts, total: asks.length, snoozed: built.snoozed + snoozedMore, types: built.types, accounts, inflight, resumable: built.resumable, generated_at: new Date(now).toISOString() };
}

// ── 执行一个选项 ─────────────────────────────────────────────────────────────
// {fields}：补充信息表单的答案（「出生年月：1995-03；…」），写进交给执行器的反馈。
const fill = (s, v) => String(s).replace(/\{(text|reason|datetime|n|fields)\}/g, (_, k) => v[k] ?? '').replace(/\s+$/, '');
async function markDisplayed(draft_id, fingerprint, now) {
  const drafts = lines('state/drafts.ndjson'), d = drafts.find(x => x.draft_id === draft_id);
  if (!d || d.status !== 'ready') throw Error('这份草稿已经不是待发状态，请刷新');
  if (draftFingerprint(d) !== fingerprint) throw Error('草稿刚被改过，你看到的不是最新版；请刷新后再看一遍');
  if (d.displayed_hash === fingerprint && d.notified_at) return;
  Object.assign(d, { notified_at: new Date(now).toISOString(), displayed_hash: fingerprint, displayed_on: 'inbox' });
  writeLines('state/drafts.ndjson', drafts);
}
function snooze(id, hours, now, until = null) {
  const s = read(SNOOZE_PATH, {});
  for (const [k, v] of Object.entries(s)) if (!(Date.parse(v) > now)) delete s[k];
  // until：到某个具体时刻（「过两天再说」= 后天 09:00）；否则往后推 hours 小时。
  s[id] = Date.parse(until || '') > now ? new Date(until).toISOString() : new Date(now + hours * 3600000).toISOString();
  write(SNOOZE_PATH, s);
}
async function addRequest({ details, number = null, record_id = null }, now) {
  const { queueEngineTask } = await import('./task-entry.mjs');
  const lead = record_id || number != null ? lines('state/leads.ndjson').find(l => (record_id && (l.record_id || l.id) === record_id) || (number != null && l.number === number)) : null;
  queueEngineTask({ text: details, leads: lead ? [lead] : [], from: { by: 'you', via: 'inbox' }, now });
  return '交给团队了，做好后在任务里给你看';
}
// 「打开」没成：照实际用的浏览器说怎么办，不露 ENOENT 这类原文（10-01 开箱 #13）。
export function openFailed(e) {
  const m = String(e?.message || e || '');
  if (e?.code === 'chrome_missing' || /^chrome_missing/.test(m)) return m.replace(/^chrome_missing：/, '');
  if (e?.code === 'chrome_host_profile_busy' || /^chrome_host_profile_busy/.test(m)) return m.replace(/^chrome_host_profile_busy：/, '');
  const why = m.replace(/^(ego_browser_failed|chrome_host_[a-z_]+|cdp_[a-z_]+):\s*/, '').replace(/^：/, '').split('\n')[0].slice(0, 120);
  return `专用 Chrome 没能打开这个页面（${why}）。再试一次；还不行就把专用 Chrome 完全退出（⌘Q）后再试。`;
}
// 登录检查（打开要登录才能看的页面，看你登没登好）在 lib/login-probe.mjs。
export { probeAccounts, probeAccount, probeVerdict } from './login-probe.mjs';

// 「我登好了」：先做一次登录检查（配置了 probe 的平台）；门户走 recoverPortalSession（同一账号家族
// 一起恢复已批准的投递）；平台（LinkedIn、脉脉、BOSS）记为已登录；挂在这个账号上的执行器任务
// 带着"已登录"的反馈重新排队。自动检测（lib/login-watch.mjs）看到已登录时走的也是这一段，by = login_watch。
// 不再把投递交给即时执行器；测试传假的。
// 登好以后接着做压着的那件活（契约 2.5）：这个账号上压着的对外动作（预填、私信）放开、叫醒 worker（lib/actions.mjs release）。
// 不再交给即时执行器、不再另起一遍预填（02a 二、「我登好了」：以前命令行版会起两次，Mac 版要等下一轮周期）。
export async function accountReady({ account, hosts = [], jobs = [], superseded = [] }, now, { probe = probeAccount, by = 'user_dashboard', release: releaseHeld = null } = {}) {
  const cfg = loadAccounts(), [familyKey, tenant] = String(account).split(/:(.+)/);
  const fam = cfg.families?.[familyKey] || {};
  let check = { checked: false };
  try { check = await probe(account, { cfg }); } catch (e) { check = { checked: false, error: String(e.message || e).slice(0, 120) }; }
  if (check.error || check.blocked || check.skipped) throw Error(`登录没核对成：${plainWords(check.error || check.reason || '需要在页面上验证')}。完成后再检查。`);
  if (check.checked && !check.logged_in) throw Error(`还没检测到 ${fam.label || account} 的登录（${check.reason}）。登录好了再点一次。`);
  const done = [];
  const auto = by === 'login_watch';
  if (!auto) resetLoginWatch(account);
  const probeNote = check.checked ? `${auto ? '自动检测' : '登录检查'}：${check.url || '页面'} 已登录` : null;
  // 门户：恢复那一步接着做这几条线索的预填（压着的放开；改造前的老批准、上次记了失败的按原批准再排一条）。
  if (fam.kind === 'portal' || tenant) done.push((await recoverPortalSession(tenant || hosts[0] || (fam.hosts || [])[0], { now, by, probe: probeNote })).receipt);
  else {
    // 同一账号在记录里可能有好几行（www.linkedin.com 和 linkedin.com）：一起更新，免得旧的"未登录"那行
    // 还留着，执行器读文件时读到它。
    const known = fam.shared_login ? Object.keys(loadPortalSessions().domains || {}).filter(d => familyOf(d, cfg)?.key === familyKey) : [];
    const targets = [...new Set([...(fam.hosts || []), ...hosts, ...known])];
    { for (const h of targets) markPortalLoggedIn(h, { now: new Date(now), by, probe: probeNote }); }
    done.push(`已记下 ${fam.label || account} 已登录${check.checked ? auto ? '（系统在浏览器里看到的）' : '（已实地核对）' : ''}`);
    // 绑定 LinkedIn 的那一下（登录检查核对过）：必要的披露（负责人 10-02，主会话定的原话）。
    if (familyKey === 'linkedin' && check.checked) done.push('LinkedIn 不允许第三方自动化，自动扫描有被限制账号的风险，随时可以关');
  }
  let resumed = 0;
  // 交给本机 AI 的老任务（宿主任务）：转回引擎接着处理；挂在登录上的投递由下面的动作接着做。
  {
    const applyJobs = new Set(lines('state/host-jobs.ndjson').filter(j => jobs.includes(j.id) && j.kind === 'queue_auto_apply').map(j => j.id));
    for (const id of jobs) {
      if (applyJobs.has(id)) continue;
      try { await updateHostJob(id, 'feedback', { note: `${auto ? '系统在浏览器里确认' : '我已经在浏览器里登录好了'}（${fam.label || account}），请继续。`, now }); resumed++; } catch (e) { noteSwallowed('ask-actions.login-resume', e, { member: 'patch', doing: '把登录好了告诉那件旧任务', then: '它还停着，下一次登录检查再接' }); }
    }
  }
  for (const id of superseded) { try { await updateHostJob(id, 'resolve', { note: '同一登录挡住的旧任务，由最新一天的任务接替', now }); } catch (e) { noteSwallowed('ask-actions.login-supersede', e, { member: 'patch', doing: '收掉同一登录挡住的旧任务', then: '它还挂着，不影响新的那件' }); } }
  if (resumed) done.push(`${resumed} 项任务重新排队`);
  // 这个账号上压着的对外动作：放开，接着做。
  const rel = releaseHeld || (await import('./actions.mjs')).release;
  const out = { released: 0, kinds: [] };
  for (const key of new Set([account, familyKey])) { const r = rel({ code: 'needs_login', key, now }); out.released += r.released; out.kinds.push(...r.kinds); }
  if (out.released) {
    const ks = new Set(out.kinds), what = [ks.has('prefill') || ks.has('submit') ? (autoSubmitEnabled() ? '接着投递' : '接着预填，停在提交前给你') : '', ks.has('send_dm') ? '接着发压着的私信' : ''].filter(Boolean).join('，');
    done.push(`${out.released} 件压着的活${what || '接着做'}`);
  }
  if (check.error) done.push(`没能自动核对登录（${check.error}），提交前引擎仍会实地检查`);
  return done.join('；');
}

// 账号页上直接点「我登好了」：账号必须是账号一览里有的；挂在它上面的任务取自当前的登录提问。
export async function accountReadyFor(account, { center = {}, now = Date.now(), confirm = false, checkOnly = false, probe = probeAccount } = {}) {
  const view = inboxView(center, { now, includeSnoozed: true });
  let row = view.accounts.find(a => a.key === account);
  // 招聘平台（LinkedIn、脉脉、BOSS……）还没有任何登录记录时不在一览里；设置页一直列着它们（lib/setup.mjs），在那里也能点「我登好了」。
  if (!row) { const f = loadAccounts().families?.[account]; if (f?.kind === 'platform') row = { key: account, label: f.label, kind: f.kind, hosts: f.hosts || [] }; }
  if (!row || row.kind === 'service') throw Error('没有这个账号，或它不需要在浏览器里登录');
  if (checkOnly) { const checked = await probe(account, { now }); if (!checked.checked) return { ok: false, receipt: plainWords(checked.error || '这个账号暂时无法自动核实，请在登录页查看') }; const watch = read('state/login-watch.json', {}); watch[account] = { ...watch[account], checked_at: new Date(now).toISOString(), logged_in: checked.logged_in, reason: checked.reason }; write('state/login-watch.json', watch); return { ok: true, receipt: checked.logged_in ? '系统已核实登录' : `系统没有看到登录：${plainWords(checked.reason)}` }; }
  if (!confirm) return { ok: true, needs_confirm: true, preview: { kind: 'record', text: `确认你已登录 ${row.label}？检查通过后，压着的任务会继续；没有自动检查方法的账号会记为你本人确认。` } };
  const ask = view.asks.find(a => a.id === `login:${account}`);
  const step = ask?.options.flatMap(o => o.steps).find(s => s.type === 'account_ready') || { account, hosts: row.hosts, jobs: [], superseded: [] };
  const receipt = await accountReady(step, now);
  event('user', 'inbox', 'ok', `账号：${row.label} 已登录`);
  return { ok: true, receipt };
}

// 登录已经确认过（记录比任务停下来的时间新）、任务却还停着：让它继续。自动检测调用。
export async function resumeSatisfied(item, now = Date.now()) {
  const cfg = loadAccounts(), label = (item.families || []).map(k => cfg.families?.[String(k).split(':')[0]]?.label || k).join('、');
  if (item.kind === 'lead' && item.host) return (await recoverPortalSession(item.host, { now, by: 'login_watch', probe: '登录记录比任务停下的时间新，自动继续' })).receipt;
  if (item.job_id) { await updateHostJob(item.job_id, 'feedback', { note: `${label} 已经登录（登录记录比这个任务停下来的时间新），请继续。`, now }); return '任务重新排队'; }
  throw Error('不知道怎么继续这一项');
}

// 表单答案：每一项都要填；日期 / 年月 / 数字 / 选择按类型检查。
const FIELD_CHECK = { month: [/^\d{4}-(0[1-9]|1[0-2])$/, '写成 1995-03 这样'], date: [/^\d{4}-\d{2}-\d{2}$/, '写成 2026-10-15 这样'], number: [/^-?\d+(\.\d+)?$/, '只写数字'] };
export function checkFields(form = [], values) {
  if (!values || typeof values !== 'object') throw Error('请把表填完');
  return form.map(f => {
    // 长段落（一段 JD、项目说明）给足长度；申请表上的一项 500 字够了。
    const v = String(values[f.key] ?? '').trim().slice(0, f.type === 'long_text' ? 8000 : 500);
    if (!v) throw Error(`「${f.label}」还没填`);
    const rule = FIELD_CHECK[f.type];
    if (rule && !rule[0].test(v)) throw Error(`「${f.label}」${rule[1]}`);
    if (f.type === 'choice' && !(f.options || []).includes(v)) throw Error(`「${f.label}」请从选项里选`);
    return { key: f.key, label: f.label, value: v };
  });
}
// 你在平台上自己回过了（LinkedIn、脉脉）：记 reply_answered_at，「对方回了你」那封收起（lib/journey.mjs answeredReply）。
export async function replyDone(recordId, now = Date.now()) {
  const rows = lines('state/leads.ndjson'), l = rows.find(x => (x.record_id || x.id) === recordId);
  if (!l) throw Error('这条线索已经不在了');
  l.reply_answered_at = new Date(now).toISOString();
  writeLines('state/leads.ndjson', rows);
  return '好，记下你回过了';
}

// 答案簿刚补上的问题，别的投递也可能正停在它上面（换了个门户问同一件事）：缺的项现在都答得上的，一并重新排队。
// 只动批准还在的、停在「表上有项不会填」的；还缺别的、或缺的是证件号这类不收集的，照旧等你。
export async function requeueAnswered(now = Date.now(), { except = null, kick = goOn } = {}) {
  const book = loadBook(), done = [], rids = [];
  {
    const rows = lines('state/leads.ndjson');
    for (const l of rows) {
      const a = l.auto_apply, rid = l.record_id || l.id;
      if (rid === except || a?.status !== 'waiting_user' || !a.approved_at) continue;
      const m = /unanswered_required_fields:([^;]+)/.exec(a.error || '');
      const labels = m ? m[1].split('|').map(cleanFieldLabel).filter(Boolean) : [];
      if (!labels.length || !labels.every(x => lookup(book, x) != null)) continue;
      const { error: _was, ...kept } = a;
      setApply(l, { ...kept, status: 'approved', answered_at: new Date(now).toISOString() }, { at: new Date(now).toISOString(), source: 'answer-book', note: 'answered' });
      done.push(l.number ?? rid); rids.push(rid);
    }
    if (done.length) writeLines('state/leads.ndjson', rows);
  }
  if (done.length) await kick(rids, { now });
  return done;
}

// 你在收件箱里点了什么、结果如何，记一行（state/ask-answers.ndjson）。"我点过了怎么还在"以后查得到。
const ANSWERS_PATH = 'state/ask-answers.ndjson';
const logAnswer = row => { try { fs.appendFileSync(file(ANSWERS_PATH), JSON.stringify(row) + '\n'); } catch {} }; /* 兜底：答复记录写不进去（磁盘满）不挡这次的回答；回答本身已经做完 */
export async function answerAsk(input = {}, ctx = {}) {
  const base = { at: new Date(ctx.now ?? Date.now()).toISOString(), id: String(input.id || ''), option: String(input.option ?? '') };
  try { const r = await answerOne(input, ctx); logAnswer({ ...base, ok: true, receipt: String(r?.receipt || '').slice(0, 300) }); return r; }
  catch (e) { logAnswer({ ...base, ok: false, error: String(e.message || e).slice(0, 300) }); throw e; }
}
// 你在收件箱贴的新岗位链接：只收 http(s)；换上以后之前的批准不再算数（批准绑的是申请入口，lib/submission-policy.mjs），
// 有批准的那条摆成「材料变了」，信上会写入口从哪儿换到哪儿，你再确认一次；没批准的照常等你决定投不投。
export async function setLeadLink(rid, text, now = Date.now()) {
  const url = String(text || '').trim().match(/https?:\/\/[^\s"'<>]+/)?.[0] || '';
  if (!url) throw Error('贴一个以 http 开头的岗位链接');
  try { new URL(url); } catch { throw Error('这个链接打不开，换一个试试'); }
  const at = new Date(now).toISOString();
  {
    const rows = lines('state/leads.ndjson'), l = rows.find(x => (x.record_id || x.id) === rid);
    if (!l) throw Error('这条线索不在了');
    const was = applyUrl(l) || l.url || null;
    l.application_url = url; l.link_by_owner = { at, was };
    const a = l.auto_apply;
    if (a?.approved_at && !['submitted', 'submitting', 'uncertain', 'closed'].includes(a.status)) setApply(l, { ...a, status: 'awaiting_batch_review', approval_stale: { at, link_changed: true } }, { at, source: 'inbox', note: 'link_changed' });
    writeLines('state/leads.ndjson', rows);
    event('user', 'inbox', 'ok', `#${l.number ?? '—'} 换了岗位链接`, { lead_id: rid });
    return l.auto_apply?.status === 'awaiting_batch_review' && a?.approved_at ? '换上了新链接；之前的批准按新入口再确认一次' : '换上了新链接';
  }
}
// 「全部跟进 / 全部不跟」：在服务端一条条做完。页面关了、刷新了也照样做完（原来在浏览器里循环，
// 离开页面就停在半路，也没人知道停在哪）；某一条失败不影响后面的，每一条的结果都带回去。
// 指挥台的多选（投 / 联系 / pass / 跟进 / 不跟）也走这里：reason 是 pass 的原因；confirm 是你在页面上已经点过的第二下（投）。
export async function answerMany(ids = [], option = '', ctx = {}, { answer = answerAsk, reason = '', confirm = false } = {}) {
  const results = [];
  for (const id of ids) {
    try {
      // 多选时你在页面上确认的是那张清单（编号、公司、岗位）：每一条先算出现在的预览，确认绑到这一份的指纹（lib/actions.mjs），
      // 不是拿一个空的 confirm 去放行（服务端没给你看过的，requestAction 会再要一次确认）。
      let r = await answer({ id, option, ...(reason ? { reason } : {}) }, ctx);
      // 按你现在的规则不在方向里的投递（确认框里多问一句的那种，lib/apply-approve.mjs offDirection）：批量里不替你确认。
      const warn = r?.needs_confirm && (r.preview?.rows || []).find(x => x.warn)?.warn;
      if (confirm && warn) { results.push({ id, ok: false, skipped: true, error: `${warn.replace(/，确定要投吗？$/, '')}，批量里不投；要投就单独点这一条` }); continue; }
      if (confirm && r?.needs_confirm && !r.changed) r = await answer({ id, option, ...(reason ? { reason } : {}), confirm: r.fingerprint || true, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) }, ctx);
      if (r?.needs_confirm) throw Error('这一条要先确认');
      results.push({ id, ok: true, receipt: r?.receipt || null });
    }
    catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 200) }); }
  }
  return { ok: results.filter(r => r.ok).length, total: ids.length, results };
}
// kick：重新填表时接着预填的那一下（continuePrefill：放开压着的预填动作）；测试传假的。
// fingerprint：页面带回来的、你看到的那一份的指纹（信上的预览）；confirm 也可以直接是指纹。对外动作按它绑定（lib/actions.mjs）。
// 收件箱里打字的回复认出来以后照指令走的几种（别的照原样交给这件事）。
const TYPED = new Set(['send', 'cancel_send', 'revise', 'pass', 'contact', 'schedule', 'snooze', 'brief', 'apply', 'archive', 'reopen', 'progress']);
// 这封信要打开的是不是这条线索自己的岗位页 / 申请页（申请地址、岗位链接、上次填表的地址，按规范写法比）：是就返回线索。
function leadPageOf(rid, url) {
  const l = lines('state/leads.ndjson').find(x => (x.record_id || x.id) === rid);
  if (!l) return null;
  const want = canonicalUrl(url) || url;
  return [applyUrl(l), l.url, l.application_url, l.auto_apply?.url, l.auto_apply?.prefill?.url].filter(Boolean).some(u => (canonicalUrl(u) || u) === want) ? l : null;
}
async function answerOne({ id, option, text = '', reason = '', datetime = '', confirm = false, fields = null, answers = null, fingerprint = null } = {}, { center = {}, now = Date.now(), kick = goOn, writerModel = null, phone = null } = {}) {
  // 通知可指向首页 40 条以外的新推荐；仍按完整的当前信与原动作守卫复核。
  const view = inboxView(center, { now, includeSnoozed: true, poolLimit: Infinity });
  const ask = view.asks.find(a => a.id === id);
  if (!ask) throw Error('这一项已经处理过或刚刚变了，请刷新');
  let steps, label;
  if (option === 'other') {
    if (!ask.other) throw Error('这一项不接受自由输入');
    if (!String(text).trim()) throw Error('请写点什么');
    steps = ask.other.steps; label = `其他：${String(text).trim().slice(0, 60)}`;
    // 打字的回复也按对话同一套认（lib/intent.mjs recognize，信对着的那一条当卡片）：认出一条指令（「发」「不发」「pass 太远」「投 12」）
    // 就照指令走，确认和闸门照旧在 dispatchCommand / requestAction；认不出就照原样把你的话交给这件事（不猜）。
    // 没被允许交办的手机：和对话里一样不直接执行指令。
    const said = recognize(String(text).trim(), { card: ask.lead?.number != null ? { number: ask.lead.number, kind: ask.kind || null } : null });
    if (said.cmd && TYPED.has(said.intent)) {
      if (phone) throw Object.assign(Error('手机上不直接执行指令：要发、要投，点信上的按钮；别的话会原样交给这件事。'), { status: 403 });
      steps = [{ type: 'command', text: said.intent === 'brief' ? `详情 ${said.number}` : said.cmd.input || said.canonical || String(text).trim() }];
    }
  } else {
    const o = ask.options.find(o => o.key === String(option));
    if (!o) throw Error('没有这个选项');
    if (o.input === 'datetime' && !String(datetime).trim()) throw Error('请填面试时间');
    // 站外页面（买补给）：页面上当场打开，这里不做事、信也不算处理完。
    if (o.href && !o.steps?.length) return { ok: true, done: false, receipt: `在浏览器里打开：${o.href}` };
    steps = o.steps; label = o.label;
  }
  const replyConfirm = ask.preview?.kind === 'message' && steps.some(s => s.type === 'reply_done');
  if (replyConfirm && confirm && (fingerprint || (typeof confirm === 'string' ? confirm : null)) !== ask.version) throw Error('来信内容刚更新，请重新查看后确认');
  if (!confirm && steps.some(s => s.type === 'account_ready')) return { ok: true, needs_confirm: true, preview: { kind: 'record', text: ask.account?.probe ? `确认检查 ${ask.account.label} 的登录状态？核对通过后，等待它的任务会继续。` : `确认你已登录 ${ask.account?.label || '这个账号'}？记下后，等待它的任务会继续。` } };
  if (!confirm && steps.some(s => s.type === 'verify_delivery' || s.type === 'reply_done' || (s.type === 'builtin_mail' && ['held_by_hand', 'sent', 'sent_by_hand', 'not_sent'].includes(s.action)))) return { ok: true, needs_confirm: true, ...(replyConfirm ? { fingerprint: ask.version } : {}), preview: { kind: 'record', text: `确认记下「${label}」？这里只记录你已经做过的事。` } };
  const vars = { text: String(text).trim(), reason: String(reason).trim(), datetime: String(datetime).trim(), n: ask.lead?.number ?? null };
  // 补充信息的表单：按信里列的字段逐项检查，拼成一句交给执行器，同时留给答案簿。
  const answered = ask.form && steps.some(s => s.type === 'remember' || s.type === 'redeem' || (s.type === 'title_pick' && !s.all)) ? checkFields(ask.form, fields) : null;
  if (answered) vars.fields = answered.map(f => `${f.label}：${f.value}`).join('；');
  const receipts = [], opens = [];
  let nav = null;
  const origin = phone ? 'phone' : 'inbox';
  for (const step of steps) {
    switch (step.type) {
      case 'inbound_reply': { const { draftInboundReply } = await import('./inbound-reply.mjs'); return draftInboundReply(step, { now, ...(writerModel ? { model: writerModel } : {}) }); }
      case 'correct_submission': { if (!confirm) return { ok: true, needs_confirm: true, preview: { kind: 'record', text: '确认先前的本人提交是误记？撤回后可以重新预填；这不会撤销网站上的申请。' } }; receipts.push(correctOwnerSubmission(step.record_id, { now })); break; }
      case 'ensure_number': { const r = await ensureLeadNumber(step.record_id); vars.n = r.number; break; }
      case 'command': {
        const t = fill(step.text, vars);
        if (/\{n\}/.test(step.text) && vars.n == null) throw Error('这条线索还没有编号');
        const r = await dispatchCommand(t, { origin, now, confirm: step.confirm === 'inline' ? true : !!confirm, freeform: x => routeFreeform(x), lead: ask.lead?.record_id ? { record_id: ask.lead.record_id, number: vars.n ?? ask.lead.number ?? null } : null });
        if (r.needs_confirm) return { ok: true, needs_confirm: true, preview: r.preview, confirm_text: r.confirm_text, ask_id: id, option };
        if (r.ok === false) throw Error(r.receipt || '没能处理');
        receipts.push(r.receipt || r.ack || null);
        opens.push(...(r.open || []));
        if (r.navigate) nav = r.navigate;
        break;
      }
      // 对外动作（发送、投递、终审提交、读信）：直接走 requestAction，不再翻成「发 12」「投 12」（契约 2.5）。
      //   confirm: 'inline'——信上就是全文，点「发送」就是确认：认页面带回来的指纹（没有就认信上这一版）。
      case 'action': {
        const said = step.confirm === 'inline' ? (fingerprint || (typeof confirm === 'string' ? confirm : null) || step.fingerprint || true) : confirm ? (typeof confirm === 'string' ? confirm : fingerprint || true) : null;
        const input = { ...step.input, ...(step.input?.number === '{n}' ? { number: vars.n } : {}) };
        const r = await requestAction(step.kind, input, { origin, confirm: said, now });
        if (r.needs_confirm) return { ok: true, needs_confirm: true, preview: legacyPreview(step.kind, r.preview, input.number ?? ask.lead?.number ?? null), fingerprint: r.fingerprint, ask_id: id, option, ...(r.changed ? { changed: true, receipt: r.reason } : {}) };
        if (r.blocked) throw Object.assign(Error(r.reason), { status: 409, ...(r.fix ? { fix: r.fix } : {}) });
        receipts.push(r.receipt);
        if (r.held && r.what?.ask_id && r.what.ask_id !== id) nav = `#inbox?ask=${encodeURIComponent(r.what.ask_id)}`;
        if (r.held && r.what?.href?.startsWith('#settings/')) nav = r.what.href;
        break;
      }
      // 批准太久的那封：按现在的内容再确认（指纹是信上给你看的那一份），或者不要了（lib/stale-approvals.mjs）。
      case 'stale': {
        if (step.act === 'drop') { receipts.push((await dropStale(step.id, { now })).receipt); break; }
        const r = await reconfirmStale(step.id, { fingerprint: fingerprint || (typeof confirm === 'string' ? confirm : null), origin, now });
        if (r.needs_confirm) return { ok: true, needs_confirm: true, preview: legacyPreview(ask.preview?.kind === 'prefill' ? 'prefill' : ask.preview?.kind === 'draft' ? 'send' : 'submit', r.preview, ask.lead?.number ?? null), fingerprint: r.fingerprint, ask_id: id, option, ...(r.changed ? { changed: true, receipt: r.reason } : {}) };
        if (r.blocked) throw Object.assign(Error(r.reason), { status: 409, ...(r.fix ? { fix: r.fix } : {}) });
        receipts.push(r.receipt);
        if (r.held && r.what?.ask_id && r.what.ask_id !== id) nav = `#inbox?ask=${encodeURIComponent(r.what.ask_id)}`;
        break;
      }
      // 旧版批准、说不出当时用的是哪份材料的那封（lib/asks.mjs reapproveAsk）：「不要了」把批准撤回，这条线索照旧（和批准太久的投递同一个 drop）。
      case 'withdraw_approval': { receipts.push(await specOf('prefill').drop({ payload: { record_id: step.record_id } }, { now })); break; }
      case 'mark_displayed': await markDisplayed(step.draft_id, step.fingerprint, now); break;
      case 'job': {
        // 前一步的指令（投 N / pass N）可能已经把这条任务收掉了：收尾用的 resolve 遇到已完成的任务就跳过。
        let r = {};
        try { r = await updateHostJob(step.id, step.action, { note: fill(step.note || '', vars), now }); }
        catch (e) { if (!(step.action === 'resolve' && /不能改|没有这条/.test(e.message))) throw e; }
        if (r.receipt) receipts.push(r.receipt);
        for (const twin of step.twins || []) { try { await updateHostJob(twin, 'resolve', { note: `与 ${step.id.slice(0, 8)} 是同一个问题，已一并处理`, now }); } catch (e) { noteSwallowed('ask-actions.twin-resolve', e, { member: 'patch', doing: '一并收掉同一个问题的另一条', then: '它可能还会再问一次' }); } }
        break;
      }
      case 'request': receipts.push(await addRequest({ ...step, details: fill(step.details, vars) }, now)); break;
      case 'open': {
        // 「处理完回来点……」点的是这封信上真有的那个按钮（我已提交、我已在页面上提交了、我登好了……）；没有这种按钮就不说
        // （10-05 #316：回执说「点下一步」，信上没有叫「下一步」的按钮）。
        const back = (ask.options || []).find(o => /^(我已|我登好|好了)/.test(String(o.label || '')));
        const after = step.watch && step.sure !== false ? '登录好之后不用回来点，系统半分钟内会自己发现并继续' : ask.type === 'login' ? '登录好之后回到这里点「我登好了，检查并继续」' : back ? `处理完回来点「${back.label}」` : '';
        // 打开的是这条线索的岗位页 / 申请页：看落在哪，照实说（lib/open-job-page.mjs）。登录页、会议入口这类照旧。
        const jobLead = !step.watch && ask.lead?.record_id ? leadPageOf(ask.lead.record_id, step.url) : null;
        if (jobLead) {
          let j;
          try { j = await openJobPage(jobLead, step.url, { after, now }); }
          catch (e) { throw Error(openFailed(e)); }
          receipts.push(j.receipt); opens.push(...(j.open || []));
          break;
        }
        let r;
        try { r = await openForUser(step.url, { account: step.watch || null }); }
        catch (e) { throw Error(openFailed(e)); }
        // 登录页：之后 10 分钟每 20 秒看一次你登好了没有，登好了自动继续，不用回来点。检查方法还没在真的登录状态下
        // 核对过的（sure: false）照样去看，但回执不承诺，还是请你回来点「我登好了」。
        if (step.watch) focusLogin(step.watch, { now });
        receipts.push(r?.navError ? `页面打开时网站返回了错误（${/HTTP_RESPONSE_CODE/.test(r.navError) ? '这个地址返回了错误状态' : String(r.navError).split('\n')[0].slice(0, 80)}），页面已经交给你，可以在里面刷新或换个地址登录${after ? `；${after}` : ''}` : `已${inLoginBrowser()}打开${after ? `，${after}` : ''}`);
        break;
      }
      // 之前填好的那一页还在就切过去；关了就直接打开申请页，回执说一句，这封信多一个「重新预填」（lib/application-page.mjs）。
      case 'application_page': { const r = await showApplicationPage(step.record_id); receipts.push(r?.receipt || '已切到之前填好的那一页'); opens.push(...(r?.open || [])); break; }
      // 换一个岗位链接（旧版执行器问「提供新的官方岗位链接」的那一类信，实测 10-04 第 12 条）：你贴的链接换到这条线索上。
      case 'set_link': receipts.push(await setLeadLink(step.record_id, vars.text, now)); break;
      // 要你本人提交的门户：这次要传的那份简历在访达里选中（lib/reveal-resume.mjs）。
      case 'reveal_resume': { const { revealResume } = await import('./reveal-resume.mjs'); receipts.push(await revealResume(step.record_id)); break; }
      // 信背后是一条阻塞记录（执行器心跳、旧版留下的停顿）：你选完了，这一条收掉（和「归档」同一份记录）。
      case 'archive': { const { archiveItem } = await import('./dispatch.mjs'); await archiveItem({ key: step.key, note: label, now }); break; }
      // 之前填好的那一页关了：照投递卡的「再试一次」重新预填（lib/apply-retry.mjs），卡上、这里看得到它走到哪了。
      case 'refill': { const { refillApply } = await import('./apply-retry.mjs'); receipts.push((await refillApply(step.record_id, { now, origin })).receipt); break; }
      case 'account_ready': receipts.push(await accountReady(step, now)); break;
      case 'remember': {
        // 只记信里标为能记的那几项（lib/asks.mjs bookable：申请表上的一项；一段 JD 这类长段落不记）。没标的老信照旧全记。
        const keep = Array.isArray(step.fields) ? new Set(step.fields.map(f => f.key)) : null;
        const n = remember((answered || []).filter(f => !keep || keep.has(f.key)), { now });
        if (n) receipts.push(`记进答案簿 ${n} 项，以后别的申请表问到会自动填`);
        const also = n ? await requeueAnswered(now, { except: ask.lead?.record_id || null, kick }) : [];
        if (also.length) receipts.push(`另外 ${also.length} 条投递缺的也是这些，已一并重新排队（${also.map(x => typeof x === 'number' ? '#' + x : x).join('、')}）`);
        break;
      }
      case 'requeue_apply': receipts.push(await requeueApply(step.record_id, now, { kick })); break;
      case 'letter_write': {
        const { letterAction } = await import('./resume-letters.mjs');
        const r = await letterAction({ action: 'letter_write', record_id: step.record_id });
        receipts.push(r.status === 'running' ? `${crewName('tailor')} 在写了：先读公司调研再写，写好在「简历 → 求职信」里等你看；你点「用这封」后系统自动接着填表` : '没能开始写，去「简历 → 求职信」看看');
        break;
      }
      // 终审「确认提交」：老信上的步骤，照对外动作走（提交只认你确认的那一版材料）。
      case 'final_approve': {
        const r = await requestAction('submit', { record_id: step.record_id }, { origin, confirm: fingerprint || step.fingerprint || null, now });
        if (r.needs_confirm) throw Error('材料刚变了，你看到的不是最新一版；请刷新后再看');
        if (r.blocked) throw Object.assign(Error(r.reason), { status: 409 });
        receipts.push(r.receipt);
        break;
      }
      // 今天的花费上限：放宽今天 / 明天继续（lib/spend.mjs）。
      case 'budget': receipts.push(answerBudget(step, { now })); break;
      // 代码守卫的信：知道了，收起（lib/code-guard.mjs）。
      case 'codeguard': receipts.push(ackCodeGuard(step.id)); break;
      case 'task_control': { const c = controlCard(step.card, { action: step.action, now }); receipts.push(c.owner_control.note); break; }
      case 'verify_delivery': receipts.push(settleDelivery(step.request, step.outcome, { now })); break;
      case 'localai': receipts.push(await answerLocalAi(step, { now })); break;
      case 'pack_sync': receipts.push(await answerPackSync(step)); break;
      // 定制版的信：用这版（这个岗位投递时用它，lib/resume-tailor.mjs acceptTailored）。
      case 'tailor_accept': receipts.push(acceptTailored(step.doc, step.version, { now }).receipt); break;
      // 不用定制版：信收起，已批准的投递接着预填（放开压着的预填动作）。
      case 'tailor_decline': { const r = declineTailored(step.doc, step.version, { now }); const k = r.approved ? await kick([r.rid], { now }) : null; receipts.push(k && (k === true || k.continued) ? `${r.receipt}，接着预填` : r.receipt); break; }
      // BOSS 聊天列表那封信：知道了，收起（lib/boss-inbox.mjs）。
      // 招聘方主动找你的那封：不感兴趣 → 这个对话不再看（lib/boss-inbound.mjs）。
      case 'boss_chat': receipts.push(step.action === 'ignore' ? ignoreBossConversation(step.key, { now }) : ackBossInbox(step.sig)); break;
      // 脉脉消息列表那封信：知道了，收起；停下的那封：我处理好了，下一轮接着看（lib/maimai-inbox.mjs）。
      case 'maimai_chat': receipts.push(step.action === 'resume' ? resumeMaimaiInbox() : ackMaimaiInbox(step.sig)); break;
      // LinkedIn 通知邮件那封信：知道了，收起（lib/linkedin-mail.mjs）。
      case 'linkedin_browser': receipts.push(ackLinkedInBrowser(step.sig)); break;
      case 'linkedin_mail': receipts.push(ackLinkedIn(step.sig)); break;
      // 内置邮箱那封「对不上岗位的招聘来信」：知道了，收起（lib/mail/asks.mjs）。
      // 发信那几封：发出去了 / 再发一次 / 不发了（lib/mail/send.mjs userSettle）。
      case 'builtin_mail': if (step.action === 'held_drop') receipts.push(await dropHeld(step.ids, { now })); else if (step.action === 'held_by_hand') receipts.push(await handHeld(step.ids, { now })); else if (step.action === 'guess_ack') receipts.push(ackGuess(step.day)); else if (step.action === 'interview_confirm') { const { confirmInterview } = await import('./mail/interview.mjs'); receipts.push(await confirmInterview(step, { now })); } else if (step.action && step.action !== 'ack') { const { userSettle } = await import('./mail/send.mjs'); receipts.push(await userSettle(step.id, step.action, { now })); } else receipts.push(ackMail(step.sig)); break;
      // 「对方在 LinkedIn / 脉脉上回了你」：你在那边回过了，这封收起（系统看不到你回没回）。
      case 'reply_done': receipts.push(await replyDone(step.record_id, now)); break;
      // 任务板的目标停下来问你：还投 / 不投了（lib/tasks.mjs answerGoal，卡上答是同一件事）。
      // phone：没被允许交办的手机答的（bin/serve.mjs 按 x-radar-phone: limited 带上），放行的下一棒照样停在电脑确认。
      // 「确认，开始预填」：信上带着预填那一版的预览，页面把它的指纹带回来，开出来的投递卡按它确认（lib/tasks.mjs goalAsks）。
      case 'goal': { const g = answerGoal(step.goal, step.option, { now, phone, fingerprint: fingerprint || (typeof confirm === 'string' ? confirm : null) }); receipts.push(step.option === '不投了' ? '好，这件事不做了' : `好，${g.title} 接着往下做`); break; }
      case 'apply_confirm': { const c = confirmApply(step.card, step.option, { now, fingerprint: fingerprint || (typeof confirm === 'string' ? confirm : null) }); receipts.push(step.option === '不投了' ? '好，这条不投了' : `好，${c.title} 接着预填`); break; }
      // Writer 先问的那几句（岗位页、信页上起的活）：在它那段里照点了「就这样改」「直接改」做（lib/talk.mjs writerAnswer）。
      case 'writer': { const { writerAnswer } = await import('./talk.mjs'); const r = await writerAnswer({ session_id: step.session_id, message_id: step.message_id, kind: step.kind, answers: answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : null, text: vars.text, now }, { writerModel }); receipts.push(r?.reply?.bad || r?.redirected ? r.reply?.content || (r.reply?.writer?.kind === 'check' ? 'Writer 开始体检简历' : 'Writer 按这次指定的材料处理') : 'Writer 照你的回答接着改'); break; }
      // 省钱档：你按标题挑的记在线索上；留下的马上去判断（Jev 判断，没有 Jev 就逐条匹配）。
      case 'title_pick': {
        const r = await pickTitles(step, answered, { now });
        receipts.push(r.receipt);
        if (r.kept) { try { runOp(judgeAvailable() ? 'judge-leads' : 'match', { now }); receipts.push('留下的这就去判断'); } catch { receipts.push('留下的下一轮判断'); } }
        break;
      }
      case 'snooze': snooze(id, step.hours, now, step.until); receipts.push(step.until ? `${new Date(step.until).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 再问你` : step.hours >= 48 ? `${Math.round(step.hours / 24)} 天内不再问` : '先放一放，稍后再出现'); break;
      case 'draft_editor': return { ok: true, client: { draft_editor: step.draft_id } };
      // 「AI 缩短」：Writer 按渠道上限重写一版（lib/draft-edit.mjs rewriteDraft，和编辑框里的重写同一条路），写到上限以内才存成新草稿；
      // 存了也不发——信变回「看完就可以发」，你看过再点发送。还超就不存，照实说。
      case 'draft_shorten': {
        // 缩完回读核对（lib/draft-edit.mjs shortenDraft，O1）：意思变了、读不通就不交，原文不动，照实说。
        const E = await import('./draft-edit.mjs');
        const r = await E.shortenDraft({ draft_id: step.draft_id, now, ...(writerModel ? { model: writerModel } : {}) });
        if (!r.ok) throw Object.assign(Error(`${r.reason}；可以再缩一次，或者点「我自己改」`), { status: 409 });
        const saved = await E.editDraft({ draft_id: step.draft_id, subject: r.subject, body: r.body, source: 'ai_shorten', now });
        receipts.push(`缩短成 ${r.chars} 字了，看一眼再发`);
        if (saved.draft_id) nav = `#inbox?ask=${encodeURIComponent(`draft:${saved.draft_id}`)}`;
        break;
      }
      // 「补信息」（待核的门户岗位，lib/asks.mjs poolAsks）：打开资料编辑器的那一组，信还在，补完下一轮重新判断。
      case 'profile_editor': return { ok: true, done: false, client: { profile_editor: String(step.scope || 'profile'), ...(step.context ? { profile_context: step.context } : {}) } };
      // 「先判断」（没判完的岗位，lib/asks.mjs judgeFirst）：Judge 只判这一条（bin/match.mjs --record）。信留着，判完它自己换成投递 / 联系。
      case 'judge': {
        if (!step.record_id) throw Error('这封信没指着哪条岗位');
        const { judgeOne } = await import('./ops.mjs');
        let r; try { r = judgeOne(step.record_id, { now }); } catch (e) { throw Object.assign(Error(`没能开始判断：${e.message}`), { status: 409 }); }
        return { ok: true, done: false, receipt: r.pending ? `${crewName('lens')} 手上这一轮跑完就判这一条` : `${crewName('lens')} 在判这一条` };
      }
      // 兑换码（「补给用完了」那封信里填的）：交给 lib/free-model.mjs，兑不上就把原因原样告诉你，信留着。
      case 'redeem': {
        const { redeemFreeCode } = await import('./model-choice.mjs');
        const r = await redeemFreeCode({ code: (answered || []).find(f => f.key === 'code')?.value || '', now });
        if (!r.body.ok) throw Error(r.body.reason || '兑换没成功');
        receipts.push(r.body.receipt);
        break;
      }
      // 只让页面跳到工作台里的某一页（比如「设置 → 模型」）；地址只能是站内的 #…。
      // 「看原因」：System 讲原因、影响、能怎么办（lib/system/explain.mjs）；已经换了模型的（switched_to）照「已换、活照常」说。信留着。
      case 'explain': { const { explainWhy } = await import('./system/explain.mjs'); const r = await explainWhy('看原因', { now, failure: { reason: step.reason, who: step.who || null, backend: step.backend || null, switched_to: step.switched_to || null } }); return { ok: true, done: false, receipt: r.content }; }
      case 'navigate': if (!/^#[a-z][\w/?=&-]*$/.test(String(step.to || ''))) throw Error('不能跳到这个地址'); return { ok: true, client: { navigate: step.to } };
      default: throw Error(`未知步骤 ${step.type}`);
    }
  }
  event('user', 'inbox', 'ok', `收件箱：${ask.title} · ${label}`);
  // 只是在电脑上打开了一个页面（打开登录页、切到保留的投递页）：这一问还没答完，信和选项都留着——登录信下面的
  //「我登好了」还要你点（和飞书卡片同一个规则，lib/ask-cards.mjs onlyOpens）。以前一律回 done，收件箱把整封信收起来，
  // 没有自动检测的门户（字节跳动等）就再也点不到「我登好了」，投递一直停在等登录（10-01 开箱测试）。
  const onlyOpens = steps.length > 0 && steps.every(s => ['open', 'application_page', 'reveal_resume'].includes(s.type));
  return { ok: true, done: !onlyOpens, receipt: receipts.filter(Boolean).join('；') || '已处理', ...(opens.length ? { open: opens } : {}), ...(nav ? { client: { navigate: nav } } : {}) };
}
