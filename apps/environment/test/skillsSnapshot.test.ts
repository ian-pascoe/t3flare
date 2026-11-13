// The composer's Skills and Slash commands for Pi Durable (SPI-1147 §3): `snapshotForCwd` answers a Workspace's Repo
// skills and Prompt templates, in t3 paths; nothing for a path that is no Workspace, or with the switch off.
import type { ServerProvider } from "@t3tools/contracts";
import type { PromptTemplate, SkillDiscovery } from "@t3flare/skills";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { piDurableSnapshotForCwd, type SkillsAccess } from "../src/provider/skills.ts";

const machine = { instanceId: "piDurable", skills: [], slashCommands: [], models: [] } as unknown as ServerProvider;
const discovery: SkillDiscovery = {
  skills: [
    { name: "fruit-code", description: "  The fruit code.  ", filePath: "/workspace/repo/.agents/skills/fruit-code/SKILL.md", disableModelInvocation: false },
    { name: "owner-only", description: "Only when named.", filePath: "/workspace/repo/.claude/skills/owner-only/SKILL.md", disableModelInvocation: true },
  ],
  skipped: [],
  omitted: 0,
};
const templates: ReadonlyArray<PromptTemplate> = [
  { name: "echo", description: "Reply with exactly: ECHO $1 ${2:-none}", filePath: "/workspace/repo/.pi/prompts/echo.md" },
  { name: "review", description: "", argumentHint: "<file> [focus]", filePath: "/workspace/repo/.pi/prompts/review.md" },
];

const access = (options: { enabled?: boolean } = {}): SkillsAccess & { asked: Array<string> } => {
  const asked: Array<string> = [];
  return {
    asked,
    enabled: () => options.enabled ?? true,
    locate: (cwd) => {
      const match = /^\/w\/(proj)(\/.*)?$/.exec(cwd);
      if (match === null) return undefined;
      return {
        id: match[1]!,
        inner: `/workspace/repo${match[2] ?? ""}`,
        workspace: {
          skills: (inner) => (asked.push(`skills ${inner}`), Promise.resolve(discovery)),
          prompts: (inner) => (asked.push(`prompts ${inner}`), Promise.resolve(templates)),
          readText: () => Promise.resolve(null),
        },
      };
    },
  };
};

const snapshot = (cwd: string, skills: SkillsAccess) => Effect.runPromise(piDurableSnapshotForCwd(machine, cwd, skills));

describe("Pi Durable's snapshotForCwd", () => {
  it("answers the Workspace's skills, scope project, in t3 paths, with userInvocationOnly from disable-model-invocation", async () => {
    const skills = access();
    const answer = await snapshot("/w/proj", skills);
    expect(answer.skills).toEqual([
      { name: "fruit-code", description: "The fruit code.", path: "/w/proj/.agents/skills/fruit-code/SKILL.md", scope: "project", enabled: true, userInvocationOnly: false },
      { name: "owner-only", description: "Only when named.", path: "/w/proj/.claude/skills/owner-only/SKILL.md", scope: "project", enabled: true, userInvocationOnly: true },
    ]);
    expect(skills.asked).toEqual(["skills /workspace/repo", "prompts /workspace/repo"]);
    expect(answer.instanceId).toBe("piDurable");
    expect(answer.slashCommandsPending).toBe(false);
  });

  it("answers the Prompt templates as Slash commands, with their argument hints", async () => {
    const answer = await snapshot("/w/proj/sub", access());
    expect(answer.slashCommands).toEqual([
      { name: "echo", description: "Reply with exactly: ECHO $1 ${2:-none}" },
      { name: "review", input: { hint: "<file> [focus]" } },
    ]);
  });

  it("is empty for a path that is no Workspace, and with the switch off, and asks no Workspace", async () => {
    for (const [cwd, skills] of [
      ["/somewhere/else", access()],
      ["/w/proj", access({ enabled: false })],
    ] as const) {
      const answer = await snapshot(cwd, skills);
      expect(answer.skills).toEqual([]);
      expect(answer.slashCommands).toEqual([]);
      expect(skills.asked).toEqual([]);
    }
  });
});
