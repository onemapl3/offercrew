// 账号家族（config/accounts.json）：用同一套账号登录的站点归成一组。
//
// 以前登录态按单个站点记（config/portal-sessions.json 的 domains）：在阿里云招聘站登录过，
// 阿里控股、淘天、阿里国际的岗位照样显示"未记录登录态"，每条都来要你登录。
// 现在按家族看：shared_login 的家族任一站点登录过，整组都算登录；per_tenant 的（Workday、
// 飞书招聘、Moka、北森）每家公司的租户各是一个账号，互不连带。站点级记录照旧保留，
// 执行器每次提交前仍实地探测，这里的"已登录"只是省一次跳转，不是授权。
import fs from 'node:fs';
import YAML from 'yaml';
import { read, file, configSource } from './store.mjs';
import { noteSwallowed } from './swallow.mjs';

export const loadAccounts = () => read('config/accounts.json', { families: {} });
const norm = h => String(h || '').trim().toLowerCase().replace(/^www\./, '');
export function hostOf(u) {
  const s = String(u || '').trim();
  try { return norm(new URL(s).hostname); } catch {} // 兜底：写得不像网址就按原样比
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) ? norm(s) : '';
}
const onHost = (host, d) => host === d || host.endsWith('.' + d);

// 按公司开的租户（Workday、飞书招聘、Moka、北森）给人看的名字：先在公司清单（config/companies.yaml）里按招聘页的域名找这家公司，
// 找不到就把子域名首字母大写（10-01 验收 #27：以前直接露出「飞书招聘 · relecloud」「Moka 招聘 · app」这种小写的内部名）。
// app.mokahr.com 这种几家公司共用的域名（子域名是 app、jobs 这类通用词）只写平台名：账号按域名记，一行管着这个域名下的所有公司。
const GENERIC_SUB = new Set(['app', 'www', 'jobs', 'job', 'careers', 'career', 'hr', 'talent', 'apply', 'recruit', 'recruiting', 'zhaopin', 'm']);
let companyIndex = { sig: null, checked: 0, byHost: new Map() };
function companyHosts() {
  const now = Date.now();
  if (now - companyIndex.checked < 1000) return companyIndex.byHost;
  companyIndex.checked = now;
  const rel = configSource('config/companies.yaml');
  let sig = null; try { const st = rel && fs.statSync(file(rel)); sig = st ? `${rel}:${st.mtimeMs}:${st.size}` : null; } catch {} // 兜底：文件不在就没有签名，下面按没有缓存重建
  if (sig === companyIndex.sig) return companyIndex.byHost;
  const byHost = new Map();
  try {
    const raw = rel ? YAML.parse(fs.readFileSync(file(rel), 'utf8')) : [];
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.companies) ? raw.companies : [];
    for (const c of items) {
      const name = String(c?.company || c?.name || '').trim();
      if (!name) continue;
      for (const v of Object.values(c)) {
        const h = typeof v === 'string' && /^https?:\/\//i.test(v) ? hostOf(v) : null;
        // 同一个域名记在两家公司名下：认不出是哪一家，不猜。
        if (h) byHost.set(h, byHost.has(h) && byHost.get(h) !== name ? null : name);
      }
    }
  } catch (e) { noteSwallowed('accounts.companyIndex', e, { doing: '按公司清单认网站是哪一家', then: '这次认不出公司，账号按网站分' }); }
  companyIndex = { sig, checked: now, byHost };
  return byHost;
}
export function tenantName(hostOrUrl) {
  const host = hostOf(hostOrUrl), sub = host?.split('.')[0];
  if (!sub || GENERIC_SUB.has(sub)) return null;
  return companyHosts().get(host) || sub.charAt(0).toUpperCase() + sub.slice(1);
}

// 站点属于哪个账号：{ key（家族或租户）, family, label, kind, shared_login, per_tenant, host, ... }。
export function familyOf(hostOrUrl, cfg = loadAccounts()) {
  const host = hostOf(hostOrUrl);
  if (!host) return null;
  for (const [family, f] of Object.entries(cfg.families || {})) {
    if (!(f.hosts || []).some(d => onHost(host, norm(d)))) continue;
    const key = f.per_tenant ? `${family}:${host}` : family;
    return { ...f, key, family, host, tenant: f.per_tenant ? host : null, label: f.per_tenant ? [f.label.replace(/（.*）$/, ''), tenantName(host)].filter(Boolean).join(' · ') : f.label };
  }
  return null;
}
export const accountKey = hostOrUrl => familyOf(hostOrUrl)?.key || (hostOf(hostOrUrl) ? `host:${hostOf(hostOrUrl)}` : null);

// 一段话里提到要登录的是哪些账号：只看说到登录的分句，免得「BOSS 按配置关闭未扫；LinkedIn 跳登录页」
// 把 BOSS 也算进来。站点域名和关键词都认。
//
// "登录"两个字出现不等于要你去登录（2026-09-28）：执行器常写"网易已登录，但须先建立在线简历"
// "登录有效""微软登录已核验恢复"，这些都被当成"去登录"，你登录多少次那封信都不会消失——真正缺的
// 是出生年月、地址、重新批准。所以每个分句分两种：
//   ok   说已经登录 / 登录有效 / 登录已恢复，同一句里没有说要登录；
//   need 说没登录 / 要登录 / 过期了 / 跳登录页，或只是提到登录、没说已经好了。
// 引号里的按钮名（点「我已登录」）不算。
const LOGIN_WORD = /登录|登陆|授权|扫码|sign ?in|log ?in|token_missing|authwall|未登录|会话失效|session/i;
const LOGIN_OK = /已(经)?(成功)?登[录陆]|登[录陆](状态|态)?(仍然?|依然|均|都)?(有效|正常|成功|没问题|无问题|可用)|登[录陆]已(经)?(核验|恢复|确认|实测|生效|完成)|(已|实测)(经)?恢复登[录陆]|logged ?in|signed ?in/i;
const LOGIN_NEED = /未登[录陆]|没(有)?登[录陆]|尚未登[录陆]|还没(有)?登[录陆]|需(要)?[^，。；,]{0,24}登[录陆]|请[^，。；,]{0,16}登[录陆]|重新登[录陆]|登[录陆](已|状态|态)?(过期|失效|退出|掉了|被踢)|会话(已)?(失效|过期)|无有效会话|跳(到|转)?(了)?登[录陆]|登[录陆](页|墙|弹窗|框)|扫码|authwall|login ?wall|(sign|log) ?in (required|wall|page)|not (logged|signed) ?in|token_missing|create account ?\/ ?sign ?in/i;
const LOGIN_NOT_NEEDED = /(不|无|毋)(需|须|必|用)(要)?(再|重新)?登[录陆]/;
const QUOTED = /「[^」]*」|“[^”]*”|『[^』]*』/g;
const CLAUSES = /[。；;\n]|(?<=[^\d]),|，/;
export function loginClauses(text) {
  return String(text || '').replace(QUOTED, ' ').split(CLAUSES).map(c => c.trim())
    .filter(c => LOGIN_WORD.test(c) || LOGIN_OK.test(c) || LOGIN_NEED.test(c))
    .map(c => ({ text: c, ok: LOGIN_OK.test(c) && !LOGIN_NEED.test(c), need: !LOGIN_NOT_NEEDED.test(c) && (LOGIN_NEED.test(c) || !LOGIN_OK.test(c)) }));
}
// 单一账号的事（一条线索的门户）：有 need、并且没有一句说"已经登好了"，才算卡在登录。
export const loginNeeded = text => { const cs = loginClauses(text); return cs.some(c => c.need) && !cs.some(c => c.ok); };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentioned = (clause, cfg) => Object.entries(cfg.families || {}).filter(([, f]) => !f.per_tenant // 租户账号只能从链接认，关键词分不出是哪家公司。
  && [...(f.keywords || []), ...(f.hosts || [])].some(w => new RegExp(/^[\x00-\x7f]+$/.test(w) ? `(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)` : escapeRe(w), 'i').test(clause))).map(([family]) => family);
// 多个账号的事（真人帖扫描）：按账号分别看，被说"已登录"的账号不算。
export function familiesInText(text, cfg = loadAccounts()) {
  const need = new Set(), ok = new Set();
  for (const c of loginClauses(text)) for (const family of mentioned(c.text, cfg)) { if (c.need) need.add(family); if (c.ok) ok.add(family); }
  return [...need].filter(f => !ok.has(f));
}
// 执行器任务的恢复条件 portal_login:linkedin.com,xiaohongshu.com → 这些站点的账号。
export function familiesInCondition(cond, cfg = loadAccounts()) {
  const m = /^portal_login:(.+)$/.exec(String(cond || '').trim());
  return m ? [...new Set(m[1].split(/[,，\s]+/).map(h => familyOf(h, cfg)?.key).filter(Boolean))] : [];
}

export function familySession(host, sessions = {}, cfg = loadAccounts()) {
  const h = hostOf(host), fam = familyOf(h, cfg);
  const mine = Object.entries(sessions.domains || {}).filter(([d]) => fam?.shared_login ? familyOf(d, cfg)?.key === fam.key : hostOf(d) === h);
  if (!mine.length) return null;
  const [domain, s] = mine.sort(([, a], [, b]) => String(b.verified_at || '').localeCompare(String(a.verified_at || '')) || (b.logged_in === true) - (a.logged_in === true))[0];
  return { domain, ...s, ...(hostOf(domain) !== h ? { via_family: fam?.family || null } : {}) };
}

// 家族里已经登录的那个站点记录（只对 shared_login 家族）。没有则 null。
export function siblingSession(host, sessions = {}, cfg = loadAccounts()) {
  const fam = familyOf(host, cfg);
  if (!fam?.shared_login) return null;
  const hit = Object.entries(sessions.domains || {}).find(([d, s]) => s?.logged_in === true && familyOf(d, cfg)?.key === fam.key);
  return hit ? { domain: hit[0], ...hit[1], via_family: fam.family } : null;
}

// 账号（家族 key 或 workday:租户）最近一次的登录记录。
export function sessionForKey(key, sessions = {}, cfg = loadAccounts()) {
  const [family, tenant] = String(key || '').split(/:(.+)/);
  const host = tenant || (cfg.families?.[family]?.hosts || [])[0];
  return host ? familySession(host, sessions, cfg) : null;
}
// 这个账号在 since（任务停下来的时间）之后被确认登录过——你点了「我登好了」、系统自动检测到、
// 或执行器实地核对过——那登录就不再是卡点：还卡着的话，卡的是别的事。只记到日期的旧记录从当天零点算。
export function loggedInSince(key, since, sessions = {}, cfg = loadAccounts()) {
  const s = sessionForKey(key, sessions, cfg);
  const at = Date.parse(s?.verified_at || ''), from = Date.parse(since || '') || 0;
  return s?.logged_in === true && Number.isFinite(at) && at >= from;
}

// 同一个账号覆盖的站点：shared_login 家族是整组（配置里的 + 线索里见过的），其余只有它自己。
export function accountHosts(hostOrUrl, { cfg = loadAccounts(), seen = [] } = {}) {
  const fam = familyOf(hostOrUrl, cfg), host = hostOf(hostOrUrl);
  if (!fam?.shared_login) return host ? [host] : [];
  return [...new Set([...(fam.hosts || []).map(norm), ...seen.map(hostOf).filter(h => familyOf(h, cfg)?.key === fam.key)])];
}

// 账号一览：每个家族 / 租户一行，登录态取家族里任一站点的记录（shared_login）。
// services（飞书本人授权、Gmail、模型订阅）由调用方传入实时状态。
export function accountsView({ sessions = { domains: {} }, hosts = [], services = {}, cfg = loadAccounts() } = {}) {
  const rows = new Map();
  const add = host => {
    const fam = familyOf(host, cfg);
    const key = fam?.key || `host:${hostOf(host)}`;
    if (!rows.has(key)) rows.set(key, { key, family: fam?.family || null, label: fam?.label || hostOf(host), kind: fam?.kind || 'portal', shared_login: !!fam?.shared_login, per_tenant: !!fam?.per_tenant, login_url: fam?.login_url || (hostOf(host) ? `https://${hostOf(host)}/` : null), how: fam?.how || null, hosts: new Set(), logged_in: null, verified_at: null, last_probe: null, evidence: null });
    const row = rows.get(key);
    if (hostOf(host)) row.hosts.add(hostOf(host));
    return row;
  };
  for (const [domain, s] of Object.entries(sessions.domains || {})) {
    const row = add(domain);
    // 家族里有一个站点确认登录过就算登录；都没登录时取最近一次探测的结论。
    const newer = !row.verified_at || String(s.verified_at || '') > String(row.verified_at || '');
    if (s.logged_in === true && (row.logged_in !== true || newer)) Object.assign(row, { logged_in: true, verified_at: s.verified_at || null, last_probe: s.last_probe || null, evidence: s.evidence || null, via: domain });
    else if (row.logged_in !== true && newer) Object.assign(row, { logged_in: s.logged_in === false ? false : row.logged_in, verified_at: s.verified_at || null, last_probe: s.last_probe || null, evidence: s.evidence || null, via: domain });
  }
  for (const h of hosts) add(h);
  for (const [family, f] of Object.entries(cfg.families || {})) {
    if (f.kind !== 'service') continue;
    const s = services[family];
    rows.set(family, { key: family, family, label: f.label, kind: 'service', shared_login: false, per_tenant: false, login_url: null, how: f.how || null, hosts: new Set(), logged_in: s?.ready === true ? true : s?.ready === false ? false : null, verified_at: s?.checked_at || null, last_probe: s?.message || null, evidence: null });
  }
  return [...rows.values()].map(r => ({ ...r, hosts: [...r.hosts].sort() })).sort((a, b) => (a.kind === 'service' ? 0 : a.kind === 'platform' ? 1 : 2) - (b.kind === 'service' ? 0 : b.kind === 'platform' ? 1 : 2) || String(a.label).localeCompare(String(b.label), 'zh'));
}
