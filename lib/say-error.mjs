import { eventReason } from './event-reasons.mjs';
// 出错时给人看的那一句（design/desktop-app/方案-任务即对话.md 第六节，T1）：谁、在做什么、没成，原因用一个短语说清。
// 原始报错（claude_code_exit_1、model_http_401、堆栈……）一律不进对话、卡片和回执，只留在运行日志和证据文件里。
// 错误分成哪几类，和 System 的健康账本（lib/system/health.mjs）是同一张表：modelErrorKind。
import fs from 'node:fs';
import { crewName } from './crew.mjs';

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// 模型那边的错 → 哪一类、一个短语。沙盒拦下来的返回 { kind: 'sandbox' }（不是毛病，账本里不记）。
const MODEL_ERRORS = [
  ['sandbox', /sandbox|沙盒|演示模式/i, '演示环境不调用模型'],
  ['no_model', /no_backend|unknown_model_driver|还没(有)?配好|model_not_configured|credentials_missing/i, '还没配好文字模型'],
  ['local_cli', /claude_code_exit_\d+|codex_exit_\d+|ENOENT.*(claude|codex)|spawn (claude|codex)/i, null],
  // 补给（lib/free-model.mjs relayFailure）：模型服务商这一次太久没回 / 出错，不是额度、不是钥匙。排在 key、quota 前面。
  ['timeout', /free_upstream_timeout/, '模型太久没回'],
  ['free_access', /free_relay_access|free_upstream_access/, '补给服务的访问被拦住了'],
  ['request', /free_request_error/, '补给服务没接受这次内容'],
  ['upstream', /free_upstream_error/, '模型服务商那边暂时出错'],
  // 流式回答没读完（lib/model.mjs 长活、lib/chat.mjs 对话那一轮）：流里报错、连接断了、没说完就结束。到点了的 stream_timeout 归下面的超时。
  ['upstream', /\bstream_(?:failed|cut|ended)\b/, '模型的回答中途断了'],
  // Claude（lib/claude-api.mjs）：直连被挡（地区）、代理连不上、模型拒绝回答。排在 key 前面（地区那条不是钥匙坏了）。
  ['region', /claude_api_region/, '这台电脑所在的地区连不上 Anthropic，要开代理'],
  ['network', /claude_api_proxy/, '代理连不上，看看代理软件开着没有'],
  ['refused', /model_refused/, '模型这次拒绝回答这件事'],
  ['free_login', /free_quota_blocked:.*(?:登录|令牌)/, '补给账户需要重新登录'],
  ['key', /(?:model_http|openai_api|claude_api)_401\b|invalid[_ ]?(api[_ ]?)?(key|token)|incorrect.api.key|authentication_error/i, '模型的钥匙失效了'],
  ['model_access', /(?:model_http|openai_api|claude_api)_403\b/, '模型服务拒绝了访问'],
  ['quota', /(?:model_http|openai_api|claude_api)_429\b/, '模型额度用完了，或者被限流了'],
  ['source_limit', /(?:github|api rate limit exceeded).*?(?:403|rate.?limit)|(?:403|429).*?(?:rate.?limit|限流)|\bHTTP\s*429\b/i, '来源网站限制了这次访问频率；等限额恢复，或打开原链接查看'],
  ['source_access', /\b403\b|(?:http|fetch|bot_challenge)_403\b|forbidden|cloudflare|error code: ?10(?:10|20)/i, '来源网站拒绝了自动读取；打开原链接查看，或贴入岗位正文'],
  ['source_missing', /\bHTTP[ _]*404\b|\bhttp_404\b/i, '来源页面已经不存在；打开原链接确认，或提供新的岗位链接'],
  ['source_server', /\bHTTP[ _]*5\d\d\b|\bhttp_5\d\d\b/i, '来源网站暂时出错；稍后再读，或打开原链接查看'],
  ['source_login', /\b401\b|(?:http|fetch)_401\b|unauthori[sz]ed/i, '来源网站需要登录；在浏览器登录后再读，或贴入岗位正文'],
  ['quota', /\b429\b|quota|credits|insufficient|rate.?limit|daily_limit|request_limit|free_quota_blocked|余额|额度/i, '模型额度用完了，或者被限流了'],
  ['missing', /\b404\b|model.{0,20}(not.?found|does not exist|不存在)|unknown[_ ]model/i, '设置里的模型不存在'],
  ['cut', /model_output_cut/, '回答太长，写到一半被截断了'],
  ['timeout', /timeout|timed out|aborted|超时/i, '模型太久没回'],
  ['json', /model_no_json|writer_bad_shape|json|unexpected token|unexpected end|schema|parse/i, '模型回的内容格式不对'],
  ['network', /fetch failed|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|socket|network|TLS/i, '网络不通'],
];
const CLI_NAME = m => (/claude/i.test(m) ? 'Claude Code' : 'Codex');
export function modelErrorKind(error) {
  const e = String(error?.message ?? error ?? '');
  // A source HTTP failure can itself contain 'invalid token'; it still is not a model credential.
  const model = /free_|model_http_|openai_api_|claude_api_|claude_code_|codex_exit_/i.test(e);
  if (!model && /\bHTTP[ _]*[45]\d\d\b|bot_challenge|cloudflare/i.test(e)) {
    const source = MODEL_ERRORS.find(([kind, re]) => kind.startsWith('source_') && re.test(e));
    if (source) return { kind: source[0], text: source[2] };
  }
  for (const [kind, re, text] of MODEL_ERRORS) if ((!model || !kind.startsWith('source_')) && re.test(e)) return { kind, text: text || `模型没调通（本机的 ${CLI_NAME(e)} 没跑起来）` };
  return { kind: 'other', text: '这次没做成' };
}

// 一句人话。who：成员 id（「Writer 这次没写成」）；doing：在做什么，动词短语（「写」「改」「核对」「写怎么准备」）。
// 已经是人话的（中文、没有英文报错码），原样用：各模块自己写给人看的那些原因（「这个岗位还没有 JD 正文」）不翻成笼统的话。
const RAW = /[a-z]+_[a-z0-9_]+|\b(error|exit|http|ECONN|ENOENT|Error:|at \S+\.m?js)/i;
// 中文里夹着报错码（「要先登录（login_required）」「模型这次没成功：xyz_failed」）、表里又认不出的：去掉报错码那几段，剩下的人话留着。
const TOKEN = /\b[A-Za-z]*Error:[^，。；\n]*|\bat \S+\.m?js\S*|[A-Za-z]+_[A-Za-z0-9_]+|\b(?:exit|http|error|ECONN\w*|ENOENT)\b\s*\d*/gi;
const stripRaw = s => { const t = s.replace(TOKEN, '').replace(/[（(][\s:：,，]*[）)]/g, '').replace(/[\s:：,，;；]+$/, '').replace(/\s+/g, ' ').trim(); return /[一-龥]{2,}/.test(t) && !RAW.test(t) ? t : null; };
export function humanError(err, { who = null, doing = '做' } = {}) {
  const raw = String(err?.message ?? err ?? '');
  const head = `${who ? `${crewName(who)} ` : ''}这次没${doing}成`;
  if (raw && !RAW.test(raw) && /[一-龥]/.test(raw)) return { text: cut(`${head}：${raw.replace(/^[^：:]*没[^：:]{0,6}成[：:]/, '')}`, 140), kind: 'said', retry: true };
  const k = modelErrorKind(raw), left = k.kind === 'other' ? stripRaw(raw) : null;
  if (left) return { text: cut(`${head}：${left}`, 140), kind: 'said', retry: true };
  return { text: k.kind === 'other' ? `${head}` : `${head}：${k.text}`, kind: k.kind, retry: !['sandbox', 'no_model', 'key', 'missing'].includes(k.kind) };
}
// 只要那一句。
export const sayError = (err, opts) => humanError(err, opts).text;

// 只要原因那个短语（「模型太久没回」）：拼进现成的句子里用（「这条我没办成：…」「没写成：…」）。
// 已经是人话的原样留着（截短）；原始报错换成表里那一句；什么都没有就写「原因没写下来」。
export function errorReason(err) {
  const raw = String(err?.message ?? err ?? '').trim();
  if (!raw) return '原因没写下来';
  const known = eventReason(raw); if (known !== raw) return cut(known, 120);
  if (!RAW.test(raw) && /[一-龥]/.test(raw)) return cut(raw, 120);
  const k = modelErrorKind(raw);
  if (k.kind !== 'other') return k.text;
  const left = stripRaw(raw);
  return left ? cut(left, 120) : '出了点问题，原因在运行日志里';
}

// 「看原因」：原因、影响、能怎么办三段（方案-任务即对话.md 第六节）。System 的「为什么」（2c）做好以前用这个规则版。
// reason：已经是人话的那句（errorReason 的结果，或者卡上写的原因）；who：哪位成员没做成。
const KIND_OF_TEXT = new Map(MODEL_ERRORS.filter(([, , t]) => t).map(([k, , t]) => [t, k]));
const FIX = {
  request: '缩短这次输入，或分成几部分再试；仍失败时反馈给 OfferCrew 支持。',
  free_access: '稍后再试；持续被拦时，把这次错误反馈给 OfferCrew 支持，由服务方检查访问限制。',
  free_login: '在设置里重新登录 OfferCrew 账户，再试一次。',
  model_access: '在模型服务商处检查该模型的使用权限和地区限制，确认后再试。',
  source_limit: '等网站限额恢复后再读；急用时打开原链接查看或贴入岗位正文。',
  source_access: '打开原链接查看；若网站要求验证，由你在浏览器完成，或直接贴入岗位正文。',
  source_missing: '打开原链接确认是否已撤下，或提供新的岗位链接。',
  source_server: '稍后再读；急用时打开原链接查看，或贴入岗位正文。',
  source_login: '在浏览器登录来源网站后再读，或直接贴入岗位正文。',
  local_cli: '在「设置 → 模型」里给这位成员换一个模型（比如 OfferCrew 补给），或者先把本机的那个程序登录好再试。',
  key: '在「设置 → 模型」里换一把钥匙，或者换一个模型。',
  quota: '等额度恢复，或者在「设置 → 模型」里换一个模型。',
  missing: '在「设置 → 模型」里改成一个还在的模型。',
  timeout: '再试一次；还是这样，就在「设置 → 模型」里换一个快一点的模型。',
  upstream: '稍后再试；补给持续失败时反馈给 OfferCrew 支持，也可以选用已配置的其他模型。',
  json: '再试一次；还是这样，就在「设置 → 模型」里换一个模型。',
  cut: '一次只让它改一部分（比如一段经历），或者在「设置 → 模型」里换一个模型。',
  network: '看看这台电脑能不能上网，好了再试一次。',
  no_model: '在「设置 → 模型」里配一个文字模型。',
  sandbox: '演示环境不调用模型，换到正式的数据目录再试。',
};
// switched_to：已经换到清单里的下一个模型了（lib/system/breaker.mjs，收件箱「你配的 X 钥匙失效了，暂时改用 Y」）：活照常，不说停了。
export function explainFailure(reason, { who = null, switched_to = null } = {}) {
  const text = errorReason(reason), name = who ? `${crewName(who)} ` : '这位成员';
  const kind = KIND_OF_TEXT.get(text) || (modelErrorKind(reason).kind !== 'other' ? modelErrorKind(reason).kind : null) || (/本机的 (Claude Code|Codex) 没跑起来/.test(text) ? 'local_cli' : 'other');
  if (switched_to) return { kind, text: `原因：${text}，已经暂时改用 ${switched_to}。\n影响：活照常在做，用的是 ${switched_to}；换好以前一直用 ${switched_to}。\n能怎么办：${kind === 'key' ? '在设置里换一把钥匙（或换个模型）。' : FIX[kind] || '在设置里把它改好（或换个模型）。'}` };
  const fix = FIX[kind] || '再试一次；还不行，原因在运行日志里，可以让 System 再查一遍。';
  const effect = ['key', 'quota', 'missing', 'no_model', 'local_cli'].includes(kind) ? `${name}要用模型的活都会停在这一步，换好之前别的活照常。` : `只是这一件没做成，别的活照常。`;
  return { kind, text: `原因：${text}。\n影响：${effect}\n能怎么办：${fix}` };
}

// 一次运行没跑成：从它日志的尾巴里取最后一句像出错的话，说成人话；没有就说「中途出错停了」（负责人 10-04：「难道让用户排错吗」，
// 不叫你去看日志）。path 是日志的绝对路径；只读末尾 4KB。
const ERR_LINE = /error|fail|exception|denied|refused|timed? ?out|not found|失败|出错|没成|不能|无法|拒绝|超时/i;
export function logReason(path) {
  let tail = '';
  try { const fd = fs.openSync(path, 'r'); try { const size = fs.fstatSync(fd).size, n = Math.min(size, 4096), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); tail = buf.toString('utf8'); } finally { fs.closeSync(fd); } } catch {} // 兜底：日志读不出就不带最后几行
  const line = tail.split('\n').map(x => x.trim()).filter(x => x && ERR_LINE.test(x)).at(-1);
  const r = line ? errorReason(line) : '';
  return r && !/原因在运行日志里|原因没写下来/.test(r) ? r : '中途出错停了';
}
