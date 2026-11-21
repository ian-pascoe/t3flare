// SPI-1168: the spawner's Claude Code wiring (`spawnCli` for `claude-agent-acp`). With an Anthropic Messages endpoint
// that lists a model, the process runs on the model relay (its handle asked for those endpoints); with none, it is
// refused, saying so (SPI-1176).
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { spawnCli } from "../src/agents/cliProcess.ts";
import type { ChannelStart } from "../src/agents/processChannel.ts";

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const anthropic = (id: string, models: ReadonlyArray<string>) => ({ id, label: id, api: "anthropic-messages" as const, baseUrl: `https://${id}.example`, auth: "api-key" as const, headers: {}, models: models.map(model) });

const started: Array<ChannelStart> = [];
const bind = (options: { readonly endpoints: ModelEndpoints }) =>
  bindEnvironmentServices({
    workspaces: { list: () => [], resolve: (id: string) => (id === "demo" ? { id } : undefined), get: () => undefined, worktreesOf: () => [] },
    agents: { WORKSPACES: { idFromName: (name: string) => name, get: () => ({ takeEnvironmentSkills: async (hash: string) => ({ taken: false, hash }) }) } },
    environmentSkills: () => ({ hash: () => undefined }),
    modelEndpoints: () => options.endpoints,
    faults: false,
    relayServers: () => [],
    processes: {
      newKey: () => "proc-1",
      start: async (input: ChannelStart) => {
        started.push(input);
        return { cli: input.cli, pid: 1, running: true, exit: new Promise(() => undefined), kill: () => undefined, write: async () => undefined, closeStdin: async () => undefined, stdout: (async function* () {})(), stderr: (async function* () {})() };
      },
    },
  } as unknown as EnvironmentServices);

const spawnClaude = () => Effect.runPromiseExit(spawnCli(ChildProcess.make("claude-agent-acp", [], { cwd: "/w/demo" }) as ChildProcess.StandardCommand).pipe(Effect.scoped));
const settingsOf = (start: ChannelStart) => JSON.parse(start.files?.find((file) => file.path.endsWith("/managed-settings.json"))?.text ?? "{}") as { apiKeyHelper: string; availableModels: Array<string>; env: Record<string, string> };

afterEach(() => {
  started.length = 0;
  vi.restoreAllMocks();
});

describe("spawnCli for Claude Code", () => {
  it("runs it on the Anthropic Messages endpoints through the relay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ endpoints: { revision: 1, endpoints: [anthropic("comm", ["claude-haiku-5-5"]), anthropic("empty", [])] } });
    expect((await spawnClaude())._tag).toBe("Success");
    const start = started[0]!;
    expect(start.modelRelay).toEqual(["comm"]);
    expect(start.env.ANTHROPIC_BASE_URL).toBe("http://computer.internal/t3flare/model/_");
    expect(settingsOf(start)).toMatchObject({ apiKeyHelper: "/opt/t3flare/bin/t3flare-claude-handle", availableModels: ["comm/claude-haiku-5-5"] });
  });

  it("refuses it without an endpoint for its API, saying so and where to add one (SPI-1176)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    bind({ endpoints: { revision: 1, endpoints: [anthropic("empty", [])] } });
    const exit = await spawnClaude();
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("Claude Code has no Model endpoint to run on: it needs one that speaks Anthropic Messages and that lists a model");
    expect(started).toEqual([]);
  });
});
