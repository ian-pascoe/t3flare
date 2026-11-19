// @effect-diagnostics extendsNativeError:off
// In-app Updates' state (ADR-0037; in-app updates plan D7, D9, D19): one record per target in the Environment DO's
// storage (`t3`, and one per CLI), so a press survives the DO's resets. A press dispatches the target's workflow, and
// the record follows the run that dispatch made until it ends, or for 110 minutes from its start (UPDATE_EXPIRY_MS), after which it reads as failed. The
// same target pressed again re-attaches to the record in flight; a different one is refused while it runs.
//
// Promise-based and free of t3: the Effect layers (`selfUpdate.ts`) and the process router (`cliUpdate.ts`) drive it.
import type { ActionsClient } from "./actions.ts";
import type { UpdatableCli } from "./pins.ts";

/**
 * How long a record may stay in flight (review A2). Measured from when the DO first sees its run out of the queue, not
 * its dispatch: a run waits its turn in the `bump` concurrency group behind other bumps (`queue: max`) for as long as
 * they take. 110 minutes covers the run's own timeouts (plan's 5, the bump job's 20, publish's 15, land's check 5 and its push
 * and follow 60, which waits out deploy-prod's 45: 105, plus a margin for runners picking up each job; a run that hits them has failed already), and orders after t3's 32-minute client wait and the
 * 35-minute replay of a failed outcome (U92).
 */
export const UPDATE_EXPIRY_MS = 110 * 60_000;
/**
 * What a press is told on a stage without an update target (`T3FLARE_UPDATE_REPO` unset; docs/deploy.md): such a
 * Deployment updates by being deployed again.
 */
export const NO_UPDATE_TARGET =
  "This Environment has no update target. Update it by deploying: pull the Canonical repository's main and deploy this Stage again (docs/deploy.md, Updating).";
/** A run still waiting its turn this long after the dispatch has failed. */
export const QUEUED_CEILING_MS = 3 * 60 * 60_000;
/** A dispatch whose run GitHub never lists within this has failed. */
export const UNLISTED_MS = 15 * 60_000;

export type UpdateKey = "t3" | `cli:${UpdatableCli}`;

export interface UpdateOutcome {
  readonly status: "succeeded" | "failed";
  readonly reason: string;
  readonly at: number;
}

export interface UpdateRecord {
  readonly id: string;
  readonly key: UpdateKey;
  /** t3: the target version; a CLI: `latest` (CI resolves the version). */
  readonly target: string;
  /** The version the press found running. */
  readonly from: string;
  /** What the record is called in a reason: `t3@<version>`, `the pi CLI`. */
  readonly label: string;
  readonly workflow: string;
  /** The run's `run-name` (plan D9), which finds it. */
  readonly runName: string;
  readonly dispatchedAt: number;
  readonly run: { readonly id: number; readonly url: string } | null;
  /** When the DO first saw its run out of the queue (review A10); null while it waits (or before it is found). */
  readonly startedAt?: number | null;
  /** Null while in flight. */
  readonly outcome: UpdateOutcome | null;
}

/** The DO's synchronous key-value storage, as much of it as the records use. */
export interface UpdateStore {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
}

const storageKey = (key: UpdateKey) => `t3flare:update:${key}`;

export class UpdateRefused extends Error {
  override readonly name = "UpdateRefused";
}

export interface PressRequest {
  readonly key: UpdateKey;
  readonly target: string;
  readonly from: string;
  readonly label: string;
  readonly workflow: string;
  readonly runName: (id: string) => string;
  readonly inputs: (id: string) => Readonly<Record<string, string>>;
}

export interface Updates {
  /** The stage has an update target (plan D14). */
  readonly configured: boolean;
  readonly record: (key: UpdateKey) => UpdateRecord | undefined;
  /** Re-attaches to the record in flight for the same target, else dispatches; refuses a different target in flight. */
  readonly press: (request: PressRequest) => Promise<{ readonly record: UpdateRecord; readonly attached: boolean }>;
  /** One look at the record's run: finds it, reads it, and settles the record when it ended or expired. */
  readonly settle: (key: UpdateKey) => Promise<UpdateRecord | undefined>;
  /** Settles a record in flight as failed (a check the run cannot make). */
  readonly fail: (key: UpdateKey, reason: string) => UpdateRecord | undefined;
}

export const isInFlight = (record: UpdateRecord | undefined): record is UpdateRecord => record !== undefined && record.outcome === null;

export const updates = (deps: {
  readonly store: UpdateStore;
  /** Undefined on a stage without an update target. */
  readonly actions: ActionsClient | undefined;
  readonly now: () => number;
  readonly newId: () => string;
}): Updates => {
  const record = (key: UpdateKey) => deps.store.get(storageKey(key)) as UpdateRecord | undefined;
  const save = (next: UpdateRecord) => {
    deps.store.put(storageKey(next.key), next);
    return next;
  };
  const settleWith = (current: UpdateRecord, status: UpdateOutcome["status"], reason: string) => save({ ...current, outcome: { status, reason, at: deps.now() } });

  const settle = async (key: UpdateKey): Promise<UpdateRecord | undefined> => {
    let current = record(key);
    if (!isInFlight(current) || deps.actions === undefined) return current;
    const actions = deps.actions;
    if (current.run === null) {
      // GitHub lists the run a moment after the dispatch; a minute's slack covers the two clocks.
      const run = await actions.findRun(current.workflow, current.runName, current.dispatchedAt - 60_000);
      if (run !== undefined) current = save({ ...current, run: { id: run.id, url: run.url } });
    }
    if (current.run !== null) {
      const run = await actions.getRun(current.run.id);
      if ((current.startedAt ?? null) === null && run.started) current = save({ ...current, startedAt: deps.now() });
      if (run.status === "completed") {
        if (run.conclusion === "success") return settleWith(current, "succeeded", `${current.label}: ${run.url}`);
        const step = await actions.failedStep(run.id).catch(() => undefined);
        return settleWith(current, "failed", `The update to ${current.label} failed${step === undefined ? "" : ` at "${step}"`} (${run.conclusion ?? "no conclusion"}). Press Update to retry: ${run.url}`);
      }
    }
    const now = deps.now();
    const startedAt = current.startedAt ?? null;
    if (current.run === null && now - current.dispatchedAt > UNLISTED_MS) {
      return settleWith(current, "failed", `The update to ${current.label} never started: GitHub lists no run for it ${UNLISTED_MS / 60_000} minutes after its dispatch.`);
    }
    if (startedAt !== null && now - startedAt > UPDATE_EXPIRY_MS) {
      return settleWith(current, "failed", `The update to ${current.label} did not finish within ${UPDATE_EXPIRY_MS / 60_000} minutes of its start: ${current.run?.url ?? ""}`);
    }
    if (startedAt === null && now - current.dispatchedAt > QUEUED_CEILING_MS) {
      return settleWith(current, "failed", `The update to ${current.label} waited its turn for ${QUEUED_CEILING_MS / 3_600_000} hours without starting: ${current.run?.url ?? ""}`);
    }
    return current;
  };

  return {
    configured: deps.actions !== undefined,
    record,
    settle,
    fail: (key, reason) => {
      const current = record(key);
      return isInFlight(current) ? settleWith(current, "failed", reason) : current;
    },
    press: async (request) => {
      if (deps.actions === undefined) throw new UpdateRefused(NO_UPDATE_TARGET);
      // A press settles what it can first, so a finished run does not hold the next one off.
      const existing = await settle(request.key).catch(() => record(request.key));
      if (isInFlight(existing)) {
        if (existing.target === request.target) return { record: existing, attached: true };
        throw new UpdateRefused(`An update to ${existing.label} is already in progress${existing.run === null ? "" : `: ${existing.run.url}`}.`);
      }
      const id = deps.newId();
      // The record is written before the dispatch: a reset between the two finds no run and expires; one written after
      // could dispatch twice.
      const created = save({
        id,
        key: request.key,
        target: request.target,
        from: request.from,
        label: request.label,
        workflow: request.workflow,
        runName: request.runName(id),
        dispatchedAt: deps.now(),
        run: null,
        outcome: null,
      });
      try {
        await deps.actions.dispatch(request.workflow, request.inputs(id));
      } catch (error) {
        settleWith(created, "failed", `Could not start the update: ${error instanceof Error ? error.message : String(error)}`);
        throw new UpdateRefused(`Could not start the update to ${request.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { record: created, attached: false };
    },
  };
};
