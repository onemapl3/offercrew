import { leadState, archivedLead } from './lead-state.mjs';
export function metrics(leads, outbound = [], feedback = [], now = new Date()) {
  const active = leads.filter((l) => !archivedLead(l) && !l.superseded && !l.prefilter_reason && l.match?.verdict !== "exclude");
  const tally = (rows, key) => {
    const out = {};
    for (const r of rows) {
      const k = r[key] || "unknown";
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  };
  const recent = (at) => at && new Date(at) >= new Date(now - 7 * 86400000) && new Date(at) <= now;
  const sourceFor = (id) => leads.find((l) => (l.record_id || l.id) === id)?.source || "unknown";
  const weekOut = outbound.filter((o) => recent(o.at)),
    newLeads = leads.filter((l) => !l.legacy && !l.superseded && recent(l.discovered_at)),
    weekFeedback = feedback.filter((f) => recent(f.at) && f.status === "applied");
  const contacted = new Set(outbound.filter((o) => ["email", "dm"].includes(o.channel)).map((o) => o.record_id));
  const replied = leads.filter((l) => ["replied", "interview_scheduled", "interview_done", "offer"].includes(leadState(l)));
  return {
    total: leads.length,
    active: active.length,
    tracked_active: active.filter((l) => l.record_id).length,
    archived: leads.filter(archivedLead).length,
    prefiltered: leads.filter((l) => l.prefilter_reason).length,
    new: leads.filter((l) => !l.legacy && !l.superseded).length,
    recommended: active.filter((l) => l.match?.verdict === "recommend").length,
    contacted: contacted.size,
    applied: outbound.filter((o) => o.channel === "ats").length,
    replied: replied.length,
    interviews: leads.filter((l) => /^interview_/.test(leadState(l))).length,
    by_source: tally(active, "source"),
    by_channel: tally(outbound, "channel"),
    reply_rate: contacted.size ? replied.filter((l) => contacted.has(l.record_id || l.id)).length / contacted.size : null,
    pass_reasons: Object.entries(
      tally(
        feedback.filter((f) => f.action === "pass" && f.reason && f.status === "applied"),
        "reason",
      ),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    weekly: {
      since: new Date(now - 7 * 86400000).toISOString(),
      new: newLeads.length,
      recommended: leads.filter((l) => l.match?.verdict === "recommend" && recent(l.matched_at)).length,
      contacted: weekOut.filter((o) => ["email", "dm"].includes(o.channel)).length,
      applied: weekOut.filter((o) => o.channel === "ats").length,
      replied: leads.filter((l) => recent(l.replied_at)).length,
      interviews: leads.filter((l) => recent(l.interview_at)).length,
      by_source: tally(newLeads, "source"),
      contacts_by_source: tally(
        weekOut.map((o) => ({ ...o, source: sourceFor(o.record_id) })),
        "source",
      ),
      by_channel: tally(weekOut, "channel"),
      feedback: weekFeedback.length,
    },
    pending_calendar_acceptance: ["连续3天真实调度", "真实面试闭环"],
    user_feedback_minutes: null,
  };
}
