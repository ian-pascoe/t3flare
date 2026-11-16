// @effect-diagnostics globalTimers:off
// Limit readings (SPI-1174): the rate-limit headers of each answer on a Model endpoint, read where SPI-1173 records usage
// (a Session's endpoint provider, text generation, the model relay) and sent to the Environment's `recordLimits`.
import { createModels } from "@earendil-works/pi-ai";
import type { ModelEndpoint } from "@t3flare/models/endpoints";
import type { LimitReading } from "@t3flare/models/limits";
import { describe, expect, it } from "vitest";

import { generateEndpointText } from "../src/endpointText.ts";
import { limitsSender } from "../src/environment.ts";
import { SessionEndpoints } from "../src/session/endpoints.ts";
import { faultAnswer, recordingFetch } from "../src/session/proxyLimits.ts";
import { handleModelRelay, type ModelRelayDeps, type ModelRelayGrant } from "../src/workspace/modelRelay.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const IN_2H = Math.floor(NOW / 1000) + 2 * 3600;
const IN_5D = Math.floor(NOW / 1000) + 5 * 86400;

const CLAUDE_HEADERS = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-5h-reset": String(IN_2H),
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.1",
  "anthropic-ratelimit-unified-7d-reset": String(IN_5D),
  "anthropic-organization-id": "org-not-kept",
};

const CODEX_HEADERS = {
  "x-codex-primary-used-percent": "12.5",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(IN_2H),
  "x-codex-secondary-used-percent": "40",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String(IN_5D),
};

const CLAUDE_WINDOWS = [
  { id: "five_hour", usedPercent: 42, resetsAt: IN_2H * 1000, windowMinutes: 300 },
  { id: "seven_day", usedPercent: 10, resetsAt: IN_5D * 1000, windowMinutes: 10080 },
];

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 200_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: true });

const anthropicEndpoint: ModelEndpoint = { id: "claude", label: "Claude", api: "anthropic-messages", baseUrl: "https://claude.example", auth: "api-key", headers: {}, models: [model("claude-haiku-5-5")] };
const responsesEndpoint: ModelEndpoint = { id: "chatgpt", label: "ChatGPT", api: "openai-responses", baseUrl: "https://chatgpt.example/v1", auth: "api-key", headers: {}, models: [model("gpt-6.1-sol")] };

const anthropicAnswer = (headers: Record<string, string>) =>
  new Response(
    [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
  );

const responsesAnswer = (headers: Record<string, string>) => {
  const response = { id: "resp_1", object: "response", status: "completed", model: "gpt-6.1-sol", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
};

const sessionWith = (endpoint: ModelEndpoint, fetcher: typeof fetch) => {
  const readings: Array<LimitReading> = [];
  const models = createModels();
  const map = new Map<string, unknown>();
  const endpoints = new SessionEndpoints({
    kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) },
    models,
    fetch: fetcher,
    readMs: 50,
    source: () => ({ modelEndpoints: async () => ({ revision: 1, endpoints: [endpoint] }), endpointCredential: async () => ({ apiKey: "sk-test-key" }) }),
    usage: { session: () => "s", record: () => undefined },
    limits: (reading) => void readings.push(reading),
  });
  return { readings, models, endpoints };
};

const ask = (models: ReturnType<typeof createModels>, provider: string, id: string) => models.completeSimple(models.getModel(provider, id)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });

describe("a Session's limit readings", () => {
  it("reads Claude's unified windows from an Anthropic Messages answer, under the endpoint and the answer's time", async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const { readings, models, endpoints } = sessionWith(anthropicEndpoint, (async () => anthropicAnswer(CLAUDE_HEADERS)) as unknown as typeof fetch);
      await endpoints.take();
      await ask(models, "claude", "claude-haiku-5-5");
      expect(readings).toEqual([{ endpointId: "claude", at: NOW, windows: CLAUDE_WINDOWS }]);
      expect(JSON.stringify(readings)).not.toContain("org-not-kept");
      expect(JSON.stringify(readings)).not.toContain("sk-test-key");
    } finally {
      Date.now = realNow;
    }
  });

  it("reads them on a sign-in endpoint too (the Claude sign-in's own provider)", async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const signIn: ModelEndpoint = { ...anthropicEndpoint, id: "claude-plan", auth: "claude", baseUrl: "https://api.anthropic.com" };
      const { readings, models, endpoints } = sessionWith(signIn, (async () => anthropicAnswer(CLAUDE_HEADERS)) as unknown as typeof fetch);
      await endpoints.take();
      const message = await ask(models, "claude-plan", "claude-haiku-5-5");
      expect(message.stopReason).toBe("stop");
      expect(readings).toEqual([{ endpointId: "claude-plan", at: NOW, windows: CLAUDE_WINDOWS }]);
    } finally {
      Date.now = realNow;
    }
  });

  it("reads ChatGPT's Codex windows from an OpenAI Responses answer", async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const { readings, models, endpoints } = sessionWith(responsesEndpoint, (async () => responsesAnswer(CODEX_HEADERS)) as unknown as typeof fetch);
      await endpoints.take();
      await ask(models, "chatgpt", "gpt-6.1-sol");
      expect(readings).toEqual([
        {
          endpointId: "chatgpt",
          at: NOW,
          windows: [
            { id: "primary", usedPercent: 12.5, resetsAt: IN_2H * 1000, windowMinutes: 300 },
            { id: "secondary", usedPercent: 40, resetsAt: IN_5D * 1000, windowMinutes: 10080 },
          ],
        },
      ]);
    } finally {
      Date.now = realNow;
    }
  });

  it("reads a refused limit (the stage's fault answer through the recording fetch) as its claim spent, and nothing from an answer with no window", async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      let faulted = true;
      const recording = recordingFetch({
        fetch: (async () => anthropicAnswer({})) as unknown as typeof fetch,
        fault: () => (faulted ? { fixture: "anthropicUsageLimit", resetAt: IN_2H * 1000 } : undefined),
        clearFault: () => undefined,
        now: () => NOW,
        onRequest: () => undefined,
      });
      const { readings, models, endpoints } = sessionWith(anthropicEndpoint, recording.fetch);
      await endpoints.take();
      await ask(models, "claude", "claude-haiku-5-5");
      faulted = false;
      await ask(models, "claude", "claude-haiku-5-5");
      expect(readings).toEqual([{ endpointId: "claude", at: NOW, windows: [{ id: "five_hour", usedPercent: 100, resetsAt: IN_2H * 1000, windowMinutes: 300 }] }]);
      expect(faultAnswer({ fixture: "anthropicUsageLimit", resetAt: IN_2H * 1000 }, NOW, "m").headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("five_hour");
    } finally {
      Date.now = realNow;
    }
  });

  it("text generation reads its answer's windows too", async () => {
    const readings: Array<LimitReading> = [];
    const result = await generateEndpointText(
      { endpointId: "claude", modelId: "claude-haiku-5-5", prompt: "title" },
      {
        endpoints: async () => ({ revision: 1, endpoints: [anthropicEndpoint] }),
        credential: async () => ({ apiKey: "sk-test-key" }),
        fetch: (async () => anthropicAnswer({ "anthropic-ratelimit-unified-5h-utilization": "0.5" })) as unknown as typeof fetch,
        usage: () => undefined,
        limits: (reading) => void readings.push(reading),
      },
    );
    expect(result).toEqual({ ok: true, text: "ok" });
    expect(readings).toMatchObject([{ endpointId: "claude", windows: [{ id: "five_hour", usedPercent: 50, windowMinutes: 300 }] }]);
  });

  it("an answer whose reading throws still reaches pi-ai whole", async () => {
    const models = createModels();
    const throwing = new SessionEndpoints({
      kv: { get: () => undefined, put: () => undefined },
      models,
      fetch: (async () => anthropicAnswer(CLAUDE_HEADERS)) as unknown as typeof fetch,
      readMs: 50,
      source: () => ({ modelEndpoints: async () => ({ revision: 1, endpoints: [anthropicEndpoint] }), endpointCredential: async () => ({ apiKey: "sk-test-key" }) }),
      usage: { session: () => "s", record: () => undefined },
      limits: () => {
        throw new Error("lost");
      },
    });
    await throwing.take();
    const message = await ask(models, "claude", "claude-haiku-5-5");
    expect(message.stopReason).toBe("stop");
  });
});

const HANDLE = "a".repeat(64);
const grant = (api: "openai-responses" | "anthropic-messages"): ModelRelayGrant => ({
  kind: "granted",
  handleId: "proc-1",
  cli: api === "openai-responses" ? "codex" : "claude",
  workspace: "ws-1",
  target: { api, auth: "api-key", baseUrl: "https://up.example/v1", headers: { authorization: "Bearer sk-endpoint-secret" } },
});

const relay = (api: "openai-responses" | "anthropic-messages", upstream: () => Response) => {
  const readings: Array<LimitReading> = [];
  const deps: ModelRelayDeps = {
    authorize: async () => grant(api),
    fetch: async () => upstream(),
    log: () => undefined,
    now: () => NOW,
    usage: () => undefined,
    limits: (reading) => void readings.push(reading),
  };
  const request = new Request("http://computer.internal/t3flare/model/sub/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HANDLE}` }, body: "{}" });
  return { readings, answer: () => handleModelRelay(request, deps) };
};

describe("the model relay's limit readings", () => {
  it("reads each answer's windows under the endpoint, and passes the headers and body on unchanged", async () => {
    const r = relay("openai-responses", () => responsesAnswer(CODEX_HEADERS));
    const response = await r.answer();
    expect(response.headers.get("x-codex-primary-used-percent")).toBe("12.5");
    expect(await response.text()).toContain("response.completed");
    expect(r.readings).toEqual([
      {
        endpointId: "sub",
        at: NOW,
        windows: [
          { id: "primary", usedPercent: 12.5, resetsAt: IN_2H * 1000, windowMinutes: 300 },
          { id: "secondary", usedPercent: 40, resetsAt: IN_5D * 1000, windowMinutes: 10080 },
        ],
      },
    ]);
  });

  it("reads a refused limit's answer too (Claude's 429 naming its claim), and nothing from garbage", async () => {
    const limited = relay("anthropic-messages", () =>
      Response.json(
        { type: "error", error: { type: "rate_limit_error", message: "limited" } },
        { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day", "anthropic-ratelimit-unified-reset": String(IN_5D) } },
      ),
    );
    expect((await limited.answer()).status).toBe(429);
    expect(limited.readings).toEqual([{ endpointId: "sub", at: NOW, windows: [{ id: "seven_day", usedPercent: 100, resetsAt: IN_5D * 1000, windowMinutes: 10080 }] }]);

    const garbage = relay("openai-responses", () => responsesAnswer({ "x-codex-primary-used-percent": "lots", "anthropic-ratelimit-unified-5h-utilization": "-1" }));
    expect((await garbage.answer()).status).toBe(200);
    expect(garbage.readings).toEqual([]);
  });

  it("a reader that throws never fails the answer", async () => {
    const deps: ModelRelayDeps = {
      authorize: async () => grant("anthropic-messages"),
      fetch: async () => anthropicAnswer(CLAUDE_HEADERS),
      log: () => undefined,
      now: () => NOW,
      usage: () => undefined,
      limits: () => {
        throw new Error("lost");
      },
    };
    const response = await handleModelRelay(new Request("http://computer.internal/t3flare/model/sub/messages", { method: "POST", headers: { authorization: `Bearer ${HANDLE}` }, body: "{}" }), deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
  });
});

describe("the limits sender (the Session, text generation, the relay's WorkspaceProxy)", () => {
  const reading: LimitReading = { endpointId: "sub", at: NOW, windows: [{ id: "five_hour", usedPercent: 1 }] };

  it("sends the reading to the Environment's recordLimits under waitUntil, and a failure loses it, logged by its endpoint only", async () => {
    const sent: Array<unknown> = [];
    const kept: Array<Promise<unknown>> = [];
    const lines: Array<string> = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void kept.push(promise) };
    limitsSender(ctx, () => ({ recordLimits: async (input) => (sent.push(input), { kept: 1 }) }))(reading);
    limitsSender(ctx, () => ({ recordLimits: () => Promise.reject(new TypeError("sk-secret")) }), (line) => void lines.push(line))(reading);
    await Promise.all(kept);
    expect(sent).toEqual([{ readings: [reading] }]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ t3flare: "limit-reading-failed", endpoint: "sub", error: "TypeError" }]);
  });
});
