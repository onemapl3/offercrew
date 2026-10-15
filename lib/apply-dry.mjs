// 演示 / 沙盒里的投递驱动：只走到「终审」，从不提交（2026-09-29，端到端验证用）。
//
// 真的投递要开浏览器（ego 或内置的 playwright）去填表，沙盒不许启动任何浏览器（lib/sandbox.mjs）。但「系统替你填好、
// 停在提交前、你在收件箱核对这一版」是整个流程最要紧的一步，演示里必须看得到。Greenhouse 的公开招聘接口会把一个岗位的
// 申请表问题一起给出来（和它嵌在公司官网上的表单是同一份，只读、不用账号），这个驱动就读这份问题清单：
//   inspect  读公开的问题清单，换成和浏览器里读出来同样形状的控件列表（标题、类型、选项、是否必填）；
//   prefill  不开页面，把系统要填的每一项原样当作「读回的值」交给终审（没有截图，终审里写明是沙盒）；
//   apply    永远不提交：返回「提交前就停了」，这一条记为没投成，原因写清是沙盒。
// 只接 Greenhouse 的岗位（accepts）；别的招聘系统在沙盒里交还给你，和没有浏览器时一样。
// 打开方式：RADAR_APPLY=dry（沙盒里 bin/auto-apply.mjs 只有这样才会跑）。
import { json } from './ats/http.mjs';
import { sandboxed } from './sandbox.mjs';
import path from 'node:path';

const FIELD_TYPE = {
  input_text: { tag: 'input', type: 'text' }, input_file: { tag: 'input', type: 'file' }, textarea: { tag: 'textarea', type: 'textarea' },
  multi_value_single_select: { tag: 'select', type: 'select-one' }, multi_value_multi_select: { tag: 'select', type: 'select-multiple' },
  input_hidden: null,
};
// Greenhouse 的一个问题可能有两个字段（「上传简历」或「粘贴文字」）：有上传的就只要上传那一个。
export function greenhouseControls(job = {}) {
  const out = [];
  const add = (q, required) => {
    const fields = (q.fields || []).filter((f) => FIELD_TYPE[f.type]);
    const pick = fields.some((f) => f.type === 'input_file') ? fields.filter((f) => f.type === 'input_file') : fields;
    for (const f of pick) out.push({ ...FIELD_TYPE[f.type], name: f.name, id: f.name, required: !!required, label: String(q.label || f.name || '').replace(/\s+/g, ' ').trim(), options: (f.values || []).map((v) => String(v.label ?? v.value)), selector: `#${f.name}` });
  };
  for (const q of job.questions || []) add(q, q.required);
  for (const q of job.location_questions || []) add(q, q.required);
  for (const section of job.compliance || []) for (const q of section.questions || []) add(q, false);
  return out;
}
export function greenhouseTarget(lead = {}, companies = []) {
  const c = companies.find((x) => x.name === lead.company && x.ats_type === 'greenhouse');
  const board = c?.board || String(lead.url || '').match(/greenhouse\.io\/([^/]+)\/jobs\//)?.[1];
  const id = lead.source_job_id || String(lead.url || '').match(/\/jobs\/(\d+)|gh_jid=(\d+)/)?.slice(1).find(Boolean);
  return board && id ? { board, id: String(id) } : null;
}
export function dryApplyDriver({ leads = [], companies = [] } = {}) {
  const leadOf = (plan) => leads.find((l) => (l.record_id || l.id) === plan.record_id) || {};
  return {
    accepts: (lead) => !!greenhouseTarget(lead, companies),
    inspect: async ({ plan }) => {
      const t = greenhouseTarget(leadOf(plan), companies);
      if (!t) return { url: plan.url, controls: [], text: '' };
      const job = await json(`https://boards-api.greenhouse.io/v1/boards/${t.board}/jobs/${t.id}?questions=true`);
      return { url: plan.url, controls: greenhouseControls(job), text: '', space: null };
    },
    prefill: async ({ plan, entries }) => ({
      prefilled: true, dry: true, url: plan.url, screenshot: null,
      readback: entries.map((e) => ({ key: e.key, value: e.action === 'files' ? path.basename(plan.resume_absolute_path || String(e.value || '')) : e.action === 'check' ? (e.value ? '已勾选' : '未勾选') : String(e.value ?? '') })),
    }),
    apply: async () => ({ submitted: false, presubmit: true, error: 'sandbox_dry_run: 沙盒只演示到终审，没有真的提交' }),
  };
}
// 只在沙盒里认：真机器上设了 RADAR_APPLY=dry 也照常用真的驱动（免得演示用的终审混进真实的投递）。
export const dryApplyWanted = () => sandboxed() && /^dry$/i.test(String(process.env.RADAR_APPLY || '').trim());
