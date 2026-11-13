// @effect-diagnostics globalDate:off
// A pi-durable Harness on pi-ai's faux provider, restarted as an evicted Durable Object is (cloudpid's restart fixture,
// cloudpid@b8097ff0:packages/effect-durable/src/harness.fixture.ts `openRestartingHarness`), shared by the extension tests.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type Extension, Harness, MemoryStorage, type Storage, ToolResultEntry } from "@earendil-works/pi-durable";

import type { ApprovalStorage } from "../src/extensions/permissions.ts";

export const context = BACKGROUND_CONTEXT;

export const memoryKv = (): ApprovalStorage => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

/**
 * Opens `kv` once per instance, as a Durable Object's constructor gets its storage: each open cuts the view the previous
 * instance holds, which then throws, as an evicted Durable Object's storage does. A store reopened for a restarted
 * Harness must take a new view: on a shared, uncut one, the old instance's calls, aborted when it notices it was cut off
 * (mid-resume), settle their requests after the new instance's reruns asked again, withdrawing the card the reruns wait
 * on (SPI-1087).
 */
export const instanceKv = (kv: ApprovalStorage): (() => ApprovalStorage) => {
  let cut = () => {};
  return () => {
    cut();
    let live = true;
    cut = () => {
      live = false;
    };
    const guard = () => {
      if (!live) throw new Error("cut off");
    };
    return {
      get: <T>(key: string) => (guard(), kv.get<T>(key)),
      put: <T>(key: string, value: T) => (guard(), kv.put(key, value)),
      delete: (key: string) => (guard(), kv.delete(key)),
    };
  };
};

/** Polls `check` until it holds, for up to 90 s of wall time (CI runners resume a restarted Harness much slower). */
export const until = async (check: () => boolean | Promise<boolean>, what: string, withinMs = 90_000): Promise<void> => {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A Harness restarted as an evicted Durable Object is: the old instance cut off from storage, a new one resumed. */
export const restartingHarness = async (extensions: ReadonlyArray<Extension>, responses: ReadonlyArray<AssistantMessage>) => {
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
    /** The root conversation's entries, newest first, as their messages' roles and texts. */
    messages: async () => {
      const conversation = await current.conversation(root.id, context);
      const page = await conversation?.entries({}, 50, undefined, context);
      return (page?.items ?? []).flatMap((item) => (item.model ?? []).map((message) => ({ role: message.role, text: typeof message.content === "string" ? message.content : textOf(message as never) })));
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

export const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> } | undefined) =>
  (result?.content ?? []).map((block) => block.text ?? "").join("");

