// Code mode's nested calls are judged exactly like direct ones (plan §2.3, one test per row): a script on pi-codemode's
// real QuickJS VM (the Node sandbox; the Session uses the remote one, same host side) calls the guarded tools through
// pi-durable's nested calls, on a real Harness on pi-ai's faux provider, restarted as an evicted Durable Object is.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import type { InteractionMode, RuntimeMode } from "@t3flare/session-protocol";
import { afterAll, describe, expect, it } from "vitest";

import { codemodeExtension } from "../src/extensions/codemode.ts";
import { ApprovalStore, PLAN_MODE_REFUSAL, permissions } from "../src/extensions/permissions.ts";

import { memoryKv, restartingHarness, textOf, until } from "./harness.fixture.ts";

const sandboxes: Array<CodemodeSandbox> = [];
afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
});

/** `bash`, `write` and `edit` that record what ran (not replay-safe, as pi-durable's own). */
const fakeTools = (ran: Array<string>, hold?: Promise<void>) =>
  defineExtension({
    name: "coding-tools",
    tools: [
      defineTool({
        name: "bash",
        description: "run",
        parameters: obj({ command: str() }),
        async execute(args) {
          ran.push(`bash ${args.command}`);
          if (hold !== undefined) await hold;
          return { output: [{ type: "text" as const, text: `ran ${args.command}` }] };
        },
      }),
      defineTool({
        name: "write",
        description: "write",
        parameters: obj({ path: str(), content: str() }),
        async execute(args) {
          ran.push(`write ${args.path}`);
          return { output: [{ type: "text" as const, text: `wrote ${args.path}` }] };
        },
      }),
      defineTool({
        name: "edit",
        description: "edit",
        parameters: obj({ path: str(), edits: arr(obj({ oldText: str(), newText: str() })) }),
        async execute(args) {
          ran.push(`edit ${args.path}`);
          return { output: [{ type: "text" as const, text: `edited ${args.path}` }] };
        },
      }),
    ],
  });

const script = (code: string, id = "call-cm"): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" });

const direct = (command: string, id: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

/** A script that reports each call's outcome, so a refusal and a run are both visible in its output. */
const reporting = (calls: string) => `
const out = [];
for (const [name, call] of ${calls}) {
  try { const r = await call(); out.push(name + ": " + (typeof r === "string" ? r : JSON.stringify(r))); }
  catch (e) { out.push(name + " threw: " + e.message); }
}
text(out.join("\\n"));`;

const setup = async (
  mode: RuntimeMode,
  responses: ReadonlyArray<AssistantMessage>,
  options: { interaction?: InteractionMode; hold?: Promise<void>; beforeCommand?: () => Promise<void> } = {},
) => {
  const kv = memoryKv();
  let store = new ApprovalStore(kv, () => {});
  const ran: Array<string> = [];
  const sandbox = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY });
  sandboxes.push(sandbox);
  const harness = await restartingHarness(
    [
      fakeTools(ran, options.hold),
      permissions({
        get store() {
          return store;
        },
        mode: () => mode,
        interaction: () => options.interaction ?? "default",
        turn: () => "turn-1",
        workspaceId: () => "fixture",
        ...(options.beforeCommand === undefined ? {} : { beforeCommand: options.beforeCommand }),
      }),
      codemodeExtension(sandbox, { inlineBudget: 2000 }),
    ],
    responses,
  );
  return {
    ran,
    harness,
    store: () => store,
    reopen: () => {
      store = new ApprovalStore(kv, () => {});
    },
    result: async () => {
      await until(async () => (await harness.lastToolResult()) !== undefined, "the script's result");
      return harness.lastToolResult();
    },
  };
};

describe("code mode: nested calls are judged like direct ones", () => {
  it("plan mode: a script's write and edit are refused, nothing changes, and its command asks even in full access", async () => {
    const run = await setup(
      "full-access",
      [
        script(
          reporting(`[["write", () => tools.write({ path: "/workspace/repo/a", content: "x" })], ["edit", () => tools.edit({ path: "/workspace/repo/a", edits: [{ oldText: "a", newText: "b" }] })], ["bash", () => tools.bash({ command: "echo x > f" })]]`),
        ),
        fauxAssistantMessage("done"),
      ],
      { interaction: "plan" },
    );
    await until(() => run.store().pending().length === 1, "the command's card");
    const card = run.store().pending()[0]!;
    expect(card.tool).toBe("bash");
    expect(card.callId.startsWith("call-cm/")).toBe(true);
    expect(card.via?.script).toContain("tools.write");
    run.store().answer(card.requestId, "decline");
    const output = textOf(await run.result());
    expect(output).toContain(`write threw: ${PLAN_MODE_REFUSAL}`);
    expect(output).toContain(`edit threw: ${PLAN_MODE_REFUSAL}`);
    expect(output).toContain("bash threw: Declined by the owner");
    expect(run.ran).toEqual([]);
  }, 30_000);

  // Hangs on GitHub Actions runners (possible restart race, SPI-1087); passes locally and on stage (m0-p5-restart).
  it.skipIf(process.env.CI)("approval-required: a nested command asks, survives restarts with one card, and runs once when approved", async () => {
    const run = await setup("approval-required", [script(`text(await tools.bash({ command: "rm -rf build" }))`), fauxAssistantMessage("done")]);
    await until(() => run.store().pending().length === 1, "the card");
    const requestId = run.store().pending()[0]!.requestId;
    for (let restart = 0; restart < 3; restart++) {
      run.reopen();
      await run.harness.restart();
      await until(() => run.store().pending().length === 1, `the card after restart ${restart + 1}`);
      expect(run.store().pending()[0]!.requestId).toBe(requestId);
      // Let the resumed run reach its wait again before the next restart (the card is in storage throughout).
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(run.ran).toEqual([]);
    run.store().answer(requestId, "accept");
    expect(textOf(await run.result())).toContain("ran rm -rf build");
    expect(run.ran).toEqual(["bash rm -rf build"]);
  }, 120_000);

  it("auto-accept-edits: a nested edit runs without a card, a nested command asks", async () => {
    const run = await setup("auto-accept-edits", [
      script(reporting(`[["edit", () => tools.edit({ path: "/workspace/repo/a", edits: [{ oldText: "a", newText: "b" }] })], ["bash", () => tools.bash({ command: "make" })]]`)),
      fauxAssistantMessage("done"),
    ]);
    await until(() => run.store().pending().length === 1, "the command's card");
    expect(run.ran).toEqual(["edit /workspace/repo/a"]);
    expect(run.store().pending()[0]!.kind).toBe("command");
    run.store().answer(run.store().pending()[0]!.requestId, "accept");
    expect(textOf(await run.result())).toContain("bash: ran make");
    expect(run.ran).toEqual(["edit /workspace/repo/a", "bash make"]);
  }, 30_000);

  it("full access: a nested command runs without a card", async () => {
    const run = await setup("full-access", [script(`text(await tools.bash({ command: "ls" }))`), fauxAssistantMessage("done")]);
    expect(textOf(await run.result())).toContain("ran ls");
    expect(run.store().pending()).toEqual([]);
  }, 30_000);

  it("accept for the session on a script's card covers a later direct command (the same key)", async () => {
    const run = await setup("approval-required", [script(`text(await tools.bash({ command: "one" }))`), direct("two", "call-direct"), fauxAssistantMessage("done")]);
    await until(() => run.store().pending().length === 1, "the script's card");
    run.store().answer(run.store().pending()[0]!.requestId, "acceptForSession");
    await until(() => run.ran.length === 2, "both commands");
    expect(run.ran).toEqual(["bash one", "bash two"]);
    expect(run.store().pending()).toEqual([]);
  }, 30_000);

  it("a script reaching bash by every lookup it has still asks (ALL_TOOLS, tools[name], a stored name)", async () => {
    const run = await setup("approval-required", [
      script(`
        const viaAll = ALL_TOOLS.find((t) => t.name === "bash");
        store("n", "bash");
        const name = load("n");
        await Promise.all([tools["bash"]({ command: "a" }), tools[name]({ command: "b" }), tools[viaAll.name]({ command: "c" })]);
        text("all ran");`),
      fauxAssistantMessage("done"),
    ]);
    await until(() => run.store().pending().length === 3, "three cards");
    expect(run.ran).toEqual([]);
    for (const card of run.store().pending()) run.store().answer(card.requestId, "accept");
    expect(textOf(await run.result())).toContain("all ran");
    expect(run.ran.toSorted()).toEqual(["bash a", "bash b", "bash c"]);
  }, 30_000);

  it("a linked thread's nested commands each note linked work before they run, and a failing note runs nothing", async () => {
    const notes: Array<number> = [];
    let fail = false;
    const run = await setup("full-access", [script(reporting(`[["one", () => tools.bash({ command: "one" })], ["two", () => tools.bash({ command: "two" })]]`)), fauxAssistantMessage("done")], {
      beforeCommand: async () => {
        notes.push(notes.length);
        if (fail) throw new Error("the Workspace refused the note");
        fail = true;
      },
    });
    const output = textOf(await run.result());
    expect(notes).toHaveLength(2);
    expect(output).toContain("one: ran one");
    expect(output).toContain("two threw: the Workspace refused the note");
    expect(run.ran).toEqual(["bash one"]);
  }, 30_000);

  it("a script's concurrent asks wait their turn past 8 pending (review M8), and every one is asked", async () => {
    const run = await setup("approval-required", [
      script(`await Promise.all(Array.from({ length: 12 }, (_, i) => tools.bash({ command: "n" + i }))); text("done");`),
      fauxAssistantMessage("done"),
    ]);
    await until(() => run.store().pending().length === 8, "eight cards");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run.store().pending()).toHaveLength(8);
    let answered = 0;
    while (answered < 12) {
      await until(() => run.store().pending().length > 0, "a card");
      expect(run.store().pending().length).toBeLessThanOrEqual(8);
      run.store().answer(run.store().pending()[0]!.requestId, "accept");
      answered++;
    }
    expect(textOf(await run.result())).toContain("done");
    expect(run.ran).toHaveLength(12);
  }, 120_000);
});
