// Skill mentions and Slash commands in a Pi Durable message (SPI-1147 §4): `turnPrompt` expands them when its caller
// passes the thread's skills (the Pi Durable adapter, for a new turn and a steer), never for the ACP builder.
import * as NodeFs from "node:fs";

import type { ChatAttachment } from "@t3tools/contracts";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import type { PromptTemplate, Skill, SkillDiscovery } from "@t3flare/skills";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { type AttachmentReader, turnPrompt } from "../src/provider/attachments.ts";
import { messageSkillsFor, type MessageSkills, type SkillsAccess } from "../src/provider/skills.ts";

const SKILLS = "/workspace/repo/.agents/skills";
const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name} things`,
  filePath: `${SKILLS}/${name}/SKILL.md`,
  disableModelInvocation: false,
  ...extra,
});
const files: Record<string, string> = {
  [`${SKILLS}/fruit-code/SKILL.md`]: "---\nname: fruit-code\ndescription: The fruit code.\n---\n\nRead reference/code.md for the code.\n",
  [`${SKILLS}/veg/SKILL.md`]: "---\nname: veg\ndescription: Veg.\n---\nEat greens.",
  [`${SKILLS}/huge/SKILL.md`]: `---\nname: huge\ndescription: Huge.\n---\n${"h".repeat(130_000)}`,
  "/workspace/repo/.pi/prompts/echo.md": "---\ndescription: Echo\n---\nReply with exactly: ECHO $1 ${2:-none}",
};
const templates: ReadonlyArray<PromptTemplate> = [{ name: "echo", description: "Echo", filePath: "/workspace/repo/.pi/prompts/echo.md" }];

const fruitBlock = `<skill name="fruit-code" location="${SKILLS}/fruit-code/SKILL.md">\nReferences are relative to ${SKILLS}/fruit-code.\n\nRead reference/code.md for the code.\n</skill>`;
const vegBlock = `<skill name="veg" location="${SKILLS}/veg/SKILL.md">\nReferences are relative to ${SKILLS}/veg.\n\nEat greens.\n</skill>`;

const thread = (): MessageSkills & { loads: number } => {
  const state = {
    loads: 0,
    load: () =>
      Effect.sync(() => {
        state.loads++;
        return { skills: [skill("fruit-code"), skill("veg"), skill("huge")], templates, read: (path: string) => Effect.succeed(files[path] ?? null) };
      }),
  };
  return state;
};
const noFiles: AttachmentReader = { bytes: () => Effect.succeed(null), extractedText: () => Effect.succeed(null) };
/** `null`: no skills passed, as the ACP builder calls it. */
const expand = (text: string, skills: MessageSkills | null = thread(), attachments: ReadonlyArray<ChatAttachment> = []) =>
  Effect.runPromise(turnPrompt({ text, attachments }, { acceptsImages: true, reader: noFiles, ...(skills === null ? {} : { skills }) })).then((prompt) => prompt.text);

describe("Skill mentions", () => {
  it("appends a <skill name location> block for a $name, as t3's Pi provider does", async () => {
    expect(await expand("what is the code? $fruit-code")).toBe(`what is the code? $fruit-code\n\n${fruitBlock}`);
  });

  it("embeds two skills, and a repeated one once", async () => {
    expect(await expand("$fruit-code then $veg and $fruit-code again")).toBe(`$fruit-code then $veg and $fruit-code again\n\n${fruitBlock}\n\n${vegBlock}`);
  });

  it("leaves an unknown $foo, a URL and an inline code span untouched", async () => {
    for (const text of ["say $nope", "see https://example.com/?q=$fruit-code", "type `$fruit-code` to pick it", "type ` $fruit-code ` here"]) {
      expect(await expand(text)).toBe(text);
    }
  });

  it("names a skill whose body does not fit the 120,000-character budget, and does not embed it", async () => {
    expect(await expand("$huge please")).toBe(
      `$huge please\n\n[Skill "huge" is not embedded: it does not fit the message's 120,000-character budget. Its file is ${SKILLS}/huge/SKILL.md.]`,
    );
  });

  it("reads the thread's skills only for a message that could expand", async () => {
    const skills = thread();
    expect(await expand("a plain message", skills)).toBe("a plain message");
    expect(skills.loads).toBe(0);
    await expand("costs $5", skills);
    expect(skills.loads).toBe(1);
  });
});

describe("Slash commands", () => {
  it("expands a leading /skill:name with its arguments", async () => {
    expect(await expand("/skill:fruit-code tell me the code")).toBe(`${fruitBlock}\n\ntell me the code`);
    expect(await expand("/skill:fruit-code")).toBe(fruitBlock);
  });

  it("expands a leading /template with pi's substitution", async () => {
    expect(await expand("/echo a")).toBe("Reply with exactly: ECHO a none");
    expect(await expand(`/echo "a b" c`)).toBe("Reply with exactly: ECHO a b c");
  });

  it("leaves an unknown command, and one not at the start, as typed", async () => {
    expect(await expand("/nope a")).toBe("/nope a");
    expect(await expand("run /echo a")).toBe("run /echo a");
  });
});

describe("the caller's switch", () => {
  it("does not expand without the thread's skills (the ACP builder's turnPrompt)", async () => {
    expect(await expand("/skill:fruit-code x $veg", null)).toBe("/skill:fruit-code x $veg");
  });

  it("the ACP flavors build their prompts without skills", () => {
    const source = NodeFs.readFileSync(new URL("../src/provider/cli/acpDriver.ts", import.meta.url), "utf8");
    const call = /turnPrompt\(([\s\S]*?)\)\.pipe/.exec(source)?.[1];
    expect(call).toBeDefined();
    expect(call).not.toMatch(/skills/);
  });

  it("the Pi Durable adapter passes the thread's skills for a new turn and for a steer", () => {
    const source = NodeFs.readFileSync(new URL("../src/provider/adapter.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/turnPrompt\((turnInput|steerInput)\.message, \{([^}]*)\}\)/g)];
    expect(calls.map((match) => match[1])).toEqual(["turnInput", "steerInput"]);
    for (const match of calls) expect(match[2]).toMatch(/\bskills: threadSkills\b/);
  });

  it("expands nothing with the Harness switch off, or outside a Workspace", async () => {
    const discovery: SkillDiscovery = { skills: [skill("fruit-code")], skipped: [], omitted: 0 };
    const access = (enabled: boolean): SkillsAccess => ({
      enabled: () => enabled,
      locate: (cwd) =>
        cwd.startsWith("/w/proj")
          ? {
              id: "proj",
              inner: "/workspace/repo",
              workspace: { skills: () => Promise.resolve(discovery), prompts: () => Promise.resolve([]), readText: (path) => Promise.resolve(files[path] ?? null) },
            }
          : undefined,
    });
    expect(await expand("$fruit-code", messageSkillsFor("/w/proj", access(true)))).toBe(`$fruit-code\n\n${fruitBlock}`);
    expect(await expand("$fruit-code", messageSkillsFor("/w/proj", access(false)))).toBe("$fruit-code");
    expect(await expand("$fruit-code", messageSkillsFor("/elsewhere", access(true)))).toBe("$fruit-code");
  });
});

describe("upstream pins (U64)", () => {
  it("matchInlineSkills matches a $name after whitespace, with a letter, up to whitespace", () => {
    const skills = [{ name: "fruit-code" }, { name: "ns:tool_1" }];
    const names = (text: string) => [...matchInlineSkills(text, skills)].map((match) => match.rawText);
    expect(names("$fruit-code and $ns:tool_1")).toEqual(["$fruit-code", "$ns:tool_1"]);
    expect(names("x$fruit-code $fruit-code. `$fruit-code` $5 $nope")).toEqual([]);
  });

  it("t3's composer inserts `$<name> ` for a picked skill (ChatComposer.tsx)", () => {
    const source = NodeFs.readFileSync(new URL("../../../t3code/apps/web/src/components/chat/ChatComposer.tsx", import.meta.url), "utf8");
    expect(source, "t3's composer changed what it inserts for a skill; re-read U64").toContain('if (item.type === "skill") {\n      const replacement = `$${item.skill.name} `;');
  });
});
