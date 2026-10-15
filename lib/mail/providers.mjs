// 内置邮箱（design/desktop-app/方案-内置邮箱.md）第 1 批支持的邮箱：QQ、网易（163 / 126 / yeah.net）、iCloud、个人 Gmail、Yahoo。
// 都走 IMAP + SMTP，用户在邮箱网站上自己生成授权码（或 App 专用密码），粘贴进来；怎么拿写在 docs/mail-auth-code.md，
// 每种邮箱一节，help 是那一节的锚点。服务器地址、端口都是厂商公开的设置；改了这里，也改那份说明。
//
//   认邮箱   providerFor(地址) 只看域名，不联网。认不出的域名，classifyDomain() 可以再查一次 MX 记录（可选）：
//            MX 指向 iCloud 的自定义域名按 iCloud 连；指向 Google Workspace、Microsoft 365、腾讯企业邮、
//            网易企业邮、阿里企业邮的，按学校 / 公司邮箱处理。
//   不支持   学校、公司的邮箱第一批接不上（要管理员或 Google、微软审核），只提示转发到个人邮箱。
//            Outlook / Hotmail 个人邮箱要用微软账号登录，排在第 4 批。
//   加密     只用 TLS：993 / 465 直接加密，iCloud 的 587 要求先 STARTTLS（requireTLS）。不开放明文端口。
import dns from 'node:dns';

export const PROVIDERS = {
  qq: {
    label: 'QQ 邮箱', code: '授权码', help: 'qq',
    // how：邮箱页上一行能直接动手的（第 6b 轮：负责人问「专用密码是啥」）。url 在浏览器里打开。
    how: { text: '网页版 QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 服务，按提示生成授权码', url: 'https://mail.qq.com' },
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
  },
  netease: {
    label: '网易邮箱', code: '授权码', help: '163',
    how: { text: '网页版邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务，拿授权码', url: 'https://mail.163.com' },
    // 163 要求客户端在登录后报上自己的名字（IMAP ID 命令），否则读收件箱时回「Unsafe Login」；imapflow 会自动报（lib/mail/connect.mjs CLIENT_INFO）。
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
  },
  icloud: {
    label: 'iCloud 邮箱', code: 'App 专用密码', help: 'icloud',
    how: { text: '先打开双重认证，再到 Apple 账户 → 登录与安全 → App 专用密码 生成一个', url: 'https://account.apple.com' },
    // Apple 的说明：IMAP 的用户名通常是地址 @ 前面那段，不行再用完整地址；SMTP 用完整地址。
    imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'local-then-full' },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
  },
  gmail: {
    label: 'Gmail', code: '应用专用密码', help: 'gmail', blocked_in_cn: true,
    how: { text: '先在 Google 账号里打开两步验证，再生成一个应用专用密码（16 位）', url: 'https://myaccount.google.com/apppasswords' },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    // 465 不通时试 587（STARTTLS，必须加密）：很多代理节点只放其中一个（lib/mail/connect.mjs routesFor）。
    smtp_alt: { port: 587, secure: false, requireTLS: true },
  },
  yahoo: {
    label: 'Yahoo 邮箱', code: '应用密码', help: 'yahoo',
    how: { text: '到 Yahoo 账户 → 账户安全 → 生成应用密码', url: 'https://login.yahoo.com/account/security' },
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  },
};

// 网易几个域名各有自己的服务器（imap.126.com、imap.yeah.net……），设置都一样。
const NETEASE = { '163.com': '163.com', '126.com': '126.com', 'yeah.net': 'yeah.net', 'vip.163.com': 'vip.163.com', '188.com': '188.com' };
const DOMAINS = {
  'qq.com': 'qq', 'vip.qq.com': 'qq', 'foxmail.com': 'qq',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo',
};
// Yahoo 各地区的域名（yahoo.co.uk、yahoo.com.hk……）用同一组服务器；yahoo.co.jp 是另一家公司（Yahoo! JAPAN），不算。
const YAHOO = /^yahoo\.(?:com|co|[a-z]{2})(?:\.[a-z]{2})?$/;
const OUTLOOK = /^(?:outlook|hotmail|live|msn)\.(?:com|co|[a-z]{2})(?:\.[a-z]{2})?$/;
// 学校：.edu、.edu.cn、.ac.uk 这类。
const SCHOOL = /(?:^|\.)(?:edu(?:\.[a-z]{2})?|ac\.[a-z]{2})$/;

export const FORWARD_HINT = '学校、公司的邮箱暂时接不上。把求职邮件转发到你的个人邮箱（QQ、163、iCloud、Gmail、Yahoo），再连那个邮箱。';
export const OUTLOOK_HINT = 'Outlook / Hotmail 邮箱要用微软账号登录，还接不上。先把求职邮件转发到 QQ、163、iCloud、Gmail 或 Yahoo 邮箱。';
export const UNKNOWN_HINT = '这个邮箱还接不上。现在能连的是 QQ、163 / 126、iCloud、Gmail 和 Yahoo 邮箱。';

export const ADDRESS = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export const normalizeAddress = (v) => String(v || '').trim().toLowerCase();
export const domainOf = (address) => normalizeAddress(address).split('@')[1] || '';

function settings(id, domain) {
  const p = PROVIDERS[id];
  if (id !== 'netease') return p;
  const d = NETEASE[domain] || '163.com';
  return { ...p, imap: { ...p.imap, host: `imap.${d}` }, smtp: { ...p.smtp, host: `smtp.${d}` } };
}
const supported = (id, domain, via = 'domain') => ({ supported: true, provider: id, via, ...settings(id, domain) });
const unsupported = (kind, hint) => ({ supported: false, kind, reason: hint });

// 只看域名：{ supported: true, provider, label, code, help, imap, smtp } 或 { supported: false, kind, reason }。
// kind 是 school / outlook / unknown；unknown 才值得再查 MX（classifyDomain）。
export function providerFor(address) {
  const domain = domainOf(address);
  if (!domain) return unsupported('invalid', '邮箱地址不对，再看一下');
  if (DOMAINS[domain]) return supported(DOMAINS[domain], domain);
  if (NETEASE[domain]) return supported('netease', domain);
  if (domain !== 'yahoo.co.jp' && YAHOO.test(domain)) return supported('yahoo', domain);
  if (OUTLOOK.test(domain)) return unsupported('outlook', OUTLOOK_HINT);
  if (SCHOOL.test(domain)) return unsupported('school', FORWARD_HINT);
  return unsupported('unknown', UNKNOWN_HINT);
}

// MX 记录能看出认不出的域名背后是谁家的邮箱。只认这几种；别的照旧是「还接不上」。
const MX_RULES = [
  [/(?:^|\.)mail\.icloud\.com$/, 'icloud'],
  [/(?:^|\.)(?:google\.com|googlemail\.com|smtp\.goog)$/, 'company'],
  [/(?:^|\.)(?:protection\.outlook\.com|outlook\.com|office365\.us)$/, 'company'],
  [/(?:^|\.)qq\.com$/, 'company'],                       // 腾讯企业邮（mxbiz1.qq.com）、QQ 域名邮箱
  [/(?:^|\.)(?:163\.com|netease\.com|ym\.163\.com|qiye163mx\.com)$/, 'company'], // 网易企业邮
  [/(?:^|\.)(?:mxhichina\.com|aliyun\.com|alibaba-inc\.com)$/, 'company'],          // 阿里企业邮
  [/(?:^|\.)(?:zoho\.com|zoho\.com\.cn|zohomail\.com)$/, 'company'],
];
const MX_TIMEOUT_MS = 4000;
async function lookupMx(domain) {
  const resolver = new dns.promises.Resolver({ timeout: MX_TIMEOUT_MS, tries: 1 });
  return resolver.resolveMx(domain);
}

// 认不出的域名再查一次 MX（可选，失败了就按认不出处理）。resolveMx 可以换成假的（测试、沙盒不联网）。
export async function classifyDomain(address, { resolveMx = lookupMx } = {}) {
  const first = providerFor(address);
  if (first.supported || first.kind !== 'unknown') return first;
  let records = [];
  try { records = await resolveMx(domainOf(address)); } catch { return first; }
  const hosts = (Array.isArray(records) ? records : []).map((r) => String(r?.exchange || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  for (const [re, what] of MX_RULES) {
    if (!hosts.some((h) => re.test(h))) continue;
    if (what === 'company') return unsupported('company', FORWARD_HINT);
    // iCloud+ 的自定义域名：服务器和 iCloud 一样，登录名要用 iCloud 邮箱地址（login），App 专用密码照旧。
    return { ...supported(what, domainOf(address), 'mx'), custom_domain: true };
  }
  return first;
}

// 页面上的一行：哪种邮箱、要什么码、说明在哪一节。
export const providerSummary = (p) => p?.supported
  ? { provider: p.provider, label: p.label, code: p.code, help: `docs/mail-auth-code.md#${p.help}`, ...(p.how ? { how: { ...p.how, ...(p.provider === 'netease' && /^imap\./.test(p.imap?.host || '') ? { url: `https://mail.${p.imap.host.slice(5)}` } : {}) } } : {}), ...(p.blocked_in_cn ? { blocked_in_cn: true } : {}), ...(p.custom_domain ? { custom_domain: true } : {}) }
  : { provider: null, kind: p?.kind || 'unknown', reason: p?.reason || UNKNOWN_HINT };
