// 预设（2026-09-29）：「开始使用」第一步选了「我是谁、想做什么」之后，一键带上的一整套默认值。
//
// 一套预设 = 求职方向（lib/directions.mjs：岗位类别、级别规则、工程师的大厂职级对标、证书）
//          + 公司包（config/company-packs/*.example.yaml：每家都用我们的适配器实际读到过岗位）
//          + 真人渠道包（config/channel-packs/<预设>.example.json：哪些来源默认开、按方向给好的搜索词）
//          + 简历提示 + 默认预算档（省钱 economy / 标准 standard / 高级 premium，由用量那边的 Ledger 执行）
//          + 面试准备要点。
// 先做全的是「工程师」（9 个子方向）；产品经理、数据分析、UI/UX 设计、运营是入门预设：用同一批科技公司的招聘系统和
// 同一批渠道，国内门户的搜索词按方向自动换（lib/ats/cn.mjs），不需要新的数据来源。2026-10-02 加了金融、法律、会计、
// 人力 / 行政、市场、销售 / 商务、项目管理 7 张卡片（排在原来 5 张后面）；咨询还没有卡片。
//
// 这里只放数据和几个纯函数；写 facts.yaml、渠道开关、公司清单的是「开始使用」的接口（lib/setup.mjs、bin/serve.mjs）。
import { DIRECTIONS, directionLabel } from './directions.mjs';

export const BUDGET_TIERS = { economy: { zh: '省钱', en: 'Economy' }, standard: { zh: '标准', en: 'Standard' }, premium: { zh: '高级', en: 'Premium' } };
export const STAGES = { student: { zh: '在校生', en: 'Student' }, new_grad: { zh: '应届生', en: 'New graduate' }, experienced: { zh: '职场人', en: 'Working professional' } };
// 面经去哪看（面试准备包的默认来源）。
export const INTERVIEW_SOURCES = ['牛客', '力扣讨论区', '脉脉'];

const ENGINEERING_PREP = {
  _all: ['算法与数据结构', '项目深挖', '行为题'],
  backend: ['算法与数据结构', '系统设计', '数据库与索引', '并发与分布式', '项目深挖', '行为题'],
  frontend: ['JavaScript / TypeScript 基础', '浏览器与网络', '框架原理（React / Vue）', '性能优化', '项目深挖', '行为题'],
  fullstack: ['算法与数据结构', '前后端各一轮基础', '系统设计', '项目深挖', '行为题'],
  ai_application: ['大模型原理与 API', 'RAG 与 Agent 设计', '评测与成本', '后端基础', '项目深挖', '行为题'],
  algorithm: ['机器学习基础', '论文与模型细节', '代码题', '业务指标与实验', '项目深挖'],
  data_engineering: ['SQL 与数仓建模', 'Spark / Flink', '数据质量与口径', '代码题', '项目深挖'],
  qa: ['测试方法与用例设计', '自动化测试框架', '编程基础', '质量平台', '项目深挖'],
  client: ['iOS / Android 基础', '性能与稳定性（崩溃、启动、包体积）', '跨端方案', '代码题', '项目深挖'],
  sre: ['Linux 与网络', 'Kubernetes 与云', '可观测性与故障处理', '脚本与编程', '项目深挖'],
};
const ENGINEERING_RESUME = {
  _all: ['每个项目写清你负责的部分、用了什么技术、结果数字（延迟、QPS、成本、用户数）', 'GitHub / 个人主页放在联系方式里', '技能按目标方向排序：先写岗位关键词里的语言和框架', '实习写成实习，起止年月写全（YYYY-MM）'],
  backend: ['写并发量、延迟、可用性和数据量级'],
  frontend: ['写性能指标（首屏、LCP）、组件库和跨端经验'],
  fullstack: ['前端、后端各举一个你从头做到上线的功能'],
  ai_application: ['写评测集和指标、调用成本、上线规模；说清模型做什么、代码做什么'],
  algorithm: ['写离线 / 在线指标的提升、论文和竞赛'],
  data_engineering: ['写数据量级、链路时延、口径治理'],
  qa: ['写自动化覆盖率、发现的缺陷、测试平台'],
  client: ['写崩溃率、启动时间、包体积和上架的应用'],
  sre: ['写可用性（SLA）、故障恢复时间、成本优化'],
};

export const PRESETS = {
  engineering: {
    direction: 'software', stage_default: 'experienced',
    tracks: Object.keys(DIRECTIONS.software.tracks), default_tracks: [],
    company_pack: 'config/company-packs/tech.example.yaml',
    channel_pack: 'config/channel-packs/engineering.example.json',
    budget_tier: 'standard',
    resume_hints: ENGINEERING_RESUME,
    interview_prep: ENGINEERING_PREP,
    level_mapping: true,
  },
  product: {
    direction: 'product', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.product.tracks), default_tracks: [],
    company_pack: 'config/company-packs/tech.example.yaml',
    channel_pack: 'config/channel-packs/product.example.json',
    budget_tier: 'economy',
    resume_hints: { _all: ['每段经历写：用户问题 → 你的方案 → 上线结果（数据）', 'AI 产品：写清模型能力的边界、评测、成本和上线效果', '附作品集或 PRD 样例的链接'] },
    interview_prep: { _all: ['产品 sense 与需求分析', '数据指标与 A/B 实验', 'AI 产品的能力边界与评测', '案例与项目深挖', '行为题'] },
  },
  data: {
    direction: 'data', stage_default: 'new_grad',
    tracks: [], default_tracks: [],
    company_pack: 'config/company-packs/tech.example.yaml',
    channel_pack: 'config/channel-packs/data.example.json',
    budget_tier: 'economy',
    resume_hints: { _all: ['写分析解决的业务问题和影响（例如增长 X%）', '工具写到具体程度：SQL、Python、Tableau / Power BI', '附一个分析项目或看板的链接'] },
    interview_prep: { _all: ['SQL 手写', '统计与 A/B 实验', '业务指标拆解', 'Python 数据处理', '案例分析'] },
  },
  design: {
    direction: 'design', stage_default: 'new_grad',
    tracks: [], default_tracks: [],
    company_pack: 'config/company-packs/tech.example.yaml',
    channel_pack: 'config/channel-packs/design.example.json',
    budget_tier: 'economy',
    resume_hints: { _all: ['作品集链接放第一行', '每个作品写你的角色、设计过程和上线效果', '写常用工具：Figma、Sketch、Adobe 系列'] },
    interview_prep: { _all: ['作品集讲解', '设计过程与用户研究', '交互与视觉规范', '现场设计题', '行为题'] },
  },
  operations: {
    direction: 'operations', stage_default: 'new_grad',
    tracks: [], default_tracks: [],
    company_pack: 'config/company-packs/tech.example.yaml',
    channel_pack: 'config/channel-packs/operations.example.json',
    budget_tier: 'economy',
    resume_hints: { _all: ['写活动和用户增长的数字（拉新、留存、转化、GMV）', '写你负责的渠道和工具（小红书、抖音、社群、私域）', '附一个你做的活动或内容的链接'] },
    interview_prep: { _all: ['用户分层与增长', '活动策划与复盘', '内容与渠道', '数据指标', '案例与行为题'] },
  },
  // 2026-10-02 新方向（design/non-tech/方案-金融法律会计.md）：细分都取注册表里的，公司包由块 8 建（文件还不在时引导页说
  // 「还没有」）；渠道包里技术社区默认关，综合平台和垂直站只放搜好的入口（lib/channel-entries.mjs 按细分和城市填链接）。
  finance: {
    direction: 'finance', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.finance.tracks), default_tracks: [],
    company_pack: 'config/company-packs/finance.example.yaml',
    channel_pack: 'config/channel-packs/finance.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['学历放最前面：学校、专业、GPA 和排名', '证书和执照写清进度：证券 / 基金从业、CFA 几级、FRM、CPA 科目', '实习写交易或研究经验：项目类型、你的角色、规模、结果', '投香港、美国的岗位，英文简历控制在一页'],
      investment_banking: ['写参与过的项目：上市、发债、并购，你负责的部分（尽调、材料、估值）'],
      research: ['写覆盖的行业和公司、发表或参与的研究报告'],
      asset_management: ['写研究覆盖的行业和推荐的标的，有组合或模拟盘就写收益和回撤'],
      banking: ['写营销或客户维护的数字：客户数、存贷款规模、产品销售额'],
      risk: ['写做过的风险模型、授信审批或合规检查，涉及的业务和规模'],
      quant: ['写策略或因子的回测结果（收益、夏普、回撤）和用的工具（Python、C++、数据库）'],
      sales_trading: ['写覆盖的品种（固收、权益、外汇）和交易或销售的业绩'],
      corporate_finance: ['写做过的预算、经营分析和财务模型，用过的系统（SAP、Oracle）'],
    },
    interview_prep: {
      _all: ['估值方法与三张表', '行业研究：一个你熟悉的行业讲清楚', '市场热点与宏观', '案例与实习深挖', '行为题（为什么选金融、为什么选这家）'],
      investment_banking: ['DCF、可比公司、LBO 的思路', 'IPO、债券、并购的流程'],
      research: ['研究报告的框架：行业空间、竞争格局、公司估值', '推荐一只股票'],
      asset_management: ['推荐一只股票或基金，讲清逻辑和风险', '组合管理与资产配置'],
      banking: ['银行的业务和产品', '信贷审批的基本思路', '营销场景题'],
      risk: ['信用、市场、操作风险的概念', '监管规则与合规案例'],
      quant: ['概率与统计题', '编程题', '因子与策略回测'],
      sales_trading: ['利率、汇率和债券定价', '市场观点与交易思路'],
      corporate_finance: ['预算与经营分析', '财务报表分析'],
    },
    interview_sources: ['牛客（银行、券商的公司面经页）', 'Wall Street Oasis（英文，要国际网络）', '小红书'],
  },
  legal: {
    direction: 'legal', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.legal.tracks), default_tracks: [],
    company_pack: 'config/company-packs/legal.example.yaml',
    channel_pack: 'config/channel-packs/legal.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['资格放最前面：法律职业资格（A 证 / C 证）、律师执业证，写取得日期', '写执业领域和执业年限（PQE 从执业证日期算起）', '代表案件和项目隐去当事人：你的角色、标的额、结果', '写法律检索、文书写作和外语能力'],
      litigation: ['写代理过的案件类型、审级和结果，独立出庭的次数'],
      transactional: ['写参与的上市、并购、投融资项目，你负责的尽调和文件'],
      in_house: ['写审过的合同类型和数量、处理过的纠纷、支持过的业务'],
      compliance: ['写做过的合规检查、制度建设和监管沟通'],
      ip: ['写代理的专利、商标数量和技术领域；有理工科背景写清楚'],
    },
    interview_prep: {
      _all: ['法条与案例分析', '法律文书写作（合同条款、法律意见）', '业务领域的常见问题', '为什么选这家律所或公司', '行为题'],
      litigation: ['诉讼程序与证据规则', '一个你经办案件的复盘'],
      transactional: ['公司法、证券法的常见问题', '尽职调查的流程和要点'],
      in_house: ['合同审查要点', '公司治理与劳动法常见问题'],
      compliance: ['反洗钱与数据合规的规则', '合规风险的识别与处理'],
      ip: ['专利法与商标法', '专利检索与侵权分析'],
    },
    interview_sources: ['小红书', '知乎', 'B 站'],
  },
  accounting: {
    direction: 'accounting', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.accounting.tracks), default_tracks: [],
    company_pack: 'config/company-packs/accounting.example.yaml',
    channel_pack: 'config/channel-packs/accounting.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['证书进度写在最前面：CPA 通过的科目、ACCA、CMA、会计职称', '四大或事务所的经历单独写清级别（A1 / A2 / Senior）和年数', '写用过的系统：SAP、Oracle、用友、金蝶，Excel 写到函数和透视表', '实习写成实习，起止年月写全（YYYY-MM）'],
      audit: ['写审计客户的行业和规模（上市公司、上市审计项目）和负责的审计循环'],
      accounting: ['写负责的科目、月结 / 年结和出具的报表'],
      fpa: ['写做过的预算、预测和经营分析，支持过的决策'],
      tax: ['写处理过的税种、纳税申报和税务筹划项目'],
      internal_audit: ['写做过的内审项目、内控测试和 SOX 工作'],
    },
    interview_prep: {
      _all: ['会计准则与常见分录', '审计流程', '税法基础', 'Excel 实操', '行为题（为什么选这家、加班怎么看）'],
      audit: ['审计循环与抽样', '群面与案例题'],
      accounting: ['月结与报表编制', '成本核算'],
      fpa: ['预算与差异分析', '财务模型'],
      tax: ['增值税、企业所得税、个税的要点', '转让定价基础'],
      internal_audit: ['内控框架（COSO）', '内审项目的流程'],
    },
    interview_sources: ['B 站（四大求职视频）', '小红书', '牛客（四大公司页，内容偏旧）'],
  },
  hr_admin: {
    direction: 'hr_admin', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.hr_admin.tracks), default_tracks: [],
    company_pack: 'config/company-packs/business.example.yaml',
    channel_pack: 'config/channel-packs/hr_admin.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['写负责的模块：招聘、薪酬、培训、员工关系、行政', '用数字写支持规模：服务多少员工、办过多大的活动', '写用过的人事系统和办公软件', '写证书：企业人力资源管理师、经济师（人力资源）'],
      recruiting: ['写招聘人数、周期和用过的渠道'],
      hrbp: ['写支持的业务和人数、推动过的组织或人才项目'],
      compensation: ['写核算的人数、做过的薪酬方案和绩效流程'],
      learning: ['写设计和交付过的培训项目、覆盖人数'],
      admin: ['写管理的办公面积、资产、供应商和费用'],
      executive_assistant: ['写支持的领导级别、安排的会议和差旅、用到的外语'],
    },
    interview_prep: {
      _all: ['劳动法常识（劳动合同、社保）', '你做过的一个项目或活动复盘', '沟通与冲突处理', '办公软件实操', '行为题'],
      recruiting: ['招聘流程与渠道选择', '怎么判断候选人'],
      hrbp: ['组织诊断与业务理解', '员工关系案例'],
      compensation: ['薪酬结构与个税', '绩效考核方法'],
      learning: ['培训需求分析与效果评估'],
      admin: ['行政预算与供应商管理', '突发事件处理'],
      executive_assistant: ['日程与会议安排', '保密与多任务处理'],
    },
    interview_sources: ['牛客（HR 校招面经）', '小红书'],
  },
  marketing: {
    direction: 'marketing', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.marketing.tracks), default_tracks: [],
    company_pack: 'config/company-packs/business.example.yaml',
    channel_pack: 'config/channel-packs/marketing.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['作品和案例链接放在最前面', '写投放预算、增长数字和内容数据', '每个项目写清你的角色和结果'],
      brand: ['写做过的品牌项目和活动、带来的声量和销量'],
      growth: ['写管理的投放预算、渠道和 ROI、获客成本'],
      content: ['写运营的账号、粉丝增长和爆款内容的数据'],
      pr: ['写对接过的媒体、处理过的舆情、发过的稿件'],
      market_research: ['写做过的调研项目、方法（问卷、访谈）和结论'],
    },
    interview_prep: {
      _all: ['作品集或案例讲解', '一个你喜欢的品牌或营销案例拆解', '数据指标', '现场策划题', '行为题'],
      brand: ['品牌定位与传播策略'],
      growth: ['投放渠道与 ROI 优化', '漏斗与归因'],
      content: ['选题与爆款逻辑', '各平台的内容差异'],
      pr: ['危机公关案例', '媒体关系'],
      market_research: ['调研设计与样本', '数据分析与洞察'],
    },
    interview_sources: ['牛客（快消公司面经页）', '小红书', 'B 站'],
  },
  sales: {
    direction: 'sales', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.sales.tracks), default_tracks: [],
    company_pack: 'config/company-packs/business.example.yaml',
    channel_pack: 'config/channel-packs/sales.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['业绩数字放在最前面：签约额、完成率、客户数', '写行业和客户类型', '有驾照写上，外勤销售常要求'],
      enterprise: ['写大客户的行业、单笔金额和销售周期'],
      channel: ['写管理的渠道数量和渠道带来的业绩'],
      bd: ['写谈成的合作和带来的收入或资源'],
      sales_support: ['写处理的报价、合同和投标数量、中标率'],
      customer_success: ['写负责的客户数、续约率和满意度'],
    },
    interview_prep: {
      _all: ['业绩复盘：一单你怎么签下来的', '现场销售演练（卖一个产品）', '抗压与目标管理', '行业与客户理解', '行为题'],
      enterprise: ['大客户销售流程与关键人', '方案讲解'],
      channel: ['渠道政策与渠道管理'],
      bd: ['合作谈判与资源整合'],
      sales_support: ['招投标流程与合同要点'],
      customer_success: ['续约与增购', '客户问题处理'],
    },
    interview_sources: ['牛客（快消公司页）', 'B 站', '小红书'],
  },
  project_management: {
    direction: 'project_management', stage_default: 'new_grad',
    tracks: Object.keys(DIRECTIONS.project_management.tracks), default_tracks: [],
    company_pack: 'config/company-packs/business.example.yaml',
    channel_pack: 'config/channel-packs/project_management.example.json',
    budget_tier: 'economy',
    resume_hints: {
      _all: ['证书写在前面：PMP、软考信息系统项目管理师、建造师', '写项目规模：预算、人数、周期，和交付结果', '写用过的方法和工具：敏捷、甘特图、Jira、Project', '不写技术细节，写你怎么推进和协调'],
      it_project: ['写交付的系统和上线结果'],
      pmo: ['写管理的项目数量和推动的规范、报表'],
      construction: ['写工程类型、合同额、工期和质量验收结果'],
      delivery: ['写实施的客户数、上线周期和验收结果'],
    },
    interview_prep: {
      _all: ['项目管理流程（启动、计划、执行、收尾）', '进度和风险管理', '跨部门沟通与冲突处理', '一个你负责的项目复盘', '行为题'],
      it_project: ['敏捷与瀑布', '需求变更的处理'],
      pmo: ['项目组合管理与度量'],
      construction: ['施工组织与质量、工期管理', '工程合同与成本控制'],
      delivery: ['实施方法论与客户沟通'],
    },
    interview_sources: ['B 站', '知乎', '小红书'],
  },
};

// 界面用的列表：名字、简介、子方向都从 lib/directions.mjs 取，只写一处。
export function presetList(lang = 'zh') {
  return Object.entries(PRESETS).map(([key, p]) => {
    const d = DIRECTIONS[p.direction];
    return {
      key, direction: p.direction, label: directionLabel(p.direction, lang), blurb: d.blurb?.[lang] || d.blurb?.zh || '',
      tracks: p.tracks.map((t) => ({ key: t, label: d.tracks?.[t]?.[lang] || d.tracks?.[t]?.zh || t })),
      stage_default: p.stage_default, budget_tier: p.budget_tier, company_pack: p.company_pack, channel_pack: p.channel_pack,
      level_mapping: !!p.level_mapping,
    };
  });
}
// 选了一个预设（和子方向、身份）之后要写进 facts.yaml 的几项。不在这里写文件。
export function presetFacts(key, { tracks = [], stage = null } = {}) {
  const p = PRESETS[key];
  if (!p) throw Error(`没有这个预设：${key}`);
  const known = tracks.filter((t) => p.tracks.includes(t));
  return {
    'preferences.directions': [p.direction],
    'preferences.tracks': known.length ? known : p.default_tracks,
    ...(stage && STAGES[stage] ? { 'availability.current_status': STAGES[stage].zh } : {}),
  };
}
// 某个预设给这几个子方向的简历提示和面试准备要点（没有子方向的预设用 _all）。
export function presetHints(key, tracks = []) {
  const p = PRESETS[key] || {};
  const pick = (table = {}) => [...new Set([...(table._all || []), ...tracks.flatMap((t) => table[t] || [])])];
  // 面经来源按预设分开：新方向写自己的，没写的（工程师那几张卡片）还是原来那一串。
  return { resume: pick(p.resume_hints), interview: pick(p.interview_prep), interview_sources: p.interview_sources || INTERVIEW_SOURCES };
}
