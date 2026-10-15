// 兑换码的格式（2026-09-30，design/pricing/收费版调研.md 5.3）：OC-7K3M-Q9TD-X2HB-4WNP。
//
// 16 个字符分 4 组，用 Crockford Base32 的字符表（0-9 加去掉 I L O U 的 22 个字母）。前 15 个是随机的（75 位），
// 最后 1 个是校验位：Σ(第 i 位的值 × i) mod 31，i 从 1 数到 15。它不防伪（防伪靠中转查账：码是随机的，中转只存它的
// HMAC 指纹），只用来在用户抄错一位（或者把相邻两位抄反）时当场说「看起来输错了一位」，不用去中转白白算一次失败。
// 面额、批次、渠道都不写在码里，记在中转的账上。
//
// 这个文件不 import 任何东西：App（lib/free-model.mjs）和中转（relay/model/worker.mjs，wrangler 打包时带上）共用。
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_BODY = 15;

const valueOf = c => CODE_ALPHABET.indexOf(c);
export function checkChar(body) {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += valueOf(body[i]) * (i + 1);
  return CODE_ALPHABET[s % 31];
}

// 用户输入 → 16 个字符（没有前缀、没有横线）。大写、去掉空格和横线、去掉开头的 OC；O 当 0，I 和 L 当 1。
// 回 { ok: true, code } 或 { ok: false, error: 'empty' | 'bad_format' | 'bad_check' }。
export function normalizeCode(input) {
  let s = String(input ?? '').toUpperCase().replace(/[\s\-_–—·.]/g, '');
  if (!s) return { ok: false, error: 'empty' };
  if (s.length === 18 && s.startsWith('OC')) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_BODY + 1 || [...s].some(c => valueOf(c) < 0)) return { ok: false, error: 'bad_format' };
  if (checkChar(s.slice(0, CODE_BODY)) !== s[CODE_BODY]) return { ok: false, error: 'bad_check' };
  return { ok: true, code: s };
}

// 16 个字符 → 给人看的 OC-XXXX-XXXX-XXXX-XXXX。
export const formatCode = code => `OC-${code.match(/.{4}/g).join('-')}`;
// 只露最后 4 位（兑换记录里用，不存整张码）。
export const maskCode = code => `OC-····-····-····-${String(code).slice(-4)}`;

// 生成一张：randomBytes(n) 回 n 个随机字节（中转里用 crypto.getRandomValues）。拒绝采样，32 正好整除 256，直接取低 5 位。
export function makeCode(randomBytes) {
  const b = randomBytes(CODE_BODY);
  let body = '';
  for (let i = 0; i < CODE_BODY; i++) body += CODE_ALPHABET[b[i] & 31];
  return body + checkChar(body);
}

// 给人看的错误（App 当场判，中转也用同一套）。
export const CODE_REASON = {
  empty: '请输入兑换码',
  bad_format: '这不是兑换码的格式，请检查一下',
  bad_check: '看起来输错了一位，请检查一下',
  not_found: '没找到这张兑换码',
  used: '这张码已经被使用过',
  void: '这张码已失效，请联系我们',
  expired: '这张码已失效，请联系我们',
  too_many_tries: '尝试次数太多，请一小时后再试',
};
