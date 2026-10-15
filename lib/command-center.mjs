import { sourceLabel } from './workflow.mjs';
import { screening, levelText } from './screening.mjs';
import { previousContact } from './recipient-contact.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { computerUseConfig, computerUseGate, computerUseDriverLabel } from './computer-use.mjs';
import { delivered } from './delivery.mjs';
// 指挥台：把 state/、runs/、config/、candidate/ 里散落的运行事实聚合成一个视图，
// 并给操作台提供与飞书指挥室完全相同的指令入口。
//
// 这里只读事实、只排队动作：不发消息、不发邮件、不提交表单。每个按钮背后都是
// 已有的 bin/ 入口（action / queue-apply / flashcard / resume-executor）或即时执行器
// （state/run-now.json 去抖后由 bin/host/run-now.sh 拉起），授权规则原样生效。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from './spawn.mjs';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { file, read } from './store.mjs';
import { cachedLines, memoize } from './state-cache.mjs';
import { tailEvents, boardStage, stages as BOARD_STAGES } from './dashboard.mjs';
import { currentJourney } from './journey.mjs';
import { waitingText } from './journey.mjs';
import { PATH as HEARTBEAT_PATH, STUCK_MS, needsUserLabel } from './executor-heartbeat.mjs';
import { PERSONAS, personaForKind } from './personas.mjs';
import { leadCity, relocationCity, primaryCity } from './city.mjs';
import { applyWord, applyUrl, applyChannel, unifyChannel, portalSession, loadPortalSessions, autoApplyReady } from './apply-channel.mjs';
import { prefilter } from './matcher.mjs';
import { sprintHold, citySprint } from './city-sprint.mjs';
import { applyFreeze } from './apply-freeze.mjs';
import { applicationPlan, planRows } from './application-form.mjs';
import { leadState, viewState, stateLabel, stateGroup, endedLead, appliedLead, decidedLead, stageText, feedbackText } from './lead-state.mjs';
import { watchDigest } from './watch.mjs';
import { STATE_PATH as RUN_NOW_PATH, STALE_RUN_MS } from './run-now.mjs';
import { topPicks, pickScore } from './top-picks.mjs';
import { noteSwallowed } from './swallow.mjs';
import { loginNeeded } from './accounts.mjs';
import { sourceState } from './discovery-source.mjs';
import { settingsView, stackSummary, stackHeadline } from './settings.mjs';
import { notFailure, laterSuccess, finishAlerts } from './alert-rules.mjs';
import { view, legacyChip } from './status.mjs';
import { memoryStats, listNotes } from './memory.mjs';
import { roleSummary } from './roles.mjs';
import { systemPrompt, opsForPrompt } from './chat.mjs';
import { TZ, zonedTime, dayOf } from './tz.mjs';
import { CREW_IDS, MEMBERS, LEGACY, isMember, crewOf, crewName, crewMember, memberOfEvent, stageMembers } from './crew.mjs';
import { materialsCount } from './resume-store.mjs';
import { localAiGate, heldText } from './capabilities.mjs';
import { heldRec, judgedFully, approvalBlocker } from './recommend-gate.mjs';
import * as J from './jobs.mjs';
import { leadApplyWords } from './apply-words.mjs';
import { plainText } from './jargon.mjs';
import { scheduleView } from './schedule-status.mjs';
import { opsStatus } from './ops.mjs';
import { OPS, OPS_PATH } from './ops-table.mjs';
import { requiredUserAction, dismissKey, dismissed, sameTarget } from './dispatch.mjs';
import { latestHostJobs, autoRepairConfig, AUTO_REPAIRED } from './system/repair.mjs';
import { judgeAvailable } from './judge.mjs';
import { VERDICT_WORD, verdictOf, verdictWord } from './vocab.mjs';

const execFileP = promisify(execFile);
const DAY = 86400000;
// 格式化器只建一次：每次 new Intl.DateTimeFormat 约 30 µs，一次指挥台刷新要按日期分一万多次。
export { dayOf };
const iso = x => new Date(x).toISOString();
const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const systemJobResult = j => ({ id: j.id, status: j.status, kind: j.kind, label: j.target?.label || j.details || j.instructions || j.kind,
  result: String(j.result || j.error || ''), details: String(j.details || j.instructions || ''), required_action: requiredUserAction(j),
  evidence: Array.isArray(j.evidence) ? j.evidence : j.evidence ? [j.evidence] : [], user_feedback: j.user_feedback || [], at: j.completed_at || j.created_at || null });
export function hostJobView(id) {
  const job = cachedLines('state/host-jobs.ndjson').findLast(j => j.id === id);
  if (!job) throw Error('没有这条宿主任务');
  return systemJobResult(job);
}
const leadKey = l => l.record_id || l.id;
const label = l => `${l.number ?? '待编号'} · ${l.company || '待核'} · ${l.role || ''}`;
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const settled = l => endedLead(l);
const isHuman = l => l.human === true || /真人|内推|HR直发/.test(l.source_type || '');

// ── 归属：事件 → 成员（lib/crew.mjs 的名册，老的 actor / 步骤名在那里换）──────────
// 周期任务的事件 actor 还是 heartbeat / postman / nightwatch 这些旧名字，按步骤归到 6 位成员；你自己的动作是 you。
export const roleOf = e => (e.step === 'cycle' && J.forRun(e.run_id)?.member) || memberOfEvent(e);
// 一步归两位的（prepare-interviews），运行记录和告警记在第一位名下。
const stageMember = stage => stageMembers(stage)[0] || 'patch';
const STAGE_NUMBERS = ['raw', 'eligible', 'added', 'verified', 'judged', 'recommended', 'verify', 'excluded', 'calls', 'matched', 'applied', 'sent', 'submitted', 'prepared', 'rows', 'found', 'drafts', 'messages', 'tasks', 'updates', 'processed'];
function stageSummary(r = {}) {
  const parts = STAGE_NUMBERS.filter(k => typeof r[k] === 'number').map(k => `${k} ${r[k]}`);
  if (Array.isArray(r.sources)) parts.push(`来源 ${r.sources.length}`);
  return parts.join(' · ');
}

// ── 事件 ─────────────────────────────────────────────────────────────────────
function recentEvents(limit = 4000) {
  return tailEvents(limit).filter(e => e.step !== 'heartbeat').sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}
export function roleActivity(member, events, now = Date.now()) {
  // 本地工作台自己启动 / 停止的记录（step web）不算哪位成员的工作。
  const es = events.filter(e => roleOf(e) === member && e.step !== 'web');
  const today = dayOf(now);
  // 开始了、90 分钟内、同一 run 的同一步骤后面没有结束事件：还在跑。
  const running = es.find(e => e.status === 'start' && now - Date.parse(e.ts) < 90 * 60000 && !es.some(x => x.run_id === e.run_id && x.step === e.step && x.status !== 'start' && x.ts > e.ts));
  const last = es.find(e => e.status !== 'start');
  const fails = es.filter(e => e.status === 'fail' && dayOf(e.ts) === today);
  return {
    status: running ? 'running' : last?.status === 'fail' ? 'fail' : last?.status === 'waiting_user' ? 'waiting' : last ? 'ok' : 'idle',
    running: running ? { ts: running.ts, step: running.step, msg: running.msg, run_id: running.run_id } : null,
    last: last ? { ts: last.ts, step: last.step, status: last.status, msg: last.msg, duration_ms: last.duration_ms ?? null } : null,
    fails_today: fails.length,
    recent: es.slice(0, 8).map(e => ({ ts: e.ts, step: e.step, status: e.status, msg: short(e.msg, 140), refs: (e.refs || []).slice(0, 2), lead_id: e.lead_id || null })),
  };
}

// ── 执行器：即时执行器、心跳、宿主任务 ──────────────────────────────────────
function latestFile(sub, re, now = Date.now(), days = 2) {
  for (let d = 0; d < days; d++) {
    const day = dayOf(now - d * DAY).replaceAll('-', '');
    const dir = file(`runs/${day}/${sub}`);
    if (!fs.existsSync(dir)) continue;
    const names = fs.readdirSync(dir).filter(n => re.test(n)).sort();
    if (names.length) return `runs/${day}/${sub}/${names.at(-1)}`;
  }
  return null;
}
function tailText(ref, bytes = 1600) {
  if (!ref) return null;
  try { const t = fs.readFileSync(file(ref), 'utf8'); return t.length > bytes ? '…' + t.slice(-bytes) : t; } catch { return null; } /* 兜底：日志文件还没有或刚被轮换：就是没有尾巴可看 */
}
export function executorView({ now = Date.now() } = {}) {
  const rn = read(RUN_NOW_PATH, {});
  const runningStale = !!rn.running && now - Date.parse(rn.running_since || 0) >= STALE_RUN_MS;
  const runLog = latestFile('run-now', /^run\.log$/, now);
  const lastResult = latestFile('run-now', /^last-.*\.md$/, now);
  const hb = read(HEARTBEAT_PATH, { tasks: {} });
  const tasks = Object.entries(hb.tasks || {}).map(([key, t]) => {
    const idleMs = now - Date.parse(t.updated_at || t.started_at || 0);
    const needs = needsUserLabel(t.step);
    return { key, executor: t.executor, task: String(t.task), step: t.step || null, detail: t.detail || '', status: t.status || 'working', started_at: t.started_at || null, updated_at: t.updated_at || null, idle_minutes: Math.max(0, Math.round(idleMs / 60000)), blocked_at: t.blocked_at || null, blocked_reason: t.blocked_reason || null, alert_message_id: t.alert_message_id || null, needs_user: needs, stuck: !needs && t.status !== 'done' && t.status !== 'failed' && idleMs >= STUCK_MS, resumable: t.executor === 'auto-apply' && !!t.blocked_at && !!t.alert_message_id };
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  // needs / record_id / updated_at / resume_condition / blocked_reason travel with the job: the inbox builds its letters
  // from these fields (lib/asks.mjs); without them every structured need fell back to the free-text guesses.
  const jobs = latestHostJobs().map(j => ({ id: j.id, kind: j.kind, status: j.status, number: j.number ?? null, record_id: j.record_id || null, company: j.company || null, created_at: j.created_at || null, updated_at: j.updated_at || null, completed_at: j.completed_at || null, target: j.target || null, ...systemJobResult(j), source: j.source || null, needs: j.needs || [], resume_condition: j.resume_condition || null, blocked_reason: j.blocked_reason || null }));
  const byStatus = s => jobs.filter(j => j.status === s).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return {
    // 桌面版本机 AI 没打开：排着的不会被拉起（bin/serve.mjs → lib/run-now.mjs runNowLaunch），团队页照实写，带直达开关的链接。
    run_now: { blocked: (g => g.allowed ? null : { text: heldText(g), go: g.go })(localAiGate()), pending: !!rn.pending, running: !!rn.running, stale: runningStale, running_since: rn.running_since || null, requested_at: rn.requested_at || null, last_run_at: rn.last_run_at || null, last_finished_at: rn.last_finished_at || null, last_exit: rn.last_exit ?? null, last_error: rn.last_error || null, reasons: (rn.reasons || []).slice(-10), queue: (rn.queue || []).slice(-10), due_in_s: rn.pending && rn.requested_at ? Math.max(0, Math.round((Date.parse(rn.requested_at) + 60000 - now) / 1000)) : null, log: tailText(runLog, 900), log_ref: runLog, last_result: tailText(lastResult, 1400), last_result_ref: lastResult },
    heartbeat: { checked_at: hb.checked_at || null, tasks },
    host_jobs: { pending: byStatus('pending'), working: byStatus('working'), waiting_user: byStatus('waiting_user'), blocked: byStatus('blocked'), completed_today: jobs.filter(j => j.status === 'completed' && dayOf(j.completed_at) === dayOf(now)).length, total: jobs.length },
    host: (() => { const h = read('config/host.json', {}); return { executor: h.executor || 'codex', models: h.models || [], codex_chain: (h.codex_models?.chain || []).map(c => `${c.provider}/${c.model}`), fallback: h.codex_models?.fallback ? `${h.codex_models.fallback.provider}/${h.codex_models.fallback.model}` : null, run_host: h.run_host || null }; })(),
  };
}

// ── 等我处理 ─────────────────────────────────────────────────────────────────
const KIND_LABEL = { send: '审核并发送', submit: '需本人提交', reply: '决定如何回复', schedule: '安排面试时间', attend: '参加面试', clarify: '补充一项信息', followup: '是否跟进', review: '面试复盘', dossier: '面试准备材料', decide: '是否争取', get auto_apply() { return `${applyWord()}（系统在做）`; }, screen: '待你筛选' };
const KIND_ORDER = Object.keys(KIND_LABEL);
export function todoView({ journey = currentJourney(), now = Date.now(), leads = [] } = {}) {
  const live = journey.actions.filter(a => !a.paused && !(Date.parse(a.snooze_until || '') > now));
  const groups = KIND_ORDER.map(kind => {
    const items = live.filter(a => a.kind === kind);
    return { kind, label: KIND_LABEL[kind], persona: personaForKind(kind), count: items.length, system: kind === 'auto_apply', items: items.slice(0, 200).map(a => ({ id: a.id, record_id: a.record_id, number: a.number, company: a.company, role: a.role, title: a.title, detail: short(a.detail, 200), due_at: a.due_at || null, url: a.url || null, draft_id: a.draft_id || null, channel: a.channel || null, priority: a.priority ?? 0, body: a.body || null, attachments: a.attachments || [], awaiting_batch_review: !!a.awaiting_batch_review, attempts: a.attempts ?? null })) };
  }).filter(g => g.count);
  const byId = new Map(leads.map(l => [leadKey(l), l]));
  const nameOf = id => { const l = byId.get(id); return l ? label(l) : id; };
  const snoozed = journey.actions.filter(a => a.paused || Date.parse(a.snooze_until || '') > now).length;
  const flash = read('state/flashcard-session.json', {});
  const draftsById = new Map(cachedLines('state/drafts.ndjson').map(d => [d.draft_id, d]));
  const sendRequests = cachedLines('state/send-requests.ndjson');
  const outbound = cachedLines('state/outbound.ndjson');
  const sending = sendRequests.filter(r => ['queued', 'dispatched', 'needs_review', 'failed', 'uncertain'].includes(r.status));
  const answered = Array.isArray(flash.answered) ? flash.answered.length : Array.isArray(flash.processed) ? flash.processed.length : typeof flash.processed === 'number' ? flash.processed : Object.keys(flash.answers || {}).length;
  return {
    groups, total_user: live.filter(a => a.kind !== 'auto_apply').length, snoozed,
    sending: sending.map(r => {
      const d = draftsById.get(r.draft_id) || {}, l = byId.get(r.record_id || d.record_id) || {};
      return { id: r.id, number: l.number ?? d.number, company: l.company || d.company, role: l.role, draft_id: r.draft_id, record_id: r.record_id || d.record_id, status: r.status, at: r.checked_at || r.at, subject: d.subject, evidence: r.evidence || null,
        detail: r.result || r.error || (r.status === 'queued' ? '发送授权已保存，等待本机 AI 处理；尚未确认发出，无需再次授权。' : r.status === 'dispatched' ? '本机 AI 已接手，正在发送或核对结果；以发送回执为准，无需重复操作。' : '发送未确认成功，需要核对执行结果后决定下一步。') };
    }),
    send_proposal: (read('state/send-proposal.json', {}).rows || []).filter(r => {
      const d = draftsById.get(r.draft_id), l = byId.get(r.record_id || d?.record_id);
      return d?.status === 'ready' && !previousContact(d, [...draftsById.values()]) && !excludedCompany(l || {}) && !settled(l || {}) && !l?.superseded &&
        !sendRequests.some(q => q.draft_id === r.draft_id && ['queued', 'dispatched', 'sent', 'needs_review', 'uncertain'].includes(q.status)) &&
        !outbound.some(o => o.draft_id === r.draft_id);
    }).map(r => {
      const d = draftsById.get(r.draft_id) || {};
      const l = leads.find(l => leadKey(l) === (r.record_id || d.record_id) || l.number === r.number) || {};
      return { ...r, record_id: r.record_id || d.record_id || leadKey(l), channel_key: unifyChannel({ ...d, ...r }), subject: r.subject || d.subject || '', to: r.to || d.to || '', url: r.url || (/^https?:/.test(d.to || '') ? d.to : applyUrl(l)), first_line: short(r.first_line || d.body, 120) };
    }),
    // 拟投清单是某一轮算好存下的：之后已投、pass、排除、对方回了或在面试的，不再问「投吗？」（和 send_proposal 一样按线索现状过滤）。
    apply_proposal: (read('state/apply-proposal.json', {}).rows || []).filter(r => {
      const l = byId.get(r.record_id) || leads.find(x => r.number != null && x.number === r.number);
      // 推荐闸（lib/recommend-gate.mjs）：排队中的推荐不问；判完了、结论不是推荐（待核 / 没过线 / 排除）的不问「投吗」；没判完的留着，那一封只给「先判断」。
      return !!l && !(settled(l) || excludedCompany(l) || l.superseded || appliedLead(l) || l.interview_at || l.replied_at || ['replied', 'interview_scheduled', 'interview_done'].includes(leadState(l)) ||
        heldRec(l) || (judgedFully(l) && approvalBlocker(l)));
    }).map(r => ({ number: r.number ?? null, record_id: r.record_id, company: r.company, role: r.role, city: r.city, channel: r.channel, channel_key: unifyChannel(r), reason: short(r.reason, 120), url: r.url || null, preference: r.preference ?? null })),
    followups: read('state/followups.json', []).map(f => ({ record_id: f.record_id, summary: f.summary, lead: nameOf(f.record_id) })),
    questions: read('state/questions.json', []),
    uncertain: read('state/feedback-uncertain.json', []).slice(0, 10),
    mail_reconciliation: read('state/mail-reconciliation-pending.json', []).map(nameOf),
    flashcard: flash.id ? { id: flash.id, filter: flash.filter || null, started_at: flash.started_at || null, finished_at: flash.finished_at || null, batch: (flash.batch || []).length, answered, deferred: Array.isArray(flash.deferred) ? flash.deferred.length : 0, active: !flash.finished_at } : null,
  };
}

export function portalSessionsView({ leads = cachedLines('state/leads.ndjson'), sessions = loadPortalSessions() } = {}) {
  const normalize = host => host.toLowerCase().replace(/^www\./, '');
  const hosts = new Set([...Object.keys(sessions.domains || {}), ...(sessions.never_auto || [])].map(normalize));
  const portalLeads = leads.filter(l => applyChannel(l) === 'portal');
  const hostOf = l => { try { return normalize(new URL(applyUrl(l)).hostname); } catch { return ''; } }; /* 兜底：地址不是有效网址：当没有门户，只影响这一行的分组 */
  for (const l of portalLeads) if (hostOf(l)) hosts.add(hostOf(l));
  return [...hosts].sort().map(host => {
    const matching = portalLeads.filter(l => hostOf(l) === host);
    const direct = Object.entries(sessions.domains || {}).find(([key]) => normalize(key) === host)?.[1];
    const session = direct || portalSession({ application_url: `https://${host}` }, sessions) || {};
    const never_auto = (sessions.never_auto || []).some(d => host === normalize(d) || host.endsWith('.' + normalize(d)));
    return { host, label: session.login || '未记录登录态', logged_in: !!session.logged_in, cua_logged_in: !!session.cua_logged_in, cua_verified_at: session.cua_verified_at || null, verified_at: session.verified_at || null, last_probe: session.last_probe || null, never_auto, lead_count: matching.length, url: matching.length ? applyUrl(matching[0]) : `https://${host}/` };
  });
}

export function agentProfile(role = 'system') {
  // 对话的口吻还是飞书卡片的那四个角色（lib/personas.mjs）；成员编号先换成它原来那个角色（lens → radar）。
  // 脚本和模型设置按成员：给的是成员就是它自己的，给的是老角色就是接手它的几位（reacher → Quill、Tailor）。
  const member = isMember(role) ? role : null;
  if (member) role = MEMBERS[member].legacy;
  if (!Object.hasOwn(PERSONAS, role)) throw Error('未知角色');
  const mine = member ? [member] : LEGACY[role]?.pause?.length ? LEGACY[role].pause : ['patch'];
  const { name, emoji, duty } = PERSONAS[role];
  const prompt = systemPrompt(role, { judgeOk: judgeAvailable({ offlineOk: true }) });
  return { persona: { name, emoji, duty }, system_prompt: prompt, grammar: prompt.split('\n').find(line => line.startsWith('指挥室指令语法')) || '', ops: Object.entries(OPS).filter(([, o]) => mine.includes(o.role || 'patch')).map(([key, o]) => ({ key, label: o.label, desc: o.desc })), tools: opsForPrompt(member || role), backends: roleSummary()[mine[0]] || {} };
}

// 「等我处理」的一行 = 一条线索：同一条线索的待办、拟发 / 拟投、阻塞、执行器的问题合成一行，
// 只留一个"卡在哪 / 你要做什么"和一个主动作（以前同一岗位会出现 2–4 次、每行 7–9 个按钮）。
// 已结束（pass / 归档 / 已排除 / 拒绝 / Offer）和用户排除的公司不再出现；资深岗不给「投」。
// 「资深岗」跟着候选人的级别走（lib/screening.mjs）：不到 5 年就是以前这一串；5–8 年只算管理和高管；8 年以上只算高管。
const SENIOR_TITLE = /\b(senior|sr\.?|staff|principal|lead|leader|architect|director|vp|head(?: of)?)\b|资深|高级|专家|架构师|总监|负责人|首席/i;
const SENIOR_TITLE_BY_LEVEL = { early: SENIOR_TITLE, senior: /\b(director|vp|head(?: of)?)\b|总监|负责人|首席/i, staff: /\b(director|vp|head of)\b|总监|首席/i };
// 通用路径（lib/screening.mjs general）用它自己的级别词（这些行业的 VP / 经理 / 主管）。
export const seniorTitle = (l = {}, S = screening()) => (S.general ? S.seniorTitle : SENIOR_TITLE_BY_LEVEL[S.level]).test(levelText(l.applied_role || l.role || '', S)) || S.excludedGrades.includes(l.judgement?.posting?.grade);
const APPLY_KINDS = new Set(['submit', 'apply_proposal', 'auto_apply']);
const INTERVIEW_KINDS = new Set(['reply', 'schedule', 'attend', 'review', 'dossier']);
// 行内排序：谁最能代表"现在卡在哪"。面试相关最急，其次是要你审核发送的，再是登录 / 确认，再是问题。
const KIND_RANK = { attend: 0, schedule: 1, reply: 2, send_proposal: 3, send: 4, blocked: 5, clarify: 6, submit: 7, apply_proposal: 8, followup: 9, review: 10, dossier: 11, decide: 12, screen: 13, auto_apply: 14 };
const oneLine = (t, n = 90) => { const x = plainText(t); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
export function taskQueue(role, { leads = cachedLines('state/leads.ndjson'), todo, blocked, now = Date.now() } = {}) {
  if (!todo || !blocked) {
    const journey = currentJourney(now);
    todo ||= todoView({ journey, leads, now });
    blocked ||= blockedView({ executor: executorView({ now }), journey, leads, now });
  }
  const drafts = cachedLines('state/drafts.ndjson');
  const byId = new Map(leads.map(l => [leadKey(l), l])), byNumber = new Map(leads.filter(l => l.number != null).map(l => [String(l.number), l]));
  const draftById = new Map(drafts.map(d => [d.draft_id, d]));
  const queue = [];
  const add = (r, kind, owner) => {
    // 早期的旧草稿可能 draft_id 是 null；没有草稿的行（draft_id: null）会查到它们，被串成「平台私信」。
    const draft = (r.draft_id && draftById.get(r.draft_id)) || {};
    const l = byId.get(r.record_id || draft.record_id) || (r.number != null ? byNumber.get(String(r.number)) : null) || {};
    // 已结束的线索与排除的公司：什么待办都不再出（排除公司的面试 / 回复除外，那是招聘方的实质进展）。
    if (l.record_id || l.id) {
      if (settled(l)) return;
      if (excludedCompany(l) && !INTERVIEW_KINDS.has(kind)) return;
    }
    const number = r.number ?? l.number ?? null, url = r.url || (/^https?:/.test(draft.to || '') ? draft.to : applyUrl(l)) || null;
    const channel_key = unifyChannel({ ...l, ...draft, ...r, channel: draft.channel || r.channel || applyChannel(l) });
    const senior = !!(l.record_id || l.id) && seniorTitle(l);
    const actions = [];
    const command = (cmd, label) => actions.push({ cmd, label, kind: 'command' });
    if (kind === 'blocked') {
      let host; try { host = new URL(url).hostname; } catch {} /* 兜底：地址不是有效网址：拿不到域名，就不给「交给电脑操作」这个按钮 */
      if (host && !computerUseGate({ url, host, config: computerUseConfig(), sessions: loadPortalSessions() })) actions.push({ cmd: leadKey(l), label: l.computer_use?.ok ? `用 ${computerUseDriverLabel(host)} 继续查看` : `交给 ${computerUseDriverLabel(host)} 处理`, kind: read(OPS_PATH, {}).current?.record_id === leadKey(l) ? 'computer_use_running' : 'computer_use' });
      if (url && l.auto_apply?.status !== 'prepared_for_user') actions.push({ cmd: url, label: '在 Ego 打开处理页', kind: 'open' });
      if (r.action === 'resume') actions.push({ cmd: r.key, label: '好了，恢复', kind: 'unblock' });
      if (r.action === 'clear') actions.push({ cmd: r.key, label: '清除记录', kind: 'clear' });
      if (r.action === 'host_job') actions.push({ cmd: r.id, label: '已处理，请核验', kind: 'host_job' }, { cmd: r.id, label: '放弃', kind: 'drop_host_job' });
      if (r.action === 'reapprove' && number != null) command(`投 ${number}`, '重新审核材料');
      // 文字只提到登录不算（"网易已登录，但须先建立在线简历"），要真在说没登录 / 要登录。
      if (r.portal_host && (r.login_required || loginNeeded(`${r.reason || ''}\n${r.label || ''}`))) actions.push({ cmd: r.portal_host, label: '我已登录，恢复', kind: 'portal_login' });
    } else if (['send', 'send_proposal', 'apply_proposal', 'submit'].includes(kind)) {
      if (['platform_dm', 'wechat', 'portal'].includes(channel_key) && url) actions.push({ cmd: url, label: channel_key === 'portal' ? '打开门户' : channel_key === 'wechat' ? '显示联系方式' : '打开平台', kind: 'open' });
      if (channel_key === 'platform_dm' && r.draft_id) actions.push({ cmd: r.draft_id, label: '复制文案', kind: 'copy_draft' });
      if (number != null) {
        if (channel_key === 'wechat') command(`${number} 已加微信`, '标记已加');
        else if (channel_key === 'email' || channel_key === 'referral') command(`发 ${number}`, channel_key === 'referral' ? '发内推请求' : '审核发送');
        else if (channel_key === 'ats_form') command(`投 ${number}`, '投');
      }
    }
    // 资深岗：用户规则是一律不投。去掉「投」和门户入口，给一个 pass。
    const kept = senior ? actions.filter(a => !(a.kind === 'command' && /^投 /.test(a.cmd)) && !(APPLY_KINDS.has(kind) && a.kind === 'open')) : actions;
    if (senior && (APPLY_KINDS.has(kind) || actions.some(a => a.kind === 'command' && /^投 /.test(a.cmd))) && number != null) kept.unshift({ cmd: `pass ${number} 资深岗，按规则不投`, label: 'pass（资深岗不投）', kind: 'command' });
    // 每一项都能手动归档：待办项按 action id 写 overrides；阻塞项按稳定 key 写 dismissed；拟发 / 拟投走「不发」「pass」。
    const archive = kind === 'blocked' ? { key: r.dismiss_key || dismissKey(r) } : /_proposal$/.test(kind) || kind === 'auto_apply' ? null : r.id ? { action_id: r.id } : null;
    const detail = typeof r.detail === 'string' ? r.detail : waitingText(r.detail) || (typeof r.reason === 'string' ? r.reason : '') || r.first_line || '';
    queue.push({ archive, host_job: r.host_job || null, id: `${kind}:${r.id || r.key || r.draft_id || r.record_id || number}`, role: owner, kind, channel_key, senior, lead: { number, company: r.company || l.company || '', role: r.lead_role || (kind === 'blocked' ? l.role : r.role) || l.role || '', record_id: r.record_id || draft.record_id || leadKey(l) || null }, title: r.title || (kind === 'send_proposal' ? '审核并发送' : kind === 'apply_proposal' ? '确认投递' : r.label || kind), detail, due_at: r.due_at || null, priority: r.priority ?? (kind === 'blocked' ? 90 : kind === 'send_proposal' ? 80 : 60), actions: kept, refs: { draft_id: r.draft_id || null, url, evidence: r.evidence || null }, to: r.to || draft.to || '', subject: r.subject || draft.subject || '', awaiting_batch_review: r.awaiting_batch_review || false, login_required: !!r.login_required });
  };
  const proposed = new Set(todo.send_proposal.map(r => r.draft_id).filter(Boolean));
  for (const g of todo.groups) for (const r of g.items) if (!(g.kind === 'send' && proposed.has(r.draft_id))) add(r, g.kind, g.persona);
  for (const r of todo.send_proposal) add(r, 'send_proposal', 'reacher');
  for (const r of todo.apply_proposal) add(r, 'apply_proposal', 'reacher');
  for (const r of blocked.filter(b => b.needs === 'user')) add(r, 'blocked', r.role);
  const merged = mergeByLead(queue);
  const due = r => Number.isFinite(Date.parse(r.due_at)) ? Date.parse(r.due_at) : Infinity;
  const out = merged.sort((a, b) => (due(a) - due(b)) || b.priority - a.priority || a.id.localeCompare(b.id));
  return role ? out.filter(q => q.role === role) : out;
}
// 同一条线索的多行合成一行：主行按 KIND_RANK 选；动作按 (类型, 文案) 去重合并；执行器的问题（宿主任务 /
// 补充信息）优先当作"卡在哪"。其它行的标题与原文放进 also，界面在「展开」里给出。
export function mergeByLead(queue) {
  const groups = new Map(), order = [];
  for (const q of queue) {
    const k = q.lead.record_id ? `id:${q.lead.record_id}` : q.lead.number != null ? `n:${q.lead.number}` : `row:${q.id}`;
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(q);
  }
  return order.map(k => {
    // 同级时让线索自己的行（Radar / Watch / Reacher）当主行，System 的修复任务并进来，不把整行带进 System。
    const rows = groups.get(k).sort((a, b) => (KIND_RANK[a.kind] ?? 20) - (KIND_RANK[b.kind] ?? 20) || (a.role === 'system') - (b.role === 'system') || b.priority - a.priority);
    const head = rows[0];
    const hostJob = rows.map(r => r.host_job).find(j => j && ['waiting_user', 'blocked'].includes(j.status)) || head.host_job || rows.find(r => r.host_job)?.host_job || null;
    const question = hostJob?.required_action || rows.find(r => r.kind === 'clarify')?.detail || '';
    const seen = new Set(), actions = [];
    for (const r of rows) for (const a of r.actions) { const key = `${a.kind}|${a.label}|${a.cmd}`; if (!seen.has(key) && !actions.some(x => x.kind === a.kind && x.label === a.label)) { seen.add(key); actions.push(a); } }
    const login = rows.some(r => r.login_required || r.actions.some(a => a.kind === 'portal_login'));
    const full = [...new Set([question, ...rows.map(r => r.detail)].map(x => String(x || '').trim()).filter(Boolean))].join('\n\n');
    const reapprove = rows.some(r => r.actions.some(a => a.kind === 'command' && /^投 /.test(a.cmd) && a.label === '重新审核材料'));
    const headline = question ? (/登录/.test(question) ? '需要你登录后继续' : '需要你回答一个问题') : reapprove ? '材料变了，需要你重新确认' : login ? '需要你登录后继续' : head.kind === 'blocked' ? '需要你确认后继续' : head.title;
    const summary = oneLine(question || head.detail || rows.map(r => r.detail).find(Boolean) || head.title);
    return { ...head, host_job: hostJob, actions, headline, summary, full_detail: full, priority: Math.max(...rows.map(r => r.priority)), due_at: rows.map(r => r.due_at).filter(Boolean).sort()[0] || null, archive: head.archive || rows.find(r => r.archive)?.archive || null, refs: { ...head.refs, draft_id: head.refs.draft_id || rows.find(r => r.refs.draft_id)?.refs.draft_id || null, url: head.refs.url || rows.find(r => r.refs.url)?.refs.url || null, evidence: head.refs.evidence || rows.find(r => r.refs.evidence)?.refs.evidence || null }, also: rows.slice(1).map(r => ({ kind: r.kind, title: r.title, detail: r.detail, id: r.id, archive: r.archive })), merged: rows.length, senior: rows.some(r => r.senior) };
  });
}

// ── 阻塞与告警 ───────────────────────────────────────────────────────────────
export function blockedView({ executor, journey, leads, now = Date.now() }) {
  let out = [];
  const lastRunSuccess = executor.run_now?.last_exit === 0 ? Date.parse(executor.run_now.last_finished_at || '') : NaN;
  const recoveredRun = at => Number.isFinite(lastRunSuccess) && lastRunSuccess > Date.parse(at || '');
  for (const t of executor.heartbeat.tasks) {
    if (t.executor === 'run-now' && t.status === 'failed' && recoveredRun(t.updated_at)) continue;
    if (t.blocked_at || t.needs_user || t.status === 'failed' || t.stuck)
      out.push({ source: 'executor', key: t.key, company: (leads.find(l => String(l.number) === String(t.task)) || {}).company || null, label: `${t.executor} · ${t.task}`, reason: t.needs_user || (t.status === 'failed' ? (t.executor === 'auto-apply' ? `${applyWord()}没成：${t.detail || '原因没记下来'}` : `本机 AI 异常退出：${t.detail || '原因未记录'}`) : t.blocked_at ? `已标 blocked（${t.blocked_reason || '原因未记录'}）：${t.detail || ''}` : `已 ${t.idle_minutes} 分钟没有新进展，停在「${t.step || '未记录'}」`), since: t.blocked_at || t.updated_at, action: t.resumable ? 'resume' : 'clear', step: t.step });
  }
  for (const j of [...executor.host_jobs.blocked, ...executor.host_jobs.waiting_user]) {
    if (j.kind === 'system_fix' && j.status === 'blocked' && j.target?.key?.startsWith('run-now:') && recoveredRun(j.created_at)) continue;
    // System 修的任务常常只在 target 里带着是哪条线索（record_id / number / 执行器 key「auto-apply:390」）：认出来才能和那条线索合成一行。
    const numberIn = (text, re) => { const m = String(text || '').match(re); return m ? Number(m[1]) : null; };
    const targetNumber = j.number ?? j.target?.number ?? numberIn(j.target?.key, /^[a-z_-]+:(\d+)$/) ?? numberIn(j.target?.label, /^[a-z_-]+ · (\d+)[：:]/);
    out.push({ source: 'host_job', id: j.id, kind: j.kind, number: targetNumber, record_id: j.record_id || j.target?.record_id || undefined, company: j.company || j.target?.company || null, host_job: j, label: `${j.kind === 'system_fix' ? `${crewName('patch')} 修：` + short(j.label, 100) : j.kind === 'user_request' ? short(j.details, 100) : j.kind}${j.number ? ' · #' + j.number : ''}${j.company ? ' · ' + j.company : ''}`, reason: j.result || j.details || '', since: j.created_at, status: j.status, action: 'host_job' });
  }
  for (const l of leads) {
    const a = l.auto_apply;
    if (!a || settled(l)) continue;
    const stale = a.status === 'awaiting_batch_review' && !!a.approved_at;
    // 预填好的那一页关了、你点了「重新预填」（lib/apply-retry.mjs 记的 page_closed）：接下来归那张投递卡（排队预填，或等你确认这一版），不再另报一条「没成」。
    if (a.status === 'failed' && a.error === 'page_closed') continue;
    // waiting_user：自动投递停在表上你才答得出的必填项（lib/auto-apply.mjs）；收件箱按原因码出补充信息的信（lib/needs.mjs）。
    if (a.status === 'failed' || a.status === 'needs_login' || a.status === 'paused' || a.status === 'prepared_for_user' || a.status === 'waiting_user' || stale)
      out.push({ source: 'lead', number: l.number, record_id: leadKey(l), company: l.company || null, label: label(l), reason: a.status === 'waiting_user' ? leadApplyWords(a).line : a.status === 'prepared_for_user' ? (l.computer_use?.reached === 'prefilled' ? 'Chrome 表单已预填，等待你检查并亲自提交；系统没有提交' : 'Chrome 申请页已打开，等待你检查并完成；系统没有提交') : a.status === 'paused' ? '投递已暂停，登录恢复后重新核对当前材料与批准' : a.status === 'needs_login' ? `需登录 ${portalSession(l)?.domain || '门户'}` : stale ? '你批准后申请入口或简历变了，需再回一次「投 编号」' : `${applyWord()}没成（第 ${a.attempts || 1} 次）：${leadApplyWords(a).line}`, since: a.at || a.approved_at, action: stale ? 'reapprove' : 'lead', evidence: a.evidence || null });
  }
  for (const c of journey.cases.filter(c => ['需要补充信息', '投递已暂停'].includes(c.stage)))
    if (!out.some(b => b.record_id === c.id)) out.push({ source: 'lead', number: c.number, record_id: c.id, company: c.company || null, label: `${c.number} · ${c.company} · ${c.role || ''}`, reason: c.next, since: null, action: 'lead' });
  // 归到角色：投递 / 材料类归 Reacher，发现 / 转发类归 Radar，面试类归 Watch，其余归 System。
  const roleOfBlocked = b => {
    if (b.source === 'executor') return 'reacher';
    if (b.source === 'host_job') return b.kind === 'system_fix' ? 'system' : /apply|application|material|referr|contact|packet/.test(b.label) ? 'reacher' : /discover|forwarded|lead|source/.test(b.label) ? 'radar' : /interview|dossier|review/.test(b.label) ? 'watch' : 'system';
    if (b.source === 'lead') return ['interview', 'reply'].includes(b.kind) ? 'watch' : 'reacher';
    return 'system';
  };
  for (const b of out) b.role = roleOfBlocked(b);
  // 谁来解：流程设计里就要用户确认 / 授权 / 登录的 → user（进「等我处理」）；流程之外走不下去的 → system（System 自动修）。
  const needsOf = b => {
    if (b.source === 'executor') return b.action === 'resume' || /登录|等你|needs_user|验证码|授权/.test(`${b.reason} ${b.status}`) ? 'user' : 'system';
    if (b.source === 'host_job') return b.status === 'waiting_user' ? 'user' : 'system';
    if (b.source === 'lead') return 'user';
    return 'system';
  };
  for (const b of out) b.needs = needsOf(b);
  // 要用户去登录 / 提交 / 加好友的，带上那个页面：工作台一个按钮就在 ego 里弹出来。
  const byNumber = new Map(leads.filter(l => l.number != null).map(l => [String(l.number), l]));
  // 任务可能用线索的内部 id 指它，也可能用飞书 record_id：两个都认，下面统一改写成 leadKey，同一条线索才合成一行。
  const byId = new Map(leads.flatMap(l => [[l.id, l], [leadKey(l), l]]).filter(([k]) => k));
  for (const b of out) {
    const l = b.record_id ? byId.get(b.record_id) : b.number != null ? byNumber.get(String(b.number)) : b.source === 'executor' ? byNumber.get(String(b.key).split(':')[1]) : null;
    if (l) { b.record_id = leadKey(l); b.lead_role = l.role || ''; b.channel_key = unifyChannel(l); b.portal_host = portalSession(l)?.domain || null; b.session_ok = !!portalSession(l)?.logged_in; b.url = (() => { try { return applyUrl(l) || l.url || null; } catch { return l.url || null; } })(); if (!b.number && l.number != null) b.number = l.number; if (!b.company) b.company = l.company || null; }
  }
  // 用户手动归档过的行不再出现（state/dismissed.json）。
  const gone = dismissed();
  for (const b of out) b.dismiss_key = dismissKey(b);
  out = out.filter(b => !gone[b.dismiss_key]);
  // 已交给 System 修的：把那条 system_fix 宿主任务的状态和结果挂到原阻塞项上。
  const fixes = cachedLines('state/host-jobs.ndjson').filter(j => j.kind === 'system_fix' && j.target);
  for (const b of out) {
    const j = fixes.filter(j => sameTarget(j.target, b)).sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)))[0];
    if (j && (['pending', 'working', 'blocked', 'waiting_user'].includes(j.status) || dayOf(j.completed_at) === dayOf(now))) b.system_job = systemJobResult(j);
  }
  const merged = new Map();
  for (const b of out.filter(b => !(b.source === 'host_job' && b.kind === 'system_fix' && out.some(o => o.system_job?.id === b.id)))) {
    const key = b.record_id && b.needs === 'user' && b.role === 'reacher' && (b.source !== 'host_job' || /apply|application|material/.test(b.kind || '')) ? `lead-blocked:${b.record_id}:apply` : b.dismiss_key;
    const old = merged.get(key);
    const preferred = !old || b.source === 'lead' ? b : old;
    const related = [...(old?.related || (old ? [old] : [])), b];
    merged.set(key, { ...preferred, dismiss_key: key, related, needs: related.some(x => x.needs === 'user') ? 'user' : preferred.needs,
      system_job: preferred.system_job || related.find(x => x.system_job)?.system_job, login_required: !/Chrome.*等待/.test(preferred.reason || '') && related.some(x => loginNeeded(x.reason || '')) });
  }
  return [...merged.values()].filter(b => !gone[b.dismiss_key]).sort((a, b) => String(b.since || '').localeCompare(String(a.since || '')));
}
// 自动修复要看的两样（lib/system/repair.mjs autoRepair）：挡路的事、告警。和指挥台同一套算法。
export function repairInputs({ now = Date.now() } = {}) {
  const executor = executorView({ now }), leads = cachedLines('state/leads.ndjson'), events = recentEvents(), journey = currentJourney(now), schedule = scheduleView({ now });
  return { blocked: blockedView({ executor, journey, leads, now }), alerts: alertsView({ events, executor, schedule, leads, now }) };
}
export function repairsView({ now = Date.now(), limit = 30 } = {}) {
  const jobs = latestHostJobs().filter(j => j.kind === 'system_fix').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const rows = jobs.slice(0, limit).map(j => ({ id: j.id, status: j.status, source: j.target?.source || null, auto: AUTO_REPAIRED.test(j.details || ''), created_at: j.created_at || null, completed_at: j.completed_at || null, ...systemJobResult(j), label: j.target?.label || short(j.details, 80), number: j.number ?? null, company: j.company || null }));
  return { rows, open: jobs.filter(j => ['pending', 'working'].includes(j.status)).length, pending: jobs.filter(j => j.status === 'pending').length, working: jobs.filter(j => j.status === 'working').length, waiting_user: jobs.filter(j => j.status === 'waiting_user').length, completed_today: jobs.filter(j => j.status === 'completed' && dayOf(j.completed_at) === dayOf(now)).length, config: autoRepairConfig() };
}

// ── 今天的进展（原总览页的漏斗）与刚刚发生 ─────────────────────────────────────
export function todayFunnel({ events = [], drafts = [], outbound = [], now = Date.now() } = {}) {
  const today = dayOf(now), day = events.filter(e => dayOf(e.ts) === today);
  return [
    ['转发', new Set(day.filter(e => e.actor === 'listener' && e.step === 'message').map(e => e.run_id)).size],
    ['识别', day.filter(e => e.step === 'extract' && e.status === 'ok').length],
    ['命中', day.filter(e => e.step === 'match' && e.status === 'ok').length],
    ['材料就绪', drafts.filter(d => d.verified_at && dayOf(d.verified_at) === today).length],
    ['已投 / 联系', outbound.filter(o => (o.at || o.sent_at) && dayOf(o.at || o.sent_at) === today).length],
    ['回复', day.filter(e => e.step === 'reply' && e.status === 'ok').length],
    ['面试', day.filter(e => e.step === 'interview' && e.status === 'ok').length],
  ];
}
export function recentEventsView(events = [], leads = [], limit = 10) {
  const byId = new Map(); for (const l of leads) { if (l.id) byId.set(l.id, l); if (l.record_id) byId.set(l.record_id, l); }
  return events.filter(e => e.step !== 'heartbeat').slice(0, limit).map(e => { const l = e.lead_id ? byId.get(e.lead_id) : null; return { ts: e.ts, actor: e.actor, step: e.step, status: e.status, msg: short(e.msg, 160), run_id: e.run_id, lead_id: e.lead_id || null, number: l?.number ?? null, company: l?.company || null, record_id: l ? leadKey(l) : null }; });
}
export function alertsView({ events, executor, schedule, runtime = {}, progress = read('state/cycle-progress.json', {}), connector = read('state/host-connector.json', {}), sources = read('state/discovery-sources.json', {}), human = read('state/human-discovery-check.json', {}), leads = [], now = Date.now() }) {
  const out = [], push = (level, source, msg, extra = {}) => out.push({ level, source, msg, ...extra });
  const since = now - DAY;
  // 核对没过不算失败；旧版命令行留下的 listener / concierge 事件也不算（10-04 删掉了那两条路）。
  const fails = events.filter(e => e.status === 'fail' && Date.parse(e.ts) > since && e.actor !== 'user' && !notFailure(e) && !['listener', 'concierge'].includes(e.actor));
  const grouped = new Map();
  for (const e of fails) {
    const k = `${roleOf(e)}|${e.step}|${e.msg || ''}`;
    const g = grouped.get(k) || { role: roleOf(e), step: e.step, msg: e.msg || '', count: 0, last_at: e.ts, last: e, refs: [], occurrences: [] };
    if (!g.occurrences.some(x => x.run_id === e.run_id && Math.abs(Date.parse(x.ts)-Date.parse(e.ts)) < 5000)) { g.count++; g.occurrences.push(e); }
    if (e.ts >= g.last_at) { g.last_at = e.ts; g.last = e; }
    for (const r of e.refs || []) if (!g.refs.some(x => x.file === r.file)) g.refs.push(r);
    grouped.set(k,g);
  }
  const doneJobs = J.list({ state: 'done', since, limit: 2000 }); // 账上这 24 小时做完的活（恢复只认这一种「成功」）
  for (const g of grouped.values()) {
    // 后来同一件事做成了：同一步，或者同一类活同一位做成了（挂在岗位上的按那个岗位对，lib/alert-rules.mjs laterSuccess）。
    const success = { ts: laterSuccess(g, doneJobs) };
    const runRecovered = g.step === 'run-now' && executor.run_now.last_exit === 0 && executor.run_now.last_finished_at > g.last_at;
    const recovered = success?.ts || (runRecovered ? executor.run_now.last_finished_at : null);
    push(recovered ? 'info' : ['sync','connection','heartbeat','catchup'].includes(g.step) ? 'warn' : 'error', g.role, `${g.msg}（24 小时内 ${g.count} 次）`, {at:g.last_at,step:g.step,refs:g.refs,count:g.count,...(recovered ? {recovered_at:recovered} : {})});
  }
  const rn = executor.run_now;
  if (rn.last_exit && rn.last_exit !== 0) push('error', 'patch', `上一次本机 AI 没正常结束（exit ${rn.last_exit}）：${short(rn.last_error, 160) || '原因未记录'}`, { at: rn.last_finished_at });
  if (rn.stale) push('warn', 'patch', '本机 AI 标记为运行中已超过 30 分钟，可能在机器休眠时被杀掉；下一次指令会重新拉起', { at: rn.running_since });
  for (const r of progress.results || []) if (/fail|error|degraded/.test(String(r.status)) && (r.errors?.length || r.error)) push('warn', stageMember(r.stage), `上一轮 ${r.stage} ${r.status}：${short((r.errors || [r.error]).map(e => typeof e === 'string' ? e : e.error || JSON.stringify(e)).join('；'), 160)}`, { at: progress.at || null, stage: r.stage });
  // 这台机器从没装过定时任务（读得到 launchctl，但一项都没加载）时，「没按时启动」「巡检超时」只是噪音：
  // 开始使用的「定时运行」那一项已经说了缺什么。读不到 launchctl 时照旧检查。
  const scheduled = true; // App 自己起定时（lib/app-schedule.mjs），不再看 launchd 装没装
  const cycle = scheduled && schedule.items.find(i => i.kind === 'cycle');
  if (cycle) {
    const start = zonedTime(dayOf(now));
    for (const { hour: h, minute: m } of cycle.calendar || []) {
      const slot = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, at = start + h * 3600000 + m * 60000;
      if (now < at + 25 * 60000) continue;
      const started = (schedule.starts || schedule.poll_log.filter(l => /^scheduled start/.test(l.text)).map(l => l.at)).some(t => Math.abs(Date.parse(t) - at) < 25 * 60000) || (cycle.last_started_at && Math.abs(Date.parse(cycle.last_started_at) - at) < 25 * 60000);
      if (!started) push('warn', 'patch', `今天 ${slot} 的周期没有按时启动（机器可能在睡眠）`, { at: iso(at) });
    }
  }
  const mail = scheduled && schedule.items.find(i => i.kind === 'mailpoll');
  if (mail?.active_window && schedule.hour >= 10 && (!mail.last_finished_at || now - Date.parse(mail.last_finished_at) > 75 * 60000)) push('warn', 'owl', `收件箱巡检超过 75 分钟没有完成记录（最近：${mail.last_finished_at ? new Date(mail.last_finished_at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false }) : '今天没有'}）`, { at: mail.last_finished_at });
  // 执行器若在 state/host-connector.json 的 reconciliation 字段（status / checked_at / evidence）记下一封尚未对账的补发邮件，就一直告警到对账完成。
  if (connector.reconciliation?.status && !/resolved|reconciled/.test(connector.reconciliation.status)) push('warn', 'quill', `有补发邮件仍未对账：${connector.reconciliation.status}（先对账，不要再次补发）`, { at: connector.reconciliation.checked_at, refs: connector.reconciliation.evidence ? [{ file: connector.reconciliation.evidence }] : [] });
  // 读到了岗位、只是官网地址没核实的不算（10-01 #7）；每家写原因（lib/discovery-source.mjs sourceState）。
  const bad = (sources.sources || []).filter(s => s && sourceState(s).bad);
  if (bad.length) push('warn', 'scout', `${bad.length} 个官方招聘源读不到：${bad.slice(0, 5).map(s => `${s.company}（${sourceState(s).text}）`).join('、')}${bad.length > 5 ? '…' : ''}`, { at: sources.at || null });
  const blockedHuman = (human.sources || []).filter(s => ['blocked','partial'].includes(s.status));
  if (blockedHuman.length) push('warn', 'scout', `真人帖来源被拦：${blockedHuman.map(s => `${s.source}（${short(s.error, 60)}）`).join('、')}`, { at: human.at || null });
  const failedToJudge = leads.filter(l => l.match_error_final && !l.match && !l.superseded && !l.prefilter_reason && !excludedCompany(l) && !l.auto_apply && leadState(l) === 'new');
  const matchFailed = failedToJudge.length;
  if (matchFailed) push('warn', 'lens', `${matchFailed} 条新岗位判断失败，可以重新判断`, { id: 'judge-failed', fix: { label: 'Judge', to: '#team/lens' } });
  // 登录、验证码等人为步骤已经在 blockedView / 等我处理；不能作为系统故障再次自动排修。
  // 供应商 id 写错会让 codex 静默落到别的底座（2026-09-19 到 09-21 就是这样）。
  // 按 stackSummary 自己分的档推（10-04：以前每条提示都推成严重，成员底座「已按跟随全局处理」也挂了 5 条在顶上）：
  // 挡路的一类一条严重（msg 写哪一类、几个，detail 是每一项原话）；降级的一条警告；已经自动处理的一条提示，不占顶上。
  try {
    const st = stackSummary(), of = level => st.issues.filter(i => i.level === level);
    const errs = of('error'), warns = of('warn'), notes = of('info');
    if (errs.length) push('error', 'patch', stackHeadline(errs), { id: 'stack', count: errs.length, detail: errs.map(i => i.text) });
    if (warns.length) push('warn', 'patch', stackHeadline(warns), { id: 'stack-skip', count: warns.length, detail: warns.map(i => i.text) });
    if (notes.length) push('info', 'patch', stackHeadline(notes), { id: 'stack-roles', count: notes.length, detail: notes.map(i => i.text) });
  } catch (e) { noteSwallowed('command-center.stack', e, { doing: '检查模型底座的配置', then: '顶上这一次不提醒底座的问题，下一次刷新再看' }); }
  const order = { error: 0, warn: 1, info: 2 };
  // 交给 System 修过的告警：把那条 system_fix 任务挂上来（告警文案里的"（24 小时内 N 次）"会变，比对时去掉）。
  const strip = t => String(t || '').replace(/（24 小时内 \d+ 次）/g, '').trim();
  const fixes = cachedLines('state/host-jobs.ndjson').filter(j => j.kind === 'system_fix' && j.target?.source === 'alert');
  const annotate = a => { const j = fixes.filter(j => strip(j.target.label) === strip(a.msg)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0]; if (j && (['pending', 'working', 'blocked', 'waiting_user'].includes(j.status) || dayOf(j.completed_at) === dayOf(now))) a.system_job = systemJobResult(j); return a; };
  // System 已修完的不再占位；等级用文字说明它是否影响运行。
  const LEVEL = { error: ['严重', '影响流程，相关工作流会停在这里'], warn: ['警告', '功能降级，主流程还在跑'], info: ['提示', '仅记录，不影响运行'] };
  // 没有去处的严重降成警告、带上「不用管这条」、关掉的同类拿掉（lib/alert-rules.mjs finishAlerts）。
  return finishAlerts(out, { now }).sort((a, b) => order[a.level] - order[b.level] || String(b.at || '').localeCompare(String(a.at || ''))).map(annotate)
    .filter(a => a.system_job?.status !== 'completed')
    .map(a => ({ ...a, level_label: a.recovered_at ? '已恢复' : LEVEL[a.level]?.[0] || a.level, impact: a.recovered_at ? '历史故障；后续同类执行已成功' : LEVEL[a.level]?.[1] || '' }));
}

// ── 线索集 ───────────────────────────────────────────────────────────────────
export function leadsView({ leads, drafts, outbound, requests = cachedLines('state/send-requests.ndjson'), now = Date.now() }) {
  const today = dayOf(now);
  const active = leads.filter(l => !l.superseded && l.status !== 'superseded' && l.match_status !== 'superseded');
  // 配置每次只读一遍再传进去（默认参数会让每条线索各读一遍 config/pipeline.json）。
  const pipeline = read('config/pipeline.json', {}), sprint = citySprint();
  const judged = active.filter(l => !l.prefilter_reason && !excludedCompany(l, pipeline)), open = judged.filter(l => l.match?.verdict !== 'exclude' && !settled(l));
  const holds = new Map(open.map(l => [l, sprintHold(l, sprint)]));
  const held = open.filter(l => holds.get(l)), alive = open.filter(l => !holds.get(l));
  const states = new Map(alive.map(l => [l, viewState(l, { requests })]));
  const pool = alive.filter(l => states.get(l) === 'new'), decided = alive.filter(l => states.get(l) !== 'new');
  const count = (rows, fn) => { const c = {}; for (const r of rows) { const k = fn(r) || '未知'; c[k] = (c[k] || 0) + 1; } return c; };
  const byStage = count(pool, l => boardStage(l, drafts, outbound));
  const byVerdict = count(pool, l => verdictWord(verdictOf(l)));
  const byCity = count(pool, l => leadCity(l) || l.judgement?.posting?.city || '未写');
  const bySource = Object.entries(count(pool, l => l.source_type || l.source)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const recent = active.filter(l => !l.prefilter_reason && dayOf(l.discovered_at || l.imported_at) === today).sort((a, b) => String(b.discovered_at).localeCompare(String(a.discovered_at))).slice(0, 10).map(l => ({ id: leadKey(l), number: l.number ?? null, company: l.company, role: l.role, city: leadCity(l) || l.location || '', verdict: l.match?.verdict || null, source: sourceLabel(l), human: isHuman(l), url: l.url }));
  let picks = read('state/top-picks.json', null);
  if (!picks || picks.date !== today) { try { picks = topPicks({ leads: active, outbound, drafts, now }); } catch { picks = picks || { rows: [] }; } }
  const m = read('state/metrics.json', {});
  return {
    counts: { total: active.length, hidden: leads.length - active.length, prefiltered: active.filter(l => l.prefilter_reason).length, backlog: held.filter(l => !decidedLead(l)).length, excluded: judged.filter(l => l.match?.verdict === 'exclude').length, decided: decided.length, pool: pool.length, recommended: pool.filter(l => l.match?.verdict === 'recommend').length, human: pool.filter(isHuman).length, discovered_today: active.filter(l => dayOf(l.discovered_at) === today).length, judged_today: active.filter(l => dayOf(l.judgement?.at) === today).length, recommended_today: active.filter(l => l.match?.verdict === 'recommend' && dayOf(l.matched_at) === today).length, match_failed: active.filter(l => l.match_error_final && !l.match).length },
    stages: BOARD_STAGES.map(s => [s, byStage[s] || 0]),
    verdicts: byVerdict, cities: Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 8), sources: bySource,
    recent,
    top_picks: { date: picks?.date || today, rows: (picks?.rows || []).filter(r => !excludedCompany(r, pipeline) && !sprintHold({location:r.city}, sprint)).map(r => ({ number: r.number, company: r.company, role: r.role, city: r.city, fit: r.fit, verdict: r.verdict, human: !!r.human, blocker: r.blocker, owner: r.owner, channel: r.channel, url: r.url || r.entry || null, record_id: r.record_id || null })) },
    metrics: { weekly: m.weekly || null, reply_rate: m.reply_rate ?? null, by_channel: m.by_channel || {}, pass_reasons: (m.pass_reasons || []).slice(0, 5), updated: m.weekly?.since || null },
  };
}

// ── 跟进情况 ─────────────────────────────────────────────────────────────────
// One row per opportunity, with the latest outbound receipt as its channel/content anchor.
export function pipelineView({ leads = cachedLines('state/leads.ndjson'), outbound = cachedLines('state/outbound.ndjson'), drafts = cachedLines('state/drafts.ndjson'), now = Date.now() } = {}) {
  const columns = Object.fromEntries(['contacted', 'awaiting_reply', 'replied', 'interviewing', 'awaiting_result', 'offer', 'rejected'].map(k => [k, []]));
  const latest = new Map();
  const byId = new Map(leads.map(l => [leadKey(l), l]));
  const byNumber = new Map(leads.filter(l => l.number != null).map(l => [String(l.number), l]));
  for (const o of outbound) {
    const lead = byId.get(o.record_id) || byNumber.get(String(o.number));
    if (!delivered(o, lead)) continue;
    const key = o.record_id || (o.number != null ? `number:${o.number}` : null);
    if (!key) continue;
    const old = latest.get(key);
    if (!old || String(o.sent_at || o.at || '') > String(old.sent_at || old.at || '')) latest.set(key, o);
  }
  const next = { contacted: '等回复', awaiting_reply: '等回复，可确认是否跟进', replied: '确认回复与下一步', interviewing: '准备并参加面试', awaiting_result: '等结果', offer: '已记录 Offer', rejected: '本轮已结束' };
  for (const l of leads) {
    if (l.superseded || l.status === 'superseded' || l.match_status === 'superseded') continue;
    const o = latest.get(leadKey(l)) || latest.get(`number:${l.number}`);
    if (!o && !l.interview_at && !l.interview_completed_at && !l.replied_at && !l.offer_at && !['replied', 'interview_scheduled', 'interview_done', 'offer', 'rejected'].includes(leadState(l))) continue;
    const sentAt = o?.sent_at || o?.at;
    // First day is the contact receipt; subsequent days are waiting for a reply.
    const st = leadState(l), column = st === 'offer' ? 'offer' : endedLead(l) ? 'rejected' : l.interview_completed_at || st === 'interview_done' ? 'awaiting_result' : l.interview_at || st === 'interview_scheduled' ? 'interviewing' : l.replied_at || st === 'replied' ? 'replied' : Number.isFinite(Date.parse(sentAt)) && now - Date.parse(sentAt) >= DAY ? 'awaiting_reply' : 'contacted';
    const last = [sentAt, l.replied_at, l.interview_completed_at, l.interview_review_at, l.offer_at, l.closed_at, l.interview_time_source?.at].filter(at => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    columns[column].push({ record_id: leadKey(l), number: l.number ?? o?.number ?? null, company: l.company || o?.company || '', role: l.applied_role || l.role || o?.role || '', channel: o?.channel || l.entry_type || null, last_at: last, days_since: last ? Math.max(0, Math.floor((now - Date.parse(last)) / DAY)) : null, next: next[column], dossier_url: l.interview_dossier?.url || null, draft_id: o?.draft_id || drafts.find(d => d.sent_external_id && d.sent_external_id === (o?.external_id || o?.message_id))?.draft_id || null, interview_at: l.interview_at || null, completed: !!l.interview_completed_at, reviewed: !!l.interview_review });
  }
  for (const rows of Object.values(columns)) rows.sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));
  return columns;
}

export function followupView({ leads, outbound, now = Date.now() }) {
  const byId = new Map(leads.map(l => [leadKey(l), l]));
  const inbox = cachedLines('state/inbox-events.ndjson').filter(e => e.category !== '用户反馈');
  const drafts = cachedLines('state/drafts.ndjson');
  const sent = outbound.map(o => {
    const l = byId.get(o.record_id) || {}, at = o.sent_at || o.at;
    const d = drafts.find(d => (o.draft_id && d.draft_id === o.draft_id) || (d.sent_external_id && d.sent_external_id === (o.external_id || o.message_id))) || {};
    const reply = inbox.find(e => e.record_id === o.record_id && e.at > at && /回复|面试|拒绝|进展|需补材料/.test(e.category || ''));
    const days = at ? Math.floor((now - Date.parse(at)) / DAY) : null;
    return { record_id: o.record_id, number: o.number ?? l.number ?? null, company: o.company || l.company, role: o.role || l.role || '', channel: o.channel, channel_key: unifyChannel(o), draft_id: o.draft_id || d.draft_id || null, body_preview: o.body_preview || null, purpose: o.purpose || 'application', at, to: o.to || null, subject: o.subject || d.subject || null, reconciled: !!o.reconciled, external_id: o.external_id || o.message_id || null, stage: stageText(l), replied_at: l.replied_at || reply?.at || null, reply_category: reply?.category || null, days_since: days, interview_at: l.interview_at || null, evidence: o.evidence || null };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const interviews = leads.filter(l => l.interview_at && !l.interview_completed_at && !settled(l)).map(l => ({ record_id: leadKey(l), number: l.number, company: l.company, role: l.applied_role || l.role, at: l.interview_at, round: l.interview_round || '面试', completed: !!l.interview_completed_at, reviewed: !!l.interview_review, dossier_url: l.interview_dossier?.url || null, upcoming: !l.interview_completed_at && Date.parse(l.interview_at) > now })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const referrers = cachedLines('state/referrers.ndjson').map(r => ({ id: r.id, company: r.company, author: r.author, title: r.author_title || '', status: r.status, source: r.source, lead_number: r.lead_number ?? null, found_at: r.found_at, contact_url: r.contact_url || r.post_url || null, offers_referral: !!r.judgement?.offers_referral })).sort((a, b) => String(b.found_at).localeCompare(String(a.found_at)));
  return {
    outbound: sent, sent_total: sent.length, sent_week: sent.filter(o => o.at && now - Date.parse(o.at) < 7 * DAY).length, replied: sent.filter(o => o.replied_at).length,
    inbox: inbox.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 15).map(e => ({ message_id: e.message_id, at: e.at, category: e.category, from: e.from || null, subject: e.subject || null, summary: short(e.summary, 200), number: e.number ?? null, company: e.company || byId.get(e.record_id)?.company || null, record_id: e.record_id || null })),
    interviews, referrers, mail: watchDigest({ now }),
  };
}

// ── 个人信息与偏好 ───────────────────────────────────────────────────────────
function todoPaths(obj, prefix = '', out = []) {
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) todoPaths(v, prefix ? `${prefix}.${k}` : k, out);
  else if (typeof obj === 'string' && /\b(TODO|unknown)\b|待确认|待填/i.test(obj)) out.push({ path: prefix, value: short(obj, 80) });
  return out;
}
export function profileView() {
  const materials = (() => { try { return materialsCount(); } catch { return { docs: 0, versions: 0 }; } })();
  let facts = {};
  try { facts = YAML.parse(fs.readFileSync(file('candidate/facts.yaml'), 'utf8')) || {}; } catch (e) { return { error: '读取 candidate/facts.yaml 失败：' + e.message, materials }; }
  const stat = p => { try { const s = fs.statSync(file(p)); return { path: p, exists: true, size: s.size, mtime: s.mtime.toISOString() }; } catch { return { path: p, exists: false }; } };
  const routing = facts.resume_routing || {};
  return {
    identity: facts.identity || {}, location: facts.location || {}, work_authorization: facts.work_authorization || {}, availability: facts.availability || {}, compensation: facts.compensation || {},
    preferences: facts.preferences || {}, current_work: facts.current_work ? { company: facts.current_work.company, title: facts.current_work.title, start: facts.current_work.start, focus: facts.current_work.focus } : null,
    highlights: (facts.career_highlights?.entries || []).map(e => ({ company: e.company, dates: e.dates, role: e.role })),
    projects: (facts.personal_projects?.entries || []).map(p => ({ name: p.name, url: p.url || null, relevance: p.relevance || [] })),
    alumni: facts.alumni_networks || [], languages: facts.standard_answers?.languages || [], communication: facts.communication || {}, standard_answers: { why_leaving: facts.standard_answers?.why_leaving ?? null, management_experience: facts.standard_answers?.management_experience ?? null, biggest_strength: facts.standard_answers?.biggest_strength ?? null },
    resumes: [routing.english_pdf, routing.chinese_pdf].filter(Boolean).map(stat), resume_rule: routing.rule || null,
    materials, // 材料是否已导入独立于个人资料是否已填写，和材料页一样数
    // 陪同浏览时段（communication.assisted_browsing_slots）已经撤掉：老资料里还留着 TODO 也不算缺。
    todos: todoPaths(facts).filter(t => !/^standard_answers\.(why_leaving|self_introduction)|^communication\.assisted_browsing_slots$/.test(t.path)),
    facts_mtime: stat('candidate/facts.yaml').mtime || null,
  };
}
export function preferencesView() {
  const p = read('state/preferences.json', null);
  if (!p) return null;
  const flat = Object.entries(p.dimensions || {}).flatMap(([dim, vals]) => Object.entries(vals).map(([value, v]) => ({ dimension: dim, value, weight: Number(v.weight) || 0, positive: v.positive || 0, negative: v.negative || 0, demoted: !!v.demoted })));
  const learned = read('state/learned-prefilters.json', {});
  const rules = Array.isArray(learned) ? learned : learned.rules || learned.prefilters || [];
  return { version: p.version || null, updated_at: p.updated_at || null, signals: p.signals ?? null, positive: flat.filter(x => x.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 8), negative: flat.filter(x => x.weight < 0).sort((a, b) => a.weight - b.weight).slice(0, 8), manual: p.manual || {}, learned_rules: rules.filter(r => !r.disabled).length, learned_disabled: rules.filter(r => r.disabled).length };
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
export function commandCenter(runtime = {}, { now = Date.now() } = {}) {
  const leads = cachedLines('state/leads.ndjson'), drafts = cachedLines('state/drafts.ndjson'), outbound = cachedLines('state/outbound.ndjson');
  const events = recentEvents();
  const journey = currentJourney(now);
  const progress = read('state/cycle-progress.json', {}), connector = read('state/host-connector.json', {});
  const schedule = scheduleView({ now, runtime });
  const executor = executorView({ now });
  const stageRows = (progress.results || []).map(r => ({ stage: r.stage, role: stageMember(r.stage), members: stageMembers(r.stage), status: r.status || 'done', summary: stageSummary(r), errors: (r.errors || (r.error ? [r.error] : [])).map(e => short(typeof e === 'string' ? e : e?.error || e?.message || e?.step || JSON.stringify(e), 120)), next_actions: (r.next_actions || []).length }));
  // 6 位成员各一份（lib/crew.mjs）：在做什么、上一次做了什么、今天失败几次、周期里它那几步的结果。
  const roles = {};
  for (const key of CREW_IDS) {
    const m = crewMember(key), mine = stageRows.filter(s => s.members.includes(key));
    roles[key] = { key, name: m.name, face: m.face, duty: m.duty, group: m.group_label, ...roleActivity(key, events, now), stages: mine, workflow: { ...mine.at(-1), at: progress.at || null } };
  }
  try { const rs = roleSummary(); for (const key of CREW_IDS) roles[key].backends = { chat: rs[key].chat_label, text: rs[key].text_labels, uses: rs[key].uses }; } catch (e) { noteSwallowed('command-center.backends', e, { doing: '读成员用的模型', then: '团队页这一次不显示各位用哪个模型' }); }
  const readyDrafts = drafts.filter(d => d.status === 'ready');
  const today = dayOf(now);
  roles.scout.facts = { discovered_today: leads.filter(l => dayOf(l.discovered_at) === today).length, sources_verified: (read('state/discovery-sources.json', {}).sources || []).filter(s => s.status === 'verified').length, sources_total: (read('state/discovery-sources.json', {}).sources || []).length, human_check: read('state/human-discovery-check.json', {}).at || null, next_cycle: schedule.items.find(i => i.kind === 'cycle')?.next_at || null };
  roles.lens.facts = { judged_today: leads.filter(l => dayOf(l.judgement?.at) === today).length, match_failed: leads.filter(l => l.match_error_final && !l.match && !settled(l)).length };
  roles.owl.facts = { mailbox: connector.mailbox || null, checked_at: connector.checked_at || null, message_count: connector.message_count ?? null, digest: watchDigest({ now }), next_poll: schedule.items.find(i => i.kind === 'mailpoll')?.next_at || null, interviews: leads.filter(l => (l.interview_at || l.interview_completed_at || /^interview_/.test(leadState(l))) && !settled(l)).length, watch_sites: Object.entries(connector.watch_sites || {}).map(([k, v]) => ({ site: k, status: v.status, checked_at: v.checked_at, scanned: v.scanned ?? null })) };
  roles.owl.pipeline = pipelineView({ leads, outbound, drafts, now });
  roles.quill.facts = { drafts_ready: readyDrafts.length, drafts_shown: readyDrafts.filter(d => d.notified_at && d.displayed_hash).length, send_proposal: (read('state/send-proposal.json', {}).rows || []).length, apply_proposal: (read('state/apply-proposal.json', {}).rows || []).length, sent_today: outbound.filter(o => dayOf(o.sent_at || o.at) === today).length, sent_total: outbound.length, queued_sends: cachedLines('state/send-requests.ndjson').filter(r => ['queued', 'dispatched'].includes(r.status)).length, referrers: cachedLines('state/referrers.ndjson').length, blocked_tasks: executor.heartbeat.tasks.filter(t => t.blocked_at).length };
  roles.patch.facts = { run_now: executor.run_now.running ? 'running' : executor.run_now.pending ? 'pending' : 'idle', host_jobs_open: executor.host_jobs.pending.length + executor.host_jobs.working.length, executor: executor.host.executor, models: executor.host.models, quiet_hours: schedule.quiet_hours, run_host: executor.host.run_host, rss_mb: runtime.process?.rss_mb ?? null, uptime_s: runtime.process?.uptime_s ?? null };
  const todo = todoView({ journey, now, leads });
  const blocked = blockedView({ executor, journey, leads, now });
  // 全局合并一次再按成员分：同一条线索只在一位名下出现一次，顶部「等我处理」和各位的「等你 N」是同一份数。
  // 待办的 role 还是飞书卡片的老角色（lib/personas.mjs：谁发这封信），这里经名册换成成员；每一条都落在一位名下。
  const queue = taskQueue(null, { leads, todo, blocked, now });
  for (const key of Object.keys(roles)) roles[key].queue = queue.filter(q => crewOf(q.role, { fallback: 'patch' }) === key);
  const covered = new Set(queue.flatMap(q => [q.lead.record_id, q.lead.number != null ? `n:${q.lead.number}` : null]).filter(Boolean));
  const leadById = new Map(leads.map(l => [leadKey(l), l]));
  // 待决定的跟进（state/followups.json）：已在队列里的、已结束的、排除公司的不再单列一遍。
  todo.followups = todo.followups.filter(f => { const l = leadById.get(f.record_id) || {}; const n = String(f.summary || '').match(/(\d+)\s*$/)?.[1]; return !(covered.has(f.record_id) || (n && covered.has(`n:${n}`))) && !settled(l) && !excludedCompany(l); });
  todo.total_user = queue.filter(q => q.kind !== 'auto_apply').length + todo.followups.length;
  roles.quill.portal_sessions = portalSessionsView({ leads });
  const alerts = alertsView({ events, executor, schedule, runtime, progress, connector, leads, now });
  for (const key of Object.keys(roles)) if (!roles[key].running && alerts.some(a => a.level === 'error' && a.source === key)) roles[key].status = 'fail';
  if (executor.run_now.stale || executor.run_now.last_error) roles.patch.status = 'fail';
  return {
    ts: iso(now), hour: schedule.hour, quiet_hours: schedule.quiet_hours, apply_freeze: applyFreeze(), interview_guide: read('config/interview-guide.json', null),
    // 操作台的「筛选 某城市」快捷指令用第一个目标城市（lib/city.mjs）。
    primary_city: primaryCity(),
    roles, executor, schedule: { items: schedule.items, poll_log: schedule.poll_log, mail_log: schedule.mail_log }, progress: { at: progress.at || null, stages: stageRows },
    todo, blocked, alerts,
    leads: leadsView({ leads, drafts, outbound, now }),
    followup: followupView({ leads, outbound, now }),
    profile: profileView(), preferences: preferencesView(),
    settings: settingsView(),
    memory: { stats: memoryStats(), recent: listNotes({ limit: 15 }).rows },
    ops: opsStatus(),
    journey_counts: journey.counts || {},
    today: todayFunnel({ events, drafts, outbound, now }),
    recent_events: recentEventsView(events, leads, 10),
    repairs: repairsView({ now }),
  };
}

// ── 线索查询：指挥台里的可点击筛选与看板共用 ───────────────────────────────────
const VERDICT_LABEL = VERDICT_WORD;
// 线索在流程里走到哪一步，收敛成 8 个状态给列表上色；渠道决定唯一的主按钮。
export const LEAD_STATUS_LABEL = { new: '新线索', contacted: '已联系', applied: '已投递', replied: '已回复', interviewing: '面试中', offer: 'Offer', rejected: '已拒绝', closed: '已关闭' };
export const CHANNEL_LABEL = { email: '邮件', ats_form: '官方表单', portal: '门户', unknown: '渠道待定' };
// 状态由 lib/lead-state.mjs 统一给：有 lead.state 用它，存量线索从旧字段推导。返回 8 色组（行上色条 / 标签）。
export function leadStatus(l) { return stateGroup(leadState(l)); }
export function leadRow(l, drafts, outbound, requests = [], ctx = {}) {
  const pipeline = 'pipeline' in ctx ? ctx.pipeline : read('config/pipeline.json', {}), sprint = 'sprint' in ctx ? ctx.sprint : citySprint(), sessions = ctx.sessions || loadPortalSessions();
  if (excludedCompany(l, pipeline)) l = { ...l, prefilter_reason: 'company_excluded_by_user' };
  const prefilter = l.prefilter_reason || null;
  const state = viewState(l, { requests }), status = stateGroup(state), channel = applyChannel(l) || 'unknown';
  let session = null; try { session = channel === 'portal' ? portalSession(l, sessions) : null; } catch {} /* 兜底：门户登录记录读不出来就当没登录：按钮多给一个「登录」，不会少挡一道 */
  let ready = false; try { ready = channel === 'ats_form' && autoApplyReady(l); } catch {} /* 兜底：判断不了是不是能直接填的表就当不能：不会多给直接填表的那条路 */
  let applyHref = null; try { applyHref = applyUrl(l) || l.url || null; } catch { applyHref = l.url || null; }
  return { id: leadKey(l), number: l.number ?? null, company: l.company, role: l.role, city: (leadCity(l) !== '其他' ? leadCity(l) : (relocationCity(l) || l.judgement?.posting?.city || '其他')), location: l.location || '', verdict: prefilter ? 'prefiltered' : (l.match?.verdict || null), verdict_label: prefilter ? '预筛排除' : (VERDICT_LABEL[l.match?.verdict] || '未判断'), stage: boardStage(l, drafts, outbound), state, state_label: stateLabel(state), status, status_label: stateLabel(state), channel, channel_label: CHANNEL_LABEL[channel] || channel, email: l.email || null, auto_apply_ready: ready, portal_host: session?.domain || null, session_ok: !!session?.logged_in, apply_url: applyHref, sprint_hold: sprintHold(l, sprint), score: pickScore(l), source: sourceLabel(l), human: isHuman(l), url: l.url || null, fit: l.match?.fit ?? null, gap: short(l.match?.biggest_gap, 80), discovered_at: l.discovered_at || l.imported_at || null, replied_at: l.replied_at || null, closed_at: l.closed_at || null, feedback: feedbackText(l), prefilter_reason: prefilter, match_failed: !!(l.match_error_final && !l.match), salary: l.salary || null, auto_apply: l.auto_apply?.status || null, applied: outbound.some(o => o.record_id === leadKey(l)) };
}
// 查询语义（2026-09-21）：每个 key 可多值，同 key 之间取或、不同 key 之间取交集；
// 默认不看预筛、不看排除、不看冲刺 Backlog，要看就带 view=excluded / view=backlog；
// 结果先按公司分组，每家只留匹配分最高的前 per_company 条（3 / 10 / all），再按公司最高分排。
// 每条线索投影成一行要 ~0.4 ms（状态机、渠道、偏好分都在里面，偏好分每次还读一遍 preferences.json），
// 1800 条就是 0.7 秒。行只取决于这些文件，文件没变就复用上次投影的结果（最多 60 秒）。
export const LEAD_ROW_INPUTS = ['state/leads.ndjson', 'state/drafts.ndjson', 'state/outbound.ndjson', 'state/send-requests.ndjson', 'state/preferences.json', 'state/learned-prefilters.json', 'state/referrers.ndjson', 'state/referrer-search.json', 'config/pipeline.json', 'config/portal-sessions.json', 'config/concierge.json', 'config/quality-rules.json', 'candidate/facts.yaml'];
export function leadRows({ now = Date.now() } = {}) {
  return memoize('lead-rows', LEAD_ROW_INPUTS, () => {
    const leads = cachedLines('state/leads.ndjson'), drafts = cachedLines('state/drafts.ndjson'), outbound = cachedLines('state/outbound.ndjson'), requests = cachedLines('state/send-requests.ndjson');
    const ctx = { pipeline: read('config/pipeline.json', {}), sprint: citySprint(), sessions: loadPortalSessions() };
    return leads.filter(l => !l.superseded && l.status !== 'superseded' && l.match_status !== 'superseded').map(l => Object.freeze(leadRow(l, drafts, outbound, requests, ctx)));
  }, { maxAgeMs: 60000, now });
}
export function leadsQuery(q = {}, { now = Date.now(), limit = 120 } = {}) {
  const today = dayOf(now), text = String(q.q || '').trim().toLowerCase();
  const many = v => v == null || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
  const want = { city: many(q.city), verdict: many(q.verdict), stage: many(q.stage), source: many(q.source), company: many(q.company).map(x => x.toLowerCase()), status: many(q.status), channel: many(q.channel) };
  const view = q.view || (q.show === 'excluded' ? 'excluded' : '');
  let rows = leadRows({ now });
  if (!want.verdict.includes('prefiltered')) rows = rows.filter(r => r.verdict !== 'prefiltered');
  if (view === 'excluded') rows = rows.filter(r => r.verdict === 'exclude');
  else if (!want.verdict.includes('exclude')) rows = rows.filter(r => r.verdict !== 'exclude');
  if (view === 'backlog') rows = rows.filter(r => r.sprint_hold);
  else if (view !== 'excluded') rows = rows.filter(r => !r.sprint_hold);
  if (want.city.length) rows = rows.filter(r => want.city.some(c => r.city === c || (c !== '未写' && r.location.includes(c)) || (c === '未写' && !r.city)));
  if (want.verdict.length) rows = rows.filter(r => want.verdict.some(v => v === 'none' ? !r.verdict : r.verdict === v));
  if (want.stage.length) rows = rows.filter(r => want.stage.includes(r.stage));
  if (want.source.length) rows = rows.filter(r => want.source.includes(r.source));
  if (want.company.length) rows = rows.filter(r => want.company.includes(String(r.company || '').toLowerCase()));
  if (want.status.length) rows = rows.filter(r => want.status.includes(r.status));
  if (want.channel.length) rows = rows.filter(r => want.channel.includes(r.channel));
  if (q.human === '1' || q.human === true) rows = rows.filter(r => r.human);
  if (q.today === '1' || q.today === true) rows = rows.filter(r => dayOf(r.discovered_at) === today);
  if (q.failed === '1' || q.failed === true) rows = rows.filter(r => r.match_failed);
  // 「待处理」= 还没拍板的：状态 new 且没有 联系 / pass 决定；决定过的归 Reacher / Watch 的管线。
  if (q.open === '1' || q.open === true) rows = rows.filter(r => r.state === 'new');
  if (q.decided === '1' || q.decided === true) rows = rows.filter(r => r.state !== 'new');
  if (text) rows = rows.filter(r => [r.company, r.role, r.location, r.city, r.number, r.source, r.gap].join(' ').toLowerCase().includes(text));
  const count = fn => { const c = {}; for (const r of rows) { const k = fn(r) || '未写'; c[k] = (c[k] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]); };
  const facets = { city: count(r => r.city).slice(0, 10), verdict: count(r => r.verdict_label), stage: count(r => r.stage), source: count(r => r.source).slice(0, 10), status: count(r => r.status), channel: count(r => r.channel) };
  const rank = r => (r.verdict === 'recommend' ? 2 : r.verdict === 'verify' ? 1 : 0);
  const byScore = (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || rank(b) - rank(a) || (Number(b.fit) || 0) - (Number(a.fit) || 0) || String(b.discovered_at || '').localeCompare(String(a.discovered_at || ''));
  const total = rows.length;
  const per = !q.per_company || q.per_company === 'all' ? Infinity : Math.max(1, Number(q.per_company) || 3);
  const byCompany = new Map();
  for (const r of rows) { const k = String(r.company || '').toLowerCase(); if (!byCompany.has(k)) byCompany.set(k, []); byCompany.get(k).push(r); }
  const groups = [...byCompany.values()].map(g => { g.sort(byScore); return { rows: g.slice(0, per), hidden: Math.max(0, g.length - g.slice(0, per).length) }; }).sort((a, b) => byScore(a.rows[0], b.rows[0]));
  rows = groups.flatMap(g => g.rows);
  const lim = Math.min(500, Math.max(1, Number(q.limit) || limit));
  const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
  return { total, shown: rows.length, offset, has_more: offset + lim < rows.length, collapsed: groups.reduce((n, g) => n + g.hidden, 0), companies: groups.length, per_company: per === Infinity ? 'all' : per, view: view || null, rows: rows.slice(offset, offset + lim), facets, query: q };
}
// 「查看表单」：这条线索自动投递时会填什么。只读，不落盘。
export function applicationPlanView(id) {
  const key = String(id || '');
  const rows = cachedLines('state/leads.ndjson');
  const l = rows.find(x => leadKey(x) === key || x.id === key || String(x.number) === key);
  if (!l) throw Error('线索不存在');
  let plan = null, error = null;
  try { plan = applicationPlan(l); } catch (e) { error = e.message; }
  const f = plan?.fields || {};
  const entries = planRows(f); // 中文名字、说人话的值（lib/application-form.mjs planRows）
  // 实际执行到哪了：账上这条线索的预填 / 提交那件活（lib/actions.mjs）；没进账的老记录认线索上的 auto_apply.status（lib/status.mjs）。
  const job = J.latest({ target: `lead:${leadKey(l)}`, kind: ['prefill', 'submit'] }), st = job ? view(job) : l.auto_apply?.status && l.auto_apply.status !== 'not_started' ? legacyChip(l.auto_apply.status) : null;
  return { execution: { status: l.auto_apply?.status || 'not_started', state: st?.state || 'none', word: st ? st.word : l.auto_apply?.status && l.auto_apply.status !== 'not_started' ? '状态没认出来' : '还没开始填', ...(job?.reason ? { reason: view(job).reason } : {}), prefilled: l.computer_use?.reached === 'prefilled', browser: !l.computer_use?.browser || l.computer_use.browser === 'ego' ? 'chrome' : l.computer_use.browser, detail: waitingText(l.waiting_user) || (l.auto_apply?.error ? leadApplyWords(l.auto_apply).line : '') || l.computer_use?.message || '', evidence: l.computer_use?.evidence || l.auto_apply?.evidence || null }, number: l.number ?? null, company: l.company, role: l.role, url: plan?.url || l.application_url || l.url || null, resume: plan?.resume_absolute_path || null, fields: entries, error, channel: applyChannel(l) };
}
