# 从源码运行

安装 Node.js 22.13 或更高版本，并确认 `node:sqlite` 可用。公开快照携带引擎及桌面锁文件；下面每次安装都按锁文件取依赖，不使用私有工作目录的 `node_modules`。

```sh
node --version
node -e "import('node:sqlite').then(() => console.log('SQLite ready'))"
npm ci
npm test
```

`npm test` 在新的临时数据目录中检查引导、合成数据读取、本地认证与 Word 导出。加 `OFFERCREW_CHECK_PDF=1 npm test` 会同时用本机 Chrome 或 Chromium 生成 PDF 并读回文字。它不发送邮件或私信，也不注册官方账号；模型来源的真实连接需在设置中单独测试。

## 桌面运行

```sh
cd desktop
npm ci
npm start
```

Electron 固定为 44.4.5；首次运行可能继续下载对应的官方二进制。如果当前网络通过已有的 `HTTP_PROXY` / `HTTPS_PROXY` 上网，可先设置 `ELECTRON_GET_USE_PROXY=1`，让 Electron 下载器使用同一代理。源码不会附带代理地址、登录凭据或已安装的私有依赖目录。

桌面默认数据在系统的 `Application Support/OfferCrew`。若已安装官方版，开发时请给新目录，避免两个实例同时操作日常数据：

```sh
OFFERCREW_DATA_DIR="$(mktemp -d)" npm start
```

`npm run smoke` 使用桌面自检入口；先设置临时数据目录，并设置 `RADAR_SANDBOX=1`。`npm run build` 生成本机开发用 App，不上传、不读取签名凭据、不开启自动更新。开发构建与官方签名、公证的安装包不同。

## 网页工作台

在仓库根目录使用一个新数据目录：

```sh
export RADAR_ROOT="$(mktemp -d)"
node bin/data-root.mjs "$RADAR_ROOT"
node bin/serve.mjs --no-workers
```

保留此终端。另一个终端使用同一 `RADAR_ROOT`，运行 `node bin/open-workbench.mjs`。它打开含本地访问凭据的入口；不要分享该地址。默认端口 4321。`--no-workers` 关闭后台执行，页面主动操作仍会按正常规则运行。

想看合成数据，可在新的临时数据目录先运行 `node bin/demo-seed.mjs`，再运行 `node bin/serve.mjs --sandbox --no-workers`。不要把演示种子写进自己的日常数据目录。

## 模型与连接

在引导或设置里选择自己的 API Key、已登录的 Codex/Claude Code，或官方补给。自己的 API 与本机运行时不是官方付费功能的裁剪版，连接的是相同客户端。视觉、结构化判断和本机执行能力取决于所选来源；在设置里点测试后，再验证需要的实际操作。没有 Key 时不会因为源码安装而自动获得服务额度。

官方手机和模型服务是可选外部服务。客户端侧手机页面及加密协议源码在仓库里；Cloudflare Worker、运营后台与部署凭据不在本仓库。使用官方服务需要网络，并受该服务实际可用性与条款约束。

## 数据与导出

数据目录与源码分离。材料页可以生成 Word 与 PDF；Word 在本机生成，PDF 需要本机 Chrome/Chromium。未连接付费模型时仍可以读取和导出现有材料。`bin/migrate.mjs` 的迁移包可能包含凭据，只用于自己的设备迁移，不作为公开数据分享包。

源码目录中的 `candidate`、`config` 仅携带示例与共享规则。真实简历、配置、数据库、聊天记录、运行证据和登录态都写入你指定的数据目录。
