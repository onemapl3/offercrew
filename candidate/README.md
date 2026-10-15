# candidate/ — 你的个人事实

这个目录是拟稿、ATS 预填、回答招聘方问题时的**唯一事实来源**。仓库里只有这份说明、模板 `facts.example.yaml`（一个虚构的示例人物）和 `templates/` 下按方向的示例（见下面「按方向的示例」）；你自己的文件都只在本机，`.gitignore` 挡住了这个目录里的其它一切：

- `facts.yaml`：结构化事实（身份、城市、工作许可、到岗时间、薪资、偏好、简历路由、标准答案、履历、项目、定位、对外短消息的说法）。`lib/facts.mjs`、`lib/application-form.mjs`、`lib/judgements.mjs`、`lib/referrers.mjs`、`lib/human-browser.mjs` 都从这里读。工作台「开始使用」导入简历或点「编辑」时会新建它；「设置」页也能改其中一部分。
- `uploads/`：「开始使用 → 导入简历」上传的原件、抽出的文字和模型整理的草稿。导入时选了「设为英文 / 中文简历」，`resume_routing` 就指向这里的 PDF。
- 简历 PDF：`facts.yaml` 的 `resume_routing` 指向的文件（英文、中文；只有一份就两项写同一个）。
- `resume.tex`（可选）：`bin/match.mjs` 会把它作为简历原文附给匹配模型；导入简历时勾「匹配用的文字版」就会生成，在「简历」页点「用这版投递」也会换成那一版。
- `resume/`：「简历」页（简历助手）的全部数据——原简历（v1）、你存下的各个版本、草稿、锁定、改写建议和拦下的、追问和你的回答、导出的 PDF / Word、按岗位定制的版本（见 [docs/resume-assistant.md](../docs/resume-assistant.md)）。
- `profile.md`（可选）：给匹配模型看的自然语言画像和你的排除规则（`bin/apply-feedback.mjs` 会往这里追加规则）。没有也能跑。
- `backup-<时间>/`：每次在页面上保存资料之前的旧版 `facts.yaml`。
- `form-answers.json`：你在收件箱里答过的申请表问题（`lib/answer-book.mjs` 自动维护）。

**新用户用「开始使用」生成 `facts.yaml`，不要把 `facts.example.yaml` 原样复制过来就开始用。** 示例里的 `outreach`（对外短消息的说法）、`positioning`、`personal_projects`、`alumni_networks`、`standard_answers` 这些段落页面上改不到，会原样进你的首联和私信；而且 `facts.yaml` 里已经有值的项，导入简历时默认**不勾选**覆盖，一不留神就还是示例人物的名字和邮箱。要参照模板，就先用「开始使用」生成自己的文件，再把模板里用得上的段落抄过来、逐项改成你自己的话。

## 按方向的示例

不是每个人都在找软件工程的工作。`templates/` 下有三份示例资料，每份是一个虚构的人，字段结构和 `facts.example.yaml` 一样，只是按那个方向来写：

| 文件 | 示例人物 | 这个方向特别要填的 |
| --- | --- | --- |
| `templates/software.example.yaml` | 做 AI 应用后端的软件工程师（就是 `facts.example.yaml` 那个人） | 个人项目和 GitHub、每段经历的数字、想做前端 / 测试 / 算法时写 `role_families` |
| `templates/finance.example.yaml` | 在美国读金融本科、2026 年毕业的应届生，F-1 OPT，投行 + 资管 | GPA、证书（CFA 一级已过……）、每段实习、毕业时间、工作许可 |
| `templates/marketing.example.yaml` | 国内工作一年多的品牌营销，方向是 市场 + 运营 | 作品（账号、活动、案例）和数据成绩（曝光、转化率、复购率、GMV） |

读这几份示例要知道的几件事：

- **方向写在 `preferences.directions`**，第一个是主方向（`software` / `finance` / `consulting` / `marketing` / `product` / `operations` / `data`），后面的是「也看」的方向；金融里的细分写在 `preferences.tracks`（`investment_banking` / `asset_management` / `risk` / `quant` / `corporate_finance` / `sales_trading`）。**没写方向就按软件处理**，和以前一样。不用手写：「开始使用」第一项「你的方向」点开就能选。
- **证书写在 `certifications`**，每条一个证书名和状态原话，可以加时间：`{ name: CFA, status: Level I passed, date: 2026-02 }`、`{ name: 证券从业资格, status: 已通过 }`。「通过、已通过、持证、passed、charterholder」算已经拿到；「Level I passed、一级已过、在考、candidate、通过 N 科」算还在考。
- **教育可以写 `gpa`**（写成带引号的字符串，如 `"3.7/4.0"`）；**美国工作许可** `work_authorization.us` 从这几个里选：`citizen`、`permanent_resident`、`f1_opt`、`f1_stem_opt`、`h1b`、`needs_sponsorship`、`none`（以前写的自由文字照样认、照样保留）。
- **在读 / 应届**：`availability.current_status` 照实写（应届、在读、在职、已离职），教育写上毕业年月。应届生没有现职，`current_work` 不用写。

和 `facts.example.yaml` 一样，**这些示例不能原样复制成你的 `facts.yaml`**：页面上改不到的 `outreach`、`positioning`、`standard_answers` 会原样进你的首联和私信。正确的用法是先在「开始使用」生成你自己的文件，再对照示例，把用得上的段落抄过去、逐项改成你自己的话。「开始使用 → 你的方向」里每个方向旁边都有「看示例」，打开的就是这几份（咨询、产品、数据分析还没有专门的示例，会给最接近的一份并说明）。

`identity.mailbox`（没写就是 `identity.email`）必须是你实际连接的 Gmail 账号，系统发信、对账、填表都用它。

发布公开副本前跑 `node bin/publish-check.mjs`：这里的每一个值都会进它的私有词表，出现在被跟踪的文件里就会报出来。
