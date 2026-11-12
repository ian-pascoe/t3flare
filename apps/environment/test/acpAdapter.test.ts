// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// t3's own ACP adapter (`makeAcpAdapterV2`) through our flavors (step 4b, plan §9's "Node with t3's adapter", review
// F1; back to stock, owner 2026-11-12): a scripted agent (fixtures/fake-acp-agent.mjs) answers as claude-agent-acp 0.106.0 and opencode 2.2.7
// did in M0's probes. Each test asserts what the agent was answered and what t3 saw.
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
import { acpFlavor } from "../src/provider/cli/acpDriver.ts";
import type { AcpCli } from "../src/provider/cli/acpFlavor.ts";

const AGENT = path.join(import.meta.dirname, "fixtures/fake-acp-agent.mjs");

// M0 P1's claude-agent-acp answers (managed settings: no auto, no bypass) and its cards.
const CLAUDE = {
  initialize: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {}, fork: {}, resume: {} } },
    authMethods: [],
    agentInfo: { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.106.0" },
  },
  sessionNew: (modes = ["default", "acceptEdits", "plan"], current = "default") => ({
    sessionId: "claude-session",
    modes: { currentModeId: current, availableModes: modes.map((id) => ({ id, name: id })) },
    configOptions: [
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: current, options: modes.map((value) => ({ value, name: value })) },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: ["default", "claude-sonnet-5-5", "gpt-6-luna"].map((value) => ({ value, name: value })) },
    ],
  }),
  editOptions: [
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "allow-with-updates", name: "Yes, and don't ask again", kind: "allow_always" },
    { optionId: "reject", name: "No", kind: "reject_once" },
  ],
  exitPlanOptions: [
    { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
    { optionId: "exit-plan-clear-accept-edits", name: "Yes, clear context and auto-accept edits", kind: "allow_always" },
    { optionId: "exit-plan-accept-edits", name: "Yes, auto-accept edits", kind: "allow_always" },
    { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
  ],
};

// M0 P2's opencode answers: no ACP modes, the agent is the `mode` config option.
const OPENCODE = {
  initialize: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {}, fork: {}, resume: {} } },
    authMethods: [{ id: "opencode-login", name: "Login" }],
    agentInfo: { name: "OpenCode", version: "2.2.7" },
  },
  sessionNew: () => ({
    sessionId: "ses_opencode",
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "t3flare/claude-sonnet-5-5", options: ["t3flare/claude-sonnet-5-5", "t3flare/gpt-6-luna"].map((value) => ({ value, name: value })) },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: ["build", "plan"].map((value) => ({ value, name: value })) },
    ],
  }),
  options: [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

interface Script {
  readonly initialize: unknown;
  readonly sessionNew: unknown;
  readonly prompts: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}

const permission = (kind: string, paths: ReadonlyArray<string>, options: ReadonlyArray<unknown>, rawInput: unknown = {}) => ({
  request: { method: "session/request_permission", params: { toolCall: { toolCallId: `tc-${kind}-${paths.length}`, kind, title: `${kind} ${paths.join(" ")}`, locations: paths.map((p) => ({ path: p })), rawInput }, options } },
});

/** An adapter session over the scripted agent, one turn started; its events and the agent's log. */
const session = (cli: AcpCli, build: (cwd: string) => Script, policy: { readonly runtimeMode: string; readonly interactionMode?: "default" | "plan" }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3flare-acp-" });
    const scriptPath = path.join(cwd, "..", `${path.basename(cwd)}.script.json`);
    const logPath = path.join(cwd, "..", `${path.basename(cwd)}.log`);
    fs.writeFileSync(scriptPath, JSON.stringify(build(cwd)));
    fs.writeFileSync(logPath, "");
    const spawn = (input: AcpAdapterV2RuntimeInput) =>
      Effect.gen(function* () {
        const { processEnvironment: _env, runtimePolicy: _policy, mcpServers: _mcp, acpMcpServers: _acp, httpMcpServers: _http, ...options } = input;
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...options,
            spawn: { command: process.execPath, args: [AGENT], cwd: input.cwd, env: { PATH: process.env.PATH ?? "", FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath }, extendEnv: false },
            authenticateOnAuthRequired: false,
            // As in production (acpDriver.ts): the process group is ours.
            ownDetachedProcessGroup: true,
            processGroupPlatform: process.platform,
          }),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
      });
    const driver = ProviderDriverKind.make(cli === "claude" ? "claudeAgent" : "opencode");
    const instanceId = ProviderInstanceId.make(cli === "claude" ? "claudeAgent" : "opencode");
    const adapter = yield* makeAcpAdapterV2({ instanceId, flavor: acpFlavor(cli, driver, { spawn }), selfInvocation: { command: "none", entrypoint: undefined } });
    const threadId = ThreadId.make(`thread-${cli}`);
    const modelSelection = { instanceId, model: "anthropic/claude-sonnet-5-5" } as const;
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: policy.runtimeMode as never, interactionMode: policy.interactionMode ?? "default", cwd });
    const runtime = yield* adapter.openSession({ threadId, providerSessionId: ProviderSessionId.make(`session-${cli}`), modelSelection, runtimePolicy });
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(events, event)))),
      Effect.forkScoped,
    );
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* runtime.startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now: yield* DateTime.now, modelSelection }));
    const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(events);
          if (predicate(event)) return event;
        }
      }).pipe(Effect.timeout("20 seconds"));
    const agentLog = () =>
      fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { received?: string; answered?: string; params?: Record<string, unknown>; result?: { outcome?: { outcome: string; optionId?: string } } });
    return { runtime, cwd, until, seen, agentLog, terminal: until((event) => event.type === "turn.terminal") };
  });

const pendingRequest = (event: ProviderAdapter.ProviderAdapterV2Event) => event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending";
const answers = (log: ReturnType<Awaited<ReturnType<typeof run>>["agentLog"]>) => log.filter((entry) => entry.answered !== undefined).map((entry) => entry.result?.outcome?.optionId ?? entry.result?.outcome?.outcome);
const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);
const test = <A>(body: Effect.Effect<A, unknown, Layer.Success<typeof layerTest> | import("effect/Scope").Scope>) => run(body.pipe(Effect.scoped, Effect.provide(layerTest)) as never);

describe("Claude Code through t3's ACP adapter", () => {
  it("asks the owner for an edit at approval-required, and 'for the session' picks the agent's own (stock t3)", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session(
          "claude",
          (cwd) => ({ initialize: CLAUDE.initialize, sessionNew: CLAUDE.sessionNew(), prompts: [[permission("edit", [`${cwd}/a.txt`], CLAUDE.editOptions), permission("execute", [cwd], CLAUDE.editOptions)]] }),
          { runtimeMode: "approval-required" },
        );
        const first = yield* harness.until(pendingRequest);
        if (first.type !== "runtime_request.updated") throw new Error("expected a request");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: first.runtimeRequest.id, decision: "acceptForSession" });
        const second = yield* harness.until(pendingRequest);
        if (second.type !== "runtime_request.updated") throw new Error("expected a request");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: second.runtimeRequest.id, decision: "accept" });
        const terminal = yield* harness.terminal;
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
        const log = harness.agentLog();
        // "For the session" is the agent's allow_always, as stock t3 answers it; "accept" its allow_once.
        expect(answers(log)).toEqual(["allow-with-updates", "allow-once"]);
        // Pinned to `default`, the catalog id chosen as the model.
        expect(log.find((entry) => entry.received === "session/set_config_option" && entry.params?.configId === "model")?.params?.value).toBe("claude-sonnet-5-5");
        expect(log.some((entry) => entry.received === "session/set_mode" && entry.params?.modeId !== "default")).toBe(false);
      }),
    ));

  it("captures the plan when Claude asks to leave plan mode, and denies the request (review F1)", () =>
    test(
      Effect.gen(function* () {
        const plan = "# Add d.txt\n\n1. Write d.txt containing z.";
        const harness = yield* session(
          "claude",
          () => ({ initialize: CLAUDE.initialize, sessionNew: CLAUDE.sessionNew(), prompts: [[permission("switch_mode", [], CLAUDE.exitPlanOptions, { plan }), { result: { stopReason: "cancelled" } }]] }),
          { runtimeMode: "full-access", interactionMode: "plan" },
        );
        const terminal = yield* harness.terminal;
        const log = harness.agentLog();
        const toPlan = (entry: (typeof log)[number]) =>
          (entry.received === "session/set_mode" && entry.params?.modeId === "plan") || (entry.received === "session/set_config_option" && entry.params?.configId === "mode" && entry.params.value === "plan");
        expect(log.some(toPlan), JSON.stringify(log.map((entry) => [entry.received, entry.params?.modeId ?? entry.params?.configId, entry.params?.value]))).toBe(true);
        // Denied even at full-access: `reject`, never `exit-plan-default` (Claude would implement in the plan turn).
        expect(answers(log)).toEqual(["reject"]);
        expect(JSON.stringify(harness.seen)).toContain("Write d.txt containing z.");
        expect(harness.seen.some((event) => event.type === "turn_item.updated" && event.turnItem.type === "proposed_plan")).toBe(true);
        // Claude stops the prompt as cancelled after the denial; the plan turn completed with its plan.
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
      }),
    ));

  it("keeps the session when the agent changes its own mode, and t3 still decides what it asks", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session(
          "claude",
          (cwd) => ({
            initialize: CLAUDE.initialize,
            sessionNew: CLAUDE.sessionNew(),
            prompts: [[{ update: { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" } }, permission("execute", [cwd], CLAUDE.editOptions)]],
          }),
          { runtimeMode: "approval-required" },
        );
        const asked = yield* harness.until(pendingRequest);
        if (asked.type !== "runtime_request.updated") throw new Error("expected a request");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: asked.runtimeRequest.id, decision: "accept" });
        const terminal = yield* harness.terminal;
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
        expect(answers(harness.agentLog())).toEqual(["allow-once"]);
      }),
    ));

  it("at t3's auto puts Claude in its own auto mode, and asks the owner for what Claude asks", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session(
          "claude",
          (cwd) => ({ initialize: CLAUDE.initialize, sessionNew: CLAUDE.sessionNew(["default", "acceptEdits", "plan", "auto"]), prompts: [[permission("execute", [cwd], CLAUDE.editOptions)]] }),
          { runtimeMode: "auto" },
        );
        const asked = yield* harness.until(pendingRequest);
        if (asked.type !== "runtime_request.updated") throw new Error("expected a request");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: asked.runtimeRequest.id, decision: "accept" });
        yield* harness.terminal;
        const log = harness.agentLog();
        const toAuto = (entry: (typeof log)[number]) => (entry.received === "session/set_mode" && entry.params?.modeId === "auto") || (entry.received === "session/set_config_option" && entry.params?.configId === "mode" && entry.params.value === "auto");
        expect(log.some(toAuto)).toBe(true);
        expect(answers(log)).toEqual(["allow-once"]);
      }),
    ));

  it("at t3's auto stays in the asking mode when Claude does not offer auto", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session(
          "claude",
          (cwd) => ({ initialize: CLAUDE.initialize, sessionNew: CLAUDE.sessionNew(), prompts: [[permission("execute", [cwd], CLAUDE.editOptions)]] }),
          { runtimeMode: "auto" },
        );
        const asked = yield* harness.until(pendingRequest);
        if (asked.type !== "runtime_request.updated") throw new Error("expected a request");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: asked.runtimeRequest.id, decision: "accept" });
        const terminal = yield* harness.terminal;
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
        expect(harness.agentLog().some((entry) => (entry.received === "session/set_mode" && entry.params?.modeId === "auto") || (entry.received === "session/set_config_option" && entry.params?.value === "auto"))).toBe(false);
      }),
    ));
});

describe("OpenCode through t3's ACP adapter", () => {
  it("at auto-accept-edits allows every edit without asking, wherever it points (stock t3)", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session(
          "opencode",
          (cwd) => ({
            initialize: OPENCODE.initialize,
            sessionNew: OPENCODE.sessionNew(),
            prompts: [[permission("edit", [`${cwd}/src/a.ts`], OPENCODE.options), permission("edit", ["/etc/opencode/opencode.json"], OPENCODE.options), permission("edit", [`${cwd}/.opencode/opencode.json`], OPENCODE.options)]],
          }),
          { runtimeMode: "auto-accept-edits" },
        );
        const terminal = yield* harness.terminal;
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
        const log = harness.agentLog();
        expect(answers(log)).toEqual(["once", "once", "once"]);
        expect(harness.seen.some(pendingRequest)).toBe(false);
        // The catalog model is already OpenCode's current value: no other model is set.
        expect(log.filter((entry) => entry.received === "session/set_config_option" && entry.params?.configId === "model" && entry.params.value !== "t3flare/claude-sonnet-5-5")).toEqual([]);
      }),
    ));

  it("runs a plan turn as OpenCode's plan agent and denies its edits", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session(
          "opencode",
          (cwd) => ({ initialize: OPENCODE.initialize, sessionNew: OPENCODE.sessionNew(), prompts: [[permission("edit", [`${cwd}/d.txt`], OPENCODE.options)]] }),
          { runtimeMode: "full-access", interactionMode: "plan" },
        );
        yield* harness.terminal;
        const log = harness.agentLog();
        expect(log.some((entry) => entry.received === "session/set_config_option" && entry.params?.configId === "mode" && entry.params.value === "plan")).toBe(true);
        expect(answers(log)).toEqual(["reject"]);
      }),
    ));
});

void Fiber;
