# Model access is per Provider instance: a proxy key or a Subscription login

Each Provider instance declares how it reaches models: a proxy (base URL plus a key held as a Worker secret; the deployment default points at the owner's model proxy, but nothing in code names it) or a Subscription login held by the Credential broker (ADR-0018). Durable agents ask the broker for a short-lived access token and keep it in Session memory; it never reaches a Container. Two logins cover both agent modes in v1: ChatGPT through t3's managed Codex sign-in, and Claude through a pasted `claude setup-token` token. The model list is static config in pi's `models.json` shape, so the thinking-level picker has its metadata.

## Consequences

- The owner carries the terms-of-service risk, chosen knowingly. The sharpest case is Durable agents on a Claude subscription: a third-party harness using subscription OAuth, where Anthropic's terms describe OAuth for its own applications.
- At a usage limit a thread pauses and t3 auto-resumes at the reset time; it never falls back to the proxy key, which would turn a pause into spend.
