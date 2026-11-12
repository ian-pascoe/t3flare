// @effect-diagnostics globalConsole:off
// Read-only: what t3's source-control discovery (Settings → Source Control) reports for a stage, and the gh commands
// the process router answered for it. Creates no project or thread.
//
//   node scripts/stage.ts run <stage> source-control
import { WS_METHODS } from "@t3tools/contracts";

import { admin, pair, wsCall } from "./lib/client.ts";

const cookie = await pair();
const discovery = (await wsCall(cookie, WS_METHODS.serverDiscoverSourceControl, {})) as {
  readonly sourceControlProviders: ReadonlyArray<{ readonly kind: string; readonly status: string; readonly auth: unknown }>;
};
const github = discovery.sourceControlProviders.find((provider) => provider.kind === "github");
console.log(JSON.stringify({ github: github === undefined ? null : { status: github.status, auth: github.auth } }, null, 1));
const { json } = await admin("GET", "/_t3flare/agents/router-trace");
const entries = (json?.entries ?? []) as ReadonlyArray<{ command: string; argv: ReadonlyArray<string>; route: string; exitCode: number | null }>;
const gh = entries.filter((entry) => entry.command === "gh").slice(-10);
console.log(JSON.stringify(gh.map((entry) => ({ argv: entry.argv.join(" "), route: entry.route, exitCode: entry.exitCode }))));
