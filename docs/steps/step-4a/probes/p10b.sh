#!/bin/bash
# P10, Codex: which features reach github.com and chatgpt.com. Each case starts Codex, runs one turn, and marks.
set -uo pipefail
export HTTPS_PROXY=http://computer.internal:3128 HTTP_PROXY=http://computer.internal:3128 NO_PROXY=computer.internal
mark() { curl -s "http://computer.internal/mark/$1" >/dev/null; }
mkdir -p /w/p10 && cd /w/p10 && git init -q
scenario='{"model":"gpt-6-luna","cwd":"/w/p10","prompt":"Reply with the single word pong.","threadParams":{"approvalPolicy":"never","sandbox":"danger-full-access"},"timeoutMs":120000}'
CODEX_PROFILE_EXTRA=(-c allow_login_shell=false)
. /probe/codex-profile.sh
off() { local a=(); for f in "$@"; do a+=(-c "features.$f=false"); done; printf '%s\n' "${a[@]}"; }
case_() {
  local name=$1; shift
  export CODEX_HOME=/var/lib/t3flare/codex-$name CODEX_SQLITE_HOME=/var/lib/t3flare/sqlite-$name
  mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
  mark "$name"
  LOG=/out/p10b-$name.jsonl node /probe/codex-rpc.mjs "$scenario" -- "${CODEX_PROFILE[@]}" "$@" | jq -c --arg n "$name" '{probe:$n,turnStatus,agent:.agentText[-20:],stderr:.stderr[-200:]}'
  sleep 4
}
mapfile -t plugins < <(off plugins plugin_discovery_prefetch remote_plugin plugin_sharing)
mapfile -t apps < <(off apps tool_suggest skill_mcp_dependency_install)
mapfile -t rest < <(off image_generation browser_use browser_use_external computer_use in_app_browser in_app_chat in_app_updates in_app_voice in_app_dictation in_app_local_automation workspace_dependencies multi_agent goals daemon_auto_start)
case_ plugins-off "${plugins[@]}"
case_ apps-off "${apps[@]}"
case_ all-off "${plugins[@]}" "${apps[@]}" "${rest[@]}" -c analytics.enabled=false
mark end
