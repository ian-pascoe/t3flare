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

export const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let tries = 0; tries < 2000; tries++) {
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

