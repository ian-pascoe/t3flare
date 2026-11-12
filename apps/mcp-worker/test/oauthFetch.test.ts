// The OAuth fetch (review M5): what a sign-in may reach from the MCP Worker.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/oauthFetch.ts";

describe("guardedFetch", () => {
  it("takes only https URLs without credentials, and never follows a redirect", async () => {
    const seen: Array<{ url: string; redirect: string | undefined }> = [];
    const fetcher = guardedFetch((async (url: URL, init?: RequestInit) => {
      seen.push({ url: url.toString(), redirect: init?.redirect });
      return new Response("{}");
    }) as unknown as typeof fetch);
    await fetcher("https://as.example/.well-known/oauth-authorization-server", { redirect: "follow" });
    await expect(fetcher("http://as.example/token")).rejects.toThrow(/https/);
    await expect(fetcher("https://user:pw@as.example/token")).rejects.toThrow(/credentials/);
    expect(seen).toEqual([{ url: "https://as.example/.well-known/oauth-authorization-server", redirect: "manual" }]);
  });
});
