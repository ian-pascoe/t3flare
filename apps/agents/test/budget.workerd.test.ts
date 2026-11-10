// @effect-diagnostics globalTimers:off
// The Container budget (step 2a cost guardrails): at most N leases; renewal keeps one; an expired one frees its slot.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ContainerBudget } from "../src/budget.ts";

const budget = () => {
  const namespace = (env as unknown as { CONTAINER_BUDGET: DurableObjectNamespace<ContainerBudget> }).CONTAINER_BUDGET;
  return namespace.get(namespace.newUniqueId());
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    for (let i = 0; i < 4; i++) {
      await sleep(150);
      expect((await b.renew("running")).ok).toBe(true);
    }
    // 600 ms in: "lost" (300 ms lease, never renewed) has expired, so its slot is free; "running" still holds.
    const state = await b.state();
    expect(state.leases.map((lease) => lease.holder)).toEqual(["running"]);
    expect((await b.renew("lost")).ok).toBe(false);
    expect((await b.acquire("next")).ok).toBe(true);
  });
});
