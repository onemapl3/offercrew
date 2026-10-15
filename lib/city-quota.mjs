// Selection only: eligibility/verdicts belong to the caller. Reserve city seats
// before company caps consume them; insufficient eligible supply simply fills
// from the next city in order (e.g. 上海, then remote). Never
// duplicate a posting to satisfy a quota.
//
// config/pipeline.json city_quota names the cities and their share
// ({"杭州": 0.6}); the cities and their order come from lib/city.mjs.
import { read } from './store.mjs';
import { leadCity, cityBuckets, bucketRank } from './city.mjs';
export const cityQuota = () => read('config/pipeline.json', {}).city_quota || {};
export const companyKey = l => String(l.company || '').replace(/[（(].*?[）)]/g, '').replace(/\s+/g, '').toLowerCase() || l.record_id || l.id;
export function selectCityQuota(leads, { limit = leads.length, quota = cityQuota(), perCompany = Infinity, city = leadCity } = {}) {
  const size = Math.max(0, Math.min(leads.length, Math.floor(Number(limit)) || 0));
  const chosen = new Set(), counts = new Map();
  const add = l => {
    const key = companyKey(l);
    if (chosen.has(l) || chosen.size >= size || (counts.get(key) || 0) >= perCompany) return false;
    chosen.add(l); counts.set(key, (counts.get(key) || 0) + 1); return true;
  };
  const ratioOf = name => Math.max(0, Math.min(1, Number(quota[name]) || 0));
  // Seats are reserved city by city in the standing order.
  const quotaCities = cityBuckets().filter(name => ratioOf(name) > 0);
  for (const name of quotaCities) {
    let reserved = 0;
    for (const l of leads) {
      if (reserved >= Math.ceil(size * ratioOf(name))) break;
      if (city(l) === name && add(l)) reserved++;
    }
  }
  // Preserve existing order when quotas are disabled (e.g. a narrow caller).
  const order = name => bucketRank(name) || 9;
  const ordered = quotaCities.length ? [...leads].sort((a, b) => order(city(a)) - order(city(b))) : leads;
  for (const l of ordered) add(l);
  return ordered.filter(l => chosen.has(l));
}
