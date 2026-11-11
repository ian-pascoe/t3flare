// @effect-diagnostics nodeBuiltinImport:off
// The stale git reads (step 2a M3; ADR-0009 refinement): the last real answer of t3's repo-scoped reads, patched with
// the paths written since, compared with what real git answers after the same writes, byte for byte. isomorphic-git
// reads the repo through Node's fs, as it reads the Workspace's files in the DO.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { repoFacts } from "../src/workspace/gitRepo.ts";
import { kindOf, MAX_PATCHED_PATHS, patchAnswer, staleRead } from "../src/workspace/staleReads.ts";

const root = fs.mkdtempSync(join(tmpdir(), "t3flare-stale-"));
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
const git = (cwd: string, args: ReadonlyArray<string>) => execFileSync("git", args, { cwd, env: ENV }).toString("utf8");

const SHAPES: ReadonlyArray<ReadonlyArray<string>> = [
  ["status", "--porcelain=2", "--branch", "-z", "--no-ahead-behind"],
  ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
  ["ls-files", "--others", "--exclude-standard", "-z", "--"],
  ["-c", "diff.suppressBlankEmpty=false", "diff", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--"],
  ["-c", "diff.suppressBlankEmpty=false", "diff", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "--minimal", "--numstat", "-z", "HEAD", "--"],
];

const setup = (name: string) => {
  const dir = join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const put = (path: string, content: string) => {
    fs.mkdirSync(dirname(join(dir, path)), { recursive: true });
    fs.writeFileSync(join(dir, path), content);
  };
  return { dir, put };
};

/** Answers before, `change` (which returns the paths it wrote), then each shape's patched answer against real git's. */
const compare = async (dir: string, change: () => ReadonlyArray<string>) => {
  // The review numstat against a merge base (a commit id), as t3's branch totals read it.
  const base = git(dir, ["rev-list", "--max-parents=0", "HEAD"]).trim();
  const shapes = [...SHAPES, [...SHAPES[4]!.slice(0, -2), base, "--"]];
  const before = shapes.map((argv) => git(dir, argv));
  const journal = change();
  for (const [at, argv] of shapes.entries()) {
    const shape = kindOf(argv, undefined);
    expect(shape).toBeDefined();
    const facts = await repoFacts({ fs, dir, cache: {} }, shape!.base);
    expect(await patchAnswer(shape!.kind, before[at]!, journal, facts), argv.join(" ")).toBe(git(dir, argv));
  }
};

// Each case forks dozens of real `git` processes (before/after answers for six shapes): fast idle, but past vitest's 5 s
// default on a CPU-saturated runner. Real git is what the answers are compared with, so the timeout is a ceiling, not a
// wait: 60 s costs nothing when git is fast and only fails a genuine hang.
const GIT_TEST_TIMEOUT_MS = 60_000;

describe("stale reads: last answer plus the journal match git", { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it("edits, an added file, a deleted file, a new untracked directory", async () => {
    const r = setup("basic");
    r.put("README.md", "# readme\n");
    r.put("src/a.txt", "a\nb\nc\n");
    r.put("src/b.txt", "b\n");
    r.put(".gitignore", "ignored/\n*.log\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    r.put("src/b.txt", "b2\n");
    git(r.dir, ["commit", "-q", "-am", "two"]);
    r.put("src/a.txt", "a\nB\nc\n");
    await compare(r.dir, () => {
      r.put("src/a.txt", "a\nB\nc\nd\n");
      fs.unlinkSync(join(r.dir, "src/b.txt"));
      r.put("new/dir/file.txt", "new\n");
      r.put("top.txt", "top\n");
      r.put("ignored/x.txt", "x\n");
      r.put("debug.log", "log\n");
      return ["src/a.txt", "src/b.txt", "new", "new/dir", "new/dir/file.txt", "top.txt", "ignored/x.txt", "debug.log"];
    });
  });

  it("a file put back as HEAD has it, and an untracked file removed", async () => {
    const r = setup("revert");
    r.put("f.txt", "one\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    r.put("f.txt", "two\n");
    r.put("scratch.txt", "s\n");
    await compare(r.dir, () => {
      r.put("f.txt", "one\n");
      fs.unlinkSync(join(r.dir, "scratch.txt"));
      return ["f.txt", "scratch.txt"];
    });
  });

  it("an untracked directory that gains and loses files", async () => {
    const r = setup("dirs");
    r.put("keep.txt", "k\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    r.put("tmp/a.txt", "a\n");
    r.put("tmp/b.txt", "b\n");
    await compare(r.dir, () => {
      fs.unlinkSync(join(r.dir, "tmp/a.txt"));
      r.put("tmp/c/d.txt", "d\n");
      return ["tmp/a.txt", "tmp/c", "tmp/c/d.txt"];
    });
  });

  it("a submodule checked out (its files in the journal) and an edit beside it", async () => {
    // The prod bug of 2026-11-11: t3's worktree creation and the agent checked out t3flare's `t3code` submodule, whose
    // files all reached the journal. git shows nothing for a submodule at its recorded commit.
    const sub = setup("submodule-source");
    for (let at = 0; at < 30; at++) sub.put(`d${at % 3}/f${at}.txt`, `${at}\n`);
    git(sub.dir, ["add", "-A"]);
    git(sub.dir, ["commit", "-q", "-m", "sub"]);
    const r = setup("submodule");
    r.put("README.md", "# readme\n");
    git(r.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/sub"]);
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    // A clone leaves the submodule's directory empty, as the project's clone does.
    const clone = join(root, "submodule-clone");
    git(root, ["clone", "-q", r.dir, clone]);
    await compare(clone, () => {
      git(clone, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
      fs.writeFileSync(join(clone, "README.md"), "# readme 2\n");
      const files = git(join(clone, "vendor/sub"), ["ls-files"]).trim().split("\n");
      return ["README.md", "vendor/sub/.git", "vendor/sub/d0", "vendor/sub/d1", "vendor/sub/d2", ...files.map((file) => `vendor/sub/${file}`)];
    });
  });

  it("no writes: the last answer as it was", async () => {
    const r = setup("none");
    r.put("x.txt", "x\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    r.put("x.txt", "y\n");
    await compare(r.dir, () => []);
  });
});

describe("a passive read while the Container is stopped (staleRead)", { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  const STATUS = ["status", "--porcelain=2", "--branch", "-z"];
  const STATUS_NAB = [...STATUS, "--no-ahead-behind"];
  /** A clone one commit ahead of its upstream, with `answers` as the reads' last real answers (at revision 0). */
  const sourcesOver = (dir: string, answers: ReadonlyMap<string, string>, written: ReadonlyArray<string> = []) => ({
    last: (argv: ReadonlyArray<string>) => {
      const stdout = answers.get(argv.join(" "));
      return Promise.resolve(stdout === undefined ? undefined : { rev: 0, answer: { exitCode: 0, stdout, stderr: "" } });
    },
    journalSince: () => written,
    withinGuard: () => Promise.resolve(true),
    facts: (base: string) => repoFacts({ fs, dir, cache: {} }, base),
  });
  const ahead = (name: string) => {
    const origin = setup(`${name}-origin`);
    origin.put("a.txt", "a\n");
    git(origin.dir, ["add", "-A"]);
    git(origin.dir, ["commit", "-q", "-m", "one"]);
    const dir = join(root, `${name}-clone`);
    git(root, ["clone", "-q", origin.dir, dir]);
    fs.writeFileSync(join(dir, "a.txt"), "a2\n");
    git(dir, ["commit", "-q", "-am", "two"]);
    return dir;
  };

  it("t3's statusDetails shape, never answered, gets the local poll's answer (ahead/behind unknown, as git says it)", async () => {
    const dir = ahead("sibling");
    const answers = new Map([[STATUS_NAB.join(" "), git(dir, STATUS_NAB)]]);
    fs.writeFileSync(join(dir, "b.txt"), "b\n");
    const outcome = await staleRead({ argv: STATUS, env: undefined }, sourcesOver(dir, answers, ["b.txt"]));
    expect(outcome).toEqual({ found: true, stale: "patched", answer: { exitCode: 0, stdout: git(dir, STATUS_NAB), stderr: "" } });
  });

  it("the local poll's shape, never answered, gets statusDetails' answer with its counts hidden as git hides them", async () => {
    const dir = ahead("sibling-back");
    const answers = new Map([[STATUS.join(" "), git(dir, STATUS)]]);
    const outcome = await staleRead({ argv: STATUS_NAB, env: undefined }, sourcesOver(dir, answers));
    expect(outcome).toEqual({ found: true, stale: "patched", answer: { exitCode: 0, stdout: git(dir, STATUS_NAB), stderr: "" } });
  });

  it("no answer to either shape: nothing to serve", async () => {
    const dir = ahead("none-known");
    expect(await staleRead({ argv: STATUS, env: undefined }, sourcesOver(dir, new Map()))).toEqual({ found: false });
  });

  it("more paths written than the DO patches: the last answer as it was", async () => {
    const dir = ahead("many");
    const before = git(dir, STATUS_NAB);
    const written = Array.from({ length: MAX_PATCHED_PATHS + 1 }, (_, at) => `gen/f${at}.txt`);
    const outcome = await staleRead({ argv: STATUS_NAB, env: undefined }, sourcesOver(dir, new Map([[STATUS_NAB.join(" "), before]]), written));
    expect(outcome).toEqual({ found: true, stale: "last-answer", why: `${MAX_PATCHED_PATHS + 1} paths written`, answer: { exitCode: 0, stdout: before, stderr: "" } });
  });
});
