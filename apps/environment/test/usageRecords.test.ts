// t3flare's own usage records (SPI-1173): the Environment keeps what the Sessions, text generation and the model relay
// record, rolled up by quarter hour, agent, endpoint, model and session, for at most the retention window; t3's Usage page
// reads them through our scan readers, split by agent (t3's usage provider) and model (`<endpointId>/<modelId>`). A model
// with no price of its own is priced by t3's rate table.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { UsageEntry } from "@t3flare/models/usage";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageAggregator } from "../../../t3code/apps/server/src/usage/usageAggregation.ts";
import { parseRateTable } from "../../../t3code/apps/server/src/usage/usagePricing.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { commissaryManagementOf } from "../src/usage/commissary.ts";
import { makeOwnUsageReader, usageReader } from "../src/usage/readers.ts";
import { acceptUsage, commissaryCountedCache, countedByCommissary, usageRecorder } from "../src/usage/commissaryCount.ts";
import {
  listedModelOf,
  MAX_USAGE_ROWS,
  USAGE_RETENTION_MS,
  USAGE_SLOT_MS,
  usageStore,
} from "../src/usage/records.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-16T12:00:00Z");

const endpoints: ModelEndpoints = {
  revision: 3,
  endpoints: [
    {
      id: "anth",
      label: "Anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: "api-key",
      headers: {},
      models: [
        { id: "claude-sonnet-4-5", name: "Sonnet", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 64_000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, known: true },
        { id: "house-model", name: "House", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false },
      ],
    },
  ],
};

const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  agent: "durable",
  endpointId: "anth",
  modelId: "claude-sonnet-4-5",
  at: NOW - 60_000,
  session: "s1",
  input: 100,
  cacheRead: 1_000,
  cacheWrite: 0,
  output: 50,
  reasoning: 0,
  costUsd: 0.5,
  ...over,
});

const scanOf = (store: ReturnType<typeof usageStore>, provider: "pi" | "codex" | "claude" | "opencode", sinceMs = NOW - DAY) =>
  Effect.runPromise(
    makeOwnUsageReader(provider, () => store).scan({ instances: [], settings: {} as never, windowStartMs: sinceMs, retentionCutoffMs: NOW - USAGE_RETENTION_MS, awaitRefresh: false }),
  );

describe("the Environment's usage records", () => {
  it("adds the answers of one agent, endpoint, model and session in one quarter hour together", async () => {
    const store = usageStore(nodeSqlStorage());
    expect(store.record([entry(), entry({ input: 1, output: 2, cacheRead: 0, costUsd: 0.25 }), entry({ session: "s2" })], endpoints, NOW)).toBe(3);
    const [scan] = await scanOf(store, "pi");
    expect(scan).toMatchObject({ dir: "t3flare://usage/durable", status: "ok" });
    const records = scan!.files![0]!.records;
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.sessionId === "durable:s1")).toEqual({
      provider: "pi",
      timestampMs: Math.floor((NOW - 60_000) / USAGE_SLOT_MS) * USAGE_SLOT_MS,
      model: "anth/claude-sonnet-4-5",
      rateModel: "claude-sonnet-4-5",
      sessionId: "durable:s1",
      totals: { uncachedInputTokens: 101, cachedInputTokens: 1_000, cacheCreationTokens: 0, outputTokens: 52, reasoningTokens: 0 },
      reportedCostUsd: 0.75,
      speed: "standard",
      dedupeKey: null,
    });
  });

  it("splits by agent: each of t3's providers reads its own, the Durable agent, text generation and Pi (the CLI agent) under Pi", async () => {
    const store = usageStore(nodeSqlStorage());
    store.record([entry(), entry({ agent: "text-generation", session: "" }), entry({ agent: "pi" }), entry({ agent: "codex" }), entry({ agent: "claude" }), entry({ agent: "opencode" })], endpoints, NOW);
    const pi = await scanOf(store, "pi");
    expect(pi.map((scan) => scan.dir)).toEqual(["t3flare://usage/durable", "t3flare://usage/text-generation", "t3flare://usage/pi"]);
    expect(pi.every((scan) => scan.files![0]!.records.every((record) => record.provider === "pi"))).toBe(true);
    for (const provider of ["codex", "claude", "opencode"] as const) {
      const scans = await scanOf(store, provider);
      expect(scans.map((scan) => scan.dir)).toEqual([`t3flare://usage/${provider}`]);
      expect(scans[0]!.files![0]!.records).toMatchObject([{ provider, model: "anth/claude-sonnet-4-5", sessionId: `${provider}:s1` }]);
    }
  });

  it("names a relayed answer's dated model by the endpoint's listed model, and prices it by the endpoint's prices", async () => {
    const store = usageStore(nodeSqlStorage());
    store.record([entry({ agent: "claude", modelId: "claude-sonnet-4-5-20250929", costUsd: null, input: 1_000_000, cacheRead: 0, output: 0 })], endpoints, NOW);
    const [scan] = await scanOf(store, "claude");
    expect(scan!.files![0]!.records).toMatchObject([{ model: "anth/claude-sonnet-4-5", rateModel: "claude-sonnet-4-5", reportedCostUsd: 3 }]);
  });

  it("leaves a model with no price to t3's rate table, which prices it on the Usage page", async () => {
    const store = usageStore(nodeSqlStorage());
    store.record(
      [entry({ agent: "codex", modelId: "house-model", costUsd: null, input: 2_000_000, cacheRead: 0, output: 0 }), entry({ agent: "codex", modelId: "never-heard-of-it", costUsd: null, cacheRead: 0 })],
      endpoints,
      NOW,
    );
    const [scan] = await scanOf(store, "codex");
    const records = scan!.files![0]!.records;
    expect(records.every((record) => record.reportedCostUsd === null)).toBe(true);
    const aggregator = new UsageAggregator({ timeZone: "UTC", sinceDay: "2026-11-16", untilDay: "2026-11-16", rates: parseRateTable({ "house-model": { input_cost_per_token: 0.000_001, output_cost_per_token: 0.000_002 } }) });
    for (const record of records) aggregator.add(record, scan!.dir);
    const buckets = aggregator.finish().buckets;
    expect(buckets.find((bucket) => bucket.model === "anth/house-model")).toMatchObject({ provider: "codex", costUsd: 2, costSource: "modelPriced" });
    expect(buckets.find((bucket) => bucket.model === "anth/never-heard-of-it")).toMatchObject({ costUsd: 0, costSource: "unpriced" });
  });

  it("keeps a model's records apart by endpoint: the same model on two endpoints is two models on the page", async () => {
    const store = usageStore(nodeSqlStorage());
    store.record([entry({ agent: "opencode" }), entry({ agent: "opencode", endpointId: "other" })], endpoints, NOW);
    const [scan] = await scanOf(store, "opencode");
    expect(scan!.files![0]!.records.map((record) => record.model).toSorted()).toEqual(["anth/claude-sonnet-4-5", "other/claude-sonnet-4-5"]);
  });

  it("reads only the window asked for, and keeps nothing past the retention window", async () => {
    const sql = nodeSqlStorage();
    const store = usageStore(sql);
    store.record([entry({ at: NOW - 3 * DAY }), entry({ at: NOW - USAGE_RETENTION_MS - DAY, session: "old" })], endpoints, NOW);
    expect((await scanOf(store, "pi"))[0]!.files![0]!.records).toEqual([]);
    expect((await scanOf(store, "pi", NOW - 4 * DAY))[0]!.files![0]!.records).toHaveLength(1);
    // A record kept then, past the window now, is gone at the next write's prune.
    const later = NOW + USAGE_RETENTION_MS - 2 * DAY;
    store.record([entry({ at: later })], endpoints, later);
    expect((await scanOf(store, "pi", 0))[0]!.files![0]!.records.map((record) => record.timestampMs)).toEqual([Math.floor(later / USAGE_SLOT_MS) * USAGE_SLOT_MS]);
  });

  it("keeps at most MAX_USAGE_ROWS rows, the oldest dropped first", async () => {
    const store = usageStore(nodeSqlStorage(), { maxRows: 3 });
    expect(MAX_USAGE_ROWS).toBeGreaterThan(10_000);
    store.record([1, 2, 3, 4, 5].map((n) => entry({ at: NOW - n * USAGE_SLOT_MS })), endpoints, NOW);
    const records = (await scanOf(store, "pi"))[0]!.files![0]!.records;
    expect(records.map((record) => (NOW - record.timestampMs) / USAGE_SLOT_MS).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("drops an entry the agents Worker should never send: unknown agent, no tokens, a control character", () => {
    const store = usageStore(nodeSqlStorage());
    expect(store.record([{ ...entry(), agent: "probe" } as never, entry({ input: 0, cacheRead: 0, output: 0 }), entry({ modelId: "a\nb" }), "junk" as never], endpoints, NOW)).toBe(0);
  });
});

describe("the records' times and bounds", () => {
  const slotOf = (at: number) => Math.floor(at / USAGE_SLOT_MS) * USAGE_SLOT_MS;
  const rows = async (store: ReturnType<typeof usageStore>) => (await scanOf(store, "pi", 0))[0]!.files![0]!.records;

  it("rolls up by quarter hour: the slot's first and last moment share a row, the next moment starts one", async () => {
    const store = usageStore(nodeSqlStorage());
    const slot = slotOf(NOW - DAY);
    store.record([entry({ at: slot }), entry({ at: slot + USAGE_SLOT_MS - 1 }), entry({ at: slot + USAGE_SLOT_MS })], endpoints, NOW);
    expect((await rows(store)).map((record) => [record.timestampMs, record.totals.outputTokens])).toEqual([
      [slot, 100],
      [slot + USAGE_SLOT_MS, 50],
    ]);
  });

  it("puts a record in its quarter hour, by the clock: 12:14:59 in 12:00's, 12:15:00 in 12:15's", async () => {
    const store = usageStore(nodeSqlStorage());
    store.record([entry({ at: Date.parse("2026-11-16T11:14:59.999Z") }), entry({ at: Date.parse("2026-11-16T11:15:00Z") })], endpoints, NOW);
    expect((await rows(store)).map((record) => new Date(record.timestampMs).toISOString())).toEqual(["2026-11-16T11:00:00.000Z", "2026-11-16T11:15:00.000Z"]);
  });

  it("reads from the start of the quarter hour the window starts in", async () => {
    const store = usageStore(nodeSqlStorage());
    store.record([entry({ at: Date.parse("2026-11-16T11:01:00Z") })], endpoints, NOW);
    expect((await scanOf(store, "pi", Date.parse("2026-11-16T11:10:00Z")))[0]!.files![0]!.records).toHaveLength(1);
    expect((await scanOf(store, "pi", Date.parse("2026-11-16T11:15:00Z")))[0]!.files![0]!.records).toHaveLength(0);
  });

  it("keeps an entry inside the retention window and up to an hour ahead of the clock, and drops the rest", () => {
    const store = usageStore(nodeSqlStorage());
    expect(store.record([entry({ at: NOW - USAGE_RETENTION_MS + 60_000 }), entry({ at: NOW + 30 * 60_000 })], endpoints, NOW)).toBe(2);
    expect(store.record([entry({ at: NOW - USAGE_RETENTION_MS - 60_000 }), entry({ at: NOW + 2 * 60 * 60_000 })], endpoints, NOW)).toBe(0);
  });

  it("prunes at most once an hour", async () => {
    const store = usageStore(nodeSqlStorage(), { maxRows: 1 });
    store.record([entry({ at: NOW - 3 * USAGE_SLOT_MS }), entry({ at: NOW - 2 * USAGE_SLOT_MS })], endpoints, NOW);
    expect(await rows(store)).toHaveLength(1);
    // Within the hour: kept past the cap.
    store.record([entry({ at: NOW })], endpoints, NOW + 30 * 60_000);
    expect(await rows(store)).toHaveLength(2);
    // An hour after the last prune: pruned again.
    store.record([entry({ at: NOW + 60 * 60_000 })], endpoints, NOW + 60 * 60_000);
    expect((await rows(store)).map((record) => record.timestampMs)).toEqual([slotOf(NOW + 60 * 60_000)]);
  });

  it("reports a table it cannot read as a failed source, never a failed page", async () => {
    const broken = { record: () => 0, read: () => { throw new Error("SQLITE_CORRUPT"); } };
    const scans = await Effect.runPromise(
      makeOwnUsageReader("pi", () => broken).scan({ instances: [], settings: {} as never, windowStartMs: 0, retentionCutoffMs: 0, awaitRefresh: false }),
    );
    expect(scans.map((scan) => [scan.dir, scan.status, scan.files])).toEqual([
      ["t3flare://usage/durable", "failed", null],
      ["t3flare://usage/text-generation", "failed", null],
      ["t3flare://usage/pi", "failed", null],
    ]);
  });
});

describe("a dated model's listed one", () => {
  const listed = (...ids: Array<string>) => ids.map((id) => ({ ...endpoints.endpoints[0]!.models[0]!, id }));
  it("is the listed id a date follows, and never another model's prefix", () => {
    expect(listedModelOf(listed("claude-sonnet-4-5"), "claude-sonnet-4-5-20250929")?.id).toBe("claude-sonnet-4-5");
    expect(listedModelOf(listed("gpt-5"), "gpt-5-2025-08-07")?.id).toBe("gpt-5");
    expect(listedModelOf(listed("gpt-5"), "gpt-5-mini")).toBeUndefined();
    expect(listedModelOf(listed("gpt-5"), "gpt-5-mini-2025-08-07")).toBeUndefined();
    expect(listedModelOf(listed("gpt-5"), "gpt-5-2025")).toBeUndefined();
    expect(listedModelOf(listed("gpt-5", "gpt-5-mini"), "gpt-5-mini")?.id).toBe("gpt-5-mini");
  });
});

// Until the hard cut (SPI-1176), the page reads Commissary's request log as well: a request on an endpoint keyed with a
// key the log is read for is the log's to count, never ours too.
describe("no request counted twice beside Commissary's log", () => {
  const PROXY_KEY = "cms_global_0a1b2c3d4e5f6a7b8c9d_c2VjcmV0";
  const OTHER_KEY = "cms_global_ffffffffffffffffffff_b3RoZXI";
  const keys: Readonly<Record<string, string>> = { comm: PROXY_KEY, mine: "sk-ant-own-key", other: OTHER_KEY };
  const two: ModelEndpoints = {
    revision: 7,
    endpoints: [
      { ...endpoints.endpoints[0]!, id: "comm" },
      { ...endpoints.endpoints[0]!, id: "mine" },
      { ...endpoints.endpoints[0]!, id: "other" },
      { ...endpoints.endpoints[0]!, id: "open", auth: "none" },
    ],
  };
  const config = commissaryManagementOf({ COMMISSARY_MANAGEMENT_URL: "https://c.example", COMMISSARY_MANAGEMENT_KEY: "cmsm_global_k_s", MODEL_PROXY_API_KEY: PROXY_KEY })!;
  const counted = (endpointsNow: ModelEndpoints) => countedByCommissary(endpointsNow, async (id) => keys[id], config.principals);

  afterEach(() => vi.unstubAllGlobals());

  it("finds the endpoints whose key is a principal the log is read for (the proxy's key), and only those", async () => {
    expect([...(await counted(two))]).toEqual(["comm"]);
    expect([...(await countedByCommissary(two, async (id) => keys[id], []))]).toEqual([]);
    expect([...(await countedByCommissary(two, async (id) => keys[id], ["key:ffffffffffffffffffff", "key:0a1b2c3d4e5f6a7b8c9d"]))].sort()).toEqual(["comm", "other"]);
  });

  it("keeps every other endpoint's records, and stores what it keeps", async () => {
    const store = usageStore(nodeSqlStorage());
    const answer = await acceptUsage(
      { entries: [entry({ endpointId: "comm" }), entry({ endpointId: "mine" }), entry({ endpointId: "open" }), entry({ endpointId: "other" })] },
      { store, endpoints: two, countedByCommissary: counted, now: () => NOW },
    );
    expect(answer).toEqual({ kept: 3 });
    expect((await scanOf(store, "pi"))[0]!.files![0]!.records.map((record) => record.model).sort()).toEqual(["mine/claude-sonnet-4-5", "open/claude-sonnet-4-5", "other/claude-sonnet-4-5"]);
  });

  it("drops the entries when it cannot tell, and reads at most MAX_USAGE_ENTRIES of one call", async () => {
    const store = usageStore(nodeSqlStorage());
    expect(await acceptUsage({ entries: [entry()] }, { store, endpoints: two, countedByCommissary: () => Promise.reject(new Error("sealed store")), now: () => NOW })).toEqual({ kept: 0 });
    expect(await acceptUsage({ entries: Array.from({ length: 100 }, () => entry({ endpointId: "mine" })) }, { store, endpoints: two, countedByCommissary: counted, now: () => NOW })).toEqual({ kept: 64 });
    expect(await acceptUsage("junk", { store, endpoints: two, countedByCommissary: counted, now: () => NOW })).toEqual({ kept: 0 });
  });

  it("is what EnvironmentDO.recordUsage runs: the configured principals, the store's keys, the store's endpoints", async () => {
    const store = usageStore(nodeSqlStorage());
    let opened = 0;
    const record = usageRecorder({
      usage: () => store,
      principals: () => config.principals,
      endpoints: { load: () => two, resolve: async (id) => (opened++, { endpoint: two.endpoints.find((endpoint) => endpoint.id === id)!, apiKey: keys[id], unreadable: false }) },
      now: () => NOW,
    });
    expect(await record({ entries: [entry({ endpointId: "comm" }), entry({ endpointId: "mine" })] })).toEqual({ kept: 1 });
    expect(await record({ entries: [entry({ endpointId: "comm" })] })).toEqual({ kept: 0 });
    expect((await scanOf(store, "pi"))[0]!.files![0]!.records.map((record) => record.model)).toEqual(["mine/claude-sonnet-4-5"]);
    // Three API-key endpoints, opened once for the revision.
    expect(opened).toBe(3);
  });

  it("opens the keys once per revision of the endpoints, and asks again after a failure", async () => {
    let opened = 0;
    let fail = true;
    const cache = commissaryCountedCache(async (endpointsNow) => {
      opened += 1;
      if (fail) throw new Error("busy");
      return counted(endpointsNow);
    });
    await expect(cache(two)).rejects.toThrow("busy");
    fail = false;
    expect([...(await cache(two))]).toEqual(["comm"]);
    await cache(two);
    expect(opened).toBe(2);
    await cache({ ...two, revision: 8 });
    expect(opened).toBe(3);
  });

  it("counts a turn on the proxy-key endpoint once on the page (the log's) and another endpoint's once (ours)", async () => {
    const store = usageStore(nodeSqlStorage());
    bindEnvironmentServices({ usage: store, commissary: config } as unknown as EnvironmentServices);
    // The agents Worker sends both; the Environment keeps only `mine`'s.
    await acceptUsage({ entries: [entry({ agent: "claude", endpointId: "comm", modelId: "claude-sonnet-4-5" }), entry({ agent: "claude", endpointId: "mine" })] }, { store, endpoints: two, countedByCommissary: counted, now: () => NOW });
    // Commissary's log has the `comm` request, under the proxy key's principal.
    vi.stubGlobal("fetch", async (url: string) => {
      const query = new URL(url).searchParams;
      const records = query.get("principal") === "key:0a1b2c3d4e5f6a7b8c9d" ? [{ timestamp: new Date(NOW - 60_000).toISOString(), provider: "claude", model: "claude-sonnet-4-5", endpoint: "/v1/messages", api_key: "x", request_id: "r1", failed: false, session_id: "claude:abc", token_breakdown: { input: { uncached_tokens: 100, cache_read_tokens: 1_000, cache_write_tokens: 0 }, output: { total_tokens: 50, reasoning_tokens: 0 } } }] : [];
      return Response.json({ records });
    });
    const scans = await Effect.runPromise(usageReader("claude").scan({ instances: [], settings: {} as never, windowStartMs: NOW - DAY, retentionCutoffMs: 0, awaitRefresh: true }));
    const records = scans.flatMap((scan) => (scan.files ?? []).flatMap((file) => file.records.map((record) => `${scan.dir} ${record.model}`)));
    expect(records).toEqual(["t3flare://usage/claude mine/claude-sonnet-4-5", "commissary://c.example/claude claude-sonnet-4-5"]);
  });
});

