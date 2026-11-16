// SPI-1170: the spawner's pi wiring (`spawnCli` for `pi --mode rpc`). With an endpoint that lists a model, the process
// runs on the model relay (its handle asked for those endpoints, no Model proxy needed) and its RPC lines name each
// endpoint's model by t3's slug; with none, on the Model proxy as before; with neither, it is refused.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type { EndpointApi, ModelEndpoints } from "@t3flare/models/endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { spawnCli } from "../src/agents/cliProcess.ts";
import { PI_SESSIONS } from "../src/agents/cliProfiles.ts";
import type { ChannelStart } from "../src/agents/processChannel.ts";

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, models: ReadonlyArray<string>) => ({ id, label: id, api, baseUrl: `https://${id}.example`, auth: "api-key" as const, headers: {}, models: models.map(model) });

const started: Array<ChannelStart> = [];
const written: Array<string> = [];
/** What the process prints, in chunks that cut its lines. */
let printed: ReadonlyArray<string> = [];
const bind = (options: { readonly proxy: boolean; readonly endpoints: ModelEndpoints }) =>
  bindEnvironmentServices({
    workspaces: { list: () => [], resolve: (id: string) => (id === "demo" ? { id } : undefined), get: () => undefined, worktreesOf: () => [] },
    agents: { WORKSPACES: { idFromName: (name: string) => name, get: () => ({ takeEnvironmentSkills: async (hash: string) => ({ taken: false, hash }) }) } },
    environmentSkills: () => ({ hash: () => undefined }),
    modelProxy: options.proxy ? { url: "https://proxy.example", apiKey: "k" } : undefined,
    modelEndpoints: () => options.endpoints,
    catalog: { current: () => ({ models: [{ id: "claude-sonnet-5-5", slug: "anthropic/claude-sonnet-5-5", name: "Sonnet", provider: "anthropic", api: "anthropic-messages", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1 }] }) },
    faults: false,
    relayServers: () => [],
    processes: {
      newKey: () => "proc-1",
      start: async (input: ChannelStart) => {
        started.push(input);
        const chunks = printed;
        return {
          cli: input.cli,
          pid: 1,
          running: true,
          exit: new Promise(() => undefined),
          kill: () => undefined,
          write: async (bytes: Uint8Array) => void written.push(new TextDecoder().decode(bytes)),
          closeStdin: async () => undefined,
          stdout: (async function* () {
            for (const chunk of chunks) yield new TextEncoder().encode(chunk);
          })(),
          stderr: (async function* () {})(),
        };
      },
    },
  } as unknown as EnvironmentServices);

// t3's fork launch: it needs no extension in the State directory.
const FORK = ["--mode", "rpc", "--offline", "--no-extensions", "--no-tools", "--fork", `${PI_SESSIONS}/s1.jsonl`];
const piCommand = () => ChildProcess.make("pi", FORK, { cwd: "/w/demo" }) as ChildProcess.StandardCommand;
const spawnPi = () => Effect.runPromise(spawnCli(piCommand()).pipe(Effect.scoped, Effect.exit));
const modelsOf = (start: ChannelStart) => JSON.parse(start.files?.find((file) => file.path.endsWith("/agent/models.json"))?.text ?? "{}") as { providers: Record<string, { baseUrl: string; apiKey: string }> };

/** One spawn: `sent` written to its stdin (in the chunks given), and what t3 reads from its stdout. */
const exchange = (sent: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawnCli(piCommand());
        yield* Stream.run(Stream.fromIterable(sent.map((text) => new TextEncoder().encode(text))), handle.stdin);
        const out = yield* Stream.runCollect(handle.stdout);
        return [...out].map((bytes) => new TextDecoder().decode(bytes)).join("");
      }),
    ),
  );

afterEach(() => {
  started.length = 0;
  written.length = 0;
  printed = [];
  vi.restoreAllMocks();
});

describe("spawnCli for pi", () => {
  it("runs it on every endpoint that lists a model through the relay, without a Model proxy", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ proxy: false, endpoints: { revision: 1, endpoints: [endpoint("gem", "google-generative-ai", ["g"]), endpoint("comm", "anthropic-messages", ["claude-haiku-5-5"]), endpoint("empty", "openai-responses", [])] } });
    expect((await spawnPi())._tag).toBe("Success");
    const start = started[0]!;
    expect(start.modelRelay).toEqual(["gem", "comm"]);
    const models = modelsOf(start);
    expect(Object.keys(models.providers)).toEqual(["t3flare-endpoint-gem", "t3flare-endpoint-comm"]);
    expect(models.providers["t3flare-endpoint-comm"]!.baseUrl).toBe("http://computer.internal/t3flare/model/comm");
    expect(models.providers["t3flare-endpoint-comm"]!.apiKey).toBe("!/opt/t3flare/bin/t3flare-pi-handle");
    expect(Object.keys(start.env)).not.toContain("T3FLARE_MODEL_HANDLE");
  });

  it("runs it on the Model proxy when no endpoint lists a model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ proxy: true, endpoints: { revision: 1, endpoints: [endpoint("empty", "anthropic-messages", [])] } });
    expect((await spawnPi())._tag).toBe("Success");
    const start = started[0]!;
    expect(start.modelRelay).toBeUndefined();
    expect(Object.keys(modelsOf(start).providers)).toEqual(["anthropic"]);
  });

  it("refuses it with neither", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ proxy: false, endpoints: { revision: 1, endpoints: [endpoint("empty", "anthropic-messages", [])] } });
    expect((await spawnPi())._tag).toBe("Failure");
    expect(started).toEqual([]);
  });

  it("on the relay, maps t3's endpoint ids to pi's providers on stdin and back on stdout, whole lines across chunks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ proxy: false, endpoints: { revision: 1, endpoints: [endpoint("comm", "anthropic-messages", ["claude-haiku-5-5"])] } });
    const response = '{"type":"response","command":"set_model","success":true,"data":{"provider":"t3flare-endpoint-comm","id":"claude-haiku-5-5"}}\n';
    printed = [response.slice(0, 40), `${response.slice(40)}{"type":"agent_end"}\n`];
    const out = await exchange(['{"id":"c1","type":"set_mo', 'del","provider":"comm","modelId":"claude-haiku-5-5"}\n{"type":"get_state"}\n']);
    expect(written.join("")).toBe('{"id":"c1","type":"set_model","provider":"t3flare-endpoint-comm","modelId":"claude-haiku-5-5"}\n{"type":"get_state"}\n');
    expect(out).toBe('{"type":"response","command":"set_model","success":true,"data":{"provider":"comm","id":"claude-haiku-5-5"}}\n{"type":"agent_end"}\n');
  });

  it("on the proxy, passes its lines through as they are", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind({ proxy: true, endpoints: { revision: 1, endpoints: [] } });
    printed = ['{"type":"response","data":{"provider":"t3flare-endpoint-comm"}}\n'];
    const out = await exchange(['{"type":"set_model","provider":"comm","modelId":"m"}\n']);
    expect(written.join("")).toBe('{"type":"set_model","provider":"comm","modelId":"m"}\n');
    expect(out).toBe('{"type":"response","data":{"provider":"t3flare-endpoint-comm"}}\n');
  });
});
