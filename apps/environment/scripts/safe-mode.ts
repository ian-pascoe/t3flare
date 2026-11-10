// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off
// Evidence for the boot counter and safe mode on a deployed stage:
//
//   bun scripts/stage.ts run <stage> safe-mode [--out file.json]
//
// 1. Forced by the boot counter: the admin fault route makes the next three boots fail; three requests each
//    fail to boot t3 (500), and the fourth finds the object in safe mode (503) without trying.
// 2. The toggle: turning safe mode off lets t3 boot (200); turning it on by hand stops t3 (503); off again (200).
import * as fs from "node:fs";

const base = new URL(process.env.T3_URL!);
const headers = {
  "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID!,
  "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET!,
  authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN}`,
};
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const admin = async (method: string, pathname: string) => (await fetch(new URL(pathname, base), { method, headers })).json() as Promise<any>;
const client = async () => {
  const response = await fetch(new URL("/api/auth/session", base));
  const body = await response.text();
  return { status: response.status, body: body.slice(0, 160) };
};

const steps: Array<Record<string, unknown>> = [];
const step = (name: string, value: unknown) => steps.push({ step: name, at: new Date().toISOString(), value });

step("inject 3 boot failures", await admin("POST", "/_t3flare/fault/boot-failures?count=3"));
const requests = [];
for (let i = 0; i < 4; i++) requests.push(await client());
step("client requests", requests);
const forced = await admin("GET", "/_t3flare/health");
step("health", { safeMode: forced.safeMode, bootRecord: forced.bootRecord, runtime: forced.runtime });

step("safe mode off", await admin("POST", "/_t3flare/safe-mode?on=0"));
const afterOff = await client();
step("client request", afterOff);
step("safe mode on (manual)", await admin("POST", "/_t3flare/safe-mode?on=1"));
const manual = await client();
step("client request", manual);
const manualHealth = await admin("GET", "/_t3flare/health");
step("health", { safeMode: manualHealth.safeMode, runtime: manualHealth.runtime });
step("safe mode off", await admin("POST", "/_t3flare/safe-mode?on=0"));
const restored = await client();
step("client request", restored);

const result = {
  url: base.origin,
  steps,
  ok:
    requests.slice(0, 3).every((r) => r.status === 500) &&
    requests[3]!.status === 503 &&
    forced.safeMode?.on === true &&
    forced.safeMode?.reason === "boot-failures" &&
    afterOff.status === 200 &&
    manual.status === 503 &&
    manualHealth.safeMode?.reason === "manual" &&
    manualHealth.runtime === "stopped" &&
    restored.status === 200,
};
const text = JSON.stringify(result, null, 2);
console.log(text);
if (outFile) fs.writeFileSync(outFile, `${text}\n`);
process.exit(result.ok ? 0 : 1);
