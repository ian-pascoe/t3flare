// @effect-diagnostics globalFetch:off
// Parity G8 (SPI-999): a Layer over t3's `UsageLimitSources` (ADR-0001: Layer first). t3's own sources, from the
// owner's settings, stay as they are; with Commissary's management API configured (`commissary.ts`), Commissary's
// accounts are one more source, read when t3 refreshes its sources and every few minutes while t3 runs. Without it,
// this Layer is t3's.
import { UsageLimitSourceError, type UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as UsageLimitSources from "t3/src/usage/UsageLimitSources.ts";

import { COMMISSARY_SOURCE_ID, CommissaryError, type CommissaryManagement, type Fetch, limitSnapshot, readCredentials } from "./commissary.ts";

/** How often Commissary's accounts are read while t3 runs (Commissary's own quota sweep is slower). */
export const COMMISSARY_LIMITS_EVERY = Duration.minutes(5);

const combine = (stock: ReadonlyArray<UsageLimitSourceSnapshot>, ours: UsageLimitSourceSnapshot | undefined) =>
  ours === undefined ? stock : [...stock.filter((source) => source.id !== ours.id), ours];

/** t3's service with Commissary's accounts added as a source. */
export const withCommissary = Effect.fn("withCommissary")(function* (
  stock: UsageLimitSources.UsageLimitSources["Service"],
  config: CommissaryManagement,
  fetcher: Fetch,
) {
  const ours = yield* SubscriptionRef.make<UsageLimitSourceSnapshot | undefined>(undefined);
  const readOurs = Effect.gen(function* () {
    const read = yield* Effect.tryPromise({
      try: () => readCredentials(fetcher, config),
      catch: (cause) => (cause instanceof CommissaryError ? cause.message : "Commissary's management API could not be read."),
    }).pipe(
      Effect.map((list) => ({ list })),
      Effect.catch((error) => Effect.succeed({ error })),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.set(ours, limitSnapshot(checkedAt, read));
  });
  yield* readOurs.pipe(Effect.forkScoped);
  yield* Effect.sleep(COMMISSARY_LIMITS_EVERY).pipe(Effect.andThen(readOurs), Effect.forever, Effect.forkScoped);

  return {
    current: Effect.zipWith(stock.current, SubscriptionRef.get(ours), combine),
    get streamChanges() {
      return Stream.zipLatestWith(stock.streamChanges, SubscriptionRef.changes(ours), combine).pipe(Stream.changes);
    },
    refresh: Effect.all([stock.refresh, readOurs], { concurrency: "unbounded", discard: true }),
    consumeResetCredit: (input) =>
      input.sourceId === COMMISSARY_SOURCE_ID
        ? Effect.fail(new UsageLimitSourceError({ detail: "Claim this account's reset in Commissary's panel (Accounts)." }))
        : stock.consumeResetCredit(input),
  } satisfies UsageLimitSources.UsageLimitSources["Service"];
});

/**
 * t3's `UsageLimitSources.layer`, plus Commissary's accounts when `config()` answers (read once, at t3's boot, from the
 * Environment DO's bindings).
 */
export const layer = (config: () => CommissaryManagement | undefined, fetcher: Fetch = (input, init) => fetch(input, init)) =>
  Layer.effect(
    UsageLimitSources.UsageLimitSources,
    Effect.gen(function* () {
      const stock = yield* UsageLimitSources.UsageLimitSources;
      const configured = config();
      return configured === undefined ? stock : yield* withCommissary(stock, configured, fetcher);
    }),
  ).pipe(Layer.provide(UsageLimitSources.layer));
