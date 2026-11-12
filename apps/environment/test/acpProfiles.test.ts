// @effect-diagnostics nodeBuiltinImport:off
// Claude Code's and OpenCode's profiles (step 4b, plan §4 with review F3, F5, F6 and M0's findings): what each process
// gets, whatever t3 asked. Expected values are M0's (docs/steps/step-4b/m0-local.json), not recomputed here.
import * as fs from "node:fs";
import * as path from "node:path";

import type { CatalogModel } from "@t3flare/models";
import { describe, expect, it } from "vitest";

import { CLAUDE_PROJECTS, OPENCODE_SNAPSHOT_DIR } from "../src/agents/acpProfiles.ts";
import { type ProfileContext, profileLaunch } from "../src/agents/cliProfiles.ts";

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  provider: "anthropic",
  vendor: "X",
  api: "anthropic-messages",
  slug: `anthropic/${id}`,
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 32_000,
  ...extra,
});

const context: ProfileContext = {
  proxyUrl: "https://proxy.example",
  models: [model("claude-sonnet-5-5", { reasoning: true, input: ["text", "image"] }), model("claude-haiku-5-5"), model("gpt-6-luna"), model("kimi-k3")],
  readStateFile: () => undefined,
  piExtensionSource: "",
};

const launch = (cli: "claude" | "opencode", args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  profileLaunch({ cli, args, key: "proc-7", cwd: "/w/demo", env, allowProbe: false }, context);

const fileOf = (answer: ReturnType<typeof launch>, suffix: string) => {
  if ("refused" in answer) throw new Error(answer.refused);
  const file = answer.files?.find((entry) => entry.path.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${suffix}`);
  return { ...file, json: JSON.parse(file.text) as Record<string, unknown> };
};

describe("Claude Code's profile", () => {
  it("runs the image's claude-agent-acp with no arguments, and refuses anything else", () => {
    const answer = launch("claude", [], { T3CODE_THREAD_ID: "thread-1", ANTHROPIC_API_KEY: "sk-x", HTTPS_PROXY: "http://evil" });
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.argv).toEqual(["/opt/t3flare/bin/claude-agent-acp"]);
    expect(answer.thread).toBe("thread-1");
    expect(answer.droppedEnv).toEqual(["ANTHROPIC_API_KEY", "HTTPS_PROXY"]);
    for (const args of [["--version"], ["--login"], ["mcp"]]) expect(launch("claude", args)).toHaveProperty("refused");
  });

  it("starts from a fresh home with only the session files synced, and no key or login in its environment", () => {
    const answer = launch("claude", []);
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.env).toMatchObject({
      HOME: "/root",
      CLAUDE_CONFIG_DIR: "/var/lib/t3flare/cli/proc-7/claude",
      CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1",
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "86400000",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
    });
    expect(Object.keys(answer.env).filter((name) => /API_KEY$|AUTH_TOKEN|OAUTH|NONCE|PROXY/.test(name))).toEqual([]);
    expect(answer.links).toEqual([{ path: "/var/lib/t3flare/cli/proc-7/claude/projects", target: CLAUDE_PROJECTS }]);
    expect(CLAUDE_PROJECTS).toBe("/workspace/.t3flare/claude/projects");
  });

  it("pins the endpoint and the key in managed settings a repository cannot override (review F3; K5; M0 P1, P3)", () => {
    const { json, mode } = fileOf(launch("claude", []), "/managed-settings.json");
    expect(mode ?? 0o600).toBe(0o600);
    expect(json).toMatchObject({
      apiKeyHelper: "/opt/t3flare/bin/t3flare-claude-key",
      allowedProviders: ["customEndpoint"],
      availableModels: ["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6-luna", "kimi-k3"],
      skipWebFetchPreflight: true,
      disableClaudeAiConnectors: true,
      permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable", allow: [], ask: [], deny: [] },
      sandbox: { enabled: false },
    });
    // The repository's own `.claude/` is honoured as stock t3 honours it (owner, 2026-11-12, back to stock): its hooks,
    // MCP servers, agents, skills, plugins, marketplaces and permission rules, and Claude's auto mode for t3's `auto`.
    for (const key of ["disableAutoMode", "allowManagedPermissionRulesOnly", "allowManagedHooksOnly", "allowManagedMcpServersOnly", "allowedMcpServers", "strictKnownMarketplaces", "disableSkillShellExecution", "strictPluginOnlyCustomization"]) {
      expect(json, key).not.toHaveProperty(key);
    }
    const env = json.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-5-5");
    // Pinned empty: every variable a repository's settings could use to send the request (and the key) elsewhere.
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(env[name], name).toBe("");
    }
    for (const name of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_UPDATES"]) expect(env[name], name).toBe("1");
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("0");
  });
});

/** Just enough JSON Schema (2020-12, the subset OpenCode's schema uses) to check our file against 2.2.7's. */
const violations = (schema: Record<string, unknown>, root: Record<string, unknown>, value: unknown, at = "$"): ReadonlyArray<string> => {
  const ref = schema.$ref as string | undefined;
  // An external reference (models.dev's model schema, used only by V1's `provider` key) is not followed.
  if (ref !== undefined) return ref.startsWith("#/$defs/") ? violations((root.$defs as Record<string, Record<string, unknown>>)[ref.slice(8)]!, root, value, at) : [];
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Array<Record<string, unknown>>).map((branch) => violations(branch, root, value, at));
    return branches.some((found) => found.length === 0) ? [] : [`${at}: matches no branch (${branches.map((found) => found[0]).join(" | ")})`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`];
  const type = schema.type as string | undefined;
  const typeOf = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  if (type !== undefined && type !== typeOf && !(type === "number" && typeOf === "integer")) return [`${at}: ${typeOf}, not ${type}`];
  if (type === "array") return (value as Array<unknown>).flatMap((item, index) => violations((schema.items ?? {}) as Record<string, unknown>, root, item, `${at}[${index}]`));
  if (type === "object") {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const found: Array<string> = [];
    for (const key of (schema.required ?? []) as Array<string>) if (!(key in object)) found.push(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      if (properties[key] !== undefined) found.push(...violations(properties[key], root, item, `${at}.${key}`));
      else if (schema.additionalProperties === false) found.push(`${at}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === "object") found.push(...violations(schema.additionalProperties as Record<string, unknown>, root, item, `${at}.${key}`));
    }
    return found;
  }
  return [];
};

describe("OpenCode's profile", () => {
  it("runs the image's opencode as `opencode acp` exactly (any other subcommand starts its background service, M0 P2)", () => {
    const answer = launch("opencode", ["acp"], { T3CODE_THREAD_ID: "thread-2", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_API_KEY: "x" });
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.argv).toEqual(["/opt/t3flare/bin/opencode", "acp"]);
    expect(answer.thread).toBe("thread-2");
    expect(answer.droppedEnv).toEqual(["OPENCODE_CONFIG_CONTENT", "OPENCODE_API_KEY"]);
    for (const args of [[], ["serve"], ["acp", "--login"], ["debug", "config"], ["auth", "login"]]) expect(launch("opencode", args)).toHaveProperty("refused");
  });

  it("keeps every home on the Container's disk and turns its vendor calls off (M0 P3)", () => {
    const answer = launch("opencode", ["acp"]);
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.env).toMatchObject({
      HOME: "/root",
      XDG_CONFIG_HOME: "/var/lib/t3flare/cli/proc-7/config",
      XDG_DATA_HOME: "/var/lib/t3flare/cli/proc-7/data",
      XDG_CACHE_HOME: "/var/lib/t3flare/cli/proc-7/cache",
      XDG_STATE_HOME: "/var/lib/t3flare/cli/proc-7/state",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    });
    expect(Object.keys(answer.env).filter((name) => /API_KEY|CONFIG_CONTENT|NONCE/.test(name))).toEqual([]);
    expect(OPENCODE_SNAPSHOT_DIR).toBe("/workspace/.t3flare/opencode");
  });

  it("writes system configuration with one provider, the catalog, the project's own config honoured, and asking agents (M0 P2)", () => {
    const { json } = fileOf(launch("opencode", ["acp"]), "/opencode.json");
    const provider = (json.providers as Record<string, Record<string, unknown>>).t3flare!;
    expect(Object.keys(json.providers as object)).toEqual(["t3flare"]);
    expect(provider.package).toBe("@opencode/ai/providers/anthropic-compatible");
    expect(provider.settings).toEqual({ baseURL: "https://proxy.example/v1" });
    expect(Object.keys(provider.models as object)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6-luna", "kimi-k3"]);
    expect(JSON.stringify(json)).not.toMatch(/apiKey|x-api-key/i);
    expect(json).toMatchObject({ model: "t3flare/claude-sonnet-5-5", small_model: "t3flare/claude-haiku-5-5", update: "disable", share: "disabled", snapshots: false, lsp: false, formatter: false });
    expect(json.plugins).toEqual(["/opt/t3flare/share/opencode-key-plugin"]);
    const policies = json.policies as Array<{ action: string; resource: string; effect: string }>;
    // OpenCode's matching: whole-value wildcards, the last match wins (M0 P4, its policies guide).
    const matches = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(value);
    const last = (action: string, resource: string) => policies.filter((entry) => entry.action === action && matches(entry.resource, resource)).at(-1)?.effect;
    expect(last("provider.use", "openai")).toBe("deny");
    expect(last("provider.use", "t3flare")).toBe("allow");
    // The project's own plugins, MCP servers, skills and agents (owner, 2026-11-12, back to stock); no vendor account.
    for (const [action, resource] of [["plugin.use", "/w/demo/.opencode/plugins/x.ts"], ["mcp.use", "repo-server"], ["skill.use", "anything"], ["tool.use", "subagent:repo-agent"]]) {
      expect(last(action!, resource!), action).toBeUndefined();
    }
    for (const action of ["websearch.use", "integration.connect"]) expect(last(action, "anything"), action).toBe("deny");
    // Every agent asks for everything but reads; plan also denies edits.
    const agents = json.agents as Record<string, { permissions: Array<{ action: string; resource: string; effect: string }> }>;
    expect(Object.keys(agents).sort()).toEqual(["build", "explore", "general", "plan"]);
    for (const rules of [json.permissions as Array<{ action: string; effect: string }>, ...Object.values(agents).map((agent) => agent.permissions)]) {
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
      expect(rules.filter((rule) => rule.effect === "allow").map((rule) => rule.action).sort()).toEqual(["glob", "grep", "list", "question", "read"]);
    }
    expect(agents.plan!.permissions.at(-1)).toEqual({ action: "edit", resource: "*", effect: "deny" });
  });

  it("validates against OpenCode 2.2.7's schema, which drops what it cannot read with only a warning (review F6)", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/opencode-2.2.7-config.schema.json"), "utf8")) as Record<string, unknown>;
    const { json } = fileOf(launch("opencode", ["acp"]), "/opencode.json");
    expect(violations(schema, schema, json)).toEqual([]);
    // The checker itself: a malformed statement is caught.
    expect(violations(schema, schema, { ...json, policies: [{ action: "tool.use", resource: "*", effect: "maybe" }] })).not.toEqual([]);
  });
});
