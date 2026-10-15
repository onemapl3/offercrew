import {execFile,execFileSync} from '../spawn.mjs';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicRead} from '../sandbox.mjs';
import {event} from '../events.mjs';
import {noteFallback} from '../fallback.mjs';
const execute=promisify(execFile);
// 线路（10-05，和邮箱 lib/mail/connect.mjs 同一个做法）：设了代理（或开着系统代理）就先走代理，连接阶段不通（代理没开、
// 代理节点到不了这个网站、超时、加密没建立）就换直连再试一次；没设代理就只有直连。换过线路的记一笔「换了一种做法」
// （lib/fallback.mjs，System 的健康账本看得到），这个主机下一跳先走通了的那条（只记在这个进程里）。
// 两条都不通才算这次没读成，错误里写清楚两条都试过；每个网站每个进程只记一条事件（一轮扫几十个岗位不刷屏）。
// 以前（兜底清单 H01，10-03）设了代理就只走代理：代理节点到不了的网站（gehc.wd5.myworkdayjobs.com）就一直读不到。
const noted=new Set();
function bothFailed(url){
  let host='';try{host=new URL(url).hostname;}catch{} // 兜底：地址解析不了就不记是哪个主机
  if(host&&!noted.has(host)){noted.add(host);try{event('system','network','error',`代理和直连都连不上：${host}`,{kind:'proxy_failed',host});}catch{}} // 兜底：记事件本身失败不影响照实报这次的错
}
const lastGood=new Map();
const hostOf=u=>{try{return new URL(u).hostname;}catch{return '';}}; // 兜底：地址解析不了就不分主机
// 连接阶段的错（换一条线路可能就通）：代理不通、连不上、域名解析不了、超时、TLS 没建立、连接被重置。HTTP 的回答（403、404……）不算。
export const routeFailure=e=>/^public_http_(?:proxy_failed|transport)_/.test(String(e?.message||''));
// 这一跳走不走代理、走哪个（兜底清单 H01；复核 10-03 加了 ALL_PROXY 和 macOS 系统代理）。认的顺序：
//   HTTPS_PROXY / https_proxy → ALL_PROXY / all_proxy → macOS 系统代理（scutil --proxy 里开着的 HTTPS 代理）。
// 从「启动台」打开的 Mac 版拿不到终端里的环境变量：你开着系统代理时，专用 Chrome 走代理，招聘站接口也要走同一个出口。
// 认到了就只走代理；本机回环地址（localhost、127.0.0.0/8、::1）永远直连——没出本机；NO_PROXY / no_proxy 里写了的也直连——
// 是你写明要直连的（照 curl 的规矩：* 是全部，域名连它的子域，前面的点可有可无，可以带端口）；系统代理自己的「例外」也照办。
// 系统代理读不到（不是 Mac、scutil 出错）就当没有，照旧直连。返回代理地址，或者 null。
const LOOPBACK=h=>h==='localhost'||h.endsWith('.localhost')||/^127(?:\.\d{1,3}){3}$/.test(h)||h==='[::1]'||h==='::1';
function listed(host,port,list){
  for(let e of list.map(x=>String(x).trim().toLowerCase()).filter(Boolean)){
    if(e==='*')return true;
    let ep='';const m=/^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(e);if(m){e=m[1];ep=m[2];}
    e=e.replace(/^\*?\./,'');
    if(ep&&ep!==port)continue;
    if(host===e||host.endsWith(`.${e}`))return true;
  }
  return false;
}
// scutil --proxy 的输出里开着的 HTTPS 代理：{ url, exceptions }，没有就 null。
export function parseSystemHttpsProxy(text){
  const t=String(text||''),val=k=>(t.match(new RegExp(`^\\s*${k} : (.+)$`,'m'))||[])[1]?.trim();
  const host=val('HTTPSProxy'),port=val('HTTPSPort');
  if(val('HTTPSEnable')!=='1'||!host||!/^\d+$/.test(port||''))return null;
  const ex=(t.match(/ExceptionsList : <array> \{([\s\S]*?)\}/)||[])[1]||'';
  return {url:`http://${host}:${port}`,exceptions:[...ex.matchAll(/^\s*\d+ : (.+)$/gm)].map(m=>m[1].trim())};
}
// 测试里不读这台机器的系统代理（开发机上常年开着），要试就把 system 传进来。一分钟读一次。
let systemCache={at:0,value:null};
export function systemHttpsProxy(){
  if(process.platform!=='darwin'||process.env.NODE_TEST_CONTEXT)return null;
  if(Date.now()-systemCache.at<60000)return systemCache.value;
  let value=null;
  try{value=parseSystemHttpsProxy(execFileSync('/usr/sbin/scutil',['--proxy'],{timeout:3000,encoding:'utf8'}));}catch{} // 兜底：读不到系统代理设置就当没设
  systemCache={at:Date.now(),value};
  return value;
}
export function proxyFor(url,env=process.env,{system=systemHttpsProxy}={}){
  let proxy=env.HTTPS_PROXY||env.https_proxy||env.ALL_PROXY||env.all_proxy||null,exceptions=[];
  if(!proxy){let s=null;try{s=system?.();}catch{}if(s?.url){proxy=s.url;exceptions=s.exceptions||[];}} // 兜底：读不到系统代理设置就当没设
  if(!proxy)return null;
  let u;try{u=new URL(url);}catch{return proxy;}
  const host=u.hostname.toLowerCase(),port=u.port||(u.protocol==='http:'?'80':'443');
  if(LOOPBACK(host))return null;
  if(listed(host,port,String(env.no_proxy||env.NO_PROXY||'').split(','))||listed(host,port,exceptions))return null;
  return proxy;
}
// The configured local proxy uses the system TLS trust store. curl honors that
// store without disabling verification; redirects remain checked by request().
async function proxyFetch(url,options,proxy){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'radar-http-'));
  try{
    // 连不上代理（或代理连不上网站）10 秒就放弃，留时间给直连那一条。
    const args=['--silent','--show-error','--suppress-connect-headers','--connect-timeout','10','--max-time','25','--max-filesize','67108864','--dump-header',path.join(dir,'headers'),'--output',path.join(dir,'body'),'--request',options.method||'GET'];
    args.push('--proxy',proxy);
    for(const [k,v] of Object.entries(options.headers||{}))args.push('--header',`${k}: ${v}`);
    if(options.body!==undefined)args.push('--data-binary',String(options.body));
    args.push(url);
    try { await execute('curl',args,{timeout:30000,maxBuffer:1024*1024}); }
    catch(e){
      // 超过上限不是网络抖动：不重试，也不交给下面没有上限、不走代理的 fetch（上限按今天最大的招聘板 34 MB 放到 64 MB）。
      if(/maximum (?:allowed )?file size|Maximum file size exceeded/i.test(e.stderr||''))throw Error(`public_http_too_large: ${url}`);
      // 走代理时，传输出错都是代理这条路的事（目标网站的名字由代理去解析）：交给 request() 换直连。
      // 连接被重置、加密握手断了这种抖一下的，同一条路先再试一次；超时（28）不再等第二遍。
      if(!/curl: \((?:35|52|56)\)/.test(e.stderr||''))throw Error(`public_http_proxy_failed_${e.code}: ${url}`);
      try{await execute('curl',args,{timeout:30000,maxBuffer:1024*1024});}catch(retry){throw Error(`public_http_proxy_failed_${retry.code}: ${url}`);}
    }
    const raw=await fs.readFile(path.join(dir,'headers'),'utf8'),blocks=raw.trim().split(/\r?\n\r?\n/),header=blocks.at(-1).split(/\r?\n/),status=Number(header.shift().match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
    const headers=new Headers();for(const line of header){const i=line.indexOf(':');if(i>0)headers.append(line.slice(0,i),line.slice(i+1).trim());}
    return new Response([204,205,304].includes(status)?null:await fs.readFile(path.join(dir,'body')),{status,headers});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}
// 直连：Node 自带的 fetch。连接阶段的错换成和 curl 一样的写法（public_http_transport_<原因>），超时也算。
async function directFetch(url,options){
  try{return await fetch(url,options);}
  catch(e){
    if(e?.name==='AbortError'&&!options.signal?.aborted)throw e;
    const code=e?.cause?.code||(e?.name==='TimeoutError'||options.signal?.aborted?'timeout':e?.code)||'fetch_failed';
    throw Object.assign(Error(`public_http_transport_${code}: ${url}`),{cause:e});
  }
}
// 反爬验证页（10-05）：腾讯云 EdgeOne 的 567、Cloudflare 的「Just a moment」、阿里云 WAF 的 acw_sc__v2 这一类。认出来就照实
// 报 bot_challenge，不绕过；扫描把它记成「官网有反爬验证」，一周才再看一次（lib/discovery-source.mjs）。
const CHALLENGE=/<title>\s*Just a moment|challenge-platform|cf-chl-|acw_sc__v2|_waf_bd8ce2ce37|aliyun_waf|geetest|人机验证|滑动验证|安全验证|访问验证/i;
export function challenged(status,headers,text=''){
  if(status===567)return true;
  if(String(headers?.get?.('cf-mitigated')||'').toLowerCase()==='challenge')return true;
  return [200,202,403,405,429,503].includes(status)&&CHALLENGE.test(String(text).slice(0,65536));
}
export const blockedHost = (u) => /(^|\.)(linkedin\.com|maimai\.cn|zhipin\.com)$/i.test(new URL(u).hostname);
// `jar` (a Map) carries anonymous session cookies across hops and calls. Some
// portals issue their CSRF cookie on a redirect hop (careers.aliyun.com sets
// XSRF-TOKEN on the 302 from /), which a caller of the final response never sees.
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
// 每一跳请求都先过这道门（lib/ats/politeness.mjs 装上它）：判断取详情时同一网站最多 2 路、照 robots.txt 的
// Crawl-delay 隔开。没装、或不在 politely() 里时直接放行。
let gate = (url, send) => send();
export const useGate = (g) => { gate = g; };
// 演示 / 沙盒模式里仍然放行（lib/sandbox.mjs publicRead）：这里只读公开的招聘页和岗位接口，不带你的账号或 cookie，
// 不写任何东西。LinkedIn、脉脉、BOSS 这类要登录的站点上面就拦下了（assisted_browser_only）。
export async function request(url, { jar, beforeRequest, ...options } = {}) {
  for (let hop = 0; hop < 6; hop++) {
    if (blockedHost(url)) throw Error("assisted_browser_only");
    // 需要遵守逐页 robots 的读取方可检查每一跳，不把重定向当成跳过规则的通道。
    if (beforeRequest) await beforeRequest(url);
    const response = await viaRoutes(url, (fetcher) => gate(url, async () => {
      // 选项在过门之后才建：25 秒的超时从真正发出去算起，不算在门口排队的时间。
      const requestOptions = {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
        headers: { "User-Agent": "OfferCrew/0.1 (+https://offercrew.onemaple.cc)", ...options.headers, ...(jar?.size ? { Cookie: cookieHeader(jar) } : {}) },
      };
      return publicRead(() => fetcher(url, requestOptions));
    }));
    if (jar) for (const cookie of response.headers.getSetCookie?.() || []) {
      const pair = cookie.split(";")[0], i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location"), url).href;
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) {
      let text = "";
      try { text = (await response.text()).slice(0, 65536); } catch {} // 兜底：错误页读不出来就只按状态码说
      if (challenged(response.status, response.headers, text)) throw Error(`bot_challenge_${response.status}: ${url}`);
      throw Error(`HTTP ${response.status}: ${url}`);
    }
    // curl 线路构造的 Response 没有 url；读取方核对岗位落点时必须拿到真实的最后一跳。
    if (!response.url) Object.defineProperty(response, 'url', { value: url });
    return response;
  }
  throw Error("too_many_redirects");
}
// 按线路一条条试（见文件头「线路」）：send(fetcher) 发一跳。只在连接阶段的错上换线路，对方回了话（哪怕是 403）就不换。
async function viaRoutes(url, send) {
  const proxy = proxyFor(url), host = hostOf(url);
  let routes = proxy ? [proxy, null] : [null];
  if (routes.length > 1 && lastGood.get(host) === "direct") routes = [null, proxy];
  const fails = [];
  for (const route of routes) {
    try {
      const response = await send(route ? (u, o) => proxyFetch(u, o, route) : directFetch);
      if (routes.length > 1) {
        const was = lastGood.get(host);
        lastGood.set(host, route ? "proxy" : "direct");
        if (fails.length && was !== lastGood.get(host)) {
          const label = (r) => (r ? "经代理读招聘站" : "直连招聘站");
          try { noteFallback({ kind: "ats-route", from: routes[0] ? "proxy" : "direct", to: route ? "proxy" : "direct", why: fails.at(-1), member: "scout", from_label: label(routes[0]), to_label: label(route) }); } catch {} // 兜底：记一笔失败不影响这次读到的结果
        }
      }
      return response;
    } catch (e) {
      if (!routeFailure(e) || route === routes.at(-1)) {
        if (fails.length && routeFailure(e)) { bothFailed(url); throw Object.assign(Error(`${e.message} (proxy_and_direct)`), { cause: e }); }
        throw e;
      }
      fails.push(e);
    }
  }
  throw fails.at(-1);
}
export const json = async (u, o) => (await request(u, o)).json();
export const decodeEntities = s => String(s).replace(/&#(x[0-9a-f]+|\d+);/gi,(original,n)=>{
  const hexadecimal=n[0].toLowerCase()==='x',code=Number.parseInt(hexadecimal?n.slice(1):n,hexadecimal?16:10);
  return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):original;
});
export const plain = (s) =>
  decodeEntities(String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim());
export function lead(c, j) {
  return { company: c.name, ...(c.wide_source?{wide_source:true}:{}), source: "official_ats", source_type: "官方岗位页", ats_type: c.ats_type, ...j };
}
