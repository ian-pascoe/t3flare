// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 2b M4: deleting a worktree thread frees its Workspace. Evidence around a deletion made in the stock web client:
//
//   bun scripts/stage.ts run <stage> delete before --worktree <id> [--dirty]  an unpushed commit (and with --dirty an
//       uncommitted file) in the worktree, from its terminal; records the Workspace's state
//   bun scripts/stage.ts run <stage> delete after --worktree <id> --branch <name> [--out f]  polls up to 60 s for: the
//       registry row gone (or tombstoned), the DO's storage empty, the Container stopped and out of the budget, the
//       branch in the project's repo
import * as fs from "node:fs";

import { admin, pair, sleep, uuid } from "./lib/client.ts";
import { attachTerminal } from "./lib/terminal.ts";

const [scenario = "after", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const id = arg("worktree")!;
const enc = encodeURIComponent(id);
const report: Record<string, unknown> = { scenario, worktree: id, at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return ok;
};
const state = async () => {
  const workspaces = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces as Array<any>;
  const row = workspaces.find((ws) => ws.id === id) ?? null;
  const info = (await admin("POST", `/_t3flare/agents/workspace-call?id=${enc}`, { killExecs: [] })).json;
  const budget = (await admin("GET", "/_t3flare/agents/budget")).json;
  return {
    row: row === null ? null : { state: row.state, references: row.references, lastError: row.lastError, purgeAfter: row.purgeAfter },
    container: info?.container ?? info,
    leased: (budget?.leases ?? []).some((lease: any) => lease.workspace === id || (row === null && lease.workspace === null)),
    leases: budget?.leases ?? [],
  };
};

if (scenario === "before") {
  const cookie = await pair();
  const terminal = await attachTerminal(cookie, { threadId: `delete-${uuid()}`, terminalId: "default", cwd: `/w/${id}` });
  await terminal.until(/[$#] $/, 120_000);
  const stamp = Date.now();
  const out = await terminal.run(
    `echo "unpushed ${stamp}" > unpushed.txt && git add unpushed.txt && git -c user.name=t3flare -c user.email=t3flare@users.noreply.github.com commit -qm "unpushed ${stamp}" && git rev-parse HEAD && git symbolic-ref --short HEAD${args.includes("--dirty") ? " && echo dirty > uncommitted.txt" : ""}`,
  );
  const lines = out.text.split("\n").map((line) => line.trim());
  report.commit = lines.find((line) => /^[0-9a-f]{40}$/.test(line)) ?? null;
  report.branch = lines[lines.findIndex((line) => /^[0-9a-f]{40}$/.test(line)) + 1] ?? null;
  // Left open: the deletion must end the terminal.
  report.terminalOpen = true;
  report.state = await state();
  await terminal.detach();
}

if (scenario === "after") {
  const branch = arg("branch");
  const started = Date.now();
  let last: Awaited<ReturnType<typeof state>> | undefined;
  while (Date.now() - started < 60_000) {
    last = await state();
    if ((last.row === null || last.row.state === "tombstoned") && last.container?.running !== true && !last.leased) break;
    await sleep(2000);
  }
  report.ms = Date.now() - started;
  report.state = last;
  const info = (await admin("POST", `/_t3flare/agents/workspace-call?id=${enc}`, { fs: { op: "stat", path: "/workspace/repo" } })).json;
  report.doFiles = info?.result ?? info;
  const doInfo = (await admin("GET", "/_t3flare/agents/workspaces")).json;
  report.registryIds = (doInfo?.workspaces ?? []).map((ws: any) => `${ws.id} ${ws.state}`);
  check("registry row gone or tombstoned", last?.row === null || last?.row?.state === "tombstoned", last?.row);
  check("Container stopped", last?.container?.running !== true, last?.container);
  check("not in the budget", last?.leased === false, last?.leases);
  if (last?.row === null) check("the DO refuses (purged)", JSON.stringify(report.doFiles).includes("deleted"), report.doFiles);
  if (branch !== undefined) {
    const project = id.split("/")[1]!;
    const carried = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(project)}`, {
      git: { argv: ["for-each-ref", "--format=%(refname) %(objectname) %(subject)", `refs/heads/${branch}`, "refs/t3flare/worktrees"], cwd: "/workspace/repo", startContainer: true },
    })).json?.result;
    report.branchInProject = String(carried?.stdout ?? "").trim().split("\n");
    check("the branch is in the project's repo", String(carried?.stdout ?? "").includes("unpushed"), carried);
  }
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
const out = arg("out");
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(0);
