#!/usr/bin/env node
// 周期里 Reacher「准备投递材料」之后的一步：按岗位定制简历（默认关）。现在是 Writer 的一份新版（lib/resume-writer.mjs
// tailorRound → startRewrite({ lead_id })）：以默认投递里和 JD 同语言的那一版为底，对着 JD 和公司调研改写，逐行核对出处。
// 开关关着时 bin/cycle.mjs 不排这一步；手动跑也只回 no_change。打开后：给已批准、还没递出、还没有定制版的岗位
// （符合规则：全部 / 只对英文 / 只对中文）各做一份，每轮最多 3 份，离收尾点不到 90 秒就停。
// 做出来的都停在「等你看」：你在材料页的左右对比里点「用这版」才存成这个岗位的定制版。
import { deadlineNear, arg } from '../lib/store.mjs';
import { loadWorkspace } from '../lib/resume-store.mjs';
import { tailorRound } from '../lib/resume-writer.mjs';
import { budgetGate } from '../lib/spend.mjs';
import { factsBlocker } from '../lib/facts-gate.mjs';

const record = arg('--record', '');
const out = r => { console.log(JSON.stringify(r)); if (record && r.status !== 'ok') process.exitCode = 1; };
const factsBad = factsBlocker();
if (!loadWorkspace().tailoring.enabled) out({ status: 'no_change', reason: 'tailoring_off' });
// 资料文件读坏了、或者引导走完以后不见了：不改写（lib/facts-gate.mjs）。
else if (factsBad) out({ status: 'no_change', reason: `facts_${factsBad.state}`, detail: factsBad.text });
// 今天的花费上限到了（lib/spend.mjs）：不开新的定制，留到明天。周期本来就跳过这一步，这里管手动跑的。
else if (budgetGate('resume-tailor')) out({ status: 'no_change', reason: 'spend_cap' });
// A task card is authorized to prepare this lead's materials, before apply approval.
// It must never fall back to the batch of other approved leads.
else out(await tailorRound({ record: record || null, limit: 3, stop: () => deadlineNear(90000) }));
