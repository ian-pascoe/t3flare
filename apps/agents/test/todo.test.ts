// The `todo` extension (SPI-1055) on a real pi-durable Harness over pi-ai's faux provider: the tool's batches change the
// Session's Todo document atomically, results show the list and its revision, and the projection puts the list back in
// front of a context that holds no `todo` result (once per window, the same bytes every request), with a note when a
// shown list is behind.
// @effect-diagnostics asyncFunction:off
import { type AssistantMessage, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, Harness as HarnessApi, type HookApi, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { TodoDoc, todoExtension, type TodoState } from "../src/extensions/todo.ts";
import { applyTodo, EMPTY_LIST, MAX_TASKS } from "../src/extensions/todo/list.ts";
import { SNAPSHOT_HEADER, STALE_NOTE, snapshotText, todoWindow } from "../src/extensions/todo/projection.ts";
import { context } from "./harness.fixture.ts";

const open = async (responses: ReadonlyArray<AssistantMessage>) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  const registry = createRegistry();
  let harness: Harness | undefined;
  registry.install(todoExtension(() => Promise.resolve(harness!)));
  harness = await HarnessApi.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await root.submit({ type: "input", content: "go" }, context);
  harness.resume();
  await root.waitForIdle(context);
  const page = await root.entries({ order: "ascending" }, 100, undefined, context);
  const results = page.items.flatMap((entry) => {
    const message = entry.model?.[0];
    return message?.role === "toolResult" ? [message] : [];
  });
  return { harness, root, results, faux };
};

const todo = (args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall("todo", args as never, { id })], { stopReason: "toolUse" });
const text = (message: { content: ReadonlyArray<{ type: string; text?: string }> }) => message.content.map((block) => block.text ?? "").join("");

describe("todo (SPI-1055)", () => {
  it("adds a batch, updates a batch, and keeps the list and its revision in the Session's document", async () => {
    const { harness, root, results } = await open([
      todo({ action: "add", tasks: [{ title: "Read the code" }, { title: "Write the port", description: "plain tools" }] }, "t1"),
      todo({ action: "update", updates: [{ id: 1, status: "completed" }, { id: 2, status: "active" }] }, "t2"),
      todo({ action: "update", updates: [{ id: 1, status: "completed" }, { id: 9, status: "active" }] }, "t3"),
      fauxAssistantMessage("done"),
    ]);
    expect(text(results[0]!)).toBe("Added 2 Tasks\n[ ] #1 Read the code\n[ ] #2 Write the port\n    plain tools");
    expect(results[0]!.details).toEqual({ todoRev: 1 });
    expect(text(results[1]!)).toBe("Updated 2 Tasks\n[x] #1 Read the code\n[>] #2 Write the port\n    plain tools");
    // A batch with one bad entry changes nothing.
    expect(results[2]!.isError).toBe(true);
    expect(text(results[2]!)).toContain("updates[1].id #9 was not found");
    const state = await harness.snapshot(TodoDoc, root.id, context);
    expect(state).toMatchObject({ rev: 2, nextId: 3, tasks: [{ id: 1, status: "completed" }, { id: 2, status: "active", description: "plain tools" }] });
  });

  it("refuses past 200 Tasks and keeps the ids until a clear", () => {
    const full = { nextId: MAX_TASKS + 1, tasks: Array.from({ length: MAX_TASKS }, (_, index) => ({ id: index + 1, title: `t${index}`, status: "pending" as const })) };
    expect(applyTodo(full, { action: "add", title: "one more" })).toMatchObject({ ok: false });
    const cleared = applyTodo(full, { action: "clear" });
    expect(cleared.ok && cleared.list).toEqual(EMPTY_LIST);
  });

  describe("the list in front of a context that shows none", () => {
    const user = (timestamp: number, content = "continue"): Message => ({ role: "user", content, timestamp });
    const state: TodoState = { nextId: 3, rev: 4, tasks: [{ id: 1, title: "a", status: "completed" }, { id: 2, title: "b", status: "pending" }], shown: null, changedBy: [] };

    const run = async (doc: typeof state, messages: ReadonlyArray<Message>) => {
      const commits: Array<unknown> = [];
      const fakeHarness = {
        commit: async (change: (tx: unknown) => Promise<void>) => {
          const draft = { ...doc };
          await change({ doc: () => Promise.resolve(draft) });
          commits.push(draft.shown);
        },
      } as unknown as Harness;
      const api = { conversationId: 1, snapshot: () => Promise.resolve(doc) } as unknown as HookApi;
      const registration = todoWindow(() => Promise.resolve(fakeHarness)) as unknown as { handlers: { beforeRequest: (request: unknown, api: HookApi, context: unknown) => Promise<{ messages: ReadonlyArray<Message> } | undefined> } };
      const answer = await registration.handlers.beforeRequest({ messages }, api, context);
      return { answer, commits };
    };

    it("puts the list, with the reconcile instruction, into the window's first message once and records it", async () => {
      const { answer, commits } = await run(state, [user(100)]);
      expect(answer?.messages[0]?.content).toBe(`continue\n\n${snapshotText(state)}`);
      expect(String(snapshotText(state))).toContain(SNAPSHOT_HEADER);
      expect(commits).toEqual([{ window: 100, rev: 4, text: snapshotText(state) }]);
      // The same window later: the recorded text, nothing recorded again, and a note if the list moved on.
      const later = await run({ ...state, rev: 5, shown: { window: 100, rev: 4, text: "recorded" } }, [user(100)]);
      expect(later.commits).toEqual([]);
      expect(later.answer?.messages[0]?.content).toBe(`continue\n\nrecorded\n\n${STALE_NOTE}`);
    });

    it("leaves a context whose last todo result shows the current list alone", async () => {
      const shown: Message = { role: "toolResult", toolCallId: "t", toolName: "todo", content: [{ type: "text", text: "list" }], details: { todoRev: 4 }, isError: false, timestamp: 2 };
      expect((await run(state, [user(100), shown])).answer).toBeUndefined();
    });
  });
});
