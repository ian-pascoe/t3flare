// The Environment settings' seam (SPI-1149, ADR-0032): what the Workspace DO and the panel get from the stored settings
// (`resolveEnvironment`), what the panel may store (`applyEnvironmentChange`), and the size name a Container starts with
// (`containerInstance`): defaults, an unknown stored size, the idle bounds, and `instance` never omitted.
import { describe, expect, it } from "vitest";

import { applyEnvironmentChange, containerInstance, EMPTY_ENVIRONMENT, resolveEnvironment } from "./environment.ts";

describe("resolveEnvironment", () => {
  it("gives the defaults for empty settings: cpu-1 and a 2-minute idle time, at revision 0", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toEqual({ revision: 0, containerSize: "cpu-1", containerIdleMinutes: 2 });
  });

  it("reads a stored size it no longer offers, or an idle time out of bounds, as the default", () => {
    expect(resolveEnvironment({ revision: 4, settings: { containerSize: "mem-8", containerIdleMinutes: 0 } })).toEqual({ revision: 4, containerSize: "cpu-1", containerIdleMinutes: 2 });
    expect(resolveEnvironment({ revision: 5, settings: { containerSize: "standard-3", containerIdleMinutes: 15 } })).toEqual({ revision: 5, containerSize: "standard-3", containerIdleMinutes: 15 });
  });
});

describe("applyEnvironmentChange", () => {
  it("stores a valid change and bumps the revision", () => {
    const applied = applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerSize: "standard-4", containerIdleMinutes: 10 } });
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.environment.revision).toBe(1);
    expect(resolveEnvironment(applied.environment)).toEqual({ revision: 1, containerSize: "standard-4", containerIdleMinutes: 10 });
    const again = applyEnvironmentChange(applied.environment, { settings: { containerIdleMinutes: 5 } });
    if (!again.ok) throw new Error(again.error);
    expect(resolveEnvironment(again.environment)).toEqual({ revision: 2, containerSize: "standard-4", containerIdleMinutes: 5 });
  });

  it("keeps the idle time between 1 and 60 whole minutes", () => {
    for (const minutes of [1, 60]) expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerIdleMinutes: minutes } })).toMatchObject({ ok: true });
    for (const minutes of [0, 61, 1.5, -2, "5"]) expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerIdleMinutes: minutes } })).toMatchObject({ ok: false });
  });

  it("refuses a size it does not offer, an unknown setting and an empty change, with the setting named", () => {
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerSize: "lite" } })).toEqual({ ok: false, error: "containerSize: one of cpu-1, standard-1, standard-2, standard-3, standard-4" });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { secrets: "x" } })).toEqual({ ok: false, error: "secrets: no such setting" });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: {} })).toMatchObject({ ok: false });
  });
});

describe("containerInstance", () => {
  it("starts cpu-1 as today's custom size and Cloudflare's named types by their names", () => {
    expect(containerInstance("cpu-1")).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12000 });
    expect(containerInstance("standard-1")).toBe("standard-1");
    expect(containerInstance("standard-2")).toBe("standard-2");
    expect(containerInstance("standard-3")).toBe("standard-3");
    expect(containerInstance("standard-4")).toBe("standard-4");
  });

  it("starts the default for a name it does not offer, never an omitted instance (which would start lite)", () => {
    for (const name of ["lite", "basic", "mem-8", "custom-1", "", undefined, null, 3, { vcpu: 4 }]) {
      expect(containerInstance(name)).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12000 });
    }
  });
});
