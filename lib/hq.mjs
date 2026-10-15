// 指挥台 v2（2026-09-29）：处理线索、指挥团队的同一个地方。这里只算数据，页面（web/hq.js）只负责画。
//   需要你   只放真卡住、只有你能定的信：对方回复、面试、登录、扫描暂停、缺信息、材料变了 / 终审、卡住、
//            怎么推进、要你回答、没找到联系人、可以关掉。只在收件箱页答（同一份清单的键盘版）；
//            指挥台只指着它们（09-29 晚，design/hq-slim）：落在某一行上的（线索级）在那一行上，其余（成员级）
//            亮在等你的那位成员的卡片上；团队条最前面的「你」说一共几件、最急的是哪件。
//   流水线   每条线索一行：在推进的（lib/workflow.mjs applicationsView）+ 收件箱里等你筛选 / 拟投的新线索。
//            筛选、拟投、草稿、跟进这四种信不进「需要你」，就在它那一行上答——同一个 answerAsk，行为、回执、飞书都不变。
//   标签     一行有流水线上的信，信决定标签（筛选 → 新线索，拟投 / 草稿 → 待批准，跟进 → 等回复）；
//            没有，就看八列里当前走到哪一列。
//   团队     6 位成员（团队名册 lib/crew.mjs），每一行算在哪几位名下（row.members，表格按它筛）：当前这一步是谁的
//            （你的那几步算你答完接手的那位，lib/workflow.mjs stepMember）；新线索是 Lens 的（今天刚找到的也算 Scout 的）；
//            出错的那几行也算 Patch 的。执行器不是成员：它在做的那一行算请它做事的那位。
//   公司     每家公司一张小卡（Lens 的公司调研，lib/company-brief.mjs）：申请抽屉里放摘要和两三条要紧的事实。
import { TIERS, tierOfKind, tierView } from './status.mjs';
import { leadTag, VERDICT_WORD, verdictOf, VERDICT_KEYS } from './vocab.mjs';
import { href } from './routes.mjs';
import { tallyOf } from './tally.mjs';
import * as J from './jobs.mjs';
import { cachedLines } from './state-cache.mjs';
import { applicationsView, COLUMNS, PREFILTER_WORD, reasonOf, sourceLabel, cut, dayClock, plainMsg, stepMember, within, DAY } from './workflow.mjs';
import { lastRev } from './cards.mjs';
import { OPS } from './ops-table.mjs';
import { plainText } from './jargon.mjs';
import { read } from './store.mjs';
import { shortTitle } from './short-title.mjs';
import { agentPauses, agentPaused, EXECUTOR } from './agents.mjs';
import { CREW_IDS, JOB_MEMBER, OWNER, TEAM, crewOf, crewGroups, memberOfJob, faceOf, crewName } from './crew.mjs';
import { companyCard, researchCounts, loadBriefs, briefSettings } from './company-brief.mjs';
import { verifyGap, decisionPoints, recommendNote, firstRoundSummary, firstRoundLine, backlogNow, rejudgeState, firstRoundNeedIds } from './first-round.mjs';
import { requirementScore } from './matcher.mjs';
import { followupSource } from './followup-state.mjs';
import { contactLead, closedByUser, viewState } from './lead-state.mjs';
import { delivered } from './delivery.mjs';
import { applyChannel } from './apply-channel.mjs';
import { topBlocker } from './blockers.mjs';
import { currentFacts } from './facts.mjs';
import { noticeOnly } from './notices.mjs';
import { heldRec, hasJudgement } from './recommend-gate.mjs';
import { shelfOf, SHELF } from './shelf.mjs';
import { hqFilterFacts } from './hq-filters.mjs';
import { canonicalCompany, jobTitle } from './lead-fields.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { redact } from './error-evidence.mjs';
import { errorReason } from './say-error.mjs';
import { recommendationAsks, focusedRecommendations } from './recommend-summary.mjs';

// 排序用发生时间：后台判断/刷新不是跟进，待发送计划也不算联系发生。
const validAt = at => typeof at === 'string' && Number.isFinite(Date.parse(at));
export function leadActivityTimes(l, outbound = []) {
  const rid = l.record_id || l.id;
  const collected_at = [l.discovered_at, l.imported_at, l.created_at].find(validAt) || null;
  const sent = outbound.filter(o => o.record_id === rid && delivered(o, l)).map(o => o.at || o.sent_at || o.submitted_at);
  const activity_at = [...sent, l.replied_at, l.auto_apply?.status === 'submitted' ? l.auto_apply.submitted_at : null].filter(validAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  return { collected_at, activity_at };
}
function judgeRecovery(l, { outbound, drafts, requests, active, judgePending, currentOp, now }) {
  const failure = l.match_error_final || l.match_error;
  if (!failure || l.prefilter_reason || hasJudgement(l) || viewState(l, { requests }) !== 'new') return null;
  const rid = l.record_id || l.id;
  if (outbound.some(o => o.record_id === rid && delivered(o, l)) || drafts.some(d => d.record_id === rid && d.status === 'ready')) return null;
  // 批量 Judge 在运行并不能证明已轮到这条。单条操作没有 lead target，按同一 op 的 record_id + job_id 对账。
  const exactOp = currentOp?.op === 'judge-one' && currentOp.status === 'running' && [currentOp.record_id].flat().includes(rid);
  const work = active.filter(j => ['judge', 'judge-one', 'judge-leads', 'match'].includes(j.kind)
    && ['running', 'queued'].includes(j.state) && (j.target === `lead:${rid}` || (exactOp && j.id === currentOp.job_id)));
  const status = work.some(j => j.state === 'running') ? 'running' : work.length || judgePending.includes(rid) ? 'queued' : l.match_error_final ? 'stopped' : 'waiting';
  return { owner: 'system', status, reason: errorReason(redact(failure)), href: href.team('patch'),
    ...(!l.match_error_final && validAt(l.match_retry_at) && Date.parse(l.match_retry_at) > now ? { retry_at: l.match_retry_at } : {}) };
}

// ── 信：哪一种、在哪儿答 ──────────────────────────────────────────────────────
// 流水线上的四种：在这一行上答，决定这一行在哪个标签。
export const PIPE_TAB = { triage: 'new', apply: 'approve', draft: 'approve', followup: 'waiting' };
// 「需要你」：rank 小的在前（有人在等你 → 机器停了 → 卡在提交前 → 要你定路子 → 可以关掉的）；
// row：这一行「现在」那一格的字段（结构化的短词：待…、缺…，不是一句话）；go：这一行上的按钮（动词或动词 + 宾语，
// 和别的行的按钮一个样子；打开岗位页，回答表单在最上面）；
// tone：sys 是系统那边停了，good 是好消息。
export const BLOCKERS = {
  reply: { tag: '对方回复', rank: 0, row: '待回复', go: '回复' },
  interview: { tag: '面试', rank: 1, row: '面试待确认', go: '查看' },
  login: { tag: '要你登录', rank: 2, row: '待登录', go: '登录' },
  // 「还差几步，就能用上全部功能」（lib/unlock.mjs）：要登录的站、接邮箱、配对手机的清单。放在「登录」标签里、排在最前（第 6b 轮：
  // 原来算「要你回答」，排在收件箱快到底的地方，负责人找不到）。不落在某一行上，算在 System 名下。
  unlock: { tag: '还差几步', rank: 1, row: '', go: '看清单' },
  paused: { tag: '扫描暂停', rank: 2, tone: 'sys', row: '扫描暂停', go: '查看' },
  // tag 和收件箱的标签同名（10-01 第 2 轮验收第 27 条：标签叫「补充信息」，分组和信头叫「缺信息」）；row 是「现在」那一格的状态词，照旧。
  fields: { tag: '补充信息', rank: 3, row: '缺信息', go: '补信息' },
  reapprove: { tag: '材料变了', rank: 4, row: '待重新确认', go: '重新确认' },
  // 批准超过 24 小时还没做的发信、私信、预填、提交（lib/stale-approvals.mjs）：不自动做，等你按现在的内容再确认。
  stale: { tag: '批准很久了', rank: 4, row: '待重新确认', go: '再看一眼' },
  final: { tag: '终审', rank: 4, row: '待终审', go: '终审' },
  page: { tag: '要你动手', rank: 4, row: '待你操作', go: '处理' },
  blocked: { tag: '卡住了', rank: 5, tone: 'sys', row: '卡住', go: '处理' },
  route: { tag: '怎么推进', rank: 6, row: '待定路线', go: '定路线' },
  question: { tag: '要你回答', rank: 7, row: '待回答', go: '回答' },
  stalled: { tag: '没找到联系人', rank: 8, row: '缺联系人', go: '定路线' },
  recovered: { tag: '可以关掉', rank: 9, tone: 'good', row: '', go: '关闭' },
  // Patch 的记账（lib/spend.mjs）：今天的花费上限到了；省钱档里按标题挑新线索。两种都不落在某一行上（成员级），
  // row 用不上；亮在等你的那位成员的卡片上：花费上限是 Patch 的（它记账），按标题挑是 Lens 的（判断前先按标题挑一遍），
  // 见下面的 WAITS_ON.kind。发信人（system / radar）不看：radar 经名册会落到 Scout。
  budget: { tag: '花费上限', rank: 2, tone: 'sys', row: '', go: '决定' },
  skim: { tag: '按标题挑', rank: 6, row: '', go: '挑选' },
  // 任务板上的目标停下来问你（岗位下线了、Judge 判断为排除、链接没收成）：还投不投。算在停下来那一棒的主人名下。
  goal: { tag: '还投吗', rank: 5, row: '待定去留', go: '回答' },
  // 代码守卫拦下了执行器改代码（bin/host/code-guard.mjs）：已经存档、还原，告诉你一声。不落在某一行上。
  codeguard: { tag: '拦下改代码', rank: 5, tone: 'sys', row: '', go: '查看' },
  // BOSS 聊天列表上对不上岗位的新消息（lib/boss-inbox.mjs 合成一封），和招聘方主动找你、你还没读的（lib/boss-inbound.mjs，一个对话一封）：
  // 有人在等你回，排在面试一档；算在 Watcher 名下。
  bosschat: { tag: 'BOSS 新消息', rank: 1, row: '', go: '查看' },
  // 脉脉消息列表（lib/maimai-inbox.mjs）和 LinkedIn 私信通知邮件（lib/linkedin-mail.mjs）里对不上岗位的，一样排在面试一档，算在 Watcher 名下。
  maimaichat: { tag: '脉脉新消息', rank: 1, row: '', go: '查看' },
  linkedinmsg: { tag: 'LinkedIn 新消息', rank: 1, row: '', go: '查看' },
  // 内置邮箱（lib/mail/asks.mjs）：批准了的邮件发不出去（没接邮箱、只能收信、被扣着）挡着已经批准的事；对不上岗位的招聘来信、
  // 没判断的信只是告诉你一声。各成一类，好让收件箱分档时整类一起走（不把同一个标签拆成两段）。
  mailblock: { tag: '邮件发不出去', rank: 2, tone: 'sys', row: '', go: '处理' },
  mailnote: { tag: '招聘来信', rank: 9, row: '', go: '查看' },
  applywork: { tag: '投递进展', rank: 9, row: '预填处理中', go: '查看任务' },
};
// 收件箱的四档（负责人 10-04：「系统通知要用不同的颜色去提示，现在都是一个颜色，分辨不出优先级」）。一封信归哪一档按它的类别定：
//   block  挡路：不处理，有活就停在那儿（要你登录、批准了的邮件发不出去、花费上限、扫描暂停、卡住的活）；
//   reply  等你回：有人在等你（对方回复、面试邀约、BOSS / 脉脉 / LinkedIn 新消息）；
//   decide 要你拍板：你不点，那件事就不往下走，但别的活照跑（终审、待批准的私信和投递、补信息、走哪条路、还差几步……）；
//   note   知会：只是告诉你一声（可以关掉的、拦下改代码、对不上岗位的招聘来信和拒信、没判断的信）。
// 档按信的类别定（一类只在一档里），收件箱先按档、再按类别排：同一个标签只出现一段（10-01 第 1 轮 #22），每档一种颜色，也写字（web/inbox.js）。
// 档的表和词在 lib/status.mjs（全系统一份），这里只按类别取。
export { TIERS };
export const tierOf = (a = {}, kind = askKind(a)) => tierOfKind(kind);
const tierRank = (a, kind) => TIERS[tierOf(a, kind)].rank;
export function askKind(a = {}, { jobKind = () => null } = {}) {
  const id = String(a.id || '');
  if (/^apply-work:/.test(id)) return ['failed', 'waiting_you'].includes(a.work_state) ? 'blocked' : 'applywork';
  if (/^tailored:/.test(id)) return 'reapprove';
  if (a.blocked_send) return 'blocked';
  if (a.type === 'triage') return 'triage';
  if (a.type === 'followup') return 'followup';
  if (/^apply:/.test(id)) return 'apply';
  if (/^draft:/.test(id)) return 'draft';
  if (a.type === 'interview') return /^interview:reply:/.test(id) ? 'reply' : 'interview';
  if (a.type === 'login') return 'login';
  if (id === 'unlock') return 'unlock';
  if (/^builtin-mail-(none|send-blocked|held)(:|$)/.test(id)) return 'mailblock';
  if (/^builtin-mail(-guess)?:/.test(id)) return 'mailnote';
  if (/^recovered:/.test(id)) return 'recovered';
  if (/^need:.*:info$/.test(id)) return 'fields';
  // 执行器停下来要你确认才继续：扫真人帖的浏览器被你接管了是「扫描暂停」，别的是执行器在问。
  if (/^need:job:.*:approve$/.test(id)) return /^discover/.test(jobKind(a.job_id) || '') ? 'paused' : 'question';
  if (/^need:lead:.*:approve$/.test(id)) return 'page';
  if (/^reapprove:/.test(id)) return 'reapprove';
  if (/^(final|prefilled|submit):/.test(id)) return 'final';
  if (/^stalled:/.test(id)) return 'stalled';
  if (/^blocked:/.test(id)) return 'blocked';
  if (/^budget:/.test(id)) return 'budget';
  if (/^goal:/.test(id)) return 'goal';
  if (/^codeguard:/.test(id)) return 'codeguard';
  if (/^boss-(?:chat|inbound):/.test(id)) return 'bosschat';
  if (/^maimai-chat(?:-blocked)?:/.test(id)) return 'maimaichat';
  if (/^linkedin-mail:/.test(id)) return 'linkedinmsg';
  if (/^skim:/.test(id)) return 'skim';
  if (/^stale:/.test(id)) return 'stale';
  if (/^city:/.test(id) || a.type === 'decide') return 'route';
  return 'question';
}
export const isPipeline = kind => Object.hasOwn(PIPE_TAB, kind);
const confirmOf = o => o.confirm_inline || (o.steps || []).some(s => s.confirm === 'inline') ? 'inline' : (o.steps || []).some(s => s.confirm === true) ? 'server' : null;
const onlyOpens = o => !!o.steps?.length && o.steps.every(s => ['open', 'application_page', 'reveal_resume'].includes(s.type));
// 页面要的一封信：不带步骤（执行什么由服务端按当前数据重新算，answerAsk），只带问法、选项和看得见的内容。
export function askOut(a, kind) {
  const b = BLOCKERS[kind];
  return {
    id: a.id, type: a.type, kind, lane: isPipeline(kind) ? 'pipeline' : 'blocker', tag: b?.tag || null, tone: b?.tone || null, rank: b?.rank ?? null,
    row: kind === 'fields' && a.form?.length ? `缺 ${a.form.length} 项信息` : b?.row || null, go: b?.go || null,
    from: a.from || 'system', title: a.title || '', question: a.question || '', context: a.context || [], note: a.note || '', detail: a.detail && a.detail !== a.note ? a.detail : '',
    ...(a.judgement_stopped ? { judgement_stopped: true } : {}),
    options: (a.options || []).map(o => ({ key: o.key, label: o.label, primary: !!o.primary, danger: !!o.danger, hint: o.hint || '', reasons: o.reasons || null, input: o.input || null, confirm: confirmOf(o), opens: onlyOpens(o), preview: o.preview || null, href: /^https:\/\/[^\s"'<>]+$/.test(o.href || '') ? o.href : null })),
    other: a.other ? { placeholder: a.other.placeholder || '' } : null,
    form: Array.isArray(a.form) ? a.form.map(f => ({ key: f.key, label: f.label, type: f.type || 'text', options: f.options || null, value: f.value ?? null, remembered: !!f.remembered })) : null,
    changes: a.changes || null, preview: a.preview || null, facts: a.facts || [], account: a.account || null, affected: a.affected || null,
    url: a.url || null, form_preview: a.form_preview || null, due_at: a.due_at || null,
    lead: a.lead ? { number: a.lead.number ?? null, company: a.lead.company || '', role: a.lead.role || '', rid: a.lead.record_id || null } : null,
  };
}
// 一件「需要你」的全文（悬停时看）：比原问题短、说清楚卡在哪。
function lineOf(a, kind, row) {
  // 信里的话已经是收件箱整理过的人话（lib/asks.mjs），这里不再过一遍：「ego 浏览器」要照原样留着。
  if (kind === 'reply') { const s = row?.steps.find(x => x.key === 'reply'); return s?.note && s.note !== s.ask_text ? s.note : a.question || ''; }
  if (kind === 'fields' && a.form?.length) return `要补 ${a.form.length} 项：${a.form.map(f => f.label).join('、')}`;
  if (kind === 'stalled') return '没找到公开联系人，换个方式推进吗？';
  if (kind === 'reapprove') return a.changes?.length ? `批准后${a.changes.join('；')}，要按现在的材料重新确认` : '批准后申请入口或简历变了，要按现在的材料重新确认';
  return a.question || '';
}
// 「你」卡片上「最急：…」那一句：哪一条 + 卡在哪（#119 网易 缺 1 项信息）。卡在哪用分类的名字（对方回复、终审……），
// 和收件箱里的分组是同一套话，点过去就在那一组里。没有线索的，信的标题就是主语（登录 BOSS 直聘、真人帖扫描……）。
const tagOf = kind => BLOCKERS[kind]?.tag || DESK_ALSO[kind] || '';
function briefOf(a, kind) {
  const what = kind === 'fields' && a.form?.length ? `缺 ${a.form.length} 项信息` : tagOf(kind);
  if (a.lead?.company) return `${leadTag(a.lead)} ${what}`;
  if (kind === 'login') return a.title || what;
  if (kind === 'paused') return `${a.title || '扫描'}暂停了`;
  if (kind === 'recovered') return `${a.title || '服务'}已恢复，可以关掉提醒`;
  return `${a.title || what}：${shortTitle(a.question, { max: 22, ask: true }) || cut(a.question, 30)}`;
}
// 成员卡片上「等你：…」那一句（成员级的卡点）：继续扫描？/ 登录 BOSS 直聘 / 执行器的原问题。
function waitOf(a, kind) {
  if (kind === 'paused') return '继续扫描？';
  if (kind === 'login') return a.title || BLOCKERS.login.tag;
  if (kind === 'recovered') return '关掉已恢复的提醒？';
  // 执行器的原话常常一大段（10-01：团队卡片上截成两行）：只要在问你的那一句的短标题，原话在详情里（title / line）。
  return a.lead?.company ? briefOf(a, kind) : shortTitle(a.question || a.title, { max: 22, ask: true }) || cut(a.question || a.title, 40);
}
// 谁在等你：信 → 成员 id（团队名册 lib/crew.mjs 的 6 位）。是数据，不写死有几位成员。按这个顺序认：
//   kind      这一类信永远是某一位的：扫描暂停是 Scout 的真人帖扫描停了（信是执行器发来的）；没找到联系人是 Quill 在找；
//             流水线上的四种（在行上答，团队条数信用）：筛选是 Lens 判完交给你的，拟投和草稿是 Quill 的，跟进提醒是 Owl 的；
//             花费上限（budget）是 Patch 的；省钱档的按标题挑（skim，判断之前）是 Lens 的，虽然信是 radar 发的；
//   job       带着交办任务的（need:job:<id>:…、blocked:<id>、job:<id>，或者信里的 job_id）：按任务的种类归请执行器做这件事
//             的那位（lib/crew.mjs JOB_MEMBER：discover* → Scout，company_brief / role_prep → Lens，投递和联络的 → Quill，
//             面试的 → Owl，system_fix → Patch；认不出的种类 → Patch）。09-29 生产上：卡住的真人帖扫描（discover_human_opportunities，
//             blocked:…，发信的是执行器）原来落在 System 卡上，应该是 Scout 的；
//   usual     没挂任务时，这一类通常是谁的：表上缺信息、页面上要你动手、终审、材料变了要重新确认（守门规则）、怎么推进（定路线）
//             都是 Quill 在递的时候停下来的；面试的事是 Owl 的。发信的写成执行器也照这个认，不再落到 Patch；
//   from      再看发信的是谁（lib/asks.mjs 的 from，飞书卡片的老角色：登录信按它挡住的是投递还是扫描；执行器的问题、
//             系统修复、「可以关掉」是 System），经名册换成成员（radar → Scout，reacher → Quill，watch → Owl，system → Patch）；
//   fallback  都认不出来的归 Patch。
// 名册换了、这张表改了，页面只按 id 画。
export const WAITS_ON = {
  kind: { unlock: 'patch', mailblock: 'owl', mailnote: 'owl', paused: 'scout', stalled: 'quill', triage: 'lens', apply: 'quill', draft: 'quill', followup: 'owl', budget: 'patch', skim: 'lens', codeguard: 'patch', bosschat: 'owl', maimaichat: 'owl', linkedinmsg: 'owl' },
  job: JOB_MEMBER,
  usual: { fields: 'quill', page: 'quill', final: 'quill', reapprove: 'quill', stale: 'quill', route: 'quill', interview: 'owl' },
  fallback: 'patch',
};
// 信挂着哪件交办任务：字段 job_id，或者从信的 id 里读（need:job:<id>:… / blocked:<id>（队列里的 id 也带 blocked: 前缀）/ job:<id>）。
export const jobIdOf = (a = {}) => a.job_id || /^need:job:([^:]+):/.exec(a.id || '')?.[1] || /^(?:blocked:)+(.+)$/.exec(a.id || '')?.[1] || /^job:(.+)$/.exec(a.id || '')?.[1] || null;
// jobOf(id) → 那件任务（{ kind, thread … }），认不出就是 null。
export function memberOf(a = {}, kind = askKind(a), { jobOf = () => null, members = CREW_IDS, map = WAITS_ON } = {}) {
  const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : null;
  if (own(map.kind, kind)) return map.kind[kind];
  const job = jobOf(jobIdOf(a));
  if (job) return own(map.job, job.kind) || (job.kind === 'user_request' ? memberOfJob(job) : map.fallback);
  if (own(map.usual, kind)) return map.usual[kind];
  const from = crewOf(a.from);
  return members.includes(from) ? from : map.fallback;
}

// ── 每一行在哪个标签 ─────────────────────────────────────────────────────────
// 八列：0 发现 1 判断 2 筛选 3 准备 4 批准 5 递出 6 回复 7 面试。
const COL_OF = Object.fromEntries(COLUMNS.flatMap((c, i) => c.steps.map(s => [s, i])));
COL_OF.result = 7;
// 待核（10-02 N13）：等你筛的新线索里判成待核的单放一个标签（首轮多半全是待核），行上写还差什么。
export const TABS = [['new', '新线索'], ['verify', '待核'], ['approve', '待批准'], ['moving', '进行中'], ['waiting', '等回复'], ['interview', '面试/Offer'], ['ended', '已结束'], ['all', '全部']];
export function tabOf(row = {}, pipeKind = null) {
  if (row.ending && row.ending !== 'offer') return 'ended';
  if (pipeKind === 'triage' && row.verdict === 'verify') return 'verify';
  if (row.state === 'replied' || (row.current === 'reply' && row.current_status === 'done')) return 'moving';
  if (pipeKind && PIPE_TAB[pipeKind]) return PIPE_TAB[pipeKind];
  const col = COL_OF[row.current] ?? 0;
  if (row.ending === 'offer' || col === 7) return 'interview';
  if (col === 6) return 'waiting';
  if (col <= 2) return 'new';
  if (col === 4 && row.current_status === 'waiting_you') return 'approve';
  return 'moving';
}
// 没有提问也能查看/重试当前进度；这些是岗位动作，不另发收件箱信。
function rowRecovery(l, r, { outbound, drafts, active, jobs, now }) {
  if (r.ending || r.number == null) return { row_actions: [], followup_note: '' };
  const rid = r.rid, end = { key: 'end', label: '不投' };
  const work = active.find(j => j.target === `lead:${rid}`) || [...jobs].reverse().find(j => (j.record_id === rid || j.number === l.number) && ['pending', 'working'].includes(j.status));
  if (work?.kind === 'prepare_followup' && work.state) return { row_actions: [{ key: 'working', label: '正在起草跟进', disabled: true }, end], followup_note: '跟进请求正在处理，尚未发出。' };
  if (work) return { row_actions: [{ key: 'task', label: '查看任务', href: href.tasks({ lead: rid }) }, end], followup_note: r.tab === 'waiting' ? '这条岗位有任务正在处理，可以查看进度。' : '' };
  if (r.tab === 'waiting') {
    if (l.contact_hold) return { row_actions: [end], followup_note: '你暂停了联系，等对方回复。' };
    if (l.followup_paused) return { row_actions: [{ key: 'resume_followup', label: '恢复跟进提醒', command: `${l.number} 恢复提醒` }, end], followup_note: '你选择了不跟，不再提醒跟进；对方的新回复和面试仍会通知你。' };
    const draft = drafts.find(d => d.record_id === rid && d.purpose === 'followup' && d.status === 'ready');
    if (draft) return { row_actions: [{ key: 'draft', label: '查看草稿', href: href.inbox(`draft:${draft.draft_id}`) }, end], followup_note: '跟进草稿已写好，尚未发出。' };
    const source = followupSource(l, outbound);
    if (source.application) {
      const url = [l.application_url, l.auto_apply?.url, l.url].find(u => /^https?:\/\/[^\s"'<>]+$/.test(u || ''));
      return { row_actions: [...(url ? [{ key: 'application', label: '打开申请页', href: url, external: true }] : []), end], followup_note: source.reason };
    }
    // 五工作日只决定自动提醒；主人主动起草不受等待天数限制，仍须有可接续的真实会话。
    const reason = source.reason || '';
    return { row_actions: [{ key: 'followup', label: '起草跟进', command: `${l.number} 跟进`, disabled: !!reason, reason }, { key: 'hold', label: '不跟', command: `${l.number} 暂停提醒` }], followup_note: reason || (l.follow_up_at ? '之前请求过跟进，但还没有草稿，可以重新起草；尚未发出。' : '起草后先给你审阅，尚未发出。') };
  }
  if (contactLead(l)) return { row_actions: [{ key: 'contact', label: '重新准备联系', command: `${l.number} 联系` }, end], followup_note: '' };
  return { row_actions: [end], followup_note: '' };
}
function clearGap(l, facts, rejudge) {
  const gap = verifyGap(l, facts, rejudge);
  if (['rejudge', 'jd', 'client_company'].includes(gap.key)) return gap;
  const points = decisionPoints(l, facts);
  return points.length ? { ...gap, text: `需确认：${points[0].text}`, title: points.map(p => p.text).join('；') } : gap;
}
// 全部标签里：走得最远的公司在前（面试 → 等回复 → 进行中 → 待批准 → 新线索 → 已结束）。
export const STAGE_RANK = { interview: 0, waiting: 1, moving: 2, approve: 3, new: 4, verify: 4, ended: 5 };
// 团队条上每位的一句筛选说明和数的单位（数 = 算在它名下的行；Scout 是今天新找到的，Tailor 是几份简历，Patch 是严重告警）。
export const AGENTS = {
  scout: { chip: '今天新找到的', unit: '今天新找到' },
  lens: { chip: '新线索 · 判断', unit: '待筛选' },
  tailor: { chip: '简历（在「材料」页）', unit: '份简历' },
  quill: { chip: '准备 · 待批准 · 递出中', unit: '在手' },
  owl: { chip: '回复 · 面试', unit: '在等' },
  patch: { chip: '告警和卡住的', unit: '严重告警' },
};
// 一行算在哪几位名下（表格按成员筛、右侧面板数「在手」都用它）。
export function rowMembers(row = {}, { fresh = false } = {}) {
  const m = new Set();
  const cur = row.ending && row.ending !== 'offer' ? null : stepMember(row.current);
  if (cur) m.add(cur);
  if (row.tab === 'new' || row.tab === 'verify') { m.add('lens'); if (fresh) m.add('scout'); }
  if (row.trouble) m.add('patch');
  return CREW_IDS.filter(k => m.has(k));
}

// ── 现在在跑什么 ─────────────────────────────────────────────────────────────
// 指挥台（空表时的「正在找第一批岗位」、页头的在跑、「让 Radar 找岗位」换成「X 在跑」）和对话里「现在怎么样」
// （lib/talk.mjs statusDigest）读的是这同一份，只在这里算（10-01 开箱测试 #5 #6）。
// 查账（线 S）：账上 running 的活（lib/jobs.mjs），不读操作记录和成员的「现在」文字。
//   op        这件活往上找到头（parent）是操作台的一项（ref op:<记录 id> 或 queue:<排队 id>，kind 是 OPS 里的名字：round-first、round-scout…）就是那一项；
//             周期的步 kind 也叫 discover、match，没有 op: 的 ref，不算操作台的一项。
//             周期每一步是周期那件活下面的子活（lib/cycle-ledger.mjs），周期由操作台起的（RADAR_JOB_ID）也往上找得到。
//   挑哪件    Radar、Judge 的先（算「在找」）；其次操作台起的那一项；别的成员手上的卡不算页头的「在跑」。
//   进度      这一项开始以后新找到的线索（discovered_at / imported_at 在那之后）；Judge 这一批判了几个（matched_at 在
//             这一批开始之后），这一批一共几个来自 bin/match.mjs 开始时记下的 state/match-progress.json（没有就只说判了几个）。
export const MATCH_PROGRESS = 'state/match-progress.json';
const after = (t, since) => !!t && Date.parse(t) >= since;
export function runningNow({ jobs = J.list({ state: 'running', limit: 50 }), leads = [], progress = null, now = Date.now(), getJob = J.get } = {}) {
  const byId = new Map((jobs || []).map(j => [j.id, j]));
  const rootOf = j => { let r = j; for (let i = 0; i < 6 && r?.parent; i++) { const p = byId.get(r.parent) || getJob(r.parent); if (!p) break; r = p; } return r; };
  const cands = (jobs || []).filter(j => j.state === 'running' && j.kind !== 'cycle').map(j => { const root = rootOf(j); return { j, root, op: /^(?:op|queue):/.test(root.ref || '') && Object.hasOwn(OPS, root.kind) ? root.kind : null }; })
    .filter(c => ['scout', 'lens'].includes(c.j.member) || c.op);
  const rank = c => (['scout', 'lens'].includes(c.j.member) ? 0 : 2) + (c.op ? 0 : 1);
  const pick = cands.sort((a, b) => rank(a) - rank(b) || Date.parse(b.j.started_at || 0) - Date.parse(a.j.started_at || 0))[0];
  if (!pick) return null;
  const { j, root, op } = pick, o = op ? OPS[op] : null;
  const run = op
    ? { op, label: o.label || root.title || op, member: crewOf(o.role || root.member || 'patch') || 'patch', started_at: root.started_at || j.started_at || null }
    : { op: null, label: j.title, member: j.member, started_at: j.started_at || null };
  run.member_name = crewName(run.member);
  run.finding = run.member === 'scout';
  if (!['scout', 'lens'].includes(run.member)) return run;
  const since = Date.parse(run.started_at || '');
  if (!Number.isFinite(since)) return run;
  const live = leads.filter(l => !l.superseded);
  run.found = live.filter(l => after(l.discovered_at || l.imported_at, since)).length;
  const batch = progress && after(progress.started_at, since) ? progress : null, from = batch ? Date.parse(batch.started_at) : since;
  const judged = live.filter(l => l.match?.verdict && after(l.matched_at, from));
  const verdicts = {}; for (const l of judged) verdicts[l.match.verdict] = (verdicts[l.match.verdict] || 0) + 1;
  Object.assign(run, { judged: judged.length, total: Number(batch?.total) || null, verdicts, judge_name: crewName('lens') });
  return run;
}
// 进度说成一句（「找到 792 个 · Judge 判了 6/15」）；long 时带上各判成什么（「（待核 5、排除 1）」）。
export function runProgress(run, { long = false, sep = ' · ' } = {}) {
  if (!run) return '';
  const parts = [];
  // 找到的多、这一批只判一部分时说清两个数的关系（第 4 轮 F09：「找到 434 个 · Judge 0/15」看不出 15 是什么）。
  if (run.found) parts.push(`${long ? run.member_name + ' ' : ''}找到 ${run.found} 个${run.total && run.total < run.found ? `，先判最对口的 ${run.total} 个` : ''}`);
  if (run.judged || run.total) {
    const vs = Object.entries(VERDICT_WORD).filter(([k]) => run.verdicts?.[k]).map(([k, w]) => `${w} ${run.verdicts[k]}`);
    parts.push(`${run.judge_name} 判了 ${run.judged}${run.total ? `/${run.total}` : ''}${long && vs.length ? `（${vs.join('、')}）` : ''}`);
  }
  return parts.join(sep);
}

// 收起来的那一行写的原因：不是岗位的写哪一种；不对口的写规则的话（「级别偏高」「你排除了这家公司」）。
const SHELF_WHY = { exclude: '判断不合适', direction: '方向不对', rules_now: '按你现在的规则不该投' };
const shelfWhy = s => s.kind === 'not_job' ? s.why : PREFILTER_WORD[s.why] || SHELF_WHY[s.why] || SHELF.off;
const listJudgementReason = l => {
  if (l.prefilter_reason) return PREFILTER_WORD[l.prefilter_reason] || '不符合筛选条件';
  if (reasonOf(l)) return reasonOf(l);
  const error = l.match_error_final || l.match_error;
  if (error) return cut(`${l.match_error_final ? '判断未完成，需处理后重试' : '判断暂未完成'}：${errorReason(redact(error))}`, 120);
  return hasJudgement(l) ? '判断没有附具体理由' : '尚无判断结论，不能据此认定适合或不适合';
};


// ── 汇总 ─────────────────────────────────────────────────────────────────────
// center：commandCenter()；inbox：inboxView()（全部的信，流水线的也在里面）；team：teamView()。
// input：交给 applicationsView 的原始行（测试用；不给就读 state/）。
export function hqView({ center = {}, inbox = {}, team = { workers: [], status: {} }, now = Date.now(), input = {} } = {}) {
  const leads = input.leads || cachedLines('state/leads.ndjson'), jobs = input.jobs || cachedLines('state/host-jobs.ndjson');
  const referrers = input.referrers || cachedLines('state/referrers.ndjson');
  const jobById = new Map(lastRev(jobs).map(j => [j.id, j])), jobOf = id => (id && jobById.get(id)) || null;
  const all = inbox.asks || [];
  const kinds = new Map(all.map(a => [a.id, askKind(a, { jobKind: id => jobOf(id)?.kind })]));
  // 每条线索的信（收件箱的顺序）；登录信按它挡住的线索算，排在这条线索自己的信后面。
  const own = new Map(), logins = new Map(), add = (m, rid, a) => { if (!rid) return; const list = m.get(rid) || m.set(rid, []).get(rid); if (!list.includes(a)) list.push(a); };
  for (const a of all) { add(own, a.lead?.record_id, a); if (a.type === 'login') for (const i of a.affected || []) add(logins, i.record_id, a); }
  const byId = new Map(all.map(a => [a.id, a]));
  // 新线索：等你筛选 / 拟投的，以及初筛未排除、还在等 Judge 的新记录，也各占一行。
  // 未判断的以 lead_only 显示“待判断”，不因预写草稿变成“已开始联系”，也不藏到“全部”里。
  const fresh = new Set(all.filter(a => ['triage', 'apply'].includes(kinds.get(a.id))).map(a => a.lead?.record_id).filter(Boolean));
  const apps = applicationsView({ ...input, asks: all, now }, { closed: true, limit: Infinity, include: e => fresh.has(e.rid) || (e.stage === 'pool' && !e.l.prefilter_reason && !hasJudgement(e.l)) });
  const leadBy = new Map(leads.filter(l => !l.superseded).map(l => [l.record_id || l.id, l]));
  const facts = input.facts || currentFacts(), rejudge = rejudgeState();
  const outbound = input.outbound || cachedLines('state/outbound.ndjson'), drafts = input.drafts || cachedLines('state/drafts.ndjson');
  const active = input.active_jobs || J.list({ state: ['queued', 'running'], limit: 500 }), busyLeads = new Set(active.map(j => j.target).filter(Boolean));
  const pending = input.judge_pending ?? read('state/judge-pending.json', {})?.records;
  const recoveryContext = { outbound, drafts, active, requests: input.requests || cachedLines('state/send-requests.ndjson'),
    judgePending: Array.isArray(pending) ? pending : [], currentOp: center.ops?.current, now };
  // 收起来的（lib/shelf.mjs：不是岗位、不对口，又没真的发出去过）：不进各标签、「全部」和账上的数，收在「全部」最后。
  const shelf = new Map();
  for (const [rid, l] of leadBy) { const s = shelfOf(l); if (s) shelf.set(rid, s); }
  const rows = apps.rows.filter(r => !shelf.has(r.rid)).map(r => {
    // 先看八列上当前这一步对上的那封信（lib/workflow.mjs），再看这条线索自己的，最后是挡住它的登录信。
    const mine = [byId.get(r.ask), ...(own.get(r.rid) || []), ...(logins.get(r.rid) || [])].filter(Boolean);
    const pipe = mine.find(a => isPipeline(kinds.get(a.id))) || null, block = r.ending ? null : mine.find(a => !isPipeline(kinds.get(a.id)) && !noticeOnly(a)) || null;
    const l = leadBy.get(r.rid) || {}, tab = tabOf({ ...r, state: l.state, verdict: l.match?.verdict || null }, pipe && kinds.get(pipe.id));
    // 有人在替这一行做事（预填、提交、准备材料……）：账上对着这条线索（target lead:<rid>）有排着或在做的活。
    const running = !r.ending && busyLeads.has(`lead:${r.rid}`);
    const trouble = r.tone === 'bad' && !r.ending;
    // 岗位名给全名（lib/workflow.mjs 的行把它截到 60 个字）：怎么折行、截不截由页面按宽度定（第 2 轮新 1、新 4）。
    return {
      rid: r.rid, number: r.number, company: /^待核/.test(r.company) ? r.company : canonicalCompany(r.company), poster: l.author || null, role: jobTitle(l.applied_role || l.role || r.role, l.jd_text), city: r.city, ...hqFilterFacts(l, referrers), channel: r.channel, channel_short: r.channel_short, channel_label: r.channel_label,
      verdict: l.match?.verdict || null, reason: reasonOf(l) || '', judgement_reason: listJudgementReason(l), source: sourceLabel(l),
      // 待核还差什么（「工作许可没填」），行上「现在」一格写它；fill：能在设置里补的那一组（行上多一个「补信息」）。
      gap: l.match?.verdict === 'verify' && !r.ending ? clearGap(l, facts, rejudge) : null,
      // 推荐里还要你确认的那一项、年限差一点（判断规则 1、2，lib/first-round.mjs recommendNote）：行上「现在」一格写短词。
      note: l.match?.verdict === 'recommend' && !r.ending ? recommendNote(l, facts) : null,
      // 匹配度（D4，lib/matcher.mjs requirementScore）：判过的都有；行上只在「推荐」旁边显示，岗位页「判断」旁边都显示。
      score: l.match ? requirementScore(l.match, facts) : null,
      // 有结论就是已判：待核由主人决定，旧版本排着重判；没结论的岗位页才给「先判断」。
      judged: !!l.prefilter_reason || hasJudgement(l),
      judge_recovery: judgeRecovery(l, recoveryContext), ...leadActivityTimes(l, outbound),
      cols: r.cols, steps: r.steps, current: r.current, current_status: r.current_status, text: r.text, now: r.now, needs_you: r.needs_you, tone: r.tone, ending: r.ending,
      at: r.at, when: r.when, attempts: (r.attempts || []).slice(0, 6), reply: l.reply_summary ? cut(plainText(l.reply_summary), 160) : '',
      ...(!pipe && !block ? rowRecovery(l, { ...r, tab }, { outbound, drafts, active, jobs: [...jobById.values()], now }) : { row_actions: [], followup_note: '' }),
      tab, running, trouble, lead_only: !!r.lead_only,
      pipe: pipe?.id || null, pipe_kind: pipe ? kinds.get(pipe.id) : null, block: block?.id || null, block_kind: block ? kinds.get(block.id) : null,
      // 组内排序：这一段的活在前，其次卡住等你回答的，系统自己在做的最后。
      act: pipe ? 0 : block ? 1 : 2,
    };
  }).map(r => { const members = rowMembers(r, { fresh: within(leadBy.get(r.rid)?.discovered_at || leadBy.get(r.rid)?.imported_at, DAY, now) }); return { ...r, members, owner: members[0] || null }; });
  const rowByRid = new Map(rows.map(r => [r.rid, r]));
  // 页面要的信：「需要你」全部 + 各行流水线上的那一封。
  // 「需要你」分两种：线索级的落在某一行上（那一行的 block，「现在」一格 + 去补 / 去终审），
  // 其余是成员级的（扫描暂停、登录、执行器没头没尾的问题……），亮在等你的那位成员的卡片上。
  const onRow = new Set(rows.map(r => r.block).filter(Boolean));
  // 「等你」只有一份：收件箱那张单子（deskInbox，侧栏角标、收件箱「全部」、手机「等你」都是它）。
  const desk = deskInbox(inbox, { jobs }), inDesk = new Set(desk.asks.map(a => a.id));
  const asks = {};
  for (const a of all) {
    const kind = kinds.get(a.id), out = askOut(a, kind);
    if (isPipeline(kind) && !rowByRid.has(a.lead?.record_id) && !inDesk.has(a.id)) continue;
    Object.assign(out, { line: lineOf(a, kind, rowByRid.get(a.lead?.record_id)), brief: briefOf(a, kind), wait: waitOf(a, kind), member: memberOf(a, kind, { jobOf }), scope: onRow.has(a.id) || (isPipeline(kind) && rowByRid.has(a.lead?.record_id)) ? 'lead' : 'member' });
    asks[a.id] = out;
  }
  const order = new Map(all.map((a, i) => [a.id, i])), firstOf = new Map(); for (const a of all) if (!firstOf.has(kinds.get(a.id))) firstOf.set(kinds.get(a.id), order.get(a.id));
  // 按急的程度：同一档里同一类排在一起（收件箱 blockersOnly 先按标签分段，再按这个档，所以两边是同一份、顺序可以不同）。
  const blockers = all.filter(a => !isPipeline(kinds.get(a.id)) && !noticeOnly(a)).sort((a, b) => BLOCKERS[kinds.get(a.id)].rank - BLOCKERS[kinds.get(b.id)].rank || firstOf.get(kinds.get(a.id)) - firstOf.get(kinds.get(b.id)) || order.get(a.id) - order.get(b.id)).map(a => a.id);
  // 「你」：所有「需要你」（和收件箱同一份、同一个顺序），最急的是第一件。页面按同样的规则画（web/hq.js，刚在抽屉里答完的先拿掉）。
  // 名字和脸（中性圆片，user 图标）来自名册（lib/crew.mjs OWNER / faceOf），和成员同一张表。
  // 「你」= 收件箱那张单子：一共几件、最急的是第一件（收件箱的顺序）。
  const waitIds = desk.asks.map(a => a.id);
  const you = { id: OWNER.id, name: OWNER.name, face: faceOf('you'), count: waitIds.length, top: waitIds.length ? { id: waitIds[0], text: asks[waitIds[0]]?.brief || '' } : null };
  // 成员的「等你」：收件箱里算在这位名下的那几件（lib/hq.mjs memberOf）。各位加起来就是收件箱的总数，团队页、成员页、右侧面板都读这一份。
  const waiting = {};
  for (const id of waitIds) { const a = asks[id]; if (!a) continue; const w = (waiting[a.member] ||= { id, text: a.wait, title: a.line || a.question, count: 0, ids: [] }); w.count++; w.ids.push(id); }
  // 全部岗位（旧「岗位看板」并进来）：不在推进、也不等你筛的线索，各占一行（只带表上要的几样），只在「全部」里。
  const inRows = new Set(rows.map(r => r.rid)), library = [], shelved = [];
  const libRow = (rid, l) => ({ rid, number: l.number ?? null, company: /^待核/.test(l.company) ? l.company : canonicalCompany(l.company), role: jobTitle(l.applied_role || l.role, l.jd_text), city: l.location || '', ...hqFilterFacts(l, referrers), verdict: l.match?.verdict || null, vkey: verdictOf(l), source: sourceLabel(l), judgement_reason: listJudgementReason(l), score: !l.prefilter_reason && l.match?.verdict === 'recommend' ? requirementScore(l.match, facts) : null, judged: !!l.prefilter_reason || hasJudgement(l), judge_recovery: judgeRecovery(l, recoveryContext), ...leadActivityTimes(l, outbound), at: l.matched_at || l.discovered_at || l.imported_at || null, tab: 'library' });
  for (const [rid, l] of leadBy) {
    if (inRows.has(rid)) continue;
    const s = shelf.get(rid);
    // 主人明确交代的找岗产物在线索库里可找回；筛掉的仍不进入推进阶段，也不撤销主人后来的关闭决定。
    const requested = l.company_search?.job_id && !closedByUser(l) && l.auto_apply?.status !== 'closed' && !excludedCompany(l);
    if (s && !requested) { shelved.push({ ...libRow(rid, l), tab: 'shelf', shelf: s.kind, why: shelfWhy(s) }); continue; }
    // 推荐排队中（lib/recommend-gate.mjs heldRec）：每天的名额满了、或者还没选方向，先不推荐。
    library.push({ ...libRow(rid, l), ...(s ? { screening_note: `${l.prefilter_reason || l.prefilter?.reason ? '初筛未通过' : s.kind === 'not_job' ? '不是岗位' : '当前不推荐'}：${shelfWhy(s)}` } : {}), queued: !s && heldRec(l) ? ((!l.rec_queue || l.rec_queue.reason === 'no_direction') ? '方向没选，先不推荐' : '排队，名额到了再推荐') : null });
  }
  for (const r of rows) r.vkey = verdictOf(leadBy.get(r.rid) || {});
  const tabs = Object.fromEntries(TABS.map(([k]) => [k, k === 'all' ? rows.length + library.length : rows.filter(r => r.tab === k).length]));
  const tally = tallyOf({ desk, asks, waiting, tabs, rows, library, shelved });
  const alerts = (center.alerts || []).filter(a => !a.recovered_at && ['error', 'warn'].includes(a.level)).map(a => ({ level: a.level, source: crewOf(a.source, { step: a.step, fallback: 'patch' }), msg: plainMsg(a.msg, 120), when: a.at ? dayClock(a.at, now) : '' }));
  // 每位名下几行（表格按成员筛的时候就是这么多行）；Scout 数今天新找到的，Tailor 数简历（都在它自己的卡上），Patch 数严重告警。
  const count = Object.fromEntries(CREW_IDS.map(k => [k, rows.filter(r => r.members.includes(k)).length]));
  const stat = (w, label) => (w.stats || []).find(x => x[0] === label)?.[1];
  const pauses = input.pauses || agentPauses();
  // Lens 的公司调研（lib/company-brief.mjs）：抽屉里每家公司一张小卡；团队条上「调研中 N 家 / 已调研 M 家」。
  const briefs = input.briefs || loadBriefs(), settings = briefSettings(), companies = {};
  for (const r of rows) if (!Object.hasOwn(companies, r.company)) companies[r.company] = companyCard(r.company, { briefs, jobs, now, settings });
  const research = researchCounts({ briefs, jobs });
  const counted = w => w.key === 'scout' ? stat(w, '今天新岗位') ?? count.scout : w.key === 'tailor' ? stat(w, '简历') ?? 0 : w.key === 'patch' ? alerts.filter(a => a.level === 'error').length : count[w.key] ?? 0;
  const workers = (team.workers || []).map(w => ({ key: w.key, name: w.name, face: w.face || faceOf(w.key), duty: w.duty, group: w.group || null, state: w.state, now: w.now, stats: w.stats, ops: w.ops, fails_today: w.fails_today || 0, jobs_open: w.jobs_open || 0, count: counted(w), rows: count[w.key] ?? 0, paused: agentPaused(w.key, pauses), waiting: waiting[w.key] || null, ...AGENTS[w.key], ...(w.key === 'lens' ? { research } : {}), ...(w.key === 'patch' ? { executor: { ...(w.executor || {}), paused: agentPaused(EXECUTOR, pauses) } } : {}) }));
  const pipeline = all.filter(a => isPipeline(kinds.get(a.id))).length;
  // groups：按小组排的成员 id（右侧面板、筛选条用；一组一位，以后一组可以有几位）。
  // team：整个团队的名字和脸（users 图标的中性圆片，命令栏「交给团队」用）。
  // 页头「找新岗位」：Radar 跑一轮（和团队页「立即跑一轮」同一个 op）；op_now 是现在在跑的那一项（空表时说「正在找第一批岗位」）。
  const findOp = (center.ops?.catalog || []).find(o => o.op === 'round-scout');
  const find = findOp ? { op: findOp.op, label: findOp.label, heavy: !!findOp.heavy } : null;
  const progress = input.progress !== undefined ? input.progress : read(MATCH_PROGRESS, null);
  const running = runningNow({ jobs: active.filter(j => j.state === 'running'), leads, progress, now });
  const op_now = running?.op ? { op: running.op, label: running.label, started_at: running.started_at } : null;
  // 首轮跑完的结果（lib/first-round.mjs）：只给对话里「现在怎么样」用。指挥台顶上不再挂这一行（第 3 轮负责人：顶上只放挡路的大事），
  // 要你补信息的进收件箱（firstRoundAsk），还没判的有多少、什么时候判进运行日志（bin/match.mjs）。
  const fr = firstRoundSummary({ ops: center.ops || {}, leads, facts, progress, now }), first_round = fr && { ...fr, line: firstRoundLine(fr), left_text: backlogNow(fr.left) };
  // 顶上那一条「挡路大事」（lib/blockers.mjs）：没有就不占地方。
  // 普通待答、登录、批准事项只在收件箱和对应岗位显示，不再复制到顶栏。
  // 给原样的告警（上面那份 alerts 截过字、去掉了 fix 和 detail：横条要修它的按钮和完整内容）。
  const top = topBlocker({ alerts: center.alerts || [] });
  // 首轮来信「看这 N 个」点进来只列这几条（web/hq.js only=first-round）。
  const first_round_need = firstRoundNeedIds({ ops: center.ops || {}, leads, facts, now });
  return { find, op_now, running, first_round, first_round_need, top, status: team.status || {}, workers, groups: crewGroups(), team: { id: TEAM.id, name: TEAM.name, face: faceOf('team') }, alerts, asks, blockers, waiting_ids: waitIds, you, waiting, rows, library, shelved, companies, tabs, tab_labels: TABS, tally, inbox: { total: desk.total, waiting: desk.total, blockers: blockers.length, pipeline } };
}
// 收件箱页（2026-09-29 起只放「需要你」）：同一份 inboxView，去掉在指挥台行上答的四种信；顺序、分类和指挥台的「需要你」一样。
// 同一档（rank）里同一类排在一起，类和类之间按各自第一封出现的先后（10-01：「材料变了」和「终审」同在第 4 档，
// 按标题交错，分组标题出现了两次）。
// 收件箱的标签页（tab）就是「全部」里的分组：标签叫什么、数几封，下面的分组就叫什么、有几封（实测 10-04 第 14 条：
// 「终审 19」里有 16 封「材料变了」——原来标签按信的底层类型分，分组按类别分，对不上）。
// 一个类别一个标签，名字是它的分组名（BLOCKERS 的 tag）；别人发来的消息（对方回复、BOSS / 脉脉 / LinkedIn 新消息）合成一个「新消息」。
// 登录和还差几步各是各的。电脑上另加的草稿、投递（DESK_ALSO）也各是一个标签。
const MESSAGE_KINDS = new Set(['reply', 'bosschat', 'maimaichat', 'linkedinmsg']);
export const MESSAGE_TAB = '新消息';
// 要不要跟进（followup）也是等你拍板的一件：电脑和手机同一张单子（rebuild7/one-source：以前手机多这一类，两边数不一样）。
export const DESK_ALSO = { draft: '草稿待批准', apply: '投递待批准', followup: '要不要跟进' };
export const inboxTab = (a, kind) => MESSAGE_KINDS.has(kind) ? 'message' : kind;
export const inboxTabLabel = kind => MESSAGE_KINDS.has(kind) ? MESSAGE_TAB : BLOCKERS[kind]?.tag || DESK_ALSO[kind] || kind;
// 排序：先按档（挡路 → 等你回 → 要你拍板 → 知会），档里按类别的先后（新消息算最前），同一个标签排在一起、只出现一段；
// 标签页的顺序就是它们在「全部」里出现的顺序。
const tabRank = kind => MESSAGE_KINDS.has(kind) ? -1 : BLOCKERS[kind]?.rank ?? 99;
function arrange(items) {
  const first = new Map(), firstKind = new Map(); items.forEach((x, i) => { const t = inboxTab(x.a, x.kind); if (!first.has(t)) first.set(t, i); if (!firstKind.has(x.kind)) firstKind.set(x.kind, i); });
  // 同一个标签里（新消息）再按类别排在一起：信上的小标（BOSS 新消息、对方回复）也各是一段。
  const kindRank = k => BLOCKERS[k]?.rank ?? 99;
  const asks = items.map((x, i) => ({ ...x, i: x.i ?? i })).sort((x, y) => tierRank(x.a, x.kind) - tierRank(y.a, y.kind) || tabRank(x.kind) - tabRank(y.kind) || first.get(inboxTab(x.a, x.kind)) - first.get(inboxTab(y.a, y.kind)) || kindRank(x.kind) - kindRank(y.kind) || firstKind.get(x.kind) - firstKind.get(y.kind) || x.i - y.i)
    .map(({ a, kind, tag }) => ({ ...a, kind, tag: tag || BLOCKERS[kind]?.tag || null, tab: inboxTab(a, kind), tab_label: inboxTabLabel(kind), ...tierView(tierOf(a, kind)) }));
  const tabs = [];
  for (const a of asks) { const t = tabs.find(x => x.key === a.tab); if (t) t.count++; else tabs.push({ key: a.tab, label: a.tab_label, count: 1 }); }
  return { asks, tabs };
}
export function blockersOnly(inbox = {}, { jobs = cachedLines('state/host-jobs.ndjson') } = {}) {
  const jobKinds = new Map(lastRev(jobs).map(j => [j.id, j.kind]));
  const all = (inbox.asks || []).map((a, i) => ({ a, i, kind: askKind(a, { jobKind: id => jobKinds.get(id) }) }));
  const { asks, tabs } = arrange(all.filter(x => !isPipeline(x.kind) && !noticeOnly(x.a)));
  const counts = Object.fromEntries(Object.keys(inbox.types || {}).map(t => [t, asks.filter(a => a.type === t).length]));
  // 等你筛的待核有几个（收件箱一件都没有时，指向指挥台的「待核」，10-02 N13）。
  const verify = all.filter(x => x.kind === 'triage' && x.a.verdict === 'verify').length;
  return { ...inbox, asks, counts, tabs, total: asks.length, pipeline: all.length - asks.length, verify };
}
// 电脑上的收件箱（GET /api/inbox、左栏的数）：「需要你」之外，加上等你批准的草稿（私信 / 邮件）和投递，各是一个标签
// （第 6 轮：#429 的 BOSS 私信草稿等你批准，岗位页上有，收件箱写「都处理完了」——以前电脑上这两类只在指挥台的行上答，
// 新用户、老用户都找不到）。按钮和手机上的同一份：批准、改、不发；发出和投递照旧先确认。
// 还没有编号的投递不放进来（实测 10-04 第 14 条）：编号由工作台的循环先补上（bin/serve.mjs，lib/inbox-recheck.mjs numberWaiting），补好了再出现。
// 每一件带上算在谁名下（member，lib/hq.mjs memberOf）：成员页、团队页的「等你」按它分，和这张单子是同一份。
export function deskInbox(inbox = {}, { jobs = cachedLines('state/host-jobs.ndjson') } = {}) {
  const b = blockersOnly(inbox, { jobs }), byJob = new Map(lastRev(jobs).map(j => [j.id, j])), jobKinds = new Map([...byJob].map(([id, j]) => [id, j.kind]));
  const jobOf = id => (id && byJob.get(id)) || null, withMember = a => ({ ...a, member: memberOf(a, a.kind, { jobOf }) });
  const shown = new Set(b.asks.map(a => a.id));
  const also = (inbox.asks || []).map(a => ({ a, kind: askKind(a, { jobKind: id => jobKinds.get(id) }) }))
    .filter(({ a, kind }) => !shown.has(a.id) && Object.hasOwn(DESK_ALSO, kind) && (kind === 'draft' || a.lead?.number != null))
    .map(({ a, kind }) => ({ a, kind, tag: DESK_ALSO[kind] }));
  if (!also.length) return { ...b, asks: b.asks.map(withMember) };
  const { asks, tabs } = arrange([...b.asks.map(a => ({ a, kind: a.kind, tag: a.tag })), ...also]);
  const counts = Object.fromEntries(Object.keys(inbox.types || {}).map(t => [t, asks.filter(a => a.type === t).length]));
  return { ...b, asks: asks.map(withMember), counts, tabs, total: asks.length, pipeline: Math.max(0, b.pipeline - also.length) };
}
// 手机「等你」（GET /api/inbox 带 x-radar-phone，经手机网关来）：「需要你」之外，还有等你批准的草稿（私信 / 邮件）、
// 等你批准的投递和跟进——电脑上它们在指挥台的行上答，手机上没有指挥台，只有这里（09-30：推送推了、点进来却找不到）。
// 顺序：「需要你」在前（和收件箱一样），这几类接在后面、按收件箱原来的顺序。新线索筛选（triage）一来一批，手机上不放、也不推。
// focus：通知点进来要找的那一条（#wait/<信>）；还在收件箱里就一定给手机，哪怕不在上面几类里——只有真的没了，手机才说「这条已经处理了。」。
// handOff：这部手机能不能把活交给执行器。不能的话，这几类的「其他：说怎么改」（改写、另说一件事，都是交给执行器的新活）不给；
// 批准、不发、pass 这些拍板的按钮照常给，发出和投递照样先在手机上确认（lib/phone/gateway.mjs）。
// 手机和电脑是同一张单子（deskInbox）：一样的几件、一样的顺序、一样的数（rebuild7/one-source）。
// 手机只多两样：通知点进来要找的那一条不在单子上时也给（focus，不算进数里）；不能交给执行器时，拍板类的「其他：说怎么改」不给。
export const PHONE_ALSO = DESK_ALSO;
export function phoneInbox(inbox = {}, { jobs = cachedLines('state/host-jobs.ndjson'), focus = null, handOff = true } = {}) {
  const d = deskInbox(inbox, { jobs }), shown = new Set(d.asks.map(a => a.id));
  const asks = d.asks.map(a => !handOff && Object.hasOwn(DESK_ALSO, a.kind) ? { ...a, other: null } : a);
  const focusIds = focusedRecommendations(focus);
  if (focusIds) {
    for (const a of recommendationAsks(inbox.asks).filter(a => focusIds.includes(a.id) && !shown.has(a.id))) asks.push({ ...a, other: handOff ? a.other : null, kind: 'triage', tag: '推荐岗位', tab: 'triage', focus_only: true });
  } else if (focus && !shown.has(focus)) {
    const a = (inbox.asks || []).find(x => x.id === focus);
    if (a) { const kind = askKind(a, { jobKind: id => lastRev(jobs).find(j => j.id === id)?.kind }); asks.push({ ...a, kind, tag: BLOCKERS[kind]?.tag || DESK_ALSO[kind] || null, tab: inboxTab(a, kind), focus_only: true }); }
  }
  return { ...d, asks, ...(focusIds ? { focus_ids: focusIds } : {}), total: d.total, pipeline: (inbox.asks || []).length - d.total };
}
