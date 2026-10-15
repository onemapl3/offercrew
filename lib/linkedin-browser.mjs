// LinkedIn's current search cards expose the post URL in the copy-link toast.
// Read that rendered link; never request permission to read the user's clipboard.
export function linkedinPostUrl(value) {
  try {
    let u = new URL(value);
    if (u.hostname === 'www.linkedin.com' && u.pathname === '/safety/go/') u = new URL(u.searchParams.get('url'));
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (u.hostname === 'lnkd.in' && /^\/p\/[\w-]+\/?$/.test(u.pathname)) return u.href;
    if (['www.linkedin.com', 'linkedin.com'].includes(u.hostname) && /^\/(?:feed\/update\/urn:li:|posts\/)/.test(u.pathname)) return u.href;
  } catch {} // 兜底：写得不像网址就不认（下一行 null）
  return null;
}

// Self-contained so the browser CLI can execute this function in its Node host.
export async function readLinkedinPosts(page, extractor, normalizeUrl, { deadline = Infinity } = {}) {
  await page.evaluate(() => {
    for (const card of document.querySelectorAll('[role="listitem"][componentkey^="update-card-focus"]')) {
      card.querySelector('button[data-testid="expandable-text-button"]')?.click();
    }
  });
  const rows = await page.evaluate('(' + extractor + ')()');
  for (const row of rows.filter(row => row.permalink_missing)) {
    if (Date.now() + 15000 >= deadline) break;
    try {
      // LinkedIn keeps the copy-link toast mounted and a scripted Dismiss click
      // does not remove it, so a card only gets a URL once the toast shows a
      // link different from the one it showed before this card was copied.
      // An unchanged toast times out instead of lending its URL to this card.
      const previous = await page.evaluate(() => document.querySelector('[role="alert"] a')?.href || null);
      const hasMenu = await page.evaluate(id => {
        const card = [...document.querySelectorAll('[role="listitem"][componentkey]')].find(el => el.getAttribute('componentkey') === id);
        const menu = card?.querySelector('button[aria-label^="Open control menu for post by"]');
        return !!menu;
      }, row.id);
      if (!hasMenu) continue;
      const menuButton = '[role="listitem"][componentkey=' + JSON.stringify(row.id) + '] button[aria-label^="Open control menu for post by"]';
      // Right after a search page loads the first menu click can be swallowed;
      // open it once more before giving up on this card.
      for (let attempt = 0; ; attempt++) {
        await page.click(menuButton);
        try { await page.waitForSelector('text="Copy link to post"', { timeout: 5000 }); break; } catch (error) { if (attempt) throw error; }
      }
      await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.innerText.trim() === 'Copy link to post')?.click());
      await page.waitForFunction(prev => {
        const href = document.querySelector('[role="alert"] a')?.href;
        return !!href && href !== prev;
      }, previous, { timeout: 6000 });
      const observed = await page.evaluate(() => document.querySelector('[role="alert"] a')?.href);
      // The toast lingers ~10 s over the lower cards and intercepts their menu
      // clicks; let pointer events pass through it (its link is already read).
      await page.evaluate(() => {
        const alert = document.querySelector('[role="alert"]');
        for (const el of alert ? alert.querySelectorAll('*') : []) el.style.setProperty('pointer-events', 'none', 'important');
        for (let el = alert; el && el !== document.body && !el.querySelector('[role="listitem"]'); el = el.parentElement) el.style.setProperty('pointer-events', 'none', 'important');
      });
      const url = normalizeUrl(observed);
      if (!url) throw Error('linkedin_post_link_not_recognized');
      row.url = url;
      row.permalink_missing = false;
      row.permalink_evidence = 'rendered_copy_link_toast';
      row.permalink_detail_verified = false;
      // More results may append below the same cards. Reuse the URL already
      // read from this card's own toast instead of copying it on every scroll.
      await page.evaluate(({ id, url }) => {
        const card = [...document.querySelectorAll('[role="listitem"][componentkey]')].find(el => el.getAttribute('componentkey') === id);
        card?.setAttribute('data-radar-post-url', url);
      }, { id: row.id, url });
    } catch (error) {
      if (/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(error.message)) throw error;
      // Inspect once and stop the sequence on an unexpected page state.
      row.permalink_error = error.message;
      row.permalink_failure_page = (await page.snapshot()).slice(0, 4000);
      break;
    }
  }
  return rows;
}
