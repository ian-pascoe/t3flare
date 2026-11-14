// CLI profiles (step 4a, plan §4 with the review's F2, F4, F5 and M0's findings): what a Codex or pi process gets,
// whatever t3 asked. Expected values are the M0 probes' (docs/steps/step-4a/m0-local.json), not recomputed here.
import type { CatalogModel } from "@t3flare/models";
import { describe, expect, it } from "vitest";

import { CODEX_SESSIONS, PI_SESSIONS, piRepoResourceArgs, type ProfileContext, profileLaunch, repoRootOf } from "../src/agents/cliProfiles.ts";

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
        'shell_environment_policy.exclude=["T3FLARE_MODEL_KEY_NONCE","T3FLARE_TOOL_HANDLE"]',
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
});

describe("the probe", () => {
  it("runs on test stages only", () => {
    expect(launch("probe", [])).toHaveProperty("refused");
    expect(launch("probe", [], {}, true)).toMatchObject({ argv: ["/bin/bash", "/var/lib/t3flare/cli/proc-1/probe.sh"] });
  });
});
