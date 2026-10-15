// 发信没发成时说的话（lib/mail/send.mjs、lib/workers.mjs、收件箱的信共用；不引 nodemailer）。
// 连不上发信服务器时最多试几次（每次隔 RETRY_MS），满了落成失败交给你。
export const SEND_TRIES = 3, RETRY_MS = 10 * 60000;
// 没连上的原因：先取发信那一步写下的第一句（lib/mail/connect.mjs explainAttempts：哪条线路、什么现象，直连被拦还是代理没开）；
// 没写下的（旧版升级上来的）按类别说一句短的。
export const KIND_WORDS = { timeout: '连不上发信服务器（超时），可能是网络或代理挡住了发信端口', network: '连不上发信服务器，看看网络', proxy: '代理连不上，看看代理软件开着没有', tls: '和发信服务器的加密连接没建立起来', auth: '邮箱的授权码不对或者失效了', throttle: '邮箱说登录太频繁了' };
// 旧版没记下原因的（升级上来的旧失败）：照实说不知道，不编。
export const UNKNOWN_WHY = '旧版没记下当时为什么没发出去';
export const sendWhy = r => String(String(r?.last_reason || '').split('。')[0] || KIND_WORDS[r?.last_error] || KIND_WORDS[r?.reason] || '连不上发信服务器').replace(/[。\s]+$/, '');
// 试满了、落成失败那一句（卡上、动作的原因）。
export const gaveUpLine = r => `${r?.tries ? `试了 ${r.tries} 次都没发出去` : '没发出去'}：${sendWhy(r)}`;
