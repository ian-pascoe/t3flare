// The web tools (SPI-1054) over a fake network: `web_fetch` through the SSRF guard (cloudpid's fetch.test.ts cases that
// matter here), and `web_search` through the model proxy's search-capable model (an Anthropic Messages answer with
// `web_search_tool_result` blocks, as Commissary returns it for Claude and for Codex upstreams).
// @effect-diagnostics asyncFunction:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { webExtension } from "../../src/extensions/web.ts";
import { webFetchTool } from "../../src/extensions/web/fetch.ts";
import type { WebRequest, WebTransport } from "../../src/extensions/web/net.ts";
import { readAnswer, resultText, webSearchTool } from "../../src/extensions/web/search.ts";

const PUBLIC = "93.184.215.14";

/** A network: DoH answers from `dns` (public by default), every other request from `pages`. */
const network = (pages: (request: WebRequest) => Response, dns: Record<string, string> = {}) => {
  const sent: Array<WebRequest> = [];
  const transport: WebTransport = (request) => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type");
      const address = dns[name] ?? PUBLIC;
      const v6 = address.includes(":");
      const answer = (type === "AAAA") === v6 ? [{ type: v6 ? 28 : 1, data: address }] : [];
      return Promise.resolve(Response.json({ Status: 0, Answer: answer }));
    }
    sent.push(request);
    return Promise.resolve(pages(request));
  };
  return { transport, sent };
};

const run = async (tool: ToolRegistration, args: Record<string, unknown>) => {
  try {
    return { ok: true as const, result: await tool.execute(args as never, {} as never, BACKGROUND_CONTEXT) };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message };
  }
};

const textOf = (outcome: Awaited<ReturnType<typeof run>>) =>
  outcome.ok ? (outcome.result.output ?? []).map((block) => ("text" in block ? block.text : "")).join("") : outcome.error;

describe("web_fetch", () => {
  it("fetches a page as Markdown with its title and URL in details", async () => {
    const { transport, sent } = network(() => new Response("<html><head><title>Example</title></head><body><h1>Hello</h1><p>World</p></body></html>", { headers: { "content-type": "text/html" } }));
    const outcome = await run(webFetchTool(transport), { url: "https://example.com/a" });
    expect(textOf(outcome)).toContain("Hello");
    expect(sent[0]?.headers.accept).toContain("text/markdown");
    expect(outcome.ok && outcome.result.details).toMatchObject({ url: "https://example.com/a", format: "markdown" });
  });

  it("refuses a private address, a name that resolves to one, and a redirect to the metadata service", async () => {
    const { transport, sent } = network(
      (request) => (request.url.startsWith("https://public.example") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }) : new Response("no")),
      { "inside.example": "10.0.0.5" },
    );
    const tool = webFetchTool(transport);
    expect(textOf(await run(tool, { url: "http://127.0.0.1/" }))).toMatch(/Unable to fetch .*blocked: loopback/);
    expect(textOf(await run(tool, { url: "https://inside.example/" }))).toMatch(/blocked: host resolves to a private address/);
    expect(textOf(await run(tool, { url: "https://public.example/" }))).toMatch(/redirect blocked: cloud metadata address/);
    expect(sent.map((request) => request.url)).toEqual(["https://public.example/"]);
  });

  it("names a failing status by its standard phrase, and refuses a body over 5 MiB", async () => {
    const { transport } = network((request) =>
      request.url.endsWith("/missing") ? new Response("server text", { status: 404 }) : new Response("x", { headers: { "content-length": String(6 * 1024 * 1024) } }),
    );
    const tool = webFetchTool(transport);
    expect(textOf(await run(tool, { url: "https://example.com/missing" }))).toBe("Unable to fetch https://example.com/missing: HTTP 404 Not Found");
    expect(textOf(await run(tool, { url: "https://example.com/big" }))).toMatch(/exceeds the 5 MiB limit/);
  });

  it("retries a Cloudflare challenge once with the honest user agent", async () => {
    const { transport, sent } = network((request) =>
      request.headers["user-agent"] === "t3flare-web-tools" ? new Response("plain text", { headers: { "content-type": "text/plain" } }) : new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );
    expect(textOf(await run(webFetchTool(transport), { url: "https://example.com/" }))).toBe("plain text");
    expect(sent).toHaveLength(2);
  });

  it("pages by lines and tells programs where to continue", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const { transport } = network(() => new Response(lines, { headers: { "content-type": "text/plain" } }));
    const outcome = await run(webFetchTool(transport), { url: "https://example.com/", offset: 3, limit: 2 });
    expect(outcome.ok && outcome.result.structuredOutput).toMatchObject({ content: "line 3\nline 4", total_lines: 10, next_offset: 5 });
  });
});

/** An Anthropic Messages answer with one search and a cited summary, as the proxy returns it. */
const answer = {
  content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "pi durable" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", url: "https://a.example/one", title: "One", page_age: "2 days ago", encrypted_content: "x" },
        { type: "web_search_result", url: "https://b.example/two", title: "Two", encrypted_content: "y" },
      ],
    },
    { type: "text", text: "Pi Durable runs agents ", citations: [{ type: "web_search_result_location", url: "https://a.example/one", title: "One", cited_text: "agents on Durable Objects" }] },
    { type: "text", text: "on Cloudflare." },
  ],
  usage: { input_tokens: 1200, output_tokens: 80, server_tool_use: { web_search_requests: 1 } },
};

describe("web_search", () => {
  const proxy = { url: "https://proxy.example/", apiKey: "sk-secret-key", model: () => "claude-haiku-5-5" };

  it("asks the proxy's model with the web search server tool, and returns the pages and the cited summary", async () => {
    const { transport, sent } = network(() => Response.json(answer));
    const outcome = await run(webSearchTool(transport, proxy), { query: "pi durable" });
    const request = sent[0]!;
    expect(request.url).toBe("https://proxy.example/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-secret-key");
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({ model: "claude-haiku-5-5", tools: [{ type: "web_search_20250305", name: "web_search" }] });
    const text = textOf(outcome);
    expect(text).toContain("Title: One\nURL: https://a.example/one\nPublished: 2 days ago\nText: agents on Durable Objects");
    expect(text).toContain("Title: Two\nURL: https://b.example/two");
    expect(text).toContain("Pi Durable runs agents on Cloudflare.");
    expect(outcome.ok && outcome.result.details).toMatchObject({ query: "pi durable", results: [{ url: "https://a.example/one", title: "One" }, { url: "https://b.example/two" }] });
    expect(outcome.ok && outcome.result.usage).toMatchObject({ input: 1200, output: 80 });
  });

  it("trims to numResults and reports no results", () => {
    const read = readAnswer(answer, (text) => text);
    expect(resultText(read.results.slice(0, 1), "")).not.toContain("Two");
    expect(readAnswer({ content: [] }, (text) => text)).toEqual({ results: [], summary: "" });
  });

  it("reports a failed search, and a proxy error without the key", async () => {
    const failed = network(() => Response.json({ content: [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }] }));
    expect(textOf(await run(webSearchTool(failed.transport, proxy), { query: "q" }))).toBe("Unable to search the web for q: the search failed (too_many_requests)");
    const refused = network(() => Response.json({ type: "error", error: { type: "permission_error", message: "key sk-secret-key has no models" } }, { status: 403 }));
    const text = textOf(await run(webSearchTool(refused.transport, proxy), { query: "q" }));
    expect(text).toBe("Unable to search the web for q: HTTP 403 Forbidden: key [REDACTED] has no models");
  });

  it("is offered only when the setting gives it a proxy", () => {
    expect(webExtension().tools?.map((tool) => tool.name)).toEqual(["web_fetch"]);
    expect(webExtension({ search: proxy }).tools?.map((tool) => tool.name)).toEqual(["web_fetch", "web_search"]);
  });
});
