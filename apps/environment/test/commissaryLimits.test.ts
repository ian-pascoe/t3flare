// Parity G8 (SPI-999): the Layer over t3's UsageLimitSources adds Commissary's accounts beside t3's own sources.
import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { withCommissary } from "../src/usage/limitSources.ts";
import type { Fetch } from "../src/usage/commissary.ts";

const hub = { id: "hub", kind: "cliproxy", label: "my hub", checkedAt: "2026-11-13T10:00:00.000Z", accounts: [] } as unknown as UsageLimitSourceSnapshot;
const config = { url: "https://c.example", managementKey: "cmsm_x_k_s", principals: [] };

const stock = (refreshed: { count: number }) => ({
  current: Effect.succeed([hub]),
  streamChanges: Stream.make([hub]),
  refresh: Effect.sync(() => {
    refreshed.count += 1;
  }),
  consumeResetCredit: () => Effect.die("stock"),
});

const credentials = {
  files: [
    { id: "a.json", auth_index: "a1", provider: "codex", label: "a", disabled: false, quota_report: { checked_at: "2026-11-13T10:00:00Z", windows: [{ id: "primary", label: "5-hour", used_percent: 10 }] } },
  ],
};

describe("t3's usage-limit sources with Commissary", () => {
  it("lists t3's own sources and then Commissary's accounts, and refreshes both", async () => {
    const refreshed = { count: 0 };
    let reads = 0;
    const fetcher: Fetch = async () => {
      reads += 1;
      return Response.json(credentials);
    };
    const current = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* withCommissary(stock(refreshed), config, fetcher);
          yield* service.refresh;
          return yield* service.current;
        }),
      ),
    );
    expect(current.map((source) => source.id)).toEqual(["hub", "commissary"]);
    expect(current[1]?.accounts.map((account) => [account.id, account.driver, account.usageLimits.windows[0]?.usedPercent])).toEqual([["a1", "codex", 10]]);
    expect(refreshed.count).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(1);
  });

  it("shows a refused read as Commissary's error, and leaves resets to Commissary's panel", async () => {
    const fetcher: Fetch = async () => Response.json({ error: "forbidden" }, { status: 403 });
    const [current, claim] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* withCommissary(stock({ count: 0 }), config, fetcher);
          yield* service.refresh;
          const claim = yield* Effect.flip(service.consumeResetCredit({ sourceId: "commissary", accountId: "a1", creditId: "c" } as never));
          return [yield* service.current, claim] as const;
        }),
      ),
    );
    expect(current[1]?.error).toMatch(/org admin's key/);
    expect(claim.detail).toMatch(/Commissary's panel/);
  });
});
