import { lines, writeLines, arg, read, write, text, optionalText, log } from "../lib/store.mjs";
const record = arg("--record"),
  lead = lines("state/leads.ndjson").find((l) => l.record_id === record || l.id === record || String(l.number) === record);
if (!lead) throw Error("record_missing");
const input = arg("--input");
if (!input) throw Error("verified_interview_details_required");
const details = read(input);
if (!details.round || !details.at || !Number.isFinite(Date.parse(details.at))) throw Error("interview_time_and_round_required");
const path = `runs/interviews/${(lead.company + "-" + details.round).replace(/[^\p{L}\p{N}_-]/gu, "_")}.md`;
write(
  path,
  `# ${lead.company} · ${details.round}\n\n时间：${details.at}\n形式：${details.format || "待确认"}\n面试官：${details.interviewer || "待确认"}\n\n## JD\n${lead.jd_text}\n\n## 简历对应证据\n${(lead.match?.reasons || lead.reasons || []).join("\n")}\n\n## 准备问题\n- 解释最相关的Agent/后端项目、本人职责和技术取舍。\n- 准备讨论已识别缺口：${lead.match?.biggest_gap || lead.biggest_gap || "待核"}。\n\n## 复盘\n${details.review || "面试后用户提供。"}\n`,
);
if (details.review) {
  const rules = details.strengthen || [];
  if (rules.length)
    write("candidate/profile.md", optionalText("candidate/profile.md") + "\n## 待补强\n" + rules.map((s) => "- " + s).join("\n") + "\n");
}
const next = {
  type: "google_calendar_connector",
  operation: "create_event",
  summary: `${lead.company} · ${details.round}`,
  start: details.at,
  end: details.end || null,
  attendees: [],
  notes: "Do not invite interviewers; personal calendar only. Confirm timezone/end before creating.",
  record_id: lead.record_id || lead.id,
};
write("state/interview-request.json", next);
console.log(
  JSON.stringify(log("interview", { status: "prepared", path, next_actions: [next], base_update: { 面试记录: JSON.stringify(details) } })),
);
