// `SessionEndpoints` stores no key (SPI-1162; ADR-0018). In a real Durable Object, the module the Session uses takes an
// endpoint, sends one pi-ai request through its provider with the key, and afterwards nothing in the object's KV or SQL
// holds the key (the endpoints it took are kept, secret-free). It does not run a whole Session: not pi-durable's Harness,
// its conversation log, or the Session's recording fetch. The agents Worker has no workerd harness for a `SessionDO` (it
// needs the Environment, a Workspace and the codemode sandbox bound), so that part rests on the module boundary: the key
// lives only in `SessionEndpoints`' memory and pi-ai's request.
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
