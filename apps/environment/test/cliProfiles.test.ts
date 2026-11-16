// CLI profiles (step 4a, plan §4 with the review's F2, F4, F5 and M0's findings): what a Codex or pi process gets,
// whatever t3 asked. Expected values are the M0 probes' (docs/steps/step-4a/m0-local.json), not recomputed here.
import type { CatalogModel } from "@t3flare/models";
import { describe, expect, it } from "vitest";

import { CODEX_SESSIONS, PI_SESSIONS, type PiRelay, piRepoResourceArgs, type ProfileContext, profileLaunch, repoRootOf } from "../src/agents/cliProfiles.ts";

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

const EXTENSION = "export default function (pi) {}\n";
const STATE_EXTENSION = "/t3/state/cache/pi-t3-mcp-extension.ts";

const context: ProfileContext = {
  proxyUrl: "https://proxy.example",
  models: [model("claude-sonnet-5-5", { reasoning: true, input: ["text", "image"] }), model("gpt-6-luna"), model("kimi-k3")],
  readStateFile: (path) => (path === STATE_EXTENSION ? EXTENSION : path === "/t3/state/other.ts" ? "evil" : undefined),
  piExtensionSource: EXTENSION,
};

const launch = (cli: "codex" | "pi" | "probe", args: ReadonlyArray<string>, env: Record<string, string> = {}, allowProbe = false) =>
  profileLaunch({ cli, args, key: "proc-1", cwd: "/w/demo", env, allowProbe }, context);

describe("Codex's profile", () => {
  it("runs the image's codex app-server with the proxy as its only provider and M0's settings", () => {
    const answer = launch("codex", ["app-server"], { T3CODE_THREAD_ID: "thread-1", OPENAI_API_KEY: "sk-x", CODEX_HOME: "/elsewhere" });
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.argv.slice(0, 2)).toEqual(["/opt/t3flare/bin/codex", "app-server"]);
    const overrides = answer.argv.filter((_, index) => answer.argv[index - 1] === "-c");
    expect(overrides).toContain('model_provider="t3flare-proxy"');
    expect(overrides.find((value) => value.startsWith("model_providers.t3flare-proxy="))).toBe(
      'model_providers.t3flare-proxy={name="Model proxy",base_url="https://proxy.example/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=1,stream_max_retries=1,auth={command="/opt/t3flare/bin/t3flare-model-key",args=["codex"],timeout_ms=30000,refresh_interval_ms=0}}',
    );
    expect(overrides).toEqual(
      expect.arrayContaining([
        "allow_login_shell=false",
        "check_for_update_on_startup=false",
        "features.plugins=false",
        "features.plugin_discovery_prefetch=false",
        "features.remote_plugin=false",
        "features.plugin_sharing=false",
        'shell_environment_policy.exclude=["T3FLARE_MODEL_KEY_NONCE","T3FLARE_TOOL_HANDLE","T3FLARE_MODEL_HANDLE"]',
        'shell_environment_policy.set.T3FLARE_EXEC="proc-1"',
        'approval_policy="on-request"',
        'sandbox_mode="read-only"',
      ]),
    );
    // Codex's subagents stay on, as stock t3 leaves them (owner, 2026-11-12, back to stock).
    expect(overrides.some((value) => value.startsWith("features.multi_agent"))).toBe(false);
    expect(answer.env).toEqual({ HOME: "/root", LANG: "C.UTF-8", CODEX_HOME: "/var/lib/t3flare/cli/proc-1/codex", CODEX_SQLITE_HOME: "/var/lib/t3flare/cli/proc-1/sqlite" });
    // SPI-1153: the Environment skill set linked inside Codex's user-level root, which stays writable for its bundled
    // `.system` Skills (M0: a read-only root fails their install).
    expect(answer.links).toEqual([
      { path: "/var/lib/t3flare/cli/proc-1/codex/sessions", target: CODEX_SESSIONS },
      { path: "/var/lib/t3flare/cli/proc-1/codex/skills/t3flare-environment", target: "/workspace/.agents/skills" },
    ]);
    expect(answer.thread).toBe("thread-1");
    expect(answer.droppedEnv.toSorted()).toEqual(["CODEX_HOME", "OPENAI_API_KEY"]);
  });

  it("gets one provider per OpenAI Responses endpoint through the model relay, its id from the endpoint's (SPI-1167)", () => {
    const endpoints = [
      { id: "openai", label: "OpenAI" },
      { id: "work-gw", label: "Work \"gateway\"" },
    ];
    const answer = profileLaunch({ cli: "codex", args: ["app-server"], key: "proc-1", cwd: "/w/demo", env: {}, allowProbe: false }, { ...context, endpoints });
    if ("refused" in answer) throw new Error(answer.refused);
    const overrides = answer.argv.filter((_, index) => answer.argv[index - 1] === "-c");
    expect(overrides).toContain('model_provider="t3flare-proxy"');
    expect(overrides).toContain(
      'model_providers.t3flare-endpoint-openai={name="OpenAI",base_url="http://computer.internal/t3flare/model/openai",wire_api="responses",env_key="T3FLARE_MODEL_HANDLE",requires_openai_auth=false,supports_websockets=false,request_max_retries=1,stream_max_retries=1}',
    );
    expect(overrides).toContain(
      'model_providers.t3flare-endpoint-work-gw={name="Work \\"gateway\\"",base_url="http://computer.internal/t3flare/model/work-gw",wire_api="responses",env_key="T3FLARE_MODEL_HANDLE",requires_openai_auth=false,supports_websockets=false,request_max_retries=1,stream_max_retries=1}',
    );
    // The Workspace DO makes the handle and puts it in the process's environment; the profile only asks for one.
    expect(answer.modelRelay).toEqual(["openai", "work-gw"]);
    expect(JSON.stringify(answer.env)).not.toContain("T3FLARE_MODEL_HANDLE");
  });

  it("runs on its session's model's provider: Codex runs a thread's turns only on its process's provider", () => {
    const endpoints = [{ id: "openai", label: "OpenAI" }];
    const providerFor = (model: string | undefined) => {
      const answer = profileLaunch({ cli: "codex", args: ["app-server"], key: "proc-1", cwd: "/w/demo", env: {}, allowProbe: false }, { ...context, endpoints, ...(model === undefined ? {} : { model }) });
      if ("refused" in answer) throw new Error(answer.refused);
      return answer.argv.find((value) => value.startsWith("model_provider="));
    };
    expect(providerFor("openai/gpt-5-mini")).toBe('model_provider="t3flare-endpoint-openai"');
    expect(providerFor("gpt-6-luna")).toBe('model_provider="t3flare-proxy"');
    expect(providerFor("other/x")).toBe('model_provider="t3flare-proxy"');
    expect(providerFor(undefined)).toBe('model_provider="t3flare-proxy"');
  });

  it("defaults to the first endpoint's provider when there is no Model proxy", () => {
    const answer = profileLaunch({ cli: "codex", args: ["app-server"], key: "proc-1", cwd: "/w/demo", env: {}, allowProbe: false }, { ...context, proxyUrl: "", endpoints: [{ id: "openai", label: "OpenAI" }] });
    if ("refused" in answer) throw new Error(answer.refused);
    const overrides = answer.argv.filter((_, index) => answer.argv[index - 1] === "-c");
    expect(overrides).toContain('model_provider="t3flare-endpoint-openai"');
    expect(overrides.some((value) => value.startsWith("model_providers.t3flare-proxy="))).toBe(false);
  });

  it("refuses any other Codex argv", () => {
    expect(launch("codex", ["exec", "hi"])).toHaveProperty("refused");
    expect(launch("codex", ["app-server", "-c", 'model_provider="openai"'])).toHaveProperty("refused");
    expect(launch("codex", ["--version"])).toHaveProperty("refused");
  });
});

describe("pi's profile", () => {
  const rpc = ["--mode", "rpc", "--session", `${PI_SESSIONS}/s1.jsonl`, "--extension", STATE_EXTENSION];

  it("runs the image's pi with a fresh agent dir, synced sessions, t3's extension copied in, and no project trust", () => {
    const answer = launch("pi", rpc, { T3_PI_RUNTIME_MODE: "auto-accept-edits", T3_MCP_BEARER_TOKEN: "secret", T3CODE_THREAD_ID: "thread-2" });
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.argv).toEqual([
      "/opt/t3flare/bin/pi",
      "--mode",
      "rpc",
      "--session",
      `${PI_SESSIONS}/s1.jsonl`,
      "--extension",
      "/var/lib/t3flare/cli/proc-1/ext/pi-t3-mcp-extension.ts",
      // SPI-1153: the Environment skill set, first, so it beats a Repo skill of its name (pi keeps the first).
      "--skill",
      "/workspace/.agents/skills",
      "--skill",
      "/w/demo/.pi/skills",
      "--skill",
      "/w/demo/.agents/skills",
      "--prompt-template",
      "/w/demo/.pi/prompts",
      "--no-approve",
    ]);
    expect(answer.env).toEqual({
      HOME: "/root",
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: "/var/lib/t3flare/cli/proc-1/agent",
      PI_CODING_AGENT_SESSION_DIR: PI_SESSIONS,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      T3_PI_MCP_EXTENSION_PATH: "/var/lib/t3flare/cli/proc-1/ext/pi-t3-mcp-extension.ts",
      T3_PI_RUNTIME_MODE: "auto-accept-edits",
    });
    // Read (SPI-1039), but passed on only as the relay with the process's own handle: never t3's own bearer.
    expect(answer.droppedEnv).toEqual([]);
    expect(answer.env.T3_MCP_BEARER_TOKEN).toBeUndefined();
    const models = JSON.parse(answer.files!.find((file) => file.path.endsWith("models.json"))!.text);
    expect(models.providers.anthropic.baseUrl).toBe("https://proxy.example");
    expect(models.providers.anthropic.apiKey).toBe("!/opt/t3flare/bin/t3flare-model-key pi");
    expect(models.providers.anthropic.models.map((entry: { id: string }) => entry.id)).toEqual(["claude-sonnet-5-5", "gpt-6-luna", "kimi-k3"]);
    expect(JSON.parse(answer.files!.find((file) => file.path.endsWith("settings.json"))!.text)).toMatchObject({ defaultProjectTrust: "never" });
  });

  it("never lets pi's extension fail open: a missing or unknown mode is approval-required", () => {
    for (const mode of [undefined, "auto", "yolo"]) {
      const answer = launch("pi", rpc, mode === undefined ? {} : { T3_PI_RUNTIME_MODE: mode });
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.env.T3_PI_RUNTIME_MODE).toBe("approval-required");
    }
  });

  it("refuses pi without t3's extension, with another extension, or with a session outside the synced dir", () => {
    expect(launch("pi", ["--mode", "rpc"])).toHaveProperty("refused");
    expect(launch("pi", ["--mode", "rpc", "--extension", "/t3/state/other.ts"])).toHaveProperty("refused");
    expect(launch("pi", ["--mode", "rpc", "--extension", "/t3/state/missing.ts"])).toHaveProperty("refused");
    expect(launch("pi", ["--mode", "rpc", "--session", "/workspace/repo/.pi/s.jsonl", "--extension", STATE_EXTENSION])).toHaveProperty("refused");
    expect(launch("pi", ["--mode", "rpc", "--approve", "--extension", STATE_EXTENSION])).toHaveProperty("refused");
    // SPI-1151: the repo's Skills and templates are the profile's to name, never t3's.
    expect(launch("pi", ["--mode", "rpc", "--skill", "/elsewhere", "--extension", STATE_EXTENSION])).toHaveProperty("refused");
    expect(launch("pi", ["--mode", "rpc", "--prompt-template", "/elsewhere", "--extension", STATE_EXTENSION])).toHaveProperty("refused");
    expect(launch("pi", ["--version"])).toHaveProperty("refused");
  });

  it("names pi's repo roots from a cwd below the repo root as pi finds them: .pi/skills at the cwd, .agents/skills up to the root (SPI-1151)", () => {
    expect(piRepoResourceArgs("/w/demo/pkg/app")).toEqual([
      "--skill",
      "/workspace/.agents/skills",
      "--skill",
      "/w/demo/pkg/app/.pi/skills",
      "--skill",
      "/w/demo/pkg/app/.agents/skills",
      "--skill",
      "/w/demo/pkg/.agents/skills",
      "--skill",
      "/w/demo/.agents/skills",
      "--prompt-template",
      "/w/demo/pkg/app/.pi/prompts",
    ]);
    expect([repoRootOf("/w/demo/pkg/app"), repoRootOf("/w/demo"), repoRootOf("/w/.wt/demo/feature/src"), repoRootOf("/elsewhere/x")]).toEqual(["/w/demo", "/w/demo", "/w/.wt/demo/feature", "/elsewhere/x"]);
    // A worktree's repo root is its own path, not the project's.
    expect(piRepoResourceArgs("/w/.wt/demo/feature/")).toEqual(["--skill", "/workspace/.agents/skills", "--skill", "/w/.wt/demo/feature/.pi/skills", "--skill", "/w/.wt/demo/feature/.agents/skills", "--prompt-template", "/w/.wt/demo/feature/.pi/prompts"]);
  });

  it("runs t3's fork (no extensions, no tools) without the extension", () => {
    const answer = launch("pi", ["--mode", "rpc", "--offline", "--no-extensions", "--no-tools", "--fork", `${PI_SESSIONS}/s1.jsonl`]);
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.argv).toContain("--fork");
    expect(answer.env.T3_PI_MCP_EXTENSION_PATH).toBeUndefined();
  });

  // SPI-1170: pi on the Model endpoints through the model relay.
  describe("on the model relay", () => {
    const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
    const endpointModel = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `${id} name`, reasoning: false, input: ["text" as const], contextWindow: 100_000, maxTokens: 8000, cost, known: false, ...extra });
    const piRelay: PiRelay = {
      endpoints: [
        { id: "comm", label: "Commissary", api: "anthropic-messages", models: [endpointModel("claude-haiku-5-5", { reasoning: true, thinkingLevelMap: { xhigh: null }, compat: { supportsStrictTools: true } })] },
        { id: "oai", label: "OpenAI", api: "openai-completions", models: [endpointModel("gpt-x"), endpointModel("org/model:free")] },
        { id: "resp", label: "Responses", api: "openai-responses", models: [endpointModel("gpt-r")] },
        { id: "gem", label: "Gemini", api: "google-generative-ai", models: [endpointModel("gemini-x", { input: ["text", "image"] })] },
        { id: "mis", label: "Mistral", api: "mistral-conversations", models: [endpointModel("mistral-x")] },
      ],
      model: "oai/gpt-x",
    };
    const onRelay = (args: ReadonlyArray<string>, env: Record<string, string> = { T3_PI_RUNTIME_MODE: "approval-required" }) =>
      profileLaunch({ cli: "pi", args, key: "proc-1", cwd: "/w/demo", env, allowProbe: false }, { ...context, piRelay });
    const fileOf = (answer: ReturnType<typeof onRelay>, name: string) => {
      if ("refused" in answer) throw new Error(answer.refused);
      return JSON.parse(answer.files!.find((file) => file.path === `/var/lib/t3flare/cli/proc-1/agent/${name}`)!.text);
    };

    it("writes one provider per endpoint, at the relay's per-endpoint URL, with its API and the handle command as its key", () => {
      const models = fileOf(onRelay(rpc), "models.json");
      expect(Object.keys(models.providers)).toEqual(["t3flare-endpoint-comm", "t3flare-endpoint-oai", "t3flare-endpoint-resp", "t3flare-endpoint-gem", "t3flare-endpoint-mis"]);
      for (const [id, api] of [["comm", "anthropic-messages"], ["oai", "openai-completions"], ["resp", "openai-responses"], ["gem", "google-generative-ai"], ["mis", "mistral-conversations"]] as const) {
        const provider = models.providers[`t3flare-endpoint-${id}`];
        expect(provider).toMatchObject({ baseUrl: `http://computer.internal/t3flare/model/${id}`, api, apiKey: "!/opt/t3flare/bin/t3flare-pi-handle" });
        // Each model pinned to the endpoint's API and relay URL.
        for (const entry of provider.models) expect(entry).toMatchObject({ api, baseUrl: `http://computer.internal/t3flare/model/${id}` });
      }
      expect(models.providers["t3flare-endpoint-oai"].models.map((entry: { id: string }) => entry.id)).toEqual(["gpt-x", "org/model:free"]);
      // pi-ai's own metadata of the model, as the Session has it; nothing of the endpoint's own URL or key.
      expect(models.providers["t3flare-endpoint-comm"].models[0]).toEqual({
        id: "claude-haiku-5-5",
        name: "claude-haiku-5-5 name",
        api: "anthropic-messages",
        baseUrl: "http://computer.internal/t3flare/model/comm",
        reasoning: true,
        input: ["text"],
        cost,
        contextWindow: 100_000,
        maxTokens: 8000,
        thinkingLevelMap: { xhigh: null },
        compat: { supportsStrictTools: true },
      });
      // Nothing of the Model proxy's.
      expect(models.providers.anthropic).toBeUndefined();
      expect(JSON.stringify(models)).not.toContain("proxy.example");
      expect(JSON.stringify(models)).not.toContain("t3flare-model-key");
    });

    it("gives a ChatGPT sign-in's models plan usage's compatibility overrides, as the Session's pi-ai has them (SPI-1171)", () => {
      const signedIn: PiRelay = {
        endpoints: [
          { id: "chatgpt", label: "ChatGPT", api: "openai-responses", auth: "chatgpt", models: [endpointModel("gpt-6.1-sol", { compat: { supportsMidConvoEffort: true, supportsStrictTools: true } })] },
          { id: "claude", label: "Claude", api: "anthropic-messages", auth: "claude", models: [endpointModel("claude-haiku-5-5")] },
        ],
        model: "chatgpt/gpt-6.1-sol",
      };
      const answer = profileLaunch({ cli: "pi", args: rpc, key: "proc-1", cwd: "/w/demo", env: { T3_PI_RUNTIME_MODE: "approval-required" }, allowProbe: false }, { ...context, piRelay: signedIn });
      const models = fileOf(answer, "models.json");
      expect(models.providers["t3flare-endpoint-chatgpt"].models[0].compat).toEqual({ supportsMidConvoEffort: false, supportsStrictTools: true, supportsToolSearch: false });
      expect(models.providers["t3flare-endpoint-claude"].models[0].compat).toBeUndefined();
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.modelRelay).toEqual(["chatgpt", "claude"]);
    });

    it("starts pi on the relay's model, as pi names it, with no project trust", () => {
      expect(fileOf(onRelay(rpc), "settings.json")).toEqual({ defaultProjectTrust: "never", retry: { maxRetries: 1 }, defaultProvider: "t3flare-endpoint-oai", defaultModel: "gpt-x" });
    });

    it("asks a model handle for exactly those endpoints, and never puts a handle in pi's environment or files", () => {
      const answer = onRelay(rpc);
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.modelRelay).toEqual(["comm", "oai", "resp", "gem", "mis"]);
      expect(Object.keys(answer.env)).not.toContain("T3FLARE_MODEL_HANDLE");
      // The handle is not taken from t3's environment either.
      const fromT3 = onRelay(rpc, { T3_PI_RUNTIME_MODE: "approval-required", T3FLARE_MODEL_HANDLE: "f".repeat(64) });
      if ("refused" in fromT3) throw new Error(fromT3.refused);
      expect(JSON.stringify(fromT3.env)).not.toContain("f".repeat(64));
      expect(JSON.stringify(fromT3.files)).not.toContain("f".repeat(64));
      expect(fromT3.droppedEnv).toContain("T3FLARE_MODEL_HANDLE");
    });

    it("gives t3's fork the same models.json and a handle (it makes no request, but resolves its models)", () => {
      const answer = onRelay(["--mode", "rpc", "--offline", "--no-extensions", "--no-tools", "--fork", `${PI_SESSIONS}/s1.jsonl`]);
      expect(Object.keys(fileOf(answer, "models.json").providers)).toHaveLength(5);
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.modelRelay).toEqual(["comm", "oai", "resp", "gem", "mis"]);
    });

    it("stays on the Model proxy without a relay (no handle asked)", () => {
      const answer = launch("pi", rpc, { T3_PI_RUNTIME_MODE: "approval-required" });
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.modelRelay).toBeUndefined();
    });
  });

  // T-pi-1 (settings-mcp plan §5, D4; SPI-1076): the relay's servers through pi's built-in MCP.
  describe("the MCP relay's entries", () => {
    const HANDLE = "tool-handle-0123456789abcdef";
    // The relay's servers: Direct servers the owner added (`commissary` and `docs`; no built-in kind since SPI-1160) and
    // the Settings server.
    const relayed = (args: ReadonlyArray<string>, servers: ReadonlyArray<string> = ["commissary", "settings", "docs"]) =>
      profileLaunch({ cli: "pi", args, key: "proc-1", cwd: "/w/demo", env: { T3_PI_RUNTIME_MODE: "approval-required" }, allowProbe: false }, { ...context, relay: { handle: HANDLE, servers } });

    it("writes one mcp.json entry per relay server in the agent dir, with the relay's URL, the handle's header, the CLI timeout and deferred exposure", () => {
      const answer = relayed(rpc);
      if ("refused" in answer) throw new Error(answer.refused);
      const file = answer.files!.find((entry) => entry.path === "/var/lib/t3flare/cli/proc-1/agent/mcp.json");
      // pi reads mcp.json from PI_CODING_AGENT_DIR (M0 P16).
      expect(answer.env.PI_CODING_AGENT_DIR).toBe("/var/lib/t3flare/cli/proc-1/agent");
      const entry = (url: string) => ({ url, headers: { Authorization: "Bearer ${T3FLARE_TOOL_HANDLE}" }, timeout: 900, exposure: "deferred" });
      expect(JSON.parse(file!.text)).toEqual({
        mcpServers: {
          commissary: entry("http://computer.internal/t3flare/mcp/commissary"),
          settings: entry("http://computer.internal/t3flare/mcp/settings"),
          docs: entry("http://computer.internal/t3flare/mcp/docs"),
        },
      });
      // Its trust stays off, so a repository's .pi/mcp.json cannot replace, disable or redirect an entry.
      expect(answer.argv.at(-1)).toBe("--no-approve");
      expect(JSON.parse(answer.files!.find((entry) => entry.path.endsWith("settings.json"))!.text)).toMatchObject({ defaultProjectTrust: "never" });
      // PI_OFFLINE stays: it does not stop MCP connects (M0 P16).
      expect(answer.env.PI_OFFLINE).toBe("1");
    });

    it("puts the handle in the process's environment and in no file", () => {
      const answer = relayed(rpc);
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.env.T3FLARE_TOOL_HANDLE).toBe(HANDLE);
      // Patch 0007 lets a built-in MCP tool through unasked only for these servers.
      expect(answer.env.T3FLARE_RELAY_SERVERS).toBe("commissary,settings,docs");
      for (const file of answer.files ?? []) expect(file.text).not.toContain(HANDLE);
      expect(answer.argv.join(" ")).not.toContain(HANDLE);
    });

    it("gives the fork launch no mcp.json and no handle: --no-extensions turns pi's built-in MCP off", () => {
      const answer = relayed(["--mode", "rpc", "--offline", "--no-extensions", "--no-tools", "--fork", `${PI_SESSIONS}/s1.jsonl`]);
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.files!.some((file) => file.path.endsWith("mcp.json"))).toBe(false);
      expect(answer.env.T3FLARE_TOOL_HANDLE).toBeUndefined();
      expect(answer.env.T3FLARE_RELAY_SERVERS).toBeUndefined();
    });

    it("writes no mcp.json and sets no handle when the relay has no server", () => {
      const answer = relayed(rpc, []);
      if ("refused" in answer) throw new Error(answer.refused);
      expect(answer.files!.some((file) => file.path.endsWith("mcp.json"))).toBe(false);
      expect(answer.env.T3FLARE_TOOL_HANDLE).toBeUndefined();
    });
  });
});

describe("the probe", () => {
  it("runs on test stages only", () => {
    expect(launch("probe", [])).toHaveProperty("refused");
    expect(launch("probe", [], {}, true)).toMatchObject({ argv: ["/bin/bash", "/var/lib/t3flare/cli/proc-1/probe.sh"] });
  });
});
