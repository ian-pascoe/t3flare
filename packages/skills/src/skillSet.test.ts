// The Environment skill set as it travels (SPI-1148): its hash, and the path rule both the install and every Workspace
// apply, so a set the Environment keeps is always one a Workspace can mount.
import { describe, expect, it } from "vitest";

import { EMPTY_SKILL_SET_HASH, listingOfSet, sha256Hex, skillFilePathProblem, skillSetHash, skillSetOf, skillSetProblem, withEnvironmentSkills, withEnvironmentSkillsFor } from "./skillSet.ts";
import { environmentPrecedenceOf, type EnvironmentPrecedence } from "./cliRoots.ts";

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
    const fromDigests = await skillSetHash({}, { "a/SKILL.md": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881", "a/ref/notes.md": await sha256Hex("é漢") });
    expect(fromDigests).toBe(set.hash);
  });
});

describe("skillFilePathProblem", () => {
  it("takes a plain relative path", () => {
    expect(skillFilePathProblem("grill-me/SKILL.md")).toBeUndefined();
    expect(skillFilePathProblem("grill-me/references/a b.md")).toBeUndefined();
  });

  it("refuses a backslash, a NUL, and an empty, `.` or `..` segment", () => {
    for (const path of ["a\\b/SKILL.md", "a/\0", "a/b\nc", "a/\u001b", "a//b", "a/./b", "a/../b", "/a", "a/"]) expect(skillFilePathProblem(path)).toBeDefined();
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

describe("withEnvironmentSkills", () => {
  const repoSkill = (name: string, path = `/workspace/repo/.agents/skills/${name}/SKILL.md`) => ({ name, description: `Repo ${name}.`, filePath: path, disableModelInvocation: false });
  const repo = { skills: [repoSkill("fruit-code"), repoSkill("tdd")], skipped: [{ path: "/workspace/repo/.claude/skills/x/SKILL.md", reason: "no description" }], omitted: 2 };
  const environment = [{ name: "fruit-code", description: "The Environment's.", disableModelInvocation: true }];

  it("puts the Environment skills first, at the mount, and shadows a Repo skill of the same name", () => {
    expect(withEnvironmentSkills(environment, repo)).toEqual({
      skills: [{ name: "fruit-code", description: "The Environment's.", filePath: "/workspace/.agents/skills/fruit-code/SKILL.md", disableModelInvocation: true }, repoSkill("tdd")],
      skipped: [
        { path: "/workspace/repo/.agents/skills/fruit-code/SKILL.md", reason: '"fruit-code" is shadowed by the Environment skill fruit-code' },
        { path: "/workspace/repo/.claude/skills/x/SKILL.md", reason: "no description" },
      ],
      omitted: 2,
    });
  });

  it("un-shadows the Repo skill once the Environment skill is removed or disabled (absent from the rows)", () => {
    expect(withEnvironmentSkills([], repo).skills.map((skill) => skill.filePath)).toEqual(["/workspace/repo/.agents/skills/fruit-code/SKILL.md", "/workspace/repo/.agents/skills/tdd/SKILL.md"]);
  });

  it("drops what an older Workspace listed from its held set, whose rows may be gone", () => {
    const old = { ...repo, skills: [repoSkill("gone", "/workspace/.agents/skills/gone/SKILL.md"), ...repo.skills], skipped: [{ path: "/workspace/.agents/skills/x/SKILL.md", reason: "r" }] };
    expect(withEnvironmentSkills([], old)).toEqual({ skills: repo.skills, skipped: [], omitted: 2 });
  });
});

describe("withEnvironmentSkillsFor (SPI-1153: a CLI agent's own rule for a same-named pair, by the Repo skill's root)", () => {
  const repoSkill = (name: string, root: string) => ({ name, description: `Repo ${name}.`, filePath: `/workspace/repo/${root}/${name}/SKILL.md`, disableModelInvocation: false });
  const atMount = (name: string, description: string) => ({ name, description, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, disableModelInvocation: false });
  const environment = [
    { name: "dup", description: "The Environment's dup.", disableModelInvocation: false },
    { name: "e-env", description: "Only the Environment's.", disableModelInvocation: false },
  ];
  const merged = (precedence: EnvironmentPrecedence, root = ".claude/skills") =>
    withEnvironmentSkillsFor(() => precedence, environment, { skills: [repoSkill("dup", root), repoSkill("tdd", root)], skipped: [], omitted: 0 });

  it("environment: the Environment's first, its Repo namesake shadowed (Claude Code, pi, OpenCode's .agents/skills)", () => {
    const repo = { skills: [repoSkill("dup", ".claude/skills"), repoSkill("tdd", ".claude/skills")], skipped: [], omitted: 0 };
    expect(merged("environment")).toEqual(withEnvironmentSkills(environment, repo));
  });

  it("repo: the Repo's kept, the Environment's shadowed by it; an Environment skill without a namesake still listed first (OpenCode's .opencode/skills)", () => {
    expect(merged("repo")).toEqual({
      skills: [atMount("e-env", "Only the Environment's."), repoSkill("dup", ".claude/skills"), repoSkill("tdd", ".claude/skills")],
      skipped: [{ path: "/workspace/.agents/skills/dup/SKILL.md", reason: '"dup" is shadowed by the Repo skill at /workspace/repo/.claude/skills/dup/SKILL.md' }],
      omitted: 0,
    });
  });

  it("both: both of a pair listed, the Repo's first, as Codex lists them", () => {
    expect(merged("both")).toEqual({
      skills: [atMount("e-env", "Only the Environment's."), repoSkill("dup", ".claude/skills"), repoSkill("tdd", ".claude/skills"), atMount("dup", "The Environment's dup.")],
      skipped: [],
      omitted: 0,
    });
  });

  it("asks the rule of each Repo namesake, so two pairs from different roots settle apart", () => {
    const answer = withEnvironmentSkillsFor(
      (skill) => (skill.filePath.includes("/.opencode/") ? "repo" : "environment"),
      [
        { name: "a", description: "Env a.", disableModelInvocation: false },
        { name: "b", description: "Env b.", disableModelInvocation: false },
      ],
      { skills: [repoSkill("a", ".opencode/skills"), repoSkill("b", ".agents/skills")], skipped: [], omitted: 0 },
    );
    expect(answer.skills.map((skill) => skill.filePath)).toEqual(["/workspace/.agents/skills/b/SKILL.md", "/workspace/repo/.opencode/skills/a/SKILL.md"]);
  });

  it("drops what a Workspace listed at the mount, whatever the rule: the rows are the set", () => {
    const old = { skills: [atMount("gone", "Gone."), repoSkill("tdd", ".claude/skills")], skipped: [], omitted: 0 };
    for (const precedence of ["environment", "repo", "both"] as const) expect(withEnvironmentSkillsFor(() => precedence, [], old).skills).toEqual([repoSkill("tdd", ".claude/skills")]);
  });
});

describe("environmentPrecedenceOf (SPI-1153 M0, one Repo root at a time)", () => {
  it("is each CLI's winner by the root a Repo skill is in", () => {
    const at = (root: string) => `/workspace/repo/pkg/${root}/x/SKILL.md`;
    expect(environmentPrecedenceOf("opencode", at(".opencode/skills"))).toBe("repo");
    expect(environmentPrecedenceOf("opencode", at(".opencode/skill"))).toBe("repo");
    expect(environmentPrecedenceOf("opencode", at(".agents/skills"))).toBe("environment");
    expect(environmentPrecedenceOf("codex", at(".agents/skills"))).toBe("both");
    expect(environmentPrecedenceOf("codex", at(".codex/skills"))).toBe("both");
    expect(environmentPrecedenceOf("claude", at(".claude/skills"))).toBe("environment");
    expect(environmentPrecedenceOf("pi", at(".pi/skills"))).toBe("environment");
    expect(environmentPrecedenceOf("pi", at(".agents/skills"))).toBe("environment");
  });

  it("takes the deepest root a path is below, and the Environment's for a path in none", () => {
    expect(environmentPrecedenceOf("opencode", "/workspace/repo/.agents/skills/vendored/.opencode/skills/x/SKILL.md")).toBe("repo");
    expect(environmentPrecedenceOf("opencode", "/elsewhere/x/SKILL.md")).toBe("environment");
  });
});

describe("listingOfSet", () => {
  it("reads each top-level SKILL.md of a set as at the mount, skipping what is no Skill", () => {
    expect(
      listingOfSet({
        "b/SKILL.md": "---\nname: b\ndescription: B.\n---\n",
        "a/SKILL.md": "---\nname: a\ndescription: A.\ndisable-model-invocation: true\n---\n",
        "a/refs/SKILL.md": "---\nname: nested\ndescription: N.\n---\n",
        "c/SKILL.md": "no frontmatter",
      }),
    ).toEqual([
      { name: "a", description: "A.", filePath: "/workspace/.agents/skills/a/SKILL.md", disableModelInvocation: true },
      { name: "b", description: "B.", filePath: "/workspace/.agents/skills/b/SKILL.md", disableModelInvocation: false },
    ]);
  });
});
