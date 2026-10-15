// 新式任务账的回执投影。没有卡的公司找岗也能直接打开，读页面不启动任务。
import { read } from './store.mjs';
import * as J from './jobs.mjs';
import { companySearchReceipt } from './company-search.mjs';
export const receiptWords = t => String(t || '').replace(/needs_browser_extraction:\s*/g, '招聘页需要浏览器读取：').replace(/company_web_search_unavailable/g, '当前文字模型不能联网搜索');
export function receiptCards(cards = []) {
  const have = new Set(cards.map(c => c.id));
  return J.list({ kind: 'company-search', limit: 1000 }).filter(j => !have.has(`radar:${j.id}`)).map(j => {
    const r = read(`state/company-search/${j.id}.json`, {});
    return { id: `radar:${j.id}`, kind: 'ask', title: j.title, owner: 'scout', status: { waiting_you:'needs_you', failed:'stuck', done:'done', cancelled:'cancelled', running:'running', queued:'queued' }[j.state], auto:false, how:'script', links:{ ledger_id:j.id }, from:{by:'you',via:'chat',session_id:r.session_id,message_id:r.message_id}, created_at:j.created_at, updated_at:j.updated_at, detail:receiptWords(j.reason || r.content), result:j.result?.summary || null, steps:[], leads:[] };
  });
}
export function taskReceipt(c, events = []) {
  const j = c.links?.ledger_id ? J.get(c.links.ledger_id) : J.byRef(`card:${c.id}`);
  const receipt = j?.kind === 'company-search' ? companySearchReceipt(j.id) : null;
  const attempts = receipt?.attempts || receipt?.steps || receipt?.trail || [];
  const rows = attempts.map(a => typeof a === 'string' ? {text:receiptWords(a)} : { at:a.at || a.finished_at, text:receiptWords([a.action || a.label || a.step || a.method, a.summary || a.reason || a.detail || a.result || a.status].filter(x=>typeof x==='string').join('：')), url:a.url, evidence:a.evidence }).filter(a=>a.text);
  if (!rows.length && receipt?.errors?.length) rows.push(...receipt.errors.map(text=>({text:receiptWords(text)})));
  if (!rows.length && receipt) rows.push({at:j.updated_at,text:receiptWords(receipt.content || j.reason || j.result?.summary)});
  if (!rows.length && j) rows.push(...J.events(j.id).filter(e=>e.to_state !== 'queued').map(e=>({at:e.at,text:receiptWords(e.data?.reason || e.data?.result?.summary || {running:'开始处理',waiting_you:'停下来等你处理',done:'处理结束',failed:'这一步没做成',cancelled:'这次已结束'}[e.to_state])})).filter(x=>x.text));
  if (!rows.length) rows.push({at:c.updated_at,text:receiptWords(c.detail || c.result || (c.status === 'queued' ? '还没有开始执行' : '这件任务没有留下详细执行记录'))});
  return { rows, summary:receiptWords(receipt?.content || j?.result?.summary || ''), reason:receiptWords(receipt?.reason || (j?.state === 'failed' ? j.reason : '')), next:receiptWords(receipt?.next_steps?.map(x=>x.label).join('；') || receipt?.next_step || receipt?.next || (receipt?.status === 'failed' || receipt?.status === 'needs_url' ? '提供招聘页链接，或者打开原页面核实岗位；也可以结束这件任务。' : '')), links:[...(receipt?.links || []), ...(receipt?.next_steps || []), ...(c.status === 'done' ? c.outputs || [] : [])] };
}
