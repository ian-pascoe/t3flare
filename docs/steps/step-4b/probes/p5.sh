#!/bin/bash
# P5: resume from synced state only, in a fresh Container. Phase 1 (`p5.sh one`): a turn sets a code word; Claude's
# projects/ is linked into the synced directory, OpenCode's database is snapshotted there with VACUUM INTO.
# Phase 2 (`p5.sh two [torn]`), in a new container with fresh homes: session/load from the synced state only.
set -uo pipefail
SYNC=/out/p5-sync; phase=$1; torn=${2:-}
mkdir -p $SYNC/claude/projects $SYNC/opencode /w/p5 && cd /w/p5 && [ -d .git ] || git init -q
export CLAUDE_AVAILABLE_MODELS='["claude-haiku-5-5"]'
CLAUDE_NONCE=n . /probe/claude-profile.sh
ln -sfn $SYNC/claude/projects $CLAUDE_HOME/projects
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=n
M='{"setConfig":{"configId":"model","value":"claude-haiku-5-5"}}'
if [ "$phase" = one ]; then
  node /probe/acp-client.mjs '{"cwd":"/w/p5","steps":['"$M"',{"prompt":"Remember the code word PERSIMMON-42. Reply ok."}],"timeoutMs":120000}' -- claude-agent-acp | jq -r '.session.sessionId' > $SYNC/claude.id
  node /probe/acp-client.mjs '{"cwd":"/w/p5","steps":[{"prompt":"Remember the code word QUINCE-17. Reply ok."}],"timeoutMs":120000}' -- opencode acp | jq -r '.session.sessionId' > $SYNC/opencode.id
  db=$XDG_DATA_HOME/opencode/opencode.db
  rm -f $SYNC/opencode/.opencode.db.tmp; sqlite3 "$db" "VACUUM INTO '$SYNC/opencode/.opencode.db.tmp'" && mv $SYNC/opencode/.opencode.db.tmp $SYNC/opencode/opencode.db
  ls -la $db* $SYNC/opencode; find $SYNC/claude -type f | head; cat $SYNC/*.id
else
  if [ "$torn" = torn ]; then f=$(find $SYNC/claude/projects -name '*.jsonl' | head -1); n=$(tail -1 "$f" | wc -c); truncate -s -$((n/2)) "$f"; echo torn $f by $((n/2)); fi
  mkdir -p $XDG_DATA_HOME/opencode && cp $SYNC/opencode/opencode.db $XDG_DATA_HOME/opencode/opencode.db
  for how in load resume; do
    sc=$(jq -nc --arg id "$(cat $SYNC/claude.id)" --arg how $how --argjson m "$M" '{cwd:"/w/p5", ($how):$id, steps:[$m,{prompt:"What was the code word? Reply with it only."}], timeoutMs:120000}')
    LOG=/out/p5-claude-$how$torn.jsonl node /probe/acp-client.mjs "$sc" -- claude-agent-acp | jq -c --arg h "claude-$how$torn" '{case:$h, end:.end, err:.errors, prompts:[.prompts[]|{stop:.stopReason, err:(.error//null|tostring|.[0:200]), text:(.text//""|.[-60:])}]}'
    sc=$(jq -nc --arg id "$(cat $SYNC/opencode.id)" --arg how $how '{cwd:"/w/p5", ($how):$id, steps:[{prompt:"What was the code word? Reply with it only."}], timeoutMs:120000}')
    LOG=/out/p5-opencode-$how.jsonl node /probe/acp-client.mjs "$sc" -- opencode acp | jq -c --arg h "opencode-$how" '{case:$h, end:.end, err:.errors, prompts:[.prompts[]|{stop:.stopReason, err:(.error//null|tostring|.[0:200]), text:(.text//""|.[-60:])}]}'
  done
fi
