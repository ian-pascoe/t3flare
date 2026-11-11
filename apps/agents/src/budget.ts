// @effect-diagnostics globalDate:off
// The Container budget (step 2a plan, cost guardrails): at most MAX_CONTAINERS Containers run at once across the
// deploy. `max_instances` does not apply under `schedulingPolicy: "durable_object"`, so a singleton DO leases the slots.
// A Workspace DO takes a lease before it starts its Container, renews it from its alarm while the Container runs, and
// releases it when the Container stops. A lease expires LEASE_MS after its last renewal, so a lost release frees its
// slot within that time and a running Container never loses its slot while it is renewed.
import { DurableObject } from "cloudflare:workers";

export const MAX_CONTAINERS = 3;
export const LEASE_MS = 10 * 60_000;
export const RENEW_EVERY_MS = 5 * 60_000;

/** The one budget object of a deploy. */
export const BUDGET_NAME = "budget";

interface Lease {
  readonly holder: string;
  readonly until: number;
}

export type LeaseAnswer =
  | { readonly ok: true; readonly until: number; readonly running: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string; readonly running: ReadonlyArray<string> };

export interface BudgetEnv {
  /** Overrides MAX_CONTAINERS (tests). */
  readonly T3FLARE_MAX_CONTAINERS?: string;
  /** Overrides LEASE_MS (tests). */
  readonly T3FLARE_LEASE_MS?: string;
}

export class ContainerBudget extends DurableObject<BudgetEnv> {
  /** The clock every lease is judged by; a field, not a method, so it is not part of the RPC surface. Tests swap it. */
  protected readonly now: () => number = () => Date.now();

  #max(): number {
    const value = Number(this.env.T3FLARE_MAX_CONTAINERS);
    return Number.isInteger(value) && value > 0 ? value : MAX_CONTAINERS;
  }

  #leaseMs(): number {
    const value = Number(this.env.T3FLARE_LEASE_MS);
    return Number.isFinite(value) && value > 0 ? value : LEASE_MS;
  }

  #live(now: number): Array<Lease> {
    const leases = this.ctx.storage.kv.get<Array<Lease>>("leases") ?? [];
    const live = leases.filter((lease) => lease.until > now);
    if (live.length !== leases.length) this.ctx.storage.kv.put("leases", live);
    return live;
  }

  /** Takes (or renews) `holder`'s lease if a slot is free. */
  acquire(holder: string): LeaseAnswer {
    const now = this.now();
    const live = this.#live(now);
    const others = live.filter((lease) => lease.holder !== holder);
    if (others.length >= this.#max()) {
      return {
        ok: false,
        reason: `${others.length} Containers are running, the most this deploy allows; try again when one stops.`,
        running: others.map((lease) => lease.holder),
      };
    }
    const until = now + this.#leaseMs();
    const next = [...others, { holder, until }];
    this.ctx.storage.kv.put("leases", next);
    return { ok: true, until, running: next.map((lease) => lease.holder) };
  }

  /** Renews `holder`'s lease; refused when it has none (it expired and its slot went to another). */
  renew(holder: string): LeaseAnswer {
    const now = this.now();
    const live = this.#live(now);
    if (!live.some((lease) => lease.holder === holder)) {
      return { ok: false, reason: "no lease", running: live.map((lease) => lease.holder) };
    }
    return this.acquire(holder);
  }

  release(holder: string): void {
    const live = this.#live(this.now()).filter((lease) => lease.holder !== holder);
    this.ctx.storage.kv.put("leases", live);
  }

  state(): { readonly max: number; readonly leases: ReadonlyArray<Lease> } {
    return { max: this.#max(), leases: this.#live(this.now()) };
  }
}
