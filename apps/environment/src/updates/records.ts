// @effect-diagnostics extendsNativeError:off
// In-app Updates' state (ADR-0037; in-app updates plan D7, D9, D19): one record per target in the Environment DO's
// storage (`t3`, and one per CLI), so a press survives the DO's resets. A press dispatches the target's workflow, and
// the record follows the run that dispatch made until it ends, or for 45 minutes, after which it reads as failed. The
// same target pressed again re-attaches to the record in flight; a different one is refused while it runs.
//
// Promise-based and free of t3: the Effect layers (`selfUpdate.ts`) and the process router (`cliUpdate.ts`) drive it.
import type { ActionsClient } from "./actions.ts";

/** A record still in flight this long after its dispatch has failed. */
export const UPDATE_EXPIRY_MS = 45 * 60_000;

export type CliName = "pi" | "codex" | "claude";
export const CLI_NAMES: ReadonlyArray<CliName> = ["pi", "codex", "claude"];
export type UpdateKey = "t3" | `cli:${CliName}`;

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
      if (run.status === "completed") {
        if (run.conclusion === "success") return settleWith(current, "succeeded", `${current.label}: ${run.url}`);
        const step = await actions.failedStep(run.id).catch(() => undefined);
        return settleWith(current, "failed", `The update to ${current.label} failed${step === undefined ? "" : ` at "${step}"`} (${run.conclusion ?? "no conclusion"}). Press Update to retry: ${run.url}`);
      }
    }
    if (deps.now() - current.dispatchedAt > UPDATE_EXPIRY_MS) {
      return settleWith(current, "failed", `The update to ${current.label} did not finish within ${UPDATE_EXPIRY_MS / 60_000} minutes${current.run === null ? " (its run never started)" : `: ${current.run.url}`}.`);
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
      if (deps.actions === undefined) throw new UpdateRefused("This Environment has no update target; only prod updates itself.");
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
