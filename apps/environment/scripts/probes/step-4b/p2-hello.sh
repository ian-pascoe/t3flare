#!/bin/bash
set -uo pipefail
OC_NONCE=nonce-p2
. /probe/opencode-profile.sh
export T3FLARE_MODEL_KEY_NONCE=$OC_NONCE T3FLARE_EXEC=p2-marker
mkdir -p /w/p2 && cd /w/p2 && git init -q
opencode debug paths 2>&1 | head; opencode debug config 2>&1 | head -30
LOG=/out/p2-hello.jsonl node /probe/acp-client.mjs '{"cwd":"/w/p2","steps":[{"prompt":"Reply with the single word pong."}],"timeoutMs":120000}' -- opencode acp > /out/p2-hello.json
jq -c '{end:.end, errors, init:.initialize|{protocolVersion, authMethods:[.authMethods[]?.id], caps:.agentCapabilities|tostring|.[0:400]}, modes:.session.modes, models:(.session.models|{currentModelId, ids:[.availableModels[]?.modelId]}), config:[.session.configOptions[]?|{id,currentValue,options:[.options[]?.value]}], prompts, stderr:.stderr[-1500:]}' /out/p2-hello.json
ps -eo pid,ppid,args | grep -v "ps -eo" | head
