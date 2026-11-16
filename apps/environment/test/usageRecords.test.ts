// t3flare's own usage records (SPI-1173): the Environment keeps what the Sessions, text generation and the model relay
// record, rolled up by quarter hour, agent, endpoint, model and session, for at most the retention window; t3's Usage page
// reads them through our scan readers, split by agent (t3's usage provider) and model (`<endpointId>/<modelId>`). A model
// with no price of its own is priced by t3's rate table.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { UsageEntry } from "@t3flare/models/usage";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { UsageAggregator } from "../../../t3code/apps/server/src/usage/usageAggregation.ts";
import { parseRateTable } from "../../../t3code/apps/server/src/usage/usagePricing.ts";
import { makeOwnUsageReader } from "../src/usage/readers.ts";
import { MAX_USAGE_ROWS, USAGE_RETENTION_MS, USAGE_SLOT_MS, usageStore } from "../src/usage/records.ts";
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

  it("splits by agent: each of t3's providers reads its own, the Durable agent, text generation and the pi CLI under Pi", async () => {
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
