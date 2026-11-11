// The decision to retry a failed deploy in two passes (scripts/deploy-retry.ts).
import { describe, expect, it } from "vitest";

import { isDurableObjectClassNotFound } from "../scripts/deploy-retry.ts";

describe("isDurableObjectClassNotFound", () => {
  it("retries on Cloudflare's class-not-found errors", () => {
    expect(
      isDurableObjectClassNotFound(
        "Cannot create binding for class 'SessionDO' because it is not currently configured to implement Durable Objects. [code: 10061]",
      ),
    ).toBe(true);
    expect(isDurableObjectClassNotFound("Cannot create binding for class in script 'agents' that does not exist. [code: 10061]")).toBe(true);
    expect(isDurableObjectClassNotFound('{"errors":[{"code":10061}]}')).toBe(true);
    expect(isDurableObjectClassNotFound("PUT failed (code: 10061)")).toBe(true);
  });

  it("does not retry on unrelated failures or empty output", () => {
    expect(isDurableObjectClassNotFound("")).toBe(false);
    expect(isDurableObjectClassNotFound("Access application: primary domain refused [code: 10000]")).toBe(false);
    expect(isDurableObjectClassNotFound("Error: build failed with 10061 modules")).toBe(false);
  });
});
