#!/bin/bash
set -uo pipefail
OC_NONCE=nonce-p2b
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=$OC_NONCE T3FLARE_EXEC=p2-marker
mkdir -p /w/p2 && cd /w/p2 && git init -q
( sleep 6; ps -eo pid,ppid,args | grep -v "ps -eo" > /out/p2-ps-during.txt ) &
LOG=/out/p2-proc.jsonl node /probe/acp-client.mjs '{"cwd":"/w/p2","steps":[{"sleepMs":4000},{"prompt":"Reply with the single word pong."}],"timeoutMs":120000}' -- opencode acp ${ACP_ARGS:-} | jq -c '{end:.end, prompts:[.prompts[]|.text], err:.errors}'
sleep 1; echo during:; cat /out/p2-ps-during.txt; echo after:; ps -eo pid,ppid,args | grep -v "ps -eo"
