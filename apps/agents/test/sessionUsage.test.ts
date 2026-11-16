// @effect-diagnostics globalTimers:off
// A Session's usage records (SPI-1173): every assistant message a model call on a Model endpoint answers (a turn's,
// compaction's, an extension's: they all go through the Session's models) is recorded with pi-ai's usage and cost, under
// the Durable agent, the endpoint, the model and the Session; text generation records its own the same way.
import { createModels } from "@earendil-works/pi-ai";
import type { ModelEndpoint } from "@t3flare/models/endpoints";
import type { UsageEntry } from "@t3flare/models/usage";
import { describe, expect, it } from "vitest";

import { generateEndpointText } from "../src/endpointText.ts";
import { SessionEndpoints } from "../src/session/endpoints.ts";

const model = (id: string, cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text" as const],
  contextWindow: 200_000,
  maxTokens: 1_000,
  cost,
  known: true,
});

const endpoint: ModelEndpoint = {
  id: "gw",
  label: "GW",
  api: "anthropic-messages",
  baseUrl: "https://gw.example",
  auth: "api-key",
  headers: {},
  models: [model("claude-haiku-5-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }), model("house-model", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })],
};

/** Anthropic's stream for one short answer with the usage given. */
const answer = (modelId: string, usage: Record<string, number>) =>
  new Response(
    [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens ?? 1 } },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const sessionWith = (fetcher: typeof fetch) => {
  const recorded: Array<UsageEntry> = [];
  const models = createModels();
  const map = new Map<string, unknown>();
  const endpoints = new SessionEndpoints({
    kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) },
    models,
    fetch: fetcher,
    readMs: 50,
    now: () => 5_000,
    source: () => ({ modelEndpoints: async () => ({ revision: 1, endpoints: [endpoint] }), endpointCredential: async () => ({ apiKey: "sk-gw" }) }),
    usage: { session: () => "session-1", record: (entry) => void recorded.push(entry) },
  });
  return { recorded, models, endpoints };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a Session's usage records", () => {
  it("records each answer on an endpoint with pi-ai's usage, and its cost when the model has a price", async () => {
    const usage = { input_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 400 };
    const { recorded, models, endpoints } = sessionWith((async () => answer("claude-haiku-5-5", usage)) as unknown as typeof fetch);
    await endpoints.take();
    const message = await models.completeSimple(models.getModel("gw", "claude-haiku-5-5")!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    await settle();
    expect(recorded).toEqual([
      {
        agent: "durable",
        endpointId: "gw",
        modelId: "claude-haiku-5-5",
        at: message.timestamp,
        session: "session-1",
        input: 1_000,
        cacheRead: 10_000,
        cacheWrite: 2_000,
        output: 400,
        reasoning: 0,
        // $1/M input, $5/M output, $0.10/M cache reads, $1.25/M cache writes.
        costUsd: expect.closeTo(0.001 + 0.002 + 0.001 + 0.0025, 9),
      },
    ]);
  });

  it("leaves the cost to the Environment for a model with no price, and records nothing for a refused request", async () => {
    let refuse = false;
    const { recorded, models, endpoints } = sessionWith((async () =>
      refuse ? Response.json({ type: "error", error: { type: "authentication_error", message: "no" } }, { status: 401 }) : answer("house-model", { input_tokens: 30, output_tokens: 7 })) as unknown as typeof fetch);
    await endpoints.take();
    const house = models.getModel("gw", "house-model")!;
    await models.completeSimple(house, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    refuse = true;
    await models.completeSimple(house, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    await settle();
    expect(recorded).toMatchObject([{ agent: "durable", modelId: "house-model", input: 30, output: 7, costUsd: null }]);
    expect(recorded).toHaveLength(1);
  });

  it("text generation records its own answer, under text generation", async () => {
    const recorded: Array<UsageEntry> = [];
    const result = await generateEndpointText(
      { endpointId: "gw", modelId: "claude-haiku-5-5", prompt: "title" },
      {
        endpoints: async () => ({ revision: 1, endpoints: [endpoint] }),
        credential: async () => ({ apiKey: "sk-gw" }),
        fetch: (async () => answer("claude-haiku-5-5", { input_tokens: 50, output_tokens: 6 })) as unknown as typeof fetch,
        usage: (entry) => void recorded.push(entry),
      },
    );
    expect(result).toEqual({ ok: true, text: "ok" });
    expect(recorded).toMatchObject([{ agent: "text-generation", endpointId: "gw", modelId: "claude-haiku-5-5", session: "", input: 50, output: 6 }]);
  });
});
