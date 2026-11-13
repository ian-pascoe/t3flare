// The `skills` extension (SPI-1147 §2): the section's text from the Workspace's discovery, empty frozen as empty, and
// the extension installs in a registry as SessionDO's does (M0: `frozenSection` in the Session's registry).
import { createRegistry } from "@earendil-works/pi-durable";
import type { WireSkillDiscovery } from "@t3flare/computer-env";
import { describe, expect, it } from "vitest";

import { skillsExtension, skillsSectionText } from "../src/extensions/skills.ts";

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
