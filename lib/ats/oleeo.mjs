// Oleeo（原 WCN）招聘系统，网址都是 <公司>.tal.net。投行、资管的校园招聘很常用：美国银行的全球校招项目
// （bankcampuscareers.tal.net）、Jefferies、Rothschild & Co、Lazard 的学生项目都在上面（docs/channels.md）。
//
// 每块岗位板（网址里的 candidate/jobboard/vacancy/<板号>）都有一个公开的 Atom 订阅源 …/vacancy/<板号>/feed，
// 一次请求就拿到整块板上的全部岗位（美国银行 2026-09-29 是 149 个），不用翻页，也不用解析网页。
// robots.txt 写了 Crawl-delay: 10：每轮扫描只读这一次订阅源；详情是判断前按需取的。判断是 6 路并发跑的（lib/judge.mjs），
// 所以同一个主机的请求排队，两次之间至少隔 10 秒（2026-10-02 端到端：以前 Evercore 的详情会同时打过去）。排队用的是
// 共用的按网站限流（lib/ats/politeness.mjs），10 秒是这里给的下限：robots.txt 读不到也照样隔 10 秒。
//
// 订阅源里的描述是截断的（两百来字），所以 jd_text 留空、截断的那段放进 summary，由 detail 打开这一个岗位的
// 详情页取全文。有的租户在 Cloudflare 后面，详情页先给一个「Quick Check Needed」挑战页（Jefferies、Rothschild
// 当天如此）：碰到挑战就报错停下，不绕过，这样的岗位只有标题，要你自己打开看。
//
// 板上的岗位多是校招或实习。订阅源有「Program type」这类栏目就按它分，没有就看标题（lib/ats/recruit.mjs），
// 然后只留下你这个阶段要读的那几类：在读的读实习和校招，应届的读校招。也有社招板（Evercore 的 3 号板）：
// 写 `board_type: social`，板上的岗位都记社招：在读的人不读它，应届生读到的 VP 岗也不会被当成校招。
//
// companies.yaml:
//   - name: Bank of America
//     ats_type: oleeo
//     origin: https://bankcampuscareers.tal.net
//     vacancy: 1                  # 岗位板编号
//     careers_url: https://bankcampuscareers.tal.net/vx/lang-en-GB/mobile-0/brand-4/candidate/jobboard/vacancy/1/adv/
//     # feed_url: …               # 订阅源不在默认地址时直接写全
//     # unlisted_city: keep       # 订阅源没有城市栏、标题也不写城市时，记「未标注」交给判断，不在预筛挡掉
//     # board_type: social        # 社招板（不写就是校招 / 实习板）
import { request, plain, lead } from './http.mjs';
import { describe } from './describe.mjs';
import { recruitTypesOf, internOrCampus } from './recruit.mjs';
import { deadlineFromText, pastDeadline } from '../deadline.mjs';
import { keepsUnlisted, inTargetCity, citiesOf, UNLISTED_CITY } from './cn.mjs';
import { politely } from './politeness.mjs';

// 同一主机两次请求之间的间隔（robots.txt 的 Crawl-delay: 10）。测试把它调小。
export const crawl = { delay_ms: 10000 };
const get = (url) => politely(async () => (await request(url)).text(), { min_ms: crawl.delay_ms });

export const feedUrl = (c) => c.feed_url || `${c.origin}/vx/mobile-0/candidate/jobboard/vacancy/${c.vacancy || 1}/feed`;
const tag = (xml, name) => (String(xml).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')) || [])[1] || '';
// 订阅源正文是「栏目:值<br/>」一行一个，栏目名各家不同（Program ID / ID、City、Program closing date、Application Deadline……）。
export function feedFields(content) {
  const out = {};
  for (const line of String(content).split(/<br\s*\/?>/i)) {
    const text = plain(line), i = text.indexOf(':');
    if (i > 0 && i < 60 && !(text.slice(0, i).trim() in out)) out[text.slice(0, i).trim()] = text.slice(i + 1).trim();
  }
  return out;
}
const pick = (fields, pattern) => Object.entries(fields).find(([k, v]) => pattern.test(k) && v)?.[1] || '';
// 没有城市栏目的板（Jefferies、Rothschild）：校招岗位名习惯把城市写在最后一个破折号后面
// （「… Summer Analyst Program - Cash Trading - Hong Kong」）。取最后一段当地点；那一段不是城市时
// （「Juillet/Septembre 2027」），地点预筛照样会把它挡在目标城市之外，和读不到地点一样。
const titleTail = (title) => {
  const parts = String(title).split(/\s+[-–—]\s+/);
  return parts.length > 1 ? parts.at(-1).trim() : '';
};

// 订阅源没有城市栏目、标题也不写城市的板（Evercore、Moelis、Perella）：标题末段往往是「Advisory」这种部门名，
// 地点预筛会把它当成目标城市以外的地方挡掉。公司写了 `unlisted_city: keep` 时，末段是目标城市才当地点，
// 否则记「未标注」交给判断读 JD；没写的照旧取末段。
function placeOf(c, city, country, role) {
  if (city) return { location: country && !city.includes(country) ? `${city}, ${country}` : city };
  const tail = titleTail(role);
  if (!keepsUnlisted(c) || inTargetCity(tail, citiesOf(c))) return { location: tail };
  return { location: UNLISTED_CITY, needs_city_check: true };
}

export function normalize(c, xml) {
  const wanted = new Set(recruitTypesOf(c));
  const out = [];
  for (const [entry] of String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const role = plain(tag(entry, 'title'));
    let url;
    try { url = new URL(plain(tag(entry, 'id')) || (entry.match(/<link[^>]+href="([^"]+)"/) || [])[1]); } catch { continue; }
    url.search = ''; url.hash = ''; // 订阅源的链接有时带 ?instant=apply，岗位本身的地址是 <id>
    if (!role || url.protocol !== 'https:') continue;
    const fields = feedFields(tag(entry, 'content'));
    const city = pick(fields, /^(?:city|location|locations|office|job location)$/i), country = pick(fields, /country$/i);
    const type = pick(fields, /type$/i);
    const recruit_type = String(c.board_type || '').trim().toLowerCase() === 'social' ? 'social' : internOrCampus(type, role);
    if (!wanted.has(recruit_type)) continue;
    const deadline = deadlineFromText(Object.entries(fields).filter(([k]) => /clos|deadline/i.test(k)).map(([k, v]) => `${k}: ${v}`).join('\n'));
    out.push(lead(c, {
      role,
      ...placeOf(c, city, country, role),
      url: url.href,
      posted_at: plain(tag(entry, 'published')) || plain(tag(entry, 'updated')) || null,
      recruit_type,
      ...(deadline ? { apply_deadline: deadline } : {}),
      jd_text: '',
      summary: [type && `类型：${type}`, pick(fields, /(?:^|\s)lob$/i), pick(fields, /description/i)].filter(Boolean).join('；'),
      source_job_id: url.pathname.match(/\/opp\/(\d+)/)?.[1] || url.href,
    }));
  }
  return out;
}

// now 只给测试用：「今天」是哪天。
export async function fetchJobs(c, { now = new Date() } = {}) {
  if (!c.feed_url && !c.origin) throw Error('oleeo_board_missing');
  const url = feedUrl(c);
  const xml = await get(url);
  // 没开订阅源的板返回的是网页（BNP Paribas），不是 Atom：报出来，不当成「没有岗位」。
  if (!/<feed\b/i.test(xml)) throw Error(`oleeo_feed_missing: ${url}`);
  // 截止日已过的项目还挂在板上的，读的时候就去掉（lib/deadline.mjs）。
  return normalize(c, xml).filter((l) => !pastDeadline(l, now));
}

// 详情页是 Oleeo 的表单模板：每个栏目一个 form-group（数据栏目 _field_、纯展示的 _label_，比如美国银行的
// Application Deadline），标签在 hform_lbl_text 里，值在 form-control-static 里；富文本栏目（Program description、
// Job description）才是 JD 正文，其余是地点、类型、截止日期这些短栏目。
export function detailFields(html) {
  const out = [];
  for (const chunk of String(html).split(/<div id="form_[^"]*_(?:field|label)_\d+_\d+" class="form-group/).slice(1)) {
    const body = chunk.split(/<style\b|<!-- template=eform2\/field\.tt -->/i)[0];
    const label = plain((body.match(/class="hform_lbl_text"[^>]*>([^<]*)</) || [])[1]);
    const at = body.search(/class="form-control-static"/);
    if (!label || at < 0) continue;
    const value = body.slice(body.indexOf('>', at) + 1);
    const rich = /htmltype-richtext|type_richtext|data-type="LARGETEXT"/.test(body.slice(0, 400));
    out.push({ label, rich, text: rich ? describe(value) : plain(value) });
  }
  return out;
}

export async function detail(c, l) {
  const html = await get(l.url);
  if (/<title>\s*Quick Check Needed|challenge-platform|cf-chl/i.test(html)) throw Error(`oleeo_detail_challenge: ${l.url}`);
  const fields = detailFields(html);
  const body = fields.filter((f) => f.rich && f.text).map((f) => f.text);
  if (!body.length) throw Error(`oleeo_full_jd_missing: ${l.url}`);
  // 正文在前（职责在第一段、要求在空行之后，lib/matcher.mjs 按这个分），地点、类型这些短栏目附在最后。
  const facts = fields.filter((f) => !f.rich && f.text && !/^(?:program id|id|title)$/i.test(f.label)).map((f) => `${f.label}: ${f.text}`);
  const jd_text = [...body, facts.join('\n')].filter(Boolean).join('\n\n');
  const deadline = deadlineFromText(jd_text);
  return { jd_text, ...(deadline && !l.apply_deadline ? { apply_deadline: deadline } : {}) };
}
