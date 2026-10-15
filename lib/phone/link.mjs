import { noteSwallowed } from '../swallow.mjs';
// 电脑到中转的那一条连接：只往外连（不开端口），断了自己重连（1 秒起，翻倍，最长 1 分钟，带一点随机）。
// 连上后先发 { t: 'auth', token }，中转回 { t: 'ok' } 才算在线；心跳是纯文本 ping / pong（中转那边自动应答，不唤醒房间）。
// 状态：off（没开）→ connecting → online；掉线后 offline，等着重连。
export class RelayLink {
  constructor({ url, token, WebSocketImpl = globalThis.WebSocket, onMessage = () => {}, onState = () => {}, pingMs = 30000, pongMs = 10000 }) {
    Object.assign(this, { url, token, WS: WebSocketImpl, onMessage, onState, pingMs, pongMs });
    this.state = 'off'; this.ws = null; this.stopped = true; this.backoff = 1000; this.timers = new Set(); this.denied = false;
  }
  set(state) { if (this.state !== state) { this.state = state; try { this.onState(state); } catch (e) { noteSwallowed('phone.linkState', e, { doing: `记下中转连接变成 ${state}`, then: '连接照常' }); } } }
  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); t.unref?.(); this.timers.add(t); return t; }
  start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear(); clearInterval(this.pinger);
    try { this.ws?.close(1000, 'bye'); } catch {} // 兜底：连接已经断了
    this.ws = null; this.set('off');
  }
  connect() {
    if (this.stopped) return;
    this.set(this.state === 'offline' ? 'offline' : 'connecting');
    let ws;
    try { ws = new this.WS(this.url); } catch { return this.retry(); }
    this.ws = ws;
    let waitingPong = null;
    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ t: 'auth', token: this.token })); } catch {} // 兜底：发不出去说明连接正在断，close 事件会接着重连
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (waitingPong) return;
        try { ws.send('ping'); } catch {} // 兜底：发不出去说明连接正在断，close 事件会接着重连
        waitingPong = setTimeout(() => { try { ws.close(4008, 'no_pong'); } catch {} }, this.pongMs); // 兜底：连接已经断了
        waitingPong.unref?.();
      }, this.pingMs);
      this.pinger.unref?.();
    });
    ws.addEventListener('message', ev => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (data === 'pong') { clearTimeout(waitingPong); waitingPong = null; return; }
      let m; try { m = JSON.parse(data); } catch { return; } // 兜底：不是 JSON 的帧（中转的心跳回声之类）跳过
      if (m.t === 'ok') { this.backoff = 1000; this.denied = false; this.set('online'); }
      if (m.t === 'denied') this.denied = true;
      try { this.onMessage(m); } catch (e) { noteSwallowed('phone.linkMessage', e, { doing: '处理中转转来的一条手机消息', then: '这一条没处理，手机那头会超时重试' }); }
    });
    const down = () => {
      clearInterval(this.pinger); clearTimeout(waitingPong); waitingPong = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return this.set('off');
      this.set('offline'); this.retry();
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', () => { try { ws.close(); } catch {} down(); }); // 兜底：连接已经断了，down() 接着重连
  }
  retry() {
    if (this.stopped) return;
    const wait = Math.min(this.denied ? 60000 : this.backoff, 60000) * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(this.backoff * 2, 60000);
    this.later(() => this.connect(), wait);
  }
  send(msg) {
    if (this.state !== 'online' || !this.ws) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch { return false; } // 兜底：发不出去照实回 false，调用方按没发出去处理
  }
}
