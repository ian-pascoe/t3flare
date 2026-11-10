// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off
// Evidence for ADR-0010 on a deployed stage: no pairing token, bootstrap token or admin token reaches the
// Worker's logs across boots. Streams the logs with `wrangler tail` while it forces two boots (a reset, then
// an armed boot, which seeds the bootstrap grant), and scans every log line.
//
//   bun scripts/stage.ts run <stage> logs-check [--out file.json]
//
// wrangler authenticates with the alchemy profile's Cloudflare OAuth token ($ALCHEMY_PROFILE or `default`,
// from ~/.alchemy), passed in its environment and never printed; or with CLOUDFLARE_API_TOKEN if set.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const base = new URL(process.env.T3_URL!);
const scriptName = base.hostname.split(".")[0]!;
const adminToken = process.env.T3FLARE_ADMIN_TOKEN!;
const bootstrapToken = process.env.T3_BOOTSTRAP_TOKEN!;
const accessHeaders = {
  "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID!,
  "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET!,
};
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;

const profile = process.env.ALCHEMY_PROFILE ?? "default";
const credentials = (() => {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
  return { token: stored.access as string, accountId: stored.accountId as string };
})();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = (method: string, pathname: string) =>
  fetch(new URL(pathname, base), { method, headers: { ...accessHeaders, authorization: `Bearer ${adminToken}` } }).then((r) => r.text());

const logFile = path.join(os.tmpdir(), `t3flare-tail-${Date.now()}.ndjson`);
const out = fs.openSync(logFile, "w", 0o600);
const tail = spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", scriptName, "--format", "json"], {
  cwd: here,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: credentials.token, CLOUDFLARE_ACCOUNT_ID: credentials.accountId ?? "" },
  stdio: ["ignore", out, "pipe"],
});
let tailErr = "";
tail.stderr?.on("data", (chunk) => (tailErr += String(chunk)));
await sleep(8000);

const steps: Array<string> = [];
// Boot 1: reset the object, then a request boots t3 cold (no grant).
await admin("POST", "/_t3flare/restart");
steps.push("restart (abort)");
await sleep(3000);
await fetch(new URL("/api/auth/session", base));
steps.push("request boots t3");
await sleep(4000);
// Boot 2: arming restarts t3 with the bootstrap grant seeded; pair with it; disarm (boot 3, without it).
await admin("POST", "/_t3flare/arm-bootstrap?minutes=2");
steps.push("arm (boot with grant)");
const paired = await fetch(new URL("/api/auth/browser-session", base), {
  method: "POST",
  headers: { "content-type": "application/json", origin: base.origin },
  body: JSON.stringify({ credential: bootstrapToken }),
});
steps.push(`pair ${paired.status}`);
await admin("POST", "/_t3flare/disarm-bootstrap");
steps.push("disarm (boot without grant)");
await sleep(12000);
tail.kill("SIGINT");
await sleep(1000);
fs.closeSync(out);

const text = fs.readFileSync(logFile, "utf8");
// wrangler prints one pretty-printed JSON object per event, back to back.
const chunks = text.split(/\n(?=\{\n)/).filter((chunk) => chunk.trim().startsWith("{"));
const events = chunks.length;
const logLines: Array<string> = [];
for (const chunk of chunks) {
  try {
    const event = JSON.parse(chunk) as { logs?: Array<{ message: Array<unknown> }> };
    for (const log of event.logs ?? []) logLines.push(log.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" "));
  } catch {
    // An event cut off when the tail stopped.
  }
}
const booted = logLines.filter((line) => line.includes('"t3flare":"booted"'));
const forbidden: Record<string, number> = {
  bootstrapToken: text.split(bootstrapToken).length - 1,
  adminToken: text.split(adminToken).length - 1,
  pairingUrlLine: (text.match(/pairingUrl/gi) ?? []).length,
  unredactedTokenParam: (text.match(/[#?&]token=(?!<redacted>)[A-Za-z0-9]/g) ?? []).length,
};
const result = {
  worker: scriptName,
  steps,
  tailEvents: events,
  logLines: logLines.length,
  boots: booted.map((line) => JSON.parse(line.slice(line.indexOf("{")))),
  forbidden,
  tailError: events === 0 ? tailErr.slice(-500) : undefined,
  ok: events > 0 && booted.length >= 2 && Object.values(forbidden).every((n) => n === 0),
};
// The raw tail holds no secret when the check passes; when it fails it may, so it stays in a 0600 temp file.
if (result.ok) fs.rmSync(logFile);
const textOut = JSON.stringify(result, null, 2);
console.log(textOut);
if (outFile) fs.writeFileSync(outFile, `${textOut}\n`);
process.exit(result.ok ? 0 : 1);
