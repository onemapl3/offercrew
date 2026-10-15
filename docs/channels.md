# 找岗位的渠道：哪些能自动读，哪些要靠你转发

> 调研日期：2026-09-29。网站会改版，这里的结论不是永久的。每一条都写了当天实际看到了什么；
> 以后某个渠道的表现和这里不一样，按第三节「怎么核对的」重新看一遍就行。
>
> 2026-10-01、10-02 按金融、法律、会计等新方向的调研改了几处过时的结论（花旗 Workday 站点 2、国泰海通、广发证券、
> 中信银行、Lazard、巴克莱、北森老版、中信证券、大易新版、高盛），第十节是这次新加的四个公司包。

这份文档写给第一次用 OfferCrew 的非程序员。比如今年从纽约大学毕业、学金融、正在投简历的学生；
或者国内金融、咨询、市场、运营、数据分析方向的应届生。你平时找工作会用到很多网站：Handshake、
LinkedIn、公司官网、实习僧、应届生求职网、各家银行和券商的校招系统……这份文档逐个回答三个问题：

1. OfferCrew 能不能替你定时去看这个网站上的新岗位？
2. 能看的，它是怎么看的？不能看的，为什么不能？
3. 不能自动看的渠道，你怎么把岗位交给它？

---

## 一、先把几个词讲清楚

**招聘系统（ATS）。** 大公司一般不会从零写自己的招聘网站，而是买一套现成的系统来发布岗位、收简历，
英文叫 Applicant Tracking System，简称 ATS。你在摩根大通官网点「搜索职位」，打开的其实是甲骨文
（Oracle）的招聘系统；在美国银行点「校园项目」，打开的是 Oleeo 的系统；国内的券商、基金公司很多用
北森（网址都是 `某某.zhiye.com`）或 Moka。同一个系统背后有成百上千家公司，所以只要弄明白一个系统怎么读，
这些公司就都能读。OfferCrew 因此按「招聘系统」而不是按「公司」来写读取程序。每一种系统对应的读取程序叫
**适配器**，放在 `lib/ats/` 下面；你在 `config/companies.yaml` 里给每家公司写上它用哪种适配器
（`ats_type`）和它在那个系统里的编号，扫描时就会去读。

**公开接口。** 现在的招聘网页，大多是先打开一个空的页面框架，再由页面里的程序去服务器要一份岗位数据
（通常是 JSON，一种程序之间传数据用的文本格式），然后画到屏幕上。这份数据，任何人不登录、打开网页时，
浏览器都会替他去要。我们说的「公开接口」就是它：OfferCrew 读到的，和你的浏览器打开页面时拿到的一模一样，
不多拿一条。有的系统还专门提供给外人用的接口或**订阅源**（feed，一种给阅读器和程序订阅更新用的标准格式），
那就更明确是欢迎程序来读的。

**robots.txt。** 每个网站的根目录下可以放一个叫 robots.txt 的文本文件，告诉自动程序（俗称爬虫）哪些地方
可以来、哪些地方别来。比如：

```
User-agent: *
Disallow: /search-jobs/
```

意思是「对所有程序（`*`）：不要访问以 /search-jobs/ 开头的地址」。`Allow` 是允许；`Crawl-delay: 10`
是「两次访问之间至少隔 10 秒」。robots.txt 不是技术上的锁，而是网站主人写明的意愿。我们照它办：
它说别来的地方，OfferCrew 就不去。请求这个文件得到 404（不存在），通常表示网站没有设限制。

**服务条款。** 你注册或使用网站时同意的那份长协议。很多求职平台在条款里写明「不许用机器人、脚本抓取」。
条款不许的事，就算技术上做得到，我们也不做。

**反爬。** 网站用来挡住自动程序的技术手段。这份文档里会碰到这几种：

- **挑战页**：打开网站时先看到「Just a moment…」「Quick Check Needed」「请稍候」之类的页面，要浏览器先跑一段
  脚本、证明自己是真人用的浏览器才放行。最常见的是 Cloudflare（一家网络安全公司）的挑战页。
- **WAF 拦截**：WAF 是 Web 应用防火墙，它判断请求可疑，就直接返回 403（禁止访问）或一页校验脚本。
- **字体加密**：页面上的文字和数字用网站自造的字体显示。网页源码里是一串看不懂的「私用区」字符
  （比如 `&#xe0d2`），只有加载它的字体文件才显示成正常文字。
- **签名参数**：请求地址里带一长串随时间、随会话变化的加密参数，没有页面里的算法就拼不出来。
- **验证码组件**：页面加载第三方验证码服务（比如网易易盾），随时可能弹出滑块或点选。

碰到任何一种，我们的做法都一样：记下「有反爬」，**不绕过**，这个渠道的结论就是「不做」。

**服务端渲染和脚本渲染。** 服务端渲染的页面，网页源码里直接就有岗位标题和描述，程序读源码就能读到；
脚本渲染的页面，源码里只有一个空框架，内容要等页面里的程序去公开接口取数据。前者要解析网页，后者要读接口。

**低频。** OfferCrew 读一个来源，每轮扫描只发几次到几十次请求（看这家公司有多少岗位），一天跑三轮。
每次请求都带着标明自己是谁的请求头（User-Agent），不登录，也不带你的 cookie（网站存在你浏览器里、
用来认出你的小文件）。这和一个人每天打开几次招聘页差不多，不给对方的服务器添负担。

---

## 二、三种结论各是什么意思

每个渠道最后只给三种结论之一。

1. **可以读（只读公开页，低频）**：不登录就能看到岗位列表和详情；robots.txt 不禁止；条款不禁止；没有反爬。
   OfferCrew 会定时去读，新岗位进收件箱，由你决定投不投。
2. **只能靠你转发链接或邮件提醒**：列表读不了（要登录、robots.txt 禁止，或者条款禁止批量读取），
   但你自己在网站上看到一个岗位，可以把它的链接转给 OfferCrew；或者在那个网站上设好「职位提醒」邮件，
   让提醒发到你的 Gmail，OfferCrew 从提醒邮件里取出岗位链接。
3. **不做**：有反爬、条款明确禁止自动化，或者读了会给你的账号带来风险。OfferCrew 不碰它，你照常自己用。

---

## 三、怎么核对的

2026-09-29 这一天，用 curl（一个命令行下载工具）和 Node.js，逐个打开下面这些网站的公开页面和 robots.txt：

- 请求头 User-Agent 用的是 `lib/ats/http.mjs` 里那个标明自己身份的字符串，不伪装成浏览器；
- 不登录，不带任何 cookie，不碰要登录的页面；
- 每个网站只发几次请求，两次之间隔几秒；robots.txt 写了 Crawl-delay 的，按它的间隔来；
- 遇到挑战页或拦截，记下来就停手，不换身份再试。

公司太多，没法全查，所以美国和国内各抽了二十来家有代表性的机构，实际打开它们的招聘入口，看落在哪个系统上。
找入口时用过搜索引擎（它只告诉我们地址，不代替核对）；下文写「当天看到」的，都是自己请求得到的结果。
服务条款只概括大意，想看原文请去对方网站。

---

## 四、一览表

| 渠道 | 地区 | 结论 | 一句话理由 |
| --- | --- | --- | --- |
| Handshake | 美国 | 只能靠你转发链接或邮件提醒 | 搜索要登录；条款禁止第三方用脚本批量收集岗位 |
| LinkedIn | 美国 | 只能靠你转发链接或邮件提醒 | robots.txt 对所有程序 `Disallow: /`；条款禁止抓取 |
| Indeed | 美国 | 只能靠你转发链接或邮件提醒 | robots.txt 禁止岗位详情页 `/viewjob`；条款禁止机器人和 AI 代理 |
| Workday、Greenhouse、Lever、Ashby、SmartRecruiters | 美国为主 | 可以读 | 早已支持 |
| Oracle Cloud HCM（摩根大通等） | 美国 | 可以读 | 页面自己用的公开接口，不登录；这次新做了 `oracle` 适配器 |
| Oleeo / tal.net（美国银行校招等） | 美国 | 可以读 | 每块岗位板有公开的 Atom 订阅源；这次新做了 `oleeo` 适配器 |
| Eightfold（摩根士丹利、花旗、Capital One） | 美国 | 不做 | 接口对不带页面会话的请求一律返回 403 |
| SAP SuccessFactors（安永） | 美国 | 可以读（还没做） | 服务端渲染，robots.txt 不禁止搜索页 |
| Avature（德勤美国） | 美国 | 可以读（还没做） | 服务端渲染，robots.txt 允许 `/careers` |
| Phenom（BCG 等） | 美国 | 可以读（还没做） | 搜索页源码里嵌着岗位数据；很多背后就是 Workday |
| iCIMS | 美国 | 可以读（还没做） | 服务端渲染，robots.txt 不禁止 `/jobs/search` |
| Taleo | 美国 | 只能靠你转发链接（未核实） | 部分租户在本机网络上连不通；巴克莱已经换到 Workday |
| 公司自建（贝恩、麦肯锡） | 美国 | 只能靠你转发链接 | 没有通用读法 |
| 高盛 | 美国 | 可以读（`oracle`） | 门面 higher.gs.com 只放行单个岗位页；背后 Oracle 主机的公开接口能读，负责人 10-02 定了读 |
| 实习僧 | 国内 | 不做 | 字体加密、加速乐防护，条款禁止爬虫和第三方工具 |
| 应届生求职网 | 国内 | 只能靠你转发链接 | 首页公告能读，但职位搜索和条款页在 WAF 挑战后面 |
| 牛客 | 国内 | 只能靠你转发链接 | 列表靠内部接口；robots.txt 禁止 `/search` |
| BOSS 直聘 | 国内 | 不做 | 条款禁止自动化；robots.txt 禁止所有带参数的地址 |
| 智联招聘（校园） | 国内 | 只能靠你转发链接 | robots.txt 禁止所有带参数的地址；列表是脚本渲染 |
| 前程无忧（校园） | 国内 | 不做 | 搜索页先加载阿里的风控脚本 |
| 国聘 | 国内 | 只能靠你转发链接（接口待核） | robots.txt 不限制，但页面是脚本渲染，接口没核实 |
| 北森（zhiye.com） | 国内 | 可以读 | 早已支持社招；这次加了校招、实习 |
| Moka | 国内 | 可以读 | 早已支持社招；这次加了校招 |
| 飞书招聘 | 国内 | 可以读 | 早已支持 |
| 北森老版门户 | 国内 | 可以读（还没做） | 没有 JSON 接口，但页面服务端渲染、不登录能看，写网页解析就能读 |
| 大易 hotjob 新版 | 国内 | 可以读 | 两个公开接口，不登录、没有签名；10-02 新做了 `hotjob` 适配器 |
| 大易 hotjob 老版（/wt/） | 国内 | 只能靠你转发链接 | 翻页要页面每次下发的令牌，不做 |
| 银行自建系统（工、农、中、建、交、招、平安） | 国内 | 只能靠你转发链接 | 每家自建、脚本渲染，没有通用读法 |
| 中信证券 | 国内 | 只放入口 | 页面加载网易易盾验证码组件，前面还有一层 WAF；不自动读，入口给你自己打开 |

---

## 五、美国：逐个说

### 1. Handshake

**是什么、谁在用。** 美国大学生用得最多的校园招聘平台。学校的就业中心（career center）和它合作，
学生用学校邮箱注册，雇主在上面发实习、全职和校园活动。纽约大学的学生找实习和第一份工作，第一站往往就是它。

**不登录能看到什么。** 搜索和岗位列表都要登录。不过 Handshake 为了让搜索引擎收录，给一部分岗位做了公开页，
地址形如 `app.joinhandshake.com/public/jobs/<编号>`。我们打开了一个：页面里带着标准的职位结构化数据
（JobPosting：标题、雇主、城市、发布日期、描述、薪资范围）。这些公开页列在它 robots.txt 声明的站点地图里，
站点地图拆成 4 个文件，我们打开的第一个就有 25000 个编号——但只有编号，没有标题和城市。

**robots.txt。** 主站 joinhandshake.com 对普通程序不设限制（`User-agent: *` 后面是空的 `Disallow:`），
同时点名拦了一批 AI 和抓取程序。真正放岗位的 app.joinhandshake.com 只放行少数页面，比如 `Allow: /public`、
`Allow: /jobs/*/share_preview`，其余 `Disallow: /`。

**服务条款。** 写明不允许第三方用自动化脚本批量收集学生、雇主、职位描述等平台信息（scraping）。

**反爬。** 应用站和帮助中心都在 Cloudflare 后面；帮助中心对我们的请求直接返回了挑战页。

**结论：只能靠你转发链接或邮件提醒。** 想找到金融岗，就得把两万多个公开页一个个打开，这正是条款禁止的批量收集。
你在 Handshake 上看中一个岗位，点「分享」拿到公开链接转给 OfferCrew，它只读这一页。

**职位提醒邮件。** Handshake 能把「保存的搜索」设成邮件提醒。OfferCrew 读提醒邮件按发件人白名单来
（`lib/alerts.mjs`），只认名单上的确切地址，防止别人伪造一封「提醒」塞链接进来。Handshake 帮助中心讲发件地址的
几篇文章对我们返回了挑战页，读不到原文；搜索引擎的摘要里出现过几个地址和域名，但分不清哪一个专门发职位提醒，
所以这次**没有**把 Handshake 加进默认白名单。你收到第一封 Handshake 职位提醒后，看一下发件人那一行尖括号里的地址，
把它写进本机的 `config/alert-senders.json`（一个 JSON 数组，比如 `["<那个地址>"]`），OfferCrew 就会一起读。
提醒里的链接如果要登录才能看，会在你登录好的专用 Chrome 里打开。

### 2. LinkedIn

**是什么。** 全球最大的职业社交网站，也是美国最常用的职位搜索之一。

**robots.txt。** 先列了一长串被点名的爬虫，最后是 `User-agent: *` 加 `Disallow: /`：没有被单独允许的程序，
整个网站都不要来。文件末尾的注释说，想爬要先写信申请白名单。我们因此没有去打开它的职位页。

**服务条款。** 用户协议禁止开发或使用软件、脚本、机器人、爬虫、浏览器插件去抓取或复制 LinkedIn 上的内容。

**结论：只能靠你转发链接或邮件提醒。** OfferCrew 本来就不直接访问 linkedin.com（`lib/ats/http.mjs` 把它列为
不直接访问的站点）。你在 LinkedIn 上设好 Job Alert，提醒发到你的 Gmail；OfferCrew 从
`jobalerts-noreply@linkedin.com`、`jobs-noreply@linkedin.com` 发来的邮件里取出职位链接，这些链接
在你自己登录好的专用 Chrome 里打开。

### 3. Indeed

**是什么。** 美国流量最大的职位搜索引擎，把各公司官网和招聘系统里的岗位汇总到一处。

**robots.txt。** 对 `*` 大体是 `Allow: /`，但明确写了 `Disallow: /viewjob`（岗位详情页）和 `Disallow: /rc/`
（跳转到岗位的链接）——恰好就是职位提醒邮件里的那两种链接。

**服务条款。** 禁止用任何自动化系统访问或挖掘网站数据，条款里点名了机器人、爬虫、蜘蛛、AI 和「Agentic AI」
（能替人操作的 AI 代理），只按 robots.txt 有条件地允许爬取；还写明会用技术手段检测和阻止未经授权的自动访问。
网站本身在 Cloudflare 后面。

**结论：只能靠你转发链接或邮件提醒。** 提醒邮件照样读，但这次改了 `lib/alerts.mjs`：indeed.com 的链接和
LinkedIn 一样，标成「要在专用 Chrome 里打开」，不再由程序直接去读。其实 Indeed 上的岗位大多转载自公司官网，
同一个岗位在官网的招聘系统里往往能直接读到；把那家公司加进 `config/companies.yaml` 更省事。

### 4. 公司官网：按招聘系统分

对美国金融应届生来说，最重要的反而是公司官网：投行、资管、四大、咨询公司的校招项目几乎都只在官网上申请。
下面按招聘系统讲，最后一小节是逐家核对的结果。

#### 已经支持的五种

- **Workday**：美国大银行和资管公司最常用。每家公司一个「租户」，比如美国银行是 `ghr.wd1.myworkdayjobs.com`。
  robots.txt 由租户自己写，美国银行的写法是逐个放行公开职位站（如 `Allow: /Lateral-US/`），只禁止几个内部站。
  页面自己调用的 `/wday/cxs/…/jobs` 接口不登录就能用。很多银行还有专门的校招站，比如 Blackstone 的
  `Blackstone_Campus_Careers`、Houlihan Lokey 的 `Campus`、Raymond James 的 `RaymondJamesEarlyCareers`。
- **Greenhouse**：`boards.greenhouse.io` 只禁止 `/embed/`；OfferCrew 读的是它官方公开的 Job Board API。
- **Lever**：`Allow: /`，`Crawl-delay: 1`；读的是官方的 postings API。
- **Ashby**：职位页所在的 `jobs.ashbyhq.com` 禁止 `/api/`（那是页面自用的内部接口）；OfferCrew 读的是
  另一个域名上官方公开的 posting API，不走被禁止的路径。
- **SmartRecruiters**：请求 robots.txt 得到 404（没有限制）；读的是官方公开的 Posting API。

#### Oracle Cloud HCM：这次新做了 `oracle`

**是什么。** 甲骨文的云端人力资源系统，对外的职位网站叫 Candidate Experience。摩根大通（JPMorgan Chase）全球的岗位，
包括给应届生的 Analyst / Associate Program 和暑期实习，都在 `jpmc.fa.oraclecloud.com` 这个站点上（站点编号 CX_1001）。

**不登录能看到什么。** 能搜，也能看详情。页面是脚本渲染，数据来自两个公开接口：列表
`recruitingCEJobRequisitions` 和详情 `recruitingCEJobRequisitionDetails`。当天这个站点一共 7480 个岗位；
只看美国、只看「Program Analysts & Associate」（给应届生和早期职业的项目岗）是 161 个。接口支持按地点、按类别筛选，
所以不用把几千个岗位全翻一遍。

**robots.txt。** 摩根大通这个站点请求 /robots.txt 被甲骨文的 WAF 挡回（403，「Blocked by WAF4SaaS」），
读不到内容；另一家的甲骨文站点返回 404（没有这个文件）。同一个请求头打开职位页和接口都正常返回，
说明挡的是那个地址，不是挡我们。

**条款和反爬。** 这是摩根大通的招聘网站，我们只读它给所有访客看的职位信息，低频，不提交任何东西；没有遇到挑战。

**结论：可以读。** 新做的 `lib/ats/oracle.mjs` 读列表，匹配前再按需读详情取完整描述；写法见
`config/companies.example.yaml` 末尾的示例。

#### Oleeo（tal.net）：这次新做了 `oleeo`

**是什么。** 英国公司 Oleeo 的招聘系统，网址都是 `<公司>.tal.net`，在投行和资管的**校园招聘**里很常见。
美国银行（Bank of America）的全球校招项目、Jefferies 的校招、Rothschild & Co 的学生项目、Lazard 的学生项目都在上面。

**不登录能看到什么。** 岗位板和岗位详情都是服务端渲染。更好的是，每块岗位板都有一个公开的 Atom 订阅源，
地址形如 `…/candidate/jobboard/vacancy/<板号>/feed`，一次请求就拿到整块板上的全部岗位：当天美国银行「Global Programs」
149 个（94 个暑期实习、31 个非暑期实习、18 个全职、6 个 industrial placement，即英国大学生的一年期实习），Jefferies「Campus Opportunities」61 个，
Rothschild & Co「Student Opportunities」30 个，Lazard「Students」这块板当天是空的。
（2026-10-01 复核：Lazard 已经从 Oleeo 换到 Oracle Cloud HCM，社招站 CX_1、学生站 CX_2，用 `oracle` 读。）

**robots.txt（各家相同）。** 禁止 `/*/agent/`、`/*/ats/`、`/*/channel/`（猎头和内部入口），`Crawl-delay: 10`；
另外点名禁止了几个 AI 训练爬虫。我们读的候选人岗位板不在禁止之列，并且严格守 10 秒的间隔。

**反爬。** 摩根士丹利的校招板（`morganstanley.tal.net`）对我们返回「Quick Check Needed」挑战页，不做；
BlackRock 的板没有订阅源（404）；BNP Paribas 的订阅源地址返回的是网页，不是订阅源。

**结论：可以读（有订阅源的板）。** 新做的 `lib/ats/oleeo.mjs` 每轮只读一次订阅源；订阅源里的描述是截断的，
匹配前再打开这一个岗位的详情页取全文。详情是一条一条按需取的，间隔远大于 10 秒。

#### Eightfold

**是什么。** 一家做「AI 人才平台」的公司，职位站地址形如 `<公司>.eightfold.ai/careers`。摩根士丹利、
花旗（`citi.eightfold.ai`）、Capital One（`capitalone.eightfold.ai`）的职位搜索都用它；微软也是
（OfferCrew 现有的 `microsoft` 适配器就是它，要借你登录好的浏览器）。

**robots.txt。** 其实很开放：`Allow: /careers`、`Allow: /api/apply`、`Allow: /api/pcsx`。

**但是。** 直接请求它的职位接口，返回 403「Not authorized for PCSX」：接口要求先由页面建立会话（发 cookie），
不带会话就不给数据。我们不带 cookie，也不模拟浏览器去拿会话。

**结论：不做。** 这些公司往往另有一个能读的系统：Capital One 的申请走 Workday（`capitalone.wd12.myworkdayjobs.com`）。

#### SAP SuccessFactors

**是什么。** SAP 的人力资源套件，对外职位站大多用它的 Career Site Builder。安永（EY）全球的职位在
`careers.ey.com`，页面的 cookie 说明里写着网站基于 SAP SuccessFactors。

**能看到什么。** 服务端渲染：搜索结果页（`/ey/search/?q=…&locationsearch=…`）直接列出职位名、地点和日期，
详情页也是。当天搜「Analyst」+「New York」有 111 个结果，每页 25 个。

**robots.txt。** 禁止 `/services/`、`/talentcommunity/`、`/applybutton/` 等，搜索页和岗位页不在其中。
SuccessFactors 自带的 RSS 就在 `/services/` 下面，所以只能解析搜索页，不能用 RSS。

**结论：可以读（这次没做）。** 要做就得解析网页；安永是四大之一，值得排进下一批。

#### Avature

**是什么。** 另一家大型招聘系统。德勤美国的职位站 `apply.deloitte.com` 就是它。

**能看到什么。** 服务端渲染，搜索页第一页就列出岗位（当天总数显示 999+），每条带公司、业务线和城市。

**robots.txt。** `Allow: /careers`，只禁止带 `qtvc=` 参数的地址（那是跟踪参数）。

**结论：可以读（这次没做）。**

#### Phenom

**是什么。** 做「职位站门面」的公司。波士顿咨询（BCG）的职位站就是它做的，不少银行、资管公司也用。

**能看到什么。** 搜索页的网页源码里嵌着一份岗位数据（名为 `eagerLoadRefineSearch`，第一页十条，带总数）。

**robots.txt。** 禁止申请、跟踪脚本、聊天机器人等路径；BCG 另外禁止 `/search-results/x*`。普通搜索页不在其中。

**结论：可以读（这次没做）。** 很多 Phenom 门面背后的申请系统就是 Workday：页面上的申请链接指向那家公司的
Workday 站点时，直接用 `workday` 适配器读更简单。

#### iCIMS

**是什么。** 中型银行、资管和地产投资公司常用的系统，地址形如 `careers-<公司>.icims.com`，比如 City National Bank、
Marathon Asset Management、Hines。

**能看到什么。** 加 `in_iframe=1` 参数时，职位列表是服务端渲染的网页。

**robots.txt。** 禁止登录、推荐、候选人相关路径（例如 `Disallow: /jobs/*login`），`/jobs/search` 不在其中。

**结论：可以读（这次没做）。**

#### Taleo

**是什么。** 甲骨文的上一代招聘系统，地址形如 `<公司>.taleo.net/careersection/…`。Barclays、Kearney（咨询）、
美联储理事会还在用。

**当天的情况。** Kearney 的 robots.txt 返回 404（没有限制）；它的职位接口 `/careersection/rest/jobboard/searchjobs`
用 GET 请求返回 405，说明要照页面的做法用 POST。Barclays 的 Taleo 在本机网络上连不通（加密握手失败），没能核实。
（2026-10-01 复核：巴克莱已经换到 Workday，`barclays.wd3`，站点 External_Career_Site_Barclays，robots 放行，用 `workday` 读。）

**结论：只能靠你转发链接（未核实）。**

#### Radancy（TalentBrew）门面

花旗（`jobs.citi.com`）、BlackRock（`careers.blackrock.com`）、Capital One（`capitalonecareers.com`）的
「官网招聘页」是 Radancy 做的门面。三家的 robots.txt 都是 `Disallow:/search-jobs/`：搜索页不让程序读。
真正的岗位在门面背后的系统里（BlackRock、Capital One 是 Workday），我们读背后的系统，不读门面的搜索页。

#### 公司自建

- **高盛（higher.gs.com）**：robots.txt 只写了 `Allow: /roles/`（单个岗位页），其余 `Disallow: /`；
  岗位列表在不让读的 `/results`。申请按钮指向 Oracle Cloud HCM（`hdpc.fa.us2.oraclecloud.com`，站点编号 CX_3002），
  那台主机没有 robots.txt；负责人 2026-10-02 定了读 Oracle 主机上的公开接口（`oracle`），门面照旧不读。
- **贝恩（bain.com/careers/find-a-role）**：页面能打开，robots.txt 只禁止带筛选参数的地址；它是一家公司的自建页面，
  这次没有专门写读取程序。只能靠你转发链接。
- **麦肯锡**：请求职位搜索页时连接被对方中途断开，没能打开。只能靠你转发链接（未核实）。
- **毕马威美国（kpmguscareers.com）**：连 robots.txt 都先返回「One moment, please...」挑战页。不做。

### 5. 大银行、资管、四大、咨询公司：逐家核对

下表是当天实际打开各家招聘入口看到的结果。「能不能读」一栏是指 OfferCrew 现在能不能定时读它。

| 机构 | 看到的招聘系统 | 能不能读 | 备注 |
| --- | --- | --- | --- |
| 摩根大通 JPMorgan Chase | Oracle Cloud HCM（`jpmc.fa.oraclecloud.com`，CX_1001） | 可以读（`oracle`） | 校招项目和暑期实习都在这个站点 |
| 美国银行 Bank of America | 社招 Workday（`ghr.wd1`，Lateral-US）；校招 Oleeo（`bankcampuscareers.tal.net`） | 可以读（`workday`、`oleeo`） | |
| 摩根士丹利 Morgan Stanley | Eightfold；校招 Oleeo（`morganstanley.tal.net`） | 不做 | Eightfold 接口 403；校招板有挑战页 |
| 高盛 Goldman Sachs | 门面 `higher.gs.com`；申请走 Oracle（`hdpc.fa.us2.oraclecloud.com`，CX_3002） | 可以读（`oracle`） | 门面 robots.txt 只放行单个岗位页，不读门面；读 Oracle 主机的公开接口（负责人 10-02 定的），只有社招 |
| 花旗 Citi | Radancy 门面 + Eightfold 搜索；申请走 Workday（`citi.wd5`，站点 `2`） | 不读（robots 禁止） | 2026-10-01 复核：Workday 的 robots.txt 现在 `Disallow: /2/`，推翻了 09-29 的「可以读」；门面和 Eightfold 也不读 |
| 富国银行 Wells Fargo | 门面 `wellsfargojobs.com` 有 Cloudflare 挑战；申请走 Workday（`wf.wd1`，WellsFargoJobs） | 可以读（`workday`） | 门面不读；Workday 搜「Early Careers」有 1291 个，同样要按地点筛 |
| BlackRock | Radancy 门面；Workday（`blackrock.wd1`，BlackRock_Professional）；Oleeo 板没有订阅源 | 可以读（`workday`） | 搜「Analyst」48 个 |
| Blackstone | 官网有 Cloudflare 挑战；Workday 校招站（`blackstone.wd1`，Blackstone_Campus_Careers） | 可以读（`workday`） | 校招站当天 32 个 |
| 富达 Fidelity | 门面 `jobs.fidelity.com` 有 Cloudflare 挑战 | 不做（门面） | |
| Capital One | Radancy 门面 + Eightfold + Workday（`capitalone.wd12`，Capital_One） | 可以读（`workday`） | 搜「Development Program」738 个，要按地点筛 |
| Jefferies | Oleeo（`jefferies.tal.net`） | 可以读（`oleeo`） | 校招板 61 个岗位 |
| Rothschild & Co | Oleeo（`rothschildandco.tal.net`） | 可以读（`oleeo`） | 学生项目 30 个 |
| Lazard | Oracle（`icbpjb.fa.ocs.oraclecloud.com`，社招 CX_1、学生 CX_2） | 可以读（`oracle`） | 2026-10-01 复核：已经从 Oleeo 换到 Oracle |
| Evercore | Oleeo（`evercore.tal.net`，社招板 3、学生板 2） | 可以读（`oleeo`） | 订阅源没有城市栏目，要写 `unlisted_city: keep`；robots.txt `Crawl-delay: 10` |
| 德意志银行 Deutsche Bank | `careers.db.com` 自己的搜索用 BeeSite；Workday（`db.wd3`，DBWebsite） | 可以读（`workday`） | Workday 的 robots.txt 放行 DBWebsite |
| 巴克莱 Barclays | Workday（`barclays.wd3`，External_Career_Site_Barclays） | 可以读（`workday`） | 已经不是 Taleo；校招和社招同站 |
| 德勤美国 Deloitte US | Avature（`apply.deloitte.com`） | 可以读（还没做） | |
| 普华永道 PwC | 门面在本机网络上握手失败 | 未核实 | |
| 安永 EY | SAP SuccessFactors（`careers.ey.com`）；校园活动用 Yello | 可以读（还没做） | |
| 毕马威美国 KPMG US | 门面有挑战页；校园活动用 Yello | 不做 | |
| 麦肯锡 McKinsey | 自建 | 只能靠你转发链接（未核实） | 连接被断开 |
| 波士顿咨询 BCG | Phenom（`careers.bcg.com`） | 可以读（还没做） | |
| 贝恩 Bain | 自建 | 只能靠你转发链接 | |
| City National Bank | iCIMS | 可以读（还没做） | |
| Houlihan Lokey | Workday 校招站（`hl.wd1`，Campus） | 可以读（`workday`） | 当天 32 个 |
| M&T Bank | Workday 校招站（`mtb.wd5`，Campus） | 可以读（`workday`） | 当天 45 个，有纽约的分析师项目 |
| Raymond James | Workday 早期职业站（`raymondjames.wd1`，RaymondJamesEarlyCareers） | 可以读（`workday`） | 当天 20 个 |
| TD、KeyBank、BMO、CIBC、PGIM | Workday（`td.wd3`、`keybank.wd5`、`bmo.wd3` Campus、`cibc.wd3` campus、`pru.wd5`） | 可以读（`workday`） | 各几十个；BMO、CIBC 的校招以加拿大为主 |

---

## 六、国内：逐个说

### 1. 实习僧

**是什么。** 国内最大的实习招聘网站之一，金融、咨询、互联网的日常实习很多在上面发。

**不登录能看到什么。** 列表页是服务端渲染的，但职位名和薪资里的关键字符用了网站自带的字体：源码里是
`&#xe0d2` 这类私用区字符，页面要加载 `/interns/iconfonts/file?rand=…`（每次地址都随机）这份字体才显示成正常文字。
这就是字体加密。

**robots.txt。** 文件是空的（0 字节），等于没写限制。但响应头显示网站在「加速乐」（一种网站防护服务）后面，
会给每个访客发一个跟踪 cookie。

**服务条款。** 用户协议写明：不得用机器人软件、脚本自动访问；不得通过外挂、插件、第三方招聘管理系统接入或浏览职位；
不得用爬虫、抓取、批量检索等手段复制网站信息。

**结论：不做。** 字体加密本身就是为了挡程序，破解它等于绕过反爬；条款也明确禁止。你在实习僧上看中的岗位，
记下公司名，去这家公司的官网找同一个岗位（很多在北森、Moka 上，OfferCrew 能读）。

### 2. 应届生求职网

**是什么。** 老牌的校招信息网站（现在属于前程无忧），首页按天更新各公司的校招公告和宣讲会。国内金融应届生常用它看
「谁在招」：当天首页就有国泰海通证券、招商银行深圳分行、南京证券、交通银行、大家保险、江苏省农商行系统等公司的
2027 届校招公告。

**不登录能看到什么。** 首页 www.yingjiesheng.com 是服务端渲染的，公告标题和链接直接能读到；点进公告，
大多跳到公司自己的招聘系统（北森、招行自建系统、前程无忧代建的校招站……）。首页的「职位推荐」要登录才显示；
职位搜索在另一个域名 q.yingjiesheng.com 上。

**robots.txt。** 只禁止 `/cache/`、`/includes/` 等几个技术目录。

**反爬。** q.yingjiesheng.com 对我们返回了 WAF 挑战页（页面里只有一段加密的校验令牌）；用户协议页也在这个域名下，读不到。

**结论：只能靠你转发链接。** 它最大的用处是告诉你「哪家公司开了校招、入口在哪」。这些入口多数是北森、Moka
这样 OfferCrew 能读的系统：把公司加进 `config/companies.yaml`，OfferCrew 就直接读官网，比读公告更完整。

### 3. 牛客

**是什么。** 程序员刷题起家的求职社区，现在也有校招日程和职位列表，筛选里有「银行」「国央企」。

**不登录能看到什么。** 职位页 `/jobs/school/jobs` 的网页源码里只有框架和筛选项，列表写着「暂无数据」：
数据要页面里的程序去内部接口取。

**robots.txt。** `Disallow:/search`，其余不限。

**服务条款。** 免责声明要求访问者不得干扰、扰乱网站服务，不得镜像或复制网站内容。

**结论：只能靠你转发链接。** 牛客的职位以技术岗为主，金融岗多半也链回公司官网，直接读官网更完整。

### 4. BOSS 直聘

**是什么。** 国内最大的「直聊」招聘 App，HR 和求职者直接聊天。

**robots.txt。** 禁止所有带查询参数的地址（`Disallow: /*?*`），还逐个禁止了一批接口路径。

**服务条款。** 禁止用自动化程序、脚本或外挂访问、操作平台（这一点早已明确，我们这次没有再去打开它的条款页）。

**结论：不做。** OfferCrew 不自动读 BOSS 直聘，`lib/ats/http.mjs` 也把 zhipin.com 列为不直接访问的站点。
模板里的 BOSS 真人帖来源默认关闭（`config/human-source-policy.example.json`），建议保持关闭。

### 5. 智联招聘（校园）

**是什么。** 智联招聘的校园频道 xiaoyuan.zhaopin.com。不少银行把整个校招网站交给智联代建，
比如邮储银行的 2027 校招站 `psbc2027.zhaopin.com`。

**不登录能看到什么。** 首页是服务端渲染的专业、职类分类表；职位列表和代建的校招站都是脚本渲染的空框架。

**robots.txt。** `Allow: /jobs/`，但 `Disallow: *?*`：任何带查询参数的地址，也就是所有搜索和筛选结果，都不让程序读。

**服务条款。** 法律协议页是脚本渲染的，程序读不到正文。

**结论：只能靠你转发链接。**

### 6. 前程无忧（校园）

**是什么。** 前程无忧（51job）的校园频道；很多银行的校招站由它代建，地址形如 `campus.51job.com/<项目名>`，
比如江苏省农商行系统、北京农商银行的 2027 校招。

**不登录能看到什么。** 代建的校招站是脚本渲染的框架；职位搜索 we.51job.com 的页面先加载阿里的前端风控脚本
（`g.alicdn.com` 上的 antidom.js 等），内容要脚本跑完才出来。

**robots.txt。** we.51job.com 请求 robots.txt 返回的是网页框架（等于没有这个文件）；campus.51job.com 的 robots.txt
跳到了「找不到该页」。

**结论：不做。** 搜索页有风控脚本，代建站也没有我们能用的公开接口。

### 7. 国聘

国资委指导的央国企招聘平台（iguopin.com），很多央企、国有金融机构的校招会同步上去。robots.txt 不设限制
（`Disallow:` 后面是空的），但页面是脚本渲染，背后的接口这次没有核实。**结论：只能靠你转发链接（接口待核）。**

### 8. 招聘系统：北森、Moka、飞书、大易

#### 北森（zhiye.com）

**是什么。** 国内最大的人力资源 SaaS 之一。招聘门户的地址都是 `<公司>.zhiye.com`：社招在 `/social`、
校招在 `/campus`、实习在 `/intern`。券商、基金、保险用得很多：中金公司、中信建投、国信证券、中国银河证券、
东吴证券、南京证券、大家保险……（基金公司里华夏基金、汇添富、海富通、景顺长城用的是北森的老版门户，页面上没有 PortalId，现有适配器读不了。
2026-10-01 复核：老版门户没有 JSON 接口，但页面是服务端渲染、不登录能看，见到了三套模板，写网页解析就能读，还没写）

**不登录能看到什么。** 门户是脚本渲染，数据来自同一个公开接口 `/api/Jobad/GetJobAdPageList`，列表里就带职责和要求。
校招、实习和社招走的是同一个接口，只换一个「类别」参数：1 是社招，2 是校招，3 是实习。当天中金公司校招 104 个、实习 152 个。

**robots.txt。** `User-agent: *` / `Allow: /`。

**结论：可以读。** 原来的 `beisen` 适配器只读社招，岗位链接也写死成 `/social/detail`。这次加了 `category`
（2 校招、3 实习），链接跟着变成 `/campus/detail`、`/intern/detail`。

#### Moka

**是什么。** 另一家常见的招聘 SaaS，地址形如 `app.mokahr.com/campus-recruitment/<公司>/<站点号>`。
嘉实基金、创金合信基金、中国投资有限责任公司（中投）的校招在上面。

**不登录能看到什么。** 校招网页本身会先发几个 cookie、再跳回自己（不带 cookie 的程序会在这里转圈，我们没有跟进去）；
但页面取数据用的接口 `/api/outer/ats-apply/website/jobs` 不需要 cookie。接口返回的数据是加密的，解密用的钥匙就附在
同一个响应里，偏移量写在页面里——OfferCrew 做的解密和网页自己在你浏览器里做的完全一样（`lib/ats/moka.mjs` 开头有说明）。
当天嘉实基金校招 22 个岗位。

**robots.txt。** 只禁止两个具体公司的页面，其它不限。

**结论：可以读。** 这次给 `moka` 适配器加了 `site: campus`，同一个接口改读校招站。

#### 飞书招聘

字节跳动系和不少新公司用它（`jobs.feishu.cn` 和各公司自己的域名）。robots.txt 返回 404（没有限制），
公开接口早已支持（`larkhire` 适配器）。**结论：可以读。**

#### 大易（hotjob）

**是什么。** 大易（Dayee）的招聘 SaaS。老版本地址形如 `www.hotjob.cn/wt/<公司>/…`，新版本是
`wecruit.hotjob.cn/SU<编号>/…` 或 `<公司>.hotjob.cn`。华夏银行、广州银行、郑州银行、大连银行、
苏州农商银行、华泰证券、安信证券、联储证券、招联金融等都在用；2026-10-01 复核：广发证券的岗位也在大易上
（官网 job.gf.com.cn 只是门面），中信银行已经换成自建站，不在大易上了。

**不登录能看到什么。** 新版本（比如华夏银行的 `hxb.hotjob.cn`）先打开一个空壳，壳里的脚本调用
`/wecruit/common/getSLD` 查出这家公司真正的门户地址，再加载脚本渲染的门户；老版本的列表地址带一个很长的加密参数
`operational`。

**robots.txt。** 新版本返回 404；老版本当天返回「系统正在维护中」。

**结论：新版本可以读，老版本只能靠你转发链接。** 2026-10-02 核实了新版本门户背后的两个公开接口（列表
`/wecruit/positionInfo/listPosition/SU…`、详情 `…/listPositionDetail/SU…`，不登录、没有签名），新做了 `hotjob`
适配器（`lib/ats/hotjob.mjs`），社招、校招、实习都能读。老版本（`/wt/` 地址）翻页要页面每次下发的令牌，不做。

### 9. 银行、券商、基金、保险：逐家核对

| 机构 | 看到的招聘系统 | 能不能读 | 备注 |
| --- | --- | --- | --- |
| 中金公司 | 北森 `cicc.zhiye.com` | 可以读（`beisen` 校招、实习） | 校招 104、实习 152 |
| 中信建投证券 | 北森 `csc108.zhiye.com` | 可以读（`beisen`） | |
| 国信证券 | 北森 `guosen.zhiye.com` | 可以读（`beisen`） | |
| 中国银河证券 | 北森 `chinastock.zhiye.com` | 可以读（`beisen`） | |
| 华夏基金 | 北森老版 `chinaamc.zhiye.com` | 可以读（要写网页解析，还没做） | 老版门户没有 PortalId，现有 `beisen` 读不了 |
| 嘉实基金 | Moka `jsfund/43906` | 可以读（`moka` 校招） | 校招 22 |
| 中国投资有限责任公司（中投） | Moka `china-inv/76020` | 可以读（`moka` 校招） | |
| 上海证券 | Moka `shzq/94541` | — | 当天页面显示「当前网页已关停」 |
| 国泰海通证券 | 自建 `hr.gtht.com` | 不读（robots 禁止） | 2026-10-01 复核：robots.txt 全站 `Disallow: /`，推翻了 09-29 的「可以读」 |
| 中信证券 | 自建 `careers.citics.com` | 只放入口 | 加载网易易盾验证码组件，前面有 WAF；不自动读，入口给你自己打开 |
| 广发证券 | 门面 `job.gf.com.cn`，岗位在大易 `wecruit.hotjob.cn` | 可以读（`hotjob`） | 2026-10-01 复核：自建的只是门面 |
| 工商银行 | 自建 `job.icbc.com.cn` | 只能靠你转发链接 | 脚本渲染 |
| 建设银行 | 自建 `job.ccb.com` | 只能靠你转发链接 | 首页只有一段跳转脚本 |
| 农业银行 | 自建 `career.abchina.com` | 只能靠你转发链接 | |
| 中国银行 | 官网「招聘公告」页 | 只能靠你转发链接 | 公告列表是服务端渲染的（当天有《2027年全球校园招聘公告》），报名入口写在公告里 |
| 交通银行 | 自建 `job.bankcomm.com` | 只能靠你转发链接 | 脚本渲染 |
| 招商银行 | 自建 `career.cmbchina.com` | 只能靠你转发链接 | 脚本渲染 |
| 华夏银行 | 大易 `hxb.hotjob.cn` | 可以读（`hotjob`） | 校招五十多页，要写 `max_pages` |
| 中信银行 | 自建 `job.citicbank.com` | 只放入口 | 2026-10-01 复核：已经不在大易上 |
| 中国平安 | 自建 `campus.pingan.com` | 只能靠你转发链接 | 脚本渲染 |
| 邮储银行（安徽分行） | 智联代建 `psbc2027.zhaopin.com` | 只能靠你转发链接 | |
| 江苏省农商行系统 | 前程无忧代建 `campus.51job.com` | 不做 | |

---

## 七、这次做了什么，怎么用

第一阶段做完、已经提交的部分：

- **两个新适配器**：`oracle`（Oracle Cloud HCM，摩根大通）和 `oleeo`（Oleeo / tal.net 校招板，美国银行、Jefferies、Rothschild、Lazard）。
  例子在 `config/companies.example.yaml` 末尾。
- **校招和实习**：`beisen`（类别 2 校招、3 实习）、`moka`（校招站）、`tencent`（join.qq.com）、`alitalent`（蚂蚁的校招搜索）
  按候选人的阶段决定读哪几类（`lib/ats/recruit.mjs`：在读 → 实习 + 校招，应届 → 校招 + 社招，其余只读社招；
  软件方向照旧只读社招），`companies.yaml` 里 `recruit_types` 可以覆盖；线索上记 `recruit_type`。
- **网申截止日期**：`lib/deadline.mjs` 从招聘系统的截止字段或 JD 里「截止 / deadline / closing date」旁边的日期读出
  `apply_deadline`，读不出不写。
- **还没进代码的**（2026-10-02 注）：旧分支上的「校招后段工作流」（`测评 / 笔试`、`体检 / 背调 / 政审`、`签约`
  这几步）和 Indeed、Handshake 提醒链接的处理，这次搬到方向分支时没有带，现在的代码里没有。

---

## 八、以后可以做的

- **SAP SuccessFactors**（安永等）、**Avature**（德勤美国）、**Phenom**（BCG）、**iCIMS**：四个都能读，
  区别只是要解析网页，按对非程序员用户的价值排，安永和德勤在前。
- **北森老版门户**：华夏基金、汇添富、景顺长城、交银施罗德、新华保险，写一个网页解析就能读。
- **平安集团招聘站**：一个适配器覆盖平安银行、平安证券等十几家子公司。
- （已做）大易新版：`hotjob`；Workday 的地点筛选：`applied_facets`。国泰海通 robots.txt 全站禁止，不做。

---

## 九、第三阶段接着做

2026-09-29 晚上方向调整：先把工程师这条线做全，金融、咨询、校招实习和企业级招聘系统放到第三阶段。下面是停在哪里、下一步做什么。

**已经在代码里、能用的**（第七节）：`oracle`、`oleeo` 两个适配器；北森、Moka、腾讯、蚂蚁的校招和实习；网申截止日期。
测评 / 笔试和校招后段的工作流步骤、Indeed / Handshake 提醒链接的处理这次没带，还没进代码。

**停下来、还没做的**：

1. **金融公司起步清单**：2026-10-02 已经建好，见第十节；下面是 09-29 当时的记录，留作对照。已经核对过、能读到岗位的来源：
   - 美国：摩根大通（`oracle`，美国 + Program Analysts & Associate，161 个）、美国银行校招（`oleeo`，149 个）；Workday 上
     Blackstone 校招站（32）、Houlihan Lokey 校招站（32）、M&T Bank 校招站（45）、Raymond James 早期职业站（20）、
     BlackRock（搜 Analyst，48）、TD（搜 Summer Analyst，61）、KeyBank（搜 Analyst Program，55）、BMO 和 CIBC 校招站（各 55）、
     美国银行社招（Lateral-US 搜 Analyst，144）。以上是单次请求看到的总数，还没逐家跑 `discover --dry-run`。
   - 国内：北森新版门户的中金（`8e5a323a-a6e8-4a37-9ff2-018191167d45`）、中信建投（`f1f86fea-3b92-4111-b411-f3992e681f6b`）、
     国信（`3963cb99-c4b3-44c5-9c10-41dd2e28febb`）、银河（`2de9fc66-f050-4aef-8bf0-68d092fcdc8e`）、东吴（`1cb05a39-704d-4d99-beb8-8b01c9010314`）、
     南京证券（`e922126e-6698-4f1b-b406-47c64f841c80`）、大家保险（`12f71a17-c142-4ec1-bc1b-05dcc241b73e`）；Moka 校招站的嘉实基金
     （jsfund / 43906）、中投（china-inv / 76020）、创金合信（cjhxfund / 42063）。括号里是各家的 PortalId 或站点号。
   - 下一步：每家跑一次 dry-run 再写进清单；富国、花旗、Capital One 的 Workday 太大，先给 `workday` 适配器加按地点筛
     （`applied_facets`）再收。
2. **校招类别还缺的**：飞书招聘（`larkhire`）对标明身份的请求头返回 405，没法按规矩核对它的校招参数，所以没做；阿里巴巴主站的
   校招搜索要先拿匿名 cookie，没核对；北森老版门户（华夏、汇添富、海富通、景顺长城）要另写读法。
3. **截止日期的提醒**：`apply_deadline` 已经记在线索上，还没进收件箱（快到期的提醒、按截止排序）。
4. **测评、笔试的来源**：状态和步骤有了，但还没有谁写它——Watch 识别「测评邀请 / 笔试通知」邮件（`lib/watch.mjs`）、
   收件箱里「记一笔测评」的选项，都还要做。
5. **企业级招聘系统**：SuccessFactors（安永）、Avature（德勤）、Phenom（BCG）、iCIMS 都能读，还没写；Eightfold（摩根士丹利、
   花旗、Capital One）接口要页面会话，不做；Taleo 没核实。
6. **匹配的短 JD**：北森上的实习岗位描述常常不到 200 字，`lib/matcher.mjs` 的 hasFullDescription 会把它当成「JD 不全」，
   这类线索会卡在匹配前。要不要为校招、实习放宽，留给改匹配器的人决定。

---

## 十、四个新公司包（2026-10-02）

金融、法律、会计和职能类方向各有一个起步清单，写法和科技包（`tech.example.yaml`）一样，复制想要的几段到
`config/companies.yaml` 才会被扫描。每一家都在 2026-10-02 用现有适配器只读核过：先看 robots.txt 放行（Workday 用
`node bin/robots-check.mjs` 按站点核），再在沙盒和演示数据里读一次，同一网站两次请求至少隔 1 秒，robots 要求 10 秒的照它。
当天读不到岗位的、robots 禁止的、只能放入口的、要新写适配器的，都列在各个包文件的末尾「没收进来的」，不在包里。

| 包 | 给哪些方向 | 分组 | 收了几家 |
| --- | --- | --- | --- |
| `finance.example.yaml` | 金融 | 券商、基金、银行、保险、外资投行和银行、精品投行、买方 | 57 |
| `legal.example.yaml` | 法律 | 内资所、外所、公司法务和合规 | 15 |
| `accounting.example.yaml` | 会计 | 四大、内资所、企业财务 | 14 |
| `business.example.yaml` | 人力 / 行政、市场、销售 / 商务、项目管理 | 快消、汽车、零售和餐饮、大厂 | 13 |

几个要注意的地方：

- **大易新版**（`hotjob`）这次一起收了：德勤、招商证券、广发证券、华泰证券、兴业证券、南方基金、博时基金、华夏银行、
  广州银行、郑州银行。易方达的门户当天回「该官网已关闭」，工银瑞信当天 0 个，都没收。华夏银行校招超过默认的 30 页，
  写了 `max_pages: 60`。
- **外资**：摩根大通、高盛用 Oracle 的地点筛选只读香港、中国、纽约；同一家的社招、校招在两个站上的分成两条
  （名字后面写「（校招）」）。Oleeo 订阅源没有城市栏目的板（Evercore、Moelis、Perella）写了 `unlisted_city: keep`。
- **大厂**（字节、阿里、腾讯、网易，加上蔚来）在法律、会计、职能三个包里都有，没写 `queries`，按你选的方向自动换搜索词
  （`lib/directions.mjs`），法务、合规、财务、市场、HRBP 这些岗位一家就比很多机构多。
- **大租户的筛选**：星巴克只读「职能支持」（北森 `classification_one: ['3']`），不读门店；可口可乐只读中国
  （Workday `applied_facets`）；中金、中国人寿、泰康在法律包里按关键词（合规、法务、法律）读。
- 包里只写公开的招聘页地址，不写任何联系人的电话、邮箱，`tests/packs.test.mjs` 会查。

