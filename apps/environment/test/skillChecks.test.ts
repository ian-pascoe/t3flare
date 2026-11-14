// The checks an Environment skill passes before it is kept (SPI-1148): each row of the ticket's table and each limit.
import { describe, expect, it } from "vitest";

import { MAX_FILE_BYTES, problemsIn, setProblem, skillNameProblem, treeProblems } from "../src/skills/checks.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("problemsIn", () => {
  it("takes UTF-8 text with nothing that looks like a credential", () => {
    expect(problemsIn("SKILL.md", bytes("---\nname: a\n---\nRun `pnpm test` in é 漢.\n"))).toEqual([]);
  });

  it("refuses a NUL, text that is not UTF-8, and a file over 1,536 KiB", () => {
    expect(problemsIn("x.bin", new Uint8Array([65, 0, 66]))).toEqual(["x.bin: a binary file; a Skill holds text only"]);
    expect(problemsIn("x.txt", new Uint8Array([0xc3, 0x28]))).toEqual(["x.txt: not UTF-8 text; a Skill holds text only"]);
    expect(problemsIn("big.txt", new Uint8Array(MAX_FILE_BYTES + 1).fill(65))).toEqual([`big.txt: ${MAX_FILE_BYTES + 1} bytes, more than the 1572864 a Skill's file may be`]);
    expect(problemsIn("ok.txt", new Uint8Array(MAX_FILE_BYTES).fill(65))).toEqual([]);
  });

  it("names the file that looks like a credential or a local path", () => {
    for (const text of ["key: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "AKIAABCDEFGHIJKLMNOP", "-----BEGIN RSA PRIVATE KEY-----", 'token = "abcdefghijklmnopqrstuvwxyz"', "see /Users/ian/notes"]) {
      const found = problemsIn("refs/env.md", bytes(text));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^refs\/env\.md: matches .*, which looks like a credential or a local path$/);
    }
  });
});

describe("skillNameProblem", () => {
  it("takes Agent Skills names with a letter", () => {
    for (const name of ["grill-me", "a", "tdd2", "x".repeat(64)]) expect(skillNameProblem(name)).toBeUndefined();
  });

  it("refuses the rest, each with its reason", () => {
    expect(skillNameProblem("")).toMatch(/empty/);
    expect(skillNameProblem("x".repeat(65))).toMatch(/65 characters, more than the 64/);
    expect(skillNameProblem("Grill_Me")).toMatch(/only lowercase letters, digits and hyphens/);
    for (const name of ["-a", "a-", "a--b"]) expect(skillNameProblem(name)).toMatch(/hyphen/);
    // Added by SPI-1148: t3's mention token needs a letter.
    expect(skillNameProblem("2024")).toBe('"2024" needs at least one letter, so t3 can mention it');
  });
});

describe("treeProblems", () => {
  it("takes a Skill within its limits", () => {
    expect(treeProblems("a", [{ relative: "SKILL.md", size: 100 }, { relative: "refs/b.md", size: 100 }], [])).toEqual([]);
  });

  it("refuses more than 500 files and more than 4 MiB together, before any is read", () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ relative: `f${index}.md`, size: 1 }));
    expect(treeProblems("a", many, [])).toEqual(["the folder holds 501 files, more than 500"]);
    const heavy = Array.from({ length: 3 }, (_, index) => ({ relative: `f${index}.md`, size: 1_500_000 }));
    expect(treeProblems("a", heavy, [])).toEqual(["the files are 4500000 bytes together, more than the 4194304 a Skill may be"]);
  });

  it("names a link or a submodule, and a path a Workspace would refuse (added by SPI-1148)", () => {
    expect(treeProblems("a", [{ relative: "SKILL.md", size: 1 }], ["run.sh"])).toEqual(["run.sh: a link or a submodule; a Skill may hold neither"]);
    expect(treeProblems("a", [{ relative: "x\\y.md", size: 1 }], [])).toEqual(["x\\y.md: the path has a backslash or a NUL"]);
    expect(treeProblems("a", [{ relative: `${"x".repeat(256)}.md`, size: 1 }], [])[0]).toMatch(/longer than 255 bytes/);
  });
});

describe("setProblem", () => {
  const kept = Array.from({ length: 99 }, (_, index) => ({ name: `s${index}`, bytes: 10 }));

  it("counts the kept skills, a replaced one once", () => {
    expect(setProblem(kept, [{ name: "new", bytes: 10 }])).toBeUndefined();
    expect(setProblem([...kept, { name: "x", bytes: 1 }], [{ name: "x", bytes: 5 }])).toBeUndefined();
    expect(setProblem([...kept, { name: "x", bytes: 1 }], [{ name: "y", bytes: 5 }])).toBe("the Environment would hold 101 skills, more than the 100 it may (disabled ones count)");
  });

  it("refuses more than 8 MiB together", () => {
    expect(setProblem([{ name: "a", bytes: 4_194_304 }], [{ name: "b", bytes: 4_194_304 }])).toBeUndefined();
    expect(setProblem([{ name: "a", bytes: 4_194_304 }], [{ name: "b", bytes: 4_194_305 }])).toBe(
      "the Environment's skills would be 8388609 bytes together, more than the 8388608 they may be (disabled ones count)",
    );
  });
});
