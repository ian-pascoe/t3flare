// Making a worktree Workspace (step 2b, plan section 3.2; review F7) on real git: the worktree's clone, the project's
// bundle of what that clone lacks, and the checkout, each run with bash in its own directory as the two Containers run
// them. Cases: a branch the remote has, local-only commits, no remote at all, and a project whose remote-tracking refs
// are stale (the remote's history was rewritten after its last fetch).
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBundleAnswer, parseTips, worktreeBundleScript, worktreeCloneScript, worktreeFinishScript } from "../src/workspace/worktreeScripts.ts";

let dir: string;
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };

const sh = (cwd: string, script: string) => {
  const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};
const git = (cwd: string, args: string) => {
  const result = sh(cwd, `git ${args}`);
  if (result.code !== 0) throw new Error(`git ${args}: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (repo: string, file: string, text: string) => {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, `add ${file}`);
  git(repo, `commit -qm ${file}`);
  return git(repo, "rev-parse HEAD");
};

/** The three steps, as the Workspace DOs run them; answers the worktree repo and what each step said. */
const provision = (project: string, url: string | null, ref: string) => {
  const worktree = path.join(dir, "worktree-repo");
  const cloned = sh(dir, worktreeCloneScript({ repo: worktree, url, helper: "", name: "t3flare", email: "t3flare@x" }));
  expect(cloned.code, cloned.stderr).toBe(0);
  const tips = parseTips(cloned.stdout);
  const bundlePath = path.join(dir, "project-tmp", "wt.bundle");
  const bundled = sh(project, worktreeBundleScript({ ref, tips, bundle: bundlePath }));
  expect(bundled.code, bundled.stderr).toBe(0);
  const answer = parseBundleAnswer(bundled.stdout);
  // The bundle crosses from one object's files to the other's.
  const seed = path.join(dir, "worktree-seed.bundle");
  if (answer.bundled) fs.copyFileSync(bundlePath, seed);
  const finished = sh(worktree, worktreeFinishScript({ bundle: answer.bundled ? seed : null, ref, commit: answer.commit!, config: answer.config }));
  return { worktree, tips, answer, finished };
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-wt-provision-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A remote with `main`, and a project cloned from it. */
const remoteAndProject = () => {
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  git(seed, "init -q -b main");
  commit(seed, "a", "a");
  const remote = path.join(dir, "remote.git");
  git(dir, `clone -q --bare ${seed} ${remote}`);
  const project = path.join(dir, "project");
  git(dir, `clone -q ${remote} ${project}`);
  return { remote, project };
};

describe("worktree provisioning scripts", () => {
  it("checks out a new branch at a commit the remote has, with no bundle", () => {
    const { remote, project } = remoteAndProject();
    git(project, "branch --track feature origin/main");
    const { worktree, answer, finished } = provision(project, remote, "feature");
    expect(answer.bundled).toBe(false);
    expect(finished.code, finished.stderr).toBe(0);
    expect(git(worktree, "rev-parse HEAD")).toBe(git(project, "rev-parse feature"));
    expect(git(worktree, "symbolic-ref HEAD")).toBe("refs/heads/feature");
    // The branch's config came along (its upstream).
    expect(git(worktree, "config branch.feature.merge")).toBe("refs/heads/main");
    expect(git(worktree, "status --porcelain")).toBe("");
    expect(fs.readFileSync(path.join(worktree, "a"), "utf8")).toBe("a");
  });

  it("brings local-only commits in a bundle of just what the clone lacks", () => {
    const { remote, project } = remoteAndProject();
    git(project, "checkout -q -b local");
    commit(project, "b", "b");
    const head = commit(project, "c", "c");
    const { worktree, answer, finished } = provision(project, remote, "local");
    expect(answer.bundled).toBe(true);
    const header = fs.readFileSync(path.join(dir, "project-tmp", "wt.bundle"), "latin1").split("\n\n")[0]!;
    expect(header).toContain("refs/heads/local");
    // Its one prerequisite is the clone's tip: the bundle holds b and c, not a.
    expect(header.split("\n").filter((line) => line.startsWith("-"))).toEqual([`-${git(project, "rev-parse origin/main")} a`]);
    expect(finished.code, finished.stderr).toBe(0);
    expect(git(worktree, "rev-parse HEAD")).toBe(head);
    expect(git(worktree, "log --format=%s")).toBe("c\nb\na");
    expect(git(worktree, "for-each-ref refs/t3flare")).toBe("");
  });

  it("works with no remote: the whole history in the bundle", () => {
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    git(project, "init -q -b main");
    commit(project, "a", "a");
    const head = commit(project, "b", "b");
    git(project, "branch feature");
    const { worktree, tips, answer, finished } = provision(project, null, "feature");
    expect(tips).toEqual([]);
    expect(answer.bundled).toBe(true);
    expect(finished.code, finished.stderr).toBe(0);
    expect(git(worktree, "rev-parse HEAD")).toBe(head);
    expect(git(worktree, "remote")).toBe("");
  });

  it("does not trust the project's stale remote-tracking refs (review F7)", () => {
    const { remote, project } = remoteAndProject();
    git(project, "checkout -q -b local");
    const head = commit(project, "b", "b");
    // The remote's main is rewritten after the project's last fetch: its origin/main commit is no longer on the remote.
    const other = path.join(dir, "other");
    git(dir, `clone -q ${remote} ${other}`);
    git(other, "commit -q --amend -m rewritten");
    git(other, "push -q --force origin main");
    // `--not --remotes` would leave out the project's stale origin/main commit, which the new clone does not have.
    const stale = sh(project, `git bundle create ${dir}/stale.bundle local --not --remotes`);
    expect(stale.code).toBe(0);
    const { worktree, answer, finished } = provision(project, `file://${remote}`, "local");
    expect(answer.bundled).toBe(true);
    expect(finished.code, finished.stderr).toBe(0);
    expect(git(worktree, "rev-parse HEAD")).toBe(head);
    // A fresh clone, as the worktree's was before the seed, lacks the stale bundle's prerequisite.
    const fresh = path.join(dir, "fresh");
    git(dir, `clone -q --no-checkout file://${remote} ${fresh}`);
    const naive = sh(fresh, `git bundle verify ${dir}/stale.bundle`);
    expect(naive.code).not.toBe(0);
    expect(naive.stderr).toMatch(/lacks these prerequisite commits|missing/i);
  });

  it("fails with git's reason for a ref the project does not have", () => {
    const { project } = remoteAndProject();
    const result = sh(project, worktreeBundleScript({ ref: "nope", tips: [], bundle: path.join(dir, "x.bundle") }));
    expect(result.code).toBe(128);
    expect(result.stderr).toContain("invalid reference: nope");
  });
});
