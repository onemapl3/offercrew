// A Maimai post keeps its identity when search highlights/tracking change.
export function maimaiPostKey(lead) {
  try {
    const url = new URL(lead.url || lead.source_url);
    if (url.hostname !== 'maimai.cn' || !/^https?:$/.test(url.protocol)) return null;
    if (!/^\/web\/(feed|gossip)_detail$/.test(url.pathname)) return null;
    const fid = url.searchParams.get('fid'), gid = url.searchParams.get('gid');
    return fid ? `maimai:fid:${fid}` : gid ? `maimai:gid:${gid}` : null;
  } catch { return null; } // 兜底：写得不像网址就不认
}

export function maimaiPostKeys(lead) {
  const key = maimaiPostKey(lead);
  if (!key) return [];
  return [...new Set([key, ...(key.startsWith('maimai:fid:') && Array.isArray(lead.cluster_ids)
    ? lead.cluster_ids.map(fid => `maimai:fid:${fid}`) : [])])];
}

export function maimaiLeadGroupKey(lead) {
  if (lead.source !== '脉脉' || lead.anonymous === true || lead.human === false
    || !maimaiPostKey(lead)?.startsWith('maimai:fid:')) return null;
  const author = String(lead.author || '').normalize('NFKC').trim();
  // Keep company qualifiers: a recruiter's distinct client companies must not
  // collapse just because their legal names or bylines share a prefix.
  const company = String(lead.company || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return author && company ? JSON.stringify([author, company]) : null;
}

const OTHER_ROLES = '\n\n同一发帖人的其他岗位：\n';
const fidOf = lead => maimaiPostKey(lead)?.slice('maimai:fid:'.length);
const postedAt = lead => Number.isFinite(Date.parse(lead.posted_at)) ? Date.parse(lead.posted_at) : -Infinity;

// The explicit primary keeps an already stored contact's identity/content when
// merging an overlapping discovery batch. Fresh groups use their newest post.
export function mergeMaimaiCluster(group, primary) {
  const posts = new Map();
  for (const lead of group) {
    const entries = lead.cluster_posts || [{ fid: fidOf(lead), role: lead.role, url: lead.url || lead.source_url }];
    for (const post of entries) if (!posts.has(post.fid)) posts.set(post.fid, { ...post });
  }
  const primaryFid = fidOf(primary);
  const primaryPost = primary.cluster_posts?.find(post => post.fid === primaryFid)
    || { fid: primaryFid, role: primary.role, url: primary.url || primary.source_url };
  posts.set(primaryFid, { ...primaryPost });
  const cluster_ids = [...new Set(group.flatMap(lead => [...(lead.cluster_ids || []), fidOf(lead)]))];
  if (cluster_ids.length < 2) return primary;
  const cluster_posts = [...posts.values()];
  const roles = [...new Set(cluster_posts.map(post => post.role))];
  const others = cluster_posts.filter(post => post.fid !== primaryFid).map(post => `- ${post.role}：${post.url}`);
  const text = String(primary.text || primary.original_body || primary.jd_text || '').split(OTHER_ROLES)[0];
  return {
    ...primary,
    role: roles.length > 1 ? `${primaryPost.role} 等 ${roles.length} 个岗位` : primaryPost.role,
    roles,
    text: text + (others.length ? OTHER_ROLES + others.join('\n') : ''),
    cluster_ids,
    // Retain original titles and links so overlapping batches can extend a
    // cluster without treating its display title as another job title.
    cluster_posts,
  };
}

export function clusterMaimaiLeads(leads) {
  const groups = new Map();
  for (const lead of leads) {
    const key = maimaiLeadGroupKey(lead) || Symbol();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lead);
  }
  return [...groups.values()].map(group => {
    if (group.length === 1 || !maimaiLeadGroupKey(group[0])) return group[0];
    const primary = group.reduce((best, lead) => postedAt(lead) > postedAt(best) ? lead : best);
    return mergeMaimaiCluster(group, primary);
  });
}
