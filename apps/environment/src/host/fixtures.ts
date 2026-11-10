// Turn-item fixtures for the heavy-query acceptance checks (docs/plan.md, Checks per step → Step 1).
//
// There is no provider in the Environment yet, so no real turn can run. The fixtures are written the way a
// provider's ingestion writes them: as t3's own orchestration domain events (run.created, node.updated,
// message.updated, turn-item.updated, run.updated) through t3's EventSinkV2, which stores the events and
// applies t3's projections in one transaction. Thread window, shell snapshot and search then read real
// projection rows with turn items.
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "t3/src/orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "t3/src/orchestration-v2/runtimeLayer.ts";

import type { Runtime } from "../runtime.ts";

export interface FixtureOptions {
  readonly threadIds: ReadonlyArray<string>;
  /** Runs per thread. */
  readonly runs: number;
  /** A marker word put in every message, so search has something to find. */
  readonly marker: string;
}

export interface FixtureReport {
  readonly threads: number;
  readonly runs: number;
  readonly messages: number;
  readonly turnItems: number;
  readonly events: number;
  readonly eventSink: "runtime" | "fresh";
}

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" } as const;

/** The domain events of one completed run with a user message, reasoning, a command, a file change and a reply. */
const runEvents = (threadId: ThreadId, ordinal: number, marker: string, at: DateTime.Utc): Array<OrchestrationV2DomainEvent> => {
  const key = `${threadId}:${ordinal}`;
  const runId = RunId.make(`run:fixture:${key}`);
  const nodeId = NodeId.make(`node:fixture:${key}`);
  const userMessageId = MessageId.make(`message:fixture:${key}:user`);
  const assistantMessageId = MessageId.make(`message:fixture:${key}:assistant`);
  const event = (suffix: string) => EventId.make(`event:fixture:${key}:${suffix}`);
  const run = {
    id: runId,
    threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId,
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const base = {
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const userText = `Fixture request ${ordinal} for ${marker}: list the files and summarise the build.`;
  const replyText = `Fixture reply ${ordinal} (${marker}): the build bundles the Worker and uploads it unbundled. `.repeat(8);
  const items: Array<OrchestrationV2TurnItem> = [
    {
      ...base,
      id: TurnItemId.make(`item:fixture:${key}:user`),
      ordinal: 1,
      title: null,
      type: "user_message",
      messageId: userMessageId,
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      text: userText,
      attachments: [],
    } as unknown as OrchestrationV2TurnItem,
    { ...base, id: TurnItemId.make(`item:fixture:${key}:reasoning`), ordinal: 2, title: "Thinking", type: "reasoning", text: `Considering ${marker}.`, streaming: false },
    {
      ...base,
      id: TurnItemId.make(`item:fixture:${key}:command`),
      ordinal: 3,
      title: "ls -la",
      type: "command_execution",
      input: "ls -la",
      output: Array.from({ length: 40 }, (_, i) => `-rw-r--r--  1 t3 t3 ${1000 + i} Nov 10 12:00 file-${i}.ts`).join("\n"),
      exitCode: 0,
    },
    {
      ...base,
      id: TurnItemId.make(`item:fixture:${key}:file`),
      ordinal: 4,
      title: "Edited build.ts",
      type: "file_change",
      fileName: "build.ts",
      additions: 3,
      deletions: 1,
      diffStr: "@@ -1,2 +1,4 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n+const c = 4;\n",
    },
    {
      ...base,
      id: TurnItemId.make(`item:fixture:${key}:assistant`),
      ordinal: 5,
      title: null,
      type: "assistant_message",
      messageId: assistantMessageId,
      text: replyText,
      streaming: false,
    },
  ];
  const message = (id: MessageId, role: "user" | "assistant", text: string) => ({
    id,
    threadId,
    runId,
    nodeId: role === "assistant" ? nodeId : null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
    creationSource: role === "user" ? ("web" as const) : ("server" as const),
    createdAt: at,
    updatedAt: at,
  });
  const common = { threadId, runId, nodeId, driver: "codex", providerInstanceId: modelSelection.instanceId, occurredAt: at };
  return [
    { ...common, id: event("message-user"), type: "message.updated", payload: message(userMessageId, "user", userText) },
    { ...common, id: event("run-created"), type: "run.created", payload: run },
    {
      ...common,
      id: event("node"),
      type: "node.updated",
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: at,
        completedAt: at,
      },
    },
    ...items.map((item, i) => ({ ...common, id: event(`item-${i}`), type: "turn-item.updated" as const, payload: item })),
    { ...common, id: event("message-assistant"), type: "message.updated", payload: message(assistantMessageId, "assistant", replyText) },
    { ...common, id: event("run-completed"), type: "run.updated", payload: { ...run, status: "completed", completedAt: at } },
  ] as unknown as Array<OrchestrationV2DomainEvent>;
};

/** Writes the fixtures through t3's EventSinkV2: the running runtime's own if it exposes one, else a fresh one. */
export const writeFixtures = async (runtime: Runtime, options: FixtureOptions): Promise<FixtureReport> => {
  const own = Context.getOption(runtime.context, EventSink.EventSinkV2);
  const program = Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    let events = 0;
    for (const id of options.threadIds) {
      const threadId = ThreadId.make(id);
      for (let ordinal = 1; ordinal <= options.runs; ordinal++) {
        const at = DateTime.subtract(yield* DateTime.now, { minutes: options.runs - ordinal });
        const batch = runEvents(threadId, ordinal, options.marker, at);
        yield* sink.write({ events: batch });
        events += batch.length;
      }
    }
    return events;
  });
  const events = await runtime.run(
    own._tag === "Some"
      ? program.pipe(Effect.provideService(EventSink.EventSinkV2, own.value))
      : program.pipe(Effect.provide(RuntimeLayer.layerEventSink)),
  );
  return {
    threads: options.threadIds.length,
    runs: options.threadIds.length * options.runs,
    messages: options.threadIds.length * options.runs * 2,
    turnItems: options.threadIds.length * options.runs * 5,
    events,
    eventSink: own._tag === "Some" ? "runtime" : "fresh",
  };
};
