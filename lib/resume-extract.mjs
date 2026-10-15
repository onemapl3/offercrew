// 从上传的文件里抽出文字（第 4 步收口，从 lib/resume-import.mjs 挪下来）：PDF（本机工具或 unpdf）、DOCX、TXT / MD。
// 只读文件、只调本机的抽字工具，不碰材料和资料：开始使用、材料页的「重新读一遍原件」（lib/resume-reparse.mjs）、导出核对都引这里。
import fs from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { layoutText, boxesLayout } from './resume-layout.mjs';
import { normalizeCjkCompat } from './resume-text.mjs';
import { localOnly } from './sandbox.mjs';
import { execFile } from './spawn.mjs';
import { file } from './store.mjs';
import { noteSwallowed } from './swallow.mjs';

export async function extractText(abs, ext) {
  const r = await extractRaw(abs, ext);
  if (!r || typeof r.text !== 'string') return r;
  const { alt, ...rest } = r;
  return { ...rest, text: plain(r.text), ...(typeof alt === 'string' && alt.trim() ? { alt: plain(alt) } : {}) };
}
export async function extractRaw(abs, ext) {
  if (ext === 'txt' || ext === 'md') return { text: fs.readFileSync(abs, 'utf8'), method: 'text' };
  if (ext === 'docx') {
    // 兜底：textutil 没读成就用下一行的内置读法读 Word
    if (process.platform === 'darwin') { try { const t = await tool(process.env.RADAR_TEXTUTIL_BIN || 'textutil', ['-convert', 'txt', '-stdout', abs]); if (t.trim()) { let alt = null; try { alt = docxText(fs.readFileSync(abs)); } catch (e) { noteSwallowed('resume-import.docxAlt', e, { member: 'tailor', doing: '用第二种办法读 Word 简历（核对解析顺序用）', then: '这次不核对' }); } return { text: t, method: 'textutil', alt }; } } catch {} }
    return { text: docxText(fs.readFileSync(abs)), method: 'docx' };
  }
  // 能打开但一个字都没有（扫描件）：交回空文字，由上传那一步说清楚原因。
  const tried = [];
  let opened = null;
  try {
    const t = layoutText(await tool(process.env.RADAR_PDFTOTEXT_BIN || 'pdftotext', ['-layout', '-enc', 'UTF-8', '-q', abs, '-']));
    if (t.trim()) { let alt = null; try { alt = await tool(process.env.RADAR_PDFTOTEXT_BIN || 'pdftotext', ['-enc', 'UTF-8', '-q', abs, '-']); } catch (e) { noteSwallowed('resume-import.pdfAlt', e, { member: 'tailor', doing: '用第二种办法读 PDF 简历（核对解析顺序用）', then: '这次不核对' }); } return { text: t, method: 'pdftotext', alt }; }
    opened ??= 'pdftotext';
  } catch (e) { tried.push(`pdftotext：${why(e)}`); }
  if (process.platform === 'darwin') { try { const r = pdfkitRead(await tool(process.env.RADAR_OSASCRIPT_BIN || 'osascript', ['-l', 'JavaScript', '-e', PDFKIT, abs])); if (r.text.trim()) return { text: r.text, method: 'pdfkit', alt: r.alt }; opened ??= 'pdfkit'; } catch (e) { tried.push(`PDFKit：${why(e)}`); } }
  const url = unpdfUrl();
  if (!url) tried.push('unpdf：没装（npm install）');
  else {
    try {
      const text = await tool(process.execPath, ['--input-type=module', '-e', UNPDF, url, abs]);
      // 给你看的只说发生了什么、该怎么办，不提工具名和安装命令（主会话 10-03）。
      if (text.trim()) return { text, method: 'unpdf', warning: '这份 PDF 里的中文有时读不全：核对一下下面的内容，不对的直接改。' };
      opened ??= 'unpdf';
    } catch (e) { tried.push(`unpdf：${why(e)}`); }
  }
  if (opened) return { text: '', method: opened };
  // 试过哪些、为什么不行（detail）只记进上传记录，不给你看。
  throw Object.assign(Error(`这份 PDF 读不出文字${tried.some(t => /password|密码/i.test(t)) ? '（设了密码）' : ''}，换一份或者直接填。`), { detail: tried.join('；') });
}
// PDFKit 的 d.string 和不加 -layout 的 pdftotext 一样，会把右对齐的日期挪到页尾：改成一行一行取选区和坐标（boxes），
// 交给 lib/resume-layout.mjs 按版面排回去；取不到选区时才用 d.string。
export const PDFKIT = 'ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); if (!d || d.isNil()) throw new Error("PDFKit 打不开这个文件"); const boxes = []; for (let i = 0; i < d.pageCount; i++) { const p = d.pageAtIndex(i); const sel = p.selectionForRect(p.boundsForBox($.kPDFDisplayBoxMediaBox)); if (!sel || sel.isNil()) continue; const ls = sel.selectionsByLine; for (let j = 0; j < ls.count; j++) { const x = ls.objectAtIndex(j), r = x.boundsForPage(p), t = x.string; if (t && !t.isNil()) boxes.push([i, r.origin.x, r.origin.y, r.size.width, r.size.height, t.js]); } } const s = d.string; return JSON.stringify({ boxes: boxes, text: s && !s.isNil() ? s.js : "" }); }';
// unpdf 在子进程里跑：特制的 PDF 卡住解析也只是这个子进程超时被杀，工作台不受影响。
export const UNPDF = "const [url, file] = process.argv.slice(1); try { const { extractText, getDocumentProxy } = await import(url); const { readFileSync } = await import('node:fs'); const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)), { verbosity: 0 }); process.stdout.write((await extractText(pdf, { mergePages: true })).text); } catch (e) { process.stderr.write(String(e && e.name && e.name !== 'Error' ? e.name + ': ' + e.message : (e && e.message) || e)); process.exitCode = 1; }";
// DOCX 是 zip：从中央目录找到 word/document.xml，解压后按段落取文字（不依赖任何库）。
// 一遍扫过去，不用会回溯的正则：特制的文件（满屏的「<」）也只花线性时间，卡不住工作台。
export function docxText(buf) {
  const raw = unzipEntry(buf, 'word/document.xml');
  if (!raw) throw Error('读不出这份 Word 文件（不是有效的 .docx）');
  const xml = raw.toString('utf8'), ent = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  let out = '', i = 0, skip = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (!skip) out += lt < 0 ? xml.slice(i) : xml.slice(i, lt);
    if (lt < 0) break;
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) break;
    const m = /^(\/?)w:([A-Za-z]+)/.exec(xml.slice(lt + 1, Math.min(gt, lt + 40)));
    if (m) {
      const [, close, name] = m;
      // 域代码（HYPERLINK …）和删掉的修订不算正文；<w:tab/> 是正文里的制表符（<w:tab w:val…/> 是制表位，不算）。
      if (name === 'instrText' || name === 'delText') { if (close) skip = Math.max(0, skip - 1); else if (xml[gt - 1] !== '/') skip++; }
      else if (close && name === 'p') out += '\n';
      else if (!close && name === 'tab' && gt === lt + 7) out += '\t';
      else if (!close && (name === 'br' || name === 'cr')) out += '\n';
    }
    i = gt + 1;
  }
  return out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => { if (e[0] !== '#') return ent[e] ?? m; const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; });
}
// 返回 { text, alt }：alt 是 PDFKit 自己的整页文字（按内容顺序），解析完拿它核对（lib/resume-parse-check.mjs）。
export const pdfkitRead = out => { let r; try { r = JSON.parse(out); } catch { return { text: String(out || ''), alt: null }; } const t = boxesLayout(r?.boxes), s = String(r?.text || ''); return t.trim() ? { text: t, alt: s.trim() ? s : null } : { text: s, alt: null }; };
export const plain = t => normalizeCjkCompat(t).replace(LIGATURE, c => c.normalize('NFKC'));
// 只在本机读这份文件（pdftotext / textutil / osascript + PDFKit / unpdf）：演示 / 沙盒模式里也放行（lib/sandbox.mjs localOnly）。
export const tool = async (bin, args) => (await localOnly(() => run(bin, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }))).stdout;
export const unpdfUrl = () => { try { return import.meta.resolve('unpdf'); } catch { return null; } }; // 兜底：没装 unpdf 就是 null，下面换别的办法读 PDF
export const url = v => { const s = S(v, 200).replace(/\s/g, ''); if (!s) return ''; if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^https?:\/\//i.test(s) ? s : ''; return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) ? `https://${s}` : ''; };
export const why = e => { if (e.code === 'ENOENT') return '没装'; if (e.killed) return '超时'; const lines = String(e.stderr || '').split('\n').map(l => l.trim()).filter(Boolean), line = lines.find(l => /execution error|Error\b|Exception\b/.test(l)) || lines[0]; return (line ? line.replace(/^.*?execution error:\s*(Error:\s*)*/, '').replace(/\s*\(-?\d+\)$/, '') : typeof e.code === 'number' ? `退出码 ${e.code}` : String(e.message || e).split('\n')[0]).slice(0, 80); };
// 抽出来的正文先把兼容汉字换成标准汉字（lib/resume-text.mjs）：Mac 导出的 PDF 常带「⼤」这类字。
// PDF 的行顺序（开箱第 2 轮 N02）：pdftotext 加 -layout，每行照版面输出，再由 lib/resume-layout.mjs 压空格、双栏先左后右；
// PDFKit 按选区坐标排成同样的版面。unpdf（pdf.js）按内容流的顺序出字、同一行的拼成一行，右对齐的日期本来就跟着自己那一行，
// 双栏的页一般也是一栏写完再写另一栏，不另做处理（tests/resume-layout.test.mjs 拿真的 PDF 三种读法都核）。
// 另一种读法（alt，10-04）：pdftotext 不加 -layout（按内容顺序）、PDFKit 的整页文字、Word 自己读 document.xml 的那份。
// 只拿来核对解析出来的顺序（lib/resume-parse-check.mjs），不拿来解析；读不出就是 null。
// 拉丁连字（「Sta\uFB00」里的 ﬀ、ﬁ、ﬂ，PDF 的文字层常带）换回普通字母：只在抽文字这一步换，lib/resume-text.mjs 不管它们（10-04）。
export const LIGATURE = /[\uFB00-\uFB06]/g;
// 模型输出是不可信的：逐项取字符串、截断、去重，形状对齐 facts.yaml。
// 模型从简历里抄来的控制字符（\u0007 之类）看不见又挡住保存：直接去掉。
export const S = (v, max = 200) => typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\b\d{17}[\dXx]\b/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// ── 抽文字 ──────────────────────────────────────────────────────────────────
export const run = promisify(execFile);
export function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (entry !== name) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + csize);
    if (method === 0) return data;
    if (method === 8) { try { return zlib.inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 }); } catch { return null; } } // 兜底：压缩的那一段解不开就当这个文件读不出，调用方会照实说
    return null;
  }
  return null;
}
