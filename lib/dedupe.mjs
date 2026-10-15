import { leadFields } from './lead-fields.mjs';
import { hash } from "./store.mjs";
import { maimaiPostKey, maimaiPostKeys, maimaiLeadGroupKey, mergeMaimaiCluster } from "./maimai-clusters.mjs";
export { maimaiPostKey, maimaiPostKeys } from "./maimai-clusters.mjs";
export function canonicalUrl(value) {
  try {
    const u = new URL(String(value).match(/\]\((https?:[^)]+)\)/)?.[1] || value);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|trk|trackingId|refId|ref$)/i.test(key)) u.searchParams.delete(key);
    }
    // 网易招聘的 lang 只管中英文站，不是另一个岗位（lib/ats/netease.mjs）。
    if (/(^|\.)hr\.163\.com$/.test(u.hostname)) u.searchParams.delete("lang");
    if (/(^|\.)linkedin\.com$/.test(u.hostname)) {
      u.hostname = "www.linkedin.com";
      const job = u.pathname.match(/\/jobs\/view\/(?:.*-)?(\d+)\/?$/);
      if (job) u.pathname = `/jobs/view/${job[1]}`;
    }
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    u.searchParams.sort();
    return u.toString();
  // 兜底：写得不像网址就没有规范写法
  } catch {
    return null;
  }
}
export function identity(l) {
  if (maimaiPostKey(l)) return hash(maimaiPostKey(l));
  const url = canonicalUrl(l.url || l.source_url);
  if (!url) throw Error("invalid_source_url");
  return hash([url, String(l.company || '').trim().toLowerCase(), String(l.role || '').trim().toLowerCase(), l.source_job_id || ""]);
}
export function mergeLeads(old, incoming) {
  const map = new Map(old.map((l) => [l.id || identity(l), l]));
  const key = (l) => { const f = leadFields(l); return maimaiPostKey(l) || [canonicalUrl(l.url || l.source_url), f.company.toLowerCase(), f.role.toLowerCase()].join("|"); };
  const leadKeys = l => maimaiPostKeys(l).length ? maimaiPostKeys(l) : [key(l)];
  const keys = new Map();
  // Register active cluster owners last so retained superseded rows cannot
  // steal a member fid back from its primary.
  for (const l of [...old.filter(l => l.superseded), ...old.filter(l => !l.superseded)]) {
    if (l.url || l.source_url) for (const k of leadKeys(l)) keys.set(k, l.superseded_by || l.id || identity(l));
  }
  const oldAtsKey = (l) => /^https:\/\/(jobs\.ashbyhq\.com|jobs\.lever\.co|boards\.greenhouse\.io|job-boards\.greenhouse\.io)\/[^/]+\/[^/]+/.test(canonicalUrl(l.url) || "") ? canonicalUrl(l.url) : null;
  const atsKey = l => postingKey(l) || oldAtsKey(l);
  const ats = new Map(old.filter(atsKey).map((l) => [atsKey(l), l.id || identity(l)]));
  // BOSS 直聘的同一个岗位（job_detail/<id>.html）：链接后面的参数每次不一样、公司名写法也可能不同，按岗位 id 认。
  // 招聘方主动找你、先进池的那条（lib/boss-inbound.mjs）在雷达后来扫到时不另起一条，来源和标签留着。
  const bossKey = (l) => String(l.url || l.source_url || "").match(/^https?:\/\/(?:www\.)?zhipin\.com\/job_detail\/([^./?#]+)\.html/i)?.[1] || null;
  const boss = new Map(old.filter((l) => bossKey(l) && !l.superseded).map((l) => [bossKey(l), l.id || identity(l)]));
  let added = 0, updated = 0;
  // A 脉脉 card seen earlier as a search snippet gets its full detail-page text
  // the next time the post is opened; the record keeps its number, status and
  // feedback, only the content fields move.
  const DETAIL_FIELDS = ["text", "original_body", "jd_text", "role", "title", "location", "location_status", "needs_city_check", "needs_role_check", "company", "company_status", "company_claim", "author_affiliation", "field_sources", "content_hash", "detail_evidence", "evidence"];
  const bodyOf = l => String(l.original_body || l.text || l.jd_text || '').replace(/\s+/g, ' ').trim();
  for (const raw of incoming) {
    const lead = { ...raw, ...leadFields(raw) };
    const id = ats.get(atsKey(lead)) || (bossKey(lead) && boss.get(bossKey(lead))) || leadKeys(lead).map(k => keys.get(k)).find(Boolean) || identity(lead);
    let existing = map.get(id);
    let clusterUpdated = false;
    if (existing && maimaiLeadGroupKey(existing) && maimaiLeadGroupKey(existing) === maimaiLeadGroupKey(lead)
      && (existing.cluster_ids?.length || lead.cluster_ids?.length)) {
      const clustered = mergeMaimaiCluster([existing, lead], existing);
      if (JSON.stringify(clustered) !== JSON.stringify(existing)) {
        existing = clustered;
        map.set(id, existing);
        updated++;
        clusterUpdated = true;
      }
      for (const k of leadKeys(existing)) keys.set(k, id);
    }
    if (existing && lead.source === "脉脉" && maimaiPostKey(lead) === maimaiPostKey(existing)
      && lead.detail_evidence && bodyOf(lead).length > bodyOf(existing).length) {
      const patch = {};
      for (const f of DETAIL_FIELDS) if (lead[f] !== undefined) patch[f] = lead[f];
      let filled = { ...existing, ...patch, detail_filled_at: new Date().toISOString() };
      if (!lead.needs_city_check) delete filled.needs_city_check;
      if (!lead.needs_role_check) delete filled.needs_role_check;
      if (!lead.company_claim) delete filled.company_claim;
      if (!existing.match) {
        if (lead.prefilter_reason) filled.prefilter_reason = lead.prefilter_reason;
        else delete filled.prefilter_reason;
      }
      // More source text invalidates a previous missing-text stop, not its
      // application/approval history or unrelated invalid model-output stops.
      if ((existing.match_error_final || existing.match_error) === 'full_jd_missing') {
        filled.match_content_recovery = { at: filled.detail_filled_at, previous_error: existing.match_error_final || existing.match_error, previous_attempts: existing.match_attempts ?? null };
        for (const field of ['match_error', 'match_retry_at', 'match_error_final', 'match_error_final_at', 'match_attempts']) delete filled[field];
      }
      if (existing.cluster_ids?.length) {
        filled = mergeMaimaiCluster([existing, lead], { ...filled, cluster_posts: lead.cluster_posts });
      }
      map.set(id, filled);
      if (!clusterUpdated) updated++;
      continue;
    }
    // 旧迁移里整批退役、没人接替的官网岗位（superseded 而没有 superseded_by）：官网上还挂着就捞回来重新判断，
    // 不让一条退役记录永远挡住这个岗位（以前一家公司好几个在招岗位因此一直没被判断过）。并进别的线索的、真人帖更正掉的不动。
    if (existing && existing.superseded && !existing.superseded_by && existing.source === "official_ats") {
      const revived = { ...existing, revived_at: new Date().toISOString(), revived_from: String(existing.superseded).slice(0, 120) };
      delete revived.superseded;
      for (const f of ["role", "location", "jd_text", "posted_at", "url", "source_job_id", "work_mode"]) if (lead[f] !== undefined) revived[f] = lead[f];
      map.set(id, revived);
      updated++;
      continue;
    }
    // 官网再读到同一个岗位时也更新地点事实；否则旧的「China」永远吃不到已补上的远程标记。
    // 编号、判断、批准和投递记录仍归原来的线索。
    if (existing && lead.source === 'official_ats' && atsKey(lead) === atsKey(existing)) {
      const patch = {};
      for (const f of ['location', 'needs_city_check', 'location_status', 'work_mode']) if (lead[f] !== undefined && lead[f] !== existing[f]) patch[f] = lead[f];
      if (Object.keys(patch).length) { map.set(id, { ...existing, ...patch }); updated++; }
      continue;
    }
    if (!map.has(id)) {
      const at = new Date().toISOString();
      map.set(id, { ...lead, id, state: "new", state_at: at, discovered_at: at });
      for (const k of leadKeys(lead)) keys.set(k, id);
      if (atsKey(lead)) ats.set(atsKey(lead), id);
      if (bossKey(lead)) boss.set(bossKey(lead), id);
      added++;
    }
  }
  return { leads: [...map.values()], added, updated };
}

// 一个明确的岗位页可以独立于标题、公司别名认同一份招聘；招聘首页仍按旧复合键。
export function postingKey(l = {}) {
  const url = canonicalUrl(l.application_url || l.url || l.source_url);
  if (!url) return null;
  const u = new URL(url);
  const board = /^(?:jobs\.ashbyhq\.com|jobs\.lever\.co|(?:job-)?boards\.greenhouse\.io)$/.test(u.hostname);
  if (l.source === 'official_ats' && l.source_job_id) return `ats:${u.hostname}:${u.pathname.split('/')[1] || ''}:${l.source_job_id}`;
  if ((board && /^\/[^/]+\/[^/]+/.test(u.pathname)) || /job(?:s)?[-_/](?:detail|view)|position[-_/](?:detail|view)|requisition|\/job\//i.test(u.pathname) || [...u.searchParams.keys()].some(k => /^(?:jobid|job_id|positionid|requisitionid)$/i.test(k))) return url;
  return null;
}
export function possibleDuplicates(l, rows = []) {
  const field = x => leadFields(x);
  const me = field(l), id = l.record_id || l.id;
  const text = x => String(x.original_body || x.jd_text || '').replace(/\s+/g, '').toLowerCase();
  return rows.filter(x => {
    if (x.superseded || (x.record_id || x.id) === id) return false;
    if (postingKey(l) && postingKey(l) === postingKey(x)) return true;
    const other = field(x);
    return !!me.company && me.company === other.company && me.role.length > 5 && me.role === other.role && me.location === other.location
      || !!l.author && l.author === x.author && text(l).length > 80 && text(l) === text(x);
  }).map(x => ({ rid: x.record_id || x.id, number: x.number ?? null, role: field(x).role }));
}
