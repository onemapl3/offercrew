// 很小的 Chrome DevTools 协议客户端，用 node 自带的 WebSocket。专用 Chrome（lib/browser-host.mjs）
// 只靠它做几件简单的事：开标签页、导航、在页面里读几个是 / 否、把窗口拉到前面、关浏览器。
//
// 只连 127.0.0.1：地址不是本机回环就不连。HTTP 请求不走代理（agent: false）——环境里配了代理，
// 发往本机调试端口的请求也不该绕出去。
//
// 页面级的命令走「扁平会话」（Target.attachToTarget flatten:true）：同一条连接上带 sessionId 发。
// 用这种办法，只碰我们自己开的那个标签页，不去挂别的标签页（你正在登录的那一页不会被注入任何东西）。
import http from 'node:http';

const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/(browser|page)\/[\w-]+$/;

// GET http://127.0.0.1:<port><path>，读 JSON（/json/version 之类）。
export function getJson(port, pathname, { timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: Number(port), path: pathname, agent: false, timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 4e6) req.destroy(Error('cdp_http_too_big')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error(`cdp_http_${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(Error('cdp_http_timeout')));
    req.on('error', reject);
  });
}

export async function connectCdp(wsUrl, { timeout = 10000 } = {}) {
  if (!LOOPBACK_WS.test(String(wsUrl || ''))) throw Error('cdp_not_loopback');
  if (typeof WebSocket !== 'function') throw Error('cdp_no_websocket：这个 node 没有自带 WebSocket（要 node 22 以上）');
  const ws = new WebSocket(wsUrl);
  let seq = 0, closed = false;
  const pending = new Map(), listeners = new Set();
  const fail = err => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); } pending.clear(); };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(Error('cdp_connect_timeout')); }, timeout); // 兜底：连接没建起来就关不掉，照样报超时
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Error('cdp_connect_failed')); };
  });
  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; } // 兜底：不是 JSON 的帧跳过
    if (m.id != null) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(Error(`${p.method}: ${m.error.message || 'cdp_error'}`), { cdp: m.error }));
      else p.resolve(m.result || {});
      return;
    }
    for (const fn of [...listeners]) { try { fn(m); } catch {} } // 兜底：一个监听出错不影响别的监听和这条连接
  };
  ws.onclose = () => { closed = true; fail(Error('cdp_closed')); };
  ws.onerror = () => {};

  const send = (method, params = {}, { session = null, timeout: t = 30000 } = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(Error('cdp_closed'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`cdp_timeout:${method}`)); }, t);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  // 等一个事件：method 对上、session 对上、pred（可选）为真。超时报 cdp_wait_timeout；
  // 不等了就调返回值上的 cancel()（按 null 结束），免得监听一直挂着。
  const waitFor = (method, { session = null, pred = null, timeout: t = 30000 } = {}) => {
    let fn, timer, settle;
    const promise = new Promise((resolve, reject) => {
      const off = () => { listeners.delete(fn); clearTimeout(timer); };
      settle = v => { off(); resolve(v); };
      fn = m => { if (m.method === method && (session == null || m.sessionId === session) && (!pred || pred(m.params || {}))) settle(m.params || {}); };
      timer = setTimeout(() => { off(); reject(Error(`cdp_wait_timeout:${method}`)); }, t);
      listeners.add(fn);
    });
    promise.cancel = () => settle(null);
    return promise;
  };
  const on = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const close = () => { if (closed) return; closed = true; try { ws.close(); } catch {} fail(Error('cdp_closed')); }; // 兜底：连接已经断了
  return { send, waitFor, on, close, get closed() { return closed; } };
}
