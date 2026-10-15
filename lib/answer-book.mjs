// 表单答案簿：你在收件箱里答过一次的申请表问题（出生年月、邮编、性别……），以后任何门户的申请表
// 再问同一项，自动投递直接用，不再问你（harness 第 5 步，2026-09-28）。
//
// candidate/form-answers.json 是本地文件，不进仓库：{ "<规范化的问题>": { label, value, at } }。
// 证件号、银行卡、密码这类问题在 lib/needs.mjs 就被拒收，不会进答案簿。
import { read, write } from './store.mjs';
import { cleanFieldLabel } from './needs.mjs';

export const BOOK_PATH = 'candidate/form-answers.json';
export const bookKey = label => cleanFieldLabel(label).toLowerCase().replace(/[\s:：*＊?？()（）]/g, '');
export const loadBook = () => read(BOOK_PATH, {});
export const lookup = (book, label) => book[bookKey(label)]?.value ?? null;

// pairs：[{ label, value }]。空值不记；同一个问题以最新的为准。
export function remember(pairs, { now = Date.now() } = {}) {
  const book = loadBook();
  let n = 0;
  for (const { label, value } of pairs) {
    const k = bookKey(label), v = String(value ?? '').trim();
    if (!k || !v) continue;
    book[k] = { label: cleanFieldLabel(label), value: v.slice(0, 500), at: new Date(now).toISOString() };
    n++;
  }
  if (n) write(BOOK_PATH, book);
  return n;
}
