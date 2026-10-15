# 执行器怎么报告任务状态

执行器（Claude Code、Codex 或任何模型代理）处理 `state/host-jobs.ndjson` 里的任务时，**只用
`node bin/job.mjs` 报告结果**，不要手改那个文件。命令会检查写法，写错了会被拒绝并告诉你怎么改。

为什么：以前卡住时写一段话（"网易已登录，但须先建立在线简历……"），收件箱要从文字里猜你要什么，
猜错一次，用户就得多登录一次、多点一次。现在卡在什么就填什么，收件箱只读字段、不猜。

## 三种结果

```bash
# 做完了：写清做了什么、结果如何；证据路径可以写几个
node bin/job.mjs done <任务id> --result "扫完 3 个来源，新增 2 条" --evidence runs/20260928/x.json

# 需要用户：见下一节，可以连着报几件（先 login 再 info），同一件事只留最新一份
node bin/job.mjs need <任务id> <login|info|decide|approve> ...

# 做不下去、也不是用户能解决的：写清查到哪一步、卡在哪
node bin/job.mjs blocked <任务id> --reason "门户接口返回 500，重试 3 次" --evidence runs/.../error.json
```

`<任务id>` 写前 8 位以上即可（唯一就行）。命令输出一行 JSON；参数不对时退出码 2 并打印用法。

## 需要用户时：四种

| 种类 | 什么时候用 | 写法 |
|---|---|---|
| `login` | 平台 / 门户要登录 | `--account linkedin`（名字见 `config/accounts.json`；按公司分开的写 `workday:<域名>`；也可以直接给站点域名）。几个账号就写几个 `--account` |
| `info` | 缺信息（申请表必填项、出生年月、邮编……） | `--question "一句话" --field <key>:<名字>[:<类型>[:<选项1\|选项2>]]`，类型 text / long_text / date / month / number / choice / file |
| `decide` | 要用户拍板 | `--question "一句话" --option 选项一 --option 选项二`（2–5 个） |
| `approve` | 要用户看一眼再继续（预填好的表、要发出的内容） | `--question "一句话" [--url 页面]` |

每种都可以加 `--title "短标题"`：约 20 个字的一句中文人话，说清要用户做什么（「补 Contoso 的岗位 JD」「继续扫描，还是跳过这轮？」）。不写代码名、路径和英文代号（`discover-human-browser`、`system_auto_repair` 这类），命令会拒收。卡片、成员卡、横幅上只放这一行，全文在 `--question`，点开才看到。不写的话系统从全文推一个，通常不如你写的准。

例子：

```bash
node bin/job.mjs need a156e167 login --account linkedin --account xiaohongshu
node bin/job.mjs need 8a3b2097 info --title "补出生年月" --question "网易要先建在线简历，还缺一项" --field birth_month:出生年月:month
node bin/job.mjs need 5f0c11aa decide --title "没找到联系人，怎么投？" --question "官网能投，没找到招聘联系人，怎么推进？" --option 投官网 --option 先找内推 --option 不投了
node bin/job.mjs need 77d0e912 approve --title "核对申请表再提交" --question "申请表已填好停在提交前，请核对" --url https://example.com/apply/1
```

## 规矩

- 证件号、银行卡、密码、验证码不经收件箱收集（命令会拒收）：改成 `approve`，请用户在网页上自己填。
- 缺申请表信息时，先查答案簿 `candidate/form-answers.json`（用户在收件箱答过的问题都在这里，按问题名存）；
  有答案就直接用，没有再报 `info`。
- 登录不要自己反复打开登录页重试：报 `login` 就行。系统会自己去浏览器里看用户登好了没有
  （`lib/login-watch.mjs`），登好了自动让任务继续。
- `--question` 写给用户看：一句话，说清缺什么、为什么，不写内部代号。
- 公司调研（`company_brief`）和怎么准备（`role_prep`）：先用 `node bin/company.mjs brief|prep` 写进去（它校验来源和 JD 引文，见 docs/interview-dossiers.md），`done` 才收。
- 只报真实情况：没做成就是没做成，不要写 `done`。
