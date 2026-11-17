# SPI-1176: the owner's setup step after the hard cut (prod)

The merge of SPI-1176 deploys prod without any Model proxy setting. From that deploy until you add a Model endpoint in
prod's Harness panel, **no agent can run a turn**. Do the steps below right after the deploy finishes (the
`Deploy prod` workflow's run on `main`); they take a few minutes and need no redeploy. The guide is
[`docs/model-endpoints.md`](../model-endpoints.md).

## Before you say "cut"

1. **Put `T3FLARE_MODEL_ENDPOINT` in `~/.config/t3flare/dev.env`** if it is not there yet (its format:
   [`docs/model-endpoints.md`, "The stages' Model endpoint"](../model-endpoints.md#the-stages-model-endpoint)). Until now
   a laptop and `ci:setup` derived Commissary's endpoint from `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`; nothing does
   after the cut. Commissary's, written out:
   `{"id":"commissary","label":"Commissary","api":"anthropic-messages","baseUrl":"<your Commissary API host>","apiKey":"cms_…","match":"^claude-"}`.
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
     `COMMISSARY_MANAGEMENT_*`/`COMMISSARY_ACCESS_*`/`COMMISSARY_USAGE_PRINCIPALS` lines. (The per-ticket stage scripts
     `p1162`–`p1172` read `MODEL_PROXY_URL`/`MODEL_PROXY_API_KEY` from the shell to make Commissary endpoints; `p1176`
     reads them from `dev.env`. Keep the two lines if you want to rerun those; nothing deployed reads them.)
   - **In Commissary**: revoke `COMMISSARY_CONTAINER_API_KEY`'s key (the CLI agents' key; nothing uses it), and the
     management key you issued for t3flare's Usage page, if any. Keep the key your endpoints now use.

## What breaks until you have done it

- **Every agent kind**: until an endpoint lists a model, Pi Durable and each CLI show "Needs attention" pointing to the
  Harness panel; a Pi Durable turn fails "No Model endpoint is set up …"; a Codex, Claude Code, OpenCode or Pi thread is
  refused at its start, naming the API it needs. Codex needs an OpenAI Responses endpoint (or a ChatGPT sign-in) even
  when the others work.
- **Text generation** (thread titles, commit messages, PR text) fails "No Model endpoint is set up …".
- **The Guardian** (if on) blocks every call it reviews ("no Model endpoint lists a model for it"), so turns with risky
  tools stop at it; **prompt suggestions** stay empty; **`web_search`** (if on) says no Anthropic Messages endpoint can
  search.
- **The nightly bump**: its real turn and CLI acceptance fail until the `bump` environment has `T3FLARE_MODEL_ENDPOINT`
  (step 4); with it, they run on that endpoint.
- **The Usage page and limit meters** lose Commissary's half: they show t3flare's own records (every endpoint, since
  SPI-1173) and the subscription endpoints' meters; the proxy's earlier traffic, which only Commissary's log had, is no
  longer on the page.

## What carries over

- Threads from before the cut keep working once an endpoint is there: a model selection from before the cut
  (`anthropic/…`, Codex's and Claude Code's bare ids) runs on the default model, the first endpoint's first model. Pick
  another in the thread to change it. **Exception:** a Codex thread started on the proxy cannot move to an endpoint
  (Codex keeps its provider in its rollout): start a new Codex thread.
- The Harness settings: a Guardian, Advisor or web-search model setting from before the cut (`claude-haiku-5-5`) reads
  as `default` (the endpoints' small model; the Advisor follows the thread). Set an `<endpointId>/<modelId>` in the
  Harness panel to choose another.
