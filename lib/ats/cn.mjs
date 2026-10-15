// Shared plumbing for mainland-China career portals (the target-city sources).
// These portals expose no board-wide export, so each adapter searches a small
// keyword list and keeps only postings whose city matches the target cities.
// Requests still go through lib/ats/http.mjs, so the configured proxy and its
// direct fallback apply unchanged.

import { rankedCities, cityEn } from "../city.mjs";
import { directionQueries } from "../directions.mjs";
import { currentFacts } from "../facts.mjs";

// The default library agent is rejected (HTTP 405) by the Feishu/Lark hiring
// portal. A browser-shaped string that still names this tool keeps the caller
// identifiable while satisfying the portal's client check.
export const CN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OfferCrew/0.1 (+https://offercrew.onemaple.cc)";

export const CN_QUERIES = ["AI", "Agent", "LLM", "大模型", "全栈", "后端", "Node", "Python", "Go", "前端"];
// 没给这家公司写 queries 时按你的求职方向搜（lib/directions.mjs）：软件方向就是上面这一串，金融是「投行、研究员、风控……」。
const defaultQueries = () => { const q = directionQueries(currentFacts(), "zh"); return q.length ? q : CN_QUERIES; };
// Without a per-company `cities`, keep the target cities (lib/city.mjs) in both
// spellings: 杭州 Hangzhou 上海 Shanghai for the owner.
export const cnCities = () => rankedCities().flatMap((city) => [city, cityEn(city)].filter(Boolean));
// The default at start-up, for older importers; citiesOf reads cnCities() each time.
export const CN_CITIES = cnCities();

export const queriesOf = (c) => (c.queries?.length ? c.queries : defaultQueries());
export const citiesOf = (c) => (c.cities?.length ? c.cities : cnCities());

// Portals report "杭州" / "杭州市" / "Hangzhou, China"; a plain substring test on
// both spellings is enough and never widens to a different city.
export const inTargetCity = (location, cities) => {
  const where = String(location || "");
  return !!where && cities.some((city) => where.toLowerCase().includes(String(city).toLowerCase()));
};

// 没写城市的岗位（百威的管培生、不少外资校招板）：默认照旧丢掉，作者本人的扫描一条都不多。
// companies.yaml 里写了 `unlisted_city: keep` 的公司，这类岗位留下，地点记「未标注」并标 needs_city_check，
// 由判断读 JD 去核城市。只认真正空着的地点；写了别的城市的照旧按目标城市筛。
export const UNLISTED_CITY = "未标注";
export const keepsUnlisted = (c) => String(c?.unlisted_city ?? "").trim().toLowerCase() === "keep";
export const unlisted = (l) => ({ ...l, location: UNLISTED_CITY, needs_city_check: true });
// 这个进程里过城市这一关的岗位数：seen 是看过几条，kept 是留下几条。扫描每个来源在自己的子进程里读
// （lib/discovery-source.mjs fetchSource）：一条都没留下、但看过岗位，就是「读得通，没有目标城市的岗位」，不是读不到。
export const cityTally = { seen: 0, kept: 0 };
// 一条岗位过不过城市这一关：过了返回这条（没写城市而留下的换上「未标注」），没过返回 null。
export function cityGate(c, l, cities = citiesOf(c)) {
  cityTally.seen++;
  const out = inTargetCity(l.location, cities) ? l : !String(l.location ?? "").trim() && keepsUnlisted(c) ? unlisted(l) : null;
  if (out) cityTally.kept++;
  return out;
}

export const cnText = (...parts) => parts.filter(Boolean).join("\n\n");

// Runs `page(company, keyword, pageIndex)` until the keyword is exhausted or the
// page budget runs out, keeping one lead per source_job_id. `page` returns
// {leads, total} so an adapter only has to describe one request.
export async function searchCities(c, page) {
  const cities = citiesOf(c);
  const size = c.page_size || 50;
  const byId = new Map();
  for (const keyword of queriesOf(c)) {
    for (let index = 0; index < (c.max_pages || 4); index++) {
      const { leads, total } = await page(c, keyword, index, size);
      for (const found of leads) {
        const l = cityGate(c, found, cities);
        if (l && !byId.has(l.source_job_id)) byId.set(l.source_job_id, l);
      }
      if (!leads.length || (index + 1) * size >= (total ?? 0)) break;
    }
  }
  return [...byId.values()];
}
