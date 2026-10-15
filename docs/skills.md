# 技能

`skills/radar-*/SKILL.md` 是本产品自带的五个执行器技能：发现（discover）、摘要（digest）、收件箱（inbox）、联系与投递（reach）、登录站点的浏览（browse-assist）。文字里只有仓库内的相对路径和配置项（工作目录是本仓库根目录，Gmail 账号是 `candidate/facts.yaml` 的 `identity.mailbox`），不含任何人的路径或账号。

安装到自己的智能体（Codex、Claude Code 等）时，把需要的 `skills/radar-*` 目录复制或符号链接到该客户端的技能目录（或你自己的共享技能根）。要加本机专属的内容（例如写死工作目录），改你安装的那一份，不改仓库里的；不要把凭据复制进技能目录。
