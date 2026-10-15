import { parsePostedAt } from './human-browser.mjs';

// The byline belongs to the author, not necessarily the hiring company. New
// pages put it after the date's dot; older pages wrap it onto the next line.
// Never consume the first paragraph as a company. Search-card dates still win.
export function parseMaimaiDetail(innerText, author) {
  const empty = { company: '', body: '', posted_place: '' };
  const lines = String(innerText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const name = String(author || '').trim();
  const start = name ? lines.findIndex(line => line === name) : -1;
  const header = /^(?:\d+\s*(?:分钟|小时|天)前|\d{2}-\d{2}|刚刚|今天|昨天|前天)[^·]*·\s*(.*)$/.exec(lines[start + 1] || '');
  if (start < 0 || !header) return empty;
  let bodyStart = start + 2, affiliation = header[1].trim();
  // A missing/wrapped byline is ambiguous. Only skip a short affiliation-shaped
  // line; a hiring sentence stays in the body even if it contains a company.
  const wrapped = lines[bodyStart] || '';
  if (!affiliation && wrapped.length <= 80 && /公司|集团|科技|工作室|实验室|^前\s*\S+|猎头|工程师|顾问|\b(?:HR|recruiter)\b/i.test(wrapped)
    && !/招聘|内推|招人|职责|要求|[。！!？?：:]/.test(wrapped)) {
    affiliation = wrapped; bodyStart++;
  }
  const end = lines.findIndex((line, i) => i >= bodyStart && /^发布于\s+\S/.test(line));
  if (end <= bodyStart) return empty;
  return { company: '', body: lines.slice(bodyStart, end).join('\n'), posted_place: lines[end].replace(/^发布于\s+/, ''), ...(affiliation ? { author_affiliation: affiliation } : {}) };
}

// The age line of a LinkedIn card. Cards print it in several shapes: alone
// ("2w"), with a trailing bullet ("5h •"), after other header text
// ("Recruiter • 3d", "Edited • 1d"), spelled out ("3 days ago") or in Chinese
// ("3 天", "2周前"). Only the header is searched (lines before `limit`) and a
// bullet segment must be the whole age, so "• 3 years" inside the body or
// "2 weeks of work" is never a date. Self-contained: it runs in the page.
export function linkedinDateLine(lines, limit = 12) {
  const age = /^(?:\d+\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)(?:\s+ago)?|\d+\s*(?:分钟|小时|天|周|个月|月|年)前?|just now|刚刚)$/i;
  for (let index = 0; index < Math.min(lines.length, limit); index++) {
    const label = String(lines[index]).split(/[•·]/).map(part => part.trim()).find(part => age.test(part));
    if (label) return { index, label };
  }
  return null;
}

// 领英搜索页现在是什么样（在页面里跑）。帖子卡片认三种写法：新版 [role=listitem][componentkey^=update-card-focus]、
// 旧版 div.feed-shared-update-v2 / [data-urn^=urn:li:activity]（同一个账号也会被分到旧版），或者带「Open control menu for post」
// 按钮的那一格。都没有时：登录页（地址、密码框）算登录过期；「没有结果」算读到了、0 条；
// 别的一律 linkedin_page_unrecognized，并记下页面结构（地址路径、标题、几种元素各有多少、开头几行短字），下一位照着修，不靠猜。
// 10-10：以前只等新版卡片，旧版页面一律等满 15 秒报 Timeout。
export const LINKEDIN_PAGE_STATE = String(function () {
  var CARD = '[role="listitem"][componentkey^="update-card-focus"], div.feed-shared-update-v2, [data-urn^="urn:li:activity"]';
  var MENU = 'button[aria-label^="Open control menu for post"], [role="listitem"] [data-testid="expandable-text-box"]';
  var cards = document.querySelectorAll(CARD).length, menus = document.querySelectorAll(MENU).length;
  if (cards || menus) return { status: null, cards: cards, menus: menus };
  var path = location.pathname, text = document.body ? document.body.innerText : '';
  if (/^\/(?:uas\/)?login|^\/authwall|^\/signup|^\/checkpoint\/lg/.test(path) || document.querySelector('input[name="session_password"], input#password')) return { status: 'session_expired' };
  // 没登录的人看到的那一页（不跳登录页、只给「Join LinkedIn / Sign in」）是登录过期，不是「0 条」。
  if (/Join LinkedIn|Join now|Sign in to|加入领英|立即加入/.test(text)) return { status: 'session_expired' };
  if (/No results found|No results|没有找到|未找到|找不到结果/.test(text)) return { status: null, cards: 0, empty: true };
  var keys = {};
  Array.prototype.forEach.call(document.querySelectorAll('[componentkey]'), function (el) { var k = String(el.getAttribute('componentkey')).replace(/[0-9a-f]{6,}|\d+/gi, '#').slice(0, 40); keys[k] = (keys[k] || 0) + 1; });
  var top = Object.keys(keys).sort(function (a, b) { return keys[b] - keys[a]; }).slice(0, 8).map(function (k) { return k + ' ×' + keys[k]; });
  var heads = text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && l.length <= 40; }).slice(0, 8);
  return { status: 'linkedin_page_unrecognized', shape: { path: path, title: document.title.slice(0, 80), text_len: text.length, listitems: document.querySelectorAll('[role="listitem"]').length,
    componentkeys: top, urns: document.querySelectorAll('[data-urn]').length, main: !!document.querySelector('main'), visibility: document.visibilityState, heads: heads } };
});

// Page-side extractors. They read the rendered DOM only; nothing is inferred
// here, and an empty result is reported as an empty result.
export const EXTRACTORS = {
  linkedin: `() => {
    // 先认新版卡片；没有再认旧版（data-urn）；再没有，认带「Open control menu for post」按钮或帖子正文框的那一格（往上找到列表项）。
    const outer = all => all.filter(el => !all.some(o => o !== el && o.contains(el)));
    const up = sel => [...new Set([...document.querySelectorAll(sel)].map(b => b.closest('[role="listitem"], li, article')).filter(Boolean))];
    const modern = [...document.querySelectorAll('[role="listitem"][componentkey^="update-card-focus"]')];
    const legacy = modern.length ? [] : outer([...document.querySelectorAll('div.feed-shared-update-v2, [data-urn^="urn:li:activity"]')]);
    const rows = modern.length ? modern : legacy.length ? legacy : outer(up('button[aria-label^="Open control menu for post"], [data-testid="expandable-text-box"]'));
    return rows.map((el, i) => {
      const t = selector => (el.querySelector(selector)?.innerText || '').trim();
      const links = [...el.querySelectorAll('a')];
      const profile = links.find(a => /linkedin\\.com\\/(?:in|company)\\//.test(a.href) && a.innerText.trim());
      const link = links.find(a => /\\/(?:feed\\/update|posts)\\//.test(a.href));
      const menu = el.querySelector('button[aria-label^="Open control menu for post by"]');
      const author = t('.update-components-actor__title') || (menu?.getAttribute('aria-label') || '').replace(/^Open control menu for post by /, '') || profile?.innerText.split('\\n')[0] || '';
      // Zero-width and direction marks would keep an age line from matching.
      const lines = el.innerText.split(/\\n/).map(s => s.replace(/[\\u200b-\\u200f\\u2060\\ufeff]/g, '').trim()).filter(Boolean);
      const boxed = t('.update-components-text') || t('[data-testid="expandable-text-box"]');
      // The header ends where the post text starts (a Follow button may sit
      // before or after the age, so it is no boundary).
      const firstBody = boxed ? lines.indexOf(boxed.split('\\n')[0].trim()) : -1;
      const header = firstBody >= 0 ? firstBody : 12;
      const dated = (${linkedinDateLine.toString()})(lines, header);
      const dateIndex = dated ? dated.index : -1;
      const start = lines.findIndex((s, n) => n > dateIndex && /^(Follow|Following)$/.test(s));
      const end = lines.findIndex((s, n) => n > start && /^(Show translation|Like|Comment|Repost)$/.test(s));
      const body = boxed || (start >= 0 ? lines.slice(start + 1, end < 0 ? undefined : end).join('\\n') : '');
      // An undated card keeps its short header lines that carry a digit, so the
      // next run's evidence shows which shape the age took. Stored locally only.
      const date_probe = dated ? undefined : lines.slice(0, header).filter(s => /\\d/.test(s) && s.length <= 40).slice(0, 4);
      // 旧版卡片的 data-urn 就是帖子编号：原帖链接直接由它拼出来（/feed/update/urn:li:activity:…/）。
      const urn = /^urn:li:(?:activity|share|ugcPost):\\d+$/.test(el.getAttribute('data-urn') || '') ? el.getAttribute('data-urn') : null;
      const fromUrn = urn ? 'https://www.linkedin.com/feed/update/' + urn + '/' : null;
      return {id:el.getAttribute('data-urn') || el.getAttribute('componentkey') || String(i),author,author_title:t('.update-components-actor__description') || (dateIndex > 2 ? lines[dateIndex-1] : ''),author_url:profile?.href || null,title:body.split('\\n')[0].slice(0,160),body,posted_at:el.querySelector('time')?.getAttribute('datetime') || null,posted_label:t('.update-components-actor__sub-description') || (dated ? dated.label : ''),date_probe,url:link?.href || el.getAttribute('data-radar-post-url') || fromUrn,permalink_missing:!link&&!el.getAttribute('data-radar-post-url')&&!fromUrn};
    }).filter(p => p.author && p.body);
  }`,
  boss: `() => [...document.querySelectorAll('li.job-card-box, li.job-card-wrapper')].map((el, i) => {
    const t = s => (el.querySelector(s)?.innerText || '').replace(/\\s+/g, ' ').trim();
    const a = el.querySelector('a.job-card-left, a[href*="/job_detail/"]');
    return {
      id: (a && a.href.match(/job_detail\\/([^.?]+)/) || [])[1] || String(i),
      author: t('.info-public, .boss-name, .job-card-footer .boss-info'),
      author_title: t('.boss-tag, .info-public em'),
      author_url: a ? a.href : null,
      company: t('.company-name, .boss-info .company-name'),
      role: t('.job-name, .job-title .job-name'),
      title: t('.job-name'),
      body: [t('.job-name'), t('.company-name'), t('.job-area, .company-location'), t('.tag-list, .job-card-footer .tag-list'), t('.info-desc')].filter(Boolean).join('\\n'),
      posted_at: el.querySelector('time')?.getAttribute('datetime') || null,
      posted_label: t('.job-time, .time, .job-card-footer .time'),
      observed_at: new Date().toISOString(),
      url: a ? a.href : location.href,
    };
  }).filter(p => p.role)`,
  maimai: `(${readMaimaiRows.toString()})`,
  xiaohongshu: `() => [...document.querySelectorAll('section.note-item')].map((el, i) => {
    const t = s => (el.querySelector(s)?.innerText || '').replace(/\\s+/g, ' ').trim();
    // The hidden /explore link omits the access token and can land on a 404.
    // Preserve the actual signed link shown on the card, including its route.
    const a = el.querySelector('a[href*="/search_result/"][href*="xsec_token="], a[href*="/explore/"][href*="xsec_token="]')
      || el.querySelector('a[href*="/explore/"], a[href*="/search_result/"]');
    return { id: (a && new URL(a.href).pathname.split('/').filter(Boolean).pop()) || String(i), author: t('.author .name, .user-name'), author_title: null, author_url: el.querySelector('a[href*="/user/profile/"]')?.href || null,
      title: t('.title'), body: [t('.title'), t('.desc')].filter(Boolean).join('\\n'), posted_at: null,
      posted_label: t('.time, span.time, .date, .footer .time'), url: a ? a.href : location.href };
  }).filter(p => p.author && p.body)`,
};

// Detail pages can contain both a visible date and machine-readable metadata.
// Prefer the post's scoped date; take only the first element per selector so
// comment dates cannot supply additional candidates.
export const XIAOHONGSHU_DETAIL_DATES = `() => [
  '.note-content .date', '.bottom-container .date',
  'meta[property="og:updated_time"]', 'meta[name="og:release_date"]'
].map(selector => {
  const el = document.querySelector(selector);
  return (el?.getAttribute('content') || el?.innerText || '').trim();
}).filter(Boolean)`;

// Read only the author's note. Comments, sidebars and recommendation cards
// must never become the job description or supply a newer publication date.
export const XIAOHONGSHU_DETAIL = `() => {
  const note = document.querySelector('.note-content');
  const title = (note?.querySelector('#detail-title')?.innerText || '').trim();
  const description = (note?.querySelector('#detail-desc')?.innerText || '').trim();
  const chrome = document.body.cloneNode(true);
  chrome.querySelectorAll('.note-content, .comments-container, section.note-item, script, style').forEach(el => el.remove());
  const text = chrome.innerText || chrome.textContent || '';
  const status = /安全验证|滑动.*验证|拖动滑块|完成验证/.test(text) ? 'captcha'
    : /^(?:登录|手机号登录|扫码登录|登录后查看更多|马上登录即可)$/m.test(text) ? 'session_expired' : null;
  return { title, body: description ? [title, description].filter(Boolean).join('\\n') : '',
    labels: (${XIAOHONGSHU_DETAIL_DATES})(), status };
}`;


// Browser-only reads and intercepted navigation. Clicking these two known
// targets opens a post/card, never a contact action. Restore even on failure.
async function readMaimaiRows({ offset = 0, limit = Infinity } = {}) {
  const rows = [...document.querySelectorAll('li.list-group-item.clearfix, li.list-group-item.cursor-pointer')].slice(offset, offset + limit);
  if (!rows.length) return [];
  const anonymous = location.pathname === '/search/gossips';
  const originalOpen = window.open;
  let captured = [];
  window.open = u => { captured.push(String(u)); return null; };
  try {
    const result = [];
    for (const el of rows) {
      const t = selector => (el.querySelector(selector)?.textContent || '').trim();
      const capture = async node => {
        captured = [];
        node?.click();
        // Real-name cards throttle rapid opens and may resolve a profile
        // asynchronously. Keep the intercept alive across that event turn.
        await new Promise(resolve => setTimeout(resolve, 1100));
        return captured.slice();
      };
      const body = el.querySelector(anonymous ? '.m-b-5.font-15' : '.m-b-5 p');
      const post_urls = await capture(body);
      const profile_urls = anonymous ? [] : await capture(el.querySelector('.media-body .font-15'));
      result.push({ anonymous, author: t('.media-body .font-15'), author_title: anonymous ? '' : t('.media-body .font-13'),
        posted_label: t('.text-muted.small'), body: body?.textContent || '', post_urls, profile_urls });
    }
    return result;
  } finally {
    window.open = originalOpen;
  }
}

// Pure string normalization shared by live extraction and offline fixtures.
export function normalizeMaimaiProfileUrl(value) {
  try {
    const u = new URL(value, 'https://maimai.cn');
    if (u.origin !== 'https://maimai.cn' || u.username || u.password || u.pathname !== '/profile/detail' || !u.searchParams.get('dstu')) return null;
    const params = new URLSearchParams({ dstu: u.searchParams.get('dstu') });
    const token = u.searchParams.get('trackable_token');
    if (token) params.set('trackable_token', token);
    return `https://maimai.cn/profile/detail?${params}`;
  // 兜底：写得不像脉脉主页地址就不认
  } catch {
    return null;
  }
}

export function normalizeMaimaiPost(row, now = Date.now()) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const urls = values => (values || []).flatMap(value => {
    try {
      const u = new URL(value, 'https://maimai.cn');
      return u.origin === 'https://maimai.cn' && !u.username && !u.password ? [u] : [];
    } catch { return []; } // 兜底：写得不像网址的那一条跳过
  });
  const anonymous = row.anonymous === true;
  const post = urls(row.post_urls).find(u => /^\/web\/(?:feed|gossip)_detail$/.test(u.pathname) && (u.searchParams.get('fid') || (anonymous && u.searchParams.get('gid'))));
  const profile = anonymous ? null : urls(row.profile_urls).find(u => u.pathname === '/profile/detail' && u.searchParams.get('dstu'));
  const profile_url = profile ? normalizeMaimaiProfileUrl(profile.href) : null;
  const body = clean(row.body);
  // A search snippet is not a job title: duties like 测试 must not turn an
  // application engineer into a test role in the existing title prefilter.
  const role = body.split(/[，,。；;！？!?\n]/).find(part => /agent|LLM|大模型|AI\s*应用|后端|全栈|开发工程师|平台|backend|full.?stack|software engineer|developer|infra/i.test(part))?.trim();
  return {
    id: post?.searchParams.get('fid') || post?.searchParams.get('gid') || null,
    author: clean(row.author).replace(/^发布者\s*[:：]\s*/, ''),
    author_title: clean(row.author_title).replace(/^[·\s]+/, ''),
    posted_label: clean(row.posted_label), posted_at: parsePostedAt(row.posted_label, now),
    title: body.slice(0, 160), role, body, text: body,
    url: post?.href || null, profile_url, contact_profile_url: profile_url, author_url: profile_url,
    anonymous, source_type: anonymous ? '内推帖' : '真人招聘帖',
  };
}

// Inspect chrome outside the posts so text about login/captcha in a post cannot
// masquerade as an authentication wall. No challenge is solved or retried.
export const MAIMAI_PAGE_STATE = `() => {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const chrome = document.body.cloneNode(true);
  chrome.querySelectorAll('li.list-group-item, script, style').forEach(el => el.remove());
  const text = chrome.textContent || '';
  const challenge = [...document.querySelectorAll('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]')].some(visible);
  const login = [...document.querySelectorAll('input[type="password"], input[placeholder*="手机号"], input[placeholder*="验证码"]')].some(visible);
  const status = /captcha|verify/i.test(location.pathname) || challenge || /安全验证|滑动.*验证|拖动滑块|完成验证/.test(text) ? 'captcha'
    : /\\/(?:login|signin|sign-?in|authwall|web\\/user\\/safe)\\b/i.test(location.pathname) || login || /登录后(?:查看|访问|搜索)|请先登录|扫码登录|登录脉脉/.test(text) ? 'session_expired' : null;
  const sort = [...document.querySelectorAll('a, button, span, div, li')].find(el => visible(el) && el.textContent.trim() === '时间排序');
  return { status, sort_available: !!sort };
}`;
export const MAIMAI_SORT_BY_TIME = `() => {
  const sort = [...document.querySelectorAll('a, button, span, div, li')].find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && el.textContent.trim() === '时间排序');
  if (!sort) return false;
  sort.click();
  return true;
}`;
