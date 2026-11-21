// @effect-diagnostics globalDate:off
// The acceptance test's step 2b part (`scripts/acceptance.ts --terminal --worktree`): on a fresh clone of the fixture, a
// terminal echoes through t3's terminal RPCs; a worktree thread of a project with a setup script provisions and runs
// it; the worktree is removed through t3's `vcs.removeWorktree` and frees its Workspace; the sweep's dry run reads t3's
// projection columns (it fails closed if a bump renamed them).
import { admin, DEFAULT_MODEL, mutateProject, runsOf, sleep, updateSettings, uuid, wsCall, wsFirst } from "./client.ts";
import { settled, until } from "./cloudThread.ts";
import { attachTerminal } from "./terminal.ts";
import { fixtureRepo } from "./scriptSettings.ts";

/** One entry of the admin route `GET /_t3flare/agents/router-trace` (`TraceEntry`), as far as the removal reads it. */
interface RouterTraceEntry {
  readonly at: number;
  readonly cwd: string | null;
  readonly command: string;
  readonly argv: unknown;
  readonly route: string;
}


export const terminalWorktree = async (cookie: string, options: { readonly terminal: boolean; readonly worktree: boolean }) => {
  const failures: Array<string> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
    return ok;
  };
  const report: Record<string, unknown> = {};
  const id = `acc2b-${Date.now().toString(36)}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${fixtureRepo()}.git`, destinationPath: `/w/${id}` }).catch(
    (error: unknown) => ({ error: String(error).slice(0, 300) }),
  )) as { cwd?: string; error?: string };
  if (!check("clone", cloned.cwd === `/w/${id}`, cloned)) return { ok: false, failures, ...report };
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: `/w/${id}`, createWorkspaceRootIfMissing: false });

  if (options.terminal) {
    const started = Date.now();
    const terminal = await attachTerminal(cookie, { threadId: `acceptance-${uuid()}`, terminalId: "default", cwd: `/w/${id}` });
    await terminal.until(/[$#] $/, 120_000);
    const token = `t3flare-${Math.floor(Date.now() % 1e6)}`;
    const echoed = await terminal.run(`echo ${token}`);
    report.terminal = { ms: Date.now() - started, echoed: echoed.text.split("\n").includes(token) };
    check("terminal echo", echoed.text.split("\n").some((line) => line.trim() === token), echoed.text.slice(-300));
    await terminal.close();
    await terminal.detach();
  }

  if (options.worktree) {
    // The project's setup script, where t3's project settings keep it.
    await updateSettings(cookie, {
      projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [{ id: "setup", name: "Setup", command: "echo setup-ran > setup.txt", icon: "configure", runOnWorktreeCreate: true }] } },
    });
    // What the client's composer sends for a new thread in "New worktree" mode.
    const threadId = uuid();
    await wsCall(cookie, "orchestration.launchThread", {
      commandId: uuid(),
      creationSource: "web",
      threadId,
      projectId,
      title: id,
      generateTitle: false,
      modelSelection: DEFAULT_MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "main" },
      initialMessage: { messageId: uuid(), text: "Reply with the single word done.", attachments: [] },
    });
    const started = Date.now();
    let setup: any;
    while (Date.now() - started < 5 * 60_000) {
      setup = await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined);
      const stage = setup?.stages?.find((s: any) => s.id === "setup-script");
      if (stage !== undefined && ["done", "failed", "skipped"].includes(stage.status)) break;
      if (setup?.phase === "failed") break;
      await sleep(3000);
    }
    const stages = (setup?.stages ?? []).map((s: any) => `${s.id}:${s.status}`);
    report.worktree = { ms: Date.now() - started, path: setup?.worktreePath ?? null, stages, error: setup?.error ?? null };
    check("setup script done in the worktree", stages.includes("setup-script:done"), report.worktree);
    const path: string | null = setup?.worktreePath ?? null;
    if (path !== null) {
      // The thread's first turn settles before the removal. t3 restores a thread's missing worktree when a turn starts
      // (`restoreMissingWorktree`, from `ProviderTurnStartService`; also on a send and a terminal launch), and since v0.1.11-nightly.20261117.4851 that restore succeeds here. A removal that
      // beats the pending turn is undone: t3 re-adds the worktree, our router restores its tombstone (review F5), and
      // the restored worktree takes a lease. That is the nightly's `leased: true`, and it is no leak.
      const turn = await until(cookie, threadId, settled, 4 * 60_000);
      report.turnBeforeRemoval = runsOf(turn).map((run) => run.status);
      check("the worktree thread's turn settled before the removal (else t3 may undo the removal below)", settled(turn), report.turnBeforeRemoval);
      const workspaceId = path.replace(/^\/w\//, "");
      const removeStarted = Date.now();
      const removed = await wsCall(cookie, "vcs.removeWorktree", { cwd: `/w/${id}`, path, force: true }).then(
        () => "removed",
        (error: unknown) => String(error).slice(0, 300),
      );
      const removeEnded = Date.now();
      const registry = ((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<{ id: string; state: string }>;
      const leases = ((await admin("GET", "/_t3flare/agents/budget")).json?.leases ?? []) as Array<{ workspace: string | null; until?: number }>;
      const row = registry.find((ws) => ws.id === workspaceId);
      const lease = leases.find((held) => held.workspace === workspaceId);
      // A lease still held after the removal: its expiry (the last acquire or renewal plus the budget's lease length,
      // on the DO's clock) against the removal's window, and what the router ran in the worktree meanwhile, tell a
      // release that never ran from a later restart. Sessions' own starts are not in the router trace.
      // In the worktree, or naming it from the project (a `git worktree add` that restores it).
      const touchesWorktree = (entry: RouterTraceEntry) => (entry.cwd !== null && entry.cwd.startsWith(path)) || JSON.stringify(entry.argv).includes(path);
      const trace = (((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<RouterTraceEntry>)
        .filter((entry) => touchesWorktree(entry) && entry.at >= removeStarted - 30_000)
        .map((entry) => ({ msFromRemoval: entry.at - removeStarted, command: entry.command, argv: entry.argv, route: entry.route }));
      report.removal = {
        removed,
        inRegistry: row !== undefined,
        leased: lease !== undefined,
        removeMs: removeEnded - removeStarted,
        row: row ?? null,
        leaseUntilFromRemovalMs: lease?.until === undefined ? null : lease.until - removeStarted,
        trace,
      };
      // setup.txt is untracked: a forced removal of a dirty worktree is a tombstone, gone from t3 and the budget.
      check("worktree removed and out of the budget", removed === "removed" && lease === undefined, report.removal);
    }
  }

  const sweep = (await admin("GET", "/_t3flare/agents/sweep?dry=1")).json?.report;
  report.sweepDry = { ok: sweep?.ok, error: sweep?.error ?? null, actions: sweep?.actions?.length ?? null };
  check("the sweep reads t3's tables", sweep?.ok === true, sweep?.error);
  // The clone goes with its tombstone (purged: not referenced once the project is gone).
  await mutateProject(cookie, { type: "project.delete", commandId: uuid(), projectId, force: true }).catch(() => undefined);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${id}`);
  return { ok: failures.length === 0, failures, ...report };
};
