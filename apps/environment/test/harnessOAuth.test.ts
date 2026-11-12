// OAuth sign-ins for direct MCP servers (review M4): single-use state, the issuer check, write-only tokens, and one
// refresh in flight. The MCP Worker's side is stubbed; it is the only one that fetches.
import { describe, expect, it } from "vitest";

import { HarnessOAuth, type McpOAuthBinding } from "../src/harness/oauth.ts";
import { harnessSecrets } from "../src/harness/secrets.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  };
};

const setup = (options: { issSupported?: boolean; expiresIn?: number } = {}) => {
  const kv = memory();
  let now = 1_000_000;
  const calls: Array<string> = [];
  let refreshes = 0;
  const engine: McpOAuthBinding = {
    begin: async (input) => {
      calls.push("begin");
      return {
        ok: true,
        value: {
          authorizationUrl: `https://as.example/authorize?state=${input.state}&code_challenge_method=S256`,
          codeVerifier: "verifier",
          client: { client_id: "client-1" },
          authorizationServerUrl: "https://as.example",
          metadata: { issuer: "https://as.example", ...(options.issSupported === true ? { authorization_response_iss_parameter_supported: true } : {}) },
          registration: "dcr",
        },
      };
    },
    exchange: async (input) => {
      calls.push(`exchange:${input.code}:${input.codeVerifier}`);
      return { ok: true, value: { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }) } };
    },
    refresh: async (input) => {
      refreshes++;
      calls.push(`refresh:${input.refreshToken}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, value: { access_token: `access-${refreshes + 1}`, token_type: "Bearer", expires_in: 3600 } };
    },
  };
  const secrets = harnessSecrets(kv, () => now);
  const oauth = new HarnessOAuth({ kv, secrets, engine, host: "admin.example", now: () => now });
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  return { oauth, kv, calls, secrets, advance: (ms: number) => void (now += ms), stateOf, refreshes: () => refreshes };
};

const callback = (state: string, extra: Record<string, string> = {}) => new URL(`https://admin.example/_t3flare/harness/oauth/callback?${new URLSearchParams({ state, code: "code-1", ...extra })}`);

describe("OAuth sign-ins (review M4)", () => {
  it("serves a client metadata document naming the public callback", async () => {
    const { oauth } = setup();
    expect(await oauth.clientDocument().json()).toMatchObject({ client_id: "https://admin.example/_t3flare/harness/oauth/client.json", redirect_uris: ["https://admin.example/_t3flare/harness/oauth/callback"], token_endpoint_auth_method: "none" });
  });

  it("completes once per state; the tokens are kept write-only", async () => {
    const h = setup();
    const begun = await h.oauth.begin("srv", "https://srv.example/mcp");
    if (!begun.ok) throw new Error(begun.error);
    const state = h.stateOf(begun.value.authorizationUrl);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const first = await h.oauth.callback(callback(state, { iss: "https://as.example" }));
    expect(first.status).toBe(200);
    expect(h.calls).toContain("exchange:code-1:verifier");
    expect((await h.oauth.callback(callback(state))).status).toBe(400);
    expect(h.oauth.status("srv")).toEqual({ signedIn: true, expiresAt: null, refreshable: true });
    expect(await first.text()).not.toContain("access-1");
    expect(await h.oauth.accessToken("srv", false)).toBe("access-1");
  });

  it("refuses an expired state, a forged one, an issuer mismatch, and a missing iss the server promised", async () => {
    const h = setup({ issSupported: true });
    const begin = async () => {
      const begun = await h.oauth.begin("srv", "https://srv.example/mcp");
      if (!begun.ok) throw new Error(begun.error);
      return h.stateOf(begun.value.authorizationUrl);
    };
    const expired = await begin();
    h.advance(11 * 60_000);
    expect((await h.oauth.callback(callback(expired, { iss: "https://as.example" }))).status).toBe(400);
    expect((await h.oauth.callback(callback("f".repeat(64), { iss: "https://as.example" }))).status).toBe(400);
    expect((await h.oauth.callback(callback(await begin(), { iss: "https://evil.example" }))).status).toBe(400);
    expect((await h.oauth.callback(callback(await begin()))).status).toBe(400);
    expect(h.calls.filter((call) => call.startsWith("exchange"))).toEqual([]);
    expect(h.oauth.status("srv").signedIn).toBe(false);
  });

  it("refreshes an aging or refused token once, however many calls ask at the same time", async () => {
    const h = setup({ expiresIn: 120 });
    const begun = await h.oauth.begin("srv", "https://srv.example/mcp");
    if (!begun.ok) throw new Error(begun.error);
    await h.oauth.callback(callback(h.stateOf(begun.value.authorizationUrl), { iss: "https://as.example" }));
    expect(await h.oauth.accessToken("srv", false)).toBe("access-1");
    h.advance(70_000);
    const tokens = await Promise.all([h.oauth.accessToken("srv", false), h.oauth.accessToken("srv", false), h.oauth.accessToken("srv", true)]);
    expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
    expect(h.refreshes()).toBe(1);
    // The refresh token is kept when the server sends no new one.
    expect(await h.oauth.accessToken("srv", true)).toBe("access-3");
    expect(h.calls.filter((call) => call.startsWith("refresh"))).toEqual(["refresh:refresh-1", "refresh:refresh-1"]);
  });

  it("forgets a removed server's client and tokens", async () => {
    const h = setup();
    const begun = await h.oauth.begin("srv", "https://srv.example/mcp");
    if (!begun.ok) throw new Error(begun.error);
    await h.oauth.callback(callback(h.stateOf(begun.value.authorizationUrl)));
    h.oauth.forget("srv");
    expect(h.oauth.status("srv").signedIn).toBe(false);
    expect(await h.oauth.accessToken("srv", false)).toBeUndefined();
  });
});
