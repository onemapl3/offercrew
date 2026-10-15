# Codex 电脑操作接入（2026-09-22）

OfferCrew 负责挑选任务、核验材料批准、记录状态；Codex `gpt-6-astra` 通过已安装的 `unified-computer-use` 插件操作 Chrome。Ego 继续承担原有确定性浏览器流程。两个浏览器的登录状态独立，Chrome 成功不会把 Ego 标成已登录。

## 使用

Reacher 的门户阻塞任务有「交给 Codex 处理」。一次只运行一个，最多每小时两次，单次最多四分钟。当前启用网易招聘和微软申请门户；`discovery.excluded_companies` 里的公司一律跳过；`config/pipeline.json` 的 `computer_use.allow_hosts` 管理范围，`never_auto` 优先。

没有匹配当前材料指纹的批准时，只导航并检查会话。有有效批准时可预填批准的字段和简历；停在最终提交前，保留 Chrome 标签页给用户检查。遇密码、验证码、跨站登录、未知必填项、条款或权限请求时交回用户。工具不可用时报告 unavailable，不能用模型的文字承诺代替实际操作。

CLI：`node bin/computer-use.mjs --record <record_id>`。供应商优先使用 `computer_use.provider`，未配置时沿用宿主的 `codex_models.fallback.provider`；模型固定 Astra。加载桌面用户已有插件，不复制凭据，不修改全局配置。

## 状态与证据

- Codex 使用独立临时目录、ephemeral / read-only、关闭 shell 工具。提示词限定 CUA 工具和任务站点；这属于代理约束，并非浏览器网络层隔离。
- 同时核对实际成功的 `mcp_tool_call`、最终 host、正面登录证据、可见申请表单和未提交状态。
- `runs/<date>/computer-use/<id>.json` 记录步骤、工具调用次数和结果；不存原始模型输出或凭据。
- 成功后记录 `cua_logged_in`，线索进入 `prepared_for_user`。后续自动轮次不能重开 Ego 再投一次；等待用户完成或重新审核。
- 网页阻塞、未验证登录、跨站跳转均不记成功。无法确认提交边界时要求对账，证据不会强行写成未提交。

## 验证

真实 Astra + Chrome 本地测试：读取登录标记、填写虚构姓名、回读输入值、保留页面且不提交。记录在 `runs/20260922/codex-cua-check/interaction.json`。这验证了插件调用与浏览器交互；真实招聘门户仍需各自的登录态和页面适配。

单元/回归测试覆盖调用证据、批准指纹变化、会话隔离、限额、并发、阻塞与越界报告、Chrome 交接后禁止 Ego 再投。执行 `npm test`。
