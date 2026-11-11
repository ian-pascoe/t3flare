// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 2b M4: deleting a worktree thread frees its Workspace. Evidence around a deletion made in the stock web client:
//
//   bun scripts/stage.ts run <stage> delete before --worktree <id> [--dirty]  an unpushed commit (and with --dirty an
//       uncommitted file) in the worktree, from its terminal; records the Workspace's state
//   bun scripts/stage.ts run <stage> delete after --worktree <id> --branch <name> [--out f]  polls up to 60 s for: the
//       registry row gone (or tombstoned), the DO's storage empty, the Container stopped and out of the budget, the
//       branch in the project's repo
import * as fs from "node:fs";

import { admin, dispatch, mutateProject, pair, sleep, uuid, wsCall } from "./lib/client.ts";
import { attachTerminal } from "./lib/terminal.ts";

const [scenario = "after", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const id = arg("worktree") ?? "";
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

if (scenario === "sweep") {
  // The sweep on a stage with a short grace (T3FLARE_SWEEP_GRACE_MS): references hold, a tombstone and unreferenced
  // Workspaces are purged after the grace, the cost guard stops a Container no Workspace holds.
  //   --archived-thread <thread>  archived first (its worktree must survive)
  //   --tombstone <worktree id> --project <project id>  restored, then removed again with --force (tombstoned)
  //   --terminal <worktree id>     a terminal open in it through the sweeps (skipped: an open terminal)
  //   --grace-ms <ms>              how long to wait between the first and the last sweep
  //   --delete-project <project id> --readd-project <project id>  deleted (one re-added within the grace)
  const cookie = await pair();
  const graceMs = Number(arg("grace-ms") ?? 180_000);
  const steps: Record<string, unknown> = {};
  const archived = arg("archived-thread");
  if (archived !== undefined) steps.archive = await dispatch(cookie, { type: "thread.archive", commandId: uuid(), threadId: archived }).then(() => "archived", (error: unknown) => String(error).slice(0, 200));
  const tomb = arg("tombstone");
  if (tomb !== undefined) {
    steps.restore = (await admin("POST", `/_t3flare/agents/workspace-restore?id=${encodeURIComponent(tomb)}`)).json;
    steps.reRemove = await wsCall(cookie, "vcs.removeWorktree", { cwd: `/w/${tomb.split("/")[1]}`, path: `/w/${tomb}`, force: true }).then(
      () => "removed",
      (error: unknown) => String(error).slice(0, 300),
    );
    const row = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((ws) => ws.id === tomb);
    steps.tombstone = row === undefined ? null : { state: row.state, purgeAfter: row.purgeAfter, lastError: row.lastError };
  }
  // The cost guard: a Container whose lease no registered Workspace holds (a scratch Workspace DO).
  steps.orphan = (await admin("POST", "/_t3flare/agents/workspace-call?id=orphan-cost-check", { exec: { script: "echo started" } })).json?.container ?? null;
  const terminalAt = arg("terminal");
  const terminal = terminalAt === undefined ? undefined : await attachTerminal(cookie, { threadId: `sweep-${uuid()}`, terminalId: "default", cwd: `/w/${terminalAt}` });
  if (terminal !== undefined) await terminal.until(/[$#] $/, 120_000);
  const deleted = arg("delete-project");
  const readd = arg("readd-project");
  for (const projectId of [deleted, readd]) {
    if (projectId !== undefined) steps[`delete ${projectId}`] = await mutateProject(cookie, { type: "project.delete", commandId: uuid(), projectId, force: true }).then(() => "deleted", (error: unknown) => String(error).slice(0, 200));
  }
  report.steps = steps;
  report.dry = (await admin("GET", "/_t3flare/agents/sweep?dry=1")).json?.report;
  report.first = (await admin("POST", "/_t3flare/agents/sweep")).json?.report;
  if (readd !== undefined) {
    // Re-added within the grace: a new project at the same root references the Workspace again.
    const root = arg("readd-root")!;
    steps.readd = await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId: uuid(), title: "re-added", workspaceRoot: root, createWorkspaceRootIfMissing: false }).then(() => root, (error: unknown) => String(error).slice(0, 200));
  }
  await sleep(graceMs + 15_000);
  report.last = (await admin("POST", "/_t3flare/agents/sweep")).json?.report;
  if (terminal !== undefined) {
    await terminal.close();
    await terminal.detach();
  }
  report.after = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).map((ws) => `${ws.id} ${ws.state}`);
  report.budget = (await admin("GET", "/_t3flare/agents/budget")).json?.leases;
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
const out = arg("out");
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(0);
