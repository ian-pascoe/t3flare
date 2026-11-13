// G6 (SPI-997, SPI-987): t3's own command policy takes the Durable agent's fork natively, from a specific turn, and
// admits its rollback (which must return a snapshot), as it does for t3's Pi adapter.
import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CommandPolicy from "t3/src/orchestration-v2/CommandPolicy.ts";
import { describe, expect, it } from "vitest";

import { PiDurableCapabilities } from "../src/provider/capabilities.ts";

const policy = Effect.runPromise(
  Effect.gen(function* () {
    return yield* CommandPolicy.CommandPolicyV2;
  }).pipe(Effect.provide(CommandPolicy.layer)),
);

const ids = { commandId: CommandId.make("command-1"), threadId: ThreadId.make("thread-1"), providerInstanceId: ProviderInstanceId.make("piDurable") };

describe("t3's command policy for the Durable agent (G6)", () => {
  it("forks natively from a completed turn of an idle source", async () => {
    const { decideForkExecution } = await policy;
    const decision = await Effect.runPromise(
      decideForkExecution({
        ...ids,
        capabilities: PiDurableCapabilities,
        sameProvider: true,
        hasStrongNativeSource: true,
        sourceRunStatus: "completed",
        fromSpecificTurn: true,
        sourceBusy: false,
      }),
    );
    expect(decision).toBe("native_fork");
  });

  it("hands a busy source's fork its portable context", async () => {
    const { decideForkExecution } = await policy;
    const decision = await Effect.runPromise(
      decideForkExecution({
        ...ids,
        capabilities: PiDurableCapabilities,
        sameProvider: true,
        hasStrongNativeSource: true,
        sourceRunStatus: "completed",
        fromSpecificTurn: true,
        sourceBusy: true,
      }),
    );
    expect(decision).toBe("portable_context");
  });

  it("admits a rollback", async () => {
    const { ensureRollback, ensureNativeFork } = await policy;
    await Effect.runPromise(ensureRollback({ ...ids, capabilities: PiDurableCapabilities }));
    await Effect.runPromise(ensureNativeFork({ ...ids, capabilities: PiDurableCapabilities, fromSpecificTurn: true }));
  });
});
