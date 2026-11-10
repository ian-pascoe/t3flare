// The permissions extension on a real pi-durable Harness (step 2a plan, Tests; cloudpid's restart fixture,
// cloudpid@b8097ff0:packages/effect-durable/src/harness.fixture.ts `openRestartingHarness`): a model run through pi-ai's
// faux provider calls `bash`, which waits for the owner's answer. The Harness is restarted as an evicted Durable Object
// is, more times than `restartLimit`, while the call waits: the request survives, the call is not ended, and the answer
// given after the restarts runs the tool once. Also: a decline, the modes, and an unsafe tool cut off after it started.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Extension, Harness, MemoryStorage, type Storage, ToolResultEntry } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { RuntimeMode } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { ApprovalStore, type ApprovalStorage, asks, permissions, toToolPath } from "../src/extensions/permissions.ts";

const context = BACKGROUND_CONTEXT;

const memoryKv = (): ApprovalStorage => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let tries = 0; tries < 2000; tries++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

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

const callBash = (command: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "call-bash" })], { stopReason: "toolUse" });

/** A Harness restarted as an evicted Durable Object is: the old instance cut off from storage, a new one resumed. */
const restartingHarness = async (extensions: ReadonlyArray<Extension>, responses: ReadonlyArray<AssistantMessage>) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const memory = new MemoryStorage();
  let cut = () => {};
  const connect = (): Storage => {
    let live = true;
    cut = () => {
      live = false;
    };
    return new Proxy(memory, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          if (!live) throw new Error("cut off");
          return (value as (...rest: Array<unknown>) => unknown).apply(target, args);
        };
      },
    });
  };
  const open = () => Harness.open(connect(), { models, registry, settings: { restartLimit: 5 } }, context);
  let current = await open();
  const root = await current.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await root.submit({ type: "input", content: "go" }, context);
  current.resume();
  return {
    restart: async () => {
      cut();
      current = await open();
      current.resume();
    },
    lastToolResult: async () => {
      const conversation = await current.conversation(root.id, context);
      const page = await conversation?.entries({}, 50, undefined, context);
      const entry = page?.items.find((item) => ToolResultEntry.is(item));
      const message = entry?.model?.[0];
      return message?.role === "toolResult" ? message : undefined;
    },
  };
};

const setup = (mode: RuntimeMode) => {
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
      turn: () => "turn-1",
      workspaceId: () => "fixture",
    }),
  };
};

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> } | undefined) =>
  (result?.content ?? []).map((block) => block.text ?? "").join("");

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

  it("the modes, acceptForSession, and the path translation", () => {
    expect(asks("full-access", "command")).toBe(false);
    expect(asks("auto-accept-edits", "file-change")).toBe(false);
    expect(asks("auto-accept-edits", "command")).toBe(true);
    expect(asks("approval-required", "file-change")).toBe(true);
    const store = new ApprovalStore(memoryKv(), () => {});
    void store.ask({ requestId: "1", turn: "t", callId: "c", tool: "bash", kind: "command", summary: "ls", createdAt: 0 }, async () => {}, context);
    expect(store.answer("1", "acceptForSession")).toBe(true);
    expect(store.acceptedKinds().has("command")).toBe(true);
    expect(store.answer("1", "accept")).toBe(false);
    expect(toToolPath("cat /w/fixture/src/a.txt && ls /w/fixture", "fixture")).toBe("cat /workspace/repo/src/a.txt && ls /workspace/repo");
    expect(toToolPath("/w/fixture-2/x", "fixture")).toBe("/w/fixture-2/x");
  });
});
