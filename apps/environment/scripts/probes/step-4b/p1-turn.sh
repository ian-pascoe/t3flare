#!/bin/bash
# P1: a tool turn per model through claude-agent-acp and the managed profile. Writes the summary per model.
set -uo pipefail
export CLAUDE_AVAILABLE_MODELS='["claude-sonnet-5-5","claude-haiku-5-5","gpt-6-luna","gemini-3-flash","gemini-3.5-flash","gemini-3.8-flash","deepseek-v4-pro","gemini-3.7-flash"]'
CLAUDE_NONCE=nonce-p1 . /probe/claude-profile.sh
export T3FLARE_EXEC=p1-marker
/probe/procwatch.sh /out/p1-proc.jsonl & watch=$!
mkdir -p /w/p1 && cd /w/p1 && git init -q 2>/dev/null
for model in "$@"; do
  sc=$(jq -nc --arg m "$model" '{cwd:"/w/p1", steps:[{setConfig:{configId:"model", value:$m}}, {prompt:"Use your Edit/Write tool to create notes-\($m).txt containing the word kiwi. Then run the bash command `cat notes-\($m).txt; env | grep -c T3FLARE_MODEL_KEY_NONCE; echo nonce-seen=$(env | grep -c T3FLARE_MODEL_KEY_NONCE)`. Then reply with the single word done."}], permission:"allow", timeoutMs:300000}')
  LOG=/out/p1-$model.jsonl node /probe/acp-client.mjs "$sc" -- claude-agent-acp > /out/p1-$model.json
  jq -c --arg m "$model" '{model:$m, end:.end, prompts, permissions:[.permissions[]|{kind,title,options,answered}], tools:[.tools[]|{kind,title,status}], auth:.authenticateCalls, errors, ms}' /out/p1-$model.json
done
kill $watch
sleep 2; cd /w/p1 && git status --porcelain --ignored | head -40; find /w/p1 -maxdepth 2 -not -path "*/.git/*" -printf "%s %p\n" | head -40
