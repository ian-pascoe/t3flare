// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// test:docker's harness for the skills probes (SPI-1151's `skills.docker.test.ts`, SPI-1153's `envSkills.docker.test.ts`):
// the image, a stand-in `computer.internal` that answers the key helper on an internal network (no model is called),
// a CLI launched as the Workspace DO launches it (`profileLaunch` → `processCommand`), and the JSON-RPC drivers.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import type { CatalogModel } from "@t3flare/models";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { processCommand } from "@t3flare/sandbox-image/process";

import { PI_T3_MCP_EXTENSION_SOURCE } from "../../../../t3code/packages/provider-pi/src/server/mcpExtensionSource.ts";
import { type Launch, type LaunchInput, profileLaunch } from "../../src/agents/cliProfiles.ts";

const here = import.meta.dirname;
const imageContext = path.resolve(here, "../../../sandbox-image/image");
export const IMAGE = "t3flare-cli-test";
export const T3_PATH = "/w/fixture";
export const EXTENSION = "/t3/caches/pi-t3-mcp-extension.ts";

export type Cli = "codex" | "pi" | "claude" | "opencode";

export const docker = (args: ReadonlyArray<string>, options: { quiet?: boolean } = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && options.quiet !== true) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${(result.stderr ?? "").slice(-1500)}`);
  return result;
};

const model = (id: string): CatalogModel => ({ id, name: id, provider: "anthropic", vendor: "Anthropic", api: "anthropic-messages", slug: `anthropic/${id}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 32_000 });

/** The profile's launch at the fixture's path; a refusal throws. */
export const launchOf = (input: Omit<LaunchInput, "allowProbe" | "cwd">): Launch => {
  const answer = profileLaunch(
    { ...input, cwd: T3_PATH, allowProbe: false },
    { proxyUrl: "http://computer.internal/no-model", models: [model("claude-haiku-5-5")], readStateFile: (file) => (file === EXTENSION ? PI_T3_MCP_EXTENSION_SOURCE : undefined), piExtensionSource: PI_T3_MCP_EXTENSION_SOURCE },
  );
  if ("refused" in answer) throw new Error(`the profile refused: ${answer.refused}`);
  return answer;
};

/** pi's launch as t3 asks for it. */
export const piLaunchOf = (key: string): Launch =>
  launchOf({ cli: "pi", args: ["--mode", "rpc", "--extension", EXTENSION, "--provider", "anthropic", "--model", "claude-haiku-5-5"], key, env: { T3_PI_RUNTIME_MODE: "approval-required" } });

/** The image built, and the stand-in key host up on its internal network; `stop` removes both containers' network. */
export const startHarness = (name: string, nonces: ReadonlyArray<string>) => {
  const keyhost = `${name}-keyhost`;
  const network = `${name}-int`;
  const stop = () => {
    docker(["rm", "-f", keyhost], { quiet: true });
    docker(["network", "rm", network], { quiet: true });
  };
  stop();
  docker([
    "build", "-q", "-t", IMAGE, "-f", path.join(here, "Dockerfile"),
    "--build-arg", `CODEX_VERSION=${CLIS.codex.version}`, "--build-arg", `CODEX_SHA256=${CLIS.codex.sha256}`, "--build-arg", `CODEX_SHA256_ARM64=${CLIS.codex.sha256Arm64}`,
    "--build-arg", `OPENCODE_VERSION=${CLIS.opencode.version}`, "--build-arg", `OPENCODE_SHA256=${CLIS.opencode.sha256}`, "--build-arg", `OPENCODE_SHA256_ARM64=${CLIS.opencode.sha256Arm64}`,
    imageContext,
  ]);
  docker(["network", "create", "--internal", network]);
  // The stand-in `computer.internal`: a key for any of the probe's nonces (no model is called), NXDOMAIN for every name.
  docker(["run", "-d", "--name", keyhost, "--network", network, "--network-alias", "computer.internal", "-e", "KEYHOST_MODEL_KEY=probe-key", "-e", `KEYHOST_NONCES=${nonces.join(",")}`, "-v", `${here}:/k:ro`, "node:26.13.0-bookworm-slim", "node", "/k/keyhost.mjs"]);
  const keyhostIp = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, keyhost]).stdout.trim();
  return { network, keyhostIp, stop };
};

export interface RunInput {
  readonly harness: { readonly network: string; readonly keyhostIp: string };
  readonly name: string;
  readonly launch: Launch;
  readonly marker: string;
  readonly nonce: string;
  /** The host directory mounted at /workspace. */
  readonly workspace: string;
  /** The argv in place of the launch's. */
  readonly argv?: ReadonlyArray<string>;
  /** Files written besides the launch's. */
  readonly files?: Launch["files"];
  /** Shell run before the launcher. */
  readonly setup?: string;
  /** More `docker run` arguments (volumes). */
  readonly dockerArgs?: ReadonlyArray<string>;
}

/** The `docker run` command of one CLI process, launched as the Workspace DO launches it. */
export const runCommand = (input: RunInput): Array<string> => {
  const env: Record<string, string> = {
    ...input.launch.env,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    T3FLARE_EXEC: input.marker,
    T3FLARE_MODEL_KEY_NONCE: input.nonce,
  };
  const command = processCommand({
    marker: input.marker,
    t3Path: T3_PATH,
    cwd: T3_PATH,
    argv: input.argv ?? input.launch.argv,
    files: [...(input.launch.files ?? []), ...(input.files ?? [])],
    ...(input.launch.links ? { links: input.launch.links } : {}),
  });
  return [
    "docker", "run", "--rm", "-i", "--name", `${input.name}-${input.marker}`, "--network", input.harness.network, "--dns", input.harness.keyhostIp,
    "-v", `${input.workspace}:/workspace`, ...(input.dockerArgs ?? []),
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    IMAGE, "bash", "-c", `${input.setup ?? ""}\n${command}`,
  ];
};

/** Runs a JSON-RPC driver (`codex-rpc.mjs`, `pi-rpc.mjs`, `acp-rpc.mjs`) over `command`; its summary, or why it failed. */
export const drive = (driver: string, scenario: unknown, command: ReadonlyArray<string>): any => {
  const result = spawnSync("node", [path.join(here, driver), JSON.stringify(scenario), "--", ...command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const line = (result.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { driverFailed: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500) };
  }
};

/** OpenCode's Skills for the fixture's cwd from its own server's `GET /api/skill` (it lists none over ACP), with the profile's environment and system configuration. */
export const openCodeServedSkills = (input: Omit<RunInput, "argv">): { readonly skills: ReadonlyArray<any>; readonly raw: unknown } => {
  const home = `/var/lib/t3flare/cli/${input.marker}`;
  const script = [
    "set -eu",
    `mkdir -p /etc/opencode "$XDG_DATA_HOME/opencode/log" && install -m 644 ${home}/opencode.json /etc/opencode/opencode.json`,
    "OPENCODE_SERVER_PASSWORD=probe /opt/t3flare/opencode/opencode serve --hostname 127.0.0.1 --port 4096 >/dev/null 2>&1 &",
    "for i in $(seq 1 60); do curl -fsS -u opencode:probe -o /dev/null http://127.0.0.1:4096/api/location 2>/dev/null && break; sleep 1; done",
    // The first request boots the location, whose skill scan settles after it: ask again once it has.
    `curl -fsS -u opencode:probe -G --data-urlencode 'location[directory]=${T3_PATH}' -o /dev/null http://127.0.0.1:4096/api/skill`,
    "sleep 5",
    `curl -fsS -u opencode:probe -G --data-urlencode 'location[directory]=${T3_PATH}' http://127.0.0.1:4096/api/skill`,
  ].join("\n");
  const [binary, ...args] = runCommand({ ...input, files: [...(input.files ?? []), { path: `${home}/serve.sh`, text: script, mode: 0o700 }], argv: ["/bin/bash", `${home}/serve.sh`] });
  const serve = spawnSync(binary!, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
  let served: any;
  try {
    served = JSON.parse(serve.stdout);
  } catch {
    served = undefined;
  }
  const skills: ReadonlyArray<any> = Array.isArray(served) ? served : (served?.data ?? served?.value ?? []);
  return { skills, raw: { status: serve.status, stdout: skills.length > 0 ? undefined : String(serve.stdout).slice(0, 1500), stderr: String(serve.stderr ?? "").slice(-1200) } };
};
