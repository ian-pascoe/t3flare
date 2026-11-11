// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// t3's own status reading over the cloud's passive git answers (the prod bugs of 2026-11-11): t3's real `GitVcsDriver`
// spawns git through the process router, whose Workspace answers like a Workspace DO: real git while its Container
// runs, and `staleRead` (the DO's rule for a passive read) once it stops. The repo is a clone of a repo with a
// submodule, as t3flare's own project is.
//
// - The project showed "Git status failed": t3's `statusDetails` (ahead/behind counted) had never been answered, only
//   its poll's `--no-ahead-behind` shape, and the Container was stopped.
// - The worktree's submodule checkout put the submodule's files in the write journal; a patched status listed it as
//   untracked.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
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
const root = fs.mkdtempSync(join(tmpdir(), "t3flare-status-"));
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
const project = () => {
  const sub = join(root, "t3code-source");
  fs.mkdirSync(join(sub, "apps"), { recursive: true });
  git(root, ["init", "-q", "-b", "main", sub]);
  for (let at = 0; at < 20; at++) fs.writeFileSync(join(sub, "apps", `f${at}.ts`), `export const f${at} = ${at};\n`);
  git(sub, ["add", "-A"]);
  git(sub, ["commit", "-q", "-m", "t3code"]);
  const origin = join(root, "origin");
  git(root, ["init", "-q", "-b", "main", origin]);
  fs.writeFileSync(join(origin, "README.md"), "# t3flare\n");
  git(origin, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "t3code"]);
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-q", "-m", "one"]);
  const dir = join(root, "project");
  git(root, ["clone", "-q", origin, dir]);
  return dir;
};

/** A Workspace DO over `dir`: real git while `running`, the DO's stale rule once stopped. */
const workspaceOver = (dir: string) => {
  const answers = new Map<string, { readonly rev: number; readonly answer: { exitCode: number; stdout: string; stderr: string } }>();
  const state = { running: true, rev: 0, journal: [] as Array<string> };
  const keyOf = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> | undefined) =>
    JSON.stringify([argv, Object.entries(env ?? {}).toSorted(([a], [b]) => a.localeCompare(b))]);
  const inDir = (word: string) => word.replaceAll(REPO_ROOT, dir);
  const stub = {
    git: async (run: { argv: ReadonlyArray<string>; cwd: string; env?: Record<string, string>; startContainer: boolean; readScope?: "git-dir" | "repo" }) => {
      if (!state.running) {
        if (run.startContainer) return { ran: false, reason: "container_refused", detail: "stopped in this test" };
        const outcome = await staleRead(run, {
          last: (argv) => Promise.resolve(answers.get(keyOf(argv, run.env))),
          journalSince: () => state.journal,
          withinGuard: () => withinGuard({ fs, dir, cache: {} }),
          facts: (base) => repoFacts({ fs, dir, cache: {} }, base),
        });
        if (!outcome.found) return { ran: false, reason: "container_stopped", detail: "needs the Workspace's Container, which is stopped, and has no earlier answer" };
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
  };
};

const driver = <A, E>(use: (driver: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* GitVcsDriver.GitVcsDriver);
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3flare-status-config-" })),
          Layer.provideMerge(ProcessRouter.layer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ) as Effect.Effect<A, E, never>,
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
