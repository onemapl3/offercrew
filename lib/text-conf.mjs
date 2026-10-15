// config/model.json 的 text / vision 段，以及「没写」时用哪条默认链（兜底清单复核 A07 / A08，10-03）。
// 以前没写 text 就当 { driver: 'codex_exec' }，悄悄用这台电脑上登录的 Codex（~/.codex）——这违反「你没选过的本机运行时不能顶上」。
// 现在没写就是默认链：和 Mac 版新装同一个（lib/data-root.mjs DESKTOP_DEFAULTS 写空清单，引导里接上补给后清单里只有补给），
// 也就是领过令牌就用 OfferCrew 补给（中转说的默认模型），没领过就是空的：没有模型，挡路横条照「model」那一类说（lib/blockers.mjs）。
// 自己写了 text（命令行装的模板、设置页保存过的、明写 driver: 'codex_exec' 的）一律照写的用。
// 读 text 的地方（lib/model.mjs infer / textReady、lib/blockers.mjs、设置页 lib/model-choice.mjs、首轮清单 lib/setup.mjs、
// 团队页 lib/crew-desk.mjs、健康账本 lib/system/health.mjs、对话 lib/chat.mjs）都从这里取，结论一致。
import { read } from './store.mjs';
import { loadProviders } from './backends.mjs';
import { FREE_PROVIDER, freeEnabled, freeState } from './free-state.mjs';

export const MODEL_CONFIG = 'config/model.json';
// 默认链里的那一条补给：{ provider: 'offercrew', model }，没领过令牌（或目录里没有它）就是 null。
export function defaultFreeRef(providers = loadProviders()) {
  try {
    if (!freeEnabled(providers)) return null;
    const models = providers[FREE_PROVIDER]?.models || [], want = freeState().models?.default;
    const model = models.includes(want) ? want : models[0] || want || null;
    return model ? { provider: FREE_PROVIDER, model } : null;
  } catch { return null; } // 兜底：算不出就当没接补给（null），调用方按默认链走
}
// 没写 text 时的那一段。default_chain 让调用方分得清「你写的」和「默认的」。
export function defaultTextConf(providers) {
  const free = defaultFreeRef(providers);
  return { driver: 'backends', backends: free ? [free] : [], default_chain: true };
}
// purpose：'text' | 'vision'。看图没有默认链（补给不收图），没写就是空的。
export function modelConf(purpose = 'text', { config = null, providers } = {}) {
  const c = (config || read(MODEL_CONFIG, {}) || {})[purpose];
  if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  return purpose === 'text' ? defaultTextConf(providers) : { driver: 'backends', backends: [], default_chain: true };
}
export const textConf = (opts = {}) => modelConf('text', opts);
