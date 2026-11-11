// t3's runtime mode as the Session enforces it: it fails closed. t3 ranks `auto` below full-access
// (t3code/packages/contracts/src/providerPolicy.ts), and t3's own Pi provider runs it as approval-required
// (t3code/packages/provider-pi/src/server/mcpInjection.ts), so ours does too.
import { interactionModeOf, runtimeModeOf } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

describe("runtime mode", () => {
  it("keeps the modes the Session enforces", () => {
    expect(runtimeModeOf("approval-required")).toBe("approval-required");
    expect(runtimeModeOf("auto-accept-edits")).toBe("auto-accept-edits");
    expect(runtimeModeOf("full-access")).toBe("full-access");
  });

  it("runs auto as approval-required, as t3's Pi provider does", () => {
    expect(runtimeModeOf("auto")).toBe("approval-required");
  });

  it("asks for approval for an unknown or missing mode", () => {
    expect(runtimeModeOf("yolo")).toBe("approval-required");
    expect(runtimeModeOf("")).toBe("approval-required");
    expect(runtimeModeOf(undefined)).toBe("approval-required");
    expect(runtimeModeOf(null)).toBe("approval-required");
  });
});

describe("interaction mode (step 3, F-plan)", () => {
  it("keeps default and plan", () => {
    expect(interactionModeOf("default")).toBe("default");
    expect(interactionModeOf("plan")).toBe("plan");
  });

  it("runs a mode it does not know as plan (read-only), and a missing one as the default", () => {
    expect(interactionModeOf("review")).toBe("plan");
    expect(interactionModeOf("")).toBe("plan");
    expect(interactionModeOf(undefined)).toBe("default");
  });
});
