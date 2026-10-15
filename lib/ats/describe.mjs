// 把招聘系统给的一整块 HTML 描述，整理成匹配器读得懂的纯文本。
//
// lib/matcher.mjs 的 requirementClauses 按空行把 JD 切开：第一段算职责，后面的算任职要求，只有要求才是门槛。
// 北森、腾讯这类接口本来就把职责和要求分成两个字段，用不上这里；甲骨文、Oleeo 这类只给一整块 HTML 的，
// 如果直接用 plain() 压成一行，职责和要求就分不开了。所以：块级标签（段落、列表项、标题、换行）变成换行，
// 每一行各自去标签；碰到「Required qualifications」「任职要求」这样的小标题，在它前面空一行。
import { plain } from './http.mjs';

const BLOCK = /<\/(?:p|div|li|h[1-6]|ul|ol|tr|table|section)>|<br\s*\/?>/gi;
// 英文招聘常见的要求小标题（Required / Preferred qualifications、What you'll need……），和 lib/ats/moka.mjs
// 认的中文小标题。「Preferred」也算：它后面的每一条都是要求，只是匹配器会把写了 preferred 的那一句当成加分项。
export const REQUIREMENT_HEADING =
  /^[【\[]?\s*(?:(?:required|minimum|basic|preferred|desired|key|additional)\s+)?(?:qualifications?|requirements?)\b|^(?:skills (?:and|&) (?:experience|qualifications)|what (?:you(?:'|’)ll need|you need|we(?:'|’)re looking for|we look for|you bring)|who you are|about you|your profile|you (?:have|bring)|required skills)\b|^[【\[]?(?:任职要求|岗位要求|任职资格|任职条件|职位要求|基本要求|我们希望你|我们期待|我们在寻找|要求)/i;

export function describe(html) {
  const lines = String(html || '').replace(BLOCK, '\n').split('\n').map(plain).filter(Boolean);
  return lines.map((line, i) => (i && REQUIREMENT_HEADING.test(line) ? `\n${line}` : line)).join('\n');
}
