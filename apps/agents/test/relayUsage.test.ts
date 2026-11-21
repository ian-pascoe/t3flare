// The model relay's usage records (SPI-1173): each relayed CLI request's usage is read from its answer as it streams past
// (the final stream event, or the body), per API, and recorded with the CLI, the endpoint and the model. The answer
// reaches the CLI byte for byte, as it comes; an answer the reader cannot parse is still relayed whole, unrecorded.
import { describe, expect, it } from "vitest";

import type { EndpointApi } from "@t3flare/models/endpoints";
import { modelRoutedRelayUrl } from "@t3flare/models/relay";
import type { UsageEntry } from "@t3flare/models/usage";

import { handleModelRelay, type ModelRelayDeps, type ModelRelayGrant } from "../src/workspace/modelRelay.ts";
import { MAX_USAGE_COPY_CHARS } from "../src/workspace/relayUsage.ts";

const HANDLE = "a".repeat(64);
const KEY = "sk-endpoint-secret-1";

const grantOf = (api: EndpointApi, cli = "codex"): ModelRelayGrant => ({
  kind: "granted",
  handleId: "proc-1",
  cli,
  workspace: "ws-1",
  target: { api, auth: "api-key", baseUrl: "https://api.example.com/v1", headers: { authorization: `Bearer ${KEY}` } },
});

const sse = (events: ReadonlyArray<unknown>, named = false): string =>
  events.map((event) => `${named ? `event: ${(event as { type?: string }).type ?? "message"}\n` : ""}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

/** A body that arrives in `size`-byte pieces, cutting lines and characters anywhere. */
const pieces = (text: string, size: number): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
};

const relay = async (options: {
  readonly api: EndpointApi;
  readonly cli?: string;
  readonly body: string;
  readonly contentType?: string;
  readonly status?: number;
  readonly url?: string;
  readonly request?: string;
  readonly size?: number;
}) => {
  const recorded: Array<UsageEntry> = [];
  const grant = grantOf(options.api, options.cli);
  const deps: ModelRelayDeps = {
    limits: () => undefined,
    authorize: async (input) => (input.endpointId === null ? { kind: "known", handleId: "proc-1", cli: grant.kind === "granted" ? grant.cli : "codex", workspace: "ws-1" } : grant),
    fetch: async () => new Response(pieces(options.body, options.size ?? 7), { status: options.status ?? 200, headers: { "content-type": options.contentType ?? "text/event-stream" } }),
    log: () => undefined,
    now: () => 1_700_000_000_000,
    usage: (entry) => void recorded.push(entry),
  };
  const response = await handleModelRelay(
    new Request(options.url ?? "http://computer.internal/t3flare/model/ep1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HANDLE}` },
      body: options.request ?? '{"model":"m"}',
    }),
    deps,
  );
  const text = await response.text();
  return { recorded, text, response };
};

const call = { endpointId: "ep1", at: 1_700_000_000_000, session: "proc-1", costUsd: null };

describe("the model relay's usage records", () => {
  it("reads Anthropic Messages' stream: input and cache at the start, output at the last delta, the routed model's own id", async () => {
    const body = sse(
      [
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'say "usage": {"output_tokens": 999}' } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 87 } },
        { type: "message_stop" },
      ],
      true,
    );
    const { recorded, text } = await relay({ api: "anthropic-messages", cli: "claude", body, url: modelRoutedRelayUrl + "/v1/messages", request: '{"model":"ep1/claude-sonnet-4-5","stream":true}' });
    expect(text).toBe(body);
    expect(recorded).toEqual([{ ...call, agent: "claude", modelId: "claude-sonnet-4-5", input: 12, cacheRead: 4000, cacheWrite: 300, output: 87, reasoning: 0 }]);
  });

  it("reads OpenAI Responses' completed event, its model named by the answer when the path names the endpoint", async () => {
    const body = sse([
      { type: "response.created", response: { id: "r1", model: "gpt-5.1-codex", usage: null } },
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: { id: "r1", model: "gpt-5.1-codex", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 1250 } },
      },
    ]);
    const { recorded, text } = await relay({ api: "openai-responses", body, url: "http://computer.internal/t3flare/model/ep1/responses", size: 3 });
    expect(text).toBe(body);
    expect(recorded).toEqual([{ ...call, agent: "codex", modelId: "gpt-5.1-codex", input: 200, cacheRead: 1000, cacheWrite: 0, output: 50, reasoning: 30 }]);
  });

  it("reads Chat Completions' last chunk (OpenCode, pi)", async () => {
    const body = sse([
      { id: "c1", object: "chat.completion.chunk", model: "qwen3-coder", choices: [{ delta: { content: "x" } }] },
      { id: "c1", object: "chat.completion.chunk", model: "qwen3-coder", choices: [], usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 10 } } },
      "[DONE]",
    ]);
    const { recorded } = await relay({ api: "openai-completions", cli: "opencode", body, url: "http://computer.internal/t3flare/model/ep1/chat/completions" });
    expect(recorded).toEqual([{ ...call, agent: "opencode", modelId: "qwen3-coder", input: 400, cacheRead: 100, cacheWrite: 0, output: 40, reasoning: 10 }]);
  });

  it("reads Google's last usage metadata, thoughts counted as output", async () => {
    const chunk = (usage: Record<string, number>) => ({ candidates: [{ content: { parts: [{ text: "x" }] } }], modelVersion: "gemini-2.5-pro", usageMetadata: usage });
    const body = sse([chunk({ promptTokenCount: 900, candidatesTokenCount: 3 }), chunk({ promptTokenCount: 900, cachedContentTokenCount: 600, candidatesTokenCount: 70, thoughtsTokenCount: 20 })]);
    const { recorded } = await relay({ api: "google-generative-ai", cli: "pi", body, url: "http://computer.internal/t3flare/model/ep1/models/gemini-2.5-pro:streamGenerateContent?alt=sse" });
    expect(recorded).toEqual([{ ...call, agent: "pi", modelId: "gemini-2.5-pro", input: 300, cacheRead: 600, cacheWrite: 0, output: 90, reasoning: 20 }]);
  });

  it("reads Mistral's done event", async () => {
    const body = sse([{ type: "message.output.delta", content: "x", model: "mistral-medium-latest" }, { type: "conversation.response.done", usage: { prompt_tokens: 80, completion_tokens: 9, total_tokens: 89 } }], true);
    const { recorded } = await relay({ api: "mistral-conversations", cli: "pi", body, url: "http://computer.internal/t3flare/model/ep1/conversations" });
    expect(recorded).toEqual([{ ...call, agent: "pi", modelId: "mistral-medium-latest", input: 80, cacheRead: 0, cacheWrite: 0, output: 9, reasoning: 0 }]);
  });

  it("reads a whole JSON answer (no stream), and Google's streamed JSON array", async () => {
    const message = { id: "msg_1", type: "message", model: "claude-haiku-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2 } };
    const anthropic = await relay({ api: "anthropic-messages", cli: "pi", body: JSON.stringify(message), contentType: "application/json" });
    expect(anthropic.text).toBe(JSON.stringify(message));
    expect(anthropic.recorded).toEqual([{ ...call, agent: "pi", modelId: "claude-haiku-4-5", input: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 }]);
    const array = JSON.stringify([
      { modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      { modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8 } },
    ]);
    const google = await relay({ api: "google-generative-ai", cli: "pi", body: array, contentType: "application/json; charset=utf-8" });
    expect(google.recorded).toEqual([{ ...call, agent: "pi", modelId: "gemini-2.5-flash", input: 5, cacheRead: 0, cacheWrite: 0, output: 8, reasoning: 0 }]);
  });

  it("relays an answer it cannot read whole and records nothing: broken JSON, no usage, a refusal", async () => {
    const broken = 'data: {"type":"message_start","message":{"usage":\n\ndata: [DONE]\n\n';
    const a = await relay({ api: "anthropic-messages", cli: "claude", body: broken });
    expect(a.text).toBe(broken);
    expect(a.recorded).toEqual([]);
    const none = sse([{ type: "message_stop" }]);
    expect((await relay({ api: "anthropic-messages", cli: "claude", body: none })).recorded).toEqual([]);
    // A failed answer is not read even when it holds a usage it could read (a vendor's partial billing on a 4xx or 5xx).
    const refused = await relay({ api: "openai-responses", body: JSON.stringify({ object: "response", model: "m", usage: { input_tokens: 5, output_tokens: 1 } }), contentType: "application/json", status: 429 });
    expect(refused.response.status).toBe(429);
    expect(refused.recorded).toEqual([]);
    // The same body answered 200 is read: the status is what kept it out.
    expect((await relay({ api: "openai-responses", body: JSON.stringify({ object: "response", model: "m", usage: { input_tokens: 5, output_tokens: 1 } }), contentType: "application/json" })).recorded).toHaveLength(1);
  });

  it("stops reading past MAX_USAGE_COPY_CHARS in one line, and still relays the answer whole", async () => {
    const huge = "x".repeat(MAX_USAGE_COPY_CHARS + 10);
    const over = sse([{ type: "response.completed", response: { model: "m", output: [{ text: huge }], usage: { input_tokens: 3, output_tokens: 1 } } }]);
    const cut = await relay({ api: "openai-responses", body: over, size: 512 * 1024 });
    expect(cut.text.length).toBe(over.length);
    expect(cut.recorded).toEqual([]);
    const under = sse([{ type: "response.completed", response: { model: "m", output: [{ text: "x".repeat(MAX_USAGE_COPY_CHARS - 1000) }], usage: { input_tokens: 3, output_tokens: 1 } } }]);
    expect((await relay({ api: "openai-responses", body: under, size: 512 * 1024 })).recorded).toMatchObject([{ input: 3, output: 1 }]);
  });

  it("stops copying a JSON body, or a stream's last line with no newline, past MAX_USAGE_COPY_CHARS", async () => {
    const pad = "x".repeat(MAX_USAGE_COPY_CHARS);
    const body = JSON.stringify({ object: "response", model: "m", output: [{ text: pad }], usage: { input_tokens: 3, output_tokens: 1 } });
    const json = await relay({ api: "openai-responses", body, contentType: "application/json", size: 512 * 1024 });
    expect(json.text.length).toBe(body.length);
    expect(json.recorded).toEqual([]);
    const line = `data: ${JSON.stringify({ type: "response.completed", response: { model: "m", output: [{ text: pad }], usage: { input_tokens: 3, output_tokens: 1 } } })}`;
    const unended = await relay({ api: "openai-responses", body: line, size: 512 * 1024 });
    expect(unended.text.length).toBe(line.length);
    expect(unended.recorded).toEqual([]);
    // Under the cap, both are read: the cap is what kept them out.
    const small = JSON.stringify({ object: "response", model: "m", usage: { input_tokens: 3, output_tokens: 1 } });
    expect((await relay({ api: "openai-responses", body: small, contentType: "application/json", size: 512 * 1024 })).recorded).toHaveLength(1);
    expect((await relay({ api: "openai-responses", body: `data: ${JSON.stringify({ type: "response.completed", response: { model: "m", usage: { input_tokens: 3, output_tokens: 1 } } })}`, size: 7 })).recorded).toHaveLength(1);
  });

  it("records what a stream the CLI cancels had read (Anthropic's input), once", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start: (controller) => void (push = controller) });
    const recorded: Array<UsageEntry> = [];
    const deps: ModelRelayDeps = {
      limits: () => undefined,
      authorize: async () => grantOf("anthropic-messages", "claude"),
      fetch: async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      log: () => undefined,
      now: () => 1,
      usage: (entry) => void recorded.push(entry),
    };
    const response = await handleModelRelay(new Request("http://computer.internal/t3flare/model/ep1/messages", { method: "POST", headers: { authorization: `Bearer ${HANDLE}` }, body: "{}" }), deps);
    const reader = response.body!.getReader();
    push.enqueue(new TextEncoder().encode(sse([{ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 900, cache_read_input_tokens: 50, output_tokens: 1 } } }])));
    await reader.read();
    await reader.cancel("interrupted");
    await reader.cancel("again").catch(() => undefined);
    expect(recorded).toEqual([{ ...call, at: 1, agent: "claude", modelId: "claude-x", input: 900, cacheRead: 50, cacheWrite: 0, output: 1, reasoning: 0 }]);
  });

  it("cancels the endpoint's answer when the CLI cancels its stream", async () => {
    const cancelled: Array<unknown> = [];
    const upstream = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(sse([{ type: "message_start", message: { model: "m", usage: { input_tokens: 3, output_tokens: 1 } } }]))),
      cancel: (reason) => void cancelled.push(reason),
    });
    const deps: ModelRelayDeps = {
      limits: () => undefined,
      authorize: async () => grantOf("anthropic-messages", "claude"),
      fetch: async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      log: () => undefined,
      now: () => 1,
      usage: () => undefined,
    };
    const response = await handleModelRelay(new Request("http://computer.internal/t3flare/model/ep1/messages", { method: "POST", headers: { authorization: `Bearer ${HANDLE}` }, body: "{}" }), deps);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("the CLI hung up");
    expect(cancelled).toEqual(["the CLI hung up"]);
  });

  it("records what a stream that fails upstream had read, and passes the failure on", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start: (controller) => void (push = controller) });
    const recorded: Array<UsageEntry> = [];
    const deps: ModelRelayDeps = {
      limits: () => undefined,
      authorize: async () => grantOf("openai-completions", "pi"),
      fetch: async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      log: () => undefined,
      now: () => 1,
      usage: (entry) => void recorded.push(entry),
    };
    const response = await handleModelRelay(new Request("http://computer.internal/t3flare/model/ep1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${HANDLE}` }, body: "{}" }), deps);
    const reader = response.body!.getReader();
    push.enqueue(new TextEncoder().encode(sse([{ object: "chat.completion.chunk", model: "q", choices: [], usage: { prompt_tokens: 40, completion_tokens: 2 } }])));
    await reader.read();
    push.error(new TypeError("reset"));
    await expect(reader.read()).rejects.toThrow("reset");
    expect(recorded).toMatchObject([{ agent: "pi", modelId: "q", input: 40, output: 2 }]);
  });

  it("records nothing for a process that is not a CLI agent's (the stage's probe)", async () => {
    const body = sse([{ type: "message_start", message: { model: "m", usage: { input_tokens: 3, output_tokens: 1 } } }]);
    expect((await relay({ api: "anthropic-messages", cli: "probe", body })).recorded).toEqual([]);
  });

  it("never lets a failing record break the answer", async () => {
    const body = sse([{ type: "response.completed", response: { model: "m", usage: { input_tokens: 3, output_tokens: 1 } } }]);
    const deps: ModelRelayDeps = {
      limits: () => undefined,
      authorize: async () => grantOf("openai-responses"),
      fetch: async () => new Response(pieces(body, 5), { status: 200, headers: { "content-type": "text/event-stream" } }),
      log: () => undefined,
      now: () => 1,
      usage: () => {
        throw new Error("the Environment is gone");
      },
    };
    const response = await handleModelRelay(new Request("http://computer.internal/t3flare/model/ep1/responses", { method: "POST", headers: { authorization: `Bearer ${HANDLE}` }, body: "{}" }), deps);
    expect(await response.text()).toBe(body);
  });

  it("passes each piece on before reading it: the CLI never waits for the reader", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start: (controller) => void (push = controller) });
    const recorded: Array<UsageEntry> = [];
    const deps: ModelRelayDeps = {
      limits: () => undefined,
      authorize: async () => grantOf("anthropic-messages", "claude"),
      fetch: async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      log: () => undefined,
      now: () => 1,
      usage: (entry) => void recorded.push(entry),
    };
    const response = await handleModelRelay(new Request("http://computer.internal/t3flare/model/ep1/messages", { method: "POST", headers: { authorization: `Bearer ${HANDLE}` }, body: "{}" }), deps);
    const reader = response.body!.getReader();
    // Half a line: the reader holds its copy, the CLI gets the bytes now.
    push.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"model":"m","usage":{"input_'));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    push.enqueue(new TextEncoder().encode('tokens":3,"output_tokens":1}}}\n\n'));
    await reader.read();
    push.close();
    expect((await reader.read()).done).toBe(true);
    expect(recorded).toMatchObject([{ agent: "claude", modelId: "m", input: 3, output: 1 }]);
  });
});
