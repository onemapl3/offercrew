// Verified against the Maimai friend-note validation receipt (2026-09-28).
export const MAIMAI_FRIEND_LIMIT = 50;
// 各渠道正文的字数上限（按字符数，含标点）：起草、批准、发出三处同一份（lib/drafts.mjs、lib/asks.mjs draftAsk、bin/send-dm.mjs）。
export const CHANNEL_LIMITS = { maimai_friend_request: MAIMAI_FRIEND_LIMIT, platform_dm: 300, platform_application: 1500 };
