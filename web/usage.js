// 用量的几个小工具（10-03 起「运行与用量」那一页退了：补给的流水在左下角账户面板 web/account.js，花费上限在「设置 → 花费」）：
// token 和钱怎么说、到了花费上限时右上角那个小条（数据 /api/usage/today）。
let h = null;

// ── 数字怎么说（和 lib/spend.mjs tokenText / cnyText 一样）─────────────────────
export function tokenText(n) {
  const x = Math.max(0, Number(n) || 0);
  if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e8 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (x >= 1e3) return `${Math.round(x / 1e3)}k`;
  return String(Math.round(x));
}
export function cnyText(cny) {
  const x = Math.max(0, Number(cny) || 0);
  if (!x) return '¥0';
  if (x < 0.1) return '不到 ¥0.1';
  return `¥${x < 10 ? x.toFixed(1).replace(/\.0$/, '') : Math.round(x)}`;
}
// 胶囊上的一句话：今日 1.2M token · 约 ¥8；只用了订阅的写「订阅额度」；到了上限加一句。
export function pillText(t = {}) {
  const money = t.usd > 0 || t.api_tokens > 0 ? `约 ${cnyText(t.cny)}` : t.credits > 0 || t.credit_tokens > 0 ? `补给 ${supplyText(t.credits)}` : t.tokens ? '订阅额度' : '';
  return { text: [`今日 ${tokenText(t.tokens)} token`, money].filter(Boolean).join(' · '), short: [tokenText(t.tokens), t.usd > 0 ? cnyText(t.cny) : ''].filter(Boolean).join(' · '), cap: !!t.budget?.reached };
}

// ── 到上限的提醒 ─────────────────────────────────────────────────────────────
// 平时什么都不显示；只有今天的花费上限到了，右上角一个小条，点一下到「设置 → 花费」。30 秒内不重复取。
let pillAt = 0;
export async function paintPill(helpers, { force = false } = {}) {
  h = h || helpers;
  if (!force && Date.now() - pillAt < 30000) return;
  pillAt = Date.now();
  let t; try { const r = await fetch('/api/usage/today'); if (!r.ok) return; t = await r.json(); } catch { return; }
  const p = pillText(t), box = document.querySelector('#notices');
  let a = document.querySelector('#spend-pill');
  if (!p.cap) { a?.remove(); return; }
  if (!a) { if (!box) return; a = document.createElement('a'); a.id = 'spend-pill'; a.href = '#settings/spend'; box.append(a); }
  a.className = 'spend-pill is-cap';
  a.innerHTML = `<i aria-hidden="true"></i>今天的花费上限到了`;
  a.title = `${p.text}${t.budget?.enabled ? ` · 上限 ${t.budget.limit_text}` : ''}`;
}

// 到了上限的后果：花费设置（web/setup.js）用这一句。
export const CAP_TEXT = '到了上限：新的判断、匹配、找人和自动调研停下，留到明天；已经批准的发信、投递和做到一半的事照常做完。';
// 数字按万、亿（和 lib/free-model.mjs tokenText 一样）。
export const supplyText = n => { const x = Math.max(0, Math.floor(Number(n) || 0)), cut = (v, d) => String(Math.floor(v * 10 ** d + 1e-9) / 10 ** d); return x >= 1e8 ? `${cut(x / 1e8, 2)} 亿` : x >= 1e4 ? `${cut(x / 1e4, x >= 1e6 ? 0 : 1)} 万` : String(x); };
