#!/bin/bash
# P3: Codex on Commissary through the profile's provider and the key helper. A tool turn (a patch, a shell command,
# reasoning) per model. Runs inside the probe container (./run.sh bash /probe/p3.sh <model>…).
set -uo pipefail
export CODEX_HOME=/var/lib/t3flare/codex-home CODEX_SQLITE_HOME=/var/lib/t3flare/codex-sqlite
mkdir -p "$CODEX_HOME" "$CODEX_SQLITE_HOME" /workspace/sessions
ln -sfn /workspace/sessions "$CODEX_HOME/sessions"
mkdir -p /w/p3 && cd /w/p3 && git init -q 2>/dev/null && git config user.email p@p && git config user.name p
. /probe/codex-profile.sh
for model in "$@"; do
  LOG=/out/p3-$model.jsonl node /probe/codex-rpc.mjs "$(jq -nc --arg m "$model" '{model:$m, cwd:"/w/p3", prompt:"Use apply_patch to create notes-\($m).txt containing the word kiwi. Then run the shell command `cat notes-\($m).txt`. Then reply with the single word done.", threadParams:{approvalPolicy:"never", sandbox:"danger-full-access"}, timeoutMs:240000}')" -- "${CODEX_PROFILE[@]}" |
    jq -c --arg m "$model" '{model:$m, turnStatus, threadId, items, errors, approvals:(.approvals|length), agentText, ms, stderr:(.stderr[-600:])}'
done
ls -la /w/p3
find /workspace/sessions -type f | head
