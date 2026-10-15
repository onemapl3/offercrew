// 收件箱：把「等我处理」的每一行变成一个提问（2026-09-28 规则：一条线索要用户处理时不堆一排按钮，
// 而是像 Claude Code 那样的对话框——几个默认选项加一个自己写的选项；选项按规则生成，不每次跑大模型）。
//
// 输入是 taskQueue 已按线索合并好的行（lib/command-center.mjs），输出是一串 ask：
//   { id, type, title, question, context, detail, preview, options[], other, affected[], ... }
// 类型决定问法和选项，全部是规则生成：
//   login     要你登录 / 授权：按账号合并（lib/accounts.mjs），一个账号一条，列出它挡住的事
//   interview 面试：记时间、进会议、写复盘
//   review    发送 / 提交前终审：草稿全文或拟填内容就在问题里，看完直接发
//   decide    要你拍板：投不投、找不找人、城市范围这类
//   info      补充信息：执行器问你的问题，能从问题里拆出选项就拆
//   followup  跟进：联系后几天没回
//   triage    新线索筛选：联系 / 投 / pass
// 选项只写"要做什么"（steps）；真正执行在 answerAsk（lib/ask-actions.mjs）里走已有入口，
// 发送与投递照旧要本人确认，这里不放宽任何授权。
import { familyOf, familiesInText, familiesInCondition, loginClauses, loginNeeded, loggedInSince, hostOf as accountHost, loadAccounts } from './accounts.mjs';
import { autoApplyNeeds, needShort, NEVER_COLLECT, cleanFieldLabel } from './needs.mjs';
import { shortTitle } from './short-title.mjs';
import { applyWord, applyUrl, applyChannel, emailChannel, portalSession, autoSubmitOn } from './apply-channel.mjs';
import { draftFingerprint } from './drafts.mjs';
import { CHANNEL_LIMITS } from './message-limits.mjs';
import { leadCity, primaryCity } from './city.mjs';
import { citySprint, sprintAllows } from './city-sprint.mjs';
import { hash, read } from './store.mjs';
import { daysLaterAt, TZ } from './tz.mjs';
import { loadBook, lookup } from './answer-book.mjs';
import { PASS_REASONS } from './feedback.mjs';
import { BRAND } from './brand.mjs';
import { crewName, memberOfJob } from './crew.mjs';
import { verifyGap, decisionPoints, profileGap, rejudgeState } from './first-round.mjs';
import { hasJudgement, judgedFully, judgementStopped, heldRec, heldApplySuggestion, approvalBlocker, directionSet } from './recommend-gate.mjs';
import { pendingReview } from './owner-decision.mjs';
import { currentFacts } from './facts.mjs';
import { hasApplicationApproval } from './submission-policy.mjs';
import { shelved } from './shelf.mjs';
import { uploadedResume, resumeNotes } from './resume-choice.mjs';
import { interviewConfirmAsk } from './mail/interview.mjs';
import { proofOf, missingLine } from './apply-words.mjs';
import { offDirection } from './apply-approve.mjs';
import { platformActionsEnabled, platformActionReason, platformMessageBlock, PLATFORM_ACTIONS_GO } from './platform-actions.mjs';
import { changeWords, changeLine } from './approval-change.mjs';
import { pageGone, lostPage } from './application-page.mjs';
import { lastLanding, landingFailed, landingWords } from './landing.mjs';
import { resumePick } from './application-form.mjs';
import { pickApplyDriver } from './auto-apply.mjs';
import { decidedLead, appliedLead } from './lead-state.mjs';
import { requirementScore } from './matcher.mjs';
import { plainJudgement, VERDICT_WORD as VERDICT } from './vocab.mjs';

export const ASK_TYPES = {
  interview: { label: '面试', icon: '📅' },
  login: { label: '登录授权', icon: '🔑' },
  review: { label: '发送前终审', icon: '📝' },
  decide: { label: '要你拍板', icon: '⚖️' },
  info: { label: '补充信息', icon: '✍️' },
  followup: { label: '跟进', icon: '🔁' },
  triage: { label: '新线索筛选', icon: '🧹' },
};
const TYPE_ORDER = Object.keys(ASK_TYPES);
// 和指挥台同一种叫法（lib/workflow.mjs CHANNEL_SHORT）：门户、官方表单都说「官网」（10-01 第 2 轮验收第 27 条）。
export const CHANNEL_NAME = { email: '邮件', platform_dm: '平台私信', wechat: '微信', ats_form: '官网表单', portal: '官网', referral: '内推请求', unknown: '渠道待定' };

// 执行器写的话里常带内部说法——浏览器任务空间编号、配置文件路径、字段名、脚本名、状态码（2026-09-29 QA：
// 「请在浏览器空间14处理」「扫描源以 config/human-source-policy.json 为准」「application_url」「pull-feedback · degraded」）。
// 给你看之前换成人话；只换这些固定说法，别的原样保留。
const INTERNAL = [
  // ego 浏览器是用户要装、要登录的真实软件，保留这个名字；只把 ego-browser / Ego / ego lite 这些写法统一成它。
  [/\s*(?:ego[- ]?browser|\bego lite\b|\bego 浏览器|\bego\b)\s*/gi, '浏览器'],
  [/(?:浏览器)?(?:任务)?空间\s*\d+/g, '浏览器窗口'],
  [/agentDelegatedToUser/g, '交给你了'],
  [/\bconcierge\b/gi, '同步'],
  [/\bapplication_url\b/g, '申请链接'],
  [/\bdraft_id\b/g, '草稿编号'],
  [/\brecord_id\b/g, '线索编号'],
  [/\b(?:config|state|candidate)\/[\w./-]+/g, '本地设置'],
  [/\bruns\/[\w./-]+/g, '运行记录'],
  [/\bpull-feedback\b/g, '拉取反馈'], [/\bproject-journey\b/g, '同步进度'], [/\bproject-base\b/g, '同步岗位表'],
  [/\bdiscover-human-browser\b/g, '真人帖浏览器扫描'], [/\bsend-dm\b/g, '发私信'], [/\b(?:queue[_-])?auto[_-]apply\b/g, () => applyWord()],
  [/\s*·\s*degraded\b/g, ' 部分失败'], [/\bdegraded\b/g, '部分失败'],
  [/ERR_CONNECTION_CLOSED/gi, '连接中断，申请页没打开'],
  [/\b(?:overall\s*fit|整体匹配)\s*[:：]?\s*\d+(?:\.\d+)?\s*\/\s*3/gi, '综合匹配度见岗位判断'],
  [/waiting_user/gi, '等你回复'], [/host[_ -]?job/gi, '任务'],
];
const clean = t => INTERNAL.reduce((x, [re, to]) => x.replace(re, to), String(t ?? '')).replace(/\s+/g, ' ').trim();
export const plainWords = clean;
// 没有线索的执行器任务：标题按任务种类说（原来拿任务说明的第一句当标题，「扫描源以 config/… 为准…」）。
const JOB_TITLE = { discover_human_opportunities: '真人帖扫描', system_fix: '系统修复', user_request: '你交代的事', read_forwarded_source: '读你转发的链接', read_incremental: '读新消息', host_cycle_review: '周期复查', sync_application_review: '同步投递审核' };
const cut = (t, n) => { const x = clean(t); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const hostOf = u => { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const PLATFORM = /(^|\.)(maimai\.cn|zhipin\.com|linkedin\.com|liepin\.com|xiaohongshu\.com)$/;
const PLATFORM_NAME = { 'maimai.cn': '脉脉', 'zhipin.com': 'BOSS 直聘', 'linkedin.com': 'LinkedIn', 'liepin.com': '猎聘', 'xiaohongshu.com': '小红书' };
const PLATFORM_KEY = { 'BOSS 直聘': 'boss', 脉脉: 'maimai' };
// 中文里夹着以英文开头 / 结尾的名字，两边空一格（「在 BOSS 直聘上」）。
export const spaced = name => { const t = String(name || ''); return `${/^[A-Za-z0-9]/.test(t) ? ' ' : ''}${t}${/[A-Za-z0-9]$/.test(t) ? ' ' : ''}`; };
const platformOf = u => { const h = hostOf(u); const k = Object.keys(PLATFORM_NAME).find(d => h === d || h.endsWith('.' + d)); return k ? PLATFORM_NAME[k] : null; };

// 线索本身走哪个渠道。不用草稿表里的值：taskQueue 里没有草稿的行会被 draft_id=null 的孤儿草稿
// 串成「平台私信」（旧数据里可能有 draft_id 为空的草稿）。
export function leadChannel(l = {}) {
  if (emailChannel(l)) return 'email';
  const c = applyChannel(l);
  if (c === 'portal' || c === 'ats_form') return c;
  if (/微信|wechat/i.test(l.entry_type || '') || l.wechat) return 'wechat';
  if (PLATFORM.test(hostOf(applyUrl(l))) || PLATFORM.test(hostOf(l.url))) return 'platform_dm';
  return 'unknown';
}

// 执行器写下的"要你做什么"。同一条任务后写的修订可能把问题清空，往前找最近一个非空的。
// 执行器以前也把问题写成 {question|text|message, at, evidence}（lib/journey.mjs waitingText 认这种写法）：同样当问题读。
const asText = v => typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.question || v.text || v.message || '') : '';
export function jobQuestion(job, revisions = []) {
  const pick = j => { for (const v of [j?.waiting_user, j?.required_action, j?.question]) { const t = asText(v).trim(); if (t) return t; } return ''; };
  const own = pick(job);
  if (own) return own;
  for (const r of [...revisions].reverse()) if (r.id === job?.id && r.status === job.status) { const q = pick(r); if (q) return q; }
  return String(job?.result || '').match(/(?:需要用户|仍需用户|还需用户|需要你做的事|需要你|请用户|需本人)[：:]?\s*([\s\S]+)$/)?.[1]?.trim() || '';
}
// 问题里列了几个候选（「你想推进哪一个：A、B、C」）就拆成选项。
export function questionChoices(q) {
  const m = String(q || '').match(/(?:哪一个|哪个|哪几个|哪一家|哪家|选哪)[^：:]{0,12}[：:]\s*([^。？?\n]+)/);
  if (!m) return [];
  const items = m[1].split(/[、，,；;]|\s或\s|或者/).map(s => s.replace(/^[\s"“]+|[\s"”…]+$/g, '').replace(/^还是\s*/, '').trim()).filter(s => s && s.length <= 40);
  return items.length >= 2 && items.length <= 6 ? items : [];
}
// 「A，还是 B？」「请选择 A，或者告诉我 B」：执行器在两条路里问你选哪条，就拆成这两个按钮（10-01：System 修复的信问的是
// 「继续扫描，还是跳过」，按钮却是「好的，照这个做」，对不上）。两边都要短（按钮放得下），拆不准就不拆，信上给通用的选项。
// 执行器自己写了选项（needs[].options）就用它的，这里只是没写时的兜底（10-01 第 2 轮验收复核 25）。
//
// 拆法（10-01 第 2 轮验收复核 20：「要不要我先给 Jordan 起草一段站内信，附上英文简历 v3 的要点，还是直接走官网表单？」
// 第一个按钮成了「附上英文简历 v3 的要点」——原来只取「还是」前面最后一个逗号后的那一段）：
//   1. 只看「还是」所在的那一小句（句号、分号、冒号之后）；
//   2. 「还是」前面按逗号分成几段：从带引导词（要不要、是否、要、想、选……）的那一段起算，后面跟着的只能是补充
//      （附上、带上、顺便……），补充放进按钮的说明里；认不出哪段是选项、或者后面跟着的不是补充，就不拆；
//   3. 「还是」后面同理：第一段是选项，后面只能是补充；
//   4. 按钮上不放括号、斜杠、问句，两边都要在 24 个字以内。
// 「要不要」放在「要」前面：先试短的「要」会剩下「不要我先……」（10-01 第 1 轮验收第 20 条就是这么没拆出来的）。
const LEAD_IN = /^(?:(?:那|所以|请问|请|你|您)?(?:要不要|是不是|是否|需要|是|要|想|看){0,2}(?:我)?(?:先|再)?(?:选择|选)?)/;
const tidy = t => String(t || '').replace(/^[\s，,：:]+|[\s。？?！!…]+$/g, '').replace(/^(?:告诉我|跟我说|让我|由我|直接)/, '').replace(LEAD_IN, '').trim();
// 这一段是不是选项的开头：带引导词（「要不要我先……」「你想……」「是要先……」「完成后选……」）。
const CHOICE_HEAD = /^(?:那|所以|请问|那么)?(?:你|您)?(?:是)?(?:要不要|需不需要|是否|是不是|要|想|打算|准备|请?选择|请?选)/;
// 条件（「你处理完验证后」「需要的话」）：不是选项，跳过。
const CONDITION = /(?:之后|以后|后|的时候|时|的话)$/;
const stripCondition = s => s.replace(/^[^，,]{1,20}?(?:之后|以后|后|的时候|时|的话)(?=\S)/, '');
// 补充：跟在选项后面、说怎么做的（「附上英文简历 v3 的要点」「顺便问一下薪资」）。
const EXTRA = /^(?:并且?|附上|附带|附|带上|顺便|同时|再附|另外附|里面|内容是|说明|写上|抄送)/;
// 一边太长放不进按钮时收短（10-01 第 1 轮验收：「要不要我先给其中那位写 Agent 方向的工程经理起草一段站内信，还是直接走官网表单？」
// 选项却是「好的，照这个做 / 不用了」）：去掉「给 / 向 / 跟 …」这个对象（取最后一个动作词，「给那位写 X 的经理起草」里是「起草」），
// 再去掉「一段 / 一封」这类量词。量词「一段 / 一封 / 一份」总是去掉；对象只在超长时动；收完还长就算拆不干净。
const ACT = /起草|写|发|联系|投|走|找|申请|提交|约|打电话|改/g;
function squeeze(t) {
  let s = t.replace(/一(?:段|封|份)/g, '');
  if (s.length <= 24) return s.replace(/\s+/g, ' ').trim();
  const to = /^(?:给|向|跟|和|对)/.exec(s);
  if (to) { let at = -1; for (const m of s.slice(0, 32).matchAll(ACT)) if (m.index > 1) at = m.index; if (at > 0) s = s.slice(at); }
  return s.replace(/一(?:条|个|下)/g, '').replace(/\s+/g, ' ').trim();
}
const NOT_A_BUTTON = /[（()）/／|「」"“”]|吗$|么$/;
const okLabel = s => s.length >= 2 && s.length <= 24 && !NOT_A_BUTTON.test(s);
const clauses = s => s.split(/[，,]/).map(x => x.trim()).filter(Boolean);
// 「还是」前面那一边：选项那一段 + 后面的补充。认不准返回 null。
function leftSide(s) {
  const cs = clauses(s);
  if (!cs.length) return null;
  let at = cs.findIndex(c => CHOICE_HEAD.test(stripCondition(c)) && !CONDITION.test(c));
  if (at < 0) {
    // 没有引导词：只有一段，或者前面几段都是条件（「你处理完验证后，继续扫描，还是……」），取最后一段。
    if (cs.slice(0, -1).every(c => CONDITION.test(c))) at = cs.length - 1;
    else return null;
  }
  const extra = cs.slice(at + 1);
  if (!extra.every(c => EXTRA.test(c))) return null;
  return { label: squeeze(tidy(stripCondition(cs[at]))), extra: extra.join('，') };
}
// 「还是」后面那一边：第一段是选项，后面只能是补充。
function rightSide(s) {
  const cs = clauses(s);
  if (!cs.length || !cs.slice(1).every(c => EXTRA.test(c))) return null;
  return { label: squeeze(tidy(cs[0])), extra: cs.slice(1).join('，') };
}
// 拆出两条路和各自的补充：{ choices: [A, B], extras: [A 的补充, B 的补充] }；拆不准返回 null。
export function eitherOrParts(q) {
  const sents = String(q || '').split(/(?<=[。！!？?\n])/).map(x => x.trim()).filter(Boolean);
  for (const t of sents.reverse()) {
    const m = t.match(/^(.*?)\s*(?:还是|或者是?|或是)\s*([^。？?！!]+?)[？?。！!]?$/);
    if (!m) continue;
    const head = m[1].split(/[；;：:]/).pop().replace(/[，,\s]+$/, '');
    if (/[；;：:]/.test(m[2])) return null;
    const a = leftSide(head), b = rightSide(m[2]);
    if (!a || !b || !okLabel(a.label) || !okLabel(b.label) || a.label === b.label) return null;
    return { choices: [a.label, b.label], extras: [a.extra, b.extra] };
  }
  return null;
}
export const eitherOr = q => eitherOrParts(q)?.choices || [];
// 执行器列的选项里那条「不推进」：和信上自带的「这条不推进」是一回事，只留一个（10-01 第 2 轮验收第 25 条）。
const NOT_ON = /^(?:都|这条|整条|这个|两个都)?不(?:推进|投|要了?|做了?|考虑)$|^(?:放弃|算了|不用了)/;
// 要你在浏览器窗口里亲手过的一步。
const HAND_STEP = /滑块|验证码|人机验证|安全验证|手动[^。；]{0,8}验证|过一下验证/;
const DECISION_Q = /哪一个|哪个|是否|要不要|还投吗|改走|或提供|或决定|推进哪/;
const NO_CONTACT = /(?:未|没有?)(?:找到|发现|公开)[^。；]{0,16}(?:联系人|邮箱|招聘人|联系入口|联系方式)|没有(?:公开)?(?:招聘)?联系/;
const DEAD_LINK = /跳回[^。]{0,12}首页|链接(?:已)?(?:失效|无效)|尚未核实可用岗位详情/;
const CITY_SCOPE = /城市范围|冲刺[^。]{0,10}(?:拦截|范围)|不在[^。]{0,6}(?:冲刺|目标)城市/;

// 标题里已有编号和公司，这里只放岗位、城市、渠道。
const ctxLine = (l = {}, channel) => [l.role ? cut(l.role, 40) : null, leadCity(l) && leadCity(l) !== '其他' ? leadCity(l) : null, CHANNEL_NAME[channel] || null].filter(Boolean);

// 投递之后会发生什么，按渠道和登录态说清楚（与 bin/queue-apply.mjs / auto-apply 的实际行为一致）。
export function applyEffect(l) {
  const channel = leadChannel(l);
  // 自动提交关着（v0.1 默认）只预填、你来提交（09-30 视频录制时发现这句还写着「填写并提交」）。
  if (channel === 'ats_form') return autoSubmitOn() ? '无需账号的官方表单：系统按你的资料填写并提交，确认前可以先看拟填内容，结果会通知你。' : '无需账号的官方表单：系统按你的资料预填，停在提交前，你检查后自己提交。';
  if (channel === 'portal') {
    const s = portalSession(l);
    // Workday 这类要本人建账号的门户，你登录过（register_by_owner 且 logged_in）就按已登录说，别再让你去注册 / 登录（#159）。
    if (s?.never_auto || (s?.register_by_owner && !s?.logged_in)) return `${s.domain} 要本人注册 / 登录：批准先记下，登录后系统按这次批准填表。`;
    if (s?.logged_in) return `${s.via_family ? '同一账号已登录' : '门户已登录'}：系统按你的资料填写申请，材料变了会再问你。`;
    return `${familyOf(applyUrl(l))?.label || s?.domain || '门户'} 还没登录：批准先记下，登录后系统按这次批准填表。`;
  }
  return '先确认投递渠道，再按渠道处理。';
}

// 拍板要的几条事实：判断结论、匹配理由、最大差距、地点 / 年限、来源和发布时间、JD 开头。
export function leadFacts(l) {
  if (!l) return [];
  const m = l.match || {}, p = l.judgement?.posting || {};
  // 读不出日期的 LinkedIn 帖只知道在搜索的时间范围里（lib/human-browser.mjs linkedinPostDate），不印成某一天。
  const day = String(l.posted_at || '').slice(0, 10);
  const posted = l.posted_at_estimated && l.posted_within_days ? `近 ${l.posted_within_days} 天内发布` : day ? `${day} 发布` : null;
  // 判断层记的是 { years, span, context, mandatory }（旧记录是数字）：只取年数，别印成 [object Object]。
  const years = p.min_years && typeof p.min_years === 'object' ? p.min_years.years : p.min_years;
  const src = [l.source_type || l.source, l.author ? `发帖人 ${l.author}${l.author_title ? '（' + cut(l.author_title, 20) + '）' : ''}` : null, posted].filter(Boolean).join(' · ');
  const jd = cut(l.jd_text || l.original_body || '', 220);
  return [
    m.verdict ? { k: '判断', v: `${VERDICT[m.verdict] || m.verdict}${m.reasons?.[0] ? '：' + cut(plainJudgement(m.reasons[0]), 90) : ''}` } : null,
    m.verdict ? { k: '匹配度', v: `${requirementScore(m, currentFacts())} / 100` } : null,
    m.biggest_gap ? { k: '差距', v: cut(m.biggest_gap, 90) } : null,
    l.location ? { k: '地点', v: clean(l.location) } : null,
    years != null ? { k: '年限', v: `${years} 年以上` } : null,
    src ? { k: '来源', v: cut(src, 90) } : null,
    jd ? { k: 'JD', v: jd } : null,
  ].filter(Boolean);
}
const lastWord = t => cut(t, 120);
const option = (key, label, steps, extra = {}) => ({ key: String(key), label, steps, ...extra });

// 这一问的版本：问题、选项文字、预览的指纹（来信原文；草稿指纹；拟填表的字段、截图和绑定的那一版材料）变了才算变。
// 飞书卡片按它判断你点的是不是你看到的那一版（lib/ask-cards.mjs）；岗位资料回填、事实行变了不算。
export function askVersion(a = {}) {
  const p = a.preview || null;
  const preview = !p ? null : p.fingerprint || (p.kind === 'message' ? [p.kind, p.url || null, p.message_id || null, p.body || ''] : [p.kind, p.url || null, p.screenshot || null, p.filled_at || null, (p.fields || []).map(f => [f.key, f.value])]);
  const bound = (a.options || []).flatMap(o => (o.steps || []).map(s => s.fingerprint).filter(Boolean));
  return hash([a.question || '', (a.options || []).map(o => o.label), preview, bound]).slice(0, 16);
}

// ── 各类提问 ─────────────────────────────────────────────────────────────────
// 从没判过的岗位主按钮是「先判断」；已判待核由主人自己决定，自动推荐另走放量闸。
// （Judge 只判这一条，bin/match.mjs --record）。不投、晚点再看照旧。
const judgeFirst = (q, l) => !hasJudgement(l) && !judgementStopped(l);
const judgeOption = q => !directionSet() ? option(1, '选求职方向', [{ type: 'profile_editor', scope: 'targets' }], { primary: true }) : option(1, '先判断', [{ type: 'judge', record_id: q.lead.record_id }], { primary: true });
function triageAsk(q, l, facts = currentFacts()) {
  const n = q.lead.number, channel = l ? leadChannel(l) : q.channel_key, id = `triage:${q.lead.record_id || n}`;
  const apply = ['portal', 'ats_form'].includes(channel);
  const needNumber = n == null ? [{ type: 'ensure_number', record_id: q.lead.record_id }] : [];
  const N = n ?? '{n}';
  const pending = l?.match?.verdict === 'verify' ? decisionPoints(l, facts).map(p => p.text).join('；') : null;
  const stopped = judgementStopped(l) ? `${pendingReview(l, facts).points.join('；')}。是否推进由你决定。` : null;
  const fill = profileGap(l, facts);
  return {
    id, type: 'triage', title: `${n != null ? '#' + n + ' ' : ''}${q.lead.company || '待核'}`, question: apply ? '这个岗位投不投？' : '这个岗位要不要联系？',
    context: ctxLine({ ...l, ...q.lead }, channel), detail: [stopped || (pending && `待核：${pending}`), clean(q.full_detail || q.detail)].filter(Boolean).join('\n'), note: stopped || pending || cut(q.summary || q.detail, 140),
    options: [
      ...(fill ? [option(4, '补信息', [{ type: 'profile_editor', scope: fill.scope, context: fill.context }], { hint: fill.context.reason })] : []),
      judgeFirst(q, l) ? judgeOption(q) : apply ? option(1, '投递', [...needNumber, { type: 'action', kind: 'prefill', input: { number: N } }], { hint: applyEffect(l || {}), primary: true })
        : option(1, '联系', [...needNumber, { type: 'command', text: `${N} 联系` }], { hint: '系统找联系人并起草首联，发送前给你看', primary: true }),
      option(2, '不投', [...needNumber, { type: 'command', text: `pass ${N} {reason}` }], { hint: '可选原因', reasons: PASS_REASONS }),
      // 收件箱自己也记下暂缓：门户岗位池、拟投清单这些行没有提醒可推，只靠「N 晚点提醒」会原地不动（09-29 实测）。
      option(3, '晚点再看', [...needNumber, { type: 'command', text: `${N} 晚点提醒` }, { type: 'snooze', hours: 2 }], { hint: '先放一放，稍后再出现' }),
    ],
    other: { placeholder: `说说你的想法，比如「只要${primaryCity() || '本地'}的」「先问问内推」`, steps: [...needNumber, { type: 'command', text: `关于 ${N} 号 ${q.lead.company || ''}：{text}` }] },
    batch: 'triage', lead: q.lead, url: q.refs?.url || null, facts: leadFacts(l), verdict: l?.match?.verdict || null,
    recommendation_ready: l?.match?.verdict === 'recommend' && judgedFully(l, facts) && !!l.recommended_at && !heldApplySuggestion(l, facts),
    recommendation_at: l?.recommended_at || null,
    ...(stopped ? { judgement_stopped: true } : {}),
  };
}

// 门户岗位池：判断为推荐、城市合适、但因为要本人登录门户而从没进过待办的岗位（多是大公司的
// 招聘门户）。当作新线索筛选给你：选「投递」后，没登录的账号会并进登录提问，登录后填好给你终审。
// 还没有编号的也要（没接飞书就不跑 project-base，编号在你点的时候补，09-30 新用户实测）。
// verify：各渠道的待核都在指挥台给主动决定，不作为收件箱的新投递建议。
//   待核排在推荐后面、新判的在前；默认不截断，否则第 41 条起的岗位详情又没有决定按钮。信上写还差什么（verifyGap），
//   差的是设置里能补的（工作许可没填），多一个「补信息」：打开资料编辑器的那一组，保存以后马上重判（忙着就等手上那一轮跑完）。
export function poolAsks({ leads = [], seen = new Set(), limit = 40, allChannels = false, verify = false, verifyLimit = Infinity, facts = currentFacts(), isExcluded = () => false, cityOk = () => true } = {}) {
  const open = l => !seen.has(l.record_id || l.id) && !l.superseded && !decidedLead(l) && !l.legacy && !appliedLead(l) && !l.auto_apply?.approved_at && !isExcluded(l);
  // 完整推荐源也补上其它渠道：它们可能已被待办分组的展示上限截掉。
  const pool = leads.filter(l => l.match?.verdict === 'recommend' && (allChannels || leadChannel(l) === 'portal') && cityOk(l) && !heldRec(l, facts) && open(l));
  pool.sort((a, b) => String(familyOf(applyUrl(a))?.label || '').localeCompare(String(familyOf(applyUrl(b))?.label || ''), 'zh') || (Number(b.number) || 0) - (Number(a.number) || 0));
  const held = verify ? leads.filter(l => (l.match?.verdict === 'verify' || judgementStopped(l)) && !shelved(l) && open(l)).sort((a, b) => String(b.matched_at || b.match_error_final_at || '').localeCompare(String(a.matched_at || a.match_error_final_at || ''))).slice(0, verifyLimit) : [];
  const rejudge = held.length ? rejudgeState() : null;
  return [...pool.slice(0, limit), ...held].map(l => {
    const rid = l.record_id || l.id, site = familyOf(applyUrl(l))?.label || '公司招聘站';
    const q = { id: `pool:${rid}`, kind: 'screen', channel_key: 'portal', lead: { number: l.number, company: l.company, role: l.role, record_id: rid }, refs: { url: applyUrl(l) }, summary: l.match?.reasons?.[0] || '', detail: l.match?.reasons?.join('\n') || '' };
    const a = triageAsk(q, l, facts);
    if (a.judgement_stopped) return { ...a, from: 'radar', pool: true };
    if (l.match?.verdict !== 'verify') return { ...a, from: 'radar', note: `门户岗位 · ${site} · 之前没进过待办`, pool: true };
    const gap = verifyGap(l, facts, rejudge);
    return { ...a, from: 'radar', note: `${gap.text} · ${a.note}`, detail: [l.match.biggest_gap, a.detail].filter(Boolean).join('\n'), gap, pool: true };
  });
}

function followupAsk(q, now = Date.now()) {
  const n = q.lead.number;
  return {
    id: `followup:${q.id}`, type: 'followup', title: `#${n} ${q.lead.company}`, question: '联系后五个工作日没有回复，跟进一次吗？',
    context: ctxLine(q.lead, q.channel_key === 'platform_dm' ? null : q.channel_key), detail: clean(q.full_detail || q.detail),
    options: [
      option(1, '跟进一次', [{ type: 'command', text: `${n} 跟进` }], { hint: '系统写一段跟进，发送前给你看', primary: true }),
      option(2, '不跟了', [{ type: 'command', text: `${n} 暂停提醒` }], { hint: '这条不再提醒跟进' }),
      // 过两天 = 后天 09:00（当地时间）：收件箱这一问和提醒本身都到那时再出现。
      option(3, '过两天再说', [{ type: 'command', text: `${n} 后天提醒` }, { type: 'snooze', until: new Date(daysLaterAt(2, '09:00:00', now)).toISOString() }]),
    ],
    other: { placeholder: '比如「换个人问问」「直接问进度」', steps: [{ type: 'command', text: `关于 ${n} 号 ${q.lead.company}：{text}` }] },
    batch: 'followup', lead: q.lead, url: q.refs?.url || null, due_at: q.due_at || null,
  };
}

const CHANNEL_WORD = { maimai_friend_request: '脉脉加好友附言', platform_dm: '平台私信', platform_application: '平台申请' };
export function draftAsk(q, l, draft) {
  const n = q.lead.number, channel = draft?.channel === 'maimai_friend_request' ? 'platform_dm' : q.channel_key;
  const platform = platformOf(draft?.to || q.refs?.url);
  const what = channel === 'email' ? `发给 ${draft?.to || '收件人待核'} 的邮件` : channel === 'referral' ? '内推请求' : platform ? `${platform}${draft?.channel === 'maimai_friend_request' ? '好友申请' : '私信'}` : '这段消息';
  const fingerprint = draft ? draftFingerprint(draft) : null;
  const sendHint = channel === 'email' ? '从你的邮箱发出，发完核对发件箱' : platform ? `系统在已登录的${spaced(platform)}里发出这段文字并回读核对；没登录会先来找你` : '按渠道发出并核对回执';
  const files = (draft?.attachments || []).map(a => a.name || a.path || String(a)).filter(Boolean);
  const sprint = citySprint();
  const warning = [
    channel !== 'email' && files.length ? `平台私信只发文字：附件（${files.join('、')}）要你在对话里自己点「发简历」。` : null,
    sprint && !sprintAllows(l, sprint) ? `当前求职范围：${sprint.only.join(' / ') || '不限城市'}；这份${clean(l.location || leadCity(l))}岗位已有草稿，仍需你单独确认发送。` : null,
  ].filter(Boolean).join('\n') || null;
  // 有字数上限的渠道（脉脉加好友附言 50 字）：批准前就写明几个字；超了不给「发送」（发出那一步也会拒：bin/send-dm.mjs maimai_note_too_long），
  // 换成「缩短到 N 字以内」——打开编辑框，Writer 按上限重写，你看过再保存（10-04：#498 批准了才发现发不出去；命令行版导进来的老草稿也一样标出来）。
  const limit = CHANNEL_LIMITS[draft?.channel] || null, len = [...String(draft?.body || '')].length, over = !!limit && len > limit;
  const count = limit ? `（${len}/${limit} 字）` : '';
  const unsupported = platformMessageBlock(draft);
  if (unsupported) return {
    id: `draft:${draft.draft_id}`, type: 'review', blocked_send: true, title: `#${n} ${q.lead.company}`, question: `${unsupported.reason}，可保存文案后在脉脉聊天中手动处理。`,
    context: ctxLine({ ...l, ...q.lead }, channel),
    preview: { kind: 'draft', channel, platform, to: draft.to || '', subject: draft.subject || '', body: draft.body || '', attachments: files, resume: draft.resume || null, fingerprint, warning },
    options: [
      option(1, unsupported.fix.label, [{ type: 'open', url: unsupported.fix.href }], { primary: true, hint: '请在脉脉中找到对应联系人；OfferCrew 不会自动发送或确认回执' }),
      option(2, '编辑文案', [{ type: 'draft_editor', draft_id: draft.draft_id }], { hint: '只保存文案，不会发送' }),
      option(3, '这条不发了', [{ type: 'command', text: `${n} 不发` }], { danger: true }),
    ],
    other: null, lead: q.lead, url: q.refs?.url || null, draft_id: draft.draft_id,
  };
  // 这个平台在设置里没打开（BOSS、脉脉默认关着，红线；lib/action-kinds.mjs 的 platform 闸）：不给「发送」，信上直说，给「打开设置」「这条不发了」
  // （实测 10-04 #205：信上写「看完就可以发」，点了确认才说默认关着）。
  const off = channel !== 'email' && PLATFORM_KEY[platform] && !platformActionsEnabled(PLATFORM_KEY[platform]);
  if (off) return {
    id: `draft:${draft?.draft_id || q.refs?.draft_id}`, type: 'review', blocked_send: true, title: `#${n} ${q.lead.company}`, question: platformActionReason(PLATFORM_KEY[platform]),
    context: ctxLine({ ...l, ...q.lead }, channel),
    preview: draft ? { kind: 'draft', channel, platform, to: draft.to || '', subject: draft.subject || '', body: draft.body || '', attachments: files, resume: draft.resume || null, fingerprint, warning, ...(limit ? { limit, chars: len, over } : {}) } : null,
    options: [
      option(1, '打开设置', [{ type: 'navigate', to: PLATFORM_ACTIONS_GO }], { primary: true }),
      option(2, '这条不发了', [{ type: 'command', text: `${n} 不发` }], { danger: true }),
    ],
    other: null, lead: q.lead, url: q.refs?.url || null, draft_id: draft?.draft_id || null,
  };
  // 超了字数：「AI 缩短」由 Writer 按上限重写一版、存成新的草稿（存了也不发，这封信变回「看完就可以发」，你看过再点发送）；
  // 「我来改」打开编辑框；「这条不发了」作废这份草稿。
  if (over) return {
    id: `draft:${draft?.draft_id || q.refs?.draft_id}`, type: 'review', title: `#${n} ${q.lead.company}`,
    question: `${CHANNEL_WORD[draft?.channel] || what}最多 ${limit} 字，这一份 ${len} 字，多了 ${len - limit} 字，缩短了才能发。`,
    context: ctxLine({ ...l, ...q.lead }, channel),
    preview: draft ? { kind: 'draft', channel, platform, to: draft.to || '', subject: draft.subject || '', body: draft.body || '', attachments: files, resume: draft.resume || null, fingerprint, warning, limit, chars: len, over } : null,
    options: [
      option(1, 'AI 缩短', [{ type: 'draft_shorten', draft_id: draft?.draft_id }], { hint: `${crewName('quill')} 缩到 ${limit} 字以内，你看过再发`, primary: true }),
      option(2, '我自己改', [{ type: 'draft_editor', draft_id: draft?.draft_id }]),
      option(3, '这条不发了', [{ type: 'command', text: `${n} 不发` }], { danger: true }),
    ],
    other: null, lead: q.lead, url: q.refs?.url || null, draft_id: draft?.draft_id || null,
  };
  const send = option(1, '发送', [{ type: 'action', kind: 'send', input: { draft_id: draft?.draft_id }, fingerprint, confirm: 'inline' }], { hint: sendHint, primary: true, needs: ['preview'] });
  return {
    id: `draft:${draft?.draft_id || q.refs?.draft_id}`, type: 'review', title: `#${n} ${q.lead.company}`, question: `${what}${count}，看完就可以发。`, draft_id: draft?.draft_id || null,
    context: ctxLine({ ...l, ...q.lead }, channel),
    preview: draft ? { kind: 'draft', channel, platform, to: draft.to || '', subject: draft.subject || '', body: draft.body || '', attachments: files, resume: draft.resume || null, fingerprint, warning, ...(limit ? { limit, chars: len, over } : {}) } : null,
    options: [
      send,
      option(2, '我来改', [{ type: 'draft_editor', draft_id: draft?.draft_id }], { hint: '打开编辑框，改完保存就能发' }),
      option(3, '不发了', [{ type: 'command', text: `${n} 不发` }], { hint: '作废这份草稿', danger: true }),
    ],
    other: { placeholder: '说怎么改，比如「语气正式一点，提一下母校」，系统改好再给你看', steps: [{ type: 'command', text: `改 ${n} {text}` }] },
    lead: q.lead, url: q.refs?.url || null,
  };
}

// 命令行时代教你回一句话的那几句（「等你回『投 全部』或『投 编号』后才预填」「回复『投 390』」「在工作台重新批准」）：App 里没有地方回，信上不带。
const CLI_SAYS = /[^。\n]*(?:回(?:复)?\s*[「『“"]\s*(?:投|发)\s*(?:全部|编号|N|\d+)[^」』”"]*[」』”"]|在工作台重新批准)[^。\n]*[。；;]?/g;
export const withoutCliSays = t => String(t || '').replace(CLI_SAYS, '').replace(/\n{3,}/g, '\n\n').trim();
function applyProposalAsk(q, l) {
  const n = q.lead.number, N = n ?? '{n}', needNumber = n == null ? [{ type: 'ensure_number', record_id: q.lead.record_id }] : [];
  return {
    id: `apply:${q.lead.record_id || n}`, type: 'decide', title: `${n != null ? '#' + n + ' ' : ''}${q.lead.company}`, question: '系统建议投递这个岗位，投吗？',
    context: ctxLine({ ...l, ...q.lead }, q.channel_key), note: cut(withoutCliSays(q.summary || q.detail), 160), detail: clean(withoutCliSays(q.full_detail || q.detail)),
    options: [
      judgeFirst(q, l) ? judgeOption(q) : option(1, '投递', [...needNumber, { type: 'action', kind: 'prefill', input: { number: N } }], { hint: applyEffect(l || { url: q.refs?.url }), primary: true, preview: 'form' }),
      option(2, '不投', [...needNumber, { type: 'command', text: `pass ${N} {reason}` }], { reasons: PASS_REASONS }),
      option(3, '晚点再看', [...needNumber, { type: 'command', text: `${N} 晚点提醒` }, { type: 'snooze', hours: 2 }]),
    ],
    other: { placeholder: '比如「简历换英文版」「先找内推」', steps: [...needNumber, { type: 'command', text: `关于 ${N} 号 ${q.lead.company}：{text}` }] },
    lead: q.lead, url: q.refs?.url || null, form_preview: q.lead.record_id || n, facts: leadFacts(l),
  };
}

// 执行器停下来问你的（宿主任务 waiting_user），按问题的样子分：没找到联系人 / 链接坏了 → 拍板投不投；
// 列了候选 → 拆成选项；其余 → 你来补一句。
// System 修复停下来问你：标题说是哪一步停下了（原来一律「系统需要你确认」，看不出是什么事，10-01 第 1 轮验收第 25 条）。
// 按出事的那一步（target.label 开头的步骤名，内部名不露）。
const SYSTEM_STEP = [[/^discover|^round|^scan|扫描/, '找岗位的扫描停下了'], [/^judge|^match|^evaluate/, '判断停下了'], [/^reach|^send|^find-|发送/, '联系和发送停下了'], [/^apply|^prepare-app|投递/, '投递停下了'], [/^inbox|^watch|^nightwatch/, '看回复停下了']];
export function systemTitle(job = {}) {
  const t = String(job.target?.label || job.details || '');
  return SYSTEM_STEP.find(([re]) => re.test(t))?.[1] || '运行停下了';
}
// 问题末尾自己又把选项列了一遍（「……请选择继续扫描还是先跳过本轮。（继续扫描 / 先跳过本轮）」）：选项已经是按钮了，这一段去掉。
// 括号后面还跟着句号也算（10-01 第 2 轮验收复核 25：「……先跳过本轮（继续扫描 / 先跳过本轮）。」括号没去掉，混进了按钮）。
export const dropOptionList = q => { const s = String(q || ''); const t = s.replace(/\s*[（(][^（）()]{1,40}[/／|][^（）()]{1,40}[）)]\s*([。.！!？?]?)\s*$/, '$1').trim(); return t === s.trim() ? t : /[。.！!？?]$/.test(t) ? t : `${t}。`; };
// 本机 AI 时代执行器留下的话（实测 10-04 第 12 条：「请在浏览器窗口处理定位权限提示（可拒绝）后反馈，或提供 37 号新的官方岗位链接」）：
// 哪个浏览器窗口、怎么「反馈」，在 App 里都做不了。这类信换成点得到的选择：打开申请页、换一个岗位链接（在信上贴）、这条不推进。
// 执行器的原话留在「详情」里。done：选完以后收掉背后那条记录（任务记完成 / 阻塞记录归档）。
export const LEGACY_HAND = /浏览器窗口|在(?:浏览器|页面)(?:里|中|上)?[^。；]{0,12}处理[^。；]{0,12}后|后(?:回来)?反馈|反馈给我|回复我|告诉我|提供[^。；]{0,20}(?:链接|网址|地址)/;
// 判断说这条不对口（Judge 排除、不在你的方向里，或者执行器的话里自己写着岗位和目标有明显偏差）：默认选「这条不推进」，
// 不高亮「打开申请页」（D11，10-05 #37：信里写着「与目标有明显偏差」，默认却是打开申请页）。
const MISFIT = /明显偏差|严重偏差|不对口|不符合(?:你的|求职|目标|方向)|与(?:目标|方向|求职方向)[^。；]{0,8}(?:不符|不一致|偏差)|而非[^。；]{0,12}(?:开发|工程|技术)岗|并非[^。；]{0,12}(?:开发|工程|技术)岗|not a (?:good )?(?:fit|match)/i;
export function misfit(l, said = '') {
  if (l?.match?.verdict === 'exclude') return true;
  try { if (offDirection(l)) return true; } catch {} // 兜底：规则读不了就只看判断结论和原话
  return MISFIT.test(String(said || ''));
}
function handoffAsk(q, l, said, done = []) {
  const n = q.lead.number, url = applyUrl(l) || q.refs?.url || l?.url || null, off = misfit(l, said);
  return {
    from: q.role === 'system' ? 'system' : 'quill', id: q.host_job?.id ? `job:${q.host_job.id}` : `handoff:${q.id}`, type: 'decide', title: `#${n} ${q.lead.company}`,
    question: '上次打开申请页没走下去，接下来怎么做？', headline: '申请页上次没走下去', job_id: q.host_job?.id || null, context: ctxLine({ ...l, ...q.lead }, leadChannel(l)), detail: clean(said), facts: leadFacts(l), lead: q.lead, url,
    ...(proofOf(l) ? { proof: proofOf(l) } : {}),
    options: seq([
      ...(off ? [option(3, '这条不推进', [{ type: 'command', text: `pass ${n} {reason}` }, ...done], { reasons: PASS_REASONS, primary: true })] : []),
      ...(url ? [option(1, '打开申请页', [{ type: 'open', url }], { primary: !off })] : []),
      option(2, '换一个岗位链接', [{ type: 'set_link', record_id: q.lead.record_id }, ...done], { input: 'url', ...(url || off ? {} : { primary: true }) }),
      ...(off ? [] : [option(3, '这条不推进', [{ type: 'command', text: `pass ${n} {reason}` }, ...done], { reasons: PASS_REASONS, danger: true })]),
    ]),
    other: null,
  };
}
const withThread = (j, jobs = []) => { if (j.thread || j.persona) return j; const r = [...(jobs || [])].reverse().find(x => x?.id === j.id && (x.thread || x.persona)); return r ? { ...j, thread: r.thread || null, persona: r.persona || null } : j; };
function jobAsk(q, l, job, question, twins = []) {
  const n = q.lead.number, rid = q.lead.record_id, channel = l ? leadChannel(l) : q.channel_key;
  // 同一条线索同一类任务的重复条目一起收掉，免得答完一条另一条又冒出来。
  const resolve = note => ({ type: 'job', id: job.id, action: 'resolve', note, twins });
  const feedback = note => ({ type: 'job', id: job.id, action: 'feedback', note });
  // headline：收件箱列表上那一行（执行器的长句收成一句，lib/short-title.mjs）；全文还在 question 里。
  // 发信人和任务看板上那张卡同一位（lib/crew.mjs memberOfJob）：对话里交给 Judge 的事，信也是 Judge 发来的。
  const base = { from: memberOfJob(job) || q.role || 'system', headline: shortTitle(question, { ask: true }) || null, facts: leadFacts(l), title: n != null ? `#${n} ${q.lead.company}` : JOB_TITLE[job.kind] || cut(job.label || job.kind, 40), context: l ? ctxLine({ ...l, ...q.lead }, channel) : [], detail: clean([question, job.result && job.result !== question ? job.result : ''].filter(Boolean).join('\n\n')), lead: q.lead, url: q.refs?.url || (l ? applyUrl(l) : null), job_id: job.id, evidence: job.evidence || null };
  const applyable = l && n != null && ['portal', 'ats_form'].includes(channel);
  // 阿里的旧链接已由 bin/fix-alitalent-urls.mjs 全部换成控股招聘站（application_url 可能在阿里云等业务站点），执行器之前"补充有效链接"的问题就过时了。
  const deadLinkFixed = l && DEAD_LINK.test(question) && [applyUrl(l), l.url].some(u => familyOf(u)?.family === 'alibaba' && !/\/\/talent\.alibaba\.com\/off-campus\/position-detail/.test(u || ''));
  if (applyable && (NO_CONTACT.test(question) || deadLinkFixed)) {
    return {
      ...base, id: `job:${job.id}`, type: 'decide',
      question: deadLinkFixed ? '岗位链接已经修好（阿里控股招聘站能打开），官网可以投，没找到公开的招聘联系人。怎么推进？' : '官网可以投，但没找到公开的招聘联系人。怎么推进？',
      note: deadLinkFixed ? '之前问的「补充有效链接」已过时：阿里的旧链接已全部换成新地址。' : cut(question, 160),
      options: [
        option(1, '投递官网', [{ type: 'action', kind: 'prefill', input: { number: n } }, resolve('用户在收件箱选择：投递官网')], { hint: applyEffect(l), primary: true, preview: 'form' }),
        option(2, '先找内推或招聘人', [feedback('先找内推人或招聘联系人（领英、脉脉、公司员工都可以），找到后起草首联给我审；找不到就告诉我，再决定投官网。')], { hint: '系统再搜一轮，找到人后起草首联给你审' }),
        option(3, '不推进', [{ type: 'command', text: `pass ${n} {reason}` }, resolve('用户在收件箱选择：不推进')], { reasons: PASS_REASONS, danger: true }),
      ],
      other: { placeholder: '或者直接说怎么做', steps: [feedback('{text}')] },
    };
  }
  if (l && n != null && LEGACY_HAND.test(question)) return handoffAsk({ ...q, host_job: job }, l, [question, job.result && job.result !== question ? job.result : ''].filter(Boolean).join('\n\n'), [resolve('用户在收件箱处理了旧版留下的这一步')]);
  const parts = questionChoices(question).length ? null : eitherOrParts(dropOptionList(question));
  if (parts) {
    return {
      ...base, id: `job:${job.id}`, type: 'decide', question: cut(dropOptionList(question), 220),
      options: [...parts.choices.map((c, i) => option(i + 1, c, [feedback(`针对问题：${cut(question, 200)}\n我的选择：${c}`)], { ...(i === 0 ? { primary: true } : {}), ...(parts.extras[i] ? { hint: parts.extras[i] } : {}) })),
        ...(n != null ? [option(3, '整条不推进', [{ type: 'command', text: `pass ${n} {reason}` }, resolve('用户在收件箱选择：整条不推进')], { reasons: PASS_REASONS, danger: true })] : [option(3, '放弃这项任务', [{ type: 'job', id: job.id, action: 'drop' }], { danger: true })])],
      other: { placeholder: '或者直接说你的想法', steps: [feedback('{text}')] },
    };
  }
  const choices = questionChoices(question);
  if (choices.length) {
    return {
      ...base, id: `job:${job.id}`, type: 'info', question: cut(question, 200),
      options: [...choices.filter(c => !NOT_ON.test(c)).map((c, i) => option(i + 1, c, [feedback(`针对问题：${cut(question, 200)}\n我的选择：${c}`)])), option(choices.filter(c => !NOT_ON.test(c)).length + 1, choices.find(c => NOT_ON.test(c)) || '都不推进', [...(n != null ? [{ type: 'command', text: `pass ${n} 都不推进` }] : []), resolve('用户在收件箱选择：都不推进')], { danger: true })],
      other: { placeholder: '或者直接说你的想法', steps: [feedback('{text}')] },
    };
  }
  // 要你先在浏览器窗口里亲手过一步（滑块、验证码），过完再继续（10-01 第 2 轮验收第 26 条：选项却是「好的，照这个做 / 不用了」）。
  if (HAND_STEP.test(question) && /继续/.test(question)) {
    return {
      ...base, id: `job:${job.id}`, type: 'info', question: cut(question, 220),
      options: [
        option(1, '验证好了，继续', [feedback(`针对问题：${cut(question, 200)}\n我的答复：验证我在窗口里过好了，继续。`)], { primary: true }),
        option(2, '这次先跳过', [feedback(`针对问题：${cut(question, 200)}\n我的答复：这次先跳过，下一轮再说。`)]),
        ...(n != null ? [option(3, '整条不推进', [{ type: 'command', text: `pass ${n} {reason}` }, resolve('用户在收件箱选择：整条不推进')], { reasons: PASS_REASONS, danger: true })] : [option(3, '放弃这项任务', [{ type: 'job', id: job.id, action: 'drop' }], { danger: true })]),
      ],
      other: { placeholder: '或者直接说你的想法', steps: [feedback('{text}')] },
    };
  }
  return {
    ...base, id: `job:${job.id}`, type: DECISION_Q.test(question) ? 'decide' : 'info', question: cut(question, 220),
    options: [
      option(1, '好的，照这个做', [feedback(`针对问题：${cut(question, 200)}\n我的答复：确认，按你说的做。`)], { primary: true }),
      option(2, '不用了', [feedback(`针对问题：${cut(question, 200)}\n我的答复：不用，这件事先放下。`)]),
      ...(n != null ? [option(3, '整条不推进', [{ type: 'command', text: `pass ${n} {reason}` }, resolve('用户在收件箱选择：整条不推进')], { reasons: PASS_REASONS, danger: true })] : [option(3, '放弃这项任务', [{ type: 'job', id: job.id, action: 'drop' }], { danger: true })]),
    ],
    other: { placeholder: '或者直接说你的想法', steps: [feedback('{text}')] },
  };
}

// 面试时间按本地时区说到哪天几点：今天 14:00、明天 14:00，别的日子 9-30 14:00（和指挥台上约了几点的写法一样）。
const LOCAL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }), LOCAL_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function interviewTime(at, now = Date.now()) {
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return '';
  const day = LOCAL_DAY.format(t), days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${LOCAL_DAY.format(now)}T00:00:00Z`)) / 86400000), hm = LOCAL_CLOCK.format(t);
  return days === 0 ? `今天 ${hm}` : days === 1 ? `明天 ${hm}` : days === -1 ? `昨天 ${hm}` : `${Number(day.slice(5, 7))}-${Number(day.slice(8, 10))} ${hm}`;
}
// 参加面试这一问：还没到点问准备好了没有，过了点问结束了没有；不知道几点就不写几点。
function attendQuestion(at, now) {
  const when = interviewTime(at, now);
  if (!when) return '面试快到了，准备好了吗？';
  return Date.parse(at) > now ? `面试就在${/^\d/.test(when) ? ' ' : ''}${when}，准备好了吗？` : `面试（${when}）结束了吗？`;
}

const BOSS_CHAT = /^https:\/\/www\.zhipin\.com\/web\/geek\/chat/;
// 脉脉消息列表（lib/maimai-inbox.mjs）和 LinkedIn 通知邮件（lib/linkedin-mail.mjs）来的：你在那边自己回；系统看不到你回没回，
// 回过了点「我回过了」收起。
const PLATFORM_REPLY = [
  { re: /^https:\/\/maimai\.cn\//, question: '对方在脉脉上回了你。', open: '打开脉脉消息' },
  { re: /^https:\/\/www\.linkedin\.com\/messaging\//, question: '对方在 LinkedIn 上回了你。', open: '打开 LinkedIn 消息' },
];
function platformReply(q) {
  const p = PLATFORM_REPLY.find(p => p.re.test(q.refs?.url || ''));
  if (!p) return null;
  return { question: p.question, options: [option(1, p.open, [{ type: 'open', url: q.refs.url }], { primary: true }), ...(q.lead?.record_id ? [option(2, '我回过了', [{ type: 'reply_done', record_id: q.lead.record_id }])] : [])] };
}
function interviewAsk(q, now = Date.now(), replyMessage = null) {
  const n = q.lead.number, co = q.lead.company;
  const kinds = {
    // 接了内置邮箱、邀请里带着时间：一键「确认并回复」（lib/mail/interview.mjs）；否则照旧自己记时间。
    get schedule() { return interviewConfirmAsk(q) || { question: '招聘方约面试了，把时间记下来？', options: [option(1, '记录面试时间', [{ type: 'command', text: `${n} 面试 {datetime}` }], { input: 'datetime', primary: true })] }; },
    attend: { question: attendQuestion(q.due_at, now), options: [...(q.refs?.url ? [option(1, '打开会议入口', [{ type: 'open', url: q.refs.url }], { primary: true })] : []), option(q.refs?.url ? 2 : 1, '面试完成', [{ type: 'command', text: `${n} 面试完成` }])] },
    // BOSS 聊天里来的（lib/boss-inbox.mjs）：你在 BOSS 上自己回，系统不代发；回过之后这封信自己收起。
    reply: BOSS_CHAT.test(q.refs?.url || '') ? { question: '对方在 BOSS 上回了你。', options: [option(1, '打开 BOSS 聊天', [{ type: 'open', url: q.refs.url }], { primary: true })] }
      : platformReply(q) || { question: '对方回复了，你想怎么回？系统据此起草，发送前给你看。', options: [] },
    review: { question: '面试结束了，记几句复盘？', options: [] },
    dossier: { question: '面试准备材料已备好。', options: [...(q.refs?.url ? [option(1, '打开准备材料', [{ type: 'open', url: q.refs.url }], { primary: true })] : [])] },
  }[q.kind] || { question: q.title, options: [] };
  const verb = q.kind === 'review' ? '复盘' : '备注';
  // 对方回复：对方的原话直接放在信上（said），列表那一行也是它（10-01 第 1 轮验收第 21 条：要点开「详情与证据」才看得到对方说了什么）。
  const said = q.kind === 'reply' ? cut(clean(q.full_detail || q.detail), 300) : '';
  return {
    id: `interview:${q.id}`, type: 'interview', title: `#${n} ${co}`, question: kinds.question, context: ctxLine(q.lead, null), detail: clean(q.full_detail || q.detail),
    ...(said ? { said, headline: said } : {}),
    ...(kinds.preview ? { preview: kinds.preview } : q.kind === 'reply' && replyMessage?.source === 'linkedin-browser' ? {preview:{kind:'message',...replyMessage}} : {}),
    options: kinds.options, other: { placeholder: q.kind === 'reply' ? '比如「周四下午都可以，问下是几轮」' : '写点什么', steps: [{ type: 'command', text: `${n} ${verb} {text}` }] },
    lead: q.lead, url: q.refs?.url || null, due_at: q.due_at || null,
  };
}

function clarifyAsk(q) {
  const n = q.lead.number;
  return {
    id: `clarify:${q.id}`, type: 'info', title: `#${n} ${q.lead.company}`, question: cut(q.detail || q.title, 220), context: ctxLine(q.lead, null), detail: clean(q.full_detail || q.detail),
    options: [], other: { placeholder: '直接回答', steps: [{ type: 'command', text: `关于 ${n} 号 ${q.lead.company}：{text}` }] }, lead: q.lead, url: q.refs?.url || null,
  };
}

// 要你本人提交的门户（10-05 #316 网易）：说清这次传哪一份简历（哪一版、文件名，「在访达里显示简历」拿得到文件）、
// 要不要先登录；上次「打开申请页」落空了（跳到首页、岗位下线、跳到别的网站，lib/landing.mjs）就照实说，多给一个「换一个岗位链接」。
// 不再笼统说「材料已备好」。
function resumeLine(l) {
  let p = null;
  try { p = l ? resumePick(l) : null; } catch { p = null; } // 兜底：算不出用哪份就照实说还没定
  if (!p?.label && !p?.file) return { text: '还没定用哪份简历：在「材料」里给这个岗位选一份。', pick: null };
  const name = p.file ? String(p.file).split('/').pop() : '';
  return { text: `简历传「${p.label || name}」${name ? `（${name}）` : '（PDF 还没导出，点「在访达里显示简历」时现导）'}。`, pick: p };
}
function loginLine(l, url) {
  const f = url ? familyOf(url) : null;
  if (!f || f.kind !== 'portal') return '';
  let s = null; try { s = l ? portalSession(l) : null; } catch { s = null; } // 兜底：登录记录读不出就当没登录过
  return s?.logged_in === true ? '' : `要先登录${f.label}。`;
}
function submitAsk(q, l) {
  const n = q.lead.number, rid = q.lead.record_id, url = q.refs?.url || (l ? applyUrl(l) : null);
  const lead = { ...(l || {}), ...q.lead };
  const last = rid ? lastLanding(rid) : null, lost = landingFailed(last) && !!url && (last.url === url || last.opened === url);
  const cv = resumeLine(l);
  const question = `${lost ? `上次打开申请页：${landingWords(last, { url, lead })}。` : ''}这个门户要你本人提交。${loginLine(l, url)}${cv.text}`;
  return {
    id: `submit:${q.id}`, type: 'review', title: `#${n} ${q.lead.company}`, question, context: ctxLine({ ...l, ...q.lead }, l ? leadChannel(l) : 'portal'), detail: clean(q.full_detail || q.detail),
    options: [
      ...(url ? [option(1, '打开申请页', [{ type: 'open', url }], { hint: '在专用 Chrome 里打开，由你核对并点提交', primary: !lost })] : []),
      ...(cv.pick && rid ? [option(4, '在访达里显示简历', [{ type: 'reveal_resume', record_id: rid }])] : []),
      ...(lost && rid ? [option(5, '换一个岗位链接', [{ type: 'set_link', record_id: rid }], { input: 'url', primary: true })] : []),
      option(url ? 2 : 1, '我已提交', [{ type: 'command', text: `${n} 这步好了` }], { hint: '记为已投递，之后按投递跟进' }),
      option(url ? 3 : 2, '不投了', [{ type: 'command', text: `pass ${n} {reason}` }], { reasons: PASS_REASONS, danger: true }),
    ],
    other: { placeholder: '遇到什么问题？', steps: [{ type: 'command', text: `关于 ${n} 号 ${q.lead.company}：{text}` }] }, lead: q.lead, url, form_preview: q.lead.record_id || n,
  };
}

// 变了什么照工作台核对时记下的说（lib/inbox-recheck.mjs recheckApprovals → auto_apply.approval_stale.changed，lib/approval-change.mjs）；
// 还没核对过的，照旧笼统说一句。changes 给页面上的批量确认列清单用。
// 「材料变了」：批准以后入口、简历变了，按现在的材料再确认一次。说清是哪一样变了（lib/approval-change.mjs）；
// 旧版的批准说不出是哪一样（只记了整份指纹）、又已经批准超过一天的，归到「批准很久了」（和 lib/stale-approvals.mjs 同一类）：
// 照实说旧版没记下当时用的是哪份材料，「投递」按现在的材料确认，「不要了」把批准撤回（不结束这条线索）。
// 详情只写变了什么：以前带着命令行时代的话（「回复『投 390』」「在工作台重新批准」），App 里没有地方回。
const DAY = 86400000;
function reapproveAsk(q, l, now) {
  const n = q.lead.number, rid = q.lead.record_id, a = l?.auto_apply || {}, changes = a.approval_stale?.changed || null, never = !a.approved_at;
  // 根本没有批准可依（实测 10-05：15 封，线索上 approval 全空）：这不是「材料变了」，是 journey 给能自动填的
  // 公开表单 / 门户岗位排的拟投（lib/journey.mjs auto_apply，awaiting = 还没批准）。改成普通的「投递待批准」，详情不带
  // 拟投清单那几句命令行时代的话（「等你回『投 全部』或『投 编号』」）。同一条已经有拟投信的，buildAsks 按 id 只留一封。
  if (never) return applyProposalAsk({ ...q, summary: '', detail: '', full_detail: '' }, l);
  const unknown = !never && (!changes?.length || changes.every(c => c.what === 'old'));
  const days = a.approved_at ? Math.floor((now - Date.parse(a.approved_at)) / DAY) : null;
  const context = ctxLine({ ...l, ...q.lead }, l ? leadChannel(l) : 'portal');
  if (unknown && rid && (days == null || days >= 1)) return {
    from: 'reacher', id: `stale:lead:${rid}`, type: 'review', title: `#${n} ${q.lead.company}`,
    question: `${days ? `这是 ${days} 天前批准的` : '这是旧版里批准的'}，旧版没记下当时用的是哪份材料。还要投吗？`, context,
    options: [option(1, '投递', [{ type: 'action', kind: 'prefill', input: { number: n } }], { hint: applyEffect(l || {}), primary: true, preview: 'form' }),
      option(2, '不要了', [{ type: 'withdraw_approval', record_id: rid }], { danger: true })],
    other: null, lead: q.lead, url: q.refs?.url || null, form_preview: rid || n,
  };
  const what = changes?.length ? changeWords(changes) : null;
  return {
    id: `reapprove:${rid || n}`, type: 'review', title: `#${n} ${q.lead.company}`,
    question: never ? '按现在的材料投递吗？' : `你批准以后${what || changeLine({ what: 'old' })}。按现在的材料重新确认一次？`, context,
    ...(what ? { headline: cut(what, 40), changes: changes.map(changeLine) } : {}),
    options: [option(1, '按新材料投递', [{ type: 'action', kind: 'prefill', input: { number: n } }], { hint: applyEffect(l || {}), primary: true, preview: 'form' }), option(2, '不投了', [{ type: 'command', text: `pass ${n} {reason}` }], { reasons: PASS_REASONS, danger: true })],
    other: { placeholder: '比如「换中文简历」', steps: [{ type: 'command', text: `关于 ${n} 号 ${q.lead.company}：{text}` }] }, lead: q.lead, url: q.refs?.url || null, form_preview: rid || n,
  };
}

// 表已在浏览器里预填好、停在提交前（lib/auto-apply.mjs 只预填，或电脑操作恢复后预填）：你检查、补空着的项，在页面上自己提交。
// 自动预填记下了填了几项、哪些必填还空着（auto_apply.prefill）；电脑操作那条路没有这些，就只说停在提交前。
// 预填时简历已经传上去了（lib/auto-apply.mjs resumeOnPage）：信里和终审里直说，申请没提交。
export const RESUME_ON_PAGE = '简历已经传到对方页面上了，申请还没提交';
export const HANDOVER = '剩下的要你接手：打开申请页检查、补全，然后自己提交。';
// 「填好的内容」只列真填上了的（读回是空、没找到控件、没勾上的不算）。
const filledValue = v => { const t = String(v ?? '').trim(); return !!t && t !== '（没找到控件）' && t !== '未勾选'; };
function prefilledAsk(q, l) {
  const info = autoApplyNeeds(l).find(n => n.kind === 'info');
  if (info) return infoAsk(q, l, null, info);
  const n = q.lead.number, rid = q.lead.record_id, p = l?.auto_apply?.prefill || null;
  const url = p?.url || l?.auto_apply?.url || q.refs?.url || (l ? applyUrl(l) : null);
  // 那一页没了——旧版在 ego 里填的（ego 已停用）、系统自带的浏览器（填完就关）、专用 Chrome 里那一页后来关了或者专用 Chrome 重开过
  // （工作台启动、专用 Chrome 重开时核对，lib/application-page.mjs checkKeptPages；打开申请页时也会发现）——
  // 主句就说那一页没了、为什么，能怎么办（重新预填，或者按截图自己填）；不再说「已经预填好了」（负责人 10-05 #482：主句和附注对不上）。
  // 「重新预填」：lib/apply-retry.mjs refillApply，在专用 Chrome 里重新填，停在提交前，那一页留着。
  // 设置里把投递驱动改成了系统自带的浏览器（config/pipeline.json auto_apply_driver），重新预填也留不下页面，就不给这个按钮。
  const why = lostPage(l || q.lead), kept = !why && (!p || p.browser === 'chrome');
  const refill = !!why && !!rid && (pageGone(rid) || pickApplyDriver({ mode: read('config/pipeline.json', {}).auto_apply_driver }) === 'chrome');
  // 读回来还空着的必填项照实列出来、说要你自己填（负责人 10-05 #482：国籍、所在国家、同意框空着，信里却写「能填的已经预填好了」；
  // 这一条盖过 09-30「不逐项列」）。自绘下拉框读回可能不准，所以说「读回来是空的」（lib/apply-words.mjs missingLine）。
  const gaps = p && !why ? missingLine(p.missing || []) : null;
  const question = why ? `#${n} ${q.lead.company} 之前预填好的那一页没了（${why}）。${refill ? '可以重新预填，填好停在提交前；也可以按截图里的值自己填，然后自己提交。' : '要按截图里的值自己填，然后自己提交。'}`
    : gaps ? `#${n} ${q.lead.company} 认得出的项预填好了；${gaps.line}。${p.resume_on_page ? `${RESUME_ON_PAGE}。` : ''}填好再自己提交。`
    : p ? `#${n} ${q.lead.company} 能填的已经预填好了。${p.resume_on_page ? `${RESUME_ON_PAGE}。` : ''}${HANDOVER}` : '申请表已在浏览器里预填好，停在提交前：请核对后亲自点提交。';
  // 附注只说主句没说的：「打开申请页」打开的是什么。
  const where = why ? '「打开申请页」打开的是空白的新申请页'
    : !p ? null
    : p.browser === 'dry' ? '沙盒演示：没有打开真的浏览器，申请页上什么也没填'
    : '预填好的页面保留在专用 Chrome 里，点「打开申请页」可回到对应页面';
  // 上传的简历：要用的那一版没用上、还有定制版在等你看，各说一句（lib/resume-choice.mjs，和终审信同一套）。
  const extra = p ? resumeNotes(p, l) : '', note = extra && where ? `${where}。${extra}` : where || extra;
  const open = option(1, '打开申请页', kept ? [{ type: 'application_page', record_id: rid }] : url ? [{ type: 'open', url }] : [], { primary: !refill });
  return {
    id: `prefilled:${rid || n}`, type: 'review', title: `#${n} ${q.lead.company}`, question, context: ctxLine({ ...l, ...q.lead }, l ? leadChannel(l) : 'portal'), detail: clean(q.full_detail || q.detail),
    ...(note ? { note } : {}),
    ...(p ? { preview: { kind: 'form', screenshot: p.screenshot || null, fields: (p.fields || []).filter(f => filledValue(f.value)), url, filled_at: p.at || null, ...(p.resume ? { resume: uploadedResume(p) } : {}) } } : {}),
    options: [
      // 那一页没了：「重新预填」排第一、是主按钮（打开申请页只是一张空表）。键照旧（打开申请页 1、重新预填 4）。
      ...(refill ? [option(4, '重新预填', [{ type: 'refill', record_id: rid }], { primary: true, hint: '在专用 Chrome 里重新填，停在提交前，不替你提交' })] : []),
      open,
      option(2, '我已在页面上提交了', [{ type: 'command', text: `${n} 这步好了` }], { hint: '记为你亲自投递，这条走到已投递' }),
      option(3, '这条不推进', [{ type: 'command', text: `pass ${n} {reason}` }], { reasons: PASS_REASONS, danger: true }),
    ],
    other: { placeholder: '哪里填错了？', steps: [{ type: 'command', text: `关于 ${n} 号 ${q.lead.company}：{text}` }] }, lead: q.lead, url, form_preview: rid || n,
  };
}

// 预填没做成（auto_apply failed）：系统不会自己再来一次（O5），信上给「重新预填」和「打开申请页」，说的和做的一样。
function refillOptions(l, q) {
  const a = l?.auto_apply, rid = q.lead?.record_id, url = l ? applyUrl(l) : q.refs?.url || null;
  if (a?.status !== 'failed' || a.error === 'page_closed' || !rid) return [];
  return seq([
    option(1, '重新预填', [{ type: 'refill', record_id: rid }], { primary: true, hint: '在专用 Chrome 里重新填，停在提交前，不替你提交' }),
    ...(url ? [option(2, '打开申请页', [{ type: 'open', url }])] : []),
  ]);
}

// 旧卡点转成同一种提问；只拆明确的字段清单，不收密码、证件或验证码。
export function legacyFields(text) {
  const m = String(text || '').match(/(?:必填(?:字段|信息|项)?|缺少(?:字段|信息)?|需要补充(?:信息|字段)?)[^：:\n。]{0,24}[：:]([^。；;\n]+)/);
  if (!m) return [];
  const labels = m[1].split(/[、，,]/).map(cleanFieldLabel).filter(Boolean);
  if (!labels.length || labels.length > 12 || labels.some(x => NEVER_COLLECT.test(x) || x.length > 40)) return [];
  return [...new Set(labels)].map((label, i) => ({ key: `field_${i + 1}`, label, type: 'text' }));
}
function legacyAsk(q, l) {
  const text = q.full_detail || q.detail || q.summary || '', fields = legacyFields(text);
  if (fields.length && q.lead?.record_id) return infoAsk(q, l, null, { question: '申请表还缺这些信息。保存后会重新预填，提交前仍由你检查。', fields });
  const choices = questionChoices(text);
  const opts = choices.filter(x => !NOT_ON.test(x)).map((choice, i) => option(i + 1, choice, [{ type: 'request', number: q.lead?.number, record_id: q.lead?.record_id, details: `针对问题：${text}\n我的选择：${choice}` }]));
  return { from: q.role || 'system', id: `blocked:${q.id}`, ...(proofOf(l) ? { proof: proofOf(l) } : {}), type: choices.length ? 'decide' : 'info', title: q.lead?.number != null ? `#${q.lead.number} ${q.lead.company}` : cut(q.title, 40), question: clean(q.summary), context: l ? ctxLine({ ...l, ...q.lead }, leadChannel(l)) : [], detail: clean(text), options: seq([...opts, ...refillOptions(l, q), ...(q.lead?.number != null ? [giveUp(q, null)] : [])]), other: q.lead?.number != null ? { placeholder: '告诉系统怎么处理', steps: tellJob(null, q) } : null, lead: q.lead, url: q.refs?.url || null };
}

// 城市范围：执行器说"冲刺城市拦截了"，其实是问你这条要不要破例。
function cityAsk(q, l) {
  const n = q.lead.number;
  return {
    id: `city:${q.lead.record_id || n}`, type: 'decide', title: `#${n} ${q.lead.company}`, question: `这个岗位在${(leadCity(l || {}) && leadCity(l || {}) !== '其他' ? leadCity(l) : cut(l?.location || '', 30)) || '优先城市以外'}，不在你现在优先的城市。还投吗？`, context: ctxLine({ ...l, ...q.lead }, l ? leadChannel(l) : null),
    options: [option(1, '破例投这一个', [{ type: 'action', kind: 'prefill', input: { number: n } }], { hint: '只放行这一条，城市偏好不变', primary: true, preview: 'form' }), option(2, '不投', [{ type: 'command', text: `pass ${n} 城市不对` }])],
    other: null, lead: q.lead, url: q.refs?.url || null,
  };
}

// ── 按固定字段生成的信（harness）：执行器用 bin/job.mjs need 写的，或自动投递的原因码转来的。
// 选项由种类决定，不看文字猜。
function needBase(q, l, job, need) {
  const n = q.lead?.number;
  // 发信人：在做这件事的那位成员（和任务看板上那张卡同一位，lib/crew.mjs memberOfJob），不是「执行器」（10-01 第 1 轮验收第 23 条）。
  return { from: job ? memberOfJob(job) : q.role || 'reacher', headline: needShort(need) || null, ...(proofOf(l) ? { proof: proofOf(l) } : {}), title: n != null ? `#${n} ${q.lead.company}` : JOB_TITLE[job?.kind] || cut(job?.label || job?.details || job?.kind || '需要你处理', 40), context: l ? ctxLine({ ...l, ...q.lead }, leadChannel(l)) : [], note: need.note ? clean(need.note) : null, url: need.url || q.refs?.url || (l ? applyUrl(l) : null), lead: q.lead, job_id: job?.id || null, evidence: job?.evidence || null, detail: job?.result && job.result !== need.question ? clean(job.result) : null };
}
// 选项编号按顺序排（10-01 第 2 轮验收第 6 条：「1 填好提交」后面直接跳到「9 不投」）。
const seq = opts => opts.map((o, i) => ({ ...o, key: String(i + 1) }));
const giveUp = (q, job) => q.lead?.number != null
  ? option(9, '这条不推进', [{ type: 'command', text: `pass ${q.lead.number} {reason}` }, ...(job ? [{ type: 'job', id: job.id, action: 'resolve', note: '用户在收件箱选择：不推进' }] : [])], { reasons: PASS_REASONS, danger: true })
  : option(9, '放弃这项任务', [{ type: 'job', id: job.id, action: 'drop' }], { danger: true });
const tellJob = (job, q) => job ? [{ type: 'job', id: job.id, action: 'feedback', note: '{text}' }] : [{ type: 'command', text: `关于 ${q.lead.number} 号 ${q.lead.company}：{text}` }];
// 能记进答案簿的项：申请表上的一项（短文本、日期、数字、选项）；长段落（一段 JD、项目说明）是这一件事的材料，不是以后表上会再问的。
const bookable = f => f && f.type !== 'long_text';
export function infoAsk(q, l, job, need) {
  const where = job ? `job:${job.id}` : `lead:${q.lead.record_id}`;
  // 申请表上的一项记进答案簿，以后别的表自动填；一段 JD、一段说明这类长段落只交给在做的那位，不记（10-01 第 1 轮验收第 23 条：
  // 要补的是一段 JD，后果却写「以后申请表会自动填」）。执行器的任务带着答案继续，自动投递的线索重新排队（再填表时从答案簿取）。
  const book = (need.fields || []).filter(bookable);
  const steps = [{ type: 'remember', fields: book }, ...(job ? [{ type: 'job', id: job.id, action: 'feedback', note: `针对问题：${need.question}\n我的答复：{fields}` }] : [{ type: 'requeue_apply', record_id: q.lead.record_id }])];
  const who = job ? crewName(memberOfJob(job)) : null;
  const hint = !job ? '记进本地答案簿；再填申请表时自动用上' : book.length ? `交给 ${who} 接着做；${book.length === (need.fields || []).length ? '' : '其中申请表上的项'}也记进答案簿，以后的申请表自动填` : `交给 ${who} 接着做`;
  // 答案簿里已经有的项（你在别的申请表上答过）直接填好，你看一眼确认就行（remembered 标出来）。
  const known = loadBook(), form = (need.fields || []).map(f => { const v = bookable(f) ? lookup(known, f.label) : null; return v != null ? { ...f, value: v, remembered: true } : f; });
  return { ...needBase(q, l, job, need), id: `need:${where}:info`, type: 'info', question: clean(need.question), form,
    options: seq([option(1, '保存并继续', steps, { input: 'fields', primary: true, hint }), ...(q.lead?.number != null || job ? [giveUp(q, job)] : [])]),
    other: { placeholder: '或者直接说明情况', steps: tellJob(job, q) } };
}
// 执行器列了「都不推进」这类选项时，它就是信上的「这条不推进」：用执行器的字、按「不推进」去做，不再另挂一个（10-01 第 2 轮验收第 25 条）。
function decideAsk(q, l, job, need) {
  const go = need.options.filter(o => !NOT_ON.test(o)), stop = need.options.find(o => NOT_ON.test(o));
  const end = giveUp(q, job);
  return { ...needBase(q, l, job, need), id: `need:job:${job.id}:decide`, type: 'decide', question: dropOptionList(clean(need.question)),
    options: seq([...go.map((o, i) => option(i + 1, o, [{ type: 'job', id: job.id, action: 'feedback', note: `针对问题：${need.question}\n我的选择：${o}` }], i === 0 ? { primary: true } : {})), stop ? { ...end, label: stop } : end]),
    other: { placeholder: '或者直接说你的想法', steps: tellJob(job, q) } };
}
function approveAsk(q, l, job, need) {
  const url = need.url || null;
  return { ...needBase(q, l, job, need), id: `need:job:${job.id}:approve`, type: 'review', question: clean(need.question),
    options: seq([option(1, '确认，继续', [{ type: 'job', id: job.id, action: 'feedback', note: `针对问题：${need.question}\n我的答复：确认，继续。` }], { primary: true }), ...(url ? [option(2, '先打开看看', [{ type: 'open', url }], { hint: '在浏览器里打开，看完回来确认' })] : []), giveUp(q, job)]),
    other: { placeholder: '哪里不对？直接说', steps: tellJob(job, q) } };
}

// 自动投递停在页面上要你亲手做的一步（验证码、登录）：你在页面上处理完点「继续」，系统重新排队接着填（仍停在终审）。
function pageStepAsk(q, l, need) {
  const n = q.lead.number, rid = q.lead.record_id, url = need.url || applyUrl(l) || null;
  return { ...needBase(q, l, null, need), id: `need:lead:${rid}:approve`, type: 'review', question: clean(need.question), url,
    ...(need.continue === false ? { intervention_code: 'submit' } : {}),
    options: seq([
      ...(need.continue === false ? [] : [option(1, '好了，继续', [{ type: 'requeue_apply', record_id: rid }], { primary: true, hint: '系统重新打开申请页接着填，填好仍停在提交前给你终审' })]),
      ...(url ? [option(2, '打开申请页', [{ type: 'open', url }], { hint: '在浏览器里打开，这一步由你来做', ...(need.continue === false ? { primary: true } : {}) })] : []),
      option(3, need.done || '我已在页面上提交了', [{ type: 'command', text: `${n} 这步好了` }], { hint: '记为你亲自投递，系统不会再提交这一份' }),
      giveUp(q, null),
    ]),
    other: { placeholder: '说说页面上是什么情况', steps: tellJob(null, q) } };
}

// 申请表要求求职信（Tailor 写，lib/resume-letters.mjs）：让它写一封；你在「简历 → 求职信」选定后，系统自动接着填表。
function letterAsk(q, l, need) {
  const n = q.lead.number, rid = q.lead.record_id;
  return { ...needBase(q, l, null, need), id: `need:lead:${rid}:letter`, type: 'review', question: clean(need.question),
    options: seq([
      option(1, `让 ${crewName('tailor')} 写一封`, [{ type: 'letter_write', record_id: rid }], { primary: true, hint: '先读公司调研再写，逐句核对出处；写好在「简历 → 求职信」里等你看' }),
      option(2, '我选好了，接着填表', [{ type: 'requeue_apply', record_id: rid }], { hint: '在「简历 → 求职信」里点过「用这封」之后用；没选的话填表还会停在这里' }),
      option(3, '我已在页面上提交了', [{ type: 'command', text: `${n} 这步好了` }], { hint: '记为你亲自投递，系统不会再提交这一份' }),
      giveUp(q, null),
    ]),
    other: { placeholder: '想在信里强调什么？（比如「写我做过的数据清洗」）', steps: tellJob(null, q) } };
}

// 与这条任务同一线索、同一类、还在等你的其它任务（按 id 取最新一版）。
export function twinJobs(job, jobs = []) {
  const latest = new Map(); for (const j of jobs) latest.set(j.id, j);
  return [...latest.values()].filter(j => j.id !== job.id && j.kind === job.kind && ['waiting_user', 'blocked'].includes(j.status) && ((job.record_id && j.record_id === job.record_id) || (job.number != null && j.number === job.number))).map(j => j.id);
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
// queue：taskQueue() 的输出；leads / drafts / jobs：原始行；services：{ feishu_user: { ready } } 等实时状态。
// sessions：config/portal-sessions.json（谁在什么时候确认登录过）；watch：state/login-watch.json（自动检测的结果）。
export function buildAsks({ queue = [], leads = [], drafts = [], jobs = [], services = {}, snoozed = {}, now = Date.now(), cfg = loadAccounts(), sessions = { domains: {} }, watch = {}, trace = null } = {}) {
  const byId = new Map(leads.map(l => [l.record_id || l.id, l])), byNumber = new Map(leads.filter(l => l.number != null).map(l => [String(l.number), l]));
  const draftById = new Map(drafts.filter(d => d.draft_id).map(d => [d.draft_id, d]));
  const leadOf = q => byId.get(q.lead?.record_id) || (q.lead?.number != null ? byNumber.get(String(q.lead.number)) : null) || null;
  const asks = [], logins = new Map(), resumable = [];
  const loginFor = key => {
    if (!logins.has(key)) {
      const fam = familyOf(key.includes(':') ? key.split(':').slice(1).join(':') : null, cfg) || null;
      const f = cfg.families?.[key] || (fam ? { ...fam } : null) || {};
      logins.set(key, { key, label: f.label || key, kind: f.kind || 'portal', login_url: f.login_url || (key.includes(':') ? `https://${key.split(':').slice(1).join(':')}/` : null), how: f.how || null, probe: !!f.probe, sure: !!f.probe && f.probe.confirmed !== false, watch: watch[key] || null, items: [], jobs: new Set(), superseded: new Set(), leads: new Set(), hosts: new Set() });
    }
    return logins.get(key);
  };
  // 同一类执行器任务（每天一条的真人帖扫描）挂在同一个登录上时合成一项：登录后只让最新的那条继续，
  // 旧的记为被接替，免得登录一次执行器重跑三遍。
  const addLogin = (keys, item) => {
    for (const k of keys) {
      const g = loginFor(k);
      const same = item.kind && item.kind !== 'lead' && g.items.find(i => i.kind === item.kind && i.label === item.label);
      if (same) {
        const newer = String(item.created_at || '') > String(same.created_at || '');
        if (newer) { if (same.job_id) g.superseded.add(same.job_id); g.jobs.delete(same.job_id); Object.assign(same, { id: item.id, job_id: item.job_id, created_at: item.created_at }); if (item.job_id) g.jobs.add(item.job_id); }
        else if (item.job_id) g.superseded.add(item.job_id);
        same.count = (same.count || 1) + 1;
        continue;
      }
      if (!g.items.some(i => i.id === item.id)) g.items.push({ ...item });
      if (item.job_id) g.jobs.add(item.job_id);
      if (item.record_id) g.leads.add(item.record_id);
      if (item.host) g.hosts.add(item.host);
    }
  };

  // 自动恢复试过几次还在喊要登录的账号（state/login-watch.json 的 stuck）：照样问你，并说明情况。
  const stillBlocked = (named, since) => named.filter(k => watch[k]?.stuck === true || !loggedInSince(k, since, sessions, cfg));

  for (const q of queue) {
    const l = leadOf(q);
    // 旅程在队列上标“待批准”时，lead.auto_apply 可以根本不存在；旧队列也须核对当前放行。
    const applySuggestion = q.kind === 'apply_proposal' || (q.kind === 'auto_apply' && q.awaiting_batch_review) ||
      (q.kind === 'blocked' && (l?.auto_apply?.status === 'awaiting_batch_review' || q.actions?.some(a => a.kind === 'command' && a.label === '重新审核材料')));
    if (applySuggestion && (!l || heldApplySuggestion(l) || (q.kind === 'apply_proposal' && !hasApplicationApproval(l) && approvalBlocker(l)))) continue;
    // 队列里的 host_job 是摘要，可能没带 thread（对话里交给哪位成员）：从任务记录里补上，信才写得出是哪位在做（memberOfJob）。
    const job = q.host_job && ['waiting_user', 'blocked'].includes(q.host_job.status) ? withThread(q.host_job, jobs) : null;
    const question = job ? jobQuestion(job, jobs) : '';
    const text = [question, job?.result, q.detail, q.summary, ...(q.also || []).map(a => a.detail)].filter(Boolean).join('\n');
    // 1) 系统修复任务：只有它问到你（登录 / 明确的问题）时才进收件箱；其余归 System 页。
    if (q.role === 'system' && job?.kind === 'system_fix' && !q.lead?.record_id) {
      const named = familiesInText(text, cfg), keys = stillBlocked(named, job.updated_at || job.created_at);
      if (keys.length) { addLogin(keys, { id: `job:${job.id}`, label: `系统修复：${cut(job.label || job.details || '同步任务', 60)}`, job_id: job.id, kind: 'system_fix' }); continue; }
      if (named.length) { resumable.push({ kind: 'job', job_id: job.id, record_id: null, host: null, families: named, since: job.updated_at || job.created_at || null }); continue; }
      // 执行器用 bin/job.mjs need 写了选项（needs[].options）就照它出按钮；只有一句话的旧任务才去拆正文（10-01 第 2 轮验收复核 25：
      // 写了「继续扫描 / 先跳过本轮」，信上却拿正文去拆，第二个按钮混进了括号）。
      const said = (job.needs || []).filter(n => ['decide', 'info', 'approve'].includes(n.kind) && (n.kind !== 'decide' || n.options?.length));
      if (said.length) { for (const need of said) asks.push({ ...(need.kind === 'decide' ? decideAsk : need.kind === 'info' ? infoAsk : approveAsk)(q, null, job, need), type: 'info', title: systemTitle(job), from: 'system' }); continue; }
      if (question && !/系统尚未写明/.test(question)) asks.push({ ...jobAsk(q, null, job, question), type: 'info', title: systemTitle(job), from: 'system' });
      continue;
    }
    if (q.kind === 'blocked') {
      const url = l ? applyUrl(l) : q.refs?.url;
      // 有固定字段的（执行器用 bin/job.mjs 报的，或自动投递的原因码）：照字段出信，不猜。
      const needs = job?.needs?.length ? job.needs : !job && l ? autoApplyNeeds(l, { cfg, url }) : [];
      if (needs.length) {
        const since = [l?.auto_apply?.at, job?.updated_at || job?.created_at].filter(Boolean).sort().pop() || null;
        const item = l ? { id: `lead:${q.lead.record_id}`, label: `#${q.lead.number ?? '—'} ${q.lead.company} · ${cut(q.lead.role, 30)}`, record_id: q.lead.record_id, number: q.lead.number, company: q.lead.company || null, job_id: job?.id || null, host: accountHost(url), url: url || null, kind: 'lead' }
          : { id: `job:${job.id}`, label: cut(job.kind === 'discover_human_opportunities' ? '真人帖浏览器扫描' : job.label || job.details || job.kind, 60), job_id: job.id, kind: job.kind || 'task', created_at: job.created_at || null, url: needs.find(n => n.kind === 'login' && n.url)?.url || null };
        const logins = needs.filter(n => n.kind === 'login').map(n => n.account);
        const blocked = stillBlocked(logins, since);
        if (blocked.length) addLogin(blocked, item);
        else if (logins.length && needs.every(n => n.kind === 'login')) resumable.push({ kind: l ? 'lead' : 'job', job_id: job?.id || null, record_id: l ? q.lead.record_id : null, host: l ? accountHost(url) : null, families: logins, since });
        for (const need of needs) {
          if (job && l && q.lead.number != null && ['approve', 'decide'].includes(need.kind) && LEGACY_HAND.test(need.question || '')) { asks.push(handoffAsk({ ...q, host_job: job }, l, need.question, [{ type: 'job', id: job.id, action: 'resolve', note: '用户在收件箱处理了旧版留下的这一步' }])); continue; }
          if (need.kind === 'info') asks.push(infoAsk(q, l, job, need));
          else if (job && need.kind === 'decide') asks.push(decideAsk(q, l, job, need));
          else if (job && need.kind === 'approve') asks.push(approveAsk(q, l, job, need));
          else if (!job && l && q.lead.number != null && need.kind === 'approve') asks.push(need.letter ? letterAsk(q, l, need) : pageStepAsk(q, l, need));
        }
        continue;
      }
      // 你已经在收件箱补齐了这条申请表缺的信息（requeue_apply 记下 answered_at），之后又没有新的停顿：
      // 执行器停下来时的旧说法（"请提供出生年月"）不再重复问，等重新填表的结果（09-29：答完 #119 / #394 马上又冒出来）。
      const answeredAt = l?.auto_apply?.answered_at;
      if (answeredAt && answeredAt > ([l.auto_apply.at, job?.updated_at || job?.created_at].filter(Boolean).sort().pop() || '')) continue;
      // ↓ 没有固定字段的旧记录：按文字判断（lib/accounts.mjs 的分句规则）。新任务都走上面。
      // 卡在哪个账号的登录上：
      //   有线索的行只认这条线索自己的账号（门户岗位的问题里可能写着"用 Microsoft / LinkedIn / Facebook 登录"，
      //   那不是要你去登录 LinkedIn）。状态本身说要登录（needs_login、portal_login 恢复条件）就算；
      //   只是文字里提到登录的，要这段话真在说"没登录 / 要登录"——"网易已登录，但须先建立在线简历"不算。
      //   没有线索的执行器任务从恢复条件和文字里认平台，文字按账号分别看。
      const leadFamily = l ? familyOf(url, cfg) : null;
      const structured = !!l && (l.auto_apply?.status === 'needs_login' || ['needs_login', 'register_by_owner'].includes(job?.blocked_reason) || /^portal_login:/.test(job?.resume_condition || ''));
      const flagged = !!l && (q.login_required || q.actions?.some(a => a.kind === 'portal_login'));
      const named = l ? (leadFamily && (structured || (flagged && loginNeeded(`${question}\n${q.summary || ''}`))) ? [leadFamily.key] : [])
        : [...new Set([...familiesInCondition(job?.resume_condition, cfg), ...(loginClauses(question || q.summary || '').some(c => c.need) ? familiesInText(text, cfg) : [])])];
      // 停下来之后你（或自动检测、执行器）确认登录过的账号不再算卡点。
      const since = [l?.auto_apply?.at, job?.updated_at || job?.created_at].filter(Boolean).sort().pop() || null;
      const keys = stillBlocked(named, since);
      if (named.length && !keys.length) {
        // 登录已经好了，任务还停着。剩下真正要你做的（重新批准、预填好的表）照常进收件箱；
        // 真正停在登录上的（状态就是等登录）交给自动检测去继续，和你点「我登好了」一样，不再问你登录。
        if (l && (q.actions?.some(a => a.kind === 'command' && a.label === '重新审核材料') || l.auto_apply?.status === 'awaiting_batch_review')) { asks.push(reapproveAsk(q, l, now)); continue; }
        if (l?.auto_apply?.status === 'prepared_for_user') { asks.push(prefilledAsk(q, l)); continue; }
        if (!l || structured) resumable.push({ kind: l ? 'lead' : 'job', job_id: job?.id || null, record_id: l ? q.lead.record_id : null, host: l ? accountHost(url) : null, families: named, since });
        if (!question || loginNeeded(question)) continue;
      }
      const loginOnly = keys.length && !(DECISION_Q.test(question) && !CITY_SCOPE.test(question));
      if (loginOnly) {
        addLogin(keys, l ? { id: `lead:${q.lead.record_id}`, label: `#${q.lead.number ?? '—'} ${q.lead.company} · ${cut(q.lead.role, 30)}`, record_id: q.lead.record_id, number: q.lead.number, company: q.lead.company || null, job_id: job?.id || null, host: hostOf(url), url: url || null, kind: 'lead' }
          : { id: `job:${job?.id || q.id}`, label: cut(job?.kind === 'discover_human_opportunities' ? '真人帖浏览器扫描' : job?.label || q.title, 60), job_id: job?.id || null, kind: job?.kind || 'task', created_at: job?.created_at || null });
        if (l && CITY_SCOPE.test(question)) asks.push(cityAsk(q, l));
        continue;
      }
      if (l && (q.actions?.some(a => a.kind === 'command' && a.label === '重新审核材料') || l.auto_apply?.status === 'awaiting_batch_review')) { asks.push(reapproveAsk(q, l, now)); continue; }
      if (l?.auto_apply?.status === 'prepared_for_user') { asks.push(prefilledAsk(q, l)); continue; }
      if (job && question) { asks.push(jobAsk(q, l, job, question, twinJobs(job, jobs))); continue; }
      if (job) continue; // 没写问题的任务：System 页里处理，不打扰你。
      if (keys.length && leadFamily) { addLogin([leadFamily.key], { id: `lead:${q.lead.record_id}`, label: `#${q.lead.number ?? '—'} ${q.lead.company} · ${cut(q.lead.role, 30)}`, record_id: q.lead.record_id, number: q.lead.number, company: q.lead.company || null, host: hostOf(url), url: url || null, kind: 'lead' }); continue; }
      if (l && q.lead.number != null && LEGACY_HAND.test(`${q.summary || ''}\n${q.full_detail || ''}`)) { asks.push(handoffAsk({ ...q, host_job: null }, l, q.full_detail || q.summary, q.archive?.key ? [{ type: 'archive', key: q.archive.key }] : [])); continue; }
      if (q.summary) asks.push(legacyAsk(q, l));
      continue;
    }
    if (q.kind === 'send_proposal' || q.kind === 'send') { const d = draftById.get(q.refs?.draft_id); if (d && q.lead.number != null) asks.push(draftAsk(q, l, d)); continue; }
    if (q.kind === 'apply_proposal') { asks.push(applyProposalAsk(q, l)); continue; }
    if (q.kind === 'auto_apply') { if (q.awaiting_batch_review && q.lead.number != null) asks.push(reapproveAsk(q, l, now)); continue; }
    if (q.kind === 'submit') { asks.push(submitAsk(q, l)); continue; }
    if (q.kind === 'followup' && q.lead.number != null) { asks.push(followupAsk(q, now)); continue; }
    if (q.kind === 'screen' || q.kind === 'decide') { asks.push(triageAsk(q, l)); continue; }
    if (q.kind === 'clarify' && q.lead.number != null) { asks.push(clarifyAsk(q)); continue; }
    if (['schedule', 'attend', 'reply', 'review', 'dossier'].includes(q.kind) && q.lead.number != null) { asks.push(interviewAsk(q, now, l?.reply_message)); continue; }
  }

  // 登录：一个账号一条。服务类账号（飞书本人授权）实时状态已经正常的，就不再问登录，
  // 而是把挂在它上面的系统提醒合成一条"可以关掉了"。
  // 登录这封信由被挡住的 worker 发：挡住投递 / 私信的是 Reacher，挡住扫描的是 Radar，服务授权是 System。
  const loginSender = g => { const k = g.items.map(i => i.kind === 'lead' ? 'reacher' : /discover/.test(i.kind || '') ? 'radar' : 'system'); return g.kind === 'service' ? 'system' : ['reacher', 'radar', 'system'].find(x => k.includes(x)) || 'system'; };
  for (const g of logins.values()) {
    const ready = g.kind === 'service' && services[g.key]?.ready === true;
    const n = g.items.length, jobsList = [...g.jobs];
    if (ready) {
      const all = [...g.jobs, ...g.superseded];
      asks.push({ from: 'system', id: `recovered:${g.key}`, type: 'info', title: g.label, question: `${g.label}已经恢复，下面 ${all.length} 条因它卡住的提醒可以关掉了。`, affected: g.items, context: [], options: [option(1, '关掉这些提醒', all.map(id => ({ type: 'job', id, action: 'resolve', note: `${g.label}已恢复` })), { primary: true })], other: null, notice: true }); // 告诉你一声（lib/notices.mjs）
      continue;
    }
    // 按公司分开的账号（Workday 等）没有统一登录页，租户根地址常常直接报错（有的租户直接回 406）：
    // 打开被挡住的那个岗位的申请页，登录入口就在页面上。
    if (g.key.includes(':') || !cfg.families?.[g.key]?.login_url) g.login_url = g.items.find(i => i.url)?.url || g.login_url;
    // 按公司分开的账号：标题用岗位上的公司名（「Workday · Globex」），不用租户地址里的小写 id。
    if (g.key.includes(':')) { const co = g.items.find(i => i.company)?.company; if (co) g.label = `${String(g.label).split(' · ')[0]} · ${co}`; }
    asks.push({
      from: loginSender(g), id: `login:${g.key}`, type: 'login', title: `登录 ${g.label}`, account: { key: g.key, label: g.label, kind: g.kind, login_url: g.login_url, how: g.how, probe: g.probe, checked: g.watch ? { at: g.watch.checked_at || null, logged_in: g.watch.logged_in ?? null, reason: g.watch.reason || null, stuck: !!g.watch.stuck } : null },
      question: g.watch?.stuck ? `系统看到你已经登录了 ${g.label}，任务继续了几次还是说要登录——平台可能要你再验证一次（验证码、安全检查），挡住了 ${n} 项。`
        : `${g.label} 需要你登录，挡住了 ${n} 项。${g.sure ? '在浏览器里登录好就行，系统会自己发现并继续。' : ''}`,
      affected: g.items, context: [],
      options: [
          ...(g.login_url ? [option(1, '打开登录页', [{ type: 'open', url: g.login_url, ...(g.probe ? { watch: g.key, ...(g.sure ? {} : { sure: false }) } : {}) }], { hint: g.sure ? '在浏览器里打开；账号密码和验证码只由你输入，登录好之后不用回来点，系统半分钟内会自己发现' : '在浏览器里打开，账号密码和验证码只由你输入', primary: true })] : []),
          option(g.login_url ? 2 : 1, '我登好了，检查并继续', [{ type: 'account_ready', account: g.key, hosts: [...g.hosts], jobs: jobsList, superseded: [...g.superseded], leads: [...g.leads] }], { hint: g.sure ? '系统先打开一个页面确认真的登录了，再恢复这些任务' : `记为已登录并恢复这 ${n} 项；提交前仍会实地核对`, primary: !g.login_url }),
          option(g.login_url ? 3 : 2, '先不用这个平台', [{ type: 'snooze', hours: 72 }], { hint: '这些任务先放着，三天内不再问' }),
        ],
      other: null,
    });
  }

  // 同一封信只留一次（同一条线索既在拟投清单、又被 journey 当成待批准的自动投递时，两边都出「投递待批准」apply:<id>）。
  { const seen = new Set(); for (let i = 0; i < asks.length; i++) { if (seen.has(asks[i].id)) { trace?.(asks[i], 'buildAsks', 'drop:duplicate_ask_id'); asks.splice(i--, 1); } else seen.add(asks[i].id); } }
  const SENDER = { triage: 'radar', followup: 'reacher', review: 'reacher', decide: 'reacher', interview: 'watch', info: 'watch' };
  for (const a of asks) a.from ||= SENDER[a.type] || 'system';
  const live = asks.filter(a => { const held = Date.parse(snoozed[a.id] || '') > now; trace?.(a, 'buildAsks', held ? 'drop:snoozed' : 'generated'); return !held; });
  const rank = a => TYPE_ORDER.indexOf(a.type);
  const due = a => Number.isFinite(Date.parse(a.due_at)) ? Date.parse(a.due_at) : Infinity;
  live.sort((a, b) => rank(a) - rank(b) || due(a) - due(b) || String(a.title).localeCompare(String(b.title), 'zh'));
  const counts = Object.fromEntries(TYPE_ORDER.map(t => [t, live.filter(a => a.type === t).length]));
  return { asks: live, counts, total: live.length, snoozed: asks.length - live.length, types: ASK_TYPES, resumable };
}

// 这一步要不要在原地确认（不跳走）：手机和对话里用（原在 lib/ask-cards.mjs，飞书卡片 10-04 删掉后挪到这里）。
export const inlineConfirm = o => !!(o?.confirm_inline || (o?.steps || []).some(s => s.confirm === 'inline'));
