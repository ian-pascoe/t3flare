// The admin leak check's endpoint keys (SPI-1167): every endpoint's key from the relay's target, by name; none for an
// endpoint without one or whose key no longer opens.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";
import { describe, expect, it } from "vitest";

import { endpointLeakCredentials } from "../src/endpoints/leak.ts";

const endpoint = (id: string) => ({ id, label: id, api: "openai-responses" as const, baseUrl: `https://${id}.example.com/v1`, auth: "api-key" as const, headers: {}, models: [] });
const endpoints: ModelEndpoints = { revision: 1, endpoints: [endpoint("openai"), endpoint("local"), endpoint("broken")] };
const targets: Record<string, ModelRelayTarget> = {
  openai: { ok: true, api: "openai-responses", auth: "api-key", baseUrl: "https://openai.example.com/v1", headers: { authorization: "Bearer sk-1" }, key: "sk-openai-key-1" },
  local: { ok: true, api: "openai-responses", auth: "none", baseUrl: "https://local.example.com/v1", headers: {}, key: null },
  broken: { ok: false, status: 503, message: "can no longer be read" },
};

describe("the leak check's endpoint keys", () => {
  it("names each endpoint's key, and skips those without one", async () => {
    const asked: Array<string> = [];
    const credentials = await endpointLeakCredentials({
      endpoints: async () => endpoints,
      target: async (id) => {
        asked.push(id);
        return targets[id]!;
      },
    });
    expect(credentials).toEqual([{ name: "endpoint:openai", value: "sk-openai-key-1" }]);
    expect(asked).toEqual(["openai", "local", "broken"]);
  });
});
