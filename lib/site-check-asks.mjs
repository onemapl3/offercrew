// 「请你接手」（主会话 10-02）：专用 Chrome 打开某个网站碰到验证页，这个网站一小时内不再自动去碰（lib/browser-sites.mjs 的
// 「先别碰」）。如果它是你打开或绑定了的来源（BOSS 直聘、脉脉、小红书照开关，LinkedIn 要绑定了），收件箱来一封信：
//   「打开这个网站」在专用 Chrome 里打开那一页、拉到最前面——你在里面过了验证，等待就清掉，信也跟着没了；
//   「知道了」收起来。同一个网站 24 小时内最多来一封（信的编号按这一轮「先别碰」开始的时间，24 小时内再被拦也是同一封）。
import { read } from './store.mjs';
import { HOLDS_PATH } from './browser-sites.mjs';
import { sourceActive, DISCOVERY_SOURCES } from './discovery-policy.mjs';

export const SITE_SOURCES = { 'linkedin.com': 'linkedin', 'zhipin.com': 'boss', 'maimai.cn': 'maimai', 'xiaohongshu.com': 'xiaohongshu' };

export function siteCheckAsks({ now = Date.now(), holds = read(HOLDS_PATH, {}), active = sourceActive } = {}) {
  const out = [];
  for (const [site, h] of Object.entries(holds || {})) {
    const src = SITE_SOURCES[site];
    if (!src || !(Date.parse(h?.until || '') > now) || !active(src)) continue;
    const label = DISCOVERY_SOURCES[src] || site;
    out.push({
      from: 'scout', id: `sitecheck:${site}:${h.letter_at || h.at}`, type: 'info', title: `${label} 要你验证`,
      question: `${label} 拦下了自动访问，要你本人过一下验证（验证码、安全检查）。验证好之前系统不会再去碰它。`,
      context: [],
      options: [
        { key: '1', label: '打开这个网站', steps: [{ type: 'open', url: h.url }], primary: true },
        { key: '2', label: '知道了', steps: [{ type: 'snooze', hours: 24 }] },
      ],
      other: null,
    });
  }
  return out;
}
