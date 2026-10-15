// 公司找岗和调研共用的页面读取：HTTP 不够才用 App 专用 Chrome；每个文档导航（包括重定向）都检查 robots。
import { blockedHost, request } from './ats/http.mjs';
import { checkSite } from './ats/robots.mjs';
import { politely, MAX_PER_SITE, politeBrowserRead } from './ats/politeness.mjs';
import { runBrowserScript } from './browser-run.mjs';
import { companyReadReason, companyResourceBusy } from './company-search-receipt.mjs';

const PAGE_CHARS = 3500;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ── 抓一页 ───────────────────────────────────────────────────────────────────
// 验证码、人机验证、挡爬虫的页面：认出来就跳过，不绕。强标记在页面任何地方出现都算；「验证码」只在几乎没有正文的页面上算。
const CHALLENGE = /cf-chl|challenge-platform|cf_chl_opt|g-recaptcha|hcaptcha|geetest|Just a moment\.\.\.|Attention Required|Access denied|人机验证|安全验证|滑动验证|请完成验证|访问验证/i;
const SHORT_CAPTCHA = /captcha|验证码/i;
export function challengeOf(html, text) {
  const h = String(html || '').slice(0, 20000);
  if (CHALLENGE.test(h)) return '要人机验证';
  if (String(text || '').length < 400 && SHORT_CAPTCHA.test(h)) return '要输验证码';
  return null;
}
const titleOf = html => clip((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', 120);
const statusWhy = s => s === 404 || s === 410 ? '页面不存在' : [401, 403, 429, 503].includes(s) ? `挡爬虫（HTTP ${s}）` : `没抓到（HTTP ${s}）`;

// 默认的抓法：礼貌抓取那一套。get(url) 回 { status, text }；robots(url) 回 { allowed, why }。测试换成对本地假页面的抓法。
async function politeGet(url) {
  const [{ politely, MAX_PER_SITE }, { request }] = await Promise.all([import('./ats/politeness.mjs'), import('./ats/http.mjs')]);
  try { const r = await politely(() => request(url), { max: MAX_PER_SITE, robots: true }); return { status: r.status, text: await r.text() }; }
  catch (e) {
    const s = Number(String(e?.message || '').match(/^HTTP (\d{3}):/)?.[1]);
    if (s) return { status: s, text: '' };
    throw e;
  }
}
async function robotsCheck(url) {
  const [{ checkSite }, { politely, MAX_PER_SITE }] = await Promise.all([import('./ats/robots.mjs'), import('./ats/politeness.mjs')]);
  const r = await politely(() => checkSite(url), { max: MAX_PER_SITE });
  return r.allowed ? { allowed: true } : { allowed: false, why: r.reason && /robots_(unreadable|server_error)/.test(r.reason) ? 'robots.txt 读不到，先不抓' : 'robots.txt 不让抓' };
}
// → { url, title, text, html } 或 { url, skipped: true, why }。
export async function fetchPublicPage(url, { get = politeGet, robots = robotsCheck, maxChars = PAGE_CHARS } = {}) {
  try {
    const { blockedHost } = await import('./ats/http.mjs');
    if (blockedHost(url)) return { url, skipped: true, why: '要登录才能看' };
    const ok = await robots(url);
    if (!ok.allowed) return { url, skipped: true, why: ok.why || 'robots.txt 不让抓' };
    const r = await get(url);
    if (r.status < 200 || r.status >= 300) return { url, skipped: true, why: statusWhy(r.status) };
    const html = String(r.text || ''), { plain } = await import('./ats/http.mjs'), text = plain(html);
    const ch = challengeOf(html, text);
    if (ch) return { url, skipped: true, why: ch };
    if (text.length < 80) return { url, skipped: true, why: '页面上没有正文' };
    return { url, title: titleOf(html), text: clip(text, Math.min(40000, Math.max(PAGE_CHARS, Number(maxChars) || PAGE_CHARS))), html: html.slice(0, 200000) };
  } catch (e) {
    const m = String(e?.message || e);
    if (e?.code === 'crawl_delay_over_cap' || /crawl_delay_over_cap/.test(m)) return { url, skipped: true, why: 'robots.txt 要求隔很久才能再抓，这次不抓' };
    if (/assisted_browser_only/.test(m)) return { url, skipped: true, why: '要登录才能看' };
    return { url, skipped: true, why: /timeout|abort/i.test(m) ? '超时了' : '没抓到' };
  }
}


export async function companyRobots(url) {
  if (blockedHost(url)) return { allowed: false, why: '这个页面要求登录后才能读取' };
  const r = await politely(() => checkSite(url), { max: MAX_PER_SITE });
  return { ...r, why: r.allowed ? null : /robots_(unreadable|server_error)/.test(r.reason || '') ? 'robots.txt 读不到' : 'robots.txt 不让抓' };
}

async function companyHttpPage(url, { robots, maxChars }) {
  let blocked = null, landed = url, diagnostic = null;
  const get = async u => {
    try {
    const response = await politely(() => request(u, { beforeRequest: async next => {
      const r = await robots(next);
      if (!r.allowed) { blocked = companyReadReason(r.why || r.reason); throw Error(blocked); }
      landed = next;
    } }), { max: MAX_PER_SITE, robots: true });
    return { status: response.status, text: await response.text() };
    } catch (e) {
      diagnostic = e;
      if (/bot_challenge/.test(e.message)) blocked = companyReadReason(e);
      const status = Number(String(e.message).match(/^HTTP (\d{3}):/)?.[1]);
      if (status) return { status, text: '' };
      throw e;
    }
  };
  const r = await fetchPublicPage(url, { robots, maxChars, get });
  return { ...r, url: landed, ...(diagnostic ? { diagnostic } : {}), ...(blocked ? { skipped: true, why: blocked } : {}) };
}

export async function readCompanyPage(url, { http = companyHttpPage, browser = readCompanyBrowser, robots = companyRobots, forceBrowser = false, attempt = () => {}, maxChars = 40000, purpose = 'jobs' } = {}) {
  const rule = await robots(url);
  attempt({ action: '检查网站抓取规则', url, status: rule.allowed ? 'done' : 'blocked', summary: rule.allowed ? 'robots.txt 允许读取这个页面' : companyReadReason(rule.why || rule.reason) });
  if (!rule.allowed) return { url, skipped: true, why: companyReadReason(rule.why || rule.reason), via: 'robots' };
  attempt({ action: '直接读取网页', url, status: 'running', summary: '正在读取公开网页的正文' });
  let page;
  try { page = await http(url, { robots, maxChars }); }
  catch (e) { if (companyResourceBusy(e)) throw e; page = { url, skipped: true, why: e.message }; }
  if (companyResourceBusy(page.why)) throw Error(page.why);
  const dynamic = /needs_browser_extraction|没有正文|正文太短|javascript|脚本加载|没抓到|超时|timeout|fetch failed|ECONN|public_http_transport/i.test(page.why || '') || !page.skipped && String(page.text || '').length < 200;
  attempt({ action: '直接读取网页', url, status: page.skipped ? 'blocked' : 'done', summary: page.skipped ? companyReadReason(page.why) : '已读取网页正文', ...(page.diagnostic ? { diagnostic: page.diagnostic } : {}) });
  delete page.diagnostic;
  // 登录墙、验证码、robots、拒绝请求等不能通过换浏览器绕过。
  if (page.skipped && !dynamic) return { ...page, why: companyReadReason(page.why), via: 'http' };
  if (!forceBrowser && !dynamic) return { ...page, via: 'http' };
  attempt({ action: '用专用 Chrome 读取网页', url, status: 'running', summary: '网页需要渲染，正在用 App 的专用 Chrome 读取正文和页面链接' });
  try {
    let rendered = await browser(url, { maxChars, purpose });
    if (companyResourceBusy(rendered.why)) throw Error(rendered.why);
    if (purpose === 'research' && !rendered.skipped && String(rendered.text || '').trim().length < 80) rendered = { ...rendered, skipped: true, why: '页面上没有正文' };
    attempt({ action: '用专用 Chrome 读取网页', url, status: rendered.skipped ? 'blocked' : 'done', summary: rendered.skipped ? companyReadReason(rendered.why) : '已读取渲染后的正文和页面实际链接' });
    return { ...rendered, ...(rendered.skipped ? { why: companyReadReason(rendered.why) } : {}), via: 'browser' };
  } catch (e) {
    if (companyResourceBusy(e)) throw e;
    attempt({ action: '用专用 Chrome 读取网页', url, status: 'failed', summary: companyReadReason(e), diagnostic: e });
    return { url, skipped: true, why: companyReadReason(e), via: 'browser' };
  }
}

export function readCompanyBrowser(url, { maxChars = 40000, purpose = 'jobs' } = {}) {
  return runBrowserScript(`const { captureCompanyPage } = await import(${JSON.stringify(import.meta.url)});
radarResult(await captureCompanyPage(taskSpace, ${JSON.stringify(url)}, ${JSON.stringify({ maxChars: Number(maxChars), purpose })}));`, { timeout: 150000, maxBuffer: 4 * 1024 * 1024 });
}

export async function captureCompanyPage(taskSpace, url, { robots = companyRobots, maxChars = 40000, waitMs = 20000, gate = politeBrowserRead, purpose = 'jobs' } = {}) {
  const task = await taskSpace(`OfferCrew 公司${purpose === 'research' ? '调研' : '找岗'} ${process.pid}`), page = task.page('p1');
  // 兼容页底下的 Playwright 页只用于导航拦截；goto 仍走 App 的网站锁、验证码及用户接手保护。
  const p = await page._p();
  let blocked = null;
  const cdp = await p.context().newCDPSession(p);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const pending = new Set();
  // Chromium 的导航拦截会逐跳触发；普通 page.route 不会重跑 HTTP 重定向的后续地址。
  const guard = e => {
    const work = (async () => {
      try {
        // 嵌入的招聘站作为独立来源稍后读取，不在子框架里越过另一站的规则。
        if (e.frameId !== frameTree.frame.id) { await cdp.send('Fetch.failRequest', {requestId:e.requestId,errorReason:'BlockedByClient'}); return; }
        const r = await robots(e.request.url);
        if (!r.allowed) { blocked = companyReadReason(r.why || r.reason); await cdp.send('Fetch.failRequest', {requestId:e.requestId,errorReason:'BlockedByClient'}); return; }
        await gate(e.request.url, () => cdp.send('Fetch.continueRequest', {requestId:e.requestId}));
      } catch (err) {
        // 资源锁留给上层排队；不能先翻译成普通读取失败，丢掉可重试原因。
        blocked = companyResourceBusy(err) ? err : companyReadReason(err);
        try { await cdp.send('Fetch.failRequest', {requestId:e.requestId,errorReason:'BlockedByClient'}); }
        catch (ended) { console.error(`[company browser] 停止导航时连接已关闭：${ended.message}`); }
      }
    })();
    pending.add(work); work.finally(() => pending.delete(work));
  };
  cdp.on('Fetch.requestPaused', guard);
  await cdp.send('Fetch.enable', {patterns:[{resourceType:'Document',requestStage:'Request'}]});
  try {
    let nav;
    try { nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    catch (e) { if (companyResourceBusy(blocked)) throw blocked; if (blocked) return { url, skipped: true, why: blocked }; throw e; }
    if (nav.status >= 400) return { url, skipped: true, why: `HTTP ${nav.status}` };
    // 调研官网可能没有岗位链接；仍要等待正文与 Loading 消失，不能读脚本空壳。
    try { await page.waitForFunction(research => {
      const text = document.body?.innerText || '';
      return text.length >= (research ? 80 : 200) && !/(?:^|\n)\s*(?:Loading[.…]*|加载中[.…]*|正在加载[.…]*)\s*(?:\n|$)/i.test(text)
        && (research || [...document.querySelectorAll('a[href]')].some(a => /job|career|position|opening|岗位|职位/i.test(a.href + a.innerText)));
    }, purpose === 'research', { timeout: waitMs }); }
    catch { /* 兜底：网站可能没有岗位链接，等待结束后仍读实际正文，由后续岗位核验判断，绝不把超时当成有岗位 */ }
    const frames = [];
    for (const frame of [p.mainFrame()]) {
      if (!/^https?:/.test(frame.url())) continue;
      const allowed = await robots(frame.url());
      if (!allowed.allowed) { blocked ||= companyReadReason(allowed.why || allowed.reason); continue; }
      const data = await frame.evaluate(limit => ({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, limit), html: document.documentElement.outerHTML.slice(0, 200000), links: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h)).slice(0, 300), embedded_urls: [...document.querySelectorAll('iframe[src]')].map(f => f.src).filter(h => /^https?:/.test(h)).slice(0, 8) }), maxChars);
      frames.push(data);
    }
    const text = frames.map(f => f.text).join('\n').slice(0, maxChars), html = frames.map(f => f.html).join('\n').slice(0, 200000);
    const why = blocked || challengeOf(html, text) || (/(?:^|\n)\s*(?:Loading[.…]*|加载中[.…]*|正在加载[.…]*)\s*(?:\n|$)/i.test(text) ? '岗位列表仍在加载，暂时没读到岗位' : text.length < 20 ? '页面上没有正文' : null);
    return { url: await page.url(), title: await page.title(), ...(why ? { skipped: true, why } : {}), text, html, links: [...new Set(frames.flatMap(f => [...f.links, ...f.embedded_urls]))], embedded_urls: frames.flatMap(f => f.embedded_urls), frames: frames.map(f => ({ url: f.url, title: f.title })) };
  } finally {
    await Promise.allSettled([...pending]);
    cdp.off('Fetch.requestPaused', guard);
    try { await cdp.detach(); } catch (e) { console.error(`[company browser] 关闭导航检查时连接已断开：${e.message}`); }
    await task.finish();
  }
}
