// 产品名只在这里写一次：飞书卡片、简报、回执、对话和执行器的提示词、浏览器任务空间名、
// 配置文件注释都从这里读。没有中文名；需要一句中文说明时用标语（「你的私人求职团队」），不当名字用。
// 静态文件（web/*.html、config/*prompt*.md、docs、skills、README、bin/host/*.sh）里的名字是文字，
// tests/brand.test.mjs 核对它们和这里一致。改名：改这一行，再替换那些文件里的旧名字。
export const BRAND = 'OfferCrew';

// 团队成员的显示名和脸：只有一处，在 lib/crew.mjs（NAMES、FACES）；这里转出去给只要名字的地方（桌面 App 的通知等）。
// 内部 id 是 scout / lens / tailor / quill / owl / patch；老编号（radar / reacher / watch / system / executor）只在 lib/crew.mjs 的 LEGACY 里换。
export { CREW } from './crew.mjs';

// OfferCrew 补给的中转（relay/model/，负责人部署在 Cloudflare）：新用户不用 key 就能先用模型（lib/free-model.mjs）。
// fork 的人改成自己的中转地址，或者改成空串关掉 OfferCrew 补给。环境变量 OFFERCREW_FREE_RELAY 可以临时覆盖（空串 = 关）。
export const FREE_MODEL_RELAY = 'https://offercrew.onemaple.cc/model/v1';
// OfferCrew 补给开没开：v0.1 放内测补给（负责人 09-30 15:5x：「还是得给点免费额度，不然没法开箱即用」；10-02 改叫「补给」）。每台新装试用 7 天、送 400 万 token（10-03），
// 前 200 台，全站每天最多 10 美元，都在中转 relay/model/wrangler.toml 里；加点、发邀请码只有负责人能做（bin/credits-admin.mjs）。
// 改成 false 就关：引导和设置里不出现这个选项，也不联网。环境变量覆盖了地址就不看这个开关（测试、本机的 wrangler dev）。
export const FREE_MODEL_ON = true;

// 买补给的地址（兑换码在那里卖）。中转 /models 带回来的 buy_url 优先（负责人改中转就能换，不用发新版）；
// 这里是没有中转地址时的后备，默认空 = 界面上不显示这个按钮。环境变量 OFFERCREW_BUY_URL 可以临时覆盖。只认 https。
export const BUY_POINTS_URL = '';
