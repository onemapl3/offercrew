// 手机网页（app.js）和垫片（shim.js）共用的两样：
//   · IndexedDB 里的账号和钥匙（能存不可导出的 CryptoKey）；
//   · 手机 App 页面代码的缓存：Cache Storage 里的 offercrew-app-<版本>，service worker（sw.js）从这里给页面代码。
// 缓存里只有页面代码（电脑上 OfferCrew 的 web/phone/ 和它用的几个文件），从不放电脑上的数据。
export const APP_PREFIX = 'offercrew-app-';
export const DONE = '/__offercrew_app_complete';
export const APP_HOME = '/phone/index.html'; // 手机 App 的首页：service worker 在 /app/ 上给它（断网时 / 上也给）
// 这些路径归中转（配对页、垫片、图标、service worker 自己），电脑送来的代码包不许占用。
export const RELAY_OWN = /^\/(p(\/|$)|app(\/|$)|icons\/|sw\.js$|manifest\.webmanifest$|ws\/|push\/|api\/|__)/;

export function idbStore() {
  const db = new Promise((res, rej) => { const r = indexedDB.open('offercrew', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const d = await db; return new Promise((res, rej) => { const t = d.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)) };
}

// 手上完整的那一版代码包的版本号（没有就是 null）。
export async function appVersion(cs = globalThis.caches) {
  if (!cs) return null;
  for (const k of await cs.keys()) {
    if (!k.startsWith(APP_PREFIX)) continue;
    const c = await cs.open(k);
    if (await c.match(DONE)) return k.slice(APP_PREFIX.length);
  }
  return null;
}

// 把电脑送来的代码包（client.bundle() 的结果）写进 offercrew-app-<版本>：按路径存（不带 ?v=，service worker 取的时候也不看查询参数），
// 最后写一个「写完了」的标记，再删掉旧版本。
export async function installBundle(b, cs = globalThis.caches) {
  if (!b || !/^[A-Za-z0-9_-]{4,64}$/.test(String(b.version || '')) || !b.files || !b.files[APP_HOME]) throw Error('代码包不完整');
  const name = APP_PREFIX + b.version;
  await cs.delete(name);
  const c = await cs.open(name);
  for (const [p, f] of Object.entries(b.files)) {
    const key = String(p).split('?')[0];
    if (!key.startsWith('/') || key.startsWith('//') || key === '/' || RELAY_OWN.test(key)) continue;
    await c.put(key, new Response(f.bytes ?? f.body ?? '', { headers: { 'Content-Type': String(f.type || 'application/octet-stream') } }));
  }
  await c.put(DONE, new Response(b.version, { headers: { 'Content-Type': 'text/plain' } }));
  for (const k of await cs.keys()) if (k.startsWith(APP_PREFIX) && k !== name) await cs.delete(k);
  return b.version;
}

export async function clearApp(cs = globalThis.caches) {
  if (!cs) return;
  for (const k of await cs.keys()) if (k.startsWith(APP_PREFIX)) await cs.delete(k);
}

// ── 新消息提醒（电脑自己发的 Web Push，lib/phone/push.mjs）────────────────────────
// iPhone 上只有从主屏幕打开的 App（iOS 16.4 以上）才能收；第一次要点一下「允许」。
// 用法：页面打开「我的」时先 preparePush(client)（取电脑的公钥、等 service worker 就绪），
//       开关的点击里直接 enablePush(client, prepared)：iOS 要求订阅紧跟着那次点击，中间不能再等网络。
// 结果：{ ok: true } 或 { ok: false, reason, message }，reason 是 not_standalone / unsupported / denied / offline / failed，message 照抄给人看。
export const PUSH_MESSAGES = {
  not_standalone: '先把 OfferCrew 添加到主屏幕，从主屏幕打开再开提醒',
  unsupported: '这个浏览器收不了提醒（iPhone 要 iOS 16.4 以上）',
  denied: '通知被关掉了：到手机的「设置 → 通知 → OfferCrew」里打开',
  offline: '电脑现在不在线，等它在线再开',
  failed: '没开成，稍后再试',
};
const pushFail = reason => ({ ok: false, reason, message: PUSH_MESSAGES[reason] });
export function pushSupport({ win = globalThis, nav = globalThis.navigator } = {}) {
  const ua = String(nav?.userAgent || ''), ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav?.maxTouchPoints) > 1);
  const standalone = !!(win.matchMedia?.('(display-mode: standalone)')?.matches || nav?.standalone === true);
  if (ios && !standalone) return 'not_standalone';
  if (!nav?.serviceWorker || !('PushManager' in win) || !('Notification' in win)) return 'unsupported';
  if (win.Notification.permission === 'denied') return 'denied';
  return null;
}
const keyBytes = s => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const sameKey = (a, b) => { if (!a) return false; const x = new Uint8Array(a); return x.length === b.length && x.every((v, i) => v === b[i]); };
const tunnelFail = e => pushFail(e?.code === 'mac_offline' ? 'offline' : 'failed');
export async function preparePush(client, { win = globalThis, nav = globalThis.navigator } = {}) {
  const why = pushSupport({ win, nav });
  if (why) return pushFail(why);
  try { const [{ key }, reg] = await Promise.all([client.request('push.key'), nav.serviceWorker.ready]); return { ok: true, key: keyBytes(key), reg }; }
  catch (e) { return tunnelFail(e); }
}
export async function enablePush(client, prepared = null, { win = globalThis, nav = globalThis.navigator } = {}) {
  const why = pushSupport({ win, nav });
  if (why) return pushFail(why);
  const p = prepared?.ok ? prepared : await preparePush(client, { win, nav });
  if (!p.ok) return p;
  let sub;
  try {
    sub = await p.reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, p.key)) { await sub.unsubscribe(); sub = null; }
    sub ||= await p.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: p.key }); // 这一步弹「允许通知」
  } catch { return pushFail(win.Notification?.permission === 'denied' ? 'denied' : 'failed'); }
  const j = sub.toJSON();
  try { await client.request('push.subscribe', { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } }); }
  catch (e) { return tunnelFail(e); }
  return { ok: true };
}
export async function disablePush(client, { nav = globalThis.navigator } = {}) {
  try { const reg = await nav.serviceWorker?.ready; await (await reg?.pushManager?.getSubscription())?.unsubscribe(); } catch {}
  try { await client.request('push.unsubscribe'); return { ok: true }; } catch (e) { return tunnelFail(e); }
}
// 点了通知、App 本来就开着：service worker 发来 { t: 'offercrew-open', url: '#talk/…' }，交给 fn(url)。返回取消监听的函数。
export function onPushOpen(fn, { nav = globalThis.navigator } = {}) {
  const h = ev => { const d = ev.data; if (d?.t === 'offercrew-open' && typeof d.url === 'string') fn(d.url); };
  nav?.serviceWorker?.addEventListener('message', h);
  return () => nav?.serviceWorker?.removeEventListener('message', h);
}

// 中转升级以后别让页面停在旧代码上：回到前台时让浏览器检查一次 service worker 有没有新版本；新版接管时它会发 offercrew-reload，这里刷新一次（10 秒内不重复）。
export function keepFresh(W = globalThis) {
  const sw = W.navigator?.serviceWorker;
  if (!sw) return;
  sw.addEventListener('message', ev => {
    if (ev.data?.t !== 'offercrew-reload') return;
    let last = 0; try { last = Number(W.sessionStorage.getItem('oc.swreload')) || 0; W.sessionStorage.setItem('oc.swreload', String(Date.now())); } catch {}
    if (Date.now() - last > 10000) W.location.reload();
  });
  W.document?.addEventListener('visibilitychange', () => { if (W.document.visibilityState === 'visible') sw.getRegistration?.().then(r => r?.update()).catch(() => {}); });
}
