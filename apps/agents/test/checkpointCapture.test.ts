// @effect-diagnostics nodeBuiltinImport:off
// SPI-1100: a turn's checkpoint holds what a CLI agent wrote in the Container. The Workspace DO's files are a real repo
// (isomorphic-git on Node's fs); the "Container" is a second directory whose files reach the repo only by `pull`, as
// computer's sync does, and every pulled path moves the change log.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { captureTurn, type CaptureDeps, type LastCapture } from "../src/workspace/checkpointCapture.ts";
import { MAX_FILE_BYTES, MAX_TRACKED_FILES } from "../src/workspace/gitRepo.ts";

const root = mkdtempSync(join(tmpdir(), "t3flare-capture-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");

/** A Workspace: the DO's repo, the Container's pending writes, the change log, and the capture's deps. */
const workspace = (name: string, tracked = 1) => {
  const dir = join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (let i = 0; i < tracked; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const pending = new Map<string, string>();
  const journal: Array<{ rev: number; path: string }> = [];
  let rev = 0;
  let last: LastCapture | undefined;
  const containerCaptures: Array<string> = [];
  const deps: CaptureDeps = {
    pull: async () => {
      for (const [path, text] of pending) {
        writeFileSync(join(dir, path), text);
        journal.push({ rev: ++rev, path });
      }
      pending.clear();
    },
    repo: async () => ({ fs, dir, cache: {} }),
    revision: () => rev,
    journalSince: (after, through) => journal.filter((entry) => entry.rev > after && entry.rev <= through).map((entry) => entry.path),
    last: () => last,
    remember: (next) => {
      last = next;
    },
    inContainer: async (ref) => {
      containerCaptures.push(ref);
      // What the Container's git captures (`captureScript`): the files as they are there.
      for (const [path, text] of pending) writeFileSync(join(dir, path), text);
      git(dir, "add", "-A");
      const tree = git(dir, "write-tree").trim();
      const commit = git(dir, "commit-tree", tree, "-p", "HEAD", "-m", `t3 checkpoint ref=${ref}`).trim();
      git(dir, "update-ref", ref, commit);
      git(dir, "reset", "-q");
      return { ok: true };
    },
    nowSeconds: () => 1_700_000_000,
  };
  /** A CLI agent writes `path` in the Container (not yet pulled into the DO). */
  const containerWrites = (path: string, text: string) => pending.set(path, text);
  const show = (ref: string, path: string) => {
    try {
      return git(dir, "show", `${ref}:${path}`);
    } catch {
      return null;
    }
  };
  return { dir, deps, containerWrites, show, containerCaptures };
};

describe("captureTurn (SPI-1100)", () => {
  it("holds a file the Container wrote and the DO had not pulled yet", async () => {
    const ws = workspace("within");
    expect(await captureTurn(ws.deps, "refs/t3/checkpoints/t/turn/0")).toMatchObject({ ok: true, by: "do" });
    ws.containerWrites("notes.txt", "one\n");
    expect(await captureTurn(ws.deps, "refs/t3/checkpoints/t/turn/1")).toMatchObject({ ok: true, by: "do" });
    expect(ws.show("refs/t3/checkpoints/t/turn/0", "notes.txt")).toBeNull();
    expect(ws.show("refs/t3/checkpoints/t/turn/1", "notes.txt")).toBe("one\n");
    // Its diff, as t3 asks it: turn 0 to turn 1 adds the file.
    expect(git(ws.dir, "diff", "--name-only", "refs/t3/checkpoints/t/turn/0", "refs/t3/checkpoints/t/turn/1").trim()).toBe("notes.txt");
    expect(readFileSync(join(ws.dir, "notes.txt"), "utf8")).toBe("one\n");
  });

  it("above the guard, a Container write since the last capture is captured, not aliased", async () => {
    const ws = workspace("above", MAX_TRACKED_FILES + 1);
    expect(await captureTurn(ws.deps, "refs/t3/checkpoints/t/turn/0")).toMatchObject({ ok: true, by: "container" });
    // Nothing written since: the next capture is an alias.
    expect(await captureTurn(ws.deps, "refs/t3/checkpoints/t/turn/1")).toMatchObject({ ok: true, by: "alias" });
    ws.containerWrites("notes.txt", "two\n");
    expect(await captureTurn(ws.deps, "refs/t3/checkpoints/t/turn/2")).toMatchObject({ ok: true, by: "container" });
    expect(ws.show("refs/t3/checkpoints/t/turn/2", "notes.txt")).toBe("two\n");
    expect(ws.containerCaptures).toEqual(["refs/t3/checkpoints/t/turn/0", "refs/t3/checkpoints/t/turn/2"]);
  }, 60_000);

  it("a file past MAX_FILE_BYTES puts a small repo above the guard (SPI-1050)", async () => {
    const ws = workspace("big-file");
    let largest = MAX_FILE_BYTES;
    const deps: CaptureDeps = { ...ws.deps, repo: async () => ({ fs, dir: ws.dir, cache: {}, largestFile: () => largest }) };
    expect(await captureTurn(deps, "refs/t3/checkpoints/t/turn/0")).toMatchObject({ ok: true, by: "do" });
    largest = MAX_FILE_BYTES + 1;
    ws.containerWrites("data.bin", "big\n");
    expect(await captureTurn(deps, "refs/t3/checkpoints/t/turn/1")).toMatchObject({ ok: true, by: "container" });
    expect(ws.containerCaptures).toEqual(["refs/t3/checkpoints/t/turn/1"]);
  });

  it("fails the capture, writing no ref, when the pull fails", async () => {
    const ws = workspace("pull-fails");
    ws.containerWrites("notes.txt", "one\n");
    await expect(captureTurn({ ...ws.deps, pull: () => Promise.reject(new Error("sync failed")) }, "refs/t3/checkpoints/t/turn/1")).rejects.toThrow("sync failed");
    expect(git(ws.dir, "for-each-ref", "refs/t3").trim()).toBe("");
  });
});
