#!/bin/bash
# F4: how many times one Codex process asks the key helper over two turns (with and without model discovery).
set -uo pipefail
mkdir -p /w/pn && cd /w/pn && git init -q
CODEX_PROFILE_EXTRA=(-c allow_login_shell=false -c features.plugins=false -c features.plugin_discovery_prefetch=false -c features.remote_plugin=false -c features.plugin_sharing=false)
. /probe/codex-profile.sh
for disc in off; do
  export CODEX_HOME=/var/lib/t3flare/c-$disc CODEX_SQLITE_HOME=/var/lib/t3flare/s-$disc T3FLARE_MODEL_KEY_NONCE=nonce-$disc
  mkdir -p $CODEX_HOME $CODEX_SQLITE_HOME
  extra=(); [ $disc = off ] && extra=(-c features.api_key_model_discovery=false)
  LOG=/out/pn-$disc.jsonl node /probe/codex-rpc.mjs '{"model":"gpt-6-luna","cwd":"/w/pn","prompt":"Run `echo a` then `echo b` as two separate shell commands, then reply done.","threadParams":{"approvalPolicy":"never","sandbox":"danger-full-access"},"turns":3}' -- "${CODEX_PROFILE[@]}" "${extra[@]}" | jq -c --arg d $disc '{disc:$d,turnStatus,items:(.items|length)}'
done
