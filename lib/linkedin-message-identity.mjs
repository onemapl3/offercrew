// 邮件是网页消息的补充来源；只在原线程、发件人、时间和原文开头都一致时合并。
export function linkedinThread(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:' || !/^(?:www\.)?linkedin\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:comm\/)?messaging\/thread\/([^/]+)\/?$/);
    return m && /^[A-Za-z0-9_=%.,:()-]+$/.test(m[1]) ? `https://www.linkedin.com/messaging/thread/${m[1]}/` : null;
  } catch { return null; } // 兜底：非线程网址不能作身份，调用方会显示无法关联。
}
export const messageText = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
export const personKey = s => messageText(s).toLowerCase();
export function sameLinkedInNotification(event, { url, name, first, at } = {}) {
  if (!linkedinThread(url) || linkedinThread(event.thread_url || event.url) !== linkedinThread(url)) return false;
  if (personKey(event.from) !== personKey(name) || !personKey(name)) return false;
  const a = messageText(event.body || event.message_preview), b = messageText(first);
  if (!a || !b || Math.min(a.length, b.length) < 12 || !(a.startsWith(b) || b.startsWith(a))) return false;
  const x = Date.parse(event.sent_at || event.at || event.observed_at), y = Date.parse(at);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 24 * 3600000;
}
