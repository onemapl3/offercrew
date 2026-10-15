// 给人看的那几行字（任务卡的标题、要做成什么、做了什么、接下来）：不露原始链接、跟踪参数和成员的内部编号（主会话实测 10-04 第 6、8 条）。
//   「发私信给 https://maimai.cn/profile/detail?dstu=…&trackable_token=…」→「发私信给 Jordan · #10 Fabrikam」
//   「reacher：等你……」→「Reacher：等你……」
// 存着的账、卡、草稿都不改：读出来给人看的时候换。纯函数，不读文件；名字由调用方给（lib/crew.mjs crewName）。
//
//   cleanUrl(url)                 去掉跟踪参数（trackable_token、utm_*、spm……），链接本身照样能打开
//   urlWord(url)                  一个链接给人看的说法：「脉脉上的联系人」「BOSS 直聘页面」「jobs.example.com 页面」
//   personOf(lead)                岗位上写着的那个人（发帖人、招聘的人、内推人）；没有就是空
//   leadWord(lead)                「Jordan · #10 Fabrikam」：人名和岗位，缺哪样就不写哪样
//   plainLinks(text, { label })   文字里的链接换掉：第一处换成 label（给了、而且文字里还没有它），其余换成 urlWord
//   plainIds(text, nameOf)        文字里露出来的成员编号（scout、reacher……）换成显示名
//   plainText(text, o)            上面两样都做
//   cleanLinks(text)              链接留着（模型写的结果里要点得开），只去掉跟踪参数
import { coName } from './vocab.mjs';
const TRACK = /^(?:utm_[a-z_]*|trackable_token|track(?:ing)?(?:_?(?:id|token|code))?|spm(?:_[a-z]+)?|fbclid|gclid|msclkid|igshid|_ga|_gl|mc_[a-z]+|share(?:_?[a-z]+)?|si|xsec_token|sessionid|token)$/i;
const URL_RE = /https?:\/\/[^\s<>"'，。；、！？）)】」]+/gi;
export function cleanUrl(u) {
  const s = String(u ?? '');
  try { const x = new URL(s); for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) x.searchParams.delete(k); return x.toString(); } catch { return s.replace(/([?&])(?:trackable_token|utm_[a-z_]*|spm)=[^&#\s]*/gi, '$1').replace(/[?&]+(?=#|$)/, ''); }
}
const SITES = [[/(^|\.)maimai\.cn$/, '脉脉'], [/(^|\.)zhipin\.com$/, 'BOSS 直聘'], [/(^|\.)linkedin\.com$/, 'LinkedIn'], [/(^|\.)liepin\.com$/, '猎聘'], [/(^|\.)lagou\.com$/, '拉勾'], [/(^|\.)xiaohongshu\.com$/, '小红书'], [/(^|\.)(x|twitter)\.com$/, 'X'], [/(^|\.)mail\.google\.com$/, 'Gmail']];
const PERSON_PATH = /\/(?:profile|in|u|user|people|contact)(?:\/|$)|[?&](?:dstu|uid|user_?id)=/i;
export function urlWord(u) {
  let host = '', path = '';
  try { const x = new URL(String(u)); host = x.hostname.replace(/^www\./, ''); path = x.pathname + x.search; } catch { return '链接'; }
  const site = SITES.find(([re]) => re.test(host))?.[1];
  if (site && PERSON_PATH.test(path)) return `${site}上的联系人`;
  return site ? `${site}页面` : host ? `${host} 页面` : '链接';
}
// 名字短、不是链接、不是邮箱（邮箱照写成邮箱，不当人名）。
const nameish = x => { const s = String(x ?? '').replace(/\s+/g, ' ').trim(); return s && s.length <= 24 && !/https?:|@|\//i.test(s) ? s : ''; };
export const personOf = l => l ? [l.author, l.contact_name, l.recruiter_name, l.recruiter, l.referrer_name, l.inbound?.recruiter].map(nameish).find(Boolean) || '' : '';
export function leadWord(l, { person = true } = {}) {
  if (!l) return '';
  const tag = `${l.number != null ? `#${l.number} ` : ''}${coName(l.company)}`.trim();
  return [person ? personOf(l) : '', tag].filter(Boolean).join(' · ');
}
export function plainLinks(text, { label = '' } = {}) {
  const s = String(text ?? '');
  if (!/https?:\/\//i.test(s)) return s;
  let first = !!label && !s.includes(label);
  return s.replace(URL_RE, u => { if (first) { first = false; return label; } return urlWord(u); })
    .replace(/(\S)\s*·\s*(?=$)/, '$1').replace(/\s{2,}/g, ' ').trim();
}
// 老编号和内部编号都是小写；显示名是大写开头（Radar、Reacher），不会被换两次。只换「挨着中文、冒号」或单独成一句的那种，
// 正文里的英文词（「apply the patch」「camera lens」）前后是英文，不动。
const IDS = ['scout', 'lens', 'tailor', 'quill', 'owl', 'patch', 'radar', 'reacher', 'watcher', 'watch', 'writer', 'judge', 'system', 'executor', 'postman', 'nightwatch', 'listener', 'heartbeat', 'concierge'];
const ID_RE = new RegExp(`(^|[^A-Za-z0-9_./-])(${IDS.join('|')})(?=$|\\s*[：:，,。；、）)]|\\s*[\\u4e00-\\u9fff]|\\s*·)`, 'g');
const ID_AFTER_CJK = new RegExp(`([\\u4e00-\\u9fff（(·]\\s*)(${IDS.join('|')})(?![A-Za-z0-9_-])`, 'g');
export function plainIds(text, nameOf = null) {
  const s = String(text ?? '');
  if (!nameOf || !/[a-z]/.test(s)) return s;
  const name = id => { const n = nameOf(id); return n && n !== id ? n : id; };
  return s.replace(ID_RE, (m, pre, id) => pre + name(id)).replace(ID_AFTER_CJK, (m, pre, id) => pre + name(id));
}
export const plainText = (text, { label = '', nameOf = null } = {}) => plainIds(plainLinks(text, { label }), nameOf);
export const cleanLinks = text => String(text ?? '').replace(URL_RE, cleanUrl);
