// 演示数据里的「材料」（bin/demo-seed.mjs 最后调用；全部虚构，人物和模板 candidate/facts.example.yaml 一致）。
//
// 演示 / 沙盒模式不调用模型，所以 Writer 改的那几处是预先写好的，照样走真实的版本操作（lib/resume-versions.mjs）：
//   v1 原简历（上传）→ v2 你改的 → v3 Writer 改的（默认投递）→ 挂在 v3 下面的 Contoso 定制版 → 一条「等你看」的 Writer 新版。
// 设默认投递要本机的 Chromium 导出 PDF；没有就只标记（演示用，resume_routing 仍指着演示自带的占位 PDF）。
import { loadDoc, loadWorkspace } from './resume-store.mjs';
import { importResume, copyToNewDoc } from './resume-intake.mjs';
import { applyOps, copyVersion, setDefault } from './resume-versions.mjs';
import { markDefault, saveDoc, saveWorkspace } from './resume-store.mjs';
import { writeLetter, decideLetter, lettersView } from './resume-letters.mjs';
import fs from 'node:fs';
import { file } from './store.mjs';
import { allLines } from './resume-doc.mjs';

export const DEMO_RESUME = `Alex Example
alex@example.com | +86 138 0000 0000 | github.com/alex-example | Shanghai
SUMMARY
Backend engineer working on AI application services and service integration. Built Photo Book, an independent agent project.
EXPERIENCE
Example Tech (示例科技)
Software Engineer 2023.07 – Present
• Responsible for the design and implementation of the conversation service APIs.
• Worked on the migration of the evaluation pipeline from cron jobs to a queue-based workflow.
• Wrote scripts to clean up training data and helped with managment of the test environment.
Contoso
Software Development Intern Jun 2020 – Sep 2020
• Helped migrate a backend service and optimized slow SQL queries, cutting p95 latency from 800 ms to 200 ms.
PROJECTS
Photo Book — independent project 2024 – Present
• Built a local photo-book generator where an agent picks, groups and lays out photos.
• Used Python and a vision model; geometry code keeps layouts inside print margins.
EDUCATION
Example University — M.S. in Computer Science Sep 2020 – Jun 2022
示例大学 (Sample University) — B.Eng. in Software Engineering Sep 2016 – Jun 2020
SKILLS
Languages: Python, Go, TypeScript, SQL
Tools: Docker, Redis, PostgreSQL, github, LangChain
`;
const H = 3600000;
export async function seedResumeDemo({ now = Date.now(), leadId = null, waitLeadId = null, waitCompany = '', exporter = null } = {}) {
  if (loadWorkspace().docs.length) return { status: 'exists' };
  const { id } = importResume({ text: DEMO_RESUME, name: 'Alex-Example-Resume.pdf' }, { now: now - 27 * H });
  const v1 = loadDoc(id).versions[0].content, L = start => allLines(v1).find(l => l.text.startsWith(start))?.id;
  const edit = (vid, by, ops, at) => applyOps(id, vid, ops, { by, rev: Number(loadDoc(id).versions.find(v => v.id === vid).rev) || 0, now: now - at * H });
  // v2：你自己改的（改掉错别字、把一条拆成两件事）。
  const v2 = copyVersion(id, 'v1', { name: '通用版', by: 'you', now: now - 26 * H });
  edit(v2, 'you', [{ op: 'set_text', line_id: L('Wrote scripts'), text: 'Wrote scripts to clean up training data; helped manage the test environment.' }], 26);
  // v3：Writer 改的一版（动词开头、结果单独成句），默认投递。
  const v3 = copyVersion(id, v2, { name: '通用版', by: 'writer', now: now - 25 * H });
  edit(v3, 'writer', [
    { op: 'set_text', line_id: L('Responsible for'), text: 'Designed and implemented the conversation service APIs.' },
    { op: 'set_text', line_id: L('Helped migrate'), text: 'Helped migrate a backend service; optimized slow SQL queries and cut p95 latency from 800 ms to 200 ms.' },
  ], 25);
  let using = false;
  try { await setDefault(id, v3, 'en', { now: now - 25 * H, exporter }); using = true; } catch { markDefault(id, v3, 'en'); }
  // Contoso 定制版：挂在 v3 下面，把评测流水线那一条放到最前面，加粗和岗位相关的词。
  if (leadId) {
    const t = copyVersion(id, v3, { name: 'Contoso 定制版', by: 'tailor', lead_ids: [leadId], now: now - 2 * H });
    edit(t, 'writer', [
      { op: 'move_line', line_id: L('Worked on'), after: null },
      { op: 'set_em', line_id: L('Built a local'), em: ['agent'] },
      { op: 'set_em', line_id: L('Responsible for'), em: ['conversation service APIs'] },
    ], 2);
  }
  // Writer 改出来的一版（10-02 起改完直接存成新的一版）：更精简、突出 AI 应用，以 v3 为底。
  const v5 = copyVersion(id, v3, { name: '通用版', by: 'writer', now: now - 60 * 60000 });
  edit(v5, 'writer', [
    { op: 'set_text', line_id: L('Backend engineer'), text: 'Backend engineer for AI application services; built Photo Book, an independent agent project.' },
    { op: 'set_text', line_id: L('Worked on'), text: 'Worked on migrating the evaluation pipeline from cron jobs to a queue-based workflow.' },
  ], 1);
  // 另一个岗位的定制版刚做好、还没点「用这版」（10-02）：收件箱有一封「定制版好了」，岗位页标「等你确认」，投递照旧用 v3。
  if (waitLeadId) {
    const w = copyVersion(id, v3, { name: `${waitCompany || '岗位'} 定制版`, by: 'tailor', lead_ids: [waitLeadId], now: now - 20 * 60000 });
    edit(w, 'writer', [{ op: 'move_line', line_id: L('Built a local'), after: null }, { op: 'set_em', line_id: L('Responsible for'), em: ['APIs'] }], 0.3);
    const d = loadDoc(id), x = d.versions.find(v => v.id === w);
    if (x) { x.accepted = false; saveDoc(d); }
  }
  // 第二份简历（10-03，材料 → 简历文件）：从这份的 v3 复制出来、专投 AI 应用方向，Writer 在它上面又改了一版。
  // 文件列表里能看到两份；点进这一份，v1 写着「从『英文简历 v3』复制」，版本号从 v1 重新算。
  {
    const c = copyToNewDoc(id, v3, { title: 'AI 应用方向', now: now - 3 * H });
    const cv1 = loadDoc(c.id).versions[0].content, C = start => allLines(cv1).find(l => l.text.startsWith(start))?.id;
    const cv2 = copyVersion(c.id, 'v1', { name: 'AI 应用', by: 'writer', now: now - 2.5 * H });
    applyOps(c.id, cv2, [{ op: 'set_text', line_id: C('Backend engineer'), text: 'Backend engineer for AI application services; built Photo Book, an independent agent project.' }], { by: 'writer', rev: 0, now: now - 2.5 * H });
    const dd = loadDoc(c.id); dd.current = cv2; saveDoc(dd);
    const ws = loadWorkspace(); ws.active = id; saveWorkspace(ws);
  }
  // Tailor 的求职信和自我介绍：先放一份虚构的公司调研（Contoso），再按真实流程写、逐句核对。
  if (leadId) {
    const brief = 'state/company-briefs/contoso.json';
    if (!fs.existsSync(file(brief))) { fs.mkdirSync(file('state/company-briefs'), { recursive: true }); fs.writeFileSync(file(brief), JSON.stringify({ company: 'Contoso', key: 'contoso', aliases: [], status: 'ready', summary: 'Contoso 做面向企业的智能体平台，帮客户把 Agent 用到客服和运营里。', business: [{ text: 'Contoso 的智能体平台服务 300 多家企业客户', src: [1] }], scale: [], hiring: [], tech: [{ text: 'Agent 运行时用 Go 和 Python 写，部署在 Kubernetes 上', src: [1] }], news: [{ text: '2026 年 8 月发布了 Agent 评测工具', src: [2], date: '2026-08-12' }], culture: [], interview: [], salary: [], red_flags: [], sources: [{ title: 'Contoso 官网（虚构）', url: 'https://www.example.com/contoso', date: '2026-09-01' }, { title: '示例媒体（虚构）', url: 'https://news.example.com/contoso-eval', date: '2026-08-12' }], updated_at: new Date(now - 30 * H).toISOString() }, null, 2)); }
    const letter = ['Dear Contoso hiring team,', 'I am applying for the Backend Engineer, Agent Runtime role. Contoso builds an agent platform for enterprises, and the role asks for experience with LLM applications and running agent systems in production.', 'At Example Tech I designed and implemented the conversation service APIs, and I worked on the migration of the evaluation pipeline from cron jobs to a queue-based workflow. I also wrote scripts to clean up training data and helped with the test environment. Outside work I built Photo Book, a local photo-book generator where an agent picks, groups and lays out photos, using Python and a vision model.', 'I would be glad to bring this experience with agent systems and backend services to the team.', 'Alex Example\nalex@example.com'];
    await writeLetter({ kind: 'cover_letter', record_id: leadId, now: now - 90 * 60000, model: async () => ({ paragraphs: letter, why: '先说为什么是这家公司的这个岗位（Agent 平台、生产环境），再说做过的对得上的三件事' }) }).catch(() => {}); // 兜底：演示数据：这封信没写成，演示里就少一封
    const intro = '我是 Alex Example，做 AI 应用后端，参与过评测流水线从定时任务迁到队列化工作流，写过清洗训练数据的脚本；业余独立做了 Photo Book，一个用 Agent 选图、分组和排版的本地照片书生成器。想继续做 AI 应用和 Agent 方向的后端工作。';
    const r = await writeLetter({ kind: 'self_intro', lang: 'zh', now: now - 80 * 60000, model: async () => ({ paragraphs: [intro], why: '学历年限一句带过，重点放在做过的两件事上' }) }).catch(() => null); // 兜底：演示数据：没写成就少一段自我介绍
    const rec = r?.status === 'proposed' ? lettersView().intros.find(x => x.key === 'intro-generic-zh') : null;
    if (rec) await decideLetter(rec.key, 'use', { fp: rec.fp, now: now - 75 * 60000 }).catch(() => {}); // 兜底：演示数据：没选上就显示成没选
  }
  return { status: 'seeded', id, using };
}
