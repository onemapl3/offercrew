// 对话的标题（负责人 09-30：「对话标题默认都是网址，应该是这个对话的第一句话的大意才对」）。
// 会话文件（state/chat/<id>.json）上两样：title 和 title_by——
//   rule   按下面的规则从第一句话取的（第一轮就写上；读的时候还会重算，收录对上岗位后换成公司和职位）
//   model  第一轮回复以后模型概括的（lib/talk.mjs nameSession），不超过 14 个字；读的时候不动
//   you    你自己改的（现在还没有改标题的地方，留着这个值：有了也不会被覆盖）
//   没有   老会话：标题是网址的、就是截的第一句话的，读的时候按规则改写；别的照旧
// 规则（没有模型或模型失败时）：去掉网址、@成员，取剩下文字的第一个分句，截到 16 个字；#编号留着（10-03：「把 #6 的求职信改一下」
//   去掉编号就成了「把的求职信改一下」）。只有 @ 和 #、没有一句话的，还是「新对话」。
// 只贴了一个链接的：这段对话开的收录卡对上岗位了就是「收录 <公司> · <职位>」，还没对上是「收录一个链接」。
// 手机和电脑都读 GET /api/chat 的 title（lib/chat.mjs listSessions），面板标题行读 /api/talk 的 session.title：同一个标题。
import { coName, leadByUrl } from './vocab.mjs';
import { lines } from './store.mjs';
import { cachedLines } from './state-cache.mjs';

export const RULE_MAX = 16, MODEL_MAX = 14;
export const NEW_TITLE = '新对话', LINK_TITLE = '收录一个链接';
const URL_G = /(?:https?:\/\/|www\.)[^\s<>"'）)]+/gi;
const HAS_URL = /(?:https?:\/\/|www\.)\S/i;
const AT_G = /@[A-Za-z][\w-]*/g;
const NUM_G = /#\s?\d+/g;
// 链接前后常带的一两个字（「收一下 https://…」）：只剩这些时也算只贴了链接。
const LINK_VERB = /^(?:帮我|请)?(?:收|收录|收一下|收下|看看|看下|看一下|读一下|读读|存一下|记一下)?(?:这个|这条|这个岗位)?$/;
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

export const hasUrl = s => HAS_URL.test(String(s || ''));
// 去掉网址、@成员、#编号后的文字（空白压成一个空格，去掉两头的标点）。keepNumbers：#编号留着（写成「#6」）。
export function stripRefs(text, { keepNumbers = false } = {}) {
  return String(text ?? '').replace(URL_G, ' ').replace(AT_G, ' ').replace(NUM_G, m => keepNumbers ? ` #${m.replace(/\D/g, '')} ` : ' ').replace(/\s+/g, ' ').replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '')
    .replace(/^[\s，。、；;:：,.!！?？~～\-—·]+/, '').replace(/[\s，。、；;:：,.~～\-—·]+$/, '').trim();
}
// 只贴了一个链接（前后最多一两个「收一下」这样的字）。
export const linkOnly = text => hasUrl(text) && LINK_VERB.test(stripRefs(text).replace(/[\s!！?？]+/g, ''));
// 规则标题。lead：这段对话的收录已经对上的岗位 { company, role }（没有给 null）。
export function ruleTitle(text, { lead = null } = {}) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return NEW_TITLE;
  if (linkOnly(raw)) {
    const co = coName(lead?.company), role = String(lead?.role || '').trim();
    return co ? clip(`收录 ${co}${role ? ` · ${role}` : ''}`, 40) : LINK_TITLE;
  }
  if (!stripRefs(raw)) return NEW_TITLE; // 只有 @ 和 # 的一句
  const rest = stripRefs(raw, { keepNumbers: true });
  // 第一个分句：句号、问号、叹号、分号、逗号、换行处断开；太短（一两个字，比如「好，」）就接着取下一句。
  const parts = rest.split(/[。！？!?；;，,\n]+/).map(x => x.trim()).filter(Boolean);
  let head = parts[0] || rest;
  for (let i = 1; head.length < 3 && i < parts.length; i++) head = `${head}，${parts[i]}`;
  return clip(head, RULE_MAX);
}
// 模型给的标题：取第一行，去掉引号书名号和「标题：」，去掉网址、@、#；空的、太长的（超过 24 个字，多半没照着做）不要。
export function cleanModelTitle(text) {
  let t = String(text ?? '').split('\n').map(x => x.trim()).find(Boolean) || '';
  t = t.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, '').replace(/[。.!！]+$/, '').replace(/^["'“”‘’「」『』《》【】\s]+|["'“”‘’「」『』《》【】\s]+$/g, '');
  t = stripRefs(t).replace(/[#@]/g, '').replace(/[。.!！]+$/, '').trim();
  if (!t || t.length > 24 || hasUrl(t)) return null;
  return t.slice(0, MODEL_MAX);
}
// 给模型的话：只要一个标题。
export const TITLE_SYSTEM = `给一段求职对话起标题。用户会给你这段对话的第一句话。用不超过 ${MODEL_MAX} 个字的简体中文概括这句话的意思（公司名、职位名可以保留原文）。不要网址，不要 @ 和 #，不要引号，不要句号。只输出标题本身。`;
export const titlePrompt = text => [{ role: 'user', content: String(text ?? '').slice(0, 600) }];

// ── 读的时候：这段对话该显示的标题 ──────────────────────────────────────────
const firstUser = s => String((s?.messages || []).find(m => m.role === 'user')?.content || '').replace(/\s+/g, ' ').trim();
// 这段对话开的收录卡（或目标）已经对上的岗位：卡上记的那一条，没记就按链接在库里找。
export function intakeLead(s, { cards = null, leads = null } = {}) {
  const ids = new Set((s?.messages || []).flatMap(m => [m.card, m.goal]).filter(Boolean));
  if (!ids.size) return null;
  const all = cards || readCardsLite();
  const mine = all.filter(c => ids.has(c.id) && (c.kind === 'intake' || (c.kind === 'goal' && (c.route || []).some(r => r.kind === 'intake'))));
  for (const c of mine) {
    const l = (c.leads || [])[0];
    if (l && coName(l.company)) return { company: coName(l.company), role: l.role || '' };
  }
  const urls = mine.map(c => c.url).filter(Boolean);
  if (!urls.length) return null;
  const pool = leads || cachedLines('state/leads.ndjson');
  const hit = urls.map(u => leadByUrl(pool, u)).find(Boolean); // 链接找线索只有一种写法（lib/vocab.mjs）
  return hit && coName(hit.company) ? { company: coName(hit.company), role: hit.role || '' } : null;
}
// 显示的标题：模型起的、你改的原样；规则取的和标题是网址的老会话按规则重算（收录对上了换成公司和职位）。
export function shownTitle(s, ctx = {}) {
  const t = String(s?.title || '');
  if (s?.title_by === 'model' || s?.title_by === 'you') return t || NEW_TITLE;
  const first = firstUser(s);
  if (!first) return t || NEW_TITLE;
  // 老会话（没有 title_by）的标题都是当时截的第一句话（那时还没有改标题的地方）：和第一句话对得上的也按规则重取。
  const legacyCut = !s?.title_by && t.replace(/…$/, '').length >= 4 && first.startsWith(t.replace(/…$/, ''));
  if (s?.title_by === 'rule' || hasUrl(t) || !t || t === NEW_TITLE || legacyCut) return ruleTitle(first, { lead: linkOnly(first) ? intakeLead(s, ctx) : null });
  return t;
}
// 任务板的卡（state/tasks.ndjson，同一个 id 取最后一版）。这里不引 lib/tasks.mjs，免得和 lib/chat.mjs 绕成一圈。
export function readCardsLite() {
  const m = new Map();
  for (const c of lines('state/tasks.ndjson')) if (c?.id) m.set(c.id, c);
  return [...m.values()];
}
