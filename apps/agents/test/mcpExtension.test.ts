// The `mcp` extension's seam (ADR-0028, plan §3.1/§3.3): MCP tools on a real Harness, called directly and from a code
// mode script. Reads run; a write asks unless full access and may be accepted for the session; plan mode refuses
// writes; a write cut off by a restart after it was sent is never sent again. Linked threads follow their own mode
// (owner, 2026-11-12, back to stock).
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
      kind: "direct",
      state: "available",
      listedAt: 1,
      exposure: "deferred",
      tools: [
        { name: "mcp__commissary__fixture_echo", upstream: "fixture_echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, hash: "h-echo", class: "read", exposure: "direct" },
        { name: "mcp__commissary__fixture_note", upstream: "fixture_note", description: "note", inputSchema: { type: "object", properties: { line: { type: "string" } } }, hash: "h-note", class: "write", exposure: "direct" },
      ],
    },
    {
      name: "settings",
      kind: "settings",
      state: "available",
      listedAt: 1,
      exposure: "deferred",
      tools: [
        { name: "mcp__settings__change_environment", upstream: "change_environment", description: "change", inputSchema: { type: "object", properties: {} }, hash: "h-env", class: "write", exposure: "direct" },
      ],
    },
  ],
};

const call = (tool: string, args: Record<string, string>, id: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: "toolUse" });

const setup = async (mode: RuntimeMode, responses: ReadonlyArray<AssistantMessage>, options: { interaction?: InteractionMode; hold?: Promise<void> } = {}) => {
  const kv = memoryKv();
  const store = new ApprovalStore(kv, () => {});
  const sent: Array<string> = [];
  const askers: Array<boolean> = [];
  const sandbox = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY });
  sandboxes.push(sandbox);
  const harness = await restartingHarness(
    [
      mcpExtension(VIEW, {
        store,
        mode: () => mode,
        interaction: () => options.interaction ?? "default",
        turn: () => "turn-1",
        asker: () => ({ ask: async () => ({ decision: "cancel" as const }), withdraw: () => undefined }),
        call: async (input) => {
          sent.push(`${input.tool} ${JSON.stringify(input.args)}`);
          askers.push(input.asker !== undefined);
          if (options.hold !== undefined) await options.hold;
          return { kind: "result", isError: false, text: `${input.tool} ok` };
        },
      }),
      codemodeExtension(sandbox, { inlineBudget: 2000, namespaces: mcpNamespaces(VIEW) }),
    ],
    responses,
  );
  return { store, sent, askers, harness, result: async () => (await until(async () => (await harness.lastToolResult()) !== undefined, "a result"), harness.lastToolResult()) };
};

const note = (id: string, line = "x") => call("mcp__commissary__fixture_note", { line }, id);

describe("mcp extension", () => {
  it("a read runs without a card in every mode, plan included", async () => {
    const run = await setup("approval-required", [call("mcp__commissary__fixture_echo", { text: "hi" }, "c1"), fauxAssistantMessage("done")], { interaction: "plan" });
    expect(textOf(await run.result())).toBe("fixture_echo ok");
    expect(run.store.pending()).toEqual([]);
    // SPI-1079: every call carries the Session's asker, so the server's questions reach the owner as cards.
    expect(run.askers).toEqual([true]);
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
    run.store.answer(card.requestId, "acceptForSession");
    await until(() => run.sent.length === 2, "both writes");
    expect(run.store.pending()).toEqual([]);
    // The acceptance covers that definition only: a changed definition (hash) asks again (review H3).
    expect(run.store.acceptedFor({ tool: "mcp__commissary__fixture_note", kind: "mcp-tool", definition: "h-note" })).toBe(true);
    expect(run.store.acceptedFor({ tool: "mcp__commissary__fixture_note", kind: "mcp-tool", definition: "h-changed" })).toBe(false);
  });

  it("full access runs an owner's write without a card", async () => {
    const run = await setup("full-access", [note("c1"), fauxAssistantMessage("done")]);
    expect(textOf(await run.result())).toBe("fixture_note ok");
    expect(run.store.pending()).toEqual([]);
  });

  it("writes from a script each ask, three cards for three calls, each declined", async () => {
    const code = `await Promise.all([1, 2, 3].map((n) => tools.mcp__commissary__fixture_note({ line: "n" + n }))); text("done");`;
    const run = await setup("approval-required", [call("codemode", { code }, "cm"), fauxAssistantMessage("done")]);
    await until(() => run.store.pending().length === 3, "three cards");
    expect(run.store.pending().every((card) => card.via?.parentCallId === "cm")).toBe(true);
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

  // T-own (plan §5, D7), M3 (SPI-1198): the Settings server judges its own writes with one card of its own, so this tool
  // keeps only plan mode's refusal for it and raises no card; a script's nested call is judged as a direct one.
  const settingsWrite = (id: string) => call("mcp__settings__change_environment", { line: "x" }, id);

  it("a Settings server write outside plan mode raises no card of the Session's: it goes to the server", async () => {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      const run = await setup(mode, [settingsWrite("s1"), fauxAssistantMessage("done")]);
      expect(textOf(await run.result())).toBe("change_environment ok");
      expect(run.store.pending()).toEqual([]);
      expect(run.askers).toEqual([true]);
    }
  });

  it("plan mode still refuses a Settings server write, directly and from a script", async () => {
    const direct = await setup("full-access", [settingsWrite("s1"), fauxAssistantMessage("done")], { interaction: "plan" });
    expect(textOf(await direct.result())).toContain("plan mode");
    expect(direct.sent).toEqual([]);
    const code = `const r = await tools.mcp__settings__change_environment({ line: "x" }); text(JSON.stringify(r));`;
    const scripted = await setup("full-access", [call("codemode", { code }, "cm"), fauxAssistantMessage("done")], { interaction: "plan" });
    expect(textOf(await scripted.result())).toContain("plan mode");
    expect(scripted.sent).toEqual([]);
  });

  it("a script's Settings server write is passed through as a direct one is, with no card", async () => {
    const code = `await tools.mcp__settings__change_environment({ line: "x" }); text("done");`;
    const run = await setup("approval-required", [call("codemode", { code }, "cm"), fauxAssistantMessage("done")]);
    await until(() => run.sent.length === 1, "the call");
    expect(run.store.pending()).toEqual([]);
  });
});
