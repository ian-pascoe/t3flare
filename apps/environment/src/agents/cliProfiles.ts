// CLI profiles (step 4a, plan §4 with the review's F2, F4, F5 and M0's findings): what a CLI agent process gets, fixed
// here whatever t3 asked: its binary in the image, an allowlisted environment (never `process.env`), the model proxy as
// its only model provider with the key helper, and a home built fresh on the Container's own disk with only its session
// directory synced. The pure part: no I/O beyond reading the State directory for pi's extension.
import { type CatalogModel } from "@t3flare/models";
import { HARNESS_ROOT } from "@t3flare/workspace-client";

/** The CLIs the channel runs; `probe` is M1's test program (stages only). */
export type CliName = "codex" | "pi" | "probe";

export const CLI_BIN = "/opt/t3flare/bin";
/** Where CLI homes live in the Container (`apps/sandbox-image/src/process.ts` `CLI_HOMES`). */
export const CLI_HOMES = "/var/lib/t3flare/cli";
/** The synced session directories (beside the repo, outside every t3 path): the only CLI state that outlives a Container. */
export const CODEX_SESSIONS = `${HARNESS_ROOT}/codex/sessions`;
export const PI_SESSIONS = `${HARNESS_ROOT}/pi/sessions`;
/** pi sessions untouched this long are removed at a pi start (review F2's retention). */
export const PI_SESSION_RETENTION_DAYS = 60;
/** Codex keeps this provider id in its rollouts and needs it unchanged to resume. */
export const CODEX_PROVIDER_ID = "t3flare-proxy";
/** The variable the key helper sends as its nonce; Codex's shells never see it (review F4). */
export const NONCE_ENV = "T3FLARE_MODEL_KEY_NONCE";

export interface LaunchInput {
  readonly cli: CliName;
  /** The argv after the binary, as t3 sent it. */
  readonly args: ReadonlyArray<string>;
  readonly key: string;
  readonly cwd: string;
  /** The env t3 put on the spawn: read for a few named values, never passed on. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly allowProbe: boolean;
}

export interface ProfileContext {
  /** The model proxy's base URL (no trailing slash). */
  readonly proxyUrl: string;
  readonly models: ReadonlyArray<CatalogModel>;
  /** pi's extension as t3 wrote it, by its State-directory path; undefined when there is no such file. */
  readonly readStateFile: (path: string) => string | undefined;
  /** t3's own extension source: a copy is accepted only when it is exactly this (plan §5.2). */
  readonly piExtensionSource: string;
}

export interface Launch {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly files?: ReadonlyArray<{ readonly path: string; readonly text: string; readonly mode?: number }>;
  readonly links?: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  readonly prune?: ReadonlyArray<{ readonly dir: string; readonly days: number }>;
  readonly thread?: string;
  /** Names of t3's env keys not passed on (for the log). */
  readonly droppedEnv: ReadonlyArray<string>;
}

export type LaunchAnswer = Launch | { readonly refused: string };

const homeOf = (key: string) => `${CLI_HOMES}/${key}`;

/** t3's env keys the profiles read; everything else is dropped. */
const READ_ENV = new Set(["T3CODE_THREAD_ID", "T3_PI_RUNTIME_MODE", "T3_PI_MCP_EXTENSION_PATH"]);

const dropped = (env: LaunchInput["env"]): ReadonlyArray<string> => Object.keys(env).filter((key) => env[key] !== undefined && !READ_ENV.has(key));

const tomlString = (value: string) => JSON.stringify(value);

/** Codex's `-c` overrides (plan §4.3; M0: P3, P10, P11). Each value is TOML. */
export const codexOverrides = (proxyUrl: string, key: string): ReadonlyArray<string> => {
  const provider = [
    `name=${tomlString("Model proxy")}`,
    `base_url=${tomlString(`${proxyUrl}/v1`)}`,
    `wire_api="responses"`,
    "requires_openai_auth=false",
    "supports_websockets=false",
    "request_max_retries=1",
    "stream_max_retries=1",
    `auth={command=${tomlString(`${CLI_BIN}/t3flare-model-key`)},args=["codex"],timeout_ms=30000,refresh_interval_ms=0}`,
  ].join(",");
  return [
    `model_provider=${tomlString(CODEX_PROVIDER_ID)}`,
    `model_providers.${CODEX_PROVIDER_ID}={${provider}}`,
    // The process's own defaults (review F5; 0.167.2 refuses "untrusted" here, so every turn/start carries the guard's).
    `approval_policy="on-request"`,
    `sandbox_mode="read-only"`,
    // M0 P3: Ubuntu's /etc/profile resets PATH in a login shell, which hides Codex's apply_patch.
    "allow_login_shell=false",
    "check_for_update_on_startup=false",
    // M0 P10: these alone reach github.com and chatgpt.com.
    "features.plugins=false",
    "features.plugin_discovery_prefetch=false",
    "features.remote_plugin=false",
    "features.plugin_sharing=false",
    "features.apps=false",
    "features.tool_suggest=false",
    "features.image_generation=false",
    "features.multi_agent=false",
    "analytics.enabled=false",
    // Review F4: the nonce stays out of Codex's shells; the marker stays in them (part 2's kill script).
    `shell_environment_policy.exclude=[${tomlString(NONCE_ENV)}]`,
    `shell_environment_policy.set.T3FLARE_EXEC=${tomlString(key)}`,
  ];
};

const codexLaunch = (input: LaunchInput, context: ProfileContext): LaunchAnswer => {
  if (input.args.length !== 1 || input.args[0] !== "app-server") return { refused: `Codex runs here only as \`codex app-server\` (not \`codex ${input.args.join(" ")}\`)` };
  const home = homeOf(input.key);
  const thread = input.env.T3CODE_THREAD_ID;
  return {
    argv: [`${CLI_BIN}/codex`, "app-server", ...codexOverrides(context.proxyUrl, input.key).flatMap((value) => ["-c", value])],
    env: { HOME: "/root", LANG: "C.UTF-8", CODEX_HOME: `${home}/codex`, CODEX_SQLITE_HOME: `${home}/sqlite` },
    files: [{ path: `${home}/codex/config.toml`, text: "# t3flare: every setting comes from the command line (-c)\n" }],
    links: [{ path: `${home}/codex/sessions`, target: CODEX_SESSIONS }],
    ...(thread === undefined ? {} : { thread }),
    droppedEnv: dropped(input.env),
  };
};

/** pi's flags t3's Pi adapter sends (`buildPiRpcLaunch`, its fork); each with whether it takes a value. */
const PI_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ["--session", true],
  ["--no-session", false],
  ["--extension", true],
  ["--offline", false],
  ["--no-extensions", false],
  ["--no-tools", false],
  ["--fork", true],
  ["--provider", true],
  ["--model", true],
  ["--thinking", true],
]);

const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "full-access"]);

/** pi's `models.json` (plan §4.4): the proxy as the anthropic provider, every catalog model, a command for the key. */
export const piModelsJson = (proxyUrl: string, models: ReadonlyArray<CatalogModel>): string =>
  `${JSON.stringify(
    {
      providers: {
        anthropic: {
          baseUrl: proxyUrl,
          apiKey: `!${CLI_BIN}/t3flare-model-key pi`,
          models: models
            .filter((model) => model.provider === "anthropic")
            .map((model) => ({
              id: model.id,
              name: model.name,
              api: "anthropic-messages",
              reasoning: model.reasoning,
              input: [...model.input],
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            })),
        },
      },
    },
    null,
    1,
  )}\n`;

/** pi's agent settings: no project is trusted (review F2), few retries (ADR-0012: nothing retries into spend). */
export const PI_SETTINGS = `${JSON.stringify({ defaultProjectTrust: "never", retry: { maxRetries: 1 } }, null, 1)}\n`;

const piLaunch = (input: LaunchInput, context: ProfileContext): LaunchAnswer => {
  if (input.args[0] !== "--mode" || input.args[1] !== "rpc") return { refused: `pi runs here only as \`pi --mode rpc\`` };
  const home = homeOf(input.key);
  const rest: Array<string> = [];
  let extension: string | undefined;
  for (let i = 2; i < input.args.length; i++) {
    const arg = input.args[i]!;
    const takesValue = PI_FLAGS.get(arg);
    if (takesValue === undefined) return { refused: `pi's flag ${arg} is not one t3flare passes on` };
    if (!takesValue) {
      rest.push(arg);
      continue;
    }
    const value = input.args[++i];
    if (value === undefined) return { refused: `pi's flag ${arg} needs a value` };
    if (arg === "--extension") {
      if (extension !== undefined) return { refused: "pi gets one extension, t3's" };
      extension = value;
      continue;
    }
    if ((arg === "--session" || arg === "--fork") && !value.startsWith(`${PI_SESSIONS}/`)) {
      return { refused: `pi's session file must be in ${PI_SESSIONS} (got ${value})` };
    }
    rest.push(arg, value);
  }
  const forking = rest.includes("--no-extensions");
  const files: Array<{ path: string; text: string; mode?: number }> = [
    { path: `${home}/agent/models.json`, text: piModelsJson(context.proxyUrl, context.models) },
    { path: `${home}/agent/settings.json`, text: PI_SETTINGS },
  ];
  const env: Record<string, string> = {
    HOME: "/root",
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: `${home}/agent`,
    PI_CODING_AGENT_SESSION_DIR: PI_SESSIONS,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const extensionArgs: Array<string> = [];
  if (!forking) {
    // The extension is the permission hook (plan §5.2): required, exactly t3's, copied into the home.
    if (extension === undefined) return { refused: "pi starts here only with t3's permission extension" };
    const source = context.readStateFile(extension);
    if (source === undefined) return { refused: `pi's extension ${extension} is not in the State directory` };
    if (source !== context.piExtensionSource) return { refused: "pi's extension is not t3's own (its content differs)" };
    const bridged = `${home}/ext/${extension.replace(/^.*\//, "")}`;
    files.push({ path: bridged, text: source });
    extensionArgs.push("--extension", bridged);
    env.T3_PI_MCP_EXTENSION_PATH = bridged;
    // A missing or unknown mode is the extension's full access: here it is always set, and never above what t3 asked.
    const mode = input.env.T3_PI_RUNTIME_MODE;
    env.T3_PI_RUNTIME_MODE = mode !== undefined && RUNTIME_MODES.has(mode) ? mode : "approval-required";
  }
  const thread = input.env.T3CODE_THREAD_ID;
  return {
    argv: [`${CLI_BIN}/pi`, "--mode", "rpc", ...rest, ...extensionArgs, "--no-approve"],
    env,
    files,
    prune: [{ dir: PI_SESSIONS, days: PI_SESSION_RETENTION_DAYS }],
    ...(thread === undefined ? {} : { thread }),
    droppedEnv: dropped(input.env),
  };
};

/** M1's probe: echoes stdin lines to stdout and stderr, sleeps, and leaves a child that ignores TERM. */
export const PROBE_SCRIPT = [
  "trap '' TERM",
  "( trap '' TERM; while :; do sleep 1; done ) &",
  "trap - TERM",
  'while IFS= read -r line; do case "$line" in',
  '  exit*) exit "${line#exit }";;',
  '  big*) head -c "${line#big }" /dev/zero | tr "\\0" x; echo;;',
  '  *) printf "out:%s\\n" "$line"; printf "err:%s\\n" "$line" >&2;;',
  "esac; done",
].join("\n");

const probeLaunch = (input: LaunchInput): LaunchAnswer => {
  if (!input.allowProbe) return { refused: "the probe program runs on test stages only" };
  const home = homeOf(input.key);
  return { argv: ["/bin/bash", `${home}/probe.sh`], env: { HOME: "/root", LANG: "C.UTF-8" }, files: [{ path: `${home}/probe.sh`, text: PROBE_SCRIPT, mode: 0o700 }], droppedEnv: dropped(input.env) };
};

/** The launch of a CLI t3 asked for, or why it is refused. */
export const profileLaunch = (input: LaunchInput, context: ProfileContext): LaunchAnswer => {
  switch (input.cli) {
    case "codex":
      return codexLaunch(input, context);
    case "pi":
      return piLaunch(input, context);
    case "probe":
      return probeLaunch(input);
  }
};
