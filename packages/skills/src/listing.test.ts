// The agent's `<available_skills>` listing (SPI-1147 §2), as pi's `formatSkillsForPrompt` writes it.
import { describe, expect, it } from "vitest";

import type { Skill } from "./discovery.ts";
import { formatSkills } from "./listing.ts";

const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name}'s description`,
  filePath: `/workspace/repo/.agents/skills/${name}/SKILL.md`,
  disableModelInvocation: false,
  ...extra,
});

describe("the listing", () => {
  it("lists each skill's name, description and SKILL.md path, escaped, as pi does", () => {
    expect(formatSkills({ skills: [skill("fruit-code", { description: "The <fruit> & \"code\"" })], omitted: 0 })).toBe(
      [
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>fruit-code</name>",
        "    <description>The &lt;fruit&gt; &amp; &quot;code&quot;</description>",
        "    <location>/workspace/repo/.agents/skills/fruit-code/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    );
  });

  it("leaves out a disable-model-invocation skill", () => {
    const text = formatSkills({ skills: [skill("listed"), skill("owner-only", { disableModelInvocation: true })], omitted: 0 });
    expect(text).toContain("<name>listed</name>");
    expect(text).not.toContain("owner-only");
  });

  it("ends with one line saying how many skills the cap left out", () => {
    const text = formatSkills({ skills: [skill("a")], omitted: 7 });
    expect(text.split("\n").at(-1)).toBe("7 more skills in this repository are not listed: at most 100 are.");
  });

  it("is empty when nothing is listed", () => {
    expect(formatSkills({ skills: [], omitted: 0 })).toBe("");
    expect(formatSkills({ skills: [skill("owner-only", { disableModelInvocation: true })], omitted: 0 })).toBe("");
  });
});
