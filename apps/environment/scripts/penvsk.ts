// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1148's stage evidence (stage `penvsk`): Environment skills. Run through the stage's `run`, which sets the stage's
// service token and admin token (never printed):
//
//
// M0's probes (env-probe.json at f64889a, env-sync.json at 1fdd389) ran through a temporary admin route, removed in M2;
// see the history of this file at those commits.
//
// Evidence goes to docs/steps/spi-1001/.
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, pair } from "./lib/client.ts";

const T3 = process.env.T3_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1001");
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };
const WORKSPACE = "penvsk-mount";
const MOUNT = "/workspace/.agents/skills";

/** The deployed build's commit (the Worker's `/_t3flare/health`), so each evidence file names the code it ran against. */
const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), ...value }, null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1001/${name}`);
};

const callOn = async (id: string, body: unknown) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${id}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, ...JSON.parse(text) } as { status: number; ms?: number; result: any; container: any };
  } catch {
    return { status: response.status, result: text.slice(0, 500), container: undefined };
  }
};
const call = (body: unknown) => callOn(WORKSPACE, body);
const sh = async (script: string) => {
  const answer = await call({ exec: { script, timeoutMs: 180_000 } });
  return { exitCode: answer.result?.exitCode, stdout: String(answer.result?.stdout ?? "").slice(0, 3000), stderr: String(answer.result?.stderr ?? "").slice(0, 1000), running: answer.container?.running };
};
const fsOp = async (op: unknown) => (await call({ fs: op })).result;
const [command] = process.argv.slice(2);
{
  console.error(`unknown command ${command ?? "(none)"}`);
  process.exit(2);
}
