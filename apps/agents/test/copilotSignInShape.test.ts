// The GitHub Copilot sign-in's pins on pi-ai (SPI-1166; docs/upstream-fragility.md U82):
// - the device flow and the Copilot token exchange the Environment runs itself (credentials/copilot.ts) use the client,
//   URLs, scope, bodies and headers of pi-ai's own Copilot flow, checked by running pi-ai's `login()` and `refresh()`
//   against a stand-in fetch; and pi-ai's per-token base URL (`toAuth`) is ours (`copilotBaseUrl`);
// - a request on a Copilot sign-in endpoint, its token's base URL and editor headers from the Credential broker, is on
//   the wire what pi-ai's own `github-copilot` provider sends for the same model and context: the URL, every header and
//   the body, with the thinking level off and on, from the owner and after a tool call.
// A pi-ai bump that changes any of these fails here.
import { type Context, type Credential, type CredentialStore, createModels, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { GITHUB_COPILOT_MODELS } from "@earendil-works/pi-ai/providers/github-copilot.models";
import {
  COPILOT_CLIENT_ID,
  COPILOT_HEADERS,
  COPILOT_LIST_HEADERS,
  COPILOT_SCOPE,
  COPILOT_TOKEN_URL,
  COPILOT_USER_AGENT,
  copilotBaseUrl,
  DEVICE_GRANT_TYPE,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
} from "@t3flare/models/copilotOAuth";
import { endpointModelOf, type ModelEndpoint, SIGN_IN_KINDS } from "@t3flare/models/endpoints";
import { knownModel } from "@t3flare/models/known";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionEndpoints } from "../src/session/endpoints.ts";
import { endpointProviders } from "../src/session/models.ts";

afterEach(() => vi.unstubAllGlobals());

const TOKEN = "tid=abc;exp=4000000000;sku=copilot_pro;proxy-ep=proxy.business.githubcopilot.com;8kp=1:sig";
const lower = (headers: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const record = (seen: Array<Seen>, answer: (url: string) => Response) =>
  (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()), body: await request.text() });
    return answer(request.url);
  }) as FetchFunction;

/** A Responses stream answering "ok". */
const responsesOk = (): Response => {
  const response = { id: "resp_1", object: "response", status: "completed", model: "gpt-6.1-sol", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, output: [item] } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};

const MODEL_ID = "gpt-6.1-sol";
/** A model whose "off" thinking level pi-ai sends to other providers as an effort (`thinkingLevelMap.off: "none"`). */
const OFF_EFFORT_ID = "gpt-6-luna";
const kind = SIGN_IN_KINDS.copilot;

/** The Copilot sign-in endpoint as the panel saves it: the stand-in base URL, no headers, pi-ai's metadata for its models. */
const COPILOT: ModelEndpoint = {
  id: "copilot",
  label: "GitHub Copilot",
  api: kind.api,
  baseUrl: kind.baseUrl,
  auth: "copilot",
  headers: {},
  models: [MODEL_ID, OFF_EFFORT_ID].map((id) => endpointModelOf({ id }, knownModel(id, { api: kind.api, baseUrl: kind.baseUrl }))),
};

const tool = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
const FROM_OWNER: Context = { systemPrompt: "Be brief.", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [tool as never] };
const AFTER_TOOL: Context = {
  ...FROM_OWNER,
  messages: [
    ...FROM_OWNER.messages,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1|fc_1", name: "bash", arguments: { command: "ls" } }],
      api: "openai-responses",
      provider: "x",
      model: MODEL_ID,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    },
    { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 2 },
  ],
};

/** One request on our Copilot sign-in endpoint, its credential as the Environment gives it. */
const ours = async (context: Context, reasoning?: "high", modelId = MODEL_ID): Promise<Seen> => {
  const seen: Array<Seen> = [];
  const models = createModels();
  const credential = { apiKey: TOKEN, expiresAt: 4_000_000_000_000, baseUrl: copilotBaseUrl(TOKEN)!, headers: COPILOT_HEADERS };
  for (const provider of endpointProviders({ revision: 1, endpoints: [COPILOT] }, { credential: async () => credential, fetch: record(seen, responsesOk) })) models.setProvider(provider);
  const message = await models.completeSimple(models.getModel("copilot", modelId)!, context, { maxTokens: 500, ...(reasoning === undefined ? {} : { reasoning }) });
  expect(message.errorMessage).toBeUndefined();
  expect(seen).toHaveLength(1);
  return seen[0]!;
};

/** The same request on pi-ai's own `github-copilot` provider, signed in with the same Copilot token. */
const piAis = async (context: Context, reasoning?: "high", modelId = MODEL_ID): Promise<Seen> => {
  const seen: Array<Seen> = [];
  const stored: Credential = { type: "oauth", access: TOKEN, refresh: "ghu_github", expires: 4_000_000_000_000 };
  const credentials: CredentialStore = {
    read: async () => stored,
    list: async () => [{ providerId: "github-copilot", type: "oauth" }],
    modify: async () => stored,
    delete: async () => undefined,
  };
  const models = createModels({ credentials });
  models.setProvider(githubCopilotProvider());
  const model = GITHUB_COPILOT_MODELS[modelId as keyof typeof GITHUB_COPILOT_MODELS] as Model<"openai-responses">;
  const message = await models.completeSimple(model, context, { maxTokens: 500, fetch: record(seen, responsesOk), ...(reasoning === undefined ? {} : { reasoning }) });
  expect(message.errorMessage).toBeUndefined();
  expect(seen).toHaveLength(1);
  return seen[0]!;
};

describe("a GitHub Copilot sign-in on pi-ai", () => {
  it("runs pi-ai's own device flow and Copilot token exchange with the client, URLs, bodies and headers the Environment's flow uses", async () => {
    const seen: Array<Seen> = [];
    vi.stubGlobal(
      "fetch",
      record(seen, (url) => {
        if (url === GITHUB_DEVICE_CODE_URL) return Response.json({ device_code: "dc_1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 });
        if (url === GITHUB_ACCESS_TOKEN_URL) return Response.json({ access_token: "ghu_github", token_type: "bearer", scope: "" });
        if (url === COPILOT_TOKEN_URL) return Response.json({ token: TOKEN, expires_at: 4_000_000_000 });
        return Response.json({ data: [] });
      }),
    );
    const oauth = githubCopilotProvider().auth.oauth!;
    const shown: Array<{ readonly type: string; readonly userCode?: string; readonly verificationUri?: string }> = [];
    const credential = await oauth.login({
      signal: new AbortController().signal,
      notify: (event: { readonly type: string }) => void shown.push(event),
      // github.com, not an Enterprise domain.
      prompt: async () => "",
    } as never);
    expect(shown[0]).toMatchObject({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    const [device, poll, exchange, list] = seen;
    const form = { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": COPILOT_USER_AGENT };
    expect(device).toMatchObject({ url: GITHUB_DEVICE_CODE_URL, method: "POST", headers: form });
    expect(Object.fromEntries(new URLSearchParams(device!.body))).toEqual({ client_id: COPILOT_CLIENT_ID, scope: COPILOT_SCOPE });
    expect(poll).toMatchObject({ url: GITHUB_ACCESS_TOKEN_URL, method: "POST", headers: form });
    expect(Object.fromEntries(new URLSearchParams(poll!.body))).toEqual({ client_id: COPILOT_CLIENT_ID, device_code: "dc_1", grant_type: DEVICE_GRANT_TYPE });
    expect(exchange).toMatchObject({ url: COPILOT_TOKEN_URL, method: "GET" });
    expect(exchange!.headers).toEqual({ accept: "application/json", authorization: "Bearer ghu_github", ...lower(COPILOT_HEADERS) });
    // The model list: at the token's base URL, with the editor headers and the API version.
    expect(list!.url).toBe(`${copilotBaseUrl(TOKEN)}/models`);
    expect(list!.headers).toEqual({ accept: "application/json", authorization: `Bearer ${TOKEN}`, ...lower(COPILOT_HEADERS), ...lower(COPILOT_LIST_HEADERS) });
    // The GitHub token is the refresh, the Copilot token the access.
    expect(credential).toMatchObject({ type: "oauth", refresh: "ghu_github", access: TOKEN });

    seen.length = 0;
    await oauth.refresh({ type: "oauth", access: TOKEN, refresh: "ghu_github", expires: 0 }, new AbortController().signal);
    expect(seen[0]).toMatchObject({ url: COPILOT_TOKEN_URL, method: "GET", headers: { accept: "application/json", authorization: "Bearer ghu_github", ...lower(COPILOT_HEADERS) } });
  });

  it("derives the base URL from the Copilot token as pi-ai does", async () => {
    const oauth = githubCopilotProvider().auth.oauth!;
    for (const token of [TOKEN, "tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;", "tid=1;exp=2;proxy-ep=proxy.enterprise.githubcopilot.com", "tid=1;exp=2"]) {
      const auth = await oauth.toAuth!({ type: "oauth", access: token, refresh: "ghu", expires: 0 });
      expect(copilotBaseUrl(token), token).toBe(auth.baseUrl);
    }
    // Ours refuses a host outside GitHub Copilot's domain, which pi-ai would send the token to.
    expect(copilotBaseUrl("tid=1;proxy-ep=proxy.evil.example;")).toBeUndefined();
  });

  it("has pi-ai's editor headers on every model of its Copilot catalog", () => {
    for (const model of Object.values(GITHUB_COPILOT_MODELS)) expect((model as { readonly headers?: unknown }).headers).toEqual(COPILOT_HEADERS);
  });

  it("sends what pi-ai's own Copilot provider sends: the URL, every header and the body", async () => {
    for (const [context, reasoning, modelId] of [
      [FROM_OWNER, undefined, MODEL_ID],
      [FROM_OWNER, "high", MODEL_ID],
      [AFTER_TOOL, undefined, MODEL_ID],
      [FROM_OWNER, undefined, OFF_EFFORT_ID],
      [FROM_OWNER, "high", OFF_EFFORT_ID],
    ] as const) {
      const [mine, theirs] = [await ours(context, reasoning, modelId), await piAis(context, reasoning, modelId)];
      expect(mine.url).toBe("https://api.business.githubcopilot.com/responses");
      expect(mine.url).toBe(theirs.url);
      expect(mine.headers).toEqual(theirs.headers);
      expect(JSON.parse(mine.body)).toEqual(JSON.parse(theirs.body));
    }
  });

  it("marks who started each request, and sends the token where it says with the editor headers", async () => {
    const owner = await ours(FROM_OWNER);
    expect(owner.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "x-initiator": "user", "openai-intent": "conversation-edits", ...lower(COPILOT_HEADERS) });
    expect((await ours(AFTER_TOOL)).headers).toMatchObject({ "x-initiator": "agent" });
    // With the thinking level off no reasoning goes (pi-ai's rule for Copilot), even for a model with an "off" effort;
    // on, its effort does.
    expect(JSON.parse(owner.body)).not.toHaveProperty("reasoning");
    expect(JSON.parse((await ours(FROM_OWNER, undefined, OFF_EFFORT_ID)).body)).not.toHaveProperty("reasoning");
    expect(JSON.parse((await ours(FROM_OWNER, "high")).body)).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("sends a Copilot token only to a base URL its kind allows: one outside githubcopilot.com goes to the stand-in, without the headers", async () => {
    for (const baseUrl of ["https://evil.example", "https://api.evilgithubcopilot.com", "http://api.business.githubcopilot.com"]) {
      const seen: Array<Seen> = [];
      const models = createModels();
      const credential = { apiKey: TOKEN, expiresAt: 4_000_000_000_000, baseUrl, headers: { ...COPILOT_HEADERS, "X-Extra": "1" } };
      for (const provider of endpointProviders({ revision: 1, endpoints: [COPILOT] }, { credential: async () => credential, fetch: record(seen, responsesOk) })) models.setProvider(provider);
      await models.completeSimple(models.getModel("copilot", MODEL_ID)!, FROM_OWNER, { maxTokens: 500 });
      expect(seen[0]!.url, baseUrl).toBe(`${kind.baseUrl}/responses`);
      expect(seen[0]!.headers).not.toHaveProperty("x-extra");
    }
  });

  it("takes no base URL or headers from a credential for an endpoint whose token does not name them", async () => {
    const seen: Array<Seen> = [];
    const models = createModels();
    const chatgpt: ModelEndpoint = { ...COPILOT, id: "chatgpt", auth: "chatgpt", baseUrl: "https://api.openai.com/v1" };
    const credential = { apiKey: "at-token", expiresAt: 4_000_000_000_000, baseUrl: "https://elsewhere.example", headers: { "X-Extra": "1" } };
    for (const provider of endpointProviders({ revision: 1, endpoints: [chatgpt] }, { credential: async () => credential, fetch: record(seen, responsesOk) })) models.setProvider(provider);
    await models.completeSimple(models.getModel("chatgpt", MODEL_ID)!, FROM_OWNER, { maxTokens: 500 });
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]!.headers).not.toHaveProperty("x-extra");
  });

  it("in a Session: keeps each token with where it goes, takes a renewed token's host, and drops it on a 401", async () => {
    const clock = 1_000_000;
    const seen: Array<Seen> = [];
    let status = 200;
    const tokens = [TOKEN, "tid=2;exp=4000000000;proxy-ep=proxy.individual.githubcopilot.com;"];
    let asked = 0;
    const models = createModels();
    const map = new Map<string, unknown>();
    const endpoints = new SessionEndpoints({
      usage: { session: () => "s", record: () => undefined },
      limits: () => undefined,
      kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) },
      models,
      fetch: record(seen, () => (status === 200 ? responsesOk() : Response.json({ error: { message: "unauthorized" } }, { status }))),
      readMs: 50,
      now: () => clock,
      source: () => ({
        modelEndpoints: async () => ({ revision: 1, endpoints: [COPILOT] }),
        endpointCredential: async () => {
          const token = tokens[Math.min(asked, tokens.length - 1)]!;
          asked += 1;
          // Each Copilot token lasts about 30 minutes.
          return { apiKey: token, expiresAt: clock + 1_800_000, baseUrl: copilotBaseUrl(token)!, headers: COPILOT_HEADERS };
        },
      }),
    });
    await endpoints.take();
    const ask = () => models.completeSimple(models.getModel("copilot", MODEL_ID)!, FROM_OWNER, { maxTokens: 500 });
    await ask();
    await ask();
    // Kept in memory: asked once, sent twice to the host the first token names.
    expect(asked).toBe(1);
    expect(seen.map((entry) => entry.url)).toEqual(["https://api.business.githubcopilot.com/responses", "https://api.business.githubcopilot.com/responses"]);
    // A 401 drops it; the next request takes the renewed token, at the host it names.
    status = 401;
    await ask();
    status = 200;
    await ask();
    expect(asked).toBe(2);
    expect(seen.at(-1)).toMatchObject({ url: "https://api.individual.githubcopilot.com/responses", headers: { authorization: `Bearer ${tokens[1]}` } });
    expect(JSON.stringify([...map.entries()])).not.toContain("tid=");
  });
});
