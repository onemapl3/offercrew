// OfferCrew 手机网页的 service worker。
// 1. 配对页（中转发的 /app/、/p/*、图标）缓存下来，好「添加到主屏幕」、打开快。__VERSION__ 由 build-assets.mjs 换成这一版文件的摘要，版本一变旧缓存就删掉。
// 2. 配对以后，手机上跑的是手机 App（引擎仓库 web/phone/，对话 / 等你 / 我的）：配对页（app.js）和垫片（shim.js）经加密通道从电脑取来代码包，
//    写进 offercrew-app-<版本>；代码包的路径（BUNDLE：/phone/*、/face.js、/crew-faces.js，即 bin/serve.mjs 的 PHONE_ROUTES）按路径（不看查询参数）从那份缓存给。
//    打开 /app/ 时，有账号、有完整的代码包就给 /phone/index.html，否则给配对页。
// 3. / 是首页（产品介绍页）。这个 service worker 是从 /sw.js 装的，管着整个站点，所以同一个浏览器配过对、再去看首页，首页也归它管（10-02 负责人的手机）：
//    / 一律去网上取首页；首页的样式、脚本、图片、宣传片根本不经这里（不调 respondWith），浏览器直接去网上取。
//    从主屏幕打开的（早先装的图标打开的是 /）由首页的 site.js 换到 /app/；只有断网时这里才在 / 上给手机 App（或者配对页）。
//    自己做出来的手机 App 页带严格的内容安全策略（CSP）：只许同一地址的脚本，不许内联脚本。
// 4. 页面里直接指向 /api/ 的（比如 <img src="/api/evidence…">）：转给打开着的那个页面，由它经加密通道去取（通道在页面里，不在这里）。
// 缓存里只有页面代码：配对、连接、加密的内容和电脑上的数据从不进缓存（/ws/、/p/code、/p/health、/push/、/api/ 都不存），首页也不进缓存。
const CACHE = 'offercrew-__VERSION__';
const APP = 'offercrew-app-', DONE = '/__offercrew_app_complete', APP_HOME = '/phone/index.html';
const SHELL = ['/app/', '/p/app.js', '/p/client.js', '/p/crypto.js', '/p/shared.js', '/p/shim.js', '/p/shim.css', '/p/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/icons/icon.svg'];
const NEVER = /^\/(ws|push)\/|^\/p\/(code|health)$/;
const RELAY_OWN = /^\/(p(\/|$)|app(\/|$)|icons\/|sw\.js$|manifest\.webmanifest$)/;
const BUNDLE = /^\/(phone\/|face\.js$|crew-faces\.js$)/; // 手机 App 代码包的路径（bin/serve.mjs 的 PHONE_ROUTES 都得在这里面）
const PHONE_PAGE = p => p.startsWith('/app/') || /^\/p(\/|$)/.test(p); // 手机网页（配对页、手机 App）的地址
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
// 换了新版本（缓存里有上一版的配对页）：接管以后，把还开着的旧页面各刷新一次，免得眼前这一页继续跑缓存里的旧代码。
// 第一次安装不刷新（那时手机可能正在配对）。能直接换页就换页，不能的就发 offercrew-reload，由页面自己刷新。
// 换页不能在 waitUntil 里等：换页的请求要等这个 service worker 激活完才交给它，激活又在等换页，两头互相等，页面一直停在「正在载入」（10-02）。
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(async keys => {
  const old = keys.filter(k => k.startsWith('offercrew-') && !k.startsWith(APP) && k !== CACHE);
  await Promise.all(old.map(k => caches.delete(k)));
  await self.clients.claim();
  if (!old.length) return;
  for (const c of await self.clients.matchAll({ type: 'window' })) reload(c);
})); });
function reload(c) {
  const ask = () => { try { c.postMessage({ t: 'offercrew-reload' }); } catch {} };
  try { if (c.navigate) { Promise.resolve(c.navigate(c.url)).catch(ask); return; } } catch {}
  ask();
}

// 完整的那一份工作台代码（页面写完最后放一个标记）。
async function appCache() {
  for (const k of await caches.keys()) {
    if (!k.startsWith(APP)) continue;
    const c = await caches.open(k);
    if (await c.match(DONE)) return c;
  }
  return null;
}
// 这部手机配过对没有（只数一下 account 这一条，不读内容）。
function paired() {
  return new Promise(resolve => {
    let r;
    try { r = indexedDB.open('offercrew', 1); } catch { return resolve(false); }
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => resolve(false);
    r.onsuccess = () => {
      try { const q = r.result.transaction('kv').objectStore('kv').count('account'); q.onsuccess = () => { resolve(q.result > 0); r.result.close(); }; q.onerror = () => resolve(false); }
      catch { resolve(false); }
    };
  });
}
function csp() {
  const ws = `${self.location.protocol === 'https:' ? 'wss' : 'ws'}://${self.location.host}`;
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ${ws}; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}
async function shell(request) {
  try { return await fetch(request); } catch { return (await caches.open(CACHE).then(c => c.match('/app/'))) || new Response('', { status: 504 }); }
}
// 有账号、有完整的代码包：手机 App（/phone/index.html，严格 CSP）；否则 null。
async function phoneApp() {
  const [c, ok] = await Promise.all([appCache(), paired()]);
  const hit = c && ok ? await c.match(APP_HOME) : null;
  if (!hit) return null;
  return new Response(await hit.blob(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp(), 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin', ...SECURITY } });
}
async function navigate(e, url) {
  if (url.pathname.startsWith('/app/')) return (await phoneApp()) || shell('/app/'); // 还没配对、或者代码包还没取来：配对页
  if (url.pathname === '/') {
    // 首页：网上的那一份。断网时（早先装的图标打开的是 /）才给手机 App 或配对页。
    try { return await fetch(e.request); }
    catch { return (await phoneApp()) || (await caches.open(CACHE).then(c => c.match('/app/'))) || new Response('', { status: 504 }); }
  }
  return shell(e.request);
}
async function code(e, url) {
  const c = await appCache(), hit = c ? await c.match(url.pathname) : null;
  if (!hit) return fetch(e.request);
  return new Response(await hit.blob(), { status: 200, headers: { 'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream', ...SECURITY } });
}
// 页面里直接指向 /api/ 的请求：交给发出它的页面，经加密通道取回。
async function viaPage(e, url) {
  const client = e.clientId ? await self.clients.get(e.clientId) : null;
  if (!client) return new Response('', { status: 503, headers: SECURITY });
  return new Promise(resolve => {
    const ch = new MessageChannel(), timer = setTimeout(() => resolve(new Response('', { status: 504, headers: SECURITY })), 120000);
    ch.port1.onmessage = ev => {
      clearTimeout(timer);
      const r = ev.data || {}, status = Number.isInteger(r.status) && r.status >= 200 && r.status <= 599 ? r.status : 502;
      resolve(new Response([204, 205, 304].includes(status) ? null : r.body ?? null, { status, headers: { 'Content-Type': r.type || 'application/octet-stream', ...SECURITY } }));
    };
    client.postMessage({ t: 'offercrew-api', path: url.pathname + url.search }, [ch.port2]);
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (url.pathname.startsWith('/api/')) { e.respondWith(viaPage(e, url)); return; }
  if (e.request.mode === 'navigate') { if (url.pathname === '/' || RELAY_OWN.test(url.pathname)) e.respondWith(navigate(e, url)); return; }
  if (BUNDLE.test(url.pathname)) { e.respondWith(code(e, url)); return; }
  if (!RELAY_OWN.test(url.pathname)) return; // 首页的文件（样式、脚本、图片、宣传片的字节范围请求……）：不经这里，浏览器直接去网上取
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    const fresh = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    return hit || fresh;
  }));
});
// 新消息提醒：电脑直接发的 Web Push（lib/phone/push.mjs），内容端到端加密，浏览器解开后是 { title, body, url, tag }。
// iOS 要求每条推送都弹出通知（不弹会被收回推送权限），所以内容解不开或不对也弹一条通用的。
// url 只认 App 里的位置（#talk/<会话>、#wait/<信>）；点通知：手机 App 开着就切过去并告诉它去哪（offercrew-open）；
// 只开着首页（同一个浏览器里看产品页）就把那一页换成手机 App；都没开就打开它。
const pushHash = u => (typeof u === 'string' && /^#[A-Za-z0-9_\-/%.!~*()]{0,200}$/.test(u) ? u : '');
const pushText = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  if (!d || typeof d !== 'object') d = {};
  const tag = pushText(d.tag, 80) || 'offercrew';
  e.waitUntil(self.registration.showNotification(pushText(d.title, 60) || 'OfferCrew', { body: pushText(d.body, 200) || '有新消息', tag, renotify: true, icon: '/icons/icon-192.png', data: { url: pushHash(d.url) } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = pushHash(e.notification.data?.url);
  e.waitUntil((async () => {
    const list = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(x => { try { return new URL(x.url).origin === self.location.origin; } catch { return false; } });
    const c = list.find(x => PHONE_PAGE(new URL(x.url).pathname));
    if (c) { try { await c.focus(); } catch {} c.postMessage({ t: 'offercrew-open', url: hash }); return; }
    if (list[0]?.navigate) { try { await list[0].focus(); } catch {} try { if (await list[0].navigate('/app/' + hash)) return; } catch {} }
    await self.clients.openWindow('/app/' + hash);
  })());
});
