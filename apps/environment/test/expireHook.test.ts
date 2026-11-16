// SPI-1171: the stage-only route that marks a sign-in's token expired cannot ship enabled to prod. It answers only with the
// Environment's faults on, and alchemy.run.ts binds `T3FLARE_FAULTS=1` on every stage but prod (checked on its source, so
// a change that binds it for prod fails); the admin route is this one (checked on admin.ts's source).
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { expireRoute } from "../src/endpoints/expireHook.ts";

const route = (query: string) => new URL(`https://env.example/_t3flare/check/sign-in-expire${query}`);

describe("the stage-only sign-in expire route", () => {
  it("refuses without the faults (403), touching nothing", async () => {
    const asked: Array<string> = [];
    const answer = await expireRoute(route("?id=claude"), { faults: () => false, expire: async (id) => (asked.push(id), true) });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ error: "stages only" });
    expect(asked).toEqual([]);
  });

  it("with the faults, expires the endpoint its id names, and refuses another id (400)", async () => {
    const asked: Array<string> = [];
    const deps = { faults: () => true, expire: async (id: string) => (asked.push(id), id === "claude") };
    const answer = await expireRoute(route("?id=claude"), deps);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ expired: true });
    for (const query of ["", "?id=", "?id=../x", "?id=Claude", "?endpoint=claude"]) expect((await expireRoute(route(query), deps)).status, query).toBe(400);
    expect(asked).toEqual(["claude"]);
  });

  it("is the admin route, and has its faults bound on every stage but prod", () => {
    const admin = fs.readFileSync(path.resolve(import.meta.dirname, "../src/host/admin.ts"), "utf8");
    const routeCase = admin.slice(admin.indexOf('case "POST /_t3flare/check/sign-in-expire"'));
    expect(routeCase.slice(0, routeCase.indexOf("case ", 10))).toMatch(/return expireRoute\(url, \{ faults: \(\) => environmentServices\(\)\.faults,/);
    expect(admin).not.toMatch(/\.expireSignIn\((?!endpointId\))/);
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../alchemy.run.ts"), "utf8");
    const bindings = [...source.matchAll(/T3FLARE_FAULTS/g)].map((match) => source.slice(source.lastIndexOf("\n", match.index), source.indexOf("\n", match.index)).trim());
    expect(bindings.length).toBeGreaterThan(0);
    for (const line of bindings) expect(line).toBe('...(stage === "prod" ? {} : { T3FLARE_FAULTS: "1" }),');
    expect(fs.readFileSync(path.resolve(import.meta.dirname, "../src/environmentDO.ts"), "utf8")).toContain('faults: env.T3FLARE_FAULTS === "1"');
  });
});
