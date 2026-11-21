// @effect-diagnostics nodeBuiltinImport:off
// t3's own status reading over the cloud's passive git answers (the prod bugs of 2026-11-11): t3's real `GitVcsDriver`
// spawns git through the process router, whose Workspace answers like a Workspace DO: real git while its Container
// runs, and `staleRead` (the DO's rule for a passive read) once it stops. The repo is a clone of a repo with a
// submodule, as t3flare's own project is.
//
// - The project showed "Git status failed": t3's `statusDetails` (ahead/behind counted) had never been answered, only
//   its poll's `--no-ahead-behind` shape, and the Container was stopped.
// - The worktree's submodule checkout put the submodule's files in the write journal; a patched status listed it as
//   untracked.
// - SPI-1295: t3's diff panel (`getReviewDiffPreview`) sent review argv `kindOf` did not match, so its reads got their
//   last answer or none; one file's reads, never answered before, were refused. Each working-tree read the Workspace
//   answers once stopped is compared with what real git prints for the same argv.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import { afterAll, describe, expect, it } from "vitest";

import { repoFacts, withinGuard } from "../../agents/src/workspace/gitRepo.ts";
import { staleRead } from "../../agents/src/workspace/staleReads.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import * as ProcessRouter from "../src/agents/processRouter.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";

const REPO_ROOT = "/workspace/repo";
// Real path: macOS links /var to /private/var, and git answers `--show-toplevel` with the real one.
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "t3flare-status-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  try {
    return { exitCode: 0, stdout: execFileSync("git", args, { cwd, env: { ...ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8"), stderr: "" };
  } catch (error) {
    const failed = error as { status: number; stdout: Buffer; stderr: Buffer };
    return { exitCode: failed.status ?? 1, stdout: failed.stdout?.toString("utf8") ?? "", stderr: failed.stderr?.toString("utf8") ?? "" };
  }
};

/** A repo with `t3code` as a submodule, cloned (the submodule's directory left empty, as the project's clone has it). */
const project = (name = "project") => {
  const sub = join(root, `${name}-t3code-source`);
  fs.mkdirSync(join(sub, "apps"), { recursive: true });
  git(root, ["init", "-q", "-b", "main", sub]);
  for (let at = 0; at < 20; at++) fs.writeFileSync(join(sub, "apps", `f${at}.ts`), `export const f${at} = ${at};\n`);
  git(sub, ["add", "-A"]);
  git(sub, ["commit", "-q", "-m", "t3code"]);
  const origin = join(root, `${name}-origin`);
  git(root, ["init", "-q", "-b", "main", origin]);
  fs.writeFileSync(join(origin, "README.md"), "# t3flare\n");
  git(origin, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "t3code"]);
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-q", "-m", "one"]);
  const dir = join(root, name);
  git(root, ["clone", "-q", origin, dir]);
  return dir;
};

/** A read the Workspace answered while its Container was stopped: how, and whether its stdout is what git prints now. */
interface StoppedRead {
  readonly argv: ReadonlyArray<string>;
  readonly route: "stale-patched" | "stale-last-answer" | "container-stopped" | "would-start-container";
  readonly asGit: boolean;
}

/** A Workspace DO over `dir`: real git while `running`, the DO's stale rule once stopped. */
const workspaceOver = (dir: string) => {
  const answers = new Map<string, { readonly rev: number; readonly answer: { exitCode: number; stdout: string; stderr: string } }>();
  const state = { running: true, rev: 0, journal: [] as Array<string> };
  const stopped: Array<StoppedRead> = [];
  const keyOf = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> | undefined) =>
    JSON.stringify([argv, Object.entries(env ?? {}).toSorted(([a], [b]) => a.localeCompare(b))]);
  const inDir = (word: string) => word.replaceAll(REPO_ROOT, dir);
  const stub = {
    git: async (run: { argv: ReadonlyArray<string>; cwd: string; env?: Record<string, string>; startContainer: boolean; readScope?: "git-dir" | "repo" }) => {
      if (!state.running) {
        if (run.startContainer) {
          stopped.push({ argv: run.argv, route: "would-start-container", asGit: false });
          return { ran: false, reason: "container_refused", detail: "stopped in this test" };
        }
        const outcome = await staleRead(run, {
          last: (argv) => Promise.resolve(answers.get(keyOf(argv, run.env))),
          journalSince: () => state.journal,
          withinGuard: () => withinGuard({ fs, dir, cache: {} }),
          facts: (base) => repoFacts({ fs, dir, cache: {} }, base),
        });
        if (!outcome.found) {
          stopped.push({ argv: run.argv, route: "container-stopped", asGit: false });
          return { ran: false, reason: "container_stopped", detail: "needs the Workspace's Container, which is stopped, and has no earlier answer" };
        }
        const now = git(inDir(run.cwd), run.argv.map(inDir), Object.fromEntries(Object.entries(run.env ?? {}).map(([key, value]) => [key, inDir(value)])));
        stopped.push({ argv: run.argv, route: `stale-${outcome.stale}`, asGit: outcome.answer.stdout === now.stdout.replaceAll(dir, REPO_ROOT) });
        return { ran: true, ...outcome.answer, ms: 0, cached: true, stale: outcome.stale };
      }
      const env = Object.fromEntries(Object.entries(run.env ?? {}).map(([key, value]) => [key, inDir(value)]));
      const answer = git(inDir(run.cwd), run.argv.map(inDir), env);
      const back = { ...answer, stdout: answer.stdout.replaceAll(dir, REPO_ROOT), stderr: answer.stderr.replaceAll(dir, REPO_ROOT) };
      if (!run.startContainer) answers.set(keyOf(run.argv, run.env), { rev: state.rev, answer: back });
      return { ran: true, ...back, ms: 0 };
    },
  };
  const record = { id: "t3flare", kind: "project", state: "ready", host: "github.com", owner: "ian-pascoe", name: "t3flare" } as unknown as WorkspaceRecord;
  bindEnvironmentServices({
    workspaces: { resolve: (id: string) => (id === "t3flare" ? record : undefined), get: () => record, list: () => [record] },
    github: () => ({ live: () => [], mint: () => Promise.reject(new Error("no GitHub in this test")) }),
    agents: { WORKSPACES: { idFromName: (name: string) => name, get: () => stub } },
  } as unknown as EnvironmentServices);
  return {
    stop: (journal: ReadonlyArray<string>) => {
      state.running = false;
      state.journal = [...journal];
    },
    /** The reads answered since the Container stopped. */
    stopped: () => stopped,
  };
};

/**
 * The routing FileSystem's answer for a Workspace's root (`src/platform/routingFileSystem.ts`), which t3's review asks
 * before one file's working-tree diff: it exists. Every other path is the local disk's (an index lock is not there).
 */
const workspacePathsExist = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const local = yield* FileSystem.FileSystem;
    // @effect-diagnostics-next-line effectFnOpportunity:off -- a fake service's stub method: Effect.fn's span adds nothing to a stand-in
    return FileSystem.FileSystem.of({ ...local, exists: (path) => (/^\/w\/[^/]+$/.test(path) ? Effect.succeed(true) : local.exists(path)) });
  }),
);

const driver = <A, E>(use: (driver: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* GitVcsDriver.GitVcsDriver);
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3flare-status-config-" })),
          Layer.provideMerge(ProcessRouter.layer),
          Layer.provideMerge(workspacePathsExist),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
  );

describe("t3's status over the Workspace's passive answers, on a repo with a submodule", { timeout: 60_000 }, () => {
  it("statusDetails, never answered, reads the poll's answer once the Container stops; the checked-out submodule is not a change", async () => {
    const dir = project();
    const workspace = workspaceOver(dir);
    // While the Container runs, t3's poll reads status without ahead/behind (the only shape it ever sent on prod).
    const polled = await driver((git) => git.statusDetailsLocal("/w/t3flare", { includeDivergence: false }));
    expect(polled.branch).toBe("main");
    expect(polled.hasWorkingTreeChanges).toBe(false);
    // The agent checks the submodule out and edits a file; computer's journal has them all. The Container stops.
    git(dir, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    fs.writeFileSync(join(dir, "README.md"), "# t3flare, edited\n");
    const submoduleFiles = git(join(dir, "t3code"), ["ls-files"]).stdout.trim().split("\n");
    workspace.stop(["README.md", "t3code/.git", "t3code/apps", ...submoduleFiles.map((file) => `t3code/${file}`)]);
    // t3's statusDetails (a commit, a push, the PR flows): ahead/behind counted, a shape it never sent before.
    const details = await driver((git) => git.statusDetails("/w/t3flare"));
    expect(details.isRepo).toBe(true);
    expect(details.branch).toBe("main");
    expect(details.upstreamRef).toBe("origin/main");
    expect(details.hasWorkingTreeChanges).toBe(true);
    expect(details.workingTree.files.map((file) => file.path)).toEqual(["README.md"]);
    // And the poll again, patched with the journal.
    const again = await driver((git) => git.statusDetailsLocal("/w/t3flare", { includeDivergence: false }));
    expect(again.workingTree.files.map((file) => file.path)).toEqual(["README.md"]);
  });
});

/** t3's reads of the working tree, as opposed to its `.git`-only reads (refs, config), which keep their last answer. */
const isWorkingTreeRead = (argv: ReadonlyArray<string>) =>
  argv[0] === "status" || argv[0] === "diff-index" || argv[0] === "ls-files" || (argv[0] === "-c" && argv[2] === "diff");

/** The working-tree reads answered since the Container stopped, each as `<route> <asGit> <argv>`, for one readable diff. */
const workingTreeReads = (reads: ReadonlyArray<StoppedRead>) =>
  reads.filter((read) => isWorkingTreeRead(read.argv)).map((read) => `${read.route} ${read.asGit ? "as-git" : "NOT-as-git"} ${read.argv.join(" ")}`);

describe("t3's diff panel over the Workspace's passive answers (SPI-1295)", { timeout: 60_000 }, () => {
  it("whole-diff and one-file review reads are patched or computed, and each equals git's; none starts the Container", async () => {
    const dir = project("review");
    for (const [path, content] of Object.entries({ "a.ts": "export const a = 1;\n", "before.ts": "export const b = 1;\n", "gone.ts": "gone\n", "ren.txt": "r1\nr2\nr3\nr4\n" })) {
      fs.writeFileSync(join(dir, path), content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "files"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    git(dir, ["commit", "-q", "-am", "feature"]);
    // Uncommitted before the panel opens: in its whole-diff answers, but these files' own reads never run.
    fs.writeFileSync(join(dir, "before.ts"), "export const b = 2;\n");
    git(dir, ["mv", "ren.txt", "moved.txt"]);
    const workspace = workspaceOver(dir);
    const cwd = "/w/t3flare";
    // While the Container runs, the panel opens: the whole diff of both sources, then one file of it.
    const opened = await driver((git) => git.getReviewDiffPreview({ cwd, baseRef: "main" }));
    expect(opened.sources.map((source) => source.files?.map((file) => file.path))).toEqual([
      ["before.ts", "moved.txt"],
      ["a.ts", "before.ts", "moved.txt"],
    ]);
    await driver((git) => git.getReviewDiffPreview({ cwd, baseRef: "main", file: { path: "a.ts", previousPath: null, sourceKind: "working-tree" } }));
    // It stops; then files change in the Workspace (the journal).
    workspace.stop(["a.ts", "gone.ts"]);
    fs.writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    fs.unlinkSync(join(dir, "gone.ts"));

    const whole = await driver((git) => git.getReviewDiffPreview({ cwd, baseRef: "main" }));
    expect(whole.sources.map((source) => [source.kind, source.files?.map((file) => file.path)])).toEqual([
      ["working-tree", ["a.ts", "before.ts", "gone.ts", "moved.txt"]],
      ["branch-range", ["a.ts", "before.ts", "gone.ts", "moved.txt"]],
    ]);
    for (const file of [
      { path: "a.ts", previousPath: null },
      { path: "before.ts", previousPath: null },
      { path: "gone.ts", previousPath: null },
      { path: "moved.txt", previousPath: "ren.txt" },
    ]) {
      for (const sourceKind of ["working-tree", "branch-range"] as const) {
        const one = await driver((git) => git.getReviewDiffPreview({ cwd, baseRef: "main", sourceKind, file: { ...file, sourceKind } }));
        expect(one.sources[0]?.diff, `${file.path} ${sourceKind}`).toContain(`b/${file.path}`);
      }
    }
    const reads = workingTreeReads(workspace.stopped());
    expect(reads.length).toBeGreaterThan(10);
    expect(reads.filter((read) => !read.startsWith("stale-patched as-git "))).toEqual([]);
    expect(workspace.stopped().filter((read) => read.route === "would-start-container")).toEqual([]);
  });

  it("a repo that hides untracked files: statusDetails reads the poll's answer, both with --untracked-files=normal", async () => {
    const dir = project("hidden-untracked");
    git(dir, ["config", "status.showUntrackedFiles", "no"]);
    const workspace = workspaceOver(dir);
    await driver((git) => git.statusDetailsLocal("/w/t3flare", { includeDivergence: false }));
    workspace.stop(["README.md", "notes.txt"]);
    fs.writeFileSync(join(dir, "README.md"), "# t3flare, edited\n");
    fs.writeFileSync(join(dir, "notes.txt"), "n\n");
    const details = await driver((git) => git.statusDetails("/w/t3flare"));
    expect(details.workingTree.files.map((file) => file.path).toSorted()).toEqual(["README.md", "notes.txt"]);
    const reads = workingTreeReads(workspace.stopped());
    expect(reads.some((read) => read.includes("status --porcelain=2 --branch -z --untracked-files=normal"))).toBe(true);
    expect(reads.filter((read) => !read.startsWith("stale-patched as-git "))).toEqual([]);
  });
});
