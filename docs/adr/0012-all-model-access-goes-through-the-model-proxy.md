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

## Usage limits as built (refinement, step 2a part 2)

The proxy's limit and key answers are classified once, in the Session, when the answer comes: a recording `fetch` keeps each answer's status and `retry-after`, and a pi-durable `afterResponse` hook classifies the failed response (`packages/models/src/proxyFailure.ts`) and records its class, code and reset on the turn. A limit with a reset (all accounts cooling down, a spend limit, Commissary Cloud's request rate, a 503 `no auth available` with `retry-after`, an upstream 429 with `retry-after`) is t3's `usage_limit` with that reset, held to at least 30 s after the turn ends and with no upper bound; a refused key is a `permission_error` that names `MODEL_PROXY_API_KEY`; an upstream account's refusal says to reconnect it in the proxy. For each of those the hook leaves pi-durable an error text no retry pattern matches, so the turn makes one request: no retry gate in `fetch` was needed. Overload and 5xx stay retried. The table and messages: [`docs/model-proxy.md` → Usage limits](../model-proxy.md#usage-limits). Proved on a stage with the Session's fault route (Commissary's own answers): a cooldown with a 2-minute reset failed after 1 request and the thread resumed by itself at the reset and completed ([report](../steps/step-2a-part2.md)).

## History

### 2026-11-10: model access is per Provider instance, a proxy key or a Subscription login

Superseded on 2026-11-11 by the decision above. The original text:

> Each Provider instance declares how it reaches models: a proxy (base URL plus a key held as a Worker secret; the deployment default points at the owner's model proxy, but nothing in code names it) or a Subscription login held by the Credential broker (ADR-0018). Durable agents ask the broker for a short-lived access token and keep it in Session memory; it never reaches a Container. Two logins cover both agent modes in v1: ChatGPT through t3's managed Codex sign-in, and Claude through a pasted `claude setup-token` token. The model list is static config in pi's `models.json` shape, so the thinking-level picker has its metadata.
>
> - The owner carries the terms-of-service risk, chosen knowingly. The sharpest case is Durable agents on a Claude subscription: a third-party harness using subscription OAuth, where Anthropic's terms describe OAuth for its own applications.
> - At a usage limit a thread pauses and t3 auto-resumes at the reset time; it never falls back to the proxy key, which would turn a pause into spend.

### 2026-11-11: why it changed

The proxy already holds the owner's subscriptions, pools several accounts per vendor, refreshes their tokens and rotates between them when one is limited. Holding Subscription logins in t3flare as well would have meant a second refresher for the same rotating tokens, one sign-in per Environment, a broker, sealed storage and vendor-specific request shapes (pi-ai's Claude Code identity, ChatGPT token sharing) to keep current. The step 2a part 2 plan that would have built them (branch `step-2a2`, `docs/steps/step-2a2-plan.md`) is shelved.

## Refinement (SPI-1004): keys typed into t3 are refused for now (owner decision D5)

Some stock t3 features keep a credential the owner types into t3's settings: cloud voice transcription (a vendor speech key), custom text generators (a vendor key per generator), and `request_secret` (an agent asks the owner for a secret). Each would put a credential in t3flare beside the proxy key, which this ADR rules out. They are **refused for now**:
- `cloudVoiceTranscription` is stripped.
- `textGenerators` is locked empty by t3flare's managed policy (ADR-0023).
- Agents are not offered `request_secret` (ADR-0022).

Text generation itself runs on the proxy through the Durable agent provider. A secret provider such as 1Password may come later through the broker pattern: the Environment DO fetches a secret per use and never stores it (ADR-0018's shape). That would take its own decision.

## Refinement (SPI-1061): a Route's Access service token is typed in (owner decision E2, 2026-11-12)

D5 above refuses credentials typed into t3flare. The owner has granted a second exception, beside the one for owner-added MCP servers' credentials (the tools step's, owner decision (b), recorded with that step): the Access service token of a Route that runs over the owner's own Cloudflare Tunnel ([ADR-0029](0029-the-outbound-link-is-the-owners-to-make-capped-at-supervised-and-every-send-over-it-waits-for-the-owner.md), rule 8).

- The owner makes the tunnel, the Access application and the token in his own Cloudflare account, and enters the token's id and secret once in the harness panel.
- It is stored write-only in the Environment's secret store, and never enters a Session, a Workspace, a Container or a log. Only the owner sets it, and nothing reads it back.
- It is not a model or vendor credential: it opens only the owner's own Access application in front of his laptop, and is sent only to that Route's address.

Rejected: prod's alchemy stack making the tunnel, the Access application and the token, with the token as a deploy secret. No credential would be typed, but prod's CI token would gain tunnel and DNS permissions and every deploy would touch the laptop's front door.

D5 otherwise stands: cloud voice, custom text generators and `request_secret` stay refused.
