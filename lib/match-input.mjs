// 在调用模型前一次性读取判断输入；恢复时用同一构造器核对，不能给旧输出补绑定。
import { read, optionalText, hash } from './store.mjs';
import { readFacts, FACTS_HEALTH } from './facts.mjs';
import { loadPreferences, promptSnippet } from './preferences.mjs';
import { matchPrompt } from './match-prompt.mjs';
import { TZ } from './tz.mjs';

export function matchInput(lead, { leads = null, now = Date.now() } = {}) {
  const facts = readFacts();
  if (facts[FACTS_HEALTH]?.state !== 'ok') throw Error('match_facts_unavailable');
  const preferences = loadPreferences(), profile = optionalText('candidate/profile.md'), resume = optionalText('candidate/resume.tex');
  const promptFacts = structuredClone(facts);
  promptFacts.standard_answers = { languages: facts.standard_answers?.languages };
  for (const key of ['identity', 'communication', 'outreach']) delete promptFacts[key];
  if (promptFacts.location) delete promptFacts.location.relocation_cities;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(now)).replaceAll('-', '');
  const context = `Current date: ${day}\n${profile}\n${JSON.stringify(promptFacts)}\nResume:\n${resume || '(no resume text on file; use the facts above)'}`;
  const preferenceHistory = promptSnippet({ leads, prefs: preferences, now });
  const prompt = matchPrompt(lead, { context, preferenceHistory, facts }), schema = read('config/match-schema.json');
  // 完整 JD 单独绑定：多岗位帖子即使只有一段入 prompt，其余正文变动也不能复用。
  const identity = { version: 1, captured_at: new Date(now).toISOString(), lead_id: lead.record_id || lead.id,
    jd_sha256: hash(String(lead.jd_text || '')), facts_sha256: hash(facts), profile_sha256: hash(profile), resume_sha256: hash(resume),
    preferences_sha256: hash(preferences), history_sha256: hash(preferenceHistory), prompt_sha256: hash(prompt), schema_sha256: hash(schema) };
  return { prompt, schema, facts, preferencesVersion: preferences.version, identity };
}
