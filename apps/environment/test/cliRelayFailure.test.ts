// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// SPI-1172: a CLI agent's failed turn on a Model endpoint shows the model relay's classification of the process's last
// answer, by the endpoint's API and auth, not what the CLI or its t3 adapter made of the error text (for Claude Code and
// OpenCode, ACP's `cliPromptFailure`, which reads Commissary's texts and is kept for proxy-mode processes only).
//
// - Claude Code and OpenCode: t3's own ACP adapter with each flavor, over a scripted agent whose prompt fails with the
//   CLI's "API Error: 401 {…}" text, wrapped by the CLI wrapper.
// - Codex and pi: t3's adapters need their real CLIs, so a stand-in adapter emits each one's failure as t3's adapter
//   makes it (Codex's own usage-limit class without a reset; pi's provider error with the vendor's text), wrapped the same way.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationV2ProviderFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId as ProviderSessionIdType,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { type AcpAdapterV2RuntimeInput, makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import * as TestProviderHost from "../../../t3code/packages/provider-testing/src/TestProviderHost.ts";
import { makeTurnInput } from "t3/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { acpAdapterOptions, acpFlavor } from "../src/provider/cli/acpDriver.ts";
import { MIN_RESET_MS } from "@t3flare/models/failures";
import { cliRelayFailure } from "../src/provider/cli/relayFailure.ts";
import { wrapCliAdapter } from "../src/provider/cli/wrapper.ts";

const AGENT = path.join(import.meta.dirname, "fixtures/fake-acp-agent.mjs");
const NOW = Date.parse("2026-11-16T10:00:00.000Z");

const ENDPOINTS: ModelEndpoints = {
  revision: 1,
  endpoints: [
    {
      id: "commissary",
      label: "Commissary",
      api: "anthropic-messages",
      baseUrl: "https://commissary.example",
      auth: "api-key",
      headers: {},
      models: [{ id: "claude-haiku-5-5", name: "Haiku", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: true }],
    },
  ],
};

const KEY_REFUSED: EndpointFailureRecord = {
  endpointId: "commissary",
  class: "permission_error",
  code: "key_refused",
  message: 'The Model endpoint "commissary" refused its API key (HTTP 401): check it on the Settings page.',
  retryable: false,
  stop: true,
  at: NOW,
};
const USAGE_LIMIT: EndpointFailureRecord = {
  endpointId: "commissary",
  class: "usage_limit",
  code: "usage_limit",
  message: 'The Model endpoint "commissary" reached its usage limit.',
  retryable: true,
  resetAt: NOW + 2 * 3_600_000,
  stop: true,
  at: NOW,
};

describe("cliRelayFailure", () => {
  const refused = makeProviderFailure({ class: "permission_error", message: "The Model endpoint refused the agent's credential.", code: null, retryable: false });
  const own = makeProviderFailure({ class: "provider_error", message: "The agent crashed.", code: "-32603", retryable: null });

  it("the relay's failure is t3's: its class, text naming the endpoint, code and reset (held to 30 s after now)", () => {
    expect(cliRelayFailure(refused, USAGE_LIMIT, NOW)).toEqual({
      class: "usage_limit",
      message: USAGE_LIMIT.message,
      code: "usage_limit",
      retryable: true,
      resetAt: "2026-11-16T12:00:00.000Z",
    });
    expect(cliRelayFailure(own, { ...USAGE_LIMIT, resetAt: NOW + 1000 }, NOW).resetAt).toBe(new Date(NOW + MIN_RESET_MS).toISOString());
  });

  it("with no relay failure, the adapter's own failure stands", () => {
    expect(cliRelayFailure(refused, null, NOW)).toBe(refused);
    expect(cliRelayFailure(own, null, NOW)).toBe(own);
  });
});

// --- Claude Code and OpenCode: t3's ACP adapter over a scripted agent -----------------------------------------------

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

type Event = ProviderAdapter.ProviderAdapterV2Event;

const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {}, fork: {}, resume: {} } },
  authMethods: [],
  agentInfo: { name: "fake", title: "Fake", version: "0.0.1" },
};
const SESSION_NEW = { sessionId: "acp-session", modes: { currentModeId: "default", availableModes: ["default", "build", "plan"].map((id) => ({ id, name: id })) } };
/** The CLI's text for a relayed 401 (Claude Code's `API Error: <status> <body>`), as the ACP error carries it. */
const PROMPT_ERROR = { code: -32603, message: 'Internal error: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' };

let threads = 0;

const acpTurn = (cli: "claude" | "opencode", relayed: EndpointFailureRecord | null, model: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3flare-cli-relay-failure-" });
    const scriptPath = path.join(cwd, "..", `${path.basename(cwd)}.script.json`);
    fs.writeFileSync(scriptPath, JSON.stringify({ initialize: INITIALIZE, sessionNew: SESSION_NEW, prompts: [[{ error: PROMPT_ERROR }]] }));
    const spawn = (input: AcpAdapterV2RuntimeInput) =>
      Effect.gen(function* () {
        const { processEnvironment: _env, runtimePolicy: _policy, mcpServers: _mcp, acpMcpServers: _acp, httpMcpServers: _http, ...rest } = input;
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...rest,
            spawn: { command: process.execPath, args: [AGENT], cwd: input.cwd, env: { PATH: process.env.PATH ?? "", FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: path.join(cwd, "..", "log") }, extendEnv: false },
            authenticateOnAuthRequired: false,
            ownDetachedProcessGroup: true,
            processGroupPlatform: process.platform,
          }),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
      });
    const driver = ProviderDriverKind.make(cli === "claude" ? "claudeAgent" : "opencode");
    const instanceId = ProviderInstanceId.make(cli === "claude" ? "claudeAgent" : "opencode");
    const adapter = wrapCliAdapter(yield* makeAcpAdapterV2(acpAdapterOptions(instanceId, acpFlavor(cli, driver, { spawn, modelEndpoints: () => ENDPOINTS }), undefined)), {
      sessions: new Map(),
      now: () => NOW,
      relayFailure: async () => relayed,
      takeEnvironmentSkills: () => Effect.void,
    });
    const threadId = ThreadId.make(`thread-relay-failure-${++threads}`);
    const modelSelection = { instanceId, model } as const;
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "full-access", interactionMode: "default", cwd });
    const runtime = yield* adapter.openSession({ threadId, providerSessionId: ProviderSessionId.make(`session-relay-failure-${threads}`), modelSelection, runtimePolicy });
    const queue = yield* Queue.unbounded<Event>();
    yield* runtime.events.pipe(Stream.runForEach((event) => Queue.offer(queue, event)), Effect.forkScoped);
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* runtime.startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now: yield* DateTime.now, modelSelection }));
    const seen: Array<Event> = [];
    while (true) {
      const event = yield* Queue.take(queue).pipe(Effect.timeout("20 seconds"));
      seen.push(event);
      if (event.type === "turn.terminal") return { terminal: event, errors: seen.flatMap((e) => (e.type === "turn_item.updated" && e.turnItem.type === "error" ? [e.turnItem.failure] : [])) };
    }
  });

const run = <A>(body: Effect.Effect<A, unknown, Layer.Success<typeof layerTest> | import("effect/Scope").Scope>) => Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(layerTest)) as never) as Promise<A>;

for (const cli of ["claude", "opencode"] as const) {
  describe(`${cli} on a Model endpoint, through the relay`, () => {
    it("a relayed refused key: the relay's failure naming the endpoint", async () => {
      const { terminal, errors } = await run(acpTurn(cli, KEY_REFUSED, "commissary/claude-haiku-5-5"));
      expect(terminal.type === "turn.terminal" && terminal.status).toBe("failed");
      const failure = terminal.type === "turn.terminal" && terminal.status === "failed" ? terminal.failure : undefined;
      expect(failure).toMatchObject({ class: "permission_error", code: "key_refused", message: KEY_REFUSED.message });
      for (const error of errors) expect(error).toMatchObject({ code: "key_refused" });
    });

    it("a relayed usage limit: t3's usage limit with the endpoint's reset", async () => {
      const { terminal } = await run(acpTurn(cli, USAGE_LIMIT, "commissary/claude-haiku-5-5"));
      expect(terminal.type === "turn.terminal" && terminal.status === "failed" ? terminal.failure : undefined).toMatchObject({ class: "usage_limit", resetAt: "2026-11-16T12:00:00.000Z" });
    });

    it("no relay failure: the adapter's own failure, never a text naming the retired Model proxy's key (SPI-1176)", async () => {
      const onEndpoint = await run(acpTurn(cli, null, "commissary/claude-haiku-5-5"));
      const endpointFailure = onEndpoint.terminal.type === "turn.terminal" && onEndpoint.terminal.status === "failed" ? onEndpoint.terminal.failure : undefined;
      expect(endpointFailure?.message).not.toMatch(/model proxy|COMMISSARY/i);
    });
  });
}

// --- Codex and pi: their adapters' failures, from a stand-in adapter ------------------------------------------------

/** A stand-in for t3's adapter whose one turn fails with `failure`, as t3's Codex or Pi adapter reports it. */
const standIn = (driver: ProviderDriverKind, failure: OrchestrationV2ProviderFailure): ProviderAdapter.ProviderAdapterV2["Service"] =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver,
    getCapabilities: () => Effect.die("unused"),
    planSelectionTransition: () => Effect.die("unused"),
    openSession: (input: { readonly providerSessionId: ProviderSessionIdType }) =>
      Effect.succeed({
        providerSession: { capabilities: {} },
        events: Stream.make(
          {
            type: "turn_item.updated",
            driver,
            turnItem: { type: "error", failure, id: "item-1", ordinal: 1 },
          },
          {
            type: "turn.terminal",
            driver,
            providerThreadId: ProviderThreadId.make(`thread-${input.providerSessionId}`),
            providerTurnId: ProviderTurnId.make("turn-1"),
            runOrdinal: 1,
            failureItemOrdinal: 1,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          },
        ),
      }),
  }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const standInTurn = (driver: string, failure: OrchestrationV2ProviderFailure, relayed: EndpointFailureRecord | null, model: string) =>
  Effect.gen(function* () {
    const adapter = wrapCliAdapter(standIn(ProviderDriverKind.make(driver), failure), { sessions: new Map(), now: () => NOW, relayFailure: async () => relayed });
    const runtime = yield* adapter.openSession({
      threadId: ThreadId.make(`thread-${driver}-${++threads}`),
      providerSessionId: ProviderSessionId.make(`session-${driver}-${threads}`),
      modelSelection: { instanceId: ProviderInstanceId.make(driver), model },
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "full-access", interactionMode: "default", cwd: "/w/x" }),
    } as never);
    return Array.from(yield* Stream.runCollect(runtime.events));
  });

const CLI_FAILURES = {
  // t3's Codex adapter: Codex's own usage limit (its `usageLimitExceeded`), with no reset t3 can arm.
  codex: makeProviderFailure({ class: "usage_limit", message: "You've hit your usage limit.", code: null, retryable: true }),
  // t3's Pi adapter: every model error is a provider error carrying pi's text.
  pi: makeProviderFailure({ class: "provider_error", message: '429 {"error":{"type":"usage_limit_reached"}}', code: null, retryable: null }),
} as const;

for (const [driver, failure] of Object.entries(CLI_FAILURES)) {
  describe(`${driver} on a Model endpoint, through the relay`, () => {
    it("the terminal and the error item carry the relay's classification", async () => {
      const events = await run(standInTurn(driver, failure, USAGE_LIMIT, "commissary/claude-haiku-5-5"));
      const failures = events.flatMap((event) => (event.type === "turn.terminal" && event.status === "failed" ? [event.failure] : event.type === "turn_item.updated" && event.turnItem.type === "error" ? [event.turnItem.failure] : []));
      expect(failures).toHaveLength(2);
      for (const each of failures) expect(each).toMatchObject({ class: "usage_limit", code: "usage_limit", message: USAGE_LIMIT.message, resetAt: "2026-11-16T12:00:00.000Z" });
    });

    it("with no relay failure, the adapter's own failure stands", async () => {
      const events = await run(standInTurn(driver, failure, null, "commissary/claude-haiku-5-5"));
      const terminal = events.find((event) => event.type === "turn.terminal");
      expect(terminal?.type === "turn.terminal" && terminal.status === "failed" ? terminal.failure : undefined).toEqual(failure);
    });
  });
}
