// Who hears that the Model endpoints changed (SPI-1162): the Pi Durable driver and the Codex driver (SPI-1167), which
// build their model lists again at once rather than at their next check. Module state, as the Environment DO is the
// only object in its isolate.
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const listeners = new Set<() => void>();

/** Hear each change; the answer stops hearing. */
export const onEndpointsChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The endpoints changed: tell every listener (a listener that throws never stops the others). */
export const endpointsChanged = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }
};

/** Runs `refresh` at each change while the caller's scope is open (a driver's snapshot: its model list at once). */
export const refreshOnEndpointsChanged = <E, R>(refresh: Effect.Effect<unknown, E, R>): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<R>();
    const stopHearing = onEndpointsChanged(() => void Effect.runForkWith(services)(refresh));
    yield* Effect.addFinalizer(() => Effect.sync(stopHearing));
  });
