#!/bin/bash
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=n
mkdir -p /w/p2 && cd /w/p2 && git init -q
( sleep 5; echo listen:; awk 'NR>1 && $4=="0A"{print $2}' /proc/net/tcp /proc/net/tcp6 ) &
node /probe/acp-client.mjs '{"cwd":"/w/p2","steps":[{"sleepMs":7000}],"timeoutMs":60000}' -- opencode acp >/dev/null
