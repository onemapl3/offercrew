import { metrics } from "../lib/metrics.mjs";
import { lines, write, today } from "../lib/store.mjs";
import { BRAND } from "../lib/brand.mjs";
const m = metrics(lines("state/leads.ndjson"), lines("state/outbound.ndjson"), lines("state/feedback.ndjson"));

write("state/metrics.json", m);
if (process.argv.includes("--weekly"))
  write(`runs/reports/weekly-${today()}.md`, "# " + BRAND + " 周复盘\n\n```json\n" + JSON.stringify(m, null, 2) + "\n```\n");
console.log(JSON.stringify(m, null, 2));
