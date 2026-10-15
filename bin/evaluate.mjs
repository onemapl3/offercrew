// 高级档（config/pipeline.json spend_tier=premium，lib/spend.mjs）：给推荐的岗位写一页评估（lib/evaluate.mjs）。
// 周期里跟在判断、匹配后面；别的档位什么都不做。到了今天的花费上限就停，剩下的留到明天。
//
//   node bin/evaluate.mjs [--limit 5]
import { lines, read, arg, log, deadlineNear } from '../lib/store.mjs';
import { event } from '../lib/events.mjs';
import { byPriority } from '../lib/matcher.mjs';
import { spendTier, budgetGate } from '../lib/spend.mjs';
import { wantsEvaluation, evaluateLead, loadFactsForEval } from '../lib/evaluate.mjs';
import { stopIfFactsBad } from '../lib/facts-gate.mjs';

const pipeline = read('config/pipeline.json', {});
if (spendTier(pipeline) !== 'premium') { console.log(JSON.stringify(log('evaluate', { status: 'no_change', reason: 'tier', tier: spendTier(pipeline) }))); process.exit(0); }
stopIfFactsBad('evaluate'); // 资料文件读坏了、或者引导走完以后不见了：不写评估（lib/facts-gate.mjs）
const wanted = lines('state/leads.ndjson').filter(wantsEvaluation).sort(byPriority);
const limit = Math.max(1, Number(arg('--limit', pipeline.evaluate_limit || 5)));
if (budgetGate('evaluate')) { console.log(JSON.stringify(log('evaluate', { status: 'no_change', reason: 'spend_cap', pending: wanted.length }))); process.exit(0); }
const facts = loadFactsForEval(), done = [], errors = [];
for (const l of wanted.slice(0, limit)) {
  // 一次评估最坏要等文字清单里每个底座超时：离周期的收尾点不够一次就不开新的；到了花费上限也停。
  if (deadlineNear(180000) || budgetGate('evaluate', { quiet: done.length > 0 })) break;
  try { const page = await evaluateLead(l, { facts }); done.push({ number: l.number ?? null, company: l.company, comp: page.comp }); }
  catch (e) { errors.push({ id: l.id, error: String(e.message || e).slice(0, 200) }); }
}
if (done.length) event('radar', 'evaluate', 'ok', `一页评估：写了 ${done.length} 条（${done.map(d => `#${d.number ?? '—'} ${d.company}`).join('、').slice(0, 120)}）`);
console.log(JSON.stringify(log('evaluate', { status: errors.length && !done.length ? 'degraded' : done.length ? 'changed' : 'no_change', written: done.length, pending: Math.max(0, wanted.length - done.length), errors })));
