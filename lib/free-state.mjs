// OfferCrew 补给在本机的几样事实：供应商叫什么、令牌和状态存在哪、接没接上。只读文件，不联网、不改设置。
// 从 lib/free-model.mjs 拆下来（10-05）：lib/text-conf.mjs 要知道「领没领过补给」才定得出默认链，
// 而 free-model 又要从 text-conf 取文字链，两边互相引成环。这几样放在两者底下，free-model 原样转出去，调用方不用改。
import { read } from './store.mjs';
import { loadProviders } from './backends.mjs';

export const FREE_PROVIDER = 'offercrew';
export const FREE_AUTH = `private/providers/${FREE_PROVIDER}.auth.json`;
export const FREE_STATE = 'state/free-model.json';

// 10-03 起补给跟着账户走（lib/account.mjs）：登录了就用账户令牌（account_token，oca_…），没登录才用这台电脑原来的安装令牌（auth_token，oc_…，
// 登录时交给中转并号，见 design/handoff/账户-接口.md 第五节）。两样都只在 private/providers/offercrew.auth.json 里，不进日志、不进页面。
export const bearerOf = a => (typeof a?.account_token === 'string' && a.account_token ? a.account_token : typeof a?.auth_token === 'string' && a.auth_token ? a.auth_token : null);
export const tokenOf = () => bearerOf(read(FREE_AUTH, null));
export const freeState = () => read(FREE_STATE, {}) || {};
export function freeEnabled(providers = null) {
  try { return !!(providers || loadProviders())[FREE_PROVIDER] && !!tokenOf(); } catch { return false; } // 兜底：模型目录读坏了在设置 → 模型里会照实报；这里当没接补给
}
