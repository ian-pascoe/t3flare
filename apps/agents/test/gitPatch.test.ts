// @effect-diagnostics nodeBuiltinImport:off
// Checkpoint-diff fidelity (step 2a plan, Tests → Checkpoint fidelity): the Workspace DO's patch and numstat text
// compared with real git's for the same two commits, byte for byte, after edits, adds, deletes, renames, mode changes,
// binary files, missing final newlines, quoted paths and symlinks. Runs real git in a temp repo (Node).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { asOutput, fileNumstat, filePatch, latin1, treeChanges, type TreeEntry } from "../src/workspace/gitPatch.ts";

const root = mkdtempSync(join(tmpdir(), "t3flare-gitpatch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, ...args: Array<string>): Buffer => execFileSync("git", args, { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024 });

const repo = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const put = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = () => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", "c");
    return git(dir, "rev-parse", "HEAD").toString().trim();
  };
  return { dir, put, commit };
};

/** t3's checkpoint diff argv (GitVcsDriver.checkpoints.diffCheckpoints). */
const realDiff = (dir: string, from: string, to: string, format: "patch" | "numstat") =>
  git(
    dir,
    "-c",
    "diff.relative=false",
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    ...(format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${from}^{commit}`,
    `${to}^{commit}`,
  ).toString("utf8");

const flatTree = (dir: string, commit: string): Map<string, TreeEntry> => {
  const out = new Map<string, TreeEntry>();
  const listing = git(dir, "ls-tree", "-r", "-z", "--full-tree", commit).toString("utf8");
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    out.set(record.slice(tab + 1), { mode: mode!, oid: oid! });
  }
  return out;
};

const ours = (dir: string, from: string, to: string, format: "patch" | "numstat") => {
  const blob = (oid: string) => new Uint8Array(git(dir, "cat-file", "blob", oid));
  const changes = treeChanges(flatTree(dir, from), flatTree(dir, to)).map((change) => ({
    oldPath: change.oldPath,
    newPath: change.newPath,
    old: change.old === null ? null : { ...change.old, bytes: blob(change.old.oid) },
    new: change.new === null ? null : { ...change.new, bytes: blob(change.new.oid) },
  }));
  return asOutput(changes.map(format === "patch" ? filePatch : fileNumstat).join(""));
};

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, at) => `${prefix} ${at + 1}\n`).join("");

const check = (dir: string, from: string, to: string) => {
  expect(ours(dir, from, to, "patch")).toBe(realDiff(dir, from, to, "patch"));
  expect(ours(dir, from, to, "numstat")).toBe(realDiff(dir, from, to, "numstat"));
};

// Each case forks a dozen real `git` processes, ~0.3 s idle but 4 s+ on a CPU-saturated CI runner or a parallel
// `bun run check`: vitest's 5 s default timed out there. Real git cannot be faked (it is what the DO is compared with),
// so the timeout is a ceiling, not a wait: 60 s costs nothing when git is fast and only fails a genuine hang.
const GIT_TEST_TIMEOUT_MS = 60_000;

describe("checkpoint diffs match git's", { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it("edits in the middle, with a function line above", () => {
    const r = repo("edit");
    r.put("src/main.ts", `import x from "x";\n\nfunction alpha() {\n${lines(20, "  a")}}\n\nfunction beta() {\n${lines(20, "  b")}}\n`);
    const a = r.commit();
    r.put("src/main.ts", `import x from "x";\n\nfunction alpha() {\n${lines(20, "  a").replace("  a 10\n", "  a 10 changed\n")}}\n\nfunction beta() {\n${lines(20, "  b").replace("  b 15\n", "")}}\n`);
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("adds, deletes, an empty file, and a file at the top", () => {
    const r = repo("adds");
    r.put("keep.txt", lines(5));
    r.put("gone.txt", lines(3, "gone"));
    const a = r.commit();
    unlinkSync(join(r.dir, "gone.txt"));
    r.put("new/dir/file.md", "# Title\n\nbody\n");
    r.put("empty.txt", "");
    r.put("keep.txt", `first\n${lines(5)}last\n`);
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("an exact rename", () => {
    const r = repo("rename");
    r.put("old/name.txt", lines(10, "same"));
    r.put("other.txt", lines(10, "other"));
    const a = r.commit();
    mkdirSync(join(r.dir, "moved"));
    git(r.dir, "mv", "old/name.txt", "moved/name.txt");
    const b = r.commit();
    check(r.dir, a, b);
    // A rename with an edit (git pairs it by similarity; the Workspace DO shows a delete and an add): not compared.
  });

  it("mode changes, alone and with an edit", () => {
    const r = repo("mode");
    r.put("run.sh", "#!/bin/sh\necho hi\n");
    r.put("tool.sh", "#!/bin/sh\necho tool\n");
    const a = r.commit();
    chmodSync(join(r.dir, "run.sh"), 0o755);
    chmodSync(join(r.dir, "tool.sh"), 0o755);
    r.put("tool.sh", "#!/bin/sh\necho tool two\n");
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("binary files and missing final newlines", () => {
    const r = repo("binary");
    r.put("img.bin", new Uint8Array([1, 2, 0, 3, 4]));
    r.put("noeol.txt", "one\ntwo");
    r.put("addeol.txt", "x\ny");
    r.put("dropeol.txt", "p\nq\n");
    const a = r.commit();
    r.put("img.bin", new Uint8Array([1, 2, 0, 3, 5, 6]));
    r.put("noeol.txt", "one\nthree");
    r.put("addeol.txt", "x\ny\n");
    r.put("dropeol.txt", "p\nq");
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("hunks far apart and hunks that merge", () => {
    const r = repo("hunks");
    r.put("long.txt", lines(100));
    const a = r.commit();
    const edited = lines(100)
      .replace("line 3\n", "line three\n")
      .replace("line 9\n", "line nine\n")
      .replace("line 50\n", "")
      .replace("line 97\n", "line 97\nadded\n");
    r.put("long.txt", edited);
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("paths that need quoting, and a symlink", () => {
    const r = repo("quote");
    r.put("with space.txt", "a\n");
    r.put("ünïcode.txt", "u\n");
    r.put('quo"te.txt', "q\n");
    const a = r.commit();
    r.put("with space.txt", "b\n");
    r.put("ünïcode.txt", "v\n");
    r.put('quo"te.txt', "r\n");
    symlinkSync("with space.txt", join(r.dir, "link"));
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("a whole-file rewrite and a file emptied", () => {
    const r = repo("rewrite");
    r.put("a.txt", lines(8, "old"));
    r.put("b.txt", lines(4));
    const a = r.commit();
    r.put("a.txt", lines(6, "new"));
    r.put("b.txt", "");
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("a function inserted between two others (git's indent heuristic)", () => {
    const r = repo("insert");
    const fn = (name: string) => `function ${name}() {\n  return "${name}";\n}\n`;
    r.put("f.js", `${fn("a")}\n${fn("c")}`);
    const a = r.commit();
    r.put("f.js", `${fn("a")}\n${fn("b")}\n${fn("c")}`);
    const b = r.commit();
    check(r.dir, a, b);
  });

  it("latin1 round trip keeps bytes", () => {
    expect(latin1(new Uint8Array([0xc3, 0xbc]))).toBe("\u00c3\u00bc");
  });
});
