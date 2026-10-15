import { event } from "../lib/events.mjs";
import { bindSend,bindSendBatch } from "../lib/drafts.mjs";
import { lines, writeLines, arg, text, optionalText, write, log } from "../lib/store.mjs";
import { parseFeedback, updatedLead, PRESET_PASS_REASONS } from "../lib/feedback.mjs";
const input = arg("--input") || (arg("--file") ? text(arg("--file")) : null);
if (!input) throw Error("input_required");
const leads = lines("state/leads.ndjson"),
  history = lines("state/feedback.ndjson");
// 「发 N」「发 N, M」：先按首联保护、给你看过的那一版核一遍（lib/drafts.mjs bindSend），再和别的入口一样走 requestAction——
// 过闸（渠道关着、资料不全……）、按那一版的指纹记批准、叫醒发信。以前只往发送请求里加一行，App 里没有动作接它。
const requests = lines("state/send-requests.ndjson");
const batch = bindSendBatch(input, arg("--source", "codex"), arg("--message-id"), lines("state/drafts.ndjson"), requests, lines("state/outbound.ndjson"));
const single = batch ? null : bindSend(input, arg("--source", "codex"), arg("--message-id"), lines("state/drafts.ndjson"), requests, lines("state/outbound.ndjson"));
if (batch || single) {
  const { requestAction } = await import("../lib/action-kinds.mjs");
  const out = [];
  for (const b of batch || [single]) {
    if (b.duplicate) { out.push({ ...b, status: "already_recorded" }); continue; }
    const r = await requestAction("send", { draft_id: b.draft_id }, { origin: "chat", confirm: b.fingerprint });
    out.push({ draft_id: b.draft_id, number: b.number, status: r.blocked ? "blocked" : r.needs_confirm ? "changed" : r.duplicate ? "already_recorded" : "queued", ...(r.reason ? { reason: r.reason } : {}) });
  }
  const queued = out.filter(x => x.status === "queued").length;
  event("postman", "send-authorization", queued ? "ok" : "skip", queued ? `发送批准记下了 ${queued} 份，排上发送` : "这几份已经批准过或者没批准成", single ? { lead_id: single.record_id } : {});
  console.log(JSON.stringify(log("send-authorization", { applied: 0, uncertain: [], status: queued ? "queued" : "already_recorded", queued, results: out, ...(batch ? { numbers: batch.map(r => r.number) } : { draft_id: single.draft_id }) })));
  process.exit(0);
}
const parsed = parseFeedback(input, leads, { source: arg("--source", "codex"), message_id: arg("--message-id") });
const fresh = parsed.events.filter((e) => !history.some((x) => x.id === e.id && x.status === "applied"));
const stale = history.filter(e => e.status === "pending" && Date.parse(e.at) < Date.now() - 60000);
const groups = new Map();
for (const e of [...stale, ...fresh]) {
  const key = JSON.stringify([e.record_id, e.action]);
  if (!groups.has(key)) groups.set(key, []);
  if (!groups.get(key).some(x => x.id === e.id)) groups.get(key).push(e);
}
const pending = [...groups.values()].map(rows => rows.sort((a,b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)).sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
let applied = 0;
const decided = []; // 这次真正生效的决定（回执按它写：不推进要说清楚记没记原因）
for (const e of pending) {
  const old = history.find((x) => x.id === e.id);
  if (!old) history.push(e);
  writeLines("state/feedback.ndjson", history);
  const i = leads.findIndex((l) => (l.record_id || l.id) === e.record_id);
  if (i < 0) {
    event("user", "feedback-retry", "warn", "反馈对应的线索不存在", { lead_id: e.record_id, record_id: e.record_id });
    continue;
  }
  const duplicates = groups.get(JSON.stringify([e.record_id, e.action]));
  // Old retries must not undo a more recent decision for this lead.
  const superseded = stale.some(x => x.id === e.id) && history.some(x => x.record_id === e.record_id && x.status === "applied" && Date.parse(x.at) >= Date.parse(e.at));
  const next = superseded ? leads[i] : updatedLead(leads[i], e);
  leads[i] = next;
  writeLines("state/leads.ndjson", leads);
  for (const row of duplicates) {
    const saved = history.find(x => x.id === row.id);
    if (saved) saved.status = "applied";
    else history.push({ ...row, status: "applied" });
  }
  writeLines("state/feedback.ndjson", history);
  event("user", "feedback-applied", "ok", `${e.number} ${e.action} 已处理`, { lead_id: e.record_id });
  applied++;
  if (!superseded && fresh.some(x => x.id === e.id)) decided.push({ number: e.number ?? leads[i].number ?? null, company: leads[i].company || '', action: e.action, reason: e.reason || '' });
  // 固定原因（方向不对、城市不对……）不写进 profile.md：一行没有上下文的「方向不对」会被匹配模型当成全局规则。
  // 它们留在 state/feedback.ndjson（带公司、岗位），学偏好从那里读；你自己写的原因照旧记成排除规则。
  if (!superseded && e.action === "pass" && e.reason && !PRESET_PASS_REASONS.has(e.reason.trim())) {
    const rule = `- ${e.reason}（用户反馈 ${e.id.slice(0, 12)}）`;
    let profile = optionalText("candidate/profile.md");
    if (!profile.includes(rule))
      write("candidate/profile.md", profile + (profile.includes("## 用户排除规则") ? "\n" : "\n## 用户排除规则\n") + rule + "\n");
  }
  const acknowledgements = lines("state/inbox-events.ndjson");
  if (!acknowledgements.some(a => a.message_id === e.id)) {
    acknowledgements.push({ message_id: e.id, category: "用户反馈", summary: `已收到：${e.number} ${e.action}${e.reason ? " · " + e.reason : ""}`, at: e.at });
    writeLines("state/inbox-events.ndjson", acknowledgements);
  }
}
console.log(JSON.stringify(log("feedback", { applied, uncertain: parsed.uncertain, decided })));
