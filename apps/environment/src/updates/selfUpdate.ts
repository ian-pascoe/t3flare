// @effect-diagnostics globalDate:off globalDateInEffect:off effectFnOpportunity:off
// The stock client's server Update in the Cloud Environment (ADR-0037; in-app updates plan D2–D7): t3flare's own
// `ServerSelfUpdate` and `ServiceLauncherClient`, which replace t3's in `t3/composition.ts` (ADR-0001: Layer).
//
// - `update` checks the target (`policy.ts`), then dispatches `bump.yml` with `land: true` and the Update gate through
//   the update records (`records.ts`), and answers `respawn` with the record's id. The client then waits for a `ready`
//   whose `updateOutcome` carries that id (t3 `client-runtime/src/state/server.ts` `matchesServerUpdateReadyEvent`).
// - Success: CI lands the bump and deploys prod, the Environment restarts on the new build, and this
//   `ServiceLauncherClient.prepareTrial` (read at startup, `serverRuntimeStartup.ts`) reports the update committed,
//   because the stored target is the stamped Server version.
// - Failure: a fiber in t3's runtime follows the run while the DO is awake (no alarm), and settles the record lazily at
//   boot and at the next press. A failed run's reason and URL go to the client as `ready` again, with its original `at`
//   and a failed `updateOutcome` (ServerLifecycleEvents replays the newest `ready` to every subscriber).
import { ServerSelfUpdateError, type ServerLifecycleStreamEvent, type ServerSelfUpdateOutcome } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ServerSelfUpdate from "t3/src/cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "t3/src/cloud/serviceLauncherClient.ts";
import * as ServerLifecycleEvents from "t3/src/serverLifecycleEvents.ts";
import packageJson from "t3/package.json" with { type: "json" };

import { environmentServices } from "../agents/bindings.ts";
import { type T3Track, t3TrackOf } from "./pins.ts";
import { serverUpdateRefusal, tagOf } from "./policy.ts";
import { NO_UPDATE_TARGET, type UpdateRecord, type Updates } from "./records.ts";

/** How often the fiber reads a run in flight. */
const POLL_INTERVAL = Duration.seconds(20);
/** A failed Update is told again at boot this long: the client waits up to 32 minutes (`SERVER_UPDATE_RESUME_TIMEOUT`). */
export const FAILED_REPLAY_MS = 35 * 60_000;
/** A run that passed while this build is not its target: the deploy's restart has this long to come (plan D11: immediate). */
export const LANDED_GRACE_MS = 5 * 60_000;

/** The workflow a server Update dispatches, and its run's name (plan D9). */
export const SERVER_UPDATE_WORKFLOW = "bump.yml";
export const serverUpdateRunName = (id: string) => `Update ${id}`;

/** The outcome the startup's `ready` carries: committed when the stored target is the version this build runs. */
export const committedOutcome = (record: UpdateRecord | undefined, version: string): ServerSelfUpdateOutcome | undefined =>
  record === undefined || record.target !== version ? undefined : { id: record.id, fromVersion: record.from, targetVersion: record.target, status: "committed" };

/** The failed outcome a settled record tells the client, or undefined when there is none to tell at `now`. */
export const failedOutcome = (record: UpdateRecord | undefined, version: string, now: number): ServerSelfUpdateOutcome | undefined =>
  record?.outcome?.status !== "failed" || record.target === version || now - record.outcome.at > FAILED_REPLAY_MS
    ? undefined
    : { id: record.id, fromVersion: record.from, targetVersion: record.target, status: "failed", reason: record.outcome.reason };

/** `ready` again, as it was, with `outcome`: the client matches it by the outcome's id. */
export const readyWithOutcome = (events: ReadonlyArray<ServerLifecycleStreamEvent>, outcome: ServerSelfUpdateOutcome) => {
  const ready = events.find((event) => event.type === "ready");
  return ready === undefined || ready.type !== "ready" ? undefined : { version: ready.version, type: "ready" as const, payload: { ...ready.payload, updateOutcome: outcome } };
};

/** Declared by the build (build.ts `define`): the t3 track it was made for (ADR-0041). */
declare const __T3FLARE_BUILD__: { readonly t3Track?: string } | undefined;
/** The t3 track this build was made for, or undefined when it names none (an unbundled test). */
const builtTrack = (): T3Track | undefined => t3TrackOf(typeof __T3FLARE_BUILD__ === "undefined" ? undefined : __T3FLARE_BUILD__.t3Track);

/** The records of this Environment (`environmentServices().updates`), or undefined where none are configured. */
const configuredUpdates = (): Updates | undefined => {
  const updates = environmentServices().updates;
  return updates?.configured === true ? updates : undefined;
};

export const make = (options: { readonly version?: string; readonly track?: T3Track; readonly updates?: () => Updates | undefined } = {}) =>
  Effect.gen(function* () {
    const version = options.version ?? packageJson.version;
    const track = options.track ?? builtTrack();
    const updatesOf = options.updates ?? configuredUpdates;
    const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const wake = yield* Queue.unbounded<void>();
    const told = new Set<string>();
    const failWith = (reason: string) => new ServerSelfUpdateError({ reason });

    /** One look at the t3 record; whether it still wants following. */
    const watchOnce = Effect.gen(function* () {
      const updates = updatesOf();
      if (updates === undefined) return false;
      let record = yield* Effect.tryPromise({ try: () => updates.settle("t3"), catch: (cause) => failWith(cause instanceof Error ? cause.message : String(cause)) }).pipe(
        Effect.catch((error) => Effect.logWarning("t3flare: could not read the server Update's run", { reason: error.reason }).pipe(Effect.as(updates.record("t3")))),
      );
      const now = Date.now();
      if (record?.outcome?.status === "succeeded" && record.target !== version && now - record.outcome.at > LANDED_GRACE_MS) {
        record = updates.fail("t3", `The update's run passed, but this Environment still runs t3@${version}. ${record.outcome.reason}`);
      }
      const failed = failedOutcome(record, version, now);
      if (failed !== undefined && !told.has(failed.id)) {
        told.add(failed.id);
        const event = readyWithOutcome((yield* lifecycle.snapshot).events, failed);
        if (event !== undefined) yield* lifecycle.publish(event);
      }
      return record !== undefined && (record.outcome === null || (record.outcome.status === "succeeded" && record.target !== version));
    });

    const follow = Effect.gen(function* () {
      yield* lifecycle.awaitReady;
      for (;;) {
        const busy = yield* watchOnce;
        yield* busy ? Effect.timeoutOption(Queue.take(wake), POLL_INTERVAL) : Queue.take(wake);
      }
    });
    yield* Effect.forkScoped(follow);

    return ServerSelfUpdate.ServerSelfUpdate.of({
      update: (input) =>
        Effect.gen(function* () {
          const updates = updatesOf();
          if (updates === undefined) return yield* failWith(NO_UPDATE_TARGET);
          const refusal = serverUpdateRefusal(input, version, track);
          if (refusal !== undefined) return yield* failWith(refusal);
          const target = input.targetVersion.trim();
          const pressed = yield* Effect.tryPromise({
            try: () =>
              updates.press({
                key: "t3",
                target,
                from: version,
                label: `t3@${target}`,
                workflow: SERVER_UPDATE_WORKFLOW,
                runName: serverUpdateRunName,
                inputs: (id) => ({ tag: tagOf(target), land: "true", gate: "update", update_id: id }),
              }),
            catch: (cause) => failWith(cause instanceof Error ? cause.message : String(cause)),
          });
          yield* Queue.offer(wake, undefined);
          yield* Effect.logInfo("t3flare: server Update dispatched", { updateId: pressed.record.id, target, attached: pressed.attached });
          return { targetVersion: target, method: "respawn" as const, updateId: pressed.record.id };
        }),
      commitDesktopUpdate: () => Effect.fail(failWith("The Cloud Environment has no desktop app to commit an update to.")),
    });
  });

export const layer = Layer.effect(ServerSelfUpdate.ServerSelfUpdate, make());

/**
 * No launcher supervises the Environment. `prepareTrial` reads storage only and never fails: a committed outcome when
 * the stored server Update's target is this build's stamped version, else none.
 */
export const makeLauncherClient = (options: { readonly version?: string; readonly updates?: () => Updates | undefined } = {}) =>
  ServiceLauncherClient.ServiceLauncherClient.of({
    managed: false,
    protocol: undefined,
    requestUpdate: () => Effect.fail(new ServiceLauncherClient.ServiceLauncherClientError({ operation: "unmanaged" })),
    prepareTrial: () =>
      Effect.sync(() => {
        try {
          return committedOutcome((options.updates ?? (() => environmentServices().updates))()?.record("t3"), options.version ?? packageJson.version);
        } catch {
          return undefined;
        }
      }),
  });

export const layerLauncherClient = Layer.sync(ServiceLauncherClient.ServiceLauncherClient, () => makeLauncherClient());
