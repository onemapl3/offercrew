// 「设置 → 模型」最上面那一块：现在用的是哪一种模型、能不能用，以及「换成它」。
//
// 「换成 OfferCrew 补给」也在这里（startFreeModel、redeemFreeCode、useFreeModel）：lib/free-model.mjs 只管补给本身（令牌、余额、
// 目录里的供应商 offercrew），领到以后换不换文字模型、对话默认是这一层的事（10-05 从补给模块挪上来，补给不再引设置和对话）。
//
// 四种来源（和引导的模型一步同一个顺序）：OfferCrew 补给（lib/free-model.mjs）、ChatGPT 账号（Codex 登录）、这台电脑上的
// Claude Code / Codex、自己的 API key（lib/provider-presets.mjs 的预设）。现在用的 = 文字模型清单（config/model.json
// text.backends）里第一个能用的（lib/backends.mjs textBackendUsable，只看本机文件和 PATH，不调模型；真要确认就点「测试」）。
// 每位成员单独的模型、base_url、协议这些都还在「高级」里，这里不碰。
import { read } from './store.mjs';
import { event } from './events.mjs';
import { loadProviders, resolveBackend, textBackendUsable, isLocalRuntime, markLocalPicked, dropUnpickedLocal, localPicked } from './backends.mjs';
import { FREE_PROVIDER, freeQuotaView, claimFree, connectFree, redeemCode, remainingLabel, freeBlocked } from './free-model.mjs';
import { localView } from './onboarding.mjs';
import { textConf } from './text-conf.mjs';
import { sandboxNote } from './model-truth.mjs';

const KIND_TITLE = { free: 'OfferCrew 补给', chatgpt: 'ChatGPT 账号', claude: '这台电脑上的 Claude Code', codex: '这台电脑上的 Codex', key: '自己的 API key', none: '还没有能用的模型' };
export function sourceOf(b) {
  if (!b) return 'none';
  if (b.provider === FREE_PROVIDER) return 'free';
  if (b.kind === 'claude_code') return 'claude';
  // Codex 用内置的 openai 供应商：有自己登录目录的账号（Mac 版「用 ChatGPT 账号登录」的 openai@app、设置里加的账号）是 ChatGPT 账号；
  // 用默认登录目录（~/.codex，终端里 codex login 的那个）的是「这台电脑上的 Codex」（10-02 主会话，开箱第 2 轮 X5 的后续）。
  if (b.kind === 'codex_exec') return b.codex_provider === 'openai' ? (b.codex_home ? 'chatgpt' : 'codex') : 'key';
  return 'key';
}
// 没写 text 段就是默认链（lib/text-conf.mjs），和 infer 用的同一条。
function chain(providers = loadProviders()) {
  const conf = textConf({ providers });
  return dropUnpickedLocal((Array.isArray(conf.backends) ? conf.backends : []).map(r => { try { return resolveBackend(r, providers); } catch { return null; } }).filter(Boolean)); // 兜底：解析不了的那一项跳过（和对话的清单同一条规矩）
}

// GET /api/model/source
export function modelSourceView() {
  const providers = loadProviders(), list = chain(providers).map(b => ({ b, usable: textBackendUsable(b) }));
  const first = list.find(x => x.usable)?.b || null, kind = sourceOf(first);
  const free = freeQuotaView();
  let status = null, ok = !!first;
  if (kind === 'free') { status = free?.blocked ? free.blocked.reason : free?.label || null; ok = !free?.blocked; }
  else if (kind === 'none') status = '选下面一种，就能导入简历、判断岗位了。';
  else { const n = list.filter(x => x.usable).length - 1; status = `${first.model === 'default' ? '用它自己的默认模型' : `模型 ${first.model}`}${n > 0 ? `，后面还有 ${n} 个备用` : ''}`; }
  // 演示 / 沙盒模式：和右侧面板、团队页同一句（lib/model-truth.mjs），「正在用」不亮。
  const sb = sandboxNote();
  if (sb) { status = sb; ok = false; }
  return {
    kind, title: kind === 'key' ? (providers[first.provider]?.label || first.provider) : KIND_TITLE[kind], status, ok,
    ref: first ? `${first.provider}/${first.model}` : null, test_ref: first?.id || null,
    local: localView(), free: free ? { install_id: free.install_id, label: free.label } : null,
    keys: Object.values(providers).filter(p => p.user && p.kind !== 'codex_exec' && p.key !== FREE_PROVIDER && p.models?.length).map(p => ({ key: p.key, label: p.label, ref: `${p.key}/${p.models[0]}`, usable: textBackendUsable(p) })),
    chain: list.map(({ b, usable }) => ({ ref: `${b.provider}/${b.model}`, source: sourceOf(b), usable })),
  };
}

// POST /api/model/source { use: '供应商/模型' }：把它放到文字模型清单第一位（原来能用的留作后备，最多 4 个），
// 对话的默认也换成它。走设置页同一个入口（校验、备份）。
export async function useTextModel(ref) {
  const providers = loadProviders();
  let b; try { b = resolveBackend(String(ref || ''), providers); } catch (e) { throw Object.assign(Error(`没有这个模型：${String(ref || '').slice(0, 80)}`), { status: 400 }); }
  if (!['anthropic_http', 'openai_http', 'claude_code', 'codex_exec'].includes(b.kind)) throw Object.assign(Error('这个模型不能用来写字'), { status: 400 });
  if (!textBackendUsable(b)) throw Object.assign(Error('这个模型现在用不了（没有 key、没登录或没装）'), { status: 409 });
  const { updateSettings } = await import('./settings.mjs');
  const spec = x => ({ provider: x.provider, model: x.model, ...(x.effort ? { effort: x.effort } : {}) });
  const rest = chain(providers).filter(x => x.id !== b.id && textBackendUsable(x)).map(spec);
  // 选择的是明确的型号。设置页切换默认不重写已有角色/步骤覆盖；初次引导的模板另有入口。
  updateSettings('model', { 'text.backends': [spec(b), ...rest].slice(0, 4) });
  updateSettings('chat', { default: b.id });
  if (isLocalRuntime(b)) markLocalPicked([b.id]);
  event('user', 'settings', 'ok', `设置 → 模型：文字模型和对话默认换成 ${b.id}`);
  return { status: 'saved', ref: b.id, source: sourceOf(b) };
}

// ── OfferCrew 补给 ─────────────────────────────────────────────────────────────
// POST /api/model/free { action: 'start' }：领补给（lib/free-model.mjs claimFree），再按下面的规矩换文字模型、对话默认。
// 返回 { status, body }：成功 200 { ok, remaining_label }；用不了 409 { error, reason }。
// make_default：设置页里你明确选了 OfferCrew 补给，就把它放到文字模型清单第一位（你自己配过的留作后备）；
// 不写的时候只在没有别的文字模型能用时才把它设成文字模型。model：换一个中转允许的模型（不写就用中转说的默认）。
export async function startFreeModel({ make_default = false, model = null, now = Date.now() } = {}) {
  const c = await claimFree({ model, now });
  if (c.status) return c;
  const used = await useAsTextModel({ force: make_default === true || model != null, providers: c.providers, model: c.model });
  event('user', 'free-model', 'ok', `开始用 OfferCrew 补给（${remainingLabel(c.quota, now) || '余额待查'}）${used.text ? '；文字模型用它' : ''}${used.chat ? '；对话默认用它' : ''}`);
  const blocked = freeBlocked({ now });
  return { status: 200, body: { ok: true, remaining_label: remainingLabel(c.quota, now), model: c.model, text_model: used.text, chat_default: used.chat, ...(blocked ? { reason: blocked.reason } : {}) } };
}
// 已经有令牌（登录了账户、第一次兑换码）：接上供应商 offercrew；没有别的文字模型能用（或者 force）就让它当文字模型和对话默认。
// 回 { model, text, chat } 或 { error, reason }。
export async function useFreeModel({ model = null, force = false } = {}) {
  const c = await connectFree({ model });
  if (c.error) return c;
  return { model: c.model, ...(await useAsTextModel({ force, providers: c.providers, model: c.model })) };
}
// POST /api/model/free { action: 'redeem', code }：兑换（lib/free-model.mjs redeemCode）；第一次用到补给就接上
// （有别的能用的文字模型就只加进目录，不抢默认）。回 { status, body }。
export async function redeemFreeCode(opts = {}) {
  const { wire, ...r } = await redeemCode(opts);
  if (wire && r.status === 200) { const w = await useFreeModel({}); if (!w.error) r.body.text_model = !!w.text; }
  return r;
}
// 文字模型、对话默认：没有别的能用的（或者你明确选了它）就用补给。走设置页同一个入口（校验、备份）。
async function useAsTextModel({ force = false, providers = loadProviders(), model } = {}) {
  // chatConfig 在 chat.mjs（以前从 settings.mjs 拿，拿到的是 undefined，对话默认总被换成补给）。
  const [{ updateSettings }, { chatConfig }] = await Promise.all([import('./settings.mjs'), import('./chat.mjs')]);
  const out = { text: false, chat: false };
  const list = chain(providers), free = { provider: FREE_PROVIDER, model };
  const others = list.filter(b => b.provider !== FREE_PROVIDER);
  const usable = others.filter(b => textBackendUsable(b));
  // 默认链（没写 text）里本来就是补给：也把它写进 config/model.json，你选过的就是明写的，不靠默认。
  const alreadyFirst = !textConf({ providers }).default_chain && list[0]?.provider === FREE_PROVIDER && list[0].model === model;
  if (!alreadyFirst && (force || !usable.length)) {
    // 后备只留现在真能用的（10-01 开箱测试 #21）：以前「设为默认」（引导里选免费额度）把模板里的 claude_subscription/sonnet、
    // openai/default 原样留着，新用户根本没有，它们还出现在每一次调用的说明里。
    // 也只留你自己配过的（10-02 负责人）：模板里的本机 Claude Code / Codex 你没选过，补给用完以后不悄悄换过去。
    const rest = usable.filter(b => !isLocalRuntime(b) || localPicked()).map(b => ({ provider: b.provider, model: b.model, ...(b.effort ? { effort: b.effort } : {}) }));
    updateSettings('model', { 'text.backends': [free, ...rest].slice(0, 4) });
    out.text = true;
  } else if (alreadyFirst) out.text = true;
  // 对话：默认底座不能用（或者你明确选了补给）就换成它。
  let def = null; try { def = resolveBackend(chatConfig().default, providers); } catch {} // 兜底：默认底座解析不了就当没有，下面会换成补给
  if (def?.provider === FREE_PROVIDER && def.model === model) out.chat = true;
  else if (force || def?.provider === FREE_PROVIDER || !def || !textBackendUsable(def)) { updateSettings('chat', { default: `${FREE_PROVIDER}/${model}` }); out.chat = true; }
  return out;
}
