#!/bin/bash
# P1 first look: initialize and session/new under the managed profile, no prompt.
set -uo pipefail
. /probe/claude-profile.sh
mkdir -p /w/p1 && cd /w/p1 && git init -q 2>/dev/null
LOG=/out/p1-hello.jsonl node /probe/acp-client.mjs '{"cwd":"/w/p1","protocolVersion":1,"steps":[],"timeoutMs":60000}' -- claude-agent-acp
