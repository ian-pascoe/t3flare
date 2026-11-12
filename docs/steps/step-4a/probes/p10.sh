#!/bin/bash
# P10: what each CLI contacts, first with its defaults, then with the profile's settings. Run on the internal network
# (PROBE_INTERNAL=1): the only way out is the CONNECT logger at computer.internal:3128, which logs every host.
set -uo pipefail
export HTTPS_PROXY=http://computer.internal:3128 HTTP_PROXY=http://computer.internal:3128 NO_PROXY=computer.internal NODE_USE_ENV_PROXY=1
mark() { curl -s "http://computer.internal/mark/$1" >/dev/null; }
mkdir -p /w/p10 && cd /w/p10 && git init -q
export CODEX_HOME=/var/lib/t3flare/codex-home CODEX_SQLITE_HOME=/var/lib/t3flare/codex-sqlite
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
scenario='{"model":"gpt-6-luna","cwd":"/w/p10","prompt":"Reply with the single word pong.","threadParams":{"approvalPolicy":"never","sandbox":"danger-full-access"},"timeoutMs":120000}'
. /probe/codex-profile.sh
mark codex-defaults
LOG=/out/p10-codex-defaults.jsonl node /probe/codex-rpc.mjs "$scenario" -- "${CODEX_PROFILE[@]:0:4}" | jq -c '{probe:"codex-defaults",turnStatus,agent:.agentText[-40:]}'
sleep 5
mark codex-profile
LOG=/out/p10-codex-profile.jsonl node /probe/codex-rpc.mjs "$scenario" -- "${CODEX_PROFILE[@]}" -c allow_login_shell=false -c analytics.enabled=false -c feedback.enabled=false | jq -c '{probe:"codex-profile",turnStatus,agent:.agentText[-40:],stderr:.stderr[-300:]}'
sleep 5
export PI_CODING_AGENT_DIR=/var/lib/t3flare/pi-agent PI_CODING_AGENT_SESSION_DIR=/workspace/pi-sessions
mkdir -p "$PI_CODING_AGENT_DIR"
jq -n --arg url "$MODEL_PROXY_URL" '{providers:{anthropic:{baseUrl:$url, apiKey:"!/opt/t3flare/bin/t3flare-model-key pi"}}}' >"$PI_CODING_AGENT_DIR/models.json"
pis='{"commands":[{"type":"prompt","message":"Reply with the single word pong."}],"timeoutMs":120000}'
mark pi-defaults
LOG=/out/p10-pi-defaults.jsonl node /probe/pi-rpc.mjs "$pis" -- --provider anthropic --model claude-haiku-4-5 | jq -c '{probe:"pi-defaults",errors,text:.text[-40:]}'
sleep 5
mark pi-profile
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 LOG=/out/p10-pi-profile.jsonl node /probe/pi-rpc.mjs "$pis" -- --provider anthropic --model claude-haiku-4-5 --no-approve | jq -c '{probe:"pi-profile",errors,text:.text[-40:]}'
sleep 5
mark end
