import fs from 'node:fs';
import {hash} from './store.mjs';
import {plain,decodeEntities} from './ats/http.mjs';
import { TZ } from './tz.mjs';
import { directionsOf, isGeneral, targetFamilies, FAMILIES } from './directions.mjs';

// 公开的真人招聘帖（V2EX、阮一峰周刊、Hacker News、电鸭）按方向取词：一条帖子是不是「我这个方向」的岗位，看它
// 有没有下面这些词。软件方向（没写方向的人，包括作者本人）用 SOFTWARE_TERMS，就是以前写死在 humanLead 里的那几组，
// 一字不变。别的方向：产品、数据、运营用渠道包（config/channel-packs/<方向>.example.json）里公开来源的 keywords；
// 渠道包没有的方向（金融、咨询、市场……）用求职方向登记表（lib/directions.mjs）里各岗位类别的标题词。
export const SOFTWARE_TERMS = Object.freeze({
  post: /后端|全栈|开发|工程师|agent|LLM|backend|full.stack|software|developer|engineer|devops/i,
  title: /开发|工程|agent|LLM|backend|software|full.stack|programmer|developer/i,
  line: /后端|全栈|开发工程师|backend|software engineer|full.stack|agent engineer/i,
  eleduck: /招聘|开发|工程|后端|全栈|agent/i,
});
const PACK_OF = { product: 'product', data: 'data', operations: 'operations' };
const wordSource = (w) => String(w).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
function packWords(preset, source) {
  try { return JSON.parse(fs.readFileSync(new URL(`../config/channel-packs/${preset}.example.json`, import.meta.url), 'utf8')).sources?.[source]?.keywords || []; }
  catch { return []; } // 兜底：这个方向没有渠道包就没有关键词
}
export function humanTerms(facts = {}) {
  if (!isGeneral(facts)) return SOFTWARE_TERMS;
  const dirs = directionsOf(facts).filter((d) => d !== 'software');
  const words = dirs.flatMap((d) => (PACK_OF[d] ? packWords(PACK_OF[d], 'v2ex') : [])).filter(Boolean);
  const titles = targetFamilies(facts).map((f) => FAMILIES[f]?.title?.source).filter(Boolean);
  const parts = [...new Set([...words.map(wordSource), ...titles.map((s) => `(?:${s})`)])];
  if (!parts.length) return SOFTWARE_TERMS;
  const role = new RegExp(parts.join('|'), 'i');
  const eleduck = dirs.flatMap((d) => (PACK_OF[d] ? packWords(PACK_OF[d], 'eleduck') : [])).filter(Boolean);
  return { post: role, title: role, line: role, eleduck: eleduck.length ? new RegExp([...new Set(eleduck.map(wordSource))].join('|'), 'i') : new RegExp(`招聘|${role.source}`, 'i') };
}
export const monthKey=now=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit'}).format(now).slice(0,7);
export function weeklyIssue(items,month){const [year,m]=month.split('-');return items.find(i=>new RegExp(`谁在招人.*${year}年\\s*0?${Number(m)}月`).test(i.title)&&!i.pull_request);}
export function hnIssue(items,month){const [year,m]=month.split('-');const name=new Date(Date.UTC(Number(year),Number(m)-1)).toLocaleString('en-US',{month:'long',timeZone:'UTC'});return items.find(i=>i.title===`Ask HN: Who is hiring? (${name} ${year})`);}
export function v2exPosts(items){return items.filter(p=>p.node?.name==='jobs').map(p=>({source:'v2ex',id:String(p.id),title:p.title,body:p.content||'',url:p.url,author:p.member?.username,posted_at:new Date(p.created*1000).toISOString()}));}
export function githubPosts(items,source='github'){return items.filter(p=>!p.pull_request&&p.state!=='closed'&&p.body).map(p=>({source,id:String(p.id),title:p.title||'',body:p.body,url:p.html_url,author:p.user?.login,posted_at:p.created_at}));}
export function hnPosts(story){return (story.children||[]).filter(p=>p.text&&p.author).map(p=>({source:'hn',id:String(p.id),title:decodeEntities(plain(p.text)).split(/[|\n]/).slice(0,3).join(' | '),raw_body:p.text,body:decodeEntities(plain(p.text.replace(/<p>/gi,'\n'))),url:`https://news.ycombinator.com/item?id=${p.id}`,author:p.author,posted_at:p.created_at}));}
export function nextData(html){const m=html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);if(!m)throw Error('eleduck_public_data_missing');return JSON.parse(m[1]);}
export function eleduckPost(data){
 const p=data.post||data.props?.initialProps?.pageProps?.post||data.props?.initialState?.post?.post||data.props?.pageProps?.post||data.props?.post;if(!p||p.closed||p.deleted||p.visibility&&p.visibility!=='public')throw Error('eleduck_post_unavailable');
 return {source:'eleduck',id:String(p.hashid||p.id),title:p.title,body:p.raw_content||p.content||p.body||'',url:`https://eleduck.com/posts/${p.hashid||p.id}`,author:p.user?.nickname||p.user?.name||p.user?.id,posted_at:p.published_at||p.created_at};
}
export function humanLead(post,{now=Date.now(),evidence,terms=SOFTWARE_TERMS}={}){
 const body=String(post.body||''),all=post.title+'\n'+body,at=Date.parse(post.posted_at);
 if(/求职|找工作|怎么选|选哪个|求内推|面经/.test(post.title)&&!/招聘|招人|内推岗位/.test(post.title))return null;
 if(/职位分享|招聘汇总|岗位汇总|job roundup/i.test(post.title))return null;
 if(!post.author||!Number.isFinite(at)||at>now||now-at>45*86400000||body.length<100||!/^https?:\/\//.test(post.url||''))return null;
 if(/招聘已结束|停止招聘|职位已关闭|no longer hiring|position (?:is )?filled/i.test(all))return null;
 // A jobs board may also contain job-seeker/advice posts. Require hiring evidence.
 if(!/招聘|招人|内推|岗位职责|任职要求|投递|简历|hiring|we(?:'re| are) looking|apply|join (?:us|our)|careers@/i.test(all))return null;
 if(!terms.post.test(all))return null;
 const cities=[...new Set(all.match(/上海|杭州|苏州|北京|深圳|成都|\b(?:Shanghai|Hangzhou|Suzhou|Beijing|Shenzhen|Chengdu)\b/gi)||[])];
 const remote=/remote|远程/i.test(all),china=/\bChina\b|中国|大陆|国内/i.test(all),apac=/\bAPAC\b|Asia.Pacific|亚太/i.test(all);
 if(post.source==='hn'&&(!(remote&&(china||apac))||/\b(?:no|not)\s+remote\b|remote\s*:\s*(?:no|false)|不支持远程/i.test(all)))return null;
 if(!cities.length&&!remote)return null;
 const location=[...cities,remote?(china?'China Remote':apac?'APAC Remote':'Remote'):null].filter(Boolean).join(' / ');
 const company=all.match(/(?:公司(?:名称|名)?|Company)\s*[:：]\s*([^\n|]{2,60})/i)?.[1]?.trim()||(post.source==='hn'&&!/engineer|developer|hiring/i.test(post.title.split('|')[0])?post.title.split('|')[0].replace(/[*#]/g,'').trim():null)||`待核（${post.author}）`;
 const role=post.title&&terms.title.test(post.title)?post.title.replace(/\s+/g,' ').slice(0,240):body.split('\n').find(l=>terms.line.test(l))?.replace(/^#+\s*/,'').slice(0,240)||null;
 if(!role)return null;
 return {company,role,location,url:post.url,source_job_id:`${post.source}:${post.id}`,source:post.source,source_type:'真人直招帖',human:true,author:String(post.author),posted_at:new Date(at).toISOString(),jd_text:all,original_body:body,evidence,content_hash:hash(body),eligibility_note:remote&&!china?'远程雇佣中国资格待核':null};
}
