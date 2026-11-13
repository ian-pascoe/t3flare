// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Parity batch 2's stage harness (docs/steps/parity-batch-2.md), through t3's own client protocol as the web client sends
// it, against a stage deployed with `T3FLARE_PROBE=1` (its probe Worker: a Commissary stand-in and an OTLP receiver).
// Evidence goes to docs/steps/parity-batch-2/<part>.json, tokens and keys redacted.
//
//   node scripts/stage.ts run pbatch2 pbatch2 <part>
//   parts: usage | registry | storage | otlp | otlp-off
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, base, pair, sleep, wsCall, wsFirst } from "./lib/client.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/parity-batch-2");
const PROBE = `https://t3flare-probe-pbatch2.ian-g-pascoe.workers.dev`;
const PROBE_KEY = process.env.T3FLARE_PROBE_KEY ?? "";

const SECRET_KEYS = /token|authorization|cookie|secret|bearer|credential|managementKey/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  if (typeof value === "string" && PROBE_KEY !== "" && value.includes(PROBE_KEY)) return value.replaceAll(PROBE_KEY, "[probe key]");
  return value;
};

const writeEvidence = (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), `${JSON.stringify(redact({ at: new Date().toISOString(), host: base.host, ...value }), null, 1)}\n`);
  console.log(`${name}: ${value.ok === true ? "PASS" : "FAIL"} -> docs/steps/parity-batch-2/${name}.json`);
  if (value.ok !== true) process.exitCode = 1;
};

const probeLog = async (): Promise<Array<any>> => {
  const response = await fetch(`${PROBE}/log`, { headers: { authorization: `Bearer ${PROBE_KEY}` } });
  if (!response.ok) throw new Error(`probe log: HTTP ${response.status}`);
  return (await response.json()) as Array<any>;
};

const errorOf = (cause: unknown) => {
  const value = cause as { _tag?: string; reason?: string; message?: string; detail?: string };
  return { tag: value?._tag, reason: value?.reason, message: value?.message ?? value?.detail ?? String(cause) };
};

const [part] = process.argv.slice(2);
const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

switch (part) {
  case "usage": {
    // t3's provider refresh refreshes the usage-limit sources too (ws.ts serverRefreshProviders).
    await wsCall(cookie, "server.refreshProviders", {}).catch(() => undefined);
    await sleep(3_000);
    const config = (await wsCall(cookie, "server.getConfig", {})) as any;
    const sources = config?.usageLimitSources ?? [];
    const commissary = sources.find((source: any) => source.id === "commissary");
    const summary = (await wsCall(cookie, "server.getUsageSummary", { sinceDay: day(-2), untilDay: day(0), timeZone: "UTC", awaitRefresh: true })) as any;
    const byProvider: Record<string, { tokens: number; records: number; costUsd: number }> = {};
    for (const bucket of summary?.buckets ?? []) {
      const entry = (byProvider[bucket.provider] ??= { tokens: 0, records: 0, costUsd: 0 });
      entry.records += bucket.records ?? 0;
      entry.tokens += (bucket.totals?.uncachedInputTokens ?? 0) + (bucket.totals?.cachedInputTokens ?? 0) + (bucket.totals?.cacheCreationTokens ?? 0) + (bucket.totals?.outputTokens ?? 0);
      entry.costUsd += bucket.cost?.totalUsd ?? bucket.costUsd ?? 0;
    }
    const log = (await probeLog()).filter((entry) => entry.kind === "management");
    const recordReads = log.filter((entry) => entry.route === "observability/usage/records");
    const ok =
      commissary !== undefined &&
      commissary.error === undefined &&
      commissary.accounts.map((a: any) => `${a.id}:${a.driver}`).join(",") === "c0ffee01:claudeAgent,c0ffee02:codex" &&
      commissary.accounts[0].usageLimits.windows.length === 2 &&
      ["pi", "codex", "claude", "opencode"].every((provider) => (byProvider[provider]?.records ?? 0) > 0) &&
      log.every((entry) => entry.admitted && entry.sentManagementKey && entry.sentServiceToken) &&
      recordReads.some((entry) => entry.query.before !== undefined);
    writeEvidence("usage", { ok, limitSources: sources, summary: { sources: summary?.sources, pricing: summary?.pricing, byProvider, bucketSample: (summary?.buckets ?? []).slice(0, 6) }, managementCalls: log.slice(-12) });
    break;
  }
  case "registry": {
    const search = (await wsCall(cookie, "server.searchAcpRegistry", { query: "", limit: 100 })) as any;
    const agents = (search?.agents ?? []).map((agent: any) => ({ id: agent.id, distribution: agent.distribution, lead: String(agent.description).split(". ")[0] }));
    const prepared: Record<string, unknown> = {};
    for (const agentId of ["claude-acp", "gemini", "cursor"]) {
      prepared[agentId] = await wsCall(cookie, "server.prepareAcpRegistryAgent", { agentId }).then(
        (result) => ({ prepared: result }),
        (cause) => ({ refused: errorOf(cause) }),
      );
    }
    const refusedAll = Object.values(prepared).every((answer: any) => answer.refused !== undefined);
    const ok = agents.length > 20 && agents.find((a: any) => a.id === "claude-acp")?.lead.startsWith("Built in here") && refusedAll;
    writeEvidence("registry", { ok, count: agents.length, agents, prepared });
    break;
  }
  case "storage": {
    const database = await wsFirst(cookie, "server.getDatabaseStorage", {});
    const health = (await admin("GET", "/_t3flare/health")).json;
    const cleanup = await wsFirst(cookie, "server.getStorageCleanupReport", {}).then(
      (report) => ({ report }),
      (cause) => ({ error: errorOf(cause) }),
    );
    const reclaim = await wsCall(cookie, "server.reclaimDatabaseSpace", {}).then(
      (answer) => ({ answer }),
      (cause) => ({ refused: errorOf(cause) }),
    );
    const db = database as any;
    const ok = db !== null && typeof db === "object" && db.databaseBytes > 0 && db.canReclaim === false && (reclaim as any).refused !== undefined;
    writeEvidence("storage", { ok, database, reclaim, cleanup, sqlStats: health?.sqlStats ?? health?.sql });
    break;
  }
  case "otlp": {
    const before = (await probeLog()).filter((entry) => entry.kind === "otlp").length;
    await wsCall(cookie, "server.updateSettings", { patch: { observability: { otlpTracesUrl: `${PROBE}/v1/traces`, otlpMetricsUrl: `${PROBE}/v1/metrics` } } });
    // As on a laptop, the endpoints apply when t3 starts again.
    const restart = (await admin("POST", "/_t3flare/restart?mode=in-place")).json;
    const cookie2 = await pair().catch(() => cookie);
    const config = (await wsCall(cookie2, "server.getConfig", {})) as any;
    // Some traffic for spans, then two export intervals.
    for (let i = 0; i < 3; i++) await wsCall(cookie2, "server.getConfig", {});
    await sleep(25_000);
    const otlp = (await probeLog()).filter((entry) => entry.kind === "otlp").slice(before);
    const traces = otlp.filter((entry) => entry.signal === "traces");
    const metrics = otlp.filter((entry) => entry.signal === "metrics");
    const ok = traces.some((entry) => entry.count > 0) && metrics.some((entry) => entry.count > 0);
    writeEvidence("otlp", { ok, restart, observability: config?.observability ?? config?.settings?.observability, received: { traces: traces.length, metrics: metrics.length }, sample: otlp.slice(0, 6) });
    break;
  }
  case "otlp-off": {
    await wsCall(cookie, "server.updateSettings", { patch: { observability: { otlpTracesUrl: "", otlpMetricsUrl: "" } } });
    await admin("POST", "/_t3flare/restart?mode=in-place");
    await sleep(15_000);
    const count = (await probeLog()).filter((entry) => entry.kind === "otlp").length;
    await sleep(25_000);
    const after = (await probeLog()).filter((entry) => entry.kind === "otlp").length;
    writeEvidence("otlp-off", { ok: after === count, exportsInTheLast25s: after - count });
    break;
  }
  default:
    console.error("usage: node scripts/stage.ts run pbatch2 pbatch2 usage|registry|storage|otlp|otlp-off");
    process.exitCode = 2;
}
