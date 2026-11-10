// The Environment's Effect runtime: t3's server, booted inside the Environment DO.
// Loaded with a dynamic `import()` from the DO, so t3's modules evaluate on the first
// request instead of in the Worker's global scope (the 1 s startup limit).
import type { DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Composition from "./t3/composition.ts";

export interface Runtime {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
  readonly bootMs: number;
}

export const boot = async (options: Composition.CompositionOptions): Promise<Runtime> => {
  const started = performance.now();
  const { layer, http } = Composition.make(options);
  const scope = Scope.makeUnsafe();
  // Build the whole layer graph; HttpRouter.serve registers t3's routes on our server.
  const exit = await Effect.runPromiseExit(Layer.buildWithScope(layer, scope));
  if (Exit.isFailure(exit)) {
    await Effect.runPromise(Scope.close(scope, exit));
    throw new Error(`t3 failed to boot:\n${Cause.pretty(exit.cause)}`);
  }
  await http.ready;
  return {
    fetch: http.handle,
    dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    bootMs: performance.now() - started,
  };
};

export type { DurableObjectStorage };
