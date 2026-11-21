// The passive-read rule after root's ruling on step 2b M2 (ADR-0009 refinement): only allow-listed `.git` reads with no
// answer at all may start a stopped Container; primed answers (made while it ran) are byte-for-byte git's.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { allowedRead, parsePrimed, passiveDecision, primeArgvs, primeScript, UPSTREAM_FORMAT } from "../src/workspace/gitDirReads.ts";

const REPO = "/workspace/repo";

describe("the allow-list", () => {
  it("takes exactly the reads t3's worktree launch sends, with or without its own --git-dir", () => {
    expect(allowedRead(["rev-parse", "--git-common-dir"], REPO)?.name).toBe("git-common-dir");
    expect(allowedRead(["--git-dir", `${REPO}/.git`, "remote"], REPO)?.name).toBe("remotes");
    expect(allowedRead(["for-each-ref", UPSTREAM_FORMAT, "refs/heads/main"], REPO)?.name).toBe("base-upstream");
    expect(allowedRead(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"], REPO)?.name).toBe("remote-commit");
    expect(allowedRead(["config", "--get", "checkout.workers"], REPO)?.name).toBe("checkout-workers");
    // t3's commit draft (SPI-1186), before its first write.
    expect(allowedRead(["rev-parse", "--git-path", "index", "--git-path", "objects"], REPO)?.name).toBe("commit-git-paths");
    expect(allowedRead(["count-objects", "-v"], REPO)?.name).toBe("commit-alternates");
    // t3's status poll and branch list are not on it.
    for (const argv of [
      ["status", "--porcelain=2", "--branch", "-z"],
      ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/main"],
      ["config", "--get", "remote.origin.url"],
      ["--git-dir", "/w/other/.git", "remote"],
      ["rev-parse", "--show-toplevel"],
      // The review diff's index path, and count-objects in another shape.
      ["rev-parse", "--git-path", "index"],
      ["count-objects"],
    ]) {
      expect(allowedRead(argv, REPO), argv.join(" ")).toBeUndefined();
    }
  });
});

describe("a passive read while the Container is stopped", () => {
  const stopped = { cachedNow: false, running: false, hasLastAnswer: false, allowed: false, emulated: false };

  it("never starts it for a read with a last answer, allow-listed or not", () => {
    expect(passiveDecision({ ...stopped, hasLastAnswer: true, allowed: false })).toBe("stale");
    expect(passiveDecision({ ...stopped, hasLastAnswer: true, allowed: true })).toBe("stale");
  });

  it("starts it only for an unprimed allow-listed read that is not answered from the files", () => {
    expect(passiveDecision({ ...stopped, allowed: true })).toBe("run-starting-container");
    expect(passiveDecision({ ...stopped, allowed: false })).toBe("stale");
    // `remote` is answered from the files.
    expect(passiveDecision({ ...stopped, allowed: true, emulated: true })).toBe("stale");
  });

  it("answers from the cache when it is fresh, and runs the read when the Container runs", () => {
    expect(passiveDecision({ ...stopped, cachedNow: true, hasLastAnswer: true })).toBe("cache");
    expect(passiveDecision({ ...stopped, running: true })).toBe("run");
  });
});

describe("priming", () => {
  it("answers each allow-listed read as git does", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-prime-")));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
    const run = (cwd: string, args: ReadonlyArray<string>) => spawnSync("git", args, { cwd, encoding: "utf8", env });
    try {
      const seed = path.join(dir, "seed");
      fs.mkdirSync(seed);
      run(seed, ["init", "-q", "-b", "main"]);
      fs.writeFileSync(path.join(seed, "a"), "a");
      run(seed, ["add", "a"]);
      run(seed, ["commit", "-qm", "a"]);
      const repo = path.join(dir, "repo");
      run(dir, ["clone", "-q", seed, repo]);
      run(repo, ["branch", "--track", "feature", "origin/main"]);
      const refs = run(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).stdout.split("\n").filter(Boolean);
      const argvs = primeArgvs(refs);
      expect(argvs.length).toBeGreaterThanOrEqual(8);
      expect(argvs).toEqual(expect.arrayContaining([["rev-parse", "--git-path", "index", "--git-path", "objects"], ["count-objects", "-v"]]));
      const primed = spawnSync("bash", ["-c", primeScript(argvs)], { cwd: repo, encoding: "utf8", env });
      const answers = parsePrimed(primed.stdout);
      expect(answers).toHaveLength(argvs.length);
      for (const answer of answers) {
        const direct = run(repo, argvs[answer.index]!);
        expect({ exitCode: answer.exitCode, stdout: answer.stdout }, argvs[answer.index]!.join(" ")).toEqual({ exitCode: direct.status, stdout: direct.stdout });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
