// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Pairs an agent-browser session with a stage as the web client's /pair does, without the token or the session cookie
// ever reaching the terminal: the cookie goes through a 0600 temp file into `agent-browser cookies set --curl`.
//
//   node scripts/stage.ts run <stage> browser-pair <agent-browser session> [path]
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { base, pair } from "./lib/client.ts";

const [session, pathname = "/"] = process.argv.slice(2);
if (session === undefined) {
  console.error("usage: browser-pair <session> [path]");
  process.exit(2);
}
const cookie = await pair();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-pair-"));
const file = path.join(dir, "cookie");
fs.writeFileSync(file, cookie, { mode: 0o600 });
try {
  const set = spawnSync("agent-browser", ["--session", session, "cookies", "set", "--curl", file, "--domain", base.hostname], { encoding: "utf8" });
  if (set.status !== 0) throw new Error(`cookies set failed (${set.status})`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
const opened = spawnSync("agent-browser", ["--session", session, "open", new URL(pathname, base).toString()], { encoding: "utf8" });
console.log(JSON.stringify({ paired: true, opened: opened.status === 0 }));
