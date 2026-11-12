// @effect-diagnostics globalConsole:off globalDate:off
// Step 3, M4: after delegated work ends and the laptop stops calling, the cloud Environment resets when idle (ADR-0003).
// Stops runs still open (`--stop-open`), then reads the admin health route (which neither boots t3 nor counts as
// activity) until the object has reset: t3 stopped and a new construction. Writes docs/steps/step-3/m4-idle.json.
//
//   node scripts/stage.ts run step3 peer-idle [--stop-open]
import { admin, dispatch, pair, sleep, uuid } from "./lib/client.ts";
import { writeEvidence } from "./lib/evidence.ts";

const out: Record<string, unknown> = {};
if (process.argv.includes("--stop-open")) {
  const cookie = await pair();
  const open = (await admin("POST", "/_t3flare/sql", { sql: "SELECT thread_id, run_id FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed','failed','cancelled','interrupted')", params: [] })).json;
  for (const [threadId, runId] of (open?.rows ?? []) as Array<[string, string]>) {
    await dispatch(cookie, { type: "run.interrupt", commandId: uuid(), threadId, runId, reason: "step 3 idle check" });
  }
  out.stopped = open?.rows?.length ?? 0;
  // Disarm pairing so the seeded grant is not what keeps it up.
  await admin("POST", "/_t3flare/disarm-bootstrap");
}
const first = (await admin("GET", "/_t3flare/health")).json;
const started = Date.now();
let last = first;
const samples: Array<unknown> = [];
while (Date.now() - started < 15 * 60_000) {
  await sleep(20_000);
  last = (await admin("GET", "/_t3flare/health")).json;
  samples.push({ s: Math.round((Date.now() - started) / 1000), runtime: last?.runtime, constructions: last?.isolate?.constructions, openWork: last?.openWork, alarm: last?.alarm });
  if (last?.runtime === "stopped" && last?.object?.constructedAt !== first?.object?.constructedAt) break;
}
out.before = { runtime: first?.runtime, constructedAt: first?.object?.constructedAt, activity: first?.activity };
out.after = { runtime: last?.runtime, constructedAt: last?.object?.constructedAt, alarm: last?.alarm, openWork: last?.openWork };
out.samples = samples;
out.ok = last?.runtime === "stopped" && last?.object?.constructedAt !== first?.object?.constructedAt;
writeEvidence("m4-idle.json", out);
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
process.exit(out.ok ? 0 : 1);
