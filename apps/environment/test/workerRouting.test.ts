// @effect-diagnostics globalDate:off
// The Worker's routing for the Owner-client endpoint (worker.ts; ADR-0036, plan D13), SPI-1200 review: the endpoint's
// branch comes before the panel's and the generic `/_t3flare` branch; it verifies against the endpoint's own audience,
// so the panel's assertion is refused there and the endpoint's at the panel; a path below the endpoint answers 404; and
// local mode admits the admin token alone on loopback, as the service-token caller. The Access team's keys are served
// by a stubbed `fetch`; the Environment DO is a recording stand-in.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/environmentDO.ts", () => ({ EnvironmentDO: class {} }));
vi.mock("../src/preview/containerPreviews.ts", () => ({ ContainerPreviews: class {} }));

const { default: worker } = await import("../src/worker.ts");
type Env = Parameters<typeof worker.fetch>[1];

const TEAM = "team.cloudflareaccess.com";
const PANEL_AUD = "panel-aud";
const SETTINGS_AUD = "settings-aud";
const OWNER = "owner@example.com";
const SERVICE_CLIENT = "0123abcd.access";
const ADMIN = "admin-token";
const HOST = "t3.example.dev";

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
let keyPair: CryptoKeyPair;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  vi.stubGlobal("fetch", async (url: string) =>
    String(url) === `https://${TEAM}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] })) : new Response("no", { status: 404 }),
  );
});
afterAll(() => vi.unstubAllGlobals());

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const assertion = async (aud: string, claims: Record<string, unknown> = { email: OWNER, sub: "owner-sub" }) => {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", kid: "k1" });
  const payload = encode({ iss: `https://${TEAM}`, aud: [aud], exp: now + 600, nbf: now - 10, ...claims });
  const signature = await crypto.subtle.sign(algorithm, keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
};

/** The Worker over a recording Environment DO, `extra` replacing its bindings (an `undefined` one unsets it). */
const world = (extra: { readonly [K in keyof Env]?: Env[K] | undefined } = {}) => {
  const seen: Array<{ readonly method: string; readonly caller?: unknown }> = [];
  const answer = (method: string) => async (_request: Request, caller?: unknown) => (seen.push({ method, ...(caller === undefined ? {} : { caller }) }), new Response(method));
  const env = {
    ENVIRONMENT: { getByName: () => ({ fetch: answer("fetch"), harness: answer("harness"), harnessPublic: answer("harnessPublic"), settingsMcp: answer("settingsMcp") }) },
    ASSETS: { fetch: async () => new Response("asset") },
    T3FLARE_ADMIN_TOKEN: ADMIN,
    T3FLARE_ACCESS_TEAM_DOMAIN: TEAM,
    T3FLARE_ACCESS_AUD: PANEL_AUD,
    T3FLARE_OWNER_EMAIL: OWNER,
    T3FLARE_ACCESS_SERVICE_CLIENT_ID: SERVICE_CLIENT,
    T3FLARE_ACCESS_SETTINGS_AUD: SETTINGS_AUD,
    ...extra,
  } as unknown as Env;
  const call = async (path: string, headers: Record<string, string> = {}, host = HOST) => {
    const response = await worker.fetch(new Request(`https://${host}${path}`, { method: "POST", headers }), env);
    return { status: response.status, seen: seen.splice(0) };
  };
  return { call, env };
};

describe("the Owner-client endpoint's branch (worker.ts)", () => {
  it("admits the owner's assertion for the endpoint's audience, with its sub as the caller", async () => {
    const w = world();
    expect(await w.call("/_t3flare/mcp", { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD) })).toEqual({
      status: 200,
      seen: [{ method: "settingsMcp", caller: { kind: "owner", subject: "owner-sub" } }],
    });
  });

  it("admits the stage's service token with the admin token, as the service-token caller", async () => {
    const w = world();
    const headers = { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD, { common_name: SERVICE_CLIENT }), authorization: `Bearer ${ADMIN}` };
    expect((await w.call("/_t3flare/mcp", headers)).seen).toEqual([{ method: "settingsMcp", caller: { kind: "service-token" } }]);
  });

  it("refuses the panel's audience at the endpoint, and the endpoint's at the panel", async () => {
    const w = world();
    expect(await w.call("/_t3flare/mcp", { "cf-access-jwt-assertion": await assertion(PANEL_AUD) })).toEqual({ status: 404, seen: [] });
    expect(await w.call("/_t3flare/settings", { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD) })).toEqual({ status: 404, seen: [] });
    // The panel's own audience still reaches the panel.
    expect((await w.call("/_t3flare/settings", { "cf-access-jwt-assertion": await assertion(PANEL_AUD) })).seen).toEqual([{ method: "harness", caller: { kind: "owner", subject: "owner-sub" } }]);
  });

  it("orders the branches: below the endpoint is its 404, never the admin branch; /_t3flare/mcpx is the admin branch's", async () => {
    const w = world();
    const settings = { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD) };
    expect(await w.call("/_t3flare/mcp/anything", settings)).toEqual({ status: 404, seen: [] });
    // Even with the admin token and the panel's assertion, a path below the endpoint is not the admin branch's.
    expect(await w.call("/_t3flare/mcp/anything", { "cf-access-jwt-assertion": await assertion(PANEL_AUD), authorization: `Bearer ${ADMIN}` })).toEqual({ status: 404, seen: [] });
    expect((await w.call("/_t3flare/mcpx", { "cf-access-jwt-assertion": await assertion(PANEL_AUD), authorization: `Bearer ${ADMIN}` })).seen).toEqual([{ method: "fetch" }]);
    expect(await w.call("/_t3flare/mcpx", settings)).toEqual({ status: 404, seen: [] });
  });

  it("refuses everything when the endpoint's audience is not configured (prod until the owner turns it on, ADR-0036)", async () => {
    const w = world({ T3FLARE_ACCESS_SETTINGS_AUD: undefined });
    expect(await w.call("/_t3flare/mcp", { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD) })).toEqual({ status: 404, seen: [] });
    // Without `SettingsAccess` the admin application covers `/_t3flare/mcp`; its assertion and the admin token reach nothing there.
    expect(await w.call("/_t3flare/mcp", { "cf-access-jwt-assertion": await assertion(PANEL_AUD), authorization: `Bearer ${ADMIN}` })).toEqual({ status: 404, seen: [] });
  });

  // Plan §5's hostile list (M6, SPI-1202): an agent that knows a Change page's URL (it is in the card and in the agent's
  // own tool result) holds no panel assertion; at the edge Access answers it with a login (m6-stage-run.md), and behind
  // the edge the Worker never hands the page to the Environment without the owner's assertion for the panel.
  it("the Change page and its API: nothing but the panel's own assertion reaches them", async () => {
    const w = world();
    const id = `chg_${"A".repeat(43)}`;
    for (const path of [`/_t3flare/settings/changes/${id}`, `/_t3flare/settings/api/changes/${id}`, "/_t3flare/settings/api/changes"]) {
      expect(await w.call(path), path).toEqual({ status: 404, seen: [] });
      expect(await w.call(path, { authorization: `Bearer ${ADMIN}` }), path).toEqual({ status: 404, seen: [] });
      expect(await w.call(path, { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD) }), path).toEqual({ status: 404, seen: [] });
      expect(await w.call(path, { "cf-access-jwt-assertion": await assertion(PANEL_AUD, { email: "someone@example.com", sub: "other-sub" }) }), path).toEqual({ status: 404, seen: [] });
      // The panel has no local-mode branch: the admin token on loopback is nothing there.
      expect(await world({ T3FLARE_LOCAL_MODE: "true" }).call(path, { authorization: `Bearer ${ADMIN}` }, "localhost:8791"), path).toEqual({ status: 404, seen: [] });
      expect((await w.call(path, { "cf-access-jwt-assertion": await assertion(PANEL_AUD) })).seen, path).toEqual([{ method: "harness", caller: { kind: "owner", subject: "owner-sub" } }]);
    }
  });

  it("local mode: the admin token alone on loopback, as the service-token caller; not off loopback, not without it", async () => {
    const w = world({ T3FLARE_LOCAL_MODE: "true" });
    expect(await w.call("/_t3flare/mcp", { authorization: `Bearer ${ADMIN}` }, "localhost:8791")).toEqual({ status: 200, seen: [{ method: "settingsMcp", caller: { kind: "service-token" } }] });
    expect(await w.call("/_t3flare/mcp", { authorization: "Bearer wrong" }, "localhost:8791")).toEqual({ status: 404, seen: [] });
    expect(await w.call("/_t3flare/mcp", { authorization: `Bearer ${ADMIN}` }, HOST)).toEqual({ status: 404, seen: [] });
    // Outside local mode the admin token alone on loopback is nothing.
    expect(await world().call("/_t3flare/mcp", { authorization: `Bearer ${ADMIN}` }, "localhost:8791")).toEqual({ status: 404, seen: [] });
  });
});

describe("the Settings page's old path (worker.ts)", () => {
  it("redirects /_t3flare/harness and below to /_t3flare/settings, keeping the rest of the path and the query", async () => {
    const env = world();
    const owner = { "cf-access-jwt-assertion": await assertion(PANEL_AUD) };
    for (const [from, to] of [
      ["/_t3flare/harness", "/_t3flare/settings"],
      ["/_t3flare/harness/", "/_t3flare/settings/"],
      ["/_t3flare/harness/changes/chg_1?x=1", "/_t3flare/settings/changes/chg_1?x=1"],
    ]) {
      const response = await worker.fetch(new Request(`https://${HOST}${from}`, { headers: owner }), env.env);
      expect([response.status, response.headers.get("location")], from).toEqual([308, to]);
    }
    expect(await env.call("/_t3flare/harness"), "no assertion: no redirect").toEqual({ status: 404, seen: [] });
    expect(await env.call("/_t3flare/harness", { "cf-access-jwt-assertion": await assertion(SETTINGS_AUD) }), "the endpoint's audience").toEqual({ status: 404, seen: [] });
    expect((await env.call("/_t3flare/harnessx", { "cf-access-jwt-assertion": await assertion(PANEL_AUD), authorization: `Bearer ${ADMIN}` })).seen).toEqual([{ method: "fetch" }]);
  });
});
