// The Claude subscription sign-in's pins on pi-ai (SPI-1165; docs/upstream-fragility.md U81):
// - the OAuth flow the Environment runs itself (credentials/claude.ts) uses the client, URLs and scopes of pi-ai's own
//   Anthropic flow, checked by running pi-ai's copy-code `login()` and `refresh()` against a stand-in fetch;
// - the request shape pi-ai sends for a Claude subscription's OAuth token (Bearer auth, Claude Code's betas, user agent
//   and identity as the system's first block, Claude Code's tool names), on a Claude sign-in endpoint's provider; and an
//   API-key endpoint on the same API gets none of it.
// A pi-ai bump that changes any of these fails here.
import { createModels, type FetchFunction } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_OAUTH_TOKEN_MARK, CLAUDE_REDIRECT_URI, CLAUDE_SCOPES, CLAUDE_TOKEN_URL } from "@t3flare/models/claudeOAuth";
import type { EndpointCredential, ModelEndpoint } from "@t3flare/models/endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { endpointProviders } from "../src/session/models.ts";

afterEach(() => vi.unstubAllGlobals());

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const CLAUDE: ModelEndpoint = {
  id: "claude",
  label: "Claude",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  auth: "claude",
  headers: {},
  models: [{ id: "claude-test-1", name: "Claude Test", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false }],
};

const anthropicOk = (text: string) => {
  const sse = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test-1", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
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
  readonly body: Record<string, unknown>;
}

/** One request with a system prompt and a `bash` tool on `endpoint`'s model, its credential `credential`. */
const requestOn = async (endpoint: ModelEndpoint, credential: EndpointCredential): Promise<Sent> => {
  const sent: Array<Sent> = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: JSON.parse(await request.text()) as Record<string, unknown> });
    return anthropicOk("ok");
  }) as FetchFunction;
  const models = createModels();
  for (const provider of endpointProviders({ revision: 1, endpoints: [endpoint] }, { credential: async () => credential, fetch })) models.setProvider(provider);
  const tool = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
  const message = await models.completeSimple(
    models.getModel(endpoint.id, endpoint.models[0]!.id)!,
    { systemPrompt: "Be brief.", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [tool as never] },
    { maxTokens: 500 },
  );
  expect(message.errorMessage).toBeUndefined();
  expect(sent).toHaveLength(1);
  return sent[0]!;
};

describe("a Claude sign-in on pi-ai", () => {
  it("runs pi-ai's own copy-code flow with the client, URLs and scopes the Environment's flow uses", async () => {
    const posted: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
      return Response.json({ access_token: "sk-ant-oat01-a", refresh_token: "sk-ant-ort01-r", expires_in: 28_800, token_type: "Bearer" });
    });
    const oauth = anthropicProvider().auth.oauth!;
    let authorizeUrl = "";
    await oauth.login({
      signal: new AbortController().signal,
      notify: (event: { readonly type: string; readonly url?: string }) => {
        if (event.type === "auth_url") authorizeUrl = event.url!;
      },
      prompt: async (prompt: { readonly type: string }) => {
        if (prompt.type === "select") return "copy_code";
        return `the-code#${new URL(authorizeUrl).searchParams.get("state")}`;
      },
    } as never);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_AUTHORIZE_URL);
    expect(Object.fromEntries([...url.searchParams].filter(([name]) => !["state", "code_challenge"].includes(name)))).toEqual({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_SCOPES,
      code_challenge_method: "S256",
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(CLAUDE_TOKEN_URL);
    expect(Object.keys(posted[0]!.body).sort()).toEqual(["client_id", "code", "code_verifier", "grant_type", "redirect_uri", "state"]);
    expect(posted[0]!.body).toMatchObject({ grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code: "the-code", redirect_uri: CLAUDE_REDIRECT_URI });

    await oauth.refresh({ type: "oauth", access: "sk-ant-oat01-a", refresh: "sk-ant-ort01-r", expires: 0 }, new AbortController().signal);
    expect(posted[1]).toEqual({ url: CLAUDE_TOKEN_URL, body: { grant_type: "refresh_token", client_id: CLAUDE_CLIENT_ID, refresh_token: "sk-ant-ort01-r" } });
  });

  it("sends an OAuth token with Claude Code's headers, betas, identity and tool names", async () => {
    // A token built from our mark gets pi-ai's OAuth shape: our mark is no looser than pi-ai's `isOAuthToken`.
    const token = `${CLAUDE_OAUTH_TOKEN_MARK}01-token`;
    const sent = await requestOn(CLAUDE, { apiKey: token, expiresAt: 4_000_000_000_000 });
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.280",
      "x-app": "cli",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(sent.headers).not.toHaveProperty("x-api-key");
    const system = sent.body.system as Array<{ readonly type: string; readonly text: string }>;
    expect(system.map((block) => block.text)).toEqual([IDENTITY, "Be brief."]);
    expect((sent.body.tools as Array<{ readonly name: string }>).map((tool) => tool.name)).toEqual(["Bash"]);
  });

  it("gives a key that falls one character short of our mark none of it: our mark is no stricter than pi-ai's", async () => {
    const sent = await requestOn({ ...CLAUDE, id: "anthropic-api", auth: "api-key" }, { apiKey: `${CLAUDE_OAUTH_TOKEN_MARK.slice(0, -1)}_-key` });
    expect(sent.headers).not.toHaveProperty("authorization");
    expect(sent.headers).not.toHaveProperty("x-app");
  });

  it("sends an API key on the same API with none of it", async () => {
    const sent = await requestOn({ ...CLAUDE, id: "anthropic-api", auth: "api-key" }, { apiKey: "sk-ant-api03-key" });
    expect(sent.headers["x-api-key"]).toBe("sk-ant-api03-key");
    expect(sent.headers).not.toHaveProperty("authorization");
    expect(sent.headers["anthropic-beta"] ?? "").not.toMatch(/oauth|claude-code/);
    expect(sent.headers["user-agent"]).not.toMatch(/claude-cli/);
    expect(sent.headers).not.toHaveProperty("x-app");
    expect((sent.body.system as Array<{ readonly text: string }>).map((block) => block.text)).toEqual(["Be brief."]);
    expect((sent.body.tools as Array<{ readonly name: string }>).map((tool) => tool.name)).toEqual(["bash"]);
  });
});
