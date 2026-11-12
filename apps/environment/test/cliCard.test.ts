// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// ADR-0028 (review M9): the MCP relay's tool card on a CLI thread is raised as t3's approval card on that thread's live
// turn by the CLI wrapper, and answered from t3's own `respondToRuntimeRequest`. Run over t3's ACP adapter, built with
// the driver's own options (`acpAdapterOptions`), and a scripted agent (fixtures/fake-acp-agent.mjs) whose turn waits on
// a permission request of its own, so the card is asked mid-turn as a relayed tool call would be. (SPI-1040's push
// cards came this way until the back-to-stock cut, owner 2026-11-12.)
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpAdapterV2, type AcpAdapterV2RuntimeInput } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { approveCliTool, cancelCliAsk } from "../src/provider/cli/cliAsk.ts";
import { wrapCliAdapter } from "../src/provider/cli/wrapper.ts";

const AGENT = path.join(import.meta.dirname, "fixtures/fake-acp-agent.mjs");

const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {}, fork: {}, resume: {} } },
  authMethods: [],
  agentInfo: { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.106.0" },
};
const SESSION_NEW = {
  sessionId: "claude-session",
  modes: { currentModeId: "default", availableModes: ["default", "acceptEdits", "plan"].map((id) => ({ id, name: id })) },
  configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: ["default", "claude-sonnet-5-5"].map((value) => ({ value, name: value })) }],
};
const OPTIONS = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
/** The agent's own request: holds the turn open until the test answers it. */
const HOLD = { request: { method: "session/request_permission", params: { toolCall: { toolCallId: "tc-hold", kind: "execute", title: "execute ls", locations: [], rawInput: {} }, options: OPTIONS } } };

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

type Event = ProviderAdapter.ProviderAdapterV2Event;

let threads = 0;

/** A wrapped Claude session over the scripted agent, its turn started and waiting on the agent's own request. */
const session = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3flare-cli-card-" });
    const scriptPath = path.join(cwd, "..", `${path.basename(cwd)}.script.json`);
    const logPath = path.join(cwd, "..", `${path.basename(cwd)}.log`);
    fs.writeFileSync(scriptPath, JSON.stringify({ initialize: INITIALIZE, sessionNew: SESSION_NEW, prompts: [[HOLD]] }));
    fs.writeFileSync(logPath, "");
    const spawn = (input: AcpAdapterV2RuntimeInput) =>
      Effect.gen(function* () {
        const { processEnvironment: _env, runtimePolicy: _policy, mcpServers: _mcp, acpMcpServers: _acp, httpMcpServers: _http, ...rest } = input;
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...rest,
            spawn: { command: process.execPath, args: [AGENT], cwd: input.cwd, env: { PATH: process.env.PATH ?? "", FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath }, extendEnv: false },
            authenticateOnAuthRequired: false,
            ownDetachedProcessGroup: true,
            processGroupPlatform: process.platform,
          }),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
      });
    const driver = ProviderDriverKind.make("claudeAgent");
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const adapter = wrapCliAdapter(yield* makeAcpAdapterV2(acpAdapterOptions(instanceId, acpFlavor("claude", driver, { spawn }), undefined)), {
      sessions: new Map(),
    });
    const threadId = ThreadId.make(`thread-card-${++threads}`);
    const modelSelection = { instanceId, model: "anthropic/claude-sonnet-5-5" } as const;
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "approval-required", interactionMode: "default", cwd });
    const runtime = yield* adapter.openSession({ threadId, providerSessionId: ProviderSessionId.make(`session-card-${threads}`), modelSelection, runtimePolicy });
    const queue = yield* Queue.unbounded<Event>();
    const seen: Array<Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(queue, event)))),
      Effect.forkScoped,
    );
    const until = (predicate: (event: Event) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (predicate(event)) return event;
        }
      }).pipe(Effect.timeout("20 seconds"));
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const agentLog = () =>
      fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { received?: string; params?: Record<string, unknown> });
    return { runtime, threadId, providerThread, instanceId, runtimePolicy, modelSelection, until, seen, agentLog };
  });

type Harness = Effect.Success<ReturnType<typeof session>>;

const startTurn = (harness: Harness) =>
  Effect.gen(function* () {
    const { runtime, threadId, providerThread, instanceId, runtimePolicy, modelSelection } = harness;
    yield* runtime.startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now: yield* DateTime.now, modelSelection }));
    // The agent's own request: the turn is live, and its provider turn known.
    const hold = yield* harness.until((event) => event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending");
    if (hold.type !== "runtime_request.updated") throw new Error("expected the agent's request");
    return hold.runtimeRequest;
  });

const isCard = (event: Event) => event.type === "runtime_request.updated" && event.runtimeRequest.id.includes(":t3flare-ask:");
const cardOpened = (event: Event) => isCard(event) && event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending";

const ask = (harness: Harness, askId: string) =>
  Effect.promise(() => approveCliTool({ thread: harness.threadId, askId, title: "Allow fixture: fixture_note?", summary: "fixture_note {\"line\":\"x\"}", detail: "fixture: fixture_note" }));

const test = <A>(body: Effect.Effect<A, unknown, Layer.Success<typeof layerTest> | import("effect/Scope").Scope>) => Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(layerTest)) as never);

describe("a relay tool call asked on a CLI thread (ADR-0028, M9)", () => {
  it("raises t3's approval card on the live turn and answers with the owner's decision", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        const hold = yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-1").pipe(Effect.forkScoped);
        const opened = yield* harness.until(cardOpened);
        if (opened.type !== "runtime_request.updated") throw new Error("expected the card");
        // The card's node and turn item are on the agent's own turn, beside its request.
        expect(opened.runtimeRequest.providerTurnId).toBe(hold.providerTurnId);
        expect(opened.runtimeRequest.kind).toBe("permission");
        expect(opened.runtimeRequest.responseCapability).toMatchObject({ type: "live" });
        const node = yield* harness.until((event) => event.type === "node.updated" && event.node.runtimeRequestId === opened.runtimeRequest.id);
        expect(node.type === "node.updated" && [node.node.kind, node.node.status, node.node.parentNodeId]).toEqual(["approval_request", "waiting", node.type === "node.updated" ? node.node.rootNodeId : null]);
        const item = yield* harness.until((event) => event.type === "turn_item.updated" && "requestId" in event.turnItem && event.turnItem.requestId === opened.runtimeRequest.id);
        if (item.type !== "turn_item.updated" || item.turnItem.type !== "approval_request") throw new Error("expected the card's turn item");
        expect(item.turnItem.title).toBe("Allow fixture: fixture_note?");
        expect(item.turnItem.prompt).toContain("fixture_note");
        expect(item.turnItem.options?.map((option) => option.decision)).toEqual(["accept", "acceptForSession", "decline"]);
        // The agent's own items are numbered from the turn's ordinal; the card comes after them.
        const ordinals = harness.seen.flatMap((event) => (event.type === "turn_item.updated" && event.turnItem.id !== item.turnItem.id ? [event.turnItem.ordinal] : []));
        expect(item.turnItem.ordinal).toBeGreaterThan(Math.max(0, ...ordinals));

        yield* harness.runtime.respondToRuntimeRequest({ requestId: opened.runtimeRequest.id, decision: "acceptForSession" });
        expect(yield* Fiber.join(answer)).toEqual({ approved: true, forSession: true });
        const closed = yield* harness.until(isCard);
        expect(closed.type === "runtime_request.updated" && [closed.runtimeRequest.status, closed.runtimeRequest.decision]).toEqual(["resolved", "acceptForSession"]);
        // The CLI never saw the card: only its own request was answered to it.
        expect(harness.agentLog().filter((entry) => entry.received === "response")).toHaveLength(0);

        yield* harness.runtime.respondToRuntimeRequest({ requestId: hold.id, decision: "accept" });
        const terminal = yield* harness.until((event) => event.type === "turn.terminal");
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
      }),
    ));

  it("a decline refuses, and a second answer to a closed card is an error", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-3").pipe(Effect.forkScoped);
        const card = yield* harness.until(cardOpened);
        if (card.type !== "runtime_request.updated") throw new Error("expected the card");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: card.runtimeRequest.id, decision: "decline" });
        expect(yield* Fiber.join(answer)).toEqual({ approved: false, reason: "decline" });
        // As t3's adapters answer an unknown request.
        const late = yield* harness.runtime.respondToRuntimeRequest({ requestId: card.runtimeRequest.id, decision: "accept" }).pipe(Effect.flip);
        expect(late._tag).toBe("ProviderAdapterRuntimeRequestResponseError");
      }),
    ));

  it("withdraws the card when the calling CLI goes away (review M7)", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-6").pipe(Effect.forkScoped);
        yield* harness.until(cardOpened);
        cancelCliAsk("ask-6");
        const closed = yield* harness.until(isCard);
        expect(closed.type === "runtime_request.updated" && closed.runtimeRequest.status).toBe("cancelled");
        expect(yield* Fiber.join(answer)).toEqual({ approved: false, reason: "the agent went away" });
      }),
    ));

  it("closes an open card before t3 sees the turn end, and refuses once no turn is live", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        // Before any turn: nothing to ask on.
        expect((yield* ask(harness, "ask-7")).approved).toBe(false);
        const hold = yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-8").pipe(Effect.forkScoped);
        const card = yield* harness.until(cardOpened);
        if (card.type !== "runtime_request.updated") throw new Error("expected the card");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: hold.id, decision: "accept" });
        yield* harness.until((event) => event.type === "turn.terminal");
        expect(yield* Fiber.join(answer)).toEqual({ approved: false, reason: "the turn ended" });
        const order = harness.seen.flatMap((event) => (event.type === "turn.terminal" ? ["terminal"] : isCard(event) && event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled" ? ["cancelled"] : []));
        expect(order).toEqual(["cancelled", "terminal"]);
        expect(yield* ask(harness, "ask-9")).toEqual({ approved: false, reason: "no live turn to ask on" });
      }),
    ));
});

describe("the ACP driver's adapter options", () => {
  it("never gives t3's adapter client terminals: the agent's commands run in the Workspace, not in t3", () =>
    test(
      Effect.gen(function* () {
        const options = acpAdapterOptions(ProviderInstanceId.make("claudeAgent"), acpFlavor("claude", ProviderDriverKind.make("claudeAgent"), {}), undefined);
        expect("clientTerminals" in options).toBe(false);
        const harness = yield* session();
        const hold = yield* startTurn(harness);
        yield* harness.runtime.respondToRuntimeRequest({ requestId: hold.id, decision: "accept" });
        const initialize = harness.agentLog().find((entry) => entry.received === "initialize");
        expect((initialize?.params?.clientCapabilities as { terminal?: boolean } | undefined)?.terminal ?? false).toBe(false);
      }),
    ));
});
