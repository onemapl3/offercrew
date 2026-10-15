// 登录检查：你点「我登好了」时先核对一次；有登录信在等时 lib/login-watch.mjs 定时来看（你刚点过「打开登录页」的
// 账号 20 秒一次），看到登好了就自己继续，不用你回来点。
//
// 打开 config/accounts.json 里这个账号的 probe.url（要登录才能看的页面，比如候选人中心、我的投递），看落到了哪、
// 页面上是什么。判断在页面里做完，只带回几个是 / 否，不把页面内容带出来；只读，不点、不填任何东西。
//   logged_out_url     落到这种地址 = 没登录（被跳到了 login、passport、sso 这类登录页）
//   logged_out_lines   页面上有一整行是这些字（「登录」「Sign in」）= 没登录；整行比较，帖子里的「欢迎加入」不算
//   logged_out_text    页面前 1500 字里出现这些字 = 没登录（脉脉、BOSS 沿用）
//   logged_in_selector 已登录的证据：页面上有这个元素（你的头像、「我」）
//   logged_in_logout   已登录的证据：页面上有「退出登录」一类的按钮或链接（收在没展开的菜单里也算）
// 配了已登录的证据，就必须找到它才算登好了；没找到、也没看到没登录的迹象，就是「看不出来」——不算没登录，
// 你点「我登好了」照样能继续（提交前照旧实地核对），只是系统不会自己替你判定登好了。
// 碰到验证页（验证码、人机检查、访问太频繁）：停下，不算登没登录，这一轮不再看这个站（lib/login-watch.mjs 歇一阵再来）。
// url 里的 {host} 换成这个账号的域名：按公司分账号的系统（Workday、北森……）每家公司一个域名。
//
// 在哪看：
//   专用 Chrome（lib/browser-host.mjs）：开一个不进标签栏的隐藏标签页，依次打开、看完就关；你的标签页不会被碰。
//     你刚为这个账号点了「打开登录页」、那一页还停在登录页上时，这一轮先不看——还在登录的时候去开要登录的页面，
//     有的网站（SSO）会把你正在走的登录流程打断。
import { loadAccounts } from './accounts.mjs';
import { withHost, hiddenTab, attach, navigate, evaluate, userTabNow } from './browser-host.mjs';
import { siteHold, holdSite } from './browser-sites.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 页面里执行的那段判断：不能引用外面的变量，只用参数 s 和页面自己的全局。
export const PROBE_PAGE = String(function (s) {
  var url = location.href, text = document.body ? document.body.innerText : '';
  var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var all = function (sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } }; // 兜底：选择器写得不合法就当没找到
  var clean = function (t) { return String(t || '').replace(/\s+/g, ' ').trim(); };
  var LOGOUT = /退出登录|注销登录|安全退出|退出账号|^退出$|^注销$|sign ?out|log ?out/i, LOGOUT_URL = /logout|signout|sign[_-]out|log[_-]out/i;
  var VERIFY_TEXT = /人机验证|安全验证|拖动滑块|滑动验证|请完成验证|请完成安全验证|访问过于频繁|访问异常|异常访问|verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|unusual traffic/i;
  var VERIFY_FRAME = /recaptcha|hcaptcha|geetest|captcha|turnstile|arkoselabs|funcaptcha|nc_iconfont|aliyuncaptcha/i;
  var VERIFY_URL = /captcha|\/challenge|verify\.html|security[-_]?check|\/waf\//i;
  return {
    url: url, lines: lines.length,
    outUrl: !!(s.outUrl && new RegExp(s.outUrl, 'i').test(url)),
    outLine: !!(s.outLines && lines.some(function (l) { return new RegExp(s.outLines, 'i').test(l); })),
    outText: !!(s.outText && new RegExp(s.outText).test(lines.join(' ').slice(0, 1500))),
    inSel: s.inSel ? document.querySelectorAll(s.inSel).length : null,
    logout: s.logout ? all('a, button, [role=menuitem], [role=button], [role=link]').some(function (n) {
      var t = clean(n.getAttribute('aria-label') || n.textContent || n.getAttribute('title'));
      return (t.length <= 20 && LOGOUT.test(t)) || LOGOUT_URL.test(n.getAttribute('href') || '');
    }) : null,
    verify: VERIFY_URL.test(url) || lines.some(function (l) { return l.length <= 60 && VERIFY_TEXT.test(l); })
      || all('iframe').some(function (f) {
        // 隐形的 reCAPTCHA（size=invisible、0×0）很多网站每页都挂着，不算要你验证。
        var src = f.getAttribute('src') || '';
        if (!VERIFY_FRAME.test(src) || /size=invisible/i.test(src)) return false;
        var r = f.getBoundingClientRect ? f.getBoundingClientRect() : null;
        return !r || (r.width >= 60 && r.height >= 40);
      }),
  };
});

// 这个账号的检查方法（config/accounts.json 的 probe），{host} 已换成账号的域名；没配就是 null。
export function probeFor(key, cfg = loadAccounts()) {
  const [family, tenant] = String(key || '').split(/:(.+)/);
  const f = cfg.families?.[family], p = f?.probe;
  if (!p?.url || (f.per_tenant && !tenant)) return null;
  const host = tenant || (f.hosts || [])[0] || '';
  if (p.url.includes('{host}') && !host) return null;
  const resolved = { ...p, url: p.url.replaceAll('{host}', host) };
  // Microsoft 的新页头把退出菜单放进组件内；旧安装的 accounts.json 只有
  // logout 规则。用原站明确的登录属性兼容旧配置，不靠按钮仍叫「Sign in」来猜。
  if (family === 'microsoft' && !resolved.logged_in_selector && /^https:\/\/apply\.careers\.microsoft\.com\/careers(?:[/?#]|$)/.test(resolved.url)) {
    resolved.logged_in_selector = 'uhf-mecontrol[data-msft-auth-visibility="signed-in"]';
  }
  return resolved;
}
const specOf = (k, p) => ({ k, url: p.url, outUrl: p.logged_out_url || null, outLines: p.logged_out_lines || null, outText: p.logged_out_text || null, inSel: p.logged_in_selector || null, logout: p.logged_in_logout ? true : null });
const wantsProof = p => !!(p?.logged_in_selector || p?.logged_in_logout);

export function probeVerdict(r, p = {}) {
  if (!r) return { checked: false, error: '页面是空的' };
  const url = r.url || null;
  if (r.outUrl) return { checked: true, logged_in: false, url, reason: '跳到了登录页' };
  // 找到了只有登录后才有的东西：登好了（页面别处有一整行「登录」也不改结论）。
  if (wantsProof(p) && (r.inSel > 0 || r.logout)) return { checked: true, logged_in: true, url, reason: null };
  if (r.outLine || r.outText) return { checked: true, logged_in: false, url, reason: '页面上还是登录 / 注册' };
  if (r.verify) return { checked: false, blocked: true, url, error: '网站要先验证（验证码、安全检查）' };
  if (r.lines < 3) return { checked: false, error: r.navError ? '页面没打开' : '页面是空的' };
  if (wantsProof(p)) return { checked: false, url, error: '页面上没看到你的账号' };
  return { checked: true, logged_in: true, url, reason: null };
}

// 你为这个账号点了「打开登录页」、那个标签页还停在登录页上（10 分钟以内）：先不看。
const LOGIN_PAGE = /login|log-in|signin|sign-in|sign_in|passport|\bsso\b|oauth|authorize|\/auth\b|register|signup/i;
const STILL_FOR_MS = 10 * 60000;
export function stillLoggingIn(tab, key, p, now = Date.now()) {
  if (!tab || tab.account !== key || !tab.url || /^(about|chrome|data):/i.test(tab.url)) return false;
  if (now - (Date.parse(tab.at || '') || 0) > STILL_FOR_MS) return false;
  try { if (p?.logged_out_url && new RegExp(p.logged_out_url, 'i').test(tab.url)) return true; } catch {} // 兜底：账号设置里的网址规则写坏了就只按常见的登录页网址认
  return LOGIN_PAGE.test(tab.url);
}

// 在专用 Chrome 的隐藏标签页里依次看。证据要的是页面「定下来」以后的样子：
//   跳到登录页、碰到验证页、找到已登录的证据——一看到就定了（最少等 1.5 秒）；
//   页面上一整行「登录」可能只是还没加载完你的账号（单页应用先画「登录」再换成头像），等满 4 秒再下结论；
//   没配证据的（LinkedIn 这些平台）也等满 4 秒；配了证据却一直没找到，最多等 8 秒。
export async function probeOnHost(specs, { minWait = 4000, maxWait = 8000, step = 500 } = {}) {
  return withHost(async cdp => {
    const { targetId } = await hiddenTab(cdp);
    const out = {};
    try {
      const session = await attach(cdp, targetId);
      for (const s of specs) {
        const { navError } = await navigate(cdp, session, s.url, { timeout: 40000 });
        const proof = !!(s.inSel || s.logout), t0 = Date.now();
        let r = null;
        for (;;) {
          await sleep(step);
          try { r = await evaluate(cdp, session, `(${PROBE_PAGE})(${JSON.stringify(s)})`, { timeout: 10000 }); } catch { r = null; } // 兜底：页面正在跳转读不到，下一拍再读；一直读不到下面记 page_unreadable
          const waited = Date.now() - t0;
          if (r && (r.outUrl || r.verify || (proof && (r.inSel > 0 || r.logout))) && waited >= Math.min(1500, minWait)) break;
          if (waited >= minWait && (!proof || (r && (r.outLine || r.outText)))) break;
          if (waited >= maxWait) break;
        }
        out[s.k] = r ? { ...r, navError } : { url: null, lines: 0, navError: navError || 'page_unreadable' };
      }
    } finally { await cdp.send('Target.closeTarget', { targetId }).catch(() => {}); } // 兜底：标签页已经关了
    return out;
  });
}

// keys：账号（家族 key，或 workday:租户域名）。返回 { key: { checked, logged_in, reason, url, error, blocked, skipped } }。
// 没配检查方法的账号不打开，不在结果里。只在专用 Chrome 里看（ego 那一支 10-04 删了）；host、userTab 测试换成假的。
export async function probeAccounts(keys, { cfg = loadAccounts(), host = probeOnHost, userTab = userTabNow, now = Date.now() } = {}) {
  const list = [...new Set(keys)].map(k => [k, probeFor(k, cfg)]).filter(([, p]) => p?.url);
  if (!list.length) return {};
  const tab = await userTab().catch(() => null); // 兜底：不知道你那一页在哪，就当你没停在登录页上
  const wait = new Set(list.filter(([k, p]) => stillLoggingIn(tab, k, p, now)).map(([k]) => k));
  // 这个网站正「先别碰」（刚碰到过验证页，lib/browser-sites.mjs）：不去敲它。
  const held = new Map(list.map(([k, p]) => [k, siteHold(p.url, now)]).filter(([, h]) => h));
  const todo = list.filter(([k]) => !wait.has(k) && !held.has(k));
  const raw = todo.length ? await host(todo.map(([k, p]) => specOf(k, p))) : {};
  const out = Object.fromEntries(list.map(([k, p]) => [k, wait.has(k) ? { checked: false, skipped: true, error: '登录页还开着' }
    : held.has(k) ? { checked: false, blocked: true, url: held.get(k).url, error: '网站要先验证（验证码、安全检查）' }
    : probeVerdict(raw?.[k], p)]));
  // 碰到验证页：这个网站一小时内谁都不再自动打开（扫描、私信也一样），验证由你来做。
  for (const [k] of todo) if (out[k]?.blocked && out[k].url) holdSite(out[k].url, { now });
  return out;
}
export async function probeAccount(account, opts = {}) {
  return (await probeAccounts([account], opts))[account] || { checked: false };
}
