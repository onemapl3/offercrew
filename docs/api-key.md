# 怎么拿到一个 API key（以 DeepSeek 为例）

OfferCrew 要一个模型来读简历、判断岗位、起草消息。最便宜、最省事的办法，是去模型服务商那里申请一把 **API key**，粘贴进 OfferCrew。

## 先说清楚几个词

- **API key**：一串以 `sk-` 开头的长字符。它相当于一张「按量付费」的会员卡：OfferCrew 每调用一次模型，就从你在服务商那里充的钱里扣一点。
- **充值**：先往服务商账户里存一点钱（几美元），用多少扣多少，不会自动续费。
- **token**：模型按字数计费的单位，一个汉字大约算 1 个 token。

## 大概花多少钱

以 DeepSeek 的 `deepseek-flash` 为例（2026-09-30 核对）：每百万 token 输入 0.30 美元、输出 1.20 美元；工作日北京时间 9–12 点和 14–18 点以外，价格减半。

判断一个岗位，大约读 5 千 token（岗位描述加你的资料），写 1–3 千 token 的结论，所以判断 100 个岗位约 2–4 元人民币。充 2–5 美元，能用很久。

## 一步一步：DeepSeek

1. **注册**：打开 [platform.deepseek.com](https://platform.deepseek.com)，用 Gmail、Outlook 这类常见邮箱注册并登录。
2. **充值**：左侧点「充值」，先充 2–5 美元。可以用 PayPal、银行卡、支付宝或微信；用支付宝或微信要先做实名认证。
3. **创建 key**：打开 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)，点「创建 API key」，名字填 `OfferCrew`，方便以后认出来。
4. **复制**：把显示出来的那一串 key（`sk-` 开头）复制下来，立刻进行下一步。如果之后找不到了，把它删掉、重新建一把就行。
5. **粘贴到 OfferCrew**：在新手引导的「模型」一步，或者「设置 → 模型与参数」里，选「DeepSeek」，粘贴 key，点「测试」。看到「可以用」就好了。地址（`https://api.deepseek.com`）和模型名（`deepseek-flash`）都已经替你填好。

## 要注意的

- **key 相当于密码。**它只存在你这台电脑上（`private/providers/`，不进 Git）。不要发给别人，也不要截图发到群里。不用了，就回到 API keys 页面把它删掉，它会立刻失效。
- **余额用完会报错。**OfferCrew 会提示「模型调用失败」，充值后就恢复。
- **用 Anthropic（Claude）。**在「模型」一步选「Anthropic（Claude）」，粘贴 `sk-ant-` 开头的 key（[platform.claude.com/settings/keys](https://platform.claude.com/settings/keys)）。加好以后，判断岗位、读信、讲原因用 Claude Haiku 5.5（每百万 token 输入 0.10、输出 0.50 美元），改简历、写信、调研、对话用 Claude Sonnet 5.5（输入 2、输出 10 美元）；在团队页可以给每位成员换成别的。在中国大陆直连 Anthropic 会被挡，要开着代理软件的系统代理，OfferCrew 会走它。
- **用别家也一样。**OfferCrew 还预设了 OpenRouter（一个 key 能用很多家的模型，收信用卡和支付宝）和通义千问国际版（最便宜，有免费额度）。步骤都写在「模型」一步里，选了就能看到。

已经在付 ChatGPT Plus 的，也可以不填 key，直接「用 ChatGPT 账号登录」。
