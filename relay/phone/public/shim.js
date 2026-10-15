// OfferCrew 手机垫片（/p/shim.js，中转发的，不来自电脑）：手机上跑的是电脑上工作台自己的页面，这一段放在页面 <head> 的最前面，
// 让页面照常 fetch('/api/…')、new EventSource('/api/events')，却不知道自己在手机上（design/phone-m2/实施方案.md 第二、三节）。
//
//   · fetch：同一地址的 /api/* 经端到端加密通道（client.js）交给电脑上的手机网关，答复做成真的 Response 还给页面；别的照常。
//     通道还没连上时请求先排着；电脑不在线就像断网一样失败（TypeError，页面照常显示出错）。
//   · 上传简历（POST /api/setup/resume，原始字节）：切块走 client.upload。
//   · 428 { phone_confirm }：往外生效的事要在手机上确认。底部弹一张确认卡（标题 + 几行），点「确认发出」带着 x-phone-confirm 再发一次。
//   · EventSource('/api/events')：页面开着、看得见时订阅电脑的更新推送，每次订上发一次 ready，有推送发 update；切到后台就退订。
//   · 点 /api/ 的链接（截图、导出的简历）：经通道取回，图片在 App 里全屏看，别的交给系统的分享 / 保存，从不离开页面。
//   · 页面里 <img src="/api/evidence…">：service worker 收到后转给这个页面（MessageChannel），这里经通道取回。
//   · 电脑不在线：顶上一条「电脑不在线 · 最后更新 HH:MM」，页面上已经显示的内容留着。
//   · 每次打开问一次电脑现在的代码包版本，不一样就换包、刷新一次。电脑上解除了配对：清掉代码包，回到配对页。
// 手机上不存任何电脑上的数据：答复只在内存里，缓存里只有页面代码。
//
// 普通脚本（不是模块）：要在页面的模块脚本之前同步换掉 fetch 和 EventSource。加密、协议、缓存用 import() 取模块。
// 纯逻辑挂在 globalThis.__offercrewShim 上，Node 测试（tests/phone-shim.test.mjs）直接用；只有在浏览器页面里才真正装上。
(function (G) {
  'use strict';
  const T = {
    offline: '电脑不在线', last: t => `最后更新 ${t}`, cancel: '取消', go: '确认发出', cancelled: '已取消，没有发出',
    close: '关闭', save: '存到手机', notPaired: '这部手机还没和电脑配对', failed: '没取到这个文件',
  };
  const pad = n => String(n).padStart(2, '0');
  const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // 同一地址的 /api/* → 带查询参数的路径；别的 → null。
  function apiPath(input, base) {
    try {
      const b = new URL(base), u = new URL(String(input), b);
      return u.origin === b.origin && u.pathname.startsWith('/api/') ? u.pathname + u.search : null;
    } catch { return null; }
  }

  // 电脑的答复（client.http 的 { status, headers, body }）→ 真的 Response。
  function toResponse(r, R = G.Response) {
    const status = Number.isInteger(r?.status) && r.status >= 200 && r.status <= 599 ? r.status : 502;
    const headers = {};
    for (const [k, v] of Object.entries(r?.headers || {})) { const key = k.toLowerCase(); if ((key === 'content-type' || key === 'content-disposition') && v) headers[key] = String(v); }
    return new R([204, 205, 304].includes(status) ? null : r?.body ?? '', { status, headers });
  }
  const jsonResponse = (status, j, R = G.Response) => new R(JSON.stringify(j), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  // 文件名：content-disposition 里的，没有就按地址猜（?file= 的最后一段、?format=）。
  function fileName(path, headers = {}) {
    const cd = String(headers['content-disposition'] || '');
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd), plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    try { if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {}
    if (plain) return plain[1].trim();
    const u = new URL(path, 'http://x.invalid'), f = u.searchParams.get('file'), fmt = u.searchParams.get('format');
    if (f) return f.split('/').pop() || 'file';
    if (fmt) return `简历.${fmt.replace(/[^a-z0-9]/gi, '')}`;
    return u.pathname.split('/').pop() || 'file';
  }
  const isImage = type => /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)\b/i.test(String(type || ''));

  // 点了一个链接：要经通道取的返回路径，别的（页内锚点、外面的网址）返回 null，照常处理。
  function linkPath(href, base) { return href == null ? null : apiPath(href, base); }

  // ── fetch ──
  // channel() → PhoneClient（连上之前请求在这里排着）；confirm({ title, lines }) → Promise<boolean>；onReply(r) 每个答复到了都调。
  function makeFetch({ realFetch, base, channel, confirm, onReply = () => {}, R = G.Response, H = G.Headers }) {
    return async function fetch(input, init = {}) {
      const req = G.Request && input instanceof G.Request ? input : null;
      const path = apiPath(req ? req.url : input, base);
      if (!path) return realFetch(input, init);
      init = init || {};
      const method = String(init.method || req?.method || 'GET').toUpperCase();
      const h = new H(init.headers || req?.headers || {}), type = h.get('content-type');
      let body = init.body ?? null;
      if (body == null && req && !['GET', 'HEAD'].includes(method)) body = await req.arrayBuffer();
      let client;
      try { client = await channel(); } catch (e) { throw new TypeError(e?.message || T.notPaired); }
      try {
        if (method === 'POST' && path.split('?')[0] === '/api/setup/resume') {
          const bytes = new Uint8Array(await new R(body).arrayBuffer());
          const r = await client.upload(bytes, { headers: { ...(type ? { 'content-type': type } : {}), ...(h.get('x-file-name') ? { 'x-file-name': h.get('x-file-name') } : {}) } });
          onReply(r); return toResponse(r, R);
        }
        const text = body == null ? null : typeof body === 'string' ? body : await new R(body).text();
        const send = extra => client.http({ method, path, headers: { ...(type ? { 'content-type': type } : {}), ...extra }, body: text }, { timeoutMs: method === 'GET' ? 60000 : 300000 });
        let r = await send({});
        if (r.status === 428) {
          let j = null; try { j = JSON.parse(typeof r.body === 'string' ? r.body : ''); } catch {}
          const pc = j?.phone_confirm;
          if (pc && typeof pc.token === 'string') {
            onReply(r);
            if (!(await confirm({ title: String(pc.title || '确认'), lines: Array.isArray(pc.lines) ? pc.lines.map(String) : [] }))) return jsonResponse(409, { error: T.cancelled, cancelled: true }, R);
            r = await send({ 'x-phone-confirm': pc.token });
          }
        }
        onReply(r);
        return toResponse(r, R);
      } catch (e) {
        if (e instanceof TypeError) throw e;
        throw new TypeError(e?.message || '电脑没有回答'); // 和断网一样：页面走自己的出错路子
      }
    };
  }

  // ── 更新推送 ──
  // hub 管订阅：有 EventSource 开着、页面看得见，才向电脑订阅；订上一次发一次 ready（和电脑上重连一样），推送来了发 update。
  function makeHub({ channel, visible, info }) {
    const list = new Set();
    let subscribed = false, down = false, chain = Promise.resolve();
    const fire = (type, data) => { for (const es of [...list]) es._fire(type, data); };
    const ready = async () => { let i = {}; try { i = (await info()) || {}; } catch {} return JSON.stringify({ started_at: i.started_at || null }); };
    // 一次一个：订阅和退订按顺序来，每一步看的是那时候想要的状态。
    const sync = () => (chain = chain.then(async () => {
      const want = list.size > 0 && visible();
      if (want === subscribed) return;
      try {
        const c = await channel();
        if (want) { await c.subscribe(); subscribed = true; down = false; fire('ready', await ready()); }
        else { subscribed = false; await c.unsubscribe(); }
      } catch { if (want) { down = true; fire('error'); } }
    }));
    return {
      list, get subscribed() { return subscribed; },
      add(es) { list.add(es); return sync(); },
      remove(es) { list.delete(es); return sync(); },
      push() { if (subscribed) fire('update', ''); },
      // 电脑掉线：页面看到 error（像电脑上本地服务断了）；回来后重新订阅，再发 ready（页面据此刷新）。
      mac(online) { if (!online) { if (!down) { down = true; subscribed = false; fire('error'); } } else if (down) { down = false; subscribed = false; return sync(); } },
      visibility() { return sync(); },
    };
  }
  function makeEventSource({ RealES, base, hub }) {
    return class EventSource extends G.EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      constructor(url, opts) {
        if (apiPath(url, base)?.split('?')[0] !== '/api/events') { if (!RealES) throw new TypeError('EventSource'); return new RealES(url, opts); }
        super();
        this.url = new URL(String(url), base).href; this.withCredentials = false; this.readyState = 0;
        this.onopen = null; this.onmessage = null; this.onerror = null;
        hub.add(this);
      }
      close() { this.readyState = 2; hub.remove(this); }
      _fire(type, data) {
        if (this.readyState === 2) return;
        this.readyState = type === 'error' ? 0 : 1;
        const ev = type === 'error' ? new G.Event('error') : new G.MessageEvent(type, { data: data ?? '' });
        this.dispatchEvent(ev);
        const on = this[`on${type}`];
        if (typeof on === 'function') try { on.call(this, ev); } catch (e) { setTimeout(() => { throw e; }); }
      }
    };
  }

  const api = { T, apiPath, toResponse, fileName, isImage, linkPath, makeFetch, makeHub, makeEventSource, hhmm };
  G.__offercrewShim = api;
  if (!G.document || !G.location || G.__offercrewShimOn) return;
  G.__offercrewShimOn = true;
  install(G, api);

  // ── 装到页面上 ──────────────────────────────────────────────────────────────
  function install(W, S) {
    const D = W.document, base = W.location.origin, realFetch = W.fetch.bind(W), RealES = W.EventSource;
    const el = (tag, cls, text) => { const e = D.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const css = el('link'); css.rel = 'stylesheet'; css.href = '/p/shim.css'; D.head ? D.head.prepend(css) : D.documentElement.append(css);
    let shared = null, clientP = null, lastOk = null, macOnline = null, link = 'off', helloP = null;

    const channel = () => clientP || (clientP = (async () => {
      const [C, { PhoneClient }, M] = await Promise.all([import('/p/crypto.js'), import('/p/client.js'), import('/p/shared.js')]);
      shared = M;
      const client = new PhoneClient({ C, base, store: M.idbStore(), onEvent });
      if (!(await client.account())) { await backToPairing(false); throw new TypeError(T.notPaired); }
      await client.connect();
      return client;
    })());
    channel().catch(() => {});
    const hello = () => helloP || (helloP = channel().then(c => c.hello()).catch(e => { helloP = null; throw e; }));

    // 手机 App（web/phone/app.js）要用的几样：通道、hello、确认卡、在 App 里打开文件、电脑在不在线。
    const listeners = new Set();
    W.__offercrewPhone = {
      channel, hello: () => hello(), confirm: (v) => confirmSheet(v), openFile: p => openFile(p),
      state: () => ({ mac: macOnline, link, lastOk }), on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    function onEvent(type, e) {
      for (const fn of listeners) { try { fn(type, e); } catch {} }
      if (type === 'link') { link = e.state; status(); if (e.state === 'offline') hub.mac(false); } // 连回来时 client 会报一次 mac
      if (type === 'mac') { macOnline = e.online; status(); hub.mac(e.online); if (e.online) checkBundle(); }
      if (type === 'push') hub.push();
      if (type === 'revoked') backToPairing(true);
    }
    async function backToPairing(revoked) {
      try { await (shared || (await import('/p/shared.js'))).clearApp(); } catch {}
      try { if (revoked) W.sessionStorage.setItem('oc.revoked', '1'); } catch {}
      W.location.replace('/app/');
    }

    // 顶上的一条：电脑不在线 · 最后更新 HH:MM
    let bar = null, barTimer = null;
    function status() {
      const off = macOnline === false || link === 'offline';
      clearTimeout(barTimer);
      barTimer = setTimeout(() => {
        if (!D.body) return;
        if (!bar) { bar = el('div', 'oc-status'); bar.setAttribute('role', 'status'); D.body.append(bar); }
        bar.textContent = off ? [T.offline, lastOk ? T.last(hhmm(lastOk)) : ''].filter(Boolean).join(' · ') : '';
        bar.hidden = !off;
        D.documentElement.classList.toggle('oc-offline', off);
      }, off ? 1500 : 0); // 重连的一两秒不闪
    }

    // 确认卡
    function confirmSheet({ title, lines, go = /^确认/.test(String(title || '')) ? String(title) : T.go }) {
      return new Promise(resolve => {
        const bg = el('div', 'oc-sheet-bg'), sheet = el('div', 'oc-sheet');
        sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
        const h = el('h2', null, title), ul = el('ul');
        for (const l of lines) ul.append(el('li', null, l));
        const row = el('div', 'oc-sheet-row'), no = el('button', 'oc-btn', T.cancel), yes = el('button', 'oc-btn is-go', go);
        no.type = yes.type = 'button';
        row.append(no, yes); sheet.append(h, ...(lines.length ? [ul] : []), row); bg.append(sheet); D.body.append(bg);
        const done = v => { bg.remove(); resolve(v); };
        no.onclick = () => done(false); yes.onclick = () => done(true);
        bg.addEventListener('click', e => { if (e.target === bg) done(false); });
        yes.focus();
      });
    }
    function toast(text) {
      const t = D.getElementById('toast');
      if (!t) return;
      t.textContent = text; t.style.display = 'block';
      clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = 'none'; }, 6000);
    }

    const hub = S.makeHub({ channel, visible: () => D.visibilityState !== 'hidden', info: async () => (await hello()).mac });
    W.fetch = S.makeFetch({ realFetch, base, channel, confirm: confirmSheet, onReply: () => { lastOk = Date.now(); for (const fn of listeners) { try { fn('reply', {}); } catch {} } } });
    W.EventSource = S.makeEventSource({ RealES, base, hub });

    // 点 /api/ 的链接：经通道取回，在 App 里打开
    D.addEventListener('click', e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target?.closest?.('a[href]');
      const path = a && S.linkPath(a.getAttribute('href'), base);
      if (!path) return;
      e.preventDefault(); e.stopPropagation();
      openFile(path);
    }, true);
    async function openFile(path) {
      const bg = el('div', 'oc-viewer'), close = el('button', 'oc-x', '×'), spin = el('i', 'oc-spin');
      close.type = 'button'; close.setAttribute('aria-label', T.close);
      let url = null;
      const shut = () => { bg.remove(); if (url) URL.revokeObjectURL(url); };
      close.onclick = shut;
      bg.append(close, spin); D.body.append(bg);
      let r;
      try { r = await (await channel()).http({ path }, { timeoutMs: 120000 }); lastOk = Date.now(); }
      catch (e) { shut(); return toast(e.message || T.failed); }
      const type = String(r.headers?.['content-type'] || '');
      if (r.status >= 400) { shut(); let j = null; try { j = JSON.parse(r.body); } catch {} return toast(j?.error || T.failed); }
      const name = S.fileName(path, r.headers), blob = new Blob([r.body], { type: type || 'application/octet-stream' });
      url = URL.createObjectURL(blob);
      spin.remove();
      if (S.isImage(type)) {
        const img = el('img'); img.src = url; img.alt = name;
        bg.classList.add('is-image'); bg.append(img);
        bg.addEventListener('click', e => { if (e.target === bg || e.target === img) shut(); });
        return;
      }
      const card = el('div', 'oc-file'), n = el('b', null, name), size = el('small', null, `${Math.max(1, Math.round(blob.size / 1024))} KB`), save = el('button', 'oc-btn is-go', T.save);
      save.type = 'button';
      save.onclick = async () => {
        const file = new File([blob], name, { type: blob.type });
        try { if (W.navigator.canShare?.({ files: [file] })) { await W.navigator.share({ files: [file] }); return shut(); } } catch (e) { if (e?.name === 'AbortError') return; }
        const a = el('a'); a.href = url; a.download = name; D.body.append(a); a.click(); a.remove();
      };
      card.append(n, size, save); bg.append(card);
    }

    // service worker 转来的 /api/ 请求（页面里的 <img src="/api/evidence…"> 这类）
    const sw = W.navigator.serviceWorker;
    if (sw) {
      sw.addEventListener('message', async ev => {
        const m = ev.data, port = ev.ports?.[0];
        if (!m || m.t !== 'offercrew-api' || !port) return;
        try {
          const path = S.apiPath(m.path, base);
          if (!path) throw Error('bad');
          const r = await (await channel()).http({ path });
          lastOk = Date.now();
          const bytes = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body.slice();
          port.postMessage({ status: r.status, type: r.headers?.['content-type'] || '', body: bytes.buffer }, [bytes.buffer]);
        } catch { port.postMessage({ status: 504, type: 'text/plain; charset=utf-8', body: null }); }
      });
      sw.startMessages?.();
    }

    // 每次打开 / 电脑回来：代码包换了就换包、刷新一次
    let checking = false;
    async function checkBundle() {
      if (checking) return;
      checking = true;
      try {
        const h = await hello(); helloP = null;
        const M = shared || (await import('/p/shared.js')), cur = await M.appVersion();
        if (!h?.bundle || h.bundle === cur) return;
        const b = await (await channel()).bundle(cur, { timeoutMs: 120000 });
        if (b.same) return;
        await M.installBundle(b);
        let last = null; try { last = W.sessionStorage.getItem('oc.reloaded'); W.sessionStorage.setItem('oc.reloaded', b.version); } catch {}
        if (last !== b.version) W.location.reload();
      } catch {} finally { checking = false; }
    }
    checkBundle();
    // 中转升级时刷新旧页面、回到前台时检查 service worker 更新（shared.js keepFresh）
    import('/p/shared.js').then(M => M.keepFresh(W)).catch(() => {});

    D.addEventListener('visibilitychange', () => {
      hub.visibility();
      if (D.visibilityState === 'hidden') clientP?.then(c => c.flushReplay()).catch(() => {});
      else checkBundle();
    });
    W.addEventListener('pagehide', () => { clientP?.then(c => c.flushReplay()).catch(() => {}); });
    // 添加到主屏幕时用中转的图标和名字
    D.addEventListener('DOMContentLoaded', () => {
      if (!D.querySelector('link[rel="manifest"]')) { const m = el('link'); m.rel = 'manifest'; m.href = '/manifest.webmanifest'; D.head.append(m); }
      if (!D.querySelector('link[rel="apple-touch-icon"]')) { const i = el('link'); i.rel = 'apple-touch-icon'; i.href = '/icons/apple-touch-icon.png'; D.head.append(i); }
      status();
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
