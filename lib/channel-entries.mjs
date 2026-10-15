import { cityName } from './city.mjs';
// 搜好的入口（2026-10-02，design/non-tech/方案-金融法律会计.md 第二节）：综合平台和垂直站的条款不许程序读，只放
// 按你的细分和目标城市填好的链接，你自己点开看。这里只有数据和纯函数：不读写文件、不联网。界面由引导页、设置页来接。
//
// 用法：
//   const pack = JSON.parse(fs.readFileSync(channelPackPath('finance'), 'utf8'));   // 读文件是调用方的事
//   channelEntries(pack, facts)            // facts 就是 facts.yaml 读出来的对象
//   → [{ key: 'liepin', name: '猎聘', enabled: true, requires_login: false, needs_international: false,
//        keywords_in_url: true, keywords: ['投行', '研究员', …], why: '…',
//        links: [{ label: '上海 投行', url: 'https://www.liepin.com/zhaopin/?key=%E6%8A%95%E8%A1%8C&dq=020' }, …] }, …]
//
// 链接 = 细分的搜索词 × 你的前两个目标城市，每个平台最多 3 条。城市参数只用下面核对过的对照表
// （下面每一行写着怎么核的）；表里没有的城市不带城市参数，不猜代码。智联从本机打开是验证页，没能核，不在表里。
import { PRESETS } from './presets.mjs';
import { DIRECTIONS, primaryDirection, tracksOf } from './directions.mjs';

// 每个平台、每个城市要带的参数。对象 = 换掉地址里 xxx={city} 那一项的查询参数；字符串 = 直接填进地址里的 {city}。
// 2026-10-03 逐站复核过（design/non-tech/实现/入口去重与链接核实.md 的报告）：只用公开页面，先看 robots.txt；
// robots 不许程序读搜索页的站（猎聘、BOSS、数英），不打开搜索页，看站点自己页面上的搜索框、筛选项和链接用的是什么写法。
export const CITY_PARAMS = {
  // 猎聘搜索页 /zhaopin/（不带参数的外壳页 robots 允许）自己的城市筛选项（data-code）；搜索页脚本读 key 和 dq。香港不带城市：10-01 记下的 320 只有 robots 禁止的那一页能作证，主会话 10-03 定去掉（和 BOSS 香港同一个理由）。
  liepin: { 北京: { dq: '010' }, 上海: { dq: '020' }, 天津: { dq: '030' }, 重庆: { dq: '040' }, 深圳: { dq: '050090' }, 广州: { dq: '050020' }, 杭州: { dq: '070020' }, 南京: { dq: '060020' }, 苏州: { dq: '060080' }, 成都: { dq: '280020' }, 武汉: { dq: '170020' }, 西安: { dq: '270020' } },
  // 前程无忧：每个城市都打开过结果页（robots.txt 不存在），标题变成「【关键词,城市招聘，求职】」、职位都在这个城市。香港认得出，但常常没有职位。
  '51job': { 北京: { jobArea: '010000' }, 上海: { jobArea: '020000' }, 深圳: { jobArea: '040000' }, 广州: { jobArea: '030200' }, 杭州: { jobArea: '080200' }, 南京: { jobArea: '070200' }, 苏州: { jobArea: '070300' }, 成都: { jobArea: '090200' }, 武汉: { jobArea: '180200' }, 西安: { jobArea: '200200' }, 香港: { jobArea: '330000' } },
  // BOSS 每个城市页（/shanghai/ 等，robots 允许）自己的搜索框就是 GET /web/geek/jobs，带 query 和隐藏的 city=本城代码。
  // 香港：以前那张岗位卡片的链接（/c101320300/）现在找不到了，驻外专区里的「中国香港」是另一套代码，所以不带城市。
  boss: { 北京: { city: '101010100' }, 上海: { city: '101020100' }, 深圳: { city: '101280600' }, 广州: { city: '101280100' }, 杭州: { city: '101210100' }, 南京: { city: '101190100' }, 苏州: { city: '101190400' }, 成都: { city: '101270100' }, 武汉: { city: '101200100' }, 西安: { city: '101110100' } },
  // robots 全站禁止，这次没打开：沿用 10-01 的记录。北京、上海必须用 geoId：文字写法会被认成别处（Shanghai → 美国弗吉尼亚州）；深圳、广州、杭州没找到 geoId，文字能认对。
  linkedin_jobs: { 北京: { geoId: '103873152' }, 上海: { geoId: '102772228' }, 香港: { geoId: '103291313' }, 深圳: { location: 'Shenzhen' }, 广州: { location: 'Guangzhou' }, 杭州: { location: 'Hangzhou' } },
  // 国聘：district 是国标行政区划代码的路径（省，或 省.市），每个都打开过结果页，「已选择」显示这个城市、职位在这个城市。
  iguopin: Object.fromEntries([['北京', '110000'], ['上海', '310000'], ['香港', '810000'], ['深圳', '440000.440300'], ['广州', '440000.440100'], ['杭州', '330000.330100'], ['南京', '320000.320100'], ['苏州', '320000.320500'], ['成都', '510000.510100'], ['武汉', '420000.420100'], ['西安', '610000.610100']]
    .map(([c, code]) => [c, { district: `000000.${code}`, district_cn: c }])),
  // eFinancialCareers：标题都变成「… jobs in <城市>」；它按城市周边找，广州、杭州常常出来的是深圳、香港、上海的职位。
  efinancialcareers: { 香港: { location: 'Hong Kong' }, 上海: { location: 'Shanghai' }, 北京: { location: 'Beijing' }, 深圳: { location: 'Shenzhen' }, 广州: { location: 'Guangzhou' }, 杭州: { location: 'Hangzhou' } },
  // ACCA Careers：LocationId 来自每个城市自己的页面（/jobs/shanghai/ 等）；「关键词 + LocationId」打开过，结果写「jobs in Shanghai」。
  acca_careers: { 北京: { LocationId: '4945870' }, 上海: { LocationId: '4945894' }, 深圳: { LocationId: '207547675' }, 广州: { LocationId: '207547664' }, 杭州: { LocationId: '207547942' }, 香港: { LocationId: '4945881' } },
  // 数英：robots 不许程序读 /search，没打开；参数来自它职位页上自己的城市链接（/search/jobs?pc=11 等）。别的城市的写法没看到。
  digitaling: { 北京: { pc: '11' }, 上海: { pc: '31' }, 广州: { pc: '44', ct: '4401' } },
  // 51 金融圈：城市列表页 /vita/allpositions/ci<行政区划代码>，每个都打开过；香港的列表是空的，不放。
  '51jrq': { 北京: '110000', 上海: '310000', 深圳: '440300', 广州: '440100', 杭州: '330100' },
};
// 城市直接写中文名的平台（任何城市都行）：参数名。
export const CITY_AS_TEXT = { shixiseng: 'city' };

// 渠道入口与资料 / 简历导入用同一份别名表。
export { cityName } from './city.mjs';
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x ?? '').trim()).filter(Boolean);

export const channelPackPath = (preset) => PRESETS[preset]?.channel_pack || null;

// 地址模板填词：{keyword} 换成编码后的词；查询参数里的 xxx={city} 换成这个城市的参数（没有就去掉这一项），路径里的 {city}
// 换成编码后的值（没有就返回 null，调用方改用 home_url）。
export function fillUrl(template, { keyword = null, city = null } = {}) {
  const [base, query = null] = String(template).split('?');
  if (base.includes('{city}') && (city == null || typeof city === 'object')) return null;
  const path = base.replace('{city}', () => encodeURIComponent(city)).replace('{keyword}', () => encodeURIComponent(keyword ?? ''));
  if (query == null) return path;
  const pairs = [];
  for (const pair of query.split('&')) {
    const [k, v = ''] = pair.split('=');
    if (v === '{city}') {
      if (city && typeof city === 'object') for (const [ck, cv] of Object.entries(city)) pairs.push(`${encodeURIComponent(ck)}=${encodeURIComponent(cv)}`);
      else if (typeof city === 'string' && city) pairs.push(`${k}=${encodeURIComponent(city)}`);
    } else if (v === '{keyword}') pairs.push(`${k}=${encodeURIComponent(keyword ?? '')}`);
    else pairs.push(pair);
  }
  return pairs.length ? `${path}?${pairs.join('&')}` : path;
}

// 这个平台、这个城市用什么：表里的参数，或中文名（CITY_AS_TEXT），没有就是 null（不带城市）。
function cityValue(key, city) {
  if (!city) return null;
  if (Object.hasOwn(CITY_AS_TEXT, key)) return { [CITY_AS_TEXT[key]]: city };
  const table = CITY_PARAMS[key];
  return table && Object.hasOwn(table, city) ? table[city] : null;
}

// 搜索词：选了细分就按细分轮流取（每个细分的第一个词在前），没选就是这个来源自己的 keywords。英文站用英文词。
function wordsFor(pack, source, tracks) {
  const lang = source.lang === 'en' ? 'en' : 'zh';
  const direction = PRESETS[pack.preset]?.direction;
  const byTrack = tracks.map((t) => {
    const own = pack.track_keywords?.[lang]?.[t];
    const reg = DIRECTIONS[direction]?.tracks?.[t]?.queries;
    return list(own?.length ? own : Array.isArray(reg) ? (lang === 'zh' ? reg : []) : reg?.[lang]);
  }).filter((w) => w.length);
  if (!byTrack.length) return list(source.keywords);
  const out = [];
  for (let i = 0; i < Math.max(...byTrack.map((w) => w.length)); i++) for (const w of byTrack) if (w[i]) out.push(w[i]);
  return [...new Set(out)];
}

// pack：一份渠道包（config/channel-packs/<预设>.example.json 读出来的对象）。facts：你的资料。
// 只给 kind 为 manual、写了 open_url 的来源（要登录的浏览器来源不在这里）；顺序同渠道包。
// options.max：每个平台最多几条链接（默认 3）；options.cities：用前几个目标城市（默认 2）。
export function channelEntries(pack, facts = {}, { max = 3, cities: cityCount = 2 } = {}) {
  if (!pack || typeof pack !== 'object' || !pack.sources) throw TypeError('channelEntries 要一份渠道包对象（先读 channelPackPath(预设) 指的文件）');
  const direction = PRESETS[pack.preset]?.direction;
  const tracks = direction && primaryDirection(facts) === direction ? tracksOf(facts) : [];
  const cities = [...new Set(list(facts?.location?.target_cities).map(cityName).filter(Boolean))].slice(0, Math.max(0, cityCount));
  const out = [];
  for (const [key, s] of Object.entries(pack.sources)) {
    if (s?.kind !== 'manual' || typeof s.open_url !== 'string') continue;
    const words = wordsFor(pack, s, tracks);
    const inUrl = s.open_url.includes('{keyword}');
    const links = [], seen = new Set();
    const add = (label, url) => { if (url && !seen.has(url) && links.length < max) { seen.add(url); links.push({ label, url }); } };
    if (inUrl) {
      for (const w of words) {
        if (cities.length) for (const c of cities) { const v = cityValue(key, c); add(v ? `${c} ${w}` : w, fillUrl(s.open_url, { keyword: w, city: v })); }
        else add(w, fillUrl(s.open_url, { keyword: w }));
        if (links.length >= max) break;
      }
    } else {
      // 地址不能带搜索词：按城市打开列表页（城市在表里时），否则打开首页；搜索词写在旁边给你复制。
      for (const c of cities) { const v = cityValue(key, c); if (v) add(c, fillUrl(s.open_url, { city: v })); }
      if (!links.length) add(s.name, fillUrl(s.open_url, {}) ?? s.home_url ?? null);
    }
    out.push({
      key, name: s.name, enabled: s.enabled !== false, requires_login: !!s.requires_login, needs_international: !!s.needs_international,
      keywords_in_url: inUrl, keywords: words.slice(0, 6), why: s.why || '', links,
    });
  }
  return out;
}
