// 社交平台上的一条帖子：谁写的、写来干什么、用什么语言、说了哪里（2026-10-05 验收 #523 #524）。
//
// 纯函数，不读文件。发现（lib/human-browser.mjs classifyPost）、预筛（lib/matcher.mjs prefilter，Jev 和文字模型两条路都先过它）、
// 草稿收口（lib/human-browser.mjs settleDrafts）用的是同一套说法，所以已经入库的线索和草稿下一轮判断时也按它收回。
//
//   seekerPost({ title, body, author_title })   求职者自己的帖子（open to work、#OpenToWork、求职、求内推……）：不是线索。
//   companyPage(url)                            LinkedIn 公司主页 / 展示页 / 学校页：不是能私信的人。
//   postReason(lead)                            上面两条落在一条已入库的线索上：返回预筛原因（not_a_job_post / human_not_direct_hiring）或 null。
//   postLanguage(text)                          帖子用的语言：'zh' 或 'en'（私信跟着对方的语言写）。
//   remotePlaces(text)                          写了远程、又写了中国以外的地方（「Charlotte, NC」「USA」）：把那些地方列出来。

// 求职的人这样写自己（第一人称、话题标签、个人简介里的「可立即到岗」）。招聘方也会说「如果你 open to new opportunities」，
// 所以英文要第一人称；「求职」「找工作」这类中文词照旧要帖子里没有招人的话才算（OFFERING）。
const SEEKING = new RegExp([
  '求职', '本人(?:履历|简历)', '找工作', '求内推', '求推荐', '求(?:个)?机会', '求带', '面经', '我在找', '想跳槽', '裸辞', '怎么选', '选哪个', '寻找新(?:的)?(?:工作)?机会', '(?:正在|在)看(?:新)?机会', '待业', '已离职.{0,6}(?:看|找)',
  '#?\\bopen\\s*to\\s*work\\b', '#?\\bopentowork\\b',
  '\\bI(?:\'m|’m| am)\\s+(?:currently\\s+|actively\\s+|now\\s+)?(?:open to|looking for|seeking|searching for|exploring|available for)\\s+(?:new\\s+|a new\\s+|my next\\s+|full[- ]time\\s+|remote\\s+|exciting\\s+)*(?:opportunit|roles?\\b|positions?\\b|jobs?\\b|challenges?\\b|work\\b)',
  '\\bI(?:\'m|’m| am)\\s+(?:currently\\s+|now\\s+)?available\\s+(?:immediately|now|to start)',
  '\\bwhat I(?:\'m|’m| am) looking for\\b', '\\bmy next (?:role|opportunit|position|challenge|job)', '\\blooking for (?:a |my next |new |a new )?(?:job|role|opportunit)',
  '\\bif your (?:team|company|organi[sz]ation) is hiring\\b', '\\bhire me\\b',
].join('|'), 'i');
// 招人的话：有它就不是求职帖（「我们在招」「we're hiring」）。
export const OFFERING = /我们(?:在|正在)?招|团队(?:在|正在)?招|我司|岗位职责|任职要求|内推码|内推岗位|欢迎投递|急招|base 在|we(?:'re|’re| are) hiring|join (?:us|our team)|we are looking for/i;
// 个人简介（LinkedIn 名字下面那一行）写着在找工作。
const SEEKER_HEADLINE = /#?\bopen\s*to\s*work\b|#?\bopentowork\b|\bopen to (?:new )?(?:opportunit|roles?\b|positions?\b)|\bavailable (?:immediately|now)\b|\bactively (?:looking|seeking)\b|\bseeking (?:new |a new |my next )?(?:opportunit|roles?\b|positions?\b|job)|\blooking for (?:my next|new|a new) (?:role|opportunit|position|job)|求职中|寻找新机会|看机会|可立即到岗/i;

export function seekerPost({ title = '', body = '', author_title = '' } = {}) {
  const all = `${title || ''}\n${body || ''}`;
  if (OFFERING.test(all)) return false;
  return SEEKING.test(all) || SEEKER_HEADLINE.test(String(author_title || ''));
}

// LinkedIn 的公司主页（/company/…）、展示页（/showcase/…）、学校页（/school/…）：发帖的是一个页面，不是招人的那个人。
// 页面开了「Message」也只是进页面的收件箱，由谁看、会不会回都不知道，所以不给它起草私信（Reacher 发送那一步也不发）。
export const companyPage = (url) => /(?:^|\/\/|\.)linkedin\.com\/(?:company|showcase|school)\//i.test(String(url || ''));

// 社交平台上真人发的帖子（不是公司招聘页、不是 Boss 的岗位卡）。
const SOCIAL_SOURCE = /^(?:linkedin|maimai|脉脉|xiaohongshu|小红书)$/i;
export function postReason(l = {}) {
  if (!SOCIAL_SOURCE.test(String(l.source || ''))) return null;
  if (companyPage(l.contact_profile_url) || companyPage(l.author_url)) return 'human_not_direct_hiring';
  // 公司不明时公司那一格存的是帖子开头那一段（「待核（本人履历为 Example Gene Tech / 示例基因）」，实测 #172）：一起看。
  const lead = l.field_sources?.company || /^待核（(.+)）$/.exec(String(l.company || '').trim())?.[1] || '';
  const body = [lead, l.original_body || l.text || l.jd_text || ''].filter(Boolean).join('\n');
  if (seekerPost({ title: l.title || l.role, body, author_title: l.author_title })) return 'not_a_job_post';
  return null;
}

// 中文字多就是中文帖（和 lib/resume-choice.mjs jobLanguage 同一条：一个汉字顶两个英文词）。
const cjk = (s) => (String(s).match(/[㐀-鿿぀-ヿ]/g) || []).length;
const latin = (s) => (String(s).match(/[A-Za-z][A-Za-z'’.+-]*/g) || []).length;
export const postLanguage = (text) => (cjk(text) * 2 >= latin(text) && cjk(text) > 0 ? 'zh' : 'en');

// 远程岗位常常只对某个国家开放（「remote Eastern Time role, ideally based near Charlotte, NC」）。帖子写了中国，就不往外看。
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const US_CITY = new RegExp(`\\b([A-Z][a-zA-Z.]+(?:\\s[A-Z][a-zA-Z.]+){0,2}),\\s?(${US_STATES})\\b`, 'g');
const REGIONS = [
  ['USA', /\b(?:USA|U\.S\.A?\.?|United States|US[- ]based|US only|(?:Eastern|Central|Mountain|Pacific) Time|\bE[SD]T\b|\bP[SD]T\b)/],
  ['Canada', /\bCanada\b/], ['UK', /\b(?:UK|United Kingdom|England)\b/], ['Europe', /\b(?:Europe|EU|EMEA)\b/], ['India', /\bIndia\b/],
  ['UAE', /\bUAE\b|\bDubai\b/], ['LATAM', /\bLATAM\b|Latin America/], ['Australia', /\bAustralia\b/],
];
const CHINA = /\bChina\b|中国|国内|大陆|\bAPAC\b|Asia[- ]Pacific|worldwide|anywhere|global(?:ly)?\b/i;
export function remotePlaces(text = '') {
  const s = String(text);
  if (CHINA.test(s)) return [];
  const cities = [...new Set([...s.matchAll(US_CITY)].map((m) => `${m[1]}, ${m[2]}`))].slice(0, 2);
  const regions = REGIONS.filter(([, re]) => re.test(s)).map(([name]) => name);
  if (cities.length && !regions.includes('USA')) regions.unshift('USA');
  return [...cities, ...regions];
}
