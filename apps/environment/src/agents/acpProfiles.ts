// Claude Code's and OpenCode's profiles (step 4b, plan §4 with the review's F3, F5, F6 and M0's findings): what each
// ACP agent's process gets, whatever t3 asked, beside 4a's Codex and pi profiles (`cliProfiles.ts`). Pure.
//
// Claude Code: `claude-agent-acp` (it starts `claude` itself), its managed settings written into the process's home and
// installed by the image's launcher at /etc/claude-code (the highest settings source; a repository's `.claude/` cannot
// override a managed key), the proxy as its only provider, the key from `apiKeyHelper` (the launcher keeps the nonce in
// the home, not in the environment: M0 P1 found the env scrub plants decoy files in the repo).
// OpenCode: `opencode acp` exactly, its system configuration (`/etc/opencode`, outranking user and project files) with
// one provider and deny-by-default policies, the key set by the image's server plugin, every home on local disk.
import type { CatalogModel } from "@t3flare/models";
import { SMALL_MODEL_SLUG, DEFAULT_MODEL_SLUG } from "@t3flare/models";
import { CLI_HOMES } from "@t3flare/sandbox-image/process";
import { HARNESS_ROOT } from "@t3flare/workspace-client";

import type { Launch, LaunchAnswer, LaunchInput, ProfileContext } from "./cliProfiles.ts";

/** The image's CLI binaries (`cliProfiles.ts` `CLI_BIN`, restated: that module imports this one). */
const CLI_BIN = "/opt/t3flare/bin";
const homeOf = (key: string) => `${CLI_HOMES}/${key}`;

/** Claude's session files, synced (resume after the Container sleeps, M0 P5). */
export const CLAUDE_PROJECTS = `${HARNESS_ROOT}/claude/projects`;
/** Where OpenCode's database snapshot lives, synced (plan §7, M4). */
export const OPENCODE_SNAPSHOT_DIR = `${HARNESS_ROOT}/opencode`;
/** The image's OpenCode key plugin (apps/sandbox-image/image/opencode-key-plugin). */
export const OPENCODE_KEY_PLUGIN = "/opt/t3flare/share/opencode-key-plugin";
/** The helper Claude Code runs for its key: the image's, reading this process's nonce from its home. */
export const CLAUDE_KEY_HELPER = `${CLI_BIN}/t3flare-claude-key`;
/** The `claude` binary the image installs (the SDK's linux-x64 platform package). */
export const CLAUDE_EXECUTABLE = "/opt/t3flare/claude/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";

/** t3's env keys these profiles read; everything else is dropped. */
const READ_ENV = new Set(["T3CODE_THREAD_ID"]);
const dropped = (env: LaunchInput["env"]): ReadonlyArray<string> => Object.keys(env).filter((key) => env[key] !== undefined && !READ_ENV.has(key));

const idOf = (slug: string) => slug.slice(slug.indexOf("/") + 1);

/**
 * Variables a repository's `.claude/settings.json` `env` could use to send Claude Code's requests, and the helper's key,
 * somewhere else (review F3): pinned empty in the managed `env`, which wins per variable.
 */
export const CLAUDE_PINNED_EMPTY: ReadonlyArray<string> = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

/** The variables Claude Code gets from both its launch environment and the managed `env` (M0 P1, P3). */
const claudeSwitches = (proxyUrl: string): Record<string, string> => ({
  ANTHROPIC_BASE_URL: proxyUrl,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: idOf(SMALL_MODEL_SLUG),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_UPDATES: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  // ADR-0012: nothing retries into spend.
  CLAUDE_CODE_MAX_RETRIES: "1",
  // M0 P1: the scrub isolates Bash with bubblewrap and leaves empty decoy files (package.json, .gitmodules, .env*) in
  // the repo. Off; the nonce is kept out of the environment instead (the launcher).
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
});

/** The relay's server names an ACP agent is given (acpDriver's session servers): the owner's and t3's own (SPI-1039). */
const relayNames = (context: ProfileContext): ReadonlyArray<string> => (context.relay === undefined ? [] : [...context.relay.servers, "t3-code"]);

/** Where the MCP relay's servers are (ADR-0028): the only MCP URLs Claude Code and OpenCode admit. */
export const RELAY_URL_PATTERN = "http://computer.internal/t3flare/mcp/*";

/**
 * Claude Code's managed settings (`/etc/claude-code/managed-settings.json`). `relayServers`: the MCP relay's servers
 * (ADR-0028; the entries themselves, with the process's handle, come per session over ACP, review H2), allowed without
 * Claude's own prompt because the relay decides and asks.
 */
export const claudeManagedSettings = (proxyUrl: string, models: ReadonlyArray<CatalogModel>, relayServers: ReadonlyArray<string> = []) => ({
  apiKeyHelper: CLAUDE_KEY_HELPER,
  // Review F3: only the endpoint the managed env pins is admitted.
  allowedProviders: ["customEndpoint"],
  availableModels: models.map((model) => model.id),
  env: { ...Object.fromEntries(CLAUDE_PINNED_EMPTY.map((name) => [name, ""])), ...claudeSwitches(proxyUrl) },
  skipWebFetchPreflight: true,
  disableClaudeAiConnectors: true,
  cleanupPeriodDays: 60,
  permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable", allow: relayServers.map((server) => `mcp__${server}`), ask: [], deny: [] },
  disableAutoMode: "disable",
  allowManagedPermissionRulesOnly: true,
  allowManagedHooksOnly: true,
  allowManagedMcpServersOnly: true,
  allowedMcpServers: relayServers.length === 0 ? [] : [{ serverUrl: RELAY_URL_PATTERN }],
  // Review F5: no marketplace, no skill shell injection, no repo hooks, MCP servers or agents.
  strictKnownMarketplaces: [],
  disableSkillShellExecution: true,
  strictPluginOnlyCustomization: ["hooks", "mcp", "agents"],
  // With Claude's own sandbox on, `autoAllowBashIfSandboxed` would run commands without asking t3.
  sandbox: { enabled: false },
});

const claudeLaunch = (input: LaunchInput, context: ProfileContext): LaunchAnswer => {
  if (input.args.length !== 0) return { refused: `Claude Code runs here only as \`claude-agent-acp\` (not with ${input.args.join(" ")})` };
  const home = homeOf(input.key);
  const thread = input.env.T3CODE_THREAD_ID;
  return {
    argv: [`${CLI_BIN}/claude-agent-acp`],
    env: {
      HOME: "/root",
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: `${home}/claude`,
      CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1",
      CLAUDE_CODE_EXECUTABLE: CLAUDE_EXECUTABLE,
      // Ask the helper at start and after a 401, not every 5 minutes (M0 P1: one grant per process).
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(24 * 3_600_000),
      ...claudeSwitches(context.proxyUrl),
    },
    files: [{ path: `${home}/managed-settings.json`, text: `${JSON.stringify(claudeManagedSettings(context.proxyUrl, context.models, relayNames(context)), null, 1)}\n` }],
    links: [{ path: `${home}/claude/projects`, target: CLAUDE_PROJECTS }],
    ...(thread === undefined ? {} : { thread }),
    droppedEnv: dropped(input.env),
  } satisfies Launch;
};

/** Every agent's rules: ask for everything, let reads through (OpenCode's default policy allows everything). */
const ASKING: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }> = [
  { action: "*", resource: "*", effect: "ask" },
  ...["read", "glob", "grep", "list", "question"].map((action) => ({ action, resource: "*", effect: "allow" })),
  { action: "external_directory", resource: "*", effect: "ask" },
];

const deny = (action: string, resource = "*") => ({ action, resource, effect: "deny" as const });
const allow = (action: string, resource: string) => ({ action, resource, effect: "allow" as const });

/**
 * OpenCode's system configuration (`/etc/opencode/opencode.json`). `relayServers`: the MCP relay's servers (ADR-0028),
 * admitted by policy and their tools allowed without OpenCode's prompt (the relay decides and asks).
 */
export const opencodeConfig = (proxyUrl: string, models: ReadonlyArray<CatalogModel>, relayServers: ReadonlyArray<string> = []) => {
  const ids = new Set(models.map((model) => model.id));
  const pick = (slug: string) => (ids.has(idOf(slug)) ? idOf(slug) : models[0]?.id);
  // The relay's tools are not asked about by OpenCode: the relay decides and asks on the thread (one card per write).
  const asking = [...ASKING, ...relayServers.map((server) => allow(`${server}_*`, "*"))];
  const main = pick(DEFAULT_MODEL_SLUG);
  const small = pick(SMALL_MODEL_SLUG);
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      t3flare: {
        name: "Model proxy",
        package: "@opencode/ai/providers/anthropic-compatible",
        settings: { baseURL: `${proxyUrl}/v1` },
        models: Object.fromEntries(
          models.map((model) => [model.id, { name: model.name, capabilities: { input: [...model.input] }, limit: { context: model.contextWindow, output: model.maxTokens } }]),
        ),
      },
    },
    ...(main === undefined ? {} : { model: `t3flare/${main}` }),
    ...(small === undefined ? {} : { small_model: `t3flare/${small}` }),
    plugins: [OPENCODE_KEY_PLUGIN],
    policies: [
      deny("provider.use"),
      allow("provider.use", "t3flare"),
      deny("integration.connect"),
      deny("mcp.use"),
      ...relayServers.map((server) => allow("mcp.use", server)),
      ...relayServers.map((server) => allow("tool.use", `${server}_*`)),
      deny("skill.use"),
      deny("plugin.use"),
      allow("plugin.use", OPENCODE_KEY_PLUGIN),
      deny("websearch.use"),
      // A repository's agents: no subagent but OpenCode's own two.
      deny("tool.use", "subagent:*"),
      allow("tool.use", "subagent:general"),
      allow("tool.use", "subagent:explore"),
    ],
    permissions: asking,
    agents: {
      build: { permissions: asking },
      plan: { permissions: [...asking, deny("edit")] },
      general: { permissions: asking },
      explore: { permissions: asking },
    },
    update: "disable",
    share: "disabled",
    snapshots: false,
    lsp: false,
    formatter: false,
  };
};

const opencodeLaunch = (input: LaunchInput, context: ProfileContext): LaunchAnswer => {
  if (input.args.length !== 1 || input.args[0] !== "acp") return { refused: `OpenCode runs here only as \`opencode acp\` (not \`opencode ${input.args.join(" ")}\`)` };
  const home = homeOf(input.key);
  const thread = input.env.T3CODE_THREAD_ID;
  return {
    argv: [`${CLI_BIN}/opencode`, "acp"],
    env: {
      HOME: "/root",
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: `${home}/config`,
      XDG_DATA_HOME: `${home}/data`,
      XDG_CACHE_HOME: `${home}/cache`,
      XDG_STATE_HOME: `${home}/state`,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    },
    files: [{ path: `${home}/opencode.json`, text: `${JSON.stringify(opencodeConfig(context.proxyUrl, context.models, relayNames(context)), null, 1)}\n` }],
    ...(thread === undefined ? {} : { thread }),
    droppedEnv: dropped(input.env),
  } satisfies Launch;
};

/** The launch of an ACP agent t3 asked for, or why it is refused. */
export const acpProfileLaunch = (cli: "claude" | "opencode", input: LaunchInput, context: ProfileContext): LaunchAnswer =>
  cli === "claude" ? claudeLaunch(input, context) : opencodeLaunch(input, context);
