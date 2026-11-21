// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalTimers:off
// The Session push depth check (ADR-0005, 2026-11-21 refinement): many tool-using turns in a row on one Durable thread
// all complete. Before the refinement, each round trip between the Environment and a Session nested the next one level
// deeper, and a long thread's turn failed with "Subrequest depth limit exceeded" ("did not answer open").
//
//   node scripts/stage.ts run <stage> pushdepth [--turns 15] [--out file.json]
import * as fs from "node:fs";

import { createProjectAndThread, pair, runsOf, sendMessage, SETTLED, waitFor } from "./lib/client.ts";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const turns = Number(arg("--turns") ?? 15);
const out = arg("--out");

const cookie = await pair();
const stamp = Date.now().toString(36);
const { threadId } = await createProjectAndThread(cookie, {
  title: `pushdepth ${stamp}`,
  workspaceRoot: `/t3/home/pushdepth-${stamp}`,
  runtimeMode: "full-access",
});

const results: Array<{ turn: number; status: string; ms: number }> = [];
for (let turn = 1; turn <= turns; turn++) {
  await sendMessage(cookie, threadId, `Run the shell command \`echo turn-${turn}\` with your bash tool, then reply with its output and nothing else.`);
  const settled = await waitFor(cookie, threadId, (p) => runsOf(p).length >= turn && runsOf(p).every((r) => SETTLED.has(r.status)), 5 * 60_000);
  const status = runsOf(settled.projection).at(-1)?.status ?? "missing";
  results.push({ turn, status, ms: settled.ms });
  console.log(`turn ${turn}: ${status} in ${settled.ms} ms`);
  if (status !== "completed") break;
}

const failed = results.filter((r) => r.status !== "completed");
const report = { at: new Date().toISOString(), threadId, turns, results, ok: failed.length === 0 && results.length === turns };
if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
console.log(report.ok ? `ok: ${turns} turns completed` : `FAILED: ${JSON.stringify(failed)}`);
process.exit(report.ok ? 0 : 1);
