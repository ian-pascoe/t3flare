// @effect-diagnostics globalDate:off
// t3's own commit action (SPI-1186, SPI-1091): the git panel's Commit, as the client sends it (`git.runStackedAction`
// with `action: "commit"` and the files picked), then the commit it made, read from the Workspace's own git. With no
// message t3 drafts one from the staged patch (its text generation); with one it reads the staged summary only.
// t3's draft (`prepareCommitContext`) runs git with a temporary index, object directory and alternates; its commit
// stages over stdin (`git add -A --pathspec-from-file=- --pathspec-file-nul`).
import { admin, uuid, wsStream } from "./client.ts";

export interface T3CommitReport {
  /** The progress events' kinds, in order. */
  readonly events: ReadonlyArray<string | null>;
  /** The action's failure (an `action_failed` event or the stream's error), or null. */
  readonly failure: string | null;
  /** t3's own result: the commit step's status, sha and subject. */
  readonly result: { readonly status: string | null; readonly commitSha: string | null; readonly subject: string | null };
  /** The Workspace's HEAD after the action: its sha, subject and the files the commit lists. */
  readonly head: { readonly sha: string; readonly subject: string; readonly files: ReadonlyArray<string> } | null;
  readonly ms: number;
}

/** One git command in Workspace `id` through the admin route (the Workspace's own git, starting its Container). */
export const workspaceGit = async (id: string, argv: ReadonlyArray<string>) => {
  const answer = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, { git: { argv, cwd: "/workspace/repo", startContainer: true } });
  return { exitCode: (answer.json?.result?.exitCode as number | undefined) ?? null, stdout: String(answer.json?.result?.stdout ?? ""), stderr: String(answer.json?.result?.stderr ?? "") };
};

/** The commit at HEAD in Workspace `id`: sha, subject and the files it lists. */
export const headCommit = async (id: string) => {
  const shown = await workspaceGit(id, ["show", "--name-only", "--format=%H%n%s", "HEAD"]);
  if (shown.exitCode !== 0) return null;
  const [sha = "", subject = "", ...files] = shown.stdout.split("\n").filter((line) => line !== "");
  return { sha, subject, files };
};

/** t3's commit action of `filePaths` in the project at `cwd` (Workspace `id`), with `message` or a drafted one. */
export const t3Commit = async (cookie: string, input: { readonly id: string; readonly cwd: string; readonly filePaths: ReadonlyArray<string>; readonly message?: string }): Promise<T3CommitReport> => {
  const started = Date.now();
  const events = (await wsStream(cookie, "git.runStackedAction", {
    actionId: uuid(),
    cwd: input.cwd,
    action: "commit",
    ...(input.message === undefined ? {} : { commitMessage: input.message }),
    filePaths: input.filePaths,
  }).catch((error: unknown) => [{ kind: "stream_failed", error: String(error).slice(0, 600) }])) as Array<any>;
  const failed = events.find((event) => event?.kind === "action_failed" || event?.kind === "stream_failed");
  const finished = events.find((event) => event?.kind === "action_finished");
  const commit = finished?.result?.commit;
  return {
    events: events.map((event) => event?.kind ?? null),
    failure: failed === undefined ? null : String(failed.error ?? failed.message ?? JSON.stringify(failed)).slice(0, 600),
    result: { status: commit?.status ?? null, commitSha: commit?.commitSha ?? null, subject: commit?.subject ?? null },
    head: await headCommit(input.id),
    ms: Date.now() - started,
  };
};

/** Whether t3 committed exactly what was asked: its result names the commit at HEAD, which lists every file. */
export const committed = (report: T3CommitReport, filePaths: ReadonlyArray<string>, subject?: string): boolean =>
  report.failure === null &&
  report.result.status === "created" &&
  report.head !== null &&
  report.result.commitSha === report.head.sha &&
  filePaths.every((file) => report.head!.files.includes(file)) &&
  (subject === undefined || report.head.subject === subject);
