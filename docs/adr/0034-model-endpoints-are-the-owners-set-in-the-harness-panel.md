# Model endpoints are the owner's, set in the Harness panel

Status: **accepted** at the hard cut (SPI-1176, 2026-11-17); drafted with SPI-1162 (2026-11-14). Part of **Model
endpoints** (SPI-1160 to SPI-1176; the owner's decisions of 2026-11-13). Reports: [`docs/steps/spi-1162.md`](../steps/spi-1162.md),
[`docs/steps/spi-1176.md`](../steps/spi-1176.md); the owner's guide: [`docs/model-endpoints.md`](../model-endpoints.md).
**Supersedes** [ADR-0012](0012-all-model-access-goes-through-the-model-proxy.md) (until the hard cut, the Model proxy
and the endpoints stood side by side; items 2, 5, 6 and 8 below say what they did then, and the SPI-1176 refinement at
the end what holds now) and refines [ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md)
(a third entity on the same page).

t3flare stops depending on the Model proxy. The owner configures **Model endpoints**: each is an API pi-ai speaks
(Anthropic Messages, OpenAI Responses, OpenAI-compatible Completions, Google Generative AI, Mistral), at a base URL,
with an API key, a sign-in (SPI-1164: ChatGPT plan usage first; SPI-1165: a Claude plan; SPI-1166: a GitHub Copilot
plan, each Claude's and Copilot's terms-of-service risk the owner's; [ADR-0018](0018-the-environment-do-is-the-credential-broker-and-each-environment-signs-in-itself.md)'s
refinement) or none, optional headers, and the models it serves.

1. **Their own entity.** Stored in the Environment DO under `t3flare:endpoints:settings` with their own revision,
   apart from the Harness settings and the Environment settings; edited in the Harness panel's Model endpoints section
   behind the panel's guards (Access, then JSON, `Origin`, `Sec-Fetch-Site` and the owner's CSRF token); every change
   audited under the entity `endpoints` with the key's mark and the headers' names, never a key or a header's value.
   A Session takes a new revision at a turn's start (`modelEndpoints`, 5 s bound, the copy it took kept secret-free in
   its storage); the Pi Durable picker builds its snapshot again at once.
2. **Slugs.** A model is `<endpointId>/<modelId>` everywhere: the picker, the Session's pi-ai ref (the endpoint is its
   provider), and the model relay and the credential broker that build on this. Ids are immutable once saved (a CLI
   keeps its provider id in its rollouts). A model id may hold a `/`; the slug splits at the first. `anthropic` is
   reserved while the Model proxy's models are `anthropic/<id>`.
3. **Models.** Read from the endpoint's own list where its API has one (Anthropic's paged `/v1/models`, the
   OpenAI-shaped `/models`, Google's `/models`), or typed in; pi-ai's own catalog fills in the name, limits, reasoning,
   thinking levels and price of a model it knows, the owner's fields winning. A model nothing knows gets default
   limits and no price.
4. **Keys sealed, write-only.** An endpoint's key is sealed apart from the entity: AES-256-GCM under a key derived
   (HKDF-SHA256) from the stage's credentials key `T3FLARE_CREDENTIALS_KEY`, the record's name as additional data
   (step-2a2's design). The key is 256 random bits alchemy makes once per stage and keeps in the stage's state
   (`Alchemy.Random`), so prod gets one at its next deploy with nothing for the owner to do. Without it no key is
   stored. What the panel shows is that a key is set, when, a fingerprint, and whether this Environment's key still
   opens it. A saved key goes only to the **target** it was saved with: the endpoint's API, base URL and headers
   (header names ignore case; a gateway may route by a header). An edit that moves any of them needs the key again,
   discovery elsewhere needs a typed key, and no redirect is followed with it. A key is sealed only for an endpoint
   saved beside it. Base URLs are https at a public host name (no IP literal, `localhost` or `.internal`).
   A Session asks for a key at use time (ADR-0018's direction) with the target it holds:
   `endpointCredential({ endpointId, target })`. The Environment gives the key only when that is the endpoint's target
   now. Otherwise the turn fails saying the endpoint changed and to retry. The Session keeps keys in memory only, by
   endpoint and target. The endpoint's headers go with every request; an endpoint with no auth sends a placeholder
   key, never a secret. A sign-in endpoint has no key: `endpointCredential` gives its access token from the Credential
   broker, under the same target rule (ADR-0018's refinement).
5. **Text generation** (SPI-1163). Thread titles, commit messages and PR text on an endpoint's model are one pi-ai
   request on the agents Worker (`EndpointTextGeneration`, the Environment's `TEXT_GENERATION` service binding), so the
   Environment's bundle never holds pi-ai. The call carries ids only; the agents Worker reads the endpoint with
   `modelEndpoints` and asks for the key with `endpointCredential`, as a Session does, and builds the request with a
   Session's own provider (`endpointProviders`), so a sign-in's credential reaches it through the same code once the
   broker exists. A failure names the
   endpoint and says what happened, classified as a turn's is (item 8), else by the answer's status. The default text model is a small model (haiku, mini,
   nano, flash, lite, small, tiny) of the first endpoint that has one, its cheapest by known price; until the hard cut,
   the Model proxy's small model when no endpoint has one. While the owner has picked no model, the text-generation
   setting names that default and follows it as the endpoints change.
6. **Expand, then cut.** Until SPI-1176 the Model proxy's models and settings keep working beside the endpoints. A
   turn on a model whose endpoint was removed, or no longer lists it, fails with a message that says so.
   **Except Claude Code** (SPI-1168; the owner accepted it): once an Anthropic Messages endpoint lists a
   model, every Claude Code process runs on the endpoints, and the Model proxy's models are refused in Claude Code
   threads. Its managed settings are the Container's, shared by every Claude process, so the choice is the
   Environment's, not the session's. **And OpenCode** (SPI-1169; the same choice, which the owner accepted for Claude
   Code): once an endpoint whose API OpenCode speaks (Anthropic Messages, OpenAI Responses, OpenAI-compatible
   Completions) lists a model, every OpenCode process runs on the endpoints, and the Model proxy's models are refused
   in OpenCode threads. Its system configuration (`/etc/opencode`) is the Container's too. **And pi** (SPI-1170; the
   same choice): once any endpoint lists a model (pi speaks every endpoint API), every pi process runs on the
   endpoints, and the Model proxy's models are refused in pi threads.
7. **CLI agents through the model relay** (SPI-1167): a CLI agent reaches an endpoint whose API it speaks at
   `computer.internal/t3flare/model/<endpointId>` with a per-process Handle; the Workers swap it for the key from
   `resolve` and stream the request to the endpoint unchanged ([ADR-0016](0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)'s
   model relay refinement). Codex is the first; its provider id is the endpoint's (`t3flare-endpoint-<id>`). Claude Code
   (SPI-1168) reaches every Anthropic Messages endpoint through one model-routed URL (`…/t3flare/model/_`), the
   endpoint chosen by the request's model slug, so a thread can switch between endpoints' models. OpenCode (SPI-1169)
   takes a base URL per provider: one provider per endpoint whose API it speaks (`t3flare-endpoint-<id>`, at the
   per-endpoint path), so a thread switches between them, across APIs, without the routed URL. pi (SPI-1170) does the
   same for every endpoint: one provider per endpoint (`t3flare-endpoint-<id>`) in its `models.json`, whose key is a
   command that prints the process's handle.

8. **Failures classified per API** (SPI-1172). A failed answer from an endpoint is classified by the endpoint's API and
   auth (`@t3flare/models/failures`, one table of rows), from what the vendor documents as machine-readable: the status,
   the error's type and code, and the reset headers and fields (Anthropic's unified limit and spend cap, OpenAI's quota
   and rate-limit headers, ChatGPT's `usage_limit_reached` and plan usage's `subscription_sharing_*` codes, any 429's
   `retry-after`, a 401 or 403 by the endpoint's auth, overload and 5xx), never its prose. The Session classifies a
   Durable turn's or a compaction's answer once, records it on the turn with its own text naming the endpoint, and stops
   pi-durable's retries when none can help; t3 shows it, and a usage limit pauses the thread until its reset (auto-resume
   when the owner has it on). A rate limit that resets within pi-durable's retries (14 s) is retried in the run. Overload and 5xx are
   retried and are never a usage limit (501 is not retried). **No fallback**: a turn's model is its endpoint's, so a
   limited endpoint's thread waits for that endpoint. Every failed answer replaces the turn's record. Text generation
   names the classified failure and its reset. The relay passes an error back in the vendor's own shape, its body
   redacted whole (an error event in a stream too), logs the class, and reports it to the Workspace DO as the process's
   last answer; a CLI agent's failed turn on an endpoint shows that classification (the Environment's CLI wrapper), so
   no CLI's failure on an endpoint is read from Commissary's texts. Error text is redacted by shape (vendor keys, bearer tokens,
   JWT-shaped values, key headers and parameters) and by the endpoint's own credential before it reaches t3 or a log
   (`@t3flare/models/redact`, also in the Environment's redacting Console). The Model proxy keeps its own classifier
   (`proxyFailure.ts`) until the hard cut.

Consequences: Commissary is one endpoint among others (an Anthropic Messages endpoint at its URL with its key). Losing
a stage's alchemy state loses its credentials key, and the owner enters the endpoints' keys again.

## Refinement (SPI-1176, 2026-11-17): the hard cut

Report: [`docs/steps/spi-1176.md`](../steps/spi-1176.md). t3flare no longer knows a Model proxy. Where items 2, 5, 6 and 8
speak of "until the hard cut", this holds instead:

1. **No proxy, no compatibility path.** `MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY`, `COMMISSARY_CONTAINER_API_KEY` and every
   `COMMISSARY_*` setting are gone from the code, the deploy and CI, with the key helper (its route, nonces and the sync
   guard's entry for its key), the proxy's catalog and static model list, its failure classifier (`proxyFailure.ts`), and
   Commissary's usage and limit readers. Commissary is one endpoint among others (Anthropic Messages at its host, OpenAI
   Responses at its `/v1` for Codex), and its MCP tools a direct server the owner adds (ADR-0028's SPI-1160 refinement).
2. **The setup state.** With no endpoint that lists a model, Pi Durable's provider is t3's `warning` status with no model
   and a message pointing to the Harness panel; so is each CLI's with no endpoint of an API it speaks, and its spawn is
   refused saying which API it needs (ADR-0016's SPI-1176 refinement). Nothing runs until the owner adds an endpoint.
3. **Old selections fall back** (item 6's "until SPI-1176's fallback"): a model selection from before the cut (the
   proxy's `anthropic/<id>`, a bare id, `default`) runs on the default model, the first model of the first endpoint that
   lists one (each CLI's: of its endpoints), for Pi Durable and every CLI; text generation's falls back to text
   generation's default. A slug of an endpoint that is gone still fails, saying so. `anthropic` stays a reserved
   endpoint id, so no endpoint answers for an old selection by accident.
4. **Text generation's default** (item 5): a small model of the first endpoint that has one, else the default model; with
   no endpoint, it says to set one up. The Guardian, prompt suggestions and `web_search` (on an Anthropic Messages
   endpoint with an API key or no auth) use the same small model unless the owner names another endpoint's model; the
   Advisor follows the thread's.
5. **Failures** (item 8): every failed answer is an endpoint's, classified by its API and auth; no other classifier is
   left.
6. **Usage and limits**: the Usage page and the limit meters read t3flare's own records alone, every endpoint's
   (Commissary's included) counted once.
