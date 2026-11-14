// The Harness panel's Environment skills API (SPI-1148, plan §5), through `handleHarness` with a fake GitHub: the
// guards, preview (replaces, unchanged), install at the previewed commit, view, check and update, remove and enable.
import { describe, expect, it } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessCaller } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";
import { OTHER_FILES_NOTE } from "../src/skills/api.ts";
import { skillStore } from "../src/skills/store.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { fakeGithub, skillMd } from "./skillRepo.fixture.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 14, 10, 30);
const owner: HarnessCaller = { kind: "owner", subject: "owner-sub" };

const memory = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
};

const setup = (caller: HarnessCaller = { kind: "service-token" }) => {
  const kv = memory();
  const store = harnessStore(kv);
  const skills = skillStore({ sql: nodeSqlStorage(), transactionSync: (closure) => closure(), harness: store, kv });
  const github = fakeGithub();
  const deps = {
    caller,
    host: HOST,
    store,
    now: () => NOW,
    skills: { store: skills, reader: async () => ({ reader: github.reader, how: "installation" as const }), unauthenticated: () => false },
  };
  return { store, skills, github, deps };
};

const post = (deps: ReturnType<typeof setup>["deps"], path: string, body: unknown, headers: Record<string, string> = {}) =>
  handleHarness(
    new Request(`https://${HOST}/_t3flare/harness/api/skills/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    deps,
  );
const postJson = async (deps: ReturnType<typeof setup>["deps"], path: string, body: unknown) => {
  const response = await post(deps, path, body);
  return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? ((await response.json()) as any) : await response.text() };
};
const get = async (deps: ReturnType<typeof setup>["deps"], path: string) => (await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/${path}`), deps)).json() as Promise<any>;

describe("Environment skills API", () => {
  it("previews, then installs what was previewed at its commit, even after the ref moves", async () => {
    const { github, deps, store } = setup();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/x.md": "x", "skills/b/SKILL.md": skillMd("b") });
    const preview = await postJson(deps, "preview", { source: "o/r" });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ commit, how: "installation", note: OTHER_FILES_NOTE, skills: [{ name: "a", path: "skills/a", files: 2, problems: [] }, { name: "b" }] });
    expect(preview.body.skills[0].replaces).toBeUndefined();
    github.push("o/r", { "skills/a/SKILL.md": skillMd("a", "moved"), "skills/b/SKILL.md": skillMd("b") });
    const installed = await postJson(deps, "install", { source: "o/r", commit, folders: ["skills/a"] });
    expect(installed.body.results).toEqual([{ name: "a", path: "skills/a", action: "skill-install" }]);
    const list = await get(deps, "skills");
    expect(list.skills).toMatchObject([{ name: "a", repo: "o/r", path: "skills/a", ref: null, commit, enabled: true, files: 2 }]);
    expect(list.totals).toMatchObject({ count: 1, enabled: 1, disabled: 0, maxBytes: 8_388_608, maxSkills: 100 });
    expect(store.loadEnvironment().revision).toBe(1);
  });

  it("says unchanged for the same skill and source, and 'replaces' for a same-named skill from elsewhere", async () => {
    const { github, deps } = setup();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    await postJson(deps, "install", { source: "o/r", commit, folders: ["skills/a"] });
    expect((await postJson(deps, "preview", { source: "o/r" })).body.skills[0]).toMatchObject({ name: "a", unchanged: true });
    github.push("x/y", { "a/SKILL.md": skillMd("a", "other") });
    expect((await postJson(deps, "preview", { source: "x/y" })).body.skills[0]).toMatchObject({ name: "a", replaces: { repo: "o/r", path: "skills/a", ref: null, commit: commit.slice(0, 7) } });
  });

  it("views SKILL.md as text and the other files with their GitHub URLs at the commit", async () => {
    const { github, deps } = setup();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a", "<script>x</script>"), "skills/a/refs/x y.md": "x" });
    await postJson(deps, "install", { source: "o/r", commit, folders: ["skills/a"] });
    const view = await get(deps, "skills/view?name=a");
    expect(view.skillMd).toBe(skillMd("a", "<script>x</script>"));
    expect(view.files).toEqual([
      { path: "SKILL.md", size: skillMd("a", "<script>x</script>").length, url: `https://github.com/o/r/blob/${commit}/skills/a/SKILL.md` },
      { path: "refs/x y.md", size: 1, url: `https://github.com/o/r/blob/${commit}/skills/a/refs/x%20y.md` },
    ]);
  });

  it("checks for updates by repo and ref, then updates with the old and new commit and the changed files", async () => {
    const { github, deps } = setup();
    const first = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/x.md": "x", "skills/b/SKILL.md": skillMd("b") });
    await postJson(deps, "install", { source: "o/r", commit: first, folders: ["skills/a", "skills/b"] });
    const second = github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/a/x.md": "x2", "skills/b/SKILL.md": skillMd("b") });
    github.reset();
    const checked = await postJson(deps, "check", {});
    expect(checked.body.results).toEqual([
      { name: "a", status: "update", added: [], changed: ["x.md"], removed: [], from: first.slice(0, 7), commit: second, to: second.slice(0, 7) },
      { name: "b", status: "current", from: first.slice(0, 7) },
    ]);
    // One group: one commit and one tree.
    expect(github.requests).toHaveLength(2);
    expect(checked.body.how).toBe("installation");
    const updated = await postJson(deps, "update", { name: "a", commit: second });
    expect(updated.body).toMatchObject({ name: "a", action: "skill-update", from: first, to: second, added: [], changed: ["x.md"], removed: [] });
  });

  it("says when an update check read without a token, as the preview does (plan §3.2)", async () => {
    const { github, deps } = setup();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    await postJson(deps, "install", { source: "o/r", commit, folders: ["skills/a"] });
    const unauthenticated = { ...deps, skills: { ...deps.skills, reader: async () => ({ reader: github.reader, how: "unauthenticated" as const }) } };
    expect((await postJson(unauthenticated, "check", {})).body).toMatchObject({ how: "unauthenticated", results: [{ name: "a", status: "current" }] });
  });

  it("refuses an update whose folder is gone or whose name changed, keeping the skill", async () => {
    const { github, deps, skills } = setup();
    const first = github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    await postJson(deps, "install", { source: "o/r", commit: first, folders: ["skills/a"] });
    const renamed = github.push("o/r", { "skills/a/SKILL.md": skillMd("a-two") });
    expect(await postJson(deps, "update", { name: "a", commit: renamed })).toEqual({
      status: 422,
      body: `a was not updated: at ${renamed.slice(0, 7)} its SKILL.md names it a-two. Install it under that name; removing a is your choice.\n`,
    });
    const gone = github.push("o/r", { "README.md": "moved away" });
    expect((await postJson(deps, "check", {})).body.results).toEqual([{ name: "a", status: "gone", message: "No longer in o/r at the default branch", from: first.slice(0, 7) }]);
    expect(await postJson(deps, "update", { name: "a", commit: gone })).toEqual({
      status: 422,
      body: `a was not updated, and is kept at ${first.slice(0, 7)}: o/r/skills/a holds no SKILL.md at ${gone.slice(0, 7)}\n`,
    });
    expect(skills.get("a")?.commit).toBe(first);
  });

  it("refuses an install over the request's 500 files as the request's own limit (422), keeping nothing", async () => {
    const { github, deps, skills } = setup();
    const files: Record<string, string> = {};
    for (const skill of ["a", "b"]) {
      files[`skills/${skill}/SKILL.md`] = skillMd(skill);
      for (let index = 0; index < 300; index++) files[`skills/${skill}/f${index}.md`] = `${skill}${index}`;
    }
    const commit = github.push("o/r", files);
    expect(await postJson(deps, "install", { source: "o/r", commit, folders: ["skills/a", "skills/b"] })).toEqual({ status: 422, body: "These skills hold 602 files; install at most 500 files at a time.\n" });
    expect(skills.list()).toEqual([]);
  });

  it("removes and switches a skill, each audited", async () => {
    const { github, deps, store } = setup();
    const commit = github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    await postJson(deps, "install", { source: "o/r", commit, folders: ["skills/a"] });
    expect((await postJson(deps, "enable", { name: "a", enabled: false })).body).toMatchObject({ ok: true, action: "skill-disable" });
    expect((await get(deps, "skills")).totals).toMatchObject({ count: 1, enabled: 0, disabled: 1, disabledBytes: skillMd("a").length });
    expect((await postJson(deps, "remove", { name: "a" })).body).toMatchObject({ ok: true, action: "skill-remove" });
    expect(await postJson(deps, "remove", { name: "a" })).toEqual({ status: 404, body: "no Environment skill is named a.\n" });
    expect(store.auditLog(10).map((entry) => entry.action)).toEqual(["skill-remove", "skill-disable", "skill-install"]);
  });

  it("answers GitHub's failure whole, and refuses a source it cannot parse", async () => {
    const { deps } = setup();
    expect(await postJson(deps, "preview", { source: "o/missing" })).toEqual({ status: 502, body: "GitHub has no repo o/missing or no ref null\n" });
    const bad = await postJson(deps, "preview", { source: "not a source" });
    expect(bad).toEqual({
      status: 400,
      body: '"not a source" is not a source to install from: it is not a GitHub repo. Use `owner/repo`, `owner/repo@skill`, or a GitHub URL such as `https://github.com/owner/repo/tree/<ref>/<path>`.\n',
    });
  });

  it("puts every write behind the panel's guards: JSON only, the host's Origin, and the owner's CSRF token", async () => {
    const { deps, store } = setup(owner);
    expect((await post(deps, "preview", "source=o/r", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(403);
    expect((await post(deps, "preview", { source: "o/r" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(deps, "preview", { source: "o/r" }, { origin: `https://${HOST}` })).status).toBe(403);
    expect((await post(deps, "preview", { source: "o/r" }, { origin: `https://${HOST}`, "sec-fetch-site": "cross-site", [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", NOW) })).status).toBe(403);
    expect((await post(deps, "nope", { source: "o/r" }, { origin: `https://${HOST}` })).status).toBe(404);
  });
});
