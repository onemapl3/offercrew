import {waitForLock} from '../lib/lock.mjs';
await waitForLock('discovery');
import YAML from "yaml";
import { text, write, log } from "../lib/store.mjs";
import { request } from "../lib/ats/http.mjs";
import { transportError, mergeFieldsText } from "../lib/discovery-source.mjs";
const cs = YAML.parse(text("config/companies.yaml"));
// `paused: <reason>` is a person's hold: never read, never re-verified here.
const selected=(process.argv.includes("--retry-unverified")?cs.filter(c=>c.status!=="verified"):cs).filter(c=>!c.paused);
let i = 0;
await Promise.all(
  Array.from({ length: 1 }, async () => {
    while (i < selected.length) {
      const c = selected[i++];
      try {
        // Moka sites answer a cookieless GET with a 302 to the same URL that
        // sets their session cookies; without a jar it never stops redirecting.
        const r = await request(c.careers_url, { jar: new Map() });
        c.careers_http_status = r.status;
        c.careers_checked_at = new Date().toISOString();
        await r.body?.cancel();
        // A recorded verification_error (no target-city jobs, covered by another
        // entry ...) is not overruled by a reachable page; discover clears it
        // once the source itself returns jobs.
        c.status = c.job_count>0&&r.status===200&&!c.verification_error ? "verified" : "unverified";
        delete c.careers_error;
      } catch (e) {
        c.careers_error = e.message;
        // A network failure says nothing about the page (2026-09-21 one
        // resolver outage demoted every source); only a real answer demotes.
        if (!transportError(e)) c.status = "unverified";
      }
    }
  }),
);
// 只改这次核验写的字段；注释和其它字段原样留着（lib/discovery-source.mjs mergeFieldsText）。
write("config/companies.yaml", mergeFieldsText(text("config/companies.yaml"), selected, ["careers_http_status", "careers_checked_at", "status", "careers_error"]));
console.log(
  JSON.stringify(
    log("careers-validation", {
      verified: cs.filter((c) => c.status === "verified").length,
      results: cs.map((c) => ({
        name: c.name,
        status: c.status,
        http: c.careers_http_status,
        error: c.careers_error,
        job_count: c.job_count,
        ...(c.paused ? { paused: true } : {}),
      })),
    }),
  ),
);
