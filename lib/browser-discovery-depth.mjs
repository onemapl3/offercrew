// Depth follows the actual marginal yield, not a target number of leads.
// Exhaustion / two pages without an unseen candidate end one query; a deadline
// is partial coverage and must not be cached as a completed source scan.
export async function collectSearch({ read, advance, key, candidate, known = new Set(), deadline = Infinity, now = Date.now }) {
  const posts = [], seen = new Set();
  let rounds = 0, candidates = 0, quiet = 0, cursor = null, unchanged = false, stop_reason = null;
  while (!stop_reason) {
    if (now() + 5000 >= deadline) { stop_reason = 'time_budget'; break; }
    const page = unchanged ? { rows: [] } : await read(cursor);
    rounds++;
    let gain = 0;
    for (const post of page.rows || []) {
      const id = key(post);
      if (!id || seen.has(id)) continue;
      seen.add(id); posts.push(post);
      if (!known.has(id) && candidate(post)) gain++;
    }
    candidates += gain;
    if (page.blocked) return { posts, rounds, candidates, stop_reason: page.blocked, blocked: page.blocked, page };
    if (page.time_budget || page.cursor && !page.rows?.length) { stop_reason = 'time_budget'; break; }
    // A partial DOM read resumes that same page; it is not a low-yield page.
    if (page.cursor) { cursor = page.cursor; continue; }
    quiet = gain ? 0 : quiet + 1;
    if (quiet >= 2) { stop_reason = 'low_yield'; break; }
    if (now() + 5000 >= deadline) { stop_reason = 'time_budget'; break; }
    const next = await advance();
    if (next.time_budget) { stop_reason = 'time_budget'; break; }
    if (next.blocked) return { posts, rounds, candidates, stop_reason: next.blocked, blocked: next.blocked, page: next };
    if (!next.advanced) { stop_reason = 'exhausted'; break; }
    cursor = next.cursor || null;
    unchanged = next.unchanged === true;
  }
  return { posts, rounds, candidates, stop_reason, partial: stop_reason === 'time_budget' };
}

// Check whether scrolling actually changed the rendered result cards before
// repeating costly per-card permalink reads. No browser-private state is read.
export function searchResultsFingerprint() {
  return JSON.stringify([...document.querySelectorAll('li.list-group-item.clearfix,li.list-group-item.cursor-pointer,[role="listitem"][componentkey^="update-card-focus"],.feed-shared-update-v2,[data-urn^="urn:li:activity"],li.job-card-box,li.job-card-wrapper,section.note-item')]
    .map(el => el.outerHTML));
}

// Only controls within a result pager are clicked. Scrolling reads more cards;
// it never clicks a post's engagement/contact actions. Self-contained for page.evaluate.
export function advanceSearchResults() {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const pager = 'nav,[role="navigation"],.pagination,.pager,[class*="pagination"],[class*="Pagination"]';
  const cardSelector = 'li.list-group-item,article,[role="listitem"][componentkey],.feed-shared-update-v2,li.job-card-box,li.job-card-wrapper,section.note-item';
  const next = [...document.querySelectorAll('a,button,[role="button"]')].find(el =>
    visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
    && !el.closest('[aria-disabled="true"],.disabled') && el.closest(pager)
    && !el.closest(cardSelector) && el.getAttribute('type') !== 'submit'
    && /^(下一页|下页|next(?: page)?|加载更多|更多结果|show more results|see more results)$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim())
    && (!el.href || new URL(el.href, location.href).origin === location.origin));
  if (next) { next.click(); return { advanced: true, method: 'next' }; }
  const cards = document.querySelectorAll('li.list-group-item.clearfix,li.list-group-item.cursor-pointer,[role="listitem"][componentkey^="update-card-focus"],.feed-shared-update-v2,li.job-card-box,li.job-card-wrapper,section.note-item');
  const last = cards[cards.length - 1];
  if (!last) return { advanced: false, method: 'empty' };
  last.scrollIntoView({ block: 'end' });
  for (let el = last.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
      el.scrollTop = el.scrollHeight;
      return { advanced: true, method: 'scroll' };
    }
  }
  window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  return { advanced: true, method: 'scroll' };
}
