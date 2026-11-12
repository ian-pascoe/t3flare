# t3flare's Container image (step 2a; ADR-0015: one image for Durable agents and, later, CLI agents). Copied from
# cloudpid@ae5a7b73:apps/sandbox-image/image/Dockerfile without Docker, the MCP bridge and the file-change signal's helper;
# the supervisor and memory guard keep cloudpid's names.
#
# The Workspace Container's image (docs/architecture/container.md, ADR-0004): Ubuntu 26.04 LTS with fuse3, the
# everyday command-line tools, a C toolchain, Docker, computerd under its supervisor with a memory guard and the MCP bridge, the
# file-change signal's helper, and mise with its installs of the base mise.toml's Toolchains. Every program a project uses is a mise Toolchain; the image's installs are only found by mise for a
# Workspace that asks for those versions. The image is glibc-based because computerd is a glibc Node SEA, and
# linux/amd64 because that is what Cloudflare Containers run.

# Keep in step with the version of @cloudflare/computer the Workspace DO runs (apps/sandbox-image/src/index.test.ts
# fails when they differ): the Workspace and computerd speak a sync protocol that is not stable across releases.
ARG COMPUTERD_VERSION=0.9.0
ARG MISE_VERSION=v2026.11.2
ARG MISE_SHA256=62cad463c1413f05398ca339168a8f655120b6f0b0b8adce3bc6758bafaf0602
# The CLI agents (step 4a; apps/sandbox-image/src/clis.ts holds the same values, apps/environment/test/cliManifest.test.ts keeps them equal).
ARG CODEX_VERSION=0.167.2
ARG CODEX_SHA256=8246e846c550ea21197fcc4067bc270dca895e94ea42ed6a282e6f4e0125b15f
# Step 4b: OpenCode's release binary (one per platform; npm's package installs the musl build beside it, M0 P7).
ARG OPENCODE_VERSION=2.2.7
ARG OPENCODE_SHA256=89a6cee227b54bc011179c528a5e63176032462b1a5e21723b616801cddc2ca7

# Every base image is pinned by digest as well as by tag, so a rebuild cannot move to another computerd build or Ubuntu
# point release. Refresh a digest together with its tag: computerd's is the manifest of
# `ghcr.io/cloudflare/computer-computerd-linux-x64:<COMPUTERD_VERSION>`, Ubuntu's the index of `ubuntu:26.04`.

# A single layer over scratch whose only content is the computerd binary at /usr/local/bin/computerd.
FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:${COMPUTERD_VERSION}@sha256:fd6a0bcd033345a34f9106f916898c2a63619d51c91c56f1044960a49714d17c AS computerd

# mise is fetched and checked against its digest in a stage of its own, so the final image holds only the binary.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS mise
ARG MISE_VERSION
ARG MISE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /mise https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64 \
 && echo "${MISE_SHA256}  /mise" | sha256sum -c - \
 && chmod 755 /mise

# Codex, the same way: the release's static binary, checked against its digest, in a stage of its own.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS codex
ARG CODEX_VERSION
ARG CODEX_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /codex.tgz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz \
 && echo "${CODEX_SHA256}  /codex.tgz" | sha256sum -c - \
 && tar -xzf /codex.tgz -C / \
 && mv /codex-x86_64-unknown-linux-musl /codex \
 && chmod 755 /codex

# OpenCode (step 4b), the same way: the release's binary, checked against its digest.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS opencode
ARG OPENCODE_VERSION
ARG OPENCODE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /opencode.tgz https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz \
 && echo "${OPENCODE_SHA256}  /opencode.tgz" | sha256sum -c - \
 && mkdir /out && tar -xzf /opencode.tgz -C /out \
 && mv /out/opencode /opencode \
 && chmod 755 /opencode

FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c

# The everyday tools agents and scripts expect (#169; some from exe.dev's exeuntu list), build-essential and the
# headers native npm and pip packages build against, and earlyoom, the memory guard
# the supervisor runs. Versioned Toolchains
# (Node, pnpm, Bun, Python, git, gh) are mise's, never apt's: mise's shims come first on PATH anyway, so a git an apt
# package pulled in would not shadow mise's. fd's binary is fdfind here; it gets its own name too.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fuse3 ca-certificates \
      curl wget jq ripgrep fd-find unzip zip xz-utils \
      procps psmisc lsof iproute2 dnsutils netcat-openbsd \
      less file tree openssh-client gnupg sudo sqlite3 tzdata \
      rsync socat net-tools iputils-ping bubblewrap locales time \
      build-essential pkg-config libssl-dev zlib1g-dev libffi-dev \
      earlyoom \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=mise /mise /usr/local/bin/mise

# The base mise.toml's Toolchains (a copy of BASE_MISE_TOML, apps/sandbox-image/src/toolchains.ts, which a test keeps
# equal), installed into mise's system directory, /usr/local/share/mise/installs, where mise looks for a version a
# config asks for before it downloads one. Its lockfile is made here too and copied by the bootstrap next to the base
# file it writes, since `mise lock` downloads aqua and Python artifacts to checksum them. A Workspace asking for other
# versions installs them under /root as before. Refresh the versions in toolchains.ts and here together.
COPY mise.toml /usr/local/share/cloudpid/mise.toml
RUN cd /usr/local/share/cloudpid \
 && export MISE_GLOBAL_CONFIG_FILE=/usr/local/share/cloudpid/mise.toml MISE_TRUSTED_CONFIG_PATHS=/usr/local/share/cloudpid \
 && mise install --system \
 && mise lock --global --platform linux-x64 \
 && mise reshim --system \
 && rm -rf /root/.cache /root/.local /tmp/*

# SPI-992 (review M5): the system gitconfig of every git the image installs (conda git reads $PREFIX/etc/gitconfig, not
# /etc) and /etc/gitconfig: pushes to github.com go to t3flare's push gateway (`pushInsteadOf`), and the credential
# helper gives a read-only token for https://github.com only. Nothing is written per Container start; each git here
# must read it back, or the build fails.
COPY gitconfig /usr/local/share/t3flare/gitconfig
RUN set -e; found=0; \
 for git in /usr/local/share/mise/installs/*/*/bin/git; do \
   [ -x "$git" ] || continue; \
   prefix="$(cd "$("$git" --exec-path)/../.." && pwd)"; \
   mkdir -p "$prefix/etc" && cp /usr/local/share/t3flare/gitconfig "$prefix/etc/gitconfig"; \
   test "$("$git" config --system --get url.http://computer.internal/t3flare/git/.pushinsteadof)" = https://github.com/; \
   found=1; \
 done; \
 test "$found" = 1; \
 cp /usr/local/share/t3flare/gitconfig /etc/gitconfig

# The CLI agents (step 4a, plan §6), at fixed paths the CLI profiles name absolutely, after the mise layer so a CLI bump
# rebuilds only this: Codex's checked binary, pi from a committed lock with the image's Node (`npm ci`, no scripts), the
# key helper. Not mise: a project's toolchains must never shadow them.
COPY --from=codex --chown=0:0 /codex /opt/t3flare/bin/codex
COPY cli/package.json cli/package-lock.json /opt/t3flare/pi/
RUN cd /opt/t3flare/pi \
 && PATH=/usr/local/share/mise/installs/node/26.13.0/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm
COPY --chmod=755 t3flare-pi /opt/t3flare/bin/pi
COPY --chmod=755 t3flare-model-key /opt/t3flare/bin/t3flare-model-key

# Step 4b, plan §6: Claude Code over ACP (claude-agent-acp and the Claude Agent SDK, whose platform package holds the
# claude binary) from its own committed lock, and OpenCode's checked binary, each in its own layers so a bump rebuilds
# one; their launchers (which install the managed settings and the system configuration) and OpenCode's key plugin.
COPY claude/package.json claude/package-lock.json /opt/t3flare/claude/
RUN cd /opt/t3flare/claude \
 && PATH=/usr/local/share/mise/installs/node/26.13.0/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm \
 && test -x node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
COPY --from=opencode --chown=0:0 /opencode /opt/t3flare/opencode/opencode
COPY --chmod=755 t3flare-claude-agent-acp /opt/t3flare/bin/claude-agent-acp
COPY --chmod=755 t3flare-claude-key /opt/t3flare/bin/t3flare-claude-key
COPY --chmod=755 t3flare-opencode /opt/t3flare/bin/opencode
COPY opencode-key-plugin /opt/t3flare/share/opencode-key-plugin

COPY --chmod=755 supervise /usr/local/bin/cloudpid-supervise

# The memory guard, which the supervisor runs: earlyoom (an apt package above), and a note for the commands that run
# when it stops a process, which the file every command's bash reads first (BASH_ENV) prints when the command ends
# (docs/architecture/container.md → Memory guard).
COPY --chmod=755 cloudpid-memory-guard /usr/local/bin/cloudpid-memory-guard
COPY command.bash /usr/local/share/cloudpid/command.bash

# computerd mounts its file system at MOUNT_POINT, so commands see the Workspace's files at /workspace. FUSE_MOUNT=auto
# mounts through /dev/fuse where the platform exposes it (Cloudflare Containers) and falls back to a userspace shim
# where it does not. mise keeps the Toolchains it installs on the Container's own disk, in its default place under
# /root, and its shims put them on PATH, before the shims of the image's own installs. PATH is the one variable
# computerd passes on to a command, so it is the one set here: mise's other settings reach a command in its exec
# environment (apps/sandbox-image/src/toolchains.ts).
# computerd keeps its copy of the Workspace in COMPUTERD_DB, on the Container's disk, so a snapshot holds it with its
# sync positions: a Container restored from one is sent only what changed since, not every file (docs/architecture/container.md →
# Snapshots). In memory, the default, it is rebuilt from the Workspace DO at each start.
ENV PORT=8080 \
    MOUNT_POINT=/workspace \
    FUSE_MOUNT=auto \
    COMPUTERD_DB=/var/lib/computerd/state.db \
    PATH=/root/.local/share/mise/shims:/usr/local/share/mise/shims:${PATH}
RUN mkdir -p /var/lib/computerd
EXPOSE 8080

# computerd runs under a supervisor that reports why it stopped, when it stops on its own, to the Workspace DO
# (`supervise`; docs/architecture/container.md → Exit reports).
ENTRYPOINT ["/usr/local/bin/cloudpid-supervise"]
