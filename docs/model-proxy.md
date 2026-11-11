# The model proxy

**Every model call t3flare makes goes to one HTTP endpoint you run: the model proxy.** The Durable agent provider has no other way to reach a model: no Anthropic or OpenAI key, and no sign-in of its own in a Worker. The proxy holds your provider keys and your Claude, ChatGPT and other subscriptions; t3flare holds one URL and one proxy key. Connect subscriptions and keys in the proxy, not in t3flare.

The proxy t3flare is built and tested against is **[Commissary](https://github.com/spiritledsoftware/commissary)**: a service you deploy to your own Cloudflare account (or buy as Commissary Cloud) that pools Claude, ChatGPT/Codex, Gemini, xAI and other accounts and provider keys behind one endpoint that speaks the Anthropic, OpenAI and Gemini APIs, translating between them. The code names a contract (below), not a deployment ([ADR-0012](adr/0012-model-access-is-per-provider-instance-a-proxy-key-or-a-subscription.md)), but only Commissary has been run against it.

## What t3flare uses it for

| Feature | Where it runs | Request |
|---|---|---|
| Durable agent turns | A Session DO in the `agents` Worker, through pi-ai's `anthropic` provider | `POST {MODEL_PROXY_URL}/v1/messages?beta=true`, streaming |
| Text generation: thread titles, commit messages, PR titles and bodies | The Environment DO in the `environment` Worker, plain `fetch` | `POST {MODEL_PROXY_URL}/v1/messages`, one non-streaming request, no tools |
| The model list: the picker's models, each one's name, thinking levels and context window; the Session's models | Both Workers, each keeping its own copy | `GET {MODEL_PROXY_URL}/v1/models`, twice (see below) |
| The nightly bump job's real turn ([ADR-0017](adr/0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md)) | The `bump` stage, deployed by CI with the same two settings | A Durable agent turn and text generation, as above |

Nothing else calls a model. A Container never sees the URL or the key; they are settings of the two Workers only.

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
   - Any other fields are ignored; every field but `id` may be missing.
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

A model is "Claude" here if its id names a Claude family and version and nothing else (`claude-(fable|opus|sonnet|haiku)-N[-M]`), so `claude-opus-4-6-thinking` and the aliases of other providers' models are not.

### Models that are not Claude

pi-ai speaks one protocol here, Anthropic Messages, whatever the model. A GPT, Gemini or DeepSeek model works **only because the proxy translates**: Commissary accepts an Anthropic Messages request for any model it can serve and converts it to that provider's API and back. What a given model does with tools, thinking or images depends on that translation.

Checked on 2026-11-11 against a Commissary on a throwaway stage ([`docs/steps/proxy-models/`](steps/proxy-models/)):

- The provider's snapshot listed all 71 models the proxy served, by real id, named and grouped by who serves each, and no alias.
- A chat turn completed on `claude-haiku-5-5` (thinking low), `gemini-3-flash` and `deepseek-v4-pro`.
- The acceptance test's real turn (clone the fixture repo, an `edit` and `bash test.sh`, each approved, the checkpoint's diff) passed on all three, with tools, through the translation.

Not checked: images, thinking, long contexts or parallel tool calls on a non-Claude model, or any other model on the list.

### Text generation's model

Text generation uses `anthropic/claude-haiku-5-5` unless a thread's own model selection or the Environment's text-generation setting names another. The proxy must serve that id, or the setting must name one it does serve: there is no search for a small model.

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
   - `bun run --cwd infra ci:setup` creates the variable, reading `MODEL_PROXY_URL` from `~/.config/t3flare/dev.env`.
   - It does not set the key. Set it yourself, once and again after a rotation: `gh secret set MODEL_PROXY_API_KEY --env bump --repo <owner>/<repo>` (the value on stdin).
   - [`.github/workflows/bump.yml`](../.github/workflows/bump.yml) passes both to the deploy.

An Environment started without them answers text generation with "The model proxy is not configured." and lists only the static models; a Session cannot run a turn.

## Another Anthropic-compatible endpoint

**Untested.** What was checked is that the requests above are ordinary Anthropic Messages requests (read in pi-ai's `anthropic-messages` implementation and the Anthropic SDK it uses: `x-api-key`, `anthropic-version: 2023-06-01`, `/v1/messages?beta=true`), so any endpoint that serves that API with an API key is a candidate, Anthropic's own (`https://api.anthropic.com`) included. Nothing was run against anything but Commissary. Two things are unverified and likely differ:

- The plain list request carries no `anthropic-version`, which Anthropic's API requires: it would be refused, and t3flare would use the Anthropic-shaped list alone (this path is covered by a unit test with a fake proxy, not by a real endpoint).
- An endpoint that translates nothing serves only its own models, and a model it lists that the Anthropic Messages API does not serve will fail on its first turn.

Anthropic's terms for subscription tokens used by a third-party harness are the owner's risk (ADR-0012).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Text generation: "The model proxy returned HTTP 401" | The key is wrong, revoked or expired; create a new one and redeploy (or rotate the `bump` secret) |
| HTTP 404 on turns | `MODEL_PROXY_URL` ends in `/v1`, or points at the control panel's host rather than the client API's |
| A redirect to `cloudflareaccess.com` | The URL is behind Access: use Commissary's API host |
| The picker shows only four Claude models | The proxy's list has not been read: it failed (wrong key or URL) or the Environment has not checked yet; run the first two checks above |
| A new model on the proxy is missing | The picker's copy is up to 15 minutes old; a Session reads it again when a turn names a model it lacks |
| A model in the list answers 400/404 on a turn | The key's org cannot reach that provider; check the proxy's Accounts and Models pages |
