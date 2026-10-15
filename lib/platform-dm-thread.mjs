// What the conversation says, not what the button said (2026-09-30).
//
// bin/send-dm.mjs used to decide "new or existing BOSS conversation" from the
// label of the button it managed to click. The label is only a hint: whether a
// conversation is new is read from the conversation itself once it is open (are
// there older messages, messages from the other side, more than the one greeting
// the platform sends on 「立即沟通」), and whether our message went out is read
// back from the thread after 「发送」.
//
// The functions below run in two places: here (unit tests) and inside the
// ego-browser page script, where send-dm injects their source. Keep each one
// self-contained: no imports, no module-level references except the other
// functions in THREAD_HELPERS.

export function normText(s) {
  return String(s || '').replace(/\s+/g, '');
}

// The part of the approved body we look for in the thread. Whitespace is dropped
// on both sides because innerText re-wraps long messages.
export function probeOf(body) {
  return normText(body).slice(0, 24);
}

export function countProbe(text, probe) {
  if (!probe) return 0;
  return normText(text).split(probe).length - 1;
}

// BOSS chat timestamps: "23:12" (today), "09-22 16:21", "昨天 10:02", "星期三",
// "09月28日", "2026-09-22 16:21". Returns epoch ms in local time, or null.
export function parseChatTime(s, now = Date.now()) {
  const t = String(s || '').trim();
  const base = new Date(now);
  const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
  let m;
  if ((m = t.match(/^(\d{1,2}):(\d{2})$/))) return at(base.getFullYear(), base.getMonth() + 1, base.getDate(), +m[1], +m[2]);
  if ((m = t.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?$/))) return at(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  if ((m = t.match(/^(\d{1,2})(?:-|月)(\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    let v = at(base.getFullYear(), +m[1], +m[2], +(m[3] || 0), +(m[4] || 0));
    if (v > now + 86400000) v = at(base.getFullYear() - 1, +m[1], +m[2], +(m[3] || 0), +(m[4] || 0));
    return v;
  }
  if (/^昨天/.test(t)) return now - 86400000;
  if (/^(?:星期|周)[一二三四五六日天]$/.test(t)) return now - 2 * 86400000;
  return null;
}

const TIME_LINE = /^(?:\d{1,2}:\d{2}|\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?|\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|昨天(?:\s+\d{1,2}:\d{2})?|(?:星期|周)[一二三四五六日天])$/;

// Fallback when no message nodes could be read from the DOM: the open
// conversation on BOSS's chat page is the text after the last 「查看职位」 (the
// job card at the top of the pane) and before the composer. A line 「送达」 or
// 「已读」 is the delivery status of one of OUR messages and precedes its text;
// a time line applies to the messages below it. The other side's messages carry
// no marker in text, so this reader never claims one ("them" comes only from DOM).
export function paneTextItems(text) {
  const TIME = TIME_LINE;
  const all = String(text || '');
  const start = all.lastIndexOf('查看职位');
  if (start < 0) return { items: [], times: [] };
  let pane = all.slice(start + 4);
  for (const end of ['按Enter键发送', '\n发简历\n']) { const i = pane.indexOf(end); if (i >= 0) pane = pane.slice(0, i); }
  const items = [], times = [];
  let time = null, mine = false;
  for (const raw of pane.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (TIME.test(line)) { time = line; times.push(line); continue; }
    if (/^(?:送达|已读|未读)$/.test(line)) { mine = true; continue; }
    if (mine) { items.push({ side: 'me', text: line.slice(0, 600), time }); mine = false; }
  }
  return { items, times };
}

// New or existing conversation, from what the open conversation shows.
//   existing: a message from the other side, anything older than ten minutes
//             before we clicked, or two or more of our own messages;
//   new:      exactly one message of ours, sent just now: the greeting the
//             platform sends itself when 「立即沟通」 opens a conversation;
//   unknown:  nothing readable.
// With DOM and text readings both present, "existing" from either wins: a
// greeting is recorded only when nothing on the page contradicts it.
// `exclude` drops messages containing our own body (used to re-read after send).
export function classifyThread({ dom = [], text = '', clickedAt = Date.now(), now = Date.now(), exclude = '' } = {}) {
  const keep = (i) => !(exclude && normText(i.text).includes(exclude));
  const sources = [];
  const domItems = (Array.isArray(dom) ? dom : []).filter(keep);
  if (domItems.length) sources.push({ source: 'dom', items: domItems, times: domItems.map((i) => i.time).filter(Boolean) });
  const fromText = paneTextItems(text);
  const textItems = fromText.items.filter(keep);
  if (textItems.length || fromText.times.length) sources.push({ source: 'text', items: textItems, times: fromText.times });
  const verdicts = sources.map((s) => {
    const mine = s.items.filter((i) => i.side === 'me');
    const theirs = s.items.filter((i) => i.side === 'them');
    const older = s.times.map((t) => parseChatTime(t, now)).filter((t) => t != null && t < clickedAt - 10 * 60000);
    const state = theirs.length || older.length || mine.length >= 2 ? 'existing' : mine.length === 1 ? 'new' : 'unknown';
    return { source: s.source, state, mine: mine.length, theirs: theirs.length, older: older.length, greeting: state === 'new' ? { text: mine[0].text, time: mine[0].time || null } : null };
  });
  const pick = verdicts.find((v) => v.state === 'existing') || verdicts.find((v) => v.state === 'new') || verdicts[0];
  return pick ? { ...pick, readings: verdicts.map(({ greeting, ...v }) => v) } : { source: null, state: 'unknown', mine: 0, theirs: 0, older: 0, greeting: null, readings: [] };
}

// 对账只认原对话中我方完整正文。没找到不等于没发：必须读到最新端，
// 而且仍能看到上次发送前的消息锚点，证明这次读取覆盖了那一次尝试。
export function deliveryEvidence(pane, body, context = null) {
  const items = Array.isArray(pane?.dom) ? pane.dom : [];
  const exact = normText(body);
  // DOM 的正文可能带时间/送达标记；要求完整正文，不用 24 字前缀或整个页面的聊天列表预览。
  const found = exact && items.some(i => i.side === 'me' && !i.pending && normText(i.text).includes(exact));
  if (found) return 'found';
  if (!pane?.ready || items.some(i => i.pending) || !pane.atBottom || !context?.anchor || !items.length) return 'unknown';
  const a = context.anchor;
  return items.some(i => !i.pending && i.side === a.side && i.text === a.text && i.time === a.time) ? 'absent' : 'unknown';
}
export function deliveryContext(pane) {
  if (!pane?.ready || !pane.atBottom || pane.dom?.some(i => i.pending)) return null;
  const anchor = (pane.dom || []).filter(i => ['me','them'].includes(i.side)).at(-1);
  return anchor ? { anchor } : null;
}

// Injected into the page script, in dependency order.
export const THREAD_HELPERS = [normText, probeOf, countProbe, parseChatTime, paneTextItems, classifyThread, deliveryEvidence, deliveryContext]
  .map((f) => f.toString())
  .join('\n')
  .replace('const TIME = TIME_LINE;', `const TIME = ${TIME_LINE.toString()};`);

// Browser-side reads (page.evaluate). Each carries a /*radar:…*/ tag so a fake
// page in the tests can answer it.
//
// Which of the two BOSS labels are on the job page, visible or not. Only a hint,
// kept in the receipt: 09-30 the send stopped on 「继续沟通」 and nobody could
// tell afterwards whether that label was the visible button.
export const READ_BUTTONS = String.raw`/*radar:buttons*/(() => {
  const labels = ['立即沟通', '继续沟通'];
  const out = { visible: [], hidden: [] };
  for (const el of document.querySelectorAll('a, button, span, div')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!labels.includes(own)) continue;
    (el.getClientRects().length ? out.visible : out.hidden).push(own);
  }
  return out;
})()`;

// The open conversation: message nodes inside a conversation container when the
// page has them, plus the whole page text for the text reading above.
export const READ_PANE = String.raw`/*radar:pane*/(() => {
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const target = /*radar:target*/'';
  const urlKey = u => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  const bubbles = [...document.querySelectorAll('.msg-overlay-conversation-bubble, .msg-convo-wrapper')].filter(vis);
  const peerLinks = el => [...el.querySelectorAll('.msg-overlay-bubble-header a[href*="/in/"], .msg-thread__link-to-profile[href*="/in/"], .msg-conversation-card__profile-link[href*="/in/"]')].map(a => a.href);
  const bubble = bubbles.find(b => peerLinks(b).some(u => urlKey(u) === urlKey(target)));
  const box = bubble ? bubble.querySelector('.msg-s-message-list, .msg-s-message-list-content') : [...document.querySelectorAll('.chat-conversation, .chat-record, .im-list')].find(vis);
  let dom = [];
  if (box) {
    const nodes = [...box.querySelectorAll('li.message-item, .im-list > li, [class*="message-item"], .msg-s-message-group')].filter(vis);
    const top = nodes.filter((n) => !nodes.some((m) => m !== n && m.contains(n)));
    const sideOf = (el) => {
      const c = [el, ...el.querySelectorAll('[class]')].map((x) => String(x.className || '')).join(' ');
      return /myself|item-self|message-group--is-self|\bself\b|\bmine\b/.test(c) ? 'me' : /friend|item-boss|\bother\b/.test(c) ? 'them' : /system|notice|\btip\b/.test(c) ? 'system' : 'unknown';
    };
    const timeOf = (el) => { const t = el.querySelector('.time, .message-time, [class*="time"]'); return t ? t.innerText.trim() : null; };
    dom = top.map((el) => {
      const text = (el.innerText || '').trim();
      let side = sideOf(el);
      if (side === 'unknown' && /(^|\n)(送达|已读)(\n|$)/.test(text)) side = 'me';
      const pending = /sending|pending|send-fail|send-error/.test(String(el.className || '')) || !![...el.querySelectorAll('[class*="loading"], [class*="send-error"], [class*="send-fail"]')].find(vis);
      return { side, text, time: timeOf(el), pending };
    }).filter((i) => i.text).slice(-40);
  }
  // 只把能读到最新端、没有加载中提示的消息容器用于“不存在”的证据。
  let scroll = box;
  while (scroll && scroll !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
  const atBottom = !!scroll && scroll !== document.body && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4;
  const loading = box && [...box.querySelectorAll('[class*="loading"], [aria-busy="true"]')].some(vis);
  return { dom, peer_urls: bubble ? peerLinks(bubble) : [], ready: !!box && !loading, atBottom, text: document.body.innerText };
})()`;

// Whatever is still sitting in a message box: text there is typed, not sent.
export const READ_COMPOSER = String.raw`/*radar:composer*/[...document.querySelectorAll('[contenteditable="true"], textarea')].map((el) => el.value ?? el.innerText ?? '').join('\n')`;
