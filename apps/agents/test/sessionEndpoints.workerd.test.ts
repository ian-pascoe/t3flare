// A Session's Model endpoint keys (SPI-1162; ADR-0018): asked of the Environment at use time and held in memory only. In a
// real Durable Object, a request through an endpoint's provider is sent with the key, and afterwards nothing the object
// stored holds it (the endpoints it took are kept, secret-free).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { EndpointsProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { ENDPOINTS_PROBE: DurableObjectNamespace<EndpointsProbe> };

describe("a Session's Model endpoint keys", () => {
  it("sends the key with the request and stores it nowhere", async () => {
    const key = "sk-probe-never-stored-7f3a";
    const probe = bindings.ENDPOINTS_PROBE.get(bindings.ENDPOINTS_PROBE.newUniqueId());
    const { sentKey, reply, stored } = await probe.run({ key });
    expect(sentKey).toBe(key);
    expect(reply).toBe("ready");
    expect(stored).toContain("t3flare:model-endpoints");
    expect(stored).not.toContain(key);
  });
});
