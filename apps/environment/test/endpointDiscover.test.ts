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
});
