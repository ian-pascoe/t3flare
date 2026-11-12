# M0's local probe image (step 4a): the two CLIs at the plan's pins on the host's architecture, with bubblewrap and the
# tools the probes use. Not the Workspace image (that is apps/sandbox-image/image/Dockerfile, amd64).
FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.167.2
ARG PI_VERSION=1.5.2
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl jq bubblewrap procps git sqlite3 python3 dnsutils socat \
 && rm -rf /var/lib/apt/lists/*
RUN arch=$(uname -m) \
 && curl -fsSL -o /tmp/codex.tgz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${arch}-unknown-linux-musl.tar.gz" \
 && mkdir -p /opt/t3flare/bin && tar -xzf /tmp/codex.tgz -C /tmp && mv /tmp/codex-${arch}-unknown-linux-musl /opt/t3flare/bin/codex \
 && chmod 755 /opt/t3flare/bin/codex && rm /tmp/codex.tgz
RUN mkdir -p /opt/t3flare/pi && cd /opt/t3flare/pi \
 && npm init -y >/dev/null && npm install --omit=dev --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
 && printf '#!/bin/sh\nexec node /opt/t3flare/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js "$@"\n' > /opt/t3flare/bin/pi \
 && chmod 755 /opt/t3flare/bin/pi
ENV PATH=/opt/t3flare/bin:${PATH}
