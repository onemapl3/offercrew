// 花费：档位、每天花费上限、每天 token 上限（表单和保存在 web/setup.js，不变）；今天用了多少（10-03「运行与用量」那一页退了）。
import { esc } from './ui.js';
import { spendSection, bindSpendSection } from '../setup.js';
import { tokenText, cnyText } from '../usage.js';

const TIER = { economy: '省钱', standard: '标准', premium: '高级' };
const cap = D => D.usage?.budget?.cap || {};
const money = D => (cap(D).daily_usd == null ? '不限' : `¥${Math.round(cap(D).daily_usd * (D.usage?.budget?.usd_cny || 7) * 100) / 100}`);
const tokens = D => (cap(D).daily_tokens == null ? '不限' : `${tokenText(cap(D).daily_tokens)} token`);
export default {
  id: 'spend', title: '花费', icon: 'coin',
  summary: D => `${TIER[D.usage?.tier] || '标准'}档 · 每天上限 ${money(D)}`,
  glance: D => `今天 ${esc(cnyText(D.usage?.today?.cny || 0))} · 上限 ${esc(money(D))}<br>${esc(TIER[D.usage?.tier] || '标准')}档`,
  cards: D => [{ rows: [
    { id: 'tier', label: '档位', value: esc(TIER[D.usage?.tier] || '标准'), sub: 'limits', words: '省钱 标准 高级' },
    { id: 'usd', label: '每天花费上限', value: esc(money(D)), sub: 'limits', words: '钱 预算 上限' },
    { id: 'tokens', label: '每天 token 上限', value: esc(tokens(D)), sub: 'limits', words: 'token 用量' },
  ] }, { rows: [
    { id: 'today', label: '今天用了', value: `自有 API ${esc(cnyText(D.usage?.today?.cny || 0))} · 补给 ${esc(D.usage?.today?.credits || 0)} · ${esc(tokenText(D.usage?.today?.tokens || 0))} token`, note: 'token 是处理的文字量，补给是按模型价格扣的额度，两者不等同。人民币只估算自有 API 的花费，订阅账号和补给另记。', words: 'token 用量 花了多少' },
  ] }],
  subs: { limits: { title: '档位与每天上限', render: D => spendSection(D.h), bind: () => bindSpendSection() } },
};
