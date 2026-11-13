// SPI-1079: an MCP server's questions on a Durable thread, held in memory: shown as a pending `mcp-elicitation` approval
// or a form question, answered by the owner's decision or answers, closed by Stop, the turn's end or the host.
import { describe, expect, it } from "vitest";

import { McpQuestions } from "../src/extensions/mcpQuestions.ts";

const approvalCard = { id: "t3flare-elicit-a", kind: "approval" as const, server: "fixture", title: "fixture asks", prompt: "Delete it?", options: [{ decision: "accept" as const, label: "Approve" }] };
const formCard = { id: "t3flare-elicit-f", kind: "form" as const, server: "fixture", title: "fixture asks", prompt: "Colour?", questions: [{ id: "colour", header: "Colour", question: "Colour?", options: [] }] };

describe("McpQuestions", () => {
  it("an approval card waits as an mcp-elicitation approval and takes the owner's decision", async () => {
    let pushes = 0;
    const questions = new McpQuestions(() => pushes++);
    const answer = questions.asker("turn-1", "call-1", undefined).ask(approvalCard);
    expect(questions.approvals()).toMatchObject([{ requestId: "t3flare-elicit-a", kind: "mcp-elicitation", title: "fixture asks", summary: "Delete it?", turn: "turn-1" }]);
    expect(questions.answer({ requestId: "t3flare-elicit-a", decision: "decline" })).toBe(true);
    expect(await answer).toEqual({ decision: "decline" });
    expect(questions.approvals()).toEqual([]);
    expect(pushes).toBe(2);
  });

  it("a form card waits as a question with its questions and takes the owner's answers", async () => {
    const questions = new McpQuestions(() => undefined);
    const answer = questions.asker("turn-1", "call-1", undefined).ask(formCard);
    expect(questions.questions()).toMatchObject([{ requestId: "t3flare-elicit-f", question: "fixture asks", questions: formCard.questions }]);
    questions.answer({ requestId: "t3flare-elicit-f", decision: "accept", answers: { colour: "red" } });
    expect(await answer).toEqual({ decision: "accept", answers: { colour: "red" } });
  });

  it("Stop, the turn's end and the host's withdrawal close a card as cancelled; no turn asks nothing", async () => {
    const questions = new McpQuestions(() => undefined);
    const stop = new AbortController();
    const stopped = questions.asker("turn-1", "call-1", stop.signal).ask(approvalCard);
    stop.abort();
    expect(await stopped).toMatchObject({ decision: "cancel", reason: "withdrawn" });
    const ended = questions.asker("turn-1", "call-2", undefined).ask(formCard);
    questions.dropAbandoned(new Set());
    expect(await ended).toMatchObject({ decision: "cancel", reason: "the turn ended" });
    const asker = questions.asker("turn-2", "call-3", undefined);
    const withdrawn = asker.ask({ ...approvalCard, id: "t3flare-elicit-w" });
    await asker.withdraw("t3flare-elicit-w");
    expect(await withdrawn).toMatchObject({ decision: "cancel" });
    expect(await questions.asker(null, "call-4", undefined).ask(approvalCard)).toMatchObject({ decision: "cancel" });
    expect(questions.approvals()).toEqual([]);
  });
});
