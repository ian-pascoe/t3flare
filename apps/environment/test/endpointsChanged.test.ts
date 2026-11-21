// A driver's model list follows the Model endpoints at once (SPI-1162 for Pi Durable, SPI-1167 for Codex): each change
// runs its refresh while its scope is open, and none after.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";

import { endpointsChanged, refreshOnEndpointsChanged } from "../src/endpoints/changes.ts";

describe("refreshOnEndpointsChanged", () => {
  it("runs the refresh at each change while the scope is open, and stops with it", async () => {
    let refreshed = 0;
    const scope = Scope.makeUnsafe();
    Effect.runSync(refreshOnEndpointsChanged(Effect.sync(() => void (refreshed += 1))).pipe(Scope.provide(scope)));
    endpointsChanged();
    endpointsChanged();
    await Effect.runPromise(Effect.yieldNow);
    expect(refreshed).toBe(2);
    Effect.runSync(Scope.close(scope, Exit.void));
    endpointsChanged();
    await Effect.runPromise(Effect.yieldNow);
    expect(refreshed).toBe(2);
  });
});
