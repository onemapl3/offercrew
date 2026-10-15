// 读一段 SSE（流式回答）：对话面板那一轮（lib/chat.mjs）和长活（lib/model.mjs）共用。
// 每个事件交给 onEvent({ event, data })，注释行（冒号开头，补给的余额尾巴 `: offercrew {...}`）交给 onComment。
// clock（可选，lib/chat.mjs deadline）：每到一块重新计时（两块之间最多等多久）；读完或出错都停掉。
// 读到一半断了、被 signal 掐了：照原样抛出去，调用方按「没读完」处理。
export async function readSse(r, { onEvent, onComment = null, clock = null }) {
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', ev = null, data = [];
  const flush = () => { if (data.length) onEvent({ event: ev, data: data.join('\n') }); ev = null; data = []; };
  const line = l => {
    if (l === '') return flush();
    if (l.startsWith(':')) return onComment?.(l.slice(1).trim());
    const i = l.indexOf(':'), k = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
    if (k === 'event') ev = v; else if (k === 'data') data.push(v);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clock?.arm();
      buf += dec.decode(value, { stream: true });
      const rows = buf.split(/\r?\n/); buf = rows.pop();
      for (const l of rows) line(l);
    }
    buf += dec.decode();
    if (buf) line(buf);
    flush();
  } finally { clock?.stop(); try { reader.releaseLock(); } catch {} } // 兜底：流已经断了
}
// 响应是不是 SSE（流式）：对方不管 stream、直接回了整个 JSON 的，照原来的办法读。
export const isSse = r => /event-stream/i.test((r.headers?.get ? r.headers.get('content-type') : r.headers?.['content-type']) || '');
