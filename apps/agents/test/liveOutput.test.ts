// SPI-996: what the Session pushes for t3's live command output and prompt suggestions.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TOOL_LIVE_OUTPUT_BYTES } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { PROMPT_SUGGESTION_PROMPT, suggestionContext, suggestPrompt } from "../src/session/promptSuggestion.ts";
import { liveOf } from "../src/session/state.ts";

describe("a running call's output in the push", () => {
  it("carries the tail of a running call's retained output, and none once it is done", () => {
    const long = `${"x".repeat(TOOL_LIVE_OUTPUT_BYTES)}END`;
    const live = liveOf(
      {
        run: { taskId: 7 },
        tools: [
          { callId: "a", name: "bash", status: "running", output: "1\n2\n" },
          { callId: "b", name: "bash", status: "running", output: long },
          { callId: "c", name: "bash", status: "done", output: "all of it" },
          { callId: "d", name: "bash", status: "running", output: "" },
        ],
      },
      () => "turn-1",
    );
    expect(live.tools).toEqual([
      { callId: "a", name: "bash", status: "running", output: "1\n2\n" },
      { callId: "b", name: "bash", status: "running", output: long.slice(-TOOL_LIVE_OUTPUT_BYTES) },
      { callId: "c", name: "bash", status: "done" },
      { callId: "d", name: "bash", status: "running" },
    ]);
    expect(live.tools[1]!.output!.endsWith("END")).toBe(true);
  });
});

const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason }) as AssistantMessage;

describe("prompt suggestions", () => {
  const model = { id: "claude-haiku-5-5", provider: "anthropic" } as never;
  const models = (answer: AssistantMessage | Error) => ({
    completeSimple: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  });

  it("asks with t3's prompt, the turn's request and answer only", () => {
    const asked = suggestionContext("fix the build", "Fixed: a missing import.");
    const text = String(asked.messages[0]!.content);
    expect(text).toContain("fix the build");
    expect(text).toContain("Fixed: a missing import.");
    expect(text.endsWith(PROMPT_SUGGESTION_PROMPT)).toBe(true);
    expect(String(suggestionContext("u", "a".repeat(10_000)).messages[0]!.content).length).toBeLessThan(5_000);
  });

  it("is the model's text, unquoted; nothing on an error, a failure, an overlong reply or an empty turn", async () => {
    expect(await suggestPrompt(models(reply('"Now run the tests"')), model, "fix it", "fixed")).toBe("Now run the tests");
    expect(await suggestPrompt(models(reply("")), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(reply("x", "error")), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(new Error("down")), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(reply("y".repeat(400))), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(reply("never asked")), model, "", "fixed")).toBe("");
  });
});
