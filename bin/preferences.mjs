// The preference table, from the command line.
//
//   node bin/preferences.mjs                 # what the table currently says
//   node bin/preferences.mjs --rebuild       # recompute it from every recorded decision
//   node bin/preferences.mjs --rebuild --out runs/<日期>/preferences-initial.json
//   node bin/preferences.mjs --explain 143   # why this posting is pushed up or down
//
// Nothing here sends an application or changes a lead. `--rebuild` writes two
// files the user can read and edit by hand: state/preferences.json (weights) and
// state/learned-prefilters.json (the exclusions the system taught itself).
import { read, write, lines, arg, log, hash } from '../lib/store.mjs';
import { extractSignals } from '../lib/preference-signals.mjs';
import {
  buildPreferences, learnedRules, loadPreferences, explainLead,
  resetLearnedRules, resetPreferencesCache, PREFERENCES_PATH, LEARNED_PATH,
} from '../lib/preferences.mjs';

const now = Date.now();
const leads = lines('state/leads.ndjson');
const signals = extractSignals({ leads, now });

if (process.argv.includes('--rebuild')) {
  const previous = loadPreferences();
  const prefs = buildPreferences({ signals, previous, now });
  const learned = learnedRules({ prefs, previous: read(LEARNED_PATH, { rules: [] }), now });
  write(PREFERENCES_PATH, prefs);
  write(LEARNED_PATH, learned);
  resetLearnedRules();
  resetPreferencesCache();
  const summary = {
    status: previous.version === prefs.version ? 'no_change' : 'changed',
    signals: signals.length,
    preferences_version: prefs.version,
    previous_version: previous.version,
    dimensions: Object.fromEntries(Object.entries(prefs.dimensions).map(([d, b]) => [d, Object.keys(b).length])),
    top_positive: topFeatures(prefs, 1).slice(0, 8),
    top_negative: topFeatures(prefs, -1).slice(0, 8),
    reasons: prefs.reasons,
    learned_rules: learned.rules.map((r) => ({ id: r.id, dim: r.dim, value: r.value, disabled: !!r.disabled, explanation: r.explanation })),
    manual_overrides: Object.keys(prefs.manual || {}),
  };
  const out = arg('--out');
  if (out) write(out, { at: new Date(now).toISOString(), ...summary, preferences: prefs, learned });
  console.log(JSON.stringify(log('preferences', summary), null, 2));
  process.exit(0);
}

const explain = arg('--explain');
if (explain) {
  const lead = leads.find((l) => String(l.number) === String(explain) || (l.record_id || l.id) === explain);
  if (!lead) throw Error(`no_lead_for_${explain}`);
  const e = explainLead(lead);
  const line = (r) => `  ${r.weight > 0 ? '+' : ''}${r.weight}  ${r.feature}${r.manual ? '（手工设定）' : `（赞成 ${r.positive} / 反对 ${r.negative}${r.demoted ? '，已降权' : ''}）`}${Object.keys(r.reasons || {}).length ? `  理由：${Object.entries(r.reasons).map(([k, n]) => `${k}×${n}`).join('、')}` : ''}`;
  console.log(
    [
      `${e.number} 号 · ${e.company} · ${e.role}`,
      `偏好分 ${e.score}（偏好表 ${e.preferences_version}）`,
      e.up.length ? '为什么推：' : '为什么推：没有正向依据',
      ...e.up.map(line),
      e.down.length ? '为什么降：' : '为什么降：没有负向依据',
      ...e.down.map(line),
      e.learned_exclusion ? `已命中学习到的排除规则 ${e.learned_exclusion.id}：${e.learned_exclusion.explanation}` : '未命中任何学习到的排除规则',
      '改权重：编辑 state/preferences.json 的 manual；撤销规则：state/learned-prefilters.json 里那条改成 "disabled": true。',
    ].join('\n'),
  );
  console.log(JSON.stringify(e));
  process.exit(0);
}

const prefs = loadPreferences();
console.log(
  JSON.stringify(
    {
      preferences_version: prefs.version, updated_at: prefs.updated_at, signals_at_build: prefs.signals, signals_now: signals.length,
      top_positive: topFeatures(prefs, 1).slice(0, 10), top_negative: topFeatures(prefs, -1).slice(0, 10),
      reasons: prefs.reasons, manual: prefs.manual,
      learned_rules: (read(LEARNED_PATH, { rules: [] }).rules || []).map((r) => ({ id: r.id, value: r.value, disabled: !!r.disabled })),
    },
    null,
    2,
  ),
);

function topFeatures(p, sign) {
  return Object.entries(p.dimensions || {})
    .flatMap(([dim, bucket]) => Object.entries(bucket).map(([value, e]) => ({ feature: `${dim}:${value}`, weight: e.weight, positive: e.positive, negative: e.negative, reasons: Object.keys(e.reasons || {}) })))
    .filter((r) => (sign > 0 ? r.weight > 0 : r.weight < 0))
    .sort((a, b) => (sign > 0 ? b.weight - a.weight : a.weight - b.weight));
}
