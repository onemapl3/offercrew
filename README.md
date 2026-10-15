# OfferCrew

OfferCrew 是在 Mac 上运行的求职助手。六位成员协作找岗位、判断匹配、准备材料、联系招聘方、跟进回复和整理面试资料。桌面、工作台和手机使用同一份任务与材料记录。

这是完整客户端的源码快照，采用 [PolyForm Perimeter 1.0.1](LICENSE)，属于源码可用项目。请阅读许可证和 [Required Notice](NOTICE)；第三方代码按各自许可证提供。本仓库不提供商业中转服务的实现或部署资料。

- 下载安装版：[OfferCrew 官网](https://offercrew.onemaple.cc/)。需要 Apple 芯片的 Mac。
- 从源码运行：[运行指南](docs/RUNNING.md)。Node.js 引擎、原生网页和 Electron 外壳没有另一套裁剪版功能。
- 代码结构和网络边界：[架构](docs/ARCHITECTURE.md)。精确分发文件与 SHA-256 见 [CLIENT-MANIFEST.json](CLIENT-MANIFEST.json)。
- 组件版本与许可：[第三方通知](THIRD-PARTY-NOTICES.md)。

可以选择自己的 API Key、已安装并登录的受支持本机 AI 工具，或可选的 OfferCrew 官方补给。使用本机工具不表示模型在设备上离线推理。某项操作需要模型、邮箱或网站登录时，客户端会显示缺少的连接；已有资料仍可读取和导出。

申请表采用「自动预填，你来提交」。发信、私信和其他外部动作使用同一套确认与回执流程；源码运行不跳过这些约束。不要把含简历、邮件、登录态或迁移包的数据目录提交到本仓库。

当前版本为 0.2.0。官方签名安装包与自己从源码运行的实例可能使用不同的发行渠道；自己构建的开发 App 默认不检查官方自动更新。安装包是否已经发布，以官网及 GitHub Releases 的实际产物为准。
