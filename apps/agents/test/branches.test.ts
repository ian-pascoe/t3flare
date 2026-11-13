// G6 (SPI-997 fork, SPI-987 rollback) on a real pi-durable Harness over pi-ai's faux provider, whose model answers with
// the user messages it was given: a rollback forgets the dropped turns (the model no longer sees them), a fork across
// Harnesses (two Session DOs) sees the source's turns through the fork point and not after it.
// @effect-diagnostics asyncFunction:off
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type Conversation, createRegistry, Harness as HarnessApi, MemoryStorage } from "@earendil-works/pi-durable";
import type { TurnState } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { FORK_ENTRY_KIND, forkPage, forkPoint, freshConversation, rewind, rollbackPlan, seed } from "../src/session/branches.ts";
import { context } from "./harness.fixture.ts";

const userTexts = (messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>): Array<string> =>
  messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : []));

const open = async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const answer = (transcript: { readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }> }) =>
    fauxAssistantMessage(`saw ${userTexts(transcript.messages).join(",")}`);
  faux.setResponses(Array.from({ length: 20 }, () => answer));
  const harness = await HarnessApi.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "low" } });
  await root.configure({ cwd: "/workspace/repo" }, context);
  harness.resume();
  return { harness, root };
};

/** Runs `text` as a turn, as the Session records it: its input entry. */
const turn = async (conversation: Conversation, text: string): Promise<TurnState> => {
  const submission = await conversation.submit({ type: "input", content: text }, context);
  const status = (await submission.wait(context)) as { readonly entry?: number };
  return { submissionId: String(submission.id), runId: text, attemptId: text, status: "answered", startedAt: 0, inputEntry: String(status.entry) };
};

const lastAnswer = async (conversation: Conversation): Promise<string> => {
  const { messages } = await conversation.context(context);
  const last = messages.at(-1) as { readonly role: string; readonly content: ReadonlyArray<{ readonly text?: string }> };
  expect(last.role).toBe("assistant");
  return last.content.map((block) => block.text ?? "").join("");
};

const threeTurns = async (root: Conversation) => {
  const turns: Record<string, TurnState> = {};
  for (const text of ["alpha", "bravo", "charlie"]) turns[`turn-${text}`] = await turn(root, text);
  expect(await lastAnswer(root)).toBe("saw alpha,bravo,charlie");
  return turns;
};

describe("rollbackPlan", () => {
  const turns: Record<string, TurnState> = {
    a: { submissionId: "1", runId: "a", attemptId: "a", status: "answered", startedAt: 0, inputEntry: "7" },
    b: { submissionId: "2", runId: "b", attemptId: "b", status: "answered", startedAt: 0, inputEntry: "11" },
    c: { submissionId: "3", runId: "c", attemptId: "c", status: "answered", startedAt: 0, inputEntry: "15" },
    never: { submissionId: "", runId: "n", attemptId: "n", status: "failed", startedAt: 0 },
  };

  it("drops from the first placed turn on, also turns t3 did not name", () => {
    const plan = rollbackPlan(turns, ["b"]);
    expect(plan.boundary).toBe(11);
    expect([...plan.drop].sort()).toEqual(["b", "c"]);
  });

  it("changes nothing for turns never placed or unknown, but forgets the known ones", () => {
    const plan = rollbackPlan(turns, ["never", "gone"]);
    expect(plan.boundary).toBeUndefined();
    expect([...plan.drop]).toEqual(["never"]);
  });
});

describe("rollback (SPI-987)", () => {
  it("rolls back two turns: the fork forgets them and keeps the first", async () => {
    const { harness, root } = await open();
    const turns = await threeTurns(root);
    const { boundary } = rollbackPlan(turns, ["turn-bravo", "turn-charlie"]);
    const next = await rewind(harness, root, boundary!, context);
    expect(next.id).not.toBe(root.id);
    expect(userTexts((await next.context(context)).messages)).toEqual(["alpha"]);
    await turn(next, "delta");
    expect(await lastAnswer(next)).toBe("saw alpha,delta");
    // The agent is the one the turns had: model, thinking level and cwd.
    const agent = await next.agent(context);
    expect([agent.model, agent.thinkingLevel, agent.cwd]).toEqual([{ provider: "faux", modelId: "faux-1" }, "low", "/workspace/repo"]);
    // The old conversation is history, unchanged.
    expect(userTexts((await root.context(context)).messages)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("rolls back to the thread's start: a fresh conversation with the same agent", async () => {
    const { harness, root } = await open();
    const turns = await threeTurns(root);
    const { boundary } = rollbackPlan(turns, Object.keys(turns));
    const next = await rewind(harness, root, boundary!, context);
    expect((await next.context(context)).messages).toEqual([]);
    const [before, after] = [await root.agent(context), await next.agent(context)];
    expect([after.model, after.thinkingLevel, after.cwd]).toEqual([before.model, before.thinkingLevel, before.cwd]);
    expect(after.tools.map((tool) => tool.name)).toEqual(before.tools.map((tool) => tool.name));
    await turn(next, "delta");
    expect(await lastAnswer(next)).toBe("saw delta");
  });
});

describe("fork (SPI-997)", () => {
  it("seeds another Session with the source's context through the fork's turn, a page at a time", async () => {
    const source = await open();
    const turns = await threeTurns(source.root);
    const at = await forkPoint(source.root, turns, "turn-bravo", context);
    // The fork point is bravo's answer: before charlie's input.
    expect(Number(at)).toBeLessThan(Number(turns["turn-charlie"]!.inputEntry));
    const target = await open();
    const conversation = await freshConversation(target.harness, target.root, context);
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      // One message a page: the paging is exercised.
      const page = await forkPage(source.root, at, offset, 1, context);
      await seed(conversation, page.messages, { source: "thread:source", at: page.at }, context);
      offset = page.next;
      pages += 1;
    }
    expect(pages).toBe(4);
    const seeded = await conversation.entries({ order: "ascending" }, 10, undefined, context);
    expect(new Set(seeded.items.map((entry) => entry.kind))).toEqual(new Set([FORK_ENTRY_KIND]));
    expect(userTexts((await conversation.context(context)).messages)).toEqual(["alpha", "bravo"]);
    await turn(conversation, "delta");
    expect(await lastAnswer(conversation)).toBe("saw alpha,bravo,delta");
    // The source goes on as it was.
    await turn(source.root, "echo");
    expect(await lastAnswer(source.root)).toBe("saw alpha,bravo,charlie,echo");
  });

  it("forks from the newest turn through its end, and refuses a turn the Session never placed", async () => {
    const source = await open();
    const turns = await threeTurns(source.root);
    const at = await forkPoint(source.root, turns, "turn-charlie", context);
    const page = await forkPage(source.root, at, 0, Number.POSITIVE_INFINITY, context);
    expect(page.next).toBeNull();
    expect(userTexts(page.messages as never)).toEqual(["alpha", "bravo", "charlie"]);
    await expect(forkPoint(source.root, turns, "turn-unknown", context)).rejects.toThrow(/not in this Session/);
  });

  it("batches seeded messages into entries", async () => {
    const target = await open();
    const conversation = await freshConversation(target.harness, target.root, context);
    const messages = Array.from({ length: 5 }, (_, index) => ({ role: "user", content: `m${index}`, timestamp: index }));
    await seed(conversation, messages, { source: "s", at: "1" }, context);
    const entries = await conversation.entries({ order: "ascending" }, 10, undefined, context);
    expect(entries.items).toHaveLength(1);
    expect(userTexts((await conversation.context(context)).messages)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});
