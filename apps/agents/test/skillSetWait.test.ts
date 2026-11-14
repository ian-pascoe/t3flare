// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// A running Container's copy of a new Environment skill set, waited for (SPI-1148, plan §4.2): what must be there and
// what must be gone, sent on stdin, and the wait script itself run with this host's sh against a directory it changes
// part-way. Also the mount's path, the same in both packages that name it, and a Workspace's files at the mount from
// before it existed, moved aside.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SKILLS_MOUNT } from "@t3flare/skills";
import { ENVIRONMENT_SKILLS_DIR } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { expectationInput, expectationOf, keepPriorSkills, parseWait, skillsWaitScript } from "../src/workspace/skillSetWait.ts";

// SHA-256 of "x" and of "y", known values.
const SHA_X = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
const SHA_Y = "a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa";

describe("the wait's expectation", () => {
  it("names each added or changed file with its SHA-256 and each removed path, nothing unchanged", async () => {
    const expectation = await expectationOf({ "a/SKILL.md": "same", "a/x.md": "old", "gone/SKILL.md": "z" }, { "a/SKILL.md": "same", "a/x.md": "x", "new/SKILL.md": "y" });
    expect(expectation).toEqual({ present: [{ path: "a/x.md", sha256: SHA_X }, { path: "new/SKILL.md", sha256: SHA_Y }], removed: ["gone/SKILL.md"] });
    expect(expectationInput(expectation)).toBe(`${SHA_X}  a/x.md\n${SHA_Y}  new/SKILL.md\n--removed--\ngone/SKILL.md\n`);
  });
});

const hasSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0;

describe.skipIf(!hasSha256sum)("skillsWaitScript", () => {
  const run = (dir: string, input: string, looks: number) =>
    new Promise<string>((resolve) => {
      const child = spawn("sh", ["-c", skillsWaitScript(dir, looks, path.join(dir, "..", "lock.failed"))]);
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("close", () => resolve(out));
      child.stdin.end(input);
    });
  const dir = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-wait-"));
    fs.mkdirSync(path.join(root, "skills/a"), { recursive: true });
    return { root, skills: path.join(root, "skills") };
  };

  it("answers caught-up at once when the copy already matches", async () => {
    const { skills } = dir();
    fs.writeFileSync(path.join(skills, "a/x.md"), "x");
    const input = expectationInput({ present: [{ path: "a/x.md", sha256: SHA_X }], removed: ["gone/SKILL.md"] });
    expect(parseWait(await run(skills, input, 25))).toEqual({ caughtUp: true, looks: 1, stale: [] });
  });

  it("looks again until a changed file reads its new SHA-256 and a removed one is gone", async () => {
    const { skills } = dir();
    fs.writeFileSync(path.join(skills, "a/x.md"), "y");
    fs.writeFileSync(path.join(skills, "a/old.md"), "o");
    const waiting = run(skills, expectationInput({ present: [{ path: "a/x.md", sha256: SHA_X }], removed: ["a/old.md"] }), 25);
    setTimeout(() => {
      fs.writeFileSync(path.join(skills, "a/x.md"), "x");
      fs.rmSync(path.join(skills, "a/old.md"));
    }, 500);
    const answer = parseWait(await waiting);
    expect(answer.caughtUp).toBe(true);
    expect(answer.looks).toBeGreaterThan(1);
  });

  it("answers stale with the paths still wrong after its looks, and the lock's failure when marked", async () => {
    const { root, skills } = dir();
    fs.writeFileSync(path.join(skills, "a/x.md"), "y");
    fs.writeFileSync(path.join(skills, "a/old.md"), "o");
    fs.writeFileSync(path.join(root, "lock.failed"), "mount: permission denied\n");
    const answer = parseWait(await run(skills, expectationInput({ present: [{ path: "a/x.md", sha256: SHA_X }], removed: ["a/old.md"] }), 2));
    expect(answer).toEqual({ caughtUp: false, looks: 2, stale: ["a/x.md: FAILED", "present: a/old.md"], lockFailed: "mount: permission denied" });
  });
});

describe("the mount's path", () => {
  it("is the same in @t3flare/skills and the Container lock's package", () => {
    expect(ENVIRONMENT_SKILLS_DIR).toBe(SKILLS_MOUNT);
  });
});

describe("keepPriorSkills", () => {
  const fakeFs = (entries: Record<string, ReadonlyArray<string>>) => {
    const renamed: Array<[string, string]> = [];
    return {
      renamed,
      fs: {
        lstat: async (at: string) => {
          if (entries[at] === undefined) throw Object.assign(new Error(`no such path: ${at}`), { code: "ENOENT" });
          return { isDirectory: true };
        },
        readdir: async (at: string) => entries[at] ?? [],
        rename: async (from: string, to: string) => void renamed.push([from, to]),
      },
    };
  };

  it("moves what a Workspace had at the mount aside before the first index, beside an earlier move", async () => {
    const { fs: files, renamed } = fakeFs({ [SKILLS_MOUNT]: ["mine"], [`${SKILLS_MOUNT}.pre-mount`]: ["older"] });
    const warned: Array<string> = [];
    expect(await keepPriorSkills({ fs: files, mount: SKILLS_MOUNT, indexed: () => false, warn: (line) => warned.push(line) })).toBe(`${SKILLS_MOUNT}.pre-mount-2`);
    expect(renamed).toEqual([[SKILLS_MOUNT, `${SKILLS_MOUNT}.pre-mount-2`]]);
    expect(warned).toEqual([`${SKILLS_MOUNT} is the Environment skills' read-only mount now: what the Workspace had there was moved to ${SKILLS_MOUNT}.pre-mount-2`]);
  });

  it("does nothing once indexed, with nothing there, or with an empty directory", async () => {
    for (const [entries, indexed] of [[{ [SKILLS_MOUNT]: ["mine"] }, true], [{}, false], [{ [SKILLS_MOUNT]: [] }, false]] as const) {
      const { fs: files, renamed } = fakeFs(entries);
      expect(await keepPriorSkills({ fs: files, mount: SKILLS_MOUNT, indexed: () => indexed, warn: () => undefined })).toBeUndefined();
      expect(renamed).toEqual([]);
    }
  });
});

describe("the Workspace DO's own Container commands", () => {
  it("start with the Environment skills' lock, before the submodule directories and the command", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../src/workspace/WorkspaceDO.ts"), "utf8");
    expect(source).toContain("`${SKILLS_LOCK_SCRIPT}${submoduleDirsScript(await this.#containerPatterns())}${body}`");
  });
});
