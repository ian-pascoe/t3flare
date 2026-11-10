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
import { kindOf, patchAnswer } from "../src/workspace/staleReads.ts";

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
  const before = SHAPES.map((argv) => git(dir, argv));
  const journal = change();
  const facts = await repoFacts({ fs, dir, cache: {} });
  for (const [at, argv] of SHAPES.entries()) {
    const kind = kindOf(argv, undefined);
    expect(kind).toBeDefined();
    expect(await patchAnswer(kind!, before[at]!, journal, facts), argv.join(" ")).toBe(git(dir, argv));
  }
};

describe("stale reads: last answer plus the journal match git", () => {
  it("edits, an added file, a deleted file, a new untracked directory", async () => {
    const r = setup("basic");
    r.put("README.md", "# readme\n");
    r.put("src/a.txt", "a\nb\nc\n");
    r.put("src/b.txt", "b\n");
    r.put(".gitignore", "ignored/\n*.log\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
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

  it("no writes: the last answer as it was", async () => {
    const r = setup("none");
    r.put("x.txt", "x\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    r.put("x.txt", "y\n");
    await compare(r.dir, () => []);
  });
});
