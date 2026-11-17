# Model endpoints

**Every model call t3flare makes goes to a Model endpoint you set up in the Harness panel.** An endpoint is one of your
own ways to reach models: an API pi-ai speaks, at a base URL, with an API key, a subscription sign-in or no auth, and the
models it serves ([ADR-0034](adr/0034-model-endpoints-are-the-owners-set-in-the-harness-panel.md)). t3flare has no
other way to reach a model: no Model proxy, no key of its own in a Worker setting (the hard cut, SPI-1176; until then a
Model proxy, Commissary, served every model, [ADR-0012](adr/0012-all-model-access-goes-through-the-model-proxy.md)).

A new Environment has no endpoint, so it starts in the **setup state**: every agent's provider shows **Needs attention**
with "No Model endpoint is set up: add one in the Harness panel (/_t3flare/harness), under Model endpoints." (each CLI
agent names the API it needs), and a CLI agent's thread is refused at its start, saying so. Do the setup step below once.

## The setup step

1. Open the Harness panel at `https://<your t3 host>/_t3flare/harness` (behind Cloudflare Access, as the owner) and go to
   **Model endpoints**.
2. **Add an endpoint** for each way you reach models:
   - **An API key**: pick a preset (Anthropic API, OpenAI API, OpenRouter) or **Custom** (any OpenAI-compatible
     Completions, OpenAI Responses, Anthropic Messages, Google Generative AI or Mistral API at a public `https` base
     URL). Give it an id (lowercase, immutable once saved: it is the first half of every model's slug,
     `<endpointId>/<modelId>`), a label, the key, optional headers, and its models: **Read the list** from the endpoint,
     or type ids. The key is sealed at rest and never shown again (ADR-0034 §4).
   - **Before you save, edit the Models field**: keep only models the endpoint answers, one id a line, **the model you
     want as the default first**. The first model of the first endpoint is the default for every new thread and every
     old selection ([below](#models-t3flare-picks-for-you)). Read model list fills the field with everything the
     endpoint lists, which can include models its server no longer answers: Commissary's list starts with dated ones
     (`claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219`) that it answers with 503. For an endpoint already
     saved, **Edit** it and fix the Models field the same way.
   - **A subscription sign-in**: ChatGPT (plan usage), Claude (a Pro or Max plan, Claude Code's sign-in) or GitHub
     Copilot. Start the sign-in, complete it in your browser, paste what the vendor shows when asked. The Environment
     keeps and refreshes the tokens ([ADR-0018](adr/0018-the-environment-do-is-the-credential-broker-and-each-environment-signs-in-itself.md)).
     Claude's and Copilot's terms-of-service risk is yours.
   - **No auth**: an endpoint that needs no key (a gateway of your own).
3. Turn on the agents you use (t3's Settings → Providers): Pi Durable, Codex, Claude Code, OpenCode, Pi.
4. Optionally, add Commissary's MCP tools as a direct server ([below](#commissary)).

That's all: every agent's picker lists the models of the endpoints whose API it speaks, at once, and a running thread
takes a change at its next turn. Nothing is redeployed.

### Which agent uses which endpoint

| Agent | Endpoints it runs on | How |
| --- | --- | --- |
| **Pi Durable** | every endpoint, every API | pi-ai in its Session, the key asked of the Environment at use time |
| **Codex** | OpenAI Responses endpoints, and a ChatGPT sign-in | the model relay, one Codex provider per endpoint ([ADR-0016](adr/0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)) |
| **Claude Code** | Anthropic Messages endpoints, and a Claude sign-in | the model relay's model-routed URL |
| **OpenCode** | Anthropic Messages, OpenAI Responses and OpenAI-compatible Completions endpoints, and every sign-in | the model relay, one OpenCode provider per endpoint |
| **Pi** (the CLI) | every endpoint, and every sign-in | the model relay, one pi provider per endpoint |

A CLI agent never holds an endpoint's credential: its process gets a per-process handle, which the Workers swap for the
key or token outside the Container (ADR-0016's model relay refinements). An endpoint must list at least one model to
count.

### Models t3flare picks for you

- **The default model** of a new thread is the first model of the first endpoint that lists one (each CLI: of the first
  endpoint it runs on). It is whatever you put first in the Models field: nothing checks that the endpoint answers it,
  so put a working model there (the setup step).
- **An old selection** (the Model proxy's `anthropic/<id>`, a bare model id such as Codex's `gpt-6-luna` or Claude
  Code's `claude-opus-5-5`, or `default`) runs on that default model, for every agent, even where an endpoint lists a
  model of the same id: no endpoint answers for an old selection by accident (ADR-0034 §3). Nothing is refused for it. A
  slug of an endpoint you removed is not one: its turn fails saying the endpoint is gone.
- **Text generation** (thread titles, commit messages, PR text) runs on the model t3's text-generation setting names.
  While you have picked none, the setting names the default: a small model (haiku, mini, nano, flash, lite, small,
  tiny) of the first endpoint that has one, its cheapest by known price, else the default model. It follows your
  endpoints as they change (ADR-0034 §5).
- **The Guardian, prompt suggestions and `web_search`** use the same small model unless the Harness panel names another
  (`<endpointId>/<modelId>` in the extension's Model setting). `web_search` needs an Anthropic Messages endpoint with an
  API key or no auth whose server takes Anthropic's web search tool (Anthropic's API, Commissary). The Advisor follows
  the thread's model unless you name one.

## Usage limits and failures

A failed answer is classified by its endpoint's API and auth, from what the vendor documents as machine-readable (the
status, the error's type and code, the reset headers), never its prose (ADR-0034 §8). A usage limit pauses the thread
until its reset ("Usage limit reached", auto-resume when the client has it on); a refused key or sign-in names the
endpoint and says what to do in the Harness panel; overload and 5xx are retried. Nothing falls back to another endpoint.

## Usage and limits (t3's Usage page and limit meters)

t3's Usage page counts every endpoint's tokens and cost from t3flare's own records, kept in the Environment, for every
agent (SPI-1173); the limit meters show a subscription endpoint's windows read from its answers' headers (SPI-1174).
Nothing is read from a vendor's or Commissary's management API.

## Commissary

[Commissary](https://github.com/spiritledsoftware/commissary) is an endpoint like any other since the hard cut:

- **Its models**: add it as an **Anthropic Messages** endpoint at its client API host (the API host if you set
  `COMMISSARY_API_DOMAIN`, else the app host; never behind Access), with a Commissary API key (`cms_…`). For Codex, add
  it a second time as an **OpenAI Responses** endpoint at `<host>/v1` with the same key: Codex speaks only Responses.
  Read each one's list (an endpoint at Commissary reads Commissary's alias for a non-Claude model back to its real id),
  then **narrow it before saving**: drop the dated models Commissary lists first and no longer answers, and put the
  model you want as the default first, e.g. `claude-sonnet-<version>`, `claude-haiku-<version>` on the Anthropic
  Messages endpoint.
- **Its MCP tools**: Commissary's MCP endpoint is not built in (SPI-1160; ADR-0028's SPI-1160 refinement). Add it in the
  Harness panel's **MCP servers** as a direct server:
  1. **A key.** Create a Commissary API key with a tool scope of the toolkits t3flare should see. Use a key of its own,
     not the one your model endpoints use.
  2. **Add the server.** **Add server**: name `commissary` (its tools are then `mcp__commissary__<tool>`); URL
     `https://<api host>/mcp`, narrowed with `?toolkits=a,b` if you like; sign-in **Header**, name `x-api-key`, value the
     key. It is stored write-only and never enters a Container.
  3. **Test** lists its tools.

  The same from a script: `POST /_t3flare/harness/api/mcp/servers` on the t3 host, through Access with a service token
  and the admin token, with the body `{"server": "commissary", "url": "https://<api host>/mcp", "auth": {"kind":
  "header", "header": "x-api-key"}, "value": "<key>"}`, then `POST /_t3flare/harness/api/mcp/test` with
  `{"server": "commissary"}`. `apps/environment/scripts/commissaryMcp.ts add` does this on a throwaway stage
  (`T3FLARE_MCP_API_URL` and `T3FLARE_MCP_KEY` exported inline).
  - **No Commissary approval rules on it** (OD-T3): t3flare asks by each thread's mode; Commissary's rules would ask a
    second time.
  - **Classes** come from each tool's read-only hint; fix a wrong one in Commissary, or for t3flare alone in the panel.
  - **Limits**: calls end after 240 s (Commissary's upstream cap); progress and upstream elicitation are not passed on.

## The stages' Model endpoints

SPI-1175. After each deploy, `stage.ts` saves the stage's Model endpoints through the Harness panel's own API
(`/_t3flare/harness/api/endpoints`, with the stage's Access service token and admin token), and the acceptance test does
the same before its turns; its real turn then runs on the first endpoint's small model. They are one setting,
`T3FLARE_MODEL_ENDPOINT`, a JSON object holding an endpoint and its key, or a list of them
([`apps/environment/scripts/lib/modelEndpointSpec.ts`](../apps/environment/scripts/lib/modelEndpointSpec.ts)):

```sh
T3FLARE_MODEL_ENDPOINT='{"id":"openai","label":"OpenAI","api":"openai-responses","baseUrl":"https://api.openai.com/v1","apiKey":"sk-…","models":["gpt-5-mini"]}'
```

One endpoint speaks one API, and each CLI agent needs its own (Claude Code: Anthropic Messages; Codex: OpenAI
Responses; OpenCode and pi: either). For every agent, as the nightly bump runs them, give a list with one of each:

```sh
T3FLARE_MODEL_ENDPOINT='[{"id":"anth","api":"anthropic-messages","baseUrl":"https://<host>","apiKey":"<key>","models":["claude-sonnet-<version>","claude-haiku-<version>"]},{"id":"resp","api":"openai-responses","baseUrl":"https://<host>/v1","apiKey":"<key>","models":["claude-sonnet-<version>"]}]'
```

The acceptance test fails by name on a CLI it is asked to run (`--codex` …) that no endpoint serves.

- `id`, `baseUrl` and `apiKey` are required; `label` defaults to the id, `api` to `anthropic-messages`, `headers` to none.
- `models` is saved in its order, the first the default model. Without it, the endpoint's own list is read through the
  panel, keeping the ids the regular expression `match` matches, when given, in the endpoint's order: name `models`
  for an endpoint whose list starts with models it does not answer.
- The panel validates the rest as it does the owner's form: an https URL at a public host, an id that is not reserved
  (`anthropic`, kept for the Model proxy's old selections, and `default`).

Where it comes from:

- **A laptop:** `T3FLARE_MODEL_ENDPOINT` in the environment or `~/.config/t3flare/dev.env`. Without it, a stage deploys
  in the setup state and says so.
- **CI:** the GitHub secret `T3FLARE_MODEL_ENDPOINT` on the `bump` and `prod` environments, set by
  `pnpm --filter @t3flare/infra run ci:setup` from `dev.env`. Run `ci:setup` again after changing the endpoint or
  rotating its key. Without the secret, a deploy and the acceptance test skip the endpoint and say so, and the bump's
  real turn fails: the stage has no model.
- **prod** gets each endpoint only when it has none of that id: what the owner changes in the panel stays. A removed one
  comes back at the next deploy while the secret is set; delete the secret to stop that.

A setting that is set but unusable fails the deploy before the Workers are built. In CI, the workflows' first step after
the setup (`apps/environment/scripts/mask-endpoint.ts`) masks its key and each header value on their own, and
`bump-report.json` and the acceptance report are written with them scrubbed.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| A provider shows **Needs attention**: "No Model endpoint is set up …" or "<agent> has no Model endpoint to run on …" | No endpoint lists a model of an API that agent speaks: do the setup step; for Codex, add an OpenAI Responses endpoint |
| A Pi Durable turn fails "No Model endpoint is set up …" | The same, for a thread from before the hard cut that found no endpoint to fall back to |
| "The model <slug> is not available: its Model endpoint was removed or no longer lists it" | The thread's model is gone: pick another |
| "The Model endpoint "<id>" refused its API key …" | The key is wrong, revoked or out of scope: enter it again in the panel |
| "… is not signed in to <vendor> …" | The sign-in was signed out or its renewal refused: sign in again in the panel |
| "Usage limit reached" naming an endpoint | That endpoint's limit; the thread resumes at the reset, or pick another endpoint's model |
| An old Codex thread fails "this Codex thread runs on another Model endpoint than …" | Codex cannot move a live thread between Model endpoints: start a new thread |
| `web_search` says no Anthropic Messages endpoint can search | Add one with an API key (or set the search model to one) |
