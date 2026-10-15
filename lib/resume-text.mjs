// 材料 · 兼容汉字换成标准汉字（2026-10-02）。不 import 任何东西：导入、导出纯文字、出处核对都从这里拿。
// Mac 导出的中文 PDF，文字层里常带康熙部首这类兼容字符（「⼤」U+2F24、「⽰」U+2F70），长得一样、码位不同：
// 「示例⼤学」搜「大学」搜不到，出处核对和关键词比对都会对不上。
// 只在下面四段码位里逐字做 NFKC，别的字一个不动——整段做 NFKC 会把中文的全角标点「，：；（）」、
// 英文简历里的「Contoso（中国）」改成半角。
//   康熙部首 U+2F00–U+2FDF、CJK 兼容汉字 U+F900–U+FAFF、U+2F800–U+2FA1F：都换成标准汉字；
//   CJK 部首补充 U+2E80–U+2EFF：NFKC 只换其中两个（⺟ U+2E9F → 母、⻳ U+2EF3 → 龟），其余部首没有对应的标准汉字，原样保留。
const COMPAT = /[\u2E80-\u2EFF\u2F00-\u2FDF\uF900-\uFAFF\u{2F800}-\u{2FA1F}]/gu;
export const normalizeCjkCompat = s => String(s ?? '').replace(COMPAT, c => c.normalize('NFKC'));
