import { discoveryAllows } from '../lib/discovery-policy.mjs';
import {json,request} from '../lib/ats/http.mjs';
import {monthKey,weeklyIssue,hnIssue,v2exPosts,githubPosts,hnPosts,nextData,eleduckPost,humanLead,humanTerms} from '../lib/human-discovery.mjs';
import {currentFacts} from '../lib/facts.mjs';
import {lines,write,writeLines,read,patch,hash,log,today} from '../lib/store.mjs';
import {mergeLeads} from '../lib/dedupe.mjs';import {prefilter} from '../lib/matcher.mjs';
const now=Date.now(),month=monthKey(now),dir=`runs/${today()}/human/${now}`,incoming=[],results=[];
const sourceIndex=read('state/human-source-index.json',{});
const sourcePolicy=read('config/human-source-policy.json',{});
// 按你的求职方向挑帖子（lib/human-discovery.mjs humanTerms）：软件方向还是原来那几组词。
const terms=humanTerms(currentFacts());
async function channel(source,collect){
 const policy=sourcePolicy[source];
 if(policy?.enabled===false){
  results.push({source,status:'paused',reason:policy.reason||'disabled_by_configuration'});
  write(`${dir}/sources.json`,results);
  return;
 }
 try{const posts=await collect();let eligible=0;
  for(const post of posts){const evidence=`${dir}/${source}-${hash([post.id,post.url]).slice(0,20)}.json`;write(evidence,post);const l=humanLead(post,{now,evidence,terms});if(!l||!discoveryAllows(l))continue;const reason=prefilter(l);if(reason&&reason!=='china_remote_unverified')l.prefilter_reason=reason;incoming.push(l);if(!l.prefilter_reason)eligible++;}
  results.push({source,status:'checked',posts:posts.length,eligible});
 }catch(e){results.push({source,status:'blocked',error:e.message.slice(-500)});}
 write(`${dir}/sources.json`,results);
}
await channel('v2ex',async()=>v2exPosts(await json('https://www.v2ex.com/api/topics/show.json?node_name=jobs')));
await channel('ruanyf',async()=>{
 const [year,m]=month.split('-'),search=await json('https://api.github.com/search/issues?q='+encodeURIComponent(`repo:ruanyf/weekly is:issue 谁在招人 ${year} ${Number(m)}`)+'&per_page=30');write(`${dir}/weekly-search.json`,search);
 const issue=weeklyIssue(search.items,month);if(!issue)throw Error('current_month_hiring_issue_not_found');let comments=[];
 for(let page=1;page<=10;page++){const rows=await json(`${issue.comments_url}?per_page=100&page=${page}`);comments.push(...rows);if(rows.length<100)break;if(page===10)throw Error('weekly_comments_pagination_limit');}
 return githubPosts(comments,'ruanyf');
});
await channel('linuxdo',async()=>{
 const categories=await json('https://linux.do/categories.json');write(`${dir}/linuxdo-categories.json`,categories);
 const c=categories.category_list.categories.find(c=>/招聘|工作机会/.test(c.name));if(!c)throw Error('public_hiring_category_not_found');
 const list=await json(`https://linux.do/c/${c.slug}/${c.id}.json`);const posts=[];
 for(const t of list.topic_list.topics.slice(0,15)){const d=await json(`https://linux.do/t/${t.id}.json`),p=d.post_stream.posts[0];posts.push({source:'linuxdo',id:String(t.id),title:t.title,body:p.raw||p.cooked,url:`https://linux.do/t/${t.id}`,author:p.username,posted_at:p.created_at});}return posts;
});
await channel('eleduck',async()=>{
 const html=await(await request('https://eleduck.com/?category=5')).text();write(`${dir}/eleduck-list.html`,html);const data=nextData(html),posts=data.props?.initialProps?.pageProps?.postList?.posts||[];const full=[];
 for(const p of posts.filter(p=>p.category?.code==='jd'&&!p.closed&&!p.deleted&&terms.eleduck.test(p.title)&&Date.parse(p.published_at)>now-45*86400000).slice(0,12)){
  const detail=await json(`https://svc.eleduck.com/api/v1/posts/${p.id}`);write(`${dir}/eleduck-${p.id}.json`,detail);
  try{full.push(eleduckPost(detail));}catch(e){write(`${dir}/eleduck-${p.id}-blocked.json`,{url:`https://eleduck.com/posts/${p.id}`,error:e.message});}

 }return full;
});
for(const repo of ['MoonshotAI/kimi-cli','langgenius/dify'])await channel('ai-'+repo.split('/')[0],async()=>{
 const all=[];for(const term of ['招聘','hiring']){const d=await json('https://api.github.com/search/issues?q='+encodeURIComponent(`repo:${repo} is:issue ${term} created:>=${month}-01`)+'&per_page=30');write(`${dir}/${repo.split('/')[0]}-${term}.json`,d);all.push(...d.items);}return githubPosts([...new Map(all.map(p=>[p.id,p])).values()]);
});
await channel('hn',async()=>{
 let id=sourceIndex.month===month?sourceIndex.hn:null;
 if(!id){const [year,m]=month.split('-'),name=new Date(Date.UTC(Number(year),Number(m)-1)).toLocaleString('en-US',{month:'long',timeZone:'UTC'}),d=await json('https://hn.algolia.com/api/v1/search?tags=story,author_whoishiring&query='+encodeURIComponent(`Who is hiring ${name} ${year}`));write(`${dir}/hn-search.json`,d);const issue=hnIssue(d.hits,month);if(!issue)throw Error('current_month_hn_issue_not_found');id=issue.objectID;sourceIndex.month=month;sourceIndex.hn=id;}
 const story=await json(`https://hn.algolia.com/api/v1/items/${id}`);write(`${dir}/hn-story.json`,story);return hnPosts(story);

});
let added;
// 抓帖子要几分钟：线索、来源索引都在写回前重读，只并进这一轮的（lib/store.mjs patch）。
{const merged=mergeLeads(lines('state/leads.ndjson'),incoming);added=merged.added;writeLines('state/leads.ndjson',merged.leads);patch('state/human-source-index.json',{},x=>{for(const k of ['month','hn'])if(sourceIndex[k]!==undefined)x[k]=sourceIndex[k];});write('state/human-discovery-check.json',{at:new Date(now).toISOString(),month,evidence:dir,sources:results,added});}
console.log(JSON.stringify(log('discover-human',{status:results.some(r=>r.status==='blocked')?'degraded':added?'changed':'no_change',added,candidates:incoming.length,sources:results,evidence:dir})));
