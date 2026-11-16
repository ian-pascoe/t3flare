// The admin leak check's endpoint keys (SPI-1167): every endpoint's key from the relay's target, by name; none for an
// endpoint without one or whose key no longer opens. A sign-in's tokens (SPI-1171): its access and refresh tokens as
// stored, read without renewing it.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";
import { patternOf } from "@t3flare/sandbox-image/leakscan";
import { describe, expect, it } from "vitest";

import { endpointLeakCredentials } from "../src/endpoints/leak.ts";

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
        return [
          { name: `sign-in:${id}:access`, value: "tid=copilot-token-1" },
          { name: `sign-in:${id}:refresh`, value: "gho_github-token-1" },
        ];
      },
    });
    // A key by value; a sign-in's tokens only as their hashes (never a value leaves the Environment).
    expect(credentials.credentials).toEqual([{ name: "endpoint:openai", value: "sk-openai-key-1" }]);
    expect(credentials.patterns).toEqual([await patternOf("sign-in:copilot:access", "tid=copilot-token-1"), await patternOf("sign-in:copilot:refresh", "gho_github-token-1")]);
    expect(JSON.stringify(credentials)).not.toMatch(/copilot-token-1|github-token-1/);
    // A sign-in's tokens are read as stored, never through the relay's target, which would renew one near its expiry.
    expect(asked).toEqual(["openai", "local", "broken"]);
    expect(signIns).toEqual(["copilot"]);
  });
});
