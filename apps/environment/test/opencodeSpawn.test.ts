// SPI-1169: the spawner's OpenCode wiring (`spawnCli` for `opencode acp`). With an endpoint whose API OpenCode speaks
// that lists a model, the process runs on the model relay (its handle asked for those endpoints); with none, it is
// refused, saying so (SPI-1176).
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { EndpointApi, ModelEndpoints } from "@t3flare/models/endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { spawnCli } from "../src/agents/cliProcess.ts";
import type { ChannelStart } from "../src/agents/processChannel.ts";

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, models: ReadonlyArray<string>) => ({ id, label: id, api, baseUrl: `https://${id}.example`, auth: "api-key" as const, headers: {}, models: models.map(model) });

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

const spawnOpenCode = () => Effect.runPromiseExit(spawnCli(ChildProcess.make("opencode", ["acp"], { cwd: "/w/demo" }) as ChildProcess.StandardCommand).pipe(Effect.scoped));
const configOf = (start: ChannelStart) => JSON.parse(start.files?.find((file) => file.path.endsWith("/opencode.json"))?.text ?? "{}") as { providers: Record<string, { settings: { baseURL: string } }>; model?: string };

afterEach(() => {
  started.length = 0;
  vi.restoreAllMocks();
});

describe("spawnCli for OpenCode", () => {
  it("runs it on the endpoints whose API it speaks through the relay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ endpoints: { revision: 1, endpoints: [endpoint("gem", "google-generative-ai", ["g"]), endpoint("comm", "anthropic-messages", ["claude-haiku-5-5"]), endpoint("oai", "openai-completions", ["gpt-x"]), endpoint("empty", "openai-responses", [])] } });
    expect((await spawnOpenCode())._tag).toBe("Success");
    const start = started[0]!;
    expect(start.modelRelay).toEqual(["comm", "oai"]);
    const config = configOf(start);
    expect(Object.keys(config.providers)).toEqual(["t3flare-endpoint-comm", "t3flare-endpoint-oai"]);
    expect(config.providers["t3flare-endpoint-comm"]!.settings.baseURL).toBe("http://computer.internal/t3flare/model/comm/v1");
    expect(config.model).toBe("t3flare-endpoint-comm/claude-haiku-5-5");
  });

  it("refuses it without an endpoint for its API, saying so and where to add one (SPI-1176)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    bind({ endpoints: { revision: 1, endpoints: [endpoint("gem", "google-generative-ai", ["g"])] } });
    const exit = await spawnOpenCode();
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("OpenCode has no Model endpoint to run on");
    expect(started).toEqual([]);
  });
});
