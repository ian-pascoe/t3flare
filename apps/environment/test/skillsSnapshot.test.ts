// The composer's Skills and Slash commands for Pi Durable (SPI-1147 §3): `snapshotForCwd` answers a Workspace's Repo
// skills and Prompt templates, in t3 paths; nothing for a path that is no Workspace, or with the switch off. SPI-1151:
// a CLI agent's, at its own roots, after its built-in commands.
import type { ServerProvider } from "@t3tools/contracts";
import type { CliAgent, PromptTemplate, SkillDiscovery } from "@t3flare/skills";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { cliSnapshotForCwd, piDurableSnapshotForCwd, type SkillsAccess } from "../src/provider/skills.ts";

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

const access = (options: { enabled?: boolean; rows?: Array<{ name: string; description: string; disableModelInvocation: boolean }> } = {}): SkillsAccess & { asked: Array<string> } => {
  const asked: Array<string> = [];
  return {
    asked,
    enabled: () => options.enabled ?? true,
    ...(options.rows === undefined ? {} : { environment: { entries: () => options.rows!, skillMd: () => undefined, hash: () => "h" } }),
    locate: (cwd) => {
      const match = /^\/w\/(proj)(\/.*)?$/.exec(cwd);
      if (match === null) return undefined;
      return {
        id: match[1]!,
        inner: `/workspace/repo${match[2] ?? ""}`,
        workspace: {
          skills: (inner, agent, opts) =>
            (asked.push(`skills ${inner}${agent === undefined ? "" : ` ${agent}`}${opts?.repoOnly === true ? " repo-only" : ""}`), Promise.resolve(discovery)),
          prompts: (inner, agent) => (asked.push(`prompts ${inner}${agent === undefined ? "" : ` ${agent}`}`), Promise.resolve(templates)),
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
    expect(skills.asked).toEqual(["skills /workspace/repo repo-only", "prompts /workspace/repo"]);
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

  it("puts the Environment skills first, scope user, at the Workspace's mount, beating a Repo skill of the same name (SPI-1148)", async () => {
    const answer = await snapshot("/w/proj", access({ rows: [{ name: "fruit-code", description: "The Environment's.", disableModelInvocation: true }] }));
    expect(answer.skills).toEqual([
      { name: "fruit-code", description: "The Environment's.", path: "/workspace/.agents/skills/fruit-code/SKILL.md", scope: "user", enabled: true, userInvocationOnly: true },
      { name: "owner-only", description: "Only when named.", path: "/w/proj/.claude/skills/owner-only/SKILL.md", scope: "project", enabled: true, userInvocationOnly: true },
    ]);
    // Removed or disabled: the rows no longer hold it, and the Repo skill is back at once.
    expect((await snapshot("/w/proj", access({ rows: [] }))).skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["fruit-code", "project"],
      ["owner-only", "project"],
    ]);
  });
});

describe("a CLI agent's snapshotForCwd (SPI-1151)", () => {
  const builtIns = { ...machine, slashCommands: [{ name: "compact", description: "Compact" }] } as ServerProvider;
  const cli = (cwd: string, skills: SkillsAccess, agent: CliAgent = "claude") => Effect.runPromise(cliSnapshotForCwd(builtIns, cwd, skills, agent));

  it("asks the Workspace for that CLI's roots, and answers its Skills in t3 paths and its commands after the built-ins", async () => {
    const skills = access();
    const answer = await cli("/w/proj", skills, "opencode");
    expect(skills.asked).toEqual(["skills /workspace/repo opencode", "prompts /workspace/repo opencode"]);
    expect(answer.skills.map((skill) => [skill.name, skill.path, skill.scope])).toEqual([
      ["fruit-code", "/w/proj/.agents/skills/fruit-code/SKILL.md", "project"],
      ["owner-only", "/w/proj/.claude/skills/owner-only/SKILL.md", "project"],
    ]);
    expect(answer.slashCommands.map((command) => command.name)).toEqual(["compact", "echo", "review"]);
    expect(answer.slashCommandsPending).toBe(false);
  });

  it("is not behind the Harness switch, which is Pi Durable's: the CLI loads its Skills either way", async () => {
    const answer = await cli("/w/proj", access({ enabled: false }));
    expect(answer.skills.map((skill) => skill.name)).toEqual(["fruit-code", "owner-only"]);
  });

  it("keeps a built-in over a repo command of the same name", async () => {
    const answer = await Effect.runPromise(cliSnapshotForCwd({ ...machine, slashCommands: [{ name: "echo", description: "built in" }] } as ServerProvider, "/w/proj", access(), "pi"));
    expect(answer.slashCommands).toEqual([{ name: "echo", description: "built in" }, { name: "review", input: { hint: "<file> [focus]" } }]);
  });

  it("lists no repo commands when told not to (OpenCode's), its Skills still", async () => {
    const answer = await Effect.runPromise(cliSnapshotForCwd(builtIns, "/w/proj", access(), "opencode", false));
    expect(answer.slashCommands).toEqual([{ name: "compact", description: "Compact" }]);
    expect(answer.skills.map((skill) => skill.name)).toEqual(["fruit-code", "owner-only"]);
  });

  it("is the built-ins alone outside a Workspace", async () => {
    const skills = access();
    const answer = await cli("/elsewhere", skills);
    expect(answer.skills).toEqual([]);
    expect(answer.slashCommands).toEqual([{ name: "compact", description: "Compact" }]);
    expect(skills.asked).toEqual([]);
  });
});
