// 求职方向（2026-09-29）：系统里「按方向走」的规则都从这里取——判断用的岗位类别和级别、预筛看的标题词、
// 实习怎么算年限、常见证书、找岗位的搜索词、排序加分。
//
// 方向写在 candidate/facts.yaml 的 preferences.directions（列表，第一个是主方向；也可以只写一个
// preferences.direction）。细分写在 preferences.tracks（金融：investment_banking / asset_management /
// risk / quant / corporate_finance / sales_trading）。
//
// 没写方向就是 software：和以前逐字相同的一套软件 / AI 工程规则（lib/screening.mjs、lib/matcher.mjs、
// lib/judgements.mjs 的老路径）。作者本人的 facts 没写这一项，判断结果一条不变——tests/golden-software.test.mjs
// 拿改动之前录下的结果逐条对比。
//
// 别的方向走「通用路径」：岗位类别用下面的 FAMILIES（投行、资管、咨询、市场……），级别用 GRADES（实习 / 应届 /
// 有经验 / 资深 / 管理），方向以外的岗位在入库前排除，相邻的方向（金融看数据分析、咨询）留给判断。
// 只依赖 node 自带模块：lib/screening.mjs、lib/matcher.mjs、web 都要用它，不能引出 import 环。

// ── 岗位类别（通用路径给 Jev 的选项；软件方向仍用 lib/judgements.mjs 的老类别） ───────────────────
// what：给判断模型读的说明（英文，和 lib/judgements.mjs 的其它问题一致）；zh / en：界面上的名字；
// title：只看岗位标题的粗筛词（没有 Jev 读 JD 时的预筛，和排序加分）。
export const FAMILIES = {
  investment_banking: {
    zh: '投行', en: 'Investment banking',
    what: 'Investment banking and capital markets advisory: M&A, ECM / DCM, leveraged finance, restructuring, industry coverage, IPO sponsorship and underwriting (投行, 投资银行, 并购, 保荐, 承销)',
    title: /investment bank|\bIBD\b|\bM&A\b|mergers|capital markets|\bECM\b|\bDCM\b|leveraged finance|restructuring|投行|投资银行|并购|保荐|承销|资本市场|债券承揽/i,
  },
  asset_management: {
    zh: '资管 / 投研', en: 'Asset management & research',
    what: 'Investing on the buy side: asset, fund or wealth management, portfolio analysis, buy-side investment research, private equity, venture capital (资产管理, 基金, 投研, 私募, 创投)',
    title: /asset management|investment management|wealth management|private bank|portfolio (?:analyst|associate|management)|\bfund\b|investment analyst|private equity|venture capital|资产管理|资管|基金|投研|财富管理|私人银行|投资经理|投资助理|投资分析|私募|创投/i,
  },
  // 2026-10-02 从「资管 / 投研」分出来：研究词原样挪过来（split_from），没加新词。
  securities_research: {
    zh: '券商研究 / 行业研究', en: 'Securities & industry research', split_from: 'asset_management',
    what: 'Sell-side or industry research: equity or credit research, research analyst or associate covering a sector, writing research reports (券商研究所, 行业研究, 研究员, 研究助理)',
    title: /equity research|credit research|research analyst|研究员|研究助理|行业研究|行研/i,
  },
  commercial_banking: {
    zh: '商业银行', en: 'Commercial banking', added: '2026-10-02',
    what: 'Commercial banking: corporate or retail relationship managers, lending and credit approval, transaction banking, bank management trainee programmes (对公, 零售, 客户经理, 信贷, 交易银行, 银行管培生)',
    title: /commercial bank|corporate bank|retail bank|relationship manager|transaction banking|trade finance|lending officer|loan officer|对公|零售银行|(?:对公|零售|公司|个人|普惠|小微)(?:金融)?客户经理|信贷|交易银行|(?<!投资)银行.{0,8}(?:管培|管理培训|柜员|客户经理)/i,
  },
  risk_compliance: {
    zh: '风控 / 合规', en: 'Risk & compliance',
    what: 'Risk and compliance: credit, market or operational risk, model validation, underwriting, compliance, AML / KYC, internal control (风控, 风险管理, 授信, 合规, 反洗钱, 内控)',
    title: /\brisk\b|credit (?:analyst|risk|officer)|underwrit|compliance|\bAML\b|\bKYC\b|model (?:risk|validation)|internal control|风控|风险|信用|授信|信贷|合规|反洗钱|内控/i,
  },
  quant: {
    zh: '量化', en: 'Quant',
    what: 'Quantitative research or trading: quant research, systematic strategies, derivatives pricing, financial engineering (量化研究, 金融工程)',
    title: /\bquant|quantitative|systematic (?:trading|strateg)|\bstrats?\b|derivatives pricing|financial engineer|量化|金融工程|策略研究/i,
  },
  corporate_finance: {
    zh: '财务 / 会计', en: 'Corporate finance & accounting',
    what: 'Corporate finance and accounting inside a company: financial analyst, FP&A, accounting, treasury, financial reporting, controllership (财务, 会计, 资金). Audit and tax have their own families',
    title: /financial analyst|finance analyst|\bFP&A\b|accountant|accounting|treasury|controller|financial reporting|财务|会计|资金|出纳|成本分析/i,
  },
  // 2026-10-02 从「财务 / 会计」分出来：审计、税务词原样挪过来。
  audit: {
    zh: '审计', en: 'Audit', split_from: 'corporate_finance',
    what: 'Audit: external audit at an accounting firm (Big Four or domestic firms: audit associate, audit senior, audit manager) or internal audit inside a company (审计, 外审, 内审)',
    // 四大的外审在英文岗位名里常写成 Assurance（普华永道「Core Assurance Associate」）；Quality / Information / Software Assurance 是测试和安全，不算。
    title: /\baudit|(?<!quality |information |software )\bassurance\b|审计|鉴证/i,
  },
  tax: {
    zh: '税务', en: 'Tax', split_from: 'corporate_finance',
    what: 'Tax: tax compliance and filing, tax advisory, transfer pricing, at an accounting firm or a company tax team (税务, 税务筹划, 转让定价)',
    title: /\btax\b|税务/i,
  },
  sales_trading: {
    zh: '销售交易', en: 'Sales & trading',
    what: 'Sales and trading on a markets desk: trader, markets analyst, institutional sales, FICC, equities (销售交易, 交易员, 固收)',
    title: /sales (?:&|and) trading|\btrader\b|trading analyst|markets? analyst|institutional sales|\bFICC\b|(?:equity|equities|fixed income|credit|rates|fx|commodities|derivatives|structured products|prime brokerage) (?:sales|trading)|销售交易|交易员|固收|固定收益|外汇交易/i,
  },
  banking_operations: {
    zh: '金融中后台', en: 'Banking operations',
    what: 'Middle and back office at a bank, broker or asset manager: operations, settlement, clearing, custody, fund accounting, client service (中后台, 清算, 托管, 运营岗)',
    title: /(?:bank|banking|fund|investment|trade|securities) operations|settlement|clearing|custody|client service|middle office|back office|柜员|清算|托管|结算|中后台/i,
  },
  consulting: {
    zh: '咨询', en: 'Consulting',
    what: 'Consulting: management, strategy, business, financial or technology consulting and advisory (咨询, 管理咨询, 战略)',
    title: /consult|advisory|strategy (?:analyst|associate)|咨询|管理顾问|战略/i,
  },
  marketing: {
    zh: '市场', en: 'Marketing',
    what: 'Marketing: brand, growth, digital or performance marketing, content, social media, PR and communications, market research (市场, 品牌, 营销, 新媒体, 投放, 公关)',
    title: /marketing|\bbrand\b|growth (?:marketing|analyst)|content (?:marketing|strategist)|social media|public relations|communications|market research|campaign|\bSEO\b|\bSEM\b|品牌|营销|新媒体|投放|公关|推广|内容策划|广告|市场(?!风险|部?经理)/i,
  },
  product_management: {
    zh: '产品', en: 'Product management',
    what: 'Product management: product manager, associate product manager, product owner, product analyst (产品经理, 产品助理)',
    title: /product manag|\bAPM\b|product owner|product analyst|产品经理|产品助理|产品专员|产品策划/i,
  },
  operations: {
    zh: '运营', en: 'Operations',
    what: 'Operations outside banking: business, user, content, e-commerce, community or strategy & operations (运营, 用户运营, 内容运营, 商业运营)',
    title: /business operations|strategy (?:&|and) operations|operations (?:analyst|associate|specialist|coordinator)|运营|供应链/i,
  },
  data_analytics: {
    zh: '数据分析', en: 'Data analytics',
    what: 'Data and business analysis: data analyst, business analyst, BI, analytics, insights (数据分析, 商业分析, 经营分析)',
    title: /data analy|business analy|\bBI\b|analytics|insights? analyst|数据分析|商业分析|经营分析|数据运营/i,
  },
  software_engineering: {
    zh: '软件工程', en: 'Software engineering',
    what: 'Engineering: writing and shipping software (backend, frontend, mobile, data or ML engineering, QA), or training models (软件开发, 算法, 测试)',
    title: /software|developer|\bengineer\b|programmer|\bSDE\b|\bSWE\b|back.?end|front.?end|full.?stack|devops|\bSRE\b|machine learning|研发|开发|工程师|程序员|算法|测试/i,
  },
  sales_bd: {
    zh: '销售 / 商务', en: 'Sales & business development',
    what: 'Sales and business development on salary: account executive, key account or channel sales, BD, sales support (bids, contracts), customer success (销售, 大客户, 渠道, 商务拓展, 客户成功). Commission-only product sales is commission_sales',
    title: /(?<!(?:equity|equities|fixed income|credit|rates|fx|commodities|derivatives|structured products|prime brokerage|institutional) )\bsales\b(?! (?:&|and) trading)|account executive|business development|\bBDR?\b|customer success|销售(?!交易)|商务拓展|渠道经理|客户成功/i,
  },
  // 2026-10-02 从「销售 / 商务」分出来：拿提成的销售，原样挪过来的词。方向以外的人看它算「你不做的岗位」，选了销售方向也一样。
  commission_sales: {
    zh: '提成类销售', en: 'Commission sales', split_from: 'sales_bd',
    what: 'Commission-based selling of a consumer product: insurance agent, telesales, wealth / course / property advisers paid mainly on commission (保险代理, 电话销售, 理财顾问, 课程顾问, 置业顾问)',
    title: /financial advisor|\bcommission|理财顾问|保险代理|课程顾问|置业顾问|电话销售/i,
  },
  // 2026-10-02 起拆成人力、行政、律所执业、公司法务四个。旧键只用来显示已有判断里的旧类别：不再给判断模型当选项，
  // 也不进「而不是」和偏好学习的类别表；已有的判断结果不重判。legacy_title 是拆之前的标题词，只给软件方向的离线判断用
  // （见 nonEngineeringTitle），让它一个字都不变。
  hr_admin_legal: {
    zh: '人力 / 行政 / 法务', en: 'HR, admin & legal', legacy: true, split_into: ['hr', 'admin', 'legal_practice', 'in_house_legal'],
    what: 'HR, recruiting, administration or legal (人力资源, 招聘, 行政, 法务)',
    title: null,
    legacy_title: /recruit(?:er|ing (?:coordinator|specialist|manager))|talent acquisition|\bHR(?:BP)?\b|human resources|payroll|administrative assistant|legal|paralegal|counsel|人力资源|(?<!校园|社会|春季|秋季|实习生)招聘(?!会|季|计划|项目)|人事|行政|法务|律师/i,
  },
  hr: {
    zh: '人力资源', en: 'Human resources', added: '2026-10-02',
    what: 'Human resources: recruiting and talent acquisition, HRBP, compensation and benefits, performance, learning and development, employee relations, HR operations (人力资源, 招聘, 薪酬绩效, 培训发展)',
    title: /recruit(?:er|ing (?:coordinator|specialist|manager|partner))|talent acquisition|\bHR(?:BP)?\b|human resources|payroll|compensation (?:&|and) benefits|\bC&B\b|learning (?:&|and) development|\bL&D\b|people (?:partner|operations)|人力资源|(?<!校园|社会|春季|秋季|实习生)招聘(?!会|季|计划|项目)|人事|薪酬|绩效|员工关系|组织发展|培训(?:专员|主管|经理|发展)/i,
  },
  admin: {
    zh: '行政 / 总助', en: 'Administration & executive support', added: '2026-10-02',
    what: 'Administration and executive support: office and facilities administration, executive assistant, secretary to an executive, chief of staff (行政, 总助, 高管助理, 秘书)',
    title: /administrative|office (?:manager|administrator|coordinator)|executive assistant|personal assistant|chief of staff|secretary|receptionist|行政|前台|秘书|高管助理|(?:总经理|总裁|董事长|CEO|部门)助理|总助/i,
  },
  legal_practice: {
    zh: '律所执业', en: 'Law-firm practice', added: '2026-10-02',
    what: 'Practising law at a law firm or IP agency: litigation and arbitration, capital markets, M&A and other transactional work, patent agency; associates, paralegals and trainee solicitors (律所, 律师, 律师助理, 诉讼, 非诉, 专利代理)',
    title: /\blawyer|attorney|solicitor|barrister|paralegal|legal assistant|law firm|律师|律所|诉讼|仲裁|争议解决|专利代理/i,
  },
  in_house_legal: {
    zh: '公司法务', en: 'In-house legal', added: '2026-10-02',
    what: 'Legal work inside a company: contracts, disputes management, corporate and financing matters, data and privacy, intellectual property; legal specialist, legal counsel, general counsel (法务, 法律顾问, 合同, 知识产权)',
    title: /\blegal\b|counsel|in-house|法务|法律顾问|知识产权|intellectual property/i,
  },
  project_management: {
    zh: '项目管理', en: 'Project management', added: '2026-10-02',
    what: 'Project management: IT or internet projects, PMO, construction and engineering projects, delivery and implementation; project assistant, project manager, programme manager (项目管理, 项目经理, PMO, 交付, 实施)',
    title: /project (?:manag|coordinator|assistant|officer)|programme manag|\bPMO\b|delivery manager|implementation (?:consultant|manager|specialist)|项目经理|项目管理|项目助理|项目专员|项目主管|交付经理|实施顾问/i,
  },
  design: {
    zh: '设计', en: 'Design',
    what: 'Design: UI / UX, visual or graphic design (设计)',
    title: /designer|\bUI\b|\bUX\b|visual design|graphic|设计师|视觉|平面设计|交互设计/i,
  },
  hardware_industrial: {
    zh: '硬件 / 制造', en: 'Hardware & manufacturing',
    what: 'Hardware, manufacturing, mechanical or electrical engineering of physical products (硬件, 制造, 机械)',
    title: /mechanical|hardware|electrical engineer|embedded|firmware|manufactur|automotive|semiconductor|机械|硬件|嵌入式|制造|汽车|半导体|工艺|产线/i,
  },
  other: {
    zh: '其他', en: 'Other',
    what: 'Something else, or the text does not say what the work is',
    title: null,
  },
};

// 通用路径给 Jev 的级别选项（软件方向仍用 lib/judgements.mjs 的 GRADES）。
export const GRADES = {
  intern: 'Internship or co-op for current students: intern, summer analyst, summer associate, co-op, 实习, 暑期实习, 日常实习. A 实习律师 (a trainee lawyer before admission) is entry, not an internship',
  entry: 'Entry level for new graduates: analyst program, graduate program, new grad, campus hire, early careers, rotational program, junior, assistant, coordinator, 应届, 校招, 管培生, 管理培训生, 助理. Also: an investment-bank Analyst hired from campus or a programme; an audit Associate (审计员, 审计助理, A1 / A2); a paralegal, legal assistant, 律师助理, 实习律师 or trainee solicitor',
  mid: 'No grade word in the title, or an experienced individual role that is not senior: associate, specialist, consultant, analyst (not entry), 专员, 中级. Trade grades that sound senior but are mid: a Big Four audit Senior or 高级审计员 (S1–S3, about 2–5 years); a domestic firm\'s 审计项目经理 (an auditor running engagements, not an IT project manager); an investment-bank Associate; a law-firm associate or 律师 (an admitted lawyer); a 销售经理, 客户经理, 大客户经理 or 客户成功经理, who usually manages no one',
  senior_or_above: 'Senior, Sr., Lead, Principal, Vice President / VP / AVP (a senior individual grade in banks, not an executive), Senior Manager, Senior Consultant, Expert, 资深, 高级, 专家, 主管. Also: a Big Four audit Manager or 审计经理; a law-firm senior associate, 资深律师, 高级律师, or Counsel / 顾问 at a law firm (a senior lawyer, not a consultant)',
  management: 'People or business management: Manager of a team, Director, Executive Director, Managing Director, Head of, Partner, Chief, 经理 (of a department), 总监, 负责人, 合伙人, 首席, 董事, 执行董事, 董事总经理, General Counsel',
};

// ── 方向 ────────────────────────────────────────────────────────────────────
// families：方向以内（推荐的对象）；adjacent：相邻（不在入库前排除，交给判断看 JD）；其余类别在入库前排除。
// internship_weight：没写 experience_summary.years、按经历日期推算年限时，一段实习算几成（软件方向照旧算全额；
// 金融、咨询招聘说的「N 年经验」指全职，实习不算，但实习仍是最重要的证据）。
// certifications：这个方向常见的证书（lib/certifications.mjs 的键），JD 要求而你没有时写成缺口。
// queries：国内门户按关键词搜（lib/ats/cn.mjs），英文站按 query 搜（Workday 等）。
export const DIRECTIONS = {
  software: {
    zh: '工程师', en: 'Engineering',
    blurb: { zh: '后端、前端、全栈、AI 应用与大模型、算法、数据开发、测试开发、客户端、SRE 运维', en: 'Backend, frontend, full-stack, AI applications & LLMs, algorithms, data engineering, test engineering, mobile, SRE' },
    legacy: true,
    families: ['software_engineering'], adjacent: ['data_analytics'],
    // 子方向（选了才生效，见 engineeringTracks）：legacy 是判断层老类别（lib/judgements.mjs FAMILIES）里对应的那一个，
    // allow 是 lib/screening.mjs 以前靠 role_families 里的词才解锁的方向（前端、移动端、测试、算法），title 是标题关键词，
    // queries 是国内门户的搜索词，what 是给判断模型读的说明。
    tracks: {
      backend: { zh: '后端', en: 'Backend', legacy: 'backend_platform', allow: null, what: 'backend and server-side services, platforms, distributed systems', title: /后端|服务端|back.?end|server.?side|平台研发|分布式|微服务|java|golang|go开发|c\+\+开发/i, queries: ['后端', 'Java', 'Go', '服务端', 'C++'] },
      frontend: { zh: '前端', en: 'Frontend', legacy: 'frontend_only', allow: 'frontend', what: 'frontend web applications (React / Vue, performance, component libraries)', title: /前端|front.?end|web开发|react|vue|小程序/i, queries: ['前端', 'React', 'Vue', 'Web'] },
      fullstack: { zh: '全栈', en: 'Full-stack', legacy: 'fullstack', allow: 'frontend', what: 'full-stack product engineering, frontend and backend together', title: /全栈|full.?stack/i, queries: ['全栈', 'Node', 'TypeScript'] },
      ai_application: { zh: 'AI 应用与大模型', en: 'AI applications & LLMs', legacy: 'ai_application', allow: null, what: 'building products on top of LLMs: agents, RAG, tool use, evaluation, AI application engineering', title: /agent|智能体|llm|大模型|ai\s*应用|applied\s*ai|ai\s*engineer|\brag\b|prompt|aigc/i, queries: ['AI', 'Agent', 'LLM', '大模型', 'AI应用'] },
      algorithm: { zh: '算法', en: 'Algorithms & ML', legacy: 'algorithm_or_training', allow: 'research', what: 'algorithms and machine learning: recommendation, search, NLP, CV, model training', title: /算法|machine learning|\bml\b|research (?:scientist|engineer)|推荐|搜索|\bnlp\b|\bcv\b|计算机视觉|模型训练/i, queries: ['算法', '机器学习', '推荐算法', 'NLP'] },
      data_engineering: { zh: '数据开发', en: 'Data engineering', legacy: 'data', allow: null, what: 'data engineering: pipelines, data warehouses, ETL, big-data platforms', title: /数据开发|数仓|数据仓库|data engineer|\betl\b|大数据|spark|flink|hadoop/i, queries: ['数据开发', '数仓', '大数据', 'Spark'] },
      qa: { zh: '测试开发', en: 'Test engineering', legacy: 'qa_ba_pm', allow: 'qa', what: 'test and quality engineering: test automation, SDET, test platforms', title: /测试|\btest|\bqa\b|sdet|质量保障|质量工程/i, queries: ['测试开发', '测试', '自动化测试'] },
      client: { zh: '客户端', en: 'Mobile & client', legacy: 'mobile', allow: 'mobile', what: 'mobile and client apps: iOS, Android, Flutter, HarmonyOS, desktop clients', title: /客户端|\bios\b|android|flutter|react.?native|mobile|移动端|鸿蒙|harmony/i, queries: ['客户端', 'iOS', 'Android', 'Flutter', '鸿蒙'] },
      sre: { zh: 'SRE 运维', en: 'SRE & infrastructure', legacy: 'devops_sre', allow: null, what: 'SRE, DevOps and infrastructure: reliability, cloud platforms, Kubernetes, CI/CD', title: /\bsre\b|运维|devops|基础设施|infrastructure|云平台|云原生|kubernetes|\bk8s\b|可靠性/i, queries: ['SRE', '运维开发', 'DevOps', '云原生'] },
    },
    internship_weight: 1,
    certifications: [],
    // 以前 lib/ats/cn.mjs 写死的那一串，逐字保留（没选子方向时用它）。
    queries: { zh: ['AI', 'Agent', 'LLM', '大模型', '全栈', '后端', 'Node', 'Python', 'Go', '前端'], en: [] },
  },
  finance: {
    zh: '金融', en: 'Finance',
    blurb: { zh: '投行、研究、资管 / 投研、银行、风控 / 合规、量化、销售交易、财务 / 会计', en: 'Investment banking, research, asset management, commercial banking, risk & compliance, quant, sales & trading, corporate finance' },
    families: ['investment_banking', 'asset_management', 'securities_research', 'commercial_banking', 'risk_compliance', 'quant', 'corporate_finance', 'sales_trading'],
    adjacent: ['banking_operations', 'data_analytics', 'consulting', 'audit', 'tax'],
    // 细分的顺序就是卡片上的顺序。原来 6 个的键不变（09-29 的端到端数据用过）；「资管」对应资管和券商研究两个类别，
    // 原来选了资管的人，研究岗照旧算方向以内。
    tracks: {
      investment_banking: { zh: '投行', en: 'Investment banking', family: 'investment_banking' },
      research: { zh: '研究', en: 'Research', family: 'securities_research', queries: { zh: ['研究员', '研究助理', '行业研究', '研究所'], en: ['Equity Research', 'Research Associate'] } },
      asset_management: { zh: '资管 / 投研', en: 'Asset management & research', families: ['asset_management', 'securities_research'] },
      banking: { zh: '银行', en: 'Commercial banking', family: 'commercial_banking', queries: { zh: ['客户经理', '管培生', '对公', '信贷', '交易银行'], en: ['Commercial Banking', 'Relationship Manager', 'Credit Analyst'] } },
      risk: { zh: '风控 / 合规', en: 'Risk & compliance', family: 'risk_compliance' },
      quant: { zh: '量化', en: 'Quant', family: 'quant' },
      sales_trading: { zh: '销售交易', en: 'Sales & trading', family: 'sales_trading' },
      corporate_finance: { zh: '财务 / 会计', en: 'Corporate finance & accounting', family: 'corporate_finance' },
    },
    internship_weight: 0,
    certifications: ['cfa', 'cpa', 'us_cpa', 'acca', 'frm', 'cma', 'caia', 'cfp', 'finra', 'sac', 'amac', 'futures', 'banking_cn', 'legal_cn', 'sponsor_rep', 'sac_advisor', 'hk_sfc', 'cet', 'ielts', 'toefl', 'jlpt'],
    // 名单固定的机构背景（INSTITUTIONS）：JD 要求而你的经历里没有时写缺口。
    institutions: ['big_four'],
    // 职级大概要几年（TRADE_LEVELS 的 finance 那张表）。
    levels: 'finance',
    queries: {
      zh: ['投行', '投资银行', '研究员', '行业研究', '资产管理', '风控', '风险管理', '合规', '财务', '会计', '审计', '量化', '固收', '管培生', '分析师'],
      en: ['Analyst', 'Investment Banking', 'Asset Management', 'Risk', 'Finance', 'Accounting', 'Quantitative'],
    },
  },
  // 2026-10-02 新方向：法律、会计（下面），人力 / 行政、销售 / 商务、项目管理（市场后面）。细分带 what 的，方向那一问
  // 用细分的说明（lib/judgements.mjs generalDirectionQuestion）：法律选了合规，纯风控岗是相邻而不是方向以内。
  legal: {
    zh: '法律', en: 'Legal',
    blurb: { zh: '诉讼 / 仲裁、非诉、公司法务、合规、知识产权', en: 'Litigation & arbitration, transactional, in-house legal, compliance, intellectual property' },
    families: ['legal_practice', 'in_house_legal', 'risk_compliance'],
    adjacent: ['consulting', 'hr'],
    tracks: {
      litigation: { zh: '诉讼 / 仲裁', en: 'Litigation & arbitration', family: 'legal_practice', what: 'litigation, arbitration or dispute resolution at a law firm', queries: { zh: ['诉讼律师', '争议解决', '仲裁', '律师助理'], en: ['Litigation Associate', 'Disputes'] } },
      transactional: { zh: '非诉', en: 'Transactional', family: 'legal_practice', what: 'transactional legal work at a law firm: capital markets, M&A, investment and financing, funds, banking and finance', queries: { zh: ['资本市场律师', '并购律师', '非诉律师', '律师助理'], en: ['Corporate Associate', 'Capital Markets Associate', 'Paralegal'] } },
      in_house: { zh: '公司法务', en: 'In-house legal', family: 'in_house_legal', what: 'in-house legal work inside a company: contracts, disputes, corporate matters, data compliance', queries: { zh: ['法务', '法务专员', '法务经理', '法律顾问'], en: ['Legal Counsel', 'Legal Specialist'] } },
      compliance: { zh: '合规', en: 'Compliance', family: 'risk_compliance', what: 'compliance, anti-money-laundering, regulatory or data and privacy compliance (not credit, market or operational risk management)', only: /compliance|\bAML\b|\bKYC\b|合规|反洗钱|内控/i, queries: { zh: ['合规', '合规专员', '反洗钱', '数据合规'], en: ['Compliance', 'AML', 'Compliance Officer'] } },
      ip: { zh: '知识产权', en: 'Intellectual property', families: ['legal_practice', 'in_house_legal'], what: 'intellectual property: patents, trademarks, copyright, patent agency', queries: { zh: ['知识产权', '专利代理师', '商标', 'IP法务'], en: ['Intellectual Property', 'Patent'] } },
    },
    internship_weight: 0,
    certifications: ['legal_cn', 'lawyer_license', 'patent_agent', 'foreign_bar', 'sac', 'amac', 'cet', 'ielts', 'toefl', 'jlpt'],
    institutions: ['red_circle'],
    levels: 'legal',
    queries: { zh: ['法务', '律师', '律师助理', '法律顾问', '合规', '知识产权'], en: ['Legal Counsel', 'Associate', 'Paralegal', 'Compliance'] },
  },
  accounting: {
    zh: '会计', en: 'Accounting',
    blurb: { zh: '审计、公司会计、财务分析 / FP&A、税务、内审 / 内控', en: 'Audit, accounting, FP&A, tax, internal audit & control' },
    families: ['audit', 'corporate_finance', 'tax'],
    adjacent: ['risk_compliance', 'consulting', 'investment_banking', 'data_analytics'],
    tracks: {
      audit: { zh: '审计', en: 'Audit', family: 'audit', what: 'external audit at an accounting firm', queries: { zh: ['审计', '审计助理', '审计员', '审计师'], en: ['Audit Associate', 'Audit Assistant', 'Assurance'] } },
      accounting: { zh: '公司会计', en: 'Accounting', family: 'corporate_finance', what: 'company accounting: bookkeeping, general ledger, financial statements, cost accounting', queries: { zh: ['会计', '总账会计', '成本会计', '财务专员'], en: ['Accountant', 'Staff Accountant', 'General Ledger'] } },
      fpa: { zh: '财务分析 / FP&A', en: 'FP&A', family: 'corporate_finance', what: 'financial planning and analysis: budgeting, forecasting, business performance analysis', queries: { zh: ['财务分析', 'FP&A', '经营分析', '预算'], en: ['FP&A', 'Financial Analyst'] } },
      tax: { zh: '税务', en: 'Tax', family: 'tax', what: 'tax compliance, tax advisory or transfer pricing', queries: { zh: ['税务', '税务专员', '税务顾问'], en: ['Tax', 'Tax Consultant'] } },
      internal_audit: { zh: '内审 / 内控', en: 'Internal audit & control', families: ['audit', 'risk_compliance'], what: 'internal audit, internal control or SOX compliance inside a company', queries: { zh: ['内审', '内控', '内部审计'], en: ['Internal Audit', 'Internal Control', 'SOX'] } },
    },
    internship_weight: 0,
    certifications: ['cpa', 'us_cpa', 'acca', 'cma', 'tax_agent', 'accounting_title', 'cia', 'cisa', 'cfa', 'cet', 'ielts', 'toefl', 'jlpt'],
    institutions: ['big_four'],
    levels: 'accounting',
    queries: { zh: ['审计', '会计', '税务', '财务分析', '内审', '财务'], en: ['Audit', 'Accountant', 'Tax', 'FP&A', 'Internal Audit'] },
  },
  consulting: {
    zh: '咨询', en: 'Consulting',
    blurb: { zh: '管理咨询、战略、财务 / 技术咨询', en: 'Management, strategy, financial and technology consulting' },
    families: ['consulting'],
    adjacent: ['data_analytics', 'corporate_finance', 'operations', 'product_management', 'investment_banking'],
    internship_weight: 0,
    certifications: ['cpa', 'us_cpa', 'cfa', 'acca', 'pmp', 'legal_cn'],
    institutions: ['big_four'],
    queries: { zh: ['咨询', '管理咨询', '战略', '咨询分析师', '分析师'], en: ['Consultant', 'Business Analyst', 'Strategy', 'Associate'] },
  },
  marketing: {
    zh: '市场', en: 'Marketing',
    blurb: { zh: '品牌、增长 / 投放、内容、新媒体、公关、市场研究', en: 'Brand, growth, content, social media, PR, market research' },
    families: ['marketing'],
    adjacent: ['operations', 'product_management', 'data_analytics'],
    tracks: {
      brand: { zh: '品牌', en: 'Brand', family: 'marketing', what: 'brand marketing: brand strategy, campaigns, brand management', queries: { zh: ['品牌', '品牌经理', '品牌策划'], en: ['Brand', 'Brand Manager'] } },
      growth: { zh: '增长 / 投放', en: 'Growth & paid media', family: 'marketing', what: 'growth and performance marketing: paid media, user acquisition, SEO / SEM', queries: { zh: ['增长', '投放', '信息流', 'SEM'], en: ['Growth Marketing', 'Performance Marketing'] } },
      content: { zh: '内容 / 新媒体', en: 'Content & social media', family: 'marketing', what: 'content marketing and social media: writing, short video, new-media accounts', queries: { zh: ['新媒体', '内容营销', '内容策划', '小红书'], en: ['Content Marketing', 'Social Media'] } },
      pr: { zh: '公关', en: 'PR & communications', family: 'marketing', what: 'public relations and communications: media relations, corporate communications', queries: { zh: ['公关', '媒介', '品牌公关'], en: ['Public Relations', 'Communications'] } },
      market_research: { zh: '市场研究', en: 'Market research', family: 'marketing', what: 'market research and consumer insights', queries: { zh: ['市场研究', '用户研究', '消费者洞察'], en: ['Market Research', 'Consumer Insights'] } },
    },
    internship_weight: 0.5,
    certifications: ['google_analytics', 'google_ads', 'hubspot', 'meta_blueprint'],
    queries: { zh: ['市场', '品牌', '营销', '新媒体', '投放', '增长', '公关'], en: ['Marketing', 'Brand', 'Growth', 'Content', 'Social Media'] },
  },
  hr_admin: {
    zh: '人力 / 行政', en: 'HR & admin',
    blurb: { zh: '招聘、HRBP、薪酬绩效、培训发展、行政、总助 / 秘书', en: 'Recruiting, HRBP, compensation, learning & development, administration, executive assistant' },
    families: ['hr', 'admin'],
    adjacent: ['operations', 'project_management'],
    tracks: {
      recruiting: { zh: '招聘', en: 'Recruiting', family: 'hr', what: 'recruiting and talent acquisition', queries: { zh: ['招聘专员', '招聘', 'HR'], en: ['Recruiter', 'Talent Acquisition'] } },
      hrbp: { zh: 'HRBP', en: 'HRBP', family: 'hr', what: 'HR business partnering: supporting a business unit on people matters', queries: { zh: ['HRBP', '人力资源'], en: ['HRBP', 'HR Business Partner'] } },
      compensation: { zh: '薪酬绩效', en: 'Compensation & performance', family: 'hr', what: 'compensation, benefits, payroll and performance management', queries: { zh: ['薪酬', '绩效', '薪酬福利'], en: ['Compensation', 'C&B', 'Payroll'] } },
      learning: { zh: '培训发展', en: 'Learning & development', family: 'hr', what: 'training, learning and organisational development', queries: { zh: ['培训', '组织发展', '人才发展'], en: ['Learning & Development', 'Training'] } },
      admin: { zh: '行政', en: 'Administration', family: 'admin', what: 'office and facilities administration', queries: { zh: ['行政', '行政专员', '前台'], en: ['Administrative', 'Office Manager'] } },
      // 搜索词按调研里大厂的叫法（部门助理、部门秘书）和常见的总助岗名；「助理」「秘书」单独太宽，「Chief of Staff」多半误中，都不单独用。
      executive_assistant: { zh: '总助 / 秘书', en: 'Executive assistant', family: 'admin', what: 'supporting an executive: executive assistant, secretary, chief of staff', queries: { zh: ['总经理助理', '总裁助理', '董事长助理', '部门助理', '行政助理'], en: ['Executive Assistant'] } },
    },
    internship_weight: 0.5,
    certifications: ['hr_cert', 'economist_hr', 'shrm', 'cipd', 'cet', 'ielts', 'toefl', 'jlpt'],
    queries: { zh: ['招聘', 'HRBP', '人力资源', '薪酬', '培训', '行政', '总经理助理', '部门助理', '行政助理'], en: ['Recruiter', 'HR', 'HRBP', 'Executive Assistant', 'Office Manager'] },
  },
  sales: {
    zh: '销售 / 商务', en: 'Sales & business development',
    blurb: { zh: '大客户 / ToB 销售、渠道销售、商务拓展、销售支持、客户成功', en: 'Enterprise sales, channel sales, business development, sales support, customer success' },
    // 客户成功已经在「销售 / 商务」的标题词里。拿提成的销售（commission_sales）仍在方向以外。
    families: ['sales_bd'],
    adjacent: ['marketing', 'operations'],
    tracks: {
      enterprise: { zh: '大客户 / ToB 销售', en: 'Enterprise sales', family: 'sales_bd', what: 'B2B or key-account sales', queries: { zh: ['大客户销售', '大客户经理', '解决方案销售'], en: ['Account Executive', 'Enterprise Sales'] } },
      channel: { zh: '渠道销售', en: 'Channel sales', family: 'sales_bd', what: 'channel and partner sales', queries: { zh: ['渠道销售', '渠道经理'], en: ['Channel Sales', 'Partner Manager'] } },
      bd: { zh: '商务拓展', en: 'Business development', family: 'sales_bd', what: 'business development: partnerships and new business', queries: { zh: ['商务拓展', 'BD', '商务经理'], en: ['Business Development'] } },
      sales_support: { zh: '销售支持', en: 'Sales support', family: 'sales_bd', what: 'sales support: quotes, contracts, bids and tenders', queries: { zh: ['销售支持', '商务专员', '招投标'], en: ['Sales Operations', 'Sales Support'] } },
      customer_success: { zh: '客户成功', en: 'Customer success', family: 'sales_bd', what: 'customer success and account management after the sale', queries: { zh: ['客户成功', '客户成功经理'], en: ['Customer Success'] } },
    },
    internship_weight: 0.5,
    certifications: ['driver'],
    levels: 'sales',
    queries: { zh: ['销售', '大客户', '商务拓展', '渠道销售', '客户成功', '商务专员'], en: ['Sales', 'Account Executive', 'Business Development', 'Customer Success'] },
  },
  project_management: {
    zh: '项目管理', en: 'Project management',
    blurb: { zh: 'IT / 互联网项目、PMO、工程项目、交付 / 实施', en: 'IT projects, PMO, construction projects, delivery & implementation' },
    families: ['project_management'],
    adjacent: ['operations', 'product_management', 'consulting'],
    tracks: {
      it_project: { zh: 'IT / 互联网项目', en: 'IT projects', family: 'project_management', what: 'IT or internet project management', queries: { zh: ['IT项目经理', '项目经理', '项目助理'], en: ['IT Project Manager', 'Project Manager'] } },
      pmo: { zh: 'PMO', en: 'PMO', family: 'project_management', what: 'a project management office: portfolio tracking, governance, reporting', queries: { zh: ['PMO', '项目管理'], en: ['PMO', 'Program Manager'] } },
      construction: { zh: '工程项目', en: 'Construction projects', family: 'project_management', what: 'construction or engineering project management on site', queries: { zh: ['工程项目经理', '项目经理', '施工管理'], en: ['Construction Project Manager'] } },
      delivery: { zh: '交付 / 实施', en: 'Delivery & implementation', family: 'project_management', what: 'delivery and implementation of systems or services for clients', queries: { zh: ['交付经理', '实施顾问', '项目交付'], en: ['Delivery Manager', 'Implementation Consultant'] } },
    },
    internship_weight: 0.5,
    certifications: ['pmp', 'prince2', 'ruankao_pm', 'constructor'],
    queries: { zh: ['项目经理', '项目管理', 'PMO', '项目助理', '交付经理', '实施顾问'], en: ['Project Manager', 'Project Coordinator', 'PMO', 'Delivery Manager'] },
  },
  product: {
    zh: '产品经理', en: 'Product management',
    blurb: { zh: '产品经理（含 AI 产品）、产品助理、产品分析', en: 'Product manager (incl. AI products), associate PM, product analyst' },
    families: ['product_management'],
    adjacent: ['operations', 'data_analytics', 'marketing', 'design'],
    tracks: {
      ai_product: { zh: 'AI 产品', en: 'AI products', family: 'product_management', title: /\bAI\b|大模型|智能|agent|llm|aigc|算法/i },
    },
    internship_weight: 0.5,
    certifications: ['pmp', 'npdp', 'cspo'],
    queries: { zh: ['产品经理', 'AI产品经理', '产品助理', '产品运营'], en: ['Product Manager', 'AI Product Manager', 'Associate Product Manager', 'Product Analyst'] },
  },
  design: {
    zh: 'UI/UX 设计', en: 'UI/UX design',
    blurb: { zh: 'UI 设计、交互设计、用户体验、视觉设计', en: 'UI design, interaction design, user experience, visual design' },
    families: ['design'],
    adjacent: ['product_management', 'marketing'],
    internship_weight: 0.5,
    certifications: [],
    queries: { zh: ['UI设计', '交互设计', 'UX', '视觉设计', '体验设计'], en: ['Product Designer', 'UX Designer', 'UI Designer'] },
  },
  operations: {
    zh: '运营', en: 'Operations',
    blurb: { zh: '用户运营、内容运营、商业 / 电商运营、战略与运营', en: 'User, content, business and e-commerce operations; strategy & operations' },
    families: ['operations'],
    adjacent: ['marketing', 'product_management', 'data_analytics', 'banking_operations'],
    internship_weight: 0.5,
    certifications: ['pmp'],
    queries: { zh: ['运营', '用户运营', '内容运营', '商业运营', '电商运营', '管培生'], en: ['Operations', 'Business Operations', 'Strategy & Operations'] },
  },
  data: {
    zh: '数据分析', en: 'Data analytics',
    blurb: { zh: '数据分析、商业分析、BI', en: 'Data analyst, business analyst, BI' },
    families: ['data_analytics'],
    adjacent: ['quant', 'risk_compliance', 'product_management', 'operations', 'marketing', 'consulting'],
    internship_weight: 0.5,
    certifications: ['google_analytics', 'tableau', 'cda'],
    queries: { zh: ['数据分析', '商业分析', '经营分析', 'BI'], en: ['Data Analyst', 'Business Analyst', 'Analytics'] },
  },
};
export const DEFAULT_DIRECTION = 'software';

// 方向的行业用语（2026-10-02）：只给离线判断用，看一份标题认不出类别的 JD 是不是完全不在你的方向里。
// 有一个词碰上就算「说不清」，交给判断；一个都碰不上才算明确不在方向里。所以这里宁宽勿窄：写的是这一行
// 天天挂在嘴边的词，不是类别。没写的方向（软件）不做这条。
export const DIRECTION_DOMAIN = {
  finance: /金融|经济|证券|投资|融资|投行|基金|资管|资产|债|股票|股权|宏观|估值|并购|银行|信贷|授信|保险|期货|衍生品|交易|财富|理财|研究报告|行业研究|financ|econom|invest|wealth|securities|equit|credit|bond|\bfunds?\b|asset|portfolio|valuation|banking|capital|trading|macro/i,
  legal: /法律|法学|法务|律师|律所|合规|诉讼|仲裁|合同|知识产权|专利|商标|法规|监管|legal|\blaw\b|counsel|compliance|litigation|contract|patent|trademark|regulat/i,
  accounting: /审计|会计|财务|财会|税|账|报表|底稿|鉴证|内控|注册会计师|\bCPA\b|\bACCA\b|audit|accounting|\btax|financial statement|ledger|IFRS|GAAP|assurance/i,
  consulting: /咨询|顾问|战略|行业研究|调研|解决方案|consult|advis|strateg|client/i,
  marketing: /市场|品牌|营销|推广|传播|内容|新媒体|广告|公关|活动策划|用户增长|marketing|brand|campaign|content|social media|advertis|public relations/i,
  hr_admin: /人力|招聘|人事|员工|薪酬|绩效|培训|行政|办公|会议|接待|档案|秘书|助理|\bHR|recruit|talent|employee|payroll|admin|office|assistant|secretar/i,
  sales: /销售|客户|商务|渠道|签约|拓展|大客户|投标|业绩|sales|client|customer|account|business development|pipeline/i,
  project_management: /项目|进度|交付|实施|里程碑|\bPMO\b|project|delivery|milestone|stakeholder/i,
  product: /产品|需求|原型|功能|迭代|用户体验|product|feature|requirement|roadmap/i,
  design: /设计|视觉|交互|界面|原型|\bUI\b|\bUX\b|figma|design|visual|graphic/i,
  operations: /运营|用户|活动|社群|增长|电商|供应链|operation|community|growth|e-?commerce|supply chain/i,
  data: /数据|分析|报表|指标|统计|\bSQL\b|python|tableau|\bBI\b|data|analy|dashboard|metric|statistic/i,
};

// ── 从 facts 读 ─────────────────────────────────────────────────────────────
const str = (v) => (v == null ? '' : String(v).trim());
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/[\n,，、;；]+/)).map(str).filter(Boolean);
// 页面上、手写时可能写中文名或英文名（「金融」「Finance」）：认得就换成键。
const ALIASES = Object.fromEntries(Object.entries(DIRECTIONS).flatMap(([k, d]) => [[k, k], [d.zh, k], [d.en.toLowerCase(), k]]));
Object.assign(ALIASES, { 软件: 'software', 'ai 工程': 'software', 数据: 'data', 'data analysis': 'data', 'data analyst': 'data', 'product management': 'product', 'consultant': 'consulting' });
// 2026-10-02 新方向的常见叫法。
Object.assign(ALIASES, { 法务: 'legal', 律师: 'legal', 审计: 'accounting', 会计师: 'accounting', 财会: 'accounting', 人力资源: 'hr_admin', 人力: 'hr_admin', 人事: 'hr_admin', hr: 'hr_admin', 行政: 'hr_admin', 'human resources': 'hr_admin', 销售: 'sales', 商务: 'sales', 'business development': 'sales', 项目经理: 'project_management', 项目管理: 'project_management', 'project manager': 'project_management' });
// 只认自己的键（Object.hasOwn）：手改的 facts.yaml 里写成 constructor、__proto__ 也不会被当成方向。
export const directionKey = (v) => { const a = str(v).toLowerCase(), b = str(v); return Object.hasOwn(ALIASES, a) ? ALIASES[a] : Object.hasOwn(ALIASES, b) ? ALIASES[b] : null; };

// 方向列表，第一个是主方向；什么都没写（或写的都不认得）就是 [software]。
export function directionsOf(facts = {}) {
  const p = facts?.preferences || {};
  const raw = [...list(p.directions), ...list(p.direction)];
  const keys = [...new Set(raw.map(directionKey).filter(Boolean))];
  return keys.length ? keys : [DEFAULT_DIRECTION];
}
export const primaryDirection = (facts = {}) => directionsOf(facts)[0];
// 通用路径：主方向不是软件。软件方向（包括「软件 + 数据」这样的组合）走老路径，一条规则不变。
export const isGeneral = (facts = {}) => !DIRECTIONS[primaryDirection(facts)].legacy;
// 细分：只认主方向下面有的键，也认中英文名。
export function tracksOf(facts = {}) {
  const d = DIRECTIONS[primaryDirection(facts)];
  const known = d.tracks || {};
  const byName = Object.fromEntries(Object.entries(known).flatMap(([k, t]) => [[k, k], [t.zh, k], [t.en.toLowerCase(), k]]));
  const find = (t) => (Object.hasOwn(byName, t) ? byName[t] : Object.hasOwn(byName, t.toLowerCase()) ? byName[t.toLowerCase()] : null);
  return [...new Set(list(facts?.preferences?.tracks).map(find).filter(Boolean))];
}
// 方向以内的岗位类别：主方向的 families（选了细分就只算这几个细分），加上「也看」的方向的 families；
// 相邻的是主方向里没选的细分，和各方向 adjacent 里不在方向以内的——相邻的不在入库前排除，但推荐不了，留给你定。
// 例：金融只选了投行、资管，量化岗就是相邻的（以前会当成方向以内，量化开发岗也被推荐）。
// 一个细分对应的类别：families（几个），旧写法 family（一个）照样认。
export const trackFamilyList = (t) => (t ? t.families || [t.family] : []);
export function targetFamilies(facts = {}) {
  const dirs = directionsOf(facts), d = DIRECTIONS[dirs[0]], tracks = tracksOf(facts);
  const primary = tracks.length ? tracks.flatMap((t) => trackFamilyList(d.tracks[t])) : d.families;
  return [...new Set([...primary, ...dirs.slice(1).flatMap((k) => DIRECTIONS[k].families)])];
}
export function adjacentFamilies(facts = {}) {
  const target = new Set(targetFamilies(facts)), dirs = directionsOf(facts);
  return [...new Set([...DIRECTIONS[dirs[0]].families, ...dirs.flatMap((k) => DIRECTIONS[k].adjacent || [])])].filter((f) => !target.has(f));
}
// 细分对应的类别，按你写的顺序（排序加分用）。
export const trackFamilies = (facts = {}) => [...new Set(trackFamilyGroups(facts).flat())];
// 按细分分组（排序加分：第一个细分的所有类别都算「第一个」）。
export const trackFamilyGroups = (facts = {}) => tracksOf(facts).map((t) => trackFamilyList(DIRECTIONS[primaryDirection(facts)].tracks[t]));
export const directionCertifications = (facts = {}) => [...new Set(directionsOf(facts).flatMap((k) => DIRECTIONS[k].certifications || []))];
export const internshipWeight = (facts = {}) => DIRECTIONS[primaryDirection(facts)].internship_weight;
export function directionQueries(facts = {}, lang = 'zh') {
  // 工程师选了子方向：按子方向搜（后端 → 后端、Java、Go……）；没选还是以前那一串。
  const eng = engineeringTracks(facts);
  if (eng.length && lang === 'zh') return [...new Set([...eng.flatMap((t) => DIRECTIONS.software.tracks[t].queries), ...directionsOf(facts).slice(1).flatMap((k) => DIRECTIONS[k].queries?.zh || [])])];
  // 通用方向选了带 queries 的细分：按细分搜（法律选了诉讼 → 诉讼律师、争议解决……），加上「也看」的方向的词。
  const dirs = directionsOf(facts), d = DIRECTIONS[dirs[0]];
  const picked = d.legacy ? [] : tracksOf(facts).map((t) => d.tracks[t].queries?.[lang]).filter((q) => Array.isArray(q) && q.length);
  if (picked.length) return [...new Set([...picked.flat(), ...dirs.slice(1).flatMap((k) => DIRECTIONS[k].queries?.[lang] || [])])];
  return [...new Set(dirs.flatMap((k) => DIRECTIONS[k].queries?.[lang] || []))];
}
// 主方向选了的细分都带 what 时，这些说明（方向那一问用它们，像工程师的子方向一样）；有一个没写就是 null，照旧按类别问。
export function trackWhats(facts = {}) {
  const d = DIRECTIONS[primaryDirection(facts)], tracks = tracksOf(facts);
  if (d.legacy || !tracks.length || !tracks.every((t) => d.tracks[t].what)) return null;
  return tracks.map((t) => d.tracks[t].what);
}
// 工程师的子方向（主方向是工程师、而且写了 tracks 才有）。没写子方向的工程师（作者本人）是空列表：一切照旧。
export const engineeringTracks = (facts = {}) => (primaryDirection(facts) === 'software' ? tracksOf(facts) : []);

// ── 大厂职级对标（仅供参考） ─────────────────────────────────────────────────
// JD 或标题里写了职级代码（「P7」「2-2」「T3」「L5」）时，这一级通常要几年经验（取下限）。各家叫法不同，同一个「T3」
// 在腾讯是资深、在百度是入门，所以只在公司名对得上时才认。只用来推断「这个岗位大概要几年」：明显高出你太多
// 才在入库前挡掉，差得不多写成年限缺口留给你定，不单独一票否决。数字是公开信息的粗略归纳，会有出入。
export const LEVELS = [
  { company: '阿里 / 蚂蚁', match: /阿里|alibaba|蚂蚁|ant group|淘天|饿了么|高德|菜鸟|钉钉/i, code: /(?<![A-Za-z0-9])P(\d{1,2})(?![0-9])/g, years: { 4: 0, 5: 0, 6: 3, 7: 5, 8: 8, 9: 10, 10: 12 } },
  { company: '字节跳动', match: /字节|bytedance|抖音|tiktok|火山引擎|飞书|lark/i, code: /(?<![0-9-])([1-4]-[12])(?![0-9])/g, years: { '1-1': 0, '1-2': 1, '2-1': 3, '2-2': 5, '3-1': 7, '3-2': 9, '4-1': 12, '4-2': 14 } },
  { company: '腾讯', match: /腾讯|tencent|微信|wechat/i, code: /(?<![A-Za-z0-9])T(\d)(?:[-.](\d))?(?![0-9])/g, years: { 1: 0, 2: 2, 3: 5, 4: 8 } },
  { company: '百度', match: /百度|baidu/i, code: /(?<![A-Za-z0-9])T(\d)(?![0-9])/g, years: { 3: 0, 4: 1, 5: 3, 6: 5, 7: 8, 8: 10 } },
  { company: '华为', match: /华为|huawei/i, code: /(?<![0-9])(1[3-9]|2[0-2])\s*级/g, years: { 13: 0, 14: 1, 15: 2, 16: 4, 17: 6, 18: 8, 19: 10 } },
  { company: 'Google', match: /google|谷歌|alphabet/i, code: /(?<![A-Za-z0-9])L(\d)(?![0-9])/g, years: { 3: 0, 4: 2, 5: 5, 6: 8, 7: 10 } },
  { company: 'Meta', match: /\bmeta\b|facebook/i, code: /(?<![A-Za-z0-9])E(\d)(?![0-9])/g, years: { 3: 0, 4: 2, 5: 5, 6: 8, 7: 10 } },
  { company: 'Amazon', match: /amazon|亚马逊|\baws\b/i, code: /(?<![A-Za-z0-9])L(\d)(?![0-9])|SDE\s*(III|II|I)\b/g, years: { 4: 0, 5: 2, 6: 5, 7: 8, I: 0, II: 2, III: 5 } },
  { company: 'Microsoft', match: /microsoft|微软/i, code: /(?<![0-9])(59|6[0-9]|70)(?![0-9])/g, years: { 59: 0, 60: 0, 61: 2, 62: 2, 63: 5, 64: 5, 65: 8, 66: 8, 67: 10 } },
];
// 标题 / JD 里写到的职级要几年（写了几个就取最低的：「P6-P7」按 P6 算）；公司对不上、没写职级就是 null。
export function levelYears(text = '', company = '') {
  const table = LEVELS.find((t) => t.match.test(String(company || '')));
  if (!table) return null;
  const found = [];
  for (const m of String(text || '').matchAll(table.code)) {
    const key = m.slice(1).find((x) => x != null);
    const years = table.years[key] ?? table.years[Number(key)];
    if (years != null) found.push(years);
  }
  return found.length ? Math.min(...found) : null;
}

// ── 行业职级（仅供参考，2026-10-02） ─────────────────────────────────────────────
// 同一个词在不同行业意思不一样：四大的 Senior 是两三年经验的高级审计员，律所的 Associate 是执业律师，银行的 VP 不是高管，
// 「销售经理」「客户经理」多数不带人。下面三张表只在主方向对得上时用（方向的 levels 指到哪张）。
//
// TRADE_GRADES：离线判断（lib/judge-offline.mjs）给标题定级别时先查这张，按顺序第一条命中的算；都不命中再走通用的词。
export const TRADE_GRADES = {
  accounting: [
    ['management', /合伙人|\bpartner\b|\bdirector\b|总监/i],
    ['mid', /审计项目经理|(?:audit|assurance) senior|senior (?:auditor|associate|accountant|consultant)|高级审计(?:员|师)|\bS[1-3]\b/i],
    ['senior_or_above', /审计经理|(?:audit|assurance|tax) manager|高级经理|senior manager|\bmanager\b|经理/i],
    ['entry', /审计(?:助理|员)|audit (?:associate|assistant)|\bA[12]\b/i],
  ],
  legal: [
    ['entry', /律师助理|实习律师|paralegal|legal assistant|trainee/i],
    ['management', /合伙人|\bpartner\b|general counsel|总法律顾问|法务总监/i],
    ['senior_or_above', /资深律师|高级律师|senior associate|顾问律师|律所顾问|(?<!legal |in-house )\bcounsel\b/i],
    ['mid', /律师|\bassociate\b|\blawyer\b|attorney|solicitor/i],
  ],
  finance: [
    ['management', /(?<![A-Za-z])(?:ED|MD)(?![A-Za-z])|executive director|managing director|\bdirector\b|董事总经理|执行董事|董事(?!会|长助理|会秘书)/],
    ['senior_or_above', /vice president|(?<![A-Za-z])A?VP(?![A-Za-z])|副总裁/i],
    ['mid', /\bassociate\b/i],
    ['entry', /\banalyst\b.*(?:program|programme|campus|graduate|class|校招|校园|项目|届)|(?:program|programme|campus|graduate|校招|校园|\d{4}\s*届).*\banalyst\b/i],
  ],
  sales: [
    ['mid', /销售经理|大客户经理|客户经理|客户成功经理|sales manager|account manager|customer success manager/i],
  ],
};
// TRADE_JOB_NAMES：入库前看级别时，先从标题里拿掉的「像级别、其实是岗位名」的词（lib/screening.mjs levelText）。
// 四大的 Audit Senior、内资所的审计项目经理是中级岗；销售经理、客户经理多数不带人。
export const TRADE_JOB_NAMES = {
  accounting: /审计项目经理|(?:audit|assurance|tax) senior|senior (?:auditor|associate|accountant|consultant)|高级审计(?:员|师)/gi,
  sales: /销售经理|大客户经理|客户成功经理|sales manager|account manager|customer success manager/gi,
};
// TRADE_LEVELS：标题里出现这些职级时，这个岗位大概要几年经验（取下限）。和上面大厂职级对标同一个做法：明显高出你太多
// 才在入库前挡掉，差得不多写成年限缺口。数字是公开说法的粗略归纳，仅供参考，会有出入。律所的律师 / Associate 看 JD
// 写的 PQE，这里不推。
export const TRADE_LEVELS = {
  finance: [
    { match: /vice president|(?<![A-Za-z])VP(?![A-Za-z])|副总裁/i, years: 6 }, // 投行 VP / 副总裁：6 年以上（仅供参考）
    { match: /\bassociate\b|高级经理/i, years: 3 }, // 投行 Associate / 高级经理：3–6 年（仅供参考）
    { match: /\banalyst\b|分析师/i, years: 0 }, // 投行 Analyst / 分析师：0–3 年（仅供参考）
  ],
  accounting: [
    { match: /审计经理|\bmanager\b|(?<!项目)经理/i, years: 5 }, // 四大 Manager / 经理：5 年以上（仅供参考）
    { match: /(?:audit|assurance) senior|senior (?:auditor|associate)|高级审计(?:员|师)|\bS[1-3]\b/i, years: 2 }, // 四大 Senior / 高级审计员：2–5 年（仅供参考）
    { match: /审计(?:员|助理)|audit (?:associate|assistant)|\bA[12]\b/i, years: 0 }, // 四大 Associate / 审计员：0–2 年（仅供参考）
  ],
  legal: [
    { match: /资深律师|高级律师|senior associate/i, years: 4 }, // 律所资深律师 / Senior Associate：4 年以上 PQE（仅供参考）
  ],
};
const tradeTable = (table, facts) => table[DIRECTIONS[primaryDirection(facts)]?.levels] || null;
export const tradeGrade = (title = '', facts = {}) => (tradeTable(TRADE_GRADES, facts) || []).find(([, re]) => re.test(String(title || '')))?.[0] || null;
export const tradeJobNames = (facts = {}) => tradeTable(TRADE_JOB_NAMES, facts);
// 标题写的职级大概要几年；主方向没有这张表、或标题里没有这些词就是 null。第一条命中的算（表按从高到低排）。
export function tradeLevelYears(title = '', facts = {}) {
  const hit = (tradeTable(TRADE_LEVELS, facts) || []).find((r) => r.match.test(String(title || '')));
  return hit ? hit.years : null;
}

// ── 名单固定的机构背景（2026-10-02） ───────────────────────────────────────────
// JD 要求（不是「优先」）「四大审计经验」「红圈所经验」时，对照你的经历（current_work.company、career_highlights 的公司）写缺口。
// 名单不固定的（「头部券商」）不在这里，照旧交给判断模型。方向的 institutions 指出看哪几张。
export const INSTITUTIONS = {
  big_four: {
    zh: '四大',
    jd: /四大(?!行|银行|国有|资产|名著|发明)(审计|税务|咨询|会计师事务所)?|\bBig\s*(?:4|Four)\b/i,
    names: /德勤|普华永道|安永|毕马威|deloitte|\bpwc\b|pricewaterhouse|ernst\s*&\s*young|(?<![A-Za-z])EY(?![A-Za-z])|kpmg/i,
  },
  red_circle: {
    zh: '红圈所',
    jd: /红圈(?:所|律所|律师事务所)?|\bred[- ]circle\b/i,
    names: /金杜|方达|君合|中伦|通商|海问|竞天公诚|环球律师|King\s*&\s*Wood|\bFangda\b|\bJun\s*He\b|Zhong\s*Lun|Commerce\s*&\s*Finance|\bHaiwen\b|\bJingtian\b|Global Law Office/i,
  },
};
export const directionInstitutions = (facts = {}) => [...new Set(directionsOf(facts).flatMap((k) => DIRECTIONS[k].institutions || []))];

// 实习：标题 / 职位里带这些词的经历按实习算（年限推算、证据说法）。
export const INTERN_WORDS = /\bintern(?:ship)?\b|实习|summer (?:analyst|associate)|\bco-?op\b|暑期/i;

// 你现在处在哪个阶段：在读（最后一段教育还没结束）、应届（毕业不到 18 个月、全职不满 1 年）、有经验。
// 只看 facts 里写了的日期；什么都推不出来就当有经验（和以前一样，不改变任何规则）。
// 「2022-09」「2022年9月」「2022」；「2023-2027」是两个年份，不是 2023 年 20 月（月份后面不能再跟数字，而且得在 1–12）。
const MONTH = /(\d{4})(?:\s*[-./年]\s*(\d{1,2})(?!\d))?/g;
const NOW_WORD = /至今|今|现在|present|now|current|ongoing|expected|预计/i;
function lastMonth(dates, now) {
  const text = str(dates);
  const tokens = [...text.matchAll(MONTH)];
  if (!tokens.length) return null;
  const t = tokens.at(-1), y = Number(t[1]), m = t[2] && Number(t[2]) >= 1 && Number(t[2]) <= 12 ? Number(t[2]) : 6;
  if (tokens.length < 2 && NOW_WORD.test(text)) return now.getUTCFullYear() * 12 + now.getUTCMonth() + 12;
  return y * 12 + (m - 1);
}
export function graduationMonth(facts = {}, now = new Date()) {
  const ends = (facts?.education || []).map((e) => lastMonth(e?.graduation || e?.dates, now)).filter((x) => x != null);
  return ends.length ? Math.max(...ends) : null;
}
export function candidateStage(facts = {}, years = null, now = new Date()) {
  const status = str(facts?.availability?.current_status).toLowerCase();
  const grad = graduationMonth(facts, now), current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  if (/student|在读|在校/.test(status) || (grad != null && grad > current)) return 'student';
  if (grad != null && current - grad <= 18 && (years == null || years < 1)) return 'new_grad';
  if (/new.?grad|应届|fresh graduate/.test(status)) return 'new_grad';
  return 'experienced';
}
// ── 校招届别（负责人 2026-10-02）────────────────────────────────────────────────
// 「2027届」「27届」「26/27届」「2025-2027届」「2027年应届毕业生」、「毕业时间为 2026年8月至2027年7月」「2026.8-2027.7」、
// 「Class of 2027」「graduating between December 2026 and June 2027」「graduating in 2027」。标题和正文都看。
// 届别按毕业月份算：8 月起算下一届（「毕业时间为 2026.8-2027.7」就是 2027 届），所以 2026 年 5 月毕业是 2026 届、
// 2026 年 12 月毕业是 2027 届。只写了实习年份（「2027 Summer Analyst」）、只写了一个毕业月份、「及以前」这类开口的写法，
// 都算看不出。同一句里还写了「或……经验」的（「2027届硕士或一至两年工作经验」），这一句不算。
export const cohortOfMonth = (m) => Math.floor(m / 12) + (m % 12 >= 7 ? 1 : 0);
const EN_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const yearOf = (s) => { const n = Number(s); return s.length === 2 ? (n >= 20 && n <= 40 ? 2000 + n : null) : n; };
export function postingCohorts(text = '') {
  const cohorts = new Set(), windows = [];
  const sentences = String(text || '').split(/[\n。；;！!？?]|(?<=[.])\s+/);
  for (const s of sentences) {
    if (/(?:或|or\b).{0,30}(?:经验|experience)/i.test(s)) continue;
    const add = (a, b = a) => { if (a && b && b >= a && b - a <= 4) for (let y = a; y <= b; y++) cohorts.add(y); };
    for (const m of s.matchAll(/(?<![\d第])(20\d\d|\d\d)\s*届?\s*(?:([-–—~～至到/、])\s*(20\d\d|\d\d)\s*)?届(?!\s*(?:及|以|之)(?:以)?前|及?以后)/g)) {
      const a = yearOf(m[1]), b = m[3] ? yearOf(m[3]) : a;
      if (m[2] === '/' || m[2] === '、') { add(a); add(b); } else add(a, b);
    }
    for (const m of s.matchAll(/(?<!\d)(20\d\d)\s*年?\s*(?:秋季|春季)?\s*(?:硕士|本科|博士|研究生)?(?:及以上学历)?\s*(?:应届|毕业生)/g)) add(Number(m[1]));
    for (const m of s.matchAll(/\bclass of (20\d\d)\b|\bgraduat\w*\s+(?:in|by)\s+(?:(?:spring|summer|fall|autumn|winter)\s+)?(20\d\d)\b|\b(20\d\d)\s+(?:graduates|grads)\b/gi)) add(Number(m[1] || m[2] || m[3]));
    if (/毕业|graduat/i.test(s)) {
      const months = [];
      for (const m of s.matchAll(/(?<!\d)(20\d\d)\s*[年.\-/]\s*(\d{1,2})(?!\d)/g)) if (Number(m[2]) >= 1 && Number(m[2]) <= 12) months.push(Number(m[1]) * 12 + Number(m[2]) - 1);
      for (const m of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d\d)\b/gi)) months.push(Number(m[2]) * 12 + EN_MONTHS[m[1].toLowerCase()]);
      if (months.length >= 2) windows.push([Math.min(...months), Math.max(...months)]);
    }
  }
  return { cohorts: [...cohorts].sort(), windows };
}
// 你的届别对不上岗位写的届别：返回 { want, mine, text }；看不出届别、你不是在读或应届、资料里没有毕业时间的，返回 null。
export function cohortMismatch(text = '', facts = {}, { years = null, now = new Date() } = {}) {
  if (!['student', 'new_grad'].includes(candidateStage(facts, years, now))) return null;
  const grad = graduationMonth(facts, now);
  if (grad == null) return null;
  const { cohorts, windows } = postingCohorts(text);
  if (!cohorts.length && !windows.length) return null;
  const mine = cohortOfMonth(grad);
  if (cohorts.includes(mine) || windows.some(([a, b]) => grad >= a && grad <= b)) return null;
  const want = [...new Set([...cohorts, ...windows.flatMap(([a, b]) => { const out = []; for (let y = cohortOfMonth(a); y <= cohortOfMonth(b); y++) out.push(y); return out; })])].sort();
  return { want, mine, text: `届别：岗位招 ${want.join('、')} 届，你是 ${mine} 届` };
}
// 实习岗位能不能推：在读可以；否则只有你在方向说明里写了「实习 / intern」才推（和软件方向的老规则同一个词表）。
export function internshipsWanted(facts = {}, stage = candidateStage(facts)) {
  if (stage === 'student') return true;
  const text = [...list(facts?.preferences?.role_families), ...list(facts?.preferences?.tracks)].join('\n');
  return /实习|\bintern/i.test(text);
}

// 标题落在哪些类别（可能不止一个：「资本市场部研究员」同时是投行和投研）。
export function titleFamilies(role = '') {
  const s = String(role || '');
  return Object.entries(FAMILIES).filter(([, f]) => f.title?.test(s)).map(([k]) => k);
}
// 软件方向的离线判断只问「标题像不像别的什么岗位」：用 2026-10-02 之前那几个类别的标题词（新加的类别不算，拆掉的
// 人力 / 行政 / 法务用拆之前的词，分出来的类别只放了原样挪过去的词），这样它的答案一个字都不变。
export const nonEngineeringTitle = (role = '') => Object.values(FAMILIES).some((f) => !f.added && (f.title || f.legacy_title)?.test(String(role || '')));
// 给判断模型、偏好学习用的类别：不含只用来显示旧结果的 legacy 类别。
export const activeFamilies = () => Object.keys(FAMILIES).filter((k) => !FAMILIES[k].legacy);

// 页面、提示里用的名字。
export const directionLabel = (key, lang = 'zh') => DIRECTIONS[key]?.[lang] || DIRECTIONS[key]?.zh || key;
export const familyLabel = (key, lang = 'zh') => FAMILIES[key]?.[lang] || key;
export function directionSummary(facts = {}, lang = 'zh') {
  const dirs = directionsOf(facts).map((k) => directionLabel(k, lang));
  const d = DIRECTIONS[primaryDirection(facts)];
  const tracks = tracksOf(facts).map((t) => d.tracks[t][lang] || d.tracks[t].zh);
  const zh = lang === 'zh', sep = zh ? '、' : ', ';
  const head = tracks.length ? (zh ? `${dirs[0]}（${tracks.join(sep)}）` : `${dirs[0]} (${tracks.join(sep)})`) : dirs[0];
  return [head, ...dirs.slice(1)].join(zh ? ' + ' : ' + ');
}
