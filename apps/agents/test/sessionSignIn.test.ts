// A Session on a sign-in endpoint (SPI-1164; ADR-0018): it asks the Environment (the Credential broker) for the access
// token at use time and keeps it in memory only, no later than shortly before its expiry, so a long turn picks up the
// refreshed token at its next request; it drops the token on a 401 and on the endpoint's sign-out; a turn on a signed-out
// endpoint fails naming the sign-in. Its requests follow ChatGPT plan usage's rules (OpenAI's "Preview limitations").
import { createModels } from "@earendil-works/pi-ai";
import type { EndpointCredential, EndpointCredentialRequest, ModelEndpoint } from "@t3flare/models/endpoints";
import type { EndpointCredentialFailure } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { SessionEndpoints } from "../src/session/endpoints.ts";
import { PLAN_USAGE_REFUSED_FIELDS } from "../src/session/planUsage.ts";

const CHATGPT: ModelEndpoint = {
  id: "chatgpt",
  label: "ChatGPT",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: "chatgpt",
  headers: {},
  models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: false, input: ["text"], contextWindow: 400_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false }],
};

/** A Responses stream that answers `text`. */
const responsesStream = (text: string): Response => {
  const response = { id: "resp_1", object: "response", status: "completed", model: "gpt-6.1-sol", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: text },
    { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, output: [item] } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

/** A Session's endpoints over a stand-in for the broker: `answer` is what `endpointCredential` gives at each ask. */
const sessionWith = (answer: (asked: number) => EndpointCredential, reply: (sent: Sent) => Response = () => responsesStream("ok"), endpoint: ModelEndpoint = CHATGPT) => {
  let clock = 1_000_000;
  let asked = 0;
  const sent: Array<Sent> = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const entry = { url: request.url, authorization: request.headers.get("authorization"), body: JSON.parse(await request.text()) as Record<string, unknown> };
    sent.push(entry);
    return reply(entry);
  }) as typeof fetch;
  const models = createModels();
  const map = new Map<string, unknown>();
  const recorded: Array<EndpointCredentialFailure | undefined> = [];
  const endpoints = new SessionEndpoints({
    onCredential: (failure) => void recorded.push(failure),
    kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) },
    models,
    fetch: fetcher,
    readMs: 50,
    now: () => clock,
    source: () => ({
      modelEndpoints: async () => ({ revision: 1, endpoints: [endpoint] }),
      endpointCredential: async (_request: EndpointCredentialRequest) => answer((asked += 1)),
    }),
  });
  const request = async (system?: string, extra: { readonly reasoning?: "high"; readonly tools?: boolean } = {}) => {
    const tools = extra.tools === true ? [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] : undefined;
    const message = await models.completeSimple(
      models.getModel("chatgpt", endpoint.models[0]!.id)!,
      { ...(system === undefined ? {} : { systemPrompt: system }), messages: [{ role: "user", content: "hi", timestamp: 0 }], ...(tools === undefined ? {} : { tools: tools as never }) },
      { maxTokens: 500, temperature: 0.2, ...(extra.reasoning === undefined ? {} : { reasoning: extra.reasoning }) },
    );
    return message.errorMessage ?? message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  };
  return { endpoints, request, sent, map, recorded, asked: () => asked, advance: (ms: number) => void (clock += ms), now: () => clock };
};

describe("a Session on a sign-in endpoint", () => {
  it("sends the broker's access token as a bearer, with a body plan usage takes", async () => {
    const session = sessionWith(() => ({ apiKey: "at-one", expiresAt: 1_000_000 + 3_600_000 }));
    await session.endpoints.take();
    expect(await session.request("Be brief.")).toBe("ok");
    const [first] = session.sent;
    expect(first).toMatchObject({ url: "https://api.openai.com/v1/responses", authorization: "Bearer at-one" });
    expect(first!.body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
    for (const field of PLAN_USAGE_REFUSED_FIELDS) expect(first!.body, field).not.toHaveProperty(field);
    const input = first!.body.input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.role === "system")).toBe(false);
    expect(input[0]).toMatchObject({ role: "developer" });
  });

  it("keeps the token until shortly before it expires, so a long turn's next request takes the refreshed one", async () => {
    // The broker's side: the first token has 4 minutes left; once it is near its end, the broker has refreshed it.
    const session = sessionWith((asked) => (asked === 1 ? { apiKey: "at-before", expiresAt: 1_000_000 + 4 * 60_000 } : { apiKey: "at-after", expiresAt: 1_000_000 + 64 * 60_000 }));
    await session.endpoints.take();
    await session.request();
    session.advance(60_000);
    await session.request();
    // Within its time in memory and not near its expiry: not asked again.
    expect(session.asked()).toBe(1);
    // Two minutes before its expiry (well inside the five a key is kept), the same turn's next request asks again.
    session.advance(90_000);
    await session.request();
    expect(session.sent.map((entry) => entry.authorization)).toEqual(["Bearer at-before", "Bearer at-before", "Bearer at-after"]);
  });

  it("drops the token on a 401, and asks again at the next request", async () => {
    let refuse = true;
    const session = sessionWith(
      (asked) => ({ apiKey: `at-${asked}`, expiresAt: 1_000_000 + 3_600_000 }),
      () => (refuse ? Response.json({ error: { message: "bad token", type: "invalid_request_error", code: "subscription_sharing_invalid_user" } }, { status: 401 }) : responsesStream("ok")),
    );
    await session.endpoints.take();
    await session.request();
    refuse = false;
    expect(await session.request()).toBe("ok");
    expect(session.sent.map((entry) => entry.authorization)).toEqual(["Bearer at-1", "Bearer at-2"]);
  });

  it("drops the token when the endpoint is signed out", async () => {
    const session = sessionWith((asked) => ({ apiKey: `at-${asked}`, expiresAt: 1_000_000 + 3_600_000 }));
    await session.endpoints.take();
    await session.request();
    expect(session.endpoints.drop("chatgpt")).toBe(true);
    await session.request();
    expect(session.asked()).toBe(2);
  });

  it("fails a turn on a signed-out endpoint naming the sign-in, and stores no token", async () => {
    const session = sessionWith(() => ({ apiKey: null, signedOut: true, problem: "ChatGPT refused to renew the sign-in (invalid_grant): it is signed out" }));
    await session.endpoints.take();
    const error = await session.request();
    expect(error).toMatch(/The Model endpoint "chatgpt" is not signed in to ChatGPT \(ChatGPT refused to renew the sign-in \(invalid_grant\): it is signed out\): sign in with ChatGPT again in the Harness panel\./);
    expect(session.sent).toEqual([]);
    const transient = sessionWith(() => ({ apiKey: null, problem: "its ChatGPT sign-in could not be renewed yet: retry the turn" }));
    await transient.endpoints.take();
    expect(await transient.request()).toMatch(/The Model endpoint "chatgpt" could not get a ChatGPT token \(its ChatGPT sign-in could not be renewed yet: retry the turn\)/);
    // Each failure is recorded typed for the differ, and cleared once a request gets a token again.
    expect(session.recorded).toEqual([{ endpointId: "chatgpt", kind: "signed_out", message: expect.stringMatching(/is not signed in to ChatGPT/), retryable: false }]);
    expect(transient.recorded).toEqual([{ endpointId: "chatgpt", kind: "unavailable", message: expect.stringMatching(/retry the turn/), retryable: true }]);
  });

  it("keeps no token in its storage", async () => {
    const session = sessionWith(() => ({ apiKey: "at-never-stored", expiresAt: 1_000_000 + 3_600_000 }));
    await session.endpoints.take();
    await session.request();
    expect(JSON.stringify([...session.map.entries()])).not.toContain("at-never-stored");
  });

  it("sends a reasoning model's thinking level as reasoning.effort, with no configuration_update item, and tools as additional_tools", async () => {
    // gpt-6.1-sol as pi-ai's catalog has it (known.ts copies its compat): mid-conversation effort, additional_tools.
    const sol: ModelEndpoint = {
      ...CHATGPT,
      models: [
        {
          ...CHATGPT.models[0]!,
          reasoning: true,
          known: true,
          thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
          compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true, supportsExplicitPromptCacheMode: true, supportsMidConvoEffort: true },
        },
      ],
    };
    const session = sessionWith(() => ({ apiKey: "at-one", expiresAt: 1_000_000 + 3_600_000 }), undefined, sol);
    await session.endpoints.take();
    await session.request("Be brief.", { reasoning: "high", tools: true });
    const body = session.sent[0]!.body;
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.type === "configuration_update")).toBe(false);
    expect(body.reasoning).toMatchObject({ effort: "high" });
    // pi-ai declares this catalog model's tools in an additional_tools item (OpenAI's documented form for plan usage).
    expect(input.some((item) => item.type === "additional_tools")).toBe(true);
    expect(JSON.stringify(body.tools ?? [])).not.toContain("tool_search");
    for (const field of PLAN_USAGE_REFUSED_FIELDS) expect(body, field).not.toHaveProperty(field);
  });
});
