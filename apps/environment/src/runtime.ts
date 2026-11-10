// @effect-diagnostics unsafeEffectTypeAssertion:off
// The Environment's Effect runtime: t3's server, booted inside the Environment DO. Loaded with a dynamic
// `import()` from the DO, so t3's modules evaluate on the first request instead of in the Worker's global
// scope (the 1 s startup limit).
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Composition from "./t3/composition.ts";

export interface Runtime {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Runs an effect against the services t3's layer graph built (admin routes and fixtures). */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  readonly context: Context.Context<never>;
  readonly dispose: () => Promise<void>;
  /** Whether this boot seeded t3's bootstrap grant (pairing was armed). */
  readonly bootstrapSeeded: boolean;
}

export const boot = async (options: Composition.CompositionOptions): Promise<Runtime> => {
  const { layer, http } = Composition.make(options);
  const scope = Scope.makeUnsafe();
  // Build the whole layer graph; HttpRouter.serve registers t3's routes on our server.
  const exit = await Effect.runPromiseExit(Layer.buildWithScope(layer, scope));
  if (Exit.isFailure(exit)) {
    await Effect.runPromise(Scope.close(scope, exit));
    throw new Error(`t3 failed to boot:\n${Cause.pretty(exit.cause)}`);
  }
  await http.ready;
  const context = exit.value as Context.Context<never>;
  return {
    fetch: http.handle,
    // The context holds every service t3's graph built; an effect needing one it lacks dies at run time.
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, context as Context.Context<never>) as Effect.Effect<never>),
    context,
    dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    bootstrapSeeded: options.bootstrapToken !== undefined,
  };
};
