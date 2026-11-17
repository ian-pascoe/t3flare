# SPI-1176: the owner's setup step after the hard cut (prod)

The merge of SPI-1176 deploys prod without any Model proxy setting. From that deploy until you add a Model endpoint in
prod's Harness panel, **no agent can run a turn**. Do the steps below right after the deploy finishes (the
`Deploy prod` workflow's run on `main`); they take a few minutes and need no redeploy. The guide is
[`docs/model-endpoints.md`](../model-endpoints.md).

## Before you say "cut"

1. **Put `T3FLARE_MODEL_ENDPOINT` in `~/.config/t3flare/dev.env`** if it is not there yet (its format:
   [`docs/model-endpoints.md`, "The stages' Model endpoints"](../model-endpoints.md#the-stages-model-endpoints)). Until
   now a laptop and `ci:setup` derived Commissary's endpoint from `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`; nothing
   does after the cut. **For the nightly bump to pass it must cover every CLI agent**: one endpoint speaks one API, and
   the bump runs Codex (OpenAI Responses only) and Claude Code (Anthropic Messages only), so give a list of two. With
   Commissary for both, written out (placeholders, not real values):

   ```sh
   T3FLARE_MODEL_ENDPOINT='[{"id":"commissary","label":"Commissary","api":"anthropic-messages","baseUrl":"https://<Commissary API host>","apiKey":"cms_<key>","match":"^claude-"},{"id":"commissary-oai","label":"Commissary (Responses)","api":"openai-responses","baseUrl":"https://<Commissary API host>/v1","apiKey":"cms_<key>","models":["<model id>"]}]'
   ```

   The first one's small model runs the bump's real turn and is the one prod gets first. With only one endpoint the bump
   fails, naming the CLI with no endpoint for its API.
2. **Do not run `pnpm --filter @t3flare/infra run ci:setup` before the merge.** After it (step 4 below), it removes the
   proxy's GitHub variables and secrets it once set, and sets `T3FLARE_MODEL_ENDPOINT` from `dev.env` (without it in
   `dev.env`, it would also remove the `T3FLARE_MODEL_ENDPOINT` secret an earlier run derived).

## Right after the deploy

1. **Add your Model endpoints** in prod's Harness panel (`https://t3.ianpascoe.dev/_t3flare/harness` → Model endpoints →
   Add endpoint). If prod already has the `commissary` endpoint (SPI-1175's deploy adds it when the `prod` environment
   has the `T3FLARE_MODEL_ENDPOINT` secret), check it lists the models you use. For each way you reach models:
   - **Commissary for Claude Code, OpenCode, pi and Pi Durable**: an Anthropic Messages endpoint at Commissary's API host
     with a Commissary API key (`cms_…`), **Read the list**.
   - **Commissary for Codex**: Codex speaks only OpenAI Responses, so add Commissary a second time: id e.g. `commissary-oai`,
     API **OpenAI Responses**, base URL `<Commissary API host>/v1`, the same key, **Read the list**. Without an OpenAI
     Responses endpoint (or a ChatGPT sign-in), Codex stays in the setup state.
   - **Any other key** (Anthropic API, OpenAI API, OpenRouter, a custom OpenAI-compatible gateway): its preset or Custom.
   - **Subscription sign-ins** you want t3flare itself to hold (ChatGPT plan usage, a Claude Pro or Max plan, GitHub
     Copilot): Add a sign-in, complete it in the browser. Claude's and Copilot's terms-of-service risk is yours.
2. **Check the setup state is gone**: in t3's Settings → Providers, Pi Durable, Codex, Claude Code, OpenCode and Pi are
   no longer "Needs attention", and each picker lists the endpoints' models. Text generation's setting names the
   endpoints' small model unless you picked one.
3. **Commissary's MCP tools, if you want them**: Harness panel → MCP servers → Add server: name `commissary`, URL
   `https://<Commissary API host>/mcp` (narrow it with `?toolkits=…`), sign-in Header `x-api-key` with a Commissary key
   of its own, scoped to the toolkits t3flare should see; Test. Since SPI-1160 prod has none until you add it.
4. **Run `pnpm --filter @t3flare/infra run ci:setup`** (with `T3FLARE_MODEL_ENDPOINT` in `dev.env`). It sets the
   `T3FLARE_MODEL_ENDPOINT` secret on `bump` and `prod`, and removes what it set for the proxy (below).
5. **Delete the old settings** (none is read any more; t3flare deleted none of them):
   - **GitHub `prod` environment**: the secrets `MODEL_PROXY_API_KEY` and `COMMISSARY_CONTAINER_API_KEY` and the variable
     `MODEL_PROXY_URL` (step 4's `ci:setup` removes these three, which it created); the optional
     `COMMISSARY_MANAGEMENT_URL`, `COMMISSARY_MANAGEMENT_ORG`, `COMMISSARY_ACCESS_CLIENT_ID` (variables) and
     `COMMISSARY_MANAGEMENT_KEY`, `COMMISSARY_ACCESS_CLIENT_SECRET` (secrets), if you set them by hand.
   - **GitHub `bump` environment**: the variable `MODEL_PROXY_URL` (removed by `ci:setup`), and the secrets you set by
     hand: `MODEL_PROXY_API_KEY`, `COMMISSARY_CONTAINER_API_KEY`.
   - **Cloudflare**: nothing to delete by hand. The deploy no longer binds `MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY`,
     `COMMISSARY_CONTAINER_API_KEY` or `COMMISSARY_*` on the `t3flare-environment-prod` and `t3flare-agents-prod`
     Workers, and alchemy removes the bindings it no longer declares. Check in the dashboard (each Worker → Settings →
     Variables and Secrets) that none is left.
   - **`~/.config/t3flare/dev.env`**: `MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY`, `COMMISSARY_CONTAINER_API_KEY` and the
     `COMMISSARY_MANAGEMENT_*`/`COMMISSARY_ACCESS_*`/`COMMISSARY_USAGE_PRINCIPALS` lines. (The kept stage scripts
     `p1162`, `p1164`–`p1166`, `p1168`–`p1172` read `MODEL_PROXY_URL`/`MODEL_PROXY_API_KEY` from the shell as
     Commissary's URL and key, and `p1176` from `dev.env`. Keep the two lines if you want to rerun those; nothing
     deployed reads them.)
   - **In Commissary**: revoke `COMMISSARY_CONTAINER_API_KEY`'s key (the CLI agents' key; nothing uses it), and the
     management key you issued for t3flare's Usage page, if any. Keep the key your endpoints now use.

## What breaks until you have done it

- **Every agent kind**: until an endpoint lists a model, Pi Durable and each CLI show "Needs attention" pointing to the
  Harness panel; a Pi Durable turn fails "No Model endpoint is set up …"; a Codex, Claude Code, OpenCode or Pi thread is
  refused at its start, naming the API it needs. Codex needs an OpenAI Responses endpoint (or a ChatGPT sign-in) even
  when the others work.
- **Text generation** (thread titles, commit messages, PR text) fails "No Model endpoint is set up …".
- **The Guardian** (if on) blocks every call it reviews ("no Model endpoint lists a model for it"), so turns with risky
  tools stop at it; **prompt suggestions** stay empty.
- **`web_search`** (if on) works only on an **Anthropic Messages endpoint with an API key or no auth**. A setup with
  sign-ins only (ChatGPT, a Claude plan, Copilot) or with no Anthropic Messages endpoint has **no search**: the tool
  says no endpoint can search. This stays so after the setup step, not only until it. Search requests write **no usage
  record**, so they are missing from the Usage page.
- **The nightly bump**: its real turn and CLI acceptance fail until the `bump` environment's `T3FLARE_MODEL_ENDPOINT`
  secret (step 4) holds an Anthropic Messages endpoint and an OpenAI Responses endpoint (the list in "Before you say
  cut"). With one of them only, the acceptance test fails on the CLI the other would serve (Claude Code or Codex), by
  name.
- **The Usage page and limit meters** lose Commissary's half: they show t3flare's own records (every endpoint, since
  SPI-1173) and the subscription endpoints' meters; the proxy's earlier traffic, which only Commissary's log had, is no
  longer on the page.

## What carries over

Checked on a stage upgraded from `origin/main` (with the Model proxy) to this branch, one thread per agent kind
([`spi-1176/upgrade.json`](spi-1176/upgrade.json)):

- **Threads from before the cut keep working** once an endpoint is there. A model selection from before the cut
  (`anthropic/<id>`, Codex's and Claude Code's bare ids) runs on the endpoint that lists a model of that id
  (`anthropic/claude-haiku-5-5` on `commissary/claude-haiku-5-5`), else on the default model, the first endpoint's
  first model. Pi Durable, Codex, Claude Code, OpenCode and pi threads each answered their next turn, Codex's on the
  same native thread (an earlier draft of this note said a Codex thread could not move; it did).
- **Check what your endpoints list.** Commissary's list holds dated models it no longer serves, first in its order
  (`claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219`, `claude-opus-4-1-20250805`; it answers 503 or 400 for
  them). The default model is the first endpoint's first model, so with Commissary's full list an old selection that
  no endpoint names, and any thread on `default`, runs on a dead model. Narrow the endpoint to the models it serves
  (`match`, or edit its list in the panel), or put an endpoint whose first model works first. Claude Code's `sonnet`
  and `opus` aliases pick the first model of their family pi-ai knows, so they skip those dated ids.
- **Bindings**: the deploy unbinds `MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY` and `COMMISSARY_CONTAINER_API_KEY` from
  both Workers and every `COMMISSARY_*` from the Environment's (the stage's deploy log: `unbind` for each of the ten).
- The Harness settings: a Guardian, Advisor or web-search model setting from before the cut (`claude-haiku-5-5`) reads
  as `default` (the endpoints' small model; the Advisor follows the thread). Set an `<endpointId>/<modelId>` in the
  Harness panel to choose another.
