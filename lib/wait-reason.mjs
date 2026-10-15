// 一件活为什么停着（L2，负责人 0.1.6：「原因见详情、原因见详情要本机 AI 来做……」）：原因是一个原因码加一句人话，各处只用这一句。
//   code   机器认的（迁移、收件箱、「看原因」按它分）：下面 WAIT 里的一个，或者别处自己的码；没有就是 null。
//   text   给你看的那一句。兜底词（「原因见详情」「原因没记下来」……）只在整句什么都没有时由显示的地方单独说，
//          从不拼进句子里；同一个片段不重复（「X、X」「X，X」只留一个）。
// 账（lib/jobs.mjs transition）收原因时一律经 reasonOf 洗一遍，卡、收件箱、手机读到的都是洗过的这一句。

// 兜底词：显示的地方「没有原因」时说的话。它们不是原因，不能当原因拼进别的句子。
export const FILLER = ['原因见详情', '原因没记下来', '原因没写下来'];

// 本机 AI 那几种等（只有它能做、或者旧版排给它的）。text 是函数：要的参数各自带。
export const WAIT = {
  // 本机 AI 没打开 / 打开了跑不了：可选的加速没接手，不挡路。
  local_ai_off: () => '本机 AI 没打开，打开后才会接手',
  local_ai_unready: ({ why } = {}) => `${why || '本机 AI 现在跑不了'}，本机 AI 先不接手`,
  // 只有本机 AI 能做的那一步（要在这台电脑上操作）：进收件箱等你定。
  needs_local_ai: ({ need, why } = {}) => `这一步要${need || '在这台电脑上操作'}，只有本机 AI 能在这台电脑上做${why ? `；${why}` : ''}`,
  // 旧版排给本机 AI、新版由引擎做的：收掉。
  legacy_local_ai: () => '旧版排给本机 AI 的，新版改由引擎做，下一轮照常接着做',
  // 你在收件箱里选了自己做 / 不做了。
  by_you: ({ need } = {}) => `你说${need ? `「${need}」` : '这一步'}自己来做`,
  dropped_by_you: () => '你说这一步不做了',
};
export const LOCAL_AI_CODES = new Set(['local_ai_off', 'local_ai_unready', 'needs_local_ai', 'legacy_local_ai']);
export const waitReason = (code, args = {}) => ({ code, text: cleanReason(WAIT[code] ? WAIT[code](args) : args.text || '') });

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILLER_RE = new RegExp(`(?:${FILLER.map(esc).join('|')})`, 'g');
const SEP = /[，、；。,;]/;

// 洗一句原因：去掉兜底词和它留下的空分隔；同一个片段在句子里出现两次的，后面那个去掉（「X、X要…」「X，X」）。
// 整句只有兜底词的洗完是空串：调用方照自己的规矩办（账上保留原话，显示的地方单独说「原因没记下来」）。
export function cleanReason(text) {
  const all = String(text ?? '');
  if (all.includes('\n')) return all.split('\n').map(cleanLine).filter(Boolean).join('\n');
  return cleanLine(all);
}
function cleanLine(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim().replace(FILLER_RE, '');
  if (!s) return '';
  const bits = s.split(/([，、；。,;])/), seen = new Set(), kept = [];
  for (let i = 0; i < bits.length; i += 2) {
    const frag = bits[i].trim();
    if (!frag || seen.has(frag)) continue;
    seen.add(frag);
    kept.push({ frag, sep: bits[i + 1] || '' });
  }
  return kept.map((o, i) => o.frag + (i < kept.length - 1 ? o.sep || '，' : o.sep === '。' ? '。' : '')).join('')
    .replace(/[（(]\s*[）)]/g, '').replace(/^[：:\s]+|[：:\s]+$/g, '').trim();
}

// 原因 → { code, text }。x：字符串、{ code, text }，或 null。code 另给（data.reason_code）时以它为准。
export function reasonOf(x, code = null) {
  if (x == null || x === '') return { code: code || null, text: '' };
  if (typeof x === 'object') return { code: code || x.code || null, text: cleanReason(x.text ?? x.reason ?? '') };
  return { code: code || null, text: cleanReason(x) };
}

// 测试和检查用：这句里有没有兜底词、有没有重复的片段（四个字以上的片段出现两次）。
export const hasFiller = text => FILLER.some(w => String(text ?? '').includes(w));
export function repeated(text) {
  const frags = String(text ?? '').split(SEP).map(x => x.trim()).filter(x => x.length >= 4);
  return frags.some((f, i) => frags.indexOf(f) !== i);
}
