// The model relay's route in `WorkspaceProxy` (SPI-1167): a CLI's request to `/t3flare/model/<endpointId>/…` with its
// model handle goes to the endpoint's base URL with the endpoint's credential in place of the handle, the request and
// the answer streamed through unchanged; the handle never leaves, and every request is logged without a value.
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "vitest";

import { ENDPOINT_ID } from "@t3flare/models/endpoints";
import { MODEL_ROUTED_ID, modelRoutedRelayUrl } from "@t3flare/models/relay";

import { oversizedError, RELAY_ERROR_BODY_BYTES, RelayFailures, sseErrors } from "../src/workspace/relayFailures.ts";
import { workspaceRelayDeps } from "../src/workspace/modelRelay.ts";
import { authorizeModelRelay, handleModelRelay, isModelRelayPath, MAX_ROUTED_BODY_BYTES, type ModelRelayDeps, type ModelRelayGrant } from "../src/workspace/modelRelay.ts";

const HANDLE = "a".repeat(64);
const KEY = "sk-endpoint-secret-1";
const URL_ = "http://computer.internal/t3flare/model/openai/responses";

const granted: ModelRelayGrant = {
  kind: "granted",
  handleId: "proc-1",
  cli: "codex",
  workspace: "ws-1",
  target: { api: "openai-responses", auth: "api-key", baseUrl: "https://api.example.com/v1", headers: { "X-Org": "acme", authorization: `Bearer ${KEY}` } },
};

const harness = (options: { grant?: ModelRelayGrant; upstream?: (request: Request) => Promise<Response>; authorizeFails?: boolean } = {}) => {
  const asked: Array<{ handle: string | null; endpointId: string | null }> = [];
  const sent: Array<Request> = [];
  const logs: Array<Record<string, unknown>> = [];
  let now = 1_000;
  const deps: ModelRelayDeps = {
    limits: () => undefined,
    authorize: async (input) => {
      asked.push(input);
      if (options.authorizeFails === true) throw new Error("rpc broke");
      return options.grant ?? granted;
    },
    fetch: async (request) => {
      sent.push(request);
      return options.upstream === undefined ? new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }) : options.upstream(request);
    },
    log: (event) => void logs.push(event),
    now: () => (now += 5),
    usage: () => undefined,
  };
  return { deps, asked, sent, logs };
};

const post = (body: string, headers: Record<string, string> = {}, url = URL_) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HANDLE}`, ...headers }, body });

const everything = (request: Request) => JSON.stringify([request.url, [...request.headers.entries()]]);

describe("the model relay route", () => {
  it("knows its paths", () => {
    expect(isModelRelayPath("/t3flare/model/openai/responses")).toBe(true);
    expect(isModelRelayPath("/t3flare/mcp/x")).toBe(false);
    expect(isModelRelayPath("/t3flare/model-key")).toBe(false);
  });

  it("sends the request to the endpoint's base URL with its credential in place of the handle, and answers its response", async () => {
    const h = harness();
    const response = await handleModelRelay(post('{"model":"gpt-5-mini"}', { "x-request-id": "r1", cookie: "a=b", "x-api-key": HANDLE }, `${URL_}?stream=true`), h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.asked).toEqual([{ handle: HANDLE, endpointId: "openai" }]);
    const upstream = h.sent[0]!;
    expect(upstream.url).toBe("https://api.example.com/v1/responses?stream=true");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(upstream.headers.get("x-org")).toBe("acme");
    expect(upstream.headers.get("x-request-id")).toBeNull();
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("x-api-key")).toBeNull();
    expect(upstream.redirect).toBe("manual");
    expect(await upstream.text()).toBe('{"model":"gpt-5-mini"}');
    expect(everything(upstream)).not.toContain(HANDLE);
  });

  it("streams the answer as it comes, idle gaps and all", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => void (push = controller) });
    const h = harness({ upstream: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    push.enqueue(new TextEncoder().encode("data: one\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    push.enqueue(new TextEncoder().encode("data: two\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: two\n\n");
    push.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("takes the handle as an x-api-key too (the Anthropic CLIs' header), and never forwards it", async () => {
    const h = harness();
    const request = new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "x-api-key": HANDLE }, body: "{}" });
    expect((await handleModelRelay(request, h.deps)).status).toBe(200);
    expect(h.asked[0]!.handle).toBe(HANDLE);
    expect(everything(h.sent[0]!)).not.toContain(HANDLE);
  });

  it("refuses a request without a handle before asking anyone, and passes the Workspace's refusal on", async () => {
    const none = harness();
    expect((await handleModelRelay(new Request(URL_, { method: "POST", body: "{}" }), none.deps)).status).toBe(401);
    expect((await handleModelRelay(post("{}", { authorization: "Bearer not-a-handle" }), none.deps)).status).toBe(401);
    expect(none.asked).toEqual([]);
    const refused = harness({ grant: { kind: "refused", status: 401, message: "unknown or revoked model handle", handleId: null, workspace: "ws-1" } });
    const response = await handleModelRelay(post("{}"), refused.deps);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("unknown or revoked model handle");
    expect(refused.sent).toEqual([]);
  });

  it("forwards only content negotiation and the API's own headers: no header from the Container routes the key", async () => {
    const h = harness();
    const routing = {
      "x-portkey-custom-host": "https://evil.example",
      "x-portkey-provider": "openai",
      "x-forwarded-host": "evil.example",
      host: "evil.example",
      forwarded: "host=evil.example",
      "user-agent": "codex_cli_rs/0.167.2",
      originator: "codex_cli_rs",
      session_id: "s1",
      "openai-organization": "org-evil",
      "anthropic-version": "2023-06-01",
      "x-goog-api-key": HANDLE,
      "api-key": HANDLE,
      "proxy-authorization": "Basic x",
      cookie: "a=b",
    };
    await handleModelRelay(post('{"stream":true}', { ...routing, accept: "text/event-stream", "openai-beta": "responses=experimental" }), h.deps);
    const sent = h.sent[0]!;
    expect([...sent.headers.keys()].sort()).toEqual(["accept", "authorization", "content-type", "openai-beta", "x-org"]);
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(new URL(sent.url).host).toBe("api.example.com");
    // An Anthropic endpoint takes its version and beta headers, and an OpenAI one's beta header is not its.
    const anthropic = harness({ grant: { ...granted, target: { api: "anthropic-messages", auth: "api-key", baseUrl: "https://api.anthropic.example", headers: { "x-api-key": KEY } } } as ModelRelayGrant });
    await handleModelRelay(post("{}", { "anthropic-version": "2023-06-01", "anthropic-beta": "tools", "openai-beta": "x", "x-portkey-custom-host": "https://evil.example" }), anthropic.deps);
    expect([...anthropic.sent[0]!.headers.keys()].sort()).toEqual(["anthropic-beta", "anthropic-version", "content-type", "x-api-key"]);
    // The names (never the values) of what was held back are logged.
    expect(h.logs[0]).toMatchObject({ dropped: expect.arrayContaining(["x-portkey-custom-host", "user-agent", "originator"]) });
    expect(JSON.stringify(h.logs)).not.toContain("evil.example");
  });

  it("passes back no cookie and no hop-by-hop header", async () => {
    const h = harness({
      upstream: async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json", "set-cookie": "session=1", connection: "close", "keep-alive": "timeout=5", upgrade: "h2c", trailer: "x", "x-request-id": "req_1" } }),
    });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect([...response.headers.keys()].sort()).toEqual(["content-type", "x-request-id"]);
  });

  it("refuses a path that could leave the base URL at a decoding endpoint, in any encoding", async () => {
    const h = harness();
    for (const rest of [
      "/%252e%252e/admin",
      "/x/%252E/y",
      "/a%2fb",
      "/a%2Fb",
      "/a%5cb",
      "/a%5Cb",
      "/a%255cb",
      // A malformed escape anywhere in a segment: an upstream's laxer decoder could read the rest.
      "/%ff%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fother",
      "/%2e%2e%5c%ff",
      "/x%2f..%2f..%ff",
      "/%c0%ae%c0%ae/x",
      // Encoded deeper than MAX_DECODES does not settle, and is refused.
      "/%2525252e%2525252e/x",
      "/%2525252f",
      "/%25252e%25252e/x",
      // Dot segments with a parameter (Tomcat's `..;`), and control characters (NUL, tab, CR LF).
      "/..;/x",
      "/%2e%2e%3fx",
      "/..%3f",
      "/..%23",
      "/a/%2e%2e;x=1/b",
      "/.;/x",
      "/.%00./x",
      "/%2e%2e%00/x",
      "/a%09/b",
      "/%0d%0aHost:%20evil",
    ]) {
      const response = await handleModelRelay(post("{}", {}, `http://computer.internal/t3flare/model/openai${rest}`), h.deps);
      expect(response.status, rest).toBe(400);
    }
    expect(h.asked).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.logs.every((entry) => entry.handle === null && entry.endpoint === "openai")).toBe(true);
  });

  it("passes an ordinary escape (a colon, a space) through unchanged; a literal percent sign is refused with the rest", async () => {
    const h = harness();
    // `%25` decodes to a bare `%`, whose next decode fails: refused as a malformed escape (no model API path holds one).
    expect((await handleModelRelay(post("{}", {}, "http://computer.internal/t3flare/model/openai/x/100%25"), h.deps)).status).toBe(400);
    for (const rest of ["/models/gpt-5%3Amini", "/files/a%20b"]) {
      expect((await handleModelRelay(post("{}", {}, `http://computer.internal/t3flare/model/openai${rest}`), h.deps)).status, rest).toBe(200);
    }
    expect(h.sent.map((request) => new URL(request.url).pathname)).toEqual(["/v1/models/gpt-5%3Amini", "/v1/files/a%20b"]);
  });

  it("resolves a dot segment the URL itself resolves (`..`, `%2e%2e`) before naming the endpoint, so the handle's scope judges it", async () => {
    // `URL` resolves these as it parses: the path names another endpoint (or none), never openai's base URL with a `..`.
    const h = harness({ grant: { kind: "refused", status: 403, message: "not for this endpoint", handleId: "proc-1", workspace: "ws-1" } });
    for (const rest of ["/%2e%2e/admin/x", "/.%2E/admin/x", "/../admin/x"]) {
      expect((await handleModelRelay(post("{}", {}, `http://computer.internal/t3flare/model/openai${rest}`), h.deps)).status, rest).toBe(403);
    }
    expect(h.asked.map((input) => input.endpointId)).toEqual(["admin", "admin", "admin"]);
    expect(h.sent).toEqual([]);
  });

  it("answers 502 when the Workspace does not answer, and logs it with its endpoint", async () => {
    const h = harness({ authorizeFails: true });
    expect((await handleModelRelay(post("{}"), h.deps)).status).toBe(502);
    expect(h.logs).toEqual([expect.objectContaining({ endpoint: "openai", status: 502, handle: null })]);
    expect(h.sent).toEqual([]);
  });

  it("answers 404 for a path that names no endpoint", async () => {
    const h = harness();
    for (const url of ["http://computer.internal/t3flare/model/", "http://computer.internal/t3flare/model/Not_An_Id/x", "http://computer.internal/t3flare/model/openai/../../model-key"]) {
      expect((await handleModelRelay(post("{}", {}, url), h.deps)).status).toBe(404);
    }
    expect(h.asked).toEqual([]);
  });

  it("does not follow or pass on a redirect, and reports an endpoint it cannot reach", async () => {
    const redirect = harness({ upstream: async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } }) });
    const moved = await handleModelRelay(post("{}"), redirect.deps);
    expect(moved.status).toBe(502);
    expect(moved.headers.get("location")).toBeNull();
    const down = harness({ upstream: async () => Promise.reject(new Error(`connect failed with ${KEY}`)) });
    const failed = await handleModelRelay(post("{}"), down.deps);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(KEY);
    expect(JSON.stringify(down.logs)).not.toContain(KEY);
  });

  it("passes an endpoint's own error through, status and body", async () => {
    const h = harness({ upstream: async () => new Response('{"error":{"message":"bad model"}}', { status: 400, headers: { "content-type": "application/json" } }) });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "bad model" } });
  });

  it("passes a usage limit back in the vendor's own shape, so the CLI pauses at its reset, and logs its class (SPI-1172)", async () => {
    const body = JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: 1_794_834_000 } });
    const h = harness({ upstream: async () => new Response(body, { status: 429, headers: { "content-type": "application/json", "retry-after": "3600", "x-codex-primary-used-percent": "100" } }) });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(response.headers.get("x-codex-primary-used-percent")).toBe("100");
    expect(await response.text()).toBe(body);
    expect(h.logs.at(-1)).toMatchObject({ status: 429, failure: { class: "usage_limit", code: "usage_limit", resetAt: 1_794_834_000_000 } });
  });

  it("redacts an error body before it reaches the CLI: the endpoint's own key, and any key, bearer or JWT shape (SPI-1172)", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl";
    const echo = JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}; also sk-proj-AbCdEfGhIjKlMnOpQrSt and Bearer ${jwt}`, type: "invalid_request_error", code: "invalid_api_key" } });
    const h = harness({ upstream: async () => new Response(echo, { status: 401, headers: { "content-type": "application/json", "content-length": String(echo.length) } }) });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect(response.status).toBe(401);
    const text = await response.text();
    for (const secret of [KEY, "sk-proj-AbCdEfGhIjKlMnOpQrSt", jwt]) expect(text).not.toContain(secret);
    // Still the vendor's JSON, its code intact, so the CLI reads it as it would the vendor's.
    expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_api_key", type: "invalid_request_error" } });
    expect(response.headers.get("content-length")).toBeNull();
    expect(h.logs.at(-1)).toMatchObject({ status: 401, failure: { class: "permission_error", code: "key_refused" } });
    expect(JSON.stringify(h.logs)).not.toContain(KEY);
  });

  it("redacts the endpoint's own key whatever its shape, and only the credential: another header's value stays (SPI-1172)", async () => {
    const own = "gateway-key-not-sk-shaped";
    const grant = { ...granted, target: { ...granted.target, headers: { "X-Org": "acme-organisation-long-id", authorization: `Bearer ${own}` } } } as ModelRelayGrant;
    const h = harness({ grant, upstream: async () => Response.json({ error: { message: `key ${own} refused for org acme-organisation-long-id`, code: "invalid_api_key" } }, { status: 401 }) });
    const text = await (await handleModelRelay(post("{}"), h.deps)).text();
    expect(text).not.toContain(own);
    expect(text).toContain("acme-organisation-long-id");
  });

  it("drops content-length and content-encoding from a redacted error answer: its body was read decoded and changed length", async () => {
    const body = JSON.stringify({ error: { message: `bad key ${KEY}`, code: "invalid_api_key" } });
    const h = harness({ upstream: async () => new Response(body, { status: 401, headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.length) } }) });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("passes a 20 KiB error body back whole, redacted and still JSON; one over 1 MiB is replaced by a short error in the API's shape", async () => {
    const big = JSON.stringify({ error: { message: `${"x".repeat(20 * 1024)} ${KEY}`, type: "invalid_request_error", code: "context_length_exceeded" } });
    const h = harness({ upstream: async () => new Response(big, { status: 400, headers: { "content-type": "application/json" } }) });
    const text = await (await handleModelRelay(post("{}"), h.deps)).text();
    expect(text.length).toBeGreaterThan(20 * 1024);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "context_length_exceeded" } });
    expect(text).not.toContain(KEY);
    const huge = new Response(`{"error":{"message":"${"y".repeat(RELAY_ERROR_BODY_BYTES + 10)}"}}`, { status: 500 });
    const over = harness({ upstream: async () => huge });
    const answer = await handleModelRelay(post("{}"), over.deps);
    expect(answer.status).toBe(500);
    expect(JSON.parse(await answer.text())).toMatchObject({ error: { type: "server_error", message: expect.stringContaining("over 1048576 bytes") } });
    expect(over.logs.at(-1)).toMatchObject({ oversized: true });
  });

  it("an error event inside a 200 stream is redacted, classified, logged and reported; the rest streams unchanged", async () => {
    const reported: Array<unknown> = [];
    const frames = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded for ${KEY}"}}\n\n`,
    ];
    const h = harness({
      grant: { ...granted, target: { api: "anthropic-messages", auth: "api-key", baseUrl: "https://api.anthropic.example", headers: { "x-api-key": KEY } } } as ModelRelayGrant,
      upstream: async () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const deps = { ...h.deps, outcome: async (handleId: string, failure: unknown) => void reported.push([handleId, failure]) };
    const text = await (await handleModelRelay(post("{}"), deps)).text();
    expect(text.startsWith(frames[0]!)).toBe(true);
    expect(text).toContain('"overloaded_error"');
    expect(text).not.toContain(KEY);
    expect(h.logs.at(-1)).toMatchObject({ stream: "error-event", failure: { class: "provider_error", code: "overloaded" } });
    expect(reported).toEqual([
      ["proc-1", null],
      ["proc-1", expect.objectContaining({ endpointId: "openai", code: "overloaded" })],
    ]);
  });

  it("an OpenAI-compatible Completions error chunk (`{\"error\":…}`, no type) inside a 200 stream is redacted, classified and reported", async () => {
    const reported: Array<unknown> = [];
    const frames = ['data: {"id":"c1","object":"chat.completion.chunk","choices":[]}\n\n', `data: {"error":{"message":"Incorrect API key provided: ${KEY}","type":"invalid_request_error","code":"insufficient_quota"}}\n\n`, "data: [DONE]\n\n"];
    const h = harness({ upstream: async () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const deps = { ...h.deps, outcome: async (handleId: string, failure: unknown) => void reported.push([handleId, failure]) };
    const text = await (await handleModelRelay(post("{}"), deps)).text();
    expect(text).not.toContain(KEY);
    expect(text.startsWith(frames[0]!)).toBe(true);
    expect(text.endsWith(frames[2]!)).toBe(true);
    expect(h.logs.at(-1)).toMatchObject({ stream: "error-event", failure: { code: "spend_limit" } });
    expect(reported.at(-1)).toEqual(["proc-1", expect.objectContaining({ code: "spend_limit" })]);
  });

  it("reports each answer as the process's last: a classified failure with its reset, a success as null (SPI-1172)", async () => {
    const reported: Array<unknown> = [];
    const limit = JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: 1_794_834_000 } });
    let calls = 0;
    const h = harness({ upstream: async () => (calls++ === 0 ? new Response(limit, { status: 429 }) : new Response("{}", { status: 200 })) });
    const deps = { ...h.deps, outcome: async (handleId: string, failure: unknown) => void reported.push([handleId, failure]) };
    await handleModelRelay(post("{}"), deps);
    await handleModelRelay(post("{}"), deps);
    expect(reported).toEqual([
      ["proc-1", expect.objectContaining({ endpointId: "openai", class: "usage_limit", code: "usage_limit", resetAt: 1_794_834_000_000, message: 'The Model endpoint "openai" reached its usage limit.' })],
      ["proc-1", null],
    ]);
  });

  it("streams a success unread: only an error answer's body is read and redacted", async () => {
    const h = harness({ upstream: async () => new Response(`data: ${KEY}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const response = await handleModelRelay(post("{}"), h.deps);
    expect(await response.text()).toBe(`data: ${KEY}\n\n`);
    expect(h.logs.at(-1)).not.toHaveProperty("failure");
  });

  it("logs every request with its endpoint, status and handle id, never a handle or a key", async () => {
    const h = harness();
    await handleModelRelay(post("{}"), h.deps);
    await handleModelRelay(new Request(URL_, { method: "POST", body: "{}" }), h.deps);
    const refused = harness({ grant: { kind: "refused", status: 404, message: "no Model endpoint openai", handleId: "proc-1", workspace: "ws-1" } });
    await handleModelRelay(post("{}"), refused.deps);
    const logs = [...h.logs, ...refused.logs];
    expect(logs).toEqual([
      expect.objectContaining({ t3flare: "model-relay", endpoint: "openai", status: 200, handle: "proc-1", cli: "codex", workspace: "ws-1" }),
      expect.objectContaining({ t3flare: "model-relay", endpoint: "openai", status: 401, handle: null }),
      expect.objectContaining({ t3flare: "model-relay", endpoint: "openai", status: 404, handle: "proc-1" }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(HANDLE);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });
});

describe("the model-routed relay URL (SPI-1168: one base URL for every endpoint of a CLI's API)", () => {
  const ROUTED = "http://computer.internal/t3flare/model/_/v1/messages?beta=true";
  const anthropic = (endpointId: string): ModelRelayGrant => ({
    ...granted,
    cli: "claude",
    target: { api: "anthropic-messages", auth: "api-key", baseUrl: `https://${endpointId}.example/v1`, headers: { "x-api-key": KEY } },
  });
  /** The Workspace DO as it answers: `known` for a live handle asked with no endpoint, the endpoint's target otherwise. */
  const routedHarness = (live = true) => {
    const h = harness();
    h.deps = {
      ...h.deps,
      authorize: async (input) => {
        h.asked.push(input);
        if (!live) return { kind: "refused", status: 401, message: "unknown or revoked model handle", handleId: null, workspace: "ws-1" };
        return input.endpointId === null ? { kind: "known", handleId: "proc-1", cli: "claude", workspace: "ws-1" } : anthropic(input.endpointId);
      },
    };
    return h;
  };
  /** A body whose stream records whether anyone read it. */
  const watched = (text: string) => {
    const state = { pulled: false };
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        state.pulled = true;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }, { highWaterMark: 0 });
    return { state, request: new Request(ROUTED, { method: "POST", headers: { "content-type": "application/json", "x-api-key": HANDLE }, body, ...({ duplex: "half" } as RequestInit) }) };
  };

  it("checks the handle, then sends the request to the endpoint its body's model slug names, with the model's own id and the rest of the body byte for byte", async () => {
    const h = routedHarness();
    const body = '{"max_tokens":9007199254740993,"model" : "comm2/claude-sonnet-4-5","messages":[{"role":"user","content":"the \\"model\\": \\"x/y\\" text é"}],"metadata":{"model":"comm/other"},"stream":true}';
    const response = await handleModelRelay(post(body, { "x-api-key": HANDLE, "content-length": String(new TextEncoder().encode(body).length), "anthropic-version": "2023-06-01" }, ROUTED), h.deps);
    expect(response.status).toBe(200);
    expect(h.asked).toEqual([
      { handle: HANDLE, endpointId: null },
      { handle: HANDLE, endpointId: "comm2" },
    ]);
    const upstream = h.sent[0]!;
    expect(upstream.url).toBe("https://comm2.example/v1/v1/messages?beta=true");
    expect(await upstream.text()).toBe(body.replace('"comm2/claude-sonnet-4-5"', '"claude-sonnet-4-5"'));
    // The Container's length was the slug's: the body's own goes instead.
    expect(upstream.headers.get("content-length")).toBeNull();
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstream.headers.get("x-api-key")).toBe(KEY);
    expect(h.logs[0]).toMatchObject({ endpoint: "comm2", routed: true, status: 200, handle: "proc-1" });
  });

  it("refuses an unknown or revoked handle (401) without reading the body", async () => {
    const h = routedHarness(false);
    const { state, request } = watched('{"model":"comm/claude-haiku-5-5"}');
    expect((await handleModelRelay(request, h.deps)).status).toBe(401);
    expect(state.pulled).toBe(false);
    expect(h.asked).toEqual([{ handle: HANDLE, endpointId: null }]);
    // A live handle's body is read.
    const live = routedHarness();
    const read = watched('{"model":"comm/claude-haiku-5-5"}');
    expect((await handleModelRelay(read.request, live.deps)).status).toBe(200);
    expect(read.state.pulled).toBe(true);
  });

  it("lets the handle's scope judge the endpoint the body names", async () => {
    const h = harness({ grant: { kind: "refused", status: 403, message: "not for this endpoint", handleId: "proc-1", workspace: "ws-1" } });
    h.deps = { ...h.deps, authorize: async (input) => (h.asked.push(input), input.endpointId === null ? { kind: "known", handleId: "proc-1", cli: "claude", workspace: "ws-1" } : { kind: "refused", status: 403, message: "not for this endpoint", handleId: "proc-1", workspace: "ws-1" }) };
    expect((await handleModelRelay(post('{"model":"other/m"}', {}, ROUTED), h.deps)).status).toBe(403);
    expect(h.asked.map((input) => input.endpointId)).toEqual([null, "other"]);
    expect(h.sent).toEqual([]);
  });

  it("refuses a body that names no endpoint's model, or names one ambiguously (400), asking for no endpoint", async () => {
    const h = routedHarness();
    const deep = `{"a":${"[".repeat(600)}${"]".repeat(600)},"model":"comm/a"}`;
    for (const body of [
      "",
      "not json",
      "[]",
      '{"messages":[]}',
      '{"model":"claude-sonnet-4-5"}',
      '{"model":"/m"}',
      '{"model":"Not_An_Id/m"}',
      '{"model":"comm/"}',
      '{"model":42}',
      // Two top-level models, one escaped: an upstream may read either one.
      '{"model":"comm/a","model":"comm2/b"}',
      '{"mod\\u0065l":"comm/a","model":"comm2/b"}',
      // Malformed around the model: unterminated, or brackets that do not match.
      '{"model":"comm/a',
      '{"a":{"x":[1}],"model":"comm/a"}',
      '{"model":"comm/a"} trailing',
      // A byte-order mark is not JSON; nesting past MAX_NESTING is refused.
      '\ufeff{"model":"comm/a"}',
      deep,
    ]) {
      expect((await handleModelRelay(post(body, {}, ROUTED), h.deps)).status, body.slice(0, 40)).toBe(400);
    }
    // A request without a body (a GET) names no model either.
    expect((await handleModelRelay(new Request("http://computer.internal/t3flare/model/_/v1/models", { headers: { "x-api-key": HANDLE } }), h.deps)).status).toBe(400);
    expect(h.asked.every((input) => input.endpointId === null)).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.logs.every((entry) => entry.status === 400 && entry.routed === true && entry.endpoint === null)).toBe(true);
  });

  it("refuses a handle-less request, and a declared length over the cap before asking anyone; a body over the cap (413)", async () => {
    const h = routedHarness();
    expect((await handleModelRelay(new Request(ROUTED, { method: "POST", body: '{"model":"comm/a"}' }), h.deps)).status).toBe(401);
    const { state, request } = watched('{"model":"comm/a"}');
    request.headers.set("content-length", String(MAX_ROUTED_BODY_BYTES + 1));
    expect((await handleModelRelay(request, h.deps)).status).toBe(413);
    expect(state.pulled).toBe(false);
    expect(h.asked).toEqual([]);
    const big = `{"model":"comm/a","pad":"${"x".repeat(MAX_ROUTED_BODY_BYTES)}"}`;
    expect((await handleModelRelay(post(big, {}, ROUTED), h.deps)).status).toBe(413);
    expect(h.sent).toEqual([]);
  });

  it("is never an endpoint's id", () => {
    expect(ENDPOINT_ID.test(MODEL_ROUTED_ID)).toBe(false);
    expect(modelRoutedRelayUrl).toBe("http://computer.internal/t3flare/model/_");
  });
});

describe("the Workspace DO's check of a model handle", () => {
  const caller = { key: "proc-1", cli: "codex", thread: "thread-1", endpoints: new Set(["openai"]) };
  const target = { ok: true as const, api: "openai-responses" as const, auth: "api-key" as const, baseUrl: "https://api.example.com/v1", headers: { authorization: `Bearer ${KEY}` }, key: KEY };
  const deps = (extra: Partial<Parameters<typeof authorizeModelRelay>[1]> = {}) => {
    const remembered: Array<[string, string]> = [];
    const asked: Array<string> = [];
    return {
      remembered,
      asked,
      value: {
        workspace: "ws-1",
        destroyed: false,
        caller: (handle: string | null) => (handle === HANDLE ? caller : null),
        target: async (endpointId: string) => {
          asked.push(endpointId);
          return target;
        },
        remember: async (endpointId: string, key: string) => void remembered.push([endpointId, key]),
        ...extra,
      },
    };
  };

  it("grants a live handle its configured endpoint, with the target, and remembers the key for the sync guard", async () => {
    const d = deps();
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "openai" }, d.value)).toEqual({
      kind: "granted",
      handleId: "proc-1",
      cli: "codex",
      workspace: "ws-1",
      target: { api: "openai-responses", auth: "api-key", baseUrl: "https://api.example.com/v1", headers: { authorization: `Bearer ${KEY}` } },
    });
    expect(d.remembered).toEqual([["openai", KEY]]);
  });

  it("with no endpoint, says only whether the handle is live, asking the Environment nothing", async () => {
    const d = deps();
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: null }, d.value)).toEqual({ kind: "known", handleId: "proc-1", cli: "codex", workspace: "ws-1" });
    expect(await authorizeModelRelay({ handle: "f".repeat(64), endpointId: null }, d.value)).toMatchObject({ kind: "refused", status: 401 });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: null }, deps({ destroyed: true }).value)).toMatchObject({ kind: "refused", status: 410 });
    expect([...d.asked, ...d.remembered]).toEqual([]);
  });

  it("refuses an unknown or revoked handle (401), an endpoint the process is not configured for (403), and a deleted Workspace (410), asking no one", async () => {
    const d = deps();
    expect(await authorizeModelRelay({ handle: "f".repeat(64), endpointId: "openai" }, d.value)).toMatchObject({ kind: "refused", status: 401, handleId: null });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "other" }, d.value)).toMatchObject({ kind: "refused", status: 403, handleId: "proc-1" });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "openai" }, deps({ destroyed: true }).value)).toMatchObject({ kind: "refused", status: 410 });
    expect(d.asked).toEqual([]);
    expect(d.remembered).toEqual([]);
  });

  it("passes the Environment's refusal on, and remembers nothing for an endpoint without a key", async () => {
    const gone = deps({ target: async () => ({ ok: false, status: 404, message: "no Model endpoint openai" }) });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "openai" }, gone.value)).toMatchObject({ kind: "refused", status: 404, handleId: "proc-1" });
    const keyless = deps({ target: async () => ({ ...target, headers: {}, key: null }) });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "openai" }, keyless.value)).toMatchObject({ kind: "granted" });
    expect([...gone.remembered, ...keyless.remembered]).toEqual([]);
  });

  it("grants a sign-in its token of this request, remembered for the sync guard, and passes a sign-in's refusal on with why (SPI-1171)", async () => {
    const signedIn = deps({ target: async () => ({ ok: true, api: "openai-responses", auth: "chatgpt", baseUrl: "https://api.openai.com/v1", headers: { authorization: "Bearer oai-access-token-1" }, key: "oai-access-token-1" }) });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "openai" }, signedIn.value)).toMatchObject({ kind: "granted", target: { auth: "chatgpt" } });
    expect(signedIn.remembered).toEqual([["openai", "oai-access-token-1"]]);
    const signIn = { api: "openai-responses" as const, kind: "chatgpt" as const, signedOut: true, problem: "it is not signed in" };
    const out = deps({ target: async () => ({ ok: false, status: 401, message: "not signed in", signIn }) });
    expect(await authorizeModelRelay({ handle: HANDLE, endpointId: "openai" }, out.value)).toEqual({ kind: "refused", status: 401, message: "not signed in", handleId: "proc-1", workspace: "ws-1", signIn });
  });
});

describe("each process's most telling relay failure this turn (SPI-1172, review 2)", () => {
  const limit = { endpointId: "openai", class: "usage_limit" as const, code: "usage_limit", message: "m", retryable: true, stop: true, at: 1 };
  const overload = { endpointId: "openai", class: "provider_error" as const, code: "overloaded", message: "o", retryable: true, stop: false, at: 2 };

  it("a background request's success never clears the turn's usage limit; a retried overload that then succeeded is forgotten", () => {
    const failures = new RelayFailures();
    failures.report("proc-1", limit);
    failures.report("proc-1", null);
    expect(failures.last("proc-1")).toEqual(limit);
    failures.report("proc-2", overload);
    failures.report("proc-2", null);
    expect(failures.last("proc-2")).toBeNull();
  });

  it("a passing failure never hides a stop; a later stop replaces an earlier one; a stop replaces a passing one", () => {
    const failures = new RelayFailures();
    failures.report("proc-1", limit);
    failures.report("proc-1", overload);
    expect(failures.last("proc-1")).toEqual(limit);
    const refused = { ...limit, class: "permission_error" as const, code: "key_refused", at: 3 };
    failures.report("proc-1", refused);
    expect(failures.last("proc-1")).toEqual(refused);
    failures.report("proc-2", overload);
    failures.report("proc-2", limit);
    expect(failures.last("proc-2")).toEqual(limit);
  });

  it("a turn's start forgets it, per process; a turn's end does not", () => {
    const failures = new RelayFailures();
    failures.report("proc-1", limit);
    failures.report("proc-2", limit);
    failures.turn("proc-1", false);
    expect(failures.last("proc-1")).toEqual(limit);
    failures.turn("proc-1", true);
    expect(failures.last("proc-1")).toBeNull();
    expect(failures.last("proc-2")).toEqual(limit);
  });
});

describe("the relay's own failure clears a passing record (SPI-1172, review 2)", () => {
  it("an unreachable endpoint and a redirect each report null, before the CLI has the answer", async () => {
    for (const upstream of [async () => Promise.reject(new TypeError("fetch failed")), async () => new Response("", { status: 302, headers: { location: "https://x" } })]) {
      const reported: Array<unknown> = [];
      const h = harness({ upstream });
      await handleModelRelay(post("{}"), { ...h.deps, outcome: async (handleId: string, failure: unknown) => void reported.push([handleId, failure]) });
      expect(reported).toEqual([["proc-1", null]]);
    }
  });
});

describe("WorkspaceProxy's relay deps (SPI-1172, review 2)", () => {
  it("report each answer to the Workspace DO, and the CLI's answer waits for the report", async () => {
    const order: Array<string> = [];
    let release!: () => void;
    const rpc = {
      modelRelay: async () => granted,
      modelRelayOutcome: (input: { readonly handleId: string; readonly failure: unknown }) =>
        new Promise<void>((resolve) => {
          order.push(`reported ${input.handleId} ${input.failure === null ? "null" : "failure"}`);
          release = resolve;
        }),
    };
    const deps = workspaceRelayDeps(rpc, { fetch: async () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }), log: () => undefined, now: () => 1, usage: () => undefined, limits: () => undefined });
    const answered = handleModelRelay(post("{}"), deps).then(() => order.push("answered"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["reported proc-1 failure"]);
    release();
    await answered;
    expect(order).toEqual(["reported proc-1 failure", "answered"]);
  });
});

describe("the over-cap replacement in each API's own error shape (SPI-1172, review 2)", () => {
  it("Anthropic's, OpenAI's, Google's google.rpc.Status and Mistral's error object", () => {
    expect(JSON.parse(oversizedError("anthropic-messages", 500))).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(JSON.parse(oversizedError("openai-completions", 400))).toMatchObject({ error: { type: "invalid_request_error", code: null } });
    expect(JSON.parse(oversizedError("google-generative-ai", 503))).toMatchObject({ error: { code: 503, status: "INTERNAL" } });
    expect(JSON.parse(oversizedError("mistral-conversations", 400))).toMatchObject({ object: "error", type: "invalid_request_error", code: "400" });
  });
});

describe("a stream's error events, held only while a line may be one (SPI-1172, rebased on SPI-1173; review 3)", () => {
  /** The watcher over `pieces`: what it passed on per piece, and what it reported. `gate` holds each report until opened. */
  const run = async (pieces: ReadonlyArray<string>, gate?: Promise<void>) => {
    const reported: Array<{ readonly body: string; readonly status?: number }> = [];
    const emitted: Array<string> = [];
    const watcher = sseErrors(
      (text) => text.replaceAll(KEY, "[redacted]"),
      async (error) => {
        reported.push(error);
        await gate;
      },
    );
    const reading = (async () => {
      const reader = watcher.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        emitted.push(new TextDecoder().decode(value));
      }
    })();
    const writer = watcher.writable.getWriter();
    for (const piece of pieces) await writer.write(new TextEncoder().encode(piece));
    await writer.close();
    await reading;
    return { reported, emitted, text: emitted.join("") };
  };
  const anthropicError = `{"type":"error","error":{"type":"overloaded_error","message":"${KEY}"}}`;

  it("an error event cut across pieces is held to its end, redacted and reported; other lines go on piece by piece", async () => {
    const { reported, emitted, text } = await run(['data: {"type":"message_st', 'art"}\n\ndata: {"type":"err', `or","error":{"type":"overloaded_error","message":"${KEY}"}}\n\n`]);
    expect(emitted[0]).toBe('data: {"type":"message_st');
    expect(text).not.toContain(KEY);
    expect(text).toContain('"overloaded_error"');
    expect(reported).toHaveLength(1);
  });

  it("spaced JSON and no space after data: are error events too", async () => {
    for (const line of [`data:${anthropicError}`, `data:  { "type": "error", "error": { "type": "overloaded_error", "message": "${KEY}" } }`, `data: { "error": { "message": "${KEY}", "code": "insufficient_quota" } }`]) {
      const { reported, text } = await run([`${line}\n\n`]);
      expect(text, line).not.toContain(KEY);
      expect(reported, line).toHaveLength(1);
    }
  });

  it("a line decided as passing stays passing across pieces, even when its continuation looks like an opening", async () => {
    const pieces = ['data: {"type":"content_block_delta","delta":{"text":"', `data: {"type":"error" ${KEY}`, '"}}\n\n'];
    const { reported, emitted, text } = await run(pieces);
    expect(text).toBe(pieces.join(""));
    expect(emitted[1]).toBe(pieces[1]);
    expect(reported).toEqual([]);
  });

  it("CRLF line ends, event: lines, and a held line with no final newline flushed at the end", async () => {
    const crlf = await run([`event: error\r\ndata: ${anthropicError}\r\n\r\n`]);
    expect(crlf.text).toBe(`event: error\r\ndata: ${anthropicError.replace(KEY, "[redacted]")}\r\n\r\n`);
    expect(crlf.reported).toHaveLength(1);
    const unterminated = await run([`data: ${anthropicError}`]);
    expect(unterminated.text).toBe(`data: ${anthropicError.replace(KEY, "[redacted]")}`);
    expect(unterminated.reported).toHaveLength(1);
  });

  it("OpenAI Responses' response.failed and Mistral's conversation.response.error, the latter's code its status", async () => {
    const failed = await run([`data: {"type":"response.failed","response":{"error":{"code":"insufficient_quota","message":"${KEY}"}}}\n\n`]);
    expect(failed.text).not.toContain(KEY);
    // The report is for the classifier only (never passed on), so it is the event as it came.
    expect(JSON.parse(failed.reported[0]!.body)).toEqual({ error: { code: "insufficient_quota", message: KEY } });
    const mistral = await run([`data: {"type":"conversation.response.error","message":"rate limited ${KEY}","code":429}\n\n`]);
    expect(mistral.text).not.toContain(KEY);
    expect(mistral.reported).toEqual([{ body: expect.stringContaining("conversation.response.error"), status: 429 }]);
  });

  it("an error event's line goes on only after its report", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const watcher = run([`data: ${anthropicError}\n\n`], gate);
    await new Promise((resolve) => setTimeout(resolve, 10));
    let settled = false;
    void watcher.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    open();
    expect((await watcher).reported).toHaveLength(1);
  });
});

describe("the relay waits for each report before the CLI has the answer (SPI-1172, review 3)", () => {
  const gated = () => {
    const reported: Array<unknown> = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    return { reported, open, outcome: async (handleId: string, failure: unknown) => { reported.push([handleId, failure]); await gate; } };
  };

  it("a success's report", async () => {
    const g = gated();
    const h = harness();
    let answered = false;
    const answer = handleModelRelay(post("{}"), { ...h.deps, outcome: g.outcome }).then((response) => ((answered = true), response));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(g.reported).toEqual([["proc-1", null]]);
    expect(answered).toBe(false);
    g.open();
    expect((await answer).status).toBe(200);
  });

  it("a stream error event's report, before its line reaches the CLI; a response.failed event is classified", async () => {
    const g = gated();
    const frames = ['data: {"type":"response.created"}\n\n', `data: {"type":"response.failed","response":{"error":{"code":"insufficient_quota","message":"${KEY}"}}}\n\n`];
    const h = harness({ upstream: async () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } }) });
    g.open();
    const gate2 = gated();
    let reports = 0;
    const response = await handleModelRelay(post("{}"), {
      ...h.deps,
      outcome: async (handleId, failure) => {
        reports++;
        if (reports > 1) await gate2.outcome(handleId, failure);
      },
    });
    let done = false;
    const text = response.text().then((body) => ((done = true), body));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(gate2.reported).toEqual([["proc-1", expect.objectContaining({ code: "spend_limit" })]]);
    gate2.open();
    expect(await text).not.toContain(KEY);
    expect(h.logs.at(-1)).toMatchObject({ stream: "error-event", failure: { code: "spend_limit" } });
  });
});
