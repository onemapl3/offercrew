// 「开始使用」：一张清单告诉你这套系统现在缺什么、去哪补（2026-09-28）。
//
// 每一项只读现有的配置和状态文件，给出 ok / warn / missing 和一句"下一步"；补的地方都是已有的
// 页面（设置、收件箱的账号、高级邮箱接入……）。这里不写任何文件。简历、个人资料、求职方向三项
// 带 edit：页面就地打开编辑（导入简历见 lib/resume-import.mjs，资料保存见 lib/profile.mjs）。新用户照着从上往下做完，
// 系统就能跑一轮；老用户用它检查换机器、换模型之后哪里断了（换机器后飞书授权、lark-cli
// 路径、ego 登录可能一起断，缺的就是这样一张清单）。
//
// 按方向（2026-09-29）：最前面一项「你的方向」读 facts 的 preferences.directions（lib/directions.mjs），
// 点开是选方向的弹窗。主方向不是软件的（金融、市场……），简历、个人资料、求职方向、岗位来源几项按方向给提示、
// 按方向算缺什么；软件方向（包括没写方向的老用户）其余各项和以前逐字一样
// （tests/setup-directions.test.mjs 拿改动之前录下的清单逐项对比）。
import { browserEngine } from './browser-run.mjs';
import { findChrome } from './browser-host.mjs';
import { sandboxNote, modelLabel } from './model-truth.mjs';
import { judgeAvailable, judgeOffline } from './judge.mjs';
import { DISCOVERY_SOURCES, sourceEnabled } from './discovery-policy.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { file, read, root, text as readConfigText } from './store.mjs';
import { appShell, localAi } from './capabilities.mjs';
import { localAiStatus } from './local-ai-status.mjs';
import { appSchedule } from './app-schedule.mjs';
import { directionKey, directionLabel, directionSummary, isGeneral, primaryDirection, tracksOf, candidateStage, targetFamilies, adjacentFamilies, familyLabel, DIRECTIONS } from './directions.mjs';
import { splitDates, BROKEN_TEXT } from './profile.mjs';
import { materialsCount } from './resume-store.mjs';
import { latestDraft } from './resume-import.mjs';
import { loadPortalSessions, applyChannel, applyUrl } from './apply-channel.mjs';
import { accountsView, hostOf, loadAccounts } from './accounts.mjs';
import { accountTable } from './account-table.mjs';
import { computerUseConfig } from './computer-use.mjs';
import { loadProviders, resolveBackend, codexProviders, codexConfigPath, textBackendUsable } from './backends.mjs';
import { cliModel } from './text-cli.mjs';
import { textConf } from './text-conf.mjs';
import { computerUseSettings, operatorModelLabel } from './operator/config.mjs';
import { onboardingState } from './onboarding-state.mjs';
import { unlockItems, unlockSnoozed } from './unlock.mjs';
import { spendTier, budgetConfig, budgetState, limitText, usedText, TIER_LABEL, TIER_NOTE } from './spend.mjs';
import { createRequire } from 'node:module';
import { href } from './routes.mjs';

const exists = p => { try { return fs.statSync(file(p)).size > 0; } catch { return false; } }; // 兜底：文件不在或是空的就算没有
// 桌面版的执行器（lib/capabilities.mjs localAi，10-02 开箱第 2 轮 X1）：关着、或打开了但没在跑时，清单不写它用哪个模型。
// 界面上叫它「本机 AI」，不说「执行器」（主会话 10-02）。
const desktopExec = () => localAi({ root }); // 命令行版 10-04 冻结：只有一种身份
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || null; } catch { return null; } })(); // 兜底：读不到版本号就不显示
const installed = mod => { try { createRequire(import.meta.url).resolve(mod); return true; } catch { return false; } }; // 兜底：没装就是 false，设置页照实显示
// 文件不在 = 还没有（null）；在但 YAML 写坏了要照实说，不能当成「还没有」（09-29：一个引号没闭合，清单说简历、资料都没有）。
const BROKEN = Symbol('broken');
const facts = () => { let t; try { t = fs.readFileSync(file('candidate/facts.yaml'), 'utf8'); } catch { return null; } try { return YAML.parse(t) || {}; } catch (e) { return { [BROKEN]: String(e.message).split('\n')[0].slice(0, 160) }; } }; // 兜底：资料文件还没有就是 null（还没填）；写坏了下面照实带出原因
// 读不了：和编辑器、资料横条同一句（lib/profile.mjs BROKEN_TEXT），不出现文件名、不叫你手动修。
const intact = F => { if (F?.[BROKEN]) throw Error(BROKEN_TEXT); return F; };
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const filled = v => Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '';

function step(key, title, why, check, edit = null) {
  const extra = edit ? { edit } : {};
  try { return { key, title, why, ...check(), ...extra }; }
  catch (e) { return { key, title, why, status: 'warn', summary: `检查时出错：${String(e.message).slice(0, 120)}`, detail: [], ...extra }; }
}

// ── 按方向的清单文字（2026-09-29）：这次新加的文字都在这里，做中英文切换时只换这一处 ──────────────
// 方向名、简介、岗位类别名取 lib/directions.mjs 的 zh / en，不在这里另写一份。软件方向看到的老文字仍在下面各项里，一字未动。
const COPY = {
  direction: {
    title: '你的方向',
    why: '你的求职团队按它找岗位、判断值不值得投、提醒你简历和资料还要补什么。',
    none: '还没选方向',
    noneDetail: names => [`点「选方向」：从${names.join('、')}里选一个主方向；有细分的（金融：投行、资管……）还可以选细分。`, '每个方向旁边有「看示例」：一个虚构的人按这个方向写的资料，可以对照着填。'],
    // 方向必填（负责人 10-10）：没写、或者写的一个都认不出，不推荐岗位（lib/recommend-gate.mjs directionSet）。
    legacy: '还没选方向，先不推荐岗位',
    legacyDetail: ['选好方向以后，排队的推荐接着放出来。'],
    unknown: raw => `写的方向「${raw}」认不出来，先不推荐岗位`,
    unknownDetail: n => [`从 ${n} 个方向里重新选一个；保存时会换掉认不出的写法。`],
    software: '软件方向沿用以前的规则：想做前端、测试、算法这类，在「求职方向与排除」的补充说明里写上。',
    ignored: raw => `认不出的「${raw}」没算进去。`,
    scope: (inside, near) => `推荐：${inside}${near ? `；相邻的${near}不在入库前筛掉，交给判断看岗位描述` : ''}。`,
    noTracks: dir => `没选细分，${dir}里的几类都看；只想做其中几类，点「改方向」勾上。`,
    stage: { student: '在读', new_grad: '应届', experienced: '有经验' },
    stageLine: s => `按你写的教育和经历，现在按「${s}」来推岗位。`,
  },
  // 简历一项：按主方向提醒简历里要有什么。
  resume: {
    finance: '金融简历要写上 GPA、证书（例如 CFA 一级已通过）和每段实习（公司、职位、起止年月、做了什么）：招聘方先看这几样，判断岗位时也按它们来。',
    consulting: '咨询简历要写上 GPA、证书和每段实习（项目、你负责的部分、结果）：招聘方先看这几样，判断岗位时也按它们来。',
    marketing: '写上作品（账号、活动、案例链接）和数据成绩（曝光、互动率、转化率、GMV……）：市场岗先看这些。',
    operations: '写上你运营过的东西和数据成绩（拉新、留存、复购、GMV……）：运营岗先看这些。',
    product: '写上你做过的产品或功能、你负责的部分和上线后的数据：产品岗先看这些。',
    data: '写上用过的工具（SQL、Python、Excel、Tableau……）和分析得出的结论与数字：数据分析岗先看这些。',
  },
  // 个人资料一项：通用方向的缺项名和「齐全」的说法（和软件方向同名的几项用同一个叫法）。
  profile: {
    name: '姓名', email: '邮箱', phone: '手机', education: '教育经历', graduation: '毕业时间', city: '现居城市', targets: '目标城市',
    auth: '工作许可', authCn: '工作许可（中国大陆）', authUs: '工作许可（美国）', start: '最早到岗', salary: '期望薪资', current: '现职',
    missing: list => `还缺 ${list.length} 项：${list.join('、')}`,
    ok: (who, stage) => `基本信息齐全（${who}，按${stage}来推岗位）`,
    extras: '证书（CFA、PMP、Google Analytics 认证……）和 GPA 在「编辑」里的证书、教育两栏填。',
    ids: '身份证号、户籍、政治面貌这类不存进资料；国内门户的申请表问到时，你的求职团队会停下来问你。',
  },
  targets: { roles: r => `补充说明：${r}` },
  // 岗位来源一项：同事做的起步清单（config/company-packs/<方向>.example.yaml）在的时候才提。
  sources: (dir, rel, own) => own
    ? `${dir}方向有一份起步公司清单，在「求职偏好 → 公司」里一键加入`
    : `现在扫的是示例里的软件公司；${dir}方向有一份起步公司清单，在「求职偏好 → 公司」里一键加入`,
};

// 主方向不是软件：简历、资料、方向、来源几项按方向说。没有 facts 或写坏了的，照软件（老文字）处理；
// 方向写成「constructor」这类会让注册表的读法出错的，也照软件处理（「你的方向」一项会说认不出）。
const general = F => { try { return !!F && !F[BROKEN] && isGeneral(F); } catch { return false; } }; // 兜底：资料的格式不对就不算通用方向，设置页照常显示
// 认得出的方向键：directionKey 查的是普通对象，原型上的名字（constructor、toString……）不算。
const knownKey = v => { const k = directionKey(v); return typeof k === 'string' && Object.hasOwn(DIRECTIONS, k) ? k : null; };
const asList = v => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : v == null || v === '' ? [] : String(v).split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean);
const yearsOf = F => { const y = Number(F?.experience_summary?.years); return F?.experience_summary?.years != null && Number.isFinite(y) ? y : null; };
const stageOf = F => candidateStage(F, yearsOf(F));
// 目标城市里有没有美国的：有就要美国的工作许可；其余城市（或还没写城市）要中国大陆的。
// 「Austin, TX」这种写法只认美国的州（London, UK、Hong Kong, HK、Toronto, ON 都不是美国）。
const US_PLACE = /美国|纽约|旧金山|硅谷|西雅图|波士顿|芝加哥|洛杉矶|华盛顿|奥斯汀|休斯顿|达拉斯|\b(?:USA?|United States|New York|NYC|San Francisco|Bay Area|Silicon Valley|Seattle|Boston|Chicago|Los Angeles|Washington|Austin|Houston|Dallas|Atlanta|Miami|Philadelphia|Charlotte|Jersey City)\b/i;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const inUS = c => US_PLACE.test(c) || US_STATES.has((String(c).match(/,\s*([A-Z]{2})$/) || [])[1]);
// 已离职 / 待业的人，「有经验」也不要求现职。
const LEFT_JOB = /离职|待业|unemployed|between jobs|not employed/i;
// 毕业时间：写了日期的每段教育都要有结束年月（「2022-09 至 2026-05」；还在读就写预计毕业的年月）。
// 「至今」或只写了开始的那段就是还不知道哪年毕业：金融招聘按届次招人，这一项要问。
// （先压掉多余的空白、截短：splitDates 的正则碰上手写的一长段空白会很慢。）
const ended = e => /\d{4}/.test(String(e?.graduation ?? '')) || /\d{4}/.test(splitDates(String(e?.dates ?? '').replace(/\s+/g, ' ').slice(0, 80)).end);
function graduationKnown(education) {
  const dated = (Array.isArray(education) ? education : []).filter(e => e && typeof e === 'object' && (e.dates || e.graduation));
  return dated.length > 0 && dated.every(ended);
}

// 「你的方向」一项。
function directionStep(F) {
  const D = COPY.direction;
  // 方向的名字取 lib/directions.mjs（主方向的顺序：通用方向在前，软件在最后，和弹窗里的卡片顺序无关）。
  const names = [...Object.keys(DIRECTIONS).filter(k => k !== 'software'), 'software'].map(k => directionLabel(k));
  if (!intact(F)) return { status: 'missing', summary: D.none, detail: D.noneDetail(names), fix: null };
  const raw = [...asList(F.preferences?.directions), ...asList(F.preferences?.direction)];
  const unknown = raw.filter(x => !knownKey(x));
  const pick = { label: '选方向', href: '#settings/prefs?hl=direction' };
  if (!raw.length) return { status: 'missing', summary: D.legacy, detail: D.legacyDetail, fix: pick, todo: '方向没选', go: pick.href };
  const unreadable = { status: 'missing', summary: D.unknown(unknown.join('、')), detail: D.unknownDetail(names.length), fix: pick, todo: '方向认不出', go: pick.href };
  if (unknown.length === raw.length) return unreadable;
  const note = unknown.length ? [D.ignored(unknown.join('、'))] : [];
  try {
    if (!isGeneral(F)) return { status: 'ok', summary: directionSummary(F), detail: [D.software, ...note], fix: null };
    const primary = DIRECTIONS[primaryDirection(F)], near = adjacentFamilies(F);
    return { status: 'ok', summary: directionSummary(F), detail: [
      D.scope(targetFamilies(F).map(k => familyLabel(k)).join('、'), near.map(k => familyLabel(k)).join('、')),
      ...(primary.tracks && !tracksOf(F).length ? [D.noTracks(primary.zh)] : []),
      D.stageLine(D.stage[stageOf(F)]),
      ...note,
    ], fix: null };
  } catch { return unreadable; } // 混着原型上的名字，注册表的读法出错：按认不出说
}
// 通用方向的「还缺什么」：应届 / 在读不要求现职；金融要毕业时间；工作许可按目标城市要中国大陆的、美国的，或两个都要。
// 求职方向本身已经写了（不然不会走到这里），不再要 role_families；期望薪资人民币、美元写一个就行。
function generalProfile(F) {
  const P = COPY.profile, stage = stageOf(F), cities = asList(get(F, 'location.target_cities'));
  const us = cities.some(inUS), cn = !cities.length || cities.some(c => !inUS(c));
  const need = [
    [P.name, filled(get(F, 'identity.name_zh')) || filled(get(F, 'identity.name_en'))],
    [P.email, filled(get(F, 'identity.email'))],
    [P.phone, filled(get(F, 'identity.phone_cn'))],
    [P.education, filled(F.education)],
    ...(primaryDirection(F) === 'finance' ? [[P.graduation, graduationKnown(F.education)]] : []),
    [P.city, filled(get(F, 'location.current_city'))],
    [P.targets, cities.length > 0],
    ...(cn ? [[us ? P.authCn : P.auth, filled(get(F, 'work_authorization.china_mainland'))]] : []),
    ...(us ? [[P.authUs, filled(get(F, 'work_authorization.us'))]] : []),
    [P.start, filled(get(F, 'availability.earliest_start'))],
    [P.salary, filled(get(F, 'compensation.expected_annual_cny')) || filled(get(F, 'compensation.expected_annual_usd'))],
    ...(stage === 'experienced' && !LEFT_JOB.test(String(get(F, 'availability.current_status') ?? '')) ? [[P.current, filled(get(F, 'current_work.company'))]] : []),
  ];
  const miss = need.filter(([, ok]) => !ok).map(([l]) => l);
  return { status: miss.length === 0 ? 'ok' : miss.length <= 3 ? 'warn' : 'missing', summary: miss.length ? P.missing(miss) : P.ok(F.identity?.name_zh || F.identity?.name_en || '', COPY.direction.stage[stage]), detail: [P.extras, P.ids], fix: { label: '在设置里填写', href: '#settings' } };
}

// 文字模型能不能用：这张清单不跑命令，只看本机文件和 PATH。claude / codex 要在 PATH 上（或 RADAR_*_BIN 指的
// 文件在）；Codex 另外要有登录（登录目录里的 auth.json）或自带 bearer 的中转；HTTP 供应商要有凭据文件里的 token；
// Claude 订阅要在它的登录目录里登录过（claude auth status）。没有一个能用，导入简历、匹配岗位都会失败，这一项不能说「好了」。
// textBackendUsable 搬到了 lib/backends.mjs（OfferCrew 补给 lib/free-model.mjs 也要用，避免循环引用）；这里照旧导出。
export { textBackendUsable };
// 没写 text 段就是默认链（lib/text-conf.mjs），和 infer 用的同一条。
function textBackends() {
  const providers = loadProviders(), conf = textConf({ providers });
  return (Array.isArray(conf.backends) ? conf.backends : []).map(r => { try { return resolveBackend(r, providers); } catch { return null; } }).filter(Boolean); // 兜底：解析不了的那一项跳过（和对话的清单同一条规矩）
}

export function setupView({ runtime = {}, leads = [] } = {}) {
  const F = facts();
  const steps = [
    step('direction', COPY.direction.title, COPY.direction.why, () => directionStep(F), 'direction'),
    step('resume', '简历', '匹配岗位、填申请表、发邮件附件都用它。', () => {
      const routing = intact(F)?.resume_routing || {};
      const pdfs = [routing.english_pdf, routing.chinese_pdf].filter(Boolean);
      const missing = pdfs.filter(p => !exists(p));
      const materials = materialsCount(), pending = latestDraft();
      const hint = general(F) ? [COPY.resume[primaryDirection(F)]].filter(Boolean) : [];
      const fix = { label: '体检、改写简历', href: '#materials' };
      // 上传到材料库不必先写旧的 routing / resume.tex；有材料与投递文件已准备好分开说。
      if (materials.docs) {
        const ready = pdfs.length > 0 && !missing.length;
        const delivery = !pdfs.length ? '还没设置投递用的 PDF' : missing.length ? `投递文件找不到：${missing.map(p => p.split('/').pop()).join('、')}` : `投递文件：${pdfs.map(p => p.split('/').pop()).join('、')}`;
        return { status: ready ? 'ok' : 'warn', summary: `已导入 ${materials.docs} 份简历，${materials.versions} 个版本；${delivery}`, detail: hint, fix };
      }
      if (pending && (!pdfs.length || missing.length === pdfs.length)) return { status: 'warn', summary: `已上传《${pending.name}》，${pending.extracting ? '正在整理' : pending.status === 'extracted' ? '等待核对并保存' : '等待整理和核对'}`, detail: hint, fix: { label: '继续确认简历草稿', href: '#settings/overview/checklist' } };
      const tex = exists('candidate/resume.tex');
      const status = !pdfs.length || missing.length === pdfs.length ? 'missing' : missing.length || !tex ? 'warn' : 'ok';
      return { status, summary: status === 'ok' ? `${pdfs.length > 1 ? '中英文简历都在' : '简历在（中英文岗位都用它）'}（${pdfs.map(p => p.split('/').pop()).join('、')}）` : !pdfs.length ? '还没有简历' : `缺：${[...missing, ...(tex ? [] : ['匹配用的文字版'])].join('、')}`, detail: [...hint], fix: { label: '体检、改写简历', href: '#materials' } };
    }, 'resume'),
    step('profile', '个人资料', '填申请表、写首联、回答"期望薪资 / 到岗时间"这类问题时用。', () => {
      if (!intact(F)) return { status: 'missing', summary: '还没有个人资料', detail: [], fix: null };
      if (general(F)) return generalProfile(F);
      const need = { 'identity.name_en': '英文名', 'identity.name_zh': '中文名', 'identity.email': '邮箱', 'identity.phone_cn': '手机', 'education': '教育经历', 'location.current_city': '现居城市', 'location.target_cities': '目标城市', 'work_authorization.china_mainland': '工作许可', 'availability.earliest_start': '最早到岗', 'compensation.expected_annual_cny': '期望薪资', 'preferences.role_families': '目标方向' };
      const miss = Object.entries(need).filter(([p]) => !filled(get(F, p))).map(([, l]) => l);
      return { status: miss.length === 0 ? 'ok' : miss.length <= 3 ? 'warn' : 'missing', summary: miss.length ? `还缺 ${miss.length} 项：${miss.join('、')}` : `基本信息齐全（${F.identity?.name_zh || F.identity?.name_en || ''}）`, detail: [], fix: { label: '在设置里填写', href: '#settings' } };
    }, 'profile'),
    step('targets', '求职方向与排除', '决定推荐什么、不推什么。', () => {
      // 手写成一行字符串（"杭州、上海"）的也当列表读：原来 cities.join 直接报错、硬排除按字数算。
      const asList = v => Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/[\n,，、]+/).map(s => s.trim()).filter(Boolean);
      const cities = asList(get(intact(F) || {}, 'location.target_cities')), roles = asList(get(F || {}, 'preferences.role_families')), hard = asList(get(F || {}, 'preferences.hard_exclusions'));
      const excluded = read('config/concierge.json', {}).auto_apply_policy?.excluded_companies || read('config/pipeline.json', {}).discovery?.excluded_companies || [];
      // 通用方向：方向（和金融的细分）就是选好的方向，role_families 只是补充说明，不算缺。
      if (general(F)) return { status: cities.length ? 'ok' : 'warn', ...(cities.length ? {} : { todo: '城市没填', go: '#settings/prefs?hl=cities' }), summary: `城市：${cities.join('、') || '未填'} · 方向：${directionSummary(F)}`, detail: [`硬排除 ${hard.length} 条${excluded.length ? `，排除公司 ${excluded.length} 家` : ''}。`, ...(roles.length ? [COPY.targets.roles(roles.slice(0, 4).join('、'))] : [])], fix: { label: '调整偏好', href: '#settings' } };
      // 工程师方向：以前只认补充说明里的岗位类别（preferences.role_families），可引导写的是方向和子方向（directions、tracks），
      // 从不写它——选了「工程师（后端）」还是「方向：未填」，概览又把摘要截成「城市」（10-02 开箱第 2 轮 N05）。现在子方向也算，
      // 在引导里答过方向（走完了引导、写了方向）也算；只写了 directions: [software] 的老资料照旧（软件是默认方向，写不写一个样），
      // 缺什么就在概览上说缺什么，点进去到缺的那一行。
      const tracks = asList(get(F || {}, 'preferences.tracks'));
      const guided = onboardingState().status === 'finished' && (asList(get(F || {}, 'preferences.directions')).length > 0 || !!String(get(F || {}, 'preferences.direction') || '').trim());
      const dir = roles.length ? roles.slice(0, 4).join('、') : tracks.length || guided ? directionSummary(F) : '';
      const missing = [!cities.length && '城市', !dir && '方向'].filter(Boolean);
      return { status: missing.length ? 'warn' : 'ok', ...(missing.length ? { todo: `${missing.join('、')}没填`, go: `#settings/prefs?hl=${dir ? 'cities' : 'direction'}` } : {}), summary: `城市：${cities.join('、') || '未填'} · 方向：${dir || '未填'}`, detail: [`硬排除 ${hard.length} 条${excluded.length ? `，排除公司 ${excluded.length} 家` : ''}。`], fix: { label: '调整偏好', href: '#settings' } };
    }, 'targets'),
    step('sources', '岗位来源', '从哪些官网、平台、真人帖找岗位。', () => {
      const text = readConfigText('config/companies.yaml');
      const all = YAML.parse(text) || [];
      const list = Array.isArray(all) ? all : all.companies || [];
      const active = list.filter(c => !c.paused).length;
      const human = read('config/human-source-policy.json', {}) || {};
      // 真人帖来源（公司官网除外）给你看名字（脉脉、BOSS 直聘……）。没写在文件里的算开着，和扫描时一样（sourceEnabled）；
      // 以前只数文件里写着的几项，模板里写着的四项都是关的，于是写「真人帖来源开着：无」（10-02 开箱第 2 轮 N01）。
      const keys = Object.keys(DISCOVERY_SOURCES).filter(k => k !== 'official');
      const on = keys.filter(k => sourceEnabled(k, human)).map(k => DISCOVERY_SOURCES[k]), off = keys.filter(k => !sourceEnabled(k, human)).map(k => DISCOVERY_SOURCES[k]);
      // 来源开着，每天抓真人帖却关着：一个也不会去扫，写明白。
      const dailyOff = on.length && read('config/pipeline.json', {})?.human_discovery_daily !== true;
      // 通用方向：仓库里有这个方向的起步清单（config/company-packs/<方向>.example.yaml）就提一句，没有就不提。
      const pack = general(F) ? `config/company-packs/${primaryDirection(F)}.example.yaml` : null;
      const packHint = pack && exists(pack) ? [COPY.sources(directionLabel(primaryDirection(F)), pack, fs.existsSync(file('config/companies.yaml')))] : [];
      return { status: active ? 'ok' : 'missing', summary: `公司官网 ${active} 家在扫${list.length - active ? `（暂停 ${list.length - active}）` : ''} · 真人帖来源开着：${on.length > 4 ? `${on.slice(0, 4).join('、')} 等 ${on.length} 个` : on.join('、') || '无'}${dailyOff ? '（每天扫描关着）' : ''}`, detail: [...packHint, ...(off.length ? [`关着的来源：${off.join('、')}`] : [])], fix: { label: '看岗位', href: href.jobs() } };
    }),
    // 解锁全部功能（Mac 版）：和收件箱那封「还差几步」同一份清单（lib/unlock.mjs）。
    ...(appShell() ? [step('unlock', '解锁全部功能', '登录引导里勾过的网站、接上邮箱以后，系统才能在那里找岗位、发私信、读回信。', () => {
      const items = unlockItems(), need = items.filter(i => i.required && !i.done);
      const snoozed = unlockSnoozed();
      // 点这一行：打开收件箱里那封信（先不看了的那一周里去「平台账号」）。
      return { status: need.length ? 'warn' : 'ok', ...(need.length ? { todo: `还差 ${need.length} 步`, go: snoozed ? '#settings/accounts' : '#inbox?ask=unlock' } : {}), summary: need.length ? `还差：${need.map(i => i.label).join('、')}` : '都做好了', detail: items.map(i => `${i.done ? '✓' : '○'} ${i.label}${i.required ? '' : '（可选）'}`), unlock: items, fix: null };
    })] : []),
    step('accounts', '平台账号', '投递、私信、扫真人帖都要用你在浏览器里登录好的账号。', () => {
      // 招聘平台（LinkedIn、脉脉、BOSS……）一直列着，没核实过就是「还没核实」；公司招聘站有岗位在那里才列。
      // 和收件箱「账号」、System 页同一张表（lib/account-table.mjs）。
      const rows = accountTable({ leads }).filter(a => a.kind !== 'service');
      const out = rows.filter(a => a.logged_in === false), unknown = rows.filter(a => a.logged_in == null);
      const stale = rows.filter(a => a.logged_in === true && a.verified_at && Date.now() - Date.parse(a.verified_at) > 14 * 86400000);
      // todo：概览「还差 N 项」那一行说缺什么（以前摘要被截在第一个冒号，只剩「30 个账号」，看不出为什么是橙点）。
      return { accounts: rows.map(a => ({ key: a.key, label: a.label, kind: a.kind, login_url: a.login_url || null, logged_in: a.logged_in ?? null, ...(a.maybe_out ? { maybe_out: true } : {}), verified_at: a.verified_at || null })), status: out.length ? 'warn' : 'ok', ...(out.length ? { todo: `${out.length} 个没登录` } : {}), summary: `${rows.length} 个账号：已登录 ${rows.filter(a => a.logged_in === true).length}，没登录 ${out.length}，没记录 ${unknown.length}`, detail: [out.length ? `没登录：${out.slice(0, 8).map(a => a.label).join('、')}` : null, stale.length ? `超过两周没核对：${stale.map(a => a.label).join('、')}（换过电脑的话要重新登录）` : null].filter(Boolean), fix: { label: '打开账号页', href: '#inbox', filter: 'accounts' } };
    }),
    step('notify', '通知与手机', '系统有事找你时怎么通知；在手机上怎么处理。', () => {
      return { status: 'ok', summary: '有事在工作台和配对的手机上找你', detail: [], fix: null };
    }),
    step('models', '模型', '判断岗位、写首联、执行任务的大模型。', () => {
      // 判断岗位真的用什么：离线规则打开了写离线规则；有判断模型（Jev，lib/judge.mjs）写判断模型；都没有时，岗位照样由文字模型判断
      // （bin/match.mjs），不是跳过——以前写「没有判断模型，这一步会跳过」，可首轮的 Judge 一直在调文字模型（10-02 开箱第 2 轮 N03）。
      // 走到这里文字模型一定能用（不能用的在下面先返回了）。
      const judge = judgeOffline() ? '离线规则' : judgeAvailable() ? '判断模型' : '文字模型';
      const sb = sandboxNote();
      if (sb) return { status: 'warn', summary: sb, detail: [], fix: { label: '模型设置', href: '#settings/model' } };
      const chain = textBackends(), usable = chain.find(textBackendUsable);
      if (!usable) return { status: 'missing', summary: '还没有能用的文字模型：导入简历、匹配岗位都要它', detail: [], fix: { label: '模型设置', href: '#settings/model' } };
      return { status: 'ok', current: usable.id, summary: `文字模型：${modelLabel(usable.id)} · 判断岗位：${judge}`, detail: [], fix: { label: '模型设置', href: '#settings' } };
    }),
    // Patch 的记账（lib/spend.mjs、docs/cost.md）：用 API key 的新用户第一件要知道的事——花多少、能不能封顶。
    step('spend', '花费档位与每天上限', '模型按 token 算钱（用 API key 时）。先选一档，再决定要不要给每天设个上限。', () => {
      const p = read('config/pipeline.json', {}) || {}, tier = spendTier(p), cap = budgetConfig(p), b = budgetState({ pipeline: p });
      const chosen = p.spend_tier != null || cap.daily_usd != null || cap.daily_tokens != null;
      return { status: 'ok', summary: `${TIER_LABEL[tier]}档${chosen ? '' : '（默认）'} · 每天上限：${cap.daily_usd == null && cap.daily_tokens == null ? '不限' : limitText({ ...b, limit_usd: cap.daily_usd, limit_tokens: cap.daily_tokens })} · 今天已用 ${usedText(b)}`, detail: [], fix: { label: '花费设置', href: '#settings/spend' } };
    }, 'spend'),
    step('computer', '电脑操作方式', '打开网页、填表、发私信靠什么在操作浏览器。', () => {
      const cu = computerUseConfig();
      // 业务电脑操作固定为内置操作员，沿用所选文字模型；历史驱动配置不影响这条路径。
      const s = computerUseSettings(), op = s.operator, model = operatorModelLabel(op);
      const pw = installed('playwright-core');
      // 浏览器归引擎，本机工具开关不影响它。
      return { status: pw ? 'ok' : 'warn', summary: `引擎浏览器：专用 Chrome · 电脑操作：${cu.enabled ? '开' : '关'}${pw ? '' : ' · 内置浏览器没装好'}`, detail: ['所有自动填表停在提交前，给你终审后才提交。', `内置操作员：${model || '跟随所选文字模型'}。`], fix: null, go: '#settings/advanced?hl=browser' };
    }),
    step('schedule', '定时运行', '每天自动扫岗位、判断、跟进的时间。', () => {
      // 定时在工作台进程里跑（lib/app-schedule.mjs），不看 launchd（命令行版 10-04 冻结）。本机 AI 默认关着（设置 → 高级，lib/capabilities.mjs）。
      // 可选本机工具的状态单独返回，不改变定时业务能否运行。
      const l = desktopExec(), x = { ...l, ...localAiStatus({ gate: l }) };
      {
        const jobs = appSchedule(), at = name => jobs.find(j => j.name === name)?.times.join(' / ');
        const times = { cycle: at('cycle'), brief: at('brief') || null };
        return { status: 'ok', app: true, times, executor: { on: x.on, ready: x.ready, why: x.why }, summary: `App 开着时每天 ${times.cycle} 跑一轮${times.brief ? `，${times.brief} 发战报` : ''} · 查信要等邮箱接好`, detail: [], fix: null };
      }
    }),
    step('policy', '外发与投递规则', '哪些事要你点头，系统才对外做。', () => {
      const p = read('config/concierge.json', {}).auto_apply_policy || {};
      return { status: 'ok', summary: `发邮件 / 私信：你确认后才发 · 投递：批准后先填好给你终审，确认才提交 · 夜里 21:00–09:00 不提醒、不看各平台的消息；你批准了的照常发`, detail: [], fix: null };
    }),
  ];
  const done = steps.filter(s => s.status === 'ok').length;
  // 引导走到哪了（lib/onboarding-state.mjs）：first_run 为真时工作台一打开就进引导；老用户（有 facts.yaml）从不强制。
  const onboarding = onboardingState();
  // 用哪个浏览器、装没装 ego / Chrome（设置 → 账号与连接 的「浏览器」一行）。
  // 设置页的诊断数据独立于「开始使用」的步骤；不把运行记录和 CLI 列表塞进定时步骤。
  return { steps, done, total: steps.length, onboarding, version: VERSION, local_ai: localAiStatus(), browser: { engine: browserEngine(), chrome: !!findChrome() } };
}
