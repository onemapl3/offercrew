import { EVENT_REASON, eventReason } from './event-reasons.mjs';
// 投递工作流：每个 job application 有一条工作流，显示走到了哪一步；这一层抽象出来，指挥台和收件箱共用。
//
// 一条在推进的线索（application）的工作流 = 公共主干 + 它那个渠道的几步：
//   发现(Scout) → 判断(Lens) → 你筛选(你) → [渠道步骤] → 回复(Owl) → 面试(Owl) → 结果(Owl)
//   官网 / 表单：准备材料 → 你批准 → 填表 → 终审 → 已提交
//   邮件：      找联系人 → 写首联 → 你审 → 已发出
//   平台私信：  写私信 → 你审 → 已发出（BOSS / 脉脉 / LinkedIn / 小红书）
//   内推：      找内推人 → 写请求 → 你审 → 已发出
// 步骤是数据（STEPS / SPINE / CHANNELS）：名字、谁负责（团队名册 lib/crew.mjs 的成员，或者你）、用哪个检测器（DETECT）
// 看它做完 / 在做 / 等你 / 卡住。
// 加一个渠道或角色 = 在表里加几行，页面只画算好的步骤。每一步的状态：
//   done 做完 · current 在做 · waiting_you 等你 · blocked 卡住 · not_reached 还没到 · skipped 跳过
// 要你做的事一律对上收件箱里的那封信（ask id），不从文字里猜：登录看登录信挡住了哪条线索，
// 缺资料看 lib/needs.mjs 的结构化 needs（need:… 信），执行器的问题按任务 id 找信。
//
// 每一次联系 / 投递（attempt）也在这里算：草稿 → 你批准（send-requests）→ 回执（outbound），加自动投递。
// 全是纯函数：输入是按文件签名缓存的只读行，输出是给页面的对象。
import { missingLine } from './apply-words.mjs';
import { plainJudgement } from './vocab.mjs';
import { cachedLines } from './state-cache.mjs';
import { read } from './store.mjs';
import { applyWord, applyUrl, applyChannel } from './apply-channel.mjs';
import { familyOf, loadAccounts } from './accounts.mjs';
import { plainText } from './jargon.mjs';
import { leadState, viewState, contactLead } from './lead-state.mjs';
import { delivered } from './delivery.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { sprintHold, citySprint } from './city-sprint.mjs';
import { leadCity, relocationCity } from './city.mjs';
import { leadChannel } from './asks.mjs';
import { autoApplyNeeds, needsSummary, fieldQuestions, clipText } from './needs.mjs';
import { TZ, dayOf } from './tz.mjs';
import { leadTag, VERDICT_WORD } from './vocab.mjs';
import { crewName } from './crew.mjs';
import { legacyChip } from './status.mjs';
import { lastRev } from './cards.mjs';
import { PREFILTER_WORD } from './prefilter-words.mjs';
import { href } from './routes.mjs';

// ── 小工具 ───────────────────────────────────────────────────────────────────
export const DAY = 86400000;
const CLOCK = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const tsOf = x => (x == null || x === '' ? NaN : new Date(x).getTime());
export const T = x => { const t = tsOf(x); return Number.isFinite(t) ? t : 0; };
export { dayOf };
export const clock = x => { const t = tsOf(x); return Number.isFinite(t) ? CLOCK.format(t) : ''; };
export const cut = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const within = (at, ms, now) => Number.isFinite(tsOf(at)) && now - tsOf(at) < ms;
export const hasCJK = s => /[㐀-鿿]/.test(String(s ?? ''));
export const latestAt = (...xs) => { let best = null, bt = -Infinity; for (const x of xs.flat()) { const t = tsOf(x); if (Number.isFinite(t) && t > bt) { bt = t; best = x; } } return best; };
export const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (k == null || k === '') continue; const list = m.get(k); if (list) list.push(r); else m.set(k, [r]); } return m; };
export const ridOf = l => l.record_id || l.id;

// ── 时间：一律按本地时区的自然日（lib/tz.mjs）──────────────────────────────────
const dayIndex = x => { const d = dayOf(x); return d ? Math.round(Date.parse(d + 'T00:00:00Z') / DAY) : NaN; };
// 隔了几个自然日：昨天 23:30 发出的，今天早上算 1 天（不是按 24 小时取整）。
export const daysSince = (at, now = Date.now()) => { const a = dayIndex(at), b = dayIndex(now); return Number.isFinite(a) && Number.isFinite(b) ? b - a : null; };
const md = x => { const d = dayOf(x); return d ? `${Number(d.slice(5, 7))}-${Number(d.slice(8, 10))}` : ''; };
export function whenText(x, now = Date.now()) {
  if (!Number.isFinite(tsOf(x))) return '';
  const d = daysSince(x, now), hm = clock(x);
  if (d === 0) return `今天 ${hm}`;
  if (d === 1) return `昨天 ${hm}`;
  if (d === -1) return `明天 ${hm}`;
  return dayOf(x).slice(0, 4) === dayOf(now).slice(0, 4) ? `${md(x)} ${hm}` : dayOf(x);
}
export const dayText = (x, now) => { const d = daysSince(x, now); return d === 0 ? '今天' : d === 1 ? '昨天' : md(x); };
// 列表里的时间：今天只写几点，昨天写「昨天 18:09」，更早写「9-27 18:09」。
export const dayClock = (x, now = Date.now()) => { if (!Number.isFinite(tsOf(x))) return ''; const d = daysSince(x, now); return d === 0 ? clock(x) : d === 1 ? `昨天 ${clock(x)}` : `${md(x)} ${clock(x)}`; };
// "下次什么时候跑"：已经过点的写"马上"（这个时间每次请求都会往后挪，不能进页面内容）。
export const nextText = (at, now) => !at ? '' : T(at) <= now + 60000 ? '马上会跑' : `下次 ${whenText(at, now)}`;
export const ago = (at, now = Date.now()) => { const m = Math.round((now - tsOf(at)) / 60000); return !Number.isFinite(m) ? '' : m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };

// ── 把机器的话翻成人话 ─────────────────────────────────────────────────────────
// 运行事件的步骤 → 在做什么。
export const STEP = {
  discover: '扫官方招聘源', 'discover-human': '扫真人招聘帖', 'discover-human-browser': '在浏览器里扫真人帖', 'judge-leads': '判断新岗位', judge: '判断岗位', match: '匹配岗位', evaluate: '写一页评估', 'spend-cap': '花费上限', 'title-pick': '按标题挑', 'match-recalibrate': '校准匹配', model: '调用模型',
  'project-base': '同步岗位表', 'job-list': '更新岗位清单', 'add-lead': '收录你转发的岗位', 'base-fields': '整理岗位表字段', 'base-views': '整理岗位表视图', 'verify-sources': '核验招聘源', 'backfill-jd': '补全岗位描述', extract: '识别岗位',
  inbox: '整理邮件', 'mail-read': '读邮件', 'mail-poll': '巡检邮箱', 'gmail-check': '检查邮箱', 'gmail-auth': '邮箱授权', mail: '处理邮件', reply: '识别回复', interview: '识别面试', 'prepare-interviews': '准备面试、调研公司', 'reconcile-mail': '核对已发邮件',
  reach: '起草首联', 'send-approved': '发邮件', 'send-dm': '发平台私信', 'send-authorization': '记下你的发送授权', send: '发送', submit: '提交申请', 'auto-apply': '填申请表', 'find-contacts': '找联系人', 'find-referrers': '找内推人', contacts: '找联系人', referrers: '找内推人', 'prepare-applications': '准备投递材料', 'queue-apply': '排队投递', 'queue-auto-apply': '排队投递',
  'pull-feedback': '拉取你的反馈', 'feedback-applied': '应用你的反馈', 'feedback-queue': '处理反馈队列', 'host-work': '整理交办任务', 'project-journey': '重算每条线索的进度', concierge: '同步', sync: '同步', notify: '发提醒', digest: '汇总提醒', metrics: '更新指标', cycle: '整轮运行', 'auto-repair': '自动修复', 'run-now': '执行交办任务', 'login-watch': '看登录状态',
  flashcard: '刷卡筛选', 'flashcard-start': '开始刷卡', feedback: '处理你的反馈', memory: '整理记忆', preferences: '更新偏好', connection: '连接', web: '工作台', room: '收消息', message: '收消息', route: '分派指令', catchup: '补跑', chat: '对话', draft: '改草稿', 'card-action': '卡片操作', settings: '改设置', ops: '手动运行', 'fix-alitalent-urls': '修正招聘链接',
};
export const CODE_WORD = {
  ...EVENT_REASON,
  maimai_note_too_long: '附言超过平台字数上限', recipient_already_contacted_and_replied: '对方已在原对话里回复过', needs_login: '要登录', no_session: '没登录',
  job_url_not_found: '申请页链接失效了', browser_permission_prompt: '浏览器弹了权限提示', application_form_not_rendered: '申请表没打开',
  resume_upload_control_missing: '没找到上传简历的地方', resume_upload_control_miss: '没找到上传简历的地方', approval_stale: '批准后材料变了',
  application_profile_conflict: '网站上存的资料和你的不一致', unanswered_required_fields: '表里有必填项没答案', cover_letter_needed: '申请表要求写求职信', excluded_company: '你排除了这家公司',
  passed: '你决定不投了', duplicate_recipient_existing_application_draft: '同一个人已经有一份草稿', source_and_contact_unavailable: '原帖和联系人都找不到了',
  posting_closed: '岗位已关闭', timeout: '超时', user_cancelled: '你取消了', superseded: '换成了新版本', city_sprint: '冲刺期先不发',
  delivery_unconfirmed: '没确认送达', token_missing: '缺登录凭证', executor_timeout: '本机 AI 超时',
  job_ids: '任务编号', manual_portal: '要本人操作的门户', api_retry: '接口重试', run_host: '指定的运行机器', needs_host_connector: '交给本机 AI',
};
// 执行器 / System 自己写的中文说明里夹着的代码词（"故报 resume_upload_control_missing"、"保持 blocked"）：认得的翻成中文，
// 认不得的蛇形代码换成"内部代码"；步骤名（auto-apply）翻成它在做的事；路径和文件名里的不动。
// 状态码（blocked、pending、completed……）的词从 lib/status.mjs 来（认成六种之一）；这里只留不是活的状态的代码词。
const CODE_TEXT = { degraded: '部分失败', needs_review: '要重新确认', dispatched: '发送中', submitted: '已提交', verified: '已核验', no_change: '没有变化', changed: '有更新', superseded: '已替换', paused: '已暂停', uncertain: '不确定' };
const codeWord = w => CODE_TEXT[w] || legacyChip(w)?.word;
const scrubCodes = s => eventReason(s)
  .replace(/(?<![\w/.-])[a-z]+(?:-[a-z]+)+(?![\w/.-])/g, w => STEP[w] || w)
  .replace(/(?<![\w.-])[a-z]+(?:_[a-z]+)+(?![\w/.-])/g, w => CODE_WORD[w] || codeWord(w) || w)
  .replace(/(?<![\w/.-])[a-z]+(?:_[a-z]+)+(?![\w/.-])/g, '内部代码')
  .replace(/(?<![\w/.-])(degraded|blocked|pending|completed|queued|dispatched|submitted|verified|failed|cancelled|superseded|paused|uncertain)(?![\w/.-])/g, w => codeWord(w) || w)
  .replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, '$1');
// 「没发出去」加上原因：认得出原因才带「：原因」，认不出就只说前半句。
export const withWhy = (head, why) => (why ? `${head}：${why}` : head);
// 一段原因：中文原样（去掉配置文件路径、翻掉行话）；英文代码按表翻；认不出的不硬塞英文。
export function plainReason(text, n = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const parts = s.split(/\s*;\s*/).map(p => { const i = p.indexOf(':'), code = (i < 0 ? p : p.slice(0, i)).trim(), rest = i < 0 ? '' : p.slice(i + 1).trim(); const w = CODE_WORD[code]; return w ? (rest ? `${w}：${rest}` : w) : null; });
  if (parts.every(Boolean)) return cut(parts.join('、'), n);
  if (hasCJK(s)) return cut(plainText(scrubCodes(s.replace(/config\/[\w./-]+(?:\s+[a-z]+(?:_[a-z]+)+)?/g, '').replace(/[，,]\s*([）)])/g, '$1').replace(/[（(]\s*[）)]/g, ''))), n);
  if (parts.some(Boolean)) return cut(parts.filter(Boolean).join('、'), n);
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|socket hang up|timed? ?out/i.test(s)) return '连不上网站或超时了';
  const m = /\bHTTP\s*([45]\d\d)\b|\b([45]\d\d)\s+(?:Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(s), http = m?.[1] || m?.[2];
  if (http) return { 401: '要登录（401）', 403: '网站拒绝访问（403）', 404: '页面不存在（404）', 429: '访问太频繁，被限流了（429）' }[http] || (Number(http) >= 500 ? `网站自己出错了（${http}）` : `网站返回错误（${http}）`);
  if (/ego-browser/i.test(s)) return '浏览器脚本出错';
  if (/command failed|error|exception|exit \d+|\.m?js\b/i.test(s)) return '程序出错了';
  // 认不出的不硬塞一句「原因见详情」：返回空串，调用方整句不带原因（兜底词不当原因拼进句子，lib/wait-reason.mjs）。
  return '';
}
// 运行记录 / 告警里的话："auto-apply · degraded（24 小时内 3 次）" → "自动投递 · 部分失败（24 小时内 3 次）"。
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
export function plainMsg(msg, n = 160) {
  let s = String(msg ?? '').replace(/\s+/g, ' ').trim().replace(ISO_TIME, t => `${md(t)} ${clock(t)}`);
  if (!s) return '';
  s = s.replace(/(?:已)?送达飞书/g, '已通知你').replace(/(\d+)\s*联系已处理/g, '#$1 已安排推进').replace(/你\s*pass\s*了|已\s*pass/gi, '不投了');
  s = s.replace(/\b([a-z][a-z-]*[a-z])\s*·\s*([a-z_]+)\b/g, (m, step, st) => (STEP[step] || codeWord(st)) ? `${STEP[step] || '这一步'} · ${codeWord(st) || '有记录'}` : m);
  // 整句是英文的报错（"bin/x.mjs exit 1: …（24 小时内 1 次）"）：翻成一句人话，保留次数。
  const tail = /（24 小时内 \d+ 次）$/.exec(s)?.[0] || '', core = tail ? s.slice(0, -tail.length) : s;
  if (!hasCJK(scrubCodes(core))) s = plainReason(core, n) + tail;
  return cut(plainText(scrubCodes(s)), n);
}
// 旧暂停的原因是历史，不能把今天的城市设置套进去冒充当时的决定。
const pauseText = reason => /^杭州冲刺模式[（：]/.test(reason || '') ? '旧城市规则暂停，尚未解除' : plainReason(reason, 40);
const waitingQuestion = l => typeof l?.waiting_user === 'string' ? l.waiting_user : l?.waiting_user?.question || '';
export const HUMAN_SOURCE = { v2ex: 'V2EX', ruanyf: '阮一峰周刊', linuxdo: 'Linux.do', eleduck: '电鸭', hn: 'Hacker News', boss: 'BOSS 直聘', maimai: '脉脉', linkedin: 'LinkedIn', xiaohongshu: '小红书', liepin: '猎聘' };
export const humanSource = k => HUMAN_SOURCE[k] || (/^ai-/.test(k || '') ? `GitHub · ${String(k).slice(3)}` : String(k || '其他来源'));
const SOURCE_WORD = { official_ats: '官方招聘页', forwarded: '你转发的', watch: `${crewName('scout')} 盯的站点`, 'Remote RSS': '远程岗位 RSS', ...HUMAN_SOURCE };
export const sourceLabel = (l = {}) => (hasCJK(l.source_type) ? l.source_type : SOURCE_WORD[l.source_type] || SOURCE_WORD[l.source] || (hasCJK(l.source) || /^[A-Z]/.test(l.source || '') ? l.source : '其他来源'));
export const cityLabel = (l = {}) => { const c = leadCity(l); if (c !== '其他') return c; const r = relocationCity(l); if (r) return r; const p = l.judgement?.posting?.city; return p && hasCJK(p) ? cut(p, 10) : cut(l.location, 14) || '城市未写'; };
export const VERDICT = VERDICT_WORD; // 结论词只在 lib/vocab.mjs 一处
// 同一家公司常有好几个岗位：凡是指向一条线索的地方都带上「#编号 公司 · 岗位 · 城市」，不会认错是哪一个。
export const leadLabel = (l = {}) => [leadTag(l), cut(l.applied_role || l.role, 40), cityLabel(l)].filter(Boolean).join(' · ');
// 只有 record_id（或线索自己的 id）的地方（收件箱的信、回执）用它找标签。
export const labelOfLead = (id, leads = cachedLines('state/leads.ndjson')) => { if (!id) return null; const l = leads.find(x => !x.superseded && (x.record_id === id || x.id === id)); return l ? leadLabel(l) : null; };
export { PREFILTER_WORD } from './prefilter-words.mjs';
// 判断程序自己拼的那句（「方向：未判定；硬性要求 5/7 条有证据，整体匹配 1.9/3」）说成人话；模型写的句子原样。
export { plainJudgement };
export const reasonOf = l => cut(plainJudgement(plainText(l.match?.verdict === 'verify' ? l.match?.biggest_gap || l.match?.reasons?.[0] : l.match?.reasons?.[0] || l.match?.biggest_gap)).replace(/^(?:推荐|待核|排除)[：:]\s*/, ''), 70);

// ── 渠道、发送与投递的状态 ─────────────────────────────────────────────────────
const CHANNEL = { email: '邮件', platform_dm: '平台私信', maimai_friend_request: '脉脉好友申请', referral: '内推请求', ats_form: '官方表单' };
const PLATFORM_BY_URL = [[/zhipin\.com/i, 'BOSS 私信'], [/maimai\.cn/i, '脉脉私信'], [/linkedin\.com/i, 'LinkedIn 私信'], [/xiaohongshu\.com/i, '小红书私信'], [/liepin\.com/i, '猎聘私信']];
const PLATFORM_BY_TEXT = [[/boss/i, 'BOSS 私信'], [/linkedin/i, 'LinkedIn 私信'], [/小红书/, '小红书私信'], [/脉脉/, '脉脉私信'], [/猎聘/, '猎聘私信']];
export function channelLabel({ channel = '', to = '', platform = '', purpose = '' } = {}) {
  const c = String(channel || '');
  let base;
  if (c === 'email' || (!c && /@/.test(to || ''))) base = '邮件';
  else if (c === 'maimai_friend_request') base = '脉脉好友申请';
  else if (c === 'platform_dm') base = PLATFORM_BY_URL.find(([re]) => re.test(to || ''))?.[1] || PLATFORM_BY_TEXT.find(([re]) => re.test(platform || ''))?.[1] || '平台私信';
  else if (c === 'ats_form') base = '官网表单';
  else if (/^portal/.test(c)) base = '官网（本人账号）';
  else if (c === 'platform_application') base = '平台上申请';
  else if (c === 'referral') base = '内推请求';
  else if (c === 'wechat') base = '微信';
  else base = CHANNEL[c] || '其他渠道';
  return purpose === 'referral' && c !== 'referral' ? `内推 · ${base}` : base;
}
// 一次发送的主题：邮件用标题；私信 / 好友申请的"标题"是「公司 · 岗位」，去掉公司那半。
const topicOf = (subject, channel) => cut(channel === 'email' ? subject : String(subject || '').replace(/^[^·]{1,60}?\s·\s(?:内推请求\s·\s)?/, ''), 60);
const PURPOSE_WORD = { first_contact: '首联', application: '', inquiry: '咨询', referral: '', followup: '跟进', reply: '回复', interview_scheduling_reply: '约面试的回复' };
const FOLLOW_UP = new Set(['followup', 'reply', 'interview_scheduling_reply']);
const LOGINISH = /needs_login|no_session|sign ?in|log ?in|登录|登陆/i;
const evidenceOf = v => [v].flat().map(x => typeof x === 'string' ? x : x?.file || x?.screenshot || null).filter(x => typeof x === 'string' && x.startsWith('runs/')).slice(0, 3);
// 自动投递（lead.auto_apply）走到哪一步：{ status, tone, group, login }。
// group：you 要你处理 · moving 在路上 · failed 没成 · done 已提交 · parked 已暂停 / 已取消。
export function applyStatus(a = {}, { lead = {}, fam = familyOf(applyUrl(lead)), sprint = null } = {}) {
  const site = fam?.label ? ` ${fam.label}` : ' 门户';
  const err = String(a.error || a.last_error || '');
  const q = waitingQuestion(lead);
  switch (a.status) {
    case 'approved': case 'queued': case 'pending': return { status: `已批准，等${applyWord()}`, tone: 'work', group: 'moving' };
    case 'submitting': return { status: '提交中', tone: 'work', group: 'moving' };
    case 'needs_login': return { status: `等你登录${site}`, tone: 'wait', group: 'you', login: true };
    case 'waiting_user': {
      if (/^cover_letter_needed/.test(err)) return { status: `申请表要求写求职信：让 ${crewName('tailor')} 写一封，你选定后接着填`, tone: 'wait', group: 'you' };
      // 原因码里是页面上的原始标签（「Nationality Type here... <编号>」）：只写题目本身，不从一道题中间切开。
      const need = /unanswered_required_fields:([^;]+)/.exec(err)?.[1]?.trim();
      const needs = need ? `表里有必填项等你补：${clipText(fieldQuestions(need).join('、'), 80)}` : '';
      if (need && hasCJK(need)) return { status: needs, tone: 'wait', group: 'you' };
      if (q) return { status: `等你回答：${clipText(plainText(q), 40)}`, tone: 'wait', group: 'you' };
      if (need) return { status: needs, tone: 'wait', group: 'you' };
      if (LOGINISH.test(err)) return { status: `等你登录${site}`, tone: 'wait', group: 'you', login: true };
      return { status: withWhy('等你处理', plainReason(err, 40)), tone: 'wait', group: 'you' };
    }
    case 'awaiting_final_review': return { status: '表填好了，等你终审', tone: 'wait', group: 'you' };
    case 'prepared_for_user': return { status: missingLine(a.prefill?.missing || [])?.line || '表已在浏览器里预填，等你亲自提交', tone: 'wait', group: 'you' };
    case 'awaiting_batch_review': return { status: '批准后材料变了，要你重新确认', tone: 'bad', group: 'you' };
    case 'uncertain': return { status: '提交结果不确定，系统在核对', tone: 'bad', group: 'moving' };
    case 'failed': return { status: withWhy(`${applyWord()}没成功（第 ${a.attempts || 1} 次）`, plainReason(err, 40)), tone: 'bad', group: 'failed' };
    case 'submitted': return { status: '已提交', tone: 'ok', group: 'done' };
    case 'paused': return { status: `已暂停${a.paused_reason ? '：' + pauseText(a.paused_reason, sprint) : ''}`, tone: 'mute', group: 'parked' };
    case 'closed': case 'cancelled': return { status: `已取消${a.closed_reason ? '：' + (CODE_WORD[a.closed_reason] || plainReason(a.closed_reason, 30)) : ''}`, tone: 'mute', group: 'parked' };
    default: return { status: '投递处理中', tone: 'work', group: 'moving' };
  }
}
// 被退回（send-requests needs_review）的原因。
function returnedWhy(r = {}) {
  const why = `${r.reason || ''} ${r.error || ''} ${r.result || ''}`;
  if (/超过|超限|too_long|太长/.test(why)) return '附言超过平台字数上限，系统已缩短';
  if (/existing_thread|already_contacted|已有.*对话|同一.*会话/.test(why)) return '平台上已经有这段对话了，要改成在原对话里回复';
  return hasCJK(r.result) ? plainReason(r.result, 50) : '内容变了，要你重新确认';
}
// 发出后对方的反应：回复了 / 约了面试 / N 天没回复（自然日）。
export function replyStatus({ sentAt, lead = {}, state = null, events = [], now = Date.now() } = {}) {
  if (!Number.isFinite(tsOf(sentAt))) return { text: '', tone: 'mute', replied: false, days: null };
  const st = state || leadState(lead);
  if (st === 'offer') return { text: '拿到 Offer', tone: 'ok', replied: true, days: null };
  if (st === 'interview_scheduled' || st === 'interview_done') return { text: '约了面试', tone: 'ok', replied: true, days: null };
  if (st === 'rejected') return { text: '对方婉拒了', tone: 'mute', replied: true, days: null };
  const after = [lead.replied_at, ...events.map(e => e.at)].filter(x => Number.isFinite(tsOf(x)) && T(x) >= T(sentAt)).sort((a, b) => T(a) - T(b))[0];
  const replyAt = after || (Number.isFinite(tsOf(lead.replied_at)) ? lead.replied_at : null);
  if (replyAt) return { text: `对方回复了（${dayText(replyAt, now)}）`, tone: 'ok', replied: true, days: null };
  const days = Math.max(0, daysSince(sentAt, now) ?? 0);
  return { text: days ? `${days} 天没回复` : '今天刚发出，等回复', tone: days >= 7 ? 'wait' : 'mute', replied: false, days };
}
// 执行器的问题可能已经合进别的信里（登录那封列着它挡住的任务），按任务 id 找到那一封。
export const askForJob = (asks, id) => asks.find(a => a.job_id === id || a.id === `job:${id}` || (a.options || []).some(o => (o.steps || []).some(st => st.id === id || (st.jobs || []).includes(id) || (st.twins || []).includes(id))))?.id || null;

// ── 线索的大段（给数字、结局用）───────────────────────────────────────────────
export const CLOSED = new Set(['passed', 'pass_pending', 'rejected', 'archived']);
const REPLY_CATEGORY = /回复|面试|拒绝|进展|需补材料|offer/i;
export const GROUP_RANK = { you: 0, moving: 1, failed: 2, done: 3, parked: 4 };
export const TONE_RANK = { bad: 0, wait: 1, work: 2, ok: 3, mute: 4 };
// 线索落在哪一段（状态来自 lib/lead-state.mjs 的同一台状态机）：
// pool 岗位池 · triage 待你筛选 · pushing 在推进 · contacted 已联系 / 已投递 · replied 有回复 · interview 面试 · offer · closed 已结束 · excluded 系统排除
export function leadStage(l = {}, state = leadState(l), { hasAsk = false, pipeline = {} } = {}) {
  if (CLOSED.has(state)) return 'closed';
  if (state === 'offer') return 'offer';
  if (state === 'interview_scheduled' || state === 'interview_done') return 'interview';
  if (state === 'replied') return 'replied';
  if (state === 'contacted' || state === 'applied') return 'contacted';
  // 你说了联系、后来又把这家公司排除了（09-22 排除字节跳动）：系统不会再推进，算结束。
  if (state !== 'new') return excludedCompany(l, pipeline) ? 'closed' : 'pushing';
  if (l.closed_at) return 'closed';
  if (hasAsk) return 'triage';
  if (excludedWhy(l, pipeline)) return 'excluded';
  return 'pool';
}
export function excludedWhy(l, pipeline = {}) {
  if (l.prefilter_reason) return PREFILTER_WORD[l.prefilter_reason] || '不符合筛选条件';
  if (excludedCompany(l, pipeline)) return '你排除了这家公司';
  if (l.match?.verdict === 'exclude') return cut(plainText(l.match.biggest_gap || l.match.reasons?.[0] || '') || '判断不合适', 50);
  if (l.legacy) return '旧程序留下的记录';
  return null;
}
const leadAt = (l, dels = [], now) => latestAt(l.discovered_at, l.imported_at, l.matched_at, l.match?.at, l.rejudged_at, l.feedback_at, l.state_at, l.replied_at, l.interview_completed_at, l.offer_at, l.closed_at, l.archived_at, T(l.interview_at) <= now ? l.interview_at : null, l.auto_apply?.at, l.auto_apply?.approved_at, l.waiting_user?.at, (l.history || []).at(-1)?.at, dels.map(d => d.at));

// 一次算好：每条线索在哪一段、每一次联系 / 投递、线索↔信的对应。输入都是只读的缓存行。
export function progressIndex({ leads = cachedLines('state/leads.ndjson'), drafts = cachedLines('state/drafts.ndjson'), requests = cachedLines('state/send-requests.ndjson'), outbound = cachedLines('state/outbound.ndjson'), inboxEvents = cachedLines('state/inbox-events.ndjson'), feedback = cachedLines('state/feedback.ndjson'), asks = [], now = Date.now(), pipeline = read('config/pipeline.json', {}), sprint = citySprint() } = {}) {
  asks = asks.filter(a => !a.notice);
  const live = leads.filter(l => !l.superseded && l.status !== 'superseded' && l.match_status !== 'superseded');
  const byId = new Map(live.map(l => [ridOf(l), l]));
  // 回执 / 请求里偶尔记的是线索自己的 id 而不是 record_id（09-18 那条脉脉好友申请），两个都认。
  const byAnyId = new Map([...live.filter(l => l.id && l.record_id && l.id !== l.record_id).map(l => [l.id, l]), ...byId]);
  const byNumber = new Map(live.filter(l => l.number != null).map(l => [String(l.number), l]));
  const outBy = groupBy(outbound, o => o.record_id), reqBy = groupBy(requests, r => r.record_id);
  // 状态机按线索只看它自己的回执 / 发送请求（整表传进去是 O(线索 × 回执)）。
  const states = new Map(live.map(l => [ridOf(l), viewState(l, { requests: reqBy.get(ridOf(l)) || [] })]));
  const askIds = new Set(asks.map(a => a.id));
  const asksBy = groupBy(asks.filter(a => a.lead?.record_id), a => a.lead.record_id);
  const loginBy = new Map();
  for (const a of asks) if (a.type === 'login') for (const i of a.affected || []) if (i.record_id && !loginBy.has(i.record_id)) loginBy.set(i.record_id, a.id);
  const askFor = (id, types) => (asksBy.get(id) || []).find(a => !types || types.includes(a.type))?.id || null;
  const loginAsk = fam => fam ? asks.find(a => a.type === 'login' && a.account?.key === fam.key)?.id || null : null;
  const replies = groupBy(inboxEvents.filter(e => e.record_id && REPLY_CATEGORY.test(e.category || '')), e => e.record_id);
  const passWhy = new Map();
  for (const f of feedback) if (f.action === 'pass' && f.record_id && f.reason) passWhy.set(f.record_id, f.reason);
  const ctx = { now, sprint, pipeline, asks, byId, byAnyId, byNumber, states, askIds, asksBy, askFor, loginAsk, loginBy, replies, passWhy };
  const deliveries = buildDeliveries({ drafts, requests, outbound, ...ctx });
  ctx.delBy = groupBy(deliveries, d => d.rid);
  const entries = live.map(l => {
    const id = ridOf(l), state = states.get(id);
    // 待你筛选 = 收件箱里有问你「这条要不要推进」的信（筛选 / 拍板），审稿、登录、终审这些不算。
    const stage = leadStage(l, state, { hasAsk: (asksBy.get(id) || []).some(a => a.type === 'triage' || a.type === 'decide'), pipeline });
    return { l, rid: id, state, stage, hold: stage === 'pool' && sprintHold(l, sprint), at: leadAt(l, ctx.delBy.get(id), now) };
  });
  // 线索已经结束了（pass、归档、后来排除的公司……），它那几次没走完的联系 / 投递也不再「在路上」或「等你」。
  const closedBy = new Map(entries.filter(e => e.stage === 'closed').map(e => [e.rid, e]));
  for (const d of deliveries) {
    if (!closedBy.has(d.rid) || !['you', 'moving'].includes(d.group)) continue;
    const e = closedBy.get(d.rid);
    Object.assign(d, { group: 'parked', tone: 'mute', status: '已结束', word: '已结束', ask: null, note: [d.note, excludedCompany(e.l, pipeline) ? '这家公司你后来排除了' : '这条线索已经结束了'].filter(Boolean).join('；') });
  }
  deliveries.sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group]);
  return { entries, deliveries, ctx };
}

// 每一次联系 / 投递一行：草稿 → 你批准（send-requests）→ 回执（outbound），加上自动投递（lead.auto_apply）。
function buildDeliveries({ drafts, requests, outbound: allOutbound, now, sprint, byId, byAnyId, byNumber, states, askIds, askFor, loginAsk, loginBy, replies }) {
  const outbound = allOutbound.filter(o => o.status !== 'corrected');
  const leadOf = (id, n) => (id && byAnyId.get(id)) || (n != null ? byNumber.get(String(n)) : null) || null;
  const draftById = new Map(drafts.filter(d => d.draft_id).map(d => [d.draft_id, d]));
  const reqLatest = new Map();
  for (const r of requests) { const k = r.draft_id || `req:${r.id}`; const o = reqLatest.get(k); if (!o || T(r.at) >= T(o.at)) reqLatest.set(k, r); }
  const outByDraft = new Map(), outByExt = new Map();
  for (const o of outbound) { if (o.draft_id) outByDraft.set(o.draft_id, o); const ext = o.external_id || o.message_id; if (ext && !outByExt.has(ext)) outByExt.set(ext, o); }
  const receiptFor = (d, r) => (d.draft_id && outByDraft.get(d.draft_id)) || (r?.external_id && outByExt.get(r.external_id)) || (d.sent_external_id && outByExt.get(d.sent_external_id)) || null;
  const who = (l, f = {}) => ({ rid: l ? ridOf(l) : f.record_id || null, number: l?.number ?? f.number ?? null, company: l?.company || f.company || '公司待核', role: cut(l?.applied_role || l?.role || f.title || f.role || '', 60), label: l ? leadLabel(l) : [`${f.number != null ? '#' + f.number + ' ' : ''}${f.company || '公司待核'}`, cut(f.title || f.role, 40)].filter(Boolean).join(' · ') });
  // 主题和岗位名重复时（私信的"标题"常常就是岗位名），只留多出来的那半句。
  const trimTopic = row => { const t = row.subject || '', r = row.role || ''; if (!t || !r) return; if (t === r || r.includes(t)) row.subject = ''; else if (t.startsWith(r)) row.subject = t.slice(r.length).replace(/^\s*[·|｜-]\s*/, ''); };
  const withReply = (row, l) => { trimTopic(row); row.reply = row.group === 'done' && row.sent_at ? replyStatus({ sentAt: row.sent_at, lead: l || {}, state: l ? states.get(ridOf(l)) : null, events: replies.get(row.rid) || [], now }) : null; row.ask ||= null; row.note ||= null; row.evidence ||= []; row.sent = row.sent_at ? whenText(row.sent_at, now) : ''; row.when = whenText(row.at, now); return row; };
  const usedReq = new Set(), usedOut = new Set(), rows = [];

  function sendRow(d, r, o, orphan = false) {
    const l = leadOf(d.record_id || r?.record_id || o?.record_id, d.number ?? o?.number);
    const channel = d.channel || r?.channel || o?.channel || (/@/.test(d.to || '') ? 'email' : '');
    const purpose = d.purpose || r?.purpose || o?.purpose || '';
    const row = { id: `send:${d.draft_id || r?.id || o?.id || o?.external_id}`, kind: 'send', ...who(l, { ...o, ...d, record_id: d.record_id || r?.record_id || o?.record_id }), channel: channelLabel({ channel, to: d.to || o?.to || '', platform: d.platform || o?.platform || '', purpose }), channel_key: channel, purpose: PURPOSE_WORD[purpose] ?? '', purpose_key: purpose, subject: topicOf(d.subject || o?.subject, channel), draft_id: d.draft_id || null, orphan, created_at: d.created_at || r?.at || null, approved: !!r || !!o, approved_at: r?.at || null, evidence: evidenceOf(o?.evidence) };
    const sentOk = (o && delivered(o, l || {})) || r?.status === 'sent' || (!r && !o && d.status === 'sent');
    row.sent_at = sentOk ? (o?.sent_at || o?.at || r?.sent_at || d.sent_at || r?.dispatched_at || null) : null;
    row.at = latestAt(d.created_at, d.notified_at, d.edited_at, d.paused_at, d.cancelled_at, r?.at, r?.dispatched_at, r?.checked_at, row.sent_at);
    const draftAsk = d.draft_id && askIds.has(`draft:${d.draft_id}`) ? `draft:${d.draft_id}` : null;
    let s;
    // 退回 / 失败之后草稿又被你暂停或作废了：以草稿为准，那次批准已经翻篇。
    // 精确取消旧暂停稿只结束本地待发；保留的失效请求不代表仍获授权，也不能推进到「已发出」。
    const cancelledPaused = d.status === 'cancelled' && d.cancellation?.from === 'paused' && !sentOk && (!r || r.status === 'cancelled') && !o;
    if (cancelledPaused) row.cancelled_paused = true;
    const settledDraft = cancelledPaused || (['cancelled', 'paused'].includes(d.status) && ['needs_review', 'failed'].includes(r?.status));
    if (settledDraft) row.approved = false;
    if (sentOk) s = ['已发出', 'ok', 'done'];
    else if (r && !settledDraft) {
      const fam = familyOf(d.to || '');
      if (r.status === 'queued' && r.blocked === 'needs_login') { s = [`等你登录${fam?.label ? ' ' + fam.label : ''}，登录后自动发`, 'wait', 'you']; row.ask = loginAsk(fam) || loginBy.get(row.rid); }
      else if (r.status === 'queued') s = [channel === 'email' ? '已批准，下一轮周期发出' : '已批准，一分钟内发出', 'work', 'moving'];
      else if (r.status === 'dispatched') s = ['发送中', 'work', 'moving'];
      else if (r.status === 'needs_review') {
        const why = returnedWhy(r);
        row.ask = draftAsk || askFor(row.rid, ['review']) || askFor(row.rid);
        row.approved = false;
        if (d.status === 'ready' && T(latestAt(d.notified_at, d.edited_at)) > T(r.checked_at || r.at)) { s = ['被退回后改好了，等你再审', 'wait', 'you']; row.note = `上次被退回：${why}`; }
        else s = [`被退回：${why}`, 'bad', row.ask || within(r.checked_at || r.at, 3 * DAY, now) ? 'you' : 'failed'];
      }
      else if (r.status === 'failed') s = [withWhy('没发出去', plainReason(r.result || r.error || r.reason, 40)), 'bad', 'failed'];
      else if (r.status === 'uncertain') s = ['发送结果不确定，系统在核对', 'bad', 'moving'];
      else s = ['处理中', 'work', 'moving'];
    } else if (o && !settledDraft) s = ['发出了，还没核对到回执', 'wait', 'moving'];
    else switch (d.status) {
      case 'ready': s = ['草稿待你审', 'wait', 'you']; row.ask = draftAsk || askFor(row.rid, ['review']); break;
      case 'editing': s = ['草稿在改', 'wait', 'you']; row.ask = draftAsk; break;
      case 'needs_platform_action': s = ['要你在平台上操作一下', 'wait', 'you']; row.ask = draftAsk || askFor(row.rid); break;
      case 'paused': s = [`暂停：${pauseText(d.paused_reason || d.pause_reason, sprint) || '先不发'}`, 'mute', 'parked']; break;
      case 'cancelled': { const why = d.cancel_reason || d.cancelled_reason; s = [`已取消${why ? '：' + plainReason(why, 40) : ''}`, 'mute', 'parked']; break; }
      case 'blocked': s = [withWhy('卡住了', plainReason(d.blocked_reason, 40)), 'bad', 'failed']; break;
      default: s = ['在准备', 'work', 'moving'];
    }
    [row.status, row.tone, row.group] = s;
    return withReply(row, l);
  }
  function receiptRow(o) {
    const l = leadOf(o.record_id, o.number), form = /^(ats_form|portal)/.test(o.channel || ''), ok = delivered(o, l || {});
    const row = { id: `out:${o.id || o.external_id || `${o.record_id}|${o.sent_at || o.at}`}`, kind: form ? 'apply' : 'send', ...who(l, o), channel: channelLabel({ channel: o.channel, to: o.to || '', platform: o.platform || '', purpose: o.purpose }), channel_key: /^portal/.test(o.channel || '') ? 'portal' : o.channel || '', purpose: PURPOSE_WORD[o.purpose] ?? '', purpose_key: o.purpose || '', subject: topicOf(o.subject, o.channel), draft_id: null, orphan: false, receipt: true, created_at: null, approved: true, approved_at: null, evidence: evidenceOf(o.evidence) };
    row.note = o.actor === 'user' || o.agent_sent === false ? '你自己发的' : hasCJK(o.note) ? cut(o.note, 60) : null;
    row.sent_at = ok ? (o.portal_submitted_at || o.sent_at || o.at || null) : null;
    row.at = latestAt(o.sent_at, o.at, o.verified_at, o.portal_submitted_at);
    [row.status, row.tone, row.group] = ok ? [form ? '已提交' : '已发出', 'ok', 'done'] : o.status === 'failed' ? [withWhy('没发出去', plainReason(o.error, 40)), 'bad', 'failed'] : [form ? '提交了，还没核对到回执' : '发出了，还没核对到回执', 'wait', 'moving'];
    return withReply(row, l);
  }
  function applyRow(l) {
    const a = l.auto_apply, id = ridOf(l), fam = familyOf(applyUrl(l)), s = applyStatus(a, { lead: l, fam, sprint });
    const row = { id: `apply:${id}`, kind: 'apply', ...who(l), channel: applyChannel(l) === 'ats_form' ? '官网表单' : '官网（本人账号）', channel_key: applyChannel(l) === 'ats_form' ? 'ats_form' : 'portal', purpose: '', purpose_key: 'application', subject: fam?.label ? cut(fam.label, 30) : '', draft_id: null, orphan: false, status: s.status, tone: s.tone, group: s.group, created_at: a.user_requested_at || a.approved_at || null, approved: !!a.approved_at, approved_at: a.approved_at || null, evidence: evidenceOf(a.final_review?.screenshot) };
    row.sent_at = a.status === 'submitted' ? (a.submitted_at || a.at || null) : null;
    row.at = latestAt(a.at, a.approved_at, a.user_requested_at, a.closed_at, a.paused_at, a.submitted_at);
    if (s.group === 'you') row.ask = (s.login ? loginAsk(fam) || loginBy.get(id) : null) || (askIds.has(`need:lead:${id}:info`) ? `need:lead:${id}:info` : null) || askFor(id, ['review', 'decide', 'info', 'interview']) || loginBy.get(id) || null;
    return withReply(row, l);
  }

  for (const d of drafts) {
    if (d.status === 'superseded') continue;
    const r = reqLatest.get(d.draft_id) || null, o = receiptFor(d, r);
    // 发现时预写的首联还在等 Judge，不是“正在联系”或“待你审核”的证据。
    // 旧草稿标记可能落后于真实批准/回执；有这些记录时仍照真实进展显示。
    if (d.status === 'awaiting_judgement' && !r && !o) continue;
    if (r) usedReq.add(r);
    if (o) usedOut.add(o);
    rows.push(sendRow(d, r, o));
  }
  // 草稿被换掉 / 删掉了、但批准记录还在的（被退回后系统重写成新草稿的那种）。
  for (const r of reqLatest.values()) {
    if (usedReq.has(r)) continue;
    const d = draftById.get(r.draft_id) || {}, o = receiptFor(d, r);
    if (o) usedOut.add(o);
    rows.push(sendRow({ ...d, record_id: d.record_id || r.record_id, channel: d.channel || r.channel }, r, o, true));
  }
  for (const o of outbound) if (!usedOut.has(o)) rows.push(receiptRow(o));
  for (const l of byId.values()) if (l.auto_apply && (l.auto_apply.approved_at || l.auto_apply.user_requested_at)) rows.push(applyRow(l));

  // 同一条线索的表单 / 门户回执并进它的投递那一行；被退回后重写的草稿吸收旧的那次批准。
  const applyBy = new Map(rows.filter(r => r.id.startsWith('apply:')).map(r => [r.rid, r]));
  const drafted = rows.filter(r => r.kind === 'send' && !r.orphan && r.draft_id && r.group !== 'parked');
  const out = rows.filter(r => {
    if (r.receipt && r.kind === 'apply' && applyBy.has(r.rid)) {
      const a = applyBy.get(r.rid);
      if (r.group === 'done') { a.sent_at ||= r.sent_at; a.sent ||= r.sent; a.evidence = [...new Set([...a.evidence, ...r.evidence])]; if (a.group !== 'done') Object.assign(a, { status: '已提交', tone: 'ok', group: 'done', ask: null }); a.reply = r.reply; }
      return false;
    }
    if (r.orphan && /^(被退回|没发出去)/.test(r.status)) {
      const newer = drafted.find(d => d.rid === r.rid && d.channel_key === r.channel_key && T(d.at) > T(r.at));
      if (newer) { newer.note ||= `上次${r.status}`; if (newer.status === '草稿待你审') newer.status = '被退回后改好了，等你再审'; return false; }
    }
    return true;
  });
  const key = r => r.group === 'done' ? r.sent_at : r.at;
  return out.map(({ orphan, receipt, ...r }) => r).sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || T(key(b)) - T(key(a)));
}

export function deliverySummary(rows = [], now = Date.now()) {
  const sent = rows.filter(r => r.group === 'done' && r.sent_at);
  const days = r => daysSince(r.sent_at, now);
  const contacted = new Set(sent.map(r => r.rid).filter(Boolean)), replied = new Set(sent.filter(r => r.reply?.replied).map(r => r.rid).filter(Boolean));
  const n = g => rows.filter(r => r.group === g).length;
  return { today: sent.filter(r => days(r) === 0).length, week: sent.filter(r => days(r) >= 0 && days(r) < 7).length, total: sent.length, leads: contacted.size, replied: replied.size, reply_rate: contacted.size ? Math.round(replied.size / contacted.size * 100) : null, you: n('you'), moving: n('moving'), failed: n('failed'), parked: n('parked') };
}

// ── 工作流：步骤是数据 ─────────────────────────────────────────────────────────
// 谁负责 → 显示的名字：成员从名册读（lib/crew.mjs），你是「你」。
export const ownerName = owner => owner === 'you' ? '你' : crewName(owner);
// key → 名字、谁负责、用哪个检测器（design/团队与工作流.md 4.2）。你的那几步写上 for：你答完交给谁接着做
// （指挥台按它把「等你」的行算在那位名下）。「准备材料」原来写着执行器，现在是请执行器做这件事的 Quill
// （prepare_application_packet，lib/crew.mjs JOB_MEMBER）。
export const STEPS = {
  found: { label: '发现', owner: 'scout', detect: 'found' },
  judged: { label: '判断', owner: 'lens', detect: 'judged' },
  screened: { label: '你筛选', owner: 'you', for: 'lens', detect: 'screened' },
  prepare: { label: '准备材料', owner: 'quill', detect: 'prepare' },
  approve: { label: '你批准', owner: 'you', for: 'quill', detect: 'approve' },
  fill: { label: '填表', owner: 'quill', detect: 'fill' },
  final: { label: '终审', owner: 'you', for: 'quill', detect: 'final' },
  submitted: { label: '已提交', owner: 'quill', detect: 'submitted' },
  contact: { label: '找联系人', owner: 'quill', detect: 'contact' },
  referrer: { label: '找内推人', owner: 'quill', detect: 'referrer' },
  first_draft: { label: '写首联', owner: 'quill', detect: 'drafted' },
  dm_draft: { label: '写私信', owner: 'quill', detect: 'drafted' },
  ref_draft: { label: '写请求', owner: 'quill', detect: 'drafted' },
  app_draft: { label: '写申请', owner: 'quill', detect: 'drafted' },
  review: { label: '你审', owner: 'you', for: 'quill', detect: 'review' },
  sent: { label: '已发出', owner: 'quill', detect: 'sent' },
  reply: { label: '回复', owner: 'owl', detect: 'reply' },
  interview: { label: '面试', owner: 'owl', detect: 'interview' },
  result: { label: '结果', owner: 'owl', detect: 'result' },
};
// 这一步是哪位成员的（你的那几步算你答完接手的那位）。
export const stepMember = key => STEPS[key]?.owner === 'you' ? STEPS[key].for : STEPS[key]?.owner || null;
export const SPINE = { head: ['found', 'judged', 'screened'], tail: ['reply', 'interview', 'result'] };
// 渠道 → 它那几步。最后一步是"发出去了"的那一步（做完了才轮到等回复）。
export const CHANNELS = {
  portal: { label: '官网（本人账号）', steps: ['prepare', 'approve', 'fill', 'final', 'submitted'] },
  ats_form: { label: '官网表单', steps: ['prepare', 'approve', 'fill', 'final', 'submitted'] },
  email: { label: '邮件', steps: ['contact', 'first_draft', 'review', 'sent'] },
  platform_dm: { label: '平台私信', steps: ['dm_draft', 'review', 'sent'] },
  referral: { label: '内推', steps: ['referrer', 'ref_draft', 'review', 'sent'] },
  platform_application: { label: '平台上申请', steps: ['app_draft', 'review', 'sent'] },
};
export const stepsFor = channel => [...SPINE.head, ...(CHANNELS[channel] || CHANNELS.email).steps, ...SPINE.tail];
// 表格里的「渠道」一列只放两个字。
export const CHANNEL_SHORT = { portal: '官网', ats_form: '官网', email: '邮件', platform_dm: '私信', referral: '内推', platform_application: '平台' };

// ── 指挥台的表格：不管走哪个渠道，都对齐成同样的八列 ─────────────────────────────
// 每列由这条线索工作流里的一步或几步合成：有一步等你 → 等你；卡住 → 卡住（冲刺期暂停是 hold，不算出错）；
// 在做 → 在做；都做完（或跳过）→ 做完；否则还没到。列从左到右只会是 做完…→ 当前 → 还没到。
export const COLUMNS = [
  { key: 'found', label: '发现', steps: ['found'] },
  { key: 'judged', label: '判断', steps: ['judged'] },
  { key: 'screened', label: '筛选', steps: ['screened'] },
  { key: 'prepare', label: '准备', steps: ['prepare', 'contact', 'referrer', 'first_draft', 'dm_draft', 'ref_draft', 'app_draft'] },
  { key: 'approve', label: '批准', steps: ['approve', 'review'] },
  { key: 'out', label: '递出', steps: ['fill', 'final', 'submitted', 'sent'] },
  { key: 'reply', label: '回复', steps: ['reply'] },
  { key: 'interview', label: '面试', steps: ['interview'] },
];
export function columnsOf(steps = []) {
  return COLUMNS.map(col => {
    const mine = steps.filter(s => col.steps.includes(s.key));
    const hit = ['waiting_you', 'blocked', 'current'].map(st => mine.find(s => s.status === st)).find(Boolean);
    let status = hit ? hit.status : mine.length && mine.every(s => s.status === 'skipped') ? 'skipped' : mine.some(s => s.status === 'done') && mine.every(s => ['done', 'skipped'].includes(s.status)) ? 'done' : 'not_reached';
    if (status === 'blocked' && hit.hold) status = 'hold';
    const src = hit || [...mine].reverse().find(s => s.status === 'done') || null;
    return { key: col.key, label: col.label, status, ...(src?.note ? { note: src.note } : {}) };
  });
}
const STATUS_OF = { done: 'done', active: 'current', you: 'waiting_you', stuck: 'blocked', skip: 'skipped' };

// 检测器：看线索和它的几次联系 / 投递，说这一步 做完（done）/ 在做（active）/ 等你（you）/ 卡住（stuck）/ 跳过（skip）。
// 返回 null = 没有迹象（还没到这一步）。有信等你的算"等你"，没信可回的算"卡住"（hold：暂停，不是出错）。
const NO_CONTACT = /(?:未|没有?)(?:找到|发现|公开)[^。；]{0,16}(?:联系人|邮箱|招聘人|联系入口|联系方式)/;
const REVIEW_WAIT = /^(草稿待你审|被退回|草稿在改|要你在平台上操作)/;
function jobStep(c, kinds) {
  const j = c.jobs.filter(x => kinds.includes(x.kind)).sort((a, b) => T(b.completed_at || b.updated_at || b.created_at) - T(a.completed_at || a.updated_at || a.created_at))[0];
  if (!j) return null;
  const ask = askForJob(c.asks, j.id);
  if (['completed', 'done'].includes(j.status)) return { s: 'done', at: j.completed_at, note: plainReason(j.result, 60), evidence: evidenceOf(j.evidence), job: j };
  if (j.status === 'working') return { s: 'active', at: j.updated_at || j.created_at, note: '本机 AI 在做' };
  if (j.status === 'pending') return { s: 'active', at: j.created_at, note: '排队给本机 AI' };
  if (j.status === 'waiting_user') return { s: ask ? 'you' : 'stuck', at: j.updated_at || j.created_at, note: plainReason(j.needs?.length ? needsSummary(j.needs) : j.waiting_user || j.required_action || j.question, 50) || '有问题问你', ask };
  if (j.status === 'blocked') return { s: 'stuck', at: j.updated_at || j.created_at, note: `本机 AI 卡住了，${crewName('patch')} 在看`, ask };
  return null;
}
// 你说了联系三天以上还没动静：算卡住，写清楚几天了。
const stale = (c, what) => { const d = ['contacting', 'outreach_ready'].includes(c.state) ? daysSince(c.l.feedback_at || c.l.state_at, c.now) : null; const official = ['portal', 'ats_form'].includes(applyChannel(c.l)); return d != null && d >= 3 ? { s: 'stuck', note: `${official ? '你决定推进官网岗位' : '你说要联系'} ${d} 天了，${what}` } : null; };
// 这封信怎么问的，就怎么写这一步（收件箱的原话，不另编）。
const askNote = (a, n = 44) => a ? cut(plainText(a.question || a.title || ''), n) : '';
// 自动投递排队等下一轮的状态；按了提交之后的状态（提交中、结果不确定）。
const APPLY_QUEUED = ['approved', 'queued', 'pending'], APPLY_SUBMITTING = ['submitting', 'uncertain'];
// 终审里点了「确认提交」（lib/ask-actions.mjs finalApprove：状态回到 approved、记下 final_approved_at），下一轮自动投递才真正提交。
// 从这时起表已填好、终审做完，工作流停在「已提交」这一步，直到提交完。
const finalConfirmed = a => !!a.final_approved_at && [...APPLY_QUEUED, ...APPLY_SUBMITTING].includes(a.status);
const DETECT = {
  found: c => ({ s: 'done', at: c.l.discovered_at || c.l.imported_at || c.l.posted_at || null, note: sourceLabel(c.l) }),
  judged: c => {
    const l = c.l, fresh = c.state === 'new';
    if (l.prefilter_reason) return { s: 'done', at: l.judgement?.at || l.prefilter_backfilled_at, note: `预筛掉：${PREFILTER_WORD[l.prefilter_reason] || '不符合筛选条件'}${fresh ? '' : '（你还是推进了）'}` };
    if (l.match?.verdict) return { s: 'done', at: l.matched_at || l.match.at, note: `${VERDICT[l.match.verdict] || '已判断'}${reasonOf(l) ? ' · ' + reasonOf(l) : ''}` };
    if (l.match_error_final) return fresh ? { s: 'stuck', note: '判断未完成，等系统修复' } : { s: 'skip', note: '判断未完成，你已直接推进' };
    if (!fresh) return { s: 'skip', note: '没走判断，你直接推进的' };
    // 后面的步骤先做完了（Quill 没等判断就写好了草稿）：这一步算做完，话也跟着换（overtaken，见 workflowOf）。
    return { s: 'active', note: `等 ${crewName('lens')} 判断`, overtaken: c.attempt?.draft_id ? `没等 ${crewName('lens')} 判断，${crewName('quill')} 先写好了草稿` : `没等 ${crewName('lens')} 判断，后面的步骤先做了` };
  },
  screened: c => {
    const l = c.l;
    if (c.state === 'passed' || c.state === 'pass_pending') return { s: 'done', at: l.feedback_at || l.state_at, note: `你决定不投了${c.passWhy ? '：' + cut(c.passWhy, 30) : ''}` };
    if (c.state !== 'new') {
      const decision = (l.history || []).filter(e => ['decide_contact', 'apply_approved'].includes(e.event)).sort((a, b) => T(a.at) - T(b.at))[0];
      const requested = decision?.at || l.auto_apply?.user_requested_at || l.auto_apply?.approved_at;
      const later = [c.attempt?.approved_at, c.attempt?.sent_at].filter(T).sort((a, b) => T(a) - T(b))[0];
      const feedback = l.feedback_at || l.state_at;
      const at = requested || (T(feedback) && (!later || T(feedback) <= T(later)) ? feedback : null);
      return { s: 'done', at, note: (l.auto_apply ? '你决定投递' : contactLead(l) ? (['portal', 'ats_form'].includes(applyChannel(l)) ? '你决定推进官网岗位' : '你决定联系招聘方') : '你决定推进') + (!at ? '；当时筛选的时间没有记录' : '') };
    }
    if (c.attempt) return { s: 'skip', note: '系统先写好了，你审的时候一起决定发不发' };
    // 系统建议投递（拟投清单，apply: 那封信）：筛选和批准是同一个决定，信落在「批准」上（09-29 复查：原来琥珀点在「筛选」）。
    if (c.proposal) return { s: 'skip', note: '系统建议投递，你批准的时候一起决定' };
    const ask = c.askObj(['triage', 'decide']);
    if (ask) return { s: 'you', ask: ask.id, note: askNote(ask) || '等你拍板：联系、投，还是不投' };
    return { s: 'active', note: '还没排到你筛选' };
  },
  prepare: c => {
    const j = jobStep(c, ['prepare_application_packet']);
    if (j) return j;
    const l = c.l;
    if (l.application_packet || l.auto_apply || c.attempt?.group === 'done') return { s: 'done', at: l.application_packet?.prepared_at || l.application_packet?.at || null, note: l.application_packet || l.auto_apply ? '申请材料备好了' : '' };
    if (c.proposal) return { s: 'done', note: '系统出好了投递计划' };
    return stale(c, '申请材料还没备好') || { s: 'active', note: '在准备申请材料' };
  },
  approve: c => {
    const a = c.l.auto_apply || {};
    if (a.status === 'awaiting_batch_review') return { s: 'you', at: a.at, note: '批准后材料变了，要你重新确认', ask: c.attempt?.ask || c.askOf(['review', 'decide']) };
    if (a.approved_at) return { s: 'done', at: a.approved_at || a.user_requested_at || a.at || l.feedback_at, note: '你批准了投递' };
    if (c.attempt?.group === 'done') return { s: 'done' };
    if (c.selfSubmit) return { s: 'skip', note: '这个门户要你本人填、本人提交' };
    const ask = c.askObj(['decide', 'review', 'info'], a => !/^(submit|final|prefilled|draft):/.test(a.id));
    if (ask) return { s: 'you', ask: ask.id, note: askNote(ask) || '等你批准投递' };
    if (a.user_requested_at) return { s: 'active', at: a.user_requested_at, note: '你说了投，系统在出申请计划给你批准' };
    return stale(c, '还没出投递计划给你批准') || { s: 'active', note: '等系统出投递计划给你批准' };
  },
  fill: c => {
    const a = c.l.auto_apply || {};
    const gaps = ['prepared_for_user', 'awaiting_final_review'].includes(a.status) && missingLine(a.prefill?.missing || a.final_review?.missing || []);
    if (gaps) return { s: 'you', at: a.at, note: gaps.line, ask: c.askOf(['info', 'review']) };
    if (c.selfSubmit && !a.status) return { s: 'skip', note: '你本人在门户上填' };
    if (c.attempt?.group === 'done' || ['awaiting_final_review', 'prepared_for_user', ...APPLY_SUBMITTING, 'submitted'].includes(a.status) || finalConfirmed(a)) return { s: 'done', at: a.final_review?.at || null, note: '表填好了' };
    if (APPLY_QUEUED.includes(a.status)) return { s: 'active', at: a.approved_at, note: `排队等${applyWord()}` };
    if (a.status === 'needs_login' || a.status === 'waiting_user') {
      // 结构化的 needs（lib/needs.mjs）：登录 → 那个账号的登录信；缺资料 → need:lead:<id>:info 那封信。
      const needs = autoApplyNeeds(c.l, { cfg: c.cfg, url: applyUrl(c.l) });
      const login = needs.find(n => n.kind === 'login'), info = needs.find(n => n.kind === 'info');
      if (login) { const fam = c.cfg.families?.[String(login.account).split(':')[0]]; return { s: 'you', at: a.at, note: `等你登录 ${fam?.label ? fam.label.replace(/（.*）$/, '') : '这个网站'}`, ask: c.asks.find(x => x.type === 'login' && x.account?.key === login.account)?.id || c.loginAskId }; }
      if (info) return { s: 'you', at: a.at, note: `表里有必填项等你补：${cut(info.fields.map(f => f.label).join('、'), 40)}`, ask: c.askIds.has(`need:lead:${c.rid}:info`) ? `need:lead:${c.rid}:info` : c.askOf(['info']) };
      const s = applyStatus(a, { lead: c.l, sprint: c.sprint }), ask = c.askObj(null, x => !/^draft:/.test(x.id));
      return { s: 'you', at: a.at, note: s.status, ask: c.attempt?.ask || ask?.id || c.loginAskId };
    }
    if (a.status === 'failed') return { s: 'stuck', at: a.at, note: withWhy(`${applyWord()}没成功（第 ${a.attempts || 1} 次）`, plainReason(a.error || a.last_error, 40)) };
    if (a.status === 'paused') return { s: 'stuck', hold: true, at: a.paused_at, note: `已暂停${a.paused_reason ? '：' + pauseText(a.paused_reason, c.sprint) : ''}` };
    if (['closed', 'cancelled'].includes(a.status)) return { s: 'skip', note: `已取消${a.closed_reason ? '：' + (CODE_WORD[a.closed_reason] || plainReason(a.closed_reason, 30)) : ''}` };
    return null;
  },
  final: c => {
    const a = c.l.auto_apply || {};
    const self = c.selfSubmit;
    if (self && a.status !== 'submitted' && c.attempt?.group !== 'done') return { s: 'you', ask: self.id, note: askNote(self) || '这个门户要你本人提交' };
    if (a.status === 'awaiting_final_review') return { s: 'you', at: a.final_review?.at || a.at, note: '表填好了，等你终审', ask: c.askIds.has(`final:${c.rid}`) ? `final:${c.rid}` : c.askOf(['review']), evidence: evidenceOf(a.final_review?.screenshot) };
    if (a.status === 'prepared_for_user') return { s: 'you', at: a.at, note: missingLine(a.prefill?.missing || [])?.line || '表已在浏览器里预填，等你亲自提交', ask: c.askIds.has(`prefilled:${c.rid}`) ? `prefilled:${c.rid}` : c.askOf(['review']) };
    if (finalConfirmed(a)) return { s: 'done', at: a.final_approved_at, note: '你确认了提交', evidence: evidenceOf(a.final_review?.screenshot) };
    // 批准即提交（auto_apply_policy.final_review=false，或这个网站的驱动不能先填后停）：这一次没有终审。
    if (APPLY_SUBMITTING.includes(a.status)) return { s: 'skip', note: '这次没有终审，批准后直接提交' };
    if (a.status === 'submitted' || c.attempt?.group === 'done') return { s: 'done', at: a.final_approved_at || null, note: a.final_approved_at ? '你确认了提交' : '', evidence: evidenceOf(a.final_review?.screenshot) };
    return null;
  },
  submitted: c => {
    const a = c.l.auto_apply || {}, att = c.attempt;
    if (att?.group === 'done') return { s: 'done', at: att.sent_at, note: '已提交', evidence: att.evidence };
    if (a.status === 'submitted') return { s: 'done', at: a.submitted_at || a.at, note: '已提交' };
    if (a.status === 'submitting') return { s: 'active', at: a.at, note: '提交中（系统在核对）' };
    if (a.status === 'uncertain') return { s: 'active', at: a.at, note: '结果不确定，系统在核对' };
    if (finalConfirmed(a)) return { s: 'active', at: a.final_approved_at, note: '已确认，等系统提交' };
    return null;
  },
  contact: c => {
    if (c.attempt) return { s: 'done', at: c.attempt.created_at, note: c.attempt.channel_key === 'email' ? '找到了联系邮箱' : '找到了联系入口' };
    const j = jobStep(c, ['verify_contact_entry']);
    if (j?.s === 'done' && NO_CONTACT.test(j.job.result || '')) { const ask = c.askIds.has(`stalled:${c.rid}`) ? `stalled:${c.rid}` : null; return { s: ask ? 'you' : 'stuck', at: j.at, note: '没找到公开的联系人，换个方式推进吗？', ask }; }
    if (j) return j;
    if (c.l.email) return { s: 'done', note: '有公开邮箱' };
    return stale(c, '还没找到联系人') || { s: 'active', note: '在找联系人' };
  },
  referrer: c => {
    if (c.referrers.length) return { s: 'done', at: latestAt(c.referrers.map(r => r.found_at)), note: `找到 ${c.referrers.length} 位：${cut(c.referrers.map(r => r.author).filter(Boolean).join('、'), 30)}` };
    if (c.attempt) return { s: 'done', note: '' };
    return { s: 'active', note: '在找内推人' };
  },
  drafted: c => c.attempt?.cancelled_paused ? { s: 'stuck', hold: true, at: c.attempt.at, note: '旧稿已取消，等待重新准备' } : c.attempt ? { s: 'done', at: c.attempt.created_at, note: c.attempt.subject || '' } : stale(c, '还没写出来') || { s: 'active', note: `${crewName('quill')} 在写` },
  review: c => {
    const att = c.attempt;
    if (!att) return null;
    if (att.approved || att.group === 'done') return { s: 'done', at: att.approved_at, note: att.approved_at ? '你批准了发送' : '' };
    if (att.group === 'parked') return { s: /^已取消/.test(att.status) ? 'skip' : 'stuck', hold: true, at: att.at, note: att.status };
    if (REVIEW_WAIT.test(att.status)) return { s: att.ask ? 'you' : 'stuck', at: att.at, note: `${att.status}${att.note ? `（${att.note}）` : ''}`, ask: att.ask };
    return { s: 'active', at: att.at, note: att.status };
  },
  sent: c => {
    const att = c.attempt;
    if (!att) return null;
    if (att.group === 'done') return { s: 'done', at: att.sent_at, note: `已发出（${att.channel}）`, evidence: att.evidence };
    if (!att.approved) return null;
    if (att.group === 'you') return { s: 'you', at: att.at, note: att.status, ask: att.ask };
    if (att.group === 'failed') return { s: 'stuck', at: att.at, note: att.status };
    return { s: 'active', at: att.at, note: att.status };
  },
  reply: c => {
    const l = c.l, st = c.state, pending = c.followUp;
    const replied = !!l.replied_at || ['replied', 'interview_scheduled', 'interview_done', 'offer'].includes(st) || (st === 'rejected' && !!l.replied_at);
    const said = l.reply_summary ? cut(plainText(l.reply_summary), 50) : '对方回复了';
    if (pending && pending.group === 'you') return { s: 'you', at: pending.at, note: `${replied ? said + '；' : ''}${pending.purpose || '跟进'}${pending.status}`, ask: pending.ask };
    // 回复收到了、后面还没有面试 / Offer / 拒绝：停在「回复」这一步（B10：原来直接跳到「面试」）。
    const after = l.interview_at || l.interview_completed_at || l.offer_at || ['interview_scheduled', 'interview_done', 'offer', 'rejected'].includes(st);
    if (replied) return after ? { s: 'done', at: l.replied_at, note: said } : { s: 'active', at: l.replied_at, note: said, replied: true };
    if (!c.lastSent) return null;
    const r = c.lastSent.reply || replyStatus({ sentAt: c.lastSent.sent_at, lead: l, state: st, now: c.now });
    if (pending) return { s: 'active', at: pending.at, note: `${r.text}；${pending.purpose || '跟进'}${pending.status}` };
    const ask = c.askOf(['followup']);
    if (ask) return { s: 'you', at: c.lastSent.sent_at, note: `${r.text}，跟进一次吗？`, ask };
    return { s: 'active', at: c.lastSent.sent_at, note: r.text };
  },
  interview: c => {
    const l = c.l, t = tsOf(l.interview_at), ask = c.askOf(['interview']);
    if (l.interview_completed_at) return { s: 'done', at: l.interview_completed_at, note: '面试完了' };
    if (Number.isFinite(t)) return { s: ask ? 'you' : 'active', at: l.interview_at, note: t > c.now ? `约了 ${whenText(l.interview_at, c.now)}${l.interview_round ? ' · ' + cut(l.interview_round, 16) : ''}` : '面试时间过了，还没记结果', ask };
    if (c.state === 'interview_scheduled') return { s: ask ? 'you' : 'active', note: '在约面试时间', ask };
    return null;
  },
  result: c => (c.state === 'interview_done' || c.l.interview_completed_at) ? { s: 'active', note: '面完了，等结果' } : null,
};
// 结局：到这里为止，后面没走到的步骤算"跳过"。
function endingOf(c) {
  const l = c.l, st = c.state;
  if (st === 'offer') return { key: 'offer', at: l.offer_at || l.state_at, note: '拿到 Offer' };
  if (st === 'rejected') return { key: 'rejected', at: l.closed_at || l.state_at || l.replied_at, note: '对方婉拒了' };
  if (st === 'archived') return { key: 'archived', at: l.archived_at || l.state_at, note: '已归档' };
  if (st === 'passed' || st === 'pass_pending') return { key: 'passed', at: l.feedback_at || l.state_at, note: `你决定不投了${c.passWhy ? '：' + cut(c.passWhy, 30) : ''}` };
  if (c.stage === 'closed' && excludedCompany(l, c.pipeline)) return { key: 'excluded_company', at: null, note: '你后来排除了这家公司，不再推进' };
  if (l.closed_at && st === 'new') return { key: 'closed', at: l.closed_at, note: '岗位已关闭' };
  if (c.stage === 'excluded') return { key: 'excluded', at: null, note: `系统排除：${excludedWhy(l, c.pipeline) || '不符合筛选条件'}` };
  return null;
}
// 这条线索走哪个渠道：看它现在那一次联系 / 投递（跟进和回复不算），没有就看线索本身。
export function applicationChannel(l = {}, attempt = null) {
  if (attempt) {
    if (attempt.kind === 'apply') return attempt.channel_key === 'ats_form' ? 'ats_form' : 'portal';
    if (attempt.purpose_key === 'referral') return 'referral';
    if (attempt.channel_key === 'email') return 'email';
    if (attempt.channel_key === 'platform_application') return 'platform_application';
    if (['platform_dm', 'maimai_friend_request'].includes(attempt.channel_key)) return 'platform_dm';
  }
  if (l.auto_apply) return applyChannel(l) === 'ats_form' ? 'ats_form' : 'portal';
  const c = leadChannel(l);
  return c === 'wechat' ? 'platform_dm' : CHANNELS[c] ? c : 'email';
}
const primaryOf = rows => [...rows].sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || T(b.group === 'done' ? b.sent_at : b.at) - T(a.group === 'done' ? a.sent_at : a.at))[0] || null;

// 表格「现在」一列：结构化的短字段，不是一句话（09-30 负责人：「等你定怎么推进」「表已填好，等你终审」太口语）。
// 等你的写「待…」，系统在做的写「…中」，结束的写「已…」；完整的那句在岗位页里。
const ASK_NOW = { triage: '待筛选', login: '待登录', decide: '待决定', info: '缺信息', followup: '待跟进', interview: '面试待确认' };
const CUR_NOW = { found: '新发现', judged: '待判断', screened: '待筛选', prepare: '准备材料中', approve: '待批准', fill: '填表中', final: '待终审', submitted: '提交中', contact: '找联系人中', referrer: '找内推人中', first_draft: '写首联中', dm_draft: '写私信中', ref_draft: '写内推请求中', app_draft: '写申请中', review: '待审核', sent: '待发出', reply: '待对方回复', interview: '面试中', result: '待结果' };
// 排着队、还没开始的：和「…中」分开（排队等自动预填 ≠ 在填表）。
const QUEUED_NOW = { fill: '待预填', prepare: '待准备材料', contact: '待找联系人', referrer: '待找内推人', first_draft: '待写首联', dm_draft: '待写私信', ref_draft: '待写内推请求', app_draft: '待写申请', submitted: '待系统提交', sent: '待发出' };
const END_NOW = { offer: 'Offer', rejected: '被婉拒', archived: '已归档', passed: '不投了', excluded_company: '公司已排除', closed: '岗位已关闭', excluded: '已排除' };
export function nowShort(cur = {}, ending = null, ask = null) {
  if (ending) return END_NOW[ending.key] || cut(ending.note, 16);
  const note = cur.note || '';
  if (cur.status === 'waiting_you') {
    if (ask?.type === 'review') return /^final:/.test(ask.id) ? '待终审' : /^submit:/.test(ask.id) ? '待你提交' : cur.key === 'reply' ? '回复待审' : '待审阅';
    // 「对方回复了，你想怎么回？」这封信的类型是面试类，但说的是回复，不是面试。
    if (ask?.type === 'interview' && /^interview:reply:/.test(ask.id)) return '待回复';
    return ASK_NOW[ask?.type] || '待处理';
  }
  if (cur.status === 'blocked') {
    if (cur.hold && /^旧稿已取消/.test(note)) return '旧稿已取消';
    if (cur.hold) return /冲刺/.test(note) ? '冲刺期暂停' : '已暂停';
    const d = /^(?:你说要联系|你决定推进官网岗位) (\d+) 天/.exec(note);
    if (d) return `${d[1]} 天无进展`;
    if (/没成功/.test(note)) return note.split(/[（：]/)[0].replace(/没成功$/, '失败');
    return ['review', 'final'].includes(cur.key) ? '检查没完成' : '这一步没完成';
  }
  if (cur.key === 'reply' && cur.replied) return '对方已回复';
  if (cur.key === 'reply' && /没回复|等回复/.test(note)) { const d = /(\d+) 天没回复/.exec(note); return d ? `${d[1]} 天未回复` : '今天已发出'; }
  if (cur.key === 'interview' && note) return cut(`面试 ${note.replace(/^约了 /, '')}`, 18);
  if (/排队/.test(note)) return QUEUED_NOW[cur.key] || '排队中';
  if (/失败|没成功/.test(note)) return `${cur.label}失败`;
  // 递出这一步分得出三种：确认了还没提交、提交中、结果不确定（系统在核对）。
  if (cur.key === 'submitted') return /结果不确定/.test(note) ? '结果待核对' : /等系统提交/.test(note) ? '待系统提交' : '提交中';
  return CUR_NOW[cur.key] || cur.label || '';
}

// 一条线索的完整工作流。c：{ l, rid, state, stage, dels, jobs, asks, askIds, referrers, now, sprint, pipeline, cfg, passWhy, loginAskId }
export function workflowOf(c0) {
  const dels = c0.dels || [];
  const firsts = dels.filter(d => !FOLLOW_UP.has(d.purpose_key));
  const attempt = primaryOf(firsts);
  const done = dels.filter(d => d.group === 'done' && d.sent_at).sort((a, b) => T(b.sent_at) - T(a.sent_at));
  const followUp = primaryOf(dels.filter(d => FOLLOW_UP.has(d.purpose_key) && ['you', 'moving'].includes(d.group)));
  const asks = c0.asks || [], mine = asks.filter(a => a.lead?.record_id === c0.rid);
  const c = { ...c0, asks, askIds: c0.askIds || new Set(asks.map(a => a.id)), jobs: c0.jobs || [], referrers: c0.referrers || [], cfg: c0.cfg || loadAccounts(), now: c0.now ?? Date.now(), attempt, followUp, lastSent: done[0] || null,
    askOf: types => mine.find(a => !types || types.includes(a.type))?.id || null,
    askObj: (types, keep = () => true) => mine.find(a => (!types || types.includes(a.type)) && keep(a)) || null };
  c.selfSubmit = c.askObj(['review'], a => /^submit:/.test(a.id));
  c.proposal = c.askObj(['decide'], a => /^apply:/.test(a.id));
  const channel = applicationChannel(c.l, attempt);
  const keys = stepsFor(channel);
  const raw = keys.map(key => ({ key, ...(DETECT[STEPS[key].detect](c) || {}) }));
  // 已经联系 / 投递过了（状态机这么说），渠道的最后一步没有记录也算做完（09 月初的旧回执没有草稿）。
  const lastChannel = keys.indexOf(CHANNELS[channel]?.steps.at(-1));
  // 这样算成做完的步骤，原来那句「在做 / 等着」的话不再成立：换成这一步被越过时的说法（detector 给的 overtaken），没有就不写。
  const settle = (r, note) => { const { note: _, overtaken, ...rest } = r; const n = note ?? overtaken; return { ...rest, s: 'done', ...(n ? { note: n } : {}) }; };
  if (lastChannel >= 0 && raw[lastChannel].s !== 'done' && ['contacted', 'replied', 'interview', 'offer'].includes(c.stage)) raw[lastChannel] = settle(raw[lastChannel], channel === 'portal' || channel === 'ats_form' ? '已投递' : '已联系');
  // 后面一步做完了，前面没有记录的也算做完。
  const lastDone = raw.map(r => r.s).lastIndexOf('done');
  for (let i = 0; i < lastDone; i++) if (!raw[i].s || raw[i].s === 'active') raw[i] = settle(raw[i]);
  const ending = endingOf(c);
  let current = null;
  const steps = raw.map(r => {
    const def = STEPS[r.key];
    let status;
    if (r.s === 'done') status = 'done';
    else if (r.s === 'skip') status = 'skipped';
    else if (ending) status = r.key === 'result' ? 'done' : 'skipped';
    else if (!current) status = STATUS_OF[r.s || 'active'];
    else status = 'not_reached';
    const out = { key: r.key, label: def.label, owner: def.owner, owner_name: ownerName(def.owner), member: stepMember(r.key), status };
    const note = ending && r.key === 'result' ? ending.note : status === 'current' && !r.s ? '' : r.note;
    const at = ending && r.key === 'result' ? ending.at : r.at;
    if (note) out.note = note;
    if (at && status !== 'not_reached') { out.at = at; out.when = whenText(at, c.now); }
    if (r.ask && ['waiting_you', 'blocked', 'current'].includes(status)) out.ask = r.ask;
    if (out.ask && status === 'waiting_you') { const a = c.asks.find(x => x.id === out.ask); const q = a ? cut(plainText(a.question || a.title || ''), 140) : ''; if (q) out.ask_text = q; }
    if (r.evidence?.length) out.evidence = r.evidence;
    if (r.hold) out.hold = true;
    if (r.replied) out.replied = true;
    if (!current && ['current', 'waiting_you', 'blocked'].includes(status)) current = out;
    return out;
  });
  // 收件箱里有这条线索的信，它就是在等你（09-29：门户线索停在「没找到公开联系人」、信在收件箱里，表上却写「在准备申请材料」）。
  // 当前这一步算出来是在做、卡住还是暂停，都换成等你、对上那封信：先用这一步自己带的，其次后面某一步认领的，
  // 再其次这条线索的第一封（收件箱的顺序），最后是挡住它的登录信。
  if (current && current.status !== 'waiting_you') {
    const i = steps.indexOf(current);
    const id = [raw[i].ask, ...raw.slice(i + 1).filter(r => r.s === 'you').map(r => r.ask), ...mine.map(a => a.id), c.loginAskId].find(x => x && c.askIds.has(x));
    const letter = id ? c.asks.find(a => a.id === id) : null;
    if (letter) {
      const q = cut(plainText(letter.question || letter.title || ''), 140);
      // 回复这一步原来写的是对方的原话，留着（信的问题在 ask_text 里，抽屉里就在它旁边）。
      Object.assign(current, { status: 'waiting_you', ask: id, note: current.replied && current.note ? current.note : askNote(letter) || '等你处理' });
      if (q) current.ask_text = q;
      delete current.hold;
    }
  }
  const cur = current ||(ending ? steps.at(-1) : steps.filter(s => s.status === 'done').at(-1) || steps[0]);
  const needsYou = cur.status === 'waiting_you';
  const group = ending ? 'ended' : needsYou ? 'you' : ['interview'].includes(c.stage) || cur.key === 'interview' || cur.key === 'result' ? 'interview' : cur.key === 'reply' && !cur.replied ? 'waiting' : 'moving';
  const tone = ending ? (ending.key === 'offer' ? 'ok' : 'mute') : needsYou ? 'wait' : cur.status === 'blocked' ? (cur.hold ? 'mute' : 'bad') : group === 'waiting' ? 'mute' : group === 'interview' ? 'ok' : 'work';
  // 指挥台表格里显示在哪一格：等你 / 进行中 / 已递出等回复 / 面试；已结束的（Offer 除外）和只在收件箱等筛选的不上表。
  const bucket = ending ? (ending.key === 'offer' ? 'interview' : null) : cur.key === 'screened' || c.stage === 'triage' ? null : group;
  return { rid: c.rid, label: leadLabel(c.l), number: c.l.number ?? null, company: c.l.company || '公司待核', role: cut(c.l.applied_role || c.l.role, 60), city: cityLabel(c.l), channel, channel_label: attempt?.channel || CHANNELS[channel].label, channel_short: CHANNEL_SHORT[channel], steps, timeline: [...steps].sort((a, b) => a.at && b.at ? T(a.at) - T(b.at) : a.at ? -1 : b.at ? 1 : 0), cols: columnsOf(steps), current: cur.key, current_label: cur.label, current_status: cur.status, text: cur.note || cur.label, now: nowShort(cur, ending, cur.ask ? c.asks.find(a => a.id === cur.ask) : null), needs_you: needsYou, ask: needsYou || cur.status === 'blocked' ? cur.ask || null : null, group, bucket, tone, ending: ending?.key || null,
    attempts: dels.map(d => ({ channel: d.channel, purpose: d.purpose, status: d.status, tone: d.tone, when: d.sent || d.when, reply: d.reply?.text || '', subject: d.subject, note: d.note, evidence: d.evidence, ask: d.ask })) };
}

// 在推进的线索：你拍过板（联系 / 投），或者系统已经为它写了东西、发了东西；只在收件箱里等筛选的不算。
export function isApplication(e, dels = []) {
  const live = dels.filter(d => !(d.group === 'parked' && /^已取消/.test(d.status)));
  if (e.stage === 'excluded') return live.length > 0;
  if (live.length || (e.l.auto_apply && !['closed', 'cancelled'].includes(e.l.auto_apply.status)) || contactLead(e.l)) return true;
  // 归档的要真推进过（有回复 / 面试 / Offer）才算；旧程序直接归档、从没推进过的不是投递。
  if (e.state === 'archived') return !!(e.l.replied_at || e.l.interview_at || e.l.offer_at);
  return !['new', 'passed', 'pass_pending'].includes(e.state);
}
// 指挥台表格上方的筛选（顺序即显示顺序）。
export const APP_GROUPS = [['you', '等你'], ['moving', '进行中'], ['waiting', '已递出等回复'], ['interview', '面试'], ['all', '全部']];
// 投递进度（/api/hq 的 applications）：每条在推进的线索一行，带它的整条工作流。等你的在前，然后按最近动静。
// 已结束的（归档、pass、后来排除的公司、对方婉拒、系统排除）和只在收件箱等筛选的默认不返回，只计数；closed: true 全返回。
// include(e)：还不是投递、也要一行的线索（指挥台 v2 的「新线索」：收件箱里等你筛选 / 拟投的），这些行带 lead_only，不进各项计数。
export function applicationsView(input = {}, { limit = 300, closed = false, include = null } = {}) {
  const x = progressIndex(input), { now, asks, askIds, loginBy, pipeline, sprint, passWhy } = x.ctx;
  const jobs = lastRev(input.jobs || cachedLines('state/host-jobs.ndjson'));
  const jobsBy = groupBy(jobs, j => j.record_id), jobsByNo = groupBy(jobs.filter(j => j.number != null), j => String(j.number));
  const refsBy = groupBy(input.referrers || cachedLines('state/referrers.ndjson'), r => r.lead_number != null ? String(r.lead_number) : null);
  const cfg = loadAccounts();
  const rows = [];
  for (const e of x.entries) {
    const dels = x.ctx.delBy.get(e.rid) || [];
    const app = isApplication(e, dels);
    if (!app && !include?.(e)) continue;
    const l = e.l, n = l.number != null ? String(l.number) : null;
    const myJobs = [...new Map([...(jobsBy.get(e.rid) || []), ...(n ? jobsByNo.get(n) || [] : [])].map(j => [j.id, j])).values()];
    const why = [...(l.history || [])].reverse().find(h => h.event === 'decide_pass' && h.note)?.note || passWhy.get(e.rid) || '';
    const wf = workflowOf({ l, rid: e.rid, state: e.state, stage: e.stage, dels, jobs: myJobs, asks, askIds, referrers: n ? refsBy.get(n) || [] : [], now, sprint, pipeline, cfg, passWhy: why, loginAskId: loginBy.get(e.rid) || null });
    rows.push({ ...wf, at: e.at, when: whenText(e.at, now), ...(app ? {} : { lead_only: true }) });
  }
  rows.sort((a, b) => (b.needs_you - a.needs_you) || !a.bucket - !b.bucket || T(b.at) - T(a.at));
  const apps = rows.filter(r => !r.lead_only), shown = apps.filter(r => r.bucket), out = closed ? rows : shown;
  const counts = { ...Object.fromEntries(APP_GROUPS.map(([k]) => [k, k === 'all' ? shown.length : shown.filter(r => r.bucket === k).length])), closed: apps.filter(r => !r.bucket && r.ending).length, triage: apps.filter(r => !r.bucket && !r.ending).length };
  return { rows: out.slice(0, limit), total: out.length, counts, groups: APP_GROUPS.map(([key, label]) => ({ key, label })), summary: deliverySummary(x.deliveries, now), board: href.jobs() };
}
