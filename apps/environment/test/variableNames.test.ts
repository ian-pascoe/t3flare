// The names t3flare sets itself, derived from the code (SPI-1152, ADR-0032's Variables refinement): every name
// `COMMAND_ENV`, a CLI profile's environment or the managed settings' `env` sets or pins, and the nonce a CLI process
// gets. Each must be refused as a Variable's, and `SET_BY_T3FLARE` must be exactly those no general rule refuses, so the
// list can drift neither way when a profile changes.
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { REFUSED_EXACT, REFUSED_LOADER_HOOKS, REFUSED_PREFIXES, SET_BY_T3FLARE, variableNameProblem } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { claudeManagedSettings } from "../src/agents/acpProfiles.ts";
import { codexExecArgs, type CliName, type LaunchInput, NONCE_ENV, profileLaunch, type ProfileContext } from "../src/agents/cliProfiles.ts";

const PI_EXTENSION = "/state/t3-pi-extension.js";
const SCHEMA = "/state/output-schema.json";
const context: ProfileContext = {
  proxyUrl: "https://proxy.example",
  models: [],
  readStateFile: (path) => (path === PI_EXTENSION ? "// t3's extension" : path === SCHEMA ? "{}" : undefined),
  piExtensionSource: "// t3's extension",
  relay: { handle: "handle", servers: ["executor"] },
};

/** Every launch the profiles make, each with the inputs that set the most names. */
const LAUNCHES: ReadonlyArray<{ readonly cli: CliName; readonly args: ReadonlyArray<string>; readonly env?: Record<string, string> }> = [
  { cli: "codex", args: ["app-server"] },
  { cli: "codex", args: codexExecArgs("gpt-6-luna", SCHEMA) },
  {
    cli: "pi",
    args: ["--mode", "rpc", "--extension", PI_EXTENSION],
    env: { T3_PI_RUNTIME_MODE: "full-access", T3_MCP_URL: "https://t3.example/mcp", T3_MCP_BEARER_TOKEN: "bearer" },
  },
  { cli: "pi", args: ["--mode", "rpc", "--no-extensions"] },
  { cli: "claude", args: [] },
  { cli: "opencode", args: ["acp"] },
  { cli: "probe", args: [] },
];

const launchNames = (): ReadonlyArray<string> =>
  LAUNCHES.flatMap(({ cli, args, env }) => {
    const input: LaunchInput = { cli, args, key: "k1", cwd: "/w/p/repo", env: { T3CODE_THREAD_ID: "t1", ...env }, allowProbe: true };
    const launch = profileLaunch(input, context);
    if ("refused" in launch) throw new Error(`${cli} ${args.join(" ")}: ${launch.refused}`);
    return Object.keys(launch.env);
  });

/** Every name t3flare sets or pins for a command or a CLI agent. */
const derived = (): ReadonlyArray<string> => [
  ...new Set([...Object.keys(COMMAND_ENV), ...launchNames(), ...Object.keys(claudeManagedSettings(context.proxyUrl, []).env), NONCE_ENV]),
];

/** Whether a rule other than `SET_BY_T3FLARE` already refuses `name`. */
const generalRuleRefuses = (name: string): boolean =>
  REFUSED_EXACT.includes(name) ||
  REFUSED_PREFIXES.some((entry) => name.startsWith(entry.prefix)) ||
  REFUSED_LOADER_HOOKS.includes(name) ||
  name
    .toUpperCase()
    .split("_")
    .some((part) => ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"].some((word) => part === word || part === `${word}S`));

describe("the names t3flare sets itself", () => {
  it("are all refused as a Variable's", () => {
    const names = derived();
    // Spot checks against the ticket's own examples, so an empty derivation cannot pass.
    expect(names).toEqual(expect.arrayContaining(["ANTHROPIC_BASE_URL", "HTTPS_PROXY", "MISE_GLOBAL_CONFIG_FILE", "BASH_ENV", "CODEX_HOME", "T3FLARE_TOOL_HANDLE", "T3FLARE_MODEL_KEY_NONCE"]));
    expect(names.filter((name) => variableNameProblem(name) === undefined)).toEqual([]);
  });

  it("are listed in SET_BY_T3FLARE exactly when no general rule refuses them", () => {
    expect([...SET_BY_T3FLARE].sort()).toEqual(derived().filter((name) => !generalRuleRefuses(name)).sort());
  });
});
