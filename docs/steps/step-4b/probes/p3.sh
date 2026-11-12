#!/bin/bash
# P3: what each CLI contacts, with defaults and then with the profile. Run on the internal network (PROBE_INTERNAL=1):
# the only way out is the CONNECT logger at computer.internal:3128, which logs every host. In the profile run the proxy
# variables are not pinned empty (they are the only route out here; in a Container egress is computer's).
set -uo pipefail
export HTTPS_PROXY=http://computer.internal:3128 HTTP_PROXY=http://computer.internal:3128 NO_PROXY=computer.internal NODE_USE_ENV_PROXY=1
mark() { curl -s "http://computer.internal/mark/$1" >/dev/null; }
export CLAUDE_AVAILABLE_MODELS='["claude-sonnet-5-5"]' CLAUDE_PINNED_EMPTY='["ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY"]'
mkdir -p /w/p3 && cd /w/p3 && git init -q
cprompt='{"cwd":"/w/p3","steps":[{"setConfig":{"configId":"model","value":"claude-sonnet-5-5"}},{"prompt":"Use the WebFetch tool to fetch https://example.com and tell me its title in three words."}],"permission":"allow","timeoutMs":180000}'
for mode in defaults managed; do
  mark claude-$mode
  CLAUDE_PROFILE_MODE=$mode CLAUDE_NONCE=n . /probe/claude-profile.sh
  [ $mode = defaults ] && unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DISABLE_UPDATES CLAUDE_CODE_MAX_RETRIES
  LOG=/out/p3-claude-$mode.jsonl node /probe/acp-client.mjs "$cprompt" -- claude-agent-acp | jq -c --arg m $mode '{probe:("claude-"+$m), end:.end, stop:[.prompts[]|.stopReason], text:.text[-80:], perms:[.permissions[]|.kind]}'
  sleep 8
done
oprompt='{"cwd":"/w/p3","steps":[{"prompt":"Use your webfetch tool to fetch https://example.com and tell me its title in three words."}],"permission":"allow","timeoutMs":180000}'
for mode in defaults managed; do
  mark opencode-$mode
  OC_PROFILE_MODE=$mode . /probe/opencode-profile.sh
  if [ $mode = defaults ]; then
    unset OPENCODE_DISABLE_AUTOUPDATE OPENCODE_DISABLE_MODELS_FETCH OPENCODE_DISABLE_FREE_MODELS OPENCODE_DISABLE_CLAUDE_CODE OPENCODE_DISABLE_LSP_DOWNLOAD
    jq -n --arg url "$MODEL_PROXY_URL/v1" --argjson models "$OC_MODELS" '{providers:{t3flare:{package:"@opencode/ai/providers/anthropic-compatible",settings:{baseURL:$url},models:$models}}, model:"t3flare/claude-sonnet-5-5", plugins:["/etc/opencode/plugins/t3flare-key"]}' >"$XDG_CONFIG_HOME/opencode/opencode.json" 2>/dev/null || { mkdir -p "$XDG_CONFIG_HOME/opencode"; jq -n --arg url "$MODEL_PROXY_URL/v1" --argjson models "$OC_MODELS" '{providers:{t3flare:{package:"@opencode/ai/providers/anthropic-compatible",settings:{baseURL:$url},models:$models}}, model:"t3flare/claude-sonnet-5-5", plugins:["/etc/opencode/plugins/t3flare-key"]}' >"$XDG_CONFIG_HOME/opencode/opencode.json"; }
  fi
  export T3FLARE_MODEL_KEY_NONCE=n
  LOG=/out/p3-opencode-$mode.jsonl node /probe/acp-client.mjs "$oprompt" -- opencode acp | jq -c --arg m $mode '{probe:("opencode-"+$m), end:.end, stop:[.prompts[]|.stopReason], text:.text[-80:], perms:[.permissions[]|.kind]}'
  sleep 8
done
mark end
