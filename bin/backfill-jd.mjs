// 补全岗位正文。单条入口也接受短摘要、未判断和旧导入记录；稳定线索不变。
// node bin/backfill-jd.mjs --record <record_id> [--text /path/to/official-jd.txt]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { lines, arg, log } from '../lib/store.mjs';
import { needsBackfill } from '../lib/job-brief.mjs';
import { backfillJd } from '../lib/jd-backfill.mjs';
import { judgeOne } from '../lib/ops.mjs';

const record = arg('--record', ''), textFile = arg('--text', ''), leads = lines('state/leads.ndjson');
if (textFile && !record) throw Error('--text 要指定 --record');
const one = record ? leads.find(l => (l.record_id || l.id) === record || l.id === record) : null;
if (record && !one) throw Error('没有这条岗位');
const targets = record ? [one] : needsBackfill(leads, Number(arg('--limit', 10))).map(t => leads.find(l => (l.record_id || l.id) === t.record_id));
const filled = [], failed = [], results = [];
for (const lead of targets) {
  try {
    const result = await backfillJd({ record_id: lead.record_id || lead.id, source_url: lead.url || lead.source_url, action: textFile ? 'save' : 'read', ...(textFile ? { text: fs.readFileSync(textFile, 'utf8') } : {}), request_id: crypto.randomUUID() }, { judge: record ? judgeOne : null });
    filled.push(lead.number); results.push(result);
  } catch (e) { failed.push({ number: lead.number, url: lead.url || lead.source_url, error: e.message }); }
}
console.log(JSON.stringify(log('backfill-jd', { status: filled.length ? 'changed' : targets.length ? 'degraded' : 'no_change', candidates: targets.length, filled, failed, ...(record ? { results } : {}) })));
if (record && failed.length) process.exitCode = 1;
