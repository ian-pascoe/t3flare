# test:docker's image: the Workspace image's CLI layer (apps/sandbox-image/image/Dockerfile, step 4a) on the same Node,
# at the same paths, without computerd and the toolchains. Build context: apps/sandbox-image/image. The ARGs come from
# apps/sandbox-image/src/clis.ts (cli.docker.test.ts passes them). The host's architecture: Codex under amd64 emulation
# on an arm64 host fails to start its commands ("Failed to create unified exec process"), so arm64 gets the arm64 build.
# SPI-1151: Claude Code and OpenCode too (skills.docker.test.ts probes every CLI's skill roots); on arm64, the SDK's
# linux-arm64 `claude` stands at the linux-x64 path the profile names.
FROM node:26.13.0-bookworm-slim
ARG CODEX_VERSION
ARG CODEX_SHA256
ARG CODEX_SHA256_ARM64
ARG OPENCODE_VERSION
ARG OPENCODE_SHA256
ARG OPENCODE_SHA256_ARM64
ARG NODE_VERSION_DIR=/usr/local/share/mise/installs/node/26.13.0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git procps sqlite3 util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p ${NODE_VERSION_DIR}/bin && ln -s /usr/local/bin/node ${NODE_VERSION_DIR}/bin/node \
 && arch=$(uname -m) && sha=$([ "$arch" = aarch64 ] && echo "$CODEX_SHA256_ARM64" || echo "$CODEX_SHA256") \
 && curl -fsSL -o /tmp/codex.tgz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${arch}-unknown-linux-musl.tar.gz \
 && echo "${sha}  /tmp/codex.tgz" | sha256sum -c - \
 && mkdir -p /opt/t3flare/bin && tar -xzf /tmp/codex.tgz -C /tmp \
 && mv /tmp/codex-${arch}-unknown-linux-musl /opt/t3flare/bin/codex && chmod 755 /opt/t3flare/bin/codex && rm /tmp/codex.tgz
COPY cli/package.json cli/package-lock.json /opt/t3flare/pi/
RUN cd /opt/t3flare/pi && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm
COPY --chmod=755 t3flare-pi /opt/t3flare/bin/pi
COPY --chmod=755 t3flare-model-key /opt/t3flare/bin/t3flare-model-key
RUN arch=$([ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64) && sha=$([ "$arch" = arm64 ] && echo "$OPENCODE_SHA256_ARM64" || echo "$OPENCODE_SHA256") \
 && curl -fsSL -o /tmp/opencode.tgz https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${arch}.tar.gz \
 && echo "${sha}  /tmp/opencode.tgz" | sha256sum -c - \
 && mkdir -p /opt/t3flare/opencode && tar -xzf /tmp/opencode.tgz -C /opt/t3flare/opencode && chmod 755 /opt/t3flare/opencode/opencode && rm /tmp/opencode.tgz
COPY claude/package.json claude/package-lock.json /opt/t3flare/claude/
RUN cd /opt/t3flare/claude && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm \
 && sdk=/opt/t3flare/claude/node_modules/@anthropic-ai \
 && if [ ! -x $sdk/claude-agent-sdk-linux-x64/claude ]; then mkdir -p $sdk/claude-agent-sdk-linux-x64 && ln -s $sdk/claude-agent-sdk-linux-arm64/claude $sdk/claude-agent-sdk-linux-x64/claude; fi \
 && test -x $sdk/claude-agent-sdk-linux-x64/claude
COPY --chmod=755 t3flare-claude-agent-acp /opt/t3flare/bin/claude-agent-acp
COPY --chmod=755 t3flare-claude-key /opt/t3flare/bin/t3flare-claude-key
COPY --chmod=755 t3flare-opencode /opt/t3flare/bin/opencode
COPY opencode-key-plugin /opt/t3flare/share/opencode-key-plugin
