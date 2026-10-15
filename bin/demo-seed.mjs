#!/usr/bin/env node
// Seed `state/` with an entirely fictional dataset so the workbench and the
// command center render without a real job search behind them — and look like
// someone has been using them for a few weeks (README screenshots, promo video).
//
//   RADAR_ROOT=/tmp/offercrew-demo node bin/demo-seed.mjs
//   RADAR_ROOT=/tmp/offercrew-demo node bin/serve.mjs --port 4399 --sandbox
//
// RADAR_DEMO_NOW=<ISO time> pins the clock the dataset is written around (tests,
// repeatable recordings); by default it is the current time.
//
// Every company, person, URL and message below is invented (company names are
// the usual placeholder names: Contoso, Fabrikam, Northwind …). Nothing here is
// sent anywhere: the seed only writes files under state/ and runs/. It also
// writes the marker state/sandbox.json, so everything that runs on this root
// afterwards is in sandbox mode (lib/sandbox.mjs): nothing leaves the machine,
// no outside program runs, and each thing not done is one "sandbox: skipped"
// line in the run log. --sandbox above only says so out loud.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { BRAND } from '../lib/brand.mjs';
import { TZ } from '../lib/tz.mjs';
import { linkEngine } from '../lib/data-root.mjs';
import { CYCLE_NOTE } from '../lib/usage.mjs';
import { crewName } from '../lib/crew.mjs';

const src = fileURLToPath(new URL('../', import.meta.url));
const root = process.env.RADAR_ROOT || src;
const now = process.env.RADAR_DEMO_NOW ? Date.parse(process.env.RADAR_DEMO_NOW) : Date.now();
if (!Number.isFinite(now)) throw Error(`RADAR_DEMO_NOW is not a time: ${process.env.RADAR_DEMO_NOW}`);
const M = 60000, H = 60 * M, D = 24 * H;
const iso = t => new Date(t).toISOString();
const ago = (h, m = 0) => iso(now - h * H - m * M);
const inH = (h, m = 0) => iso(now + h * H + m * M);
const day = t => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t));
// A local wall-clock time on the demo day, `days` from today ("tomorrow at 14:00").
const offset = (() => { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(now)).find(x => x.type === 'timeZoneName')?.value || 'GMT+08:00'; const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(p); return m ? `${m[1]}:${m[2] || '00'}` : '+08:00'; })();
const wall = (days, hm) => iso(Date.parse(`${day(now + days * D)}T${hm}:00${offset}`));
const write = (p, s) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (p, o) => write(p, JSON.stringify(o, null, 2) + '\n');
const read = p => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return null; } }; // 兜底：演示数据：文件不在就是 null
const ndjson = (p, rows) => write(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
// A minimal one-page PDF (Helvetica, ASCII text) — enough for code that only needs the file to exist.
function placeholderPdf(lines) {
  const text = lines.map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 56 ${780 - i * 24} Td (${l.replace(/[\\()]/g, m => '\\' + m)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const at = objs.map((o, i) => { const off = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return off; });
  const xref = Buffer.byteLength(out);
  return out + `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

// When seeding a separate RADAR_ROOT, copy what the code needs to run there — the product's own
// files only. Everything personal in this checkout (candidate/, each local config/<name>.json that has a
// checked-in config/<name>.example.json, config/host.json, config/*.local.json) is replaced by its
// template, so the demo never shows the person who runs it.
if (root !== src) {
  // The engine is linked in with lib/data-root.mjs, the same way the desktop app does it: bin, lib, web,
  // skills… and the shared rules, prompts and templates are links back to this checkout, so every
  // `node bin/<script>` the workbench starts in the root finds its script and nothing personal from
  // this checkout is copied. Here each config template also becomes the demo's local file (its invented
  // values); a link is removed first, so the copy can never write through into the code.
  linkEngine({ code: src.replace(/\/$/, ''), data: root });
  for (const f of fs.readdirSync(path.join(src, 'config'))) {
    const template = f.match(/^(.*)\.example(\.[a-z]+)$/);
    if (!template) continue;
    const to = path.join(root, 'config', template[1] + template[2]);
    fs.rmSync(to, { force: true });
    fs.copyFileSync(path.join(src, 'config', f), to);
  }
  // 文字模型在演示目录里先用 Codex 的官方订阅（供应商 openai），模板里的其他底座排在后面：沙盒开了模型
  // （RADAR_SANDBOX_MODELS=1，lib/sandbox.mjs）时第一次调用就走它，不先去撞没登录的 Claude。
  const codexFirst = list => [...list.filter(b => b?.provider === 'openai'), ...list.filter(b => b?.provider !== 'openai')];
  const model = read('config/model.json');
  if (Array.isArray(model?.text?.backends) && model.text.backends.some(b => b?.provider === 'openai')) json('config/model.json', { ...model, text: { ...model.text, backends: codexFirst(model.text.backends) } });
  const chat = read('config/chat.json'), codexChat = chat?.backends?.find(b => b?.provider === 'openai');
  if (codexChat) json('config/chat.json', { ...chat, default: codexChat.id || `${codexChat.provider}/${codexChat.model}` });
  fs.mkdirSync(path.join(root, 'candidate'), { recursive: true });
  fs.copyFileSync(path.join(src, 'candidate/facts.example.yaml'), path.join(root, 'candidate/facts.yaml'));
  // The template names its résumé files (resume_routing); write a one-page placeholder for each, so
  // 「投」 in the demo gets as far as a real application plan (lib/application-form.mjs checks the file).
  const facts = YAML.parse(fs.readFileSync(path.join(root, 'candidate/facts.yaml'), 'utf8')) || {};
  const name = facts.identity?.name_en || 'Alex Example';
  for (const [kind, rel] of Object.entries(facts.resume_routing || {})) {
    if (typeof rel !== 'string' || !/\.pdf$/i.test(rel) || !rel.startsWith('candidate/')) continue;
    write(rel, placeholderPdf([`${name} - ${/chinese/i.test(kind) ? 'Chinese' : 'English'} resume`, `A placeholder for the ${BRAND} demo. Everything in it is invented.`, 'Software engineer: LLM agents, tool calling, evaluation; backend and full-stack work.']));
  }
}

// ── leads ───────────────────────────────────────────────────────────────────
// One row per posting: [company, role, city, source type, url, verdict, fit, what happened since].
// Several companies have three or four postings in different cities, so the command center's
// "same company, which one?" labels (#number · city) matter. Channels follow the URL, as in the
// product: ashbyhq / greenhouse / lever are public forms (官网表单), Workday / 飞书招聘 / Moka need
// the candidate's own account (官网 · 本人账号), BOSS / 脉脉 / LinkedIn are messages, a mailbox is email.
const ashby = (co, n) => `https://jobs.ashbyhq.com/${co}/00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const moka = n => `https://app.mokahr.com/social-recruitment/contoso/100${n}#/job/demo-${n}`;
const feishuHire = (co, n) => `https://${co}.jobs.feishu.cn/index/position/70000000000000000${String(n).padStart(2, '0')}/detail`;
const boss = n => `https://www.zhipin.com/job_detail/demo-${n}.html`;
const linkedinJob = n => `https://www.linkedin.com/jobs/view/100000${String(n).padStart(4, '0')}/`;
const maimaiPost = n => `https://maimai.cn/web/feed_detail?fid=demo${n}`;
const judged = (h, extra = {}) => ({ discovered_at: ago(h + 1), imported_at: ago(h + 1), matched_at: ago(h), ...extra });
const pursued = (h, extra = {}) => ({ feedback_at: ago(h), ...extra }); // 你说过「联系」：落在 state 上（lib/lead-state.mjs），不另记 feedback

const postings = [
  // Northwind Labs: four postings, each at a different step.
  ['Northwind Labs', 'Agent Platform Engineer', '杭州', '官方岗位页', 'https://jobs.example.com/northwind/agent-platform', 'recommend', 2.8,
    { ...judged(30), ...pursued(26), email: 'talent@northwind.example.com', state: 'outreach_ready' }],
  ['Northwind Labs', 'LLM Infrastructure Engineer', '上海', '官方岗位页', ashby('northwind', 2), 'recommend', 2.6,
    { ...judged(5 * 24), ...pursued(4 * 24), state: 'applied', auto_apply: { status: 'submitted', user_requested_at: ago(4 * 24), approved_at: ago(4 * 24 - 1), final_approved_at: ago(3 * 24 + 2), at: ago(3 * 24 + 1), submitted_at: ago(3 * 24 + 1), attempts: 1, evidence: 'runs/demo/auto-apply/2' } }],
  ['Northwind Labs', 'AI Product Engineer', '苏州', '官方岗位页', linkedinJob(3), 'recommend', 2.4,
    { ...judged(3 * 24), ...pursued(2 * 24), state: 'contacted' }],
  ['Northwind Labs', 'Applied Scientist, Agents', '远程', '官方岗位页', ashby('northwind', 4), 'recommend', 2.7,
    { ...judged(18 * 24), ...pursued(17 * 24), state: 'interview_done', auto_apply: { status: 'submitted', user_requested_at: ago(17 * 24), approved_at: ago(17 * 24 - 1), final_approved_at: ago(16 * 24 + 3), at: ago(16 * 24 + 2), submitted_at: ago(16 * 24 + 2), attempts: 1 },
      replied_at: ago(12 * 24), reply_summary: '想约一次技术面，聊聊你做过的 Agent 评测。', interview_at: wall(-2, '10:30'), interview_round: '二面', interview_completed_at: wall(-2, '11:40'), interview_review: '问了工具调用的失败重试和评测集怎么搭；对方说一周内给结果。' }],
  // Contoso (applies through its Moka portal, already logged in).
  ['Contoso', 'AI Developer Tools Engineer', '杭州', '官方岗位页', moka(5), 'recommend', 2.7,
    { ...judged(28), ...pursued(3), state: 'apply_needs_user', auto_apply: { status: 'waiting_user', error: 'unanswered_required_fields:出生年月', user_requested_at: ago(3), approved_at: ago(2, 40), at: ago(0, 25), attempts: 1 } }],
  ['Contoso', 'Backend Engineer, Agent Runtime', '上海', '官方岗位页', moka(6), 'recommend', 2.5,
    { ...judged(30), ...pursued(2), state: 'apply_queued', auto_apply: { status: 'queued', user_requested_at: ago(2), approved_at: ago(0, 50), at: ago(0, 50), attempts: 0 }, application_packet: { prepared_at: ago(1, 30) } }],
  ['Contoso', 'Solutions Engineer, LLM', '苏州', '官方岗位页', moka(7), 'recommend', 2.3,
    { ...judged(3 * 24), ...pursued(2 * 24), state: 'applied', auto_apply: { status: 'submitted', user_requested_at: ago(2 * 24), approved_at: ago(2 * 24 - 1), final_approved_at: wall(-1, '17:38'), at: wall(-1, '17:40'), submitted_at: wall(-1, '17:40'), attempts: 1 } }],
  ['Contoso', 'AI Evaluation Engineer', '杭州', '官方岗位页', moka(8), 'recommend', 2.4,
    { ...judged(26), ...pursued(0, 40), state: 'apply_review', auto_apply: { user_requested_at: ago(0, 40) } }],
  // Fabrikam: recruiter posts on platforms.
  ['Fabrikam', 'Agent Engineer (LLM apps)', '远程', 'Boss直聘HR直发', boss(9), 'recommend', 2.5,
    { ...judged(3 * 24), ...pursued(2 * 24 + 2), state: 'replied', replied_at: ago(2, 40), reply_summary: '方便这周五下午聊 30 分钟吗？想先了解一下你做过的 Agent 项目。' }],
  ['Fabrikam', 'AI Infra Engineer', '杭州', '真人招聘帖', maimaiPost(10), 'recommend', 2.4,
    { ...judged(2), ...pursued(0, 30), state: 'contacting', author: 'Jordan', author_title: 'Fabrikam 基础架构组' }],
  ['Fabrikam', 'LLM Application Engineer', '上海', '真人招聘帖', linkedinJob(11), 'recommend', 2.6,
    { ...judged(10 * 24), ...pursued(9 * 24), state: 'interview_scheduled', replied_at: ago(5 * 24), reply_summary: '一面通过，约二面。', interview_at: wall(3, '10:30'), interview_round: '二面' }],
  // Relecloud (飞书招聘 portal).
  ['Relecloud', 'Platform Engineer (Agent Infra)', '杭州', '官方岗位页', feishuHire('relecloud', 12), 'recommend', 2.5,
    { ...judged(2 * 24), ...pursued(30), state: 'apply_needs_user', auto_apply: { status: 'failed', user_requested_at: ago(30), approved_at: ago(29), at: ago(5), attempts: 2, error: '提交后页面一直在加载，没拿到回执', evidence: 'runs/demo/auto-apply/12/last.png' } }],
  ['Relecloud', 'Backend Engineer (Go)', '上海', '官方岗位页', 'https://jobs.example.com/relecloud/backend-go', 'recommend', 2.3,
    { ...judged(29), ...pursued(2) }],
  ['Relecloud', 'ML Platform Engineer', '苏州', '官方岗位页', feishuHire('relecloud', 14), 'recommend', 2.2,
    { ...judged(31), ...pursued(1, 10) }],
  // One company each.
  ['Acme AI', 'Applied AI Engineer (Agents)', '上海', '官方岗位页', ashby('acme', 15), 'recommend', 2.9,
    { ...judged(26 * 24), ...pursued(25 * 24), state: 'offer', offer_at: ago(26), auto_apply: { status: 'submitted', user_requested_at: ago(25 * 24), approved_at: ago(25 * 24 - 1), final_approved_at: ago(24 * 24 + 2), at: ago(24 * 24 + 1), submitted_at: ago(24 * 24 + 1), attempts: 1 },
      replied_at: ago(20 * 24), reply_summary: '简历通过，约一面。', interview_at: wall(-9, '15:00'), interview_round: '终面', interview_completed_at: wall(-9, '16:10'), interview_review: '终面聊了团队规划和 on-call 安排。' }],
  ['Adventure Works', 'Full-Stack Engineer, AI Products', '上海', 'Boss直聘HR直发', boss(16), 'recommend', 2.3,
    { ...judged(7 * 24), ...pursued(6 * 24 + 2), state: 'interview_scheduled', replied_at: ago(4 * 24), reply_summary: 'HR 约了一面，线上。', interview_at: wall(1, '14:00'), interview_round: '一面', interviewer: 'Riley（技术负责人）' }],
  ['Litware', 'Backend Engineer, LLM Tooling', '杭州', '真人招聘帖', linkedinJob(17), 'recommend', 2.4,
    { ...judged(5), ...pursued(3), state: 'outreach_ready', author: 'Casey', author_title: 'Litware 工程经理' }],
  ['Proseware', 'AI Application Developer', '远程', '真人招聘帖', linkedinJob(18), 'recommend', 2.2,
    { ...judged(11 * 24), ...pursued(10 * 24), state: 'contacted' }],
  ['Trey Research', 'Software Engineer, Developer Tools', '苏州', '官方岗位页', 'https://jobs.example.com/trey/devtools', 'recommend', 2.1,
    { ...judged(7 * 24), ...pursued(6 * 24), email: 'careers@trey.example.com', state: 'interview_scheduled', replied_at: ago(22), reply_summary: '想约一面，请回复方便的时间：周三 14:00、周四 10:30 或周五 16:00。' }],
  ['Umbrella Cloud', 'Agent Infrastructure Engineer', '杭州', '官方岗位页', 'https://jobs.example.com/umbrella/agent-infra', 'recommend', 2.4,
    { ...judged(3 * 24), ...pursued(2 * 24 + 5) }],
  ['Globex', 'AI Platform Engineer', '杭州', '官方岗位页', 'https://globex.wd5.myworkdayjobs.com/en-US/Careers/job/Hangzhou/AI-Platform-Engineer_R-000021', 'recommend', 2.5,
    { ...judged(32), ...pursued(6), state: 'apply_needs_user', auto_apply: { status: 'needs_login', user_requested_at: ago(6), approved_at: ago(5), at: ago(4), attempts: 0, error: '需要先登录 Globex 的 Workday 候选人账号' } }],
  ['Initech', 'Applied AI Engineer', '杭州', '官方岗位页', ashby('initech', 22), 'recommend', 2.7,
    { ...judged(27), ...pursued(4), state: 'apply_review', auto_apply: { status: 'awaiting_final_review', user_requested_at: ago(4), approved_at: ago(3), at: ago(0, 40), attempts: 0, plan_fingerprint: 'fp_demo_022', final_review: {
      screenshot: 'runs/demo/auto-apply/22/final.png', url: `${ashby('initech', 22)}/application`, at: ago(0, 40),
      fields: [
        { key: 'First name', value: 'Alex' }, { key: 'Last name', value: 'Example' }, { key: 'Email', value: 'alex@example.com' }, { key: 'Phone', value: '+86 138 0000 0000' },
        { key: 'Resume / CV', value: 'Alex-Example-English-Resume.pdf' }, { key: 'Current location', value: 'Hangzhou, China' },
        { key: 'Earliest start date', value: 'Within one month of an offer' },
        { key: 'Why are you interested in this role?', value: 'I build LLM agents end to end — tool use, evaluation and the boring reliability work around them — and the Applied AI team\'s work on customer-facing agents is exactly that.' },
      ] } } }],
  ['Woodgrove Bank', 'AI Engineer, Risk Platform', '上海', '官方岗位页', 'https://jobs.example.com/woodgrove/ai-risk', 'recommend', 2.2,
    { ...judged(2 * 24), ...pursued(26), email: 'careers@woodgrove.example.com', state: 'contacted' }],
  ['Tailspin', 'Agent Tools Engineer', '杭州', '官方岗位页', 'https://jobs.lever.co/tailspin/00000000-0000-4000-8000-000000000024', 'recommend', 2.5,
    { ...judged(33), ...pursued(1), state: 'apply_queued', auto_apply: { status: 'approved', user_requested_at: ago(1), approved_at: ago(0, 20), at: ago(0, 20), attempts: 0 } }],
  ['Wingtip Labs', 'AI Engineer', '上海', '官方岗位页', 'https://jobs.example.com/wingtip/ai-engineer', 'recommend', 2.0,
    { ...judged(15 * 24), ...pursued(14 * 24), email: 'jobs@wingtip.example.com', state: 'rejected', replied_at: ago(3 * 24), reply_summary: '感谢投递，这个岗位已经招到人了。', closed_at: ago(3 * 24) }],
  // New today: the inbox asks you to screen these.
  ['Fourth Coffee', 'AI 产品工程师', '杭州', '真人招聘帖', 'https://social.example.com/posts/fourth-coffee-ai', 'verify', 1.9, { ...judged(1, { discovered_at: ago(1, 20), imported_at: ago(1, 20) }), author: 'Sam', author_title: 'Fourth Coffee 产品负责人' }],
  ['Humongous Insurance', 'LLM 应用工程师', '上海', '官方岗位页', 'https://boards.greenhouse.io/humongous/jobs/4000000027', 'recommend', 2.5, judged(3)],
  ['VanArsdel', '全栈工程师（AI 方向）', '杭州', 'Boss直聘HR直发', boss(29), 'recommend', 2.4, judged(4)],
  ['Relecloud', 'AI Solutions Engineer', '杭州', '官方岗位页', feishuHire('relecloud', 30), 'recommend', 2.3, judged(5)],
  ['Alpine Labs', 'Agent Engineer', '远程', '真人招聘帖', 'https://social.example.com/posts/alpine-agents', 'verify', 1.8, { ...judged(6), author: 'Morgan', author_title: 'Alpine Labs 创始人' }],
  // Screened out by Radar today (系统排除).
  ['A. Datum', 'Senior Staff Engineer, AI', '上海', '官方岗位页', 'https://jobs.example.com/adatum/staff-ai', 'exclude', 0.4, { ...judged(3), prefilter_reason: 'seniority_out_of_range' }],
  ['Coho Games', 'Gameplay Engineer', '杭州', '官方岗位页', 'https://jobs.example.com/coho/gameplay', 'exclude', 0.2, { ...judged(4), prefilter_reason: 'non_target_role' }],
  // Found by the browser scan 25 minutes ago and judged a moment ago; Reacher already drafted a message.
  ['Lucerne', 'Agent 应用工程师', '杭州', '真人招聘帖', maimaiPost(33), 'recommend', 2.6,
    { discovered_at: ago(0, 25), imported_at: ago(0, 25), matched_at: ago(0, 3), state: 'new', author: 'Taylor', author_title: 'Lucerne 技术负责人' }],
  // Found six minutes ago; Radar is judging it right now (判断).
  ['Fabrikam', 'Applied AI Engineer', '苏州', '官方岗位页', 'https://jobs.example.com/fabrikam/applied-ai', null, null,
    { discovered_at: ago(0, 6), imported_at: ago(0, 6), state: 'new' }],
];
// Judgement text, written the way the judge writes it: no closing period (the cover letter
// generator adds its own punctuation when it quotes these, lib/application-form.mjs).
const REASON = {
  recommend: ['Agent and LLM application work in personal projects matches the core requirement', 'Backend and full-stack work cover the rest of the stack'],
  verify: ['Agent work matches, but the post does not say whether the team hires directly'],
  exclude: ['Title is above the target seniority band'],
};
const leads = postings.map(([company, role, city, source_type, url, verdict, fit, more], i) => {
  const number = i + 1, id = `rec_demo_${String(number).padStart(3, '0')}`;
  const at = more.discovered_at || ago(24);
  const remote = city === '远程';
  return {
    id, record_id: id, number, company, role, location: city, source: source_type, source_type, url,
    jd_text: `${company} is hiring a ${role}.\nResponsibilities: build and run agent systems in production; work closely with product and research teams.\nRequirements: 2+ years of software engineering; experience with LLM applications; ${remote ? 'remote within China' : 'based in ' + city}.`,
    human: /真人|内推|HR直发/.test(source_type), imported_at: at, state: 'new',
    judgement: { at, posting: { city, grade: /Senior|Staff/.test(role) ? 'senior_or_above' : 'mid', family: 'ai_application' } },
    ...(verdict ? {
      // 演示的历史放行也遵循每天至多五条，不依赖旧版本未标记的推荐。
      ...(verdict === 'recommend' ? { recommended_at: ago(24 * (1 + Math.floor(i / 5))) } : {}),
      match: {
        verdict, fit,
        must_haves: [
          { req: 'Two or more years of software engineering', status: 'met', critical: true, jd_quote: '2+ years of software engineering', resume_ref: 'three years of backend and full-stack work, including internships, on systems that ran in production' },
          { req: 'Experience building LLM applications', status: verdict === 'exclude' ? 'conflict' : 'met', critical: true, jd_quote: 'experience with LLM applications', resume_ref: 'built Photo Book, an agent that plans, groups and lays out photo books with tool calls and a small evaluation set' },
        ],
        reasons: [...REASON[verdict], `${remote ? 'Remote within China' : city} is within the target cities`],
        biggest_gap: verdict === 'verify' ? 'The post does not say which team is hiring or at what level' : verdict === 'exclude' ? 'Title is above the target seniority band' : 'Team size and on-call expectations are not stated in the posting',
        eligibility: { location: 'met', work_auth: 'met', remote_china: remote ? 'met' : 'n/a' },
      },
    } : {}),
    ...more,
  };
});
const L = n => leads[n - 1];
ndjson('state/leads.ndjson', leads);
// Screenshots the pages point at: the filled form waiting for final review (a mock,
// docs/demo/final-review-form.png) and the last page an unfinished submission reached.
for (const n of [22, 12]) {
  try { fs.mkdirSync(path.join(root, `runs/demo/auto-apply/${n}`), { recursive: true }); fs.copyFileSync(path.join(src, 'docs/demo/final-review-form.png'), path.join(root, `runs/demo/auto-apply/${n}/${n === 22 ? 'final' : 'last'}.png`)); } catch {} // 兜底：演示数据：截图拷不过去就少一张图
}

// ── drafts, approved sends, receipts, referrers, mail ───────────────────────
const draft = (n, channel, extra) => ({ number: n, record_id: L(n).id, company: L(n).company, channel, draft_id: `draft_demo_${String(n).padStart(3, '0')}`, attachments: [], purpose: 'application', displayed_hash: `demo${n}`, ...extra });
const resume = [{ name: 'Alex-Example-English-Resume.pdf', size: 21000 }];
const drafts = [
  draft(1, 'email', { to: 'talent@northwind.example.com', subject: 'Application: Agent Platform Engineer', body: 'Hello Northwind team,\n\nI am applying for the Agent Platform Engineer role in Hangzhou. Over the last two years I have built agent systems end to end — tool calling, evaluation and the reliability work around them.\n\nMy résumé is attached. I would be glad to talk.\n\nBest regards,\nAlex Example', attachments: resume, status: 'ready', created_at: ago(5), verified_at: ago(5), notified_at: ago(4, 50) }),
  draft(3, 'platform_dm', { platform: 'LinkedIn', to: 'https://www.linkedin.com/in/morgan-example/', purpose: 'referral', referrer_id: 'ref_demo_1', subject: 'Northwind Labs · 内推请求 · AI Product Engineer', body: 'Hi Morgan, I saw that your team is hiring an AI Product Engineer in Suzhou. I have been building LLM agents end to end for two years — would you be open to referring me?', status: 'sent', created_at: ago(26), verified_at: ago(26), notified_at: ago(25, 50), sent_at: ago(25) }),
  draft(9, 'platform_dm', { platform: 'Boss直聘', to: boss(9), subject: 'Fabrikam · Agent Engineer (LLM apps)', body: '你好，看到 Fabrikam 在招 Agent 工程师（远程），我做过两年 Agent 应用和后端，想进一步了解一下团队。', status: 'sent', created_at: ago(2 * 24 + 1), verified_at: ago(2 * 24 + 1), notified_at: ago(2 * 24 + 1), sent_at: ago(2 * 24) }),
  draft(11, 'platform_dm', { platform: 'LinkedIn', to: linkedinJob(11), subject: 'Fabrikam · LLM Application Engineer', body: 'Hi Jamie, I saw your post about the LLM Application Engineer role in Shanghai…', status: 'sent', created_at: ago(9 * 24), verified_at: ago(9 * 24), notified_at: ago(9 * 24), sent_at: ago(8 * 24 + 20) }),
  draft(16, 'platform_dm', { platform: 'Boss直聘', to: boss(16), subject: 'Adventure Works · Full-Stack Engineer, AI Products', body: '你好 Riley，看到 Adventure Works 在招 AI 产品方向的全栈工程师，我做过两年全栈和 Agent 应用，想进一步了解一下团队。', status: 'sent', created_at: ago(6 * 24 + 1), verified_at: ago(6 * 24 + 1), notified_at: ago(6 * 24 + 1), sent_at: ago(6 * 24) }),
  draft(17, 'platform_dm', { platform: 'LinkedIn', to: 'https://www.linkedin.com/in/casey-example/', subject: 'Litware · Backend Engineer, LLM Tooling', body: 'Hi Casey, I saw your post about the LLM tooling role in Hangzhou. I have spent the last two years building agent tooling — tool calling, evals and the job queue behind them. Happy to share details if it is a fit.', status: 'ready', created_at: ago(2, 10), verified_at: ago(2, 10), notified_at: ago(2) }),
  draft(18, 'platform_dm', { platform: 'LinkedIn', to: linkedinJob(18), subject: 'Proseware · AI Application Developer', body: 'Hi Avery, I came across the AI Application Developer opening…', status: 'sent', created_at: ago(10 * 24), verified_at: ago(10 * 24), notified_at: ago(10 * 24), sent_at: ago(9 * 24 + 22) }),
  draft(19, 'email', { to: 'careers@trey.example.com', subject: 'Application: Software Engineer, Developer Tools', body: 'Hello Trey Research team, …', attachments: resume, status: 'sent', created_at: ago(6 * 24), verified_at: ago(6 * 24), notified_at: ago(6 * 24), sent_at: ago(5 * 24 + 20) }),
  draft(23, 'email', { to: 'careers@woodgrove.example.com', subject: 'Application: AI Engineer, Risk Platform', body: 'Hello Woodgrove team, …', attachments: resume, status: 'sent', created_at: ago(24), verified_at: ago(24), notified_at: ago(23), sent_at: ago(6, 8) }),
  draft(33, 'platform_dm', { platform: '脉脉', to: maimaiPost(33), subject: 'Lucerne · Agent 应用工程师', body: '你好 Taylor，看到你在招 Agent 应用工程师（杭州），我做过两年 Agent 应用和后端，想了解一下团队现在在做的方向。', status: 'ready', created_at: ago(0, 20), verified_at: ago(0, 20), notified_at: ago(0, 18) }),
  draft(25, 'email', { to: 'jobs@wingtip.example.com', subject: 'Application: AI Engineer', body: 'Hello Wingtip team, …', attachments: resume, status: 'sent', created_at: ago(14 * 24), verified_at: ago(14 * 24), notified_at: ago(14 * 24), sent_at: ago(13 * 24 + 20) }),
];
ndjson('state/drafts.ndjson', drafts);
const sentDrafts = drafts.filter(d => d.status === 'sent');
// What each send left behind, in the shapes the real senders write (the lead page's 进展 opens them):
// an email's Sent read-back (bin/reconcile-mail.mjs input), a platform message's approval + conversation read-back (bin/send-dm.mjs).
const gmailId = n => (0x18f3a2b4c5d00 + n * 7919).toString(16);
const sendEvidence = d => d.channel === 'email' ? `runs/demo/send/${d.number}.json` : `runs/demo/platform-dm/${d.number}`;
for (const d of sentDrafts) {
  if (d.channel === 'email') json(sendEvidence(d), { profile: { email: 'alex.jobs@example.com' }, sent: [{ id: gmailId(d.number), thread_id: gmailId(d.number + 500), labels: ['SENT'], to: d.to, subject: d.subject, body: d.body, attachments: d.attachments.map(a => ({ ...a, sha256: null })), at: d.sent_at, record_id: d.record_id, draft_id: d.draft_id }] });
  else {
    json(`${sendEvidence(d)}/approved.json`, { request: { id: `sr_demo_${d.number}`, draft_id: d.draft_id, record_id: d.record_id, channel: d.channel, status: 'dispatched' }, draft: { record_id: d.record_id, number: d.number, company: d.company, platform: d.platform, to: d.to, subject: d.subject, body: d.body } });
    json(`${sendEvidence(d)}/thread.json`, { delivered: true, url: d.to, thread: `${d.platform} · ${L(d.number).company}\n\n我：${d.body}\n\n（已读）` });
  }
}
ndjson('state/send-requests.ndjson', sentDrafts.map(d => ({ id: `sr_demo_${d.number}`, record_id: d.record_id, draft_id: d.draft_id, channel: d.channel, status: 'sent', at: iso(Date.parse(d.sent_at) - 10 * M), dispatched_at: iso(Date.parse(d.sent_at) - 2 * M), checked_at: d.sent_at, evidence: sendEvidence(d) })));
const form = (n, channel, at, external_id) => ({ record_id: L(n).id, number: n, company: L(n).company, title: L(n).role, channel, purpose: 'application', at, external_id, url: L(n).url, reconciled: true, actor: 'auto-apply', evidence: `runs/demo/auto-apply/${n}`, screenshot: `runs/demo/auto-apply/${n}/submitted.png`, confirmation: `Application received · ${external_id}` });
ndjson('state/outbound.ndjson', [
  ...sentDrafts.map(d => ({ record_id: d.record_id, number: d.number, company: d.company, title: L(d.number).role, channel: d.channel, platform: d.platform, purpose: d.purpose, draft_id: d.draft_id, at: d.sent_at, to: d.to, subject: d.subject, external_id: d.channel === 'email' ? gmailId(d.number) : `msg_demo_${d.number}`, thread_id: d.channel === 'email' ? gmailId(d.number + 500) : undefined, reconciled: true, evidence: sendEvidence(d) })),
  form(2, 'ats_form', L(2).auto_apply.submitted_at, 'NW-20482'),
  form(4, 'ats_form', L(4).auto_apply.submitted_at, 'NW-19377'),
  form(7, 'portal', L(7).auto_apply.submitted_at, 'CT-7741'),
  form(15, 'ats_form', L(15).auto_apply.submitted_at, 'ACME-48213'),
]);
ndjson('state/referrers.ndjson', [
  { id: 'ref_demo_1', company: 'Northwind Labs', author: 'Morgan', author_title: 'Engineering manager', relationship: 'alumni', source: 'LinkedIn', post_url: 'https://social.example.com/posts/northwind-team', status: 'sent', found_at: ago(2 * 24), updated_at: ago(25), lead_number: 3, judgement: { offers_referral: true, employed: true } },
]);
ndjson('state/inbox-events.ndjson', [
  { message_id: 'mail_demo_9', category: '招聘方回复', summary: 'Fabrikam 的招聘方问这周五下午能不能聊 30 分钟。', at: L(9).replied_at, record_id: L(9).id, from: 'recruiter@fabrikam.example.com', subject: 'Re: Agent Engineer (LLM apps)', source: 'boss' },
  { message_id: 'mail_demo_19', category: '面试邀约', summary: 'Trey Research 约一面，给了三个时间。', at: L(19).replied_at, record_id: L(19).id, from: 'careers@trey.example.com', subject: 'Re: Application: Software Engineer, Developer Tools', source: 'gmail' },
  { message_id: 'mail_demo_7', category: '自动确认', summary: 'Contoso 已收到申请（CT-7741）。', at: L(7).auto_apply.submitted_at, record_id: L(7).id, from: 'no-reply@contoso.example.com', subject: '我们已收到你的申请', source: 'gmail' },
  { message_id: 'mail_demo_2', category: '自动确认', summary: 'Application received (NW-20482).', at: L(2).auto_apply.submitted_at, record_id: L(2).id, from: 'no-reply@northwind.example.com', subject: 'We received your application', source: 'gmail' },
  { message_id: 'mail_demo_16', category: '面试邀约', summary: 'Adventure Works 约了线上一面。', at: L(16).replied_at, record_id: L(16).id, from: 'riley@adventureworks.example.com', subject: '一面邀请', source: 'boss' },
  { message_id: 'mail_demo_25', category: '拒绝', summary: 'Wingtip Labs：岗位已经招到人了。', at: L(25).replied_at, record_id: L(25).id, from: 'jobs@wingtip.example.com', subject: 'Re: Application: AI Engineer', source: 'gmail' },
  { message_id: 'mail_demo_15', category: 'offer', summary: 'Acme AI 发来 Offer。', at: L(15).offer_at, record_id: L(15).id, from: 'talent@acme.example.com', subject: 'Offer', source: 'gmail' },
]);

// ── events: two full cycles today, one yesterday evening, and what is running right now ──
const ev = [];
const push = (agoMin, actor, step, status, msg, extra = {}) => ev.push({ ts: iso(now - agoMin * M), run_id: extra.run_id || `run_${Math.round(agoMin)}`, actor, step, status, msg, refs: extra.refs || [], ...(extra.lead_id ? { lead_id: extra.lead_id } : {}), ...(extra.duration_ms ? { duration_ms: extra.duration_ms } : {}) });
// A full cycle that started `start` minutes ago and took 22 minutes (the scheduled runs: 09:05, 13:05, 18:05
// when the demo clock reads 16:20).
const CYCLES = [[1335, 'y18', 1], [435, 't09', 2], [195, 't13', 0]];
const cycle = (start, tag, n) => {
  const run_id = `cycle_${tag}`, agoMin = start - 24;
  push(agoMin + 24, 'heartbeat', 'cycle', 'start', '周期开始 · full', { run_id });
  push(agoMin + 22, 'radar', 'discover', 'ok', `discover · changed · raw ${58 + n} · eligible ${7 + n} · added ${3 + n}`, { run_id, duration_ms: 84000, refs: [{ file: `runs/demo/discover-${tag}.json` }] });
  push(agoMin + 19, 'radar', 'discover-human-browser', 'ok', `discover-human-browser · changed · found ${2 + n}`, { run_id, duration_ms: 122000 });
  push(agoMin + 16, 'radar', 'judge-leads', 'ok', `judge-leads · changed · judged ${6 + n} · recommended ${3 + n} · verify 2 · excluded 1`, { run_id, duration_ms: 6100 });
  push(agoMin + 13, 'reacher', 'find-referrers', 'ok', 'find-referrers · changed · found 1', { run_id, duration_ms: 41000 });
  push(agoMin + 11, 'reacher', 'prepare-applications', 'ok', 'prepare-applications · changed · prepared 2', { run_id, duration_ms: 9000 });
  push(agoMin + 9, 'nightwatch', 'inbox', 'ok', 'inbox · changed · messages 2', { run_id, duration_ms: 2400 });
  push(agoMin + 3, 'heartbeat', 'metrics', 'ok', 'metrics · done', { run_id, duration_ms: 300 });
  push(agoMin + 2, 'heartbeat', 'cycle', 'ok', '周期结束 · full · 22 分钟', { run_id, duration_ms: 1320000 });
};
for (const c of CYCLES) cycle(...c);
push(5 * 60, 'postman', 'auto-apply', 'fail', 'auto-apply · #12 Relecloud · 提交后页面一直在加载，没拿到回执', { lead_id: L(12).id, refs: [{ screenshot: 'runs/demo/auto-apply/12/last.png' }] });
push(2 * 60 + 50, 'postman', 'auto-apply', 'ok', 'auto-apply · #22 Initech · 表填好了，停在提交前等终审', { lead_id: L(22).id });
push(25, 'postman', 'auto-apply', 'ok', 'auto-apply · #5 Contoso · 表上有一项必填系统不知道：出生年月', { lead_id: L(5).id });
push(6 * 60 + 8, 'postman', 'send-approved', 'ok', 'send-approved · #23 Woodgrove Bank · 邮件已发出', { lead_id: L(23).id });
push(2 * 60 + 40, 'nightwatch', 'inbox', 'ok', `inbox · changed · 1 条招聘方回复 → ${crewName('owl')}`, { duration_ms: 2100 });
push(95, 'user', 'feedback', 'ok', 'pass 31 职级太高', { run_id: 'fb_1', lead_id: L(31).id });
push(40, 'user', 'feedback', 'ok', '投 8', { run_id: 'fb_2', lead_id: L(8).id });
push(30, 'user', 'feedback', 'ok', '10 联系', { run_id: 'fb_3', lead_id: L(10).id });
push(4, 'radar', 'judge-leads', 'start', 'judge-leads · 开始 · 1 条新岗位', { run_id: 'judge_now' });
ev.sort((a, b) => a.ts.localeCompare(b.ts));
ndjson('state/events.ndjson', ev);

// ── executor, host jobs, run-now, sync, connector, sources ─────────────────
json('state/executor-heartbeat.json', { checked_at: ago(0, 4), tasks: {
  'auto-apply:12': { executor: 'auto-apply', task: '12', step: 'submit', detail: 'Relecloud 的门户提交后一直在加载，没拿到回执', status: 'failed', started_at: ago(5, 10), updated_at: ago(5), finished_at: ago(5), steps: 9 },
} });
const job = (id, extra) => ({ id: `job_demo_${id}`, source: 'journey', ...extra });
ndjson('state/host-jobs.ndjson', [
  job(1, { kind: 'research_interview_dossier', record_id: L(16).id, number: 16, company: 'Adventure Works', details: `为明天 14:00 的一面整理有来源的公司准备材料`, created_at: ago(26), status: 'completed', completed_at: ago(3, 48), result: '一面准备材料整理好了：公司产品、团队近况、可能问到的项目。' }),
  job(2, { kind: 'prepare_application_packet', record_id: L(6).id, number: 6, company: 'Contoso', details: '准备 Contoso · Backend Engineer, Agent Runtime 的申请材料', created_at: ago(2), status: 'completed', completed_at: ago(1, 30), result: '申请材料备好了：英文简历、一段申请理由、表单上常问的几项。' }),
  job(3, { kind: 'read_forwarded_source', details: '读你转发的岗位链接', created_at: ago(5, 30), status: 'completed', completed_at: ago(5, 10), result: '已收录为 #30 并判断：待核', source: 'talk' }),
  job(4, { kind: 'verify_contact_entry', record_id: L(13).id, number: 13, company: 'Relecloud', details: '核实 Relecloud 的招聘联系人和投递入口', created_at: ago(3, 30), status: 'completed', completed_at: ago(3, 2), result: '核实了 Relecloud 的官方岗位页和申请入口，招聘联系人写进了线索' }),
  job(5, { kind: 'prepare_application_packet', record_id: L(14).id, number: 14, company: 'Relecloud', details: '准备 Relecloud · ML Platform Engineer 的申请材料', created_at: ago(4, 5), status: 'completed', completed_at: ago(3, 40), result: '申请材料备好了：英文简历和一段申请说明' }),
  // The executor found no public contact for an approved "联系": the inbox asks how to go on.
  job(6, { kind: 'verify_contact_entry', record_id: L(20).id, number: 20, company: 'Umbrella Cloud', details: '核实 Umbrella Cloud 的招聘联系人和投递入口', created_at: ago(2 * 24 + 4), status: 'completed', completed_at: ago(26), result: '已核实 Umbrella Cloud 的官方岗位和申请入口，页面和公司主页都没有公开的招聘联系人或邮箱。' }),
  job(7, { kind: 'system_fix', details: '合盖睡眠错过了 09:05 那一轮，醒来后补跑', created_at: ago(4, 36), status: 'completed', completed_at: ago(4, 33), result: '醒来后补跑了一轮，5 条线索的进度对上了。', source: 'system', target: { source: 'alert', label: '09:05 那一轮没按时跑' } }),
]);
json('state/run-now.json', { reasons: [], requested_at: ago(0, 7), pending: false, running: false, last_run_at: ago(1, 30), queue: [], last_exit: 0, last_error: null, last_finished_at: ago(1, 20) });
const sourceNames = [...new Set(leads.map(l => l.company))];
json('state/discovery-sources.json', { at: ago(3), sources: sourceNames.map(company => ({ company, status: 'verified' })) });
json('state/human-discovery-check.json', { at: ago(3), sources: [{ source: 'LinkedIn', status: 'ok' }, { source: 'Boss直聘', status: 'ok' }, { source: '脉脉', status: 'ok' }] });
json('state/cycle-progress.json', { at: iso(now - (CYCLES.at(-1)[0] - 22) * M), results: [
  { stage: 'discover', status: 'changed', raw: 58, eligible: 7, added: 3, verified: sourceNames.length, sources: sourceNames },
  { stage: 'discover-human-browser', status: 'changed', found: 2, added: 2, drafted: 1 },
  { stage: 'judge-leads', status: 'changed', judged: 6, verdicts: { recommend: 3, verify: 2, exclude: 1 }, prefiltered: 1 },
  { stage: 'find-referrers', status: 'changed', companies: 4, people: 1, drafts: 1 },
  { stage: 'prepare-applications', status: 'changed', prepared: 2 },
  { stage: 'inbox', status: 'changed', messages: 2 },
  { stage: 'auto-apply', status: 'changed', submitted: 1, awaiting_final_review: 1, needs_login: 1 },
  { stage: 'metrics', status: 'done' },
] });
const live = leads.filter(l => !l.prefilter_reason);
json('state/metrics.json', { total: leads.length, active: 25, recommended: live.filter(l => l.match?.verdict === 'recommend').length, contacted: 9, applied: 5, replied: 7, interviews: 4, by_source: { 官方岗位页: 22, 真人招聘帖: 7, Boss直聘HR直发: 4 }, by_channel: { ats_form: 3, portal: 1, platform_dm: 6, email: 3 }, reply_rate: 0.58, pass_reasons: [['职级太高', 3], ['方向不对', 2], ['城市不对', 1]], weekly: { since: ago(7 * 24), new: 19, recommended: 11, contacted: 6, applied: 4, replied: 4, interviews: 2 } });
// What the system has learned from your 投 / 联系 / pass (设置 · 偏好; lib/preferences.mjs).
json('state/preferences.json', { version: 'demo', updated_at: ago(1, 35), signals: 57, half_life_days: 30, weight_cap: 2.5, score_cap: 0.5, manual: {}, learned_rule_ids: ['lp_demo_1'], dimensions: {
  direction: { 'Agent应用': { weight: 2.2, positive: 11, negative: 0 }, '后端平台': { weight: 1.4, positive: 6, negative: 1 }, '算法研究': { weight: -1.3, positive: 0, negative: 4, demoted: true } },
  city: { '杭州': { weight: 1.9, positive: 12, negative: 1 }, '上海': { weight: 1.0, positive: 8, negative: 2 }, '远程': { weight: 0.8, positive: 4, negative: 1 } },
  company_type: { foreign_mnc: { weight: 1.1, positive: 5, negative: 1 } },
  seniority: { '资深岗': { weight: -1.7, positive: 0, negative: 5, demoted: true } },
  stack: { Go: { weight: 0.9, positive: 4, negative: 0 }, TypeScript: { weight: 0.7, positive: 3, negative: 0 } },
  source_type: { '真人招聘帖': { weight: 1.3, positive: 6, negative: 1 } },
} });
json('state/learned-prefilters.json', { rules: [{ id: 'lp_demo_1', dimension: 'seniority', value: '资深岗', reason: '你 pass 了 5 个资深 / Staff 岗，理由都是职级太高', created_at: ago(2 * 24) }] });
const recommended = live.filter(l => l.match?.verdict === 'recommend' && !['rejected', 'offer'].includes(l.state));
json('state/top-picks.json', { date: day(now), rows: recommended.slice(0, 6).map(l => ({ number: l.number, record_id: l.id, company: l.company, role: l.role, city: l.location, fit: l.match.fit, verdict: 'recommend', human: l.human, blocker: l.number === 1 ? '邮件草稿待你审' : l.number === 2 ? '已投递，等回复' : '在推进', owner: l.number === 2 ? '招聘方' : '你', channel: 'email', url: l.url })) });
json('state/apply-proposal.json', { rows: [] });
json('state/send-proposal.json', { rows: drafts.filter(d => d.status === 'ready').map(d => ({ number: d.number, company: d.company, role: L(d.number).role, city: L(d.number).location, kind: d.purpose, channel: d.channel, draft_id: d.draft_id, first_line: d.body.split('\n')[0] })) });
json('state/ops.json', { current: null, history: [{ id: 'op-demo-judge-leads', op: 'judge-leads', label: 'Jev 全量判断', status: 'ok', exit: 0, started_at: ago(3), finished_at: iso(now - 3 * H + 6100), log: 'runs/demo/ops/judge-leads.log' }] });
write('runs/demo/ops/judge-leads.log', 'judged 6 leads in 6.1 s\n');
// A submitted form's folder, as lib/auto-apply.mjs leaves it: the fields read back before submit, the confirmation, the page after submit.
for (const [n, id] of [[2, 'NW-20482'], [4, 'NW-19377'], [7, 'CT-7741'], [15, 'ACME-48213']]) {
  write(`runs/demo/auto-apply/${n}/receipt.json`, JSON.stringify({ confirmation: id, at: L(n).auto_apply.submitted_at }, null, 2));
  write(`runs/demo/auto-apply/${n}/confirmation.txt`, `Application received · ${id}\n`);
  json(`runs/demo/auto-apply/${n}/prefilled.json`, { url: L(n).url, fields: [{ key: 'First name', value: 'Alex' }, { key: 'Last name', value: 'Example' }, { key: 'Email', value: 'alex.jobs@example.com' }, { key: 'Phone', value: '+86 138 0000 0000' }, { key: 'Resume/CV', value: 'Alex-Example-English-Resume.pdf' }, { key: 'LinkedIn', value: 'https://www.linkedin.com/in/alex-example/' }, { key: 'Earliest start date', value: '2026-11-01' }], missing: [] });
  try { fs.copyFileSync(path.join(src, 'docs/demo/final-review-form.png'), path.join(root, `runs/demo/auto-apply/${n}/submitted.png`)); } catch {} // 兜底：演示数据：截图拷不过去就少一张图
}
for (const tag of ['y18', 't09', 't13']) write(`runs/demo/discover-${tag}.json`, JSON.stringify({ status: 'changed', raw: 58, eligible: 7, added: 3 }, null, 2));
// Host logs the schedule view reads (runs/<day>/cycle-host, mail-poll), at the same times as the cycles above.
const stamp = t => `${day(t)} ${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(t))} ${offset.replace(':', '')}`;
const today = CYCLES.filter(([start]) => day(now - start * M) === day(now));
const d = day(now).replaceAll('-', '');
write(`runs/${d}/cycle-host/poll.log`, today.flatMap(([start]) => [`[${stamp(now - start * M)}] scheduled start`, `[${stamp(now - (start - 22) * M)}] scheduled exit=0`]).join('\n') + '\n');
write(`runs/${d}/mail-poll/poll.log`, `[${stamp(now - 17 * M)}] mail-poll exit=0\n`);
// A week of (invented) usage for 运行与用量 and the header pill (Patch's ledger, lib/usage.mjs): Codex sessions on a ChatGPT
// plan (the cycle's big session → patch, mail polls → owl, run-now research → lens), Jev judging, and a little chat and
// rewriting through API keys, so a few yuan show next to the subscription tokens. Numbers follow a fixed pseudo-random walk.
{
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = [], add = (t, r) => { if (t <= now) rows.push({ id: `u_demo_${rows.length}`, at: iso(t), logged_at: iso(t + 2 * M), cache_write_tokens: 0, status: 'ok', ...r }); };
  for (let back = 6; back >= 0; back--) {
    const base = Date.parse(`${day(now - back * D)}T00:00:00${offset}`), q = 6 + (6 - back) * 4;
    for (const [h, m, big] of [[9, 20, 7.2], [13, 25, 10.4], [18, 20, 5.6]]) {
      const input = Math.round((big * 0.7 + rnd() * big * 0.6) * 1e6);
      add(base + h * H + m * M, { member: 'patch', role: 'executor', launcher: 'cycle', step: 'cycle', member_note: CYCLE_NOTE, backend: 'codex_exec', provider: 'openai', model: 'gpt-6-astra', input_tokens: input, cached_tokens: Math.round(input * 0.975), output_tokens: Math.round(18000 + rnd() * 9000), billing: 'subscription', quota: { used_percent: q + h / 6, window_minutes: 10080, resets_at: Math.round((now + 4 * D) / 1000), plan: 'plus', read_at: iso(base + h * H + m * M) } });
    }
    for (let h = 9; h < 18; h++) { const input = Math.round((2.9 + rnd() * 1.6) * 1e5); add(base + h * H + 7 * M, { member: 'owl', role: 'executor', launcher: 'mail-poll', step: 'mail-poll', backend: 'codex_exec', provider: 'openai', model: 'gpt-6-astra', input_tokens: input, cached_tokens: Math.round(input * 0.9), output_tokens: Math.round(1500 + rnd() * 1500), billing: 'subscription' }); }
    { const input = Math.round((1.6 + rnd() * 1.2) * 1e6); add(base + 15 * H + 40 * M, { member: 'lens', role: 'executor', launcher: 'run-now', step: 'research', backend: 'codex_exec', provider: 'openai', model: 'gpt-6-astra', input_tokens: input, cached_tokens: Math.round(input * 0.95), output_tokens: Math.round(9000 + rnd() * 6000), billing: 'subscription' }); }
    for (let i = 0; i < 26 + Math.round(rnd() * 14); i++) add(base + (9 * 60 + 12 + i * 11) * M, { member: 'lens', role: 'radar', launcher: 'judge-leads', step: 'judge', backend: 'jev', provider: 'typesafe', model: 'jev-latest', input_tokens: Math.round(9000 + rnd() * 6000), cached_tokens: 0, output_tokens: Math.round(1500 + rnd() * 1500), billing: 'api' });
    for (let i = 0; i < 3; i++) add(base + (20 + i) * H + 12 * M, { member: ['lens', 'owl', 'quill'][i], role: ['radar', 'watch', 'reacher'][i], launcher: 'serve', step: 'chat', backend: 'anthropic_http', provider: 'claude_gateway', model: 'claude-sonnet-5', input_tokens: Math.round(22000 + rnd() * 8000), cached_tokens: Math.round(14000 + rnd() * 4000), output_tokens: Math.round(600 + rnd() * 500), billing: 'api' });
    add(base + 11 * H + 5 * M, { member: 'quill', role: 'reacher', launcher: 'serve', step: 'rewrite', backend: 'openai_http', provider: 'deepseek', model: 'deepseek-chat', input_tokens: Math.round(6000 + rnd() * 3000), cached_tokens: 2000, output_tokens: 700, billing: 'api' });
  }
  ndjson('state/usage.ndjson', rows.sort((a, b) => a.at.localeCompare(b.at)));
}
// Sandbox mode for this root from now on (lib/sandbox.mjs); delete the file to leave it.
json('state/sandbox.json', { sandbox: true, by: 'bin/demo-seed.mjs', at: iso(now), note: '演示 / 沙盒模式：这个目录里跑的一切都不会发出任何东西（lib/sandbox.mjs）。删掉本文件即退出。' });
// The résumé assistant (简历 page, lib/resume-demo.mjs): a fictional résumé run through the real review with a
// canned model answer — fabricated rewrites get blocked on screen — plus a saved v2 and one tailored version.
// The real code writes its events on the wall clock; they are moved onto the demo clock (a few minutes before now, in
// order), so Tailor's work shows up on the demo's day whatever day the seed runs.
{
  const evFile = path.join(root, 'state/events.ndjson'), before = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8') : '';
  try { const { seedResumeDemo } = await import('../lib/resume-demo.mjs'); await seedResumeDemo({ now, leadId: L(6).id, waitLeadId: L(29).id, waitCompany: L(29).company }); } catch (e) { console.error(`résumé demo skipped: ${e.message}`); }
  const added = (fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8') : '').slice(before.length).split('\n').filter(Boolean);
  if (added.length) fs.writeFileSync(evFile, before + added.map((l, i) => JSON.stringify({ ...JSON.parse(l), ts: iso(now - (added.length - i) * 3 * M) })).join('\n') + '\n');
}
// Tasks as conversations (方案-任务即对话): a few tasks in each of the four states, each with its own conversation —
// Writer asking before it writes a letter (等你), Judge writing a prep note and a two-leg apply goal (在做), a résumé
// edit whose model call failed (没做成), a finished intake (做完); a plain chat where one sentence started two tasks
// (two link rows), an old card with no conversation of its own (opened as a read-only thread), a reply answered by the
// next model after the free quota stopped, a System answer with its buttons, and routine cards (folded in the directory).
{
  try {
    const K = { ...(await import('../lib/tasks.mjs')), ...(await import('../lib/cards.mjs')) }, X = await import('../lib/task-chat.mjs'), C = await import('../lib/chat.mjs');
    const { fixButton } = await import('../lib/system/explain.mjs');
    const { FREE_LABEL } = await import('../lib/free-model.mjs');
    const at = m => now - m * M;
    let n = 0; const mid = () => `dm${String(++n).padStart(10, '0')}`;
    const msg = (role, content, m, extra = {}) => ({ id: mid(), role, content, at: iso(at(m)), ...extra });
    const [L1, L2, L3, L4, L5, L6] = live.filter(l => l.number != null).slice(1, 7);
    const tag = l => `#${l.number} ${l.company}`;
    const card = o => K.makeCard({ from: { by: 'you' }, ...o, now: at(o.m) });
    // 等你：Writer asks two things before it writes the letter.
    const A = card({ kind: 'letters', title: `给 ${tag(L1)} 写求职信`, leads: [L1], owner: 'tailor', status: 'needs_you', m: 6 }); A.detail = '写之前先确认两件事';
    // 在做：Judge on a prep note; an apply goal whose first leg (referrers) is done and the second (form) is running.
    const B = card({ kind: 'prep', title: `${tag(L2)} 怎么准备`, leads: [L2], owner: 'lens', status: 'running', m: 5 }); B.started_at = iso(at(5));
    const G = card({ kind: 'goal', title: `投递 ${tag(L3)}`, leads: [L3], owner: 'team', m: 40 });
    const G1 = card({ kind: 'referrers', title: `${tag(L3)} · 找内推`, leads: [L3], owner: 'quill', goal: G.id, status: 'done', m: 39 });
    Object.assign(G1, { result: '你的联系人里没有这家公司的人，改走官网表单', done_at: iso(at(30)) });
    const G2 = card({ kind: 'apply', title: `${tag(L3)} · 预填申请表`, leads: [L3], owner: 'quill', goal: G.id, status: 'running', m: 29 }); G2.started_at = iso(at(29));
    G.route = [{ kind: 'referrers', owner: 'quill', state: 'done', card: G1.id }, { kind: 'apply', owner: 'quill', state: 'open', card: G2.id }];
    // 等你：an apply goal stopped before the form leg — it asks you (the same letter is in the inbox).
    const H = card({ kind: 'goal', title: `投递 ${tag(L6)}`, leads: [L6], owner: 'team', m: 25 });
    const H1 = card({ kind: 'referrers', title: `${tag(L6)} · 找内推`, leads: [L6], owner: 'quill', goal: H.id, status: 'done', m: 24 });
    Object.assign(H1, { result: '找到一位在那里工作过的联系人，消息草稿放在收件箱', done_at: iso(at(12)) });
    H.route = [{ kind: 'referrers', owner: 'quill', state: 'done', card: H1.id }, { kind: 'apply', owner: 'quill', state: 'planned' }];
    H.halt = { question: `要投 #${L6.number} ${L6.company} · ${L6.role} 吗？确认以后系统预填好认得出的项，停在提交前，你在页面上检查后自己提交。`, options: ['确认，开始预填', '不投了'], at: iso(at(12)), card: H1.id, from: 'quill' };
    H.status = 'needs_you';
    // 没做成：the model call behind a résumé edit failed.
    const D0 = card({ kind: 'resume', title: '改简历：项目经历', owner: 'tailor', status: 'stuck', m: 80 }); Object.assign(D0, { detail: '模型没调通（本机的 Claude Code 没跑起来）', started_at: iso(at(78)) });
    // 做完：an intake.
    const E = card({ kind: 'intake', title: `${tag(L4)} · 收录并核验`, leads: [L4], owner: 'scout', status: 'done', m: 120 }); Object.assign(E, { result: `#${L4.number} 收好了，还在招`, done_at: iso(at(118)) });
    // An old card from before tasks had conversations: no session_id, opened as a read-only thread built on the spot.
    const F = card({ kind: 'research', title: `${tag(L5)} · 公司调研`, leads: [L5], owner: 'lens', status: 'needs_you', m: 300 });
    F.steps.push({ at: iso(at(299)), who: 'lens', text: '读了官网、最近的新闻和招聘页' }); Object.assign(F, { status: 'done', result: `${L5.company} 的调研写好了：业务、团队规模和最近在招的方向`, done_at: iso(at(290)) });
    // The plain chat: a question, the old card message, a fallback reply, a System answer, then one sentence → two tasks.
    const P = C.newSession({ persona: 'patch', now: at(400) });
    const askF = msg('user', `帮我调研一下 #${L5.number}`, 300);
    F.from = { by: 'you', session_id: P.id, message_id: askF.id };
    P.title = '今天跑了什么';
    P.messages = [
      msg('user', '今天跑了什么', 400),
      msg('assistant', '上午 09:05 那一轮扫了 12 个官方源，新判断 40 个岗位，推荐 3 个。', 399, { persona: 'patch', model: 'deepseek-chat', backend: 'deepseek/deepseek-chat', fallback_from: [{ backend: 'offercrew/supply', label: FREE_LABEL, why_kind: 'quota' }], fallback_to: 'DeepSeek · deepseek-chat' }),
      msg('user', '为什么推荐是 3 个', 398, { question: true }),
      msg('assistant', '原因：最近一天看了 40 个岗位：推荐 3、待核 21、排除 16。待核的大多差在「Go 经验」，你的资料里看不出来。\n影响：有 3 个推荐可以直接投。\n能怎么办：你确实有 Go 经验的话，在资料里补上；不想等下一档，可以现在再判 40 个。', 397, { persona: 'patch', kind: 'why', why: { kind: 'verdict', by: 'rule', buttons: ['profile', 'rejudge'].map(id => fixButton(id)).filter(Boolean) } }),
      askF,
      msg('assistant', `好，我来调研 ${L5.company}。`, 300, { persona: 'lens', kind: 'card', card: F.id }),
      msg('user', `给 #${L1.number} 写封求职信，再看看 #${L2.number} 怎么准备`, 6),
    ];
    C.saveSession(P);
    // 用真实 Writer 问题记录，和原对话同一份；普通 assistant 文字不能充当可回答的问题。
    const { writeLetter } = await import('../lib/resume-letters.mjs');
    const letter = await writeLetter({ kind: 'cover_letter', record_id: L1.record_id || L1.id, now: at(6), model: async () => ({
      paragraphs: [`Dear ${L1.company} hiring team,`, 'I am applying for the role. At Example Tech I designed and implemented conversation service APIs and worked on the migration of the evaluation pipeline from cron jobs to a queue-based workflow.', 'Alex Example'],
      why: '围绕岗位确认语言和要强调的经历',
    }) });
    if (!letter.key) throw Error('demo letter missing');
    const questionA = msg('assistant', '', 5, { persona: 'tailor', kind: 'writer', writer: { kind: 'letter_ask', letter: letter.key, title: A.title, lead: { rid: L1.record_id || L1.id, number: L1.number, company: L1.company, role: L1.role } } });
    json('state/writer-talk.json', { ...(read('state/writer-talk.json') || {}), [questionA.id]: { kind: 'ask', status: 'done', at: iso(at(5)), questions: [
      { id: 'language', kind: 'direction', text: '用中文还是英文？', options: ['中文', '英文'] },
      { id: 'experience', kind: 'direction', text: '要不要写你在 RAG 评测流水线上的经历？', options: ['写进去', '先不写'] },
    ] } });
    A.links = { ...A.links, writer: questionA.id }; A.from = { by: 'you', session_id: P.id, message_id: P.messages.at(-1).id };
    P.messages.push(questionA); C.saveSession(P);
    const sA = P.id;
    const sB = X.openTaskSession(B, { now: at(5), origin: `你在对话里说的：看看 #${L2.number} 怎么准备`, extra: { asked_in: { session_id: P.id } } });
    X.appendMessage(sB, msg('assistant', 'Judge 对着 JD 和你的缺口在写怎么准备。', 4, { persona: 'lens' }));
    const sG = X.openTaskSession(G, { now: at(40), messages: [msg('user', `投 #${L3.number}`, 40)] });
    X.appendMessage(sG, msg('system', `${crewName('quill')} → ${crewName('quill')}：你的联系人里没有 ${L3.company} 的人，改走官网表单`, 30, { kind: 'relay', from: 'quill', to: 'quill', card: G2.id }));
    const sH = X.openTaskSession(H, { now: at(25), messages: [msg('user', `投 #${L6.number}`, 25)] });
    X.appendMessage(sH, msg('assistant', `找到一位在 ${L6.company} 工作过的联系人，消息草稿放在收件箱。`, 12, { persona: 'quill' }));
    H.session_id = sH;
    const sD = X.openTaskSession(D0, { now: at(80), messages: [
      msg('user', '把项目经历改得更突出 Agent 的部分', 80),
      msg('assistant', '先确认：用中文版还是英文版？RAG 评测那段要不要保留？', 79, { persona: 'tailor' }),
      msg('user', '中文版；保留', 78),
      msg('assistant', `${crewName('tailor')} 这次没写成：模型没调通（本机的 Claude Code 没跑起来）`, 76, { persona: 'tailor', bad: true }),
    ] });
    const sE = X.openTaskSession(E, { now: at(120), origin: `你贴了一个链接让 ${crewName('scout')} 收录` });
    X.appendMessage(sE, msg('assistant', `#${L4.number} 收好了，还在招。`, 118, { persona: 'scout' }));
    Object.assign(A, { session_id: sA }); Object.assign(B, { session_id: sB }); Object.assign(G, { session_id: sG }); Object.assign(D0, { session_id: sD }); Object.assign(E, { session_id: sE });
    K.saveCards([A, B, G, G1, G2, H, H1, D0, E, F]);
    const { recordWriter } = await import('../lib/task-writer.mjs');
    recordWriter(A, { session: P, now: at(5) });
    // 「在做」的那张投递卡也要有账上的动作带着（任务卡只读账，第 2 步 2X）：一条你批准过的预填，排到明早再填（演示里不真的打开浏览器）。
    {
      const J = await import('../lib/jobs.mjs'), { tx, toJson } = await import('../lib/db.mjs'), { newActionId } = await import('../lib/actions.mjs');
      const j = J.byRef(`card:${G2.id}`), rid = L3.record_id || L3.id, later = new Date(now + 24 * 3600e3).toISOString();
      if (j) tx(d => d.prepare(`INSERT INTO actions (id, kind, job_id, target, payload, state, attempts, not_before, approved_at, created_at, updated_at) VALUES (?, 'prefill', ?, ?, ?, 'approved', 0, ?, ?, ?, ?)`)
        .run(newActionId(at(29)), j.id, `lead:${rid}`, toJson({ record_id: rid, number: L3.number }), later, iso(at(29)), iso(at(29)), iso(at(29))));
    }
    const P2 = C.loadSession(P.id);
    P2.messages.push(X.taskLink(A, { now: at(6) }), X.taskLink(B, { now: at(6) })); P2.updated_at = iso(at(6));
    C.saveSession(P2);
    // Seen: everything except Writer's question (the switcher shows its dot).
    for (const id of [sB, sG, sH, sD, sE]) { const f = path.join(root, 'state/chat', `${id}.json`), s0 = JSON.parse(fs.readFileSync(f, 'utf8')); s0.seen_at = iso(now); fs.writeFileSync(f, JSON.stringify(s0, null, 2) + '\n'); }
    await K.cycleRoutines([{ stage: 'discover', status: 'changed' }, { stage: 'judge-leads', status: 'changed' }, { stage: 'discover-human', status: 'error', error: '电鸭返回 403，这一轮跳过了' }], { now: at(200) });
  } catch (e) { console.error(`task demo skipped: ${e.message}`); }
}
console.log(`demo state written under ${root} (sandbox mode: state/sandbox.json)`);
