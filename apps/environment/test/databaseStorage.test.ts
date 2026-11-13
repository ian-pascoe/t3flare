// Parity batch 2: the Storage page's database row from Durable Object storage.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { withDurableObjectSize } from "../src/t3/databaseStorage.ts";

const stock = {
  reclaim: Effect.void,
  status: Stream.make(null),
  requestReclaim: Effect.die("stock repair must not run"),
};

describe("the Storage page's database row", () => {
  it("shows the Durable Object's database size, nothing to reclaim and no repair to run", async () => {
    const service = withDurableObjectSize(stock as never, () => 12_345_678);
    const [first] = await Effect.runPromise(Stream.runCollect(Stream.take(service.status, 1)));
    expect(first).toEqual({
      databaseBytes: 12_345_678,
      reclaimableBytes: 0,
      incrementalVacuumEnabled: true,
      compactCommand: expect.stringMatching(/Not needed/),
      canReclaim: false,
    });
  });

  it("answers a reclaim request with why there is nothing to do", async () => {
    const service = withDurableObjectSize(stock as never, () => 0);
    const error = await Effect.runPromise(Effect.flip(service.requestReclaim));
    expect(error.reason).toMatch(/Durable Object storage/);
  });
});
