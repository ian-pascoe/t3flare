# M0's local probe image (step 4b): Claude Code over claude-agent-acp and OpenCode at the plan's pins, on the host's
# architecture. Not the Workspace image (apps/sandbox-image/image/Dockerfile, amd64).
FROM node:24-bookworm-slim
ARG CLAUDE_ACP_VERSION=0.106.0
ARG OPENCODE_VERSION=2.2.7
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl jq bubblewrap procps git sqlite3 python3 dnsutils socat ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/t3flare/claude && cd /opt/t3flare/claude \
 && npm init -y >/dev/null && npm install --omit=dev --ignore-scripts @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION} \
 && printf '#!/bin/sh\nexec node /opt/t3flare/claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js "$@"\n' > /usr/local/bin/claude-agent-acp \
 && chmod 755 /usr/local/bin/claude-agent-acp
RUN mkdir -p /opt/t3flare/opencode && cd /opt/t3flare/opencode \
 && npm init -y >/dev/null && npm install --omit=dev --ignore-scripts @opencode/cli@${OPENCODE_VERSION} \
 && ls node_modules/@opencode/ && bin=$(ls -d node_modules/@opencode/cli-linux-*/bin/opencode* | grep -v musl | head -1) && ln -s /opt/t3flare/opencode/$bin /usr/local/bin/opencode \
 && opencode --version
ENV PATH=/opt/t3flare/bin:${PATH}
