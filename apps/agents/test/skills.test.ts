// The `skills` extension (SPI-1147 §2): the section's text from the Workspace's discovery, empty frozen as empty, and
// the extension installs in a registry as SessionDO's does (M0: `frozenSection` in the Session's registry).
import { createRegistry } from "@earendil-works/pi-durable";
import type { WireSkillDiscovery } from "@t3flare/computer-env";
import { afterEach, describe, expect, it, vi } from "vitest";

import { skillsExtension, skillsSectionText } from "../src/extensions/skills.ts";
import { workspaceSkills } from "../src/workspace/skills.ts";

const workspace = (answer: WireSkillDiscovery) => ({ cwd: "/workspace/repo", discoverSkills: () => Promise.resolve(answer) }) as never;
const fruit = { name: "fruit-code", description: "The fruit code.", filePath: "/workspace/repo/.agents/skills/fruit-code/SKILL.md", disableModelInvocation: false };

describe("the skills section", () => {
  it("lists the Workspace's skills in a <skills> block", async () => {
    const text = await skillsSectionText(workspace({ skills: [fruit, { ...fruit, name: "owner-only", disableModelInvocation: true }], skipped: [], omitted: 0 }));
    expect(text).toMatch(/^<skills>\nThe following skills/);
    expect(text).toContain("<location>/workspace/repo/.agents/skills/fruit-code/SKILL.md</location>");
    expect(text).not.toContain("owner-only");
    expect(text).toMatch(/<\/available_skills>\n<\/skills>$/);
  });

  it("is empty, a text that freezes, when nothing is listed; absent without a Workspace", async () => {
    expect(await skillsSectionText(workspace({ skills: [], skipped: [], omitted: 0 }))).toBe("");
    expect(await skillsSectionText(undefined)).toBeUndefined();
    expect(await skillsSectionText({ cwd: "/" } as never)).toBeUndefined();
  });

  it("installs in a registry", () => {
    const registry = createRegistry();
    expect(() => registry.install(skillsExtension())).not.toThrow();
  });
});

describe("the Workspace DO's discovery log", () => {
  const ROOT = "/workspace/repo";
  /** A `ReadEnv` over `files` (absolute path to text), listing every file below a directory. */
  const readEnv = (files: Record<string, string>) =>
    ({
      cwd: ROOT,
      listFiles: (directory: string) => {
        const entries = Object.keys(files)
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => ({ path: path.slice(directory.length + 1), kind: "file" as const }));
        return Promise.resolve(entries.length === 0 ? { ok: false, error: { code: "not_found", message: "absent" } } : { ok: true, value: { entries, truncated: false } });
      },
      readTextFile: (path: string) => Promise.resolve(path in files ? { ok: true, value: files[path] } : { ok: false, error: { code: "not_found", message: "absent" } }),
    }) as never;
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;
  const lines = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"t3flare":"skills"'));

  afterEach(() => vi.restoreAllMocks());

  it("writes one skills line when anything was skipped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const found = await workspaceSkills(
      readEnv({
        [`${ROOT}/.agents/skills/a/SKILL.md`]: skill("a", "first"),
        [`${ROOT}/.claude/skills/a/SKILL.md`]: skill("a", "loses"),
        [`${ROOT}/.claude/skills/b/SKILL.md`]: "no frontmatter",
      }),
      ROOT,
      [],
    );
    expect(found.skipped).toHaveLength(2);
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!)).toMatchObject({ t3flare: "skills", cwd: ROOT, skills: 1, omitted: 0, skippedCount: 2 });
  });

  it("writes none when nothing was skipped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await workspaceSkills(readEnv({ [`${ROOT}/.agents/skills/a/SKILL.md`]: skill("a", "only") }), ROOT, []);
    expect(lines()).toEqual([]);
  });
});
