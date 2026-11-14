// The model relay's route in `WorkspaceProxy` (SPI-1167): a CLI's request to `/t3flare/model/<endpointId>/…` with its
// model handle goes to the endpoint's base URL with the endpoint's credential in place of the handle, the request and
// the answer streamed through unchanged; the handle never leaves, and every request is logged without a value.
// @effect-diagnostics globalTimers:off newPromise:off
import { describe, expect, it } from "vitest";

import { handleModelRelay, isModelRelayPath, type ModelRelayDeps, type ModelRelayGrant } from "../src/workspace/modelRelay.ts";

const HANDLE = "a".repeat(64);
const KEY = "sk-endpoint-secret-1";
const URL_ = "http://computer.internal/t3flare/model/openai/responses";

const granted: ModelRelayGrant = {
  kind: "granted",
  handleId: "proc-1",
  cli: "codex",
  workspace: "ws-1",
  target: { baseUrl: "https://api.example.com/v1", headers: { "X-Org": "acme", authorization: `Bearer ${KEY}` } },
};

const harness = (options: { grant?: ModelRelayGrant; upstream?: (request: Request) => Promise<Response> } = {}) => {
  const asked: Array<{ handle: string | null; endpointId: string }> = [];
  const sent: Array<Request> = [];
  const logs: Array<Record<string, unknown>> = [];
  let now = 1_000;
  const deps: ModelRelayDeps = {
    authorize: async (input) => {
      asked.push(input);
      return options.grant ?? granted;
    },
    fetch: async (request) => {
      sent.push(request);
      return options.upstream === undefined ? new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }) : options.upstream(request);
    },
    log: (event) => void logs.push(event),
    now: () => (now += 5),
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
    expect(upstream.headers.get("x-request-id")).toBe("r1");
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

  it("answers 404 for a path that names no endpoint", async () => {
    const h = harness();
    for (const url of ["http://computer.internal/t3flare/model/", "http://computer.internal/t3flare/model/Not_An_Id/x", "http://computer.internal/t3flare/model/openai/../../model-key"]) {
      expect((await handleModelRelay(post("{}", {}, url), h.deps)).status).toBe(404);
    }
    expect(h.asked).toEqual([]);
  });

  it("never leaves the endpoint's base URL", async () => {
    const h = harness();
    expect((await handleModelRelay(post("{}", {}, "http://computer.internal/t3flare/model/openai/%2e%2e/%2e%2e/elsewhere"), h.deps)).status).toBe(404);
    expect(h.sent).toEqual([]);
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
