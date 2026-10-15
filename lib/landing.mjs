// 「打开申请页」打开的是不是这个岗位（负责人 10-05：「316网易打开申请页 你自己跑一遍看看问题在哪里」）。
//
// 两件事：
//   1. landingUrl：已知会落空的岗位链接，打开前改成能打开的写法。只改链接，不改线索。
//      网易招聘（hr.163.com）：页面按 ?lang=、localStorage、浏览器语言三者之一定中英文；专用 Chrome 是英文环境时
//      走英文站，英文站的详情页、职位列表一律 location.replace('/index.html')（10-05 实测 job-detail.324a5bc2.js /
//      37.f8682400.chunk.js）。带上 lang=zh 就是中文站，详情页正常（实测过）。网站自己的「复制职位链接」也带 lang。
//   2. judgeLanding：打开以后看落在哪（地址、标题、正文开头），认出是这个岗位、跳到了首页、跳到了登录页、
//      岗位下线了、跳到了别的网站、或者认不出。认不出 / 不对时不说「已打开」。
//
// 结果记在 state/landing.json（按线索），收件箱那封信据此说上次落在哪、多给一个「换一个岗位链接」。
import { read, write } from './store.mjs';
import { familyOf } from './accounts.mjs';

const LINK_FIXES = [
  {
    host: /(^|\.)hr\.163\.com$/i, path: /^\/(job-detail|job-list)\.html$/i,
    fix: u => u.searchParams.set('lang', 'zh'), // 英文站（lang=en）的详情页一样跳回首页
  },
];
export function landingUrl(url) {
  let u; try { u = new URL(String(url || '')); } catch { return url; } // 兜底：不像网址就原样交给调用方，它自己报错
  const hit = LINK_FIXES.find(f => f.host.test(u.hostname) && f.path.test(u.pathname));
  if (!hit) return url;
  hit.fix(u);
  return u.toString();
}

const clean = s => String(s || '').toLowerCase().replace(/[\s\-_·•|｜:：,，.。/\\()（）【】\[\]「」"'“”]+/g, '');
const site = h => { const p = String(h || '').toLowerCase().replace(/^www\./, '').split('.'); const two = /^(com|net|org|gov|edu|co)$/.test(p[p.length - 2] || '') && p.length > 2; return p.slice(two ? -3 : -2).join('.'); };
const HOME = /^\/(?:(?:index|home|default)(?:\.s?html?|\.aspx?)?|zh(?:-cn)?|en(?:-us)?|cn|#?)\/?$/i;
const LOGIN = /(^|[./_-])(login|signin|sign-in|sso|passport|oauth|auth|cas|reg)([./_?-]|$)/i;
const CHALLENGE = /人机验证|滑动验证|安全验证|访问验证|验证码|verify you are human|captcha|just a moment|access denied|forbidden/i;
const UNAVAILABLE = /page not found|找不到(该|这个)?页面|internal server error|service unavailable|无法访问此网站/i;
const GONE = /(职位|岗位|该职位|该岗位)[^。\n]{0,8}(已下线|已关闭|已失效|已过期|已结束|已停止|不存在|已被删除|已暂停)|(已下线|已失效|已过期)的(职位|岗位)|no longer (available|accepting|open)|(job|position|posting)\s+(?:(?:has been|is|was)\s+)?(closed|expired|filled|removed|not found)\b|找不到(该|这个)?(职位|岗位)/i;
// 岗位编号：配置里的 source_job_id，或者链接里的那串（id=、postId=、/123456/）。
const jobIdIn = (url, lead) => {
  const own = String(lead?.source_job_id || '').replace(/^[a-z]+:/i, '');
  if (own.length >= 4) return own;
  try { const u = new URL(url); for (const [k, v] of u.searchParams) if (/id$/i.test(k) && /^[\w-]{4,}$/.test(v)) return v; return u.pathname.match(/\/(\d{5,}|[0-9a-f-]{16,})(?:\/|$)/i)?.[1] || null; } catch { return null; } // 兜底：链接解析不了就没有编号可核对
};
// 岗位名：去掉括号里的补充（「AI全栈开发工程师（暴雪）」认「AI全栈开发工程师」也算），太短的不认。
const roleKeys = role => { const r = String(role || ''), a = clean(r), b = clean(r.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')); return [...new Set([a, b])].filter(x => x.length >= 4); };

// page：{ url, title, text }（专用 Chrome 里那一页安静下来以后读的）。没读到（null）就是认不出。
// → { verdict: 'job'|'login'|'home'|'gone'|'other_site'|'unclear', landed }
export function judgeLanding({ requested, page, lead = {} }) {
  if (!page?.url) return { verdict: 'unclear', landed: null };
  let req, got; try { req = new URL(requested); got = new URL(page.url); } catch { return { verdict: 'unclear', landed: page.url }; } // 兜底：地址读不出就认不出
  const blob = clean(`${page.title || ''}\n${String(page.text || '').slice(0, 6000)}`);
  const roleHit = roleKeys(lead.role).some(k => blob.includes(k));
  const id = jobIdIn(requested, lead), idHit = !!id && page.url.includes(id);
  const gone = GONE.test(`${page.title || ''}\n${String(page.text || '').slice(0, 3000)}`);
  const v = verdict => ({ verdict, landed: page.url });
  if (LOGIN.test(`${got.hostname}${got.pathname}`) && !LOGIN.test(`${req.hostname}${req.pathname}`)) return v('login');
  if (page.status >= 400 || page.challenge || CHALLENGE.test(String(page.text || '').slice(0, 3000)) || UNAVAILABLE.test(`${page.title || ''}\n${String(page.text || '').slice(0, 3000)}`)) return v('unclear');
  if (site(got.hostname) !== site(req.hostname)) return v('other_site');
  // 阿里关闭页仍保留原岗位 title 和 positionId；明确的关闭文案不能被这两个旧值覆盖。
  if (gone) return v('gone');
  if (roleHit) return v('job');
  if (HOME.test(got.pathname) && !HOME.test(req.pathname)) return v('home');
  if (idHit) return v('job');
  return v('unclear');
}

// 给人看的网站名：账号清单里的名字（「网易招聘」，去掉括号里的说明）；没有就「<公司>招聘」，再没有就域名。
export function siteName(url, lead = {}) {
  const f = familyOf(url);
  if (f?.label && !f.per_tenant) return f.label.replace(/（.*）$/, '');
  if (lead.company) return `${lead.company}招聘`;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '招聘网站'; } // 兜底：域名都读不出就泛称
}

const FAILED = new Set(['home', 'gone', 'other_site']);
export const landingFailed = r => !!r && FAILED.has(r.verdict);
// 一句话：落在哪。after 是「处理完回来点……」那半句（可以没有）。
export function landingWords(r, { url, lead = {}, after = '', where = '在专用 Chrome 里' } = {}) {
  const name = siteName(url, lead);
  const tail = after ? `；${after}` : '';
  switch (r?.verdict) {
    case 'job': return `已${where}打开这个岗位的页面${tail}`;
    case 'login': return `${name}要先登录：${where}打开的是登录页，登录后回到这个岗位再申请${tail}`;
    case 'home': return `${name}的岗位链接打不开了，跳到了首页`;
    case 'gone': return `${name}上这个岗位打不开了：页面说已下线或不存在`;
    case 'other_site': { let h = ''; try { h = new URL(r.landed).hostname.replace(/^www\./, ''); } catch {} return `岗位链接跳到了别的网站${h ? `（${h}）` : ''}，不是这个岗位`; } // 兜底：落地址读不出就不写域名
    default: return `${where}打开了链接，页面上没认出「${String(lead.role || '这个岗位').slice(0, 40)}」，核对一下是不是这个岗位${tail}`;
  }
}

// 落空时能用的另一条路：这家公司的职位列表（公司清单里的 careers_url，和岗位链接同一个网站才给）。
export function fallbackLinks(url, lead = {}, conf = null) {
  const out = [], list = conf?.careers_url;
  try { if (list && site(new URL(list).hostname) === site(new URL(url).hostname) && list !== url) out.push({ label: `打开${siteName(url, lead)}的职位列表`, url: landingUrl(list) }); } catch {} // 兜底：清单里的地址不像网址就不给
  return out;
}

const PATH = 'state/landing.json';
export const lastLanding = rid => (rid ? read(PATH, {})[rid] || null : null);
export function rememberLanding(rid, entry, now = Date.now()) {
  if (!rid) return;
  const all = read(PATH, {});
  all[rid] = { ...entry, at: new Date(now).toISOString() };
  write(PATH, all);
}
