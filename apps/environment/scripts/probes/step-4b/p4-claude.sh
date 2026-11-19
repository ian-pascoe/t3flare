#!/bin/bash
# P4 (CLI half): Claude Code under the managed profile, in the hostile repo: what it asks, plan mode and ExitPlanMode,
# /goal and /compact. Answers per case; every request is recorded. Markers and the logging host are checked after.
set -uo pipefail
export CLAUDE_AVAILABLE_MODELS='["claude-sonnet-5-5","claude-haiku-5-5"]'
CLAUDE_NONCE=nonce-p4 . /probe/claude-profile.sh
export T3FLARE_EXEC=p4-marker
/probe/hostile-repo.sh /w/h >/dev/null
cd /w/h
run() { # name scenario-json
  LOG=/out/p4c-$1.jsonl node /probe/acp-client.mjs "$2" -- claude-agent-acp > /out/p4c-$1.json
  jq -c --arg n "$1" '{case:$n, end:.end, modes:.session.modes.availableModes|map(.id), cur:.session.modes.currentModeId, prompts:[.prompts[]|{r:(.result//null|tostring|.[0:80]), stop:.stopReason, err:(.error//null|tostring|.[0:160]), text:(.text//""|.[-160:])}], perms:[.permissions[]|{kind,title:.title[0:60],plan:(.plan//null|tostring|.[0:60]),options,answered}], modeUpdates, tools:[.tools[]|.kind+":"+(.status//"")+":"+(.title//"")[0:50]]}' /out/p4c-$1.json
}
M='{"setConfig":{"configId":"model","value":"claude-sonnet-5-5"}}'
run hostile-default '{"cwd":"/w/h","steps":['"$M"',{"prompt":"Do these in order: 1) create a.txt containing x with your Write tool; 2) run `bash test.sh` and `touch b.txt`; 3) ask the helper subagent to create c.txt containing y; 4) use the s skill. Then reply done."}],"permission":"allow","timeoutMs":300000}'
run plan-reject '{"cwd":"/w/h","steps":['"$M"',{"setMode":"plan"},{"prompt":"Add a file d.txt containing z. Plan it briefly (one step), then call ExitPlanMode with the plan."}],"permission":{"switch_mode":"reject","default":"allow"},"timeoutMs":300000}'
run plan-accept '{"cwd":"/w/h","steps":['"$M"',{"setMode":"plan"},{"prompt":"Add a file e.txt containing z. Plan it briefly (one step), then call ExitPlanMode with the plan."}],"permission":{"switch_mode":"allow","default":"reject"},"timeoutMs":300000}'
run enter-plan '{"cwd":"/w/h","steps":['"$M"',{"prompt":"Call the EnterPlanMode tool now, then reply ok."}],"permission":"allow","timeoutMs":180000}'
run goal-compact '{"cwd":"/w/h","steps":['"$M"',{"prompt":"Reply with the word one."},{"prompt":"/goal make the README say hi"},{"prompt":"/compact"}],"permission":"reject","timeoutMs":300000}'
echo markers: $(ls /w/marker-* 2>/dev/null); ls /w/h; cat /w/h/.claude/settings.local.json; git -C /w/h status --porcelain
