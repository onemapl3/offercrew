// 增量读收件箱（第 2 批）：只读打开（EXAMINE），从上次读到的地方接着往后读。不删、不移、不改已读状态
// （取信只走 BODY.PEEK，imapflow 自己就这样；这里也不发 STORE / EXPUNGE / MOVE）。
//
//   游标   state/mail-cursor.json：{ address, uidvalidity, last_uid, checked_at }。
//          第一次（或者换了邮箱）只记下现在收件箱读到哪一封，不读以前的信；服务器换了 UIDVALIDITY（编号作废）也一样重新起头。
//   一次   最多读 PER_RUN 封，按 UID 从旧到新；剩下的下一次接着读（more）。每封最多取 MAX_BYTES 字节（BODY.PEEK[]<0.N>），
//          够正文和日历邀请，大附件不下载。游标由调用方在每封信登记完以后再往前挪：中途出错，没登记的下次还会读到。
import { read, write } from '../store.mjs';
import { openInbox, routesFor } from './connect.mjs';
import { toMessage } from './parse.mjs';

export const CURSOR_FILE = 'state/mail-cursor.json';
export const PER_RUN = 25;
export const MAX_BYTES = 512 * 1024;

export const loadCursor = () => read(CURSOR_FILE, null);
export const saveCursor = (c) => write(CURSOR_FILE, c);

// account：{ address, login?, imap_user?, imap, smtp, provider }；provider：lib/mail/providers.mjs 的那一项（Gmail 要它认邮件编号、走代理）。
// 回 { baseline, reset, messages, more, cursor }。cursor 的 last_uid 还是旧的（调用方逐封往前挪），checked_at、uidvalidity 是这一次的。
export async function fetchNew(account, pass, cursor, { provider = null, env = process.env, limits = {}, perRun = PER_RUN, maxBytes = MAX_BYTES, now = new Date() } = {}) {
  const gmail = provider?.provider === 'gmail';
  const { client, box, recovery } = await openInbox(account, pass, { routes: routesFor('imap', account, { provider, env }), limits, ...(account.imap_user ? { users: [account.imap_user] } : {}) });
  try {
    const uidvalidity = String(box.uidValidity);
    const checked_at = now.toISOString();
    // 收件箱里现在最大的 UID：UIDNEXT 减一；服务器没给 UIDNEXT 就取最后一封的 UID。
    let top = Number(box.uidNext) > 0 ? Number(box.uidNext) - 1 : 0;
    if (!top && box.exists > 0) top = Number((await client.fetchOne('*', { uid: true }))?.uid) || 0;
    const fresh = !cursor || cursor.address !== account.address;
    if (fresh || String(cursor.uidvalidity) !== uidvalidity) {
      await client.logout().catch(() => {}); // 兜底：读完了，退出登录失败不影响读到的结果
      return { recovery, baseline: true, reset: !fresh, messages: [], more: false, cursor: { address: account.address, uidvalidity, last_uid: top, checked_at } };
    }
    const last = Number(cursor.last_uid) || 0;
    const next = { ...cursor, uidvalidity, checked_at };
    if (top <= last) { await client.logout().catch(() => {}); /* 兜底：没有新信，退出登录失败不影响结果 */ return { recovery, baseline: false, reset: false, messages: [], more: false, cursor: next }; }
    // UID n:* 在没有更新的信时会回最后一封（「*」就是最大的那个），所以再滤一遍。
    const uids = ((await client.search({ uid: `${last + 1}:*` }, { uid: true })) || []).map(Number).filter((u) => u > last).sort((a, b) => a - b);
    const take = uids.slice(0, perRun);
    const fetched = take.length
      ? await client.fetchAll(take.join(','), { uid: true, envelope: true, internalDate: true, size: true, threadId: gmail, source: { maxLength: maxBytes } }, { uid: true })
      : [];
    await client.logout().catch(() => {}); // 兜底：信已经取回来了，退出登录失败不影响结果
    const messages = [];
    for (const f of fetched.sort((a, b) => a.uid - b.uid)) messages.push(await toMessage(f, { uidvalidity, gmail, maxBytes }));
    return { recovery, baseline: false, reset: false, messages, more: uids.length > take.length, cursor: next };
  } catch (e) {
    try { client.close(); } catch { /* 兜底：连接已经断了；真正的错在下面原样抛出 */ }
    throw e;
  }
}
