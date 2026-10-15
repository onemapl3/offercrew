import { arg, log } from "../lib/store.mjs";
import { loadAccount } from "../lib/mail/vault.mjs";
import { noteSwallowed } from '../lib/swallow.mjs';
// 接了内置邮箱：Writer 用引擎自己的模型起草（lib/mail/draft.mjs，同一套挑法），草稿直接进收件箱等你批准，不交给 Codex 建 Gmail 草稿。
if (loadAccount()) {
  const { draftFirstContacts, draftReplies, reviseDrafts } = await import("../lib/mail/draft.mjs");
  let r;
  try { r = await draftFirstContacts({ record: process.argv.includes("--pending") ? null : arg("--record") }); } catch (e) { r = { status: "failed", error: String(e.message || e).slice(0, 160) }; }
  // 「改 N」「N 备注」交给 Writer 的那几封也在这一步写（周期里紧跟在你说完之后跑）。
  if (process.argv.includes("--pending")) { try { r.revised = (await reviseDrafts()).revised; r.replies = (await draftReplies()).drafted; } catch (e) { noteSwallowed('reach.pending', e, { member: 'quill', doing: '改等你看的草稿、起回信草稿', then: '这一轮先不改，下一轮再做' }); } }
  console.log(JSON.stringify(log("reach", { via: "builtin-mail", ...r })));
} else {
  // 没接邮箱：没人能起草邮件（命令行版交给 Gmail 连接器的那条路 10-04 删掉了）。
  console.log(JSON.stringify(log("reach", { status: "no_change", reason: "mail_not_connected" })));
}
