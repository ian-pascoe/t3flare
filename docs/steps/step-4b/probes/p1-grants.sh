#!/bin/bash
# P1: helper runs per process: one process, two prompts with a model switch between them.
set -uo pipefail
export CLAUDE_AVAILABLE_MODELS='["claude-sonnet-5-5","claude-haiku-5-5"]'
CLAUDE_NONCE=nonce-grants . /probe/claude-profile.sh
mkdir -p /w/pg && cd /w/pg && git init -q
LOG=/out/p1-grants.jsonl node /probe/acp-client.mjs '{"cwd":"/w/pg","steps":[{"setConfig":{"configId":"model","value":"claude-sonnet-5-5"}},{"prompt":"Reply with the single word one."},{"setConfig":{"configId":"model","value":"claude-haiku-5-5"}},{"prompt":"Reply with the single word two."}],"timeoutMs":120000}' -- claude-agent-acp | jq -c '{end:.end, prompts:[.prompts[]|{result:(.result|tostring), stopReason, text}]}'
