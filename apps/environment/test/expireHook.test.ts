// SPI-1171: the stage-only hook that marks a sign-in's token expired cannot ship enabled to prod. It answers only with the
// Environment's faults on, and alchemy.run.ts binds `T3FLARE_FAULTS=1` on every stage but prod (checked here on its
// source, so a change that binds it for prod fails).
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { expireHook } from "../src/endpoints/expireHook.ts";

describe("the stage-only sign-in expire hook", () => {
  it("refuses without the faults, touching nothing, and expires with them", async () => {
    const asked: Array<string> = [];
    const expire = async (endpointId: string) => (asked.push(endpointId), true);
    expect(await expireHook({ faults: false, expire }, "claude")).toEqual({ status: 403, json: { error: "stages only" } });
    expect(asked).toEqual([]);
    expect(await expireHook({ faults: true, expire }, "claude")).toEqual({ status: 200, json: { expired: true } });
    expect(asked).toEqual(["claude"]);
  });

  it("has its faults bound on every stage but prod", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../alchemy.run.ts"), "utf8");
    const bindings = [...source.matchAll(/T3FLARE_FAULTS/g)].map((match) => source.slice(source.lastIndexOf("\n", match.index), source.indexOf("\n", match.index)).trim());
    expect(bindings.length).toBeGreaterThan(0);
    for (const line of bindings) expect(line).toBe('...(stage === "prod" ? {} : { T3FLARE_FAULTS: "1" }),');
    // And the Environment reads it as nothing but "1".
    expect(fs.readFileSync(path.resolve(import.meta.dirname, "../src/environmentDO.ts"), "utf8")).toContain('faults: env.T3FLARE_FAULTS === "1"');
  });
});
