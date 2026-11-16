// t3's limit meters for subscription endpoints (SPI-1174): each vendor's rate-limit headers read as its own client reads
// them (the shapes pinned here: a vendor's rename or a change of unit fails this file), kept per window by the latest
// answer in the Environment DO's SQLite, and shown as one t3 limit source per endpoint, through t3's own contract and
// the meter logic its Usage page and composer use.
import { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { collectLimitAccounts, collectLimitNotices, collectLimitPools, collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { acceptedLimitReading, limitReadingOf, limitWindowsOf, type LimitReading } from "@t3flare/models/limits";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { endpointMeterSources, withSources } from "../src/usage/limitSources.ts";
import { agoText, LIMIT_SOURCE_PREFIX, limitSnapshots, limitStore, STALE_AFTER_MS } from "../src/usage/limits.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const S = (ms: number) => String(Math.floor(ms / 1000));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const headers = (values: Record<string, string>) => new Headers(values);

const model = { id: "m", name: "m", reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: true };
const endpoints: ModelEndpoints = {
  revision: 1,
  endpoints: [
    { id: "chatgpt", label: "ChatGPT plan", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "chatgpt", headers: {}, models: [model] },
    { id: "claude", label: "Claude plan", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "claude", headers: {}, models: [model] },
    { id: "copilot", label: "Copilot", api: "openai-completions", baseUrl: "https://api.githubcopilot.com", auth: "copilot", headers: {}, models: [model] },
  ],
};

describe("each vendor's limit headers, as its own client reads them", () => {
  it("ChatGPT's Codex windows: x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}, a percentage and epoch seconds (codex-rs rate_limits.rs)", () => {
    expect(
      limitWindowsOf(
        headers({
          "x-codex-primary-used-percent": "12.5",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": S(NOW + 2 * HOUR),
          "x-codex-secondary-used-percent": "40",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": S(NOW + 5 * DAY),
          // Another limit family Codex also reads (model-specific): not this endpoint's plan windows.
          "x-codex-other-primary-used-percent": "90",
        }),
        NOW,
      ),
    ).toEqual([
      { id: "primary", usedPercent: 12.5, resetsAt: NOW + 2 * HOUR, windowMinutes: 300 },
      { id: "secondary", usedPercent: 40, resetsAt: NOW + 5 * DAY, windowMinutes: 10080 },
    ]);
  });

  it("Claude's unified windows: anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}, a fraction and epoch seconds (Claude Code 2.1.325)", () => {
    expect(
      limitWindowsOf(
        headers({
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.42",
          "anthropic-ratelimit-unified-5h-reset": S(NOW + 3 * HOUR),
          "anthropic-ratelimit-unified-7d-status": "allowed_warning",
          "anthropic-ratelimit-unified-7d-utilization": "0.8",
          "anthropic-ratelimit-unified-7d-reset": S(NOW + 4 * DAY),
          "anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
          "anthropic-organization-id": "org-should-never-be-kept",
        }),
        NOW,
      ),
    ).toEqual([
      { id: "five_hour", usedPercent: 42, resetsAt: NOW + 3 * HOUR, windowMinutes: 300 },
      { id: "seven_day", usedPercent: 80, resetsAt: NOW + 4 * DAY, windowMinutes: 10080 },
    ]);
  });

  it("only the seven-day window when that is all the answer sends (SPI-1161's recorded header names)", () => {
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-unified-7d-utilization": "0.05", "anthropic-ratelimit-unified-7d-reset": S(NOW + DAY) }), NOW)).toEqual([
      { id: "seven_day", usedPercent: 5, resetsAt: NOW + DAY, windowMinutes: 10080 },
    ]);
  });

  it("a refused claim with no utilization is spent: its own status, or the overall status naming it, with the overall reset", () => {
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": S(NOW + HOUR) }), NOW)).toEqual([
      { id: "five_hour", usedPercent: 100, resetsAt: NOW + HOUR, windowMinutes: 300 },
    ]);
    expect(
      limitWindowsOf(
        headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day", "anthropic-ratelimit-unified-reset": S(NOW + DAY) }),
        NOW,
      ),
    ).toEqual([{ id: "seven_day", usedPercent: 100, resetsAt: NOW + DAY, windowMinutes: 10080 }]);
    // A representative claim the answer did not refuse says nothing.
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-representative-claim": "five_hour" }), NOW)).toEqual([]);
  });

  it("GitHub Copilot, an API-key OpenAI answer and an API-key Anthropic answer report no window", () => {
    expect(limitWindowsOf(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-tokens": "10" }), NOW)).toEqual([]);
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-tokens-reset": "2026-11-16T12:01:00Z" }), NOW)).toEqual([]);
    expect(limitReadingOf("copilot", headers({}), NOW)).toBeUndefined();
  });

  it("is strict: garbage, out-of-range and implausible values are dropped, never shown", () => {
    const codex = (used: string, extra: Record<string, string> = {}) => limitWindowsOf(headers({ "x-codex-primary-used-percent": used, ...extra }), NOW);
    for (const bad of ["lots", "-1", "1e2", "NaN", "Infinity", "12.5%", "0x10", " ", "1.2.3"]) expect(codex(bad), bad).toEqual([]);
    // Overspent is spent: clamped to 100.
    expect(codex("150")).toEqual([{ id: "primary", usedPercent: 100 }]);
    // Codex drops a window that says nothing.
    expect(codex("0")).toEqual([]);
    expect(codex("0", { "x-codex-primary-window-minutes": "300" })).toEqual([{ id: "primary", usedPercent: 0, windowMinutes: 300 }]);
    // A reset in the past, in milliseconds, over a year away or not a whole number is dropped (the window is kept).
    for (const reset of [S(NOW - HOUR), String(NOW + HOUR), S(NOW + 400 * DAY), "soon", "1.5"]) {
      expect(codex("10", { "x-codex-primary-reset-at": reset }), reset).toEqual([{ id: "primary", usedPercent: 10 }]);
    }
    // A length of zero, over a month, or not whole is dropped.
    for (const minutes of ["0", "50000", "5.5", "-300"]) expect(codex("10", { "x-codex-primary-window-minutes": minutes }), minutes).toEqual([{ id: "primary", usedPercent: 10 }]);
    // Claude's utilization is a fraction: 1.5 is 150 %, clamped; a negative or garbage one is dropped.
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-unified-5h-utilization": "1.5" }), NOW)).toEqual([{ id: "five_hour", usedPercent: 100, windowMinutes: 300 }]);
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-unified-5h-utilization": "-0.1" }), NOW)).toEqual([]);
    expect(limitWindowsOf(headers({ "anthropic-ratelimit-unified-5h-utilization": "42%" }), NOW)).toEqual([]);
  });

  it("never throws, whatever the headers object does", () => {
    expect(
      limitWindowsOf(
        {
          get: () => {
            throw new Error("broken");
          },
        },
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("what the Environment accepts of a reading", () => {
  it("an endpoint id, a time and known windows with a share from 0 to 100; implausible resets and lengths dropped, a repeated window once", () => {
    expect(
      acceptedLimitReading({
        endpointId: "claude",
        at: NOW,
        windows: [
          { id: "five_hour", usedPercent: 42, resetsAt: NOW + HOUR, windowMinutes: 300, token: "sk-ant-oat01-x" },
          { id: "five_hour", usedPercent: 1 },
          { id: "seven_day", usedPercent: 10, resetsAt: NOW - 1, windowMinutes: 0.5 },
          { id: "monthly", usedPercent: 10 },
          { id: "primary", usedPercent: 101 },
        ],
        account: "someone@example.com",
      }),
    ).toEqual({
      endpointId: "claude",
      at: NOW,
      windows: [
        { id: "five_hour", usedPercent: 42, resetsAt: NOW + HOUR, windowMinutes: 300 },
        { id: "seven_day", usedPercent: 10 },
      ],
    });
    for (const bad of [null, "x", { endpointId: "Bad Id", at: NOW, windows: [{ id: "primary", usedPercent: 1 }] }, { endpointId: "claude", at: -1, windows: [] }, { endpointId: "claude", at: NOW, windows: [] }]) {
      expect(acceptedLimitReading(bad)).toBeUndefined();
    }
  });
});

const reading = (endpointId: string, at: number, windows: LimitReading["windows"]): LimitReading => ({ endpointId, at, windows });

describe("the Environment's kept windows", () => {
  it("keeps each window's reading of the latest answer, whatever order the sends arrive in", () => {
    const store = limitStore(nodeSqlStorage());
    const kept: Array<number> = [];
    store.subscribe(() => void kept.push(store.read().length));
    expect(store.record({ readings: [reading("claude", NOW, [{ id: "five_hour", usedPercent: 50 }])] }, endpoints, NOW)).toBe(1);
    // An older answer's reading arriving later is not kept.
    expect(store.record({ readings: [reading("claude", NOW - 1000, [{ id: "five_hour", usedPercent: 10 }, { id: "seven_day", usedPercent: 3 }])] }, endpoints, NOW)).toBe(1);
    expect(store.read().map((window) => [window.id, window.usedPercent, window.at])).toEqual([
      ["five_hour", 50, NOW],
      ["seven_day", 3, NOW - 1000],
    ]);
    // A later answer replaces only the windows it reports.
    store.record({ readings: [reading("claude", NOW + 1000, [{ id: "five_hour", usedPercent: 55, resetsAt: NOW + HOUR, windowMinutes: 300 }])] }, endpoints, NOW);
    expect(store.read()).toEqual([
      { endpoint: "claude", id: "five_hour", at: NOW + 1000, usedPercent: 55, resetsAt: NOW + HOUR, windowMinutes: 300 },
      { endpoint: "claude", id: "seven_day", at: NOW - 1000, usedPercent: 3, resetsAt: null, windowMinutes: null },
    ]);
    // The same answer again (equal time) changes nothing and tells no one.
    expect(store.record({ readings: [reading("claude", NOW + 1000, [{ id: "five_hour", usedPercent: 99 }])] }, endpoints, NOW)).toBe(0);
    expect(kept).toEqual([1, 2, 2]);
  });

  it("drops readings of unknown endpoints and from the future, and a removed endpoint's windows at the next write", () => {
    const store = limitStore(nodeSqlStorage());
    store.record({ readings: [reading("chatgpt", NOW, [{ id: "primary", usedPercent: 1 }]), reading("ghost", NOW, [{ id: "primary", usedPercent: 1 }]), reading("claude", NOW + 2 * HOUR, [{ id: "five_hour", usedPercent: 1 }])] }, endpoints, NOW);
    expect(store.read().map((window) => window.endpoint)).toEqual(["chatgpt"]);
    const without = { revision: 2, endpoints: endpoints.endpoints.filter((endpoint) => endpoint.id !== "chatgpt") };
    store.record({ readings: [reading("claude", NOW, [{ id: "five_hour", usedPercent: 1 }])] }, without, NOW);
    expect(store.read().map((window) => window.endpoint)).toEqual(["claude"]);
  });

  it("outlives the object: a new store on the same database reads what an earlier one kept (eviction)", () => {
    const sql = nodeSqlStorage();
    limitStore(sql).record({ readings: [reading("claude", NOW, [{ id: "seven_day", usedPercent: 7 }])] }, endpoints, NOW);
    expect(limitStore(sql).read()).toMatchObject([{ endpoint: "claude", id: "seven_day", usedPercent: 7 }]);
    expect(JSON.stringify(sql.db.prepare("SELECT * FROM t3flare_limit_windows").all())).not.toMatch(/sk-|@|org/);
  });
});

const stored = (endpoint: string, id: "primary" | "secondary" | "five_hour" | "seven_day", at: number, usedPercent: number, resetsAt: number | null, windowMinutes: number | null) => ({ endpoint, id, at, usedPercent, resetsAt, windowMinutes });

describe("t3's limit sources: one per subscription endpoint", () => {
  const windows = [
    stored("chatgpt", "primary", NOW - 60_000, 12.5, NOW + 2 * HOUR, 300),
    stored("chatgpt", "secondary", NOW - 60_000, 40, NOW + 5 * DAY, 10080),
    stored("claude", "five_hour", NOW - 2 * 60_000, 42, NOW + 3 * HOUR, 300),
    stored("claude", "seven_day", NOW - 2 * 60_000, 80, NOW + 4 * DAY, 10080),
  ];

  it("are t3's own contract: each window's share, reset and length, under the endpoint's label, with no account identity", () => {
    const sources = limitSnapshots(windows, endpoints, NOW);
    for (const source of sources) expect(() => Schema.decodeUnknownSync(UsageLimitSourceSnapshot)(source)).not.toThrow();
    expect(sources.map((source) => [source.id, source.label, source.error])).toEqual([
      [`${LIMIT_SOURCE_PREFIX}chatgpt`, "ChatGPT plan", undefined],
      [`${LIMIT_SOURCE_PREFIX}claude`, "Claude plan", undefined],
    ]);
    expect(sources[0]!.accounts).toEqual([
      {
        id: "chatgpt",
        driver: "codex",
        usageLimits: {
          checkedAt: new Date(NOW - 60_000).toISOString(),
          windows: [
            { id: "primary", kind: "session", label: "5-hour", usedPercent: 12.5, resetsAt: new Date(NOW + 2 * HOUR).toISOString(), windowDurationMins: 300 },
            { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: new Date(NOW + 5 * DAY).toISOString(), windowDurationMins: 10080 },
          ],
        },
      },
    ]);
    expect(sources[1]!.accounts[0]).toMatchObject({ id: "claude", driver: "claudeAgent" });
    expect(sources.flatMap((source) => source.accounts).every((account) => account.email === undefined && account.workspaceId === undefined)).toBe(true);
  });

  it("render through t3's own meter logic: a Codex pool and a Claude pool with their percentages, and no notice while fresh", () => {
    const presentations = new Map([["env-1", { entry: { target: { label: "t3flare" } }, serverConfig: { providers: [], usageLimitSources: limitSnapshots(windows, endpoints, NOW) } }]]);
    const pools = collectLimitPools(collectLimitAccounts(presentations as never), NOW);
    expect(pools.map((pool) => [pool.driver, pool.windows.map((window) => [window.label, window.remainingPercent])])).toEqual([
      ["codex", [["5-hour", 88], ["Weekly", 60]]],
      ["claudeAgent", [["5-hour", 58], ["Weekly", 20]]],
    ]);
    expect(collectLimitNotices(presentations as never)).toEqual([]);
  });

  it("a meter not read for a while says when it was last read: on the Usage page and in the composer's report", () => {
    const later = NOW + 3 * HOUR;
    const sources = limitSnapshots(windows, endpoints, later);
    expect(sources.map((source) => source.error)).toEqual([
      "Last read 3 hours ago (limits are read from this endpoint's answers).",
      "Last read 3 hours ago (limits are read from this endpoint's answers).",
    ]);
    const presentations = new Map([["env-1", { entry: { target: { label: "t3flare" } }, serverConfig: { providers: [], usageLimitSources: sources } }]]);
    expect(collectLimitNotices(presentations as never)).toEqual([
      "ChatGPT plan: Last read 3 hours ago (limits are read from this endpoint's answers).",
      "Claude plan: Last read 3 hours ago (limits are read from this endpoint's answers).",
    ]);
    // The stale meters still show (the notice is beside them, not in their place).
    expect(collectLimitPools(collectLimitAccounts(presentations as never), later)).toHaveLength(2);
    const codex = { instanceId: "codex", driver: "codex", enabled: true, auth: {}, slashCommands: [] };
    const report = collectProviderUsageLimits("codex" as never, [codex] as never, sources, later);
    expect(report?.notices).toEqual(["ChatGPT plan: Last read 3 hours ago (limits are read from this endpoint's answers)."]);
    expect(report?.accounts.map((account) => account.label)).toEqual(["ChatGPT plan · chatgpt"]);
  });

  it("goes stale at STALE_AFTER_MS, names each stale window when they differ, and shows a window past its reset as reset", () => {
    const fresh = [stored("claude", "five_hour", NOW, 42, NOW + HOUR, 300)];
    expect(limitSnapshots(fresh, endpoints, NOW + STALE_AFTER_MS - 1)[0]!.error).toBeUndefined();
    expect(limitSnapshots(fresh, endpoints, NOW + STALE_AFTER_MS)[0]!.error).toBe("Last read 30 minutes ago (limits are read from this endpoint's answers).");
    const mixed = [stored("claude", "five_hour", NOW, 42, NOW + HOUR, 300), stored("claude", "seven_day", NOW - 2 * DAY, 80, NOW + DAY, 10080)];
    expect(limitSnapshots(mixed, endpoints, NOW)[0]!.error).toBe("Weekly last read 2 days ago (limits are read from this endpoint's answers).");
    const [past] = limitSnapshots(fresh, endpoints, NOW + 2 * HOUR);
    expect(past!.accounts[0]!.usageLimits.windows).toEqual([{ id: "five_hour", kind: "session", label: "5-hour", usedPercent: 0, windowDurationMins: 300 }]);
    expect([agoText(59_999), agoText(HOUR), agoText(47 * HOUR), agoText(49 * HOUR)]).toEqual(["0 minutes ago", "1 hour ago", "47 hours ago", "2 days ago"]);
  });

  it("labels a window by its length, and an unknown length by its slot", () => {
    const sources = limitSnapshots(
      [stored("chatgpt", "primary", NOW, 1, null, 60), stored("chatgpt", "secondary", NOW, 1, null, null)],
      endpoints,
      NOW,
    );
    expect(sources[0]!.accounts[0]!.usageLimits.windows.map((window) => [window.label, window.kind])).toEqual([
      ["1-hour", "session"],
      ["Secondary", "weekly"],
    ]);
  });
});

const stockService = {
  current: Effect.succeed([]),
  streamChanges: Stream.make([]),
  refresh: Effect.void,
  consumeResetCredit: () => Effect.die("stock"),
};

describe("the endpoints' meters in t3's UsageLimitSources", () => {
  it("show a kept reading at once, look again on refresh (a meter going stale), and refuse a reset claim", async () => {
    const store = limitStore(nodeSqlStorage());
    let now = NOW;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const meters = yield* endpointMeterSources({ store, endpoints: () => endpoints, now: () => now });
          const service = withSources(stockService as never, [meters]);
          const before = yield* service.current;
          store.record({ readings: [reading("claude", NOW, [{ id: "five_hour", usedPercent: 25, resetsAt: NOW + 4 * HOUR, windowMinutes: 300 }])] }, endpoints, NOW);
          yield* Effect.yieldNow;
          yield* Effect.sleep("10 millis");
          const after = yield* service.current;
          now = NOW + HOUR;
          yield* service.refresh;
          const stale = yield* service.current;
          const claim = yield* Effect.flip(service.consumeResetCredit({ sourceId: `${LIMIT_SOURCE_PREFIX}claude`, accountId: "claude", creditId: "c" } as never));
          return { before, after, stale, claim };
        }),
      ),
    );
    expect(result.before).toEqual([]);
    expect(result.after.map((source) => [source.id, source.accounts[0]!.usageLimits.windows[0]!.usedPercent, source.error])).toEqual([[`${LIMIT_SOURCE_PREFIX}claude`, 25, undefined]]);
    expect(result.stale[0]!.error).toBe("Last read 1 hour ago (limits are read from this endpoint's answers).");
    expect(result.claim.detail).toMatch(/with the vendor/);
  });
});
