// The permissions extension on a real pi-durable Harness (step 2a plan, Tests; cloudpid's restart fixture,
// cloudpid@b8097ff0:packages/effect-durable/src/harness.fixture.ts `openRestartingHarness`): a model run through pi-ai's
// faux provider calls `bash`, which waits for the owner's answer. The Harness is restarted as an evicted Durable Object
// is, more times than `restartLimit`, while the call waits: the request survives, the call is not ended, and the answer
// given after the restarts runs the tool once. Also: a decline, the modes, and an unsafe tool cut off after it started.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { InteractionMode, RuntimeMode } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { ApprovalStore, asks, interactionModeSection, permissions, PLAN_MODE_REFUSAL, toToolPath } from "../src/extensions/permissions.ts";

import { context, memoryKv, restartingHarness, textOf, until } from "./harness.fixture.ts";

/** A `bash` that records its runs (not replay-safe, as pi-durable's own). */
const fakeBash = (runs: Array<string>, hold?: Promise<void>) =>
  defineExtension({
    name: "coding-tools",
    tools: [
      defineTool({
        name: "bash",
        description: "run",
        parameters: obj({ command: str() }),
        async execute(args) {
          runs.push(args.command);
          if (hold !== undefined) await hold;
          return { output: [{ type: "text" as const, text: `ran ${args.command}` }] };
        },
      }),
    ],
  });

/** `write` that records the paths it wrote. */
const fakeWrite = (writes: Array<string>) =>
  defineExtension({
    name: "files",
    tools: [
      defineTool({
        name: "write",
        description: "write",
        parameters: obj({ path: str(), content: str() }),
        async execute(args) {
          writes.push(args.path);
          return { output: [{ type: "text" as const, text: `wrote ${args.path}` }] };
        },
      }),
    ],
  });

const callWrite = (path: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("write", { path, content: "x" }, { id: "call-write" })], { stopReason: "toolUse" });

const callBash = (command: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "call-bash" })], { stopReason: "toolUse" });

const setup = (mode: RuntimeMode, interaction: InteractionMode = "default") => {
  const kv = memoryKv();
  let store = new ApprovalStore(kv, () => {});
  return {
    kv,
    store: () => store,
    /** A new instance's store over the same storage (the Session DO's constructor). */
    reopenStore: () => {
      store = new ApprovalStore(kv, () => {});
    },
    extension: permissions({
      get store() {
        return store;
      },
      mode: () => mode,
      interaction: () => interaction,
      turn: () => "turn-1",
      workspaceId: () => "fixture",
    }),
  };
};

describe("permissions", () => {
  it("an approval survives more restarts than restartLimit, and the answer runs the tool once", async () => {
    const runs: Array<string> = [];
    const host = setup("approval-required");
    const harness = await restartingHarness([fakeBash(runs), host.extension], [callBash("bash test.sh"), fauxAssistantMessage("done")]);
    await until(() => host.store().pending().length === 1, "the request");
    const requestId = host.store().pending()[0]!.requestId;
    for (let restart = 0; restart < 8; restart++) {
      host.reopenStore();
      await harness.restart();
      await until(() => host.store().pending().length === 1, `the request after restart ${restart + 1}`);
      expect(host.store().pending()[0]!.requestId).toBe(requestId);
      // The rerun reached its wait again (and marked it as progress) before the next restart.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(runs).toEqual([]);
    expect(host.store().answer(requestId, "accept")).toBe(true);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the tool result");
    const result = await harness.lastToolResult();
    expect(result?.isError).toBe(false);
    expect(textOf(result)).toBe("ran bash test.sh");
    expect(runs).toEqual(["bash test.sh"]);
    expect(host.store().pending()).toEqual([]);
  }, 30_000);

  it("a decline returns the owner's feedback as the tool's error, and nothing runs", async () => {
    const runs: Array<string> = [];
    const host = setup("approval-required");
    const harness = await restartingHarness([fakeBash(runs), host.extension], [callBash("rm -rf build"), fauxAssistantMessage("ok")]);
    await until(() => host.store().pending().length === 1, "the request");
    host.store().answer(host.store().pending()[0]!.requestId, "decline", "not now");
    await until(async () => (await harness.lastToolResult()) !== undefined, "the tool result");
    const result = await harness.lastToolResult();
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("Declined by the owner");
    expect(textOf(result)).toContain("not now");
    expect(runs).toEqual([]);
  });

  it("an unsafe tool cut off after it started is not run again", async () => {
    const runs: Array<string> = [];
    const host = setup("full-access");
    const harness = await restartingHarness([fakeBash(runs, new Promise(() => {})), host.extension], [callBash("make deploy"), fauxAssistantMessage("ok")]);
    await until(() => runs.length === 1, "the first run");
    await harness.restart();
    await until(async () => (await harness.lastToolResult()) !== undefined, "the tool result");
    expect(textOf(await harness.lastToolResult())).toContain("cut off by a restart");
    expect(runs).toEqual(["make deploy"]);
  });

  it("in plan mode a write is refused without asking, and nothing is written", async () => {
    const writes: Array<string> = [];
    const host = setup("full-access", "plan");
    const harness = await restartingHarness([fakeWrite(writes), host.extension], [callWrite("/workspace/repo/a.txt"), fauxAssistantMessage("ok")]);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the tool result");
    const result = await harness.lastToolResult();
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(PLAN_MODE_REFUSAL);
    expect(writes).toEqual([]);
    expect(host.store().pending()).toEqual([]);
  });

  it("in plan mode bash asks even in full access and after the owner accepted commands for the session", async () => {
    const runs: Array<string> = [];
    const host = setup("full-access", "plan");
    void host.store().ask({ requestId: "earlier", turn: "turn-1", callId: "c", tool: "bash", kind: "command", summary: "ls", createdAt: 0 }, async () => {}, context);
    host.store().answer("earlier", "acceptForSession");
    const harness = await restartingHarness([fakeBash(runs), host.extension], [callBash("git status"), fauxAssistantMessage("ok")]);
    await until(() => host.store().pending().length === 1, "the request");
    expect(runs).toEqual([]);
    host.store().answer(host.store().pending()[0]!.requestId, "accept");
    await until(async () => (await harness.lastToolResult()) !== undefined, "the tool result");
    expect(runs).toEqual(["git status"]);
  });

  it("the plan-mode instruction is in the prompt only in plan mode", async () => {
    const render = (mode: InteractionMode) => interactionModeSection(() => mode).sections![0]!.render({} as never, context);
    expect(await render("default")).toBeUndefined();
    expect(await render("plan")).toContain("do not edit files");
  });

  it("accepting for the session covers one MCP tool by name, never bash or another tool, and never a push", () => {
    const store = new ApprovalStore(memoryKv(), () => {});
    const ask = (requestId: string, tool: string, kind: "command" | "mcp-tool" | "git-push") =>
      void store.ask({ requestId, turn: "t", callId: "c", tool, kind, summary: tool, createdAt: 0 }, async () => {}, context);
    ask("1", "mcp__t3-code__delegate_task", "mcp-tool");
    store.answer("1", "acceptForSession");
    expect(store.acceptedFor({ tool: "mcp__t3-code__delegate_task", kind: "mcp-tool" })).toBe(true);
    expect(store.acceptedFor({ tool: "mcp__t3-code__t3_thread_send", kind: "mcp-tool" })).toBe(false);
    expect(store.acceptedFor({ tool: "bash", kind: "command" })).toBe(false);
    ask("2", "bash", "command");
    store.answer("2", "acceptForSession");
    expect(store.acceptedFor({ tool: "bash", kind: "command" })).toBe(true);
    expect(store.acceptedFor({ tool: "mcp__t3-code__t3_thread_send", kind: "mcp-tool" })).toBe(false);
    ask("3", "git push", "git-push");
    store.answer("3", "acceptForSession");
    expect(store.acceptedFor({ tool: "git push", kind: "git-push" })).toBe(false);
  });

  it("the modes, acceptForSession, and the path translation", () => {
    expect(asks("full-access", "command")).toBe(false);
    expect(asks("auto-accept-edits", "file-change")).toBe(false);
    expect(asks("auto-accept-edits", "command")).toBe(true);
    expect(asks("approval-required", "file-change")).toBe(true);
    const store = new ApprovalStore(memoryKv(), () => {});
    void store.ask({ requestId: "1", turn: "t", callId: "c", tool: "bash", kind: "command", summary: "ls", createdAt: 0 }, async () => {}, context);
    expect(store.answer("1", "acceptForSession")).toBe(true);
    expect(store.acceptedFor({ tool: "bash", kind: "command" })).toBe(true);
    expect(store.answer("1", "accept")).toBe(false);
    expect(toToolPath("cat /w/fixture/src/a.txt && ls /w/fixture", "fixture")).toBe("cat /workspace/repo/src/a.txt && ls /workspace/repo");
    expect(toToolPath("/w/fixture-2/x", "fixture")).toBe("/w/fixture-2/x");
  });
});
