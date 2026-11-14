// Text generation on a Model endpoint's model (SPI-1163): one pi-ai request on the agents Worker, for the Environment DO.
// The request names ids only; the endpoint is read from the Environment and its key asked for the endpoint's target at use
// time (as a Session does). A failure names the endpoint and never carries the vendor's body or the key.
import type { EndpointCredential, EndpointTarget, ModelEndpoint } from "@t3flare/models/endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type EndpointTextAccess, generateEndpointText } from "../src/endpointText.ts";

const COST = { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 };
const KEY = "sk-secret-123";
const VENDOR_BODY = "upstream said: request id req_9 for key sk-secret-123 refused";

const endpoint = (api: ModelEndpoint["api"], auth: ModelEndpoint["auth"] = "api-key", maxTokens = 4_000): ModelEndpoint => ({
  id: "gw",
  label: "Gateway",
  api,
  baseUrl: "https://gw.example/v1",
  auth,
  headers: { "X-Org": "acme" },
  models: [{ id: "small-mini", name: "Small", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens, cost: COST, known: true }],
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

const recorder = (answer: (init?: RequestInit) => Response | Promise<Response>) => {
  const sent: Array<Sent> = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: await request.text() });
    return answer(init);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
};

const keyFor = (answer: EndpointCredential = { apiKey: KEY }) => {
  const asked: Array<{ readonly endpointId: string; readonly target: EndpointTarget }> = [];
  return { asked, credential: async (endpointId: string, target: EndpointTarget) => (asked.push({ endpointId, target }), answer) };
};

/** One request for `gw`'s `modelId`, the Environment holding `held`. */
const generate = (held: ModelEndpoint, access: Partial<EndpointTextAccess> & Pick<EndpointTextAccess, "credential">, modelId = "small-mini") =>
  generateEndpointText({ endpointId: "gw", modelId, prompt: "Name this thread." }, { endpoints: async () => ({ revision: 2, endpoints: [held] }), ...access });

const errorOf = (answer: Awaited<ReturnType<typeof generateEndpointText>>) => (answer.ok ? "" : answer.error);

afterEach(() => vi.unstubAllGlobals());

describe("generateEndpointText", () => {
  it("answers the model's text from one request to the endpoint, with its key asked for the endpoint's target", async () => {
    const wire = recorder(() => anthropicOk('{"title":"Fix the build"}'));
    const key = keyFor();
    const answer = await generate(endpoint("anthropic-messages"), { credential: key.credential, fetch: wire.fetch });
    expect(answer).toEqual({ ok: true, text: '{"title":"Fix the build"}' });
    expect(key.asked).toEqual([{ endpointId: "gw", target: { api: "anthropic-messages", baseUrl: "https://gw.example/v1", headers: { "X-Org": "acme" } } }]);
    expect(wire.sent).toHaveLength(1);
    expect(wire.sent[0]!.url.startsWith("https://gw.example/v1")).toBe(true);
    expect(wire.sent[0]!.headers).toMatchObject({ "x-api-key": KEY, "x-org": "acme" });
    expect(wire.sent[0]!.body).toContain("Name this thread.\\n\\nAnswer with the JSON object only.");
  });

  it("asks for at most 8192 tokens, and never more than the model's own limit", async () => {
    for (const [limit, sent] of [
      [4_000, 4_000],
      [128_000, 8_192],
    ] as const) {
      const wire = recorder(() => anthropicOk("ok"));
      await generate(endpoint("anthropic-messages", "api-key", limit), { credential: keyFor().credential, fetch: wire.fetch });
      expect((JSON.parse(wire.sent[0]!.body) as { max_tokens: number }).max_tokens).toBe(sent);
    }
  });

  it("sends the placeholder key, and asks for none, on an endpoint with no auth", async () => {
    const wire = recorder(() => anthropicOk("ok"));
    const key = keyFor();
    const answer = await generate(endpoint("anthropic-messages", "none"), { credential: key.credential, fetch: wire.fetch });
    expect(answer).toEqual({ ok: true, text: "ok" });
    expect(key.asked).toEqual([]);
    expect(wire.sent[0]!.headers["x-api-key"]).toBe("none");
  });

  for (const api of ["anthropic-messages", "openai-responses", "openai-completions"] as const) {
    for (const [status, says] of [
      [401, 'The Model endpoint "gw" refused its API key (HTTP 401): check it in the Harness panel.'],
      [403, 'The Model endpoint "gw" refused its API key (HTTP 403): check it in the Harness panel.'],
      [404, 'The Model endpoint "gw" does not serve the model small-mini (HTTP 404).'],
      [429, 'The Model endpoint "gw" is rate- or usage-limited (HTTP 429): try again later.'],
      [400, 'The Model endpoint "gw" refused the request (HTTP 400).'],
      [503, 'The Model endpoint "gw" failed (HTTP 503).'],
    ] as const) {
      it(`names the endpoint and never echoes the body or the key on HTTP ${status} (${api})`, async () => {
        const wire = recorder(() => Response.json({ error: { message: VENDOR_BODY, type: "error" } }, { status }));
        const error = errorOf(await generate(endpoint(api), { credential: keyFor().credential, fetch: wire.fetch }));
        expect(error).toBe(says);
        expect(error).not.toContain("req_9");
        expect(error).not.toContain(KEY);
      });
    }
  }

  it("says an endpoint with no auth refused the request, not a key", async () => {
    const wire = recorder(() => Response.json({ error: { message: VENDOR_BODY } }, { status: 401 }));
    expect(errorOf(await generate(endpoint("openai-completions", "none"), { credential: keyFor().credential, fetch: wire.fetch }))).toBe(
      'The Model endpoint "gw" refused the request without a credential (HTTP 401): check its auth in the Harness panel.',
    );
  });

  it("reads a Mistral endpoint's status, which its adapter reports without a Session's fetch", async () => {
    const wire = recorder(() => Response.json({ message: VENDOR_BODY }, { status: 401 }));
    vi.stubGlobal("fetch", wire.fetch);
    const error = errorOf(await generate(endpoint("mistral-conversations"), { credential: keyFor().credential }));
    expect(error).toBe('The Model endpoint "gw" refused its API key (HTTP 401): check it in the Harness panel.');
    expect(wire.sent).toHaveLength(1);
  });

  it("says a Google endpoint failed when it answered an error, though its adapter reports no status", async () => {
    const wire = recorder(() => Response.json({ error: { code: 401, message: VENDOR_BODY, status: "UNAUTHENTICATED" } }, { status: 401 }));
    vi.stubGlobal("fetch", wire.fetch);
    const error = errorOf(await generate(endpoint("google-generative-ai"), { credential: keyFor().credential }));
    expect(error).toBe('The Model endpoint "gw" failed (its API reports no status here).');
    expect(wire.sent.length).toBeGreaterThan(0);
  });

  it("says the endpoint could not be reached when the request never got an answer", async () => {
    const fetch = (async () => {
      throw new TypeError(`connect failed for ${KEY}`);
    }) as typeof globalThis.fetch;
    expect(await generate(endpoint("openai-responses"), { credential: keyFor().credential, fetch })).toEqual({ ok: false, error: 'The Model endpoint "gw" could not be reached.' });
  });

  it("says the endpoint did not answer in time when the request outlives its bound", async () => {
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof globalThis.fetch;
    expect(await generate(endpoint("anthropic-messages"), { credential: keyFor().credential, fetch, timeoutMs: 50 })).toEqual({ ok: false, error: 'The Model endpoint "gw" did not answer in time.' });
  });

  it("says why there is no key, as a Session's turn does, and sends nothing", async () => {
    for (const [credential, says] of [
      [{ apiKey: null }, 'The Model endpoint "gw" has no API key: set one in the Harness panel.'],
      [{ apiKey: null, unreadable: true }, `The Model endpoint "gw"'s API key can no longer be read (this Environment's credentials key changed): enter it again in the Harness panel.`],
      [{ apiKey: null, changed: true }, 'The Model endpoint "gw" changed or was removed while the text was being generated: try again.'],
    ] as const) {
      const wire = recorder(() => anthropicOk("never"));
      expect(errorOf(await generate(endpoint("anthropic-messages"), { credential: keyFor(credential).credential, fetch: wire.fetch }))).toBe(says);
      expect(wire.sent).toEqual([]);
    }
  });

  it("refuses a model the endpoint does not list, and an endpoint the Environment no longer has, sending nothing", async () => {
    const wire = recorder(() => anthropicOk("never"));
    expect(await generate(endpoint("anthropic-messages"), { credential: keyFor().credential, fetch: wire.fetch }, "gone")).toEqual({ ok: false, error: 'The Model endpoint "gw" does not list the model gone.' });
    expect(
      await generateEndpointText({ endpointId: "gw", modelId: "small-mini", prompt: "p" }, { endpoints: async () => ({ revision: 3, endpoints: [] }), credential: keyFor().credential, fetch: wire.fetch }),
    ).toEqual({ ok: false, error: 'The Model endpoint "gw" was removed: pick another model for text generation.' });
    expect(
      await generateEndpointText({ endpointId: "gw", modelId: "small-mini", prompt: "p" }, { endpoints: () => Promise.reject(new Error("rpc")), credential: keyFor().credential, fetch: wire.fetch }),
    ).toEqual({ ok: false, error: 'The Model endpoint "gw" could not be read from the Environment: try again.' });
    expect(wire.sent).toEqual([]);
  });

  it("refuses a malformed request before reading anything", async () => {
    let read = false;
    for (const input of [undefined, null, "gw/small-mini", { endpointId: "gw", modelId: "small-mini" }, { endpointId: 1, modelId: "m", prompt: "p" }, { endpoint: { id: "gw" }, modelId: "m", prompt: "p" }]) {
      const answer = await generateEndpointText(input, {
        endpoints: async () => ((read = true), { revision: 1, endpoints: [] }),
        credential: keyFor().credential,
      });
      expect(answer).toEqual({ ok: false, error: "The text generation request was malformed: it names no Model endpoint, model and prompt." });
    }
    expect(read).toBe(false);
  });

  it("says the model returned no text when it answered none", async () => {
    const wire = recorder(() => anthropicOk(""));
    expect(await generate(endpoint("anthropic-messages"), { credential: keyFor().credential, fetch: wire.fetch })).toEqual({ ok: false, error: 'The Model endpoint "gw"\'s model small-mini returned no text.' });
  });
});
