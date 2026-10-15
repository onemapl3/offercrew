// 申请表题目给人看的样子：去掉区块名、内部 id、占位字，截短不把词切开。只有文字处理，不引别的模块
// （lib/needs.mjs 和 lib/apply-words.mjs 都用；以前在 needs 里，apply-words 一引就成了环）。
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// 申请表控件的名字常带着区块名和内部 id（"Postal Code/Zip Contact Information Contact_Information_q_zip"）：
// 只留给人看的那一段（"Postal Code/Zip"）。答案簿也按这个名字存取，同一个问题在不同门户能对上。
function stripLabel(raw) {
  let s = clean(raw).replace(/[*＊✱]+$/, '').trim();
  s = s.split(/\s(?:Contact Information|Personal Information|Application Questions|Self[- ]Identification|Voluntary Disclosures?)\b/i)[0];
  // 输入框里的占位字（「Type here...」「Start typing...」「hello@example.com...」「1-415-555-1234...」）和内部编号（UUID）不是题目。
  s = s.replace(/(?:type here|start typing|search|select|choose)\s*(?:\.\.\.|…)/gi, ' ');
  s = s.split(' ').filter(t => t && !/_|^input-\d+$|^select$/i.test(t) && !(/^[0-9a-f]{8}(?:-[0-9a-f]*)*$/i.test(t) && /\d/.test(t)) && !/(?:\.\.\.|…)$/.test(t)).join(' ').trim();
  // 抽取脚本把控件的 name / id 接在「名字 *」后面（"出生年月 * birth_month birth_month"、"Email * email email"、Lever 的 "Full name ✱ name"）：
  // 必填星号之后的都不是给人看的。
  s = s.split(/\s?[*＊✱](?=\s|$)/)[0].replace(/[\s*＊✱]+$/, '').trim();
  return s;
}
export const cleanFieldLabel = raw => stripLabel(raw).slice(0, 40);
// 截短给人看的一句话，不把一个词、一道题从中间切开：先在题目之间（、；。，）断开，没有再在词之间（空格）断开，
// 都没有（整段中文）才硬切。09-30 真实测试：信里的「还要你补」被切成「Location (Cit…」。
export function clipText(t, n) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n - 1), at = cs => Math.max(...cs.map(c => head.lastIndexOf(c)));
  const i = at(['、', '；', '。', '，', ';']), j = at([' ', ',']);
  const end = i >= Math.min(8, n / 3) ? i : j >= n / 2 ? j : n - 1;
  return head.slice(0, end).replace(/[、；。，,;:：\s]+$/, '') + '…';
}
// 信里给人看的题目：同样去掉占位字和内部编号，但不截到 40 字（答案簿的键才截）。长题目整句给出，页面上折行；
// 只有长到一段话（同意条款之类）才在 200 字前的词间断开。
export const fieldQuestion = raw => clipText(stripLabel(raw), 200);
// 「名字|名字」（原因码）或名字数组 → 给人看的题目清单，去重、去空。
export const fieldQuestions = raw => [...new Set((Array.isArray(raw) ? raw : String(raw ?? '').split('|')).map(fieldQuestion).filter(Boolean))];
