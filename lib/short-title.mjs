// 短标题（10-01 负责人开箱测试 #21、第六节「任务」「团队」）：一件事给人看的那一行，二十来个字，一句人话。
//
// 执行器写的全文（「以 Writer 身份读取……；若岗位不明确……」「discover-human-browser · degraded（24 小时内 1 次）：。用户补充：……」）
// 放进详情；卡片、成员卡、横幅上只放这一行。新的「等你」由执行器自己写（`node bin/job.mjs need … --title "…"`，存在
// need.title）；没写的旧数据用这里的纯函数推一个：取第一句，认得的内部代号换成中文，认不得的代号、路径、编号去掉。
//
//   shortTitle(text, { max = 20, ask = false })   任意一段话 → 一行。ask：优先取在问你 / 请你做事的那一句。
//   needTitle(need, { account })                  一条「等你」（lib/needs.mjs 的结构）→ 一行：有 title 用 title，
//                                                 没有按种类推（登录 X · 补 A、B · A 还是 B？· 问题的那一句）。
//   plainCodes(text)                              只做代号替换和清理，不截短（给详情里的全文用）。
//   textWidth(text)                               汉字算 1，英文、数字、空格算 0.5。
// 纯函数，不读文件；页面（web/）和服务端都能用。
const CODE_WORDS = {
  'discover-human-browser': '浏览器扫真人帖', 'discover-human': '扫真人帖', discover: '扫官方源', 'auto-apply': '填申请表', 'judge-leads': '判断新岗位',
  match: '判断岗位', evaluate: '评估岗位', 'tailor-resumes': '定制简历', 'round-tailor': '定制简历', reach: '起草首联', 'send-approved': '发出已批准的', 'send-dm': '发私信',
  'find-contacts': '找联系人', 'find-referrers': '找内推人', 'prepare-applications': '准备投递材料', 'prepare-interviews': '面试资料', inbox: '看邮箱',
  metrics: '更新指标', 'run-now': '即时执行',
  'add-lead': '收录岗位', 'resume-import': '导入简历', 'company-brief': '公司调研', 'login-watch': '检查登录', 'boss-inbox': '看 BOSS 消息', cycle: '定时周期',
  system_fix: '修复', system_auto_repair: '自动修复', queue_auto_apply: '投递', company_brief: '公司调研', role_prep: '怎么准备', user_request: '你交代的事',
};
const STATUS_WORDS = { degraded: '出了问题', failed: '失败了', fail: '失败了', error: '出错了', timeout: '超时了', stalled: '停住了', blocked: '卡住了', stuck: '卡住了', warn: '有警告', ok: '正常' };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 带 - / _ 的代号见了就换；单个英文词（match、inbox……）只在「代号 · 状态」的写法里换，免得把正文里的英文词换掉。
const alt = keys => keys.sort((a, b) => b.length - a.length).map(esc).join('|'), ST = alt(Object.keys(STATUS_WORDS));
const COMPOUND = new RegExp(`(?<![A-Za-z0-9_./-])(${alt(Object.keys(CODE_WORDS).filter(k => /[-_]/.test(k)))})(?:\\s*·\\s*(${ST}))?(?![A-Za-z0-9_./-])`, 'g');
const SINGLE = new RegExp(`(?<![A-Za-z0-9_./-])(${alt(Object.keys(CODE_WORDS).filter(k => !/[-_]/.test(k)))})\\s*·\\s*(${ST})(?![A-Za-z0-9_./-])`, 'g');

export const textWidth = s => [...String(s ?? '')].reduce((n, ch) => n + (/[\u0000-ÿ]/.test(ch) ? 0.5 : 1), 0);
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// 代号换成中文、认不得的代号去掉、自动修复那句附注和「：。」这种接缝去掉。不截短。
export function plainCodes(text) {
  let s = clean(text);
  if (!s) return '';
  // 自动修复排入时附的那句（lib/command-center.mjs autoRepair）：来源另有标记，不进标题。
  s = s.replace(/[。.]?\s*用户补充[:：]\s*（[^（）]{0,24}自动修复：无人点击[^（）]*）/g, '').replace(/（[^（）]{0,24}自动修复：无人点击[^（）]*）/g, '');
  s = s.replace(/[。.]?\s*用户补充[:：]\s*$/, '');
  const word = (_, code, st) => `${CODE_WORDS[code]}${st ? STATUS_WORDS[st] : ''}`;
  s = s.replace(COMPOUND, word).replace(SINGLE, word);
  // 路径、文件名、任务 id、认不得的 snake / kebab 代号（全小写才算，Full-Stack、GPT-5 这类保留）。
  s = s.replace(/(?<![A-Za-z0-9])(?:runs|state|config|bin|lib|private|web|docs|tests)\/[^\s，。；、）)]*/g, '')
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9_-]+\.(?:mjs|js|json|ndjson|md|yaml|yml|log|png|patch|diff|txt|html)(?![A-Za-z0-9])/g, '')
    .replace(/(?<![A-Za-z0-9])(?=[0-9a-f]*\d)[0-9a-f]{12,}(?![A-Za-z0-9])/g, '')
    .replace(/(?<![A-Za-z0-9./-])[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+(?![A-Za-z0-9./-])/g, '');
  // 「以 Writer 身份」「作为 System」这种写给执行器的开头。
  s = s.replace(/^(?:以|作为)\s*[A-Za-z一-龥]{1,12}\s*(?:身份|角色)[，,：:\s]*/, '');
  // 接缝：代号去掉后剩下的「：。」「（）」、重复的标点和空格。
  s = s.replace(/（\s*）|\(\s*\)/g, '').replace(/\s*·\s*(?=[。；，,：:）)]|$)/g, '').replace(/^[\s·:：，,。；;、]+/, '')
    .replace(/[:：]\s*[。；;，,]+/g, '：').replace(/([。；;，,、])\s*[。；;，,、]+/g, '$1').replace(/\s+([，。；、,）)])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return s.replace(/[\s·:：，,；;、]+$/, '');
}

const ASKING = /请|要你|需要你|麻烦你|你来|是否|要不要|还是|吗|？|\?/;
const cutWidth = (s, max) => { let out = '', w = 0; for (const ch of s) { const cw = textWidth(ch); if (w + cw > max) break; out += ch; w += cw; } return out; };
// 超长的一句：先按分句（，、：）从头攒，攒不下第一个分句时在词边界硬截，加「…」。
function fit(sentence, max) {
  if (textWidth(sentence) <= max) return sentence;
  const parts = sentence.split(/(?<=[，,、：])|(?<=:)(?=\s)/);
  let out = '';
  for (const p of parts) { if (textWidth(out + p) > max) break; out += p; }
  out = out.replace(/[，,、：:\s]+$/, '');
  if (out && textWidth(out) >= max / 3) return out;
  let head = cutWidth(sentence, max - 0.5);
  // 不把一个英文词从中间切开。
  const m = head.match(/^(.*[^A-Za-z0-9])[A-Za-z0-9]+$/);
  if (m && /[A-Za-z0-9]/.test(sentence[head.length] || '') && textWidth(m[1]) >= max / 2) head = m[1];
  return head.replace(/[\s，,、：:（(·]+$/, '') + '…';
}

export function shortTitle(text, { max = 20, ask = false } = {}) {
  const s = plainCodes(text);
  if (!s) return '';
  // 句子：按句号、分号、问叹号、换行断开；括号里的补充（「（Contoso offer 岗位名称及完整JD）」）不单独成句。
  const sentences = s.split(/(?<=[。！？!?；;])\s*|\n+/).map(x => x.replace(/[。；;]+$/, '').trim()).filter(x => x && !/^（[^（）]*）$/.test(x));
  let one = (ask && (sentences.find(x => /(?:^|[，,：:])\s*(?:请(?:你|提供|补充|确认|选择|核对|登录|完成)|需要你|麻烦你)/.test(x)) || sentences.find(x => ASKING.test(x)))) || sentences[0] || s;
  // 旧等待记录常把已做过的事和请求写在同一句里：短标题应保留「请提供…」，而非截断前面的进度。
  if (ask && textWidth(one) > max) one = one.match(/(?:请你|请|需要你|麻烦你)[^。；;]*/)?.[0] || one;
  if (ask) one = one.replace(/^(?:[^，,]{0,12}后[，,]?\s*)?(?:请你|请|麻烦你|麻烦)\s*/, '');
  // 句末的括号是补充（「（24 小时内 1 次）」「（Contoso offer 岗位名称及完整JD）」），详情里有，标题里不要。
  one = one.replace(/\s*(?:（[^（）]*）|\([^()]*\))\s*$/, '').trim() || one;
  return fit(one, max);
}

// 一条「等你」的短标题。account(key) → 账号给人看的名字（lib/needs.mjs 传 config/accounts.json 的名字；不传就用 key）。
export function needTitle(need = {}, { account = null, max = 20 } = {}) {
  const own = clean(need.title);
  if (own) return fit(own, Math.max(max, 24));
  const q = need.question || need.note || '';
  if (need.kind === 'login') return `登录 ${account ? account(need.account) : need.account || '账号'}`;
  if (need.kind === 'info') {
    const labels = (need.fields || []).map(f => clean(f.label)).filter(Boolean);
    const t = labels.length ? `补${/^[A-Za-z0-9]/.test(labels[0]) ? ' ' : ''}${labels.slice(0, 3).join('、')}${labels.length > 3 ? ` 等 ${labels.length} 项` : ''}` : '';
    if (t && textWidth(t) <= max) return t;
  }
  if (need.kind === 'decide' && (need.options || []).length >= 2) {
    const o = need.options.map(x => clean(typeof x === 'string' ? x : x?.label));
    const t = o.length === 2 ? `${o[0]}，还是${o[1]}？` : `选一个：${o.join(' / ')}`;
    if (textWidth(t) <= max + 2) return t;
  }
  return shortTitle(q, { max, ask: true }) || (need.kind === 'approve' ? '看一眼再批准' : need.kind === 'decide' ? '要你拍板' : '要你补信息');
}
