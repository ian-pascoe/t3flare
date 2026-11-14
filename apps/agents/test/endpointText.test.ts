// Text generation on a Model endpoint's model (SPI-1163): one pi-ai request on the agents Worker, for the Environment DO.
// The key is asked for the endpoint's target at use time (as a Session does); a failure names the endpoint and never
// carries the vendor's body or the key.
import type { EndpointCredential, EndpointTarget, ModelEndpoint } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { generateEndpointText } from "../src/endpointText.ts";

const COST = { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 };
const KEY = "sk-secret-123";
const VENDOR_BODY = "upstream said: request id req_9 for key sk-secret-123 refused";

const endpoint = (api: ModelEndpoint["api"], auth: ModelEndpoint["auth"] = "api-key"): ModelEndpoint => ({
  id: "gw",
  label: "Gateway",
  api,
  baseUrl: "https://gw.example/v1",
  auth,
  headers: { "X-Org": "acme" },
  models: [{ id: "small-mini", name: "Small", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_000, cost: COST, known: true }],
});

const anthropicOk = (text: string) => {
  const sse = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "small-mini", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
};

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const recorder = (answer: () => Response | Promise<Response>) => {
  const sent: Array<Sent> = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: await request.text() });
    return answer();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
};

const keyFor = (answer: EndpointCredential = { apiKey: KEY }) => {
  const asked: Array<{ readonly endpointId: string; readonly target: EndpointTarget }> = [];
  return { asked, credential: async (endpointId: string, target: EndpointTarget) => (asked.push({ endpointId, target }), answer) };
};

describe("generateEndpointText", () => {
  it("answers the model's text from one request to the endpoint, with its key asked for the endpoint's target", async () => {
    const wire = recorder(() => anthropicOk('{"title":"Fix the build"}'));
    const key = keyFor();
    const answer = await generateEndpointText({ endpoint: endpoint("anthropic-messages"), modelId: "small-mini", prompt: "Name this thread." }, { credential: key.credential, fetch: wire.fetch });
    expect(answer).toEqual({ ok: true, text: '{"title":"Fix the build"}' });
    expect(key.asked).toEqual([{ endpointId: "gw", target: { api: "anthropic-messages", baseUrl: "https://gw.example/v1", headers: { "X-Org": "acme" } } }]);
    expect(wire.sent).toHaveLength(1);
    expect(wire.sent[0]!.url.startsWith("https://gw.example/v1")).toBe(true);
    expect(wire.sent[0]!.headers).toMatchObject({ "x-api-key": KEY, "x-org": "acme" });
    expect(wire.sent[0]!.body).toContain("Name this thread.");
  });

  it("sends the placeholder key, and asks for none, on an endpoint with no auth", async () => {
    const wire = recorder(() => anthropicOk("ok"));
    const key = keyFor();
    const answer = await generateEndpointText({ endpoint: endpoint("anthropic-messages", "none"), modelId: "small-mini", prompt: "p" }, { credential: key.credential, fetch: wire.fetch });
    expect(answer).toEqual({ ok: true, text: "ok" });
    expect(key.asked).toEqual([]);
    expect(wire.sent[0]!.headers["x-api-key"]).toBe("none");
  });

  for (const api of ["anthropic-messages", "openai-responses", "openai-completions"] as const) {
    for (const [status, says] of [
      [401, /Model endpoint "gw" refused its API key \(HTTP 401\)/],
      [403, /Model endpoint "gw" refused its API key \(HTTP 403\)/],
      [404, /Model endpoint "gw" does not serve the model small-mini \(HTTP 404\)/],
      [429, /Model endpoint "gw" is rate- or usage-limited \(HTTP 429\)/],
      [400, /Model endpoint "gw" refused the request \(HTTP 400\)/],
      [503, /Model endpoint "gw" failed \(HTTP 503\)/],
    ] as const) {
      it(`names the endpoint and never echoes the body or the key on HTTP ${status} (${api})`, async () => {
        const wire = recorder(() => Response.json({ error: { message: VENDOR_BODY, type: "error" } }, { status }));
        const answer = await generateEndpointText({ endpoint: endpoint(api), modelId: "small-mini", prompt: "p" }, { credential: keyFor().credential, fetch: wire.fetch });
        expect(answer.ok).toBe(false);
        const error = answer.ok ? "" : answer.error;
        expect(error).toMatch(says);
        expect(error).not.toContain("req_9");
        expect(error).not.toContain(KEY);
      });
    }
  }

  it("says the endpoint could not be reached when the request never got an answer", async () => {
    const fetch = (async () => {
      throw new TypeError(`connect failed for ${KEY}`);
    }) as typeof globalThis.fetch;
    const answer = await generateEndpointText({ endpoint: endpoint("openai-responses"), modelId: "small-mini", prompt: "p" }, { credential: keyFor().credential, fetch });
    expect(answer).toEqual({ ok: false, error: 'The Model endpoint "gw" could not be reached.' });
  });

  it("says why there is no key, as a Session's turn does, and sends nothing", async () => {
    for (const [credential, says] of [
      [{ apiKey: null }, /Model endpoint "gw" has no API key/],
      [{ apiKey: null, unreadable: true }, /can no longer be read .*enter it again/],
      [{ apiKey: null, changed: true }, /Model endpoint "gw" changed or was removed/],
    ] as const) {
      const wire = recorder(() => anthropicOk("never"));
      const answer = await generateEndpointText({ endpoint: endpoint("anthropic-messages"), modelId: "small-mini", prompt: "p" }, { credential: keyFor(credential).credential, fetch: wire.fetch });
      expect(answer.ok).toBe(false);
      expect(answer.ok ? "" : answer.error).toMatch(says);
      expect(wire.sent).toEqual([]);
    }
  });

  it("refuses a model the endpoint does not list, sending nothing", async () => {
    const wire = recorder(() => anthropicOk("never"));
    const answer = await generateEndpointText({ endpoint: endpoint("anthropic-messages"), modelId: "gone", prompt: "p" }, { credential: keyFor().credential, fetch: wire.fetch });
    expect(answer).toEqual({ ok: false, error: 'The Model endpoint "gw" does not list the model gone.' });
    expect(wire.sent).toEqual([]);
  });

  it("says the model returned no text when it answered none", async () => {
    const wire = recorder(() => anthropicOk(""));
    const answer = await generateEndpointText({ endpoint: endpoint("anthropic-messages"), modelId: "small-mini", prompt: "p" }, { credential: keyFor().credential, fetch: wire.fetch });
    expect(answer).toEqual({ ok: false, error: 'The Model endpoint "gw"\'s model small-mini returned no text.' });
  });
});
