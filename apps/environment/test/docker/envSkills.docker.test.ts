// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// `pnpm run test:docker`, SPI-1153's probe (its M0): each pinned CLI, launched as the Workspace DO launches it
// (`profileLaunch` → `processCommand`, with SPI-1153's links and pi's flag), with an Environment skill set mounted
// read-only at `/workspace/.agents/skills` (as SPI-1148's lock leaves it): an Environment-only Skill (`e-env`) and a
// `dup`. For each of the CLI's Repo Skill roots (`CLI_ROOTS`), on its own, a repo holds a `dup` in that root alone, so
// each root's winner is seen apart (review round 1: OpenCode's differs by root). Each CLI reports what it loaded (as in
// `skills.docker.test.ts`); the test holds that every CLI reads the set through its link, that each root's winner is
// that root's `environment` in `CLI_ROOTS`, and that a write through the link fails. Codex is also run with its whole
// user-level root linked, the layout SPI-1153 did not take (`CODEX_ENVIRONMENT_SKILLS`). No model is called.
// T3FLARE_ENV_SKILLS_PROBE_OUT=<file> writes the report (docs/steps/env-skills-cli/m0-probe.json).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CLI_AGENTS, CLI_ROOTS, type CliAgent, SKILLS_MOUNT } from "@t3flare/skills";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { expect, it } from "vitest";

import { CODEX_ENVIRONMENT_SKILLS, type Launch } from "../../src/agents/cliProfiles.ts";
import { drive, IMAGE, launchOf, openCodeServedSkills, piLaunchOf, runCommand, startHarness, T3_PATH } from "./cliHarness.ts";
import { type Loaded, skillMd } from "./skillsProbe.ts";

const here = import.meta.dirname;
const out = process.env.T3FLARE_ENV_SKILLS_PROBE_OUT;
const NAME = "t3flare-env-skills-probe";

/** The Environment skill set: a Skill of its own name and the same-named `dup`. */
const ENVIRONMENT_SET: Readonly<Record<string, string>> = {
  "e-env/SKILL.md": skillMd("e-env", "Environment marker e-env"),
  "e-env/reference.md": "e-env's reference\n",
  "dup/SKILL.md": skillMd("dup", "dup from the Environment"),
};

/** Where each CLI reads the set: its linked root (the process's home is `<home>`), or pi's flag's directory. */
const READ_AT: Readonly<Record<CliAgent, string>> = {
  codex: `<home>/${CODEX_ENVIRONMENT_SKILLS}`,
  pi: SKILLS_MOUNT,
  claude: "<home>/claude/skills",
  opencode: "<home>/config/opencode/skills",
};

/** Who won `dup` in what a CLI listed: the Environment's, a Repo one, or both listed. */
const winnerOf = (loaded: Loaded): "environment" | "repo" | "both" | "none" => {
  const descriptions = loaded.skills.filter((skill) => skill.name === "dup").map((skill) => skill.description ?? "");
  const environment = descriptions.some((text) => text.includes("from the Environment"));
  const repo = descriptions.some((text) => /dup from \./.test(text));
  return environment && repo ? "both" : environment ? "environment" : repo ? "repo" : "none";
};

it("each CLI reads the Environment skill set through its link, keeps its own winner per Repo root, and cannot write it (SPI-1153 M0)", async () => {
  const environmentSet = fs.mkdtempSync(path.join(here, ".env-set-"));
  const nonce = `nonce-${randomUUID()}`;
  const harness = startHarness(NAME, [nonce]);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const [file, text] of Object.entries(ENVIRONMENT_SET)) write(path.join(environmentSet, file), text);
  const workspaces: Array<string> = [];
  /** A workspace whose repo holds `dup` in `root` alone. */
  const workspaceWith = (root: string): string => {
    const workspace = fs.mkdtempSync(path.join(here, ".env-skills-"));
    workspaces.push(workspace);
    write(path.join(workspace, "repo", root, "dup", "SKILL.md"), skillMd("dup", `dup from ${root}`));
    fs.mkdirSync(path.join(workspace, ".t3flare"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".agents/skills"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: path.join(workspace, "repo") });
    fs.chmodSync(workspace, 0o777);
    return workspace;
  };
  // The mount as SPI-1148's lock leaves it in the Container: read-only.
  const dockerArgs = ["-v", `${environmentSet}:${SKILLS_MOUNT}:ro`];
  const marker = () => `proc-${randomUUID()}`;
  const run = (workspace: string, launch: Launch, key: string, argv?: ReadonlyArray<string>) =>
    runCommand({ harness, name: argv === undefined ? NAME : `${NAME}-sh`, launch, marker: key, nonce, workspace, dockerArgs, ...(argv === undefined ? {} : { argv }) });

  /** A write through where the CLI reads the set (and a read of `e-env`), as a shell in the CLI's launch would make it. */
  const writeProbe = (workspace: string, cli: CliAgent, launch: Launch, key: string): string => {
    const at = READ_AT[cli].replace("<home>", `/var/lib/t3flare/cli/${key}`);
    const script = [
      `at=${JSON.stringify(at)}`,
      `echo "link: $(readlink "$at" || echo none)"`,
      `echo "read: $(head -n 3 "$at/e-env/SKILL.md" | tail -n 1)"`,
      `if touch "$at/planted" 2>/dev/null; then echo "touch: written"; else echo "touch: refused"; fi`,
      `if mkdir "$at/planted-dir" 2>/dev/null; then echo "mkdir: written"; else echo "mkdir: refused"; fi`,
      `if printf x > "$at/e-env/SKILL.md" 2>/dev/null; then echo "overwrite: written"; else echo "overwrite: refused"; fi`,
      `echo "after: $(ls "$at" | tr '\\n' ' ')"`,
    ].join("\n");
    const [binary, ...args] = run(workspace, launch, key, ["/bin/bash", "-c", script]);
    const result = spawnSync(binary!, args, { encoding: "utf8", timeout: 120_000 });
    return `${result.stdout}${result.status === 0 ? "" : `\nexit ${result.status}: ${result.stderr.slice(-400)}`}`;
  };

  /** What `cli` loaded over `workspace`, launched with `adjust` applied to its launch. */
  const loadedBy = (cli: CliAgent, workspace: string, adjust: (launch: Launch, key: string) => Launch = (launch) => launch): { loaded: Loaded; raw: unknown; launch: Launch; key: string } => {
    const key = marker();
    if (cli === "codex") {
      const launch = adjust(launchOf({ cli, args: ["app-server"], key, env: {} }), key);
      const result = drive("codex-rpc.mjs", { extraRequests: [{ method: "skills/list", params: { cwds: [T3_PATH], forceReload: true } }], timeoutMs: 120_000 }, run(workspace, launch, key));
      const list = result["extra:skills/list"]?.ok?.data ?? [];
      return {
        loaded: { skills: list.flatMap((entry: any) => entry.skills ?? []).map((skill: any) => ({ name: skill.name, description: skill.description ?? null, path: skill.path ?? null, scope: skill.scope ?? null })), commands: [] },
        raw: { error: result["extra:skills/list"]?.error ?? null, errors: result.errors, stderr: String(result.stderr ?? "").slice(-1500), driver: result.driverFailed },
        launch,
        key,
      };
    }
    if (cli === "pi") {
      const launch = piLaunchOf(key);
      const result = drive("pi-rpc.mjs", { commands: [{ type: "get_commands" }], timeoutMs: 120_000 }, run(workspace, launch, key));
      const commands = (result.responses ?? []).find((response: any) => response.command === "get_commands")?.data?.commands ?? [];
      return {
        loaded: { skills: commands.filter((entry: any) => entry.source === "skill").map((entry: any) => ({ name: String(entry.name).replace(/^skill:/, ""), description: entry.description ?? null, path: entry.sourceInfo?.path ?? entry.path ?? null })), commands: [] },
        raw: { errors: result.errors, stderr: String(result.stderr ?? "").slice(-800), driver: result.driverFailed },
        launch,
        key,
      };
    }
    if (cli === "claude") {
      const launch = launchOf({ cli, args: [], key, env: {} });
      const result = drive("acp-rpc.mjs", { cwd: T3_PATH, waitMs: 90_000, settleMs: 5000, timeoutMs: 150_000 }, run(workspace, launch, key));
      const last: ReadonlyArray<{ name: string; description: string | null }> = result.commandUpdates?.at(-1) ?? [];
      return {
        loaded: { skills: last.map((entry) => ({ name: entry.name, description: entry.description, path: null })), commands: [] },
        raw: { updates: result.commandUpdates?.length ?? 0, errors: result.errors, stderr: String(result.stderr ?? "").slice(-1200), driver: result.driverFailed },
        launch,
        key,
      };
    }
    const launch = launchOf({ cli, args: ["acp"], key, env: {} });
    const served = openCodeServedSkills({ harness, name: NAME, launch, marker: key, nonce, workspace, dockerArgs });
    return { loaded: { skills: served.skills.map((skill) => ({ name: skill.name, description: skill.description ?? null, path: skill.path ?? null })), commands: [] }, raw: served.raw, launch, key };
  };

  const report: Record<string, unknown> = { at: new Date().toISOString(), clis: { codex: CLIS.codex.version, pi: CLIS.pi.version, claude: `${CLIS.claude.version} (claude-agent-acp ${CLIS.claude.packageVersion})`, opencode: CLIS.opencode.version }, environmentSet: Object.keys(ENVIRONMENT_SET) };
  /** Per CLI, per Repo root: the winner, and the `dup` and `e-env` entries the CLI listed. */
  const byRoot: Record<string, Record<string, { winner: string; entries: ReadonlyArray<unknown>; raw: unknown }>> = {};
  const writes: Partial<Record<CliAgent, string>> = {};
  const launches: Partial<Record<CliAgent, { argv: ReadonlyArray<string>; links: Launch["links"] }>> = {};
  try {
    for (const cli of CLI_AGENTS) {
      byRoot[cli] = {};
      for (const root of CLI_ROOTS[cli].skills) {
        const workspace = workspaceWith(root.directory);
        const answer = loadedBy(cli, workspace);
        byRoot[cli]![root.directory] = { winner: winnerOf(answer.loaded), entries: answer.loaded.skills.filter((skill) => skill.name === "dup" || skill.name === "e-env"), raw: answer.raw };
        if (writes[cli] === undefined) {
          writes[cli] = writeProbe(workspace, cli, answer.launch, answer.key);
          launches[cli] = { argv: cli === "pi" ? answer.launch.argv.slice(1) : [], links: answer.launch.links };
        }
      }
    }
    // The layout not taken: Codex's whole user-level root linked to the read-only set.
    const linkedRoot = loadedBy("codex", workspaceWith(".agents/skills"), (launch, key) => ({
      ...launch,
      links: (launch.links ?? []).map((link) => (link.target === SKILLS_MOUNT ? { path: `/var/lib/t3flare/cli/${key}/codex/skills`, target: SKILLS_MOUNT } : link)),
    }));
    report["codex (whole root linked)"] = { skills: linkedRoot.loaded.skills.map((skill) => `${skill.name} (${skill.scope}) ${skill.path}`), raw: linkedRoot.raw };
  } finally {
    harness.stop();
    for (const workspace of workspaces) {
      spawnSync("docker", ["run", "--rm", "-v", `${workspace}:/workspace`, IMAGE, "rm", "-rf", "/workspace/repo", "/workspace/.t3flare", "/workspace/.agents"], { encoding: "utf8" });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    fs.rmSync(environmentSet, { recursive: true, force: true });
  }
  const winners = Object.fromEntries(CLI_AGENTS.map((cli) => [cli, Object.fromEntries(Object.entries(byRoot[cli] ?? {}).map(([root, found]) => [root, found.winner]))]));
  const full = { ...report, launches, winners, writes, byRoot };
  if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify(full, null, 1)}\n`);
  console.log(JSON.stringify({ winners, writes }, null, 1));
  for (const cli of CLI_AGENTS) {
    for (const root of CLI_ROOTS[cli].skills) {
      const found = byRoot[cli]![root.directory]!;
      expect(found.entries.map((entry: any) => entry.name), `${cli} reads the Environment skill set through its link`).toContain("e-env");
      expect(found.winner, `${cli}'s winner of a Repo skill in ${root.directory} and an Environment skill: update CLI_ROOTS[${cli}]`).toBe(root.environment);
    }
    expect(writes[cli], `${cli} reads the set where it is linked`).toContain("read: description: Environment marker e-env");
    for (const write of ["touch", "mkdir", "overwrite"]) expect(writes[cli], `${cli}: a write (${write}) through the link fails`).toContain(`${write}: refused`);
  }
}, 30 * 60_000);
