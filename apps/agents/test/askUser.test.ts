// `ask_user` (step 3, plan section 3.2) on a real pi-durable Harness: the question waits durably through more restarts
// than `restartLimit`, and the owner's answer (a choice or free text) is the tool's result, once.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { askUser, answerText, QuestionStore } from "../src/extensions/ask-user.ts";
import { memoryKv, restartingHarness, textOf, until } from "./harness.fixture.ts";

const ask = (args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("ask_user", args as never, { id: "ask-1" })], { stopReason: "toolUse" });

describe("ask_user", () => {
  it("waits through restarts for the owner's answer, which is the tool's result", async () => {
    const kv = memoryKv();
    let store = new QuestionStore(kv, () => {});
    const host = {
      get store() {
        return store;
      },
      turn: () => "turn-1",
    };
    const harness = await restartingHarness([askUser(host)], [ask({ question: "Which color?", options: ["red", "blue"] }), fauxAssistantMessage("ok")]);
    await until(() => store.pending().length === 1, "the question");
    const question = store.pending()[0]!;
    expect(question).toMatchObject({ question: "Which color?", options: ["red", "blue"], allowFreeText: true, turn: "turn-1" });
    for (let restart = 0; restart < 7; restart++) {
      store = new QuestionStore(kv, () => {});
      await harness.restart();
      await until(() => store.pending().length === 1, `the question after restart ${restart + 1}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(store.answer(question.requestId, "blue")).toBe(true);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    expect(textOf(await harness.lastToolResult())).toBe("The owner answered: blue");
    expect(store.pending()).toEqual([]);
  }, 30_000);

  it("reads t3's answer shapes as text", () => {
    expect(answerText("blue")).toBe("blue");
    expect(answerText(["red", "blue"])).toBe("red, blue");
    expect(answerText({ answers: ["a"] })).toBe("a");
    expect(answerText(undefined)).toBeUndefined();
  });
});
