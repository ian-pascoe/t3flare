// @effect-diagnostics globalDate:off
// A Layer over t3's `UsageLimitSources` (ADR-0001: Layer first; parity G8, U84). t3's own sources, from the owner's
// settings, stay as they are.
//
// SPI-1174: each subscription endpoint whose answers report limit windows is one more source (`limits.ts`), from the
// readings the Environment DO keeps: pushed a few seconds after readings are kept (a burst once), and looked at again
// every minute, so a stale meter says when it was last read and a window past its reset shows reset.
import { UsageLimitSourceError, type UsageLimitSourceSnapshot } from "@t3tools/contracts";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as UsageLimitSources from "t3/src/usage/UsageLimitSources.ts";

import { LIMIT_SOURCE_PREFIX, limitSnapshots } from "./limitMeters.ts";
import type { LimitStore } from "./limits.ts";

/** How often the endpoints' meters are looked at again (staleness and passed resets) while t3 runs. */
export const ENDPOINT_METERS_EVERY = Duration.minutes(1);
/**
 * The most often kept readings are pushed to t3's clients: a CLI turn's many requests each send one, so the readings of a
 * burst are pushed once, this long after its first (the trailing edge, with the latest of them).
 */
export const ENDPOINT_METERS_PUSH_EVERY = Duration.seconds(3);

type Service = UsageLimitSources.UsageLimitSources["Service"];

/** Sources of ours beside t3's: their current snapshots, how to read them again, and which ids are theirs. */
export interface ExtraSources {
  readonly ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<UsageLimitSourceSnapshot>>;
  readonly refresh: Effect.Effect<void>;
  readonly owns: (sourceId: string) => boolean;
  /** Why a reset credit cannot be claimed here. */
  readonly noReset: string;
}

const combine = (stock: ReadonlyArray<UsageLimitSourceSnapshot>, ours: ReadonlyArray<UsageLimitSourceSnapshot>) => {
  const mine = new Set(ours.map((source) => source.id));
  return [...stock.filter((source) => !mine.has(source.id)), ...ours];
};

/** t3's service with `extras` added after its own sources, in order. */
export const withSources = (stock: Service, extras: ReadonlyArray<ExtraSources>): Service => {
  if (extras.length === 0) return stock;
  const [first, ...rest] = extras.map((extra) => SubscriptionRef.changes(extra.ref));
  const ours = rest.reduce((all, next) => Stream.zipLatestWith(all, next, (left, right) => left.concat(right)), first!);
  return {
    current: Effect.zipWith(
      stock.current,
      Effect.forEach(extras, (extra) => SubscriptionRef.get(extra.ref)),
      (sources, mine) => combine(sources, mine.flat()),
    ),
    get streamChanges() {
      return Stream.zipLatestWith(stock.streamChanges, ours, combine).pipe(Stream.changes);
    },
    refresh: Effect.all([stock.refresh, ...extras.map((extra) => extra.refresh)], { concurrency: "unbounded", discard: true }),
    consumeResetCredit: (input) => {
      const owner = extras.find((extra) => extra.owns(input.sourceId));
      return owner === undefined ? stock.consumeResetCredit(input) : Effect.fail(new UsageLimitSourceError({ detail: owner.noReset }));
    },
  } satisfies Service;
};

/** What the endpoints' meters read: the kept windows (and word of each new one), and the endpoints now. */
export interface EndpointMetersDeps {
  readonly store: Pick<LimitStore, "read" | "subscribe">;
  readonly endpoints: () => ModelEndpoints;
  readonly now: () => number;
  /** `ENDPOINT_METERS_EVERY` and `ENDPOINT_METERS_PUSH_EVERY` unless given (tests). */
  readonly every?: Duration.Input;
  readonly pushEvery?: Duration.Input;
}

/**
 * One source per subscription endpoint with limit readings (SPI-1174): built now, again after the store keeps readings
 * (at most once per `ENDPOINT_METERS_PUSH_EVERY`), every `ENDPOINT_METERS_EVERY`, and on t3's refresh. Only a changed
 * list is published.
 */
export const endpointMeterSources = Effect.fn("endpointMeterSources")(function* (deps: EndpointMetersDeps) {
  let shown = "";
  /** The sources now, and whether they differ from those last shown. */
  const build = (): { readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>; readonly changed: boolean } => {
    let sources: ReadonlyArray<UsageLimitSourceSnapshot>;
    try {
      sources = limitSnapshots(deps.store.read(), deps.endpoints(), deps.now());
    } catch {
      // An unreadable store shows no meters rather than failing t3's sources.
      sources = [];
    }
    const key = JSON.stringify(sources);
    const changed = key !== shown;
    shown = key;
    return { sources, changed };
  };
  const ref = yield* SubscriptionRef.make(build().sources);
  const update = Effect.suspend(() => {
    const next = build();
    return next.changed ? SubscriptionRef.set(ref, next.sources) : Effect.void;
  });
  // The store calls back synchronously inside `recordLimits`, marking the meters due (a one-place queue: marks while
  // one waits are dropped). A scoped fiber pushes a burst once, `pushEvery` after its first mark, with what is kept then;
  // a mark made while that push builds makes the next. The fiber and the subscription end with the scope.
  const due = yield* Queue.dropping<void>(1);
  yield* Queue.take(due).pipe(Effect.andThen(Effect.sleep(deps.pushEvery ?? ENDPOINT_METERS_PUSH_EVERY)), Effect.andThen(update), Effect.forever, Effect.forkScoped);
  yield* Effect.acquireRelease(
    Effect.sync(() => deps.store.subscribe(() => void Queue.offerUnsafe(due, undefined))),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Effect.sleep(deps.every ?? ENDPOINT_METERS_EVERY).pipe(Effect.andThen(update), Effect.forever, Effect.forkScoped);
  return {
    ref,
    refresh: update,
    owns: (sourceId) => sourceId.startsWith(LIMIT_SOURCE_PREFIX),
    noReset: "This meter is read from the endpoint's answers: claim a reset with the vendor.",
  } satisfies ExtraSources;
});

/** t3's `UsageLimitSources.layer`, plus the endpoints' meters when `meters()` answers (read once, at t3's boot). */
export const layer = (meters: () => Omit<EndpointMetersDeps, "now"> | undefined = () => undefined) =>
  Layer.effect(
    UsageLimitSources.UsageLimitSources,
    Effect.gen(function* () {
      const stock = yield* UsageLimitSources.UsageLimitSources;
      const endpointMeters = meters();
      const extras: Array<ExtraSources> = [];
      if (endpointMeters !== undefined) extras.push(yield* endpointMeterSources({ ...endpointMeters, now: () => Date.now() }));
      return withSources(stock, extras);
    }),
  ).pipe(Layer.provide(UsageLimitSources.layer));
