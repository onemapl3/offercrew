// 简历助手 · 导出：一份结构化简历（content）→ 打印用 HTML、PDF（本机 Chromium 打印）、Word（.docx，自己打 zip），
// 再把导出的文件读回文字，逐行核对「ATS 能不能把每一行读出来」（2026-09-29）。
//
// content：{ lang, header: [姓名行, 联系方式行…], sections: [{ id, kind, title|null, entries: [{ id, head: [行…], lines: [行…] }] }] }，
// 行是 { id, text, bullet?, em? }：head 第一行加粗；bullet: true 画成要点；em 是这行里要加粗的原文片段（只加粗真出现的）。
// 文字一律当不可信的：HTML / XML 全部转义，XML 1.0 不允许的控制字符去掉。版式为 ATS 着想：单栏、真文字（没有图片、
// 图标、排版用的表格），阅读顺序 = 文档顺序。本模块不碰工作台状态：只收 content 和路径，写文件先写 .tmp 再改名。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { localOnly } from './sandbox.mjs';
import { extractText } from './resume-extract.mjs';
import { normalizeCjkCompat } from './resume-text.mjs';

// ── 输入整理 ────────────────────────────────────────────────────────────────
// XML 1.0 不允许的字符（\t \n \r 以外的控制字符、落单的代理项、U+FFFE/FFFF）连同 DEL、C1 控制字符去掉；行内的换行当空格。
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const clean = s => String(s ?? '').replace(BAD, '').replace(/[\t\r\n]+/g, ' ');
const line = l => l && typeof l === 'object' ? { id: String(l.id ?? ''), text: clean(l.text).trim(), bullet: l.bullet === true, em: Array.isArray(l.em) ? l.em.map(e => clean(e).trim()).filter(Boolean) : [] } : null;
const lines = xs => (Array.isArray(xs) ? xs : []).map(line).filter(l => l?.text); // 空行不画、不核对
function shape(c) {
  const sections = (Array.isArray(c?.sections) ? c.sections : []).map(s => {
    const title = line(s?.title);
    const entries = (Array.isArray(s?.entries) ? s.entries : []).map(e => ({ id: String(e?.id ?? ''), head: lines(e?.head), lines: lines(e?.lines) })).filter(e => e.head.length || e.lines.length);
    return { id: String(s?.id ?? ''), kind: String(s?.kind ?? 'other'), title: title?.text ? title : null, entries };
  }).filter(s => s.title || s.entries.length);
  return { lang: c?.lang === 'zh' ? 'zh' : 'en', header: lines(c?.header), sections };
}
// 阅读顺序里的每一行：姓名、联系方式、节标题、条目抬头、正文。
const everyLine = c => [...c.header, ...c.sections.flatMap(s => [...(s.title ? [s.title] : []), ...s.entries.flatMap(e => [...e.head, ...e.lines])])];
const docTitle = (c, title) => clean(title).trim() || c.header[0]?.text || (c.lang === 'zh' ? '简历' : 'Resume');
// 加粗：em 里真出现在这行的片段才加粗；英文片段不从单词中间截（em「Go」不会把「Google」的 Go 加粗）。
const WORD = /[A-Za-z0-9]/;
function segments({ text, em }) {
  const bold = new Uint8Array(text.length);
  for (const k of em) for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) {
    const j = i + k.length;
    if (!(WORD.test(k[0]) && WORD.test(text[i - 1] ?? '')) && !(WORD.test(k.at(-1)) && WORD.test(text[j] ?? ''))) bold.fill(1, i, j);
  }
  const out = [];
  for (let i = 0, j; i < text.length; i = j) { for (j = i + 1; j < text.length && bold[j] === bold[i]; j++); out.push({ text: text.slice(i, j), bold: bold[i] === 1 }); }
  return out;
}

// ── HTML（打印用）──────────────────────────────────────────────────────────
// 字体：拉丁字 Helvetica Neue / Arial，中文先用黑体（Heiti SC / 微软雅黑）。苹方、冬青黑、系统字体被 Chrome 当 Type 3 字形
// 嵌进 PDF，pdftotext 会把中英混排的一行拆成两段、顺序也乱；黑体 / 雅黑嵌成真正的 TrueType，读回来是完整的一行。
// 连字关掉（fi / fl 读回来就是两个字母）；不用字间距（有的解析器会读成「E x p」）。
// 条目抬头一行一行往下排，不把日期推到右边：右对齐（哪怕同一行隔开一点）的日期会被 pdftotext 当成另一栏，
// 挪到下一段甚至整页最后。要点用文字的「•」当列表符号：读回来每条前面都有记号，折行的续行不会被当成新的一条。
const FONTS = '"Helvetica Neue", Arial, "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", sans-serif';
const CSS = `@page{size:A4;margin:16mm}
html{background:#fff}
body{margin:0;color:#111;font-family:${FONTS};font-size:10.5pt;line-height:1.4;font-variant-ligatures:none;overflow-wrap:break-word}
h1,h2,h3,p,ul{margin:0;padding:0}
h1{font-size:20pt;line-height:1.2;font-weight:700}
.contact{margin-top:3pt;font-size:9.5pt;color:#333}
section{margin-top:10pt}
h2{font-size:11.5pt;line-height:1.3;font-weight:700;padding-bottom:2pt;margin-bottom:4pt;border-bottom:.75pt solid #999;break-after:avoid}
.entry+.entry{margin-top:6pt}
.head{break-inside:avoid;break-after:avoid}
.head h3{font-size:1em;font-weight:700}
.head p{margin-top:1pt;font-size:10pt;color:#555}
.head .gap{display:inline-block;width:1.5em}
ul{margin-top:2pt;padding-left:12pt;list-style-type:"\\2022\\a0\\a0"}
li,.line{margin-top:1.5pt;break-inside:avoid}
strong{font-weight:700}
@media screen{html{background:#eceff3}body{box-sizing:border-box;max-width:210mm;min-height:297mm;margin:24px auto;padding:16mm;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}}`;
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const inline = l => segments(l).map(s => s.bold ? `<strong>${esc(s.text)}</strong>` : esc(s.text)).join('');
const gapped = html => String(html).replace(/ {2,}/g, ' <span class="gap"></span>');
const at = o => ` data-id="${esc(o.id)}"`; // 预览里按行号定位用；不进 PDF 的文字
export function renderHtml(content, { title } = {}) {
  const c = shape(content), [name, ...contacts] = c.header;
  let body = '';
  if (name) body += `<header><h1${at(name)}>${inline(name)}</h1>${contacts.length ? `<p class="contact">${contacts.map(l => `<span${at(l)}>${inline(l)}</span>`).join('<span class="sep"> · </span>')}</p>` : ''}</header>`;
  for (const s of c.sections) {
    body += `<section${at(s)} data-kind="${esc(s.kind)}">${s.title ? `<h2${at(s.title)}>${inline(s.title)}</h2>` : ''}`;
    for (const e of s.entries) {
      body += `<div class="entry"${at(e)}>`;
      // 抬头里原文隔开的几栏（两格以上空白）：拉开一点（空的 inline-block，不加字，读回来还是一行），不推到右边。
      if (e.head.length) body += `<div class="head">${e.head.map((l, i) => i ? `<p${at(l)}>${gapped(inline(l))}</p>` : `<h3${at(l)}>${gapped(inline(l))}</h3>`).join('')}</div>`;
      let ul = false; // 连续的要点合成一个 <ul>
      for (const l of e.lines) {
        if (l.bullet !== ul) { body += ul ? '</ul>' : '<ul>'; ul = l.bullet; }
        body += l.bullet ? `<li${at(l)}>${inline(l)}</li>` : `<p class="line"${at(l)}>${inline(l)}</p>`;
      }
      body += `${ul ? '</ul>' : ''}</div>`;
    }
    body += '</section>';
  }
  return `<!doctype html>\n<html lang="${c.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(docTitle(c, title))}</title><style>${CSS}</style></head><body>${body}</body></html>\n`;
}

// 匹配用的文字版：阅读顺序，一行一行；要点前面加「- 」，加粗不留标记。
export function plainText(content) {
  const c = shape(content), out = c.header.map(l => l.text);
  for (const s of c.sections) {
    out.push('');
    if (s.title) out.push(s.title.text);
    s.entries.forEach((e, i) => { if (i && e.head.length) out.push(''); out.push(...e.head.map(l => l.text), ...e.lines.map(l => l.bullet ? `- ${l.text}` : l.text)); });
  }
  // candidate/resume.tex 和投递留底的纯文字：旧数据里的兼容汉字在这里换掉（盘上的简历不改）。
  return normalizeCjkCompat(out.join('\n').trim());
}

// ── 写文件：先写 .tmp 再改名，半截的文件不会顶替上一版 ─────────────────────────
function save(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  try { fs.writeFileSync(tmp, buf); fs.renameSync(tmp, abs); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return { file: abs, bytes: buf.length };
}

// ── PDF：本机 Chromium 打印 renderHtml（带结构标签的 PDF，文字是真文字）─────────────
// 先用 Playwright 自带的无头 Chromium，没有再用装好的 Chrome。启动放在 localOnly() 里：演示 / 沙盒模式也能导出
// （闸只放行这一次本机程序）。页面完全离线：不跑脚本、所有请求都掐掉（setContent 本身不用网络）。整体 60 秒封顶。
// browsers / timeout 两个选项给测试用（换一组启动参数、缩短时限）。
const LAUNCH = [{}, { channel: 'chrome' }];
const MARGIN = { top: '16mm', right: '16mm', bottom: '16mm', left: '16mm' };
const short = e => { const m = String(e?.message || e).split('\n')[0].replace(/^[\w.]+: /, '').trim(); return /doesn't exist|is not found|not found at|ENOENT/i.test(m) ? '没装' : m.slice(0, 120); };
const noBrowser = why => Object.assign(Error(`导出 PDF 要用 Chrome 或 Chromium，这台电脑上没找到（Word 版不受影响）：${why}`), { code: 'NO_BROWSER' });
const shut = b => b && Promise.race([b.close().catch(() => {}), new Promise(r => setTimeout(r, 5000).unref())]); // 兜底：浏览器已经关了
export async function exportPdf(content, abs, { title, browsers = LAUNCH, timeout = 60000 } = {}) {
  const html = renderHtml(content, { title });
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch (e) { throw noBrowser(`playwright-core 没装（${short(e)}）`); }
  let browser = null, over = false, timer;
  const job = (async () => {
    const tried = [];
    for (const opts of browsers) {
      if (over) return null;
      try { browser = await localOnly(() => chromium.launch({ headless: true, timeout: 25000, ...opts })); break; }
      catch (e) { tried.push(`${opts.channel === 'chrome' ? 'Chrome' : opts.channel || opts.executablePath || '内置 Chromium'}：${short(e)}`); }
    }
    if (over) return null;
    if (!browser) throw noBrowser(tried.join('；'));
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
      await context.route('**/*', r => r.abort());
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      return await page.pdf({ format: 'A4', printBackground: false, preferCSSPageSize: true, tagged: true, margin: MARGIN });
    } catch (e) { throw Object.assign(Error(`导出 PDF 没成功：${short(e)}`), { code: 'PDF_FAILED', cause: e }); }
  })();
  job.catch(() => {}); // 超时之后它才失败，不算没人接的 rejection // 兜底：超时之后它才失败，不算没人接的 rejection
  try {
    const pdf = await Promise.race([job, new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(Error(`导出 PDF 超时（${Math.ceil(timeout / 1000)} 秒没做完）`), { code: 'PDF_TIMEOUT' })), timeout); })]);
    return save(abs, pdf);
  } finally {
    over = true;
    clearTimeout(timer);
    await shut(browser);
    job.then(() => shut(browser), () => shut(browser)); // 超时那一刻浏览器还在启动：起来之后马上关，不留孤儿进程
  }
}

// ── Word（.docx）：自己拼 Office Open XML、自己打 zip，不用任何库 ─────────────────
// 样式：正文 Arial / 苹方（Word 里找不到苹方时按字体表换成微软雅黑）10.5 磅；姓名用 Title，节标题用 Heading1
// （Word 和 ATS 都认得的内置名字）；要点是「•」+ 制表符 + 悬挂缩进的普通段落，不用 numbering.xml。
// document.xml 里标签之间不留空白：读 .docx 的程序（包括 lib/resume-import.mjs 的 docxText）会把它当正文。
const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const x = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const run = (text, bold) => `<w:r>${bold ? '<w:rPr><w:b/><w:bCs/></w:rPr>' : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
const runs = (l, bold = false) => segments(l).map(s => run(s.text, bold || s.bold)).join('');
const para = (style, body, pPr = '') => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pPr}</w:pPr>${body}</w:p>`;
// 要点的缩进和制表位在段落上再写一遍：苹果的 .docx 读法（预览、邮件附件预览、TextEdit）不认样式里的这两项。
const HANG = '<w:tabs><w:tab w:val="left" w:pos="284"/></w:tabs><w:ind w:left="284" w:hanging="284"/>';
function documentXml(c) {
  const [name, ...contacts] = c.header;
  let b = '';
  if (name) b += para('Title', runs(name));
  if (contacts.length) b += para('Contact', contacts.map(l => runs(l)).join(run(' · ')));
  for (const s of c.sections) {
    if (s.title) b += para('Heading1', runs(s.title));
    for (const e of s.entries) {
      e.head.forEach((l, i) => { b += para(i ? 'EntryMeta' : 'EntryHead', runs(l, i === 0)); });
      for (const l of e.lines) b += l.bullet ? para('Bullet', `<w:r><w:t>•</w:t><w:tab/></w:r>${runs(l)}`, HANG) : para('Line', runs(l));
    }
  }
  // A4，页边距 16 mm（907 twip）；一个段落都没有的正文 Word 会当坏文件。
  return `${XML}<w:document xmlns:w="${WNS}" xmlns:r="${RNS}"><w:body>${b || '<w:p/>'}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="907" w:right="907" w:bottom="907" w:left="907" w:header="454" w:footer="454" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}
// 元素顺序照 schema 排（Word 对 pPr / rPr 里的顺序较真）。
const style = (id, name, pPr = '', rPr = '', extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`;
const sz = hp => `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
// 字体和字号在 Normal 样式里也写一遍：苹果的读法不看 docDefaults。
const BASE_FONT = `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="PingFang SC" w:cs="Arial"/>${sz(21)}`;
const STYLES = `${XML}<w:styles xmlns:w="${WNS}"><w:docDefaults><w:rPrDefault><w:rPr>${BASE_FONT}<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
  + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${BASE_FONT}</w:rPr></w:style>`
  + style('Title', 'Title', '<w:spacing w:after="40"/>', `<w:b/><w:bCs/>${sz(40)}`, '<w:next w:val="Normal"/><w:qFormat/>')
  + style('Contact', 'Contact', '<w:spacing w:after="120"/>', `<w:color w:val="333333"/>${sz(19)}`)
  + style('Heading1', 'heading 1', '<w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="999999"/></w:pBdr><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="0"/>', `<w:b/><w:bCs/>${sz(23)}`, '<w:next w:val="Normal"/><w:qFormat/>')
  + style('EntryHead', 'Entry Heading', '<w:keepNext/><w:keepLines/><w:spacing w:before="100"/>', '', '<w:next w:val="EntryMeta"/>')
  + style('EntryMeta', 'Entry Details', '<w:keepNext/><w:keepLines/>', `<w:color w:val="555555"/>${sz(20)}`)
  + style('Bullet', 'Bullet Line', '<w:tabs><w:tab w:val="left" w:pos="284"/></w:tabs><w:spacing w:before="30"/><w:ind w:left="284" w:hanging="284"/>')
  + style('Line', 'Body Line', '<w:spacing w:before="30"/>')
  + '</w:styles>';
// 字体表：苹方的备用名写微软雅黑、字符集写 GB2312（86）——Windows 上的 Word 没有苹方时就换成雅黑，而不是宋体。
const FONT = (name, alt, panose, charset) => `<w:font w:name="${name}">${alt ? `<w:altName w:val="${alt}"/>` : ''}<w:panose1 w:val="${panose}"/><w:charset w:val="${charset}"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>`;
const FONT_TABLE = `${XML}<w:fonts xmlns:w="${WNS}">${FONT('Arial', '', '020B0604020202020204', '00')}${FONT('PingFang SC', 'Microsoft YaHei', '020B0400000000000000', '86')}${FONT('Microsoft YaHei', '微软雅黑', '020B0503020204020204', '86')}</w:fonts>`;
// 设置：默认制表位 = 要点的缩进（苹果的读法只认默认制表位，不然「•」后面空出一大截）；按 Word 2013+ 排版，
// 打开时不显示「兼容模式」。
const SETTINGS = `${XML}<w:settings xmlns:w="${WNS}"><w:defaultTabStop w:val="284"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
  + [['/word/document.xml', 'officedocument.wordprocessingml.document.main+xml'], ['/word/styles.xml', 'officedocument.wordprocessingml.styles+xml'], ['/word/settings.xml', 'officedocument.wordprocessingml.settings+xml'], ['/word/fontTable.xml', 'officedocument.wordprocessingml.fontTable+xml'], ['/docProps/core.xml', 'package.core-properties+xml']].map(([p, t]) => `<Override PartName="${p}" ContentType="application/vnd.openxmlformats-${t}"/>`).join('') + '</Types>';
const PACKAGE_RELS = `${XML}<Relationships xmlns="${PNS}"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${PNS}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOCUMENT_RELS = `${XML}<Relationships xmlns="${PNS}"><Relationship Id="rId1" Type="${RNS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${RNS}/settings" Target="settings.xml"/><Relationship Id="rId3" Type="${RNS}/fontTable" Target="fontTable.xml"/></Relationships>`;
// 文档属性只写标题：不写作者、公司、时间这类本机信息。
const core = title => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title></cp:coreProperties>`;

// zip：本地文件头 + 数据（deflate）+ 中央目录 + 结尾记录。时间戳固定成 1980-01-01：同样的内容打出同样的字节。
const crc32 = zlib.crc32 ?? (buf => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; });
const pack = (sizes, values) => { const b = Buffer.alloc(sizes.reduce((a, s) => a + s, 0)); let o = 0; sizes.forEach((s, i) => { if (s === 4) b.writeUInt32LE(values[i] >>> 0, o); else b.writeUInt16LE(values[i], o); o += s; }); return b; };
const DOS_DATE = 0x21;
function zip(parts) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const n = Buffer.from(name), data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    locals.push(pack([4, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2], [0x04034b50, 20, 0, 8, 0, DOS_DATE, crc, comp.length, data.length, n.length, 0]), n, comp);
    centrals.push(pack([4, 2, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2, 2, 2, 2, 4, 4], [0x02014b50, 20, 20, 0, 8, 0, DOS_DATE, crc, comp.length, data.length, n.length, 0, 0, 0, 0, 0, offset]), n);
    offset += 30 + n.length + comp.length;
  }
  const dir = Buffer.concat(centrals);
  return Buffer.concat([...locals, dir, pack([4, 2, 2, 2, 2, 4, 4, 2], [0x06054b50, 0, 0, parts.length, parts.length, dir.length, offset, 0])]);
}
export function exportDocx(content, abs, { title } = {}) {
  const c = shape(content);
  return save(abs, zip([
    ['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', PACKAGE_RELS], ['docProps/core.xml', core(docTitle(c, title))],
    ['word/document.xml', documentXml(c)], ['word/styles.xml', STYLES], ['word/settings.xml', SETTINGS], ['word/fontTable.xml', FONT_TABLE], ['word/_rels/document.xml.rels', DOCUMENT_RELS],
  ]));
}

// ── 读回自检 ────────────────────────────────────────────────────────────────
// 用上传简历同一套读法（pdftotext / PDFKit / unpdf；textutil / 内置 zip 读）把导出的文件读回文字。
export async function readBack(abs) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!['pdf', 'docx', 'txt', 'md'].includes(ext)) throw Error(`读不回 .${ext || '?'} 文件（只认 PDF、Word、文本）`);
  const { text, method } = await extractText(abs, ext);
  return { text, method };
}
// 每一行都要能在读回的文字里找到。比「骨架」：NFKC、小写、去掉空白 / 要点符号 / 软连字符和零宽字符——
// PDF 抽出来的换行、空格、连字（ﬁ）、全角半角都不算差别；每行各自当子串找，抽取器换了行序也不误报。
const skeleton = s => clean(s).normalize('NFKC').toLowerCase().replace(/[\s•\u00ad\u200b-\u200d\u2060\ufeff]/g, '');
export function coverage(content, text) {
  const all = skeleton(text), missing = [];
  let total = 0;
  for (const l of everyLine(shape(content))) { const k = skeleton(l.text); if (!k) continue; total++; if (!all.includes(k)) missing.push(l.id); }
  return { ok: !missing.length, total, missing };
}
