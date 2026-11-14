// The Environment skills the Environment DO keeps (SPI-1148, plan §2): rows, the enabled set and its hash, the
// Environment settings' revision and audit, the limits, and changes that cannot interleave. On Node's SQLite.
import { sha256Hex, skillSetHash, skillSetProblem } from "@t3flare/skills";
import { describe, expect, it } from "vitest";

import { harnessStore } from "../src/harness/store.ts";
import type { FetchedSkill } from "../src/skills/fetch.ts";
import { skillStore } from "../src/skills/store.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
};


const fetched = async (name: string, files: Record<string, string>, digest = `digest-${name}`): Promise<FetchedSkill> => ({
  name,
  description: `What ${name} does.`,
  path: `skills/${name}`,
  disableModelInvocation: false,
  digest,
  bytes: Object.values(files).reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0),
  files: Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, text]) => [path, { text, blob: `blob-${text}`, size: text.length, sha256: await sha256Hex(text) }] as const))),
});

const setup = () => {
  const kv = memory();
  const harness = harnessStore(kv);
  const store = skillStore({ sql: nodeSqlStorage(), transactionSync: (closure) => closure(), harness, kv });
  return { harness, store };
};
const source = (commit: string) => ({ repo: "o/r", path: "skills/a", ref: null, commit });

describe("skillStore", () => {
  it("keeps an installed skill's row and files, and serves the enabled set with a hash made from the files", async () => {
    const { store, harness } = setup();
    expect(store.set()).toEqual({ hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", files: {} });
    const answer = await store.apply({ kind: "install", skill: await fetched("a", { "SKILL.md": "---\nname: a\n---\n", "refs/x.md": "x" }), source: source("c1") }, "owner:me", 1000);
    expect(answer).toMatchObject({ ok: true, action: "skill-install", revision: 1 });
    expect(store.list()).toEqual([
      { name: "a", description: "What a does.", repo: "o/r", path: "skills/a", ref: null, commit: "c1", digest: "digest-a", enabled: true, disableModelInvocation: false, savedAt: 1000, bytes: 17, files: 2 },
    ]);
    const set = store.set();
    expect(set.files).toEqual({ "a/SKILL.md": "---\nname: a\n---\n", "a/refs/x.md": "x" });
    // The hash the store keeps (made from SHA-256s) is the one the files make.
    expect(set.hash).toBe(await skillSetHash(set.files));
    expect(store.hash()).toBe(set.hash);
    expect(harness.loadEnvironment().revision).toBe(1);
  });

  it("audits each change with entity environment, the source and switch before and after, and never file content", async () => {
    const { store, harness } = setup();
    await store.apply({ kind: "install", skill: await fetched("a", { "SKILL.md": "SECRET-BODY" }), source: source("c1") }, "owner:me", 1);
    await store.apply({ kind: "install", skill: await fetched("a", { "SKILL.md": "SECRET-BODY-2" }, "digest-2"), source: source("c2") }, "owner:me", 2);
    await store.apply({ kind: "enable", name: "a", enabled: false }, "owner:me", 3);
    await store.apply({ kind: "remove", name: "a" }, "owner:me", 4);
    const log = harness.auditLog(10);
    expect(log.map((entry) => [entry.entity, entry.action, entry.target])).toEqual([
      ["environment", "skill-remove", "a"],
      ["environment", "skill-disable", "a"],
      ["environment", "skill-update", "a"],
      ["environment", "skill-install", "a"],
    ]);
    expect(log[2]).toMatchObject({ before: { repo: "o/r", path: "skills/a", ref: null, commit: "c1", digest: "digest-a", enabled: true }, after: { commit: "c2", digest: "digest-2" } });
    expect(JSON.stringify(log)).not.toContain("SECRET-BODY");
    expect(harness.loadEnvironment().revision).toBe(4);
  });

  it("answers unchanged for the same files and source, moving nothing", async () => {
    const { store, harness } = setup();
    const skill = await fetched("a", { "SKILL.md": "x" });
    await store.apply({ kind: "install", skill, source: source("c1") }, "owner:me", 1);
    expect(await store.apply({ kind: "install", skill, source: source("c9") }, "owner:me", 2)).toMatchObject({ ok: true, action: "unchanged", revision: 1 });
    expect(await store.apply({ kind: "enable", name: "a", enabled: true }, "owner:me", 3)).toMatchObject({ action: "unchanged", revision: 1 });
    expect(harness.auditLog(10)).toHaveLength(1);
  });

  it("leaves a disabled skill out of the set and its hash, still counted by the limits", async () => {
    const { store } = setup();
    await store.apply({ kind: "install", skill: await fetched("a", { "SKILL.md": "a" }), source: source("c1") }, "owner:me", 1);
    await store.apply({ kind: "install", skill: await fetched("b", { "SKILL.md": "b" }), source: source("c1") }, "owner:me", 1);
    await store.apply({ kind: "enable", name: "a", enabled: false }, "owner:me", 2);
    expect(Object.keys(store.set().files)).toEqual(["b/SKILL.md"]);
    expect(store.hash()).toBe(await skillSetHash({ "b/SKILL.md": "b" }));
    const big = await fetched("c", { "SKILL.md": "x".repeat(4_194_304) });
    const bigger = await fetched("d", { "SKILL.md": "y".repeat(4_194_304) });
    expect(await store.apply({ kind: "install", skill: big, source: source("c1") }, "owner:me", 3)).toMatchObject({ ok: true });
    expect(await store.apply({ kind: "install", skill: bigger, source: source("c1") }, "owner:me", 4)).toEqual({
      ok: false,
      // The disabled a (1 byte) and b (1) count with c and d (4,194,304 each).
      error: "d was not kept: the Environment's skills would be 8388610 bytes together, more than the 8388608 they may be (disabled ones count)",
    });
  });

  it("refuses the 101st skill", async () => {
    const { store } = setup();
    for (let index = 0; index < 100; index++) await store.apply({ kind: "install", skill: await fetched(`s${index}`, { "SKILL.md": "x" }), source: source("c") }, "owner:me", 1);
    expect(await store.apply({ kind: "install", skill: await fetched("one-more", { "SKILL.md": "x" }), source: source("c") }, "owner:me", 1)).toEqual({
      ok: false,
      error: "one-more was not kept: the Environment would hold 101 skills, more than the 100 it may (disabled ones count)",
    });
  });

  it("keeps the hash right when two installs are made at once", async () => {
    const { store, harness } = setup();
    const [a, b] = await Promise.all([fetched("a", { "SKILL.md": "a" }), fetched("b", { "SKILL.md": "b" })]);
    await Promise.all([store.apply({ kind: "install", skill: a, source: source("c") }, "owner:me", 1), store.apply({ kind: "install", skill: b, source: source("c") }, "owner:me", 1)]);
    expect(store.list().map((row) => row.name)).toEqual(["a", "b"]);
    expect(store.hash()).toBe(await skillSetHash({ "a/SKILL.md": "a", "b/SKILL.md": "b" }));
    expect(harness.loadEnvironment().revision).toBe(2);
  });

  it("emits only sets a Workspace can mount", async () => {
    const { store } = setup();
    await store.apply({ kind: "install", skill: await fetched("a", { "SKILL.md": "a", "refs/deep/x y.md": "x", "é漢.md": "y" }), source: source("c") }, "owner:me", 1);
    expect(skillSetProblem(store.set())).toBeUndefined();
  });

  it("keeps a Workspace's last refusal until it reads the set again", () => {
    const { store } = setup();
    store.noteRefusal({ workspace: "w1", hash: "h1", message: "Skill file path a\\b has a backslash or a NUL", at: 1 });
    store.noteRefusal({ workspace: "w2", hash: "h1", message: "no room", at: 2 });
    store.noteRefusal({ workspace: "w1", hash: "h2", message: "again", at: 3 });
    expect(store.refusals().map((refusal) => [refusal.workspace, refusal.message])).toEqual([
      ["w2", "no room"],
      ["w1", "again"],
    ]);
    store.noteTaken("w1");
    expect(store.refusals().map((refusal) => refusal.workspace)).toEqual(["w2"]);
  });
});
