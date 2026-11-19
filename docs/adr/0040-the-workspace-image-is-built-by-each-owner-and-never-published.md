# The Workspace image is built by each Owner and never published

Status: accepted (2026-11-19, the open-source release's design interview). Facts:
[`docs/research/oss-release-facts.md`](../research/oss-release-facts.md) Part A.

The Workspace image holds the CLI agents at their CLI pins. Its Dockerfile (`apps/sandbox-image/image/Dockerfile`)
downloads each from its publisher while it builds: Codex and OpenCode as release tarballs checked by SHA-256, the pi CLI
and Claude Code's ACP adapter by `npm ci` from their locks. alchemy builds it with Docker during a deploy and pushes it
to the Deployment's own Cloudflare account. The Canonical repository holds no CLI binary.

The licences differ. Codex and claude-agent-acp are Apache-2.0, OpenCode and pi are MIT, but the Claude Agent SDK the
adapter pulls in, and the `claude` binary in it, are proprietary ("All rights reserved. Use is subject to the Legal
Agreements …"). Anthropic's terms make "preinstalling or running Claude Code in your products or services" subject
to its Commercial Terms and their conditions. t3flare's MIT licence covers none of the CLIs.

So the project never publishes a Workspace image: no registry image, no release asset, no image built by the Canonical
repository's CI for others to pull. Every Owner builds their own, from the publishers' releases, and accepts each CLI's
terms by doing so. A build for one Owner's own Deployment redistributes nothing.

## Considered Options

- **Publish the full image.** Deploys would need no local Docker, but the project would redistribute Anthropic's binary
  under conditions it would have to meet, and carry the Apache-2.0 and MIT notices (pi's npm package ships no licence
  file). An image once published cannot be taken back.
- **Publish an image without Claude Code,** and let Owners add it. Two image variants to maintain, and the published one
  lacks a headline agent.

## Consequences

- Every machine that deploys needs Docker, and a first deploy is slower.
- A Deployment repository's CI may build the image for its own Deployment (the `bump` Stage, `prod`); that is the same
  build, pushed to the same Owner's account.
