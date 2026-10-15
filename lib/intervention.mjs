// 收件箱与任务详情共用的介入类别；模型提供具体内容，不决定按钮的名字。
export const INTERVENTIONS = {
  computer: { type: 'info', prompt: '这一步要你在电脑上操作' },
  login: { type: 'login', prompt: '这一步要你登录' },
  submit: { type: 'review', prompt: '这一步要你检查并提交' },
  decide: { type: 'decide', prompt: '这一步要你决定' },
  info: { type: 'info', prompt: '这一步要你补信息' },
  review: { type: 'review', prompt: '这一步要你看一眼再发' },
};
// 先看当前步骤的结构和动作；文字只兼容未留下结构的旧卡。
// 不能因说明里提到“登录后/提交前”，或仅有 job_ref，就把补信息、选择题归成电脑操作。
export function interventionOf(a = {}, c = {}) {
  const id = a.id || c.links?.ask_id || '';
  const steps = (a.options || []).flatMap(o => o.steps || []);
  const t = [a.question, c.detail, c.computer_need].filter(Boolean).join(' ');
  let code;
  if (INTERVENTIONS[a.intervention_code]) code = a.intervention_code;
  else if (a.type === 'login' || /^login:/.test(id)) code = 'login';
  else if (a.form?.length || a.questions?.length || /^need:.*:info$/.test(id)) code = 'info';
  else if (/^(?:final|prefilled|submit):/.test(id) || steps.some(s => s.type === 'action' && s.kind === 'submit')) code = 'submit';
  else if (a.preview?.kind === 'draft' || steps.some(s => ['send', 'send_dm', 'send_email'].includes(s.kind || s.type))) code = 'review';
  else if (a.type === 'decide' || a.type === 'triage' || /^(?:goal|apply|reapprove):/.test(id)) code = 'decide';
  else if (steps.some(s => s.type === 'localai')) code = 'computer';
  else if (c.wait === 'login') code = 'login';
  else if (c.wait === 'final') code = 'submit';
  else if (c.wait === 'local_ai' || c.mac_hold) code = 'computer';
  else if (/(?:先|要你|请你|自己).{0,6}登录|登录(?:网站|账号)/.test(t)) code = 'login';
  else if (/(?:本人|亲自|自己)[^。；]{0,35}(?:申请|提交|投递简历)|(?:本人|自己)投|一键投(?:出|递)/.test(t)) code = 'submit';
  else if (/电脑|验证码|浏览器里/.test(t)) code = 'computer';
  else code = a.type === 'info' ? 'info' : 'decide';
  return { code, ...INTERVENTIONS[code] };
}
