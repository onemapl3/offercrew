// 「填一个 API key」的服务商预设：地址、推荐模型、去哪注册，以及一步一步怎么拿到 key。
// 新手引导的模型一步、设置 → 模型与参数的「添加供应商」都读这张表（GET /api/settings/providers/presets），
// 用户只要选服务商、粘贴 key；真正保存仍走 lib/backends.mjs 的 addProvider（key 存在 private/providers/，不进仓库）。
// 价格、模型名会变：改这里，再改 docs/api-key.md。核对日期写在 checked_at。
export const PROVIDER_PRESETS = [
  {
    key: 'deepseek', label: 'DeepSeek', kind: 'openai_http', wire_api: 'chat',
    base_url: 'https://api.deepseek.com', model: 'deepseek-flash', models: ['deepseek-flash'],
    signup: 'https://platform.deepseek.com', key_page: 'https://platform.deepseek.com/api_keys',
    price: '每百万 token 输入 0.30 美元、输出 1.20 美元；工作日北京时间 9–12 点和 14–18 点以外半价。判断 100 个岗位约 2–4 元人民币',
    steps: [
      '打开 platform.deepseek.com，用 Gmail、Outlook 这类常见邮箱注册并登录',
      '左侧点「充值」，先充 2–5 美元就够用很久；可以用 PayPal、银行卡、支付宝或微信（用支付宝、微信要先做实名认证）',
      '打开 platform.deepseek.com/api_keys，点「创建 API key」，名字填 OfferCrew',
      '把显示出来的那一串 key（sk- 开头）复制下来，立刻粘贴到下面的框里；找不到了就删掉重新建一把',
      '点「测试」，看到「可以用」就好了',
    ],
    notes: ['key 相当于密码：只存在这台电脑上，不要发给别人或截图发群；不用了就回到 API keys 页面把它删掉'],
    checked_at: '2026-09-30',
  },
  {
    // 你自己的 Anthropic key：判断、读信用 Haiku 5.5，写东西、对话用 Sonnet 5.5（加好以后自动分给各位成员，lib/claude-defaults.mjs）。
    // 在中国大陆直连会被挡（403），和发信一样走系统代理（lib/claude-api.mjs）。
    key: 'anthropic', label: 'Anthropic（Claude）', kind: 'anthropic_http',
    base_url: 'https://api.anthropic.com', model: 'claude-haiku-5-5', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    signup: 'https://platform.claude.com', key_page: 'https://platform.claude.com/settings/keys',
    price: '每百万 token：Haiku 5.5 输入 0.10、输出 0.50 美元（判断、读信）；Sonnet 5.5 输入 2、输出 10 美元（写东西、对话）',
    steps: [
      '打开 platform.claude.com，注册并登录',
      '在 Billing 页面充值（信用卡），先充 5 美元',
      '打开 platform.claude.com/settings/keys，点「Create Key」，名字填 OfferCrew',
      '把 sk-ant- 开头的 key 复制下来，粘贴到下面的框里',
      '点「测试」，看到「可以用」就好了',
    ],
    notes: ['在中国大陆要开着代理软件的系统代理，不然连不上', 'key 相当于密码：只存在这台电脑上，不要发给别人或截图发群'],
    checked_at: '2026-10-10',
  },
  {
    key: 'openrouter', label: 'OpenRouter（一个 key 用很多家模型）', kind: 'openai_http', wire_api: 'chat',
    base_url: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3.8-flash', models: ['qwen/qwen3.8-flash'],
    signup: 'https://openrouter.ai', key_page: 'https://openrouter.ai/settings/keys',
    price: '按所选模型计价，充值另收 5.5% 手续费',
    steps: [
      '打开 openrouter.ai，用邮箱或 Google 账号注册',
      '在 Credits 页面充值（信用卡或支付宝），先充 5 美元',
      '打开 openrouter.ai/settings/keys，新建一把 key，复制下来粘贴到下面',
      '点「测试」',
    ],
    notes: ['余额变成负数时，连免费模型也会报错'],
    checked_at: '2026-09-30',
  },
  {
    key: 'qwen_intl', label: '通义千问（阿里云国际站）', kind: 'openai_http', wire_api: 'chat',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash', models: ['qwen3.7-flash', 'qwen3.8-flash'],
    signup: 'https://www.alibabacloud.com/product/modelstudio', key_page: null,
    price: '最便宜：qwen3.7-flash 每百万 token 0.03 / 0.13 美元；新账号每个模型有 100 万 token、90 天免费',
    steps: [
      '注册阿里云国际站账号（要一张非中国大陆发行的信用卡，或 PayPal）',
      '开通 Model Studio，在控制台的 API Key 页面新建一把 key',
      '复制粘贴到下面，点「测试」',
    ],
    notes: ['国际站和国内站是两套账号和 key，用错会报 401'],
    checked_at: '2026-09-30',
  },
];

export const presetView = () => ({ presets: PROVIDER_PRESETS.map(({ checked_at, ...p }) => ({ ...p, checked_at })) });

// 预设 + 用户粘贴的 key → addProvider 要的参数。
export function providerFromPreset(key, apiKey) {
  const p = PROVIDER_PRESETS.find(x => x.key === key);
  if (!p) throw Error(`没有这个服务商预设：${String(key).slice(0, 40)}`);
  const token = String(apiKey || '').trim();
  if (!token) throw Error('缺 API key');
  return { key: p.key, label: p.label, kind: p.kind, base_url: p.base_url, api_key: token, models: p.kind === 'anthropic_http' ? [...p.models] : [p.model], wire_api: p.wire_api };
}
