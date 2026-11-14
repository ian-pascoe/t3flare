// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off
// The acceptance test's real turn (step 2a plan, Tests → Deployed; `scripts/acceptance.ts --real-turn [--push]`):
// clone the fixture into a new Workspace through t3's own clone, open a project and an approval-required thread on
// it, run one turn with a small model that edits a file and runs `bash test.sh`, approve each call, and check the turn
// items, the checkpoint diff and the tool output; then commit the edit through t3's own commit action (the git panel's
// Commit) and check the commit lists the file (SPI-1186, SPI-1091). With `--push` (the step's own stage), commit, push and open a PR
// through t3's git action, then close the PR and delete the branch (with the local `gh`). The Workspace is forgotten
// afterwards (its registry row; its DO's files stay until the stage goes).
import { spawnSync } from "node:child_process";

import { admin, dispatch, itemsOf, mutateProject, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall, wsStream } from "./client.ts";
import { committed, headCommit, t3Commit } from "./t3Commit.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
// T3FLARE_REAL_TURN_MODEL names another model of the proxy (a Claude model gets a thinking level, any other none).
const SLUG = process.env.T3FLARE_REAL_TURN_MODEL ?? "anthropic/claude-haiku-5-5";
const MODEL = { instanceId: "piDurable", model: SLUG, options: /claude/.test(SLUG) ? [{ id: "thinking", value: "low" }] : [] };

export interface RealTurnReport {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly [key: string]: unknown;
}

export const realTurn = async (cookie: string, options: { readonly push: boolean }): Promise<RealTurnReport> => {
  const failures: Array<string> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
    return ok;
  };
  const report: Record<string, unknown> = { fixture: FIXTURE, model: MODEL.model };
  const started = Date.now();
  const id = `acceptance-${Date.now().toString(36)}`;
  const destination = `/w/${id}`;

  // 0. Turn the Durable agent provider on, as the client's onboarding "Turn on" does (a new Environment has it off).
  await wsCall(cookie, "server.updateSettings", {
    patch: {},
    providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
  });

  // 1. Clone, as the client's Add project → Clone does.
  const cloneStarted = Date.now();
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: destination }).catch(
    (error: unknown) => ({ error: String(error).slice(0, 500) }),
  )) as { cwd?: string; error?: string };
  report.clone = { destination, ms: Date.now() - cloneStarted, cwd: cloned.cwd ?? null, error: cloned.error ?? null };
  if (!check("clone", cloned.cwd === destination, report.clone)) return { ok: false, failures, ...report };

  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: destination, createWorkspaceRootIfMissing: false });
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title: id,
    modelSelection: MODEL,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

  // 2. The turn, each approval accepted.
  await sendMessage(cookie, threadId, "In src/greeting.txt add a new last line `Hello from the acceptance test.` with the edit tool, then run `bash test.sh` and tell me in one sentence whether it passed.", MODEL);
  const answered: Array<string> = [];
  let projection: any;
  while (Date.now() - started < 6 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.includes(r.id))) {
      answered.push(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" });
    }
    const runs = runsOf(projection);
    if (runs.length > 0 && runs.every((run) => SETTLED.has(run.status))) break;
    await sleep(1500);
  }
  const items = itemsOf(projection);
  const edit = items.find((item: any) => item.type === "file_change");
  const bash = items.find((item: any) => item.type === "command_execution" && /test\.sh/.test(String(item.input)));
  const checkpoint = items.find((item: any) => item.type === "checkpoint" && Array.isArray(item.files) && item.files.length > 0);
  const requests = (projection?.runtimeRequests ?? []).map((r: any) => ({ kind: r.kind, status: r.status, decision: r.decision ?? null }));
  report.turn = {
    threadId,
    runs: runsOf(projection).map((run) => run.status),
    approvals: requests,
    edit: edit === undefined ? null : { fileName: edit.fileName, status: edit.status },
    bash: bash === undefined ? null : { input: bash.input, status: bash.status, exitCode: bash.exitCode ?? null },
    checkpointFiles: checkpoint?.files ?? null,
    ms: Date.now() - started,
  };
  check("the turn completed", runsOf(projection)[0]?.status === "completed", report.turn);
  check("the edit and bash each asked and were approved", requests.length >= 2 && requests.every((r: any) => r.status === "resolved" && r.decision === "accept"), requests);
  // Claude passes the absolute path, other models often the one relative to the repo; both name the file.
  check("the edit item names the file", [`${destination}/src/greeting.txt`, "src/greeting.txt"].includes(edit?.fileName) && edit?.status === "completed", edit);
  check("bash test.sh exited 0", bash?.status === "completed" && bash?.exitCode === 0, bash);
  check("the turn's checkpoint lists src/greeting.txt", JSON.stringify(checkpoint?.files ?? []).includes("src/greeting.txt"), checkpoint?.files);
  const trace = (await admin("GET", "/_t3flare/agents/checkpoint-trace?clear=1")).json?.entries ?? [];
  report.checkpointOps = trace.filter((entry: any) => entry.cwd === destination).map((entry: any) => `${entry.op}:${entry.by}`);

  // 3. t3's own commit action of the edited file (SPI-1186, SPI-1091): t3's commit draft in the Container (its temporary
  // index, object directory and alternates) and the stdin staging. With `--push`, step 4's commit drafts the same way
  // (with a generated message) and is checked the same way.
  if (!options.push) {
    const subject = "acceptance: t3's commit action";
    const commit = await t3Commit(cookie, { id, cwd: destination, filePaths: ["src/greeting.txt"], message: subject });
    report.commit = commit;
    check("t3's commit action committed src/greeting.txt", committed(commit, ["src/greeting.txt"], subject), commit);
  }

  // 4. Push and PR (the step's stage only).
  if (options.push) {
    const events = (await wsStream(cookie, "git.runStackedAction", {
      actionId: uuid(),
      cwd: destination,
      action: "commit_push_pr",
      featureBranch: true,
      threadId,
      projectId,
    }).catch((error: unknown) => [{ kind: "action_failed", error: String(error).slice(0, 500) }])) as Array<any>;
    const finished = events.find((event) => event.kind === "action_finished");
    const pr = finished?.result?.pr;
    report.push = { events: events.map((event) => event.kind), branch: finished?.result?.push?.branch ?? null, pr: pr ?? null, failed: events.find((event) => event.kind === "action_failed") ?? null };
    // The same check as step 3's: the commit t3 made (its drafted message) is HEAD of the pushed branch, and lists the file.
    const commit = finished?.result?.commit;
    const head = await headCommit(id);
    report.pushCommit = { status: commit?.status ?? null, commitSha: commit?.commitSha ?? null, head };
    check(
      "t3's commit_push_pr committed src/greeting.txt",
      commit?.status === "created" && head !== null && head.sha === commit.commitSha && head.files.includes("src/greeting.txt"),
      report.pushCommit,
    );
    if (check("a PR was opened", typeof pr?.url === "string" && pr.url.includes("/pull/"), report.push)) {
      const closed = spawnSync("gh", ["pr", "close", pr.url, "--delete-branch"], { encoding: "utf8" });
      report.cleanup = { closed: closed.status === 0, output: `${closed.stdout}${closed.stderr}`.trim().slice(0, 300) };
    }
  }
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${id}`);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${id}`);
  report.ms = Date.now() - started;
  return { ok: failures.length === 0, failures, ...report };
};
