// 一键投递的门户（线 P，10-04）：岗位页上一个按钮直接投出去、没有表要填（阿里招聘的「投递简历」：用的是你门户账号里存的简历和资料）。
// 这一下就是提交，只能你自己点；系统认出来就不填、不点，那件活记「等你」，给你打开那一页和「我已经投了」。
//
// 怎么认，写成数据（config/accounts.json 账号家族上的 one_click_apply），不写死在流程里：
//   { "name": "阿里招聘", "button": "投递简历", "pages": "position-detail" }
//   name    给人看的门户名字；button 页面上那个按钮的字；pages 岗位页地址里的一段（可不写）。
// 页面特征：页面上没有能填的控件（同意条款的勾选框、按钮不算），只有一个整行就是「投递简历 / 一键投递 / 立即投递」的按钮。
// 家族里没写的门户也按这个特征认出来，话说得保守一些（「多半就直接投出去了」）。
import { familyOf, loadAccounts } from './accounts.mjs';

// 整行就是按钮，或者按钮后面紧跟着同意条款那句（同一行）。
const ONE_CLICK_LINE = /^(?:投递简历|一键投递|立即投递|一键申请|投递此职位)(?=\s|$)/;
const NOT_FIELD = /^(?:submit|button|image|reset|hidden)$/i;
// 和 lib/auto-apply.mjs FIELD_MATCHERS 的 data_processing_consent 同一个认法（不引它，免得两个模块互相引用）。
const CONSENT = /consent|privacy|gdpr|data\s*(?:processing|protection)|同意|隐私|个人信息/i;
// 能填的控件：输入框、下拉、多行框、单选组；同意条款的勾选框不算（「申请此职位表明您已阅读并同意……」）。
// portal：已知的一键投递门户、岗位页地址也对上了（真实的阿里招聘岗位页，线 R 10-04）：页头的搜索框、语言切换不算一道题；
// 勾选框一律算同意条款（它们的勾选框常常不包在 label 里，读不到那句「我已阅读并同意」）。
const SITE_CHROME = /搜索|search|关键[词字]|keyword|语言|language|lang\b/i;
export const fillableControls = (controls = [], { portal = false } = {}) => controls.filter(c => {
  const tag = String(c.tag || '').toLowerCase(), type = String(c.type || '').toLowerCase(), label = String(c.label ?? c.name ?? c.id ?? '');
  if (tag === 'button') return type === 'radio'; // Yes/No 按钮组是一道题
  if (!(/^(?:input|textarea|select|radio)$/.test(tag) || (!tag && type))) return false;
  if (NOT_FIELD.test(type)) return false;
  if (type === 'checkbox' && (portal || CONSENT.test(label))) return false;
  return !(portal && (type === 'search' || SITE_CHROME.test(`${label} ${c.name || ''} ${c.id || ''}`)));
});
const lines = text => String(text || '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

// inspected：驱动读到的页面（url、controls、text、buttons）。认出来返回 { portal, button, family, known }，不是返回 null。
// text 只截了页面开头那一段（驱动里 4000 字）：岗位描述长的时候按钮在后面，看 buttons（页面上看得见的按钮的字）。
export function oneClickPortal(inspected = {}, { url = null, cfg = loadAccounts() } = {}) {
  if (!inspected) return null;
  const where = inspected.url || url || '', fam = familyOf(where, cfg) || (url ? familyOf(url, cfg) : null), spec = fam?.one_click_apply;
  const text = String(inspected.text || ''), buttons = (inspected.buttons || []).map(b => String(b || '').replace(/\s+/g, ' ').trim());
  const known = !!(spec?.button && (text.includes(spec.button) || buttons.includes(spec.button)) && (!spec.pages || String(where).includes(spec.pages)));
  if (fillableControls(inspected.controls || [], { portal: known }).length) return null;
  if (known) return { portal: spec.name || String(fam.label).replace(/（.*）$/, ''), button: spec.button, family: fam.key, known: true };
  const line = [...lines(text), ...buttons].map(s => ONE_CLICK_LINE.exec(s)?.[0]).find(Boolean);
  if (!line) return null;
  return { portal: fam ? String(fam.label).replace(/（.*）$/, '') : '这个网站', button: line, family: fam?.key || null, known: false };
}
