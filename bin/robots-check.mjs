#!/usr/bin/env node
// 只读：读一个招聘站所在主机的 robots.txt，回答这个站放不放行（lib/ats/robots.mjs）。接公司包之前核一遍：
//   node bin/robots-check.mjs https://citi.wd5.myworkdayjobs.com/en-US/2 https://hl.wd1.myworkdayjobs.com/Campus
// 每个地址打一行 JSON：allowed、说了算的那条规则（rule）、核的路径（Workday 按 /<站点>/ 核）。有一个不放行，退出码就是 1。
// 同一个主机的 robots.txt 只读一次，两次请求之间至少隔 1 秒。
import { checkSite, fetchRobots } from '../lib/ats/robots.mjs';

const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!urls.length) {
  console.error('用法：node bin/robots-check.mjs <招聘站地址> [更多地址…]');
  process.exit(2);
}
const cache = new Map();
let last = 0;
async function once(robotsUrl) {
  if (!cache.has(robotsUrl)) {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    cache.set(robotsUrl, fetchRobots(robotsUrl));
  }
  return cache.get(robotsUrl);
}
let blocked = false;
for (const url of urls) {
  let result;
  try { result = await checkSite(url, { fetchRobots: once }); } catch (e) { result = { url, allowed: false, reason: e.message }; }
  if (!result.allowed) blocked = true;
  console.log(JSON.stringify(result));
}
process.exit(blocked ? 1 : 0);
