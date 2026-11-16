// The admin leak check's endpoint keys (SPI-1167): every endpoint's key from the relay's target, by name; none for an
// endpoint without one or whose key no longer opens. A sign-in's tokens (SPI-1171): its access and refresh tokens as
// stored, read without renewing it.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";
import { patternOf } from "@t3flare/sandbox-image/leakscan";
import { describe, expect, it } from "vitest";

import { endpointLeakCredentials, signInLeakPatterns } from "../src/endpoints/leak.ts";

// Realistic lengths: a Copilot token (`tid=…;exp=…;…`, well over 100 characters) and a GitHub token (`gho_` + 36).
const COPILOT_TOKEN = `tid=${"a1b2c3d4".repeat(4)};exp=1795000000;sku=copilot_individual;proxy-ep=proxy.individual.githubcopilot.com`;
const GITHUB_TOKEN = `gho_${"Z9y8X7w6".repeat(4)}abcd`;

const endpoint = (id: string) => ({ id, label: id, api: "openai-responses" as const, baseUrl: `https://${id}.example.com/v1`, auth: "api-key" as const, headers: {}, models: [] });
const endpoints: ModelEndpoints = { revision: 1, endpoints: [endpoint("openai"), endpoint("local"), endpoint("broken"), { ...endpoint("copilot"), auth: "copilot" }] };
const targets: Record<string, ModelRelayTarget> = {
  openai: { ok: true, api: "openai-responses", auth: "api-key", baseUrl: "https://openai.example.com/v1", headers: { authorization: "Bearer sk-1" }, key: "sk-openai-key-1" },
  local: { ok: true, api: "openai-responses", auth: "none", baseUrl: "https://local.example.com/v1", headers: {}, key: null },
  broken: { ok: false, status: 503, message: "can no longer be read" },
};

describe("the leak check's endpoint keys", () => {
  it("names each endpoint's key, and skips those without one", async () => {
    const asked: Array<string> = [];
    const signIns: Array<string> = [];
    const credentials = await endpointLeakCredentials({
      endpoints: async () => endpoints,
      target: async (id) => {
        asked.push(id);
        return targets[id]!;
      },
      signIn: async (id) => {
        signIns.push(id);
        return signInLeakPatterns([
          { name: `sign-in:${id}:access`, value: COPILOT_TOKEN },
          { name: `sign-in:${id}:refresh`, value: GITHUB_TOKEN },
          { name: `sign-in:${id}:odd`, value: "short-token" },
        ]);
      },
    });
    // A key by value; a sign-in's tokens only as their hashes (never a value leaves the Environment).
    expect(credentials.credentials).toEqual([{ name: "endpoint:openai", value: "sk-openai-key-1" }]);
    expect(credentials.patterns).toEqual([await patternOf("sign-in:copilot:access", COPILOT_TOKEN), await patternOf("sign-in:copilot:refresh", GITHUB_TOKEN)]);
    // One too short to hash is dropped before hashing: named, nothing of it sent (not its prefix, length or hash).
    expect(credentials.notScanned).toEqual([{ name: "sign-in:copilot:odd", where: "everywhere" }]);
    expect(credentials.patterns.map((pattern) => pattern.name)).not.toContain("sign-in:copilot:odd");
    const text = JSON.stringify(credentials);
    for (const value of [COPILOT_TOKEN, GITHUB_TOKEN, "short-token", COPILOT_TOKEN.slice(4, 30), GITHUB_TOKEN.slice(4)]) expect(text).not.toContain(value);
    // A sign-in's tokens are read as stored, never through the relay's target, which would renew one near its expiry.
    expect(asked).toEqual(["openai", "local", "broken"]);
    expect(signIns).toEqual(["copilot"]);
  });
});
