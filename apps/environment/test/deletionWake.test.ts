// The deletion wake's Layer (ADR-0043 §5): t3's application event stream, read from its latest sequence, wakes
// the Sweep for `project.deleted` and `thread.deleted` and for nothing else. A stream error is logged and ends the fork.
import type { ApplicationStoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as OrchestrationEventStore from "t3/src/persistence/OrchestrationEventStore.ts";
import { describe, expect, it, vi } from "vitest";

import { layerDeletionWake, wakesSweep } from "../src/t3/deletionWake.ts";

// The events carry only the fields `wakesSweep` reads, not a whole stored event.
const projectEvent = (type: "project.created" | "project.meta-updated" | "project.deleted", sequence: number) =>
  ({ sequence, type, aggregateKind: "project", aggregateId: "p1" }) as unknown as ApplicationStoredEvent;
const threadEvent = (type: string, sequence: number) =>
  ({ sequence, commandId: null, event: { type, threadId: "t1" } }) as unknown as ApplicationStoredEvent;

/** A fake event store: the cursor, and the events after it, then the stream's end (or its failure). */
const fakeStore = (latest: number, events: ReadonlyArray<ApplicationStoredEvent>, fail = false) => {
  const asked: Array<number | undefined> = [];
  // The two methods the Layer calls, not the whole event store.
  const service = {
    latestApplicationSequence: Effect.succeed(latest),
    streamApplicationEvents: (input?: { readonly afterSequence?: number }) => {
      asked.push(input?.afterSequence);
      const stream = Stream.fromIterable(events);
      return fail ? Stream.concat(stream, Stream.fail(new Error("the store went away"))) : stream;
    },
  } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"];
  return { asked, layer: Layer.succeed(OrchestrationEventStore.OrchestrationEventStore, service) };
};

/** Builds the Layer over the fake store, lets its fork drain the stream, and returns what it logged. */
const runLayer = async (store: ReturnType<typeof fakeStore>, wake: () => void) => {
  const logged: Array<Logger.Options<unknown>> = [];
  await Effect.runPromise(
    Effect.scoped(Layer.build(layerDeletionWake(wake).pipe(Layer.provide(store.layer))).pipe(Effect.andThen(Effect.sleep("20 millis")))).pipe(
      Effect.provide(Logger.layer([Logger.make((entry) => void logged.push(entry))], { mergeWithExisting: false })),
    ),
  );
  return logged;
};

describe("wakesSweep", () => {
  it("is true for a project's and a thread's deletion only", () => {
    expect(wakesSweep(projectEvent("project.deleted", 1))).toBe(true);
    expect(wakesSweep(threadEvent("thread.deleted", 2))).toBe(true);
    expect(wakesSweep(projectEvent("project.created", 3))).toBe(false);
    expect(wakesSweep(projectEvent("project.meta-updated", 3))).toBe(false);
    for (const type of ["thread.archived", "thread.created", "run.created", "provider-session.updated"]) {
      expect(wakesSweep(threadEvent(type, 4))).toBe(false);
    }
  });
});

describe("layerDeletionWake", () => {
  it("wakes the Sweep once per deletion, from the latest sequence", async () => {
    const store = fakeStore(41, [
      projectEvent("project.created", 42),
      threadEvent("thread.created", 43),
      threadEvent("thread.deleted", 44),
      threadEvent("thread.archived", 45),
      threadEvent("thread.deleted", 46),
      projectEvent("project.deleted", 47),
    ]);
    const wake = vi.fn();
    await runLayer(store, wake);
    expect(store.asked).toEqual([41]);
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it("logs a stream error and ends the fork, without failing the Layer", async () => {
    const store = fakeStore(0, [threadEvent("thread.deleted", 1), threadEvent("thread.deleted", 3)], true);
    const wake = vi.fn();
    const logged = await runLayer(store, wake);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(store.asked).toEqual([0]);
    expect(logged.map((entry) => [entry.logLevel, String(entry.message)])).toEqual([["Warn", expect.stringContaining("deletion-wake-stream-ended")]]);
    expect(Logger.formatLogFmt.log(logged[0]!)).toContain("the store went away");
  });
});
