// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off
// Step 3+ (M2's leak check): tails the stage's Worker logs while other scripts run, then asks the Environment which of
// its T3 Connect secrets (the publish credential, the account token's two parts) appear in them. Names only: the
// Environment compares, nothing secret is printed. The raw tail is kept (0600, in the temp directory) only on a leak.
//
//   bun scripts/stage.ts run <stage> connect-tail <seconds> [--out file.json]
//
// wrangler authenticates as logs-check.ts does (the alchemy profile's token, never printed).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const base = new URL(process.env.T3_URL!);
const scriptName = base.hostname.split(".")[0]!;
const seconds = Number(process.argv[2] ?? "600");
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const headers = {
  "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID!,
  "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET!,
  authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN!}`,
};

const profile = process.env.ALCHEMY_PROFILE ?? "default";
const credentials = (() => {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
  return { token: stored.access as string, accountId: stored.accountId as string };
})();

const logFile = path.join(os.tmpdir(), `t3flare-connect-tail-${Date.now()}.ndjson`);
const out = fs.openSync(logFile, "w", 0o600);
const startedAt = new Date().toISOString();
const tail = spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", scriptName, "--format", "json"], {
  cwd: here,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: credentials.token, CLOUDFLARE_ACCOUNT_ID: credentials.accountId ?? "" },
  stdio: ["ignore", out, "ignore"],
});
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
tail.kill("SIGINT");
await new Promise((resolve) => setTimeout(resolve, 1000));
fs.closeSync(out);

const text = fs.readFileSync(logFile, "utf8");
const response = await fetch(new URL("/_t3flare/check/connect-leak", base), {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
const answer = (await response.json()) as { checked: Array<string>; bytes: number; leaked: Array<string> };
const result = {
  worker: scriptName,
  from: startedAt,
  to: new Date().toISOString(),
  tailBytes: text.length,
  tailEvents: (text.match(/^\{$/gm) ?? []).length,
  publishLines: (text.match(/agent activity publish/g) ?? []).length,
  ...answer,
  ok: response.status === 200 && text.length > 0 && answer.leaked.length === 0,
};
if (result.ok) fs.rmSync(logFile);
console.log(JSON.stringify(result, null, 1));
if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`);
process.exit(result.ok ? 0 : 1);
