#!/bin/bash
# P8 (changelog F9): session/fork on both agents: fork after a turn, then the fork recalls the parent's context and the
# parent does not see the fork's.
set -uo pipefail
mkdir -p /w/p8 && cd /w/p8 && git init -q
export CLAUDE_AVAILABLE_MODELS='["claude-haiku-5-5"]'
CLAUDE_NONCE=n . /probe/claude-profile.sh
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=n
M='{"setConfig":{"configId":"model","value":"claude-haiku-5-5"}}'
s='[{"prompt":"Remember the code word FIG-3. Reply ok."},{"fork":true},{"prompt":"Remember a second code word PLUM-9. What were the code words so far? Reply with them only."}]'
LOG=/out/p8-claude.jsonl node /probe/acp-client.mjs '{"cwd":"/w/p8","protocolVersion":'"${PV:-1}"',"steps":['"$M"','"${s:1}"',"timeoutMs":180000}' -- claude-agent-acp | jq -c '{agent:"claude", prompts:[.prompts[]|{fork,error,keys,stop:.stopReason,text:(.text//""|.[-60:])}], sid:.session.sessionId}'
LOG=/out/p8-opencode.jsonl node /probe/acp-client.mjs '{"cwd":"/w/p8","protocolVersion":'"${PV:-1}"',"steps":'"$s"',"timeoutMs":180000}' -- opencode acp | jq -c '{agent:"opencode", prompts:[.prompts[]|{fork,error,keys,stop:.stopReason,text:(.text//""|.[-60:])}], sid:.session.sessionId}'
ls $CLAUDE_HOME/projects/*/ 2>/dev/null
