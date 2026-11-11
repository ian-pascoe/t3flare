# All model access goes through the model proxy

Rewritten 2026-11-11 (owner decision); the decision it replaces is kept under [History](#history).

Every model call t3flare makes, for every kind of agent, goes to one model proxy: the Durable agents' turns, text generation, the model list, and the CLI agents (Codex, Claude Code, OpenCode and pi). t3flare holds the proxy's base URL and keys and nothing else: no vendor API key and no Subscription login of its own. The owner's subscriptions (Claude, ChatGPT, …) and provider keys are connected in the proxy, which pools, refreshes and rotates them. The code names the proxy's contract, not a deployment; the contract is Commissary's (below).

## Consequences

- Nothing in t3flare refreshes a token, so there is no Credential broker and no per-Environment sign-in: [ADR-0018](0018-the-environment-do-is-the-credential-broker-and-each-environment-signs-in-itself.md) is superseded.
- A CLI agent is pointed at the proxy with its base URL and a key. How that key reaches the Container is open ([ADR-0016](0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)).
- A usage limit is the proxy's. When every account behind a model is exhausted it answers 429 with a reset hint; t3 shows the limit, pauses the thread and can resume it at the reset. Nothing retries into spend, and nothing falls back to another key or model. A refused key (401/403) is a failure that names the key, not a pause.
- Plan windows and usage meters belong to the proxy's accounts, so t3's usage readers stay empty.
- The terms-of-service risk of using a subscription through a third-party harness is still the owner's, chosen knowingly; it now sits in how the proxy is set up, not in t3flare's code.

## The contract is Commissary's (refinement, 2026-11-11)

"Nothing in code names it" means the code names the proxy's **contract**, not its deployment. That contract is [Commissary](https://github.com/spiritledsoftware/commissary)'s: the Anthropic Messages API for turns and text generation, protocol translation (so every model it serves is reached as an Anthropic Messages model), and `GET /v1/models` for the model list. The list is no longer static config: both Workers read it from the proxy, keep a copy in their Durable Object's storage, and fall back to the static list in `packages/models` before the first read. Only real model ids are used; Commissary's alias ids for non-Claude models are read back to them. What the proxy must provide, how to set it up, and what was verified: [`docs/model-proxy.md`](../model-proxy.md). The CLI agents (step 4) will use whichever of Commissary's APIs each CLI speaks (OpenAI Responses for Codex, Anthropic Messages for the others).

## History

### 2026-11-10: model access is per Provider instance, a proxy key or a Subscription login

Superseded on 2026-11-11 by the decision above. The original text:

> Each Provider instance declares how it reaches models: a proxy (base URL plus a key held as a Worker secret; the deployment default points at the owner's model proxy, but nothing in code names it) or a Subscription login held by the Credential broker (ADR-0018). Durable agents ask the broker for a short-lived access token and keep it in Session memory; it never reaches a Container. Two logins cover both agent modes in v1: ChatGPT through t3's managed Codex sign-in, and Claude through a pasted `claude setup-token` token. The model list is static config in pi's `models.json` shape, so the thinking-level picker has its metadata.
>
> - The owner carries the terms-of-service risk, chosen knowingly. The sharpest case is Durable agents on a Claude subscription: a third-party harness using subscription OAuth, where Anthropic's terms describe OAuth for its own applications.
> - At a usage limit a thread pauses and t3 auto-resumes at the reset time; it never falls back to the proxy key, which would turn a pause into spend.

### 2026-11-11: why it changed

The proxy already holds the owner's subscriptions, pools several accounts per vendor, refreshes their tokens and rotates between them when one is limited. Holding Subscription logins in t3flare as well would have meant a second refresher for the same rotating tokens, one sign-in per Environment, a broker, sealed storage and vendor-specific request shapes (pi-ai's Claude Code identity, ChatGPT token sharing) to keep current. The step 2a part 2 plan that would have built them (branch `step-2a2`, `docs/steps/step-2a2-plan.md`) is shelved.
