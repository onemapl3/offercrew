// 记忆库命令行：执行器（Claude / Codex）和人都用它读写 state/memory/notes.ndjson。
//
//   node bin/memory.mjs --recall "任务描述" [--number 12,34] [--company Initech] [--kind lesson,company] [--limit 20] [--format md|json]
//   node bin/memory.mjs --add --by codex --kind lesson --text "Initech 门户投递前要先在专用 Chrome 里登录" [--subject Initech] [--number 12] [--company Initech] [--evidence runs/20260101/auto-apply/12] [--tags 门户,登录]
//   node bin/memory.mjs --list [--kind lesson] [--by codex] [--q 门户] [--number 12] [--limit 50]
//   node bin/memory.mjs --update <id> [--text ...] [--kind ...] [--subject ...] [--pin|--unpin]
//   node bin/memory.mjs --delete <id>
//   node bin/memory.mjs --stats
import { arg } from '../lib/store.mjs';
import { addNote, updateNote, deleteNote, recall, listNotes, memoryStats, renderNotes, KINDS } from '../lib/memory.mjs';

const has = f => process.argv.includes(f);
const out = x => console.log(JSON.stringify(x, null, has('--pretty') ? 2 : 0));
const split = v => v == null ? [] : String(v).split(/[,，、]+/).map(s => s.trim()).filter(Boolean);
try {
  if (has('--stats')) out(memoryStats());
  else if (has('--recall')) {
    const notes = recall({ text: arg('--recall', ''), numbers: split(arg('--number')).map(Number), companies: split(arg('--company')), kinds: arg('--kind') ? split(arg('--kind')) : null, limit: Number(arg('--limit', 12)) });
    if ((arg('--format', 'json')) === 'md') console.log(notes.length ? `记忆库里与本次相关的 ${notes.length} 条（最相关在前）：\n${renderNotes(notes)}` : '记忆库里没有与本次相关的条目。');
    else out({ total: notes.length, notes });
  } else if (has('--add')) {
    const r = await addNote({ by: arg('--by', 'codex'), kind: arg('--kind', 'lesson'), text: arg('--text', ''), subject: arg('--subject'), numbers: split(arg('--number')), companies: split(arg('--company')), tags: split(arg('--tags')), evidence: arg('--evidence'), pinned: has('--pin') });
    out(r);
  } else if (has('--list')) out(listNotes({ q: arg('--q', ''), kind: arg('--kind'), by: arg('--by'), number: arg('--number'), company: arg('--company'), limit: Number(arg('--limit', 50)) }));
  else if (has('--update')) {
    const patch = {};
    for (const k of ['text', 'kind', 'subject', 'evidence']) if (process.argv.includes('--' + k)) patch[k] = arg('--' + k);
    if (process.argv.includes('--number')) patch.numbers = split(arg('--number'));
    if (process.argv.includes('--company')) patch.companies = split(arg('--company'));
    if (process.argv.includes('--tags')) patch.tags = split(arg('--tags'));
    if (has('--pin')) patch.pinned = true; if (has('--unpin')) patch.pinned = false;
    out(await updateNote(arg('--update'), patch));
  } else if (has('--delete')) out(await deleteNote(arg('--delete')));
  else { console.log(`用法见文件头。kind 可选：${Object.entries(KINDS).map(([k, v]) => `${k}（${v}）`).join(' ')}`); process.exitCode = 2; }
} catch (e) { console.log(JSON.stringify({ status: 'error', error: e.message })); process.exitCode = 1; }
