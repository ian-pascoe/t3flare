# The model proxy

**Every model call t3flare makes goes to one HTTP endpoint you run: the model proxy.** No agent has any other way to reach a model: no Anthropic or OpenAI key, and no sign-in of its own, in a Worker or a Container. The proxy holds your provider keys and your Claude, ChatGPT and other subscriptions; t3flare holds one URL and one proxy key. Connect subscriptions and keys in the proxy, not in t3flare.

The proxy t3flare is built and tested against is **[Commissary](https://github.com/spiritledsoftware/commissary)**: a service you deploy to your own Cloudflare account (or buy as Commissary Cloud) that pools Claude, ChatGPT/Codex, Gemini, xAI and other accounts and provider keys behind one endpoint that speaks the Anthropic, OpenAI and Gemini APIs, translating between them. The code names a contract (below), not a deployment ([ADR-0012](adr/0012-all-model-access-goes-through-the-model-proxy.md)), but only Commissary has been run against it.

## What t3flare uses it for

| Feature | Where it runs | Request |
|---|---|---|
| Durable agent turns | A Session DO in the `agents` Worker, through pi-ai's `anthropic` provider | `POST {MODEL_PROXY_URL}/v1/messages?beta=true`, streaming |
| Text generation: thread titles, commit messages, PR titles and bodies | The Environment DO in the `environment` Worker, plain `fetch` | `POST {MODEL_PROXY_URL}/v1/messages`, one non-streaming request, no tools |
| The model list: the picker's models, each one's name, thinking levels and context window; the Session's models | Both Workers, each keeping its own copy | `GET {MODEL_PROXY_URL}/v1/models`, twice (see below) |
| The nightly bump job's real turn ([ADR-0017](adr/0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md)) | The `bump` stage, deployed by CI with the same two settings | A Durable agent turn and text generation, as above |

Nothing else calls a model today. A Container never sees the URL or the key; they are settings of the two Workers only. The CLI agents of step 4 (Codex, Claude Code, OpenCode, pi) call the proxy from their Containers, each through its own base-URL setting, with `COMMISSARY_CONTAINER_API_KEY` given on demand ([CLI agents](#cli-agents-steps-4a-4b), [ADR-0016](adr/0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)).

## What the proxy must provide

1. **The Anthropic Messages API at `MODEL_PROXY_URL`.** The URL is a base URL **without `/v1` and without a trailing slash**; t3flare appends the path (pi-ai hands the base URL to the Anthropic SDK, which does the same). Each request carries:
   - `x-api-key: <MODEL_PROXY_API_KEY>`, never `Authorization: Bearer`. (Exception, from pi-ai: a key containing `sk-ant-oat`, which marks an Anthropic subscription token, is sent as a Bearer token with Claude Code's identity headers. A Commissary key, `cms_…`, never does.)
   - `anthropic-version: 2023-06-01`, and for turns an `anthropic-beta` header (interleaved thinking, fine-grained tool streaming) whose features the proxy must accept or ignore.
   - A JSON body with `model`, `messages`, `max_tokens`, and for turns `stream: true`, tools, `thinking` and cache-control blocks as pi-ai sends them.
   - The path for turns is `/v1/messages?beta=true`; for text generation, `/v1/messages`. Both must work.
2. **Server-sent events** for turns, in Anthropic's streaming format, with tool-use and thinking blocks.
3. **`GET /v1/models`**, which is where t3flare's model list comes from. Commissary answers in one of two shapes, by the request's headers, and t3flare reads both and merges them by model id:
   - **Without `anthropic-version`**, OpenAI's shape, `{ object: "list", data: [{ id, object: "model", owned_by }] }`: every model under its **real id** (`gemini-3-flash`, `deepseek-v4-pro`, `claude-haiku-5-5`), but with no display name, context window or output limit. This list says which models there are.
   - **With `anthropic-version: 2023-06-01`** (and `limit=1000`, following `has_more`/`last_id` as `after_id`), Anthropic's shape, `{ data: [{ id, type: "model", display_name, max_input_tokens, max_tokens, owned_by }], has_more, first_id, last_id }`. This list says what each model is called and allows, but Commissary lists a model that is not Claude under an alias: `claude-fable-5-dd-` followed by the real id spelled backwards (`claude-fable-5-dd-eerf-maeb` is `beam-free`).
   - t3flare reads an alias back to its real id and joins the two lists on it. **Only real ids reach the picker, a Session or a request.** An alias with no counterpart in the plain list is dropped. (Both id forms answer `POST /v1/messages`, but only the real one means anything to a person.)
   - Any other fields are ignored, `owned_by` included: it names the route Commissary serves a model through (`opencode`, `antigravity`), not who makes it. Every field but `id` may be missing.
4. **Reachability from a Worker**: a public `https:` address that needs no Cloudflare Access sign-in on the client API paths. Commissary's client API is outside Access by design (an API host, or the bypass the deploy creates), so a key is all a caller sends.

### How the list is kept

Each Durable Object that needs it (the Environment, and each Session) keeps its own copy in its storage, stamped with the time it was read.

- It is read again once older than **15 minutes**: by the Environment when it boots and at each of its provider checks, by a Session when it starts, and before a turn on a model its copy lacks (the proxy may have added it).
- A read has **5 seconds**. If it fails, the copy there is stays in force, and none is tried again for **a minute**.
- Before the first read that succeeds, or when the proxy has never been reachable, the catalog is the **static list** in [`packages/models/src/models.json`](../packages/models/src/models.json): four Claude models. Turns and text generation still run on those.
- Either list failing alone is enough: with only the plain list, models are named by id and get default limits; with only the Anthropic one, aliases are read back to real ids. A proxy that answers the same shape to both works too.

### What each model gets

| | A Claude model (id like `claude-opus-5-5`, optionally dated) | Any other model |
|---|---|---|
| Thinking picker | Yes (off, minimal, low, medium, high) | None: no thinking is requested |
| Input | Text and images | Text only |
| Context window | The proxy's, held to 400,000 as `models.json` holds the Claude models | The proxy's, else 200,000 |
| Output limit | The proxy's, else 32,000 | The proxy's, else 32,000 |
| Price (spend limits) | pi-ai's own, or the family's newest it knows | None: unpriced |
| Picker label and group | Anthropic | Its vendor, by its id's family: `gpt-*`/`o<N>…` OpenAI, `gemini-*` Google, `deepseek-*` DeepSeek, `grok-*` xAI, `kimi-*` Moonshot AI, `glm-*` Z.ai, `qwen*` Alibaba, and so on; **Other** when the family is not known |

The picker lists the models grouped by vendor, the vendors by name and Other last, in the proxy's order within each. The label is never the proxy's `owned_by`. t3's picker drops a leading vendor name from a model's name when the label repeats it, so `DeepSeek V4 Pro` shows as `V4 Pro` labelled DeepSeek. The families are in [`packages/models/src/index.ts`](../packages/models/src/index.ts) (`vendorOf`); a new family shows as Other until it is added there.

A model is "Claude" here if its id names a Claude family and version and nothing else (`claude-(fable|opus|sonnet|haiku)-N[-M]`), so `claude-opus-4-6-thinking` and the aliases of other providers' models are not.

### Models that are not Claude

pi-ai speaks one protocol here, Anthropic Messages, whatever the model. A GPT, Gemini or DeepSeek model works **only because the proxy translates**: Commissary accepts an Anthropic Messages request for any model it can serve and converts it to that provider's API and back. What a given model does with tools, thinking or images depends on that translation.

Checked on 2026-11-11 against a Commissary on a throwaway stage ([`docs/steps/proxy-models/`](steps/proxy-models/)):

- The provider's snapshot listed all 71 models the proxy served, by real id, named, and no alias. (They were labelled and grouped by the proxy's route then; the vendor came after.)
- A chat turn completed on `claude-haiku-5-5` (thinking low), `gemini-3-flash` and `deepseek-v4-pro`.
- The acceptance test's real turn (clone the fixture repo, an `edit` and `bash test.sh`, each approved, the checkpoint's diff) passed on all three, with tools, through the translation.

Not checked: images, thinking, long contexts or parallel tool calls on a non-Claude model, or any other model on the list.

### Text generation's model

Text generation uses `anthropic/claude-haiku-5-5` unless a thread's own model selection or the Environment's text-generation setting names another. The proxy must serve that id, or the setting must name one it does serve: there is no search for a small model.

## Usage limits

When the proxy cannot serve a turn because a limit is reached, the turn ends as t3's **"Usage limit reached"** with the time it resets, and the thread can resume by itself at that time; a refused key ends the turn with an error that names the key. Nothing retries into spend and nothing falls back to another key or model ([ADR-0012](adr/0012-all-model-access-goes-through-the-model-proxy.md)). Built and checked in step 2a part 2 ([report](steps/step-2a-part2.md)).

**How it works.** The Session makes every model request through a recording `fetch` that keeps the answer's status and `retry-after` (pi-ai drops the headers). When a response fails, a pi-durable `afterResponse` hook classifies it once, with that answer, before pi-durable decides whether to retry ([`packages/models/src/proxyFailure.ts`](../packages/models/src/proxyFailure.ts), [`apps/agents/src/session/proxyLimits.ts`](../apps/agents/src/session/proxyLimits.ts)). It records the class, the code and the reset (counted from when the answer came) on the turn, and when no retry can help it leaves pi-durable an error text no retry pattern matches: **one request, no backoff.** The Environment's differ turns the record into t3's failure with a fixed message (never the proxy's body). The Session also counts each turn's requests (`GET /_t3flare/agents/session?thread=…` shows `proxy.requests`).

| The proxy answers (Commissary) | t3 shows | Code | Reset | Retried by pi-durable |
|---|---|---|---|---|
| 429, every account for the model cooling down (`… are cooling down … (reset after 1h2m3s)`) | Usage limit | `proxy_cooldown` | `retry-after`, else the message's hint | No |
| 429 passed through from the provider | Usage limit | `proxy_upstream_limit` | `retry-after`; none without it | Only without a reset (the next answer is the cooldown, with one) |
| 429, a Spend limit of the key, member, team or org (`… it resets at <time>`) | Usage limit | `proxy_spend_limit` | The time in the message, else `retry-after` | No |
| 429 `{"error":"Rate limit exceeded"}` (Commissary Cloud's request rate) | Usage limit | `proxy_request_rate` | `retry-after` (60 s) | No |
| 503 `no auth available` with `retry-after` (no account usable until one recovers) | Usage limit | `proxy_account_unavailable` | `retry-after` | No |
| 503 `no auth available` without it | Provider error | `proxy_no_account` | — | No |
| 401/403 `{"error":"Invalid API key"}`, `Missing API key`, `Forbidden` (the proxy refused t3flare's key) | Error: "The model proxy refused this Environment's key. Check `MODEL_PROXY_API_KEY`." | `proxy_key_rejected` | — | No |
| 401/403 in Anthropic's shape (an account in the proxy was refused upstream) | Error: reconnect the account in the proxy | `proxy_account_rejected` | — | No |
| 529 overloaded, other 5xx | Provider error | `proxy_overloaded`, `proxy_server_error` | — | Yes (3 retries from 2 s) |
| Any of these as an `event: error` inside a stream | As its body says | as above | The message's hint or time | as above |

- A reset is held to at least **30 s after the turn ends**, so a `retry-after: 0` cannot start an instant resume (t3 arms no resume for a reset that is not after the run's end). There is no upper bound: a monthly spend limit resets weeks away.
- **Resuming.** t3 offers the resume on the thread; with the client's "auto-resume limited threads" setting on (off by default, your own choice) it resumes by itself. An idle Environment's alarm wakes it at the reset. t3 resumes once per run and reset, so a limit that persists costs one request per window.
- **Text generation** (titles, commit messages) uses the same classification for its error text.
- **Compaction** gets the same treatment. pi-durable's compaction summarizes with `completeSimple` and runs no `afterResponse` hook, so the Session's models classify each `completeSimple` answer the same way (`compactionLimits`). A summary refused for a limit or a key makes one request. It fails the compaction, and a turn that waited on that compaction fails with the record as above.

## Usage and limits (t3's Usage page and limit meters)

Optional (parity G8, [report](steps/parity-batch-2.md)). With it, t3's **Usage** page shows this Environment's token use and cost by agent and model, and its limit meters show each Commissary account's windows (5-hour, weekly, …) as a source named **Commissary**. Without it, both stay empty, as before.

Commissary serves usage and quotas only on its **management API** (`/v9/management/...`, on the app host, behind Cloudflare Access on a self-hosted deployment). It refuses API keys (`cms_`) there, and t3's own `cliproxy` source cannot read it (Commissary did not port CLIProxyAPI's `/v0/management`). So the Environment Worker, and nothing in a Container, holds:

| Setting | What | Where |
|---|---|---|
| `COMMISSARY_MANAGEMENT_URL` | The app host, e.g. `https://commissary.example.com` (not the API host) | variable |
| `COMMISSARY_MANAGEMENT_ORG` | The org's slug; unset means the key's own org | variable, optional |
| `COMMISSARY_MANAGEMENT_KEY` | A management key, `cmsm_…`, with the **admin** role (below) | secret |
| `COMMISSARY_ACCESS_CLIENT_ID`, `COMMISSARY_ACCESS_CLIENT_SECRET` | Self-hosted only: an Access service token Commissary's Access application admits for `/v9/management` | variable, secret |

Put them in `~/.config/t3flare/dev.env` (stages) or the GitHub environment `prod` (`deploy-prod.yml` passes them); `stage.ts` and `alchemy.run.ts` bind each one only when set.

**Least privilege.** Commissary's roles are owner, admin and member; there is no read-only role. A member-role management key has no member id, so it reads none of the org's usage records and none of its accounts: **admin is the minimum.** An admin key can also change accounts, routing and keys (never download a credential or issue keys). Records served by a member's *private* accounts stay hidden from any management key. Issue it for t3flare alone (`POST /v9/management/orgs/<slug>/management-keys {"name":"t3flare","role":"admin"}`, or the panel's Management keys) and revoke it there.

**What is read.** `GET /credentials` each time t3 refreshes its providers and every 5 minutes while t3 runs; `GET /observability/usage/records` when the Usage page asks (one read shared by its four readers for a minute), filtered to t3flare's two keys (`MODEL_PROXY_API_KEY`'s and `COMMISSARY_CONTAINER_API_KEY`'s key ids), up to 25,000 records per key per read. Requests are attributed by what Commissary recorded: Codex by its session identity or the Responses API, Claude Code by its session header, OpenCode by its affinity header, everything else (the Durable agent, text generation, the pi CLI) as **Pi**. Costs are Commissary's own, priced with your prices; unpriced models are left to t3's rate table. A Claude reset grant is claimed in Commissary's panel, not from t3.

## Set it up

1. **Deploy Commissary.** Self-hosted: follow its [README](https://github.com/spiritledsoftware/commissary#deploy) (a Workers Paid account, a zone, Cloudflare Zero Trust) and [`docs/DEPLOY.md`](https://github.com/spiritledsoftware/commissary/blob/main/docs/DEPLOY.md). Or use Commissary Cloud, the paid service ([DEPLOY.md, "Commissary Cloud"](https://github.com/spiritledsoftware/commissary/blob/main/docs/DEPLOY.md#commissary-cloud)). Either way, connect your accounts and provider keys in its control panel, so `GET /v1/models` lists the models you want. A self-hosted Commissary has no rate limits or spend caps of its own: set spend limits on the key you give t3flare.
2. **Create an API key** in the control panel (**API keys**). It is shown once. It looks like `cms_…`.
3. **Check it** before wiring it in:

   ```bash
   curl -H "x-api-key: $KEY" "$URL/v1/models"                                    # OpenAI shape: real ids
   curl -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" "$URL/v1/models"  # Anthropic shape: names, limits
   curl "$URL/v1/messages" -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
     -d '{"model":"<an id from the first list>","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}'
   ```

   `$URL` is the host that serves the client API: the API host if you set `COMMISSARY_API_DOMAIN`, else the app host.
4. **Local deploys.** Put both in `~/.config/t3flare/dev.env` (mode 0600, outside the repo):

   ```sh
   MODEL_PROXY_URL=https://llm.example.com
   MODEL_PROXY_API_KEY=cms_…
   ```

   `apps/environment/scripts/stage.ts` reads the file (shell variables of the same name win) and binds them as Worker settings and secrets of both Workers. It refuses to deploy a stage when either is missing, and never prints them.
5. **CI (the nightly bump).** The `bump` GitHub environment needs the variable `MODEL_PROXY_URL` and the secret `MODEL_PROXY_API_KEY`.
   - `pnpm --filter @t3flare/infra run ci:setup` creates the variable, reading `MODEL_PROXY_URL` from `~/.config/t3flare/dev.env`.
   - It does not set the key. Set it yourself, once and again after a rotation: `gh secret set MODEL_PROXY_API_KEY --env bump --repo <owner>/<repo>` (the value on stdin).
   - [`.github/workflows/bump.yml`](../.github/workflows/bump.yml) passes both to the deploy.

An Environment started without them answers text generation with "The model proxy is not configured." and lists only the static models; a Session cannot run a turn.

## CLI agents (steps 4a, 4b)

Codex, the pi CLI, Claude Code and OpenCode run in the Workspaces' Containers and call the proxy themselves ([ADR-0016](adr/0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)):

- **Codex** speaks the OpenAI **Responses** API: `POST <MODEL_PROXY_URL>/v1/responses` with `Authorization: Bearer <key>`, as model provider `t3flare-proxy` (`base_url = <MODEL_PROXY_URL>/v1`, `wire_api = "responses"`). Commissary accepts a `cms_` key as a Bearer, and its Responses API drove Codex's tools on GPT, Claude and Gemini models in step 4a's probes, so Codex lists the whole catalog. The model id Codex sends is the catalog's real id.
- **pi** speaks the Anthropic **Messages** API with `x-api-key`, as pi's `anthropic` provider with its `baseUrl` overridden; its models are the catalog's (`anthropic/<id>`), as for Pi Durable.
- **Claude Code** (step 4b) speaks the Anthropic **Messages** API to `ANTHROPIC_BASE_URL=<MODEL_PROXY_URL>` with the key from its managed `apiKeyHelper` (sent as both `x-api-key` and `Authorization: Bearer`); Commissary accepts its `anthropic-beta` headers. The catalog's real ids are its `availableModels`, chosen with ACP's `model` config option; Commissary checks a model when it is set, so an id it refuses fails the set. Tool turns completed on Claude, GPT and DeepSeek models; Gemini 3.x was refused by Commissary's upstream accounts for every client (402, 403, 410) on 2026-11-12. Its background model is the text-generation model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`).
- **OpenCode** (step 4b) speaks the Anthropic **Messages** API as its provider `t3flare` (`@opencode/ai/providers/anthropic-compatible`, `baseURL = <MODEL_PROXY_URL>/v1`; the `/v1` is needed), the whole catalog by real id (`t3flare/<id>`), with `x-api-key` set by t3flare's key plugin.
- **A second key.** The CLIs get `COMMISSARY_CONTAINER_API_KEY`, never `MODEL_PROXY_API_KEY`: anything in a Container that runs the key helper while a CLI process lives can read it. Create it as its own Commissary API key with an **empty tool scope** (models only), its **own spend limit**, and optionally an expiry. Put it in `~/.config/t3flare/dev.env`; `stage.ts` binds it to the agents Worker alone and refuses a stage deploy without it. CI: `pnpm --filter @t3flare/infra run ci:setup` sets it on the `prod` environment from `dev.env`; on `bump` set it by hand: `gh secret set COMMISSARY_CONTAINER_API_KEY --env bump --repo <owner>/<repo>`.
- **Rotate it** after a `credential-in-workspace` error in the agents Worker's logs (the sync guard found it in a Workspace and flagged it; `POST /_t3flare/check/leak?id=<workspace>` shows the flag) or on any doubt: revoke it in Commissary, update `dev.env`, run `ci:setup`, set it on `bump`, redeploy.

## MCP tools (tools step)

Commissary's MCP endpoint is also a tool source for every agent (ADR-0028). There is no new secret: the Environment Worker uses `MODEL_PROXY_API_KEY` as Commissary's **tools key**, read through one accessor (`toolsKeyOf`) so a dedicated key can replace it later. It is a Workers-only secret and never enters a Container; the CLIs reach Commissary's tools through the MCP relay with a per-process handle.

- **Scope.** Give the key a tool scope of the toolkits t3flare should see. With "every tool you may use", every new private toolkit reaches t3flare at once.
- **No Commissary approval rules on it** (OD-T3). t3flare asks by each thread's mode, linked threads included. Commissary's rules would ask a second time, on its own panel.
- **Classes.** A tool's class comes from its read-only hint (owner, 2026-11-12, back to stock: no pins). Fix a wrong class in Commissary (it then applies to every client), or for t3flare alone in the Harness panel.
- **Limits.** Calls end after 240 s (Commissary's upstream cap), progress is not passed on, and upstream elicitation is not forwarded. Servers that need those are added as Direct servers in the Harness panel instead.
- **`COMMISSARY_CONTAINER_API_KEY` keeps an empty tool scope.** It is models only.

## Another Anthropic-compatible endpoint

**Untested.** What was checked is that the requests above are ordinary Anthropic Messages requests (read in pi-ai's `anthropic-messages` implementation and the Anthropic SDK it uses: `x-api-key`, `anthropic-version: 2023-06-01`, `/v1/messages?beta=true`), so any endpoint that serves that API with an API key is a candidate, Anthropic's own (`https://api.anthropic.com`) included. Nothing was run against anything but Commissary. Two things are unverified and likely differ:

- The plain list request carries no `anthropic-version`, which Anthropic's API requires: it would be refused, and t3flare would use the Anthropic-shaped list alone (this path is covered by a unit test with a fake proxy, not by a real endpoint).
- An endpoint that translates nothing serves only its own models, and a model it lists that the Anthropic Messages API does not serve will fail on its first turn.

Anthropic's terms for subscription tokens used by a third-party harness are the owner's risk (ADR-0012).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A turn ends "The model proxy refused this Environment's key" (`proxy_key_rejected`), or text generation says the same | The key is wrong, revoked or expired, or its member may not use the client API (403); create a new one and redeploy (or rotate the `bump` secret) |
| "The proxy's account for this model was refused" (`proxy_account_rejected`) | An account behind the model was refused upstream (expired login, revoked key) and no other served it: reconnect it in the proxy's Accounts page |
| "Usage limit reached" with "every account … is at its usage limit" (`proxy_cooldown`) | All the proxy's accounts for that model are cooling down; the thread resumes at the reset (auto-resume on) or offers it. Add accounts in the proxy, or pick another model |
| "Usage limit reached", "the model provider's usage limit" (`proxy_upstream_limit`) without a reset time | The provider's own 429 came with no `retry-after`; resume by hand: the proxy then answers with its cooldown and a reset |
| "Usage limit reached", spend limit (`proxy_spend_limit`) | A Spend limit on the key, member, team or org; it resets at the time shown. Raise it in the proxy |
| "Usage limit reached", request rate (`proxy_request_rate`) | Commissary Cloud's per-org request rate; resets within a minute |
| "No account … is available until one recovers" (`proxy_account_unavailable`) | Every account is disabled or cooling for another reason; resets at the time shown |
| "The model proxy has no usable account for this model" (`proxy_no_account`) | No account in the proxy serves the model: connect one, or pick another model |
| HTTP 404 on turns | `MODEL_PROXY_URL` ends in `/v1`, or points at the control panel's host rather than the client API's |
| A redirect to `cloudflareaccess.com` | The URL is behind Access: use Commissary's API host |
| The picker shows only four Claude models | The proxy's list has not been read: it failed (wrong key or URL) or the Environment has not checked yet; run the first two checks above |
| A new model on the proxy is missing | The picker's copy is up to 15 minutes old; a Session reads it again when a turn names a model it lacks |
| A model in the list answers 400/404 on a turn | The key's org cannot reach that provider; check the proxy's Accounts and Models pages |
