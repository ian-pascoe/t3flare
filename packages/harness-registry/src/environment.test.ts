// The Environment settings' seam (SPI-1149, ADR-0032): what the Workspace DO and the panel get from the stored settings
// (`resolveEnvironment`), what the panel may store (`applyEnvironmentChange`), and the size name a Container starts with
// (`containerInstance`): defaults, an unknown stored size, the idle bounds, and `instance` never omitted.
import { describe, expect, it } from "vitest";

import { applyEnvironmentChange, containerInstance, EMPTY_ENVIRONMENT, resolveEnvironment } from "./environment.ts";

describe("resolveEnvironment", () => {
  it("gives the defaults for empty settings: cpu-1 and a 2-minute idle time, at revision 0", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toEqual({ revision: 0, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 3, variables: {}, globalMiseConfig: "" });
  });

  it("reads a stored size it no longer offers, or an idle time out of bounds, as the default", () => {
    expect(resolveEnvironment({ revision: 4, settings: { containerSize: "mem-8", containerIdleMinutes: 0, containerBudget: 11 } })).toEqual({ revision: 4, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 3, variables: {}, globalMiseConfig: "" });
    expect(resolveEnvironment({ revision: 5, settings: { containerSize: "standard-3", containerIdleMinutes: 15, containerBudget: 5 } })).toEqual({ revision: 5, containerSize: "standard-3", containerIdleMinutes: 15, containerBudget: 5, variables: {}, globalMiseConfig: "" });
  });
});

describe("applyEnvironmentChange", () => {
  it("stores a valid change and bumps the revision", () => {
    const applied = applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerSize: "standard-4", containerIdleMinutes: 10 } });
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.environment.revision).toBe(1);
    expect(resolveEnvironment(applied.environment)).toEqual({ revision: 1, containerSize: "standard-4", containerIdleMinutes: 10, containerBudget: 3, variables: {}, globalMiseConfig: "" });
    const again = applyEnvironmentChange(applied.environment, { settings: { containerIdleMinutes: 5 } });
    if (!again.ok) throw new Error(again.error);
    expect(resolveEnvironment(again.environment)).toEqual({ revision: 2, containerSize: "standard-4", containerIdleMinutes: 5, containerBudget: 3, variables: {}, globalMiseConfig: "" });
  });

  it("stores and bumps the revision for the settings that moved only; a save that moves none changes nothing", () => {
    const first = applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 } });
    if (!first.ok) throw new Error(first.error);
    expect(first.changed).toEqual(["containerSize"]);
    expect(first.environment).toEqual({ revision: 1, settings: { containerSize: "standard-2" } });
    const same = applyEnvironmentChange(first.environment, { settings: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 } });
    if (!same.ok) throw new Error(same.error);
    expect(same.changed).toEqual([]);
    expect(same.environment).toBe(first.environment);
  });

  it("keeps the idle time between 1 and 60 whole minutes", () => {
    for (const minutes of [1, 60]) expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerIdleMinutes: minutes } })).toMatchObject({ ok: true });
    for (const minutes of [0, 61, 1.5, -2, "5"]) expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerIdleMinutes: minutes } })).toMatchObject({ ok: false });
  });

  it("keeps the Container budget between 1 and 10 whole Containers", () => {
    for (const budget of [1, 10]) expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerBudget: budget } })).toMatchObject({ ok: true });
    for (const budget of [0, 11, 2.5, "3"]) expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerBudget: budget } })).toMatchObject({ ok: false });
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

  it("starts the default for a stored name it does not offer, never an omitted instance (which would start lite)", () => {
    for (const name of ["lite", "basic", "mem-8", "custom-1", "", null, 3, { vcpu: 4 }]) {
      expect(containerInstance(resolveEnvironment({ revision: 1, settings: { containerSize: name } }).containerSize)).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12000 });
    }
  });
});

describe("the Global mise config", () => {
  const set = (text: unknown) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { globalMiseConfig: text } });

  it("is empty by default, and a stored value that no longer fits reads as empty", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).globalMiseConfig).toBe("");
    expect(resolveEnvironment({ revision: 2, settings: { globalMiseConfig: "a\u0000b" } }).globalMiseConfig).toBe("");
    expect(resolveEnvironment({ revision: 2, settings: { globalMiseConfig: 42 } }).globalMiseConfig).toBe("");
  });

  it("takes up to 16 KiB of UTF-8 and refuses one byte more, counting a character by its bytes", () => {
    expect(set("x".repeat(16 * 1024))).toMatchObject({ ok: true });
    expect(set("x".repeat(16 * 1024 + 1))).toEqual({ ok: false, error: "globalMiseConfig: is longer than 16 KiB of UTF-8" });
    // 5462 three-byte characters are 16 386 bytes, though only 5462 UTF-16 units.
    expect(set("€".repeat(5462))).toEqual({ ok: false, error: "globalMiseConfig: is longer than 16 KiB of UTF-8" });
    expect(set("€".repeat(5461))).toMatchObject({ ok: true });
  });

  it("refuses a NUL and anything not text", () => {
    expect(set('[tools]\nnode = "24"\u0000')).toEqual({ ok: false, error: "globalMiseConfig: contains a NUL character" });
    expect(set(7)).toMatchObject({ ok: false });
  });

  it("stores CRLF as LF, so a browser's round trip of the same text is not a change", () => {
    const first = set('[tools]\r\nnode = "24.11.1"\r\n');
    if (!first.ok) throw new Error(first.error);
    expect(resolveEnvironment(first.environment).globalMiseConfig).toBe('[tools]\nnode = "24.11.1"\n');
    const again = applyEnvironmentChange(first.environment, { settings: { globalMiseConfig: '[tools]\r\nnode = "24.11.1"\r\n' } });
    if (!again.ok) throw new Error(again.error);
    expect(again.changed).toEqual([]);
    expect(again.environment.revision).toBe(1);
  });
});
