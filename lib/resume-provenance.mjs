// 简历助手 · 出处核对（2026-09-29）：「只改写，不编造」由这里的代码强制，不靠提示词。
//
// 模型给出的每一条改写，改后的那一行要拆开逐段核对，任何一段找不到出处，整条拒绝，理由摆给你看：
//   数字      每个数字（30%、1.2k、10 万、3 倍、两个、three、年份……）都要在「本段证据」里出现过，数值一致；
//             原句里的数字也不能被删掉。
//   名词技能  英文技术词、工具名、专有名词、中文句子里的英文词，都要在本段证据里出现过（k8s = Kubernetes 这类别名认）。
//   担当      「主导、牵头、带领、独立、从 0 到 1、管理团队、led、owned……」本段证据里要有同一个意思的词；
//             原句有「参与、协助、helped、assisted……」，改后也必须有，不许悄悄去掉。
//   成果      「转化率、营收、成本、延迟、用户数、revenue、latency……」要在本段证据里出现过。
//   其余的话  要么是证据里的原话（中文按最长匹配，英文按词干），要么是同义词表里的普通说法（写了 → 开发，
//             helped → assisted），要么是连接用的虚词；中文里四个字以上的原话只在别的经历里出现，算「挪用」。
// 「本段证据」= 这一行所在那段经历的原文 + facts.yaml 里对上这段的条目 + 你对这段的回答；简介、技能用全文。
// 证据从哪来、怎么分本段和全文，见 lib/resume-doc.mjs 的 poolsFor。这里是纯函数，不读文件、不调模型。
// 宁可错拦，不可放过：被拦下的会列出原因，你也可以自己改一下再接受（你写的字是你自己的话）。

import { normalizeCjkCompat } from './resume-text.mjs';

const NFKC = s => String(s ?? '').normalize('NFKC');
// 看不见的字符（零宽空格、方向控制符、软连字符……）去掉；数学粗体、全角的字母和数字换成普通写法（𝟭𝟮 → 12，ＡＷＳ → AWS）。
// Writer 写的每一行先过这一道再核对、再存：核对的和存下的是同一串字。
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// 兼容汉字（「⼤」）也换成标准汉字（lib/resume-text.mjs）；证据那边的旧数据在比对时由 NFKC 折叠，不改盘上的内容。
export const plainChars = s => normalizeCjkCompat(s).replace(INVISIBLE, '').replace(/[\u{1D400}-\u{1D7FF}\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/gu, c => c.normalize('NFKC'));
// 过了上面那一道还剩下的「长得像字母数字」的字：别的文字里的数字（١٢）、上标、圈码，拉丁、中日韩以外的字母（西里尔字母的 а）。
const ODD_CHAR = c => (/\p{N}/u.test(c) && !/[0-9]/.test(c) && !/\p{Script=Han}/u.test(c)) || (/\p{L}/u.test(c) && !/[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u.test(c));
// 逐字规范化、长度不变（全角数字和字母变半角，其余原样）：核对用它，位置和原文一一对应，片段拼回去还是原文。
const norm1 = s => { let out = ''; for (const c of String(s ?? '')) { const n = c.normalize('NFKC'); out += n.length === c.length ? n : c; } return out; };
const low = s => NFKC(s).toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-');
const isCjk = c => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const cjkShare = s => { const c = (String(s).match(/[\u3400-\u9fff]/g) || []).length, a = (String(s).match(/[A-Za-z]/g) || []).length; return c * 2 > a; };

// ── 数字 ─────────────────────────────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const SCALE = { k: 1e3, thousand: 1e3, '千': 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, w: 1e4, '万': 1e4, '亿': 1e8, '百': 100 };
const WORD_NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, hundreds: 100, thousand: 1e3, thousands: 1e3, million: 1e6, millions: 1e6, billion: 1e9, billions: 1e9, dozen: 12, dozens: 12 };
const WORD_MULT = { double: '2x', doubled: '2x', twice: '2x', triple: '3x', tripled: '3x', quadrupled: '4x', half: '50%', halved: '50%' };
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_MEASURE = '个位名人年月周天日次倍项款家条套台篇门种类份场期轮级版余多几部支只批张届座间处';
const cnValue = s => { let total = 0, section = 0, num = 0; for (const ch of s) { if (ch in CN_DIGIT) num = CN_DIGIT[ch]; else if (ch === '十' || ch === '百' || ch === '千') { section += (num || 1) * { 十: 10, 百: 100, 千: 1000 }[ch]; num = 0; } else if (ch === '万' || ch === '亿') { total += (section + num) * (ch === '万' ? 1e4 : 1e8); section = 0; num = 0; } } return total + section + num; };
const fmt = v => String(Math.round(v * 1e6) / 1e6);
// 文字里的所有数字：{ raw, key, start, end }。key 是比较用的规范写法（1,200 = 1.2k = 1200；10 万 = 100000；3 倍 = 3x）。
const NUM_RE = new RegExp([
  '(?<date>(?:19|20)\\d{2}\\s*[./\\-年]\\s*\\d{1,2}(?:\\s*月)?(?!\\d))',
  `(?<mdate>\\b(?:${Object.keys(MONTHS).join('|')})[a-z]*\\.?\\s+(?:19|20)\\d{2}\\b)`,
  '(?<num>(?<![A-Za-z0-9.])(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:\\s*(?<unit>%|％|percent\\b|pct\\b|(?:k|m|mm|mn|bn|b|w)(?![A-Za-z])|thousand\\b|million\\b|billion\\b|万|亿|千|百|x(?![A-Za-z])|倍))?)',
  `(?<cn>第?[零〇一二两三四五六七八九十百千万亿]+(?=[${CN_MEASURE}]))`,
  // 后面没有量词、但带着十百千万亿的：三百万用户、两千条、十万级（千万、万一这类不是数，不认）。
  '(?<cnbig>[一二两三四五六七八九十][零〇一二两三四五六七八九十百千万亿]*[十百千万亿][零〇一二两三四五六七八九十百千万亿]*)',
  `(?<word>\\b(?:${[...Object.keys(WORD_NUM), ...Object.keys(WORD_MULT)].join('|')})\\b)`,
].join('|'), 'gi');
export function numbersIn(text) {
  const s = norm1(text), out = [];
  for (const m of s.matchAll(NUM_RE)) {
    const g = m.groups, raw = m[0], at = { raw, start: m.index, end: m.index + raw.length };
    if (g.date) { const [, y, mo] = raw.match(/((?:19|20)\d{2})\D+(\d{1,2})/); out.push({ ...at, key: `d:${y}-${mo.padStart(2, '0')}` }); }
    else if (g.mdate) { const mo = MONTHS[raw.slice(0, 3).toLowerCase()] || MONTHS[raw.slice(0, 4).toLowerCase()], y = raw.match(/(?:19|20)\d{2}/)[0]; out.push({ ...at, key: `d:${y}-${String(mo).padStart(2, '0')}` }); }
    else if (g.num) {
      const unit = (g.unit || '').toLowerCase().replace('％', '%'), digits = raw.slice(0, raw.length - (g.unit || '').length).replace(/[,\s]/g, '');
      let v = Number(digits), u = '';
      if (unit === '%' || unit === 'percent' || unit === 'pct') u = '%'; else if (unit === 'x' || unit === '倍') u = 'x'; else if (SCALE[unit]) v *= SCALE[unit];
      if (Number.isFinite(v)) out.push({ ...at, key: `n:${fmt(v)}${u}` });
    } else if (g.cnbig) out.push({ ...at, key: `n:${fmt(cnValue(raw))}` });
    else if (g.cn) {
      const ord = raw.startsWith('第'), body = ord ? raw.slice(1) : raw;
      if (!ord && body === '一') continue; // 一个、一套：是量词，不是数
      out.push({ ...at, key: `${ord ? 'o' : 'n'}:${fmt(cnValue(body))}` });
    } else if (g.word) { const w = raw.toLowerCase(); out.push({ ...at, key: WORD_MULT[w] ? `n:${WORD_MULT[w].replace(/x$|%$/, '')}${WORD_MULT[w].endsWith('%') ? '%' : 'x'}` : `n:${fmt(WORD_NUM[w])}` }); }
  }
  return out;
}

// 数字后面跟的是什么：时间（ms、小时）、大小（GB）、别的词、什么都没有。「800 ms 到 200 ms」写成「800 到 200 ms」，800 跟着后面那个数的单位。
const TIME_U = /^(?:ms|msec|millis|milliseconds?|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|yrs?|years?)$/i, SIZE_U = /^(?:kb|mb|gb|tb|pb|bytes?)$/i;
const ZH_UNIT = [['毫秒', 'time'], ['秒', 'time'], ['分钟', 'time'], ['小时', 'time'], ['天', 'time'], ['周', 'time'], ['个月', 'time'], ['年', 'time']];
function unitAfter(s, end, hop = 0) {
  const t = String(s).slice(end).replace(/^\s+/, '');
  const link = hop ? null : t.match(/^(?:to|and|or|-|–|—|~|～|→|->|\/|至|到)\s*/i);
  if (link) { const n = numbersIn(t.slice(link[0].length))[0]; if (n && n.start === 0) return unitAfter(t, link[0].length + n.end, 1); }
  const w = t.match(/^[a-z]+/i)?.[0];
  if (w) return TIME_U.test(w) ? 'time' : SIZE_U.test(w) ? 'size' : 'other';
  const zh = ZH_UNIT.find(([u]) => t.startsWith(u));
  if (zh) return zh[1];
  return /^[\u3400-\u9fff]/.test(t) ? 'other' : 'none';
}

// ── 名词、技能 ────────────────────────────────────────────────────────────────
const TERMS = new Set(`python java javascript typescript rust ruby php swift kotlin scala perl matlab sql mysql postgresql postgres sqlite mongodb redis kafka rabbitmq elasticsearch spark hadoop hive flink airflow dbt snowflake bigquery redshift docker kubernetes k8s terraform ansible jenkins git github gitlab linux unix aws azure gcp react vue angular svelte nextjs django flask fastapi spring rails laravel graphql grpc tensorflow pytorch keras sklearn scikit-learn pandas numpy scipy matplotlib jupyter excel vba powerpoint outlook tableau powerbi looker figma sketch photoshop illustrator salesforce hubspot sap oracle bloomberg factset capiq refinitiv stata eviews spss sas quickbooks xero jira confluence notion asana llm llms rag langchain openai gpt bert cuda opencv unity webpack vite html css sass tailwind jquery redux ios android macos windows cfa cpa frm acca pmp gmat gre toefl ielts seo sem crm erp etl api apis sdk cli saas b2b b2c kpi okr roi dcf lbo ipo`.split(/\s+/));
const ALIAS = { k8s: 'kubernetes', js: 'javascript', ts: 'typescript', postgres: 'postgresql', golang: 'go', py: 'python', nodejs: 'node.js', 'scikit-learn': 'sklearn', llms: 'llm', apis: 'api', 'powerbi': 'power bi' };
// 英文缩写在中文证据里的说法：英文简历的一行可以引用中文资料里写的同一件事。
const ZH_ALIAS = { api: ['接口'], llm: ['大模型', '大语言模型'], ml: ['机器学习'], ai: ['人工智能'], crm: ['客户关系管理'], seo: ['搜索引擎优化'], ui: ['界面'], ux: ['用户体验'], qa: ['测试'], kpi: ['指标'], roi: ['投资回报'], dcf: ['现金流折现'], ipo: ['上市'], 'm&a': ['并购'], vc: ['风险投资', '风投'], pe: ['私募'] };
const WORD_RE = /[A-Za-z][A-Za-z0-9]*(?:[.+#/&'’-][A-Za-z0-9+#]+)*[+#]*/g;
// 这个英文词是不是「名字 / 技能」：中文句子里的英文词都算；英文句子里看大小写、数字符号和技能词表。
const isTerm = (tok, { cjkLine, sentenceStart }) => {
  if (/^I(?:['’](?:m|ve|d|ll))?$/.test(tok)) return false; // 英文的「我」
  if (cjkLine) return true;
  if (/\d/.test(tok) || /[+#]/.test(tok) || /\.[a-z]/i.test(tok)) return true;
  if ((tok.match(/[A-Z]/g) || []).length >= 2) return true;
  if (TERMS.has(tok.toLowerCase())) return true;
  return /^[A-Z]/.test(tok) && !sentenceStart && !KNOWN_WORDS.has(tok.toLowerCase());
};
const termForms = t => { const x = low(t).replace(/['’]s$/, ''); const forms = new Set([x, ALIAS[x] || x]); if (/[^s]s$/.test(x)) forms.add(x.slice(0, -1)); for (const f of [...forms]) if (ALIAS[f]) forms.add(ALIAS[f]); return [...forms]; };

// ── 担当、谦辞、成果（中英对照的概念表） ─────────────────────────────────────────
// en 按整词 / 词组匹配（小写），zh 按包含匹配；re 是需要上下文才算数的写法（「管理 6 人」而不是「项目管理系统」）。
const STRONG = [
  { key: 'lead', en: ['led', 'lead', 'leads', 'leading', 'headed', 'spearheaded', 'spearhead', 'drove', 'directed', 'head of'], zh: ['主导', '牵头', '带领', '带队', '领导', '领衔', '负责人', '主持'] },
  { key: 'own', en: ['owned', 'owner', 'ownership', 'took ownership'], zh: ['全权负责', '总负责', '全面负责', '一手'] },
  { key: 'solo', en: ['independently', 'independent', 'single-handedly', 'solely', 'sole', 'on my own', 'by myself'], zh: ['独立', '独自', '独力', '一人', '单独'] },
  { key: 'scratch', en: ['from scratch', '0 to 1', '0-to-1', 'zero to one', 'ground up', 'from the ground up'], zh: ['从0到1', '从零到一', '从零', '从头'] },
  { key: 'manage', en: ['supervised', 'oversaw', 'mentored', 'coached', 'hired', 'manager'], zh: ['带教', '指导新人', '管理团队', '团队管理', '培养'], re: [/\bmanag(?:ed|ing|e)\s+(?:a\s+)?(?:team|\d+\s+\w+)/, /管理\s*\d+\s*(?:人|名)|带\s*\d+\s*(?:人|名)/] },
  { key: 'found', en: ['founded', 'co-founded', 'founder', 'co-founder'], zh: ['创立', '创办', '创始'] },
  { key: 'architect', en: ['architected', 'architect'], zh: ['架构设计', '架构师', '总体设计'] },
  { key: 'end2end', en: ['end-to-end', 'end to end'], zh: ['端到端', '全流程', '全链路'] },
];
const HEDGE = [{ key: 'hedge', en: ['assisted', 'assist', 'assisting', 'helped', 'help', 'helping', 'supported', 'participated', 'participate', 'participating', 'contributed', 'contribute', 'contributing', 'involved in', 'worked on', 'part of', 'member of'], zh: ['参与', '协助', '辅助', '配合', '参加', '帮助', '协同', '跟随'] }];
const CLAIMS = [
  { key: 'revenue', en: ['revenue', 'revenues', 'sales', 'gmv', 'income', 'profit', 'profits', 'profitability', 'margin', 'margins'], zh: ['营收', '收入', '营业额', '销售额', '利润', '毛利', '盈利'] },
  { key: 'cost', en: ['cost', 'costs', 'spend', 'spending', 'expense', 'expenses', 'budget'], zh: ['成本', '费用', '开支', '预算'] },
  { key: 'latency', en: ['latency', 'response time', 'load time', 'faster', 'speed', 'speedup'], zh: ['延迟', '时延', '响应时间', '加载时间', '速度'] },
  { key: 'throughput', en: ['throughput', 'qps', 'tps', 'concurrency', 'scalability', 'scalable', 'high-traffic', 'at scale'], zh: ['吞吐', '并发', '高并发', '扩展性'] },
  { key: 'users', en: ['users', 'customers', 'clients', 'subscribers', 'dau', 'mau', 'audience'], zh: ['用户', '客户', '会员', '日活', '月活', '粉丝'] },
  { key: 'conversion', en: ['conversion', 'conversions', 'conversion rate', 'ctr', 'click-through'], zh: ['转化', '点击率'] },
  { key: 'retention', en: ['retention', 'churn', 'engagement'], zh: ['留存', '流失', '活跃度', '粘性'] },
  { key: 'accuracy', en: ['accuracy', 'precision', 'recall', 'error rate', 'defects'], zh: ['准确率', '精度', '召回', '错误率', '缺陷'] },
  { key: 'reliability', en: ['uptime', 'availability', 'reliability', 'stability', 'downtime', 'incidents'], zh: ['可用性', '稳定性', '故障率', '宕机', '事故'] },
  { key: 'efficiency', en: ['efficiency', 'productivity', 'manual work', 'time savings'], zh: ['效率', '人效', '工时', '人力'] },
  { key: 'growth', en: ['growth', 'market share', 'roi', 'returns', 'aum', 'yield'], zh: ['增长', '市场份额', '回报', '收益', '管理规模', '收益率'] },
  { key: 'quality', en: ['satisfaction', 'nps', 'ratings', 'quality'], zh: ['满意度', '好评', '评分', '质量'] },
];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tableRe = new Map();
const hitsOf = (text, table) => {
  const t = low(text), out = new Map();
  for (const c of table) {
    let re = tableRe.get(c);
    if (!re) { re = new RegExp(`(?<![a-z0-9])(?:${c.en.map(escRe).join('|')})(?![a-z0-9])`, 'i'); tableRe.set(c, re); }
    const m = t.match(re) || c.zh.map(w => t.includes(w) ? [w] : null).find(Boolean) || (c.re || []).map(r => t.match(r)).find(Boolean);
    if (m) out.set(c.key, m[0]);
  }
  return out;
};

// 这句话里的谦辞（helped、参与……），没有就是 null。
export const hedgeIn = text => { const m = hitsOf(text, HEDGE); return m.size ? [...m.values()][0] : null; };

// ── 普通说法：同义词组、虚词 ────────────────────────────────────────────────────
// 同一组里互相替换不改变事实（写了 → 开发，cut → reduced）。「系统 / 平台 / 工具」各自一组、不互通：换了就是换了规模。
const SYN = [
  'build built building develop developed developing implement implemented create created write wrote written code coded program programmed construct constructed make made 开发 研发 编写 实现 搭建 构建 写 做 制作 建立 建设',
  'improve improved improving optimize optimized optimise optimised optimizing enhance enhanced refine refined upgrade upgraded 优化 改进 提升 提高 改善 完善 增强',
  'reduce reduced reducing cut cutting decrease decreased lower lowered drop dropped fall fell shorten shortened save saved minimize minimized 降低 减少 缩短 节省 节约 压缩 减轻 削减',
  'increase increased raise raised grow grew boost boosted expand expanded 增加 增长 扩大 扩展',
  'analyze analyzed analyse analysed analyzing analysis examine examined evaluate evaluated assess assessed study studied research researched investigate investigated 分析 研究 评估 调研 研判',
  'design designed designing plan planned 设计 规划',
  'maintain maintained maintaining operate operated run ran 维护 运维 运营 保障',
  'test tested testing validate validated verify verified 测试 验证 校验 检验',
  'deploy deployed release released launch launched ship shipped deliver delivered 上线 发布 部署 交付 推出 落地',
  'automate automated automating automation script scripts scripted 自动化 脚本',
  'integrate integrated integrating integration connect connected 整合 集成 接入 对接 打通',
  'migrate migrated migrating migration port ported move moved 迁移 切换',
  'document documented documentation 文档 撰写',
  'present presented presenting report reported 汇报 展示 呈现 演示',
  'model modeled modelled modeling modelling forecast forecasted forecasting 建模 预测 测算',
  'prepare prepared preparing draft drafted compile compiled assemble assembled 准备 整理 汇总 编制 起草',
  'collaborate collaborated collaborating partner partnered coordinate coordinated 协作 合作 协调 沟通',
  'use used using utilize utilized leverage leveraged leveraging employ employed apply applied adopt adopted 使用 利用 采用 借助 基于 运用 应用',
  'team teams colleagues teammates 同事 团队 小组 大家',
  'help helped helping assist assisted assisting support supported 协助 帮助 辅助 支持 配合',
  'participate participated contribute contributed involved 参与 参加 贡献',
  'responsible responsibility 负责 承担 担任',
  'process processed processing handle handled handling 处理 应对',
  'monitor monitored monitoring track tracked tracking 跟踪 监控 追踪 监测',
  'fix fixed fixing resolve resolved debug debugged troubleshoot troubleshot 修复 解决 排查 定位',
  'review reviewed audit audited 审核 评审 审查 复核',
  'clean cleaned cleaning cleanse cleansed 清洗 清理',
  'internal in-house 内部',
  'tool tools tooling 工具', 'service services 服务', 'system systems 系统', 'platform platforms 平台', 'pipeline pipelines 流水线 管道',
  'feature features function functionality 功能 特性', 'data 数据', 'report reports reporting 报表 报告', 'page pages 页面',
  'customer customers client clients 客户', 'user users 用户', 'daily everyday 每天 每日 日常', 'weekly 每周 周报', 'monthly 每月 月报',
].map(g => g.split(/\s+/));
// 这些是有事实含义的双语说法，不是免核对的填充词；必须在本段证据里有对应概念。
const LOCAL_SYN = [
  // 重构可写成重新组织，但必须来自本段；organization 这个名词本身不证明做过重构。
  'refactor refactored rewrite rewrote restructure restructured reorganize reorganized reorganizing reorganise reorganised reorganising 重构 重写',
  'communication communications 通信 通讯', 'download downloads downloading 下载',
  'chat 聊天', 'progress 进度', 'history 历史', 'algorithm algorithms 算法',
  'produce produced producing output 输出 生成', 'retrieve retrieved retrieval 检索',
  'image images 图片 图像', 'content media 内容 媒体',
  'standardize standardized standardise standardised unify unified 统一 标准化',
  'teacher teachers 教师 老师', 'material materials 资料 课件', 'result results 结果',
  'submit submitted submission submissions 提交', 'environment environments 环境',
  'define defined defining 明确 定义', 'recover recovered recovery 恢复', 'resource resources 资源',
  'session sessions conversation conversations 会话', 'scene scenes 场景', 'entity entities 实体', 'detail details 详情',
  'address addressed addressing 处理', 'stability 稳定性',
  'station stations 地面站', 'orbit orbits orbital 轨道', 'link links 链路',
  'cell cells 小区', 'beam beams 波束', 'display displays 显示 展示', 'timeline timelines 时间轴',
  'personal 个人', 'project projects 项目', 'application applications 应用',
  'interface interfaces 界面 接口', 'stream streaming 流式', 'response responses 响应',
  'file files 文件 资料', 'upload uploads 上传', 'reference references 引用',
  'workbench workbenches 工作台', 'component components 组件', 'state states 状态',
  'management 管理', 'interaction interactions 交互', 'error errors 异常 错误', 'feedback 反馈',
  'student students 学生', 'course courses 课程 课件', 'structure structures 结构',
  'transition transitions 流转', 'test tested testing 联调', 'ground 地面 地面站',
  'playback 回放', 'switch switching 切换', 'synchronize synchronization 同步',
  'render rendering 渲染', 'independent independently 独立',
  'split divided divide dividing 拆分 分拆 划分',
].map(g => g.split(/\s+/));
// 不带事实的常见说法（封闭的一张表，10-01 真模型试跑后加）：改写时换个说法很常见，找不到原话也不算编。
// 只放不说「做了什么、做成了什么、用了什么」的词：数字、技术名词、公司、担当（主导、led、owned）、成果（提升、revenue……）
// 另有各自的核对，不因为这张表放行。end-to-end / 端到端 说的是「整件事都是你做的」，算担当，不在这里。要加词就加在这里，别的地方不要再开口子。
export const PLAIN_EN = 'focus focused focuses focusing select selected selecting selection selections constrain constrained constraining constraint constraints emphasis approach approaches aspect aspects area areas ensure ensures ensured ensuring keep keeps keeping kept clear clearly consistent consistently primarily mainly mostly around toward towards along approximately solution'.split(' ');
export const PLAIN_ZH = ['专注', '聚焦', '侧重', '着重', '挑选', '选取', '筛选', '约束', '限制在', '围绕', '负责', '确保', '保持', '主要', '方面', '方向', '面向'];
const STOP = new Set('a an the and or but nor of to in on at by for with from into onto over under via through across within without as per than then that which who whom whose this these those it its their them they our we my me i his her both each all any such while when where so also well including include includes up out off about around after before during between among other its into'.split(' '));
const NEUTRAL = new Set([...'work works worked working various related relevant key main core new existing different specific overall time'.split(' '), ...PLAIN_EN]);
// 中文虚词和连接词：只起连接作用，不带事实。
const NEUTRAL_ZH = [...new Set([...PLAIN_ZH, '并且', '以及', '同时', '从而', '进而', '以便', '用于', '用来', '进行', '相关', '包括', '包含', '其中', '等等', '对于', '针对', '围绕', '为了', '使得', '一个', '一套', '一次', '一项', '一批', '各类', '各种', '整个', '主要', '日常', '实际', '具体', '完成', '通过', '负责', '时间', '耗时'])].sort((a, b) => b.length - a.length);
const FUNC_ZH = new Set('的了和与及并在对为把被将等个项次中上下后前内里之地得着过其此该各由从向到至以于而且或也都还又再就才所是有做用给让使帮'.split(''));
// 英文的同一个词：一样、差个复数 s，或者共同前缀够长（implemented = implementation，automated = automation，
// optimize = optimization）；短词（use / user）只认一样。比去词尾的办法稳。
export const stem = w => low(w).replace(/['’]s$/, '').replace(/^indices$/, 'index').replace(/(?<=[^s])s$/, '');
const prefix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
// 词根：再去掉 -ing / -ed（-eed 结尾的 need、speed 不去）、双写的辅音和词尾的 e：keeping = keeps，using = use，used = use，planned = plan。
const root = w => { let s = stem(w), cut = false; if (/ing$/.test(s) && s.length >= 5) { s = s.slice(0, -3); cut = true; } else if (/ed$/.test(s) && !/eed$/.test(s) && s.length >= 4) { s = s.slice(0, -2); cut = true; } if (cut && /([b-df-hjkmnp-rtv-z])\1$/.test(s)) s = s.slice(0, -1); return s.replace(/e$/, ''); };
export const sameWord = (a, b) => { a = stem(a); b = stem(b); if (a === b || root(a) === root(b)) return true; const n = prefix(a, b); return n >= 5 && n >= Math.ceil(0.75 * Math.min(a.length, b.length)); };
// 说成果的动词（提升、降低、增长、improved、reduced……）只认本段证据：别的经历里「优化过」不等于这一段也优化过。
const CLAIMY = SYN.slice(1, 4);
const claimyWord = w => CLAIMY.some(g => /[a-z]/i.test(w) ? g.some(m => /[a-z]/.test(m) && sameWord(m, w)) : g.includes(w));
const CLAIMY_ZH = [...new Set(CLAIMY.flat().filter(w => !/[a-z]/.test(w)))];
const localWord = w => claimyWord(w) || LOCAL_SYN.some(g => /[a-z]/i.test(w) ? g.some(m => /[a-z]/.test(m) && sameWord(m, w)) : g.includes(w));
const LOCAL_ZH = [...new Set([...CLAIMY_ZH, ...LOCAL_SYN.flat().filter(w => !/[a-z]/.test(w))])];
const ALL_SYN = [...SYN, ...LOCAL_SYN];
const synOf = w => /[a-z]/i.test(w) ? ALL_SYN.filter(g => g.some(m => /[a-z]/.test(m) && sameWord(m, w))) : ALL_SYN.filter(g => g.includes(w));
const ZH_SYN = [...new Set(ALL_SYN.flat().filter(w => !/[a-z]/.test(w)))].sort((a, b) => b.length - a.length);
// 编辑距离，相邻两个字母对调算一步（Pyhton → Python）：只给「原文里拼错的技能名」用。
const osa = (a, b) => { if (Math.abs(a.length - b.length) > 1) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) { d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); } return d[a.length][b.length]; };
// 这张表里认识的普通英文词：不会是拼错的技能名（scale 不是 Scala 的错别字，rest 不是 Rust）。
const KNOWN_WORDS = new Set([...STOP, ...NEUTRAL, ...ALL_SYN.flat(), ...[STRONG, HEDGE, CLAIMS].flat().flatMap(c => c.en.flatMap(w => w.split(/[\s-]+/))), ...Object.keys(WORD_NUM), ...Object.keys(WORD_MULT)].filter(w => /^[a-z]+$/.test(w)));
const lev = (a, b) => { if (Math.abs(a.length - b.length) > 2) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };

// 实词序列（英文）：去掉虚词和不带事实的普通说法，同义词组里的词算同一个（wrote = developed）。
const canonCache = new Map();
const canon = w => { let c = canonCache.get(w); if (c == null) { const g = ALL_SYN.findIndex(gr => gr.some(m => /[a-z]/.test(m) && sameWord(m, w))); c = g >= 0 ? `${g < SYN.length ? '#' : '@'}${g}` : root(w); if (canonCache.size < 20000) canonCache.set(w, c); } return c; };
const contentSeq = t => { const out = []; for (const m of String(t).matchAll(WORD_RE)) { let offset = 0; for (const part of m[0].split('/')) { const w = low(part), start = m.index + offset; offset += part.length + 1; if (STOP.has(w) || NEUTRAL.has(w)) continue; out.push({ k: canon(w), start, end: start + part.length }); } } return out; };
const trigrams = texts => { const set = new Set(); for (const t of texts) { const q = contentSeq(t); for (let i = 0; i + 2 < q.length; i++) set.add(`${q[i].k} ${q[i + 1].k} ${q[i + 2].k}`); } return set; };
// 一句话的「内容单位」：英文实词（同义词算一个）、数字、中文的两字组。用来看一行是从哪几行来的（合并、挪用）。
export function unitsOf(text) {
  const t = NFKC(text), u = new Set();
  for (const x of contentSeq(t)) u.add(x.k);
  for (const n of numbersIn(t)) u.add(n.key);
  for (const r of t.replace(/[^\u3400-\u9fff]/g, ' ').split(/\s+/)) for (let k = 0; k + 1 < r.length; k++) u.add(r.slice(k, k + 2));
  return u;
}
// source 这一行有多少内容出现在 text 里：{ shared, of }。distinct：只数有区分度的（不数同义词表里的普通动词、名词：built、service、team）。
export function overlap(text, source, { distinct = false } = {}) { const a = unitsOf(text), b = [...unitsOf(source)].filter(x => !distinct || !x.startsWith('#')); let shared = 0; for (const x of b) if (a.has(x)) shared++; return { shared, of: b.length }; }

// ── 证据的索引（一次核对建一次） ──────────────────────────────────────────────────
function indexPool(items) {
  const texts = items.map(x => ({ ref: x.ref, t: low(x.text), nonum: !!x.nonum }));
  const words = new Map(), terms = new Map(), nums = new Map(), units = new Map(), termish = new Set();
  // 证据里写成名字样子的词（句中大写、带数字符号、列在「Languages: …, …」里）：只有它们拼错了，才能按「改错别字」换成技能表里的写法。
  for (const x of items) {
    const t = NFKC(x.text), cjkLine = cjkShare(t);
    for (const m of t.matchAll(WORD_RE)) {
      const tok = m[0], before = t.slice(0, m.index).replace(/\s+$/, ''), after = t.slice(m.index + tok.length).replace(/^\s+/, '');
      if (tok.length < 4 || /^[A-Z]+$/.test(tok)) continue; // 全大写的缩写（REST、KEY）不当拼错的词
      const listed = /^[A-Z]/.test(tok) && (/[,，、:：]$/.test(before) || /^[,，、]/.test(after));
      if (listed || isTerm(tok, { cjkLine, sentenceStart: !before || /[.!?;:•·|(（—–-]$/.test(before) })) termish.add(low(tok));
    }
  }
  for (const x of texts) {
    for (const m of x.t.matchAll(WORD_RE)) { const w = m[0]; for (const part of [w, ...w.split(/[-/]/)]) if (part && !words.has(stem(part))) words.set(stem(part), x.ref); for (const part of [w, ...w.split('/')]) for (const f of termForms(part)) if (!terms.has(f)) terms.set(f, x.ref); }
    if (!x.nonum) for (const n of numbersIn(x.t)) { if (!nums.has(n.key)) nums.set(n.key, x.ref); if (!units.has(n.key)) units.set(n.key, new Set()); units.get(n.key).add(unitAfter(x.t, n.end)); }
  }
  const all = texts.map(x => x.t).join(' ¶ ');
  let grams = null;
  return {
    get grams() { return grams ||= trigrams(texts.map(x => x.t)); }, items: texts, all, words, terms, nums, units, termish, strong: hitsOf(all, STRONG), claims: hitsOf(all, CLAIMS), refOf: s => texts.find(x => x.t.includes(s))?.ref || null };
}
// 整词出现（前后不是字母数字）：「ai」不能从 training 里找出来。
const bounded = (all, f) => new RegExp(`(?<![a-z0-9])${escRe(f)}(?![a-z0-9])`).test(all);
const hasTerm = (pool, t) => termForms(t).some(f => pool.terms.has(f) || (f.length >= 3 && /[.+#/-]/.test(f) && bounded(pool.all, f))) || (t.includes('/') && t.split('/').every(part => hasTerm(pool, part))) || (ZH_ALIAS[low(t)] || []).some(z => /[a-z]/.test(z) ? bounded(pool.all, z) : pool.all.includes(z));
const wordIn = (pool, w) => { const k = stem(w); if (pool.words.has(k)) return pool.words.get(k); for (const [p, ref] of pool.words) if (sameWord(p, k)) return ref; return null; };
const groupIn = (pool, w) => synOf(w).flat().find(m => /[a-z]/.test(m) ? wordIn(pool, m) : pool.all.includes(m)) || null;
const PHRASE_EQUIVALENTS = [
  { after: /\bpassive traffic capture\b/gi, source: /\bby-?pass sniffing\b/i },
  { after: /\bTTL values\b/g, source: /\bttl fields\b/i },
  { after: /\breusable components\b/gi, source: /组件封装|可复用组件|\breusable components\b/i },
  { after: /\bturn(?= [^.!?;]{1,100}\binto\b)/gi, source: /\b(?:processing|routing)\b[^.!?;]{1,100}\binto\b/i },
];
// 只认同一指标、相同起止数的方向：CPU idle improved from 30% to 60% 可以说 increased，不能把 improved 泛化成增加。
function increasedFromRange(text, at, pool) {
  const range = /\b([a-z][a-z -]{0,50}?)\s+(improved|increased)\s+from\s+(\d[\d,.]*%?)\s+to\s+(\d[\d,.]*%?)/gi;
  const wanted = [...text.matchAll(range)].find(m => m.index + m[1].length + 1 === at && m[2].toLowerCase() === 'increased');
  if (!wanted) return null;
  const key = s => numbersIn(s)[0]?.key, from = key(wanted[3]), to = key(wanted[4]);
  if (!from || !to || !(Number(from.replace(/^n:|%$/g, '')) < Number(to.replace(/^n:|%$/g, '')))) return null;
  return pool.items.find(x => [...x.t.matchAll(range)].some(m => low(m[1]).trim() === low(wanted[1]).trim() && key(m[3]) === from && key(m[4]) === to))?.ref || null;
}

// ── 核对一行 ─────────────────────────────────────────────────────────────────
// 一句话里的「名字 / 技能」（原句被删掉了哪些，给页面提示用）。
export function termsIn(text) {
  const t = NFKC(text), cjkLine = cjkShare(t), out = [];
  for (const m of t.matchAll(WORD_RE)) { const before = t.slice(0, m.index).replace(/\s+$/, ''); if (isTerm(m[0], { cjkLine, sentenceStart: !before || /[.!?;:•·|(（—–-]$/.test(before) })) out.push(m[0]); }
  return [...new Set(out)];
}
// after：改后的一行；original：原简历里这一行（新加的行没有）；local / global：证据 [{ref, text}]；
// allow：代码自己给的错别字修正 [{from, to}]，to 算出处。
// 返回 { ok, problems: [{kind, text, message}], spans: [{t, k: src|syn|fill|fix|new, ref?, was?}], dropped, refs }。
// mode：line（简历的一行，默认，最严）；letter（求职信 / 自我介绍里说「我」的句子：客套话不查，数字、名字技能、担当、成果照查）；
// company（说公司、岗位的句子：只查数字、名字、成果，出处是公司调研和岗位描述）。
export function verifyLine({ after, original = null, local = [], global = [], allow = [], mode = 'line' } = {}) {
  const prose = mode !== 'line';
  const text = plainChars(after).replace(/\s+/g, ' ').trim(), nt = norm1(text), problems = [], refs = new Set();
  const say = (kind, t, message) => { if (!problems.some(p => p.kind === kind && p.text === t)) problems.push({ kind, text: t, message }); };
  if (!text) return { ok: false, problems: [{ kind: 'empty', text: '', message: '改后是空的' }], spans: [], dropped: [], refs: [] };
  const L = indexPool(local), G = indexPool(global.length ? global : local), O = original == null ? null : NFKC(original);
  // 原句自己：出处和同义词都先对到原句里的词（Developed ← wrote），再看本段、全文。
  const P = O == null ? null : indexPool([{ ref: local.find(x => x.text === original)?.ref || 'original', text: original }]);
  const allowTo = allow.map(a => norm1(a.to)).filter(Boolean);
  const cjkLine = cjkShare(text);
  // 逐字记下每个位置的来处；w = 这是普通的话（不是数字 / 名字），最后合成一条「找不到出处的说法」。
  const marks = new Array(text.length).fill(null);
  const mark = (start, end, span) => { for (let i = start; i < end; i++) marks[i] = span; };
  const seen = ref => { if (ref) refs.add(ref); return ref || undefined; };
  // 代码给的错别字修正先标出来（中文按字、英文按整词），免得被前后的最长匹配吃掉一半。
  for (const a of allowTo) for (let at = nt.indexOf(a); at >= 0; at = nt.indexOf(a, at + 1)) { const latin = /[A-Za-z]/.test(a); if (!latin || (!/[A-Za-z0-9]/.test(nt[at - 1] || '') && !/[A-Za-z0-9]/.test(nt[at + a.length] || ''))) mark(at, at + a.length, { k: 'fix' }); }
  // 少数技术搭配按本段完整短语核对，不将 passive / values 等拆成无条件放行词。
  for (const pair of PHRASE_EQUIVALENTS) {
    const source = L.items.find(x => pair.source.test(x.t));
    if (source) for (const match of nt.matchAll(pair.after)) mark(match.index, match.index + match[0].length, { k: 'syn', ref: seen(source.ref), was: source.t.match(pair.source)[0] });
  }
  // 长得像字母数字、其实不是的字：证据里原样有才行（原简历里本来就写着 ① 的可以留着）。
  const rawAll = [...local, ...global].map(x => String(x.text ?? '')).join(' ');
  for (let i = 0; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i));
    if (ODD_CHAR(c) && !rawAll.includes(c)) { mark(i, i + c.length, { k: 'new' }); say('lookalike', c, `「${c}」看起来像普通的字母或数字，其实不是；原简历和你的资料里没有，不能这样写`); }
    i += c.length;
  }
  // 数字：本段证据里要有同一个数。
  const nums = numbersIn(text).filter(n => !marks[n.start]);
  for (const n of nums) {
    const ref = L.nums.get(n.key);
    // 同一个数、说的是别的东西：证据里它总是带着时间 / 大小的单位（800 ms），这里却接着别的词（800 slow SQL queries）。
    // 后面什么都不跟（「6 → 1」）不算换了意思。
    const was = L.units.get(n.key), now = was && /^n:\d+(?:\.\d+)?$/.test(n.key) ? unitAfter(nt, n.end) : null;
    if (ref && now && now !== 'none' && was.size && [...was].every(u => u === 'time' || u === 'size') && !was.has(now)) {
      mark(n.start, n.end, { k: 'new' });
      say('number', n.raw, `「${n.raw}」在原文里说的是${was.has('time') ? '时间' : '大小'}，这里拿来说别的，意思变了`);
      continue;
    }
    if (ref) { mark(n.start, n.end, { k: 'src', ref: seen(ref) }); continue; }
    mark(n.start, n.end, { k: 'new' });
    say('number', n.raw, G.nums.has(n.key) ? `「${n.raw}」是别的经历里的数字，不能用到这一条` : `「${n.raw}」这个数字在原简历和你的资料里都找不到，不能替你写上`);
  }
  if (O) for (const n of numbersIn(O)) if (!nums.some(x => x.key === n.key)) say('dropped_number', n.raw, `原文里的「${n.raw}」被删掉了；数字是这一条最有说服力的部分，改写不能丢`);
  // 英文词：名字 / 技能按本段核对；普通词按全文、同义词表、虚词核对。
  for (const m of nt.matchAll(WORD_RE)) {
    const tok = m[0], start = m.index, end = start + tok.length, lw = low(tok);
    if (marks[start]) continue; // three、doubled 这类数字词已经按数字核对过
    const before = nt.slice(0, start).replace(/\s+$/, ''), sentenceStart = !before || /[.!?;:•·|(（—–-]$/.test(before);
    if (isTerm(tok, { cjkLine, sentenceStart })) {
      if (hasTerm(L, tok)) { mark(start, end, { k: 'src', ref: seen(L.terms.get(termForms(tok)[0]) || L.refOf(lw)) }); continue; }
      // 原文里拼错的技能名改成正确写法（Javscript → JavaScript）：原文那个词本身要像个名字（不是普通英文词、不是缩写、四个字母以上），
      // 只差一个字母（或两个字母对调）；正确的名字换成另一个名字不算，普通的词（scale、rest、table、a、p95）也不能「改」成技能名。
      const near = lw.length >= 4 && TERMS.has(lw) && [...L.termish].find(p => !TERMS.has(p) && !KNOWN_WORDS.has(p) && p[0] === lw[0] && osa(p, lw) <= 1);
      if (near) { mark(start, end, { k: 'fix', was: near }); continue; }
      mark(start, end, { k: 'new' });
      say('term', tok, hasTerm(G, tok) ? `「${tok}」出自别的经历，不能挪到这一条` : `「${tok}」在原简历和你的资料里都没出现过——不能替你加上没写过的技能或名字`);
      continue;
    }
    if (STOP.has(lw)) { mark(start, end, { k: 'fill' }); continue; }
    // 带连字符的普通词（consumer-sector、queue-based）每一截分别核对。
    const parts = lw.split('-').filter(Boolean), cover = w => {
      if (STOP.has(w) || NEUTRAL.has(w)) return { k: 'fill' };
      const range = w === 'increased' && increasedFromRange(text, start, L);
      if (range) return { k: 'src', ref: seen(range) };
      if (localWord(w)) {
        const ref = (P && wordIn(P, w)) || wordIn(L, w), was = !ref && ((P && groupIn(P, w)) || groupIn(L, w));
        if (ref || was) return ref ? { k: 'src', ref: seen(ref) } : { k: 'syn', was };
        // 已有普通词的错拼仍可改，但只在本段找，不能借其它经历的近似词。
        const st = stem(w), near = st.length >= 5 && [...L.words.keys()].find(p => p[0] === st[0] && lev(p, st) <= (st.length >= 8 ? 2 : 1));
        return near ? { k: 'fix', was: near } : null;
      }
      // 先在本段找（原话，再同义词），再去全文找：出处尽量指向这一段自己的原文。
      const local = (P && wordIn(P, w)) || wordIn(L, w);
      if (local) return { k: 'src', ref: seen(local) };
      const alike = (P && groupIn(P, w)) || groupIn(L, w);
      if (alike) return { k: 'syn', was: alike };
      const ref = wordIn(G, w);
      if (ref) return { k: 'src', ref: seen(ref) };
      const was = groupIn(G, w);
      if (was) return { k: 'syn', was };
      const st = stem(w), near = st.length >= 5 && [...G.words.keys()].find(p => p[0] === st[0] && lev(p, st) <= (st.length >= 8 ? 2 : 1));
      return near ? { k: 'fix', was: near } : null;
    };
    const got = parts.map(cover);
    if (got.every(Boolean)) { mark(start, end, got.find(g => g.k === 'syn' || g.k === 'fix') || got.find(g => g.k === 'src') || got[0]); continue; }
    mark(start, end, { k: 'new', w: 1 });
  }
  // 英文的挪用：连着三个实词在别的经历里有、在这一段（和原句）里没有，就是把别处的内容挪了过来（中文见下面「四个字以上的原话」）。
  // 简介、技能说的是整个人（本段就是全文），不查。
  if (!prose && !cjkLine && global.length && global !== local) {
    const q = contentSeq(nt), hit = [];
    for (let i = 0; i + 2 < q.length; i++) {
      const key = `${q[i].k} ${q[i + 1].k} ${q[i + 2].k}`;
      if (G.grams.has(key) && !L.grams.has(key) && !(P && P.grams.has(key))) { const last = hit.at(-1); if (last && q[i].start <= last.end) last.end = q[i + 2].end; else hit.push({ start: q[i].start, end: q[i + 2].end }); }
    }
    for (const h of hit) { const s = text.slice(h.start, h.end); mark(h.start, h.end, { k: 'new' }); say('borrowed', s, `「${s}」出自别的经历，不能挪到这一条`); }
  }
  // 中文：先找本段证据里最长的原话，没有再找全文；再看同义词、虚词；都不是的字就是「新写的」。
  for (let i = 0; i < text.length;) {
    if (marks[i] || !isCjk(nt[i])) { i++; continue; }
    let j = i; while (j < nt.length && isCjk(nt[j]) && !marks[j]) j++;
    const run = nt.slice(i, j);
    for (let p = 0; p < run.length;) {
      const longest = hay => { for (let n = run.length - p; n >= 2; n--) if (hay.includes(run.slice(p, p + n))) return n; return 0; };
      const nl = longest(L.all);
      if (nl) { mark(i + p, i + p + nl, { k: 'src', ref: seen(L.refOf(run.slice(p, p + nl))) }); p += nl; continue; }
      const ng = longest(G.all);
      if (ng) {
        const s = run.slice(p, p + ng);
        // 四个字以上的原话只在别的经历里有：多半是把别处的具体内容挪了过来。
        if (ng >= 4 && !prose) { mark(i + p, i + p + ng, { k: 'new' }); say('borrowed', s, `「${s}」出自别的经历，不能挪到这一条`); }
        else if (LOCAL_ZH.some(w => s.includes(w))) mark(i + p, i + p + ng, { k: 'new', w: 1 });
        else mark(i + p, i + p + ng, { k: 'src', ref: seen(G.refOf(s)) });
        p += ng; continue;
      }
      const syn = ZH_SYN.filter(w => run.startsWith(w, p)).find(w => groupIn(L, w) || (!LOCAL_ZH.includes(w) && groupIn(G, w)));
      if (syn) { mark(i + p, i + p + syn.length, { k: 'syn', was: (P && groupIn(P, syn)) || groupIn(L, syn) || groupIn(G, syn) }); p += syn.length; continue; }
      const neutral = NEUTRAL_ZH.find(w => run.startsWith(w, p));
      if (neutral) { mark(i + p, i + p + neutral.length, { k: 'fill' }); p += neutral.length; continue; }
      mark(i + p, i + p + 1, FUNC_ZH.has(run[p]) ? { k: 'fill' } : { k: 'new', w: 1 }); p++;
    }
    i = j;
  }
  // 担当、谦辞、成果：按意思核对，不按字面（中英文对照）。
  // 被拦下的担当词、成果词在片段里也标成「新写的」（它们在别的经历里出现过也不算）。
  const lt = nt.toLowerCase(), flag = word => { for (let at = lt.indexOf(word); at >= 0; at = lt.indexOf(word, at + 1)) mark(at, at + word.length, { k: 'new' }); };
  const asWritten = word => { const at = lt.indexOf(word); return at >= 0 ? text.slice(at, at + word.length) : word; }; // 理由里照原文的大小写引
  for (const [key, word] of mode === 'company' ? [] : hitsOf(text, STRONG)) if (!L.strong.has(key)) { say('ownership', asWritten(word), `原文没有说你「${asWritten(word)}」，改写不能把你的角色说大`); flag(word); }
  if (O) { const had = hitsOf(O, HEDGE); if (had.size && !hitsOf(text, HEDGE).size) { const w0 = [...had.values()][0], at = low(O).indexOf(w0), w = at >= 0 ? NFKC(O).slice(at, at + w0.length) : w0; say('hedge', w, `原文写的是「${w}」，改后去掉了，读起来像是你一个人做的`); } }
  for (const [key, word] of hitsOf(text, CLAIMS)) if (!L.claims.has(key)) { say('claim', asWritten(word), `原文没提到「${asWritten(word)}」，改写不能加上没有的成果`); flag(word); }
  // 找不到出处的普通说法：连续的字 / 词拼成一段，合成一条理由。
  const fresh = [];
  for (let i = 0; i < text.length; i++) {
    if (!marks[i]?.w) continue;
    let j = i; while (j < text.length && (marks[j]?.w || (/\s/.test(text[j]) && marks[j + 1]?.w))) j++;
    fresh.push(text.slice(i, j).trim()); i = j;
  }
  const named = new Set(problems.map(p => low(p.text)));
  if (fresh.length && !prose) { const listed = [...new Set(fresh)].filter(f => !named.has(low(f))).slice(0, 6); if (listed.length) say('word', listed.join('、'), `这些说法在原文和资料里找不到出处：「${listed.join('」「')}」`); }
  // 和原句有关系：改后的内容至少四分之一来自原句（整句换成另一件事不算改写）。
  if (O) {
    const units = s => { const t = low(s), u = new Set(); for (const m of t.matchAll(WORD_RE)) if (!STOP.has(m[0])) u.add(stem(m[0])); for (const r of t.replace(/[^\u3400-\u9fff]/g, ' ').split(/\s+/)) for (let k = 0; k + 1 < r.length; k++) u.add(r.slice(k, k + 2)); return u; };
    const a = units(text), o = units(O), shared = [...a].filter(x => o.has(x)).length;
    if (a.size >= 3 && shared / a.size < 0.25) say('unrelated', '', '改后的内容和原来这一条几乎没有关系，不像是改写');
  }
  // 片段：相邻、同类、同出处的合并；空格和标点跟着前一段。给页面按出处着色。
  if (prose) for (let i = 0; i < marks.length; i++) if (marks[i]?.w) marks[i] = { k: 'fill' };
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    const m = marks[i] || { k: 'fill' }, last = spans.at(-1), k = m.k;
    if (last && ((last.k === k && last.ref === m.ref && last.was === m.was) || (!marks[i] && (last.k === 'fill' || last.k === 'src')))) last.t += text[i];
    else spans.push({ t: text[i], k, ...(m.ref ? { ref: m.ref } : {}), ...(m.was ? { was: m.was } : {}) });
  }
  const dropped = O ? termsIn(O).filter(t => !termForms(t).some(f => low(text).includes(f))) : [];
  return { ok: !problems.length, problems, spans, dropped, refs: [...refs] };
}

// ── 求职信、自我介绍：按句核对 ──────────────────────────────────────────────────
// 说「我」的句子只拿你的材料当出处；句子点名了哪段经历（公司、项目、学校），数字和名字就只认那一段。
// 说公司、岗位的句子只拿公司调研和岗位描述当出处。客套话（「期待与您交流」）不查；数字、名字和技能、担当、成果照样严格查。
// names：公司名、岗位名、你的名字和联系方式——任何句子都可以提。
const FIRST_PERSON = /(?<![a-z])(?:i|i'm|i've|i'd|i'll|my|me|mine|myself)(?![a-z])/i;
const squashName = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function splitSentences(text) {
  return String(text ?? '').split(/\n+/).flatMap(p => p.split(/(?<=[。！？!?])|(?<=[.;；])\s+(?=[A-Z"“‘(（\u3400-\u9fff])/)).map(x => x.trim()).filter(Boolean);
}
// 哪些句子在说公司：没有「我」，而且提到公司名（或别名）、「贵司 / 你们 / 这个岗位 / the role / your team」。
// 中文常常省掉「我」：别的句子都当作在说你自己（自我介绍 aboutMe=true 时每一句都是）。
// general：说「整个人」的材料（简介、技能、抬头、资料里的定位和年限）——任何一句说自己的话都可以引用。
const COMPANY_WORDS = /贵司|贵公司|贵团队|你们|您们|该岗位|这个岗位|此岗位|该职位|这个职位|\b(?:your (?:team|company|mission|product|platform)|the (?:role|position|team)|this (?:role|position))\b/i;
// target：指着对方的说我的句子（「希望在贵司做转化相关的事」「I'd like to bring this to your team」）可以用的词——JD、岗位名。
// 不指着对方的自我陈述照旧只认你的材料（第 6b 轮：英文称呼的 Hiring、目标岗位名、JD 里的「转化」被当成了编的）。
const TOWARD = /贵司|贵公司|贵团队|贵部门|你们|该岗位|这个岗位|此岗位|这份工作|\byour\b|\bthis (?:role|position|team|opportunity)\b|\bthe (?:role|position|team)\b/i;
export function verifyLetter({ text, candidate = [], entries = [], general = [], company = [], jd = [], names = [], companyNames = [], aboutMe = false, target = [] } = {}) {
  const base = names.filter(Boolean).map(n => ({ ref: 'name', text: n })), coKeys = companyNames.map(squashName).filter(k => k.length >= 2);
  const sentences = splitSentences(text).map(s => {
    const key = squashName(s), me = aboutMe || FIRST_PERSON.test(s) || /我/.test(s) || !(coKeys.some(k => key.includes(k)) || COMPANY_WORDS.test(s));
    const hit = me ? entries.filter(e => { const n = squashName(e.name); return n.length >= (/[\u3400-\u9fff]/.test(n) ? 2 : 4) && key.includes(n); }) : [];
    const toward = me && TOWARD.test(s) ? target : [];
    const local = me ? [...(hit.length ? [...hit.flatMap(e => e.local), ...general] : candidate), ...base, ...toward] : [...company, ...jd, ...base];
    const global = me ? [...candidate, ...base, ...toward] : local;
    const r = verifyLine({ after: s, local, global, mode: me ? 'letter' : 'company' });
    return { text: s, about: me ? 'me' : 'company', ok: r.ok, problems: r.problems, spans: r.spans, refs: r.refs };
  });
  return { ok: sentences.every(x => x.ok), sentences, problems: sentences.flatMap(x => x.problems.map(p => ({ ...p, sentence: x.text }))) };
}

