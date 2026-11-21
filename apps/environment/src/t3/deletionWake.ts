// The deletion wake (ADR-0043 §5): when a project or a thread is deleted in t3, the Workspace Sweep is asked
// to run, so what the deletion left unreferenced is marked within seconds, not up to a day later. It only wakes the
// Sweep (ADR-0043 §5): the Sweep's reference read decides what goes, and nothing else purges.
//
// One subscription: t3's application event stream (`OrchestrationEventStore.streamApplicationEvents`, as t3's
// `KeepAwake` reads it) carries both. Project events are its own (`ApplicationProjectEvent`, `type` at the top), and the
// event sink publishes every committed orchestration event to it too (`EventSink.ts`'s `publishStoredEvents`:
// `eventStore.publishCommitted(events)`), wrapped as `{ sequence, commandId, event }`. Fragility U94.
import type { ApplicationStoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as OrchestrationEventStore from "t3/src/persistence/OrchestrationEventStore.ts";
import * as ServerActivation from "t3/src/serverActivation.ts";

import { environmentServices } from "../agents/bindings.ts";

/** The deletions that wake the Sweep: one project's, and each of its threads' before it (`ProjectService.delete`). */
export const wakesSweep = (stored: ApplicationStoredEvent): boolean =>
  "event" in stored ? stored.event.type === "thread.deleted" : stored.type === "project.deleted";

/**
 * Reads the stream from its latest sequence (what happened before this boot was the daily Sweep's) and calls `wake` for
 * each deletion. A stream error is logged and ends the fork, not t3: the daily Sweep is the backstop.
 */
export const layerDeletionWake = (wake: () => void) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* ServerActivation.forkParked(
        Stream.unwrap(events.latestApplicationSequence.pipe(Effect.map((afterSequence) => events.streamApplicationEvents({ afterSequence })))).pipe(
          Stream.filter(wakesSweep),
          Stream.runForEach(() => Effect.sync(wake)),
          Effect.andThen(Effect.logWarning("t3flare: deletion-wake-stream-ended")),
          Effect.catchCause((cause) => Effect.logWarning("t3flare: deletion-wake-stream-ended", cause)),
        ),
      );
    }),
  );

/** The Layer in the composition: the Environment DO's `wakeSweep`, read at each deletion. */
export const layer = layerDeletionWake(() => environmentServices().wakeSweep());
