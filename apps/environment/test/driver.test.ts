// The Durable agent provider's name (ADR-0015's refinement, 2026-11-11): t3 shows it as "Pi Durable", apart from the
// pi CLI, which t3's own Pi provider shows as "Pi".
import { describe, expect, it } from "vitest";

import { PI_DURABLE_DRIVER } from "../src/provider/capabilities.ts";
import { PiDurableDriver } from "../src/provider/driver.ts";

describe("the Durable agent provider", () => {
  it("is named Pi Durable, under the driver kind piDurable", () => {
    expect(PiDurableDriver.metadata.displayName).toBe("Pi Durable");
    expect(PiDurableDriver.driverKind).toBe(PI_DURABLE_DRIVER);
    expect(String(PI_DURABLE_DRIVER)).toBe("piDurable");
  });
});
