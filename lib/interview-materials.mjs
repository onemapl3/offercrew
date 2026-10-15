// 面试资料只读目录：既有岗位资料、正式文档绑定，以及用户登记的本机材料。
// 私有索引不进源码；接口只接受目录 key，不接受文件路径，也不生成或重写资料。
import fs from 'node:fs';
import path from 'node:path';
import { file, read, lines, hash } from './store.mjs';
import { dossierFor, DOSSIER_DIR, SOURCE_LABEL } from './interview-dossier.mjs';

export const INTERVIEW_INDEX = 'candidate/interviews/index.json';
const idOf = l => l.record_id || l.id;
const urlOf = s => { try { const u = new URL(String(s || '')); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } }; // 兜底：旧登记可能没有可用网页地址，不生成失效链接。
const norm = s => String(s || '').trim().toLocaleLowerCase();
const href = key => `#materials/interview?key=${encodeURIComponent(key)}`;
const fileHref = (key, asset) => `/api/materials/interview/file?key=${encodeURIComponent(key)}${asset ? `&asset=${encodeURIComponent(asset)}` : ''}`;
const SECTIONS = { company: '公司和岗位要点', questions: '可能会问的', prepare: '你该准备的', review: '复盘' };
function localPath(rel, maxBytes = 2 * 1024 * 1024) {
  if (typeof rel !== 'string' || !/^(?:candidate\/interviews|runs)\//.test(rel) || rel.split(/[\\/]/).includes('..') || path.isAbsolute(rel)) throw Error('资料路径不在已登记的材料目录内');
  const absolute = fs.realpathSync(file(rel)), root = fs.realpathSync(file(rel.startsWith('runs/') ? 'runs' : 'candidate/interviews'));
  if (!absolute.startsWith(root + path.sep)) throw Error('资料路径不在已登记的材料目录内');
  if (!fs.statSync(absolute).isFile()) throw Error('登记的资料不是文件');
  if (fs.statSync(absolute).size > maxBytes) throw Error('这份资料超过预览大小限制');
  return absolute;
}
function sources() {
  const leads = lines('state/leads.ndjson'), byId = new Map(leads.map(l => [idOf(l), l]));
  const registry = read(INTERVIEW_INDEX, { items: [] }), out = [];
  for (const item of registry.items || []) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(item.key || '') || !String(item.title || '').trim()) continue;
    const lead = byId.get(item.record_id), key = `local:${item.key}`;
    if (out.some(x => x.key === key)) continue;
    out.push({ key, title: item.title, company: lead?.company || item.company || null, record_id: item.record_id || null, record_missing: !!item.record_id && !lead, number: lead?.number ?? null, role: lead?.role || null, updated_at: item.updated_at || null, source_url: urlOf(item.source_url), source_label: item.source_label || '本机资料', category: item.category || null, category_order: Number(item.category_order) || 0, order: Number(item.order) || 0, version_label: item.version_label || null, kind: 'local', _path: item.path, _origin: item.original_path || null, _aliases: Array.isArray(item.original_aliases) ? item.original_aliases : [], _files: (Array.isArray(item.files) ? item.files : []).filter(f => /^[A-Za-z0-9_-]{1,80}$/.test(f.id || '')) });
  }
  const dir = file(DOSSIER_DIR);
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const d = read(`${DOSSIER_DIR}/${name}`, null), lead = d && byId.get(d.record_id);
    if (!lead || dossierFor(d.record_id)?.record_id !== d.record_id) continue;
    out.push({ key: `dossier:${d.record_id}`, title: `${lead.company || '岗位'} · 面试资料`, company: lead.company || null, record_id: idOf(lead), number: lead.number ?? null, role: lead.applied_role || lead.role || null, updated_at: d.updated_at || null, kind: 'generated', source_label: '团队准备的资料', _dossier: d });
  }
  for (const lead of leads) {
    const d = lead.interview_dossier;
    if (d?.status !== 'published' || (!d.local_path && !urlOf(d.url))) continue;
    out.push({ key: `published:${idOf(lead)}`, title: `${lead.company || '岗位'} · 面试资料`, company: lead.company || null, record_id: idOf(lead), number: lead.number ?? null, role: lead.applied_role || lead.role || null, updated_at: d.verified_at || d.researched_at || null, kind: 'published', source_label: '已登记的正式资料', source_url: urlOf(d.url), _path: d.local_path || null, _document: d.document_id || null, _revision: d.revision_id ?? null, _hash: d.content_hash || null });
  }
  const guide = read('config/interview-guide.json', null), url = urlOf(guide?.url);
  if (url && !out.some(x => x.source_url === url)) out.push({ key: 'guide', title: guide.title || '通用面试手册', company: null, record_id: null, kind: 'guide', source_label: '通用讲义', source_url: url });
  return out;
}
const publicItem = x => Object.fromEntries(Object.entries({ ...x, href: href(x.key) }).filter(([key]) => !key.startsWith('_')));
// 只能下载登记过的原件或附件；HTML/SVG 等可执行格式始终作为附件，配图仅允许栅格图片。
export function interviewMaterialFile(key, asset = null) {
  const x = sources().find(item => item.key === key), attachment = asset && x?._files?.find(f => f.id === asset);
  if (!x || (asset && !attachment) || !(attachment?.path || (!asset && x._path))) throw Object.assign(Error('这份文件不在资料目录里'), { status: 404 });
  const target = localPath(attachment?.path || x._path, 20 * 1024 * 1024), ext = path.extname(target).toLowerCase();
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
  return { file: target, name: path.basename(target), size: fs.statSync(target).size, type: type || 'application/octet-stream', inline: !!asset && !!type };
}
export function interviewMaterials() {
  const items = sources().map(publicItem).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.title.localeCompare(b.title));
  return { items, content_sig: hash(items) };
}
export function interviewMaterialsForLead(lead) {
  if (!lead) return [];
  const priority = { generated: 0, published: 1, local: 2 };
  return sources().filter(x => x.record_id === idOf(lead) || (!x.record_id && x.company && norm(x.company) === norm(lead.company))).sort((a, b) => (priority[a.kind] ?? 3) - (priority[b.kind] ?? 3)).map(publicItem);
}
export function interviewMaterial(key) {
  const all = sources(), x = all.find(item => item.key === key);
  if (!x) throw Object.assign(Error('这份面试资料不在目录里'), { status: 404 });
  const base = publicItem(x);
  if (x._dossier) {
    const d = x._dossier, labels = Object.fromEntries((d.materials || []).map(m => [m.id, m.label]));
    const sections = Object.entries(SECTIONS).map(([k, title]) => ({ title, items: (d[k] || []).map(v => ({ text: String(v.text || ''), sources: (v.from || []).map(f => labels[f] || SOURCE_LABEL[f] || f) })) })).filter(s => s.items.length);
    return { ...base, format: 'sections', sections, content_sig: hash(d) };
  }
  if (!x._path) return { ...base, format: 'link', reason: '这份资料保存在原文网站，可打开原文查看。' };
  try {
    const target = localPath(x._path), raw = fs.readFileSync(target, 'utf8');
    let body = raw, format = /\.xml$/i.test(target) ? 'document' : 'markdown';
    if (/\.json$/i.test(target)) {
      const doc = JSON.parse(raw)?.data?.document;
      if (!doc || typeof doc.content !== 'string' || (x._document && doc.document_id !== x._document)) throw Error('本机文档与登记的正式资料不一致');
      if (x._revision != null && doc.revision_id !== x._revision) throw Error('本机文档不是登记的资料版本，请打开原文查看');
      body = doc.content; format = 'document';
    } else if (!/\.(?:xml|md|txt)$/i.test(target)) throw Error('这类资料暂不能在这里预览');
    if (x._hash && hash(body) !== x._hash) throw Error('本机文档内容与登记时不同，请打开原文查看');
    // 只改展示层链接；原件不变。绝对路径也必须精确匹配登记来源，不能任意读本机文件。
    if (format === 'markdown' && x._origin) body = body.replace(/(!?)\[([^\]\n]*)\]\(([^\s)]+)\)/g, (whole, image, label, dest) => {
      if (/^(?:[a-z]+:|#)/i.test(dest)) return whole;
      const [rel, section] = dest.split('#');
      let decoded; try { decoded = decodeURIComponent(rel); } catch { return whole; }
      const origin = path.resolve(path.dirname(x._origin), decoded), match = !image && all.find(item => item._origin === origin || item._aliases?.includes(origin));
      if (match) return `[${label}](${href(match.key)}${section ? `&section=${encodeURIComponent(section)}` : ''})`;
      const attachment = x._files?.find(f => f.original_path === origin);
      return attachment ? `${image}[${label}](${fileHref(x.key, attachment.id)})` : whole;
    });
    const attachments = (x._files || []).filter(f => f.attachment).map(f => ({ title: f.title || path.basename(f.path || ''), href: fileHref(x.key, f.id) }));
    return { ...base, format, body, download_url: fileHref(x.key), attachments, content_sig: hash({ body, attachments }) };
  } catch (e) { return { ...base, format: 'unavailable', reason: e.code === 'ENOENT' ? '这份资料的本机文件已不在原位置。' : e.message }; }
}
