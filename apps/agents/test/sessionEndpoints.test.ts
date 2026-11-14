// A Session's Model endpoint keys follow the endpoint's target (SPI-1162 review): each request for a key names the target
// the Session holds, and the Environment gives one only for the endpoint's target now. After the owner moves an endpoint
// to a new host with a new key, a Session still holding the old target (a long turn past the key's time in memory, or a
// turn whose read of the endpoints failed) sends no key to the old host, and its turn says why.
import { createModels } from "@earendil-works/pi-ai";
import { type EndpointCredentialRequest, type ModelEndpoint, sameTarget } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { ENDPOINT_KEY_TTL_MS, SessionEndpoints } from "../src/session/endpoints.ts";

const endpointAt = (baseUrl: string): ModelEndpoint => ({
  id: "gw",
  label: "GW",
  api: "anthropic-messages",
  baseUrl,
  auth: "api-key",
  headers: {},
  models: [{ id: "claude-haiku-5-5", name: "h", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: true }],
});

describe("a Session's Model endpoint keys", () => {
  it("sends no key to a target the endpoint has left, within a turn or after a failed read", async () => {
    let environment = { revision: 1, endpoint: endpointAt("https://old-host.example"), key: "sk-K1-old" };
    let failRead = false;
    let clock = 0;
    const sent: Array<string> = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      sent.push(`${String(url)} ${new Headers(init?.headers).get("x-api-key")}`);
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "stub" } }, { status: 400 });
    }) as typeof fetch;
    const models = createModels();
    const map = new Map<string, unknown>();
    const endpoints = new SessionEndpoints({
      kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) },
      models,
      fetch: fetcher,
      readMs: 50,
      now: () => clock,
      source: () => ({
        modelEndpoints: async () => {
          if (failRead) throw new Error("busy");
          return { revision: environment.revision, endpoints: [environment.endpoint] };
        },
        // The Environment's rule (endpoints/store.ts `credential`): a key only for the target it has now.
        endpointCredential: async ({ target }: EndpointCredentialRequest) => (sameTarget(environment.endpoint, target) ? { apiKey: environment.key } : { apiKey: null, changed: true }),
      }),
    });
    const request = async () => {
      const model = models.getModel("gw", "claude-haiku-5-5")!;
      return (await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })).errorMessage ?? "";
    };
    const ask = async () => (await models.getAuth("gw").then((auth) => auth?.auth.apiKey ?? null, (error: Error) => error.message)) as string | null;
    await endpoints.take();
    expect(await ask()).toBe("sk-K1-old");
    environment = { revision: 2, endpoint: endpointAt("https://new-host.example"), key: "sk-K2-new" };
    clock += ENDPOINT_KEY_TTL_MS + 1;
    expect(await ask()).toMatch(/changed or was removed .*retry the turn/);
    expect(await request()).toMatch(/changed or was removed/);
    failRead = true;
    await endpoints.take();
    clock += ENDPOINT_KEY_TTL_MS + 1;
    expect(await ask()).toMatch(/changed or was removed/);
    failRead = false;
    await endpoints.take();
    expect(await ask()).toBe("sk-K2-new");
    await request();
    // Only the new host ever saw a request, with the new key; the old host never got the new key.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((line) => line.startsWith("https://new-host.example") && line.endsWith(" sk-K2-new"))).toBe(true);
  });
});
