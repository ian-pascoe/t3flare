// SPI-1079: an MCP server's questions as t3 cards. The pure plans (`mcp/elicitation.ts`: card kinds, answers back, the
// rules ported from cloudpid ADR-0041), the MCP host's live questions and Executor-style pauses over a fake engine, and
// the Environment's fence on `t3_pending_request`.
import { applyMcpChange, EMPTY_HARNESS } from "@t3flare/harness-registry";
import type { McpAsker, McpQuestionAnswer, McpQuestionCard } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { isPausingServer, pauseOf, planPause, planQuestion, SEND_QUESTION, type QuestionContext } from "../src/mcp/elicitation.ts";
import { McpHost, type McpEngineBinding } from "../src/mcp/host.ts";
import { OWNER_ONLY_REFUSAL, refuseOwnerOnly } from "../src/mcp/ownerOnly.ts";

const context: QuestionContext = { server: "fixture", tool: "fixture_ask", args: { why: "test" }, isOwnHost: (host) => host === "t3.example.com" };
const ask = (params: Record<string, unknown>) => planQuestion({ key: "q1", kind: "elicitation", params: params as never, mode: "live" }, context);

const form = {
  type: "object",
  properties: {
    colour: { type: "string", title: "Colour", enum: ["red", "blue"] },
    note: { type: "string", description: "A note" },
    urgent: { type: "boolean", title: "Urgent" },
    count: { type: "integer", minimum: 1 },
  },
  required: ["colour"],
};

describe("planQuestion", () => {
  it("a form with no fields is an approval card; only accept accepts", () => {
    const plan = ask({ message: "Delete the thing?", requestedSchema: { type: "object", properties: {} } });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card).toMatchObject({ kind: "approval", server: "fixture" });
    expect(plan.card.id).toMatch(/^t3flare-elicit-/);
    expect(plan.card.prompt).toContain("Delete the thing?");
    expect(plan.card.prompt).toContain("fixture_ask");
    expect(plan.card.options?.map((option) => option.decision)).toEqual(["accept", "decline", "cancel"]);
    expect(plan.answerOf({ decision: "accept" }).result).toEqual({ action: "accept" });
    expect(plan.answerOf({ decision: "decline" }).result).toEqual({ action: "decline" });
    expect(plan.answerOf({ decision: "cancel", reason: "no live turn" }).result).toEqual({ action: "cancel" });
  });

  it("a form with fields is a user_input card, one question per field and a Send question; answers are typed", () => {
    const plan = ask({ message: "Tell me more", requestedSchema: form });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.kind).toBe("form");
    const questions = plan.card.questions ?? [];
    expect(questions.map((question) => question.id)).toEqual(["colour", "note", "urgent", "count", SEND_QUESTION]);
    expect(questions[0]?.question).toContain("Tell me more");
    expect(questions[0]?.options.map((option) => option.value)).toEqual(["red", "blue"]);
    expect(questions[2]?.options.map((option) => option.value)).toEqual(["true", "false"]);
    expect(questions[1]?.question).toContain("(optional)");
    const sent = plan.answerOf({ decision: "accept", answers: { colour: "blue", note: "hi", urgent: "true", count: "3", [SEND_QUESTION]: "send" } });
    expect(sent.result).toEqual({ action: "accept", content: { colour: "blue", note: "hi", urgent: true, count: 3 } });
    expect(plan.answerOf({ decision: "accept", answers: { colour: "blue", [SEND_QUESTION]: "decline" } }).result).toEqual({ action: "decline" });
    const wrong = plan.answerOf({ decision: "accept", answers: { colour: "green", [SEND_QUESTION]: "send" } });
    expect(wrong.result.action).toBe("cancel");
    expect(wrong.note).toContain("colour");
    expect(plan.answerOf({ decision: "cancel", reason: "the turn ended" }).result).toEqual({ action: "cancel" });
  });

  it("a form that asks for a credential is declined unseen; a malformed one is refused", () => {
    const secret = ask({ message: "Log in", requestedSchema: { type: "object", properties: { user: { type: "string" }, api_key: { type: "string" } } } });
    expect(secret).toMatchObject({ kind: "now", answer: { kind: "answered", result: { action: "decline" } } });
    const bad = ask({ message: "?", requestedSchema: { type: "object", properties: { x: { $ref: "#/y" } } } });
    expect(bad).toMatchObject({ kind: "now", answer: { kind: "refused" } });
    expect(planQuestion({ key: "s", kind: "sampling", params: {}, mode: "live" }, context)).toMatchObject({ kind: "now", answer: { kind: "refused" } });
  });

  it("a page is an approval card showing its link; http, private and own-host pages are declined unseen", () => {
    const plan = ask({ mode: "url", message: "Connect your account", url: "https://auth.example.org/connect?x=1", elicitationId: "e1" });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.kind).toBe("approval");
    expect(plan.card.prompt).toContain("https://auth.example.org/connect?x=1");
    expect(plan.card.options?.[0]).toEqual({ decision: "accept", label: "Opened it" });
    expect(plan.answerOf({ decision: "accept" }).result).toEqual({ action: "accept" });
    for (const url of ["http://auth.example.org/", "https://127.0.0.1/", "https://printer.local/", "https://t3.example.com/_t3flare/harness"]) {
      expect(ask({ mode: "url", message: "x", url, elicitationId: "e" })).toMatchObject({ kind: "now", answer: { kind: "answered", result: { action: "decline" } } });
    }
  });
});

const pause = (status: "approval-required" | "input-required", schema: unknown = { type: "object", properties: {} }) => ({
  content: [{ type: "text", text: JSON.stringify({ status, requestId: "apr_1" }) }],
  structuredContent: {
    status,
    requestId: "apr_1",
    elicitation: { mode: "form", message: "Approve mac-bridge.messages_send?", requestedSchema: schema, _meta: { app: "mac-bridge", tool: "messages_send", args: { to: "me" } } },
    expiresAt: "2026-11-13T12:00:00Z",
  },
});

describe("Executor-style pauses", () => {
  it("recognises model mode's resume and its pauses, not browser mode's", () => {
    expect(isPausingServer({ resume: { inputSchema: { type: "object", properties: { requestId: {}, response: {} } } } })).toBe(true);
    expect(isPausingServer({ resume: { inputSchema: { type: "object", properties: { requestId: {} } } } })).toBe(false);
    expect(pauseOf(pause("approval-required"))).toMatchObject({ status: "approval-required", requestId: "apr_1" });
    expect(pauseOf({ structuredContent: { status: "user_approval_required", executionId: "x" } })).toBeUndefined();
  });

  it("an approval's card shows Executor's own text and the agent's call; only accept accepts", () => {
    const plan = planPause(pauseOf(pause("approval-required"))!, { ...context, tool: "call" });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.kind).toBe("approval");
    expect(plan.card.prompt).toContain("Approve mac-bridge.messages_send?");
    expect(plan.card.prompt).toContain('"tool": "messages_send"');
    expect(plan.card.prompt).toContain("The agent's call: fixture: call");
    expect(plan.card.prompt).not.toContain("apr_1");
    expect(plan.answerOf({ decision: "accept" }).result).toEqual({ action: "accept" });
    expect(plan.answerOf({ decision: "decline" }).result).toEqual({ action: "decline" });
  });
});

const memory = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
};

const tool = (name: string, properties: Record<string, unknown> = {}, readOnlyHint?: boolean) => ({ name, description: name, inputSchema: { type: "object", properties }, ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }) });

/** A host over a direct server `fixture` whose engine answers with `respond` (given the request and the hooks). */
const hostOver = async (tools: Array<Record<string, unknown>>, respond: (request: any, hooks: any) => Promise<unknown>) => {
  const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } });
  if (!added.ok) throw new Error(added.error);
  const requests: Array<any> = [];
  const engine: McpEngineBinding = {
    discover: async () => ({ kind: "discovered", era: "legacy", protocolVersion: "2025-06-18", capabilities: { tools: {} }, tools, prompts: [], problems: [], fetchedAt: 0, state: {} }) as never,
    request: async (_target, _prior, request, hooks) => {
      requests.push(request);
      return { kind: "complete", result: { kind: "inline", value: await respond(request, hooks) }, cacheable: false, fetchedAt: 0, state: {} } as never;
    },
  };
  const host = new McpHost({ kv: memory(), engine, commissary: { url: undefined, key: undefined }, settings: () => added.harness, now: () => 1, ownHost: () => "t3.example.com" });
  await host.list("fixture");
  return { host, requests };
};

const askerAnswering = (answer: (card: McpQuestionCard) => McpQuestionAnswer) => {
  const cards: Array<McpQuestionCard> = [];
  const withdrawn: Array<string> = [];
  const asker: McpAsker = {
    ask: async (card) => {
      cards.push(card);
      return answer(card);
    },
    withdraw: (id) => void withdrawn.push(id),
  };
  return { asker, cards, withdrawn };
};

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("McpHost questions", () => {
  it("an agent's call declares elicitation, and the server's question is answered from the owner's card", async () => {
    const { host, requests } = await hostOver([tool("fixture_ask")], async (_request, hooks) => {
      const answer = await hooks.onInput({ key: "k", kind: "elicitation", params: { message: "Colour?", requestedSchema: form }, mode: "live", era: "legacy" });
      return text(JSON.stringify(answer));
    });
    const owner = askerAnswering(() => ({ decision: "accept", answers: { colour: "red", [SEND_QUESTION]: "send" } }));
    const answer = await host.call({ server: "fixture", tool: "fixture_ask", args: {}, judged: "write", asker: owner.asker });
    expect(requests[0].ctx).toMatchObject({ origin: "agent", answers: { elicitation: true } });
    expect(owner.cards).toHaveLength(1);
    expect(answer).toMatchObject({ kind: "result" });
    expect(JSON.parse((answer as { text: string }).text)).toEqual({ kind: "answered", result: { action: "accept", content: { colour: "red" } } });
  });

  it("without an asker nothing is declared", async () => {
    const { host, requests } = await hostOver([tool("fixture_echo", {}, true)], async () => text("ok"));
    await host.call({ server: "fixture", tool: "fixture_echo", args: {}, judged: "read" });
    expect(requests[0].ctx).toEqual({ origin: "agent" });
  });

  const executorTools = [tool("call", { calls: {} }), tool("execute", { code: {} }), tool("resume", { requestId: {}, response: {} }, true)];

  it("a pausing server's resume is hidden from agents and refused when called", async () => {
    const { host, requests } = await hostOver(executorTools, async () => text("never"));
    const view = await host.view();
    expect(view.servers.find((server) => server.name === "fixture")?.tools.map((t) => t.upstream)).toEqual(["call", "execute"]);
    const answer = await host.call({ server: "fixture", tool: "resume", args: { requestId: "apr_1", response: { action: "accept" } }, judged: "read" });
    expect(answer).toMatchObject({ kind: "unavailable", mayHaveRun: false });
    expect(requests).toHaveLength(0);
  });

  it("an approval pause is resumed with accept only after the owner accepts; the agent never sees the requestId", async () => {
    const { host, requests } = await hostOver(executorTools, async (request) =>
      request.tool.name === "call" ? pause("approval-required") : text(`resumed with ${JSON.stringify(request.arguments.response)}`),
    );
    const owner = askerAnswering(() => ({ decision: "accept" }));
    const answer = await host.call({ server: "fixture", tool: "call", args: { calls: { path: "tools.mac-bridge.messages_send" } }, judged: "write", asker: owner.asker });
    expect(owner.cards[0]?.prompt).toContain("Approve mac-bridge.messages_send?");
    expect(owner.cards[0]?.prompt).toContain("tools.mac-bridge.messages_send");
    expect(requests.map((request) => request.tool.name)).toEqual(["call", "resume"]);
    expect(requests[1].arguments).toEqual({ requestId: "apr_1", response: { action: "accept" } });
    expect(answer).toEqual({ kind: "result", isError: false, text: 'resumed with {"action":"accept"}' });
  });

  it("a declined pause is sent Executor's decline, never an accept; an unanswered one is sent cancel", async () => {
    for (const [decision, action] of [["decline", "decline"], ["cancel", "cancel"]] as const) {
      const { host, requests } = await hostOver(executorTools, async (request) => (request.tool.name === "call" ? pause("approval-required") : text("declined")));
      const owner = askerAnswering(() => ({ decision }));
      await host.call({ server: "fixture", tool: "call", args: {}, judged: "write", asker: owner.asker });
      expect(requests[1].arguments).toEqual({ requestId: "apr_1", response: { action } });
    }
  });

  it("an expired outcome that still carries the requestId reaches the agent without it", async () => {
    const { host } = await hostOver(executorTools, async (request) =>
      request.tool.name === "call" ? pause("approval-required") : { content: [{ type: "text", text: '{"requestId":"apr_1"}' }], structuredContent: { status: "unavailable", requestId: "apr_1", message: "Request apr_1 expired." }, isError: true },
    );
    const owner = askerAnswering(() => ({ decision: "accept" }));
    const answer = await host.call({ server: "fixture", tool: "call", args: {}, judged: "write", asker: owner.asker });
    expect(answer).toEqual({ kind: "result", isError: true, text: "Request [request] expired." });
  });
});

describe("refuseOwnerOnly", () => {
  const call = (args: Record<string, unknown>, id: unknown = 7) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "t3_pending_request", arguments: args } });

  it("refuses read and respond on an MCP question's card, and nothing else", () => {
    const refused = refuseOwnerOnly(call({ action: "respond", requestId: "runtime-request:codex:t3flare-ask:t3flare-elicit-1", answers: { a: "b" } }));
    expect(JSON.parse(refused!)).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: OWNER_ONLY_REFUSAL }], isError: true } });
    expect(refuseOwnerOnly(call({ action: "read", requestId: "runtime-request:piDurable:thread:x:approval:t3flare-elicit-2" }))).toBeDefined();
    expect(refuseOwnerOnly(call({ action: "list" }))).toBeUndefined();
    expect(refuseOwnerOnly(call({ action: "respond", requestId: "runtime-request:piDurable:thread:x:approval:task-9" }))).toBeUndefined();
    expect(refuseOwnerOnly("not json")).toBeUndefined();
    const batch = refuseOwnerOnly(`[${call({ action: "respond", requestId: "t3flare-elicit-3" }, 1)},${call({ action: "list" }, 2)}]`);
    expect(JSON.parse(batch!).map((answer: { id: number }) => answer.id)).toEqual([1, 2]);
  });
});
