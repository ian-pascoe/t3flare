// The Environment skill set as it travels (SPI-1148): its hash, and the path rule both the install and every Workspace
// apply, so a set the Environment keeps is always one a Workspace can mount.
import { describe, expect, it } from "vitest";

import { EMPTY_SKILL_SET_HASH, skillFilePathProblem, skillSetHash, skillSetOf, skillSetProblem } from "./skillSet.ts";

describe("skillSetHash", () => {
  it("is SHA-256 of nothing for no files", async () => {
    expect(await skillSetHash({})).toBe(EMPTY_SKILL_SET_HASH);
  });

  it("moves when a file's text or path moves, and not with the order files are given in", async () => {
    const one = await skillSetHash({ "a/SKILL.md": "x", "b/SKILL.md": "y" });
    expect(await skillSetHash({ "b/SKILL.md": "y", "a/SKILL.md": "x" })).toBe(one);
    expect(await skillSetHash({ "a/SKILL.md": "x", "b/SKILL.md": "z" })).not.toBe(one);
    expect(await skillSetHash({ "a/SKILL.md": "x", "c/SKILL.md": "y" })).not.toBe(one);
  });

  it("is the same whether made from the files or from each file's SHA-256 (what the Environment keeps)", async () => {
    const set = await skillSetOf({ "a/SKILL.md": "x", "a/ref/notes.md": "é漢" });
    // SHA-256 of "x", a known value.
    const fromDigests = await skillSetHash({}, { "a/SKILL.md": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881", "a/ref/notes.md": await sha("é漢") });
    expect(fromDigests).toBe(set.hash);
  });
});

const sha = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("skillFilePathProblem", () => {
  it("takes a plain relative path", () => {
    expect(skillFilePathProblem("grill-me/SKILL.md")).toBeUndefined();
    expect(skillFilePathProblem("grill-me/references/a b.md")).toBeUndefined();
  });

  it("refuses a backslash, a NUL, and an empty, `.` or `..` segment", () => {
    for (const path of ["a\\b/SKILL.md", "a/\0", "a//b", "a/./b", "a/../b", "/a", "a/"]) expect(skillFilePathProblem(path)).toBeDefined();
  });

  it("refuses a path over 512 UTF-8 bytes, and a segment over 255", () => {
    expect(skillFilePathProblem(`a/${"x".repeat(255)}`)).toBeUndefined();
    expect(skillFilePathProblem(`a/${"x".repeat(256)}`)).toMatch(/255/);
    expect(skillFilePathProblem(`${"x/".repeat(256)}y`)).toMatch(/512/);
    // Bytes, not characters: 200 three-byte characters are 600 bytes.
    expect(skillFilePathProblem(`a/${"漢".repeat(90)}/${"漢".repeat(90)}`)).toMatch(/512/);
  });
});

describe("skillSetProblem", () => {
  it("takes a set whose paths all pass the rule", async () => {
    expect(skillSetProblem(await skillSetOf({ "a/SKILL.md": "x", "a/b/c.md": "y" }))).toBeUndefined();
  });

  it("names the first path the rule refuses, and a path that is both a file and a directory", () => {
    expect(skillSetProblem({ hash: "h", files: { "a/SKILL.md": "x", "a\\b": "y" } })).toMatch(/a\\b/);
    expect(skillSetProblem({ hash: "h", files: { "a/b": "x", "a/b/c": "y" } })).toMatch(/also a directory/);
  });

  it("refuses what is not a set", () => {
    for (const value of [null, 3, { hash: "", files: {} }, { hash: "h" }, { hash: "h", files: { a: 1 } }]) expect(skillSetProblem(value)).toBeDefined();
  });
});
