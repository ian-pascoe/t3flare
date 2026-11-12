// The `mcp` extension's seam (ADR-0028, plan §3.1/§3.3, H4's Durable half): MCP tools on a real Harness, called directly
// and from a code mode script. Reads run; an owner's write asks unless full access and may be accepted for the session;
// plan mode refuses writes; a linked thread's every write asks, each call alone, in full access too; a write cut off by
// a restart after it was sent is never sent again.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { InteractionMode, RuntimeMode } from "@t3flare/session-protocol";
import { afterAll, describe, expect, it } from "vitest";

import { codemodeExtension } from "../src/extensions/codemode.ts";
import { mcpExtension, mcpNamespaces, type McpView } from "../src/extensions/mcp.ts";
import { ApprovalStore } from "../src/extensions/permissions.ts";

import { memoryKv, restartingHarness, textOf, until } from "./harness.fixture.ts";

const sandboxes: Array<CodemodeSandbox> = [];
afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
});

const VIEW: McpView = {
  version: "v1",
  servers: [
    {
      name: "commissary",
      kind: "commissary",
      state: "available",
      listedAt: 1,
      exposure: "deferred",
      tools: [
        { name: "mcp__commissary__fixture_echo", upstream: "fixture_echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, class: "read", exposure: "direct" },
        { name: "mcp__commissary__fixture_note", upstream: "fixture_note", description: "note", inputSchema: { type: "object", properties: { line: { type: "string" } } }, class: "write", exposure: "direct" },
      ],
    },
  ],
};

const call = (tool: string, args: Record<string, string>, id: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: "toolUse" });

const setup = async (mode: RuntimeMode, responses: ReadonlyArray<AssistantMessage>, options: { linked?: boolean; interaction?: InteractionMode; hold?: Promise<void> } = {}) => {
  const kv = memoryKv();
  const store = new ApprovalStore(kv, () => {});
  const sent: Array<string> = [];
  const sandbox = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY });
  sandboxes.push(sandbox);
  const harness = await restartingHarness(
    [
      mcpExtension(VIEW, {
        store,
        mode: () => mode,
        interaction: () => options.interaction ?? "default",
        turn: () => "turn-1",
        linked: () => options.linked === true,
        call: async (input) => {
          sent.push(`${input.tool} ${JSON.stringify(input.args)}`);
          if (options.hold !== undefined) await options.hold;
          return { kind: "result", isError: false, text: `${input.tool} ok` };
        },
      }),
      codemodeExtension(sandbox, { inlineBudget: 2000, namespaces: mcpNamespaces(VIEW) }),
    ],
    responses,
  );
  return { store, sent, harness, result: async () => (await until(async () => (await harness.lastToolResult()) !== undefined, "a result"), harness.lastToolResult()) };
};

const note = (id: string, line = "x") => call("mcp__commissary__fixture_note", { line }, id);

describe("mcp extension", () => {
  it("a read runs without a card in every mode, plan included", async () => {
    const run = await setup("approval-required", [call("mcp__commissary__fixture_echo", { text: "hi" }, "c1"), fauxAssistantMessage("done")], { interaction: "plan" });
    expect(textOf(await run.result())).toBe("fixture_echo ok");
    expect(run.store.pending()).toEqual([]);
  });

  it("plan mode refuses a write; nothing is sent", async () => {
    const run = await setup("full-access", [note("c1"), fauxAssistantMessage("done")], { interaction: "plan" });
    expect(textOf(await run.result())).toContain("plan mode");
    expect(run.sent).toEqual([]);
  });

  it("an owner's write asks with its arguments on the card, and an acceptance for the session covers the next call", async () => {
    const run = await setup("approval-required", [note("c1", "first"), note("c2", "second"), fauxAssistantMessage("done")]);
    await until(() => run.store.pending().length === 1, "the card");
    const card = run.store.pending()[0]!;
    expect(card).toMatchObject({ kind: "mcp-tool", tool: "mcp__commissary__fixture_note" });
    expect(card.summary).toContain('"line": "first"');
    expect(card.perCall).toBeUndefined();
    run.store.answer(card.requestId, "acceptForSession");
    await until(() => run.sent.length === 2, "both writes");
    expect(run.store.pending()).toEqual([]);
  });

  it("full access runs an owner's write without a card", async () => {
    const run = await setup("full-access", [note("c1"), fauxAssistantMessage("done")]);
    expect(textOf(await run.result())).toBe("fixture_note ok");
    expect(run.store.pending()).toEqual([]);
  });

  it("a linked thread's every write asks, in full access, and an acceptance for the session counts once", async () => {
    const run = await setup("full-access", [note("c1"), note("c2"), fauxAssistantMessage("done")], { linked: true });
    await until(() => run.store.pending().length === 1, "the first card");
    const first = run.store.pending()[0]!;
    expect(first.perCall).toBe(true);
    run.store.answer(first.requestId, "acceptForSession");
    await until(() => run.store.pending().length === 1 && run.store.pending()[0]!.requestId !== first.requestId, "a second card");
    run.store.answer(run.store.pending()[0]!.requestId, "decline");
    await until(async () => run.sent.length === 1 && (await run.harness.lastToolResult()) !== undefined, "the turn");
    expect(run.sent).toHaveLength(1);
  });

  it("a linked thread's writes from a script each ask, three cards for three calls", async () => {
    const code = `await Promise.all([1, 2, 3].map((n) => tools.mcp__commissary__fixture_note({ line: "n" + n }))); text("done");`;
    const run = await setup("full-access", [call("codemode", { code }, "cm"), fauxAssistantMessage("done")], { linked: true });
    await until(() => run.store.pending().length === 3, "three cards");
    expect(run.store.pending().every((card) => card.perCall === true && card.via?.parentCallId === "cm")).toBe(true);
    for (const card of run.store.pending()) run.store.answer(card.requestId, "decline");
    expect(textOf(await run.result())).toContain("Declined");
    expect(run.sent).toEqual([]);
  });

  it("a write cut off by a restart after it was sent is not sent again", async () => {
    const run = await setup("full-access", [note("c1"), fauxAssistantMessage("done")], { hold: new Promise(() => {}) });
    await until(() => run.sent.length === 1, "the send");
    await run.harness.restart();
    expect(textOf(await run.result())).toContain("cut off by a restart");
    expect(run.sent).toHaveLength(1);
  });
});
