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

// t3's review diffs (`getReviewDiffPreview`): its `REVIEW_DIFF_ARGS`, then the stats read or the patch read.
const REVIEW = ["-c", "diff.suppressBlankEmpty=false", "diff", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/"];
const STATS = [...REVIEW, "--raw", "--numstat", "-z"];
const PATCH = [...REVIEW, "--patch"];
const OTHERS = ["ls-files", "--others", "--exclude-standard", "-z", "--"];
/** t3's pathspec for one file of the diff panel. */
const one = (path: string) => `:(top,literal)${path}`;

const SHAPES: ReadonlyArray<ReadonlyArray<string>> = [
  ["status", "--porcelain=2", "--branch", "-z", "--no-ahead-behind"],
  ["status", "--porcelain=2", "--branch", "-z", "--untracked-files=normal"],
  ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
  OTHERS,
  [...PATCH, "HEAD", "--"],
  [...STATS, "HEAD", "--"],
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

/**
 * Answers before, `change` (which returns the paths it wrote), then each shape's patched answer against real git's.
 * `extra` adds shapes to t3's whole-repo reads (one file's reads), and `only` replaces them.
 */
const compare = async (
  dir: string,
  change: () => ReadonlyArray<string>,
  options: { readonly extra?: ReadonlyArray<ReadonlyArray<string>>; readonly only?: ReadonlyArray<ReadonlyArray<string>> } = {},
) => {
  // The review reads against a merge base (a commit id), as t3's branch-range source reads them.
  const base = git(dir, ["rev-list", "--max-parents=0", "HEAD"]).trim();
  const shapes = options.only ?? [...SHAPES, [...PATCH, base, "--"], [...STATS, base, "--"], ...(options.extra ?? [])];
  const before = shapes.map((argv) => git(dir, argv));
  const journal = change();
  for (const [at, argv] of shapes.entries()) {
    const shape = kindOf(argv, undefined);
    expect(shape, argv.join(" ")).toBeDefined();
    const facts = await repoFacts({ fs, dir, cache: {} }, shape!.base);
    expect(await patchAnswer(shape!, before[at]!, journal, facts), argv.join(" ")).toBe(git(dir, argv));
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
    }, {
      // One file's reads, as the diff panel sends them: a written file, a deleted one, one nothing wrote, a new one.
      extra: [
        ...["src/a.txt", "src/b.txt", "README.md"].flatMap((path) => [[...STATS, "HEAD", "--", one(path)], [...PATCH, "HEAD", "--", one(path)]]),
        [...OTHERS, one("top.txt")],
        [...OTHERS, one("src/a.txt")],
      ],
    });
  });

  it("a rename (git mv), a mode change and a staged edit: the review reads", async () => {
    const r = setup("rename");
    r.put("ren.txt", "r1\nr2\nr3\nr4\n");
    r.put("run.sh", "echo\n");
    r.put("staged.txt", "s\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    const both = [one("moved.txt"), one("ren.txt")];
    await compare(r.dir, () => {
      git(r.dir, ["mv", "ren.txt", "moved.txt"]);
      fs.chmodSync(join(r.dir, "run.sh"), 0o755);
      r.put("staged.txt", "s2\n");
      git(r.dir, ["add", "staged.txt"]);
      return ["ren.txt", "moved.txt", "run.sh", "staged.txt"];
    }, {
      only: [
        [...STATS, "HEAD", "--"],
        [...PATCH, "HEAD", "--"],
        [...STATS, "HEAD", "--", ...both],
        [...PATCH, "HEAD", "--", ...both],
        [...STATS, "HEAD", "--", one("moved.txt")],
        [...PATCH, "HEAD", "--", one("run.sh")],
      ],
    });
  });

  it("renames git pairs (an empty file, a mode change, the source with the same basename) and a file that became a symlink", async () => {
    const r = setup("pairs");
    r.put("empty.txt", "");
    r.put("m.sh", "m\n");
    r.put("dir_a.txt", "same\n");
    r.put("z/b.txt", "same\n");
    r.put("l", "x\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    await compare(r.dir, () => {
      git(r.dir, ["mv", "empty.txt", "empty2.txt"]);
      git(r.dir, ["mv", "m.sh", "m2.sh"]);
      fs.chmodSync(join(r.dir, "m2.sh"), 0o755);
      git(r.dir, ["rm", "-q", "dir_a.txt", "z/b.txt"]);
      r.put("new/b.txt", "same\n");
      fs.unlinkSync(join(r.dir, "l"));
      fs.symlinkSync("dir_a.txt", join(r.dir, "l"));
      git(r.dir, ["add", "-A"]);
      return ["empty.txt", "empty2.txt", "m.sh", "m2.sh", "dir_a.txt", "z/b.txt", "new", "new/b.txt", "l"];
    }, {
      only: [
        [...STATS, "HEAD", "--"],
        [...PATCH, "HEAD", "--"],
        ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
        [...STATS, "HEAD", "--", one("l")],
        [...PATCH, "HEAD", "--", one("l")],
      ],
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

  it("with --untracked-files=normal, each status shape stands in for the other, never for a shape without it", async () => {
    const dir = ahead("untracked-normal");
    git(dir, ["config", "status.showUntrackedFiles", "no"]);
    const withFlag = [...STATUS, "--untracked-files=normal"];
    const withFlagNab = [...withFlag, "--no-ahead-behind"];
    fs.writeFileSync(join(dir, "before.txt"), "b\n");
    const answers = new Map([[withFlagNab.join(" "), git(dir, withFlagNab)]]);
    fs.writeFileSync(join(dir, "after.txt"), "a\n");
    const outcome = await staleRead({ argv: withFlag, env: undefined }, sourcesOver(dir, answers, ["after.txt"]));
    expect(outcome).toEqual({ found: true, stale: "patched", answer: { exitCode: 0, stdout: git(dir, withFlagNab), stderr: "" } });
    expect(await staleRead({ argv: STATUS, env: undefined }, sourcesOver(dir, answers, ["after.txt"]))).toEqual({ found: false });
    expect(await staleRead({ argv: STATUS_NAB, env: undefined }, sourcesOver(dir, answers, ["after.txt"]))).toEqual({ found: false });
    // And back: the --no-ahead-behind shape from the plain one's answer, its counts hidden as git hides them.
    const plain = new Map([[withFlag.join(" "), git(dir, withFlag)]]);
    const back = await staleRead({ argv: withFlagNab, env: undefined }, sourcesOver(dir, plain));
    expect(back).toEqual({ found: true, stale: "patched", answer: { exitCode: 0, stdout: git(dir, withFlagNab), stderr: "" } });
  });

  it("more paths written than the DO patches: the last answer as it was", async () => {
    const dir = ahead("many");
    const before = git(dir, STATUS_NAB);
    const written = Array.from({ length: MAX_PATCHED_PATHS + 1 }, (_, at) => `gen/f${at}.txt`);
    const outcome = await staleRead({ argv: STATUS_NAB, env: undefined }, sourcesOver(dir, new Map([[STATUS_NAB.join(" "), before]]), written));
    expect(outcome).toEqual({ found: true, stale: "last-answer", why: `${MAX_PATCHED_PATHS + 1} paths written`, answer: { exitCode: 0, stdout: before, stderr: "" } });
  });
});

describe("one file's review reads with no last answer are computed (SPI-1295)", { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  /** No read was answered before; `written` is the journal since the Container stopped. */
  const noAnswers = (dir: string, written: ReadonlyArray<string>, within = true) => ({
    last: () => Promise.resolve(undefined),
    journalSince: () => written,
    withinGuard: () => Promise.resolve(within),
    facts: (base: string) => repoFacts({ fs, dir, cache: {} }, base),
  });
  /** A repo on a branch one commit past `main`, and that commit's merge base with `main`. */
  const branched = (name: string) => {
    const r = setup(name);
    r.put("edited.txt", "one\ntwo\nthree\n");
    r.put("before.txt", "b1\n");
    r.put("gone.txt", "g\n");
    r.put("src/kept.ts", "export const k = 1;\n");
    r.put("ren.txt", "r1\nr2\nr3\nr4\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    const base = git(r.dir, ["rev-parse", "HEAD"]).trim();
    git(r.dir, ["checkout", "-q", "-b", "feature"]);
    r.put("edited.txt", "one\ntwo\nthree\nfour\n");
    git(r.dir, ["commit", "-q", "-am", "two"]);
    return { ...r, base };
  };
  /** Each argv's computed answer, against real git's. */
  const expectComputed = async (dir: string, argvs: ReadonlyArray<ReadonlyArray<string>>, written: ReadonlyArray<string>) => {
    for (const argv of argvs) {
      const outcome = await staleRead({ argv, env: undefined }, noAnswers(dir, written));
      expect(outcome, argv.join(" ")).toEqual({ found: true, stale: "patched", answer: { exitCode: 0, stdout: git(dir, argv), stderr: "" } });
    }
  };
  const reads = (path: string, base: string) => [[...OTHERS, one(path)], [...STATS, base, "--", one(path)], [...PATCH, base, "--", one(path)]];

  it("a path written after the stop and one changed before it, against HEAD and the merge base", async () => {
    const r = branched("one-file");
    // Changed while the Container ran, before it stopped: not in the journal.
    r.put("before.txt", "b2\n");
    // Written after the stop.
    r.put("edited.txt", "zero\none\ntwo\nthree\nfour\n");
    fs.unlinkSync(join(r.dir, "gone.txt"));
    r.put("src/kept.ts", "export const k = 2;\n");
    git(r.dir, ["add", "src/kept.ts"]);
    const written = ["edited.txt", "gone.txt", "src/kept.ts"];
    const paths = ["edited.txt", "before.txt", "gone.txt", "src/kept.ts", "ren.txt"];
    await expectComputed(r.dir, paths.flatMap((path) => [...reads(path, "HEAD"), ...reads(path, r.base)]), written);
  });

  it("an unstaged rename with a mode change, an unstaged type change, and pairs made in path order whatever the journal's", async () => {
    const r = setup("unstaged-pairs");
    r.put("m.sh", "m\n");
    r.put("a/x.txt", "same\n");
    r.put("b/y.txt", "same\n");
    r.put("t.txt", "t\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    await compare(r.dir, () => {
      git(r.dir, ["mv", "m.sh", "m2.sh"]);
      fs.chmodSync(join(r.dir, "m2.sh"), 0o755);
      git(r.dir, ["rm", "-q", "a/x.txt", "b/y.txt"]);
      r.put("c/z.txt", "same\n");
      git(r.dir, ["add", "c/z.txt"]);
      fs.unlinkSync(join(r.dir, "t.txt"));
      fs.symlinkSync("m2.sh", join(r.dir, "t.txt"));
      // Not in path order, as computer's change log need not be.
      return ["t.txt", "m2.sh", "c/z.txt", "b/y.txt", "c", "a/x.txt", "m.sh"];
    }, {
      only: [
        [...STATS, "HEAD", "--"],
        [...PATCH, "HEAD", "--"],
        ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
      ],
    });
  });

  it("status: a type change staged and one not (renames in a patched status stay their two sides, ADR-0009)", async () => {
    const r = setup("status-types");
    r.put("staged.txt", "s\n");
    r.put("worktree.txt", "w\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-q", "-m", "one"]);
    await compare(r.dir, () => {
      fs.unlinkSync(join(r.dir, "staged.txt"));
      fs.symlinkSync("worktree.txt", join(r.dir, "staged.txt"));
      git(r.dir, ["add", "staged.txt"]);
      fs.unlinkSync(join(r.dir, "worktree.txt"));
      fs.symlinkSync("staged.txt", join(r.dir, "worktree.txt"));
      return ["staged.txt", "worktree.txt"];
    }, { only: [["status", "--porcelain=2", "--branch", "-z"], ["status", "--porcelain=2", "--branch", "-z", "--no-ahead-behind"]] });
  });

  it("a file that became a symlink: git's type change", async () => {
    const r = branched("one-symlink");
    fs.unlinkSync(join(r.dir, "before.txt"));
    fs.symlinkSync("edited.txt", join(r.dir, "before.txt"));
    await expectComputed(r.dir, reads("before.txt", "HEAD"), ["before.txt"]);
  });

  it("an untracked file is listed, and has no review diff", async () => {
    const r = branched("one-untracked");
    r.put("fresh.txt", "f\n");
    await expectComputed(r.dir, reads("fresh.txt", "HEAD"), ["fresh.txt"]);
  });

  it("an exact rename read with both paths pairs them, as git does", async () => {
    const r = branched("one-rename");
    git(r.dir, ["mv", "ren.txt", "moved.txt"]);
    const both = [one("moved.txt"), one("ren.txt")];
    await expectComputed(r.dir, [[...STATS, "HEAD", "--", ...both], [...PATCH, "HEAD", "--", ...both], [...STATS, r.base, "--", ...both]], ["ren.txt", "moved.txt"]);
  });

  it("refused: an inexact rename read with both paths, a directory, and any read above the guard", async () => {
    const r = branched("one-refused");
    git(r.dir, ["mv", "ren.txt", "moved.txt"]);
    fs.writeFileSync(join(r.dir, "moved.txt"), "r1\nr2\nr3\nr4\nr5\n");
    git(r.dir, ["add", "moved.txt"]);
    const refused = async (argv: ReadonlyArray<string>, within = true) =>
      expect(await staleRead({ argv, env: undefined }, noAnswers(r.dir, ["ren.txt", "moved.txt"], within)), argv.join(" ")).toEqual({ found: false });
    // git pairs the two as a rename with a similarity index, which only git computes.
    expect(git(r.dir, [...STATS, "HEAD", "--", one("moved.txt"), one("ren.txt")])).toContain("R0");
    await refused([...STATS, "HEAD", "--", one("moved.txt"), one("ren.txt")]);
    await refused([...PATCH, "HEAD", "--", one("moved.txt"), one("ren.txt")]);
    await refused([...PATCH, "HEAD", "--", one("src")]);
    await refused([...OTHERS, one("src")]);
    await refused([...PATCH, "HEAD", "--", one("edited.txt")], false);
    // A whole-diff read with no last answer still fails fast.
    await refused([...PATCH, "HEAD", "--"]);
    // So does one with untracked files staged in a temporary index.
    expect(await staleRead({ argv: [...PATCH, "HEAD", "--", one("edited.txt")], env: { GIT_INDEX_FILE: "/tmp/x" } }, noAnswers(r.dir, []))).toEqual({ found: false });
  });
});
