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

import type { CatalogModel } from "@t3flare/models";
import { CLI_AGENTS, CLI_ROOTS, discoverPrompts, discoverSkills } from "@t3flare/skills";
import { memoryFiles } from "@t3flare/skills/testing";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { processCommand } from "@t3flare/sandbox-image/process";

import { PI_T3_MCP_EXTENSION_SOURCE } from "../../../../t3code/packages/provider-pi/src/server/mcpExtensionSource.ts";
import { type Launch, type LaunchInput, profileLaunch } from "../../src/agents/cliProfiles.ts";
import { expect, it } from "vitest";

import { commandMd, type Loaded, PROBED, repoFixture, repoView, skillMd } from "./skillsProbe.ts";

const here = import.meta.dirname;
const imageContext = path.resolve(here, "../../../sandbox-image/image");
const IMAGE = "t3flare-cli-test";
const KEYHOST = "t3flare-skills-probe-keyhost";
const NET_INT = "t3flare-skills-probe-int";
const T3_PATH = "/w/fixture";
const EXTENSION = "/t3/caches/pi-t3-mcp-extension.ts";
const out = process.env.T3FLARE_SKILLS_PROBE_OUT;

type Cli = "codex" | "pi" | "claude" | "opencode";

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

const docker = (args: ReadonlyArray<string>, options: { quiet?: boolean } = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && options.quiet !== true) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${(result.stderr ?? "").slice(-1500)}`);
  return result;
};

const model = (id: string): CatalogModel => ({ id, name: id, provider: "anthropic", vendor: "Anthropic", api: "anthropic-messages", slug: `anthropic/${id}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 32_000 });

const launchOf = (input: Omit<LaunchInput, "allowProbe" | "cwd">): Launch => {
  const answer = profileLaunch(
    { ...input, cwd: T3_PATH, allowProbe: false },
    { proxyUrl: "http://computer.internal/no-model", models: [model("claude-haiku-5-5")], readStateFile: (file) => (file === EXTENSION ? PI_T3_MCP_EXTENSION_SOURCE : undefined), piExtensionSource: PI_T3_MCP_EXTENSION_SOURCE },
  );
  if ("refused" in answer) throw new Error(`the profile refused: ${answer.refused}`);
  return answer;
};

it("each CLI's skill and command roots (SPI-1151 M0) are CLI_ROOTS' table", async () => {
  const workspace = fs.mkdtempSync(path.join(here, ".skills-"));
  const nonces = { codex: `nonce-${randomUUID()}`, pi: `nonce-${randomUUID()}`, claude: `nonce-${randomUUID()}`, opencode: `nonce-${randomUUID()}` };
  const cleanup = () => {
    docker(["rm", "-f", KEYHOST], { quiet: true });
    docker(["network", "rm", NET_INT], { quiet: true });
  };
  cleanup();
  docker([
    "build", "-q", "-t", IMAGE, "-f", path.join(here, "Dockerfile"),
    "--build-arg", `CODEX_VERSION=${CLIS.codex.version}`, "--build-arg", `CODEX_SHA256=${CLIS.codex.sha256}`, "--build-arg", `CODEX_SHA256_ARM64=${CLIS.codex.sha256Arm64}`,
    "--build-arg", `OPENCODE_VERSION=${CLIS.opencode.version}`, "--build-arg", `OPENCODE_SHA256=${CLIS.opencode.sha256}`, "--build-arg", `OPENCODE_SHA256_ARM64=${CLIS.opencode.sha256Arm64}`,
    imageContext,
  ]);
  docker(["network", "create", "--internal", NET_INT]);
  // The stand-in `computer.internal`: a key for any of the probe's nonces (no model is called), NXDOMAIN for every name.
  docker(["run", "-d", "--name", KEYHOST, "--network", NET_INT, "--network-alias", "computer.internal", "-e", "KEYHOST_MODEL_KEY=probe-key", "-e", `KEYHOST_NONCES=${Object.values(nonces).join(",")}`, "-v", `${here}:/k:ro`, "node:26.13.0-bookworm-slim", "node", "/k/keyhost.mjs"]);
  const keyhostIp = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${NET_INT}").IPAddress}}`, KEYHOST]).stdout.trim();
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

  const run = (cli: Cli, launch: Launch, marker: string, argv?: ReadonlyArray<string>): Array<string> => {
    const home = `/var/lib/t3flare/cli/${marker}`;
    const files = [...(launch.files ?? []), ...Object.entries(PROCESS_SKILL_CANDIDATES[cli]).flatMap(([key, name]) => markerFiles(home, key, name))];
    const env: Record<string, string> = {
      ...launch.env,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      T3FLARE_EXEC: marker,
      T3FLARE_MODEL_KEY_NONCE: nonces[cli],
    };
    const command = processCommand({ marker, t3Path: T3_PATH, cwd: T3_PATH, argv: argv ?? launch.argv, files, ...(launch.links ? { links: launch.links } : {}) });
    return ["docker", "run", "--rm", "-i", "--name", `t3flare-skills-probe-${marker}`, "--network", NET_INT, "--dns", keyhostIp, "-v", `${workspace}:/workspace`, ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]), IMAGE, "bash", "-c", `${userSetup}\n${command}`];
  };
  const drive = (driver: string, scenario: unknown, command: ReadonlyArray<string>): any => {
    const result = spawnSync("node", [path.join(here, driver), JSON.stringify(scenario), "--", ...command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    const line = (result.stdout ?? "").trim().split("\n").at(-1) ?? "";
    try {
      return JSON.parse(line);
    } catch {
      return { driverFailed: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500) };
    }
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
    const piLaunch = (key: string) => launchOf({ cli: "pi", args: ["--mode", "rpc", "--extension", EXTENSION, "--provider", "anthropic", "--model", "claude-haiku-5-5"], key, env: { T3_PI_RUNTIME_MODE: "approval-required" } });
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
    const serveLaunch = launchOf({ cli: "opencode", args: ["acp"], key: serveKey, env: {} });
    const serveHome = `/var/lib/t3flare/cli/${serveKey}`;
    const serveScript = [
      "set -eu",
      `mkdir -p /etc/opencode "$XDG_DATA_HOME/opencode/log" && install -m 644 ${serveHome}/opencode.json /etc/opencode/opencode.json`,
      "OPENCODE_SERVER_PASSWORD=probe /opt/t3flare/opencode/opencode serve --hostname 127.0.0.1 --port 4096 >/dev/null 2>&1 &",
      "for i in $(seq 1 60); do curl -fsS -u opencode:probe -o /dev/null http://127.0.0.1:4096/api/location 2>/dev/null && break; sleep 1; done",
      // The first request boots the location, whose skill scan settles after it: ask again once it has.
      `curl -fsS -u opencode:probe -G --data-urlencode 'location[directory]=${T3_PATH}' -o /dev/null http://127.0.0.1:4096/api/skill`,
      "sleep 5",
      `curl -fsS -u opencode:probe -G --data-urlencode 'location[directory]=${T3_PATH}' http://127.0.0.1:4096/api/skill`,
    ].join("\n");
    const [serveBinary, ...serveArgs] = run("opencode", { ...serveLaunch, files: [...(serveLaunch.files ?? []), { path: `${serveHome}/serve.sh`, text: serveScript, mode: 0o700 }] }, serveKey, ["/bin/bash", `${serveHome}/serve.sh`]);
    const serve = spawnSync(serveBinary!, serveArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    let served: any;
    try {
      served = JSON.parse(serve.stdout);
    } catch {
      served = undefined;
    }
    const servedSkills: ReadonlyArray<any> = Array.isArray(served) ? served : (served?.data ?? served?.value ?? []);
    loaded["opencode (GET /api/skill)"] = {
      skills: servedSkills.map((skill) => ({ name: skill.name, description: skill.description ?? null, path: skill.path ?? null })),
      commands: [],
    };
    report.opencodeServeRaw = { status: serve.status, stdout: Array.isArray(servedSkills) && servedSkills.length > 0 ? undefined : String(serve.stdout).slice(0, 1500), stderr: String(serve.stderr ?? "").slice(-1200) };
  } finally {
    cleanup();
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
