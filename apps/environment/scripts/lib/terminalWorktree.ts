// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off
// The acceptance test's step 2b part (`scripts/acceptance.ts --terminal --worktree`): on a fresh clone of the fixture, a
// terminal echoes through t3's terminal RPCs; a worktree thread of a project with a setup script provisions and runs
// it; the worktree is removed through t3's `vcs.removeWorktree` and frees its Workspace; the sweep's dry run reads t3's
// projection columns (it fails closed if a bump renamed them).
import { admin, DEFAULT_MODEL, mutateProject, sleep, updateSettings, uuid, wsCall, wsFirst } from "./client.ts";
import { attachTerminal } from "./terminal.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";

export const terminalWorktree = async (cookie: string, options: { readonly terminal: boolean; readonly worktree: boolean }) => {
  const failures: Array<string> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
    return ok;
  };
  const report: Record<string, unknown> = {};
  const id = `acc2b-${Date.now().toString(36)}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: `/w/${id}` }).catch(
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
      const removed = await wsCall(cookie, "vcs.removeWorktree", { cwd: `/w/${id}`, path, force: true }).then(
        () => "removed",
        (error: unknown) => String(error).slice(0, 300),
      );
      const workspaces = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<{ id: string; state: string }>).map((ws) => ws.id);
      const leases = (((await admin("GET", "/_t3flare/agents/budget")).json?.leases ?? []) as Array<{ workspace: string | null }>).map((lease) => lease.workspace);
      const wid = path.replace(/^\/w\//, "");
      report.removal = { removed, inRegistry: workspaces.includes(wid), leased: leases.includes(wid) };
      // setup.txt is untracked: a forced removal of a dirty worktree is a tombstone, gone from t3 and the budget.
      check("worktree removed and out of the budget", removed === "removed" && !leases.includes(wid), report.removal);
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
