// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off anyUnknownInErrorContext:off
// Parity batch 2's stage harness (docs-archive-1:docs/steps/parity-batch-2.md), through t3's own client protocol as the web client sends
// it, against a stage deployed with `T3FLARE_PROBE=1` (its probe Worker: an OTLP receiver).
// Evidence goes to docs/steps/parity-batch-2/<part>.json, tokens and keys redacted.
//
//   node scripts/stage.ts run pbatch2 pbatch2 <part>
//   parts: registry | storage | otlp | otlp-off
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, base, pair, sleep, wsCall, wsFirst } from "./lib/client.ts";
import { workersDevUrl } from "./lib/scriptSettings.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/parity-batch-2");
const PROBE = workersDevUrl("t3flare-probe-pbatch2");
const PROBE_KEY = process.env.T3FLARE_PROBE_KEY ?? "";

const SECRET_KEYS = /token|authorization|cookie|secret|bearer|credential|managementKey/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  if (typeof value === "string" && PROBE_KEY !== "" && value.includes(PROBE_KEY)) return value.replaceAll(PROBE_KEY, "[probe key]");
  // t3flare's API keys' ids (not secret, but they name the keys): their shape only.
  return typeof value === "string" ? value.replace(/key:[0-9a-f]{8,}/g, "key:[id]") : value;
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

switch (part) {
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
    console.error("usage: node scripts/stage.ts run pbatch2 pbatch2 registry|storage|otlp|otlp-off");
    process.exitCode = 2;
}
