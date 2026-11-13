// @effect-diagnostics globalDate:off
// The Container budget (step 2a cost guardrails): at most N leases; renewal keeps one; an expired one frees its slot.
// Lease timing runs on a fake clock (FakeClockContainerBudget) that only `advance` moves, so no test sleeps or races a
// real 300 ms lease: a loaded machine cannot expire a lease early or late.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ContainerBudget } from "../src/budget.ts";
import type { FakeClockContainerBudget, SettingContainerBudget } from "./workerd.fixture.ts";

/** The lease length the test Worker configures (T3FLARE_LEASE_MS in vitest.config.ts). */
const LEASE_MS = 300;

const bindings = env as unknown as {
  CONTAINER_BUDGET: DurableObjectNamespace<FakeClockContainerBudget>;
  WALL_CLOCK_BUDGET: DurableObjectNamespace<ContainerBudget>;
  SETTING_BUDGET: DurableObjectNamespace<SettingContainerBudget>;
};
/** A budget without the test override: judged by the Environment settings' budget each request carries (ADR-0032). */
const settingBudget = () => bindings.SETTING_BUDGET.get(bindings.SETTING_BUDGET.newUniqueId());
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

  it("judges each request by the budget it carries, and keeps the last one for status reads", async () => {
    const b = settingBudget();
    expect((await b.state()).max).toBe(3);
    expect((await b.acquire("a", 1)).ok).toBe(true);
    const refused = await b.acquire("b", 1);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("the Container budget is 1");
    expect(refused.ok ? "" : refused.reason).toContain("Environment section");
    expect((await b.state()).max).toBe(1);
    // Raised: the next request starts.
    expect((await b.acquire("b", 2)).ok).toBe(true);
    expect((await b.state()).max).toBe(2);
    // A request carrying no budget (a renewal) is judged by the last one kept.
    expect((await b.acquire("c")).ok).toBe(false);
  });

  it("ignores a carried budget out of bounds, keeping the last valid one", async () => {
    const b = settingBudget();
    await b.acquire("a", 2);
    for (const bad of [0, 11, 2.5, Number.NaN]) await b.acquire("x", bad).catch(() => undefined);
    expect((await b.state()).max).toBe(2);
  });

  it("lowered below the running count, stops nothing: holders renew, new starts are refused until enough stop", async () => {
    const b = settingBudget();
    expect((await b.acquire("a", 2)).ok).toBe(true);
    expect((await b.acquire("b", 2)).ok).toBe(true);
    // Lowered to 1 by a third Workspace's request: refused, and both running leases stay.
    expect((await b.acquire("c", 1)).ok).toBe(false);
    expect((await b.state()).leases.map((lease) => lease.holder)).toEqual(["a", "b"]);
    expect((await b.renew("a")).ok).toBe(true);
    expect((await b.renew("b")).ok).toBe(true);
    expect((await b.acquire("a", 1)).ok).toBe(true);
    await b.release("a");
    // One still runs: at a budget of 1, c waits for it too.
    expect((await b.acquire("c", 1)).ok).toBe(false);
    await b.release("b");
    expect((await b.acquire("c", 1)).ok).toBe(true);
  });

  it("lets T3FLARE_MAX_CONTAINERS win over a carried budget (tests)", async () => {
    // This Worker sets T3FLARE_MAX_CONTAINERS=2 (vitest.config.ts).
    const b = budget();
    expect((await b.acquire("a", 1)).ok).toBe(true);
    expect((await b.acquire("b", 1)).ok).toBe(true);
    expect((await b.acquire("c", 10)).ok).toBe(false);
    expect((await b.state()).max).toBe(2);
  });
});
