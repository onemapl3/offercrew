// 一个招聘站的 robots.txt 放不放行（只读）。接一家公司之前先核：花旗 Workday 的 /2/、玛氏的 /External/ 这些站
// 被 robots.txt 禁了，适配器能读到也不读（docs/channels.md「不做」的那一类）。
//
// 规则照 RFC 9309：先找写了本工具名字（OfferCrew）的那一组，没有就用 `User-agent: *` 那一组；组里和路径匹配得最长
// 的那条说了算，一样长时 Allow 优先；`*` 匹配任意字符，`$` 锚在结尾。robots.txt 不存在（4xx）等于全部放行；
// 5xx、连不上时说不清，当作不放行，交给你自己看。
//
// `Crawl-delay`（秒，可以带小数）不在 RFC 9309 里，但很多站写：同一组里写了就记在组上，crawlDelay() 按同样的
// 分组规则读它（有写给 OfferCrew 的组就只看那组）。判断取详情时照它隔开请求（lib/ats/politeness.mjs）。
//
// Workday 的地址（<租户>.wdN.myworkdayjobs.com/en-US/<站点>/…、/wday/cxs/<租户>/<站点>/jobs、
// <host>.myworkdaysite.com/recruiting/<租户>/<站点>）按站点核：robots.txt 禁的是 /<站点>/ 这一段。
import { request } from './http.mjs';

export const AGENT = 'OfferCrew';

export function parseRobots(text) {
  const groups = [];
  let group = null, lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(), i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((group = { agents: [], rules: [] }));
      group.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (group && (key === 'allow' || key === 'disallow')) group.rules.push({ allow: key === 'allow', path: value });
    if (group && key === 'crawl-delay' && Number.isFinite(Number(value)) && value !== '' && Number(value) >= 0) group.crawl_delay = Number(value);
  }
  return groups;
}

// 空的 Disallow 等于什么都不禁；`*` 匹配任意字符，结尾的 `$` 表示路径到此为止。
const escape = (t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function matches(rule, path) {
  if (!rule.path) return false;
  const anchored = rule.path.endsWith('$'), body = anchored ? rule.path.slice(0, -1) : rule.path;
  return new RegExp(`^${body.split('*').map(escape).join('.*')}${anchored ? '$' : ''}`).test(path);
}

// 说给这个工具听的那几组：有写给它名字的组就只用那些，没有就用 `User-agent: *` 那些。
function groupsFor(groups, agent) {
  const name = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a && a !== '*' && name.includes(a)));
  return own.length ? own : groups.filter((g) => g.agents.includes('*'));
}

// 这条路径放不放行，和说了算的那条规则（没有就是 null）。
export function robotsVerdict(text, path, agent = AGENT) {
  const rules = groupsFor(parseRobots(text), agent).flatMap((g) => g.rules);
  let best = null;
  for (const rule of rules) {
    if (!matches(rule, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow && !best.allow)) best = rule;
  }
  return { allowed: best ? best.allow : true, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null };
}
export const robotsAllows = (text, path, agent) => robotsVerdict(text, path, agent).allowed;

// 两次请求之间至少隔几秒（没写就是 null）。几组都写了取最长的。
export function crawlDelay(text, agent = AGENT) {
  const delays = groupsFor(parseRobots(text), agent).map((g) => g.crawl_delay).filter((d) => d !== undefined);
  return delays.length ? Math.max(...delays) : null;
}

// Workday 职位站地址 → 主机、租户、站点和要核的路径；不是 Workday 的地址返回 null。
export function workdaySite(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; } // 兜底：写得不像网址就不认
  if (!/\.myworkday(?:jobs|site)\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let tenant = u.hostname.split('.')[0], site = null;
  if (parts[0] === 'wday' && parts[1] === 'cxs') [tenant, site] = [parts[2] || tenant, parts[3]];
  else if (parts[0] === 'recruiting') [tenant, site] = [parts[1] || tenant, parts[2]];
  else site = /^[a-z]{2}-[A-Za-z]{2}$/.test(parts[0] || '') ? parts[1] : parts[0];
  if (!site) return null;
  const path = parts[0] === 'recruiting' ? `/recruiting/${tenant}/${site}/` : `/${site}/`;
  return { origin: u.origin, tenant, site, path };
}

// 读这个主机的 robots.txt，回答这个站（或这个地址）放不放行。fetchRobots 可以换掉（测试用）。
export async function checkSite(url, { fetchRobots: read = fetchRobots } = {}) {
  const u = new URL(String(url)), wd = workdaySite(url);
  const path = wd ? wd.path : u.pathname || '/';
  const robots_url = `${u.origin}/robots.txt`;
  const base = { url: String(url), robots_url, path, ...(wd ? { ats_type: 'workday', tenant: wd.tenant, site: wd.site } : {}) };
  let got;
  try { got = await read(robots_url); } catch (e) { return { ...base, allowed: false, rule: null, status: null, reason: `robots_unreadable: ${e.message}` }; }
  if (got.status >= 500) return { ...base, allowed: false, rule: null, status: got.status, reason: 'robots_server_error' };
  if (got.status >= 400) return { ...base, allowed: true, rule: null, status: got.status, reason: 'no_robots_txt' };
  return { ...base, status: got.status, ...robotsVerdict(got.text, path) };
}

export async function fetchRobots(robotsUrl) {
  try {
    const response = await request(robotsUrl);
    return { status: response.status, text: await response.text() };
  } catch (e) {
    const status = Number(String(e.message).match(/^HTTP (\d{3}):/)?.[1]);
    if (status) return { status, text: '' };
    throw e;
  }
}
