// 认意图只在一处（线 H，design/architecture-review/04-改造契约与分工.md 2.5；01 根 5）。
//
// 这一轮收的是「对外动作」：你说的一句话、按的一个按钮里，要不要往外动手、动哪一种、对哪几条。
// 以前这件事在 planTalk、doablePart、taskPlan、planFor、writerAsk、computerNeed、resolveCommand 里各认一遍，改一处另几处不跟着
// （「不要投递或发信」走成投递、「只看草稿」走成找内推、手机上一句「确认，开始预填」就开浏览器……）。
// 现在：入口只问 outboundIntent()，认出来的交给 lib/actions.mjs requestAction()，确认和闸门都在那边。
// 规则，不问模型。其余意图（问答、交办、改材料）发版后再收过来。
//
//   outboundIntent(text, { card }) → null 或
//     { act: 'prefill', numbers, all, exclude, url }     投 / 投递 / 网申（编号或链接）
//     { act: 'send', numbers, all, exclude }              发 N / 发 全部 / 卡片下面回「发」
//     { act: 'cancel_send', number }                      不发 N
//     { act: 'contact', number }                          联系 N / 找内推 N（先起草，发还要你批准）
//   computerNeed(text) → 一句原因（要动电脑的那一类）或 null
//   doablePart / readOnlyAsk / isQuestion：去掉「不要……」「投之前……」的那几段、只看不动、是在问
//
// 下面（原来的这一份）：Jev 读一句自由话，认出明确的意图就换成指令原文、偏好直接记进偏好表；发送、提交仍只认你确认过的那一份。

// What a free-form room message asks for, when the regex grammar could not tell.
//
// resolveCommand (below) keeps the exact grammar (`发 32`, `投 全部 去掉 44`). Anything
// it cannot place used to become a host job for the generative executor, sixty
// seconds and one model run later. Now Jev reads the sentence first: a clear
// intent becomes the canonical command the executors already understand, a
// preference ("外企多一点") is written straight into the preference table, and
// only a genuinely open request still goes to the executor.
//
// Two boundaries are kept on purpose. Sending and submitting are never
// executed from a Jev reading: the user gets the canonical sentence back and
// confirms with it, so authorization still comes only from a literal `发 N` or
// `投 N`. And a reading below the confidence floor changes nothing.
import { read, write } from './store.mjs';
import { judgeAvailable, threshold } from './judge.mjs';
import { routeIntent } from './judgements.mjs';
import { PREFERENCES_PATH, loadPreferences, resetPreferencesCache, WEIGHT_CAP } from './preferences.mjs';
import { primaryCity } from './city.mjs';
import { FAMILIES } from './directions.mjs';
import { noteSwallowed } from './swallow.mjs';
import { memberByWord } from './members.mjs';

const numbersIn = (s) => [...new Set((String(s).match(/\d{1,6}/g) || []).map(Number).filter((n) => n > 0))];
const stripNumber = (s, n) => String(s).replace(new RegExp(`\\s*(?:#|编号)?${n}\\s*(?:号|那封|那条|这条|这个)?\\s*`), ' ').replace(/\s{2,}/g, ' ').trim();

// The preference table's own vocabulary (lib/preference-signals.mjs) for the
// values Jev names.
const PREF_KEY = {
  city: (v) => `city:${v}`,
  company_type: (v) => `company_type:${v}`,
  // 通用路径的类别（投行、资管……）记在它的中文名下，和 lib/preference-signals.mjs 学到的方向同名。
  job_family: (v) => `direction:${{ ai_application: 'Agent应用', backend_platform: '后端平台', fullstack: '全栈产品', algorithm_or_training: '算法研究', data: '数据', devops_sre: '工具链', frontend_only: '全栈产品' }[v] || FAMILIES[v]?.zh || v}`,
  seniority: (v) => `seniority:${{ junior: '初级岗', senior_or_above: '资深岗', management: '管理岗', mid: '未标注' }[v] || v}`,
  source_type: (v) => `source_type:${v}`,
  salary: (v) => `salary_band:${v}`,
};
const DIRECTION_WEIGHT = { more: 4, less: -4, only: WEIGHT_CAP, exclude: -WEIGHT_CAP };
const LABEL = { city: '城市', company_type: '公司类型', job_family: '方向', seniority: '职级', source_type: '来源', salary: '薪资' };
const VALUE_LABEL = { foreign_mnc: '外企', chinese_big_tech: '大厂', state_owned: '国企', startup: '创业公司', outsourcing: '外包', ai_application: 'AI 应用', backend_platform: '后端平台', fullstack: '全栈', algorithm_or_training: '算法/训练', data: '数据', devops_sre: '工具链', frontend_only: '纯前端', junior: '初级', mid: '中级', senior_or_above: '资深', management: '管理岗' };

// Write one preference the user stated into `manual`, which every rebuild of
// the table keeps (lib/preferences.mjs). Returns the sentence to answer with.
export function applyPreference({ dimension, direction, value }, { path = PREFERENCES_PATH, now = Date.now() } = {}) {
  if (!dimension || !PREF_KEY[dimension]) return null;
  const prefs = loadPreferences(path);
  const manual = { ...(prefs.manual || {}) };
  const note = (k, w) => `已把 ${k} 的权重设为 ${w > 0 ? '+' : ''}${w}（手动，重算不丢）`;
  let receipt;
  if (direction === 'reset') {
    const keys = Object.keys(manual).filter((k) => k.startsWith(dimension === 'job_family' ? 'direction:' : dimension === 'salary' ? 'salary_band:' : `${dimension}:`));
    for (const k of keys) delete manual[k];
    receipt = keys.length ? `已撤销 ${LABEL[dimension]} 上的 ${keys.length} 条手动偏好。` : `${LABEL[dimension]} 上没有手动偏好可撤销。`;
  } else {
    if (!value) return `听懂了是要调整${LABEL[dimension]}，但没听出具体是哪一个。可以说「外企多一点」「少推创业公司」「不要算法岗」。`;
    const key = PREF_KEY[dimension](value);
    const weight = DIRECTION_WEIGHT[direction] ?? DIRECTION_WEIGHT.more;
    manual[key] = weight;
    receipt = `${note(key, weight)}。下一轮推荐和拟投清单的顺序都会按它排；回「撤销${LABEL[dimension]}偏好」恢复。`;
    if (direction === 'only') receipt = `已把 ${VALUE_LABEL[value] || FAMILIES[value]?.zh || value} 设为最优先（${key} = +${weight}）。其它${LABEL[dimension]}不会被排除，只会排在后面；要排除请说「不要……」。`;
    if (direction === 'exclude') receipt = `已把 ${VALUE_LABEL[value] || FAMILIES[value]?.zh || value} 降到最低（${key} = ${weight}）。它不会再排到前面；彻底预筛掉需要三次带原因的 pass，或直接编辑 state/learned-prefilters.json。`;
  }
  write(path, { ...prefs, manual, manual_updated_at: new Date(now).toISOString() });
  resetPreferencesCache();
  return receipt;
}

// Turn a free-form message into one of: a canonical command sentence, a
// confirmation prompt (send/submit), a receipt (preference applied), or null.
export async function routeFreeform(text, { card = null, now = Date.now() } = {}) {
  // 取消只会撤回发送；明确的取消句不受外发禁令阻挡，也不靠模型猜。
  const local = outboundIntent(text, { card });
  if (local?.act === 'cancel_send') return { verb: 'cancel_send', confidence: 1, canonical: `${local.number} 不发` };
  if (deniesOutbound(text)) return null;
  if (!judgeAvailable()) return null;
  const raw = String(text || '').trim();
  const numbers = numbersIn(raw);
  let intent;
  try { intent = await routeIntent(raw, { card, numbers, request_id: `intent-${now}-${Math.random().toString(36).slice(2, 8)}` }); }
  catch (e) { noteSwallowed('intent.route', e, { doing: '让模型认这句话要做什么', then: '按规则认' }); return null; }
  const n = card?.number ?? (numbers.length === 1 ? numbers[0] : null);
  const rest = n ? stripNumber(raw, n) : raw;
  const out = { intent, verb: intent.verb, confidence: intent.confidence };
  if (!intent.verb || intent.verb === 'other') return { ...out, canonical: null };
  const confirmOnly = threshold('intent_send_verbs_confirm_only') !== false;
  if (['send', 'queue_apply', 'contact'].includes(intent.verb) && !outboundAsk(raw, { card })) return { ...out, canonical: null };
  switch (intent.verb) {
    case 'send':
      return { ...out, confirm: n ? `听起来是要发 ${n} 这封。发送需要你亲口确认：回「发 ${n}」我就发。` : numbers.length > 1 ? `要发 ${numbers.join('、')} 这几封吗？回「发 ${numbers.join('、')}」确认。` : '要发哪一封？回「发 编号」，或「发 全部」发出所有待确认草稿。' };
    case 'queue_apply':
      return { ...out, confirm: numbers.length ? `要投 ${numbers.join('、')} 吗？回「投 ${numbers.join(' ')}」确认后才提交。` : '回「投 全部」或「投 编号」确认拟投清单，我才会提交。', ...(confirmOnly ? {} : { canonical: numbers.length ? `投 ${numbers.join(' ')}` : null }) };
    case 'cancel_send': return { ...out, canonical: n ? `${n} 不发` : null, confirm: n ? null : '要取消哪一封？回「编号 不发」。' };
    case 'revise': return { ...out, canonical: n ? `改 ${n} ${rest}` : null, confirm: n ? null : '要改哪一封？回「改 编号 怎么改」。' };
    case 'pass': return { ...out, canonical: n ? `${n} pass ${intent.states_reason ? rest.replace(/^(pass|不合适|排除|不要)\s*/i, '') : ''}`.trim() : null, confirm: n ? null : '要排除哪一条？回「pass 编号 原因」。' };
    case 'contact': return { ...out, canonical: n ? `${n} 联系` : null, confirm: n ? null : '要联系哪一条？回「编号 联系」。' };
    case 'brief': return { ...out, canonical: n ? `详情 ${n}` : null, confirm: n ? null : '想看哪一条？回「详情 编号」。' };
    case 'progress': return { ...out, canonical: n ? `${n} 进展` : '我的待办' };
    case 'snooze': return { ...out, canonical: n ? (/暂停/.test(raw) ? `${n} 暂停提醒` : /明天/.test(raw) ? `${n} 明天提醒` : `${n} 晚点提醒`) : null };
    case 'schedule_interview': {
      const t = raw.match(/(\d{4}-\d{2}-\d{2})[ T]?(\d{2}:\d{2})/);
      return { ...out, canonical: n && t ? `${n} 面试 ${t[1]} ${t[2]}` : null, confirm: n && t ? null : `记面试时间请用「${n || '编号'} 面试 2026-09-25 14:00」这个格式（北京时间）。` };
    }
    case 'adjust_preference': {
      const receipt = intent.preference ? applyPreference(intent.preference, { now }) : null;
      return { ...out, receipt: receipt || `听懂了是要调整推荐偏好，但没听出维度和方向。可以说${primaryCity() ? `「多推${primaryCity()}的」` : ''}「外企多一点」「不要算法岗」。` };
    }
    default: return { ...out, canonical: null };
  }
}

// ── 对外动作（线 H，10-04）────────────────────────────────────────────────────
export const URL_RE = /https?:\/\/[^\s<>"'，。）)]+/;
const NUM = /\d{1,6}/;

// 说了不要做的、「投之前」的那几段不算要做（第 5 轮开箱 B2：「帮我看看 #1……不要投递或发信」被当成「投 1」）。
const NOT_DO = /(?:先|暂时|暂|还|也)?(?:不要|不用|不必|无需|不需要|不想|没想|别|不|勿)(?:再|先|急着|着急|马上|直接)?(?:帮我|给我|替我|帮忙)?去?(?:投|网申|发(?:信|邮件|消息|私信|出|送)?|私信|联系|找内推)[^，。,.；;！!？?\n]*/g;
const BEFORE_DO = /在?(?:投递?|网申|发信|发出|联系)(?:之前|以前|前|的话)/g;
// 动作字当名词用的不算要做（第 6 轮 C6：「核对……联系状态」被排成了「联系」）。前面有「找」的还是要做的事。
const NOUN_USE = /(?<!找[^，。,.；;！!？?]{0,12})(?:(?:联系|投递|内推)(?:状态|情况|记录|历史|方式|入口|过没有|过吗|过的|了没有|进度)|投递(?=的|用|材料)|联系人|内推人)/g;
export const doablePart = text => String(text || '').replace(NOT_DO, ' ').replace(BEFORE_DO, ' ').replace(NOUN_USE, ' ');
// 限制作用于整句话，不能删掉否定半句再从其余文字猜出投递。草稿仍可写，外发和预填须另获批准。
export const deniesOutbound = text => /(?:不要|不用|不必|无需|别|勿|禁止|不允许|不)(?:[^。；;，,!！?？\n]{0,10})?(?:外发|对外|发(?:送|出|信|邮件|私信|给|到|出去|过去)?|投递?|网申|预填|提交|联系)/.test(String(text || ''));
// 只看、只核对：不排要动手的活，在对话里直接答。
const READ_ONLY = /(?:只|仅|就)(?:是)?(?:想)?(?:看|查看|看看|核对|检查|确认|展示|列)|只读|别动|不要(?:动|改|执行|跑)|^(?:@\S+\s*)?(?:请|帮我|麻烦)?(?:展示|列出|显示|查看|看看|看一下|核对)[^。！!]{0,12}(?:已有|现有|已经有)/;
export const readOnlyAsk = text => READ_ONLY.test(String(text || '').trim());
// 问一句不是交办（负责人 09-30「问不等于委派」）；客气的请求照样是交办。
const ASK_WORTH = /值得|值不值|要不要|该不该|能不能投|投不投|适合(?:我)?吗|合适吗|靠谱|怎么样|如何|好不好|是什么|哪个|哪些|什么(?:团队|级别|职级|部门|业务)|为什么|多少|几个|谁/;
const POLITE = /^(?:请|麻烦|劳驾)|(?:帮我|帮忙|替我|给我)(?!看看.{0,6}(?:值|要不要|适合|靠谱|怎么样))/;
export function isQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (ASK_WORTH.test(t) && !/^(?:请|麻烦)/.test(t)) return true;
  return /[吗？?]/.test(t) && !POLITE.test(t);
}

// 编号后面括号里的注（「投 29（VanArsdel · 全栈工程师）」）、飞书的 @ 占位去掉。
const clean = s => String(s || '').replace(/(\d{1,6})\s*[（(][^（）()\n]{1,80}[）)]/g, '$1').replace(/ /g, ' ').replace(/@_user_\d+/g, ' ').replace(/^@[^\s]+\s*/g, '').replace(/\s{2,}/g, ' ').trim();
const numbers = s => [...new Set(String(s).split(/[\s,，、;；#]+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n > 0))];
const ALL = /^(全部|所有|都投|都发|all)$/i;
const SPLIT_EXCLUDE = /\s*(?:去掉|除了|排除|不投|不发|除去)\s*/;

// 跟进只起草；有编号或正在看的岗位才能确定对象。否定发送不否定起草。
export function followupAsk(text, { number = null } = {}) {
  const raw = clean(text);
  if (!/跟进/.test(raw) || /(?:不要|不用|别|不再|不)跟进/.test(raw) || isQuestion(raw)) return null;
  if (!/^(?:#?\d+\s*跟进|跟进\s*(?:#?\d+|一次)?\s*$)|(?:帮我|请|麻烦)?(?:起草|写|准备)[^。；;]*跟进|(?:帮我|请|麻烦)跟进/.test(raw)) return null;
  const m = /#\s*(\d{1,6})(?!\d)|(\d{1,6})\s*号|^(?:跟进\s*)?#?(\d{1,6})(?!\d)/.exec(raw);
  return m ? Number(m[1] || m[2] || m[3]) : Number(number) || null;
}

export function outboundIntent(text, { card = null } = {}) {
  const raw = clean(text);
  if (!raw) return null;
  const naturalStop = /^(?:#?(\d{1,6})\s*(?:那封|这封)\s*(?:别发|不要发|不发)(?:了)?)[。！!.]?$/.exec(raw);
  if (naturalStop) return { act: 'cancel_send', number: Number(naturalStop[1]) };
  const stopping = /^(?:不发\s*#?\d+|#?\d+\s*不发|不发|别发|先不发|取消|算了|不要发)[。！!.]?$/.test(raw);
  const exclusion = /^(?:投|投递|发|发送)\s*(?:全部|所有|all)\s*(?:去掉|除了|排除|不投|不发|除去)\s*[\d\s,，、#]+$/i.test(raw);
  if (deniesOutbound(raw) && !stopping && !exclusion) return null;
  // 指令的写法（指挥台、手机、卡片）：投 118 121 / 投 全部 去掉 44 / 发 32、46 / 发 全部 / 不发 32。
  const apply = raw.match(/^(?:投|投递)\s*([\s\S]*)$/);
  if (apply) {
    const body = apply[1].replace(/[。！!.]$/, '').trim();
    const [inc, exc = ''] = body.split(SPLIT_EXCLUDE);
    // 指令只认「投」后面只有编号、「全部」或一个链接；别的（「投之前帮我看看 #1」）是一句话，下面按说话认。
    const url = /^\S+$/.test(inc.trim()) ? inc.match(URL_RE)?.[0] || null : null;
    const all = !url && (!inc || ALL.test(inc.trim()));
    const nums = all || url || !/^[\s\d,，、#]+$/.test(inc) ? [] : numbers(inc);
    if (all || nums.length || url) return { act: 'prefill', numbers: all && card?.kind === 'apply_proposal' ? card.numbers || [] : nums, all: all && card?.kind !== 'apply_proposal', exclude: numbers(exc), url };
  }
  // 客气的投递请求仍须明确列出编号；不从 v1、薪资或材料名称里捞数字。
  const politeApply = /^(?:请|麻烦|帮我|替我|给我)\s*(?:投递?|网申|预填)\s*(#?\d{1,6}(?:\s*(?:和|、|,|，|\s)\s*#?\d{1,6})*)\s*[吧。！!]?$/.exec(raw);
  if (politeApply) return { act: 'prefill', numbers: numbersIn(politeApply[1]), all: false, exclude: [], url: null };
  const sendAll = raw.match(/^(?:发|发送)\s*(?:全部|所有|都发|all)\s*([\s\S]*)$/i);
  if (sendAll) return { act: 'send', numbers: [], all: true, exclude: numbers(sendAll[1].replace(/^(?:去掉|除了|排除|不发|除去)\s*/, '')) };
  const send = raw.match(/^(?:发|发送)\s*#?(\d{1,6}(?:\s*[,，、]\s*#?\d{1,6})*)\s*[。！!.]?$/);
  if (send) return { act: 'send', numbers: numbers(send[1]), all: false, exclude: [] };
  const stop = raw.match(new RegExp(`^(?:不发\\s*#?(${NUM.source})|#?(${NUM.source})\\s*不发)\\s*[。！!.]?$`));
  if (stop) return { act: 'cancel_send', number: Number(stop[1] || stop[2]) };
  // 卡片下面的一句回话：卡片上的那一条。
  const n = card?.number ?? null;
  if (n != null) {
    if (/^(?:OK\s*)?(发|发送|确认发送|可以发|发吧|同意|同意发送)[。！!.]?$/i.test(raw)) return { act: 'send', numbers: [n], all: false, exclude: [] };
    if (/^(不发|别发|先不发|取消|算了|不要发)[。！!.]?$/.test(raw)) return { act: 'cancel_send', number: n };
    if (/^(联系|要|想要|争取)[。！!.]?$/.test(raw)) return { act: 'contact', number: n };
  }
  const numbered = raw.match(new RegExp(`^#?(${NUM.source})\\s*(联系|跟进)(?=\\s|$|[，,;；])`));
  if (numbered) return { act: 'contact', number: Number(numbered[1]) };
  // 「跟进 18」「联系 #18」：和「18 跟进」一样（对话里 crewCommand 也是这么换的）。
  const verbFirst = raw.match(new RegExp(`^(?:联系|跟进)\\s*#?(${NUM.source})\\s*[。！!.]?$`));
  if (verbFirst) return { act: 'contact', number: Number(verbFirst[1]) };
  // 说话的写法（对话、交办）：问的不算；说了不要做、只看的那几段去掉以后再认。
  const url = raw.match(URL_RE)?.[0] || null;
  if (isQuestion(raw.replace(URL_RE, ''))) return null;
  const act = readOnlyAsk(raw) ? '' : doablePart(raw.replace(URL_RE, ' '));
  const num = Number(raw.replace(URL_RE, '').match(/#\s*(\d{1,6})(?!\d)|(?:编号\s*|第\s*)(\d{1,6})(?!\d)|(\d{1,6})\s*号/)?.slice(1).find(Boolean)) || null;
  const applyVerb = /(?:^先判断(?:一下)?再|^|[，。；\s]|帮我|替我|给我|请|麻烦)(?:投递?|网申|预填)(?:一下|这条|这个岗位|简历|申请表)?\s*(?:#|编号|第|https?:|给|到|吧|$)/;
  if (applyVerb.test(act) && (url || num)) return { act: 'prefill', numbers: num ? [num] : [], all: false, exclude: [], url: num ? null : url };
  // 客气前缀可叠加；全句否定已在上面拦住，不从禁止句里剥出动作。
  const contactRequest = /^(?:(?:请|麻烦|帮我|替我|给我)\s*)*(?:用浏览器\s*)?(?:找(?:一下)?\s*(?:(?:#|编号|第)\s*\d{1,6}\s*(?:号|条)?\s*的?\s*)?(?:内推人?|联系人)(?:\s*(?:#|编号|第)\s*\d{1,6}\s*(?:号|条)?)?|联系(?:一下)?\s*(?:#|编号|第)\s*\d{1,6}\s*(?:号|条)?(?:\s*的\s*(?:HR|hr|招聘方|联系人))?)\s*(?=[，,。；;！!]|$)/;
  if (contactRequest.test(act) && num) return { act: 'contact', number: num };
  return null;
}

// 要不要动电脑（往外发、开浏览器填表、登录）。「写一封私信」是写东西；「发给 HR」「帮我投」才是往外动手。
const SEND = /发出去|发送|发过去|发(?:到|给)|发(?:一?(?:封|条))?(?:私信|邮件|消息|微信)|私信(?:给|一下|他|她|对方|HR|hr)|打(?:个)?招呼|加(?:他|她|对方)?(?:微信|好友)/;
const DRAFT = /写|起草|草拟|拟一|润色|改一下|草稿/;
const SEND_NOW = /发出去|发送|发过去|(?:帮我|替我|直接|然后|再|并)发/;
const SEND_REQUEST = /^(?:(?:请|麻烦|劳驾|帮我|替我|给我|我要|我想)\s*)?(?:现在|直接|立即|继续|再)?(?:发送|发出去|发过去|发给|发到|发私信|发邮件|私信|打招呼|加.*好友)|^(?:(?:请|麻烦|帮我|替我|给我)\s*)?把[^。；;]{0,120}(?:发送|发出去|发给|发到|私信给)|(?:然后|并|再)(?:发送|发出去|发给)/;
const NEEDS = [
  [t => outboundIntent(t)?.act === 'prefill' || /^(?:请|帮我|替我)?(?:预填|填表|提交申请)/.test(t), '用浏览器打开申请页预填'],
  [t => SEND.test(t) && SEND_REQUEST.test(t) && !readOnlyAsk(t) && !isQuestion(t) && (!DRAFT.test(t) || SEND_NOW.test(t)), '往外发消息'],
  [/登录|登陆|扫码/, '登录网站'],
  [t => /打开浏览器|用浏览器|浏览器里|打开[^。；;]{0,30}(?:网页|页面|链接|原帖)|截(?:个)?图|下载|上传/.test(t) || (/打开|看看|浏览|读取/.test(t) && /https?:\/\//.test(t)), '开浏览器'],
];
export function computerNeed(text) {
  if (deniesOutbound(text)) return null;
  const t = doablePart(text);
  for (const [re, why] of NEEDS) if (typeof re === 'function' ? re(t) : re.test(t)) return why;
  return null;
}
// 这句话要往外动手吗（发、投、联系，或者要动电脑往外发、去预填）：是的话从不交给本机 AI（契约 2.4），开卡停下等你批准那一份。
export const OUTBOUND_NEEDS = new Set(['用浏览器打开申请页预填', '往外发消息']);
export const outboundAsk = (text, options = {}) => !!outboundIntent(text, options) || OUTBOUND_NEEDS.has(computerNeed(text));

// ── 一句话要做什么（第 4 步 4a，05 第一节第 7 项）────────────────────────────────────────
// 对话、任务新建、收件箱里打字的回复、手机：「这句话要做什么」都只在这里认。调用方只拿结果，再调现有的执行函数：
//   recognize(text, { card, focus, member }) → { intent, numbers, number, url, cmd?, task?, ... }
//     intent：apply 投 / send 发 / cancel_send 不发 / contact 联系 / pass / revise 改稿 / schedule 面试时间 / snooze 提醒 /
//             progress 进展 / brief 详情 / note 备注 / archive 归档 / reopen 重新打开 / ignore 先放着 / query 待办 /
//             list 清单（apply_list、send_list、top_picks）/ agent 暂停·恢复成员 / op 跑一个脚本 / status 现在怎么样 /
//             why 为什么 / capture 贴来的链接 / research 调研 / prep 怎么准备 / resume 改简历 / letters 求职信·自我介绍 /
//             intake 收录 / chat 认不出要做什么（照实交给对话，不猜）/ empty 空的
//     cmd：指令的写法（resolveCommand，dispatchCommand 拿它执行）；task：任务新建要开的那类活（taskIntent，planTalk 拿它排路线）。
//   下面这些也只在这里：resolveCommand / threadCommand（指令和卡片下的回话）、focusCommand（正看着一条时的短指令）、
//   crewCommand（成员的几句）、isStatusQuestion / isWhyQuestion / whyTarget / captureUrl、taskIntent、
//   Writer 的 wantsWriter / writerIntent / writerAsk / letterAsk、startsWork / splitWork（这句开不开活、拆不拆）。
// 交给谁（成员、口吻）不在这里：lib/talk-route.mjs。认出来以后怎么做：lib/command-center.mjs dispatchCommand、lib/tasks.mjs、lib/actions.mjs。
// 对外的（投、发）认出来也只是「要做」：批准和确认在 lib/actions.mjs requestAction，这里从不放行。

// ── 指令（原 lib/commands.mjs）──
// 三种写法：常用指令（`投 118 121`、`发 32`、`pass 44 原因`、`27 面试 2026-09-16 14:00`、`我的待办`）、
// 卡片下面的回话（`发`、`不发`、`改成……`，沿用卡片那一条）、别的话（交给对话 / 执行器）。
export const QUERY = /^(我的待办|待办|进展|目前进展|今日进展|招聘进展|状态|有什么要做|帮助)$/;
// 背后已经有执行器、自己不往外动的几种动词；别的要等即时执行器。
export const IMMEDIATE = new Set(['query', 'feedback', 'schedule', 'snooze', 'cancel', 'progress', 'archive', 'reopen']);
// 「N 联系」「N 跟进」也是 feedback（先记下你的决定），但要马上排给即时执行器起草。词后面的界限同 lib/feedback.mjs parseFeedback。
const DRAFT_NOW = /^\d{1,6}\s*(?:联系|跟进)(?=\s|$|[，,;；])/;
const runNow = (verb, input) => !IMMEDIATE.has(verb) || (verb === 'feedback' && DRAFT_NOW.test(String(input || '')));
export const RUN = /^(?:运行|跑|run)\s+([a-z][a-z0-9-]*)$/i;

// 结束当前岗位必须是完整的决定句；暂时不投、讨论或引用都不算。
const endCurrentLead = t => /^(?:这一?条|这个岗位|这个)?(?:不投了|不推进了?|不要了|收掉|结束这条)(?:[，,、\s]*(?:收掉|不投了|不要了|结束这条))*[。.!！]?$/.test(t);

// 卡片下面的一句回话：沿用卡片上那一条。
export function threadCommand(text, card) {
  const t = clean(text);
  if (!card || !t) return null;
  const n = card.number ?? null;
  if (!n) return null;
  if (endCurrentLead(t)) return { verb: 'feedback', input: `${n} pass` };
  const oi = outboundIntent(t, { card });
  if (oi?.act === 'send') return { verb: 'send', input: `发 ${n}`, numbers: [n] };
  if (oi?.act === 'cancel_send') return { verb: 'cancel', input: `${n} 不发` };
  const revise = t.match(/^(?:改成|改为|修改成|改|修改)[：:，,]?\s*([\s\S]+)$/);
  if (revise) return { verb: 'revise', input: `${n} 改 ${revise[1].trim()}` };
  if (/^(pass|不合适|排除)([\s\S]*)$/i.test(t)) return { verb: 'feedback', input: `${n} pass ${t.replace(/^(pass|不合适|排除)\s*/i, '').trim()}`.trim() };
  if (oi?.act === 'contact') return { verb: 'feedback', input: `${n} 联系` };
  if (/^(忽略|不用管|已读)[。！!.]?$/.test(t)) return { verb: 'ignore', input: null };
  if (/^(这个?是(啥|什么)|详情|简报|什么岗位|啥岗位|招聘贴|原帖)[？?。!！]?$/.test(t)) return { verb: 'brief', number: n, input: null };
  const interview = t.match(/^面试\s+([\s\S]+)$/);
  if (interview) return { verb: 'schedule', input: `${n} 面试 ${interview[1].trim()}` };
  // 别的话还是说这一条的：记成备注。
  return { verb: 'freeform', input: `${n} 备注 ${t}`, note: t };
}

export function resolveCommand(text, { card = null } = {}) {
  const raw = clean(text);
  if (!raw) return { kind: 'ignore', verb: 'ignore', input: null, ack: null, needs_run_now: false };
  const ack = (verb, extra = '') => `收到${extra ? '，' + extra : '，正在处理'}。`;
  // 「运行 <脚本>」：对话里的角色把脚本当工具用（dispatchCommand 走 runOrQueue）。
  const run = RUN.exec(raw);
  if (run) return { kind: 'op', verb: 'op', op: run[1].toLowerCase(), input: raw, needs_run_now: false, card: null, ack: null };
  if (/^(拟投清单|待投清单|拟投列表|待审清单)\s*[。！!.]?$/.test(raw)) return { kind: 'apply_list', verb: 'apply_list', input: null, needs_run_now: false, card: null, ack: null };
  if (/^(重点|重点岗位|最重要的岗位|最值得投的|重点清单)\s*[。！!.？?]?$/.test(raw)) return { kind: 'top_picks', verb: 'top_picks', input: null, needs_run_now: false, card: null, ack: null };
  if (/^(拟发清单|待发清单|待发草稿|草稿清单)\s*[。！!.]?$/.test(raw)) return { kind: 'send_list', verb: 'send_list', input: null, needs_run_now: false, card: null, ack: null };
  // 投 / 发 / 不发：和对外动作同一套认法（outboundIntent）。投 = 批准拟投清单里这几条（全部 = Reacher 上次给的清单，去掉 / 除了 / 排除后面的拿掉）；
  // 只认编号和「全部」，链接走任务（taskIntent）。发 N = 发这封的授权，执行在 lib/action-entry.mjs。
  const oi = /^(?:投|投递|发|发送|不发|\d{1,6}\s*不发)/.test(raw) ? outboundIntent(raw, { card }) : null;
  if (oi?.act === 'prefill' && !oi.url && (oi.all || oi.numbers.length)) {
    const all = oi.all || (card?.kind === 'apply_proposal' && !/\d/.test(raw.split(SPLIT_EXCLUDE)[0]));
    return {
      kind: 'queue_apply', verb: 'queue_apply', numbers: oi.numbers, exclude: oi.exclude, all: oi.all, input: null, needs_run_now: true, card: null,
      ack: `收到，${all ? '按拟投清单全部排队' : '已排队：' + oi.numbers.join('、')}${oi.exclude.length ? `，去掉 ${oi.exclude.join('、')}` : ''}。`,
    };
  }
  if (oi?.act === 'send' && oi.all) return { kind: 'send_all', verb: 'send', exclude: oi.exclude, input: null, needs_run_now: true, card: null, ack: `收到，按拟发清单全部发送${oi.exclude.length ? `，去掉 ${oi.exclude.join('、')}` : ''}。` };
  if (oi?.act === 'send' && oi.numbers.length) return { kind: 'action', verb: 'send', numbers: oi.numbers, input: `发 ${oi.numbers.join('、')}`, needs_run_now: true, card: null, ack: ack('send', '正在核对这封草稿后发送') };
  if (oi?.act === 'cancel_send') return { kind: 'action', verb: 'cancel', input: `${oi.number} 不发`, needs_run_now: false, card: null, ack: ack('cancel', '这封不发了') };
  if (deniesOutbound(raw)) return { kind: 'freeform', verb: 'freeform', input: raw, card: null, needs_run_now: false, ack: null };
  // 改 32 把第二段删掉
  const revise = raw.match(new RegExp(`^(?:改|修改)\\s*(${NUM.source})\\s+([\\s\\S]+)$`));
  if (revise) return { kind: 'action', verb: 'revise', input: `${revise[1]} 改 ${revise[2].trim()}`, needs_run_now: true, card: null, ack: ack('revise', '已作废旧的发送授权，改好后重新发给你确认') };
  // pass 44 原因
  const pass = raw.match(new RegExp(`^pass\\s*(${NUM.source})\\s*([\\s\\S]*)$`, 'i'));
  if (pass) return { kind: 'action', verb: 'feedback', input: `${pass[1]} pass ${pass[2].trim()}`.trim(), needs_run_now: false, card: null, ack: ack('feedback', '已排除') };
  if (QUERY.test(raw)) return { kind: 'query', verb: 'query', input: raw, needs_run_now: false, card: null, ack: null };
  // 详情 32 / 32 详情 / 32 是啥 / 32 招聘贴
  const brief = raw.match(new RegExp(`^(?:(?:详情|简报|招聘贴|原帖|看看)\\s*(${NUM.source})|(${NUM.source})\\s*(?:是啥|是什么|详情|简报|招聘贴|原帖|什么岗位|啥岗位|讲讲|说说))\\s*[？?。!！]?$`));
  if (brief) return { kind: 'brief', verb: 'brief', number: Number(brief[1] || brief[2]), input: null, needs_run_now: false, card: null, ack: null };
  // 27 面试 …、27 进展、27 联系、27 pass 原因、27 复盘 …
  const numbered = raw.match(NUMBERED);
  if (numbered) {
    const w = numbered[2];
    const verb = /面试$/.test(w) ? 'schedule' : ['进展', '查看准备'].includes(w) ? 'progress' : ['改', '修改'].includes(w) ? 'revise' : w === '不发' ? 'cancel' : ['联系', '跟进', '备注', 'pass'].includes(w.toLowerCase()) ? 'feedback' : /提醒$/.test(w) ? 'snooze' : ['归档', '结束'].includes(w) ? 'archive' : w === '重新打开' ? 'reopen' : 'action';
    return { kind: w === '进展' ? 'query' : 'action', verb, input: raw, needs_run_now: runNow(verb, raw), card: null, ack: verb === 'progress' ? null : ack(verb) };
  }
  // 卡片下面的回话沿用卡片那一条。
  const threaded = threadCommand(raw, card);
  if (threaded) {
    if (threaded.verb === 'brief') return { kind: 'brief', verb: 'brief', number: threaded.number, input: null, card, needs_run_now: false, ack: null };
    if (threaded.verb === 'ignore') return { kind: 'ignore', verb: 'ignore', input: null, card, needs_run_now: false, ack: '收到，这条先放着。' };
    return { kind: threaded.verb === 'freeform' ? 'freeform' : 'action', verb: threaded.verb, input: threaded.input, ...(threaded.numbers ? { numbers: threaded.numbers } : {}), card, needs_run_now: runNow(threaded.verb, threaded.input), ack: ack(threaded.verb) };
  }
  // 别的都是一句话：交给处理队列（不猜它是哪条指令）。
  return { kind: 'freeform', verb: 'freeform', input: raw, card: null, needs_run_now: true, ack: '收到，已记到处理队列，处理完在这条消息下回复你。' };
}
// 编号在前的指令里的动作词（lib/talk-route.mjs 的回执、谁管，也用同一张表）。
export const NUMBERED = /^(\d{1,6})\s*(进展|查看准备|准备好了|这步好了|卡住了|面试完成|复盘|offer|面试|联系|跟进|备注|pass|不发|改|修改|明天提醒|后天提醒|晚点提醒|暂停提醒|恢复提醒|归档|结束|重新打开)\s*([\s\S]*)$/i;

// ── 成员的几句（原 lib/talk.mjs crewCommand）：「跟进 18」→「18 跟进」；「暂停 Radar」「恢复 Judge」；「Radar 跑一轮」→ round-scout。
// 成员按名册认：显示名、id、老名字（Scout、Lens……）都行。
export function crewCommand(text) {
  const t = String(text ?? '').trim().replace(/[。！!.]+$/, '');
  let m;
  if ((m = /^(跟进|联系)\s*#?(\d{1,6})$/.exec(t))) return { canonical: `${m[2]} ${m[1]}` };
  if ((m = /^(暂停|恢复)\s*@?([A-Za-z]+)$/.exec(t)) && memberByWord(m[2])) return { agent: m[1] === '暂停' ? 'pause' : 'resume', member: memberByWord(m[2]) };
  if ((m = /^@?([A-Za-z]+)\s*(?:立即|马上|现在)?(?:跑|运行)一(?:轮|次|下)$/.exec(t)) && memberByWord(m[1])) return { canonical: `运行 round-${memberByWord(m[1])}` };
  return null;
}

// ── 你正看着一条（「正在看 #12」）时说的短指令：补上编号再按指令走（「投」→「投 12」）。只认这几种明确的动作。
export function focusCommand(text, n) {
  const t = String(text || '').trim().replace(/[。！!.]+$/, '');
  if (!Number.isInteger(n) || n <= 0 || !t || /\d/.test(t.replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/, ''))) return null;
  let m;
  if (endCurrentLead(t)) return `${n} pass`;
  if (/^(投|投递)(这个|这条|它)?$/.test(t)) return `投 ${n}`;
  if (/^(发|发送)(这封|它)?$/.test(t)) return `发 ${n}`;
  if ((m = /^(?:pass|不合适|排除)(?:\s+([\s\S]*))?$/i.exec(t))) return `pass ${n}${m[1] ? ' ' + m[1].trim() : ''}`;
  if (/^(联系|跟进|不跟|归档|重新打开|不发|面试完成|这步好了|晚点提醒|明天提醒|后天提醒|暂停提醒|恢复提醒)$/.test(t)) return `${n} ${t}`;
  if (/^(详情|这个是啥|这是什么岗位)$/.test(t)) return `详情 ${n}`;
  if ((m = /^(?:备注)\s+([\s\S]+)$/.exec(t))) return `${n} 备注 ${m[1].trim()}`;
  if ((m = /^(?:改|改成)\s*([\s\S]+)$/.exec(t))) return `改 ${n} ${m[1].trim()}`;
  if ((m = /^面试\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/.exec(t))) return `${n} 面试 ${m[1]}`;
  return null;
}

// ── 「现在怎么样了、我该做什么」：问的是全局，不点某一条（带编号的归对话）。
const STATUS = [
  /(现在|目前|今天|最近|整体|总体|大家|团队|我的|这边|求职|申请|投递).{0,8}(进展|进度|怎么样|咋样|情况|状态)/,
  /(我|先|接下来|下一步|今天|现在).{0,4}(该|要|需要)?(做|干|处理|定)(什么|啥|哪)/,
  /有什么(要|需要|得)我/, /(汇总|总结|盘点?)一下/, /等我(做|处理|定|回)/,
  /what should i do|how('s| is| are) (it|everything|things)|status (update|report)/i,
];
export const isStatusQuestion = text => { const t = String(text || '').trim(); return !!t && t.length <= 60 && !/\d/.test(t) && STATUS.some(re => re.test(t)); };

// 明确询问本机 AI 的状态先走只读事实；不能被“现在…状态”的团队进展规则抢走。
export const isLocalAiQuestion = text => {
  const t = String(text || '').trim();
  return t.length <= 500 && /本机\s*AI|执行器|\bcodex\b|claude\s*code/i.test(t)
    && /状态|用的|在用|用谁|是谁|哪[个种]|开着|关着|打开了吗|允许|就绪|登录|运行[吗没了]?|能用|可用|为什么|为何|为啥|怎么|查询|检查一下/i.test(t)
    && !/帮我(?:写|改|运行|执行)|让.{0,15}(?:运行|执行|写|改)|切换|换成|打开本机|关闭本机|启用本机|停用本机/i.test(t);
};

// ── 「为什么」（原 lib/talk-route.mjs）
// 「为什么」这一类（L 线 2c，方案-System监工-第2批.md 第五节）：问的是系统、流程、结果为什么这样，System 照事实讲原因、影响、能怎么办
// （lib/system/explain.mjs）。要同时有一个问法（为什么、怎么没、报错了……）和一个说的是我们这边的词（推荐、待核、没跑、模型、登录、
// 成员名……）；问求职本身的（「面试官问我为什么离职」「帮我写为什么想加入」）照旧是对话。
const WHY = /为什么|为啥|为何|怎么(?:没|不|还|又|是|回事|了|会)|是什么意思|啥意思|什么情况|报错|出错了|失败了|卡住了|不动了|没反应|\bwhy\b/i;
const WHY_ABOUT = /推荐|待核|排除|判断|判成|判了|没判|匹配|首轮|第一轮|这一?轮|岗位|线索|结果|是\s*0|为\s*0|跑|没动|不动|定时|周期|模型|额度|补给|登录|本机\s*AI|执行器|Chrome|浏览器|邮箱|收件箱|日志|任务|这件|这一步|系统|团队|报错|出错|失败|卡住|没反应|System|Radar|Judge|Writer|Reacher|Watcher|Scout|Lens|Tailor|Quill|Owl|Patch|#\d/i;
const WHY_NOT_OURS = /帮我写|写一?[段封篇句份]|怎么(?:回答|答|说|讲)|面试官|面试(?:时|里|中)被?问|离职|跳槽|想加入|为什么(?:选择|想|要来|离开|转行)|自我介绍|求职信/;
// 指挥台顶上挡路横条的「看原因」（web/hq.js askSystem）带来的那一句「这是怎么回事：<横条上那句话>」：一律是 why，System 答，
// 按现在顶上是哪一条分类（lib/system/explain.mjs 读 lib/blockers.mjs），不看横条里写了什么词。
export const BANNER_WHY = /^这是怎么回事[：:]\s*(\S[\s\S]*)$/;
// 横条带来的是完整的告警内容（lib/blockers.mjs detail），可能有几百字：上限和对话框一样 2000。
export const isWhyQuestion = text => { const t = String(text || '').trim(); if (BANNER_WHY.test(t)) return t.length <= 2000; return !!t && t.length <= 80 && !CAPTURE_URL.test(t) && WHY.test(t) && WHY_ABOUT.test(t) && !WHY_NOT_OURS.test(t); };
// 问的是某一条（「#12 为什么是待核」「第 3 条怎么是排除」，或者正看着一条时问「这条为什么待核」）：Judge 说；别的 System 说。
// → { persona, number }（number 是那一条的编号，没有就是 null）。
export function whyTarget(text, { focus = null } = {}) {
  const t = String(text || '');
  if (BANNER_WHY.test(t.trim())) return { persona: 'patch', number: null };
  const m = /#\s*(\d{1,6})|第\s*(\d{1,6})\s*[条个]|^(\d{1,6})(?:\s+|号)|(\d{1,6})\s*号/.exec(t);
  const n = m ? Number(m[1] || m[2] || m[3] || m[4]) : focus?.number != null && /这(?:一)?[条个]|这个岗位|它/.test(t) ? Number(focus.number) : null;
  return n ? { persona: 'lens', number: n } : { persona: 'patch', number: null };
}


// 贴来的岗位链接（可以带一两句话，比如「收一下」）：交给 Scout 收录。话多的归对话（「这个值得投吗 https://…」）。
const CAPTURE_URL = /https?:\/\/[^\s<>"'）)]+/i;
export function captureUrl(text) {
  const t = String(text || '').trim(), m = CAPTURE_URL.exec(t);
  if (!m) return null;
  const rest = t.replace(m[0], '').replace(/[\s，。,.!！?？:：]+/g, '');
  return rest.length <= 12 ? m[0].replace(/[。，,.]+$/, '') : null;
}


// ── Writer 的活（原 lib/resume-talk.mjs）
// 否定材料对象/改版不是肯定请求；只用于识别，给 Writer 的原话保留全部限制。
export const materialRequestText = text => String(text || '')
  .replace(/(?:不要|不用|不想|别|不)(?:再|继续)?定制(?:岗位|简历)?/g, ' ')
  .replace(/(?:不要|不用|不想|别|不)(?:再|继续)?(?:新建|创建|保存|生成)(?:新的?)?(?:简历|履历|求职信|自我介绍)(?:[或和、](?:简历|履历|求职信|自我介绍))*(?:新?(?:版|版本))?/g, ' ')
  .replace(/(?:不是|并非|而非|不要|不用|不想|别|不)(?:再|继续)?(?:生成|写|改(?:一版)?|修改|起草|换)?(?:新的?|一(?:版|份|封))?(?:求职信|自我介绍|简历|履历|新版|新版本)/g, ' ')
  .replace(/(?:不要|不用|不想|别|不)(?:外发|投递|发送|上传|下载|导出|打印)(?:[和、](?:外发|投递|发送|上传|下载|导出|打印))*/g, ' ')
  .replace(/(?:正在)?默认投递(?:使用)?的?/g, '默认');
export const rejectsMaterial = text => /(?:不是|并非|而非|不要|不用|不想|别|不)(?:再|继续)?(?:生成|写|改|修改)?(?:求职信|自我介绍|简历|履历)/.test(String(text || ''));
const wclean = (s, max = 400) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// ── 交给 Writer 的话分三类 ─────────────────────────────────────────────────────
// 带着「正在看」、没写 @ 的话，这几种也交给 Writer（设计说明 3.5）：说到「这几行」「体检」「改一版」、润色措辞，或者选中了几行又说要怎么改。
const CHECK = /体检|诊断|检查|挑挑毛病|哪里(?:该|要|还能|可以)改/;
const REWRITE = /改一版|再改一版|重写|重新写|整份|全文|改一份|出一版|做一版|定制|改简历|通用版|精简版/;
const EDIT_VERB = /改|写|换|突出|精简|简洁|删|加上|加粗|润色|调整|缩短|简短|强调|措辞|具体|量化|动词|通顺|翻译|去掉/;
const THESE = /这(?:几|一|两|三)?(?:行|句|段|条)/;
const RESUME_TALK = new RegExp(`${THESE.source}|${CHECK.source}|${REWRITE.source}|润色|措辞`);
const ASKING_POLITELY = /^(?:能|可以|能不能|可不可以|麻烦|请|帮我)/;
export function wantsWriter(text, { thread = null, persona = null, rf = null } = {}) {
  if (thread === 'tailor') return true;
  if (!rf) return false;
  const t = String(text || '');
  return persona === 'tailor' || RESUME_TALK.test(t) || (rf.selection?.length > 0 && EDIT_VERB.test(t));
}
// → { kind:'check' } | { kind:'rewrite', number } | { kind:'edit', line_ids } | { kind:'need_selection' } | { kind:'chat' }
export function writerIntent(text, { selection = [], named = () => [] } = {}) {
  const t = wclean(materialRequestText(text), 600), asked = isQuestion(t) && !ASKING_POLITELY.test(t);
  if (!t) return { kind: 'chat' };
  if (REWRITE.test(t) && !asked) { const n = /定制/.test(t) ? Number(/#(\d{1,6})(?!\d)/.exec(t)?.[1]) || null : null; return { kind: 'rewrite', number: n }; }
  if (CHECK.test(t) && !asked) return { kind: 'check' };
  if (isQuestion(t)) return { kind: 'chat' };
  if (selection.length && (EDIT_VERB.test(t) || THESE.test(t))) return { kind: 'edit', line_ids: selection.slice(0, 40) };
  if (THESE.test(t) && EDIT_VERB.test(t)) return { kind: 'need_selection' };
  const lines = EDIT_VERB.test(t) ? named(t) : [];
  if (lines.length) return { kind: 'edit', line_ids: lines };
  return { kind: 'chat' };
}
// 「@Writer 改一版，更精简」→ 要求是「更精简」；只说了「改一版」就没有附加要求。
export function rewriteWish(text) {
  return wclean(String(text || '').replace(/^(?:请|麻烦)?(?:帮我)?(?:再)?(?:改一版|重写一版|重写|改简历|改一份|出一版|做一版)[，,。.:：\s]*/, ''), 480);
}

// ── 没开着材料页也认得的 Writer 的活（L 线 10-02：和本机 AI 解耦）────────────────────────
// 「帮我改一下简历，突出 Agent 经验」「把简历里的项目经历润色一下」：以前只有开着材料页（正在看）或 @Writer 才交给 Writer，
// 别的时候当普通聊天，回话下面的「交给团队去做」一点就排进本机 AI 的队列。说到简历、又有改的动词、不是在问、不是要发出去的，
// 都是 Writer 的活。全是规则，不问模型。
const RESUME_WORD = /简历|履历|\bCV\b|\bresume\b/i;
const RESUME_EDIT = /改|润色|优化|突出|精简|重写|调整|完善|更新|修改|打磨|体检|诊断|检查|挑挑毛病|定制|翻译|缩短|量化|补充|强调|删掉|去掉|加上|写得/;
const NOT_EDIT = /发给|发到|发送|投递|投给|投一下|上传|附件|下载|导出|打印|转给/;
const asking = t => isQuestion(t) && !ASKING_POLITELY.test(t);
export function writerAsk(text) {
  const t = wclean(materialRequestText(text), 600);
  return !!t && RESUME_WORD.test(t) && RESUME_EDIT.test(t) && !NOT_EDIT.test(doablePart(t)) && !asking(t);
}
// 求职信、自我介绍：写一封新的，或者改已有的那封。number：话里点名的编号（#521、521 号、编号 521）；bare：话里别的数字
// （带单位的不算：「200 字」「2026 年」），对得上表里的一条才算（lib/talk.mjs 去对）。
const LETTER_WORD = /求职信|cover\s*letter|自我介绍|self[- ]?intro/i;
const LETTER_VERB = /写|改|润色|准备|生成|起草|来一|出一|弄一|做一|更新|重写|缩短|精简/;
const LETTER_NEW = /写一|写封|写个|写段|写份|来一|出一|弄一|做一|生成|起草|准备一/;
export function letterAsk(text) {
  const t = wclean(materialRequestText(text), 600), m = LETTER_WORD.exec(t);
  if (!m || !LETTER_VERB.test(t) || NOT_EDIT.test(doablePart(t)) || asking(t)) return null;
  const named = /#\s*(\d{1,6})(?!\d)|(\d{1,6})\s*号|编号\s*(\d{1,6})/.exec(t), bare = /(?<![\d.#])(\d{1,6})(?![\d.]|\s*(?:年|月|日|天|字|词|个|岁|分|行|段|句|%|万|k\b|w\b))/i.exec(t);
  return {
    kind: /自我介绍|self/i.test(m[0]) ? 'self_intro' : 'cover_letter',
    number: named ? Number(named[1] || named[2] || named[3]) : null, bare: !named && bare ? Number(bare[1]) : null,
    lang: /英文|English/i.test(t) ? 'en' : /中文|Chinese/i.test(t) ? 'zh' : null,
    revise: /改|润色|重写|缩短|精简|更新/.test(t) && !LETTER_NEW.test(t),
  };
}

// ── 接着改信、改简历的那几句（原 lib/talk.mjs）
// 接着改这封信的话：有改的意思、不是在问，也没把简历当成要改的那样（「改一下简历」是改简历，「按原简历修正」是照着简历改信）。
export const LETTER_MENTION = /求职信|cover\s*letter|自我介绍|self[- ]?intro/i;
export const FIX_VERB = /改(?!天|日|主意|变主意)|修(?!改主意)|润色|调整|缩短|精简|重写|换成|加上|去掉|删|保存|存成|按原|照着/;
export const EDIT_RESUME = /(?:改|定制|润色|优化|调整|修改|重写|精简|更新)[^，。,.；;]{0,6}(?:简历|履历|\bCV\b|resume)/i;
export const followsLetter = t => FIX_VERB.test(t) && !isQuestion(t) && !EDIT_RESUME.test(t) && !writerAsk(t);
// 一句话里既要信又要改简历（「定制简历 + 英文求职信」）：简历那件只拿说简历的那半句当要求，信的要求不混进来。
export const resumePart = t => String(t).split(/[，,；;。]|\s*\+\s*|和|还有|以及|并且|同时|另外/).filter(x => /简历|履历|\bCV\b|resume/i.test(x)).join('，') || t;

// ── 任务新建：这句话要开哪类活（原 lib/tasks.mjs planTalk 认的那一半；路线还在 planTalk 排）──
// 认得这几类：投递（投 / 投递 + 链接或编号）、联系（联系 / 找内推 + 编号）、调研 / 怎么准备（+ 编号）、材料（改简历 / 求职信 / 自我介绍）、
// 贴链接收录。问一句不是交办（负责人 09-30「问不等于委派」）；客气的请求照样是交办。认不出就是 null。
// 一句话里你写的邮箱（链接本身里的 @ 不算）：贴链接时顺手写的 HR 邮箱，收录时记成这个岗位的联系方式；只认你写的。
export const ownerEmail = (raw, url = '') => (String(raw || '').replace(url, ' ').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/) || [])[0] || null;
// 只点了公司名，还没有具体岗位：授权 Radar 找岗，不能当成批准一条投递。
export function companySearchAsk(text) {
  const raw = String(text || '').trim();
  if (isQuestion(raw) || deniesOutbound(raw) || outboundIntent(raw)) return null;
  const url = raw.match(URL_RE)?.[0] || null;
  const request = raw.replace(url || '\u0000', '').trim().replace(/[吧。！!]+$/, '').trim();
  const m = /^(?:(?:请|麻烦|劳驾|帮我|替我|给我)\s*)*(投(?:递)?(?:一下)?|申请(?:一下)?|(?:找|搜)(?:一下)?)\s*(.+)$/.exec(request);
  if (!m || (/找|搜/.test(m[1]) && !/(?:岗位|职位)$/.test(m[2]))) return null;
  const company = m[2].trim().replace(/\s*(?:公司)?(?:的)?(?:在招|正在招聘)?(?:岗位|职位)$/, '').replace(/\s*公司$/, '').trim().replace(/^[“「"]|[”」"]$/g, '').trim();
  if (!company || !/^[\p{L}\d][\p{L}\d .&()（）·_-]{0,79}$/u.test(company) || /^\d+$/.test(company)) return null;
  if (/简历|履历|求职信|自我介绍|申请表|\b(?:CV|resume|cover\s*letter|v\d+)\b/i.test(company)) return null;
  if (/^(?:这(?:个|些|家|条)?|那(?:个|些|家|条)?|它|全部|所有|都|岗位|职位|工作|公司|拟投清单|待投清单)(?:公司|岗位|职位)?$/.test(company)) return null;
  return { company, url };
}
export function taskIntent(text, { lead = null, member = null } = {}) {
  const raw = String(text || '').trim(), url = raw.match(URL_RE)?.[0] || null;
  const company = companySearchAsk(raw);
  if (company) return { intent: 'company_search', ...company, number: null };
  const number = lead?.number ?? (Number(raw.replace(URL_RE, '').match(/#?(\d{1,6})(?!\d)/)?.[1]) || null);
  if (isQuestion(raw.replace(URL_RE, ''))) return null;
  const oi = outboundIntent(raw);
  // 投：一件活对一条。编号按投的那几条认（「投 全部 去掉 44」不是投 #44，「投 12 13」是两条，交给指令那一路批准）。
  if (oi?.act === 'prefill') { const n = lead?.number ?? (oi.all || oi.numbers.length > 1 ? null : oi.numbers[0] ?? null); return n || oi.url ? { intent: 'apply', number: n, url: n ? url : oi.url, judge_first: /先判断|先看看值不值|判断一下再/.test(raw) } : null; }
  if (oi?.act === 'contact') return { intent: 'contact', number: lead?.number ?? oi.number, url };
  if (/(调研|怎么准备|准备一下)/.test(raw) && number) return { intent: /准备/.test(raw) ? 'prep' : 'research', number, url };
  if (/(改简历|求职信|自我介绍)/.test(raw)) return { intent: /改简历/.test(raw) ? 'resume' : 'letters', number, url };
  if (url && (!member || member === 'scout') && /^(收|收录|收一下|看看|读一下)?\s*https?:/.test(raw.replace(/\s+/g, ' '))) { const email = ownerEmail(raw, url); return { intent: 'intake', number: null, url, ...(email ? { email } : {}) }; }
  return null;
}

// ── 一句话认成什么（对话、手机、任务新建、收件箱都从这里拿）──
// card：卡片 / 收件箱那封信对着的那一条（{ number, kind }）：「发」「不发」「pass 太远」沿用它；focus：{ number } 你正看着的那一条（「投」→「投 12」）。
// 认不出要做什么就是 chat：照实交给对话里的成员，不猜成哪条指令。
const CMD_INTENT = { queue_apply: 'apply', send_all: 'send', apply_list: 'list', send_list: 'list', top_picks: 'list', brief: 'brief', query: 'query', op: 'op' };
const VERB_INTENT = { send: 'send', cancel: 'cancel_send', revise: 'revise', schedule: 'schedule', snooze: 'snooze', progress: 'progress', archive: 'archive', reopen: 'reopen', ignore: 'ignore' };
function intentOfCmd(cmd) {
  if (CMD_INTENT[cmd.kind]) return CMD_INTENT[cmd.kind];
  if (VERB_INTENT[cmd.verb]) return VERB_INTENT[cmd.verb];
  if (cmd.verb === 'feedback') { const w = (NUMBERED.exec(String(cmd.input || '')) || [])[2] || ''; return /^pass$/i.test(w) ? 'pass' : /^(联系|跟进)$/.test(w) ? 'contact' : w === '备注' ? 'note' : 'feedback'; }
  return cmd.verb || 'command';
}
// 指令动到哪几条（预览、回执、「查看 #12」的链接都用它）。
export function commandNumbers(cmd = {}) {
  if (Array.isArray(cmd.numbers) && cmd.numbers.length) return [...new Set(cmd.numbers)];
  if (cmd.number != null) return [Number(cmd.number)];
  const input = String(cmd?.input || '');
  if (cmd.verb === 'send') return [...new Set((input.match(/\d{1,6}/g) || []).map(Number))];
  const m = /^(\d{1,6})(?!\d)/.exec(input);
  return m ? [Number(m[1])] : [];
}
export function recognize(text, { card = null, focus = null } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { intent: 'empty', numbers: [] };
  const company = companySearchAsk(raw);
  if (company) return { intent: 'company_search', ...company, numbers: [] };
  const crew = crewCommand(raw);
  if (crew?.agent) return { intent: 'agent', verb: crew.agent, member: crew.member, numbers: [] };
  const follow = followupAsk(raw, { number: focus?.number || card?.number });
  const stop = endCurrentLead(raw) ? focus?.number || card?.number : null;
  const canonical = stop ? `${stop} pass` : follow ? `${follow} 跟进` : crew?.canonical || (focus?.number ? focusCommand(raw, Number(focus.number)) : null);
  const cmd = resolveCommand(canonical || raw, { card });
  const out = extra => ({ numbers: [], ...extra, ...(canonical ? { canonical } : {}) });
  // 「我的待办」「进展」「状态」也是在问现在怎么样（「帮助」照旧是指令说明）。
  if (cmd.kind === 'query' && QUERY.test(raw) && raw !== '帮助') return out({ intent: 'status' });
  if (!['freeform', 'ignore'].includes(cmd.kind) || (card && cmd.kind === 'ignore')) {
    const numbers = commandNumbers(cmd);
    return out({ intent: intentOfCmd(cmd), cmd, numbers, number: numbers.length === 1 ? numbers[0] : null, ...(cmd.op ? { op: cmd.op } : {}) });
  }
  // 卡片 / 那封信下面说的别的话：记成这一条的备注（不是猜一条指令）。
  if (card?.number && cmd.kind === 'freeform' && cmd.card) return out({ intent: 'note', cmd, numbers: [card.number], number: card.number });
  if (isLocalAiQuestion(raw) && !isWhyQuestion(raw)) return out({ intent: 'local_ai_status' });
  if (isWhyQuestion(raw)) { const w = whyTarget(raw, { focus }); return out({ intent: 'why', number: w.number, numbers: w.number ? [w.number] : [] }); }
  if (isStatusQuestion(raw)) return out({ intent: 'status' });
  const url = captureUrl(raw);
  if (url) return out({ intent: 'capture', url });
  const task = taskIntent(raw);
  if (task) return out({ intent: task.intent, task, url: task.url || null, number: task.number ?? null, numbers: task.number != null ? [task.number] : [] });
  if (writerAsk(raw)) return out({ intent: 'resume', numbers: [] });
  const letter = letterAsk(raw);
  if (letter) return out({ intent: 'letters', letter, number: letter.number, numbers: letter.number != null ? [letter.number] : [] });
  return out({ intent: 'chat' });
}

// ── 这句开不开活、拆不拆（原 lib/task-start.mjs，design/desktop-app/方案-任务即对话.md 第三节）──
// ask 只是问：只在对话里答；instant 当场办完的指令（pass、归档、暂停成员……）；work 会在后台留下一件要等的事。
// classify：lib/talk.mjs classifyTalk（对话面板同一套）；不给就只按话里的字认。
const verdict = (work, why) => ({ work, why });
const commandWork = cmd => !!cmd && (cmd.kind === 'queue_apply' || cmd.kind === 'op' || cmd.needs_run_now === true);
export function startsWork(text, { classify = null } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return verdict('ask', 'empty');
  const c = classify ? classify(raw) : null;
  if (['status', 'local_ai_status'].includes(c?.kind) || (!c && (isStatusQuestion(raw) || isLocalAiQuestion(raw)))) return verdict('ask', 'status');
  if (c?.kind === 'why') return verdict('ask', 'why');
  if (c?.kind === 'command') return commandWork(c.cmd) ? verdict('work', c.cmd.kind === 'queue_apply' ? 'apply' : c.cmd.kind === 'op' ? 'op' : 'run_now') : verdict('instant', c.cmd?.verb || 'command');
  if (taskIntent(raw)) return verdict('work', 'plan');
  if (writerAsk(raw) || letterAsk(raw)) return verdict('work', 'writer');
  if (c?.kind === 'capture') return verdict('work', 'capture');
  return verdict('ask', isQuestion(raw) ? 'question' : 'chat');
}
// 一句话里的几件事：「，再」「然后」「另外」「还有」「；」和换行切开。每一段单独看都是「做」才拆。
const SPLIT_WORK = /\s*(?:\n+|[；;]|[，,、]\s*再(?=\S)|[，,]?\s*(?:然后|另外|还有)[，,]?)\s*/;
const tidy = s => String(s || '').replace(/^[\s，,。.、！!]+|[\s，,。.、；;]+$/g, '').trim();
export function splitParts(text) {
  const parts = String(text ?? '').split(SPLIT_WORK).map(tidy).filter(Boolean);
  return parts.length > 1 ? parts : [String(text ?? '').trim()];
}
export function splitWork(text, { classify = null } = {}) {
  if (deniesOutbound(text)) return null;
  const parts = splitParts(text);
  if (parts.length < 2) return null;
  // 体检附的一句示例属于同一份结果；不能把原话截掉，再另建一件改写任务。
  if (writerIntent(parts[0]).kind === 'check' && parts.slice(1).every(p => /^(?:把|给|加|提供|展示)?(?:其中|里面|里头)?(?:的)?(?:一句|一条|一处|一个)(?:原句|例子|示例)?[^。；]{0,20}改写/.test(materialRequestText(p)) && !/(?:#\d|求职信|自我介绍|联系|调研)/.test(materialRequestText(p)))) return null;
  return parts.every(p => startsWork(p, { classify }).work === 'work') ? parts : null;
}
