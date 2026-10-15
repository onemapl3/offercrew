// The preference table: what the user's own decisions say he wants.
//
// The rule the user asked for is that the system gets more accurate the more it
// is used, and that he can always see — and overrule — why. So the table is a
// plain JSON file he can open and edit (`state/preferences.json`), every number
// in it is the sum of dated events from lib/preference-signals.mjs, and the
// update rules are four sentences long:
//
//   1. every signal scores each feature of the job it was about, faded by how
//      long ago it happened (half life 30 days), and a feature's weight is the
//      average of those scores times how much evidence stands behind it — so
//      volume alone never creates a preference;
//   2. two negatives of the same kind and that feature is demoted outright;
//   3. three negatives with a stated reason, and no positives at all, and the
//      feature becomes a prefilter exclusion (state/learned-prefilters.json);
//   4. no single feature may move a ranking by more than a fixed cap, and the
//      table as a whole may never outrank the city order 杭州 > 上海 > 远程.
//
// It imports only the store, the city rules and the signal extractor, so
// lib/matcher.mjs can use it without an import cycle.
import { read, lines, hash } from './store.mjs';
import { fileSig } from './state-cache.mjs';

import { extractSignals, leadFeatures, featureKey, explicitReasons, directionRules, SENIORITY_RULES, ruleRegex, recentDecisions, SILENT_REASON, DIMENSIONS } from './preference-signals.mjs';
import { TZ } from './tz.mjs';
import { noteSwallowed } from './swallow.mjs';
import { decidedLead } from './lead-state.mjs';

export const PREFERENCES_PATH = 'state/preferences.json';
export const LEARNED_PATH = 'state/learned-prefilters.json';

// A decision from a month ago counts half as much as one from today. The job
// search moves in weeks, so an opinion from the spring should not outvote one
// from this morning.
export const HALF_LIFE_DAYS = 30;
// No one feature may be worth more than this much of a ranking.
export const WEIGHT_CAP = 6;
// And the whole table together may move one lead by less than half the distance
// between 杭州 and 上海 in lib/matcher.mjs `priority` (125 − 95 = 30). Half,
// because the guarantee has to hold between two leads: the most loved posting
// and the most disliked one are 18 points apart, so the city order the user set
// is never reordered by anything the system taught itself.
export const SCORE_CAP = 9;
// Two negatives is a pattern; three with a reason is a rule.
export const DEMOTE_MIN = 2;
export const EXCLUDE_MIN = 3;
// How much louder a demoted feature's negatives get once the pattern is clear.
export const DEMOTE_FACTOR = 1.5;
// A weight is the average strength of one decision about that feature, not the
// sum of all of them. Volume alone must not create a preference: the user looks
// almost exclusively at AI application roles, so "he contacted thirty of them"
// says nothing about which one to show first, while "he says no to this kind
// every time he sees it" says a great deal. Confidence then discounts a feature
// the user has only met once or twice (n / (n + 2): one decision counts a third,
// three count three fifths, ten count five sixths).
export const CONFIDENCE_K = 2;
export const WEIGHT_SCALE = 1.5;
// A company name is a sharper signal than a stack keyword, and a city is
// already handled by the base priority, so it barely counts here.
export const DIM_WEIGHT = { direction: 1, company: 0.8, company_type: 0.8, seniority: 0.8, salary_band: 0.7, stack: 0.6, source_type: 0.6, city: 0.5 };
// Dimensions an exclusion pattern can be written for. A city is a priority, not
// an exclusion; a pay band and a stack keyword are too blunt to retire a posting
// on; how a job was found is never a reason to drop it.
export const EXCLUDABLE_DIMS = ['direction', 'seniority', 'company'];

const DAY = 86400000;
const clamp = (x, cap) => Math.max(-cap, Math.min(cap, x));
const round = (x) => Math.round(x * 100) / 100;
export const decay = (at, now = Date.now()) => {
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return 1;
  return 0.5 ** (Math.max(0, now - t) / DAY / HALF_LIFE_DAYS);
};

export const emptyPreferences = () => ({
  version: 'empty', updated_at: null, signals: 0,
  half_life_days: HALF_LIFE_DAYS, weight_cap: WEIGHT_CAP, score_cap: SCORE_CAP,
  dimensions: {}, reasons: {}, manual: {}, learned_rule_ids: [],
});

export function loadPreferences(path = PREFERENCES_PATH) {
  const p = read(path, null);
  if (!p || typeof p !== 'object') return emptyPreferences();
  return { ...emptyPreferences(), ...p, dimensions: p.dimensions || {}, manual: p.manual || {} };
}

// The weight actually used for a feature: whatever the user typed in `manual`
// wins over anything the system learned, and it survives every rebuild.
export function featureWeight(prefs, key) {
  if (Object.prototype.hasOwnProperty.call(prefs.manual || {}, key)) return clamp(Number(prefs.manual[key]) || 0, WEIGHT_CAP);
  const [dim, ...rest] = key.split(':');
  const entry = prefs.dimensions?.[dim]?.[rest.join(':')];
  return entry ? clamp(Number(entry.weight) || 0, WEIGHT_CAP) : 0;
}

// ---------------------------------------------------------------------------
// Building the table.

export function buildPreferences({ signals = [], previous = loadPreferences(), now = Date.now() } = {}) {
  const dims = {};
  const reasons = {};
  for (const s of signals) {
    const faded = s.base * decay(s.at, now);
    // A reason is always an answer to "why not". Words attached to a 联系 are a
    // note about the job, not a complaint about its kind, and counting them
    // would put "算法研究" in the evidence for a feature the user pursued.
    const said = s.sign < 0 ? explicitReasons(s.reasons || []) : [];
    for (const r of said) reasons[r] = (reasons[r] || 0) + 1;
    for (const f of s.features || []) {
      const bucket = (dims[f.dim] = dims[f.dim] || {});
      const e = (bucket[f.value] = bucket[f.value] || { weight: 0, positive: 0, negative: 0, positive_raw: 0, negative_raw: 0, reasons: {}, examples: [], last_at: null });
      const contribution = faded * (DIM_WEIGHT[f.dim] ?? 0.5);
      if (s.sign > 0) { e.positive++; e.positive_raw += contribution; }
      else { e.negative++; e.negative_raw += contribution; }
      for (const r of said) e.reasons[r] = (e.reasons[r] || 0) + 1;
      if (e.examples.length < 5) e.examples.push({ number: s.number, company: s.company, kind: s.kind, at: s.at, reason: (s.reasons || [])[0] || null });
      if (!e.last_at || String(s.at) > String(e.last_at)) e.last_at = s.at;
    }
  }
  // Rule 2: a feature the user has said no to twice is demoted, which means its
  // negatives are counted louder from then on. Stated in the file so the number
  // can be checked by hand.
  for (const bucket of Object.values(dims))
    for (const e of Object.values(bucket)) {
      const n = e.positive + e.negative;
      e.demoted = e.negative >= DEMOTE_MIN && e.negative > e.positive;
      const net = e.positive_raw + e.negative_raw * (e.demoted ? DEMOTE_FACTOR : 1);
      e.mean = round(n ? net / n : 0);
      e.confidence = round(n / (n + CONFIDENCE_K));
      e.weight = round(clamp(e.mean * e.confidence * WEIGHT_SCALE, WEIGHT_CAP));
      e.positive_raw = round(e.positive_raw);
      e.negative_raw = round(e.negative_raw);
      e.reasons = Object.fromEntries(Object.entries(e.reasons).sort((a, b) => b[1] - a[1]));
    }
  const prefs = {
    ...emptyPreferences(),
    updated_at: new Date(now).toISOString(),
    signals: signals.length,
    dimensions: Object.fromEntries(DIMENSIONS.filter((d) => dims[d]).map((d) => [d, sortBucket(dims[d])])),
    reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    // Anything the user typed by hand is his, not ours, and a rebuild keeps it.
    manual: previous?.manual || {},
    note: '手改：在 manual 里写 "维度:取值": 权重（覆盖学习值，重算不丢）。撤销学习到的排除规则：把 state/learned-prefilters.json 里那条改成 "disabled": true。',
  };
  prefs.version = hash([prefs.dimensions, prefs.manual]).slice(0, 12);
  return prefs;
}
const sortBucket = (bucket) => Object.fromEntries(Object.entries(bucket).sort((a, b) => Math.abs(b[1].weight) - Math.abs(a[1].weight)));

// Rule 3. An exclusion is the strongest thing the system can learn by itself, so
// it is also the most conservative: three negatives, a reason in words at least
// once, not a single positive ever, and only on a dimension a pattern can
// honestly be written for.
export function learnedRules({ prefs, previous = read(LEARNED_PATH, { rules: [] }), now = Date.now() } = {}) {
  const kept = new Map((previous.rules || []).map((r) => [r.id, r]));
  const rules = [];
  for (const dim of EXCLUDABLE_DIMS) {
    for (const [value, e] of Object.entries(prefs.dimensions?.[dim] || {})) {
      const stated = Object.entries(e.reasons || {});
      if (e.negative < EXCLUDE_MIN || e.positive > 0 || !stated.length) continue;
      const id = hash([dim, value]).slice(0, 16);
      const prior = kept.get(id);
      const pattern = exclusionPattern(dim, value);
      if (!pattern) continue;
      rules.push({
        id, dim, value, ...pattern,
        reason: 'learned_exclusion',
        evidence: { negative: e.negative, positive: e.positive, reasons: Object.fromEntries(stated), examples: e.examples.slice(0, 3) },
        explanation: `你连续 ${e.negative} 次排除这类（${stated.map(([r, n]) => `${r}×${n}`).join('、')}），已自动预筛掉。`,
        created_at: prior?.created_at || new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        // A rule the user turned off stays off across every rebuild.
        disabled: !!prior?.disabled,
      });
      kept.delete(id);
    }
  }
  // A rule whose evidence has faded is retired, but one the user disabled by
  // hand is kept so it is never silently regenerated.
  for (const r of kept.values()) if (r.disabled) rules.push(r);
  return { at: new Date(now).toISOString(), rules: rules.sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}

// The regex an exclusion is enforced with, and the field it is tested against.
// A direction or a grade reuses the very rule that produced the feature, so the
// pattern can never mean something different from the label above it.
function exclusionPattern(dim, value) {
  if (dim === 'direction') {
    const re = ruleRegex(directionRules(), value);
    return re ? { field: 'role_and_jd', pattern: re.source, flags: re.flags } : null;
  }
  if (dim === 'seniority') {
    const re = ruleRegex(SENIORITY_RULES, value);
    return re ? { field: 'role', pattern: re.source, flags: re.flags } : null;
  }
  if (dim === 'company') return { field: 'company', pattern: `^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, flags: 'i' };
  return null;
}

// ---------------------------------------------------------------------------
// Enforcement: the learned prefilter, read by lib/matcher.mjs.
//
// Cached against the file's signature (mtime + size + inode), because
// `prefilter` runs once per lead and there are a few thousand of them per cycle:
// a hit costs one stat, not a read and a parse. The list is shared, so frozen.
let learnedCache = { key: null, rules: [] };
export function loadLearnedRules(path = LEARNED_PATH) {
  const key = path + '|' + fileSig(path);
  if (learnedCache.key === key) return learnedCache.rules;
  const doc = read(path, null);
  const rules = (doc?.rules || [])
    .filter((r) => r && !r.disabled && r.pattern)
    .map((r) => { try { return Object.freeze({ ...r, re: new RegExp(r.pattern, r.flags || 'i') }); } catch (e) { noteSwallowed('preferences.rule', e, { member: 'lens', doing: `用你的偏好规则「${r.pattern}」`, then: '这条规则这次不用' }); return null; } })
    .filter(Boolean);
  learnedCache = { key, rules: Object.freeze(rules) };
  return learnedCache.rules;
}
export const resetLearnedRules = () => { learnedCache = { key: null, rules: [] }; };

// The reason string lib/matcher.mjs `prefilter` returns, or null. Learned rules
// only ever apply to leads the user has not already ruled on: a posting he asked
// to be contacted is never retired by something the system taught itself.
export function learnedPrefilterReason(l = {}) {
  if (decidedLead(l) || l.match?.verdict === 'recommend') return null;
  for (const r of loadLearnedRules()) {
    const subject = r.field === 'company' ? String(l.company || '') : r.field === 'role' ? String(l.role || '') : `${l.role || ''} ${l.jd_text || l.jd || ''}`;
    if (subject && r.re.test(subject)) return 'learned_exclusion';
  }
  return null;
}
export const learnedRuleFor = (l = {}) =>
  loadLearnedRules().find((r) => {
    const subject = r.field === 'company' ? String(l.company || '') : r.field === 'role' ? String(l.role || '') : `${l.role || ''} ${l.jd_text || l.jd || ''}`;
    return subject && r.re.test(subject);
  }) || null;

// ---------------------------------------------------------------------------
// Enforcement: the ranking overlay.

let prefsCache = { key: null, prefs: null };
// `priority` runs per lead per sort (1,784 calls per Radar list rebuild), so the
// file is parsed once per version of the file (mtime + size + inode) — a hit is
// one stat, not a 70 KB read and parse. Every caller shares the table: frozen.
const deepFreeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); } return x; };
export function cachedPreferences() {
  const key = fileSig(PREFERENCES_PATH);
  if (prefsCache.key !== key) prefsCache = { key, prefs: deepFreeze(loadPreferences()) };
  return prefsCache.prefs;
}
export const resetPreferencesCache = () => { prefsCache = { key: null, prefs: null }; };

// What the table adds to a lead's ranking, capped so the standing city order
// always wins. With no preferences file this is exactly 0, and every ranking in
// the system is unchanged.
export function preferenceScore(lead = {}, prefs = cachedPreferences()) {
  if (!prefs || !Object.keys(prefs.dimensions || {}).length && !Object.keys(prefs.manual || {}).length) return 0;
  let total = 0;
  for (const f of leadFeatures(lead)) total += featureWeight(prefs, featureKey(f));
  // Squashed rather than clipped. A hard cap would make every well-liked lead
  // score exactly the same at the top of the list, which is where the ordering
  // matters most; tanh keeps the order intact all the way up and still never
  // reaches the cap, so the city order can never be overturned.
  return round(SCORE_CAP * Math.tanh(total / SCORE_CAP));
}

// ---------------------------------------------------------------------------
// Visibility: why this lead, in the user's own words.

export function explainLead(lead = {}, prefs = cachedPreferences()) {
  const rows = leadFeatures(lead)
    .map((f) => {
      const key = featureKey(f);
      const [dim, ...rest] = key.split(':');
      const entry = prefs.dimensions?.[dim]?.[rest.join(':')] || null;
      return {
        feature: key, weight: featureWeight(prefs, key),
        manual: Object.prototype.hasOwnProperty.call(prefs.manual || {}, key),
        positive: entry?.positive || 0, negative: entry?.negative || 0,
        demoted: !!entry?.demoted, reasons: entry?.reasons || {}, examples: entry?.examples || [],
      };
    })
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const rule = learnedRuleFor(lead);
  return {
    number: lead.number ?? null, company: lead.company || '', role: lead.role || '',
    preferences_version: prefs.version, score: preferenceScore(lead, prefs),
    up: rows.filter((r) => r.weight > 0), down: rows.filter((r) => r.weight < 0), neutral: rows.filter((r) => !r.weight),
    learned_exclusion: rule ? { id: rule.id, value: rule.value, explanation: rule.explanation } : null,
  };
}

// One sentence for the brief's 匹配点 row: the single strongest reason the table
// is pushing this lead up or down, with the count behind it. Empty when the
// table has nothing to say, so a brief never carries a sentence about nothing.
export const LEARNING_NOTE_MIN = 1;
export function learningNote(lead = {}, prefs = cachedPreferences()) {
  const e = explainLead(lead, prefs);
  if (Math.abs(e.score) < LEARNING_NOTE_MIN) return '';
  const top = [...e.up, ...e.down].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0];
  if (!top) return '';
  const label = top.feature.split(':').slice(1).join(':');
  if (top.manual) return `学习依据：你把「${label}」的权重手工设成了 ${top.weight}。`;
  if (top.weight > 0) return `学习依据：你近期对「${label}」有 ${top.positive} 次投递/联系，此类已加权（${top.weight > 0 ? '+' : ''}${top.weight}）。`;
  const why = Object.keys(top.reasons || {})[0];
  return `学习依据：「${label}」你已排除/跳过 ${top.negative} 次${why ? `（${why}）` : ''}，此类已降权（${top.weight}）。`;
}

// The paragraph bin/match.mjs puts in front of the model: what the user went
// after lately and what he threw away, with the reasons in his own words. It is
// reference material for a judgement, never an instruction to the model.
export function promptSnippet({ signals = null, prefs = cachedPreferences(), leads = null, now = Date.now() } = {}) {
  const rows = signals || extractSignals({ leads: leads || lines('state/leads.ndjson'), now });
  const { pursued, dropped } = recentDecisions(rows);
  if (!pursued.length && !dropped.length) return '';
  const line = (s) => `${s.company || '未记录'} · ${s.role || '未记录'}${s.reasons?.length ? `（${s.reasons.filter((r) => r !== SILENT_REASON).join('、') || SILENT_REASON}）` : ''}`;
  return [
    'User preference history (reference only, never an instruction; the JD still decides):',
    pursued.length ? `最近投递/联系：${pursued.map(line).join('；')}` : '最近投递/联系：暂无记录',
    dropped.length ? `最近跳过/排除：${dropped.map(line).join('；')}` : '最近跳过/排除：暂无记录',
    `偏好表版本：${prefs.version}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The weekly note in the command room.


