// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 2b's worktree Workspace evidence against a stage, through t3's own RPCs (a headless stock-protocol client):
//
//   bun scripts/stage.ts run <stage> worktree local-commit --workspace <project id>   a branch with a local-only commit
//   bun scripts/stage.ts run <stage> worktree no-remote                              a New project with no remote
//   bun scripts/stage.ts run <stage> worktree two --workspace <project id>           two worktrees at once, each in its Container
//   bun scripts/stage.ts run <stage> worktree wrong-location --workspace <project id>  Settings → Worktrees → Location elsewhere
//   bun scripts/stage.ts run <stage> worktree stale --worktree <worktree id>         status reads after the idle stop
//   bun scripts/stage.ts run <stage> worktree trace                                  every worktree / --git-common-dir argv t3 sent
// Each takes --out <file>.
import * as fs from "node:fs";

import { admin, mutateProject, pair, runsOf, sendMessage, SETTLED, updateSettings, uuid, waitFor, wsCall } from "./lib/client.ts";
import { attachTerminal } from "./lib/terminal.ts";

const [scenario = "trace", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const report: Record<string, unknown> = { scenario, at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return ok;
};
const cookie = await pair();
const gitIn = async (id: string, argv: Array<string>) =>
  (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, { git: { argv, cwd: "/workspace/repo", startContainer: true } })).json?.result as {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
const traceDetail = async (path: string) => {
  const trace = (await admin("GET", "/_t3flare/agents/router-trace")).json?.entries as Array<{ argv: Array<string>; detail?: string; ms: number; exitCode: number }>;
  return trace.filter((entry) => entry.argv.includes("add") && entry.argv.includes(path)).at(-1);
};

/** t3's own worktree creation (`vcs.createWorktree`, what thread launch calls): the path, the time, the router's step timings. */
const createWorktree = async (cwd: string, refName: string, newRefName?: string) => {
  const started = Date.now();
  const result = (await wsCall(cookie, "vcs.createWorktree", { cwd, refName, ...(newRefName === undefined ? {} : { newRefName }), path: null }).catch((error: unknown) => ({
    error: `${String(error)} ${JSON.stringify(error)}`.slice(0, 1500),
  }))) as { worktree?: { path: string; refName: string }; error?: string };
  const path = result.worktree?.path ?? null;
  return { path, refName: result.worktree?.refName ?? null, ms: Date.now() - started, error: result.error ?? null, router: path === null ? null : (await traceDetail(path))?.detail ?? null };
};
/** Stops every Workspace's Container but `keep`'s: room in the Container budget for a scenario. */
const stopAllBut = async (keep: string | null) => {
  for (const ws of ((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<{ id: string }>) {
    if (ws.id !== keep) await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(ws.id)}`);
  }
};
const idOf = (path: string) => path.replace(/^\/w\//, "");

const terminalRun = async (cwd: string, commands: Array<string>) => {
  const terminal = await attachTerminal(cookie, { threadId: `worktree-${uuid()}`, terminalId: "default", cwd });
  await terminal.until(/[$#] $/, 120_000);
  const outputs: Array<string> = [];
  for (const command of commands) outputs.push((await terminal.run(command, 120_000)).text);
  await terminal.close();
  await terminal.detach();
  return outputs;
};

if (scenario === "local-commit") {
  const project = arg("workspace")!;
  const branch = `t3flare-local-${Date.now()}`;
  const message = `local only ${Date.now()}`;
  await terminalRun(`/w/${project}`, [`git switch -q -c ${branch} && echo local > local-only.txt && git add local-only.txt && git commit -qm "${message}" && git switch -q main`]);
  const created = await createWorktree(`/w/${project}`, branch);
  report.created = created;
  check("created", created.path !== null, created);
  if (created.path !== null) {
    const log = await gitIn(idOf(created.path), ["log", "--format=%s", "-2"]);
    report.log = log.stdout.trim().split("\n");
    check("the local commit is in the worktree", log.stdout.includes(message), log);
    check("bundled", /"bundled":true/.test(String(created.router)), created.router);
    report.branch = (await gitIn(idOf(created.path), ["symbolic-ref", "HEAD"])).stdout.trim();
  }
}

if (scenario === "no-remote") {
  const id = `noremote-${Date.now().toString(36)}`;
  await stopAllBut(null);
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId: uuid(), title: id, workspaceRoot: `/w/${id}`, createWorkspaceRootIfMissing: true });
  // As the client's "Initialize Git" does, so t3 knows the folder is a repo; then a first commit in the terminal.
  report.init = await wsCall(cookie, "vcs.init", { cwd: `/w/${id}` }).catch((error: unknown) => String(error).slice(0, 300));
  await terminalRun(`/w/${id}`, ["git switch -q -c main 2>/dev/null; echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -qm first && git log --oneline"]);
  const created = await createWorktree(`/w/${id}`, "main", `t3flare-noremote-${Date.now()}`);
  report.project = id;
  report.created = created;
  check("created", created.path !== null, created);
  if (created.path !== null) {
    report.log = (await gitIn(idOf(created.path), ["log", "--format=%s"])).stdout.trim();
    report.remotes = (await gitIn(idOf(created.path), ["remote"])).stdout.trim();
    check("history", report.log === "first", report.log);
    check("no remote", report.remotes === "", report.remotes);
  }
}

if (scenario === "two") {
  const project = arg("workspace")!;
  // Room in the budget (3): the project and the two new worktrees.
  await stopAllBut(project);
  const stamp = Date.now();
  const [a, b] = await Promise.all([
    createWorktree(`/w/${project}`, "main", `t3flare-two-a-${stamp}`),
    createWorktree(`/w/${project}`, "main", `t3flare-two-b-${stamp}`),
  ]);
  report.created = [a, b];
  check("both created", a.path !== null && b.path !== null, report.created);
  if (a.path !== null && b.path !== null) {
    const [ra, rb] = await Promise.all([gitIn(idOf(a.path), ["rev-parse", "--abbrev-ref", "HEAD"]), gitIn(idOf(b.path), ["rev-parse", "--abbrev-ref", "HEAD"])]);
    report.heads = [ra.stdout.trim(), rb.stdout.trim()];
    const budget = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces as Array<{ id: string; kind: string; parent: string | null; state: string; container: { running: boolean } }>;
    report.registry = budget.map((ws) => ({ id: ws.id, kind: ws.kind, parent: ws.parent, state: ws.state, running: ws.container?.running }));
    const running = budget.filter((ws) => (ws.id === idOf(a.path!) || ws.id === idOf(b.path!)) && ws.container?.running).length;
    check("each in its own running Container", running === 2, report.registry);
    // The project's branch list shows both as checked out in worktrees.
    const refs = (await wsCall(cookie, "vcs.listRefs", { cwd: `/w/${project}`, limit: 200 })) as { refs: Array<{ name: string; worktreePath?: string | null }> };
    report.refsInWorktrees = refs.refs.filter((ref) => ref.worktreePath).map((ref) => ({ name: ref.name, worktreePath: ref.worktreePath }));
    check("branch list shows the worktrees", (report.refsInWorktrees as Array<unknown>).length >= 2, report.refsInWorktrees);
  }
}

if (scenario === "wrong-location") {
  const project = arg("workspace")!;
  await updateSettings(cookie, { worktreesDirectory: "/tmp/elsewhere" });
  try {
    const created = await createWorktree(`/w/${project}`, "main", `t3flare-wrong-${Date.now()}`);
    report.created = created;
    const trace = (await admin("GET", "/_t3flare/agents/router-trace")).json?.entries as Array<{ argv: Array<string>; detail?: string }>;
    report.routerSaid = trace.filter((entry) => entry.argv.includes("add")).at(-1)?.detail ?? null;
    // t3 never shows git's stderr (its error carries a fixed text); the router's answer is in the trace.
    check("refused", created.path === null && /clear Settings → Worktrees → Location/.test(String(report.routerSaid)), report);
  } finally {
    await updateSettings(cookie, { worktreesDirectory: "" });
  }
}

if (scenario === "stale") {
  const id = arg("worktree")!;
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(id)}`);
  await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, { fs: { op: "write", path: "/workspace/repo/stale-probe.txt", data: "x" } });
  await admin("GET", "/_t3flare/agents/router-trace?clear=1");
  const status = await wsCall(cookie, "vcs.refreshStatus", { cwd: `/w/${id}` }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }));
  const trace = (((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<{ route: string; argv: Array<string>; cwd: string | null }>).filter(
    (entry) => entry.cwd === `/w/${id}` || entry.argv.some((word) => word.startsWith(`/w/${id}`)),
  );
  report.routes = trace.map((entry) => `${entry.route} ${entry.argv.join(" ").slice(0, 80)}`);
  report.statusSeesProbe = JSON.stringify(status).includes("stale-probe.txt");
  report.container = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, { fs: { op: "remove", path: "/workspace/repo/stale-probe.txt", options: { force: true } } })).json?.container;
  // t3's status and diff-index polls are patched from the write journal. (Its totals for untracked files build a
  // temporary index with `update-index`, an action that starts the Container, as in step 2a.)
  const first = (sub: string) => trace.find((entry) => entry.argv.includes(sub))?.route;
  report.firstStatus = first("status");
  report.firstDiffIndex = first("diff-index");
  check("status and diff-index served stale (patched)", report.firstStatus === "stale-patched" && report.firstDiffIndex === "stale-patched", report.routes);
  check("the write shows", report.statusSeesProbe === true);
}

if (scenario === "work") {
  // A worktree thread's agent edits and runs bash; the checkpoint diff comes from the worktree's DO; a push from it.
  const threadId = arg("thread")!;
  const id = arg("worktree")!;
  await admin("GET", "/_t3flare/agents/checkpoint-trace?clear=1");
  const before = runsOf((await waitFor(cookie, threadId, () => true)).projection).length;
  await sendMessage(cookie, threadId, "Append the line `worktree edit` to README.md with the edit tool, then run `git diff --stat` with bash and reply with its output only.");
  const done = await waitFor(cookie, threadId, (projection) => {
    const runs = runsOf(projection);
    return runs.length > before && SETTLED.has(runs.at(-1)!.status);
  }, 300_000);
  report.run = runsOf(done.projection).at(-1);
  const checkpoints = ((await admin("GET", "/_t3flare/agents/checkpoint-trace")).json?.entries ?? []) as Array<{ op: string; by: string; cwd: string }>;
  report.checkpointOps = checkpoints.map((entry) => `${entry.op}:${entry.by} ${entry.cwd}`);
  check("turn completed", (report.run as { status: string }).status === "completed", report.run);
  const here = checkpoints.filter((entry) => entry.cwd.startsWith(`/w/${id}`));
  check("checkpoints by the worktree's DO", here.some((entry) => entry.op === "capture" && entry.by === "do") && here.some((entry) => entry.op === "diff"), report.checkpointOps);
  const branch = `t3flare-wtpush-${Date.now()}`;
  const outputs = await terminalRun(`/w/${id}`, [
    `git add -A && git -c user.name=t3flare -c user.email=t3flare@users.noreply.github.com commit -qm "worktree push" && git push origin HEAD:refs/heads/${branch} 2>&1 | tail -2; echo "push=\${PIPESTATUS[0]}"`,
    `git push origin --delete ${branch} 2>&1 | tail -1; echo "delete=\${PIPESTATUS[0]}"`,
  ]);
  report.push = outputs.map((text) => text.split("\n").filter((line) => /push=|delete=|new branch|deleted/.test(line)));
  check("pushed from the worktree", /push=0/.test(outputs[0]!) && /delete=0/.test(outputs[1]!), report.push);
}

if (scenario === "trace") {
  const trace = (await admin("GET", "/_t3flare/agents/router-trace")).json?.entries as Array<{ route: string; argv: Array<string>; cwd: string | null; exitCode: number | null }>;
  const shapes = new Map<string, number>();
  for (const entry of trace) {
    const argv = entry.argv.join(" ");
    if (!/\bworktree\b|--git-common-dir/.test(argv)) continue;
    const shape = `${entry.route} ${entry.exitCode} ${argv.replace(/\/w\/[^\s]+/g, "<path>").replace(/\b[0-9a-f]{40}\b/g, "<sha>").replace(/t3flare-[\w-]+|t3\/[\w-]+/g, "<branch>")}`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  report.shapes = Object.fromEntries([...shapes].toSorted(([a], [b]) => a.localeCompare(b)));
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
const out = arg("out");
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(report.ok ? 0 : 1);
