// @effect-diagnostics globalDate:off
// The Container budget (step 2a cost guardrails): at most N leases; renewal keeps one; an expired one frees its slot.
// Lease timing runs on a fake clock (FakeClockContainerBudget) that only `advance` moves, so no test sleeps or races a
// real 300 ms lease: a loaded machine cannot expire a lease early or late.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ContainerBudget } from "../src/budget.ts";
import type { FakeClockContainerBudget } from "./workerd.fixture.ts";

/** The lease length the test Worker configures (T3FLARE_LEASE_MS in vitest.config.ts). */
const LEASE_MS = 300;

const bindings = env as unknown as {
  CONTAINER_BUDGET: DurableObjectNamespace<FakeClockContainerBudget>;
  WALL_CLOCK_BUDGET: DurableObjectNamespace<ContainerBudget>;
};
const budget = () => bindings.CONTAINER_BUDGET.get(bindings.CONTAINER_BUDGET.newUniqueId());

describe("ContainerBudget", () => {
  it("refuses a start past the limit, and frees a slot at release", async () => {
    const b = budget();
    expect((await b.acquire("a")).ok).toBe(true);
    expect((await b.acquire("b")).ok).toBe(true);
    const refused = await b.acquire("c");
    expect(refused.ok).toBe(false);
    // A holder renewing its own lease is never refused.
    expect((await b.acquire("a")).ok).toBe(true);
    await b.release("a");
    expect((await b.acquire("c")).ok).toBe(true);
  });

  it("keeps a renewed lease past its first expiry, and frees a lease that is not renewed", async () => {
    const b = budget();
    await b.acquire("running");
    await b.acquire("lost");
    // Four renewals every 150 ms: 600 ms in, twice the lease.
    for (let i = 0; i < 4; i++) {
      await b.advance(LEASE_MS / 2);
      expect((await b.renew("running")).ok).toBe(true);
    }
    // "lost" (never renewed) has expired, so its slot is free; "running" still holds.
    const state = await b.state();
    expect(state.leases.map((lease) => lease.holder)).toEqual(["running"]);
    expect((await b.renew("lost")).ok).toBe(false);
    expect((await b.acquire("next")).ok).toBe(true);
  });

  it("expires a lease exactly LEASE_MS after its last renewal, not before", async () => {
    const b = budget();
    expect((await b.acquire("a")).ok).toBe(true);
    await b.advance(LEASE_MS - 1);
    expect((await b.state()).leases.map((l) => l.holder)).toEqual(["a"]);
    await b.advance(1);
    expect((await b.state()).leases).toEqual([]);
  });

  it("judges leases by the wall clock by default", async () => {
    const b = bindings.WALL_CLOCK_BUDGET.get(bindings.WALL_CLOCK_BUDGET.newUniqueId());
    const before = Date.now();
    const lease = await b.acquire("a");
    // Only a lower bound: the lease runs at least LEASE_MS from a moment no earlier than `before`, however slow the call.
    expect(lease.ok && lease.until >= before + LEASE_MS).toBe(true);
  });
});
