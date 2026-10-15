// 材料 · PDF 抽出来的文字按版面排回阅读顺序（2026-10-02，开箱第 2 轮 N02）。
//
// pdftotext 不加 -layout 时按自己的阅读顺序吐字：同一行里换了字体的一段（「Example Tech (示例科技)」的中文那半）、
// 右对齐的日期那一栏，都会被拆出去单独排，日期还会跑到后面的栏目底下。加了 -layout，每一行照版面原样输出，
// 栏与栏之间用一串空格隔开。这里再整理一遍：
//   - 每一行去掉两头空格，连续空格压成一个（栏与栏之间的一大段空白留两格）；括号和汉字之间多出来的空格去掉（「( 示例科技)」→「(示例科技)」）；
//   - 双栏的页（左边主栏、右边侧栏，或反过来）：-layout 会把两栏的同一行拼在一行里，中间隔一大段空格。
//     认法：很多行在同一个位置（±2 格）起头一段文字，这一段的结尾参差不齐（左对齐的一栏），而且左边那一栏不是只有日期；
//     右对齐的日期栏结尾整齐，日期在左边的一窄条（「2019.09 - 2023.06    示例大学」）左栏只有日期，都不算双栏。
//     认出来就在那个位置切开，先出左栏、再出右栏，两栏不交错。
// macOS 自带的 PDFKit（没装 poppler 时用）给的是一行一行的选区和坐标：boxesLayout 先按坐标排成 -layout 那样的版面，
// 再走同一个 layoutText。只 import lib/resume-doc.mjs 认栏目名的两个函数（它不 import 任何东西）。
import { headingKind, customHeading } from './resume-doc.mjs';
const GAP = / {3,}(?=\S)/g;
const DATEISH = /^[^\p{L}\d]{0,3}(?:[A-Za-z]{3,9}\.?\s*)?(?:19|20)\d{2}(?:\s*[./年-]\s*\d{1,2}\s*月?)?(?:\s*(?:-|–|—|~|～|至|到|to)\s*(?:(?:[A-Za-z]{3,9}\.?\s*)?(?:19|20)\d{2}(?:\s*[./年-]\s*\d{1,2}\s*月?)?|至今|现在|present|now|current))?\s*$/iu;
const near = (a, b) => Math.abs(a - b) <= 2;

// 一行 → 去掉多余空格的样子：一大段空格（三格以上，原来是两栏之间的空白）留两格，别的连续空格压成一格。
// 两格是「这里分栏」的记号：离线整理（lib/resume-offline.mjs cellsOf）和段落名（lib/resume-doc.mjs entryName）都按两格以上分栏，
// 「Software Engineer  Remote」里的地点、「Example Tech (示例科技)  Jul 2023 – Present」里的日期才分得出来；页面上看还是一格。
export const squashLine = line => String(line).replace(/[\t\u00a0\u3000]/g, ' ').trim().replace(/ {2,}/g, m => m.length >= 3 ? '  ' : ' ')
  .replace(/([(（[【]) (?=[㐀-鿿])/gu, '$1').replace(/(?<=[㐀-鿿]) ([)）\]】])/gu, '$1');

// 一页（-layout 的样子）里有没有第二栏：有就给出它起头的位置，没有给 null。
export function secondColumn(lines) {
  const starts = []; // [行号, 起头, 结尾]
  let longest = 0;
  lines.forEach((l, i) => {
    const end = l.trimEnd().length;
    longest = Math.max(longest, end);
    if (!end) return;
    const lead = l.length - l.replace(/^ +/, '').length;
    if (lead >= 3) starts.push([i, lead, segEnd(l, lead)]);
    for (const m of l.matchAll(GAP)) { const s = m.index + m[0].length; if (s > lead) starts.push([i, s, segEnd(l, s)]); }
  });
  const filled = lines.filter(l => l.trim()).length;
  if (starts.length < 5 || longest < 40) return null;
  // 起头最集中的位置（±2 格）。按位置计数，特制的长文件也是线性时间。
  const at = new Map();
  for (const [, s] of starts) at.set(s, (at.get(s) || 0) + 1);
  const around = s => [-2, -1, 0, 1, 2].reduce((n, d) => n + (at.get(s + d) || 0), 0);
  let best = null;
  for (const s of at.keys()) { const n = around(s); if (!best || n > best.n) best = { s, n }; }
  const hits = starts.filter(x => near(x[1], best.s));
  const rows = new Set(hits.map(x => x[0]));
  if (rows.size < Math.max(5, filled * 0.25)) return null;
  const col = hits.reduce((m, x) => Math.min(m, x[1]), Infinity);
  // 侧栏可以很窄（Letter 纸上 2 英寸左右，十几、二十格）：起头不早于整行的 15% 就算（以前要 25%，窄侧栏的两栏被交错拼在一起，10-04）。
  if (col < longest * 0.15 || col > longest * 0.8) return null;
  // 结尾整齐的是右对齐的一栏（日期、地点），不是第二栏。
  const endAt = new Map();
  for (const x of hits) endAt.set(x[2], (endAt.get(x[2]) || 0) + 1);
  const modal = [...endAt.keys()].reduce((m, e) => Math.max(m, (endAt.get(e - 1) || 0) + endAt.get(e) + (endAt.get(e + 1) || 0)), 0);
  if (modal >= hits.length * 0.6) return null;
  // 左边那一栏只有日期：是日期在左的单栏简历。
  const lefts = [...rows].map(i => lines[i].slice(0, col).trim()).filter(Boolean);
  if (lefts.length && lefts.filter(t => DATEISH.test(t)).length >= lefts.length * 0.5) return null;
  // 左边那一窄条大多是空的、或者写的大多是栏目名（「EXPERIENCE」）：是栏目名写在左边的单栏简历，不是侧栏。
  // 当双栏切开，栏目名会全挪到页尾、内容全挤进一栏（10-04）。原样留着，栏目名由 lib/resume-doc.mjs 拆出来。
  if (lefts.length < rows.size * 0.3 || lefts.filter(t => headingKind(t) || customHeading(t, { caps: true })).length >= lefts.length * 0.6) return null;
  return col;
}
// 从 s 起这一段到哪儿结束（下一段大空格之前或行尾）。
function segEnd(line, s) {
  const rest = line.slice(s), m = / {3,}\S/.exec(rest);
  return s + (m ? m.index : rest.trimEnd().length);
}

// pdftotext -layout 的输出（或 boxesLayout 排出来的）→ 按阅读顺序的文字，一行一行，空格压好。
export function layoutText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\f').map(page => {
    const lines = page.split('\n').map(l => l.replace(/\t/g, '    ').trimEnd());
    const col = secondColumn(lines);
    if (col == null) return lines.map(squashLine).join('\n');
    const left = [], right = [];
    for (const l of lines) {
      if (!l.trim()) { left.push(''); right.push(''); continue; }
      // 在第二栏起头的地方切：切口前面要是至少两格空白，不然这一行是横跨两栏的（抬头的姓名、整行的标题）。
      if (l.length > col && l[col - 1] === ' ' && l[col - 2] === ' ') {
        const a = squashLine(l.slice(0, col)), b = squashLine(l.slice(col));
        if (a) left.push(a);
        if (b) right.push(b);
      } else left.push(squashLine(l));
    }
    return [...left, '', ...right].join('\n');
  }).join('\f');
}

// PDFKit 的一行一行选区：[页, x, y, 宽, 高, 文字]（PDF 坐标，y 朝上）→ -layout 那样的版面，再 layoutText。
export function boxesLayout(boxes) {
  const items = (Array.isArray(boxes) ? boxes : []).map(b => ({ page: Number(b[0]) || 0, x: Number(b[1]) || 0, y: Number(b[2]) || 0, w: Number(b[3]) || 0, h: Number(b[4]) || 0, text: String(b[5] ?? '').replace(/\s+/g, ' ').trim() })).filter(b => b.text);
  if (!items.length) return '';
  // 一格多宽：拉丁字母多的选区按「宽 ÷ 字数」取中位数。
  const widths = items.filter(b => b.text.length >= 4 && !/[㐀-鿿]/.test(b.text) && b.w > 0).map(b => b.w / b.text.length).sort((a, b) => a - b);
  const unit = widths.length ? widths[Math.floor(widths.length / 2)] : 6;
  const pages = [...new Set(items.map(b => b.page))].sort((a, b) => a - b);
  return layoutText(pages.map(p => {
    const on = items.filter(b => b.page === p).sort((a, b) => (b.y + b.h / 2) - (a.y + a.h / 2) || a.x - b.x);
    const left = Math.min(...on.map(b => b.x));
    const rows = [];
    for (const b of on) {
      const row = rows.at(-1), mid = b.y + b.h / 2;
      if (row && Math.abs(row.mid - mid) < Math.min(row.h, b.h || row.h) / 2) row.boxes.push(b);
      else rows.push({ mid, h: b.h || 1, boxes: [b] });
    }
    return rows.map(r => {
      let out = '', right = -Infinity;
      for (const b of r.boxes.sort((a, c) => a.x - c.x)) {
        // 同一行被切成几块（换字体、字距）：挨着的直接接上，不插空格（以前「Mor gan」「负责 推荐服务」，10-04）；
        // 隔开小半格以上是一个空格；隔得远（两格以上）至少空三格，后面才认得出是另一栏。
        const gap = b.x - right;
        if (out.length && gap < unit * 0.3) { out += b.text; right = Math.max(right, b.x + b.w); continue; }
        const wide = gap > unit * 2;
        const col = !out.length ? Math.min(Math.round((b.x - left) / unit), 400) : wide ? Math.max(Math.min(Math.round((b.x - left) / unit), 400), out.length + 3) : out.length + 1; // 特制文件的坐标再离谱也只补到 400 格
        out = out.padEnd(col, ' ') + b.text;
        right = Math.max(right, b.x + b.w);
      }
      return out;
    }).join('\n');
  }).join('\f'));
}
