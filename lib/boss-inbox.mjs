// Watcher 看 BOSS 直聘的聊天列表（09-30 负责人：「BOSS 上很多给我发消息的，这些并没有转发到系统里面」）。
//
// 只读：在 ego 浏览器里打开 https://www.zhipin.com/web/geek/chat，读列表上每个对话的「谁、最后一句、未读数、
// 最后一句是不是你自己发的（[送达] / [已读]）」，然后关掉这个任务空间。**从不点开对话**（点开就把消息标成已读），
// 不点任何按钮、不输入、不发送。脚本里只有 goto、waitForTimeout、evaluate、finish（tests/boss-inbox.test.mjs 看着）。
//
// 招聘方主动找你、对不上线索的新对话另走 lib/boss-inbound.mjs（没读的不点开；你读过之后才点开看岗位、交给 Judge）。
//
// 默认关：BOSS 的用户协议禁止自动化访问（渠道包照实写着：岗位入口你自己开，聊天列表另有开关、默认关）。你自己在设置页（发现与匹配）
// 打开 config/pipeline.json 的 boss_chat_watch。打开后每小时一次，时段和收件箱巡检一样（MAIL_POLL_HOURS），
// 只在 BOSS 记为已登录、Watcher 没暂停、不在沙盒里的时候跑（bossInboxGate）。
//
// 读到的新消息走邮件回复的同一条路：对得上线索的，登记成一条来信（state/inbox-events.ndjson，category 回复），
// 线索记为已回复（lib/inbox.mjs recordReply）——Watcher 的「对方回复了」那封信、线索状态、手机推送都照旧；
// 信上多一个「打开 BOSS 聊天」，你自己去回（系统不在 BOSS 上代发）。对不上线索的合成一封信，列出谁 · 公司 · 最后一句。
// 你回过之后（列表上最后一句变成你的），那封信自己收起。状态在 state/boss-inbox.json，同一句话不会提第二次。
//
// 做法和脉脉的消息列表（lib/maimai-inbox.mjs）是同一套：lib/list-watch.mjs。这里是 BOSS 那一份说明，外加「对方主动找你」这一段。
import * as W from './list-watch.mjs';
import { classifyInbound, confirmInbound, MAX_PER_ROUND, CHAT_URL, STATE_PATH } from './boss-inbound.mjs';

export { CHAT_URL, STATE_PATH }; // 定义在 lib/boss-inbound.mjs
export const DEFAULT_HOURS = W.DEFAULT_HOURS; // 与 lib/app-schedule.mjs MAIL_POLL_HOURS 相同（测试核对）

export const parseChatItem = W.parseChatItem;
export const conversationKey = c => W.conversationKey('boss', c);
export const isNew = W.isNew;
export const hasBaseline = W.hasBaseline;

// 页面里跑的收集函数：只拿每一项的文字、未读角标、名字行，交给 parseChatItem，带回字段（不带页面内容）。
export const COLLECT = W.makeCollect({ lists: ['.user-list li', '.chat-user li', '[class*="user-list"] li', '[class*="friend-list"] li'], badge: '.notice-badge', nameBox: '.name-box, [class*="name-box"]', fallback: 'li' });

// BOSS 这一份说明（lib/list-watch.mjs 的 src）。每小时一次，整点后 5 分钟（bin/serve.mjs 传 minute）。
export const BOSS_SOURCE = {
  id: 'boss', family: 'boss', label: 'BOSS 直聘', listName: 'BOSS 聊天列表', taskName: '看 BOSS 消息',
  url: CHAT_URL, statePath: STATE_PATH, pipelineKey: 'boss_chat_watch', eventSource: 'boss-chat', askPrefix: 'boss-chat', stepType: 'boss_chat',
  evidenceDir: 'boss-inbox', openLabel: '打开 BOSS 聊天', host: /zhipin\.com/i, sourceName: /boss/i,
  everyHours: 1, slotMinute: 5, collect: COLLECT,
};

export const chatListScript = (opts = {}) => W.chatListScript(BOSS_SOURCE, opts);
export const readChatList = (opts = {}) => W.readChatList(BOSS_SOURCE, opts);
export const linkConversation = (conv, ctx = {}) => W.linkConversation(BOSS_SOURCE, conv, ctx);

// 招聘方主动找你（lib/boss-inbound.mjs）的候选：上次看过之后新冒出来的、有未读、最后一句是对方的、对不上线索。
// 第一次看（还没有底）一个都不算：那一眼就是底。
export const inboundCandidate = (c, { state = {}, leads = [], outbound = [] } = {}) =>
  hasBaseline(state) && !state.conversations?.[c.key] && c.unread > 0 && !c.from_me && !linkConversation(c, { leads, outbound });
// lib/boss-inbound.mjs 和这里互相引用：用到的时候再取（模块加载的先后不影响）。
BOSS_SOURCE.inbound = { candidate: inboundCandidate, classify: (c, ctx) => classifyInbound(c, ctx), confirm: opts => confirmInbound(opts), get max() { return MAX_PER_ROUND; } };

export const planInbox = (opts = {}) => W.planInbox(BOSS_SOURCE, opts);
export const applyPlan = (plan, opts = {}) => W.applyPlan(BOSS_SOURCE, plan, opts);
export const bossInboxGate = (opts = {}) => W.listGate(BOSS_SOURCE, opts);
export const bossInboxAsks = (opts = {}) => W.listAsks(BOSS_SOURCE, opts);
export const ackBossInbox = sig => W.ackList(BOSS_SOURCE, sig);

// 开关：config/pipeline.json boss_chat_watch（默认关）。force = 操作台手动点的：不管到没到点、在不在时段，其余的闸照旧。
export const watchEnabled = pipeline => W.listEnabled(BOSS_SOURCE, pipeline);
export const runBossInbox = (opts = {}) => W.runList(BOSS_SOURCE, opts);
