// Fetching Environment skills from GitHub (SPI-1148): the preview, the fetch of the folders the owner picked, and the
// update check, over a fake GitHub that counts requests (some cases ported from cloudpid@47941c7c's
// `skill-fetch.test.ts`). Each request is bounded (plan §3.3), and the counts below say so.
import { describe, expect, it } from "vitest";

import { checkSkills, fetchSkills, GithubReadError, previewSkills, readSkillMd } from "../src/skills/fetch.ts";
import { parseSkillSource } from "../src/skills/source.ts";
import { fakeGithub, skillMd } from "./skillRepo.fixture.ts";

const source = (text: string) => {
  const parsed = parseSkillSource(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.source;
};
const REPO = { owner: "o", name: "r" };

describe("readSkillMd", () => {
  it("reads the name, description, internal mark and disable-model-invocation", () => {
    expect(readSkillMd("---\nname: a\ndescription: Does a.\ndisable-model-invocation: true\nmetadata:\n  internal: true\n---\nBody")).toEqual({
      ok: true,
      name: "a",
      description: "Does a.",
      internal: true,
      disableModelInvocation: true,
    });
  });

  it("requires a name (no folder fallback, unlike a Repo skill) and a description of at most 1,024 characters", () => {
    expect(readSkillMd("---\ndescription: Does a.\n---\n")).toEqual({ ok: false, message: "SKILL.md's frontmatter sets no name" });
    expect(readSkillMd("---\nname: a\n---\n")).toEqual({ ok: false, message: "SKILL.md's frontmatter sets no description" });
    expect(readSkillMd(`---\nname: a\ndescription: ${"d".repeat(1025)}\n---\n`)).toEqual({ ok: false, message: "SKILL.md's description is 1025 characters, more than the 1024 it may be" });
    expect(readSkillMd("no frontmatter")).toEqual({ ok: false, message: "SKILL.md has no frontmatter" });
  });
});

describe("previewSkills", () => {
  it("lists a repo's Skills at the commit its ref resolves to, reading only their SKILL.md", async () => {
    const github = fakeGithub();
    const commit = github.push("o/r", {
      "skills/grill-me/SKILL.md": skillMd("grill-me"),
      "skills/grill-me/refs/a.md": "A",
      "skills/tdd/SKILL.md": skillMd("tdd"),
      "README.md": "hi",
    });
    const preview = await previewSkills(github.reader, source("o/r"));
    expect(preview).toMatchObject({ status: "listed", repo: "o/r", ref: null, commit, internal: 0, omitted: 0, unreadable: [] });
    if (preview.status !== "listed") return;
    expect(preview.skills.map(({ name, path, files, problems }) => ({ name, path, files, problems }))).toEqual([
      { name: "grill-me", path: "skills/grill-me", files: 2, problems: [] },
      { name: "tdd", path: "skills/tdd", files: 1, problems: [] },
    ]);
    expect(github.requests).toEqual(["commit o/r@HEAD", `tree o/r@${commit.slice(0, 7)}`, expect.stringMatching(/^blob /), expect.stringMatching(/^blob /)]);
  });

  it("finds one Skill by @name or a tree URL's folder, and an internal one only when named", async () => {
    const github = fakeGithub();
    github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/b/SKILL.md": skillMd("b", "x", "metadata:\n  internal: true\n") }, "v1");
    const all = await previewSkills(github.reader, source("https://github.com/o/r/tree/v1"));
    expect(all.status === "listed" && { names: all.skills.map((skill) => skill.name), internal: all.internal }).toEqual({ names: ["a"], internal: 1 });
    const named = await previewSkills(github.reader, source("https://github.com/o/r/tree/v1/skills/b"));
    expect(named.status === "listed" && named.skills.map((skill) => skill.name)).toEqual([]);
    github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/b/SKILL.md": skillMd("b", "x", "metadata:\n  internal: true\n") });
    const byName = await previewSkills(github.reader, source("o/r@b"));
    expect(byName.status === "listed" && byName.skills.map((skill) => skill.name)).toEqual(["b"]);
    expect(await previewSkills(github.reader, source("o/r@nope"))).toEqual({ status: "failed", kind: "no_match", message: 'o/r has no Skill named "nope".' });
  });

  it("marks a Skill the checks refuse, from the tree and its SKILL.md, without reading its other files", async () => {
    const github = fakeGithub();
    github.push("o/r", {
      "skills/Bad_Name/SKILL.md": skillMd("Bad_Name"),
      "skills/linked/SKILL.md": skillMd("linked"),
      "skills/linked/run.sh": { link: "/etc/passwd" },
      "skills/linked/vendor": { submodule: true },
      "skills/big/SKILL.md": skillMd("big"),
      "skills/big/data.txt": "x".repeat(1_572_865),
      "skills/leaky/SKILL.md": skillMd("leaky", "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    });
    const preview = await previewSkills(github.reader, source("o/r"));
    if (preview.status !== "listed") throw new Error(preview.message);
    expect(Object.fromEntries(preview.skills.map((skill) => [skill.name, skill.problems]))).toEqual({
      Bad_Name: ['"Bad_Name" may hold only lowercase letters, digits and hyphens'],
      linked: ["run.sh: a link or a submodule; a Skill may hold neither", "vendor: a link or a submodule; a Skill may hold neither"],
      big: ["data.txt: 1572865 bytes, more than the 1572864 a Skill's file may be"],
      leaky: [expect.stringMatching(/^SKILL\.md: matches .*, which looks like a credential or a local path$/)],
    });
    // Each SKILL.md once; no data file.
    expect(github.blobs()).toBe(4);
  });

  it("lists a SKILL.md that is no Skill apart, and tells a ref the repo lacks from a repo it cannot read", async () => {
    const github = fakeGithub();
    github.push("o/r", { "skills/a/SKILL.md": "---\ndescription: no name\n---\n", "skills/b/SKILL.md": skillMd("b") });
    const preview = await previewSkills(github.reader, source("o/r"));
    expect(preview.status === "listed" && preview.unreadable).toEqual([{ path: "skills/a", message: "SKILL.md's frontmatter sets no name" }]);
    expect(await previewSkills(github.reader, source("https://github.com/o/r/tree/nope"))).toEqual({
      status: "failed",
      kind: "bad_ref",
      message: 'o/r has no ref "nope" (a branch, a tag or a commit).',
    });
    expect(await previewSkills(github.reader, source("o/missing"))).toMatchObject({ status: "failed", kind: "not_found" });
  });

  it("refuses a truncated tree and a repo with no Skill, and passes a reader's failure on", async () => {
    const github = fakeGithub();
    github.push("o/r", { "README.md": "hi" });
    expect(await previewSkills(github.reader, source("o/r"))).toEqual({ status: "failed", kind: "no_skills", message: "o/r holds no Skill (no folder with a SKILL.md)." });
    github.truncate(true);
    expect(await previewSkills(github.reader, source("o/r"))).toMatchObject({ status: "failed", kind: "truncated" });
    github.truncate(false);
    github.fail("o/r", new GithubReadError("rate_limited", "GitHub asked t3flare to slow down: try again in 30 seconds."));
    expect(await previewSkills(github.reader, source("o/r"))).toEqual({ status: "failed", kind: "rate_limited", message: "GitHub asked t3flare to slow down: try again in 30 seconds." });
    github.fail("o/r", new Error("a bug"));
    await expect(previewSkills(github.reader, source("o/r"))).rejects.toThrow("a bug");
  });

  it("reads at most 200 SKILL.md files and counts the rest", async () => {
    const github = fakeGithub();
    github.push("o/r", Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`skills/s${index}/SKILL.md`, skillMd(`s${index}`)])));
    const preview = await previewSkills(github.reader, source("o/r"));
    expect(preview.status === "listed" && { listed: preview.skills.length, omitted: preview.omitted }).toEqual({ listed: 200, omitted: 5 });
    expect(github.blobs()).toBe(200);
  });
});

describe("fetchSkills", () => {
  it("reads the picked folders whole at the previewed commit, with each file's blob, size and SHA-256", async () => {
    const github = fakeGithub();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/refs/x.md": "x", "skills/b/SKILL.md": skillMd("b") });
    github.push("o/r", { "skills/a/SKILL.md": skillMd("a", "moved on") });
    const fetched = await fetchSkills(github.reader, { repo: REPO, commit, folders: ["skills/a"] });
    if (fetched.status !== "fetched") throw new Error(fetched.message);
    expect(fetched.refused).toEqual([]);
    const [skill] = fetched.skills;
    expect(skill).toMatchObject({ name: "a", description: "What a does.", path: "skills/a", disableModelInvocation: false, bytes: skillMd("a").length + 1 });
    expect(Object.keys(skill!.files).sort()).toEqual(["SKILL.md", "refs/x.md"]);
    // SHA-256 of "x", a known value.
    expect(skill!.files["refs/x.md"]).toMatchObject({ text: "x", size: 1, sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" });
    expect(skill!.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a folder whose files the checks refuse, reading the others; and one with no SKILL.md", async () => {
    const github = fakeGithub();
    const commit = github.push("o/r", {
      "skills/a/SKILL.md": skillMd("a"),
      "skills/leaky/SKILL.md": skillMd("leaky"),
      "skills/leaky/env.md": "AKIAABCDEFGHIJKLMNOP",
      "skills/bin/SKILL.md": skillMd("bin"),
      "skills/bin/x.bin": "a\u0000b",
    });
    const fetched = await fetchSkills(github.reader, { repo: REPO, commit, folders: ["skills/a", "skills/leaky", "skills/bin", "skills/gone"] });
    if (fetched.status !== "fetched") throw new Error(fetched.message);
    expect(fetched.skills.map((skill) => skill.name)).toEqual(["a"]);
    expect(fetched.refused).toEqual([
      { path: "skills/gone", message: `o/r/skills/gone holds no SKILL.md at ${commit.slice(0, 7)}` },
      { path: "skills/leaky", message: expect.stringMatching(/^leaky: env\.md: matches .*, which looks like a credential or a local path$/) },
      { path: "skills/bin", message: "bin: x.bin: a binary file; a Skill holds text only" },
    ]);
  });

  it("refuses a folder before reading its other files when the tree says it is too large (its SKILL.md is 53 bytes)", async () => {
    const github = fakeGithub();
    const commit = github.push("o/r", { "skills/big/SKILL.md": skillMd("big"), "skills/big/a.txt": "x".repeat(1_500_000), "skills/big/b.txt": "y".repeat(1_500_000), "skills/big/c.txt": "z".repeat(1_500_000) });
    github.reset();
    const fetched = await fetchSkills(github.reader, { repo: REPO, commit, folders: ["skills/big"] });
    expect(fetched).toEqual({ status: "fetched", commit, skills: [], refused: [{ path: "skills/big", message: "big: the files are 4500053 bytes together, more than the 4194304 a Skill may be" }] });
    // Its SKILL.md alone.
    expect(github.blobs()).toBe(1);
  });

  it("refuses more than 500 files in one request before any read", async () => {
    const github = fakeGithub();
    const files: Record<string, string> = {};
    for (const skill of ["a", "b"]) {
      files[`skills/${skill}/SKILL.md`] = skillMd(skill);
      for (let index = 0; index < 260; index++) files[`skills/${skill}/f${index}.md`] = `${skill}${index}`;
    }
    const commit = github.push("o/r", files);
    github.reset();
    expect(await fetchSkills(github.reader, { repo: REPO, commit, folders: ["skills/a", "skills/b"] })).toEqual({
      status: "failed",
      kind: "too_many",
      message: "These skills hold 522 files; install at most 500 files at a time.",
    });
    expect(github.blobs()).toBe(0);
  });

  it("asks the reader before its blobs, so an unauthenticated limit that would run out stops it first", async () => {
    const github = fakeGithub();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/x.md": "x" });
    const asked: Array<number> = [];
    const reader = {
      ...github.reader,
      beforeBlobs: async (reads: number) => {
        asked.push(reads);
        throw new GithubReadError("rate_limited", "GitHub's unauthenticated limit has 1 request left.");
      },
    };
    github.reset();
    expect(await fetchSkills(reader, { repo: REPO, commit, folders: ["skills/a"] })).toEqual({ status: "failed", kind: "rate_limited", message: "GitHub's unauthenticated limit has 1 request left." });
    expect(asked).toEqual([2]);
    expect(github.blobs()).toBe(0);
  });
});

describe("checkSkills", () => {
  it("answers current, an update with its changed files, and gone, from one commit and one tree", async () => {
    const github = fakeGithub();
    const first = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/x.md": "x", "skills/a/y.md": "y", "skills/b/SKILL.md": skillMd("b"), "skills/c/SKILL.md": skillMd("c") });
    const fetched = await fetchSkills(github.reader, { repo: REPO, commit: first, folders: ["skills/a", "skills/b", "skills/c"] });
    if (fetched.status !== "fetched") throw new Error(fetched.message);
    const kept = fetched.skills.map((skill) => ({ name: skill.name, path: skill.path, digest: skill.digest, files: Object.fromEntries(Object.entries(skill.files).map(([path, file]) => [path, file.blob])) }));
    const second = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/x.md": "x2", "skills/a/z.md": "z", "skills/b/SKILL.md": skillMd("b") });
    github.reset();
    expect(await checkSkills(github.reader, { repo: REPO, ref: null, kept })).toEqual({
      status: "checked",
      commit: second,
      results: [
        { name: "a", status: "update", added: ["z.md"], changed: ["x.md"], removed: ["y.md"] },
        { name: "b", status: "current" },
        { name: "c", status: "gone", message: "No longer in o/r at the default branch" },
      ],
    });
    expect(github.requests).toEqual(["commit o/r@HEAD", `tree o/r@${second.slice(0, 7)}`]);
  });
});
