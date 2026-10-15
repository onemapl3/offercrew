import { discoveryOutcome, DISCOVERY_STAGES } from './discovery-outcome.mjs';
// 指挥台（CEO 视角）：各位成员自动做本职工作，要用户决定的像给 CEO 发邮件一样
// 进收件箱，同时能看到每位成员的进度，每位底下显示它的详情。收件箱单独一页（专心处理），
// 指挥台只管"看"：
//   workers   每位成员一张卡（团队名册 lib/crew.mjs 的 6 位）：现在在做什么、今天做了多少、卡在哪、给你的信几封
//   worker    点开一位：它手上的事（现在、队列、今天做完的、出的问题）、请执行器做的事、给你的信、运行记录
//   inflight  你拍板之后的事走到了哪一步（收件箱的「进行中」用）
// 执行器不是成员：它做的事记在请它做事的那位名下（lib/crew.mjs JOB_MEMBER），它自己的运行、心跳、原始日志在 Patch 那里。
// 每条在推进的线索的工作流在 lib/workflow.mjs。这里只读状态、不做任何动作；给人看的字一律是中文说法。
import { cachedLines } from './state-cache.mjs';
import { leadTag, coName, verdictOf, verdictWord, verdictTone, VERDICT_KEYS } from './vocab.mjs';
import { href } from './routes.mjs';
import { read } from './store.mjs';
import { applyWord, applyUrl } from './apply-channel.mjs';
import { familyOf, loadAccounts } from './accounts.mjs';
import { roleOf as defaultRoleOf } from './command-center.mjs';
import { OPS } from './ops-table.mjs';
import { nextCalendar } from './schedule-status.mjs';
import { plainText } from './jargon.mjs';
import { tailEvents } from './dashboard.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { leadState } from './lead-state.mjs';
import { loadBriefs, researchCounts, companyKey, BRIEF_KIND, researchTasks } from './company-brief.mjs';
import { dossierFor, PHASE_WORD } from './interview-dossier.mjs';
import { CREW_IDS, crewMember, crewName, crewOf, memberOfJob } from './crew.mjs';
import { agentPaused, EXECUTOR } from './agents.mjs';
import { loadWorkspace, loadDoc, usedBy } from './resume-assistant.mjs';
import { versionLabel } from './resume-label.mjs';
import { deskInbox } from './hq.mjs';
import { sourceReadSummary } from './discovery-source.mjs';
import { sourcesView } from './sources.mjs';
import { contactRole } from './source-contacts.mjs';
import { eventWords, dedupeEvents } from './event-words.mjs';
import { backlogNow } from './first-round.mjs';
import { view, wordOf, fromLegacy, legacyChip, STATE_OF_TONE } from './status.mjs';
import * as J from './jobs.mjs';
import { noteSwallowed } from './swallow.mjs';
import { DAY, tsOf, T, dayOf, clock, dayClock, cut, within, ridOf, whenText, nextText, ago, STEP, plainReason, withWhy, plainMsg, humanSource, VERDICT, PREFILTER_WORD, reasonOf, channelLabel, applyStatus, askForJob, TONE_RANK, CLOSED, progressIndex, deliverySummary, leadLabel } from './workflow.mjs';
import { lastRev, JOB_KIND } from './cards.mjs';
import { browserReceiptWhy } from './browser-source-receipt.mjs';

const size = x => Array.isArray(x) ? x.length : Number(x) || 0;
const hasText = s => typeof s === 'string' && s.trim().length > 0;
const stepName = s => STEP[s] || '运行步骤';
// 运行记录的一行（事件流，历史）：结果的词从 lib/status.mjs 来（事件的 ok / skip / fail / waiting_user 认成六种之一）。
const eventWord = e => /changed|有更新/.test(e.msg || '') ? '有更新' : e.status === 'skip' ? '没有新的' : fromLegacy(e.status) ? wordOf(fromLegacy(e.status)) : '有记录';
const eventLine = (e, now = Date.now()) => ({ at: e.ts, time: dayClock(e.ts, now), status: e.status, text: `${stepName(e.step)}${e.status === 'start' ? '…' : ' · ' + eventWord(e)}` });
// 账上一件活给成员卡的名字：周期的一步用步骤名（「扫描官方源」），别的用活自己的标题。
const jobName = j => STEP[j.kind] || j.title || stepName(j.kind);

// ── 进行中：你拍板之后的事（收件箱「进行中」）──────────────────────────────────
export function inflightView({ leads = cachedLines('state/leads.ndjson'), drafts = cachedLines('state/drafts.ndjson'), requests = cachedLines('state/send-requests.ndjson'), outbound = cachedLines('state/outbound.ndjson'), jobs = cachedLines('state/host-jobs.ndjson'), asks = [], now = Date.now(), pipeline = read('config/pipeline.json', {}) } = {}) {
  const byId = new Map(leads.map(l => [l.record_id || l.id, l])), draftById = new Map(drafts.filter(d => d.draft_id).map(d => [d.draft_id, d]));
  // 线索已经结束（pass、归档、对方拒了、后来排除的公司），它没走完的发送 / 投递不算「进行中」。
  const ended = l => !!l && (CLOSED.has(leadState(l)) || excludedCompany(l, pipeline));
  const askFor = (rid, types) => asks.find(a => a.lead?.record_id === rid && (!types || types.includes(a.type)))?.id || null;
  const out = [];
  // 1) 你批准发送的（邮件、平台私信、好友申请）：每条线索每个渠道只看最新一次。
  const latest = new Map();
  for (const r of requests) { const k = `${r.record_id}|${r.channel || ''}`; const old = latest.get(k); if (!old || String(r.at || '') >= String(old.at || '')) latest.set(k, r); }
  for (const r of latest.values()) {
    if (!within(r.checked_at || r.dispatched_at || r.at, 3 * DAY, now)) continue;
    const d = draftById.get(r.draft_id) || {}, l = byId.get(r.record_id) || {};
    if (ended(byId.get(r.record_id))) continue;
    const what = channelLabel({ channel: r.channel || d.channel, to: d.to || '', platform: d.platform || '' });
    const sent = r.status === 'sent' || outbound.some(o => o.draft_id === r.draft_id);
    let stage, tone, ask = null;
    if (sent) { stage = '已发出 ✓'; tone = 'ok'; }
    else if (r.status === 'queued' && r.blocked === 'needs_login') { stage = `等你登录${familyOf(d.to)?.label ? ' ' + familyOf(d.to).label : ''}后自动发`; tone = 'wait'; ask = asks.find(a => a.type === 'login' && a.account?.key === familyOf(d.to)?.key)?.id || null; }
    else if (r.status === 'queued') { stage = r.channel === 'email' ? '排队中，下一轮周期发出' : '排队中，一分钟内发出'; tone = 'work'; }
    else if (r.status === 'dispatched') { stage = '发送中'; tone = 'work'; }
    else if (r.status === 'needs_review') { const why = `${r.reason || ''} ${r.result || ''}`; stage = /超过|超限|too_long|太长/.test(why) ? '附言超过平台字数上限，系统已缩短，要你重新确认' : /existing_thread|已有.*对话/.test(why) ? '平台上已经有这段对话了，没发；要改成回复再发' : '内容变了，要你重新确认'; tone = 'bad'; ask = askFor(r.record_id, ['review']); }
    else { stage = withWhy('发送结果不确定，系统在核对', plainReason(r.result, 40)); tone = 'bad'; }
    out.push({ id: `send:${r.id}`, kind: 'send', record_id: r.record_id || null, label: l.company ? leadLabel(l) : `${d.number != null ? '#' + d.number + ' ' : ''}${d.company || ''}`.trim(), number: l.number ?? d.number ?? null, company: l.company || d.company || '', what, stage, tone, at: r.checked_at || r.dispatched_at || r.at, ask });
  }
  // 2) 你批准投递的：从批准到提交。
  for (const l of leads) {
    const a = l.auto_apply;
    if (!a?.approved_at || l.superseded || ['closed', 'cancelled'].includes(a.status) || ended(l)) continue;
    const at = a.at || a.approved_at;
    if (!within(at, (a.status === 'submitted' ? 2 : 14) * DAY, now)) continue;
    const rid = l.record_id || l.id, fam = familyOf(applyUrl(l));
    const s = applyStatus(a, { lead: l, fam });
    const ask = s.group !== 'you' ? null : s.login ? asks.find(x => x.type === 'login' && x.account?.key === fam?.key)?.id || null : asks.find(x => x.id === `need:lead:${rid}:info`)?.id || askFor(rid, ['review', 'decide']) || asks.find(x => x.type === 'login' && (x.affected || []).some(i => i.record_id === rid))?.id || null;
    out.push({ id: `apply:${rid}`, kind: 'apply', record_id: rid, label: leadLabel(l), number: l.number ?? null, company: l.company || '', what: '投递', stage: s.status === '已提交' ? '已提交 ✓' : s.status, tone: s.tone, at, ask });
  }
  // 3) 交给执行器的事：你在收件箱写的话、对执行器问题的答复、"先找内推人"……
  for (const j of lastRev(jobs)) {
    const mine = j.kind === 'user_request' || (j.user_feedback || []).length || j.resume_source === 'dashboard_feedback';
    if (!mine) continue;
    const at = j.completed_at || j.resumed_at || j.updated_at || j.created_at;
    if (!within(at, (j.status === 'completed' ? 1 : 3) * DAY, now)) continue;
    const l = byId.get(j.record_id) || leads.find(x => j.number != null && x.number === j.number) || {};
    const ask = ['waiting_user', 'blocked'].includes(j.status) ? askForJob(asks, j.id) : null;
    // 说是哪位在做、哪位在问（E 线 10-01：给人看的字里不说「执行器」，它是大家共用的手）。
    const who = crewName(memberOfJob(j));
    const stage = j.status === 'completed' ? withWhy('做完了', plainReason(j.result, 60)) : j.status === 'working' ? `${who} 在做` : j.status === 'pending' ? '排队中' : j.status === 'waiting_user' ? `${who} 有问题问你` : j.status === 'blocked' ? `卡住了，${crewName('patch')} 在看` : j.status === 'dropped' ? '已放弃' : '处理中';
    const tone = j.status === 'completed' ? 'ok' : j.status === 'waiting_user' ? 'wait' : j.status === 'blocked' ? 'bad' : j.status === 'dropped' ? 'mute' : 'work';
    out.push({ id: `job:${j.id}`, kind: 'job', member: memberOfJob(j), record_id: l.record_id || l.id || j.record_id || null, label: l.company ? leadLabel(l) : '', number: l.number ?? j.number ?? null, company: l.company || '', what: j.kind === 'user_request' ? cut(j.details, 36) : `${JOB_KIND[j.kind] || '交办任务'}（你答复过）`, stage, tone, at, ask });
  }
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || T(b.at) - T(a.at)).slice(0, 40);
}

// ── 每位成员一张卡（团队名册，lib/crew.mjs）─────────────────────────────────────
export const WORKERS = CREW_IDS.map(id => { const m = crewMember(id); return { key: id, name: m.name, face: m.face, duty: m.duty, plain: m.plain, group: m.group_label }; });
export const WORKER_KEYS = CREW_IDS;
// 等你的信：收件箱那一张单子（lib/hq.mjs deskInbox，每件带着算在谁名下）按成员分。和指挥台、收件箱、侧栏角标同一份（lib/tally.mjs）。
const lettersBy = (inbox, jobs) => { const d = deskInbox(inbox, { jobs }); return key => d.asks.filter(a => a.member === key); };
// 交给执行器的任务（最新一版）按请它做事的成员分；open：还在排队、在做、等你、卡住的。
const OPEN_JOB = ['pending', 'working', 'waiting_user', 'blocked'];
const jobsOf = (key, jobs) => lastRev(jobs).filter(j => memberOfJob(j) === key);
// 简历助手（Tailor）的几份简历：只读文件，不跑体检（lib/resume-assistant.mjs）。
// 「材料」的结构（2026-10-01）：投递在用的是标了默认投递（default_for）的那一版；用在几个岗位按投递记录算。
// 旧的草稿、建议、拦下、追问都没有了，记 0。简历数据还没转换完（或转不过来）的那份当作没有，不报错。
function resumeSummary() {
  let ws; try { ws = loadWorkspace(); } catch { return { docs: [], tailoring: {} }; }
  const docs = [];
  for (const d of ws.docs || []) {
    try {
      const doc = loadDoc(d.id), used = usedBy(doc), def = (doc.versions || []).filter(v => v.default_for);
      const n = def.reduce((k, v) => k + (used[v.id] || []).length, 0);
      const stable = def.length ? `${def.map(v => versionLabel(doc, v, { lang: v.default_for })).join('、')}${n ? `，${n} 个岗位的申请表留底记录了这版` : ''}` : null;
      docs.push({ id: doc.id, title: doc.title || d.title || '简历', lang: doc.lang, versions: (doc.versions || []).length, current: def[0]?.id || null, stable, stable_at: def[0]?.created_at || null, draft: 0, pending: 0, accepted: 0, blocked: 0, questions: 0, used: n });
    } catch (e) { noteSwallowed('resume.loadDoc', e, { member: 'tailor', doing: `读简历 ${d.id}`, then: '团队页上先不列这份' }); }
  }
  return { docs, tailoring: ws.tailoring || {} };
}
const SCHEDULE_TITLE = { brief: '今日战报', cycle: '全流程周期', mailpoll: '收件箱巡检', workbench: '本地工作台' };
// 顶栏的「下一轮」：按 launchd 的日程（config/launchd/cycle.plist 的几个钟点；bin/host/radar-cycle.sh 只在 08:30–19:30 之间真跑）
// 从现在往后找，今天的只写几点，明天写「明天 09:05」。过了点还没跑的不写时间（这个时间每次请求都在变）。
// 读得到 launchctl、周期那一项没加载，或者根本没有周期那一项：「定时任务未安装」。读不到日程（测试、别的系统）就不写。
const CYCLE_WINDOW = [8 * 60 + 30, 19 * 60 + 30];
export function nextCycleText(schedule, now = Date.now()) {
  const items = schedule?.items;
  if (!items) return '';
  const cycle = items.find(i => i.kind === 'cycle');
  if (!cycle || cycle.loaded === false || (items.length && items.every(i => i.loaded === false))) return '定时任务未安装';
  const inWindow = (cycle.calendar || []).filter(c => { const m = c.hour * 60 + c.minute; return m >= CYCLE_WINDOW[0] && m <= CYCLE_WINDOW[1]; });
  const next = cycle.calendar?.length ? (inWindow.length ? nextCalendar(inWindow, now) : null) : cycle.next_at;
  if (!next || T(next) <= now + 60000) return '';
  return `下一轮 ${whenText(next, now).replace(/^今天 /, '')}`;
}
export function teamView(center = {}, inbox = {}, { now = Date.now(), leads = cachedLines('state/leads.ndjson'), outbound = cachedLines('state/outbound.ndjson'), jobs = cachedLines('state/host-jobs.ndjson'), resume = null } = {}) {
  const today = dayOf(now);
  const asks = inbox.asks || [];
  // 给你的信按成员分，和指挥台「等你」同一条规则（lib/hq.mjs memberOf：信的种类 → 挂着的交办任务 → 发信的老角色）。
  const letters = lettersBy(inbox, jobs), triageOf = key => key === 'lens' ? asks.filter(a => a.type === 'triage').length : 0;
  const nextCycle = nextCycleText(center.schedule, now);
  // 顶栏的一句系统状态：没有未恢复的严重告警就是「系统正常」。
  const errors = (center.alerts || []).filter(a => !a.recovered_at && a.level === 'error').length;
  const status = { tone: errors ? 'bad' : 'ok', text: errors ? `${errors} 条严重告警` : '系统正常', next: nextCycle };
  const live = leads.filter(l => !l.superseded);
  const count = (arr, f) => arr.filter(f).length;
  const born = l => l.discovered_at || l.imported_at;
  const briefs = loadBriefs(), rc = researchCounts({ briefs, jobs: lastRev(jobs) });
  const rs = resume || resumeSummary(), inUse = rs.docs.filter(d => d.stable).length;
  const stats = {
    scout: [
      ['今天新岗位', count(live, l => dayOf(born(l)) === today)],
      ['今天挡掉', count(live, l => dayOf(born(l)) === today && !!l.prefilter_reason)],
      ['浏览器在扫', count(jobsOf('scout', jobs), j => ['pending', 'working'].includes(j.status))],
    ],
    lens: [
      ['今天判断', count(live, l => dayOf(l.matched_at || l.match?.at || l.rejudged_at) === today)],
      ['推荐待你看', count(asks, a => a.type === 'triage')],
      ['公司在调研', rc.researching],
    ],
    tailor: [
      ['简历', rs.docs.length],
      ['在用于投递', inUse],
      ['拦下编造', rs.docs.reduce((n, d) => n + d.blocked, 0)],
    ],
    quill: [
      ['今天发出', count(outbound, o => dayOf(o.sent_at || o.at) === today)],
      ['草稿待你审', count(asks, a => a.type === 'review' && a.preview?.kind === 'draft')],
      ['投递进行中', count(inbox.inflight || [], i => i.kind === 'apply' && i.tone !== 'ok')],
    ],
    owl: [
      ['今天回复', count(live, l => dayOf(l.replied_at) === today)],
      ['待面试', count(live, l => tsOf(l.interview_at) > now && !l.interview_completed_at)],
      ['要你回的', count(asks, a => a.type === 'interview')],
    ],
    patch: [
      ['今天失败', center.roles?.patch?.fails_today ?? 0],
      ['修复在做', (center.repairs?.rows || []).filter(r => ['pending', 'working'].includes(r.status)).length],
      ['告警', (center.alerts || []).filter(a => !a.recovered_at && a.level === 'error').length],
    ],
  };
  const rn = center.executor?.run_now || {};
  const workers = WORKERS.map(w => {
    const role = center.roles?.[w.key] || {};
    // 在做、出错查账（线 S）：这位手上 running 的活（周期的一步先于整轮那件），最近结束的那件失败了就是出错。
    const doing = J.list({ member: w.key, state: 'running', limit: 20 }).sort((a, b) => (a.kind === 'cycle') - (b.kind === 'cycle'))[0] || null;
    const last = J.latest({ member: w.key, state: ['done', 'failed'] });
    let state = doing ? 'running' : last?.state === 'failed' ? 'warn' : 'idle', nowText = '';
    // 本地工作台自己启动 / 停止的记录不算 Patch 的工作。
    const own = e => e.status !== 'start' && e.step !== 'web';
    const recent = (role.recent || []).filter(own).slice(0, 4).map(e => eventLine(e, now));
    const mine = jobsOf(w.key, jobs);
    if (doing) nowText = `正在${jobName(doing)}（${clock(doing.started_at || doing.updated_at)} 开始）`;
    else if (last && within(last.finished_at || last.updated_at, 15 * 60000, now)) nowText = `刚刚${jobName(last)} · ${view(last).word}`;
    // 下一轮什么时候跑只在顶栏说一次；这里说它上一次做了什么。
    else nowText = `空闲${recent[0] ? ` · 上次 ${recent[0].time} ${recent[0].text}` : ''}`;
    // 给你的信不含新线索筛选（顶栏「另有 N 条新线索待筛选」单独数），各位的信加起来就是顶栏的「N 封信」。
    const letter = letters(w.key);
    const blockers = letter.filter(a => a.type === 'login').map(a => ({ text: a.title, ask: a.id }));
    // 手动跑一次（原来散在旧指挥台各模块里的「运行」按钮），按成员收在它自己那一栏里。
    const ops = Object.entries(OPS).filter(([, o]) => !o.round && o.role === w.key).map(([key, o]) => ({ key, label: o.label, desc: plainText(o.desc), heavy: !!o.heavy, running: center.ops?.current?.op === key }));
    const jobs_open = mine.filter(j => OPEN_JOB.includes(j.status)).length;
    // 执行器是大家共用的手，它的开关（state/agent-pause.json 的 executor）在 Patch 这里。
    const extra = w.key === 'patch' ? { executor: { paused: agentPaused(EXECUTOR), running: !!rn.running, pending: !!rn.pending } } : {};
    return { ...w, state, now: nowText, stats: stats[w.key] || [], letters: letter.length, triage: triageOf(w.key), blockers, recent, ops, fails_today: role.fails_today || 0, jobs_open, ...extra };
  });
  return { workers, status };
}

// 真人帖平台：同一个平台的几种写法（boss、Boss直聘、BOSS 直聘）认成一个，名字统一。
const platformKey = k => { const x = String(k || '').toLowerCase().replace(/[\s.]/g, ''); return /^boss/.test(x) ? 'boss' : /^linkedin/.test(x) ? 'linkedin' : /^(maimai|脉脉)/.test(x) ? 'maimai' : /^linuxdo/.test(x) ? 'linuxdo' : x; };
const PLATFORM = { boss: 'BOSS 直聘', linkedin: 'LinkedIn', maimai: '脉脉', linuxdo: 'Linux.do' };
const platformName = k => PLATFORM[platformKey(k)] || humanSource(k);
// 浏览器关着的原因（config/human-source-policy.json 写给维护的人看的那句）说成一句人话，不露接口、状态码、命令名。
export function offReason(reason) {
  const r = String(reason || '');
  if (/cloudflare|(?<!\d)40[13](?!\d)|拦/i.test(r)) return '网站拦住了自动读取';
  if (/登录|ego|login/i.test(r)) return '要先登录这个网站';
  const first = plainReason(r.split(/[；;。]/)[0].replace(/（[^）]*）|\([^)]*\)/g, ''), 40).replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
  return /[A-Za-z]{4,}/.test(first) ? '暂时不扫' : first;
}

// ── 点开一位成员：它手上的事 ──────────────────────────────────────────────────
// 和页面的约定（web/team.js）：一行的 link 一律是 { url, label }（外部网页），href 是站内地址（lib/routes.mjs 拼），ask 是收件箱那一封的 id。
// 交给这台电脑的事（state/host-jobs.ndjson，还没进账）的小标：旧状态码经 lib/status.mjs 认成六种之一。
const jobChip = s => { const c = legacyChip(s) || { word: '处理中', tone: 'run' }; return { tag: c.word, tone: c.tone }; };
// 交办任务（host-jobs 的一行）：账上有它那件活（迁移时记成 ref hostjob:<id>，lib/jobs-migrate.mjs）就照账，没有才认旧状态码。
const hostChip = j => { const x = j?.id ? J.byRef(`hostjob:${j.id}`) : null; if (!x) return jobChip(j?.status); const v = view(x); return { tag: v.word, tone: v.tone }; };
const HEARTBEAT_WHO = { 'auto-apply': '填申请表', 'run-now': '即时任务', 'send-dm': '发私信', 'discover-human-browser': '浏览器扫真人帖' };
const MAIL_CATEGORY = { unrelated: '无关', other: '其他' };
const jobTitle = j => `${j.number != null ? '#' + j.number + ' ' : ''}${j.company ? j.company + ' · ' : ''}${JOB_KIND[j.kind] || '交办任务'}`;
const STAGE_TEXT = {
  'pull-feedback': r => `处理了你的 ${r.applied ?? 0} 条反馈`,
  'send-approved': r => `发出 ${r.sent ?? 0} 封邮件`,
  'send-dm': r => `发出 ${r.sent ?? 0} 条私信`,
  discover: r => `抓到 ${r.raw ?? 0} 条，${r.eligible ?? 0} 条合格，新增 ${r.added ?? 0} 条；${Array.isArray(r.sources) && r.sources.some(x => x && typeof x === 'object') ? sourceReadSummary(r.sources).text : `${r.verified ?? 0} 个源正常${r.failing ? `，${size(r.failing)} 个出错` : ''}`}`,
  'discover-human': r => `看了 ${r.candidates ?? 0} 条候选，新增 ${r.added ?? 0} 条（${size(r.sources)} 个来源）`,
  'discover-human-browser': r => `新增 ${r.added ?? 0} 条，起草 ${r.drafted ?? 0} 条${(r.sources || []).filter(s => s.status === 'skipped').length ? `；${(r.sources || []).filter(s => s.status === 'skipped').length} 个来源跳过了` : ''}`,
  'judge-leads': r => `判断 ${r.judged ?? 0} 条：推荐 ${r.verdicts?.recommend ?? 0}、待核 ${r.verdicts?.verify ?? 0}、排除 ${r.verdicts?.exclude ?? 0}；预筛掉 ${r.prefiltered ?? 0}${r.failed ? `；失败 ${r.failed}` : ''}${r.pending ? `；还有 ${r.pending} 条没判断` : ''}`,
  match: r => `这轮调用模型 ${r.calls ?? 0} 次；池里推荐 ${r.recommended ?? 0}、待核 ${r.verify ?? 0}、排除 ${r.exclude ?? 0}${r.match_failed_final ? `；${r.match_failed_final} 条匹配失败` : ''}`,
  'find-contacts': r => `查了 ${r.checked ?? 0} 条，找到 ${r.found ?? 0} 个联系方式`,
  'find-referrers': r => `查了 ${r.companies ?? 0} 家公司，找到 ${r.people ?? 0} 位内推人，写了 ${r.drafts ?? 0} 份草稿`,
  'prepare-applications': r => `交给这台电脑准备 ${size(r.next_actions)} 份投递材料`,
  'auto-apply': r => `提交 ${r.submitted ?? 0}；等你确认 ${r.awaiting_review ?? 0}、等终审 ${r.awaiting_final_review ?? 0}、等登录 ${r.needs_login ?? 0}；失败 ${r.failed ?? 0}`,
  inbox: r => `交给这台电脑看邮件${size(r.reminders) ? `；${size(r.reminders)} 条跟进提醒` : ''}`,
  'prepare-interviews': r => [size(r.next_actions) ? `面试资料 ${size(r.next_actions)} 份在做` : '', r.company_briefs?.queued?.length ? `排了 ${r.company_briefs.queued.length} 家公司调研（${r.company_briefs.queued.slice(0, 3).join('、')}）` : '', r.role_prep?.queued?.length ? `${r.role_prep.queued.length} 条怎么准备` : ''].filter(Boolean).join('，') || '没有要新排的',
  'host-work': r => `交给这台电脑 ${size(r.next_actions)} 件事`,
  metrics: r => `在推进 ${r.active ?? 0} 条、联系过 ${r.contacted ?? 0}、回复 ${r.replied ?? 0}`,
};
const stageRow = (r, at, now) => {
  if (DISCOVERY_STAGES.has(r.stage) && Array.isArray(r.sources)) {
    const scan = discoveryOutcome([r]);
    if (scan.status !== 'done') return { a: stepName(r.stage), b: scan.text, tag: scan.status === 'partial' ? '部分完成' : '没完成', tone: scan.status === 'partial' ? 'wait' : 'bad', c: at ? whenText(at, now) : '' };
  }
  const c = legacyChip(r.status) || legacyChip(r.stage === 'metrics' ? 'done' : 'none') || { word: '—', tone: 'mute' }, word = r.status === 'no_change' ? '没有新的' : c.word, tone = c.tone;
  const errors = (r.errors || (r.error ? [r.error] : [])).map(x => plainReason(typeof x === 'string' ? x : x?.error || x?.message || '', 60)).filter(Boolean);
  return { a: stepName(r.stage), b: (STAGE_TEXT[r.stage] || (() => ''))(r) || word, d: errors.length ? `出错：${errors.slice(0, 2).join('；')}` : '', tag: word, tone, c: at ? whenText(at, now) : '' };
};
// 这位成员最近 24 小时的运行记录（事件按 lib/crew.mjs memberOfEvent 归属；执行器自己的起停、整理交办任务是 Patch 的）。
// 同一步同一个结果记了两条：lib/event-words.mjs dedupeEvents（运行日志页也用它）。
export { dedupeEvents };
function eventsFor(key, events, role, now) {
  // 本地工作台自己启动 / 停止（step web）不算谁的工作，和卡片上一样不列。
  return dedupeEvents(events.filter(e => e.status !== 'start' && e.step !== 'heartbeat' && e.step !== 'web' && within(e.ts, DAY, now) && ((e.step === 'cycle' && J.forRun(e.run_id)?.member) || role(e)) === key).sort((a, b) => T(b.ts) - T(a.ts))).slice(0, 60).map(e => {
    const plain = /^[a-z][a-z-]* · [a-z_]+$/.test(String(e.msg || '').trim()) ? '' : eventWords(e.msg, 160, e);
    // 认不出的步骤（写求职信、自我介绍……）标题只会是「运行步骤」：那一句话本身就是标题。
    const line = eventLine(e, now), unnamed = !STEP[e.step] && plain;
    return { ...line, run_id: e.run_id || null, step: e.step || null, ...(unnamed ? { text: `${cut(plain, 60)}${e.status === 'fail' ? ' · 失败' : ''}` } : {}), detail: unnamed ? '' : plain, rid: e.lead_id || null, refs: (e.refs || []).map(r => r.file || r.screenshot).filter(f => typeof f === 'string' && f.startsWith('runs/')).slice(0, 2) };
  });
}
// 浏览器扫描回执是不可变的；后来的 Judge 周期不会覆盖它。每个来源保留自己最近一次的扫描记录。
function browserSourceRecords(events, prog) {
  const found = new Map();
  const add = (sources, at) => { for (const r of sources || []) { const key = platformKey(r.source); if (key === 'browser') continue; if (!found.has(key) || T(at) > T(found.get(key).at)) found.set(key, { ...r, at }); } };
  for (const e of events.filter(e => e.step === 'discover-human-browser').sort((a, b) => T(b.ts) - T(a.ts))) {
    for (const r of e.refs || []) {
      const ref = r.file;
      if (!/^runs\/\d{8}\/discover-human-browser-\d+\.json$/.test(ref || '')) continue;
      try { add(read(ref, {})?.sources, e.ts); } catch (err) { console.error(`[team] 读取真人帖回执失败：${err.message}`); }
    }
  }
  add((prog.results || []).find(r => r.stage === 'discover-human-browser')?.sources, prog.at);
  return [...found.values()];
}
// 每一节一个稳定的 key（页面按 key 挑要显示的几节，不认标题文字）。
const SECTION_KEY = [[/^公司调研/, 'research'], [/^今天找到的/, 'found_today'], [/^手上的线索/, 'on_hand'], [/^上一轮找岗位/, 'last_round'], [/^上一轮判断/, 'last_judge'], [/^简历/, 'resumes'], [/^按岗位定制/, 'tailoring'], [/^交给这台电脑的/, 'executor'], [/^招聘源/, 'sources'], [/^在路上/, 'on_the_way'], [/^今天发出的/, 'sent_today'], [/^没发成的/, 'failed'], [/^联系人/, 'referrers'], [/^面试准备/, 'interviews'], [/^最近 14 天的回复/, 'replies'], [/^邮箱巡检/, 'mail_patrol'], [/^最近收到的邮件/, 'mail'], [/^这台电脑：现在$/, 'now'], [/^你交代的事/, 'asked'], [/^这台电脑：后台任务心跳/, 'heartbeats'], [/^这台电脑：原始日志/, 'log'], [/^接下来/, 'next'], [/^上一轮各步骤/, 'last_cycle'], [/^自动修复/, 'repairs'], [/^告警/, 'alerts'], [/^服务和账号/, 'services']];
// 一位成员点开之后的内容。sections 里每行：a 标题 · b 内容 · d 补充 · tag 状态 · c 时间，
// 可带 rid（线索详情）、ask（收件箱那封信）、href（站内页面）、inbox（收件箱的某个标签）、link（外部链接）。
// 有 log 的一节是原始日志（排查用，折叠显示）。
// tally：lib/tally.mjs 的那份账（/api/hq 的 tally）：新线索、待核、各结论几条照它写，不在这里另数。
export function workerDetail(key, center = {}, inbox = {}, { now = Date.now(), roleOf = defaultRoleOf, events = null, progress = {}, tally = null } = {}) {
  const w = WORKERS.find(x => x.key === key);
  if (!w) throw Error('没有这位成员');
  const asks = inbox.asks || [];
  const card = teamView(center, inbox, { now }).workers.find(x => x.key === key) || {};
  const sections = [];
  const L = (title, rows, { note = '', empty = '没有', more = 0, log = null } = {}) => sections.push({ key: (SECTION_KEY.find(([re]) => re.test(title)) || [null, null])[1], title, note, rows: rows.map(r => Object.fromEntries(Object.entries(typeof r.link === 'string' ? { ...r, link: { url: r.link, label: '打开' } } : r).filter(([, v]) => v != null && v !== ''))), empty, more: Math.max(0, more), ...(log != null ? { log } : {}) });
  const x = ['scout', 'lens', 'quill', 'owl'].includes(key) ? progressIndex({ asks, now, ...progress }) : null;
  const today = dayOf(now);
  const leadLine = (l, extra = {}) => ({ a: leadTag(l), label: leadLabel(l), rid: ridOf(l), ...extra });
  // 线索按 id / 编号找（执行器的任务、内推人、邮件只记了其中一个）。
  let leadMap = null;
  const leadOf = (id, n) => { if (!leadMap) { const live = x ? x.entries.map(e => e.l) : cachedLines('state/leads.ndjson').filter(l => !l.superseded); leadMap = new Map(); for (const l of live) { leadMap.set(ridOf(l), l); if (l.id) leadMap.set(l.id, l); if (l.number != null) leadMap.set(`#${l.number}`, l); } } return (id && leadMap.get(id)) || (n != null ? leadMap.get(`#${n}`) : null) || null; };
  const labelOf = (id, n) => { const l = leadOf(id, n); return l ? leadLabel(l) : null; };
  const prog = read('state/cycle-progress.json', {});
  const R = Object.fromEntries((prog.results || []).map(r => [r.stage, r]));

  if (key === 'scout') {
    const bornAt = l => l.discovered_at || l.imported_at;
    const week = x.entries.filter(e => within(bornAt(e.l), 7 * DAY, now) && T(bornAt(e.l)) <= now + 60000);
    const tw = { recommend: 0, verify: 0, exclude: 0, prefilter: 0, none: 0 };
    for (const e of week) tw[verdictOf(e.l)]++;
    const verdictTag = l => [verdictWord(verdictOf(l)), verdictTone(verdictOf(l))]; // 结论词一张表（lib/vocab.mjs）
    const why = l => l.prefilter_reason ? PREFILTER_WORD[l.prefilter_reason] || '不符合筛选条件' : l.match ? reasonOf(l) : l.match_error_final ? '判断失败了，要人工看一眼' : '';
    const order = e => e.l.prefilter_reason ? 3 : e.l.match?.verdict === 'exclude' ? 2 : e.l.match?.verdict ? 0 : 1;
    const todays = week.filter(e => dayOf(bornAt(e.l)) === today).sort((a, b) => order(a) - order(b) || T(bornAt(b.l)) - T(bornAt(a.l)));
    // 链接上已经是「#编号 公司 · 岗位 · 城市」，下面不再把岗位名写一遍（QA 第 2 轮 #21）；写判断的理由。
    L(`今天找到的（${todays.length}）`, todays.slice(0, 10).map(e => { const [tag, tone] = verdictTag(e.l); return leadLine(e.l, { d: why(e.l), tag, tone, c: clock(bornAt(e.l)) }); }), { note: `近 7 天找到 ${week.length} 条：推荐 ${tw.recommend}、待核 ${tw.verify}、排除 ${tw.exclude}、预筛掉 ${tw.prefilter}${tw.none ? `、还没判断 ${tw.none}` : ''}`, empty: '今天还没有新岗位', more: todays.length - 10 });
    L('上一轮找岗位的结果', ['discover', 'discover-human', 'discover-human-browser'].filter(s => R[s]).map(s => stageRow(R[s], prog.at, now)), { empty: '还没有周期记录' });
    // 官方招聘源：config/companies.yaml 的每一家（lib/sources.mjs），读到了岗位就算正常；官网地址没核实过不算有问题（10-01 #7）。
    const SV = sourcesView({ now }), unread = SV.sources.filter(s => ['held', 'failing', 'broken'].includes(s.state));
    // quiet 是读通了但暂无岗位；held 是网站限制、没读成，保留具体原因。
    const SOURCE_TAG = { ok: ['正常', 'ok'], unconfirmed: ['正常', 'ok'], quiet: ['暂无岗位', 'mute'], held: ['读不了', 'mute'], failing: ['这次没读成', 'wait'], broken: ['读不到', 'bad'], paused: ['暂停', 'mute'], new: ['新加的', 'mute'] };
    const human = read('state/human-discovery-check.json', {}), policy = read('config/human-source-policy.json', {});
    const browser = browserSourceRecords(events || tailEvents(4000), prog);
    const acct = k => (inbox.accounts || []).find(a => a.key === k);
    const loginTag = k => { const a = acct(k); return !a ? {} : a.logged_in === true ? { tag: '已登录', tone: 'ok' } : a.logged_in === false ? { tag: '没登录', tone: 'wait', ask: asks.find(q => q.type === 'login' && q.account?.key === k)?.id || null } : { tag: '没核实登录', tone: 'mute' }; };
    const sourceRows = SV.sources.map(x => ({ a: x.name, b: x.text, tag: SOURCE_TAG[x.state][0], tone: SOURCE_TAG[x.state][1], c: x.at ? ago(x.at, now) : '', ...(x.editable ? { source: x.name } : {}), ...(x.url ? { link: x.url } : {}) }));
    // 真人帖：一个平台一行（QA 第 2 轮 #16：「LinkedIn · 看了 0 帖 · 正常」和「LinkedIn（浏览器）· 关着」同时出现，BOSS 两种写法）。
    // 检查记录（state/human-discovery-check.json）和浏览器开关（config/human-source-policy.json）按平台并起来：
    // 浏览器关着、检查又说「正常、看了 0 帖」，就只说关着；看到了帖子，说看了几帖。
    const humanRows = new Map();
    for (const s of human.sources || []) {
      const ok = ['checked', 'ok'].includes(s.status);
      humanRows.set(platformKey(s.source), { a: platformName(s.source), at: human.at, posts: Number(s.posts) || 0, b: ok ? `看了 ${s.posts ?? 0} 帖，${s.eligible ?? 0} 条合格` : s.status === 'paused' ? `暂停：${offReason(s.reason) || '手动关了'}` : ['blocked', 'partial'].includes(s.status) ? withWhy('被拦住了', plainReason(s.error || s.reason, 60)) : plainReason(s.reason, 60) || '没有记录', tag: ok ? '正常' : s.status === 'paused' ? '暂停' : '有问题', tone: ok ? 'ok' : s.status === 'paused' ? 'mute' : 'bad', c: human.at ? ago(human.at, now) : '' });
    }
    for (const k of [...new Set([...Object.keys(policy), ...browser.map(s => s.source)])]) {
      const p = policy[k] || {}, b = browser.find(s => platformKey(s.source) === platformKey(k)), off = p.enabled === false, key = platformKey(k), had = humanRows.get(key);
      // 检查记录说「正常、看了 0 帖」而浏览器关着：说关着。别的检查记录（看到了帖子、暂停、被拦）留着，浏览器这行不另列。
      // 浏览器这一轮扫不了（10-10：领英动态天天失败，这里却写「上一轮看了 0 条」）：说哪个源、为什么、要你做什么，盖过检查记录那一行。
      const stuck = ['blocked', 'partial'].includes(b?.status);
      const skipped = b?.status === 'skipped' ? browserReceiptWhy(b, k, acct(k)).replace(/^[^：]{1,12}：/, '') : '';
      if (had && (!b || T(had.at) > T(b.at)) && !(off && had.tag === '正常' && !had.posts)) continue;
      if (stuck) { humanRows.set(key, { a: platformName(k), b: `上次扫不了：${browserReceiptWhy(b, k, acct(k)).replace(/^[^：]{1,12}：/, '')}`, tag: b.status === 'partial' ? '上次没读全' : '上次没读成', tone: 'bad', c: b.at ? ago(b.at, now) : '', d: `${off ? '当前关着' : '当前开着'}${loginTag(k).tag ? ' · ' + loginTag(k).tag : ''}` }); continue; }
      humanRows.set(key, { a: platformName(k), b: b?.status === 'skipped' ? `上一轮跳过了：${skipped}` : b ? `上一轮${b.status === 'paused' ? '未扫描：' + (offReason(b.reason) || plainReason(b.reason, 60)) : '看了 ' + (b.candidates ?? b.posts ?? 0) + ' 条'}` : off ? `关着${p.reason ? '：' + offReason(p.reason) : ''}` : '还没有扫描记录', c: b?.at ? ago(b.at, now) : '', d: `当前${off ? '关着' : '开着'}${loginTag(k).tag ? ' · ' + loginTag(k).tag : ''}`, ...(b ? { tag: b.status === 'skipped' || b.status === 'paused' ? '没扫描' : '已扫描', tone: b.status === 'skipped' || b.status === 'paused' ? 'wait' : 'ok' } : off ? { tag: '关着', tone: 'mute' } : loginTag(k)) });
    }
    // 读取结果不决定网站能否打开、登录；平台入口沿用账号配置，开关仍在现有「渠道」页。
    const families = loadAccounts().families || {};
    sourceRows.push(...[...humanRows].map(([k, { posts, at, ask, ...r }]) => {
      const account = acct(k) || families[k], url = account?.login_url || families[k]?.login_url;
      return { ...r, ...(account ? { href: '#settings/accounts', href_label: '账号' } : {}), ...(/^https?:\/\//i.test(url || '') ? { link: { url, label: '打开网站' } } : {}) };
    }));
    const issues = [...humanRows.values()].filter(r => r.tone === 'bad');
    L(`招聘源${unread.length + issues.length ? `（${unread.length + issues.length} 个没读成或没读全）` : ''}`, sourceRows, { note: [sourceReadSummary(SV.sources).note, issues.length ? `${issues.length} 个真人帖来源没读成或没读全` : '', human.at ? `真人帖上次检查 ${whenText(human.at, now)}` : ''].filter(Boolean).join('；'), empty: '还没有抓取记录' });
  }

  if (key === 'lens') {
    // 几个数都照那份账（lib/tally.mjs，和指挥台的标签、对话里报的同一份）；没给账（老调用、测试）就按线索数一遍同样的口径。
    const V = tally?.leads?.verdicts || (() => { const v = { recommend: 0, verify: 0, exclude: 0, prefilter: 0, none: 0 }; for (const e of x.entries) v[verdictOf(e.l)]++; return v; })();
    const fresh = tally?.leads ? { new: tally.leads.new, verify: tally.leads.verify, recommend: tally.leads.recommend } : (() => { const vs = asks.filter(a => a.type === 'triage').map(a => leadOf(a.lead?.record_id || a.lead?.id)?.match?.verdict || null); return { new: vs.filter(v => v !== 'verify').length, verify: vs.filter(v => v === 'verify').length, recommend: vs.filter(v => v === 'recommend').length }; })();
    // 等判断 = Judge 手上排着的（刚找到、还没判、没被规则筛掉、也没往下走的），和「全部」里「还没判断」不是一回事（那个也算没判就联系、投了的）。
    const unjudged = x.entries.filter(e => e.state === 'new' && !e.l.auto_apply && !e.l.prefilter_reason && !e.l.match && !e.l.match_error_final).length, toPick = fresh.new + fresh.verify;
    // 判断失败的只列判断以后还没往下走的（已经联系、投过的不再判，B26）。
    const failed = x.entries.filter(e => e.l.match_error_final && !e.l.match && e.state === 'new' && !e.l.auto_apply);
    L('手上的线索', [
      // 什么时候判、一轮判几个照实说（lib/first-round.mjs backlogNow，和运行日志同一句），不说笼统的「下一轮周期」。
      { a: '新岗位等判断', b: unjudged ? backlogNow(unjudged) : '新岗位都判断过了', d: V.none > unjudged ? `全部里另有 ${V.none - unjudged} 条未判断记录，包含判断失败、已推进或收起的岗位` : '', tag: unjudged ? '排队' : '清空', tone: unjudged ? 'work' : 'ok' },
      // 新线索在指挥台的「新线索」「待核」里筛，不在收件箱（QA 第 2 轮 #19）。
      { a: '待你筛选', b: `新线索 ${fresh.new} 条（推荐 ${fresh.recommend}）、待核 ${fresh.verify} 条`, href: href.command({ tab: fresh.new || !fresh.verify ? 'new' : 'verify' }), tag: toPick ? '等你' : '清空', tone: toPick ? 'wait' : 'ok' },
      { a: '全部岗位', b: VERDICT_KEYS.filter(k => V[k]).map(k => `${verdictWord(k)} ${V[k]}`).join('、') || '还没有', href: href.jobs() },
      // 指挥台已移除结论筛选；保留统计，不给出会落到全部岗位的旧入口。
      { a: '系统排除', b: `${V.exclude + V.prefilter} 条预筛掉或判断不合适` },
      ...failed.slice(0, 10).map(e => leadLine(e.l, { b: `判断失败了（试了 ${e.l.match_attempts || 1} 次）`, ask: asks.find(a => a.lead?.record_id === e.rid)?.id || null, judge: e.rid, tag: '判断失败', tone: 'bad' })),
    ]);
    L('上一轮判断的结果', ['judge-leads', 'match', 'prepare-interviews'].filter(s => R[s]).map(s => stageRow(R[s], prog.at, now)), { empty: '还没有周期记录' });
    // 公司调研（lib/company-brief.mjs）：在调研的、最近调研好的、没调研成的；点一行打开这家公司的一条线索。
    // 调研卡（引擎做的，researchTasks）按宿主任务的样子并进来：在查、没调研成都看得到。
    const briefs = loadBriefs(), jobs = lastRev([...cachedLines('state/host-jobs.ndjson'), ...researchTasks()]), rc = researchCounts({ briefs, jobs });
    const leadOfCompany = key => { if (!key) return null; for (const e of x.entries) if (companyKey(e.l.company) === key) return e.l; return null; };
    // 这一行说的是公司，不是某个岗位：只挂一条线索的 rid（点开看这家公司的调研），不换成线索的名字。
    const coRow = (key, extra) => { const l = leadOfCompany(key); return { ...extra, ...(l ? { rid: ridOf(l) } : {}) }; };
    const briefJobs = jobs.filter(j => j.kind === BRIEF_KIND).map(j => ({ ...j, company_key: j.company_key || companyKey(j.company) })).sort((a, b) => T(b.created_at) - T(a.created_at));
    const researching = [...new Map(briefJobs.filter(j => ['pending', 'working'].includes(j.status)).reverse().map(j => [j.company_key || j.company, j])).values()].reverse(); // 一家一行（旧任务和调研卡同一家只算一次）
    const failedJobs = briefJobs.filter(j => ['blocked', 'dropped'].includes(j.status) && within(j.updated_at || j.created_at, 7 * DAY, now) && !briefs.has(j.company_key));
    const ready = [...briefs.values()].sort((a, b) => T(b.updated_at) - T(a.updated_at));
    L(`公司调研（调研中 ${rc.researching} 家 / 已调研 ${rc.done} 家）`, [
      ...researching.slice(0, 4).map(j => coRow(j.company_key, { a: j.company, b: j.reason === 'stale' ? '调研过期了，重新查' : j.roles?.length ? `为 ${cut(j.roles.join('、'), 50)}` : j.source === 'cycle' ? '定时调研' : '你点的调研', tag: j.status === 'working' ? '在查' : '排队', tone: 'work', c: ago(j.created_at, now) })),
      ...failedJobs.slice(0, 2).map(j => coRow(j.company_key, { a: j.company, b: plainReason(j.result || j.blocked_reason, 60) || '没查下去', tag: '没调研成', tone: 'bad', c: ago(j.updated_at || j.created_at, now) })),
      ...ready.slice(0, 4).map(b => coRow(b.key, { a: b.company, b: b.status === 'not_found' ? `公开资料很少：${cut(b.note, 40)}` : cut(b.summary?.text, 60), tag: b.status === 'not_found' ? '查不到' : '已调研', tone: b.status === 'not_found' ? 'mute' : 'ok', c: whenText(b.updated_at, now) })),
    ], { note: rc.preps_open ? `另有 ${rc.preps_open} 条「怎么准备」在写` : '', empty: '还没有调研过公司' });
  }

  if (key === 'tailor') {
    // 简历助手（lib/resume-assistant.mjs）：几份简历、各自在用哪一版、草稿里改了几条、拦下几条编造、还有几个追问。
    const rs = resumeSummary();
    L(`简历（${rs.docs.length}）`, rs.docs.map(d => ({ a: `${d.title}${d.lang ? `（${d.lang === 'zh' ? '中文' : '英文'}）` : ''}`, b: `${d.versions} 个版本，${d.stable ? `投递在用 ${d.stable}` : '还没选投递用哪一版'}${d.draft ? `；草稿里改了 ${d.draft} 处没存` : ''}`, d: [d.pending ? `${d.pending} 条改写建议等你看` : '', d.questions ? `${d.questions} 个追问` : '', d.blocked ? `拦下 ${d.blocked} 条编造` : ''].filter(Boolean).join('，'), tag: d.stable ? '在用' : '没在用', tone: d.stable ? 'ok' : 'wait', c: d.stable_at ? whenText(d.stable_at, now) : '', href: '#materials' })), { note: '在「材料」里改', empty: '还没导入简历（在「材料」里导入）' });
    const tl = rs.tailoring || {};
    L('按岗位定制', [{ a: tl.enabled ? '开着' : '关着', b: tl.enabled ? `给已批准、还没递出的岗位做定制版（${tl.only === 'en' ? '只对英文 JD' : tl.only === 'zh' ? '只对中文 JD' : '全部'}），你点「用这版」才会用` : '打开后给已批准的岗位做定制版，每一行都能指回原文', href: '#materials', tag: tl.enabled ? '开' : '关', tone: tl.enabled ? 'ok' : 'mute' }, ...(R['tailor-resumes'] ? [stageRow(R['tailor-resumes'], prog.at, now)] : [])], { empty: '' });
  }

  if (key === 'quill') {
    sections.push({ key: 'followups', title: '起草跟进', rows: asks.filter(a => a.type === 'followup').map(a => ({ a: a.title, label: a.lead ? leadLabel(a.lead) : a.title, rid: a.lead?.record_id || null, b: a.question, followup: a.id, option: a.options?.find(o => o.label === '跟进一次')?.key, ask: a.id })), empty: '没有待跟进的岗位' });
    const rows = x.deliveries, s = deliverySummary(rows, now);
    const drow = d => ({ a: `${d.number != null ? '#' + d.number + ' ' : ''}${d.company}`, label: d.label, b: `${d.channel}${d.purpose ? ' · ' + d.purpose : ''}${d.subject ? ' · ' + d.subject : ''}`, d: d.note || '', tag: d.group === 'done' ? d.reply?.text || d.status : d.status, tone: d.group === 'done' ? d.reply?.tone || 'ok' : d.tone, c: d.group === 'done' ? d.sent : d.when, rid: d.rid, ask: d.ask });
    const moving = rows.filter(d => d.group === 'moving' && !CLOSED.has(leadState(leadOf(d.rid) || {}))).map(d => T(d.at) && now - T(d.at) > DAY ? { ...d, status: `${d.status}，已经 ${Math.floor((now - T(d.at)) / DAY)} 天没有推进`, tone: 'wait', note: '还没有新的处理记录', ask: d.ask || asks.find(a => a.lead?.record_id === d.rid)?.id || null } : d);
    L(`在路上（${moving.length}）`, moving.map(drow), { note: '已批准的发送和自动预填，包含尚未开始的项', empty: '现在没有待发送或预填的' });
    const sentToday = rows.filter(d => d.group === 'done' && dayOf(d.sent_at) === today);
    L(`今天发出的（${sentToday.length}）`, sentToday.map(drow), { note: `近 7 天 ${s.week} 次、一共 ${s.total} 次；联系过 ${s.leads} 家，有回复 ${s.replied} 家${s.reply_rate != null ? `（${s.reply_rate}%）` : ''}`, empty: '今天还没发出' });
    const failed = rows.filter(d => d.group === 'failed');
    L(`没发成的（${failed.length}）`, failed.map(drow), { empty: '没有发失败的', more: failed.length - 8 });
    // 联系人：沿用收集和手动添加的资料；只有原记录有身份时才标出来。
    const refs = cachedLines('state/referrers.ndjson').filter(r => r.status !== 'retired');
    const refAttempt = r => rows.filter(d => d.purpose_key === 'referral' && (r.lead_number != null ? d.number === r.lead_number : d.company === r.company)).sort((p, q) => T(q.at) - T(p.at))[0];
    const REF_STATUS = { found: ['已收录', 'work'], drafted: ['已有草稿', 'wait'], contacted: ['联系过了', 'ok'], sent: ['联系过了', 'ok'], replied: ['回复了', 'ok'], skipped: ['跳过了', 'mute'] };
    L(`联系人（${refs.length}）`, [...refs].sort((p, q) => T(q.found_at) - T(p.found_at)).map(r => {
      const att = refAttempt(r);
      const [tag, tone] = att ? [att.group === 'done' ? `请求已发出${att.reply?.text ? '，' + att.reply.text : ''}` : `请求：${att.status}`, att.group === 'done' ? att.reply?.tone || 'ok' : att.tone] : REF_STATUS[r.status] || ['已收录', 'work'];
      const url = /^https?:\/\//.test(r.contact_url || r.post_url || '') ? r.contact_url || r.post_url : null;
      const lead = leadOf(null, r.lead_number);
      return { a: `${r.author || '联系人'}${r.company ? `（${coName(r.company)}）` : ''}`, b: cut(contactRole(r), 60), d: [r.email, r.source ? `来源：${r.source === 'manual' ? '手动添加' : r.source}` : '', lead ? `对应 ${leadLabel(lead)}` : r.lead_number != null ? `对应 #${r.lead_number}` : ''].filter(Boolean).join(' · '), rid: lead ? ridOf(lead) : null, tag, tone, c: ago(r.found_at, now), ask: att?.ask || null, link: url ? { url, label: r.contact_url ? '主页' : '原帖' } : null };
    }), { empty: '还没有联系人', more: refs.length - 8 });
  }

  if (key === 'owl') {
    const F = center.followup || {};
    const ivs = (F.interviews || []).filter(i => i.upcoming || (!i.completed && within(i.at, 3 * DAY, now)));
    const shown = new Set(ivs.map(i => i.record_id));
    const past = x.entries.filter(e => (e.l.interview_dossier?.url || dossierFor(e.rid)) && !shown.has(e.rid)).sort((a, b) => T(b.l.interview_at) - T(a.l.interview_at));
    const guide = center.interview_guide?.url ? [{ a: '通用面试手册', b: cut(center.interview_guide.title || '自我介绍、项目讲法、常见问题', 60), link: { url: center.interview_guide.url, label: '打开' } }] : [];
    L(`面试准备（${ivs.length} 场在约）`, [
      ...ivs.map(i => ({ a: `${i.number != null ? '#' + i.number + ' ' : ''}${i.company || ''}`, label: labelOf(i.record_id, i.number), b: `${cut(i.role, 40)} · ${cut(i.round || '面试', 20)}`, ...(dossierFor(i.record_id) ? { d: `面试资料：${PHASE_WORD[dossierFor(i.record_id).phase] || '有了'}` } : {}), tag: i.upcoming ? whenText(i.at, now) : '时间过了，没记结果', tone: i.upcoming ? 'wait' : 'bad', rid: i.record_id, ask: asks.find(a => a.type === 'interview' && a.lead?.record_id === i.record_id)?.id || null, link: i.dossier_url ? { url: i.dossier_url, label: '准备文档' } : null })),
      ...guide,
      ...past.slice(0, 6).map(e => leadLine(e.l, { b: `以前的面试资料${e.l.interview_round ? ' · 已结束的轮次：' + cut(e.l.interview_round.replace(/^下一轮[：:]?\s*/, ''), 20) : ''}`, tag: e.stage === 'offer' ? 'Offer' : e.stage === 'closed' ? '结束了' : '面过了', tone: e.stage === 'offer' ? 'ok' : 'mute', link: /^https?:\/\//.test(e.l.interview_dossier?.url || dossierFor(e.rid)?.url || '') ? { url: e.l.interview_dossier?.url || dossierFor(e.rid)?.url, label: '准备文档' } : null })),
    ], { empty: '没有安排中的面试' });
    const replied = x.entries.filter(e => within(e.l.replied_at, 14 * DAY, now)).sort((a, b) => T(b.l.replied_at) - T(a.l.replied_at));
    const seen = new Set(replied.map(e => e.rid));
    const mail = [...x.ctx.replies.values()].flat().filter(ev => within(ev.at, 14 * DAY, now) && !seen.has(ev.record_id)).sort((a, b) => T(b.at) - T(a.at));
    const STAGE_TAG = { offer: ['Offer', 'ok'], interview: ['约了面试', 'ok'], closed: ['结束了', 'mute'], replied: ['等你回', 'wait'] };
    L('最近 14 天的回复', [...replied.map(e => { const [tag, tone] = STAGE_TAG[e.stage] || ['回复了', 'ok']; return leadLine(e.l, { b: cut(plainText(e.l.reply_summary) || e.l.role, 80), tag, tone, c: whenText(e.l.replied_at, now), ask: x.ctx.askFor(e.rid) }); }), ...mail.map(ev => { const l = x.ctx.byId.get(ev.record_id) || {}; return { a: `${l.number != null ? '#' + l.number + ' ' : ''}${l.company || ev.company || ''}`, label: l.company ? leadLabel(l) : null, b: cut(plainText(ev.summary || ev.subject), 80), tag: MAIL_CATEGORY[ev.category] || cut(ev.category, 8), tone: /拒绝/.test(ev.category) ? 'mute' : 'ok', c: whenText(ev.at, now), rid: ev.record_id }; })], { empty: '最近两周没有回复' });
    const mp = (center.schedule?.items || []).find(i => i.kind === 'mailpoll');
    const facts = center.roles?.owl?.facts || {};
    const pollRows = [];
    // App 里查信不排（lib/command-center.mjs appScheduleView 的 off）：照实写，不写「今天还没巡检」「正常」。
    if (mp?.off) pollRows.push({ a: '收件箱巡检', b: mp.schedule || '', tag: '不跑', tone: 'mute' });
    else if (mp) pollRows.push({ a: '收件箱巡检', b: `${mp.schedule || ''}${mp.last_finished_at ? ` · 上次 ${whenText(mp.last_finished_at, now)}${mp.last_exit ? '，出错了' : ''}` : ' · 今天还没巡检'}`, tag: mp.last_exit ? '上次出错' : mp.active_window === false ? '下班时间' : '正常', tone: mp.last_exit ? 'bad' : 'ok', c: nextText(mp.next_at, now) });
    const siteRows = [];
    for (const s of facts.watch_sites || []) siteRows.push({ a: `${s.site} 招聘站`, b: `${s.status === 'checked' ? '看过了' : plainReason(s.error || s.reason, 100) || '这次没查成，没记下原因'}${s.scanned != null ? `，扫了 ${s.scanned} 个岗位` : ''}`, tag: s.status === 'checked' ? '正常' : '有问题', tone: s.status === 'checked' ? 'ok' : 'bad', c: s.checked_at ? ago(s.checked_at, now) : '' });
    L('邮箱巡检', pollRows, { empty: '' });
    if (siteRows.length) sections.push({ key: 'site_patrol', title: '招聘源巡检', rows: siteRows });
    L('最近收到的邮件', (F.inbox || []).slice(0, 8).map(ev => ({ a: MAIL_CATEGORY[ev.category] || cut(ev.category, 8) || '邮件', label: ev.record_id ? labelOf(ev.record_id) : null, b: cut(ev.subject || ev.summary, 70), d: ev.subject ? cut(/验证码|code/i.test(ev.category || '') ? String(ev.summary || '').replace(/\d{4,8}/g, '••••') : ev.summary, 90) : '', c: whenText(ev.at, now), rid: ev.record_id || null })), { note: '你的反馈邮件不在这里', empty: '最近没有新邮件' });
  }

  if (key === 'patch') {
    const items = center.schedule?.items || [];
    L('接下来', items.map(i => { const failed = i.last_result?.state === 'failed' || i.last_exit; const unknown = i.last_result?.state === 'unknown'; return ({ a: SCHEDULE_TITLE[i.kind] || plainText(i.title), b: i.schedule || '', d: i.facts_held && i.last_finished_at ? `上次 ${whenText(i.last_finished_at, now)}：资料挡住，这一轮没跑` : i.last_finished_at ? `上次 ${whenText(i.last_finished_at, now)}：${failed ? '有步骤没做成' + (i.last_result?.reason ? '，' + plainReason(i.last_result.reason, 180) : '') : unknown ? '已结束，未记录工作结果' : i.last_result?.summary || '跑完了'}` : i.last_started_at ? `上次 ${whenText(i.last_started_at, now)} 开始` : '', tag: i.running ? '在跑' : i.off ? '不跑' : i.loaded === false ? '没加载' : i.facts_held ? '没跑' : failed ? '上次出错' : unknown ? '结果待核' : i.last_result?.partial ? '部分完成' : '正常', tone: i.running ? 'work' : i.off ? 'mute' : i.loaded === false ? 'bad' : i.facts_held ? 'wait' : failed ? 'bad' : unknown || i.last_result?.partial ? 'wait' : 'ok', c: nextText(i.next_at, now) }); }), { note: '定时任务', empty: '没有定时任务' });
    // 没变化、也没出错的步骤并成一行，只把做了事或出了错的列出来。
    const scheduled = items.find(i => i.kind === 'cycle')?.last_result;
    const cycleResults = scheduled ? scheduled.results : prog.results || [];
    const cycleAt = scheduled?.at || prog.at;
    const quiet = cycleResults.filter(r => ['no_change', 'skipped', 'skip'].includes(r.status) && !(r.errors || []).length && !r.error);
    L('上一轮各步骤的结果', [...cycleResults.filter(r => !quiet.includes(r)).map(r => stageRow(r, null, now)), ...(quiet.length ? [{ a: `另外 ${quiet.length} 步没有变化`, b: quiet.map(r => stepName(r.stage)).join('、'), tone: 'mute' }] : [])], { note: cycleAt ? scheduled ? `定时这一轮 ${whenText(cycleAt, now)} 结束` : `这一轮 ${whenText(cycleAt, now)} 跑完` : '', empty: '还没有周期记录' });
    const Rp = center.repairs || {};
    L('自动修复', (Rp.rows || []).slice(0, 8).map(r => { return { a: plainMsg(r.label, 60), b: plainReason(r.required_action || r.result, 90), ...hostChip(r), c: ago(r.completed_at || r.created_at, now), ask: r.status === 'waiting_user' ? askForJob(asks, r.id) : null }; }), { note: Rp.config ? `流程之外卡住的，自动交给这台电脑修；每小时最多 ${Rp.config.per_hour ?? 2} 条，今天修好 ${Rp.completed_today ?? 0} 条` : '', empty: '没有修复记录' });
    // 告警：全都列在 System 名下（10-04：别的成员的不挡路的告警也在这里，能点「不用管这条」）；不是 System 自己的，前面写是谁的。
    const alerts = center.alerts || [], whoOf = a => crewOf(a.source, { step: a.step, fallback: 'patch' });
    const alertRow = a => ({ a: a.recovered_at ? '已恢复' : a.level_label || (a.level === 'error' ? '严重' : a.level === 'warn' ? '警告' : '提示'), b: (m => whoOf(a) === 'patch' || m.startsWith(crewName(whoOf(a))) ? m : `${crewName(whoOf(a))}：${m}`)(plainMsg(a.msg, 140)), d: a.recovered_at ? '' : a.impact || '', tone: a.recovered_at ? 'mute' : a.level === 'error' ? 'bad' : a.level === 'warn' ? 'wait' : 'mute', c: a.at ? ago(a.at, now) : '', ...(a.recovered_at ? {} : { fix: a.fix || null, dismiss: a.dismissible && a.key ? a.key : null }) });
    const open = alerts.filter(a => !a.recovered_at), healed = alerts.filter(a => a.recovered_at);
    L(`告警（${open.length}）`, [...open, ...healed.slice(0, 5)].map(alertRow), { note: healed.length ? `另有 ${healed.length} 条已经恢复` : '', empty: '没有告警' });
    const f = center.roles?.patch?.facts || {};
    // 站点登录：收件箱的「账号」标签管（登录、我登好了）；这里只数一数，点过去处理。
    const accts = (inbox.accounts || []).filter(a => a.kind !== 'service');
    const out = accts.filter(a => a.logged_in === false), blocking = accts.reduce((n, a) => n + (a.waiting || 0), 0);
    L('服务和账号', [
      // 和收件箱「账号」、设置 · 账号与连接同一张表（lib/accounts.mjs accountTable）：没核实过的也写出来，三个数加起来就是表上的行数。
      { a: '网站账号', b: `${accts.filter(a => a.logged_in === true).length} 个已登录、${out.length} 个没登录${(n => n ? `、${n} 个还没核实` : '')(accts.filter(a => a.logged_in == null).length)}${blocking ? `，没登录的挡住了 ${blocking} 项` : ''}${out.length ? `（${cut(out.map(a => a.label).join('、'), 40)}）` : ''}`, tag: blocking ? '等你登录' : '正常', tone: blocking ? 'wait' : 'ok', inbox: 'accounts' },
      ...(f.quiet_hours ? [{ a: '夜间监听', b: '现在不看各平台的消息、不提醒你；你批准的发送照常处理' }] : []),
    ]);
      // 执行器（大家共用的手）：它自己的运行、心跳、原始日志；开关在 Patch 的 ⋯ 里（state/agent-pause.json 的 executor）。
    const E = center.executor || {}, rn = E.run_now || {}, J = E.host_jobs || {};
    const q = s => plainMsg(String(s || '').replace(/^\[[^\]]+\]\s*/, ''), 90);
    const busy = rn.running || rn.pending;
    // 桌面版本机 AI 没打开（lib/command-center.mjs executorView 的 blocked）：排着的不会被拉起，照实写，带直达开关的链接。
    const held = rn.blocked && rn.pending && !rn.running;
    const nowRows = [held ? { a: '没在做', b: rn.blocked.text, tag: '排着', tone: 'wait', href: rn.blocked.go } : { a: rn.running ? '正在做' : rn.pending ? '马上开始' : '空闲', b: rn.running ? `${clock(rn.running_since)} 开始${rn.stale ? '，超过 30 分钟了，可能卡住' : ''}` : rn.last_finished_at ? `上次 ${whenText(rn.last_finished_at, now)} 做完${rn.last_exit === 0 ? '' : '，出错了'}` : '还没跑过', tag: rn.running ? '在做' : rn.pending ? '排队' : rn.last_exit && rn.last_exit !== 0 ? '上次出错' : '空闲', tone: rn.running ? 'work' : rn.last_exit && rn.last_exit !== 0 ? 'bad' : 'ok' }, ...(held ? rn.reasons || [] : busy ? rn.queue || [] : []).map(r => ({ a: rn.running ? '这次在做' : held ? '排着' : '马上开始', b: q(r.reason), tag: rn.running ? '在做' : '排队', tone: held ? 'wait' : 'work', c: ago(r.at, now) }))];
    let last = null; try { last = JSON.parse(rn.last_result || 'null'); } catch {} // 兜底：上一次的结果不是 JSON 就当没有
    if (last && typeof last === 'object') nowRows.push({ a: '上次结果', b: `处理任务 ${last.jobs_processed ?? 0} 件、${applyWord()} ${last.auto_applied ?? 0}、回复 ${last.replies ?? 0}、卡住 ${last.blocked ?? 0}` });
    else if (hasText(rn.last_result)) nowRows.push({ a: '上次结果', b: plainReason(rn.last_result, 120) });
    L('这台电脑：现在', nowRows, { note: '团队交给这台电脑的事记在交代的那位名下，这里只看它自己跑得好不好' });
    const jrow = j => ({ a: jobTitle(j), label: labelOf(j.record_id, j.number), b: plainReason(j.required_action || j.result || j.details, 140), ...hostChip(j), c: ago(j.completed_at || j.created_at, now), rid: (leadOf(j.record_id, j.number) ? ridOf(leadOf(j.record_id, j.number)) : null), ask: ['waiting_user', 'blocked'].includes(j.status) ? askForJob(asks, j.id) : null });
    // 心跳（state/executor-heartbeat.json）：每个后台任务停在哪一步，太久没动的标出来。
    const beats = (E.heartbeat?.tasks || []).slice(0, 8);
    L('这台电脑：后台任务心跳', beats.map(t => ({ a: `${HEARTBEAT_WHO[t.executor] || '后台任务'}${/^\d+$/.test(t.task) ? ' · #' + t.task : /^[\x00-\x7f]*$/.test(String(t.task || '')) ? '' : ' · ' + cut(t.task, 20)}`, b: plainReason(t.detail, 90) || '没有细节', d: t.stuck ? `已经 ${t.idle_minutes ?? '好久'} 分钟没动了` : '', ...jobChip(t.blocked_at ? 'blocked' : t.status || 'running'), c: ago(t.updated_at, now) })), { empty: '没有后台任务在跑' });
    // 原始运行日志：排查时才看，折叠显示。
    if (hasText(rn.log)) L('这台电脑：原始日志（最后 20 行，排查用）', [], { log: String(rn.log).split('\n').filter(Boolean).slice(-20).join('\n'), empty: '' });

  }

  // 请执行器做的事（lib/crew.mjs JOB_MEMBER：这位请它做的那几类）：等你的、卡住的、在做和排队的、今天做完的。
  const myJobs = jobsOf(key, cachedLines('state/host-jobs.ndjson')), ORDER = { waiting_user: 0, blocked: 1, working: 2, pending: 3 };
  const jrow = j => ({ a: jobTitle(j), label: labelOf(j.record_id, j.number), b: plainReason(j.required_action || j.result || j.details, 140), ...hostChip(j), c: ago(j.completed_at || j.updated_at || j.created_at, now), rid: (leadOf(j.record_id, j.number) ? ridOf(leadOf(j.record_id, j.number)) : null), ask: ['waiting_user', 'blocked'].includes(j.status) ? askForJob(asks, j.id) : null });
  // 你交代的事（下面单列一节）不在这里再列一遍。
  const askedIds = new Set((inbox.inflight || []).filter(i => i.kind === 'job' && i.member === key).map(i => String(i.id || '')));
  const openJobs = myJobs.filter(j => OPEN_JOB.includes(j.status) && !askedIds.has(`job:${j.id}`)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || T(b.updated_at || b.created_at) - T(a.updated_at || a.created_at));
  const doneJobs = myJobs.filter(j => ['completed', 'done'].includes(j.status) && dayOf(j.completed_at) === today && !askedIds.has(`job:${j.id}`)).sort((a, b) => T(b.completed_at) - T(a.completed_at));
  const jobsNote = key === 'patch' ? '自动修复也在这里；这台电脑自己跑得怎样见下面「这台电脑」几节' : `这台电脑替 ${crewName(key)} 开浏览器、上网查的事`;
  if (openJobs.length || doneJobs.length || key !== 'tailor') L(`交给这台电脑的（${openJobs.length} 件没做完）`, [...openJobs.slice(0, 10), ...doneJobs.slice(0, 5)].map(j => ({ ...jrow(j), ...(j.completed_at ? { c: clock(j.completed_at) } : {}) })), { note: jobsNote, empty: '现在没有交给这台电脑的事', more: openJobs.length - 10 });
  const asked = (inbox.inflight || []).filter(i => i.kind === 'job' && i.member === key);
  if (asked.length) L(`你交代的事（${asked.length}）`, asked.map(i => ({ a: `${i.number != null ? '#' + i.number + ' ' : ''}${i.company || ''}`.trim() || '交办任务', label: i.label || labelOf(i.record_id, i.number), b: i.what, d: i.stage, tag: wordOf(STATE_OF_TONE[i.tone]), tone: i.tone, c: ago(i.at, now), rid: i.record_id || null, ask: i.ask })), { note: '最近三天你交代、或答复过的' });

  // 给你的信（算在这位名下的，lib/hq.mjs memberOf）→ 点开进收件箱那一封。
  const mine = lettersBy(inbox, cachedLines('state/host-jobs.ndjson'))(key), triageN = key === 'lens' ? (tally?.leads ? tally.leads.new + tally.leads.verify : asks.filter(a => a.type === 'triage').length) : 0;
  const letters = mine.slice(0, 6).map(a => ({ id: a.id, type: inbox.types?.[a.type]?.label || '', title: cut(a.title, 50), label: a.lead?.record_id ? labelOf(a.lead.record_id, a.lead.number) : null, question: cut(plainText(a.question), 120) }));
  const evs = eventsFor(key, events || tailEvents(4000), roleOf, now);
  const alerts = key === 'patch' ? [] : (center.alerts || []).filter(a => crewOf(a.source, { step: a.step, fallback: 'patch' }) === key).map(a => ({ level: a.recovered_at ? '已恢复' : a.level_label || '提醒', tone: a.recovered_at ? 'mute' : a.level === 'error' ? 'bad' : a.level === 'warn' ? 'wait' : 'mute', msg: plainMsg(a.msg, 140), at: a.at || null, ago: a.at ? ago(a.at, now) : '', fix: a.recovered_at ? null : a.fix || null, key: a.dismissible ? a.key || null : null }));
  const opsDone = Object.entries(OPS).filter(([, o]) => o.role === key).map(([k, o]) => { const last = (center.ops?.history || []).find(h => h.op === k); return last ? { label: o.label, status: wordOf(fromLegacy(last.status) || 'failed'), at: last.finished_at || last.started_at, ago: ago(last.finished_at || last.started_at, now) } : null; }).filter(Boolean);
  return { key, name: w.name, face: w.face, duty: w.duty, state: card.state || 'idle', now: card.now || '', stats: card.stats || [], sections, letters, letters_total: mine.length, triage_total: triageN, alerts, events: evs, ops: opsDone, progress_at: center.progress?.at || null };
}
