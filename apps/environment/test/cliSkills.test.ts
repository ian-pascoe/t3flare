// The CLI agents' roots table (SPI-1151 §1, M1): discovery with each CLI's roots finds, in the probe's fixture, the
// repo Skills and commands that CLI itself loaded (`docs/steps/spi-1151/m0-roots.json`, recorded by
// `test/docker/skills.docker.test.ts` from the pinned CLIs), with its winner of a same-named pair; and their built-in
// commands.
import * as NodeFs from "node:fs";

import { CLI_AGENTS, CLI_ROOTS, discoverPrompts, discoverSkills, type SkillFiles } from "@t3flare/skills";
import { memoryFiles } from "@t3flare/skills/testing";
import { describe, expect, it } from "vitest";

import { CLI_BUILT_IN_COMMANDS } from "../src/provider/cli/builtInCommands.ts";
import { type Loaded, PROBED, repoFixture, repoView } from "./docker/skillsProbe.ts";

const ROOT = "/workspace/repo";
const recorded = JSON.parse(NodeFs.readFileSync(new URL("../../../docs/steps/spi-1151/m0-roots.json", import.meta.url), "utf8")) as { readonly loaded: Readonly<Record<string, Loaded>> };
const files: SkillFiles = memoryFiles(Object.fromEntries(Object.entries(repoFixture()).map(([file, text]) => [`${ROOT}/${file}`, text])));

describe("the CLI agents' roots table", () => {
  for (const cli of CLI_AGENTS) {
    it(`finds what ${cli} loaded`, async () => {
      const loaded = repoView(recorded.loaded[PROBED[cli].skills]!, recorded.loaded[PROBED[cli].commands]!);
      const found = await discoverSkills(files, { cwd: ROOT, root: ROOT, roots: CLI_ROOTS[cli].skills });
      const commands = await discoverPrompts(files, ROOT, CLI_ROOTS[cli].commands);
      expect(found.skills.map((skill) => skill.name).sort()).toEqual(Object.keys(loaded.skills));
      for (const skill of found.skills) expect(loaded.skills[skill.name], skill.name).toContain(skill.description);
      expect(commands.map((command) => command.name).sort()).toEqual(loaded.commands);
    });
  }
});

describe("the CLI agents' built-in commands (SPI-1151 §2)", () => {
  it("are stock's static entries that run on t3flare's path: /compact for Codex and pi, Codex's /goal, never /feedback", () => {
    expect(Object.fromEntries(CLI_AGENTS.map((cli) => [cli, CLI_BUILT_IN_COMMANDS[cli].map((command) => command.name)]))).toEqual({
      codex: ["compact", "goal"],
      pi: ["compact"],
      claude: [],
      opencode: [],
    });
  });

  it("restate stock's Codex /goal entry (CodexProvider.ts)", () => {
    const source = NodeFs.readFileSync(new URL("../../../t3code/apps/server/src/provider/CodexProvider.ts", import.meta.url), "utf8");
    const goal = CLI_BUILT_IN_COMMANDS.codex.find((command) => command.name === "goal")!;
    expect(source, "t3 changed Codex's /goal entry; re-read U65").toContain(`name: "goal",\n        description: ${JSON.stringify(goal.description)},\n        input: { hint: ${JSON.stringify(goal.input?.hint)} },`);
  });
});
