// A sign-in endpoint on the model relay (SPI-1171): the CLI's request goes with the Credential broker's token of that
// request as a bearer, shaped by the sign-in's rules (the Session's own table, `SIGN_IN_REQUESTS`), and a sign-in that
// gives no token answers the CLI naming the sign-in, in its API's shape, and is the process's last answer for t3.
import { createModels, type FetchFunction } from "@earendil-works/pi-ai";
import type { EndpointCredential, ModelEndpoint, SignIn } from "@t3flare/models/endpoints";
import type { RelaySignInRefusal, RelayTarget } from "@t3flare/models/relay";
import type { UsageEntry } from "@t3flare/models/usage";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { endpointProviders } from "../src/session/models.ts";
import { planUsagePayload } from "../src/session/planUsage.ts";
import { handleModelRelay, MAX_ROUTED_BODY_BYTES, type ModelRelayDeps, type ModelRelayGrant } from "../src/workspace/modelRelay.ts";

const HANDLE = "b".repeat(64);
const OAT = "sk-ant-oat01-relayed-token";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const target = (auth: SignIn, token: string, extra: Partial<RelayTarget> = {}): RelayTarget => ({
  api: auth === "claude" ? "anthropic-messages" : "openai-responses",
  auth,
  baseUrl: auth === "claude" ? "https://api.anthropic.com" : auth === "chatgpt" ? "https://api.openai.com/v1" : "https://api.business.githubcopilot.com",
  headers: { authorization: `Bearer ${token}` },
  ...extra,
});
const granted = (relayTarget: RelayTarget): ModelRelayGrant => ({ kind: "granted", handleId: "proc-7", cli: "opencode", workspace: "ws-1", target: relayTarget });
const refused = (signIn: RelaySignInRefusal, status: number): ModelRelayGrant => ({ kind: "refused", status, message: "no token", handleId: "proc-7", workspace: "ws-1", signIn });

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly text: string;
}

const harness = (grants: ReadonlyArray<ModelRelayGrant>, upstream?: (request: Request) => Response) => {
  const sent: Array<Sent> = [];
  const logs: Array<Record<string, unknown>> = [];
  const outcomes: Array<EndpointFailureRecord | null> = [];
  const usage: Array<UsageEntry> = [];
  let asked = 0;
  let now = 1_000_000;
  const deps: ModelRelayDeps = {
    limits: () => undefined,
    authorize: async (input) => (input.endpointId === null ? { kind: "known", handleId: "proc-7", cli: "claude", workspace: "ws-1" } : grants[Math.min(asked++, grants.length - 1)]!),
    fetch: async (request) => {
      sent.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), text: await request.text() });
      return upstream?.(request) ?? new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    },
    log: (event) => void logs.push(event),
    now: () => (now += 5),
    usage: (entry) => void usage.push(entry),
    outcome: async (_handle, failure) => void outcomes.push(failure),
  };
  return { deps, sent, logs, outcomes, usage };
};

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`http://computer.internal/t3flare/model/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HANDLE}`, ...headers }, body });

describe("a ChatGPT sign-in on the model relay", () => {
  it("sends the CLI's body by plan usage's rules (the Session's), with the token as a bearer and no handle", async () => {
    const h = harness([granted(target("chatgpt", "oai-access-1"))]);
    const body = {
      model: "gpt-6.1-sol",
      store: true,
      stream: true,
      max_output_tokens: 4096,
      metadata: { a: "b" },
      previous_response_id: "resp_1",
      input: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "tool_search" }, { type: "function", name: "shell", parameters: {} }],
    };
    expect((await handleModelRelay(post("chatgpt/responses", JSON.stringify(body)), h.deps)).status).toBe(200);
    const sent = h.sent[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/responses");
    expect(sent.headers.authorization).toBe("Bearer oai-access-1");
    expect(JSON.parse(sent.text)).toEqual(planUsagePayload(body));
    expect(JSON.parse(sent.text)).toMatchObject({ store: false, stream: true, input: [{ role: "developer" }, { role: "user" }], tools: [{ type: "function" }] });
    expect(JSON.stringify(sent)).not.toContain(HANDLE);
    // The token's short id is logged, never the token.
    expect(h.logs.at(-1)).toMatchObject({ status: 200, signIn: "chatgpt", credential: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(JSON.stringify(h.logs)).not.toContain("oai-access-1");
  });

  it("takes each request's token from that request's grant: a token renewed mid-thread is the next request's", async () => {
    const h = harness([granted(target("chatgpt", "oai-access-1")), granted(target("chatgpt", "oai-access-2"))]);
    for (let turn = 0; turn < 2; turn++) await handleModelRelay(post("chatgpt/responses", '{"model":"gpt-6.1-sol","input":"hi","store":false,"stream":true}'), h.deps);
    expect(h.sent.map((sent) => sent.headers.authorization)).toEqual(["Bearer oai-access-1", "Bearer oai-access-2"]);
    const ids = h.logs.map((log) => log.credential);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("passes a body plan usage takes as it is, byte for byte", async () => {
    const h = harness([granted(target("chatgpt", "oai-access-1"))]);
    const body = '{ "model":"gpt-6.1-sol", "input":"hi", "store":false, "stream":true, "n": 9007199254740993 }';
    await handleModelRelay(post("chatgpt/responses", body), h.deps);
    expect(h.sent[0]!.text).toBe(body);
  });

  it("does not make a CLI's non-streaming call a streamed one (plan usage's rule forces `stream: true`)", async () => {
    const h = harness([granted(target("chatgpt", "oai-access-1"))]);
    await handleModelRelay(post("chatgpt/responses", JSON.stringify({ model: "gpt-6.1-sol", input: "hi", temperature: 0 })), h.deps);
    await handleModelRelay(post("chatgpt/responses", JSON.stringify({ model: "gpt-6.1-sol", input: "hi", stream: false, temperature: 0 })), h.deps);
    const [absent, off] = h.sent.map((sent) => JSON.parse(sent.text) as Record<string, unknown>);
    expect(absent).not.toHaveProperty("stream");
    expect(off).toMatchObject({ stream: false, store: false });
    // The rest of plan usage's rules still apply.
    expect(absent).not.toHaveProperty("temperature");
  });

  it("records the usage of a relayed sign-in request, as SPI-1173 records any", async () => {
    const events = [
      { type: "response.created", response: { id: "r1", model: "gpt-6.1-sol", usage: null } },
      { type: "response.completed", response: { id: "r1", model: "gpt-6.1-sol", output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 107 } } },
    ];
    const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const h = harness([granted(target("chatgpt", "oai-access-1"))], () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const response = await handleModelRelay(post("chatgpt/responses", '{"model":"gpt-6.1-sol","input":"hi","stream":true}'), h.deps);
    await response.text();
    expect(h.usage).toMatchObject([{ endpointId: "chatgpt", modelId: "gpt-6.1-sol", input: 100, output: 7 }]);
  });

  it("refuses a body over the cap before sending anything", async () => {
    const h = harness([granted(target("chatgpt", "oai-access-1"))]);
    const response = await handleModelRelay(post("chatgpt/responses", "x".repeat(MAX_ROUTED_BODY_BYTES + 1)), h.deps);
    expect(response.status).toBe(413);
    expect(h.sent).toEqual([]);
  });
});

/** The request pi-ai sends on `endpoint` with `credential`: one prompt with a system prompt and a `bash` tool. */
const piAiRequest = async (endpoint: ModelEndpoint, credential: EndpointCredential): Promise<Request> => {
  let captured: Request | undefined;
  const fetch = (async (input: unknown, init?: RequestInit) => {
    captured = input instanceof Request ? input.clone() : new Request(String(input), init);
    return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as FetchFunction;
  const models = createModels();
  for (const provider of endpointProviders({ revision: 1, endpoints: [endpoint] }, { credential: async () => credential, fetch })) models.setProvider(provider);
  const tool = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
  await models.completeSimple(models.getModel(endpoint.id, endpoint.models[0]!.id)!, { systemPrompt: "Be brief.", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [tool as never] }, { maxTokens: 500 });
  return captured!;
};

const claudeModel = { id: "claude-test-1", name: "Claude Test", reasoning: false, input: ["text" as const], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false };
const claudeEndpoint = (auth: "claude" | "api-key"): ModelEndpoint => ({ id: "claude", label: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth, headers: {}, models: [claudeModel] });

describe("a Claude sign-in on the model relay", () => {
  it("gives a CLI's API-key-shaped request the headers, betas and identity pi-ai gives the token itself", async () => {
    // What a pi-ai CLI sends on the relay: an API key's shape with its handle as the key, at the relay's URL.
    const cli = await piAiRequest({ ...claudeEndpoint("api-key"), baseUrl: "http://computer.internal/t3flare/model/claude" }, { apiKey: HANDLE });
    expect(cli.headers.get("x-api-key")).toBe(HANDLE);
    // What pi-ai sends with the subscription's token: the shape to reach.
    const own = await piAiRequest(claudeEndpoint("claude"), { apiKey: OAT });
    const h = harness([granted(target("claude", OAT))]);
    expect((await handleModelRelay(cli, h.deps)).status).toBe(200);
    const sent = h.sent[0]!;
    expect(sent.url).toBe(own.url);
    for (const name of ["authorization", "anthropic-beta", "user-agent", "x-app", "anthropic-dangerous-direct-browser-access", "anthropic-version", "content-type"]) {
      expect(sent.headers[name], name).toBe(own.headers.get(name) ?? undefined);
    }
    expect(sent.headers).not.toHaveProperty("x-api-key");
    const ownBody = (await own.json()) as { system: Array<{ text: string }> };
    expect((JSON.parse(sent.text) as { system: Array<{ text: string }> }).system.map((block) => block.text)).toEqual(ownBody.system.map((block) => block.text));
    expect(JSON.stringify(sent)).not.toContain(HANDLE);
  });

  it("keeps a CLI's own betas after Claude Code's, and leaves a system that already holds the identity as it is", async () => {
    const h = harness([granted(target("claude", OAT))]);
    const body = JSON.stringify({ model: "claude-haiku-5-5", system: [{ type: "text", text: "x-anthropic-billing-header: cc" }, { type: "text", text: `${IDENTITY}\n\nMore.` }], messages: [] });
    await handleModelRelay(post("claude/v1/messages", body, { "x-api-key": HANDLE, authorization: "", "anthropic-beta": "interleaved-thinking-2025-05-14, claude-code-20250219" }), h.deps);
    expect(h.sent[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14");
    expect(h.sent[0]!.text).toBe(body);
  });

  it("puts the identity first in a string system or none", async () => {
    const h = harness([granted(target("claude", OAT))]);
    await handleModelRelay(post("claude/v1/messages", JSON.stringify({ model: "m", system: "Be brief.", messages: [] })), h.deps);
    await handleModelRelay(post("claude/v1/messages", JSON.stringify({ model: "m", messages: [] })), h.deps);
    expect(JSON.parse(h.sent[0]!.text).system).toEqual([{ type: "text", text: IDENTITY }, { type: "text", text: "Be brief." }]);
    expect(JSON.parse(h.sent[1]!.text).system).toEqual([{ type: "text", text: IDENTITY }]);
  });

  it("shapes a model-routed request (Claude Code's) after routing it to the sign-in", async () => {
    const h = harness([granted(target("claude", OAT))]);
    const response = await handleModelRelay(post("_/v1/messages", JSON.stringify({ model: "claude/claude-haiku-5-5", system: "Be brief.", messages: [] }), { "x-api-key": HANDLE }), h.deps);
    expect(response.status).toBe(200);
    const sent = JSON.parse(h.sent[0]!.text) as { model: string; system: Array<{ text: string }> };
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.system.map((block) => block.text)).toEqual([IDENTITY, "Be brief."]);
    expect(h.sent[0]!.headers.authorization).toBe(`Bearer ${OAT}`);
  });

  it("redacts the token from an error answer that echoes it, whatever its shape", async () => {
    // A token no generic shape catches (not `sk-…`, no `Bearer ` before it in the echo): only the target's own bearer does.
    const plainToken = "Zq7xYw3Rk9Lm2Np5Tv8Bc4Df6Gh1Jk0";
    const h = harness([granted(target("claude", plainToken))], () => Response.json({ type: "error", error: { type: "authentication_error", message: `bad token ${plainToken}` } }, { status: 401 }));
    const response = await handleModelRelay(post("claude/v1/messages", '{"model":"m","messages":[]}'), h.deps);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(plainToken);
    expect(h.outcomes.at(-1)).toMatchObject({ code: "sign_in_refused", message: expect.stringContaining("Claude sign-in") });
  });
});

describe("a sign-in's paths on the model relay", () => {
  it("refuses every path but the sign-in's inference calls, sending nothing anywhere (no account or key-minting call)", async () => {
    const h = harness([granted(target("claude", OAT))]);
    for (const path of ["claude/api/oauth/claude_cli/create_api_key", "claude/api/oauth/profile", "claude/v1/models", "claude/v1/messages/batches", "claude/v1/messages/"]) {
      const response = await handleModelRelay(post(path, "{}"), h.deps);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain(OAT);
    }
    // Only a POST: no GET, HEAD, PUT or DELETE (review 2).
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH"]) {
      const request = new Request("http://computer.internal/t3flare/model/claude/v1/messages", { method, headers: { authorization: `Bearer ${HANDLE}` }, ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }) });
      expect((await handleModelRelay(request, h.deps)).status, method).toBe(404);
    }
    // The path as written: no case-folded match.
    for (const path of ["claude/V1/messages", "claude/v1/Messages", "claude/v1/MESSAGES/count_tokens"]) expect((await handleModelRelay(post(path, "{}"), h.deps)).status, path).toBe(404);
    const chatgpt = harness([granted(target("chatgpt", "oai-access-1"))]);
    for (const path of ["chatgpt/models", "chatgpt/files", "chatgpt/chat/completions", "chatgpt/responses/compact"]) expect((await handleModelRelay(post(path, "{}"), chatgpt.deps)).status, path).toBe(404);
    const copilot = harness([granted(target("copilot", "tid=copilot-1"))]);
    for (const path of ["copilot/chat/completions", "copilot/models", "copilot/v1/messages", "copilot/Responses"]) expect((await handleModelRelay(post(path, "{}"), copilot.deps)).status, path).toBe(404);
    expect([...h.sent, ...chatgpt.sent, ...copilot.sent]).toEqual([]);
    expect(h.logs.at(-1)).toMatchObject({ status: 404 });
  });

  it("carries each sign-in's inference calls", async () => {
    const cases: ReadonlyArray<readonly [SignIn, string, string]> = [
      ["claude", "claude/v1/messages?beta=true", "https://api.anthropic.com/v1/messages?beta=true"],
      ["claude", "claude/v1/messages/count_tokens", "https://api.anthropic.com/v1/messages/count_tokens"],
      ["chatgpt", "chatgpt/responses", "https://api.openai.com/v1/responses"],
      ["copilot", "copilot/responses", "https://api.business.githubcopilot.com/responses"],
    ];
    for (const [kind, path, url] of cases) {
      const h = harness([granted(target(kind, "tok-1"))]);
      expect((await handleModelRelay(post(path, '{"model":"m","messages":[],"input":"hi"}'), h.deps)).status, path).toBe(200);
      expect(h.sent[0]!.url).toBe(url);
    }
  });
});

describe("a GitHub Copilot sign-in on the model relay", () => {
  const editor = { "Editor-Version": "vscode/1.107.0", "Copilot-Integration-Id": "vscode-chat" };

  it("goes to the token's base URL with the editor headers and pi-ai's dynamic headers, without a thinking-off reasoning", async () => {
    const h = harness([granted(target("copilot", "tid=copilot-1", { headers: { ...editor, authorization: "Bearer tid=copilot-1" } }))]);
    const body = { model: "gpt-6.1-sol", reasoning: { effort: "none" }, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    await handleModelRelay(post("copilot/responses", JSON.stringify(body)), h.deps);
    const sent = h.sent[0]!;
    expect(sent.url).toBe("https://api.business.githubcopilot.com/responses");
    expect(sent.headers).toMatchObject({ "editor-version": "vscode/1.107.0", "copilot-integration-id": "vscode-chat", "x-initiator": "user", "openai-intent": "conversation-edits", authorization: "Bearer tid=copilot-1" });
    expect(sent.headers).not.toHaveProperty("copilot-vision-request");
    expect(JSON.parse(sent.text)).not.toHaveProperty("reasoning");
  });

  it("marks a request after a tool's output as the agent's, and one with an image as vision", async () => {
    const h = harness([granted(target("copilot", "tid=copilot-1"))]);
    const input = [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ];
    await handleModelRelay(post("copilot/responses", JSON.stringify({ model: "m", input })), h.deps);
    expect(h.sent[0]!.headers).toMatchObject({ "x-initiator": "agent", "copilot-vision-request": "true" });
  });
});

describe("a sign-in that gives no token", () => {
  it("answers the CLI in its API's shape naming the sign-in, and is the process's last answer for t3", async () => {
    const h = harness([refused({ api: "openai-responses", kind: "chatgpt", signedOut: true, problem: "it is not signed in" }, 401)]);
    const response = await handleModelRelay(post("chatgpt/responses", "{}"), h.deps);
    expect(response.status).toBe(401);
    const answer = (await response.json()) as { error: { message: string } };
    expect(answer.error.message).toMatch(/The Model endpoint "chatgpt" is not signed in to ChatGPT \(it is not signed in\): sign in with ChatGPT again on the Settings page/);
    expect(h.sent).toEqual([]);
    expect(h.outcomes).toEqual([
      { class: "permission_error", code: "sign_in_refused", retryable: false, stop: true, message: expect.stringContaining("not signed in to ChatGPT"), endpointId: "chatgpt", at: expect.any(Number) },
    ]);
    expect(h.logs.at(-1)).toMatchObject({ status: 401, signIn: "chatgpt", failure: { code: "sign_in_refused" } });
  });

  it("answers Anthropic's shape for a Claude sign-in", async () => {
    const h = harness([refused({ api: "anthropic-messages", kind: "claude", signedOut: true, problem: "it is not signed in" }, 401)]);
    const answer = (await (await handleModelRelay(post("claude/v1/messages", "{}"), h.deps)).json()) as { type: string; error: { type: string; message: string } };
    expect(answer).toMatchObject({ type: "error", error: { type: "authentication_error", message: expect.stringContaining("not signed in to Claude") } });
  });

  it("tells a CLI when to retry a passing failure the vendor asked to wait out, so its retries do not spin", async () => {
    const h = harness([refused({ api: "openai-responses", kind: "copilot", signedOut: false, problem: "its sign-in cannot be renewed yet", retryAt: 1_000_000 + 90_000 }, 503)]);
    const response = await handleModelRelay(post("copilot/responses", "{}"), h.deps);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(89);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(90);
    expect(h.outcomes[0]).toMatchObject({ class: "provider_error", code: "unavailable", retryable: true, message: expect.stringContaining("could not get a GitHub Copilot token") });
  });
});
