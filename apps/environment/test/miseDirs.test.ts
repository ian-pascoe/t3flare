// mise's own directories on every command path (SPI-1150, review round 1): the lay-down installs the Global mise config's
// tools once per Container, under COMMAND_ENV with the image's HOME, and every later command must find them there. A
// CLI profile that moves XDG_* (OpenCode's own home) would otherwise send mise to another data directory, where a
// command reinstalls the pins (or, with auto-install off, finds none) and an owner-pinned git has no credential helper.
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { describe, expect, it } from "vitest";

import { CLI_PROFILE_NAMES, type CliName, type LaunchInput, profileLaunch, type ProfileContext } from "../src/agents/cliProfiles.ts";

const context: ProfileContext = { proxyUrl: "https://proxy.example", models: [], readStateFile: () => undefined, piExtensionSource: "// t3's extension", relay: { handle: "handle", servers: [] } };
const ARGS: Record<CliName, ReadonlyArray<string>> = { codex: ["app-server"], pi: ["--mode", "rpc", "--no-extensions"], claude: [], opencode: ["acp"], probe: [] };

/** Where mise puts its data, cache, state and config for `env`, as mise resolves them (its `dirs.rs`). */
const miseDirs = (env: Readonly<Record<string, string | undefined>>) => {
  const home = env.HOME ?? "/root";
  return {
    data: env.MISE_DATA_DIR ?? `${env.XDG_DATA_HOME ?? `${home}/.local/share`}/mise`,
    cache: env.MISE_CACHE_DIR ?? `${env.XDG_CACHE_HOME ?? `${home}/.cache`}/mise`,
    state: env.MISE_STATE_DIR ?? `${env.XDG_STATE_HOME ?? `${home}/.local/state`}/mise`,
    config: env.MISE_CONFIG_DIR ?? `${env.XDG_CONFIG_HOME ?? `${home}/.config`}/mise`,
  };
};

/** The lay-down's: COMMAND_ENV on the Container's own environment (HOME=/root, no XDG_*). */
const LAY_DOWN = miseDirs({ HOME: "/root", ...COMMAND_ENV });

describe("mise's directories", () => {
  it("are the image's defaults under /root for the lay-down, so the shims on PATH are its installs'", () => {
    expect(LAY_DOWN).toEqual({ data: "/root/.local/share/mise", cache: "/root/.cache/mise", state: "/root/.local/state/mise", config: "/root/.config/mise" });
  });

  it("are the lay-down's for every CLI agent's process, whatever HOME or XDG_* its profile sets", () => {
    for (const cli of CLI_PROFILE_NAMES) {
      const input: LaunchInput = { cli, args: ARGS[cli], key: "k1", cwd: "/w/p/repo", env: { T3CODE_THREAD_ID: "t1" }, allowProbe: true };
      const launch = profileLaunch(input, context);
      if ("refused" in launch) throw new Error(`${cli}: ${launch.refused}`);
      // A process's environment: COMMAND_ENV under the profile's (processHost's spawn).
      expect({ cli, dirs: miseDirs({ HOME: "/root", ...COMMAND_ENV, ...launch.env }) }).toEqual({ cli, dirs: LAY_DOWN });
    }
  });
});
