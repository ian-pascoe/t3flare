#!/bin/bash
# Samples every process's environ and cmdline once a second: which processes carry the launcher's marker, the nonce,
# or a canary. Names only, never values. Writes one JSON line per new (pid, finding) to $1.
out=$1; seen=""
while true; do
  for d in /proc/[0-9]*; do
    p=${d#/proc/}; [ "$p" = "$$" ] && continue
    cmd=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null | cut -c1-120); [ -z "$cmd" ] && continue
    env=$(tr '\0' '\n' <"$d/environ" 2>/dev/null)
    m=$(grep -c '^T3FLARE_EXEC=' <<<"$env"); n=$(grep -c '^T3FLARE_MODEL_KEY_NONCE=' <<<"$env"); c=$(grep -c 'CANARY' <<<"$env")
    key="$p:$m$n$c"; case " $seen " in *" $key "*) continue;; esac; seen="$seen $key"
    jq -nc --arg pid "$p" --arg cmd "$cmd" --argjson marker "$m" --argjson nonce "$n" --argjson canary "$c" --arg names "$(cut -d= -f1 <<<"$env" | sort | tr '\n' ' ')" '{pid:$pid,cmd:$cmd,marker:$marker,nonce:$nonce,canary:$canary,envNames:$names}' >>"$out"
  done
  sleep 1
done
