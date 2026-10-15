// 模型与补给：接入来源、默认模型、成员模型（web/model-settings.js 整块照用，它自己读数据、自己保存）。
// 下面几行通往别处：供应商的地址、协议、删除在「高级」。补给的余额和流水在左下角的账户面板（web/account.js）。
// 摘要先用 web/model-settings.js 读到的型号目录（实际默认的供应商 · 型号）；还没读到时用 /api/setup 的旧摘要。
import { esc } from './ui.js';

const step = D => (D.setup?.steps || []).find(s => s.key === 'models');
const sum = () => globalThis.OfferCrewModelSimple?.summary?.() || null;
const oldWords = D => String(step(D)?.summary || '').split(' · ')[0].replace(/^文字模型：/, '');
export default {
  id: 'model', title: '模型与补给', icon: 'cpu',
  summary: D => (sum()?.model || oldWords(D)).slice(0, 30) || '还没选',
  glance: D => { const s = sum(); return s ? esc(s.model || '还没选') : `${esc(oldWords(D))}${step(D)?.status === 'ok' ? '<br>能用' : ''}`; },
  // model-settings.js 由 app.js 载入，挂在 window.OfferCrewModelSimple 上（同一个实例，状态不丢）。
  top: () => `<div class="st-ms">${globalThis.OfferCrewModelSimple?.html() || '<div id="settings-model" class="ms" data-model-simple><p class="muted">正在读取…</p></div>'}</div>`,
  cards: () => [],
  index: () => [
    { id: 'x-default', label: '默认模型', value: '', words: '型号 模型 默认 切换 测试', go: '#settings/model' },
    { id: 'x-roles', label: '成员的模型', value: '', words: '角色 成员 单独设置 跟随默认 覆盖', go: '#settings/model' },
    { id: 'x-providers', label: '供应商与型号列表', value: '', words: '供应商 添加 自定义 兼容 拉取 型号列表 DeepSeek OpenRouter key', go: '#settings/model' },
    { id: 'x-free', label: 'OfferCrew 补给', value: '', words: '补给 中转 账号', go: '#settings/model' },
    { id: 'x-redeem', label: '兑换码', value: '', words: '补给 兑换', go: '#settings/model' },
    { id: 'x-chatgpt', label: 'ChatGPT 账号', value: '', words: 'Codex 登录', go: '#settings/model' },
  ],
};
