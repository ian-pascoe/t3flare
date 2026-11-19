#!/bin/bash
set -uo pipefail
. /probe/opencode-profile.sh
# plant an invalid policy statement and an unknown key
jq '.policies += [{"action":"tool.use","resource":"shell:*","effect":"maybe"}] | .bogusKey = 1' /etc/opencode/opencode.json > /tmp/c && mv /tmp/c /etc/opencode/opencode.json
export T3FLARE_MODEL_KEY_NONCE=n
mkdir -p /w/p2 && cd /w/p2 && git init -q
node /probe/acp-client.mjs '{"cwd":"/w/p2","steps":[{"prompt":"Reply pong."}],"timeoutMs":60000}' -- opencode acp | jq -c '{end:.end, p:.prompts, stderr:.stderr[-500:]}'
ls -R $XDG_DATA_HOME/opencode/log | head; grep -h -i "warn\|invalid\|drop\|policy\|bogus" $XDG_DATA_HOME/opencode/log/* | cut -c1-400 | head -20
