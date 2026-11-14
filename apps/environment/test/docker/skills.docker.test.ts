// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// `pnpm run test:docker`, SPI-1151's probe (its M0): which skill and command roots each pinned CLI loads, launched as
// the Workspace DO launches it (`profileLaunch` → `processCommand`) in test:docker's image. A marker Skill with its own
// name sits in every candidate root, repo-level and user-level, with one same-named Skill (`dup`) in every repo root;
// each CLI reports what it loaded: Codex by `skills/list`, pi by `get_commands`, Claude Code and OpenCode by their
// `available_commands_update` (OpenCode's Skills by its server's `GET /api/skill`). No model is called. The test then
// holds `CLI_ROOTS` to what they loaded, so a CLI bump that moves a root fails here.
// T3FLARE_SKILLS_PROBE_OUT=<file> writes the report (docs/steps/spi-1151/m0-roots.json).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CLI_AGENTS, CLI_ROOTS, discoverPrompts, discoverSkills } from "@t3flare/skills";
import { memoryFiles } from "@t3flare/skills/testing";
import { CLIS } from "@t3flare/sandbox-image/clis";

import { type Launch } from "../../src/agents/cliProfiles.ts";
import { expect, it } from "vitest";

import { type Cli, drive, IMAGE, launchOf, openCodeServedSkills, piLaunchOf, runCommand, startHarness, T3_PATH } from "./cliHarness.ts";
import { commandMd, type Loaded, PROBED, repoFixture, repoView, skillMd } from "./skillsProbe.ts";

const here = import.meta.dirname;
const out = process.env.T3FLARE_SKILLS_PROBE_OUT;

/** User-level candidates under HOME (/root): skill roots, and each process's own home (`$HOME_OF`) by its variable. */
const USER_SKILL_CANDIDATES: Readonly<Record<string, string>> = {
  "/root/.agents/skills": "u-home-agents",
  "/root/.claude/skills": "u-home-claude",
  "/root/.codex/skills": "u-home-codex",
  "/root/.pi/agent/skills": "u-home-pi",
  "/root/.config/opencode/skills": "u-home-opencode",
};
/** Per-process homes, as the profile sets them (`<home>` is the process's). */
const PROCESS_SKILL_CANDIDATES: Readonly<Record<Cli, Readonly<Record<string, string>>>> = {
  codex: { "codex/skills": "u-codex-home", "codex/prompts/u-codex-prompt.md": "u-codex-prompt" },
  pi: { "agent/skills": "u-pi-agent-dir", "agent/prompts/u-pi-prompt.md": "u-pi-prompt" },
  claude: { "claude/skills": "u-claude-config", "claude/commands/u-claude-cmd.md": "u-claude-cmd" },
  opencode: { "config/opencode/skills": "u-xdg-opencode-skills", "config/opencode/skill": "u-xdg-opencode-skill", "config/opencode/commands/u-oc-cmd.md": "u-oc-cmd" },
};

/** Files below a home or root for a marker: a skill directory or a command file. */
const markerFiles = (root: string, key: string, name: string): ReadonlyArray<{ path: string; text: string }> =>
  key.endsWith(".md") ? [{ path: `${root}/${key}`, text: commandMd(name) }] : [{ path: `${root}/${key}/${name}/SKILL.md`, text: skillMd(name, `Probe marker for ${key}`) }];

/**
 * The launch without SPI-1153's Environment skill links and flag: this probe is of the CLIs' own roots, and a link
 * where a marker sits (Claude Code's and OpenCode's user roots) would hide it (`envSkills.docker.test.ts` probes them).
 */
const withoutEnvironmentSkills = (launch: Launch): Launch => {
  const argv = launch.argv.filter((arg, at) => !(arg === "/workspace/.agents/skills" || (arg === "--skill" && launch.argv[at + 1] === "/workspace/.agents/skills")));
  const links = (launch.links ?? []).filter((link) => link.target !== "/workspace/.agents/skills");
  return { ...launch, argv, links };
};

it("each CLI's skill and command roots (SPI-1151 M0) are CLI_ROOTS' table", async () => {
  const workspace = fs.mkdtempSync(path.join(here, ".skills-"));
  const nonces = { codex: `nonce-${randomUUID()}`, pi: `nonce-${randomUUID()}`, claude: `nonce-${randomUUID()}`, opencode: `nonce-${randomUUID()}` };
  const harness = startHarness("t3flare-skills-probe", Object.values(nonces));
  const repo = path.join(workspace, "repo");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const [file, text] of Object.entries(repoFixture())) write(path.join(repo, file), text);
  fs.mkdirSync(path.join(workspace, ".t3flare"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.chmodSync(workspace, 0o777);

  const userSetup = Object.entries(USER_SKILL_CANDIDATES)
    .flatMap(([root, name]) => markerFiles(root, "", name).map((file) => ({ ...file, path: file.path.replace("//", "/") })))
    .map((file) => `mkdir -p ${JSON.stringify(path.dirname(file.path))} && printf %s ${JSON.stringify(file.text)} > ${JSON.stringify(file.path)}`)
    .join("\n");

  const run = (cli: Cli, given: Launch, marker: string, argv?: ReadonlyArray<string>): Array<string> => {
    const launch = withoutEnvironmentSkills(given);
    const home = `/var/lib/t3flare/cli/${marker}`;
    return runCommand({
      harness,
      name: "t3flare-skills-probe",
      launch,
      marker,
      nonce: nonces[cli],
      workspace,
      ...(argv === undefined ? {} : { argv }),
      files: Object.entries(PROCESS_SKILL_CANDIDATES[cli]).flatMap(([key, name]) => markerFiles(home, key, name)),
      setup: userSetup,
    });
  };
  const marker = () => `proc-${randomUUID()}`;
  const report: Record<string, unknown> = { at: new Date().toISOString(), clis: { codex: CLIS.codex.version, pi: CLIS.pi.version, claude: `${CLIS.claude.version} (claude-agent-acp ${CLIS.claude.packageVersion})`, opencode: CLIS.opencode.version } };
  const loaded: Partial<Record<string, Loaded>> = {};
  try {
    // Codex: `skills/list` for the cwd, before any thread.
    const codexKey = marker();
    const codex = drive("codex-rpc.mjs", { extraRequests: [{ method: "skills/list", params: { cwds: [T3_PATH], forceReload: true } }], timeoutMs: 120_000 }, run("codex", launchOf({ cli: "codex", args: ["app-server"], key: codexKey, env: {} }), codexKey));
    const codexList = codex["extra:skills/list"]?.ok?.data ?? [];
    loaded.codex = {
      skills: codexList.flatMap((entry: any) => entry.skills ?? []).map((skill: any) => ({ name: skill.name, description: skill.description ?? null, path: skill.path ?? null, scope: skill.scope ?? null })),
      commands: [],
    };
    report.codexRaw = { error: codex["extra:skills/list"]?.error ?? null, errors: codex.errors, stderr: String(codex.stderr ?? "").slice(-800), driver: codex.driverFailed };

    // pi: `get_commands`, under t3flare's profile and, for pi's own roots, with the project trusted (`--approve`).
    const piCommands = (result: any): Loaded => {
      const commands = (result.responses ?? []).find((response: any) => response.command === "get_commands")?.data?.commands ?? [];
      return {
        skills: commands.filter((entry: any) => entry.source === "skill").map((entry: any) => ({ name: String(entry.name).replace(/^skill:/, ""), description: entry.description ?? null, path: entry.sourceInfo?.path ?? entry.path ?? null })),
        commands: commands.filter((entry: any) => entry.source !== "skill").map((entry: any) => String(entry.name)),
      };
    };
    const piLaunch = (key: string) => withoutEnvironmentSkills(piLaunchOf(key));
    const piKey = marker();
    const pi = drive("pi-rpc.mjs", { commands: [{ type: "get_commands" }], timeoutMs: 120_000 }, run("pi", piLaunch(piKey), piKey));
    loaded.pi = piCommands(pi);
    const trustedKey = marker();
    const trustedLaunch = piLaunch(trustedKey);
    const piTrusted = drive("pi-rpc.mjs", { commands: [{ type: "get_commands" }], timeoutMs: 120_000 }, run("pi", trustedLaunch, trustedKey, trustedLaunch.argv.map((arg) => (arg === "--no-approve" ? "--approve" : arg))));
    loaded["pi (project trusted)"] = piCommands(piTrusted);
    report.piRaw = { profileArgv: piLaunch("proc-x").argv.slice(1), errors: [...(pi.errors ?? []), ...(piTrusted.errors ?? [])], stderr: String(pi.stderr ?? "").slice(-800), driver: pi.driverFailed ?? piTrusted.driverFailed };

    // Claude Code and OpenCode: the commands of their first settled `available_commands_update`.
    for (const cli of ["claude", "opencode"] as const) {
      const key = marker();
      const result = drive("acp-rpc.mjs", { cwd: T3_PATH, waitMs: 90_000, settleMs: 5000, timeoutMs: 150_000 }, run(cli, launchOf({ cli, args: cli === "claude" ? [] : ["acp"], key, env: {} }), key));
      const last: ReadonlyArray<{ name: string; description: string | null }> = result.commandUpdates?.at(-1) ?? [];
      loaded[cli] = { skills: last.map((entry) => ({ name: entry.name, description: entry.description, path: null })), commands: last.map((entry) => entry.name) };
      report[`${cli}Raw`] = { updates: result.commandUpdates?.length ?? 0, agentInfo: result.initialize?.agentInfo ?? null, errors: result.errors, stderr: String(result.stderr ?? "").slice(-1200), driver: result.driverFailed };
    }
    // OpenCode lists no skills over ACP (its commands only): its own server's `GET /api/skill` for the cwd, with the
    // profile's environment and system configuration, answers them.
    const serveKey = marker();
    const serveLaunch = withoutEnvironmentSkills(launchOf({ cli: "opencode", args: ["acp"], key: serveKey, env: {} }));
    const serveHome = `/var/lib/t3flare/cli/${serveKey}`;
    const served = openCodeServedSkills({
      harness,
      name: "t3flare-skills-probe",
      launch: serveLaunch,
      marker: serveKey,
      nonce: nonces.opencode,
      workspace,
      files: Object.entries(PROCESS_SKILL_CANDIDATES.opencode).flatMap(([key, name]) => markerFiles(serveHome, key, name)),
      setup: userSetup,
    });
    loaded["opencode (GET /api/skill)"] = {
      skills: served.skills.map((skill) => ({ name: skill.name, description: skill.description ?? null, path: skill.path ?? null })),
      commands: [],
    };
    report.opencodeServeRaw = served.raw;
  } finally {
    harness.stop();
    spawnSync("docker", ["run", "--rm", "-v", `${workspace}:/workspace`, IMAGE, "rm", "-rf", "/workspace/repo", "/workspace/.t3flare"], { encoding: "utf8" });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  const full = { ...report, loaded };
  if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify(full, null, 1)}\n`);
  console.log(JSON.stringify(full, null, 1));
  expect(Object.keys(loaded)).toHaveLength(6);
  // The roots table (`CLI_ROOTS`) still says where each CLI looks: discovery over the same fixture finds what it loaded.
  const files = memoryFiles(Object.fromEntries(Object.entries(repoFixture()).map(([file, text]) => [`/workspace/repo/${file}`, text])));
  for (const cli of CLI_AGENTS) {
    const live = repoView(loaded[PROBED[cli].skills]!, loaded[PROBED[cli].commands]!);
    const found = await discoverSkills(files, { cwd: "/workspace/repo", root: "/workspace/repo", roots: CLI_ROOTS[cli].skills });
    const commands = await discoverPrompts(files, "/workspace/repo", CLI_ROOTS[cli].commands);
    expect(found.skills.map((skill) => skill.name).sort(), `${cli} moved a skill root: update CLI_ROOTS`).toEqual(Object.keys(live.skills));
    for (const skill of found.skills) expect(live.skills[skill.name], `${cli}'s winner of ${skill.name}`).toContain(skill.description);
    expect(commands.map((command) => command.name).sort(), `${cli} moved a command root: update CLI_ROOTS`).toEqual(live.commands);
  }
}, 30 * 60_000);
