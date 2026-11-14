set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq git jq >/dev/null
ls -l /usr/bin/base64 /usr/bin/mktemp | head -2
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p /s && cd /s && git init -q -b main && echo a > a && git add a && git commit -qm a
git clone -q /s /r && cd /r
jq -r .script /tmp/prime.json > /tmp/prime.sh
bash /tmp/prime.sh > /tmp/out.txt
n=$(jq '.argvs|length' /tmp/prime.json)
for i in $(seq 0 $((n-1))); do
  mapfile -t argv < <(jq -r ".argvs[$i][]" /tmp/prime.json)
  direct=$(git "${argv[@]}" 2>/dev/null | base64 -w0; echo " ${PIPESTATUS[0]}")
  line=$(grep "^T3P $i " /tmp/out.txt)
  code=$(echo "$line" | cut -d' ' -f3); b64=$(echo "$line" | cut -d' ' -f4)
  [ "$b64 $code" = "$direct" ] && echo "ok $i ${argv[*]}" || echo "MISMATCH $i ${argv[*]}: [$b64 $code] vs [$direct]"
done
