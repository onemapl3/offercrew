// config/*-prompt.md 是交给执行器（Codex / Claude）的提示词模板。本人的路径和邮箱不写进模板，写成占位符，
// bin/host/*.sh 在交出去之前经 bin/host/render-prompt.mjs 填上：
//   {{ROOT}}     仓库根：脚本 cd 过去之后的 $PWD（与 -C "$PWD" 同一个路径）
//   {{HOME}}     家目录
//   {{MAILBOX}}  系统读写的 Gmail（candidate/facts.yaml identity.mailbox，没写就是 identity.email）
//   {{EMAIL}}    简历上的邮箱（identity.email，没写就是 mailbox）
//   {{FOCUS_CITIES}}  当前求职设置的目标城市（lib/city.mjs），「/」连接，不含远程；没配置就写「目标城市」
//   {{INTERVIEW_GUIDE}}  通用面试讲义：config/interview-guide.json 的 url（写了 local_entry 再加「本地入口 …」，
//                开头的 ~/ 换成家目录）；没配置就写「未配置（config/interview-guide.json）」
//   {{REMOTE_SCOPE}}  远程岗位要对哪里开放：只能在中国工作的人是「可在中国工作」（以前模板里写死的原话），
//                在美国拿到工作许可的人是「可在美国或中国工作」这样（lib/work-auth.mjs）
//   {{SENIOR_WORDS}}  浏览列表时直接跳过的标题词：软件方向是以前那一串，金融、市场等方向换成这些行业的级别词
//   {{BROWSER}} / {{BROWSER_TOOL}} / {{BROWSER_SPACE}} / {{BROWSER_HOWTO}}  网页上的活用哪个浏览器（lib/ego-browser.mjs
//                browserEngine，和 ego 解耦第 4 批）：ego 时填出来和以前写死的原话一样（「ego 浏览器」「ego-browser 技能」
//                「ego 任务空间」，BROWSER_HOWTO 是空的）；专用 Chrome 时是 `node bin/browser.mjs` 和一句怎么写脚本
// 迁移时核对过：本机配置填出来与改动之前模板里写死的文字逐字相同（tests/prompt.test.mjs）。
// 认不出的占位符、没有值的占位符原样留着：宁可让执行器看见 {{MAILBOX}}，也不替它编一个。
import os from 'node:os';
import { mailboxOf, readFacts } from './facts.mjs';
import { read } from './store.mjs';
import { cityConfigFrom, REMOTE } from './city.mjs';
import { workRegions, chinaOnly } from './work-auth.mjs';
import { isGeneral } from './directions.mjs';
import { browserEngine } from './browser-run.mjs';

export function remoteScope({ facts = readFacts() } = {}) {
  if (chinaOnly(facts)) return '可在中国工作';
  return `可在${workRegions(facts).map((r) => ({ cn: '中国', us: '美国' }[r] || r)).join('或')}工作`;
}
export const seniorWords = ({ facts = readFacts() } = {}) => (isGeneral(facts) ? 'Senior / Lead / Principal / VP / Director / Manager / 资深 / 高级 / 主管 / 经理 / 总监' : 'Senior / Principal / Staff / Lead / 资深 / 高级 / 专家');

export function focusCities({ facts = readFacts() } = {}) {
  return cityConfigFrom(facts).ranked.filter((c) => c !== REMOTE).join('/') || '目标城市';
}
export function interviewGuide({ guide = read('config/interview-guide.json', {}), home = os.homedir() } = {}) {
  const url = String(guide?.url ?? '').trim(), local = String(guide?.local_entry ?? '').trim().replace(/^~(?=\/)/, home);
  if (!url && !local) return '未配置（config/interview-guide.json）';
  return [url, local ? `本地入口 ${local}` : ''].filter(Boolean).join('，');
}
export const BROWSER_HOWTO = '浏览器脚本用 `node bin/browser.mjs -e \'<脚本>\'` 跑（长的从标准输入给：`node bin/browser.mjs <<\'EOF\'`），写法说明在 `docs/browser-scripts.md`。报 `site_check:<网站>` 是这个网站要人来验证，`site_busy:<网站>` 是这个网站上别的脚本还没跑完：都停下这一站，不重试，不换办法绕过去。';
export function browserVars() {
  return { BROWSER: '专用 Chrome', BROWSER_TOOL: '`node bin/browser.mjs`', BROWSER_SPACE: '任务空间', BROWSER_HOWTO };
}
export function promptVars({ root = process.cwd(), home = os.homedir(), facts = readFacts(), pipeline, guide, browser } = {}) {
  const mailbox = mailboxOf(facts), email = String(facts?.identity?.email ?? '').trim() || mailbox;
  let focus; try { focus = focusCities({ facts, ...(pipeline === undefined ? {} : { pipeline }) }); } catch { focus = '目标城市'; }
  let interview; try { interview = interviewGuide({ home, ...(guide === undefined ? {} : { guide }) }); } catch { interview = '未配置（config/interview-guide.json）'; }
  let engine; try { engine = browser || browserEngine(); } catch { engine = 'chrome'; }
  return { ROOT: root, HOME: home, MAILBOX: mailbox, EMAIL: email, FOCUS_CITIES: focus, INTERVIEW_GUIDE: interview, REMOTE_SCOPE: remoteScope({ facts }), SENIOR_WORDS: seniorWords({ facts }), ...browserVars(engine) };
}
// 可以填成空的占位符（ego 时没有那句说明）；别的没有值就原样留着。
export const MAY_BE_EMPTY = new Set(['BROWSER_HOWTO']);
export const renderPrompt = (text, vars = promptVars()) => String(text).replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (vars[key] ? String(vars[key]) : vars[key] === '' && MAY_BE_EMPTY.has(key) ? '' : m));
