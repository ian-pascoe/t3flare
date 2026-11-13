// @effect-diagnostics globalDate:off
// The Container budget (step 2a plan, cost guardrails): at most the budget's Containers run at once across the
// deploy. `max_instances` does not apply under `schedulingPolicy: "durable_object"`, so a singleton DO leases the slots.
// The budget is an Environment setting (ADR-0032): a Workspace DO carries it with a fresh start's lease request, and
// this object judges the request by it and keeps the last one for renewals and status reads (MAX_CONTAINERS before
// any). Lowering it stops nothing: a holder's own lease is always renewed, and only new starts wait until fewer run.
// A Workspace DO takes a lease before it starts its Container, renews it from its alarm while the Container runs, and
// releases it when the Container stops. A lease expires LEASE_MS after its last renewal, so a lost release frees its
// slot within that time and a running Container never loses its slot while it is renewed.
import { DEFAULT_CONTAINER_BUDGET, fitsEnvironmentSetting } from "@t3flare/harness-registry";
import { DurableObject } from "cloudflare:workers";

/** The budget before any request carried one (the Environment settings' default). */
export const MAX_CONTAINERS = DEFAULT_CONTAINER_BUDGET;
/** The last budget a request carried. */
const BUDGET_KEY = "budget";
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
  /** `max`: the budget the request was judged by (a reclaim frees enough slots to get under it, or none). */
  | { readonly ok: false; readonly reason: string; readonly running: ReadonlyArray<string>; readonly max?: number };

export interface BudgetEnv {
  /** Overrides MAX_CONTAINERS and every carried budget (tests). */
  readonly T3FLARE_MAX_CONTAINERS?: string;
  /** Overrides LEASE_MS (tests). */
  readonly T3FLARE_LEASE_MS?: string;
}

export class ContainerBudget extends DurableObject<BudgetEnv> {
  /** The clock every lease is judged by; a field, not a method, so it is not part of the RPC surface. Tests swap it. */
  protected readonly now: () => number = () => Date.now();

  /** `T3FLARE_MAX_CONTAINERS` when set; a field, not a method, so it is not part of the RPC surface. Tests swap it. */
  protected readonly maxOverride: () => number | undefined = () => {
    const value = Number(this.env.T3FLARE_MAX_CONTAINERS);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };

  /** The budget: the override, else `carried` when valid (kept for later), else the last kept, else the default. */
  #max(carried?: number): number {
    if (carried !== undefined && fitsEnvironmentSetting("containerBudget", carried)) this.ctx.storage.kv.put(BUDGET_KEY, carried);
    return this.maxOverride() ?? this.ctx.storage.kv.get<number>(BUDGET_KEY) ?? MAX_CONTAINERS;
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

  /**
   * Takes `holder`'s lease if a slot is free under `budget` (the Environment settings' Container budget, carried by the
   * Workspace DO; absent, the last one carried), or renews the lease it holds: a holder is never refused its own.
   */
  acquire(holder: string, budget?: number): LeaseAnswer {
    const now = this.now();
    const live = this.#live(now);
    const others = live.filter((lease) => lease.holder !== holder);
    const max = this.#max(budget);
    if (others.length >= max && others.length === live.length) {
      return {
        ok: false,
        // Short: computer keeps only the first 240 characters of a failed start's message, its own prefix included, and
        // the Workspace DO shows that message to terminals and CLI agents.
        reason: `Container budget (${max}) reached: raise it at /_t3flare/harness#environment`,
        running: others.map((lease) => lease.holder),
        max,
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
