// Claude Code's and OpenCode's profiles (step 4b, plan §4 with the review's F3, F5, F6 and M0's findings): what each
// ACP agent's process gets, whatever t3 asked, beside 4a's Codex and pi profiles (`cliProfiles.ts`). Pure.
//
// Claude Code: `claude-agent-acp` (it starts `claude` itself), its managed settings written into the process's home and
// installed by the image's launcher at /etc/claude-code (the highest settings source; a repository's `.claude/` cannot
// override a managed key), the proxy as its only provider, the key from `apiKeyHelper` (the launcher keeps the nonce in
// the home, not in the environment: M0 P1 found the env scrub plants decoy files in the repo).
// OpenCode: `opencode acp` exactly, its system configuration (`/etc/opencode`, outranking user and project files) with
// one provider, the key set by the image's server plugin, every home on local disk.
// Each honours the repository's own configuration otherwise, as stock t3's CLIs do (owner, 2026-11-12, back to stock):
// hooks, MCP servers, agents, skills, plugins, marketplaces. What stays pinned is K5: the endpoint and the key.
//
// SPI-1168: with an Anthropic Messages Model endpoint, Claude Code runs on the endpoints through the model relay instead
// (`ClaudeRelay`): its one base URL is the relay's model-routed URL, its models are the endpoints' slugs (the relay
// sends each request to its model's endpoint), and its key is the process's model handle, which `apiKeyHelper` reads
// from the launcher's environment (`CLAUDE_HANDLE_HELPER`). The managed settings are the Container's, shared by every
// Claude process in it, so nothing in them is one process's.
//
// SPI-1169: with an endpoint whose API OpenCode speaks (Anthropic Messages, OpenAI Responses, OpenAI-compatible
// Completions), OpenCode runs on the endpoints through the model relay instead (`OpenCodeRelay`): one OpenCode provider
// per endpoint (`t3flare-endpoint-<id>`, its package by API), each at the relay's per-endpoint URL, and the image's
// plugin gives each the process's model handle as its key, from OpenCode's own start environment.
import type { CatalogModel } from "@t3flare/models";
import { SMALL_MODEL_SLUG, DEFAULT_MODEL_SLUG } from "@t3flare/models";
import { type EndpointApi, type ModelEndpoint, parseEndpointSlug } from "@t3flare/models/endpoints";
import { endpointProviderId, modelRelayUrl, modelRoutedRelayUrl } from "@t3flare/models/relay";
import { CLI_HOMES } from "@t3flare/sandbox-image/process";
import { SKILLS_MOUNT } from "@t3flare/skills";
import { HARNESS_ROOT } from "@t3flare/workspace-client";

import type { Launch, LaunchAnswer, LaunchInput, ProfileContext } from "./cliProfiles.ts";

/** The image's CLI binaries (`cliProfiles.ts` `CLI_BIN`, restated: that module imports this one). */
const CLI_BIN = "/opt/t3flare/bin";
const homeOf = (key: string) => `${CLI_HOMES}/${key}`;

/**
 * SPI-1153: the Environment skill set in a CLI's user-level Skill root, linked to the Workspace's read-only mount, never
 * copied, so a CLI process lists the set the Workspace holds when it starts (all four CLIs list skills only at process
 * start; a running Claude Code or OpenCode keeps serving what it cached). The launcher makes the link in the process's fresh home;
 * nothing writes through it (the mount is read-only from the Container's first command, SPI-1148's lock). Every
 * profile's (`cliProfiles.ts` imports it from here).
 */
export const environmentSkillsLink = (path: string) => ({ path, target: SKILLS_MOUNT });

/** Claude's session files, synced (resume after the Container sleeps, M0 P5). */
export const CLAUDE_PROJECTS = `${HARNESS_ROOT}/claude/projects`;
/** Where OpenCode's database snapshot lives, synced (plan §7, M4). */
export const OPENCODE_SNAPSHOT_DIR = `${HARNESS_ROOT}/opencode`;
/**
 * The image's OpenCode key plugin (apps/sandbox-image/image/opencode-key-plugin): the Model proxy's key from the key
 * helper, or (SPI-1169) the process's model handle on each endpoint's provider.
 */
export const OPENCODE_KEY_PLUGIN = "/opt/t3flare/share/opencode-key-plugin";
/** The helper Claude Code runs for its key: the image's, reading this process's nonce from its home. */
export const CLAUDE_KEY_HELPER = `${CLI_BIN}/t3flare-claude-key`;
/**
 * The helper Claude Code runs for its key on the model relay (SPI-1168): the image's, printing this process's model
 * handle from the environment its launcher started claude-agent-acp with; no file and no Claude environment holds it.
 */
export const CLAUDE_HANDLE_HELPER = `${CLI_BIN}/t3flare-claude-handle`;

/**
 * Claude Code on the Model endpoints (SPI-1168, `provider/cli/claudeEndpoints.ts` `claudeRelayOf`): the Anthropic
 * Messages endpoints its handle is for, their models' slugs, and the background model's slug.
 */
export interface ClaudeRelay {
  readonly endpoints: ReadonlyArray<string>;
  readonly models: ReadonlyArray<string>;
  readonly backgroundModel: string | undefined;
  /**
   * The slugs Claude Code's `opus` and `sonnet` aliases resolve to (its own default model and its subagents' aliases):
   * each a slug, as the routed URL needs. Undefined: no model to give.
   */
  readonly opusModel: string | undefined;
  readonly sonnetModel: string | undefined;
}
/**
 * OpenCode on the Model endpoints (SPI-1169, `provider/cli/opencodeEndpoints.ts` `opencodeRelayOf`): the endpoints whose
 * API it speaks that list a model (its handle is for these), the default model's and the small model's slugs.
 */
export interface OpenCodeRelay {
  readonly endpoints: ReadonlyArray<Pick<ModelEndpoint, "id" | "label" | "api" | "models">>;
  readonly model: string | undefined;
  readonly smallModel: string | undefined;
}

/**
 * OpenCode's provider package for each API it speaks, and the path its base URL takes beyond the endpoint's: Anthropic's
 * SDK appends `/messages` to a base URL that holds `/v1` (an endpoint's base URL does not, as pi-ai's), the OpenAI
 * packages `/responses` and `/chat/completions` to one that does. Other APIs' endpoints are not offered to OpenCode.
 */
export const OPENCODE_PACKAGES: Readonly<Partial<Record<EndpointApi, { readonly package: string; readonly path: string }>>> = {
  "anthropic-messages": { package: "@opencode/ai/providers/anthropic-compatible", path: "/v1" },
  "openai-responses": { package: "@opencode/ai/providers/openai-compatible-responses", path: "" },
  "openai-completions": { package: "@opencode/ai/providers/openai-compatible", path: "" },
};

/**
 * The processes whose start environment holds an OpenCode process's model handle (SPI-1169), by command line: only the
 * launch chain's setsid. The launcher starts OpenCode without it; the key plugin reads it from there.
 */
export const OPENCODE_HANDLE_HOLDERS: ReadonlyArray<string> = ["setsid --wait /opt/t3flare/bin/opencode acp"];

/** Whether OpenCode gets a provider for an endpoint: an API it speaks, and a model (`opencodeEndpoints`, the profile). */
export const opencodeServes = (endpoint: Pick<ModelEndpoint, "api" | "models">): boolean => OPENCODE_PACKAGES[endpoint.api] !== undefined && endpoint.models.length > 0;

/** The model as OpenCode names it on the relay: its endpoint's provider and the model's own id. */
export const opencodeEndpointModel = (slug: string): string | undefined => {
  const parsed = parseEndpointSlug(slug);
  return parsed === undefined ? undefined : `${endpointProviderId(parsed.endpointId)}/${parsed.modelId}`;
};

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

/**
 * Where Claude Code gets its models (SPI-1168): the Model proxy's URL, models and key helper, or the model relay's
 * routed URL, the endpoints' slugs and the handle helper, with the endpoints its handle is for.
 */
export type ClaudeMode =
  | { readonly kind: "proxy"; readonly baseUrl: string; readonly keyHelper: string; readonly availableModels: ReadonlyArray<string>; readonly aliases: Readonly<Record<string, string>> }
  | {
      readonly kind: "relay";
      readonly baseUrl: string;
      readonly keyHelper: string;
      readonly availableModels: ReadonlyArray<string>;
      readonly aliases: Readonly<Record<string, string>>;
      /** The endpoints the process's model handle is for. */
      readonly endpoints: ReadonlyArray<string>;
    };

/** The alias variables set, by their model (an undefined model leaves Claude Code's own). */
const aliasesOf = (models: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(models).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** Claude Code's mode for a profile's context: the relay's when it has a `claudeRelay`, else the proxy's. */
export const claudeModeOf = (context: Pick<ProfileContext, "proxyUrl" | "models" | "claudeRelay">): ClaudeMode => {
  const relay = context.claudeRelay;
  if (relay === undefined) {
    return { kind: "proxy", baseUrl: context.proxyUrl, keyHelper: CLAUDE_KEY_HELPER, availableModels: context.models.map((model) => model.id), aliases: { ANTHROPIC_DEFAULT_HAIKU_MODEL: idOf(SMALL_MODEL_SLUG) } };
  }
  return {
    kind: "relay",
    baseUrl: modelRoutedRelayUrl,
    keyHelper: CLAUDE_HANDLE_HELPER,
    availableModels: relay.models,
    // Every alias Claude Code resolves on its own is a slug: the routed URL refuses any other model (400).
    aliases: aliasesOf({ ANTHROPIC_DEFAULT_HAIKU_MODEL: relay.backgroundModel, ANTHROPIC_DEFAULT_SONNET_MODEL: relay.sonnetModel, ANTHROPIC_DEFAULT_OPUS_MODEL: relay.opusModel }),
    endpoints: relay.endpoints,
  };
};

/** The variables Claude Code gets from both its launch environment and the managed `env` (M0 P1, P3). */
const claudeSwitches = (mode: ClaudeMode): Record<string, string> => ({
  ANTHROPIC_BASE_URL: mode.baseUrl,
  ...mode.aliases,
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

/** The relay's server names an ACP agent is given (acpDriver's session servers): the owner's third-party servers. */
const relayNames = (context: ProfileContext): ReadonlyArray<string> => (context.relay === undefined ? [] : context.relay.servers);

/**
 * Claude Code's managed settings (`/etc/claude-code/managed-settings.json`): the endpoint and the key (K5), and the
 * asking mode the flavor pins (`acpFlavor.ts`). `relayServers`: the MCP relay's servers (ADR-0028; the entries
 * themselves, with the process's handle, come per session over ACP, review H2), allowed without Claude's own prompt
 * because the relay decides and asks. The repository's `.claude/` is honoured for everything else. `mode`: the proxy's
 * or the model relay's (SPI-1168, `claudeModeOf`).
 */
export const claudeManagedSettings = (mode: ClaudeMode, relayServers: ReadonlyArray<string> = []) => ({
  apiKeyHelper: mode.keyHelper,
  // Review F3: only the endpoint the managed env pins is admitted.
  allowedProviders: ["customEndpoint"],
  availableModels: [...mode.availableModels],
  env: { ...Object.fromEntries(CLAUDE_PINNED_EMPTY.map((name) => [name, ""])), ...claudeSwitches(mode) },
  skipWebFetchPreflight: true,
  disableClaudeAiConnectors: true,
  cleanupPeriodDays: 60,
  // The asking mode the flavor pins: t3 decides each request (acpFlavor.ts). Claude's `auto` mode is not disabled: t3's
  // `auto` selects it, as stock t3's Claude adapter does.
  permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable", allow: relayServers.map((server) => `mcp__${server}`), ask: [], deny: [] },
  // With Claude's own sandbox on, `autoAllowBashIfSandboxed` would run commands without asking t3.
  sandbox: { enabled: false },
});

const claudeLaunch = (input: LaunchInput, context: ProfileContext): LaunchAnswer => {
  if (input.args.length !== 0) return { refused: `Claude Code runs here only as \`claude-agent-acp\` (not with ${input.args.join(" ")})` };
  const home = homeOf(input.key);
  const thread = input.env.T3CODE_THREAD_ID;
  const mode = claudeModeOf(context);
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
      ...claudeSwitches(mode),
    },
    files: [{ path: `${home}/managed-settings.json`, text: `${JSON.stringify(claudeManagedSettings(mode, relayNames(context)), null, 1)}\n` }],
    // SPI-1153: the Environment skill set as Claude Code's user-level root (`$CLAUDE_CONFIG_DIR/skills`).
    links: [{ path: `${home}/claude/projects`, target: CLAUDE_PROJECTS }, environmentSkillsLink(`${home}/claude/skills`)],
    ...(thread === undefined ? {} : { thread }),
    // SPI-1168: the Workspace DO gives the process a model handle for these endpoints, in its environment only.
    ...(mode.kind === "relay" ? { modelRelay: [...mode.endpoints] } : {}),
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
 * Where OpenCode gets its models (SPI-1169): the Model proxy (its one `t3flare` provider, the key plugin asking the key
 * helper), or the model relay (one provider per endpoint, the key plugin giving each the process's model handle).
 */
export type OpenCodeMode = { readonly kind: "proxy"; readonly proxyUrl: string; readonly models: ReadonlyArray<CatalogModel> } | { readonly kind: "relay"; readonly relay: OpenCodeRelay };

/** OpenCode's mode for a profile's context: the relay's when it has an `opencodeRelay`, else the proxy's. */
export const opencodeModeOf = (context: Pick<ProfileContext, "proxyUrl" | "models" | "opencodeRelay">): OpenCodeMode =>
  context.opencodeRelay === undefined ? { kind: "proxy", proxyUrl: context.proxyUrl, models: context.models } : { kind: "relay", relay: context.opencodeRelay };

/** A model's entry in an OpenCode provider: its name, inputs and limits. */
const opencodeModelEntry = (model: { readonly name: string; readonly input: ReadonlyArray<string>; readonly contextWindow: number; readonly maxTokens: number }) => ({
  name: model.name,
  capabilities: { input: [...model.input] },
  limit: { context: model.contextWindow, output: model.maxTokens },
});

/** The providers, default and small models of a mode, as OpenCode names them (`<provider>/<model>`). */
const opencodeProviders = (mode: OpenCodeMode) => {
  if (mode.kind === "proxy") {
    const { proxyUrl, models } = mode;
    const ids = new Set(models.map((model) => model.id));
    const pick = (slug: string) => (ids.has(idOf(slug)) ? `t3flare/${idOf(slug)}` : models[0] === undefined ? undefined : `t3flare/${models[0].id}`);
    return {
      providers: {
        t3flare: {
          name: "Model proxy",
          package: "@opencode/ai/providers/anthropic-compatible",
          settings: { baseURL: `${proxyUrl}/v1` },
          models: Object.fromEntries(models.map((model) => [model.id, opencodeModelEntry(model)])),
        },
      },
      model: pick(DEFAULT_MODEL_SLUG),
      small: pick(SMALL_MODEL_SLUG),
    };
  }
  const { relay } = mode;
  const providers: Record<string, unknown> = {};
  for (const endpoint of relay.endpoints.filter(opencodeServes)) {
    const wiring = OPENCODE_PACKAGES[endpoint.api]!;
    // The relay's per-endpoint URL. The key plugin treats a provider as the relay's only with this base URL, and puts the
    // handle only into a request sent to it (`relay.js`).
    const pinned = { package: wiring.package, settings: { baseURL: `${modelRelayUrl(endpoint.id)}${wiring.path}` } };
    providers[endpointProviderId(endpoint.id)] = {
      name: endpoint.label,
      ...pinned,
      // Pinned on each model too: OpenCode lets a model's own `package` and `settings.baseURL` win over its provider's,
      // and this system configuration outranks a repository's for the keys it sets, so the endpoint's models stay here.
      models: Object.fromEntries(endpoint.models.map((model) => [model.id, { ...opencodeModelEntry(model), ...pinned }])),
    };
  }
  return {
    providers,
    model: relay.model === undefined ? undefined : opencodeEndpointModel(relay.model),
    small: relay.smallModel === undefined ? undefined : opencodeEndpointModel(relay.smallModel),
  };
};

/**
 * OpenCode's system configuration (`/etc/opencode/opencode.json`). `relayServers`: the MCP relay's servers (ADR-0028),
 * admitted by policy and their tools allowed without OpenCode's prompt (the relay decides and asks). `mode`: the
 * proxy's or the model relay's (SPI-1169, `opencodeModeOf`); only its providers are usable.
 */
export const opencodeConfig = (mode: OpenCodeMode, relayServers: ReadonlyArray<string> = []) => {
  // The relay's tools are not asked about by OpenCode: the relay decides and asks on the thread (one card per write).
  const asking = [...ASKING, ...relayServers.map((server) => allow(`${server}_*`, "*"))];
  const { providers, model, small } = opencodeProviders(mode);
  return {
    $schema: "https://opencode.ai/config.json",
    providers,
    ...(model === undefined ? {} : { model }),
    ...(small === undefined ? {} : { small_model: small }),
    plugins: [OPENCODE_KEY_PLUGIN],
    policies: [
      deny("provider.use"),
      ...Object.keys(providers).map((provider) => allow("provider.use", provider)),
      // No vendor account (K3): OpenCode's sign-in and its hosted web search.
      deny("integration.connect"),
      deny("websearch.use"),
      ...[...relayServers, "t3-code"].map((server) => allow("tool.use", `${server}_*`)),
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
  const mode = opencodeModeOf(context);
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
    files: [{ path: `${home}/opencode.json`, text: `${JSON.stringify(opencodeConfig(mode, relayNames(context)), null, 1)}\n` }],
    // SPI-1153: the Environment skill set as OpenCode's user-level root (`$XDG_CONFIG_HOME/opencode/skills`).
    links: [environmentSkillsLink(`${home}/config/opencode/skills`)],
    ...(thread === undefined ? {} : { thread }),
    // SPI-1169: the Workspace DO gives the process a model handle for these endpoints, in its environment only.
    ...(mode.kind === "relay" ? { modelRelay: mode.relay.endpoints.filter(opencodeServes).map((endpoint) => endpoint.id) } : {}),
    droppedEnv: dropped(input.env),
  } satisfies Launch;
};

/** The launch of an ACP agent t3 asked for, or why it is refused. */
export const acpProfileLaunch = (cli: "claude" | "opencode", input: LaunchInput, context: ProfileContext): LaunchAnswer =>
  cli === "claude" ? claudeLaunch(input, context) : opencodeLaunch(input, context);
