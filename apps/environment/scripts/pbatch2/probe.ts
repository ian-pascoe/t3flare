// @effect-diagnostics globalDate:off
// Parity batch 2's probe Worker (test stages only, `t3flare-probe-<stage>`, made when T3FLARE_PROBE=1): two throwaway
// receivers the stage's Environment is pointed at, each logging what it got to a Durable Object the harness reads.
//
// - A stand-in for Commissary's management API (`/v9/management/credentials`, `/v9/management/observability/usage/
//   records`), serving the v9 shapes of `~/src/commissary/packages/contract/src/{credentials,usage}.ts`. It answers only
//   with the stage's probe key as the management key and as the Access service token's secret (a self-hosted
//   Commissary's two credentials), and 403 otherwise.
// - An OTLP/HTTP receiver (`/v1/traces`, `/v1/metrics`, `/v1/logs`, JSON): it keeps each export's size, service name and
//   a sample of span and metric names.
//
// `GET /log` (with the probe key as bearer) answers everything logged.
import { DurableObject } from "cloudflare:workers";

interface LogStub {
  append(entry: unknown): Promise<number>;
  entries(): Promise<Array<unknown>>;
}

interface Env {
  readonly PROBE_KEY: string;
  readonly LOG: { idFromName(name: string): unknown; get(id: unknown): LogStub };
}

export class ProbeLog extends DurableObject {
  async append(entry: unknown): Promise<number> {
    const entries = ((await this.ctx.storage.get<Array<unknown>>("entries")) ?? []).slice(-499);
    entries.push(entry);
    await this.ctx.storage.put("entries", entries);
    return entries.length;
  }
  async entries(): Promise<Array<unknown>> {
    return (await this.ctx.storage.get<Array<unknown>>("entries")) ?? [];
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

const HOUR = 3_600_000;

/** Commissary's accounts: a Claude subscription with two windows, a Codex one whose last check failed, a Kimi key t3 has no driver for. */
const credentials = (now: number) => ({
  observed_at: new Date(now).toISOString(),
  files: [
    {
      id: "claude-owner.json",
      auth_index: "c0ffee01",
      name: "claude-owner.json",
      type: "claude",
      provider: "claude",
      label: "owner",
      status: "active",
      status_message: "",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      source: "file",
      size: 1,
      success: 10,
      failed: 0,
      recent_requests: [],
      quota: { signals: {} },
      cooldowns: [],
      email: "owner@example.com",
      quota_report: {
        checked_at: new Date(now - 60_000).toISOString(),
        refreshed_at: new Date(now - 60_000).toISOString(),
        plan: "Max 20x",
        windows: [
          { id: "five_hour", label: "5-hour", used_percent: 37, resets_at: new Date(now + 2 * HOUR).toISOString(), window_seconds: 18_000 },
          { id: "seven_day", label: "Weekly", used_percent: 62, resets_at: new Date(now + 72 * HOUR).toISOString(), window_seconds: 604_800 },
        ],
      },
    },
    {
      id: "codex-owner.json",
      auth_index: "c0ffee02",
      name: "codex-owner.json",
      type: "codex",
      provider: "codex",
      label: "owner",
      status: "error",
      status_message: "",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      source: "file",
      size: 1,
      success: 0,
      failed: 1,
      recent_requests: [],
      quota: { signals: {} },
      cooldowns: [],
      id_token: { plan_type: "pro" },
      quota_report: { checked_at: new Date(now - 60_000).toISOString(), windows: [], error: "the usage endpoint answered 401" },
    },
    {
      id: "kimi.json",
      auth_index: "c0ffee03",
      name: "kimi.json",
      type: "kimi",
      provider: "kimi",
      label: "kimi",
      status: "active",
      status_message: "",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      source: "file",
      size: 1,
      success: 0,
      failed: 0,
      recent_requests: [],
      quota: { signals: {} },
      cooldowns: [],
      quota_report: { checked_at: new Date(now).toISOString(), windows: [{ id: "weekly", label: "Weekly", used_percent: 5 }] },
    },
  ],
});

const record = (now: number, principal: string, index: number, over: Record<string, unknown>) => ({
  timestamp: new Date(now - (index + 1) * 10 * 60_000).toISOString(),
  latency_ms: 900,
  ttft_ms: 300,
  auth_index: "c0ffee01",
  provider: "claude",
  model: "claude-sonnet-5-5",
  alias: "claude-sonnet-5-5",
  endpoint: "POST /v1/messages",
  api_key: principal,
  request_id: `${principal}-${index}`,
  failed: false,
  stream: true,
  fail: { status_code: 200 },
  reasoning_effort: "",
  service_tier: "",
  token_breakdown: {
    total_tokens: 3_450,
    input: { total_tokens: 3_150, uncached_tokens: 150, cache_read_tokens: 2_000, cache_write_tokens: 1_000 },
    output: { total_tokens: 300, reasoning_tokens: 0 },
    unclassified_tokens: 0,
  },
  cost_micros: 12_500,
  ...over,
});

/**
 * Two pages per principal (the cursor is followed): a Durable agent's request, a Codex one (its session identity), a
 * Claude Code one, an OpenCode one, and a failed attempt t3 must leave out.
 */
const records = (now: number, principal: string, before: string | null) =>
  before === null
    ? {
        records: [
          record(now, principal, 0, {}),
          record(now, principal, 1, { model: "gpt-6-luna", provider: "codex", endpoint: "POST /v1/responses", session_id: "codex:019a-probe", cost_micros: 20_000 }),
          record(now, principal, 2, { session_id: "claude:5f1e-probe" }),
        ],
        next_before: `${principal}-cursor`,
      }
    : {
        records: [
          record(now, principal, 3, { model: "claude-haiku-5-5", session_id: "affinity:ses_probe", cost_micros: 1_000 }),
          record(now, principal, 4, { failed: true, fail: { status_code: 429 } }),
        ],
      };

/** What an OTLP/JSON export held: its service, its span or metric names (a sample), its counts. */
const summarize = (signal: string, body: any) => {
  const resources: Array<any> = body?.resourceSpans ?? body?.resourceMetrics ?? body?.resourceLogs ?? [];
  const service = resources
    .flatMap((r: any) => r?.resource?.attributes ?? [])
    .find((a: any) => a?.key === "service.name")?.value?.stringValue;
  const names = new Set<string>();
  let count = 0;
  for (const r of resources) {
    for (const scope of r?.scopeSpans ?? r?.scopeMetrics ?? r?.scopeLogs ?? []) {
      for (const item of scope?.spans ?? scope?.metrics ?? scope?.logRecords ?? []) {
        count += 1;
        if (typeof item?.name === "string" && names.size < 25) names.add(item.name);
      }
    }
  }
  return { signal, service, count, names: [...names] };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const log = env.LOG.get(env.LOG.idFromName("log"));
    const authorization = request.headers.get("authorization");

    if (url.pathname === "/log" && request.method === "GET") {
      return authorization === `Bearer ${env.PROBE_KEY}` ? json(await log.entries()) : json({ error: "unauthorized" }, 401);
    }

    if (url.pathname.startsWith("/v9/management/")) {
      const route = url.pathname.slice("/v9/management/".length);
      const admitted =
        authorization === `Bearer ${env.PROBE_KEY}` &&
        request.headers.get("cf-access-client-id") === "probe-client.access" &&
        request.headers.get("cf-access-client-secret") === env.PROBE_KEY;
      await log.append({
        at: new Date().toISOString(),
        kind: "management",
        method: request.method,
        route,
        query: Object.fromEntries(url.searchParams),
        admitted,
        sentManagementKey: authorization?.startsWith("Bearer ") === true,
        sentServiceToken: request.headers.has("cf-access-client-id") && request.headers.has("cf-access-client-secret"),
      });
      if (!admitted) return json({ error: "forbidden" }, 403);
      const now = Date.now();
      if (request.method === "GET" && route === "credentials") return json(credentials(now));
      if (request.method === "GET" && route === "observability/usage/records") {
        return json(records(now, url.searchParams.get("principal") ?? "", url.searchParams.get("before")));
      }
      return json({ error: "not_found" }, 404);
    }

    const signal = /^\/v1\/(traces|metrics|logs)$/.exec(url.pathname)?.[1];
    if (signal !== undefined && request.method === "POST") {
      const text = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      await log.append({
        at: new Date().toISOString(),
        kind: "otlp",
        contentType: request.headers.get("content-type"),
        bytes: text.length,
        userAgent: request.headers.get("user-agent"),
        ...summarize(signal, body),
      });
      return json({});
    }

    return json({ error: "not found" }, 404);
  },
};
