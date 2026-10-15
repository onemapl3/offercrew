// 指挥台的只读筛选标记：复用已存事实，不重判岗位，不改求职偏好或业务状态。
import { locationCities, remoteWork } from './city.mjs';
import { seekerPost, companyPage } from './post-signals.mjs';
import { headhunterFirm } from './quality.mjs';

const HUMAN = /真人|内推|HR直发|Boss/;
const OFFER = /(?:本人|我们?|可以|可|提供|支持|欢迎|帮大家|帮你|找我|联系我|私信我)[^。！!？?\n]{0,24}内推|内推(?:码|链接|通道|入口|邮箱|岗位)|\b(?:I|we)\s+(?:can|will|am happy to|are happy to)\s+refer\b|\b(?:happy to|offering)\s+(?:a\s+)?referral\b/i;
const postUrl = value => String(value || '').trim().replace(/\/$/, '');

export function referralPost(l = {}, referrers = []) {
  const body = String(l.original_body || l.text || l.jd_text || ''), posting = l.judgement?.posting || {};
  if (l.anonymous === true || l.human === false || (!l.human && !HUMAN.test(String(l.source_type || '')))
    || !String(l.author || '').trim() || !/^https?:\/\//.test(l.url || '') || companyPage(l.contact_profile_url || l.url)
    || l.headhunter || headhunterFirm(l) || posting.is_job_post === false || posting.is_roundup === true
    || seekerPost({ title: l.title || l.role || '', body, author_title: l.author_title || '' })) return false;
  // 同公司的联系人不等于这条是内推帖；只认同一原帖已有的员工内推判断。
  const known = referrers.some(r => postUrl(r.post_url) === postUrl(l.url) && r.status !== 'retired'
    && r.judgement?.offers_referral === true && r.judgement?.works_at_company === true && !r.judgement?.headhunter);
  const offered = body.replace(/(?:不可以|不能|无法|不提供|不支持|不接受)[^。！!？?\n]{0,12}内推/g, '');
  return known || (body.length >= 40 && OFFER.test(offered));
}

export const hqFilterFacts = (l, referrers = []) => ({ cities: locationCities(l), remote: remoteWork(l), referral: referralPost(l, referrers) });
