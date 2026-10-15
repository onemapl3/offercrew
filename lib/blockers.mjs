// 指挥台顶上那一条「挡路大事」（负责人 10-02：顶上除非特别重要，否则不占着；要你决定的进收件箱，进度进运行日志）。
// 只有系统走不下去、得你动手的事才上来；一次只放最要紧的一条：一句话，加一个「看原因」（打开和 System 的对话，回答由 L 线接）。
// 按轻重：
//   facts     资料文件（candidate/facts.yaml）读不了，或者引导走完以后找不到：判断、写信、填表、周期全停（lib/facts-gate.mjs）。
//             排最前：模型好好的也没用，对着空候选人判断只会判错。沙盒里也报（演示数据的资料是好的，报了就是真坏了）。
//   model     没有能用的文字模型（免费额度用完 / 被拒、能用的底座都因为钥匙失效这类错坏着、清单里一个能用的都没有）：判断、匹配、写信全停
//   alert     严重告警（lib/command-center.mjs alertsView 的 error，没恢复的；只剩挡路、有地方修的，见 lib/alert-rules.mjs）
//   phone     配过的手机连不上中转（lib/phone/link.mjs 的 offline）
// 本机 AI 没开不在这里（L2，0.1.6 负责人）：App 里引擎是唯一的手，本机 AI 只是可选的加速，等它不算挡路。
//   只有它能做的那一步进收件箱（lib/legacy-hands.mjs localAiAsks），旧版排给它的启动时收掉（settleLocalAiWaits）。
// 沙盒里不报模型：左上角的「演示 / 沙盒模式」已经说了，那里本来就不调模型。
// 每一条带 why（「看原因」要的完整内容：哪件事、卡在哪一步、为什么、能怎么办、证据链接）和 detail（同一份写成一段话，
// 「看原因」把它发给 System，web/hq.js askSystem），不只是横条上那一句。
import { read } from './store.mjs';
import { sandboxed } from './sandbox.mjs';
import { freeHold, freeBlocked, BLOCK_TITLE, FREE_PROVIDER } from './free-model.mjs';
import { textConf } from './text-conf.mjs';
import { loadProviders, resolveBackend, textBackendUsable, backendLabel } from './backends.mjs';
import { onboardingState } from './onboarding-state.mjs';
import { phoneLink } from './phone-status.mjs';
import { factsBlocker } from './facts-gate.mjs';
import { factsHealth } from './facts.mjs';
import { CREW_IDS, crewName } from './crew.mjs';
import { backendsFor } from './model.mjs';
import { yourFaults, FAULT_WORDS } from './system/breaker.mjs';
import { noteSwallowed } from './swallow.mjs';

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// 文字模型清单里有没有一个现在能用（和设置检查同一个判断，lib/backends.mjs textBackendUsable）。
// 没写 text 段就看默认链（lib/text-conf.mjs），和 infer、textReady 同一个结论。
function textModelUsable() {
  const providers = loadProviders(), conf = textConf({ providers });
  return (Array.isArray(conf.backends) ? conf.backends : []).some(r => { try { return textBackendUsable(resolveBackend(r, providers)); } catch { return false; } }); // 兜底：解析不了的那一项不算能用，设置 → 模型那里会照实显示
}

// 清单里能用的底座都因为要你出手的错坏着（钥匙失效、模型不存在、没配好；lib/system/breaker.mjs 记下的，比如只剩一个底座、钥匙
// 又失效了）：设置检查还当它能用（textBackendUsable 只看配没配），所以单算。停的只是某几位的活，就照实写那几位。没有就是 null。
export function modelFaultBlock({ faults = yourFaults(), members = CREW_IDS, listOf = null } = {}) {
  if (!faults.length) return null;
  const bad = new Map(faults.map(e => [e.backend, e]));
  const providers = loadProviders(), conf = textConf({ providers });
  const ids = listOf || (m => { try { return backendsFor(conf, providers, { role: m, purpose: 'text' }).map(b => b.id); } catch { return []; } }); // 兜底：这位成员的清单解析不了就当空的
  const stopped = [], hit = new Map();
  for (const m of members) {
    const list = ids(m);
    if (!list.length || !list.every(id => bad.has(id))) continue;
    stopped.push(m);
    for (const id of list) hit.set(id, bad.get(id));
  }
  if (!stopped.length) return null;
  const es = [...hit.values()], label = id => { try { return backendLabel(id, providers); } catch { return id; } };
  const what = `你配的 ${es.map(e => label(e.backend)).join('、')} ${FAULT_WORDS[es[0].kind] || '用不了'}`;
  return { kind: 'model', text: stopped.length === members.length ? `${what}，判断和写信先停了` : `${what}，${stopped.map(crewName).join('、')}的活先停了` };
}

// 一条告警的完整内容：那句话，加上每一项的原话（lib/command-center.mjs 给的 detail）。
export const alertDetail = a => { const d = (Array.isArray(a.detail) ? a.detail : []).filter(x => typeof x === 'string' && x.trim()); return d.length ? `${a.msg}：${d.join('；')}` : String(a.msg ?? ''); };

// 各项的输入都能传进来（测试、或者调用方已经算过）；不传就现读。facts 是 lib/facts.mjs factsHealth() 的结果。
// 没写 text 段、默认链里只有补给（lib/text-conf.mjs）：补给被拒着就和 freeHold 一样说（freeHold 只看写下来的清单）。
function defaultChainHold() {
  try { const c = textConf(); return c.default_chain && c.backends.some(b => b.provider === FREE_PROVIDER) ? freeBlocked() : null; } catch (e) { noteSwallowed('blockers.free', e, { doing: '看补给是不是被拒着', then: '顶上先不说补给的事' }); return null; }
}
export function blockers({ alerts = [], sandbox = sandboxed(), onboarding = onboardingState(), free = freeHold() || defaultChainHold(), modelOk = null, modelFault = undefined, phone = phoneLink(), facts = factsHealth() } = {}) {
  const out = [];
  const f = factsBlocker({ health: facts, onboarding });
  if (f) out.push(withWhy({ kind: 'facts', text: f.text }, { what: '你的资料（简历、经历、要求）', step: '判断、写信、填表之前读资料', cause: f.state === 'broken' ? '资料文件读不了' : '还没有你的资料', effect: '判断、写信、填表先停了，别的照常', fix: f.state === 'broken' ? '在「材料」里重新导入简历，或者在「设置 → 资料」里重新填；原来那份会留一份旧版' : '在「材料」里导入简历，或者在「设置 → 资料」里填上', links: [LINK.profile, LINK.materials] }));
  // 没走完引导的新用户：模型那一步还没到，不算挡路。
  if (!sandbox && !onboarding.first_run) {
    let fault = null;
    const model = (text, cause) => withWhy({ kind: 'model', text }, { what: '判断岗位和写信', step: '调用文字模型', cause, effect: text.slice(text.lastIndexOf('，') + 1) || '判断和写信先停了', fix: /钥匙/.test(cause) ? '在「设置 → 模型」里换一把钥匙，或者换一个模型' : /补给/.test(cause) ? '等补给恢复，或者在「设置 → 模型」里换一个模型' : '在「设置 → 模型」里配一个能用的模型', links: [LINK.model, LINK.log] });
    if (free) { const t = BLOCK_TITLE[free.kind] || 'OfferCrew 补给现在用不了'; out.push(model(`${t}，判断和写信先停了`, t)); }
    else if ((fault = modelFault !== undefined ? modelFault : modelFaultBlock())) out.push(fault.why ? fault : model(fault.text, fault.text.slice(0, fault.text.lastIndexOf('，')) || fault.text));
    else if (!(modelOk ?? textModelUsable())) out.push(model('现在没有能用的文字模型，判断和写信先停了', '模型清单里没有一个现在能用的'));
  }
  const errors = alerts.filter(a => a && a.level === 'error' && !a.recovered_at);
  // 严重的只剩真挡路、你能动手的（lib/alert-rules.mjs），一类一条（同一类几个写在那条的 msg 里，比如「图片识别的 2 个模型都用不了」）。
  // 横条写每一类；都是同一个地方修的就直接给那个按钮，不然「看原因」问 System，带上每一条的完整内容（detail），不带横条上截过的字。
  if (errors.length) {
    const fixes = [...new Set(errors.map(a => a.fix?.to || ''))], fix = fixes.length === 1 && fixes[0] ? errors[0].fix : null;
    const text = errors.length > 1 ? cut(`${errors.length} 条严重告警：${errors.map(a => cut(a.msg, 30)).join('；')}`, 80) : cut(errors[0].msg, 60);
    const who = [...new Set(errors.map(a => crewName(a.member || 'patch')))].join('、');
    const why = { what: `${who}的活`, step: [...new Set(errors.map(a => a.step || a.title || '').filter(Boolean))].join('、') || '告警里记下的那几步', cause: errors.map(alertDetail).join('；'), effect: '相关的活先停着，别的照常', fix: fix ? `点「${fix.label}」处理` : '照每一条的原话处理；原始记录在运行日志里', links: [...(fix?.to?.startsWith('#') ? [{ label: fix.label, href: fix.to }] : []), LINK.log] };
    out.push({ ...withWhy({ kind: 'alert', text }, why), ...(fix ? { go: fix.to, label: fix.label } : {}) });
  }
  if (phone?.paired > 0 && phone.link === 'offline') out.push(withWhy({ kind: 'phone', text: '手机连不上中转服务，手机上看不到新消息' }, { what: '手机上的消息', step: '这台电脑连中转服务', cause: `配过的 ${phone.paired} 台手机连不上中转服务`, effect: '手机上看不到新消息，电脑上照常', fix: '看看这台电脑能不能上网；一直连不上，在「设置 → 通知」里重新配一次手机', links: [LINK.phone] }));
  return out;
}
// 证据和能修的地方（页面里的地址）。
const LINK = { profile: { label: '打开资料', href: '#settings/profile' }, materials: { label: '打开材料', href: '#materials' }, model: { label: '设置模型', href: '#settings/model' }, log: { label: '看运行日志', href: '#stream' }, phone: { label: '手机设置', href: '#settings/notify' } };
// 「看原因」的完整内容写成一段话（发给 System 的那一段）：证据和入口只写名字，链接在 why.links 里（System 的回答画成按钮）。
export function whyText(w = {}) {
  return [['哪件事', w.what], ['卡在哪一步', w.step], ['为什么', w.cause], ['影响', w.effect], ['能怎么办', w.fix], ['证据和入口', (w.links || []).map(l => l.label).join('、')]]
    .filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join('\n');
}
const withWhy = (b, why) => ({ ...b, why, detail: whyText(why) });
// 顶上放的那一条（最要紧的），没有就是 null。
export const topBlocker = opts => blockers(opts)[0] || null;
