#!/bin/bash
# P2's mode matrix (local half): what asks for a patch and for a command under each (approvalPolicy, sandboxPolicy) a
# turn/start can carry, with the process-level defaults the profile sets. Approvals are accepted.
set -uo pipefail
export CODEX_HOME=/var/lib/t3flare/codex-home CODEX_SQLITE_HOME=/var/lib/t3flare/codex-sqlite
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME"
model=${MODEL:-gpt-6-luna}
CODEX_PROFILE_EXTRA=(-c allow_login_shell=false -c 'approval_policy="on-request"' -c 'sandbox_mode="read-only"')
. /probe/codex-profile.sh
case_() { # name approvalPolicy sandboxPolicyJson
  local dir=/w/p2-$1
  mkdir -p "$dir" && cd "$dir" && git init -q
  LOG=/out/p2-$1.jsonl node /probe/codex-rpc.mjs "$(jq -nc --arg m "$model" --arg d "$dir" --arg a "$2" --argjson s "$3" '{model:$m,cwd:$d,prompt:"Use apply_patch to create a.txt containing x. Then run the shell command `touch b.txt && ls`. Reply done.",turnParams:{approvalPolicy:$a,sandboxPolicy:$s},approve:"accept"}')" -- "${CODEX_PROFILE[@]}" |
    jq -c --arg n "$1" '{case:$n, turnStatus, errors:[.errors[]|tostring|.[0:200]], asked:[.approvals[]|.method], items:[.items[]|select(.type=="fileChange" or .type=="commandExecution")|.type+":"+(.status//"")]}'
  echo "{\"case\":\"$1\",\"files\":\"$(ls "$dir" | tr '\n' ' ')\"}"
}
case_ untrusted-readonly untrusted '{"type":"readOnly"}'
case_ onrequest-workspacewrite on-request '{"type":"workspaceWrite"}'
case_ untrusted-fullaccess untrusted '{"type":"dangerFullAccess"}'
case_ never-fullaccess never '{"type":"dangerFullAccess"}'
