// The names t3flare sets itself, derived from the code (SPI-1152, ADR-0032's Variables refinement): every name
// `COMMAND_ENV`, a CLI profile's environment or Codex's shell policy, the managed settings' `env`, a Terminal's base
// environment or its rc file sets, and the nonce a CLI process gets. Each must be refused as a Variable's, and
// `SET_BY_T3FLARE` must be exactly those no general rule refuses, so the list can drift neither way.
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { terminalRc } from "@t3flare/sandbox-image/terminal";
import { credentialSegment, REFUSED_EXACT, REFUSED_LOADER_HOOKS, REFUSED_PREFIXES, SET_BY_T3FLARE, variableNameProblem } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { claudeManagedSettings } from "../src/agents/acpProfiles.ts";
import { CLI_PROFILE_NAMES, codexExecArgs, codexOverrides, type CliName, type LaunchInput, NONCE_ENV, profileLaunch, type ProfileContext } from "../src/agents/cliProfiles.ts";
import { TERMINAL_BASE_ENV } from "../src/terminal/layer.ts";

const PI_EXTENSION = "/state/t3-pi-extension.js";
const SCHEMA = "/state/output-schema.json";
const context: ProfileContext = {
  proxyUrl: "https://proxy.example",
  models: [],
  readStateFile: (path) => (path === PI_EXTENSION ? "// t3's extension" : path === SCHEMA ? "{}" : undefined),
  piExtensionSource: "// t3's extension",
  relay: { handle: "handle", servers: ["executor"] },
};

/**
 * Every launch each CLI's profile makes, with the inputs that set the most names. Keyed by `CliName`: a CLI added to
 * `CLI_PROFILE_NAMES` fails the first test below until its launches are listed here.
 */
const LAUNCHES = {
  codex: [{ args: ["app-server"] }, { args: codexExecArgs("gpt-6-luna", SCHEMA) }],
  pi: [
    { args: ["--mode", "rpc", "--extension", PI_EXTENSION], env: { T3_PI_RUNTIME_MODE: "full-access", T3_MCP_URL: "https://t3.example/mcp", T3_MCP_BEARER_TOKEN: "bearer" } },
    { args: ["--mode", "rpc", "--no-extensions"] },
  ],
  claude: [{ args: [] }],
  opencode: [{ args: ["acp"] }],
  probe: [{ args: [] }],
} satisfies Record<CliName, ReadonlyArray<{ readonly args: ReadonlyArray<string>; readonly env?: Record<string, string> }>>;

const launchNames = (): ReadonlyArray<string> =>
  Object.entries(LAUNCHES).flatMap(([cli, launches]) =>
    launches.flatMap(({ args, ...rest }) => {
      const env = "env" in rest ? rest.env : {};
      const input: LaunchInput = { cli: cli as CliName, args, key: "k1", cwd: "/w/p/repo", env: { T3CODE_THREAD_ID: "t1", ...env }, allowProbe: true };
      const launch = profileLaunch(input, context);
      if ("refused" in launch) throw new Error(`${cli} ${args.join(" ")}: ${launch.refused}`);
      return Object.keys(launch.env);
    }),
  );

/** The names Codex's shell policy sets in every command it runs (`shell_environment_policy.set.NAME=…`). */
const codexShellNames = (): ReadonlyArray<string> => codexOverrides(context.proxyUrl, "k1").flatMap((value) => /^shell_environment_policy\.set\.([A-Za-z_][A-Za-z0-9_]*)=/.exec(value)?.[1] ?? []);

/** The shell variables a Terminal's rc file assigns after the shell starts (`NAME=…` at a line's start). */
const terminalRcNames = (): ReadonlyArray<string> =>
  terminalRc()
    .split("\n")
    .flatMap((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? []);

/** Every name t3flare sets or pins for a command, a Terminal or a CLI agent. */
const derived = (): ReadonlyArray<string> => [
  ...new Set([
    ...Object.keys(COMMAND_ENV),
    ...launchNames(),
    ...codexShellNames(),
    ...Object.keys(claudeManagedSettings(context.proxyUrl, []).env),
    ...Object.keys(TERMINAL_BASE_ENV),
    ...terminalRcNames(),
    NONCE_ENV,
  ]),
];

/** Whether a rule other than `SET_BY_T3FLARE` already refuses `name`. */
const generalRuleRefuses = (name: string): boolean =>
  REFUSED_EXACT.includes(name) || REFUSED_PREFIXES.some((entry) => name.startsWith(entry.prefix)) || REFUSED_LOADER_HOOKS.includes(name) || credentialSegment(name) !== undefined;

describe("the names t3flare sets itself", () => {
  it("are derived from a launch of every CLI profile", () => {
    expect(Object.keys(LAUNCHES).sort()).toEqual([...CLI_PROFILE_NAMES].sort());
  });

  it("are all refused as a Variable's", () => {
    const names = derived();
    // Spot checks against each source, so an empty derivation cannot pass.
    expect(names).toEqual(
      expect.arrayContaining(["ANTHROPIC_BASE_URL", "HTTPS_PROXY", "MISE_GLOBAL_CONFIG_FILE", "BASH_ENV", "CODEX_HOME", "T3FLARE_TOOL_HANDLE", "T3FLARE_MODEL_KEY_NONCE", "T3FLARE_EXEC", "TERM", "HISTFILE", "PS1"]),
    );
    expect(names.filter((name) => variableNameProblem(name) === undefined)).toEqual([]);
  });

  it("are listed in SET_BY_T3FLARE exactly when no general rule refuses them", () => {
    expect([...SET_BY_T3FLARE].sort()).toEqual(derived().filter((name) => !generalRuleRefuses(name)).sort());
  });
});
