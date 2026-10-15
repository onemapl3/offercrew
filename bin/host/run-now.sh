#!/bin/zsh
# 指挥室的即时执行器：常驻服务去抖 60 秒后拉起一次模型代理，处理 host-jobs 队列
# 和已排队的自动投递，结果由它回到对应消息的话题里。
#
# Routes are tried in order (config/host.json):
#   executor=claude  Claude `models` via `claude_provider` (config/providers.json), then the
#                    Codex routes. A Claude run that exits nonzero or reports "blocked" > 0 gets
#                    one Codex pass over what is left (finished jobs are already marked done).
#   executor=codex   the Codex routes; only when every one of them dies of a provider failure
#                    (quota, 429/401/403/5xx, stream errors, idle watchdog, missing binary) do
#                    the Claude models take over. Claude has no Gmail connector (NO_GMAIL below).
# Codex routes = codex_models.fallback, then each codex_models.chain entry whose provider+model
# was not tried yet. Any other nonzero exit ends the run with that code, so work is never re-run
# by a second model. Every attempt runs in its own process group under a watchdog: idle_minutes
# (default 8) without log progress, or the rest of the timeout_minutes budget (default 25, under
# lib/run-now.mjs's 30-minute kill), stops the group with TERM, then KILL after 10 s.
# Test hooks: RADAR_ROOT, RADAR_PATH, RADAR_CLAUDE_BIN, RADAR_CODEX_BIN, RADAR_IDLE_SECONDS,
# RADAR_TIMEOUT_SECONDS.
export PATH="${RADAR_PATH:-$HOME/.local/bin:$HOME/.nvm/versions/node/v22.21.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH}"
# 提示词模板里的 {{ROOT}} / {{HOME}} / {{MAILBOX}} / {{EMAIL}} 由 render-prompt.mjs 填上（lib/prompt.mjs）；
# 它跑不起来就原样给出模板，执行器至少还有指令。渲染器按本脚本所在目录找（cd 之前记下）。
PROMPT_RENDER=${0:A:h}/render-prompt.mjs
SANDBOX_SKIP=${0:A:h}/sandbox-skip.mjs
RECORD_USAGE=${0:A:h}/record-usage.mjs
# 代码守卫（bin/host/code-guard.mjs）：执行器跑之前记下代码的样子，跑完对一遍；改了就存档、还原、告诉用户（09-30 负责人：执行器可以执行代码，不能改代码）。
CODE_GUARD=${0:A:h}/code-guard.mjs
# 出错就停的闸停下时记一条事件（bin/host/host-event.mjs）。
HOST_EVENT=${0:A:h}/host-event.mjs
# 资料关卡（lib/facts-gate.mjs 的命令行入口）：资料挡住时记事件、以 78 退出。
FACTS_GATE=${0:A:h:h:h}/lib/facts-gate.mjs
# 执行器自己报的错（bin/host/executor-errors.mjs，兜底清单 E02）：是不是供应商故障只看这些行，命令和网页的输出不算。
EXECUTOR_ERRORS=${0:A:h}/executor-errors.mjs
RECORD_RUNTIME=${0:A:h}/record-runtime.mjs
prompt_text() { node "$PROMPT_RENDER" "$1" "$PWD" 2>/dev/null || cat "$1"; }
cd "${RADAR_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}" || exit 1
# 演示 / 沙盒模式（与 lib/sandbox.mjs 同一规则）：不拉起 Codex / Claude，队列原样留着，只在运行日志里记一行。
if [[ ${(L)RADAR_SANDBOX} == (1|true|yes|on) || -f state/sandbox.json ]]; then node "$SANDBOX_SKIP" system "即时执行器（bin/host/run-now.sh：Codex / Claude）" 2>/dev/null; exit 0; fi
# Only the machine named in config/host.json run_host runs the radar; a synced
# copy on another Mac must not push, poll or apply in parallel. Tests set RADAR_ROOT.
if [[ -z "${RADAR_ROOT:-}" ]]; then
  # 与工作台同一判断（lib/run-host.mjs hostGate；换 Wi-Fi 时 hostname 会变成 DHCP 名字，LocalHostName 不会）。
  # 别的机器：照旧安静退出。host.json 读不了、读坏了（或判断本身跑不起来）：不开工，记一条 fail 事件（兜底清单 I05）。
  host_why=$(node --input-type=module -e 'import {hostGate} from "./lib/run-host.mjs"; const g = hostGate(); if (!g.ok) { console.log(g.why); process.exit(g.other ? 3 : 4); }' 2>&1); host_rc=$?
  if (( host_rc == 3 )); then print -r -- "OfferCrew disabled on $(hostname): $host_why" >&2; exit 0; fi
  if (( host_rc != 0 )); then print -r -- "OfferCrew stopped on $(hostname): ${host_why:-the run_host check could not run}" >&2; node "$HOST_EVENT" run-host fail "${host_why:-run_host 的检查跑不起来，先不开工}（${0:t}）" 2>/dev/null; exit 78; fi
fi
# 一次只跑一个：上一轮还没结束就直接退出，队列留到下一次去抖窗口。
# 互斥靠 pid 文件（claude -p 的参数是提示词正文、codex 从 stdin 读，进程名里都没有提示词文件名）。
PIDFILE=state/run-now.pid
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then exit 75; fi
# 退出时留下 {pid, code, at}：工作台若在本轮中途重启，新服务靠它区分"正常跑完"和"被杀"（lib/run-now.mjs reconcileRunNow）。
# 代码守卫出错就停（兜底清单 E06）：快照没记成，下面不拉起执行器；核对的结果和出错原因写进 run.log（出错时守卫自己记 fail 事件）。
GUARD_OK=0
print -r -- $$ > "$PIDFILE"; trap 'rc=$?; (( GUARD_OK )) && { guard_out=$(node "$CODE_GUARD" check "run-now-$$" 2>&1) || print -r -- "[$(date "+%F %T")] run-now code guard: $guard_out" >> "${D:-runs}/run.log"; }; rm -f "$PIDFILE"; printf "{\"pid\":%d,\"code\":%d,\"at\":\"%s\"}\n" $$ $rc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > state/run-now-exit.json 2>/dev/null' EXIT
# The service stops an overdue run with SIGTERM to this process group: zsh waits until the
# watchdog has torn the attempt's own group down, then leaves through the EXIT trap above.
trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP
# 退出（任何一条路，包括被停下）时上面的 EXIT 先让代码守卫核对，再放开锁。
guard_out=$(node "$CODE_GUARD" snapshot "run-now-$$" 2>&1) && GUARD_OK=1
# 本地时区：config/host.json timezone，没写或认不出就是 Asia/Shanghai（与 lib/tz.mjs 同一规则）。
RADAR_TZ=$(node -e "let z='';try{z=String(require('./config/host.json').timezone||'').trim();new Intl.DateTimeFormat('en-US',{timeZone:z});}catch{z='';}console.log(z||'Asia/Shanghai')" 2>/dev/null); RADAR_TZ=${RADAR_TZ:-Asia/Shanghai}
D=runs/$(TZ=$RADAR_TZ date +%Y%m%d)/run-now; mkdir -p "$D"
T=$(date +%H%M%S)
note() { print -r -- "[$(date '+%F %T')] run-now $*" >> "$D/run.log"; }
if (( ! GUARD_OK )); then note "code guard snapshot failed (${guard_out//$'\n'/ }): executor not started"; exit 70; fi
# 资料关卡（lib/facts-gate.mjs）：资料读坏了、或者引导走完以后找不到，执行器不拉起（提示词里的 {{MAILBOX}} 这些填不上）。
# 挡住了：它自己记一条 skip 事件（横条已经在说，不进告警），以 78 退出。关卡本身跑不起来：同样不开工，记 fail 事件（和 I05 一样）。
facts_why=$(node "$FACTS_GATE" run-now 2>&1); facts_rc=$?
if (( facts_rc == 78 )); then note "facts: ${facts_why//$'\n'/ }: executor not started"; exit 78; fi
if (( facts_rc != 0 )); then
  note "facts check could not run (${facts_why//$'\n'/ }): executor not started"
  node "$HOST_EVENT" facts fail "资料检查跑不起来，这一次没有拉起执行器（${0:t}）" 2>/dev/null
  exit 78
fi
# 执行器的权限（10-02 负责人：Mac 版打开执行器时不给全部权限；和 bin/host/radar-cycle.sh 同一套约定）。RADAR_EXECUTOR_SANDBOX
# 只认 read-only / workspace-write：Codex 换成 --sandbox <值>；Claude 换成 --permission-mode（workspace-write → acceptEdits：
# 工作目录里的文件能改，命令一律不放，-p 里碰到要批准的就拒绝；read-only → plan：只读）。没设就照旧全权限（负责人本机的
# 正式系统）。认不出的值（拼错之类）不当没设：这一次不拉起执行器，记一行、记一条事件（兜底清单 E05：写错的档位不能悄悄变成全权限）。
CODEX_PERM=(--dangerously-bypass-approvals-and-sandbox) CLAUDE_PERM=(--dangerously-skip-permissions)
case "${RADAR_EXECUTOR_SANDBOX:-}" in
  '') ;;
  read-only) CODEX_PERM=(--sandbox read-only) CLAUDE_PERM=(--permission-mode plan) ;;
  # workspace-write 默认断网（10-02 实测：codex sandbox -P :workspace 里 node fetch 报 ENOTFOUND、curl 000；开了网络才 200，
  # 工作目录外照样写不了）。周期里抓网页、调模型都要网：只开网络，写入仍只限工作目录。
  workspace-write) CODEX_PERM=(--sandbox workspace-write -c sandbox_workspace_write.network_access=true) CLAUDE_PERM=(--permission-mode acceptEdits) ;;
  *) note "executor sandbox \"$RADAR_EXECUTOR_SANDBOX\" not recognised (only read-only / workspace-write): executor not started"
     node "$HOST_EVENT" executor-sandbox fail "执行器的权限档「$RADAR_EXECUTOR_SANDBOX」认不出来（只认 read-only、workspace-write），这一次没有拉起执行器" 2>/dev/null
     exit 78 ;;
esac
# 受限档用谁的登录：RADAR_EXECUTOR_OWN_LOGIN=1（R23，10-11 负责人：直接用这台电脑上登录好的 Claude Code / Codex）时，
# 照常用各自的登录，权限照旧受限。没带它（旧的「App 自己的账号」那条路）：Codex 一律用传进来的 CODEX_HOME，供应商有另一个
# 登录目录、或者没传 CODEX_HOME 的那一条跳过；Claude 的每一条都跳过。每次跳过记一行。
RESTRICTED=0; [[ "${CODEX_PERM[1]}" == --sandbox && "${RADAR_EXECUTOR_OWN_LOGIN:-}" != 1 ]] && RESTRICTED=1
APP_CODEX_HOME=${CODEX_HOME:-}
restricted_codex_ok() {
  if [[ -z "$APP_CODEX_HOME" ]]; then note "$1 skipped (restricted: no CODEX_HOME passed in; the user's ~/.codex is not used)"; return 1; fi
  if [[ -n "$2" && "${2:A}" != "${APP_CODEX_HOME:A}" ]]; then note "$1 skipped (restricted: its login directory is not the CODEX_HOME passed in)"; return 1; fi
  return 0
}

# config/host.json in one read; the inline values are the defaults if node itself fails.
EXECUTOR=codex; CLAUDE_PROVIDER=claude_gateway; MODELS=(claude-fable-5-1); MAX_TURNS=60; IDLE_S=480; BUDGET_S=1500
AUTH_STYLE=bearer; HOST_AUTH=private/claude-api.auth.json; CX_PROV=(''); CX_MODEL=(''); CX_EFFORT=('')
eval "$(node --input-type=commonjs -e '
let c = {}; try { c = require("./config/host.json"); } catch {}
const Q = "\x27", q = v => Q + String(v ?? "").split(Q).join(Q + "\\" + Q + Q) + Q, env = process.env;
const pos = (v, d) => (Number(v) > 0 ? Number(v) : d), cm = c.codex_models || {}, seen = new Set(), cx = [];
for (const r of [cm.fallback, ...(Array.isArray(cm.chain) ? cm.chain : [])]) {
  const k = r && typeof r === "object" ? (r.provider || "") + "/" + (r.model || "") : null;
  if (k !== null && !seen.has(k)) { seen.add(k); cx.push(r); }
}
if (!cx.length) cx.push({});
const models = Array.isArray(c.models) ? c.models : ["claude-fable-5-1"];
console.log(["EXECUTOR=" + q(c.executor || "codex"), "CLAUDE_PROVIDER=" + q(c.claude_provider || "claude_gateway"),
  "MODELS=(" + models.map(m => q(m)).join(" ") + ")", "MAX_TURNS=" + q(c.max_turns || 60),
  "IDLE_S=" + Math.max(1, Math.round(pos(env.RADAR_IDLE_SECONDS, pos(c.idle_minutes, 8) * 60))),
  "BUDGET_S=" + Math.max(1, Math.round(pos(env.RADAR_TIMEOUT_SECONDS, pos(c.timeout_minutes, 25) * 60))),
  "AUTH_STYLE=" + q(c.auth_style || "bearer"), "HOST_AUTH=" + q(c.auth_file || "private/claude-api.auth.json"),
  "CX_PROV=(" + cx.map(r => q(r.provider)).join(" ") + ")", "CX_MODEL=(" + cx.map(r => q(r.model)).join(" ") + ")",
  "CX_EFFORT=(" + cx.map(r => q(r.effort)).join(" ") + ")"].join("\n"));
' 2>/dev/null)"

# 自动检测后选择的本机运行时：沿用 CLI 自己的登录和模型，旧 App provider/模型链不覆盖它。
# 只跑选中的一种；不能在额度失败后偷偷换到另一种身份。
if [[ "${RADAR_EXECUTOR_OWN_LOGIN:-}" == 1 ]]; then
  CLAUDE_PROVIDER=local; MODELS=(default); CX_PROV=(''); CX_MODEL=(''); CX_EFFORT=('')
fi

# Watchdog: runs <bin> <args...> in its own process group with stdio inherited (the attempt
# log). Log growth is progress, except retry chatter (Claude api_retry events, Codex
# reconnects): a 429 retry storm counts as idle. Exit: the child's code; 124 budget used up;
# 125 idle; 127 binary missing; a TERM/INT/HUP to the wrapper stops the group within 5 s.
# Sleep is detected from late polls (see below), so a run is not killed as idle or over budget
# right after the lid opens.
WATCHDOG='
const fs = require("node:fs"), { spawn } = require("node:child_process"), os = require("node:os");
const log = process.env.RADAR_WATCH_LOG, idle = Number(process.env.RADAR_WATCH_IDLE) || 480, budget = Number(process.env.RADAR_WATCH_BUDGET) || 0;
const chatter = /"subtype":"api_retry"|Reconnecting\.\.\.|retrying \d+\/\d+/;
const sizeOf = () => { try { return fs.statSync(log).size; } catch { return -1; } };
let off = Math.max(0, sizeOf()), seen = off, last = performance.now(), stopping = false;
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit", detached: true });
const group = s => { try { process.kill(-child.pid, s); return true; } catch (e) { return e.code === "EPERM"; } };
function stop(code, why, grace = 10000) {
  if (stopping) return;
  stopping = true; clearInterval(poll); clearTimeout(cap);
  console.error("[radar-watchdog] " + why + "; stopping process group " + child.pid);
  group("SIGTERM");
  const t0 = performance.now(), wait = setInterval(() => {
    if (group(0) && performance.now() - t0 < grace) return;
    clearInterval(wait); group("SIGKILL"); process.exit(code);
  }, 200);
}
function progressed() {
  const size = sizeOf();
  if (size <= seen) return false;
  seen = size;
  if (size - off > 65536) { off = size; return true; }
  const buf = Buffer.alloc(size - off), fd = fs.openSync(log, "r");
  try { fs.readSync(fd, buf, 0, buf.length, off); } finally { fs.closeSync(fd); }
  const cut = buf.lastIndexOf(10);
  if (cut < 0) return true;
  off += cut + 1;
  return buf.subarray(0, cut).toString().split("\n").some(s => s.trim() && !chatter.test(s));
}
// performance.now() and timers keep running while the Mac sleeps (node 25 on macOS), so a poll
// that arrives far later than its interval means the Mac slept: that time is neither idle nor
// budget (2026-09-23: runs started in 2-second DarkWakes were stopped as idle on the next wake).
const every = Math.min(15000, Math.max(200, idle * 250));
let tick = performance.now(), awake = 0;
const poll = setInterval(() => {
  const t = performance.now(), dt = t - tick; tick = t;
  if (dt > every + 60000) last += dt - every; else awake += dt;
  if (progressed()) last = t;
  else if (t - last >= idle * 1000) stop(125, "no progress for " + idle + "s");
  if (budget > 0 && awake >= budget * 1000) stop(124, "time budget of " + budget + "s used up");
}, every);
const cap = null;
for (const [s, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) process.on(s, () => stop(code, s, 5000));
child.on("error", e => { console.error(e.message); process.exit(e.code === "ENOENT" ? 127 : 126); });
child.on("exit", (code, sig) => { if (!stopping) process.exit(code ?? 128 + (os.constants.signals[sig] || 15)); });
'
# Claude stream-json log -> final `result` text into <last.md> (exit 2 when there is none).
# Prints the error surface for the provider-failure check: stderr / watchdog lines, a
# trailing api_retry error and an error result.
CLAUDE_RESULT='
const fs = require("node:fs"), rest = [];
let res = null, retry = "";
for (const s of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!s.trim()) continue;
  let e; try { e = JSON.parse(s); } catch { rest.push(s); continue; }
  if (e.type === "result") res = e;
  else if (e.type === "system" && e.subtype === "api_retry") retry = "api_retry status=" + e.error_status + " " + (typeof e.error === "string" ? e.error : JSON.stringify(e.error ?? ""));
  else retry = "";
}
const ok = !!res && typeof res.result === "string";
if (ok) fs.writeFileSync(process.argv[2], res.result);
console.log([...rest.slice(-20), retry, res && (res.is_error || res.subtype !== "success") ? res.subtype + " " + (res.result || "") : ""].filter(Boolean).join("\n"));
process.exit(ok ? 0 : 2);
'
PROVIDER_FAILURE='usage limit|rate.?limit|too many requests|\b429\b|\b401\b|\b403\b|unauthori[sz]ed|quota|exceeded retry|stream (error|disconnected)|error sending request|api.?error|not available|not supported|model_not_found|\b50[234]\b|\b529\b|overloaded|no available accounts|upstream|connection error|invalid api key|please run /login|not logged in|token has expired|credit balance'
# Claude Code has no Gmail connector (codex_apps/gmail.* exists only in Codex).
# 本轮不碰邮箱（RADAR_EXECUTOR_NO_MAIL=1，10-02 负责人：邮件连接器跟着 ChatGPT 账号走、不跟登录目录走，开关一开周期就会去读
# 用户自己的 Gmail）：提示词末尾加这一段，写法照 NO_GMAIL。
NO_MAIL_NOTE=
[[ ${(L)RADAR_EXECUTOR_NO_MAIL:-} == (1|true|yes|on) ]] && NO_MAIL_NOTE=$'\n\n'"【执行器说明】本轮不碰邮箱：不读、不搜、不用任何邮件连接器（Gmail 或别的邮箱）。凡是要读写邮箱的待办（核对收件箱与发送回执、建/改/回读草稿、发送已授权草稿、对账）一律保持 pending，在对应 job 的 result 里写明「本轮不碰邮箱」；不要改 state/host-connector.json，绝不能推进其中的 checked_at。其余待办照常完成。"
NO_GMAIL="本执行器没有 Gmail 连接器：凡是要读写 Gmail 的 job（读收件箱或发送回执、建/改/回读草稿、发送已授权草稿、对账）一律保持 pending，在它的 result 里写明「需要 Codex 执行器（Gmail 连接器）」，并计入收尾 JSON 的 blocked；不要改 state/host-connector.json，绝不能推进其中的 checked_at。其余任务照常处理。"

# 用量账（lib/usage.mjs）：每次尝试跑完，按这次的日志记一笔（Codex 会话的总用量、本周额度；Claude 的 result）。出错不影响执行器。
record_usage() { node "$RECORD_USAGE" --launcher run-now "$@" >/dev/null 2>&1; }
# supervise <log> <seconds left> <bin> <args...>; stdin comes from the caller.
supervise() {
  local log=$1 left=$2; shift 2
  RADAR_WATCH_LOG="$log" RADAR_WATCH_IDLE="$IDLE_S" RADAR_WATCH_BUDGET="$left" node --input-type=commonjs -e "$WATCHDOG" "$@" > "$log" 2>&1
}
# classify <rc> <error surface> -> A_FAIL: provider-failure reason (next route), or empty.
# A_WHY: the reason in words for the fallback record (lib/fallback.mjs classifies it); for a provider failure the line that matched.
classify() {
  A_WHY=
  case $1 in
    0) A_FAIL= ;;
    124) A_FAIL=budget A_WHY="time budget used up (timeout)" ;;
    125) A_FAIL=idle A_WHY="no progress for ${IDLE_S}s (timeout)" ;;
    126|127) A_FAIL=missing A_WHY="executable not found (exit $1)" ;;
    *) if A_WHY=$(print -r -- "$2" | grep -m1 -iE "$PROVIDER_FAILURE"); then A_FAIL=provider; else A_FAIL= A_WHY=; fi ;;
  esac
}
# 换了路线（兜底清单 E02 / N07）：记进统一的「换了」记录（lib/fallback.mjs noteFallback，经 bin/host/host-event.mjs）。
# 在下一条路线真的跑起来以后记（跳过的不算换）。
note_fallback() { [[ -n "$FB_FROM" ]] || return 0; node "$HOST_EVENT" --fallback executor "$FB_FROM" "$1" "$FB_WHY" 2>/dev/null; FB_FROM= FB_WHY=; }
# Claude Code 走哪个供应商由 config/host.json 的 claude_provider 决定（目录见 config/providers.json）：
#   anthropic_http → 网关：独立配置目录（没有 claude.ai 登录），用 ANTHROPIC_* 环境变量
#   claude_code    → 官方订阅：该账号目录（默认 ~/.claude）里 Claude Code 自己的登录（用户自己跑
#                    claude auth login）；不设网关变量，也不带任何令牌。没登录时 claude -p 报
#                    "Please run /login"，算供应商故障，Codex 接手
# Resolved once, on the first Claude route; the variables are exported per attempt.
claude_ready() {
  if [[ "${RADAR_EXECUTOR_OWN_LOGIN:-}" == 1 ]]; then CL_KIND=local_cli; return 0; fi
  if [[ -n "$CL_KIND" ]]; then [[ "$CL_KIND" == claude_code || "$CL_KIND" == anthropic_http ]]; return; fi
  eval "$(node bin/host/resolve-provider.mjs "$CLAUDE_PROVIDER")"
  CL_KIND=$RADAR_KIND
  if [[ "$CL_KIND" == claude_code ]]; then
    CL_CONFIG_DIR=$RADAR_CLAUDE_CONFIG_DIR
    note "claude provider=$CLAUDE_PROVIDER (official subscription, config_dir=${CL_CONFIG_DIR:-default})"
  elif [[ "$CL_KIND" == anthropic_http ]]; then
    local auth=${RADAR_AUTH_FILE:-$HOST_AUTH}
    if [[ ! -f "$auth" ]]; then note "claude provider=$CLAUDE_PROVIDER auth file $auth missing; claude routes skipped"; CL_KIND=no_auth; return 1; fi
    { read -r CL_BASE_URL; read -r CL_TOKEN; } < <(node -e "const a=require(require('path').resolve(process.argv[1]));console.log(a.base_url||'');console.log(a.auth_token||'')" "$auth")
    note "claude provider=$CLAUDE_PROVIDER (gateway $CL_BASE_URL)"
  else
    note "claude provider=$CLAUDE_PROVIDER is not a Claude provider (kind=$CL_KIND); claude routes skipped"; return 1
  fi
}
# claude_attempt <model> <seconds left>: sets A_RC, A_FAIL, A_SKIP, BLOCKED.
claude_attempt() {
  local model=$1 log="$D/log-$T-$1.jsonl" surface got model_args=()
  [[ "$model" != default ]] && model_args=(--model "$model")
  if (( RESTRICTED )); then note "claude route $model skipped (restricted: it would use the user's own Claude login)"; A_SKIP=1; return; fi
  claude_ready || { A_SKIP=1; return; }
  (
    unset CLAUDECODE
    if [[ "$CL_KIND" == claude_code ]]; then
      unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
      if [[ -n "$CL_CONFIG_DIR" ]]; then export CLAUDE_CONFIG_DIR="$CL_CONFIG_DIR"; else unset CLAUDE_CONFIG_DIR; fi
    elif [[ "$CL_KIND" == anthropic_http ]]; then
      export CLAUDE_CONFIG_DIR="$PWD/private/claude-config" ANTHROPIC_BASE_URL="$CL_BASE_URL"
      if [[ "$AUTH_STYLE" == "bearer" ]]; then export ANTHROPIC_AUTH_TOKEN="$CL_TOKEN"; unset ANTHROPIC_API_KEY; else export ANTHROPIC_API_KEY="$CL_TOKEN"; unset ANTHROPIC_AUTH_TOKEN; fi
    fi
    supervise "$log" "$2" "${RADAR_CLAUDE_BIN:-claude}" -p "${model_args[@]}" "${CLAUDE_PERM[@]}" --max-turns "$MAX_TURNS" \
      --output-format stream-json --verbose \
      --append-system-prompt "你在 $PWD 里运行，是 OfferCrew 的即时执行器。严格按用户消息里的步骤做，少调用工具。$NO_GMAIL" \
      "$(prompt_text config/run-now-prompt.md)$NO_MAIL_NOTE" < /dev/null
  )
  A_RC=$?
  node "$RECORD_RUNTIME" claude "$A_RC" "$log" "$$" || note "Claude Code result could not be recorded"
  surface=$(node --input-type=commonjs -e "$CLAUDE_RESULT" "$log" "$D/last-$T.md" 2>&1); got=$?
  BLOCKED=; (( got == 0 )) && BLOCKED=$(grep -oE '"blocked"\s*:\s*[0-9]+' "$D/last-$T.md" | tail -1 | grep -oE '[0-9]+$')
  classify $A_RC "$surface"
  note "executor=claude model=$model exit=$A_RC${A_FAIL:+ reason=$A_FAIL}"
  record_usage --kind claude --log "$log" --provider "$CLAUDE_PROVIDER" --backend "$CL_KIND"
}
# codex_attempt <route index> <seconds left>: sets A_RC, A_FAIL, A_SKIP.
# 供应商 key → 那份 config.toml 里的 id 与登录目录（多账号）。
codex_attempt() {
  local prov=${CX_PROV[$1]} model=${CX_MODEL[$1]} effort=${CX_EFFORT[$1]} args=() log
  if [[ -n "$prov" ]]; then
    eval "$(node bin/host/resolve-provider.mjs "$prov")"
    if [[ "$RADAR_KIND" != "codex_exec" ]]; then note "codex route provider=$prov skipped (kind=$RADAR_KIND)"; A_SKIP=1; return; fi
    [[ -n "$RADAR_CODEX_PROVIDER" ]] && args+=(-c "model_provider=$RADAR_CODEX_PROVIDER")
  fi
  if (( RESTRICTED )) && ! restricted_codex_ok "codex route provider=${prov:-default}" "${prov:+$RADAR_CODEX_HOME}"; then A_SKIP=1; return; fi
  [[ -n "$effort" ]] && args+=(-c "model_reasoning_effort=$effort")
  [[ -n "$model" && "$model" != default ]] && args+=(--model "$model")  # default = codex 自己的默认模型
  log="$D/log-$T-${prov:-codex}-${model:-default}.txt"
  (
    if (( RESTRICTED )); then export CODEX_HOME="$APP_CODEX_HOME"
    elif [[ -n "$prov" ]]; then if [[ -n "$RADAR_CODEX_HOME" ]]; then export CODEX_HOME="$RADAR_CODEX_HOME"; else unset CODEX_HOME; fi; fi
    supervise "$log" "$2" "${RADAR_CODEX_BIN:-codex}" exec "${args[@]}" "${CODEX_PERM[@]}" --skip-git-repo-check \
      -C "$PWD" --output-last-message "$D/last-$T.md" - < <(prompt_text config/run-now-prompt.md; [[ -n "$NO_MAIL_NOTE" ]] && print -rn -- "$NO_MAIL_NOTE")
  )
  A_RC=$?
  node "$RECORD_RUNTIME" codex "$A_RC" "$log" "$$" || note "Codex result could not be recorded"
  classify $A_RC "$(node "$EXECUTOR_ERRORS" codex "$log" 2>/dev/null)"
  note "executor=codex provider=${prov:-default} model=${model:-default} exit=$A_RC${A_FAIL:+ reason=$A_FAIL}"
  record_usage --kind codex --log "$log" --provider "${prov:-}" --codex-home "$( (( RESTRICTED )) && print -r -- "$APP_CODEX_HOME" || print -r -- "${RADAR_CODEX_HOME:-${CODEX_HOME:-}}")"
}

CL_ROUTES=() CX_ROUTES=() SHOWN=()
for m in $MODELS; do CL_ROUTES+=("claude:$m"); done
for (( i=1; i<=${#CX_PROV}; i++ )); do CX_ROUTES+=("codex:$i"); SHOWN+=("codex:${CX_PROV[i]:-default}/${CX_MODEL[i]:-default}"); done
if [[ "${RADAR_EXECUTOR_OWN_LOGIN:-}" == 1 ]]; then
  if [[ "$EXECUTOR" == "claude" ]]; then ROUTES=($CL_ROUTES); SHOWN=($CL_ROUTES); else ROUTES=($CX_ROUTES); fi
elif [[ "$EXECUTOR" == "claude" ]]; then ROUTES=($CL_ROUTES $CX_ROUTES); SHOWN=($CL_ROUTES $SHOWN); else ROUTES=($CX_ROUTES $CL_ROUTES); SHOWN=($SHOWN $CL_ROUTES); fi
note "executor=$EXECUTOR routes: ${SHOWN[*]} (idle ${IDLE_S}s, budget ${BUDGET_S}s)"
rc=1; ran=0; claude_done=0; codex_ran=0; FB_FROM= FB_WHY=
for (( r=1; r<=${#ROUTES}; r++ )); do
  route=${ROUTES[r]} label=${SHOWN[r]} kind=${ROUTES[r]%%:*}
  [[ "$kind" == claude && $claude_done -eq 1 ]] && continue
  left=$(( BUDGET_S - SECONDS ))
  if (( left <= 0 )); then note "time budget ${BUDGET_S}s used up; ${label} not started"; break; fi
  A_SKIP=0; A_FAIL=; BLOCKED=
  if [[ "$kind" == claude ]]; then claude_attempt "${route#claude:}" "$left"; else codex_attempt "${route#codex:}" "$left"; fi
  (( A_SKIP )) && continue
  ran=1; rc=$A_RC; [[ "$kind" == codex ]] && codex_ran=1
  note_fallback "$label"
  if [[ "${RADAR_EXECUTOR_OWN_LOGIN:-}" == 1 ]]; then
    if [[ "$kind" == claude && $rc -eq 0 && "${BLOCKED:-0}" -gt 0 ]]; then note "selected local Claude finished with blocked work"; exit 3; fi
    exit $rc
  fi
  if [[ "$kind" == claude && "$EXECUTOR" == "claude" && -z "$A_FAIL" ]]; then
    # Claude finished. If it failed, or its closing JSON reports blocked work, Codex
    # (stronger at driving the computer) takes one pass over what is left.
    if [[ $rc -eq 0 && "${BLOCKED:-0}" -eq 0 ]]; then exit 0; fi
    note "claude rc=$rc blocked=${BLOCKED:-?}; codex fallback"; claude_done=1
    FB_FROM=$label FB_WHY=$( (( rc != 0 )) && print -r -- "claude exited $rc" || print -r -- "claude reported ${BLOCKED} blocked" ); continue
  fi
  [[ $rc -eq 0 ]] && exit 0
  [[ -z "$A_FAIL" ]] && exit $rc
  note "${label} failed (${A_FAIL}); trying the next route"
  FB_FROM=$label FB_WHY=$A_WHY
done
# Out of routes (or time): the last route that ran decides; nothing ran at all is a failure.
if (( ! ran )); then note "no route could run"; exit 1; fi
# Claude handed work to Codex (blocked / failed) but no Codex route could even start (unknown
# provider, not a codex kind): that is not a success, whatever Claude's own exit code was.
if (( claude_done )) && (( ! codex_ran )); then note "codex fallback unavailable: no runnable codex route (check codex_models.fallback / chain)"; exit 3; fi
note "routes exhausted, exit=$rc"
exit $rc
