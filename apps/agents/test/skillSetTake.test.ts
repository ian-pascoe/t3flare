// A Workspace's take of the Environment skill set (SPI-1148, plan §4.1-§4.2, §4.5), as `WorkspaceDO.takeEnvironmentSkills`
// runs it, with fakes for its storage, the Environment, the mount and the Container: a held hash asks nothing; a refused
// set is remembered by hash and not read again until the hash moves; a set that is no set or cannot be mounted is
// refused and reported; an Environment or a report that predates the calls; and the Container's wait, which never
// starts a stopped Container. The real mount and its fallback run in workerd (`skillSet.workerd.test.ts`).
import { EMPTY_SKILL_SET_HASH, sha256Hex, skillSetOf, type SkillSet } from "@t3flare/skills";
import { describe, expect, it } from "vitest";

import { awaitContainerCopy, takeSkillSet, type TakeDeps, type WaitCommand } from "../src/workspace/skillSetTake.ts";

const memoryStore = (held: SkillSet = { hash: EMPTY_SKILL_SET_HASH, files: {} }) => {
  let current = held;
  let refused: { hash: string; message: string } | undefined;
  return {
    hash: () => current.hash,
    files: () => ({ ...current.files }),
    refused: () => refused,
    refuse: (refusal: { hash: string; message: string }) => void (refused = refusal),
    clearRefused: () => void (refused = undefined),
    set: (set: SkillSet) => void (current = set),
  };
};

const deps = (overrides: Partial<TakeDeps> & { readonly store: ReturnType<typeof memoryStore>; readonly set?: unknown }) => {
  const calls = { read: 0, mount: 0, report: [] as Array<string>, awaited: [] as Array<unknown> };
  const store = overrides.store;
  const built: TakeDeps = {
    read: async () => {
      calls.read++;
      return overrides.set;
    },
    mount: async (set) => {
      calls.mount++;
      store.set(set);
      return {};
    },
    report: async (hash, message) => void calls.report.push(`${hash.slice(0, 6)} ${message}`),
    awaitContainer: async (expectation) => {
      calls.awaited.push(expectation);
      return "stopped";
    },
    warn: () => undefined,
    ...overrides,
    store,
  };
  return { built, calls };
};

describe("takeSkillSet", () => {
  it("asks nothing when the hash is the one held", async () => {
    const store = memoryStore();
    const { built, calls } = deps({ store });
    expect(await takeSkillSet(built, EMPTY_SKILL_SET_HASH)).toEqual({ taken: false, hash: EMPTY_SKILL_SET_HASH });
    expect(calls.read).toBe(0);
  });

  it("takes a new set, mounts it, and waits for the Container's copy of what moved", async () => {
    const set = await skillSetOf({ "a/SKILL.md": "x" });
    const store = memoryStore();
    const { built, calls } = deps({ store, set });
    expect(await takeSkillSet(built, set.hash)).toEqual({ taken: true, hash: set.hash, container: "stopped" });
    expect(store.hash()).toBe(set.hash);
    expect(calls.awaited).toEqual([{ present: [{ path: "a/SKILL.md", sha256: await sha256Hex("x") }], removed: [] }]);
  });

  it("remembers a set that is no set by its hash, reports it, and reads it again only when the hash moves", async () => {
    const store = memoryStore();
    const bad = { hash: "bad-hash", files: { "a\\b": "x" } };
    const { built, calls } = deps({ store, set: bad });
    const first = await takeSkillSet(built, "bad-hash");
    expect(first).toEqual({ taken: false, hash: EMPTY_SKILL_SET_HASH, error: "The Environment skill set was refused: Skill file path a\\b has a backslash or a NUL" });
    expect(calls.report).toEqual(["bad-ha The Environment skill set was refused: Skill file path a\\b has a backslash or a NUL"]);
    expect(await takeSkillSet(built, "bad-hash")).toEqual(first);
    expect(calls.read).toBe(1);
    const good = await skillSetOf({ "a/SKILL.md": "x" });
    const next = deps({ store, set: good });
    expect(await takeSkillSet(next.built, good.hash)).toMatchObject({ taken: true, hash: good.hash });
    expect(store.refused()).toBeUndefined();
  });

  it("refuses and remembers a set the mount could not take, keeping what the mount fell back to", async () => {
    const held = await skillSetOf({ "old/SKILL.md": "o" });
    const store = memoryStore(held);
    const set = await skillSetOf({ "new/SKILL.md": "n" });
    const { built, calls } = deps({ store, set, mount: async () => ({ error: "The Environment skill set could not be mounted, and the Workspace keeps the one it held: boom" }) });
    expect(await takeSkillSet(built, set.hash)).toEqual({ taken: false, hash: held.hash, error: "The Environment skill set could not be mounted, and the Workspace keeps the one it held: boom" });
    expect(store.refused()?.hash).toBe(set.hash);
    expect(calls.awaited).toEqual([]);
  });

  it("version skew: an Environment without the set's call fails the take (the Session logs it); one without the report call does not", async () => {
    const store = memoryStore();
    const old = deps({ store, read: () => Promise.reject(new TypeError('The RPC receiver does not implement the method "environmentSkillSet".')) });
    await expect(takeSkillSet(old.built, "h")).rejects.toThrow("environmentSkillSet");
    const warned: Array<string> = [];
    const noReport = deps({ store, set: null, report: () => Promise.reject(new TypeError('does not implement the method "skillSetRefused"')), warn: (line) => warned.push(line) });
    expect(await takeSkillSet(noReport.built, "h2")).toMatchObject({ taken: false, error: "The Environment skill set was refused: not a Skill set" });
    expect(warned.some((line) => line.includes("skills-refusal-unreported"))).toBe(true);
  });
});

describe("awaitContainerCopy", () => {
  const expectation = { present: [], removed: ["a/SKILL.md"] };

  it("sends no command to a stopped Container, so it never starts one", async () => {
    const sent: Array<WaitCommand> = [];
    expect(await awaitContainerCopy({ running: () => false, exec: async (command) => (sent.push(command), { status: "completed", stdout: "" }), warn: () => undefined }, expectation)).toBe("stopped");
    expect(sent).toEqual([]);
  });

  it("asks a running one with a passive command that refuses to start it, the expectation on stdin", async () => {
    const sent: Array<WaitCommand> = [];
    const answer = await awaitContainerCopy({ running: () => true, exec: async (command) => (sent.push(command), { status: "completed", stdout: "caught-up 3\n" }), warn: () => undefined }, expectation);
    expect(answer).toEqual({ caughtUp: true, looks: 3, stale: [] });
    expect(sent).toMatchObject([{ passive: true, onlyIfRunning: true, stdin: "--removed--\na/SKILL.md\n" }]);
    expect(sent[0]!.script).not.toContain("a/SKILL.md");
  });

  it("answers stopped when the Container stopped before the command reached it, and nothing when nothing moved", async () => {
    expect(await awaitContainerCopy({ running: () => true, exec: async () => ({ status: "not-running", stdout: "" }), warn: () => undefined }, expectation)).toBe("stopped");
    expect(await awaitContainerCopy({ running: () => true, exec: async () => ({ status: "completed", stdout: "" }), warn: () => undefined }, { present: [], removed: [] })).toBeUndefined();
  });
});
