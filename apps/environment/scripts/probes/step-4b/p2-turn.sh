#!/bin/bash
# P2: a tool turn per model through opencode acp and the system configuration.
set -uo pipefail
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=nonce-p2 T3FLARE_EXEC=p2-marker
/probe/procwatch.sh /out/p2-proc.jsonl & watch=$!
mkdir -p /w/p2 && cd /w/p2 && git init -q
for model in "$@"; do
  sc=$(jq -nc --arg m "$model" '{cwd:"/w/p2", steps:[{setConfig:{configId:"model", value:"t3flare/\($m)"}}, {prompt:"Use your edit or write tool to create notes-\($m).txt containing the word kiwi. Then run the shell command `touch ran-\($m).txt; echo nonce-seen=$(env | grep -c T3FLARE_MODEL_KEY_NONCE)`. Then reply with the single word done."}], permission:"allow", timeoutMs:300000}')
  LOG=/out/p2-$model.jsonl node /probe/acp-client.mjs "$sc" -- opencode acp > /out/p2-$model.json
  jq -c --arg m "$model" '{model:$m, end:.end, set:(.prompts[0].result|tostring|.[0:200]), stop:.prompts[1].stopReason, err:(.prompts[1].error|tostring|.[0:200]), text:(.prompts[1].text//""|.[-120:]), perms:[.permissions[]|{kind,title,options,answered}], tools:[.tools[]|.kind+":"+(.status//"")]}' /out/p2-$model.json
done
kill $watch; ls /w/p2
grep -rl "nonce-p2" /var/lib/t3flare/opencode-home /w/p2 2>/dev/null | head; echo key-in-files: $(grep -rlF "$(/opt/t3flare/bin/t3flare-model-key scan 2>/dev/null | head -c 20)" /var/lib/t3flare/opencode-home /w/p2 /tmp 2>/dev/null | head -5)
