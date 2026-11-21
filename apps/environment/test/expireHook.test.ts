// SPI-1171: the stage-only route that marks a sign-in's token expired cannot ship enabled to prod. It answers only with the
// Environment's faults on, and alchemy.run.ts binds `T3FLARE_FAULTS=1` on every stage but prod (checked on its source, so
// a change that binds it for prod fails); the Environment DO and its admin route are driven with the binding on and off
// (the first such test loads the DO's module graph: seconds alone, more under a loaded `pnpm run check`).
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { expireOnStage, expireRoute } from "../src/endpoints/expireHook.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

/** A real Environment DO over Node's SQLite and an in-memory KV, with `T3FLARE_FAULTS` as given; `read` lists the KV keys read since. */
const environmentWith = async (faults: string | undefined) => {
  const { EnvironmentDO } = await import("../src/environmentDO.ts");
  const values = new Map<string, unknown>();
  const read: Array<string> = [];
  const kv = {
    get: (key: string) => (read.push(key), values.get(key)),
    put: (key: string, value: unknown) => void values.set(key, value),
    delete: (key: string) => values.delete(key),
    list: () => new Map(values),
  };
  const ctx = { storage: { sql: nodeSqlStorage(), kv, transactionSync: <T>(closure: () => T) => closure() }, waitUntil: () => {}, exports: {} };
  const environment = new EnvironmentDO(ctx as never, { T3FLARE_FAULTS: faults, T3FLARE_CREDENTIALS_KEY: "k".repeat(44) } as never);
  read.length = 0;
  return { environment, read };
};
const SIGN_IN = "t3flare/sealed/endpoint/claude/oauth";

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

  it("is refused by the Environment DO's own check without the faults, whoever calls it (review 2)", async () => {
    let calls = 0;
    const expire = async () => (calls++, true);
    for (const faults of [undefined, "", "0", "true", "1 "]) expect(await expireOnStage(faults, expire), String(faults)).toBe(false);
    expect(calls).toBe(0);
    expect(await expireOnStage("1", expire)).toBe(true);
    expect(calls).toBe(1);
    // The DO calls its broker's expiry in one place (the RPC behind that check, tested below); a second call site, which
    // no behavioural test here would reach, fails this until it is reviewed.
    expect(fs.readFileSync(path.resolve(import.meta.dirname, "../src/environmentDO.ts"), "utf8").match(/\.expire\(/g)).toHaveLength(1);
  });

  it("is refused by the Environment DO's own RPC and its admin route without the faults binding, reading no sign-in", async () => {
    for (const faults of [undefined, "0"]) {
      const { environment, read } = await environmentWith(faults);
      expect(await environment.expireSignIn("claude"), String(faults)).toBe(false);
      const { handleAdmin } = await import("../src/host/admin.ts");
      const answer = await handleAdmin(new Request("https://env.example/_t3flare/check/sign-in-expire?id=claude", { method: "POST" }), environment);
      expect(answer.status, String(faults)).toBe(403);
      expect(read, String(faults)).not.toContain(SIGN_IN);
    }
  }, 60_000);

  it("reaches the sign-in through the Environment DO's RPC and its admin route with the faults bound", async () => {
    const { environment, read } = await environmentWith("1");
    // Nothing is signed in here, so nothing is expired; the broker read the sign-in to find that.
    expect(await environment.expireSignIn("claude")).toBe(false);
    expect(read).toContain(SIGN_IN);
    read.length = 0;
    const { handleAdmin } = await import("../src/host/admin.ts");
    const answer = await handleAdmin(new Request("https://env.example/_t3flare/check/sign-in-expire?id=claude", { method: "POST" }), environment);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ expired: false });
    expect(read).toContain(SIGN_IN);
  }, 60_000);

  it("has its faults bound on every stage but prod", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../alchemy.run.ts"), "utf8");
    const bindings = [...source.matchAll(/T3FLARE_FAULTS/g)].map((match) => source.slice(source.lastIndexOf("\n", match.index), source.indexOf("\n", match.index)).trim());
    expect(bindings.length).toBeGreaterThan(0);
    for (const line of bindings) expect(line).toBe('...(stage === "prod" ? {} : { T3FLARE_FAULTS: "1" }),');
  });
});
