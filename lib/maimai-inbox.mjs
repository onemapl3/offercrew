// Watcher 看脉脉的消息列表（10-01 负责人：「脉脉照 BOSS 的做法只读看列表」）。做法和 BOSS 同一套（lib/list-watch.mjs）：
// 只读列表，未读的对话一律不点开，不点任何按钮、不输入、不发送；基线之后新出现的才算；对得上线索的登记成来信，
// 信上的主按钮「打开脉脉消息」，你自己去回；对不上的合成一封信。
//
// 默认关：《脉脉服务协议》第五条第（6）项不允许用程序读取平台信息。你自己在设置页（发现与匹配）打开 config/pipeline.json 的
// maimai_chat_watch。打开后 09:00–21:00 每两小时一次（09、11、13、15、17、19 点），整点后 35 分钟，和 BOSS（后 5 分钟）错开。
// 碰到验证码或登录墙就停，在收件箱报一封信，不绕；你处理好了点「我处理好了」再接着看。
//
// 列表上分不出最后一句是不是你自己发的：新消息只认未读角标（src.unreadOnly），你回过没有也看不出来，
// 所以「对方在脉脉上回了你」那封信另有「我回过了」。
//
// 「对方主动联系的岗位进线索池」这一段这次不做：src.inbound 留空，接上的时候照 BOSS（lib/boss-inbound.mjs）填
// { candidate, classify, confirm, max }，lib/list-watch.mjs runList 会照样调。
//
// 页面还没核对好（src.verified = false）：10-01 只读核对时，`/web/new-message` 打开的是「通知」页，不是聊天列表，
// 左栏「聊天」没有链接地址（点开才进）。在真页面上确认聊天列表的地址和选择器之前，打开开关也不去看（闸返回 unverified）。
import * as W from './list-watch.mjs';

export const CHAT_URL = 'https://maimai.cn/web/new-message';
export const STATE_PATH = 'state/maimai-inbox.json';

// 列表项的候选选择器：先按名字里常见的几种试，都没有就找「同一个父元素下、样子相同、带时间的一排」（fallback: repeat）。
// 未读：带 badge / unread / dot / count 的元素，有数字用数字，没字的红点算 1。
export const COLLECT = W.makeCollect({
  lists: ['[class*="conversation"] [class*="item"]', '[class*="session-list"] > *', '[class*="chat-list"] > *', '[class*="message-list"] > *', '[class*="msg-list"] > *'],
  badge: '[class*="badge"], [class*="unread"], [class*="dot"], [class*="count"]', nameBox: '[class*="name-box"], [class*="nameBox"]', fallback: 'repeat', dotBadge: true, block: true,
});

export const MAIMAI_SOURCE = {
  id: 'maimai', family: 'maimai', label: '脉脉', listName: '脉脉消息列表', taskName: '看脉脉消息',
  url: CHAT_URL, loginUrl: 'https://maimai.cn/platform/login', statePath: STATE_PATH, pipelineKey: 'maimai_chat_watch', eventSource: 'maimai-chat', askPrefix: 'maimai-chat', stepType: 'maimai_chat',
  evidenceDir: 'maimai-inbox', openLabel: '打开脉脉消息', host: /maimai\.cn/i, sourceName: /脉脉|maimai/i,
  everyHours: 2, slotMinute: 35, waitMs: 12000, unreadOnly: true, baselineOnly: true, verified: false,
  block: { url: 'captcha|verify|security', text: '安全验证|请完成验证|滑动验证|拖动滑块|人机验证|访问异常|验证码' },
  collect: COLLECT,
  inbound: null,
};

export const readChatList = (opts = {}) => W.readChatList(MAIMAI_SOURCE, opts);
export const chatListScript = (opts = {}) => W.chatListScript(MAIMAI_SOURCE, opts);
export const linkConversation = (conv, ctx = {}) => W.linkConversation(MAIMAI_SOURCE, conv, ctx);
export const planInbox = (opts = {}) => W.planInbox(MAIMAI_SOURCE, opts);
export const maimaiInboxGate = (opts = {}) => W.listGate(MAIMAI_SOURCE, opts);
export const maimaiInboxAsks = (opts = {}) => [...W.blockedAsks(MAIMAI_SOURCE, opts), ...W.listAsks(MAIMAI_SOURCE, opts)];
export const ackMaimaiInbox = sig => W.ackList(MAIMAI_SOURCE, sig);
export const resumeMaimaiInbox = () => W.resumeList(MAIMAI_SOURCE);
export const watchEnabled = pipeline => W.listEnabled(MAIMAI_SOURCE, pipeline);
export const runMaimaiInbox = (opts = {}) => W.runList(MAIMAI_SOURCE, opts);
