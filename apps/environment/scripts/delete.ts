// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off
// Step 2b M4: deleting a worktree thread frees its Workspace. Evidence around a deletion made in the stock web client:
//
//   node scripts/stage.ts run <stage> delete before --worktree <id> [--dirty]  an unpushed commit (and with --dirty an
//       uncommitted file) in the worktree, from its terminal; records the Workspace's state
//   node scripts/stage.ts run <stage> delete after --worktree <id> --branch <name> [--out name]  polls up to 60 s for: the
//       registry row gone (or tombstoned), the DO's storage empty, the Container stopped and out of the budget, the
//       branch in the project's repo
//
// The Workspace deletion Proof (ADR-0043, ADR-0044), in six steps on a Stage deployed with T3FLARE_SWEEP_GRACE_MS (a
// Grace of minutes). Each step reads the Settings page's own routes (`/_t3flare/settings/api/workspaces…`, `…/audit`,
// `…/environment`), never the admin sweep route:
//
//   delete wake        steps 1-2: a project with one worktree thread deleted in t3; both unreferenced within a minute
//                      with a purge date a Grace on, then gone after it by the Sweep's own alarm (two `sweep.purge`)
//   delete purge-now   step 3: Purge now refused on a live project, naming it; on the deleted one, with the name typed,
//                      it and its worktree purged at once
//   delete restore     step 4 (ADR-0044's Consequences): a worktree tombstoned, restored, then taken by a new thread (existing_worktree)
//   delete tool        step 5: a Durable thread in full access calls purge_workspace; the card approved; audit `card`
//   delete never       step 6: "Never purge" marks and purges nothing; on again, nothing purged for one Grace
//   delete mark-alarm  ADR-0043 §5: a Sweep that only marks sets the alarm to the purge date
//   delete sweep-fixture  makes the `sweep` scenario's arguments on the Stage and prints them (`args`)
//   [--out name]       the report's file name in .evidence/workspace-deletion/ (default: the scenario's)
import * as fs from "node:fs";
import { join, resolve } from "node:path";

import { admin, base, dispatch, enablePiDurable, mutateProject, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall, wsFirst } from "./lib/client.ts";
import { settled, until } from "./lib/cloudThread.ts";
import { fixtureRepo } from "./lib/scriptSettings.ts";
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

// ---------------------------------------------------------------------------------------------------------------------
// The Workspace deletion Proof on a Stage (ADR-0043, ADR-0044)

/** The Settings page's API, as the Stage's service token with the admin token. */
const panel = (method: string, sub: string, body?: unknown) => admin(method, `/_t3flare/settings/api${sub}`, body);
const view = async (): Promise<any> => (await panel("GET", "/workspaces")).json;
/** Every row of the view, a project's worktrees included. */
const rowsOf = (seen: any): Array<any> => ((seen?.rows ?? []) as Array<any>).flatMap((row) => [row, ...(row.worktrees ?? [])]);
const rowIn = (seen: any, ws: string) => rowsOf(seen).find((row) => row.id === ws);
const brief = (row: any) =>
  row === undefined
    ? null
    : { id: row.id, status: row.status, references: row.references, unreferencedSince: iso(row.unreferencedSince), deletedAt: iso(row.deletedAt), purgeDue: iso(row.purgeDue), planned: row.planned, sessions: row.sessions };
const iso = (at: number | null | undefined) => (typeof at === "number" ? new Date(at).toISOString() : null);
const auditLog = async (): Promise<Array<any>> => (await panel("GET", "/audit")).json?.entries ?? [];
const stamp = () => Date.now().toString(36);
/** The Settings page's HTML, whole. */
const pageHtml = async () => {
  const response = await fetch(new URL("/_t3flare/settings", base), {
    headers: {
      "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "",
      "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "",
      authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`,
      accept: "text/html",
    },
  });
  return { status: response.status, text: await response.text() };
};
const grace = async () => {
  const seen = await view();
  return { purging: seen?.purging, graceMs: seen?.graceMs, overridden: seen?.overridden, purgingSince: iso(seen?.purgingSince) };
};

/** Polls the view (the page's route, no Sweep) until `done` holds or `timeoutMs` passes; the last view and when. */
const watch = async (done: (seen: any) => boolean, timeoutMs: number, everyMs = 3000) => {
  const started = Date.now();
  let seen: any;
  while (Date.now() - started < timeoutMs) {
    seen = await view().catch(() => seen);
    if (seen !== undefined && done(seen)) return { seen, ms: Date.now() - started, held: true };
    await sleep(everyMs);
  }
  return { seen, ms: Date.now() - started, held: false };
};

/** A fresh clone of the fixture as a t3 project. */
const projectAt = async (cookie: string, tag: string) => {
  const ws = `purge-${tag}-${stamp()}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${fixtureRepo()}.git`, destinationPath: `/w/${ws}` }).catch((error: unknown) => ({
    error: String(error).slice(0, 300),
  }))) as { cwd?: string; error?: string };
  if (cloned.cwd !== `/w/${ws}`) throw new Error(`clone ${ws}: ${JSON.stringify(cloned)}`);
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: ws, workspaceRoot: `/w/${ws}`, createWorkspaceRootIfMissing: false });
  return { ws, projectId, title: ws };
};

/**
 * A thread launched as the client's composer launches one (`orchestration.launchThread`), on a new worktree or on an
 * existing one; its worktree's path once t3 has prepared it, and its first turn settled (a removal or deletion that beats
 * a pending turn is undone by t3's restore: lib/terminalWorktree.ts).
 */
const launch = async (cookie: string, projectId: string, title: string, strategy: Record<string, unknown>) => {
  const threadId = uuid();
  await wsCall(cookie, "orchestration.launchThread", {
    commandId: uuid(),
    creationSource: "web",
    threadId,
    projectId,
    title,
    generateTitle: false,
    modelSelection: { instanceId: "piDurable", model: durableModel, options: [{ id: "thinking", value: "low" }] },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: strategy,
    initialMessage: { messageId: uuid(), text: "Reply with the single word done.", attachments: [] },
  });
  const started = Date.now();
  let setup: any;
  // An existing worktree has no setup to wait for (t3 may keep no setup state for it).
  while (strategy.type === "worktree" && Date.now() - started < 5 * 60_000) {
    setup = await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined);
    // null until t3 has a setup state for the thread.
    if (setup != null && setup.phase !== "running") break;
    await sleep(3000);
  }
  const turn = await until(cookie, threadId, settled, 4 * 60_000);
  if (strategy.type !== "worktree") setup = await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined);
  const path: string | null = setup?.worktreePath ?? (typeof strategy.worktreePath === "string" ? strategy.worktreePath : null);
  return {
    threadId,
    title,
    path,
    worktree: path?.replace(/^\/w\//, "") ?? null,
    setup: { phase: setup?.phase ?? null, stages: (setup?.stages ?? []).map((s: any) => `${s.id}:${s.status}`), error: setup?.error ?? null },
    runs: runsOf(turn).map((run) => run.status),
  };
};

/** The Durable agent's model: T3FLARE_TOOLS_MODEL, else the Stage's first Model endpoint's small (haiku) model. */
let durableModel = process.env.T3FLARE_TOOLS_MODEL ?? "";
const pickModel = async () => {
  if (durableModel !== "") return;
  const endpoints = ((await panel("GET", "/endpoints")).json?.endpoints ?? []) as Array<{ id: string; models?: Array<{ id: string }> }>;
  const endpoint = endpoints.find((entry) => (entry.models?.length ?? 0) > 0);
  const model = endpoint?.models?.find((entry) => /haiku/.test(entry.id)) ?? endpoint?.models?.[0];
  durableModel = endpoint === undefined || model === undefined ? "anthropic/claude-haiku-5-5" : `${endpoint.id}/${model.id}`;
};

/** A worktree setup script on the project, so its first thread's worktree is dirty (a forced removal tombstones it). */
const withSetupScript = (cookie: string, projectId: string) =>
  wsCall(cookie, "server.updateSettings", {
    patch: { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [{ id: "setup", name: "Setup", command: "echo setup-ran > setup.txt", icon: "configure", runOnWorktreeCreate: true }] } } },
  });

/** A project with one worktree thread (steps 1, 3, 5), its first turn settled. */
const projectWithWorktree = async (cookie: string, tag: string) => {
  const project = await projectAt(cookie, tag);
  const thread = await launch(cookie, project.projectId, `${project.ws} wt`, { type: "worktree", baseRef: "main" });
  if (thread.worktree === null) throw new Error(`no worktree for ${project.ws}: ${JSON.stringify(thread.setup)}`);
  return { ...project, thread, worktree: thread.worktree };
};

const deleteProject = (cookie: string, projectId: string) =>
  mutateProject(cookie, { type: "project.delete", commandId: uuid(), projectId, force: true }).then(
    () => "deleted",
    (error: unknown) => String(error).slice(0, 300),
  );

if (scenario === "sweep-fixture") {
  // The `sweep` scenario's arguments, made on the Stage: an archived-to-be worktree thread, a Tombstone (a dirty
  // worktree's forced removal) of a live project, and a project to delete.
  const cookie = await pair();
  await enablePiDurable(cookie);
  await pickModel();
  const kept = await projectWithWorktree(cookie, "keep");
  const tombProject = await projectAt(cookie, "tomb");
  await withSetupScript(cookie, tombProject.projectId);
  const tombThread = await launch(cookie, tombProject.projectId, `${tombProject.ws} wt`, { type: "worktree", baseRef: "main" });
  await wsCall(cookie, "vcs.removeWorktree", { cwd: `/w/${tombProject.ws}`, path: tombThread.path, force: true });
  const gone = await projectAt(cookie, "gone");
  report.args = ["--archived-thread", kept.thread.threadId, "--tombstone", tombThread.worktree, "--project", tombProject.ws, "--delete-project", gone.projectId];
  report.keep = { ws: kept.ws, worktree: kept.worktree, tombstoneProject: tombProject.ws, deleted: gone.ws };
}

if (scenario === "mark-alarm") {
  // ADR-0043 §5: a project with no thread, deleted: one event, one woken Sweep, which marks it. The Environment DO's alarm
  // must then be its purge date (a Grace on), not a day ahead.
  const cookie = await pair();
  const project = await projectAt(cookie, "alarm");
  report.delete = await deleteProject(cookie, project.projectId);
  const marked = await watch((seen) => typeof rowIn(seen, project.ws)?.purgeDue === "number", 60_000, 2000);
  await sleep(3000);
  const alarm = Date.parse(String((await admin("GET", "/_t3flare/health")).json?.alarm));
  const due = rowIn(marked.seen, project.ws)?.purgeDue as number;
  report.row = brief(rowIn(marked.seen, project.ws));
  report.alarm = iso(alarm);
  check("the alarm is the marked row's purge date", Math.abs(alarm - due) < 5000, { alarm: iso(alarm), due: iso(due) });
}

if (["wake", "purge-now", "restore", "tool", "never"].includes(scenario)) {
  const cookie = await pair();
  await enablePiDurable(cookie);
  await pickModel();
  report.grace = await grace();
  const graceMs = Number((report.grace as any).graceMs);

  if (scenario === "wake") {
    // Steps 1-2: the deletion wakes the Sweep; the Sweep's own alarm purges after the Grace.
    const p = await projectWithWorktree(cookie, "wake");
    report.project = { ws: p.ws, worktree: p.worktree, thread: { runs: p.thread.runs, setup: p.thread.setup } };
    const before = await view();
    report.before = { project: brief(rowIn(before, p.ws)), worktree: brief(rowIn(before, p.worktree)) };
    const deletedAt = Date.now();
    report.deletedAt = iso(deletedAt);
    report.delete = await deleteProject(cookie, p.projectId);
    const ids = [p.ws, p.worktree];
    const marked = await watch((seen) => ids.every((ws) => rowIn(seen, ws)?.status === "unreferenced" && typeof rowIn(seen, ws)?.purgeDue === "number"), 60_000, 2000);
    report.step1 = {
      msAfterDelete: marked.ms,
      held: marked.held,
      purgingSince: iso(marked.seen?.purgingSince),
      rows: ids.map((ws) => brief(rowIn(marked.seen, ws))),
      dueAfterDeleteMs: ids.map((ws) => (rowIn(marked.seen, ws)?.purgeDue ?? 0) - deletedAt),
    };
    check("step 1: both unreferenced with a purge date within a minute, no admin call", marked.held, report.step1);
    for (const ws of ids) {
      const due = rowIn(marked.seen, ws)?.purgeDue ?? 0;
      check(`step 1: ${ws}'s purge date is about a Grace after the deletion`, Math.abs(due - deletedAt - graceMs) < 60_000, { due: iso(due), deletedAt: iso(deletedAt), graceMs });
    }
    // The page's HTML renders the section with both rows.
    const page = await pageHtml();
    report.page = { status: page.status, section: /Workspaces/.test(page.text), rows: ids.map((ws) => page.text.includes(ws)), unreferenced: /unreferenced/.test(page.text) };
    // Step 2: no call at all until a minute and a half past the later date, then the view and the audit log.
    const due = Math.max(...ids.map((ws) => rowIn(marked.seen, ws)?.purgeDue ?? 0));
    const quietUntil = due + 90_000;
    report.quietUntil = iso(quietUntil);
    await sleep(Math.max(0, quietUntil - Date.now()));
    const after = await watch((seen) => ids.every((ws) => rowIn(seen, ws) === undefined), 3 * 60_000, 10_000);
    const entries = (await auditLog()).filter((entry) => entry.action === "sweep.purge" && ids.includes(entry.target));
    report.step2 = {
      goneAt: iso(Date.now()),
      msPastQuiet: after.ms,
      rows: ids.map((ws) => brief(rowIn(after.seen, ws))),
      audit: entries.map((entry) => ({ at: iso(entry.at), caller: entry.caller, action: entry.action, target: entry.target, after: entry.after })),
    };
    check("step 2: both gone after the date, no sweep route called", after.held, report.step2);
    check("step 2: two sweep.purge entries", entries.length === 2 && entries.every((entry) => entry.caller === "sweep" && entry.at >= due), entries);
  }

  if (scenario === "purge-now") {
    // Step 3: Purge now, the Owner's act on the page's route.
    const q = await projectWithWorktree(cookie, "now");
    report.project = { ws: q.ws, worktree: q.worktree, thread: { runs: q.thread.runs, setup: q.thread.setup } };
    const live = await panel("POST", "/workspaces/purge", { id: q.ws, confirm: q.ws });
    report.live = live;
    check("step 3: a live project's Purge refused (409), naming the project", live.status === 409 && JSON.stringify(live.json).includes(q.title), live);
    const liveView = await view();
    check("step 3: the live project and worktree are still there", rowIn(liveView, q.ws)?.status === "in use" && rowIn(liveView, q.worktree) !== undefined, [brief(rowIn(liveView, q.ws)), brief(rowIn(liveView, q.worktree))]);
    report.delete = await deleteProject(cookie, q.projectId);
    await watch((seen) => rowIn(seen, q.ws)?.status === "unreferenced" && rowIn(seen, q.worktree)?.status === "unreferenced", 60_000, 2000);
    const wrong = await panel("POST", "/workspaces/purge", { id: q.ws, confirm: "not-its-name" });
    report.wrongName = wrong;
    check("step 3: a wrong name refused (400)", wrong.status === 400, wrong);
    const started = Date.now();
    const purged = await panel("POST", "/workspaces/purge", { id: q.ws, confirm: q.ws });
    report.purged = { status: purged.status, ms: Date.now() - started, ids: purged.json?.ids, sessions: purged.json?.sessions, error: purged.json?.error ?? null };
    const afterView = await view();
    report.after = [brief(rowIn(afterView, q.ws)), brief(rowIn(afterView, q.worktree))];
    check("step 3: with the name typed, it and its worktree purged at once (worktree first)", purged.status === 200 && JSON.stringify(purged.json?.ids) === JSON.stringify([q.worktree, q.ws]), report.purged);
    check("step 3: both gone from the view", rowIn(afterView, q.ws) === undefined && rowIn(afterView, q.worktree) === undefined, report.after);
    const entry = (await auditLog()).find((e) => e.action === "workspace.purge" && e.target === q.ws);
    report.audit = entry === undefined ? null : { caller: entry.caller, action: entry.action, target: entry.target, after: entry.after };
    check("step 3: one workspace.purge audit entry", entry !== undefined, report.audit);
  }

  if (scenario === "restore") {
    // Step 4 (ADR-0044's Consequences): a dirty worktree's forced removal is a Tombstone; restored, a new thread takes it.
    const r = await projectAt(cookie, "restore");
    await withSetupScript(cookie, r.projectId);
    const first = await launch(cookie, r.projectId, `${r.ws} first`, { type: "worktree", baseRef: "main" });
    report.first = first;
    if (first.worktree === null || first.path === null) throw new Error(`no worktree: ${JSON.stringify(first.setup)}`);
    const wt = first.worktree;
    const path = first.path;
    // The control: what t3's branch selector lists for the live worktree, before any removal.
    const refsOf = async () =>
      (((await wsCall(cookie, "vcs.listRefs", { cwd: `/w/${r.ws}`, limit: 200, refresh: true }).catch((error: unknown) => ({ error: String(error) }))) as any)?.refs ?? []) as Array<any>;
    /** The process router's last `git worktree list` in the project: how many worktree Workspaces it answered. */
    const lastList = async () =>
      (((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<any>)
        .filter((entry) => entry.cwd === `/w/${r.ws}` && JSON.stringify(entry.argv).includes('"list"'))
        .map((entry) => ({ argv: entry.argv, route: entry.route, detail: entry.detail }))
        .at(-1) ?? null;
    const firstShell = (await wsFirst(cookie, "orchestration.subscribeShell", {})) as any;
    const firstThread = ((firstShell?.snapshot ?? firstShell)?.threads ?? []).find((t: any) => (t.id ?? t.threadId) === first.threadId);
    report.firstBranch = firstThread?.branch ?? null;
    const liveRefs = await refsOf();
    report.listedLive = { listed: liveRefs.some((ref) => ref.worktreePath === path), refs: liveRefs.map((ref) => `${ref.name} ${ref.worktreePath}`), worktreeList: await lastList() };
    // setup.txt is untracked: the forced removal keeps it as a Tombstone.
    report.removed = await wsCall(cookie, "vcs.removeWorktree", { cwd: `/w/${r.ws}`, path, force: true }).then(
      () => "removed",
      (error: unknown) => String(error).slice(0, 300),
    );
    report.deleteFirst = await dispatch(cookie, { type: "thread.delete", commandId: uuid(), threadId: first.threadId }).then(
      () => "deleted",
      (error: unknown) => String(error).slice(0, 300),
    );
    const tomb = await watch((seen) => rowIn(seen, wt)?.status === "tombstone", 60_000, 2000);
    report.tombstone = brief(rowIn(tomb.seen, wt));
    check("step 4: the removed dirty worktree is a Tombstone with a date", tomb.held && typeof rowIn(tomb.seen, wt)?.purgeDue === "number", report.tombstone);
    const restored = await panel("POST", "/workspaces/restore", { id: wt });
    report.restored = { status: restored.status, state: restored.json?.restored?.state, error: restored.json?.error ?? null };
    const back = await view();
    report.afterRestore = brief(rowIn(back, wt));
    check("step 4: restored to ready (unreferenced)", restored.status === 200 && rowIn(back, wt)?.status === "unreferenced", report.afterRestore);
    // What t3's branch selector lists: the branch with the restored worktree's path.
    const refs = await refsOf();
    const listed = refs.find((ref) => ref.worktreePath === path);
    report.listed = { listed: listed ?? null, refs: refs.map((ref) => `${ref.name} ${ref.worktreePath}`), worktreeList: await lastList() };
    // Restore must list it as the live worktree was listed (the control); a gap the live one shares is not restore's.
    check("step 4: t3's refs list the restored worktree as they listed it live", (listed !== undefined) === (report.listedLive as any).listed, report.listed);
    const second = await launch(cookie, r.projectId, `${r.ws} second`, { type: "existing_worktree", worktreePath: path, ...(listed?.name === undefined ? {} : { branch: listed.name }) });
    report.second = second;
    const shell = (await wsFirst(cookie, "orchestration.subscribeShell", {})) as any;
    const thread = ((shell?.snapshot ?? shell)?.threads ?? []).find((t: any) => (t.id ?? t.threadId) === second.threadId);
    report.secondThread = thread === undefined ? null : { worktreePath: thread.worktreePath ?? null, branch: thread.branch ?? null };
    const taken = await view();
    report.afterTake = brief(rowIn(taken, wt));
    const files = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(wt)}`, { git: { argv: ["status", "--porcelain"], cwd: "/workspace/repo", startContainer: true } })).json?.result;
    report.files = String(files?.stdout ?? files?.detail ?? "").trim();
    check("step 4: the new thread is on the restored worktree", thread?.worktreePath === path, report.secondThread);
    check("step 4: the restored Workspace is in use by the new thread", rowIn(taken, wt)?.status === "in use" && JSON.stringify(rowIn(taken, wt)?.references).includes(second.title), report.afterTake);
    check("step 4: its files came back (setup.txt untracked)", /setup\.txt/.test(String(report.files)), report.files);
    report.cleanup = await deleteProject(cookie, r.projectId);
  }

  if (scenario === "tool") {
    // Step 5: an own agent's purge_workspace, always asked; approved on its card.
    const s = await projectWithWorktree(cookie, "tool");
    report.project = { ws: s.ws, worktree: s.worktree };
    report.delete = await deleteProject(cookie, s.projectId);
    await watch((seen) => rowIn(seen, s.ws)?.status === "unreferenced", 60_000, 2000);
    // The asking thread lives in a project of its own.
    const home = await projectAt(cookie, "agent");
    const threadId = uuid();
    await dispatch(cookie, {
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId: home.projectId,
      title: `${home.ws} purge`,
      modelSelection: { instanceId: "piDurable", model: durableModel, options: [{ id: "thinking", value: "low" }] },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const code = `const r = await tools.mcp__settings__purge_workspace(${JSON.stringify({ workspace: s.ws })}).catch((e) => ({ threw: String(e && e.message || e) }));\ntext(JSON.stringify(r).slice(0, 4000));`;
    await sendMessage(cookie, threadId, `Call the codemode tool exactly once, with exactly this code (verbatim, change nothing), then reply with the script's output and nothing else:\n\n\`\`\`js\n${code}\n\`\`\``, {
      instanceId: "piDurable",
      model: durableModel,
      options: [{ id: "thinking", value: "low" }],
    } as never);
    const cards: Array<any> = [];
    const started = Date.now();
    let projection: any;
    while (Date.now() - started < 8 * 60_000) {
      projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined)) ?? projection;
      for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !cards.some((c) => c.id === r.id))) {
        const item = (projection?.turnItems ?? []).find((candidate: any) => candidate.requestId === request.id);
        // The card while it waits: the view must still show the Workspace (nothing purged before the answer).
        const waiting = rowIn(await view(), s.ws);
        cards.push({ id: request.id, kind: request.kind, prompt: String(item?.prompt ?? item?.detail ?? "").slice(0, 1500), options: (item?.options ?? []).map((o: any) => `${o.decision}:${o.label}`), whileWaiting: brief(waiting) });
        await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" });
      }
      if (settled(projection) && cards.length > 0) break;
      if (settled(projection) && Date.now() - started > 60_000) break;
      await sleep(1500);
    }
    const session = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(threadId)}`)).json;
    const outputs = ((session?.entries ?? []) as Array<any>).filter((entry) => entry.role === "toolResult" && entry.toolName === "codemode").map((entry) => (entry.content ?? []).map((block: any) => block.text ?? "").join(""));
    report.turn = { runs: runsOf(projection).map((run) => run.status), cards, output: (outputs.at(-1) ?? "").slice(0, 2000) };
    const afterView = await view();
    report.after = [brief(rowIn(afterView, s.ws)), brief(rowIn(afterView, s.worktree))];
    const entry = (await auditLog()).find((e) => e.action === "workspace.purge" && e.target === s.ws);
    report.audit = entry === undefined ? null : { caller: entry.caller, via: entry.via, tier: entry.tier, mode: entry.mode, answeredBy: entry.answeredBy, change: entry.change, after: entry.after };
    check("step 5: one Owner-only card, nothing purged while it waited", cards.length === 1 && cards[0].whileWaiting?.status === "unreferenced", cards);
    check("step 5: approved, the Workspace and its worktree purged", rowIn(afterView, s.ws) === undefined && rowIn(afterView, s.worktree) === undefined, report.after);
    check("step 5: the audit entry says card", entry?.mode === "card" && entry?.answeredBy === "card" && entry?.via === "mcp", report.audit);
    report.cleanup = await deleteProject(cookie, home.projectId);
  }

  if (scenario === "never") {
    // Step 6: "Never purge" marks and purges nothing; on again, nothing is purged for one Grace (purgingSince, ADR-0043 §4).
    const off = await panel("POST", "/environment", { settings: { sweepPurges: false } });
    report.off = { status: off.status, error: off.json?.error ?? null };
    report.graceOff = await grace();
    check("step 6: purging off, purgingSince forgotten at once", off.status === 200 && (report.graceOff as any).purging === false && (report.graceOff as any).purgingSince === null, report.graceOff);
    const u = await projectAt(cookie, "never");
    report.project = { ws: u.ws };
    const deletedAt = Date.now();
    report.delete = await deleteProject(cookie, u.projectId);
    const marked = await watch((seen) => typeof rowIn(seen, u.ws)?.unreferencedSince === "number", 60_000, 2000);
    report.marked = { ms: marked.ms, row: brief(rowIn(marked.seen, u.ws)) };
    check("step 6: the Sweep marks with purging off (no purge date)", marked.held && rowIn(marked.seen, u.ws)?.purgeDue === null, report.marked);
    const preview = await panel("GET", "/workspaces/sweep");
    report.preview = { summary: preview.json?.summary, row: (preview.json?.rows ?? []).find((row: any) => row.id === u.ws) ?? null };
    // A Grace and a minute: nothing purged.
    await sleep(Math.max(0, deletedAt + graceMs + 60_000 - Date.now()));
    const kept = await view();
    report.keptOff = brief(rowIn(kept, u.ws));
    check("step 6: a Grace on, purging off: still there", rowIn(kept, u.ws)?.status === "unreferenced", report.keptOff);
    const onAt = Date.now();
    const on = await panel("POST", "/environment", { settings: { sweepPurges: true } });
    report.on = { at: iso(onAt), status: on.status, error: on.json?.error ?? null };
    const since = await watch((seen) => typeof seen?.purgingSince === "number", 60_000, 2000);
    const purgingSince = since.seen?.purgingSince as number;
    report.purgingSince = { at: iso(purgingSince), msAfterOn: purgingSince - onAt, row: brief(rowIn(since.seen, u.ws)) };
    check("step 6: turned on, the woken Sweep starts purgingSince", since.held && purgingSince >= onAt, report.purgingSince);
    check("step 6: its purge date is a Grace after purgingSince, not its old mark", Math.abs((rowIn(since.seen, u.ws)?.purgeDue ?? 0) - purgingSince - graceMs) < 5000, report.purgingSince);
    await sleep(Math.max(0, purgingSince + graceMs - 20_000 - Date.now()));
    const held = await view();
    report.heldOn = { at: iso(Date.now()), row: brief(rowIn(held, u.ws)) };
    check("step 6: nothing purged for one Grace after turning it on", rowIn(held, u.ws) !== undefined, report.heldOn);
    const gone = await watch((seen) => rowIn(seen, u.ws) === undefined, purgingSince + graceMs + 3 * 60_000 - Date.now(), 10_000);
    const entry = (await auditLog()).find((e) => e.action === "sweep.purge" && e.target === u.ws);
    report.after = { held: gone.held, at: iso(Date.now()), audit: entry === undefined ? null : { at: iso(entry.at), caller: entry.caller, after: entry.after } };
    check("step 6: purged after that Grace, by the Sweep", gone.held && entry !== undefined && entry.at >= purgingSince + graceMs, report.after);
  }
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
const evidenceDir = resolve(import.meta.dirname, "../../../.evidence/workspace-deletion");
const evidenceName = `${arg("out") ?? scenario}.json`;
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(join(evidenceDir, evidenceName), `${text}\n`);
console.log(text);
console.log(`wrote .evidence/workspace-deletion/${evidenceName}`);
process.exit(0);
