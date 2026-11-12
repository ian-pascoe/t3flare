#!/bin/bash
# P7: RSS of each CLI process during a turn that installs and tests a small Node project, sampled every 500 ms; and
# the time from spawn to session/new answered.
set -uo pipefail
mkdir -p /w/p7 && cd /w/p7 && git init -q
cat > package.json <<'J'
{"name":"p7","version":"1.0.0","scripts":{"test":"node -e \"console.log('tests ok')\""},"dependencies":{"left-pad":"1.3.0"}}
J
npm install --package-lock-only --ignore-scripts >/dev/null 2>&1
export CLAUDE_AVAILABLE_MODELS='["claude-sonnet-5-5"]'
CLAUDE_NONCE=n . /probe/claude-profile.sh
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=n
sample() { while :; do for p in $(pgrep -f 'claude-agent-acp|claude-agent-sdk-linux|opencode'); do echo "$(date +%s%N | cut -c1-13) $p $(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null) $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -c1-200)"; done; sleep 0.5; done; }
sample > /out/p7-rss.txt & s=$!
P='{"prompt":"Run `npm ci && npm test` and reply with the test output."}'
node /probe/acp-client.mjs '{"cwd":"/w/p7","steps":[{"setConfig":{"configId":"model","value":"claude-sonnet-5-5"}},'"$P"'],"permission":"allow","timeoutMs":300000}' -- claude-agent-acp | jq -c '{agent:"claude", sessionNewMs:(.session|length), text:.text[-60:], ms}'
node /probe/acp-client.mjs '{"cwd":"/w/p7","steps":['"$P"'],"permission":"allow","timeoutMs":300000}' -- opencode acp | jq -c '{agent:"opencode", text:.text[-60:], ms}'
kill $s
for pat in 'claude-agent-acp' 'claude-agent-sdk-linux' 'opencode acp' 'opencode serve'; do awk -v p="$pat" 'index($0,p){if($3>m)m=$3}END{printf "%s peakRSS=%d MiB\n", p, m/1024}' /out/p7-rss.txt; done
grep -h '"t":' /out/p7-*.jsonl 2>/dev/null | head -0
df -h / /out | tail -2
