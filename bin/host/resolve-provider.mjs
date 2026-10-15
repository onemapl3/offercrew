// 给 zsh 宿主脚本用：把目录里的供应商 key 解析成环境变量与 codex 参数。
//   eval "$(node bin/host/resolve-provider.mjs <key>)"
// 输出形如：
//   RADAR_KIND=codex_exec; RADAR_CODEX_PROVIDER=openai; RADAR_CODEX_HOME=/abs/path（或空）
//   RADAR_KIND=claude_code; RADAR_CLAUDE_CONFIG_DIR=/abs/path（或空：默认 ~/.claude）——只有登录目录，没有令牌
//   RADAR_KIND=anthropic_http; RADAR_AUTH_FILE=private/claude-api.auth.json
// 找不到的 key 输出 RADAR_KIND=unknown 并退出码 3，脚本据此跳过这一项。
import { loadProviders } from '../../lib/backends.mjs';
import { file } from '../../lib/store.mjs';
import path from 'node:path';
const key = process.argv[2] || '';
const p = loadProviders()[key];
const q = v => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
if (!p) { console.log(`RADAR_KIND=unknown; RADAR_PROVIDER_KEY=${q(key)}`); process.exit(3); }
const abs = v => (v ? (path.isAbsolute(v) ? v : file(v)) : '');
console.log([`RADAR_KIND=${q(p.kind)}`, `RADAR_PROVIDER_KEY=${q(key)}`, `RADAR_CODEX_PROVIDER=${q(p.codex_provider || '')}`, `RADAR_CODEX_HOME=${q(abs(p.codex_home))}`, `RADAR_CLAUDE_CONFIG_DIR=${q(abs(p.config_dir))}`, `RADAR_AUTH_FILE=${q(p.auth_file || '')}`].join('; '));
