// 能力表（lib/capabilities.mjs，core）问「文字模型从哪来」要的那一问：textReady、第一个能用的底座是哪一家。
// model、backends、text-conf 都在 domain，能力表不往上引它们；要它看得到模型的进程启动时调一次 loadTextProbe()。
import { textReady, backendsFor } from './model.mjs';
import { loadProviders, textBackendUsable } from './backends.mjs';
import { modelConf } from './text-conf.mjs';
import { loadCapabilities } from './capabilities.mjs';

export const textProbe = {
  textReady: () => textReady(),
  firstProvider: () => {
    const conf = modelConf('text');
    if (conf.driver === 'http_api') return 'http_api';
    const b = backendsFor(conf, loadProviders(), { purpose: 'text' }).find(x => { try { return textBackendUsable(x); } catch { return false; } }); // 兜底：凭据解析不了的不算能用
    return b?.provider || null;
  },
};
export const loadTextProbe = () => loadCapabilities({ model: textProbe });
