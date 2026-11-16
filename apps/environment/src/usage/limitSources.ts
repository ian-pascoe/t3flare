// @effect-diagnostics globalFetch:off globalDate:off
// Parity G8 (SPI-999): a Layer over t3's `UsageLimitSources` (ADR-0001: Layer first). t3's own sources, from the
// owner's settings, stay as they are; with Commissary's management API configured (`commissary.ts`), Commissary's
// accounts are one more source, read when t3 refreshes its sources and every few minutes while t3 runs.
//
// SPI-1174: each subscription endpoint whose answers report limit windows is one more source (`limits.ts`), from the
// readings the Environment DO keeps: shown at once when a reading is kept, and looked at again every minute, so a stale
// meter says when it was last read and a window past its reset shows reset.
import { UsageLimitSourceError, type UsageLimitSourceSnapshot } from "@t3tools/contracts";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as UsageLimitSources from "t3/src/usage/UsageLimitSources.ts";

import { COMMISSARY_SOURCE_ID, CommissaryError, type CommissaryManagement, type Fetch, limitSnapshot, readCredentials } from "./commissary.ts";
import { LIMIT_SOURCE_PREFIX, type LimitStore, limitSnapshots } from "./limits.ts";

/** How often Commissary's accounts are read while t3 runs (Commissary's own quota sweep is slower). */
export const COMMISSARY_LIMITS_EVERY = Duration.minutes(5);
/** How often the endpoints' meters are looked at again (staleness and passed resets) while t3 runs. */
export const ENDPOINT_METERS_EVERY = Duration.minutes(1);

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

/** Commissary's accounts as one source, read now, every `COMMISSARY_LIMITS_EVERY` and on t3's refresh. */
export const commissarySources = Effect.fn("commissarySources")(function* (config: CommissaryManagement, fetcher: Fetch) {
  const ref = yield* SubscriptionRef.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const readOurs = Effect.gen(function* () {
    const read = yield* Effect.tryPromise({
      try: () => readCredentials(fetcher, config),
      catch: (cause) => (cause instanceof CommissaryError ? cause.message : "Commissary's management API could not be read."),
    }).pipe(
      Effect.map((list) => ({ list })),
      Effect.catch((error) => Effect.succeed({ error })),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.set(ref, [limitSnapshot(checkedAt, read)]);
  });
  yield* readOurs.pipe(Effect.forkScoped);
  yield* Effect.sleep(COMMISSARY_LIMITS_EVERY).pipe(Effect.andThen(readOurs), Effect.forever, Effect.forkScoped);
  return {
    ref,
    refresh: readOurs,
    owns: (sourceId) => sourceId === COMMISSARY_SOURCE_ID,
    noReset: "Claim this account's reset in Commissary's panel (Accounts).",
  } satisfies ExtraSources;
});

/** t3's service with Commissary's accounts added as a source. */
export const withCommissary = Effect.fn("withCommissary")(function* (stock: Service, config: CommissaryManagement, fetcher: Fetch) {
  return withSources(stock, [yield* commissarySources(config, fetcher)]);
});

/** What the endpoints' meters read: the kept windows (and word of each new one), and the endpoints now. */
export interface EndpointMetersDeps {
  readonly store: Pick<LimitStore, "read" | "subscribe">;
  readonly endpoints: () => ModelEndpoints;
  readonly now: () => number;
}

/**
 * One source per subscription endpoint with limit readings (SPI-1174): built now, again whenever the store keeps a
 * reading, every `ENDPOINT_METERS_EVERY`, and on t3's refresh. Only a changed list is published.
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
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // A kept reading shows at once: the store calls back synchronously inside `recordLimits`.
  yield* Effect.acquireRelease(
    Effect.sync(() => deps.store.subscribe(() => void runFork(update))),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Effect.sleep(ENDPOINT_METERS_EVERY).pipe(Effect.andThen(update), Effect.forever, Effect.forkScoped);
  return {
    ref,
    refresh: update,
    owns: (sourceId) => sourceId.startsWith(LIMIT_SOURCE_PREFIX),
    noReset: "This meter is read from the endpoint's answers: claim a reset with the vendor.",
  } satisfies ExtraSources;
});

/**
 * t3's `UsageLimitSources.layer`, plus Commissary's accounts when `config()` answers (read once, at t3's boot, from the
 * Environment DO's bindings), plus the endpoints' meters when `meters()` answers.
 */
export const layer = (
  config: () => CommissaryManagement | undefined,
  meters: () => Omit<EndpointMetersDeps, "now"> | undefined = () => undefined,
  fetcher: Fetch = (input, init) => fetch(input, init),
) =>
  Layer.effect(
    UsageLimitSources.UsageLimitSources,
    Effect.gen(function* () {
      const stock = yield* UsageLimitSources.UsageLimitSources;
      const configured = config();
      const endpointMeters = meters();
      const extras: Array<ExtraSources> = [];
      if (configured !== undefined) extras.push(yield* commissarySources(configured, fetcher));
      if (endpointMeters !== undefined) extras.push(yield* endpointMeterSources({ ...endpointMeters, now: () => Date.now() }));
      return withSources(stock, extras);
    }),
  ).pipe(Layer.provide(UsageLimitSources.layer));
