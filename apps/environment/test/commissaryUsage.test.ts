// Parity G8 (SPI-999): Commissary's accounts and request log as t3's usage-limit source and usage records.
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  commissaryManagementOf,
  limitSnapshot,
  readCredentials,
  readUsageRecords,
  toUsageRecord,
  type CommissaryUsageRecord,
  type Fetch,
} from "../src/usage/commissary.ts";
import { makeCommissaryUsageReader, sharedRead } from "../src/usage/readers.ts";

const KEY = "cms_global_0a1b2c3d4e5f6a7b8c9d_c2VjcmV0X3dpdGhfdW5kZXJzY29yZXM";

describe("Commissary's management settings", () => {
  it("are off unless the URL and the management key are both set", () => {
    expect(commissaryManagementOf({ MODEL_PROXY_API_KEY: KEY })).toBeUndefined();
    expect(commissaryManagementOf({ COMMISSARY_MANAGEMENT_URL: "https://c.example", MODEL_PROXY_API_KEY: KEY })).toBeUndefined();
  });

  it("count the Workers' own key's requests, and any principal listed, and use a service token only when whole", () => {
    const config = commissaryManagementOf({
      COMMISSARY_MANAGEMENT_URL: "https://c.example/",
      COMMISSARY_MANAGEMENT_KEY: "cmsm_global_k_s",
      COMMISSARY_ACCESS_CLIENT_ID: "id.access",
      COMMISSARY_USAGE_PRINCIPALS: "key:ffff, key:0a1b2c3d4e5f6a7b8c9d",
      MODEL_PROXY_API_KEY: KEY,
    });
    expect(config).toEqual({ url: "https://c.example", managementKey: "cmsm_global_k_s", principals: ["key:0a1b2c3d4e5f6a7b8c9d", "key:ffff"] });
  });
});

describe("Commissary's accounts as t3's limit meters", () => {
  const list = {
    files: [
      {
        id: "claude-a.json",
        auth_index: "a1",
        provider: "claude",
        label: "a",
        disabled: false,
        email: "owner@example.com",
        quota_report: {
          checked_at: "2026-11-13T10:00:00Z",
          refreshed_at: "2026-11-13T10:00:00Z",
          plan: "Max 20x",
          windows: [
            { id: "five_hour", label: "5-hour", used_percent: 42.5, resets_at: "2026-11-13T12:00:00Z", window_seconds: 18000 },
            { id: "seven_day_opus", label: "Weekly Opus", used_percent: 130 },
          ],
        },
      },
      { id: "codex-b.json", auth_index: "b2", provider: "codex", label: "b", disabled: false, quota_report: { checked_at: "2026-11-13T10:00:00Z", windows: [], error: "token expired" } },
      { id: "c.json", auth_index: "c3", provider: "claude", label: "c", disabled: true, quota_report: { checked_at: "x", windows: [] } },
      { id: "d.json", auth_index: "d4", provider: "kimi", label: "d", disabled: false, quota_report: { checked_at: "2026-11-13T10:00:00Z", windows: [] } },
      { id: "e.json", auth_index: "e5", provider: "codex", label: "e", disabled: false },
    ],
  };

  it("shows each enabled account t3 has a driver for, with its windows, as one source", () => {
    const snapshot = limitSnapshot("2026-11-13T10:01:00.000Z", { list });
    expect(snapshot).toMatchObject({ id: "commissary", kind: "cliproxy", label: "Commissary", checkedAt: "2026-11-13T10:01:00.000Z" });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.accounts).toEqual([
      {
        id: "a1",
        driver: "claudeAgent",
        email: "owner@example.com",
        plan: "Max 20x",
        usageLimits: {
          checkedAt: "2026-11-13T10:00:00.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 42.5, resetsAt: "2026-11-13T12:00:00.000Z", windowDurationMins: 300 },
            { id: "seven_day_opus", kind: "weekly", label: "Weekly Opus", usedPercent: 100 },
          ],
        },
      },
      { id: "b2", driver: "codex", usageLimits: { checkedAt: "2026-11-13T10:00:00.000Z", windows: [], unavailable: { reason: "probeFailed", message: "token expired" } } },
    ]);
  });

  it("reports a failed read as the source's error", () => {
    expect(limitSnapshot("2026-11-13T10:01:00.000Z", { error: "Commissary refused it." })).toMatchObject({ accounts: [], error: "Commissary refused it." });
  });
});

const record = (over: Partial<CommissaryUsageRecord>): CommissaryUsageRecord => ({
  timestamp: "2026-11-13T09:00:00Z",
  provider: "claude",
  model: "claude-sonnet-5-5",
  endpoint: "POST /v1/messages",
  api_key: "key:0a1b2c3d4e5f6a7b8c9d",
  request_id: "r1",
  failed: false,
  token_breakdown: { input: { uncached_tokens: 100, cache_read_tokens: 2000, cache_write_tokens: 50 }, output: { total_tokens: 300, reasoning_tokens: 40 } },
  cost_micros: 12_500,
  ...over,
});

describe("Commissary's request log as t3's usage records", () => {
  it("names the agent that made each request", () => {
    const providers = [
      record({ session_id: "codex:019a" }),
      record({ endpoint: "POST /v1/responses" }),
      record({ endpoint: "POST /backend-api/codex/responses" }),
      record({ session_id: "claude:5f1e" }),
      record({ session_id: "affinity:ses_1" }),
      record({ session_id: "derived:ctx:v1:abc" }),
      record({}),
    ].map((r) => toUsageRecord(r)?.provider);
    expect(providers).toEqual(["codex", "codex", "codex", "claude", "opencode", "pi", "pi"]);
  });

  it("carries the tokens by kind, Commissary's price, and a key no other record shares", () => {
    expect(toUsageRecord(record({ session_id: "claude:5f1e", service_tier: "priority" }))).toEqual({
      provider: "claude",
      timestampMs: Date.parse("2026-11-13T09:00:00Z"),
      model: "claude-sonnet-5-5",
      sessionId: "claude:5f1e",
      totals: { uncachedInputTokens: 100, cachedInputTokens: 2000, cacheCreationTokens: 50, outputTokens: 300, reasoningTokens: 40 },
      reportedCostUsd: 0.0125,
      speed: "fast",
      dedupeKey: "commissary:r1",
    });
  });

  it("leaves an unpriced model to t3's rate table, and drops failed attempts and tool calls", () => {
    expect(toUsageRecord(record({ unpriced: true, cost_micros: 0 }))?.reportedCostUsd).toBeNull();
    expect(toUsageRecord(record({ failed: true }))).toBeUndefined();
    expect(toUsageRecord(record({ area: "tools" }))).toBeUndefined();
  });
});

describe("the management API client", () => {
  const config = { url: "https://c.example", org: "acme", managementKey: "cmsm_x_k_s", access: { clientId: "id.access", clientSecret: "sec" }, principals: ["key:a", "key:b"] };
  const recorder = (answer: (url: URL) => Response) => {
    const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
    const fetcher: Fetch = async (input, init) => {
      const url = new URL(input);
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return answer(url);
    };
    return { calls, fetcher };
  };

  it("sends the management key and the Access service token to the org's management URL", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ files: [] }));
    await readCredentials(fetcher, config);
    expect(calls[0]?.url.href).toBe("https://c.example/v9/management/orgs/acme/credentials");
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer cmsm_x_k_s", "cf-access-client-id": "id.access", "cf-access-client-secret": "sec" });
  });

  it("reads each principal's successful model records since the window, following the cursor", async () => {
    const { calls, fetcher } = recorder((url) =>
      Response.json(
        url.searchParams.get("principal") === "key:a" && url.searchParams.get("before") === null
          ? { records: [record({ request_id: "a1" })], next_before: "cur1" }
          : { records: [record({ request_id: `${url.searchParams.get("principal")}-last` })] },
      ),
    );
    const read = await readUsageRecords(fetcher, config, 1_700_000_000_000, (r) => r);
    expect(read.records.map((r) => r.request_id)).toEqual(["a1", "key:a-last", "key:b-last"]);
    expect(read.truncated).toBe(false);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ since: "1700000000000", principal: "key:a", area: "models", failed: "false", limit: "1000" });
    expect(calls[1]?.url.searchParams.get("before")).toBe("cur1");
  });

  it("says a refused key needs an org admin's, without echoing anything secret", async () => {
    const { fetcher } = recorder(() => Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(readCredentials(fetcher, config)).rejects.toThrow(/org admin's key/);
    await expect(readCredentials(fetcher, config)).rejects.not.toThrow(/cmsm_/);
  });
});

describe("t3's usage readers over Commissary", () => {
  const config = { url: "https://c.example", managementKey: "cmsm_x_k_s", principals: ["key:a"] };
  const scanInput = { instances: [], settings: {} as never, windowStartMs: 1_700_000_000_000, retentionCutoffMs: 0, awaitRefresh: false };

  it("report no source until Commissary is configured", async () => {
    const reader = makeCommissaryUsageReader("pi", sharedRead(() => 0, async () => Response.json({ records: [] })), () => undefined);
    if (reader.kind !== "scan") throw new Error("scan reader expected");
    expect(await Effect.runPromise(reader.scan(scanInput))).toEqual([]);
  });

  it("share one read between the four readers, each keeping its agent's records", async () => {
    let reads = 0;
    const read = sharedRead(
      () => 1_000,
      async () => {
        reads += 1;
        return Response.json({ records: [record({ request_id: "p" }), record({ request_id: "c", session_id: "codex:1" }), record({ request_id: "x", failed: true })] });
      },
    );
    const scans = await Promise.all(
      (["pi", "codex", "claude", "opencode"] as const).map((provider) => {
        const reader = makeCommissaryUsageReader(provider, read, () => config);
        if (reader.kind !== "scan") throw new Error("scan reader expected");
        return Effect.runPromise(reader.scan(scanInput));
      }),
    );
    expect(reads).toBe(1);
    expect(scans.map((sources) => sources[0]?.files?.[0]?.records.map((r) => r.dedupeKey))).toEqual([["commissary:p"], ["commissary:c"], [], []]);
    expect(scans[0]?.[0]).toMatchObject({ dir: "commissary://c.example/pi", volumeId: "commissary", status: "ok" });
  });

  it("show a failed read as a failed source", async () => {
    const read = sharedRead(() => 0, async () => Response.json({ error: "forbidden" }, { status: 403 }));
    const reader = makeCommissaryUsageReader("codex", read, () => config);
    if (reader.kind !== "scan") throw new Error("scan reader expected");
    const [source] = await Effect.runPromise(reader.scan(scanInput));
    expect(source).toMatchObject({ status: "failed", files: null });
    expect(source?.message).toMatch(/org admin's key/);
  });
});
