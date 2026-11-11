// The process router's rules (step 2a plan, section 2): what may start a Container, t3's clone, URLs, paths.
import { describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  cloneRequestOf,
  gitEnvOf,
  intoWorkspace,
  mayStartContainer,
  needsRemoteToken,
  parseWorktreeList,
  readScopeOf,
  remoteRepoOf,
  subcommandOf,
  worktreeCommandOf,
  worktreeDestinationOf,
  worktreeListPorcelain,
} from "../src/agents/gitRoutes.ts";

describe("subcommandOf", () => {
  it("skips git's global options", () => {
    expect(subcommandOf(["-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--porcelain=v2"])).toEqual({
      name: "status",
      rest: ["--porcelain=v2"],
    });
    expect(subcommandOf(["-C", "/w/x", "log"]).name).toBe("log");
    expect(subcommandOf(["--version"]).name).toBeNull();
  });
});

describe("mayStartContainer", () => {
  it("keeps t3's passive reads off a stopped Container", () => {
    for (const argv of [
      ["status", "--porcelain=v2", "--branch", "-z"],
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      ["remote", "-v"],
      ["config", "--get", "remote.origin.url"],
      ["branch", "--list", "--format=%(refname)"],
      ["worktree", "list", "--porcelain"],
      ["for-each-ref", "refs/heads"],
      ["check-ignore", "-z", "--stdin"],
    ]) {
      expect(mayStartContainer(argv), argv.join(" ")).toBe(false);
    }
  });

  it("lets actions start it", () => {
    for (const argv of [
      ["clone", "--progress", "--", "https://github.com/a/b.git", "b"],
      ["fetch", "--quiet", "origin"],
      ["push", "-u", "origin", "HEAD"],
      ["commit", "-m", "x"],
      ["checkout", "-b", "feature"],
      ["branch", "-D", "old"],
      ["branch", "new-branch"],
      ["config", "user.name", "x"],
      ["remote", "add", "upstream", "u"],
      ["worktree", "add", "../x"],
      ["stash", "push"],
      ["add", "-A"],
    ]) {
      expect(mayStartContainer(argv), argv.join(" ")).toBe(true);
    }
  });
});

describe("cloneRequestOf", () => {
  it("is t3's clone into /w", () => {
    expect(cloneRequestOf(["clone", "--progress", "--", "git@github.com:o/r.git", "r"], "/w")).toEqual({
      url: "git@github.com:o/r.git",
      id: "r",
    });
    expect(cloneRequestOf(["clone", "--progress", "--", "https://github.com/o/r.git", "r"], "/w/")).not.toBeNull();
  });

  it("is nothing else", () => {
    expect(cloneRequestOf(["clone", "--", "u", "r"], "/t3/home")).toBeNull();
    expect(cloneRequestOf(["fetch", "origin"], "/w")).toBeNull();
    expect(cloneRequestOf(["clone", "--", "u"], "/w")).toBeNull();
  });
});

describe("remoteRepoOf", () => {
  it("reads https, ssh and scp forms as https", () => {
    const expected = { https: "https://github.com/ian-pascoe/t3flare-fixture.git", host: "github.com", owner: "ian-pascoe", name: "t3flare-fixture" };
    expect(remoteRepoOf("https://github.com/ian-pascoe/t3flare-fixture.git")).toEqual(expected);
    expect(remoteRepoOf("https://github.com/ian-pascoe/t3flare-fixture")).toEqual(expected);
    expect(remoteRepoOf("git@github.com:ian-pascoe/t3flare-fixture.git")).toEqual(expected);
    expect(remoteRepoOf("ssh://git@github.com/ian-pascoe/t3flare-fixture.git")).toEqual(expected);
    expect(remoteRepoOf("https://x-access-token:secret@github.com/ian-pascoe/t3flare-fixture.git")).toEqual(expected);
  });

  it("is null for other URLs", () => {
    expect(remoteRepoOf("/local/path")).toBeNull();
    expect(remoteRepoOf("https://gitlab.com/group/sub/repo.git")).toBeNull();
  });
});

describe("paths into a Workspace", () => {
  it("translates paths in the same Workspace only", () => {
    expect(intoWorkspace("a", "/w/a/src/x.ts")).toBe("/workspace/repo/src/x.ts");
    expect(intoWorkspace("a", "/w/a")).toBe("/workspace/repo");
    expect(intoWorkspace("a", "/w/b/x")).toBe("/w/b/x");
    expect(intoWorkspace("a", "--porcelain")).toBe("--porcelain");
  });

  it("passes git's environment, not the Environment's", () => {
    expect(
      gitEnvOf("a", { HOME: "/t3/home", PATH: "/bin", GIT_OPTIONAL_LOCKS: "0", GIT_DIR: "/w/a/.git", GIT_TRACE2_EVENT: "/tmp/x", LANGUAGE: "C" }),
    ).toEqual({ GIT_OPTIONAL_LOCKS: "0", GIT_DIR: "/workspace/repo/.git", LANGUAGE: "C" });
  });
});

describe("readScopeOf", () => {
  it("keys ref and config reads on .git alone", () => {
    expect(readScopeOf(["--git-dir", "/w/a/.git", "for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("git-dir");
    expect(readScopeOf(["rev-parse", "--show-toplevel"])).toBe("git-dir");
    expect(readScopeOf(["config", "--get", "remote.origin.url"])).toBe("git-dir");
  });

  it("keys working-tree reads on the whole repo", () => {
    expect(readScopeOf(["status", "--porcelain=2", "--branch", "-z"])).toBe("repo");
    expect(readScopeOf(["diff-index", "-M", "--numstat", "-z", "HEAD", "--"])).toBe("repo");
    expect(readScopeOf(["ls-files", "--others", "--exclude-standard", "-z", "--"])).toBe("repo");
    expect(readScopeOf(["check-ignore", "-z", "--stdin"])).toBe("repo");
  });
});


describe("needsRemoteToken (step 2a M4)", () => {
  it("push, fetch, pull and ls-remote get the token; local commands do not", () => {
    expect(needsRemoteToken(["push", "-u", "origin", "HEAD:refs/heads/feature"])).toBe(true);
    expect(needsRemoteToken(["-c", "x=y", "fetch", "--quiet", "origin"])).toBe(true);
    expect(needsRemoteToken(["pull", "--ff-only"])).toBe(true);
    expect(needsRemoteToken(["ls-remote", "origin"])).toBe(true);
    expect(needsRemoteToken(["remote", "update"])).toBe(true);
    expect(needsRemoteToken(["commit", "-m", "x"])).toBe(false);
    expect(needsRemoteToken(["status"])).toBe(false);
  });

  it("t3's branch creation (`branch -- <name>`) may start the Container; listings do not", () => {
    expect(mayStartContainer(["branch", "--", "t3flare/m4-pr-check"])).toBe(true);
    expect(mayStartContainer(["branch", "feature"])).toBe(true);
    expect(mayStartContainer(["branch", "--list", "--format=%(refname)"])).toBe(false);
    expect(mayStartContainer(["branch", "--show-current"])).toBe(false);
    expect(mayStartContainer(["branch", "-a"])).toBe(false);
  });
});

describe("worktree commands (step 2b)", () => {
  it("reads every shape t3 sends", () => {
    // GitVcsDriverCore.createWorktree
    expect(worktreeCommandOf(["-c", "checkout.workers=0", "worktree", "add", "--", "/w/.wt/fixture/feat-0123456789abcdef", "feat"])).toEqual({
      verb: "add",
      path: "/w/.wt/fixture/feat-0123456789abcdef",
      ref: "feat",
      detach: false,
      newBranch: null,
    });
    // PullRequestReviewGuideService.addWorktree (review F6): a detached scratch checkout
    expect(worktreeCommandOf(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", "/w/.wt/review-guide-abc/checkout", "0123abcd"])).toEqual({
      verb: "add",
      path: "/w/.wt/review-guide-abc/checkout",
      ref: "0123abcd",
      detach: true,
      newBranch: null,
    });
    // GitVcsDriverCore.removeWorktree
    expect(worktreeCommandOf(["-c", "status.showUntrackedFiles=normal", "worktree", "remove", "--force", "--", "/w/.wt/fixture/x"])).toEqual({
      verb: "remove",
      path: "/w/.wt/fixture/x",
      force: true,
    });
    expect(worktreeCommandOf(["worktree", "remove", "/w/.wt/fixture/x"])).toEqual({ verb: "remove", path: "/w/.wt/fixture/x", force: false });
    // listWorktreePaths
    expect(worktreeCommandOf(["worktree", "list", "--porcelain", "-z"])).toEqual({ verb: "list", porcelain: true, z: true });
    expect(worktreeCommandOf(["worktree", "prune"])).toEqual({ verb: "prune" });
    expect(worktreeCommandOf(["worktree", "move", "a", "b"])).toEqual({ verb: "unsupported", name: "move" });
    expect(worktreeCommandOf(["status"])).toBeNull();
  });

  it("accepts a destination below /w/.wt/<the project's dir>, and refuses any other with the reason", () => {
    expect(worktreeDestinationOf("/w/fixture", "/w/.wt/fixture/feat-0123")).toEqual({ id: ".wt/fixture/feat-0123" });
    // A project in a subdirectory of its repo: t3 names the worktree's folder after the subdirectory.
    expect(worktreeDestinationOf("/w/mono/packages/app", "/w/.wt/app/feat-0123")).toEqual({ id: ".wt/app/feat-0123" });
    for (const destination of ["/home/me/worktrees/fixture/x", "/w/.wt/other/x", "/w/.wt/fixture/x/nested", "/w/fixture-2"]) {
      expect(worktreeDestinationOf("/w/fixture", destination), destination).toHaveProperty("refused");
    }
    expect((worktreeDestinationOf("/w/fixture", "/tmp/x") as { refused: string }).refused).toContain("clear Settings → Worktrees → Location");
    expect(worktreeDestinationOf("/w/.wt/fixture/a", "/w/.wt/fixture/b")).toHaveProperty("refused");
  });
});

const git = (cwd: string, ...args: Array<string>) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

describe("the worktree list emulation", () => {
  it("writes what real git writes for a main checkout and a worktree, with and without -z", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-wt-")));
    try {
      const repo = path.join(dir, "repo");
      fs.mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(repo, "a"), "a");
      git(repo, "add", "a");
      git(repo, "commit", "-qm", "a");
      git(repo, "worktree", "add", "-q", "-b", "feature", path.join(dir, "wt"));
      git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "detached"));
      const head = git(repo, "rev-parse", "HEAD").trim();
      const entries = [
        { path: repo, head, branch: "refs/heads/main" },
        { path: path.join(dir, "detached"), head, branch: null },
        { path: path.join(dir, "wt"), head, branch: "refs/heads/feature" },
      ];
      for (const z of [true, false]) {
        const real = git(repo, "worktree", "list", "--porcelain", ...(z ? ["-z"] : []));
        expect(worktreeListPorcelain(entries, z)).toBe(real);
        expect(parseWorktreeList(real, z)).toEqual(entries);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
