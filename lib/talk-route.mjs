// 你说的一句话交给谁、做完怎么回你（2026-09-29 对话面板，web/talk.js）。你不用挑成员，这里按规则分（是代码，不是一个角色）：
//   指令（lib/intent.mjs resolveCommand 认得的：投 12 13、pass 44 原因、12 联系……）→ 管这件事的那位（commandPersona），
//        回执用那位的口吻、第一人称，写清动了哪几行（receiptLine）
//   「现在怎么样、我该做什么」→ 团队按当前状态直接答（isStatusQuestion，不经模型；单独和一位成员说时也是团队答）
//   「为什么推荐是 0」「怎么还没跑」→ System 讲原因、影响、能怎么办（isWhyQuestion；问某一条的由 Judge 说，whyTarget）
//   贴来的岗位链接 → Scout 收录（isCapture）
//   别的话 → 关键词打分最高的那位（routePersona）；一个词都没命中，接着上一位说；没有上一位是 Scout
// 成员是六位（lib/members.mjs：scout lens tailor quill owl patch）；旧 id（radar reacher watch system）在那边当别名认。
// 全是纯函数、确定的：同一句话永远交给同一位（tests/talk-route.test.mjs）。
import { errorReason } from './say-error.mjs';
import { QUEUED_LINE } from './op-queue.mjs';
// 这句话要做什么只在 lib/intent.mjs 认（4a）；这里只管交给谁、回执怎么说。下面几样从那边转出去，老的调用方不用改。
import { NUMBERED, isStatusQuestion, isWhyQuestion, whyTarget, captureUrl, focusCommand, BANNER_WHY, commandNumbers } from './intent.mjs';
export { isStatusQuestion, isWhyQuestion, whyTarget, captureUrl, focusCommand, BANNER_WHY, commandNumbers };

// 分派表：关键词 → 成员 id（显示名在 lib/crew.mjs：scout Radar、lens Judge、tailor Writer、quill Reacher、owl Watcher、patch System）。
// 问一条线索的团队、级别、公司是 Judge（lens）的事，不是 Radar 的（「查一下 #26 招的是哪个团队、什么级别」）。
// 成员变了加一行、改一行就行。strong 3 分、weak 1 分；同一个词只算一次；同分按表里的先后。
// 关键词是正则片段：弱词里「发」「信」躲开「发现」「信息」，免得「最近发现的岗位」算成递出去的事。
export const ROUTES = [
  { member: 'scout', strong: ['岗位', '职位', '线索', '新机会', '扫一下', '扫描', '搜一下', '找工作', '找岗位', '发现', '招聘帖', '真人帖', '收录', '去重', '重复', '外包', '还在招'], weak: ['看看', '找', '招', '机会'] },
  { member: 'lens', strong: ['推荐', '匹配', '判断', '值不值', '适合', '合适', '评估', '差距', '职级', '级别', '资深', '薪资', '调研', '融资', '规模', '口碑', '方向', '要不要投', 'JD', '(?:哪个|什么|哪些)(?:团队|组|部门|业务|级别|职级)', '团队(?:规模|背景|情况)', '业务线', '做什么的', '公司(?:背景|情况|怎么样)'], weak: ['公司', '值得', '城市', '团队', '业务'] },
  { member: 'tailor', strong: ['简历', '自我介绍', '求职信', 'cover ?letter', '改写', '定制', '体检', '作品集'], weak: ['材料', '版本'] },
  { member: 'quill', strong: ['投递', '内推', '草稿', '首联', '私信', '跟进', '发出去', '发送', '申请表', '填表', '提交', '终审', '联系人', '招聘方', '打招呼', 'referr\\w*'], weak: ['投', '发(?!现)', '信(?!息)', '联系', '申请', '消息'] },
  { member: 'owl', strong: ['面试', '笔试', '约面', '邮件', '邮箱', '收件箱', '回信', '回复', '答复', 'offer', '复盘', '面经', '故事库', '模拟', '日程', '终面', '一面', '二面', '三面', 'HR ?面'], weak: ['回了', '回我', '时间', '提醒', '准备'] },
  { member: 'patch', strong: ['执行器', '报错', '出错', '错误', '失败', '卡住', '卡死', '日志', '配置', '设置', '模型', '额度', 'token', '用量', '预算', '花了多少', '调度', '定时', '周期', '重启', '服务', '崩了', '挂了', 'bug', '修一下', '修复', '飞书', '同步', '登录', '太慢', '隐私'], weak: ['运行', '跑', '系统', '卡'] },
];
const compiled = new WeakMap();
const rulesOf = routes => {
  if (!compiled.has(routes)) compiled.set(routes, routes.map(r => ({ member: r.member, parts: [[new RegExp((r.strong || []).join('|') || '(?!)', 'gi'), 3], [new RegExp((r.weak || []).join('|') || '(?!)', 'gi'), 1]] })));
  return compiled.get(routes);
};
export const routeMembers = (routes = ROUTES) => routes.map(r => r.member);

export function personaScores(text, { routes = ROUTES } = {}) {
  const t = String(text || '');
  return Object.fromEntries(rulesOf(routes).map(r => [r.member, r.parts.reduce((sum, [re, w]) => sum + w * new Set((t.match(re) || []).map(x => x.toLowerCase())).size, 0)]));
}
// 问一条岗位值不值得投、它的团队、级别、公司：Judge（lens）答，不管句子里有没有「岗位」这种 Radar 的词（A24：
// 「#12 这个岗位值得投吗」原来按「岗位」3 分、平分时 Radar 在前，交给了 Radar）。要有编号或「这个 / 这家 / 这条」指着一条。
const JUDGE_Q = /值得(?:投|申请|去)|值不值得?(?:投|申请|去)|要不要投|该不该投|能不能投|适合我|合适吗|靠谱|(?:哪个|什么|哪些)(?:团队|组|部门|业务|级别|职级)|团队(?:怎么样|如何|规模|背景|情况)|级别|职级|公司(?:怎么样|如何|背景|情况|靠谱)|这家(?:公司)?怎么样/;
export const isJudgeQuestion = text => { const t = String(text || ''); return JUDGE_Q.test(t) && /#?\d{1,6}|这个|这家|这条|它/.test(t); };
// previous：这个会话里上一位说话的成员（接着聊「那 13 呢」不换人）。
export function routePersona(text, { previous = null, routes = ROUTES } = {}) {
  if (routes === ROUTES && isJudgeQuestion(text)) return 'lens';
  const s = personaScores(text, { routes }), best = Math.max(0, ...Object.values(s)), members = routeMembers(routes);
  if (!best) return members.includes(previous) ? previous : members[0];
  return members.find(k => s[k] === best);
}
// 「现在怎么样、我该做什么」和贴来的链接归谁。
// 状态问题问的是全局，由「团队」回答，不交给哪一位成员（2026-09-30）。
export const STATUS_MEMBER = 'team', CAPTURE_MEMBER = 'scout';

// ── 指令：谁管、动哪几行、给人看的动词 ─────────────────────────────────────────
const input = cmd => String(cmd?.input || '');
// 编号在前的指令（「44 pass 太远」「12 联系」「27 复盘今天……」）里的动作词和后面那句：词表在 lib/intent.mjs NUMBERED。
const wordOf = cmd => NUMBERED.exec(input(cmd))?.[2] || '';
export const restOf = cmd => (NUMBERED.exec(input(cmd))?.[3] || '').trim();
const WATCH_ACTIONS = /^(面试完成|复盘|offer|准备好了|卡住了|查看准备|准备)$/i;

export function commandPersona(cmd = {}) {
  if (cmd.kind === 'op') return { radar: 'scout', reacher: 'quill', watch: 'owl', system: 'patch' }[cmd.role] || cmd.role || 'patch';
  if (cmd.kind === 'agent') return cmd.member || 'patch';
  if (cmd.kind === 'resume_executor') return 'patch';
  if (['queue_apply', 'apply_list', 'send_list', 'send_all'].includes(cmd.kind) || ['send', 'cancel', 'revise', 'queue_apply'].includes(cmd.verb)) return 'quill';
  // pass 和备注是你对这一条的判断（Lens 从这里学偏好）；联系、跟进是递出去的事。
  if (cmd.verb === 'feedback') return /^(联系|跟进)$/.test(wordOf(cmd)) ? 'quill' : 'lens';
  if (['schedule', 'progress', 'snooze'].includes(cmd.verb)) return 'owl';
  if (cmd.verb === 'action') return WATCH_ACTIONS.test(wordOf(cmd)) ? 'owl' : wordOf(cmd) === '这步好了' ? 'quill' : 'scout';
  // 重点、详情、刷卡筛选：判断的事；归档、重新打开、我的待办：线索本身的事。
  if (['top_picks', 'brief', 'flashcard', 'flashcard_stop'].includes(cmd.kind)) return 'lens';
  return 'scout';
}

// 预览行和回执上的动词：「投」「pass」「联系」「记面试」……
export function verbLabel(cmd = {}) {
  switch (cmd.kind) {
    case 'queue_apply': return cmd.all ? '投 拟投清单全部' : '投';
    case 'send_all': return '发 全部待发草稿';
    case 'apply_list': return '拟投清单';
    case 'send_list': return '拟发清单';
    case 'top_picks': return '重点岗位';
    case 'flashcard': return `筛选${cmd.filter ? ' ' + cmd.filter : ''}`;
    case 'flashcard_stop': return '停止刷卡';
    case 'brief': return '详情';
    case 'query': return input(cmd) || '我的待办';
    case 'op': return cmd.label || '跑一个操作';
    case 'resume_executor': return '继续';
    case 'agent': return cmd.verb === 'pause' ? '暂停' : '恢复';
  }
  if (cmd.verb === 'send') return '发';
  if (cmd.verb === 'cancel') return '不发';
  if (cmd.verb === 'revise') return '改';
  if (cmd.verb === 'schedule') return '记面试';
  return wordOf(cmd) || cmd.verb || '指令';
}
// 动词后面那句（原因、时间、怎么改）。
export function commandNote(cmd = {}) {
  if (['queue_apply', 'send_all', 'op', 'query', 'brief', 'agent'].includes(cmd.kind) || cmd.verb === 'send') return '';
  return restOf(cmd);
}

// ── 回执：管这件事的那位用第一人称说一句；to 是那几行接下来会变成什么 ─────────────
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const list = rows => rows.map(r => `#${r.number}${r.company ? ' ' + r.company : ''}`).join('、');
// res：dispatchCommand 的返回（或 { ok:false, error }）；rows：这条指令点到的线索 { number, company, role }。
export function receiptLine(cmd = {}, res = {}, rows = []) {
  if (res.draft) return { text: res.receipt, to: '草稿待审阅', per: {}, ok: true };
  // 原因只说人话（lib/say-error.mjs errorReason）：原始报错不进回执。
  if (res.ok === false || res.error) return { text: `这条我没办成：${errorReason(res.error || res.receipt)}`, to: null, ok: false };
  const who = list(rows), note = commandNote(cmd), word = wordOf(cmd), backend = String(res.receipt || '').trim();
  const say = (text, to = null) => ({ text, to, ok: true });
  if (cmd.kind === 'queue_apply') {
    if (res.data?.frozen) return say(`投递现在冻结着，我先把 ${who || '要投的编号'} 记下，解冻后再排队，不会真的提交。`, '记下，解冻后再投');
    // bin/queue-apply.mjs 说了每个编号的去向：排上的、等你登录的、没排上的分开说，每一行写它自己的去向（per）。
    const a = res.applied;
    if (a) {
      const name = n => { const r = rows.find(x => x.number === n); return `#${n}${r?.company ? ' ' + r.company : ''}`; };
      const skipped = (a.skipped || []).map(x => /^(\d{1,6})[：:]\s*([\s\S]*)$/.exec(String(x))).filter(Boolean).map(m => [Number(m[1]), m[2]]);
      const per = {};
      // 自动提交关着（默认）：系统只预填，填好你在页面上提交（09-30 #26）。
      for (const n of a.queued || []) per[n] = a.auto_submit ? '排队投递 · 提交前等你终审' : '排队预填 · 填好你在页面上提交';
      for (const n of a.waiting_login || []) per[n] = a.auto_submit ? '等你登录后自动提交' : '等你登录后预填';
      for (const [n, why] of skipped) per[n] = `没排上：${cut(why, 60)}`;
      const parts = [
        (a.queued || []).length ? `${a.queued.map(name).join('、')} 我排进投递队列了，${a.auto_submit ? '填好表会先停在提交前，等你终审' : '系统预填好认得出的项，停在提交前，你在页面上检查后自己提交'}` : '',
        (a.waiting_login || []).length ? `${a.waiting_login.map(name).join('、')} 要你先登录${(res.open || []).length ? '（下面有登录页）' : ''}，登录好我接着投，不用再说「投」` : '',
        skipped.length ? `${skipped.map(([n]) => name(n)).join('、')} 这次没排上，原因写在那一行` : '',
      ].filter(Boolean);
      return { text: parts.length ? `好，${parts.join('；')}。` : backend || '这次没有可排队的编号。', to: null, per, ok: true };
    }
    return say(`好，${who ? who + ' ' : '拟投清单里的'}我排进投递队列了。系统预填好认得出的项，停在提交前，你在页面上检查后自己提交。`, '排队预填 · 填好你在页面上提交');
  }
  if (cmd.verb === 'send') return say(`收到，我核对 ${who || '这封'} 的草稿后发出，发完从已发送里对账。`, '发送中');
  if (cmd.verb === 'cancel') return say(`好，${who || '这封'} 不发了。`, '不发了');
  if (cmd.verb === 'revise') return say(`好，我照你说的改${who ? ' ' + who : ''}${note ? '：' + cut(note, 60) : ''}。改好重新给你看。`, '改稿中');
  if (cmd.verb === 'feedback') {
    if (/^pass$/i.test(word)) return say(`好，${who} 不再推进${note ? `（${cut(note, 40)}）` : ''}。`, '已排除');
    // 联系、跟进排给了即时执行器（res.run_now）就照实这么说；没排上的等下一轮定时任务起草（09-30 真实测试）。
    if (word === '联系' || word === '跟进') {
      const what = `${who} 的${word === '联系' ? '首联' : '跟进'}`, tail = '写好先给你看，你批准了才发。';
      return say(res.run_now ? `${word === '联系' ? '收到' : '好'}，${what}已经排给本机 AI 去写，${tail}` : `记下了，${what}在下一轮定时任务里起草，${tail}`, word === '联系' ? '准备首联' : '准备跟进');
    }
    if (word === '备注') return say(`记下了 ${who} 的备注。`, '已记备注');
  }
  if (cmd.verb === 'schedule') return say(`记下了：${who} 面试 ${note}。我会准备材料，面试前提醒你。`, `面试 ${note}`);
  if (cmd.verb === 'snooze') return say(`好，${who} ${word === '暂停提醒' ? '先不提醒了' : word === '恢复提醒' ? '恢复提醒了' : word.replace(/提醒$/, '') + '再提醒你'}。`, word);
  if (cmd.verb === 'archive') return say(`好，${who} 归档了，它的待办和提醒都结束了。`, '已归档');
  if (cmd.verb === 'reopen') return say(backend && /不用重新打开/.test(backend) ? backend : `好，${who} 重新打开了，回到在推进的线索里。`, '重新打开');
  if (cmd.kind === 'brief') return say(`这是 ${who} 的详情。`);
  // 手上有别的在跑：排上了（lib/crew-desk.mjs runOrQueue），说排上了、跑完自动接着跑；同一项已经在跑就说在跑。
  if (cmd.kind === 'op' && res.op?.queued) return say(`好，「${res.op.label || cmd.op}」${res.op.dup ? '已经排着了，' : ''}${QUEUED_LINE}${res.op.ahead ? `（前面还有 ${res.op.ahead} 个）` : ''}。`);
  if (cmd.kind === 'op' && res.already) return say(`「${res.op?.label || cmd.op}」正在跑。`);
  if (cmd.kind === 'op') return say(`好，我开始跑「${res.op?.label || cmd.op}」了。`);
  // 暂停 / 恢复一位成员（lib/command-center.mjs agentAction 的回执本来就是一句完整的话）。
  // 指挥台回执里的「点 ⋯ 恢复」是给老的团队条写的；在对话里说一句就能恢复。
  if (cmd.kind === 'agent') return say(backend.replace(/^(.+?) 暂停了([\s\S]*?)点 ⋯ 恢复/, (all, who, mid) => `${who} 暂停了${mid}说「恢复 ${who}」`).replace(/^(.+?) 暂停了([\s\S]*?)；恢复后继续定时工作/, (all, who, mid) => `${who} 暂停了${mid}，说「恢复 ${who}」就接着做`) || (cmd.verb === 'pause' ? '好，我先停下。' : '好，我接着做。'), cmd.verb === 'pause' ? '已暂停' : '已恢复');
  // 我的待办、进展、重点、清单、刷卡、面试完成、复盘……：后台脚本那句本来就是回答。
  return say(backend || '好，记下了。');
}
