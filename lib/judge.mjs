// The one door to Jev (TypeSafe System One).
//
// Jev does not write text. It answers typed questions about a `state`: a
// Choice picks one of the options we name, a Noul says how likely a statement
// holds, a Score places the state on ordered levels. Every question in one
// request is evaluated in parallel over the same state. Code owns everything
// else: which candidates the model may choose from, what a probability means,
// and what happens next.
//
// This module only knows how to call the API, retry, keep evidence and account
// for usage. The question sets live in lib/judgements.mjs. Tests inject a
// driver with `setJudgeDriver` and never touch the network.
import { read, write, today, hash } from './store.mjs';
import { sandboxed, sandboxModels, sandboxError, modelCall } from './sandbox.mjs';
import { recordUsage } from './usage.mjs';
// 离线判断（lib/judge-offline.mjs）：RADAR_JUDGE=offline 或 config/judge.json "driver": "offline" 时用规则代替 Jev，
// 不联网、不写判断缓存（缓存里只放 Jev 的真答案，免得以后配了 Jev 还读到规则的答案）。
import { offlineAnswers, offlineWanted, offlineSupports } from './judge-offline.mjs';
import { noteSwallowed } from './swallow.mjs';
import { textJudgeAvailable, textJudge } from './judge-text.mjs';

export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const noul = (instructions, criteria = { true: 'The statement holds.', false: 'The statement does not hold.' }) => ({ type: 'noul', instructions, criteria });
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

export const DEFAULT_CONFIG = {
  enabled: true, model: 'jev-latest', timeout_ms: 45000, max_retries: 3, concurrency: 6, cache: true, max_state_chars: 60000,
  thresholds: { prefilter_choice: 0.7, match_status: 0.6, critical: 0.6, recommend_fit: 2, mail_kind: 0.7, mail_code: 0.85, intent_verb: 0.75, intent_send_verbs_confirm_only: true, referral: 0.7, contact_email: 0.7 },
};
export const loadJudgeConfig = () => {
  const c = read('config/judge.json', {});
  return { ...DEFAULT_CONFIG, ...c, thresholds: { ...DEFAULT_CONFIG.thresholds, ...(c.thresholds || {}) } };
};
export const threshold = (name) => loadJudgeConfig().thresholds[name];
const loadAuth = () => read('private/typesafe.auth.json', null);
// offlineOk：只有判断岗位（bin/judge-leads.mjs）认离线规则；分邮件、听指令这些调用方看的还是有没有 Jev。
export const judgeAvailable = ({ offlineOk = false, textOk = false, role = 'quill' } = {}) => !!driver || (offlineOk && offlineWanted(loadJudgeConfig())) || (loadJudgeConfig().enabled && !!loadAuth()?.api_key) || (textOk && textJudgeAvailable({ role }));

let driver = null;
// 判断岗位这一步走的是离线规则（没有测试驱动、打开了离线）：不调用模型，花费上限不拦它（lib/spend.mjs stageHeld）。
export const judgeOffline = () => !driver && offlineWanted(loadJudgeConfig());
// Tests and dry runs: `fn({model, state, questions}) -> {answers, usage?, model?}`.
export function setJudgeDriver(fn) { driver = fn; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callApi(body, conf) {
  // 演示 / 沙盒模式：岗位和简历不发给 Jev；立刻失败，不重试（lib/sandbox.mjs）。
  // 开了 RADAR_SANDBOX_MODELS=1：照常问 Jev（要这个目录里有 Jev 的凭据），这一次请求在 modelCall 里放行。
  if (sandboxed() && !sandboxModels()) throw sandboxError('Jev 判断（api.typesafe.ai）', { actor: 'radar' });
  const auth = loadAuth();
  if (!auth?.api_key) throw Error('typesafe_credentials_missing');
  const url = auth.base_url || 'https://api.typesafe.ai/v1/systemone';
  let last;
  for (let attempt = 0; attempt <= conf.max_retries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    let r;
    try {
      r = await modelCall(() => fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(conf.timeout_ms),
      }));
    } catch (e) { last = Error(`jev_transport: ${e.message}`); continue; }
    if (r.ok) return r.json();
    const text = (await r.text().catch(() => '')).slice(0, 300); // 兜底：错误的正文读不出就只报状态码
    last = Error(`jev_http_${r.status}: ${text}`);
    // 4xx other than rate limiting is our mistake; retrying will not fix it.
    if (r.status < 500 && r.status !== 429) throw last;
  }
  throw last;
}

// Strings inside the state are bounded so a runaway JD cannot exceed the
// context. Truncation is visible in the evidence file.
function bound(value, max) {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…[truncated]' : value;
  if (Array.isArray(value)) return value.map((v) => bound(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bound(v, max)]));
  return value;
}

let usageChain = Promise.resolve();
function accountUsage(row) {
  usageChain = usageChain.then(() => {
    const p = `runs/${today()}/usage.json`;
    write(p, [...read(p, []), row]);
  }).catch(e => noteSwallowed('judge.usage', e, { member: 'lens', doing: '记判断服务的用量', then: '这一次的用量没记上' }));
  return usageChain;
}

// Ask Jev. `request_id` names the evidence file; `state` and `questions` are
// exactly what the API receives. Identical requests are served from the cache
// under state/judge-cache so a re-run never pays twice for the same judgement.
// `meta` ({ member, step, lead_id }) goes into the usage ledger (lib/usage.mjs); without it the
// ledger reads the member and step off the request id (posting- / match- / mail- …).
export async function judge(request_id, state, questions, { persist = true, cache = undefined, meta = {}, textOk = false } = {}) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(request_id) || request_id.includes('..')) throw Error('invalid_request_id');
  if (!questions || !Object.keys(questions).length) throw Error('no_questions');
  const conf = loadJudgeConfig();
  const body = { model: conf.model, state: bound(state, conf.max_state_chars), questions };
  const offline = !driver && offlineWanted(conf) && offlineSupports(body);
  const text = !driver && !offline && textOk && (!conf.enabled || !loadAuth()?.api_key) && textJudgeAvailable({ role: meta.member || 'quill' });
  if (!driver && !conf.enabled && !offline && !text) throw Error('judge_disabled');
  const useCache = (cache ?? conf.cache) && !driver && !offline && !text;
  const key = hash([body.model, body.state, body.questions]).slice(0, 40);
  const cachePath = `state/judge-cache/${key}.json`;
  if (useCache) {
    const hit = read(cachePath, null);
    if (hit?.answers) return { ...hit, request_id, cached: true };
  }
  const started = Date.now();
  const at = new Date().toISOString();
  const evidence = `runs/${today()}/judgements/${request_id}.json`;
  try {
    const raw = driver ? await driver(body) : offline ? offlineAnswers(body) : text ? await textJudge(request_id, body.state, questions, { meta, persist }) : await callApi(body, conf);
    if (!raw?.answers) throw Error('jev_answers_missing');
    const result = { request_id, model: raw.model || body.model, ...(text ? { driver: 'text' } : {}), answers: raw.answers, usage: raw.usage || null, duration_ms: Date.now() - started, at, cached: false };
    if (persist) {
      write(evidence, { ...result, state: body.state, questions });
      if (!text) await accountUsage({ request_id, at, driver: offline ? 'offline' : 'jev', model: result.model, status: 'completed', duration_ms: result.duration_ms, usage: result.usage });
      // 离线判断是规则，不是模型调用：不花 token，不进用量账（lib/usage.mjs）。
      if (!offline && !text) recordUsage({ at, request_id, ...meta, backend: 'jev', provider: 'typesafe', model: result.model, usage: result.usage, duration_ms: result.duration_ms, status: 'ok' });
    }
    if (useCache) write(cachePath, result);
    return result;
  } catch (e) {
    if (persist) {
      write(evidence, { request_id, at, status: 'failed', error: String(e.message).slice(0, 300), questions: Object.keys(questions) });
      if (!text) await accountUsage({ request_id, at, driver: 'jev', model: body.model, status: 'failed', duration_ms: Date.now() - started, error: String(e.message).slice(0, 200) });
      if (e.code !== 'ESANDBOX' && !offline && !text) recordUsage({ at, request_id, ...meta, backend: 'jev', provider: 'typesafe', model: body.model, duration_ms: Date.now() - started, status: 'failed' });
    }
    throw e;
  }
}

// Run `fn(item)` over many items with bounded concurrency. Failures are
// returned, not thrown, so one bad lead never stops a batch.
export async function judgeMany(items, fn, { concurrency = loadJudgeConfig().concurrency } = {}) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { out[i] = { ok: false, error: String(e.message || e).slice(0, 300) }; }
    }
  }));
  return out;
}

// Reading answers. A Choice below its confidence floor is `null`: "the model
// could not tell" is an answer code has to handle, never a default it should
// guess. A Noul is a probability; `yes` applies the floor the caller names.
export const pick = (answer, floor = 0) => (answer && answer.type === 'choice' && (answer.confidence ?? 0) >= floor ? answer.choice : null);
export const prob = (answer, option) => (answer?.probabilities?.[option] ?? 0);
export const yes = (answer, floor = 0.5) => !!answer && answer.type === 'noul' && answer.noul >= floor;
export const level = (answer) => (answer && answer.type === 'score' ? answer.score : null);
