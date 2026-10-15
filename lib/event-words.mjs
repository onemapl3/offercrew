// 运行记录里的一句话说成中文（10-01：运行日志页的事件原文是英文，「judge-leads · changed · judged 6 · recommended 3…」）。
// lib/workflow.mjs plainMsg 已经把「步骤 · 状态」换成人话；这里再把脚本自己记的计数（judged 6、raw 58……）换掉，
// 认不出的英文计数去掉，不留半句英文。运行日志页（web/app.js）和成员页的日志都用它。
import { errorReason } from './say-error.mjs';
import { plainMsg, STEP } from './workflow.mjs';

const COUNT = {
  raw: '抓到', eligible: '合格', added: '新增', found: '找到', judged: '判断', recommended: '推荐', verify: '待核', excluded: '排除',
  prefiltered: '预筛掉', rows: '行', updated: '更新', updates: '更新', prepared: '备好', messages: '消息', tasks: '待办', drafted: '起草',
  sent: '发出', submitted: '提交', matched: '匹配', calls: '调用', candidates: '候选', posts: '帖子', people: '人', companies: '公司',
  failed: '失败', skipped: '跳过', retried: '重试', recovered: '恢复', demoted: '降级', unconfirmed: '官网待核实', broken: '读不到', quiet: '暂无岗位',
};
const SUFFIX = new Set(['rows', 'people', 'companies', 'messages', 'tasks', 'posts', 'candidates']);
const MODE = { full: '完整周期', light: '轻量周期', host: '本机 AI 一轮' };
// 模型调用链（「offercrew/gpt-6-astra → claude_subscription/sonnet → openai/default」，QA 10-01 #12）不给人看：
// 供应商 / 模型的 id 去掉，剩下的「模型调用」这几个字也不重复写。
// 只认「小写供应商 / 模型」：数字（「第 1/40 个」）、大写开头的（iOS/Android、Java/Go）、路径（后面还有「/」、
// 或者是 .json 这样的文件）都不是模型名，不删（10-02 开箱第 2 轮 N07：「第 1/40 个」被删成「第  个」）。
const MODEL_ID = String.raw`(?<![\w/.-])[a-z][a-z0-9_-]*\/(?![\w.:-]*\/)(?![\w.:-]*\.(?:json|ya?ml|md|tex|m?js|txt|pdf|ndjson|html|csv|log)\b)[a-z0-9][A-Za-z0-9_.:-]*`;
const MODEL_CHAIN = new RegExp(`${MODEL_ID}(?:\\s*(?:→|->|>)\\s*${MODEL_ID})*`, 'g');
export function dropModelIds(text) {
  return String(text || '').replace(MODEL_CHAIN, '').replace(/\b(?:claude-(?:opus|sonnet|haiku|fable)-[\d-]+|gpt-\d[\w.-]*|deepseek-[\w.-]+|jev-latest)\b/g, '')
    .split(' · ').map(x => x.trim()).filter(x => x && !/^[→\->\s]+$/.test(x)).join(' · ').replace(/[\s·:：→]+$/, '');
}
// 设置改了哪份文件（lib/settings.mjs「操作台修改 config/pipeline.json：spend_tier」）：说成哪一类设置，字段名、备份路径不写。
const SETTINGS_FILE = {
  'config/pipeline.json': '流程设置', 'config/model.json': '模型设置', 'config/host.json': '本机 AI 设置', 'config/chat.json': '对话设置',
  'config/roles.json': '成员设置', 'config/human-source-policy.json': '扫描源', 'config/concierge.json': '提醒设置', 'config/companies.yaml': '公司清单',
};
function settingsWords(msg) {
  const t = String(msg || '').trim();
  let m;
  if (/^操作台修改个人事实/.test(t)) return '你改了个人资料';
  if ((m = /^操作台修改\s*(config\/[\w.-]+)?/.exec(t))) return `你改了${SETTINGS_FILE[m[1]] || '设置'}`;
  return null;
}
// 你在指挥台、群里下的命令（「pass 31 职级太高」「10 联系」「投 8」）说成一句话：运行日志拿它当一次运行的标题（QA 第 2 轮 #13）。
function commandWords(msg) {
  const t = String(msg || '').trim();
  let m;
  if ((m = /^操作台指令：(.+?)(?:（|$)/.exec(t))) return commandWords(m[1]) || (/^(?:feedback|action|queue_apply|send|progress|query)(?:$|\b)|^内部代码/.test(m[1]) ? '处理你的指令' : m[1]);
  if ((m = /^pass\s+(\d+)(?:\s+(.+))?$/i.exec(t))) return `不投 #${m[1]}${m[2] ? '：' + m[2] : ''}`;
  if ((m = /^(投|联系|跟进|详情)\s*#?\s*(\d+)$/.exec(t))) return `${m[1]} #${m[2]}`;
  if ((m = /^(\d+)\s*(投|联系|跟进|详情)$/.exec(t))) return `${m[2]} #${m[1]}`;
  return null;
}
// 沙盒挡下的一件事（lib/sandbox.mjs「sandbox: skipped <what>」）说成中文：模型、联网、外部程序各一种说法，
// 括号里的请求编号、文件路径、命令行参数不写（复核 43：「sandbox: skipped 模型调用（resume-check-r1-v3-…）」）。
function sandboxWords(msg) {
  const m = /^sandbox: skipped\s*(.*)$/s.exec(String(msg || '').trim());
  if (!m) return null;
  const what = m[1].replace(/（[^）]*[A-Za-z][^）]*）|\([^)]*\)/g, '').replace(/https?:\/\/([^/\s]+)\S*/g, '$1')
    .replace(/Jev\s*判断/g, '判断模型').replace(/在\s*ego\s*浏览器/g, '在浏览器').replace(/ego\s*浏览器/g, '浏览器').replace(/\s*\b[a-z]+_[A-Za-z0-9_-]+\b/g, '').replace(/\s+/g, ' ').trim();
  if (/模型/.test(what)) return '沙盒里没调模型';
  if (/^(fetch|https?)\b/i.test(what)) { const host = /https?:\/\/([^/\s]+)/.exec(m[1])?.[1]; return `沙盒里没联网${host ? `：${host}` : ''}`; }
  if (/执行器/.test(what)) { const rest = what.replace(/^[^：:]*执行器[^：:]*[：:]?\s*/, ''); return `沙盒里没让这台电脑接手${rest ? '：' + rest : ''}`; }
  if (/[\u4e00-\u9fff]/.test(what)) return `沙盒里没做：${what}`;
  return '沙盒里没运行外部程序';
}
export function eventWords(msg, n = 200, event = null) {
  if (event?.status === 'ok' && /已改用直连完成收信检查/.test(String(msg))) return String(msg).slice(0, n);
  if (event?.status === 'ok' && /^mail-route-/.test(event.kind || '') && /^proxy-/.test(event.from || '') && /^direct-/.test(event.to || '')) return '代理连接没成功，已改用直连连上邮箱';
  if (event?.status === 'ok' && /代理.*(?:连不上|没调通|失败).*改用直连/.test(String(msg))) return '代理连接没成功，已改用直连完成';
  if (/经代理|代理.*(?:连不上|没调通)/.test(String(msg || '')) && /(?:imap|smtp|邮箱|发信|收信)/i.test(String(msg || ''))) {
    if (/改用\s*直连/.test(msg)) msg = `代理没连上，已改用直连${event?.status === 'ok' ? '，邮箱连接已恢复' : event?.status === 'fail' ? '，这次邮箱连接没完成' : '，连接结果未确认'}`;
    else if (/没调通|连不上|失败/.test(msg)) msg = /smtp|发信|发邮件/i.test(msg) ? '发邮件的代理没连上，这次没有发出；检查代理或换节点再试' : '收邮件的代理没连上，这次没有读到新信；检查代理或换节点再试';
  }
  const said = commandWords(msg) || sandboxWords(msg) || settingsWords(msg);
  if (said) return said.length > n ? said.slice(0, n - 1) + '…' : said;
  // Classify at the failing service boundary before plainMsg removes HTTP details.
  msg = String(msg || '').replace(/(?:free_(?:upstream|relay)_[a-z]+|(?:model_http|openai_api|claude_api)_\d{3}|HTTP\s+[45]\d\d|bot_challenge_\d+)[^；;]*/gi, raw => errorReason(raw));
  // 「写 candidate/resume.tex（旧版备份在 candidate/…）」这种带路径的半句整个去掉，不留「写 （旧版备份在 /）」（QA 第 2 轮 #22）。
  msg = String(msg || '').replace(/\bmetrics\b/g, '统计运行情况').replace(/\bfeedback\b/g, '处理反馈').replace(/^历史运行\s*·/, '历史记录 ·').replace(/[，,]\s*写\s+[^\s，,（]*\/[^\s，,（]*(?:（[^）]*）)?/g, '')
    // 链接只留网站名（整条链接会被下面的路径清理切成「https:///123」）；退出码说成人话。
    .replace(/https?:\/\/([^/\s]+)\S*/g, '$1').replace(/（exit 0）/g, '').replace(/（exit -?\d+）/g, '（出错了）')
    // 备份在哪个目录不给人看：「（旧版备份在 candidate/backup-…/）」说成「（旧版已备份）」，「（备份 state/…）」整个去掉（N09：「旧版备份在 /」）。
    .replace(/备份在\s*state-backup-[\w.:-]+/g, '旧记录已备份').replace(/（旧版备份在[^）]*）/g, '（旧版已备份）').replace(/（备份\s[^）]*）/g, '')
    // 「文字模型用 openai/default」：用的是哪个模型 id 不写，说「选好了」（N09：「文字模型用」后面空着）。
    .replace(new RegExp(`(模型)用\\s*${MODEL_ID}`, 'g'), '$1选好了')
    // 周期每一步开始（bin/cycle.mjs「开始 discover」）：步骤名说成在做的事（N09：「开始 discover」「开始 match」）。
    .replace(/127\.0\.0\.1:\d+|localhost:\d+/g, '本机代理').replace(/imap\.[\w.-]+:\d+/g, '收信服务器')
    .replace(/^开始 ([a-z][a-z-]*)$/, (x, k) => `开始${STEP[k] || '下一步'}`);
  let s = dropModelIds(plainMsg(msg, 400));
  if (!s) return '';
  s = s.split(' · ').map(part => {
    const m = /^([a-z_]+)\s+(\d+)$/.exec(part.trim());
    if (m) return !COUNT[m[1]] ? '' : SUFFIX.has(m[1]) ? `${m[2]} ${COUNT[m[1]]}` : `${COUNT[m[1]]} ${m[2]}`;
    if (MODE[part.trim()]) return MODE[part.trim()];
    return part;
  }).filter(Boolean).join(' · ');
  s = s.replace(/开始 (full|light|host) 运行/, (x, k) => `${MODE[k]}开始`).replace(/周期(开始|结束) · (full|light|host)/, (x, a, k) => `${MODE[k]}${a}`);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 同一步同一个结果记了两条（脚本自己 log() 一条，周期给这一步再记一条，前后差几秒）：只留一条，留带用时 / 证据多的那条
// （10-01 #18；QA 第 2 轮 #24：运行日志页也去重）。rows 按时间排好（正序倒序都行）。
export function dedupeEvents(rows, { window = 3 * 60000 } = {}) {
  const out = [], near = new Map(), at = e => Date.parse(e.ts) || 0;
  for (const e of rows) {
    const k = `${e.job_id || e.action_id || e.run_id || ''}|${e.step}|${e.status}|${e.lead_id || ''}`, t = at(e), same = (near.get(k) || []).filter(o => Math.abs(at(out[o]) - t) <= window);
    near.set(k, same);
    // 开始记录代表一次尝试；旧 run-* 是进程 id，不能据此合并几分钟内的重试。
    const i = same.find(o => (e.status !== 'start' || out[o].ts === e.ts) && (out[o].msg === e.msg || (String(e.msg || '').split(' · ')[1] != null && String(out[o].msg || '').split(' · ')[1] === String(e.msg || '').split(' · ')[1])));
    if (i == null) { same.push(out.length); out.push(e); continue; }
    const twin = out[i];
    if ((e.duration_ms && !twin.duration_ms) || (e.refs || []).length > (twin.refs || []).length) out[i] = { ...e, refs: [...(e.refs || []), ...(twin.refs || [])] };
  }
  return out;
}
