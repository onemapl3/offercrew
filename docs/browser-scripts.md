# 浏览器脚本：给本机 AI 的说明（专用 Chrome）

本机 AI（Codex / Claude Code）要在网页上做事时，写一段脚本交给 OfferCrew 的专用 Chrome 跑。专用 Chrome 是什么、怎么开关，见 `docs/chrome-host.md`。写法和 ego-browser 一样，原来写给 ego 的脚本不用改。

## 怎么跑

```bash
node bin/browser.mjs -e 'const task = await taskSpace("watch-sites"); const p = task.page("p1"); await p.goto("https://example.com/jobs"); console.log(await p.title()); await task.finish({ keep: [] });'
```

长脚本从标准输入给：

```bash
node bin/browser.mjs <<'EOF'
const task = await taskSpace("watch-sites");
const p = task.page("p1");
await p.goto("https://example.com/jobs");
const rows = await p.evaluate(() => [...document.querySelectorAll("a")].slice(0, 30).map(a => ({ title: a.innerText.trim(), href: a.href })));
console.log(JSON.stringify(rows));
await task.finish({ keep: [] });
EOF
```

- 脚本是一个 async 函数体，可以直接 `await`。结果自己用 `console.log` 打出来。
- 出错时错误写到标准错误，退出码 1。
- 专用 Chrome 没开着也没关系：命令会等它开好。在 Mac 版的沙盒里，由 OfferCrew 替你打开，最多等 30 秒。

## 任务空间

一个任务空间就是专用 Chrome 里的一个窗口，在后台开，不抢焦点。

| 写法 | 做什么 |
| --- | --- |
| `await taskSpace("名字")` | 拿到这个名字的空间，没有就建一个。传编号就找回那一个。 |
| `task.page("p1")` | 空间里叫 p1 的那一页，第一次用时才开。p2、p3 是同一个窗口里的新标签。 |
| `await task.pages()` / `await task.tabs()` | 列出空间里开着的页。 |
| `await task.handOff()` | 交给用户：之后要再动这个空间，得先 `await takeOverTaskSpace(编号)`。 |
| `await task.finish({ keep: [] })` | 关掉自己开的页；`keep: ["p1"]` 留下 p1。 |
| `await listTaskSpaces()` | 列出所有空间：编号、名字、归谁。 |

整件事只用一个空间。页面用 `goto()` 复用，不要不停开新页。结束前一定 `finish`。

## 页面

- 打开和等待：`goto(url)`、`reload()`、`url()`、`title()`、`waitForSelector(选择器)`、`waitForURL(…)`、`waitForLoadState()`、`waitForTimeout(毫秒)`。
- 读：`evaluate(() => …)`、`snapshot()`（页面的无障碍树）、`screenshot({ path })`。
- 动手：`click`、`fill`、`press`、`selectOption`、`hover`、`setInputFiles`、`mouse.*`、`keyboard.*`。默认最多等 3 秒。回执里带着点出来的新页（p2……）和页面弹窗。
- 弹窗不会被自动点掉：用 `acceptDialog()` 或 `dismissDialog()`。

选择器的写法：

- 普通 CSS；
- `text=登录`；
- `xpath=//a`；
- `loc=role:button[name="下一步"]`；
- `loc=href:/jobs/`；
- `loc=css:…`。

## 必须停下的时候

| 看到什么 | 怎么办 |
| --- | --- |
| 报 `site_check:<网站>` | 这个网站要人来验证（验证码、人机检查、访问太频繁）。停下这一站，一小时内系统不会再自动打开它。 |
| 报 `site_busy:<网站>` | 这个网站上别的脚本还没跑完。这一站留到下一轮。 |
| 报 `agentDelegatedToUser` / `is under user control` | 空间已经交给用户了，别再动它。 |
| 落到登录页 | 停下。把页面交给用户（`handOff()`），把网址写进任务结果。 |

上面这些情况都不要重试，也不要换浏览器、换出口、换写法绕过去。不要在页面上输入账号、密码或验证码。

专用 Chrome 带着标准的自动化标记（`navigator.webdriver` 是 true）。不要改指纹，不要伪装。
