// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalDate:off
// Streams a stage Worker's logs to a file with `wrangler tail` until stopped (step 2a part 2's diagnosis):
//
//   bun scripts/stage.ts run <stage> tail environment|agents <file.ndjson>
//
// wrangler authenticates as logs-check.ts does (the alchemy profile's token, or CLOUDFLARE_API_TOKEN), in its
// environment only; nothing secret is printed. The file is written 0600 and holds only what the Workers log.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const [which = "agents", file = path.join(os.tmpdir(), `t3flare-tail-${Date.now()}.ndjson`)] = process.argv.slice(2);
const environmentName = new URL(process.env.T3_URL!).hostname.split(".")[0]!;
const scriptName = which === "agents" ? environmentName.replace("t3flare-environment-", "t3flare-agents-") : environmentName;

const profile = process.env.ALCHEMY_PROFILE ?? "default";
const credentials = (() => {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
  return { token: stored.access as string, accountId: stored.accountId as string };
})();

const out = fs.openSync(file, "w", 0o600);
const tail = spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", scriptName, "--format", "json"], {
  cwd: here,
  stdio: ["ignore", out, "ignore"],
  env: { ...process.env, CLOUDFLARE_API_TOKEN: credentials.token, ...(credentials.accountId ? { CLOUDFLARE_ACCOUNT_ID: credentials.accountId } : {}) },
});
console.log(`tailing ${scriptName} to ${file}`);
process.on("SIGTERM", () => tail.kill());
process.on("SIGINT", () => tail.kill());
tail.on("exit", (code) => process.exit(code ?? 0));
