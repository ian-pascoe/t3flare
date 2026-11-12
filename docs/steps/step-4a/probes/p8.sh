#!/bin/bash
# P8 (local half): resume after the Container's local state is gone and only the synced sessions remain, and resume
# from a torn last line (a pull that caught a rollout mid-write).
#  Codex: turn 1 (a code word), then a fresh CODEX_HOME and CODEX_SQLITE_HOME with only sessions/ linked back, the
#         rollout's last line cut in half, and thread/resume + turn 2 asking for the word.
#  pi:    the same with a fresh agent dir and `--session <file>`.
set -uo pipefail
synced=/workspace/.t3flare
mkdir -p $synced/codex/sessions $synced/pi/sessions /w/p8 && cd /w/p8 && git init -q
CODEX_PROFILE_EXTRA=(-c allow_login_shell=false -c features.plugins=false -c features.plugin_discovery_prefetch=false -c features.remote_plugin=false -c features.plugin_sharing=false)
. /probe/codex-profile.sh
home() { # fresh Container-local Codex home with sessions/ linked to the synced dir
  rm -rf /var/lib/t3flare/codex-home /var/lib/t3flare/codex-sqlite
  export CODEX_HOME=/var/lib/t3flare/codex-home CODEX_SQLITE_HOME=/var/lib/t3flare/codex-sqlite
  mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
  ln -sfn $synced/codex/sessions "$CODEX_HOME/sessions"
}
full='{"approvalPolicy":"never","sandbox":"danger-full-access"}'
home
first=$(LOG=/out/p8-codex-1.jsonl node /probe/codex-rpc.mjs "$(jq -nc --argjson t "$full" '{model:"gpt-6-luna",cwd:"/w/p8",prompt:"Remember the code word ZEBRA-41. Reply ok.",threadParams:$t}')" -- "${CODEX_PROFILE[@]}")
thread=$(jq -r .threadId <<<"$first")
echo "{\"codexTurn1\":$(jq -c '{turnStatus,threadId}' <<<"$first")}"
rollout=$(find $synced/codex/sessions -name "*$thread*.jsonl")
lines=$(wc -l <"$rollout")
last=$(tail -n 1 "$rollout" | wc -c)
head -c $(($(wc -c <"$rollout") - last / 2)) "$rollout" >"$rollout.tmp" && mv "$rollout.tmp" "$rollout"
echo "{\"codexRollout\":{\"lines\":$lines,\"tornBytes\":$((last / 2))}}"
home
LOG=/out/p8-codex-2.jsonl node /probe/codex-rpc.mjs "$(jq -nc --arg r "$thread" --argjson t "$full" '{model:"gpt-6-luna",cwd:"/w/p8",resume:$r,prompt:"What was the code word? Reply with it only.",threadParams:$t}')" -- "${CODEX_PROFILE[@]}" |
  jq -c '{codexResume:{turnStatus,threadId,errors,agent:.agentText[-60:]}}'
# pi
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 PI_CODING_AGENT_SESSION_DIR=$synced/pi/sessions
pihome() {
  rm -rf /var/lib/t3flare/pi-agent
  export PI_CODING_AGENT_DIR=/var/lib/t3flare/pi-agent
  mkdir -p "$PI_CODING_AGENT_DIR"
  jq -n --arg url "$MODEL_PROXY_URL" '{providers:{anthropic:{baseUrl:$url, apiKey:"!/opt/t3flare/bin/t3flare-model-key pi"}}}' >"$PI_CODING_AGENT_DIR/models.json"
}
pihome
out=$(LOG=/out/p8-pi-1.jsonl node /probe/pi-rpc.mjs '{"commands":[{"type":"prompt","message":"Remember the code word OTTER-77. Reply ok."},{"type":"get_state"}]}' -- --provider anthropic --model claude-haiku-4-5 --no-approve)
file=$(jq -r '.responses[]|select(.command=="get_state")|.data.sessionFile' <<<"$out")
last=$(tail -n 1 "$file" | wc -c)
head -c $(($(wc -c <"$file") - last / 2)) "$file" >"$file.tmp" && mv "$file.tmp" "$file"
echo "{\"piSession\":\"$(basename "$file")\",\"tornBytes\":$((last / 2))}"
pihome
LOG=/out/p8-pi-2.jsonl node /probe/pi-rpc.mjs "$(jq -nc --arg f "$file" '{commands:[{type:"switch_session",sessionPath:$f},{type:"prompt",message:"What was the code word? Reply with it only."},{type:"get_state"}]}')" -- --provider anthropic --model claude-haiku-4-5 --no-approve |
  jq -c '{piResume:{errors,text:.text[-60:],responses:[.responses[]|{command,success,error,data}]}}'
