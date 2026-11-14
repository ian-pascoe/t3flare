# Model endpoints are the owner's, set in the Harness panel

Status: draft (SPI-1162, 2026-11-14), to be accepted at the hard cut (SPI-1176). Part of **Model endpoints**
(SPI-1160 to SPI-1176; the owner's decisions of 2026-11-13). Report: [`docs/steps/spi-1162.md`](../steps/spi-1162.md).
Refines [ADR-0012](0012-all-model-access-goes-through-the-model-proxy.md) (until the hard cut, the Model proxy and
the endpoints stand side by side) and [ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md)
(a third entity on the same page).

t3flare stops depending on the Model proxy. The owner configures **Model endpoints**: each is an API pi-ai speaks
(Anthropic Messages, OpenAI Responses, OpenAI-compatible Completions, Google Generative AI, Mistral; ChatGPT's Codex
backend and the other sign-ins come with SPI-1164), at a base URL, with an API key or none (OAuth sign-ins next),
optional headers, and the models it serves.

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
   key, never a secret.
5. **Text generation** (SPI-1163). Thread titles, commit messages and PR text on an endpoint's model are one pi-ai
   request on the agents Worker (`EndpointTextGeneration`, the Environment's `TEXT_GENERATION` service binding), so the
   Environment's bundle never holds pi-ai. The call carries ids only; the agents Worker reads the endpoint with
   `modelEndpoints` and asks for the key with `endpointCredential`, as a Session does, and builds the request with a
   Session's own provider (`endpointProviders`), so a sign-in's credential reaches it through the same code once the
   broker exists. A failure names the
   endpoint and says what happened by the answer's status alone. The default text model is a small model (haiku, mini,
   nano, flash, lite, small, tiny) of the first endpoint that has one, its cheapest by known price; until the hard cut,
   the Model proxy's small model when no endpoint has one. While the owner has picked no model, the text-generation
   setting names that default and follows it as the endpoints change.
6. **Expand, then cut.** Until SPI-1176 the Model proxy's models and settings keep working beside the endpoints. A
   turn on a model whose endpoint was removed, or no longer lists it, fails with a message that says so.
7. **CLI agents through the model relay** (SPI-1167): a CLI agent reaches an endpoint whose API it speaks at
   `computer.internal/t3flare/model/<endpointId>` with a per-process Handle; the Workers swap it for the key from
   `resolve` and stream the request to the endpoint unchanged ([ADR-0016](0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)'s
   model relay refinement). Codex is the first; its provider id is the endpoint's (`t3flare-endpoint-<id>`).

Consequences: Commissary is one endpoint among others (an Anthropic Messages endpoint at its URL with its key). Losing
a stage's alchemy state loses its credentials key, and the owner enters the endpoints' keys again.
