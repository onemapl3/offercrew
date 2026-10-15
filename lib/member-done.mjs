// 成员页「做了什么」（0.1.8，负责人 10-05：「之前那些角色的一些功能，还有他做的事都在哪里？」）。
// 10-03 成员页只剩任务卡以后，定时跑的那些（不是卡）在成员页上看不到，Radar 一页只有一行「扫真人帖 失败」。
// 这里从账本身（岗位、发出的消息、邮件、简历版本、修复、用量）和运行日志（state/events.ndjson）拼两样，GET /api/team/<id> 的 done：
//   made   做出来的东西：每一行指到那条岗位、那一版材料、那封邮件的证据……
//            Radar 找到的新岗位 · Judge 判断过的岗位（带结论）和公司调研 · Writer 改出来的简历版本和信 ·
//            Reacher 发出的邮件 / 私信、预填好的申请表、找到的内推人 · Watcher 认出来的回复和面试 · System 修好的、恢复的、花了多少
//   facts  一行有数的事实（「近 7 天找到 27 条新岗位」），没有就空
//   runs   运行日志里这位最近的运行（定时的、手点的都在），连着同一句的并成一行「×N」；带证据文件的给证据
// 只读，不改任何东西；读不到的那一类当没有（不报错，页面照样画别的）。
import { coName } from './vocab.mjs';
import { cachedLines } from './state-cache.mjs';
import { DAY, T, within, leadLabel, ridOf, reasonOf, sourceLabel, PREFILTER_WORD, VERDICT, cut, STEP, channelLabel, plainMsg } from './workflow.mjs';
import { loadBriefs, companyKey } from './company-brief.mjs';
import { loadWorkspace, loadDoc } from './resume-store.mjs';
import { versionLabel } from './resume-label.mjs';
import { ledgerSince, totals, dayOf as usageDay, dayStart } from './usage.mjs';
import { tailEvents } from './events.mjs';
import { memberOfEvent, crewName } from './crew.mjs';
import { eventWords, dedupeEvents } from './event-words.mjs';
import { wordOf, fromLegacy } from './status.mjs';
import { plainText } from './jargon.mjs';
import { noteSwallowed } from './swallow.mjs';
import { href } from './routes.mjs';
import { read } from './store.mjs';
import { sourceReadSummary } from './discovery-source.mjs';
import * as J from './jobs.mjs';

const MADE_MAX = 8, RUNS_MAX = 8;
const leadHref = l => `#lead/${encodeURIComponent(ridOf(l))}`;
const born = l => l.discovered_at || l.imported_at;
const safe = (what, fn, fallback) => { try { return fn(); } catch (e) { noteSwallowed('member-done', e, { doing: what, then: '成员页上先不列这一类' }); return fallback; } };
// 窗口里的按时间新的在前；窗口里一条都没有就退一步，拿最近的几条（做过事的成员页不空，负责人 10-05）。
function recent(rows, { now, days, max = MADE_MAX }) {
  const sorted = rows.filter(r => T(r.at)).sort((a, b) => T(b.at) - T(a.at));
  const inWin = sorted.filter(r => now - T(r.at) < days * DAY);
  return (inWin.length ? inWin : sorted.slice(0, 5)).slice(0, max);
}
const n = (k, word) => k ? `${k} ${word}` : '';
const join = parts => parts.filter(Boolean).join('、');
// 程序自己记的代号（步骤名、状态码、「concierge · degraded」这种事件原话）：一律不上页面（主会话 10-05 在真数据上看到）。
// 有人话的换成人话（lib/workflow.mjs STEP、plainMsg）；换不了的这一句就不写。
export const CODEY = /(?<![\w./@-])[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+(?![\w./@-])|(?<![\w./-])[a-z][a-z-]*[a-z] · [a-z_]+(?![\w./-])|(?<![\w./-])(?:concierge|listener|heartbeat|catchup|degraded|no_change|changed|skipped)(?![\w./-])/;
const human = t => { const x = String(t || '').trim(); return x && !CODEY.test(x) && !/内部代码/.test(x) ? x : ''; };

// ── 每位做出来的 ─────────────────────────────────────────────────────────────
// Radar 收进来的每一条都写它现在怎样（推荐 / 待核 / 排除 / 预筛掉，带一句为什么，还没判断的照说）：
// 收进来的不都是岗位（求职者自己的帖、公司主页、评论帖会被预筛掉或排除），不说「找到 N 条新岗位」（主会话 10-05）。
const VERDICT_TONE = { recommend: 'ok', verify: 'work', exclude: 'mute' };
export function leadStatus(l) {
  if (l.prefilter_reason) return { tag: '预筛掉', tone: 'mute', why: PREFILTER_WORD[l.prefilter_reason] || '不符合筛选条件' };
  if (l.match?.verdict) return { tag: VERDICT[l.match.verdict] || '判断过', tone: VERDICT_TONE[l.match.verdict] || 'mute', why: reasonOf(l) };
  if (l.match_error_final) return { tag: '判断失败', tone: 'bad', why: '要人工看一眼' };
  return { tag: '还没判断', tone: 'wait', why: '' };
}
const tally = rows => join(['推荐', '待核', '排除', '预筛掉', '判断失败', '还没判断'].map(k => [k, rows.filter(r => r.tag === k).length]).filter(x => x[1]).map(x => `${x[0]} ${x[1]}`));
function scoutMade({ leads, now }) {
  const from = l => { const src = sourceLabel(l); return (l.human || l.source_type === 'human') && !/真人/.test(src) ? `真人帖 · ${src}` : src; };
  const rows = leads.filter(l => born(l) && T(born(l)) <= now + 60000).map(l => { const st = leadStatus(l); return { at: born(l), title: leadLabel(l), detail: [st.why, from(l)].filter(Boolean).join(' · '), tag: st.tag, tone: st.tone, href: leadHref(l) }; });
  const week = rows.filter(r => within(r.at, 7 * DAY, now));
  return { facts: week.length ? `近 7 天收进 ${week.length} 条：${tally(week)}` : '', rows: recent(rows, { now, days: 7 }), all: href.jobs() };
}
function lensMade({ leads, now, briefs }) {
  const judgedAt = l => l.matched_at || l.match?.at || l.rejudged_at || (l.prefilter_reason ? born(l) : null);
  const rows = leads.filter(l => judgedAt(l) && (l.match?.verdict || l.prefilter_reason)).map(l => {
    const st = leadStatus(l);
    return { at: judgedAt(l), title: leadLabel(l), detail: st.why, tag: st.tag, tone: st.tone, href: leadHref(l) };
  });
  const byCompany = new Map(leads.map(l => [companyKey(l.company), l]));
  for (const b of briefs.values()) {
    if (!b.updated_at) continue;
    const l = byCompany.get(b.key || companyKey(b.company));
    rows.push({ at: b.updated_at, title: `公司调研 · ${b.company}`, detail: b.status === 'not_found' ? `公开资料很少${b.note ? `：${cut(b.note, 40)}` : ''}` : cut(b.summary?.text, 70), tag: b.status === 'not_found' ? '查不到' : '已调研', tone: b.status === 'not_found' ? 'mute' : 'ok', href: l ? leadHref(l) : '#command' });
  }
  const week = rows.filter(r => within(r.at, 7 * DAY, now) && r.tag !== '已调研' && r.tag !== '查不到');
  const briefsWeek = rows.filter(r => within(r.at, 7 * DAY, now) && (r.tag === '已调研' || r.tag === '查不到')).length;
  return { facts: [week.length ? `近 7 天判断 ${week.length} 条（${tally(week)}）` : '', briefsWeek ? `调研了 ${briefsWeek} 家公司` : ''].filter(Boolean).join('；'), rows: recent(rows, { now, days: 7 }), all: href.jobs() };
}
const WRITER_BY = new Set(['writer', 'tailor']);
function tailorMade({ now, docs, letters }) {
  const rows = [];
  for (const doc of docs) for (const v of doc.versions || []) {
    if (!WRITER_BY.has(v.by) || v.draft || !v.created_at) continue;
    rows.push({ at: v.created_at, title: `${doc.title || '简历'} · ${versionLabel(doc, v, { lang: true })}`, detail: [v.by === 'tailor' ? `历史定制版${v.authorization?.source ? '，授权来源：' + v.authorization.source : '，当时授权来源未记录'}` : '改了一版', v.base ? `基于 ${v.base}` : ''].filter(Boolean).join('，'), tag: v.default_for ? '投递在用' : '新版本', tone: v.default_for ? 'ok' : 'work', href: `#materials?doc=${encodeURIComponent(doc.id)}&v=${encodeURIComponent(v.id)}` });
  }
  const KIND = { cover_letter: ['求职信', 'letters'], self_intro: ['自我介绍', 'intros'] };
  const latest = new Map();
  for (const r of letters) {
    const key = r.family || `${r.kind}|${r.record_id || r.number || r.company || 'generic'}|${r.lang || ''}`;
    const previous = latest.get(key);
    if (!previous || (Number(r.n) && Number(previous.n) ? Number(r.n) >= Number(previous.n) : T(r.created_at) >= T(previous.created_at))) latest.set(key, r);
  }
  for (const r of latest.values()) {
    if (r.by !== 'ai' || !r.created_at || !KIND[r.kind]) continue;
    const [word, tab] = KIND[r.kind];
    rows.push({ at: r.created_at, title: `${word}${r.company ? ` · ${r.number != null ? '#' + r.number + ' ' : ''}${r.company}` : r.generic ? ' · 通用' : ''}`, detail: [r.n ? `第 ${r.n} 版` : '', r.status === 'failed' ? '有句子核对没过' : r.role ? cut(r.role, 40) : ''].filter(Boolean).join(' · '), tag: r.status === 'used' || r.status === 'accepted' ? '在用' : r.status === 'failed' ? '没过核对' : '写好了', tone: r.status === 'failed' ? 'bad' : r.status === 'used' || r.status === 'accepted' ? 'ok' : 'work', href: href.materials('', { tab, key: r.key }) });
  }
  const w = rows.filter(r => within(r.at, 14 * DAY, now));
  const vers = w.filter(r => r.href.includes('doc=')).length, lets = w.length - vers;
  return { facts: w.length ? `近 14 天 ${join([n(vers, '版简历'), n(lets, '封信和自我介绍')])}` : '', rows: recent(rows, { now, days: 14 }), all: '#materials' };
}
const CHANNEL = { email: '邮件', platform_dm: '私信', dm: '私信', friend_request: '好友申请' };
const PURPOSE = { referral: '内推请求', application: '投递', first_contact: '首联', followup: '跟进', reply: '回复' };
// 申请表只说「自动预填，你来提交」（负责人 09-30）：预填好了等你、填好了等你终审、已提交。
const APPLY = { prepared_for_user: ['自动预填', 'wait', '申请表自动预填，你来提交'], awaiting_final_review: ['等你终审', 'wait', '申请表填好了，你终审后提交'], submitted: ['已提交', 'ok', '申请表'] };
function quillMade({ leads, outbound, referrers, now }) {
  const byRid = new Map(leads.map(l => [String(ridOf(l)), l]));
  const FORM = new Set(['ats_form', 'portal']);
  const rows = [];
  for (const o of outbound) {
    if (!(o.at || o.sent_at) || o.status === 'corrected') continue;
    const l = byRid.get(String(o.record_id)), form = FORM.has(o.channel);
    if (form && APPLY[l?.auto_apply?.status]) continue; // 申请表那一行下面按投递记录写（预填好了 / 已提交）
    const ch = form ? '' : CHANNEL[o.channel] || '消息';
    rows.push({ at: o.sent_at || o.at, title: l ? leadLabel(l) : `${o.number != null ? '#' + o.number + ' ' : ''}${o.company || ''}`.trim() || '一条消息', detail: [form ? channelLabel({ channel: o.channel }) : (x => `发出${/^[A-Za-z]/.test(x) ? ' ' : ''}${x}`)(channelLabel({ channel: o.channel, to: o.to, platform: o.platform })), PURPOSE[o.purpose] || '', o.subject && !l ? cut(o.subject, 40) : ''].filter(Boolean).join(' · '), tag: form ? '已提交' : ch === '邮件' ? '邮件' : '私信', tone: 'ok', href: l ? leadHref(l) : '#inbox', evidence: typeof o.evidence === 'string' && o.evidence.startsWith('runs/') ? o.evidence : null, ...(form ? { apply: 'submitted' } : { channel: ch }) });
  }
  for (const l of leads) {
    const a = l.auto_apply, s = a && APPLY[a.status];
    if (!s || !(a.at || a.submitted_at)) continue;
    const ev = [a.evidence, ...outbound.filter(o => FORM.has(o.channel) && String(o.record_id) === String(ridOf(l))).map(o => o.evidence)].find(f => typeof f === 'string' && f.startsWith('runs/')) || null;
    rows.push({ at: a.submitted_at || a.at, title: leadLabel(l), detail: s[2], tag: s[0], tone: s[1], href: leadHref(l), evidence: ev, apply: a.status });
  }
  for (const r of referrers) {
    if (!r.found_at) continue;
    const l = r.lead_number != null ? leads.find(x => x.number === r.lead_number) : null;
    rows.push({ at: r.found_at, title: `内推人 · ${r.author || '未署名'}（${coName(r.company) || '公司待核'}）`, detail: cut(r.author_title || r.relationship || '', 50), tag: '找到了', tone: 'work', href: l ? leadHref(l) : '#command' });
  }
  const w = rows.filter(r => within(r.at, 7 * DAY, now));
  return { facts: w.length ? `近 7 天 ${join([n(w.filter(r => r.channel === '邮件').length, '封邮件'), n(w.filter(r => r.channel && r.channel !== '邮件').length, '条私信'), n(w.filter(r => r.apply && r.apply !== 'submitted').length, '份申请表自动预填'), n(w.filter(r => r.apply === 'submitted').length, '份已提交'), n(w.filter(r => r.tag === '找到了').length, '位内推人')])}` : '', rows: recent(rows, { now, days: 7 }), allRows: rows.sort((a, b) => T(b.at) - T(a.at)), all: href.team('quill', { section: 'made' }) };
}
// Watcher 认出来的：只算挂在某个岗位上、和求职有关的邮件（招聘方回复、面试、拒信、申请确认）。
// 安全提醒、账号通知这些分好类的别的邮件不算回复，只在事实那一行数一下（主会话 10-05：真数据上 7 条「回复」里 6 条是安全提醒）。
const MAIL_KIND = [[/面试/, 'interview', '面试'], [/拒/, 'rejection', '拒信'], [/申请已收到|自动确认|确认收到/, 'confirmation', '申请确认'], [/招聘方回复|回复|进展|需补材料|offer/i, 'reply', '招聘方回复']];
export const mailKind = category => { const k = MAIL_KIND.find(([re]) => re.test(String(category || ''))); return k ? { kind: k[1], tag: k[2] } : null; };
const NOT_JOB_MAIL = /安全|验证码|code|账号|account|无关|unrelated|用户反馈/i;
function owlMade({ leads, mail, now }) {
  const rows = [], seen = new Set(), byRid = new Map(leads.map(l => [String(ridOf(l)), l]));
  for (const l of leads) {
    if (!l.replied_at && !l.interview_at) continue;
    const iv = l.interview_at && !l.interview_completed_at;
    const at = l.replied_at || l.interview_response_at || l.interview_at;
    rows.push({ at: T(at) > now ? new Date(now).toISOString() : at, title: leadLabel(l), detail: iv ? `面试 ${new Date(T(l.interview_at)).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${l.interview_round ? ` · ${cut(l.interview_round, 20)}` : ''}` : cut(plainText(l.reply_summary || ''), 70), tag: l.offer_at ? 'Offer' : iv ? '约了面试' : l.interview_completed_at ? '面过了' : '回复了', tone: l.closed_at && !l.offer_at ? 'mute' : 'ok', href: leadHref(l), kind: iv || l.interview_completed_at ? 'interview' : 'reply' });
    seen.add(String(ridOf(l)));
  }
  let other = 0;
  for (const e of mail) {
    const l = e.record_id ? byRid.get(String(e.record_id)) : null, k = mailKind(e.category);
    if (!l || !k || NOT_JOB_MAIL.test(e.category || '')) { if (within(e.at, 14 * DAY, now) && !/用户反馈/.test(e.category || '')) other++; continue; }
    if (seen.has(String(e.record_id))) continue;
    rows.push({ at: e.at, title: leadLabel(l), detail: cut(plainText(e.summary || e.subject || ''), 70), tag: k.tag, tone: k.kind === 'rejection' ? 'mute' : 'ok', href: leadHref(l), kind: k.kind });
  }
  const w = rows.filter(r => within(r.at, 14 * DAY, now)), c = k => w.filter(r => r.kind === k).length;
  const got = join([n(c('reply'), '条招聘方回复'), n(c('interview'), '场面试'), n(c('rejection'), '封拒信'), n(c('confirmation'), '封申请确认')]);
  return { facts: [got ? `近 14 天认出 ${got}` : '', other ? `另外分好类 ${other} 封别的邮件` : ''].filter(Boolean).join('；'), rows: recent(rows, { now, days: 14 }), all: '#inbox' };
}
// 一条恢复了的告警说成人话：哪一步（lib/workflow.mjs STEP）、谁的、出错过几次，后来做成了；原话换得成人话才写原因。
// 认不出是哪一步、原话又全是代号的，说「一项后台工作」，不露代号。
export function alertWords(a = {}) {
  const step = STEP[a.step] || '', who = crewName(a.source || 'patch');
  const core = String(a.msg || '').replace(/（24 小时内 \d+ 次）$/, ''), said = human(plainMsg(core, 60)).replace(/^这一步\s*·?\s*/, '');
  const what = step || (said ? cut(said, 30) : '一项后台工作');
  const why = step && said ? said.replace(new RegExp(`^${step}\\s*[·：:]?\\s*`), '') : '';
  return { title: `恢复了 · ${who} 的${what}`, detail: [`${a.count ? `出错过 ${a.count} 次，` : '之前出错，'}后来又做成了`, why ? `当时：${why}` : ''].filter(Boolean).join('；') };
}
// 花了多少：模型调用的账（state/usage.ndjson，lib/usage.mjs）。订阅的不花钱，只写 token；补给写补给；按量的写人民币。
export function spendText(t = {}) {
  if (!t.calls) return '';
  const money = t.cny >= 0.01 ? `自有模型约 ¥${t.cny.toFixed(2)}` : '';
  const credit = t.credits >= 1 ? `补给 ${Math.round(t.credits)} token` : '';
  const tok = !money && !credit && t.tokens ? `${t.tokens >= 10000 ? `${Math.round(t.tokens / 1000)}k` : t.tokens} token` : '';
  return [`${t.calls} 次模型调用`, money, credit, tok].filter(Boolean).join(' · ');
}
function patchMade({ center, now, usage }) {
  const rows = [];
  for (const r of center.repairs?.rows || []) {
    if (r.status !== 'completed' || !r.completed_at) continue;
    const what = human(plainMsg(r.label, 50));
    rows.push({ at: r.completed_at, title: what ? `修好了 · ${what}` : '修好了一处卡住的地方', detail: human(plainMsg(r.result, 80)), tag: '修好了', tone: 'ok', href: '#stream?flow=patch', evidence: (r.evidence || []).find(f => typeof f === 'string' && f.startsWith('runs/')) || null });
  }
  for (const a of center.alerts || []) {
    if (!a.recovered_at) continue;
    rows.push({ at: a.recovered_at, ...alertWords(a), tag: '已恢复', tone: 'ok', href: '#stream?flow=fail' });
  }
  const today = usage.today, week = usage.week;
  if (today?.calls || week?.calls) rows.push({ at: usage.last_at || new Date(now).toISOString(), title: '模型花费', detail: [today?.calls ? `今天 ${spendText(today)}` : '今天还没调用', week?.calls ? `近 7 天 ${spendText(week)}` : ''].filter(Boolean).join('；'), tag: '用量', tone: 'mute', href: '#settings/spend' });
  const fixed = rows.filter(r => r.tag === '修好了' && within(r.at, 7 * DAY, now)).length;
  return { facts: [fixed ? `近 7 天修好 ${fixed} 处` : '', today?.calls ? `今天 ${spendText(today)}` : ''].filter(Boolean).join('；'), rows: recent(rows, { now, days: 7 }), all: '#stream?flow=patch' };
}

// ── 运行日志里这位的运行 ─────────────────────────────────────────────────────
// 和运行日志页同一份事件（lib/events.mjs），按 lib/crew.mjs memberOfEvent 归属；「开始」、心跳、工作台起停不算。
// 一行：步骤名 · 结果（「扫官方招聘源 · 没有新的」），补充一句（事件原话说成人话），证据文件；连着同一句的并成一行，n 次。
// 不算这位做的事：迁移旧记录（migrate、jobs：旧记录迁进账）、改设置、对话、卡片上点的（运行日志页照样有）。
const NOT_WORK = new Set(['migrate', 'jobs', 'settings', 'chat', 'card-action', 'room', 'message', 'connection', 'connect']);
const eventWord = e => /changed|有更新/.test(e.msg || '') ? '有更新' : e.status === 'skip' ? '没有新的' : fromLegacy(e.status) ? wordOf(fromLegacy(e.status)) : '有记录';
export function memberRuns(id, { events = [], now = Date.now(), days = 7, max = RUNS_MAX } = {}) {
  const mine = dedupeEvents(events.filter(e => e.status !== 'start' && e.step !== 'heartbeat' && e.step !== 'web' && !NOT_WORK.has(e.step) && within(e.ts, days * DAY, now) && ((e.step === 'cycle' && J.forRun(e.run_id)?.member) || memberOfEvent(e)) === id).sort((a, b) => T(b.ts) - T(a.ts)));
  const out = [];
  for (const record of mine) {
    const job = record.step === 'cycle' ? J.forRun(record.run_id) : null;
    const partial = job?.state === 'done' && job.result?.counts?.partial === true;
    const e = job?.state === 'failed' ? { ...record, status: 'fail', msg: job.reason || record.msg } : partial ? { ...record, status: 'ok', msg: job.result.summary } : record;
    // 事件原话开头的「Writer：」不再写一遍：这一页就是 Writer 的。
    const label = STEP[e.step] || '', said = (/^[a-z][a-z-]* · [a-z_]+$/.test(String(e.msg || '').trim()) ? '' : eventWords(e.msg, 160)).replace(new RegExp(`^${crewName(id)}\\s*[：:]\\s*`), '');
    const title = label ? `${label} · ${partial ? '部分完成' : eventWord(e)}` : `${cut(human(said), 50) || '一项后台工作'}${e.status === 'fail' ? ' · 失败' : ''}`;
    // 补充一句：去掉和标题重复的开头、只剩程序记的英文计数的不写（页面上只写中文）。
    let detail = label ? said.replace(new RegExp(`^${label}\\s*·\\s*`), '') : '';
    detail = detail.replace(/^(?:有更新|没有新的|做完了|跑完了|失败)\s*(?:·\s*|$)/, '');
    if (/^[\x00-\x7f·\s]*$/.test(detail)) detail = '';
    detail = human(detail);
    const evidence = (e.refs || []).map(r => r.file || r.screenshot).find(f => typeof f === 'string' && f.startsWith('runs/')) || null;
    // 读这一次自己的回执，不拿最新源状态解释历史运行。
    const receipt = e.step === 'discover' && /^runs\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.json$/.test(evidence || '') ? safe('读扫描回执', () => read(evidence, {}), {}) : {};
    const sourceResult = Array.isArray(receipt.sources) && receipt.sources.some(s => s && typeof s === 'object') ? sourceReadSummary(receipt.sources) : null;
    const row = { at: e.ts, step: e.step || null, label: label || title, word: partial ? '部分完成' : sourceResult?.unread ? '部分没读成' : label ? eventWord(e) : '', title, detail: sourceResult ? [`新增 ${receipt.added || 0} 条`, sourceResult.text, sourceResult.note].filter(Boolean).join('；') : cut(detail, partial ? 240 : 80), tone: e.status === 'fail' ? 'bad' : partial || sourceResult?.unread ? 'wait' : e.status === 'skip' ? 'mute' : 'ok', href: e.lead_id ? `#lead/${encodeURIComponent(e.lead_id)}` : `#stream?flow=${encodeURIComponent(id)}`, evidence, n: 1 };
    const prev = out.at(-1);
    if (prev && prev.title === row.title && prev.detail === row.detail && prev.href === row.href) { prev.n++; continue; }
    if (out.length >= max) break;
    out.push(row);
  }
  return out;
}

// ── 合起来（GET /api/team/<id> 的 done）────────────────────────────────────────
const MADE = { scout: scoutMade, lens: lensMade, tailor: tailorMade, quill: quillMade, owl: owlMade, patch: patchMade };
function resumeDocs() {
  const ws = loadWorkspace();
  return (ws.docs || []).map(d => safe(`读简历 ${d.id}`, () => loadDoc(d.id), null)).filter(Boolean);
}
// lib/resume-letters.mjs 牵着模型那一串，不在这里静态引入（lib/ask-actions.mjs 也是按需引）：模块载入后在后台引好，
// 引好之前（服务刚起的头一下）当没有信。
let lettersView = null;
import('./resume-letters.mjs').then(m => { lettersView = m.lettersView; }, e => noteSwallowed('member-done.letters', e, { doing: '载入求职信模块', then: '成员页上不列信' }));
function letters() { if (!lettersView) return []; const v = lettersView(); return [...(v.letters || []), ...(v.intros || [])]; }
function usageNow(now) {
  const rows = ledgerSince(dayStart(usageDay(now - 6 * DAY)));
  const today = usageDay(now);
  return { today: totals(rows.filter(r => usageDay(r.at) === today)), week: totals(rows), last_at: rows.at(-1)?.at || null };
}
export function memberDone(id, { now = Date.now(), center = {}, leads = null, outbound = null, referrers = null, mail = null, briefs = null, docs = null, letterRows = null, usage = null, events = null } = {}) {
  const L = leads || cachedLines('state/leads.ndjson').filter(l => !l.superseded);
  const ctx = {
    now, center, leads: L,
    get outbound() { return outbound || cachedLines('state/outbound.ndjson'); },
    get referrers() { return referrers || cachedLines('state/referrers.ndjson'); },
    get mail() { return mail || cachedLines('state/inbox-events.ndjson'); },
    get briefs() { return briefs || safe('读公司调研', loadBriefs, new Map()); },
    get docs() { return docs || safe('读简历', resumeDocs, []); },
    get letters() { return letterRows || safe('读求职信', letters, []); },
    get usage() { return usage || safe('读用量', () => usageNow(now), {}); },
  };
  const made = safe(`拼${id}做出来的`, () => MADE[id]?.(ctx), null) || { facts: '', rows: [], all: null };
  const runs = safe('读运行日志', () => memberRuns(id, { events: events || tailEvents(4000), now }), []);
  return { made: made.rows, ...(made.allRows ? { all_made: made.allRows } : {}), facts: made.facts || '', all: made.all || null, runs, log: `#stream?flow=${id}` };
}
