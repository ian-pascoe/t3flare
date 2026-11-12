#!/bin/bash
# Starts the probe network: `keyhost` (computer.internal + a CONNECT logger at keyhost:3128) with the model key in its
# environment only, read from ~/.config/t3flare/dev.env by bash as the repo's stage.ts does, never printed.
# Then runs "$@" in a probe container on the same network with MODEL_PROXY_URL and /out mounted.
#   OUT=<dir> ./run.sh <command…>        (keyhost stays up; ./run.sh --down removes it)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${OUT:-$here/../out}
mkdir -p "$out"
if [ "${1:-}" = "--down" ]; then docker rm -f t3flare-keyhost4b >/dev/null 2>&1 || true; docker network rm t3flare-probe4b t3flare-probe4b-int >/dev/null 2>&1 || true; exit 0; fi
docker network inspect t3flare-probe4b >/dev/null 2>&1 || docker network create t3flare-probe4b >/dev/null
if ! docker inspect t3flare-keyhost4b >/dev/null 2>&1; then
  ( set -a; . "$HOME/.config/t3flare/dev.env"; set +a
    PROBE_MODEL_KEY="$COMMISSARY_CONTAINER_API_KEY" docker run -d --name t3flare-keyhost4b --network t3flare-probe4b \
      --network-alias computer.internal -e PROBE_MODEL_KEY -v "$here:/probe:ro" node:24-bookworm-slim node /probe/keyhost.mjs >/dev/null )
fi
net=t3flare-probe4b
if [ -n "${PROBE_INTERNAL:-}" ]; then
  # A network with no route out: the CLI reaches only keyhost (the egress host and the CONNECT logger).
  docker network inspect t3flare-probe4b-int >/dev/null 2>&1 || docker network create --internal t3flare-probe4b-int >/dev/null
  docker network connect --alias computer.internal t3flare-probe4b-int t3flare-keyhost4b 2>/dev/null || true
  net=t3flare-probe4b-int
fi
url=$( set -a; . "$HOME/.config/t3flare/dev.env"; set +a; printf %s "$MODEL_PROXY_URL" )
exec docker run --rm -i --network "$net" -e MODEL_PROXY_URL="$url" ${PROBE_DOCKER_ARGS:-} \
  -v "$here:/probe:ro" -v "$out:/out" -v "$here/t3flare-model-key:/opt/t3flare/bin/t3flare-model-key:ro" \
  t3flare-probe4b "$@"
