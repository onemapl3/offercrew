// Which project to lead with.
//
// The user ranks the evidence in candidate/facts.yaml `positioning`
// (project_priority): the project to lead with first, a second one, a third only
// as an extra example. Without it every letter and every brief opened with
// whichever project happened to be first in `personal_projects`. This reads the
// ranking the user wrote and picks the
// highest-ranked project that actually fits the posting; it never invents one.
import { read } from './store.mjs';

export const positioningOf = facts => facts?.positioning || {};

// The words that make a project the right example for this posting, taken from
// what the user wrote in `use_for` and `why` — not from a list in this file.
const tokens = s =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter(t => t.length > 1);

export function rankedProjects(facts = {}) {
  const p = positioningOf(facts);
  const entries = facts.personal_projects?.entries || [];
  const byName = new Map(entries.map(e => [String(e.name), e]));
  const ranked = (p.project_priority || []).map((item, index) => {
    // A ranked name may carry a second name in brackets, e.g. OfferCrew（多智能体求职系统）; match on either part.
    const names = String(item.name).split(/[（()）/]/).map(s => s.trim()).filter(Boolean);
    const entry = names.map(n => byName.get(n)).find(Boolean) || null;
    return { rank: index, name: names[0], why: item.why || '', use_for: item.use_for || '', entry, evidence: entry?.evidence || item.why || '', url: entry?.url || null };
  });
  // Anything the user ranked comes first; unranked projects keep their old order.
  const rest = entries.filter(e => !ranked.some(r => r.entry === e)).map((e, i) => ({ rank: ranked.length + i, name: e.name, why: '', use_for: (e.relevance || []).join(' '), entry: e, evidence: e.evidence || '', url: e.url || null }));
  return [...ranked, ...rest];
}

// The project to lead with for this posting: the highest-ranked one whose
// `use_for` / `why` overlaps the job text, else the highest-ranked one overall.
export function pickProject(lead = {}, facts = {}, { ranked = rankedProjects(facts) } = {}) {
  if (!ranked.length) return null;
  const jd = tokens(`${lead.role || ''} ${lead.jd_text || lead.jd || ''} ${(lead.match?.must_haves || []).map(r => r.req).join(' ')}`);
  if (!jd.length) return ranked[0];
  const jdSet = new Set(jd);
  const scored = ranked
    .map(p => ({ p, hits: [...new Set(tokens(`${p.use_for} ${p.why}`))].filter(t => jdSet.has(t)).length }))
    .sort((a, b) => b.hits - a.hits || a.p.rank - b.p.rank);
  return scored[0].hits ? scored[0].p : ranked[0];
}

// One line of "this is why I fit", built from the match result and the chosen
// project. Nothing here is invented: both halves come from saved facts.
export function fitLine(lead = {}, facts = {}) {
  const reason = String((lead.match?.reasons || [])[0] || '').trim();
  const project = pickProject(lead, facts);
  const head = positioningOf(facts).lead_with || '';
  const first = String(project?.why || project?.evidence || '').split(/[；;。：:]/).filter(Boolean)[0] || '';
  const evidence = project ? `可讲 ${project.name}${first ? '：' + (first.length > 24 ? first.slice(0, 23) + '…' : first) : ''}` : '';
  return [reason || head, evidence].filter(Boolean).join('；');
}

export const loadPositioning = (path = 'candidate/facts.json') => positioningOf(read(path, {}));
