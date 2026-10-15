import { read, lines, write, writeLines, patch, hash, root, log } from "../lib/store.mjs";
import { execFileSync } from "../lib/spawn.mjs";
const cursor = read("state/feedback-cursor.json", { seen: [] }),
  seen = new Set(cursor.seen),
  errors = [],
  requests = [];
let applied = 0;
const apply = (raw, source, id) => {
  if (seen.has(id)) return;
  const out = JSON.parse(
    execFileSync(process.execPath, ["bin/apply-feedback.mjs", "--input", raw, "--source", source, "--message-id", id], {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
    }),
  );
  applied += out.applied || 0;
  if (out.uncertain?.length) requests.push({ source, id, raw, uncertain: out.uncertain });
  seen.add(id);
};
// 工作台里排队的反馈交给 apply-feedback；排着的「发」保留你看过的那一版草稿的绑定。
for (const queued of lines("state/feedback.ndjson").filter(e => e.source === "dashboard" && e.status === "queued")) {
  try {
    if (queued.action === "发") {
      const d = lines("state/drafts.ndjson").find(d => d.draft_id === queued.draft_id);
      if (!d || d.displayed_hash !== queued.fingerprint) throw Error("queued_draft_changed");
    }
    apply(queued.raw, "dashboard", queued.message_id);
    const history = lines("state/feedback.ndjson");
    Object.assign(history.find(e => e.id === queued.id), { status: "processed", processed_at: new Date().toISOString() });
    writeLines("state/feedback.ndjson", history);
  } catch (e) { errors.push("dashboard:" + e.message); }
}
// 每条反馈另起一个进程处理（每条最长 3 分钟）：游标在写回前重读，并上这一轮处理过的（lib/store.mjs patch）。
patch("state/feedback-cursor.json", { seen: [] }, (c) => ({ ...c, seen: [...new Set([...(c.seen || []), ...seen])] }));
write("state/feedback-uncertain.json", requests);
console.log(
  JSON.stringify(
    log("pull-feedback", {
      status: applied ? "changed" : errors.length ? "degraded" : "no_change",
      applied,
      errors,
      next_actions: requests,
    }),
  ),
);
