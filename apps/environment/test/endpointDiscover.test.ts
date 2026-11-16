// A Model endpoint's model list (SPI-1162): read from the endpoint itself where its API has one, in each API's shape and
// with each API's way of sending the key; a failure says why, never the key.
import { describe, expect, it } from "vitest";

import { discoverModels } from "../src/endpoints/discover.ts";

type Seen = { url: string; headers: Record<string, string> };

const fake = (answer: (url: URL) => unknown, status = 200) => {
  const seen: Array<Seen> = [];
  const fetcher = (async (input: URL, init?: RequestInit) => {
    const url = new URL(input);
    seen.push({ url: url.toString(), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return Response.json(answer(url), { status });
  }) as typeof fetch;
  return { seen, fetcher };
};

describe("discoverModels", () => {
  it("reads an OpenAI-shaped list with a bearer key and the endpoint's headers", async () => {
    const { seen, fetcher } = fake(() => ({ object: "list", data: [{ id: "gpt-5-mini" }, { id: "gpt-5" }] }));
    const found = await discoverModels({ api: "openai-responses", baseUrl: "https://api.openai.com/v1", headers: { "X-Org": "me" } }, "sk-1", fetcher);
    expect(found).toEqual({ ok: true, models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] });
    expect(seen[0]).toMatchObject({ url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer sk-1", "x-org": "me" } });
  });

  it("reads ChatGPT plan usage's catalog: the slugs listed for display, with their names (SPI-1164)", async () => {
    const { seen, fetcher } = fake(() => ({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "gpt-internal", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-5-mini", visibility: "list" },
      ],
    }));
    const found = await discoverModels({ api: "openai-responses", baseUrl: "https://api.openai.com/v1", headers: {} }, "at-token", fetcher);
    expect(found).toEqual({ ok: true, models: [{ id: "gpt-5-mini" }, { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] });
    expect(seen[0]).toMatchObject({ url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer at-token" } });
  });

  it("reads Anthropic's paged list with its key header, names and limits", async () => {
    const { seen, fetcher } = fake((url) =>
      url.searchParams.get("after_id") === null
        ? { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", max_input_tokens: 200_000, max_tokens: 64_000 }], has_more: true, last_id: "claude-haiku-5-5" }
        : { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }], has_more: false },
    );
    const found = await discoverModels({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com", headers: {} }, "sk-ant", fetcher);
    expect(found).toEqual({
      ok: true,
      models: [
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextWindow: 200_000, maxTokens: 64_000 },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      ],
    });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(seen[0]!.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
  });

  it("reads Google's list, keeping only the models that generate content", async () => {
    const { seen, fetcher } = fake(() => ({
      models: [
        { name: "models/gemini-3-flash", displayName: "Gemini 3 Flash", inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-9", supportedGenerationMethods: ["embedContent"] },
      ],
    }));
    const found = await discoverModels({ api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", headers: {} }, "g-key", fetcher);
    expect(found).toEqual({ ok: true, models: [{ id: "gemini-3-flash", name: "Gemini 3 Flash", contextWindow: 1_000_000, maxTokens: 65_536 }] });
    expect(seen[0]!.headers["x-goog-api-key"]).toBe("g-key");
  });

  it("never follows a redirect with the key", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetcher = (async (_input: URL, init?: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/models" } });
    }) as typeof fetch;
    const found = await discoverModels({ api: "openai-responses", baseUrl: "https://api.openai.com/v1", headers: {} }, "sk-1", fetcher);
    expect(found).toMatchObject({ ok: false, error: expect.stringMatching(/redirected \(HTTP 302\)/) });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("says why a list could not be read, without the key", async () => {
    const { fetcher } = fake(() => ({ error: { message: "Incorrect API key provided: sk-secret" } }), 401);
    const found = await discoverModels({ api: "openai-completions", baseUrl: "https://example.test/v1", headers: {} }, "sk-secret", fetcher);
    expect(found).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 401/) });
    expect(JSON.stringify(found)).not.toContain("sk-secret");
  });

  it("reads GitHub Copilot's catalog by pi-ai's rules: chat models with tools the picker shows, on the endpoint's API (SPI-1166)", async () => {
    const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { type: "chat", supports: { tool_calls: true } }, ...extra });
    const { seen, fetcher } = fake(() => ({
      object: "list",
      data: [
        // On Responses in pi-ai's Copilot catalog.
        entry("gpt-6.1-sol"),
        // Copilot lists its endpoints: that wins.
        entry("gpt-new", { supported_endpoints: ["/chat/completions", "/responses"] }),
        entry("claude-sonnet-5.5", { supported_endpoints: ["/v1/messages", "/chat/completions"] }),
        // On Messages or Chat Completions in pi-ai's catalog, or unknown to it: not on this endpoint.
        entry("claude-haiku-4.5"),
        entry("gemini-3.8-flash"),
        entry("mystery-1"),
        // Not shown, disabled, without tools, not chat.
        entry("gpt-5.6-luna", { model_picker_enabled: false }),
        entry("gpt-6-sol", { policy: { state: "disabled" } }),
        entry("grok-4.7", { capabilities: { type: "chat", supports: { tool_calls: false } } }),
        entry("text-embedding-3-small", { capabilities: { type: "embeddings", supports: {} } }),
        // Unconfigured but shown: pi-ai lists it too.
        entry("grok-4.6", { policy: { state: "unconfigured" } }),
      ],
    }));
    const target = { api: "openai-responses" as const, baseUrl: "https://api.individual.githubcopilot.com", headers: { authorization: "Bearer tid=1", "Copilot-Integration-Id": "vscode-chat" } };
    expect(await discoverModels(target, undefined, fetcher)).toEqual({
      ok: true,
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1-SOL" },
        { id: "gpt-new", name: "GPT-NEW" },
        { id: "grok-4.6", name: "GROK-4.6" },
      ],
    });
    expect(seen[0]).toMatchObject({ url: "https://api.individual.githubcopilot.com/models", headers: { authorization: "Bearer tid=1", "copilot-integration-id": "vscode-chat" } });
  });

  it("falls back to an individual Copilot account's enabled policies when its picker shows none, as pi-ai does", async () => {
    const entry = (id: string, state: string) => ({ id, model_picker_enabled: false, policy: { state }, capabilities: { type: "chat", supports: { tool_calls: true } } });
    const { fetcher } = fake(() => ({ data: [entry("gpt-6.1-sol", "enabled"), entry("gpt-6-sol", "unconfigured")] }));
    const individual = { api: "openai-responses" as const, baseUrl: "https://api.individual.githubcopilot.com", headers: {} };
    expect(await discoverModels(individual, undefined, fetcher)).toEqual({ ok: true, models: [{ id: "gpt-6.1-sol" }] });
    expect(await discoverModels({ ...individual, baseUrl: "https://api.business.githubcopilot.com" }, undefined, fetcher)).toEqual({ ok: true, models: [] });
  });
});
