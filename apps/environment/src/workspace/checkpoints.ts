// @effect-diagnostics effectFnOpportunity:off globalDate:off
// t3's checkpoints for paths in a Workspace (step 2a plan, section 2, `VcsDriverRegistry` row; ADR-0009 items 1–2).
// The stock registry builds its git driver inside its own `make` (`GitVcsDriver.makeVcsDriver`), so this Layer wraps
// the registry: every driver it hands out answers `checkpoints.*` for a cwd under `/w/<id>` from the Workspace DO
// (isomorphic-git in the DO, the Container's git only where the DO says it needs it), and runs the stock operations
// for every other cwd. The driver's other reads stay stock: they reach git through the process router, whose passive
// reads the Workspace DO answers without starting its Container (M2's read cache, M3's stale reads).
import { VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import { isUnderW, normalize, type CheckpointAnswer, type CheckpointOp } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as VcsDriver from "t3/src/vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "t3/src/vcs/VcsDriverRegistry.ts";

import { locate } from "../agents/workspaceClient.ts";

/** Checkpoint operations the Workspace DOs answered, by the side that made them (the admin trace). */
export const checkpointTrace: Array<{ readonly at: number; readonly op: string; readonly cwd: string; readonly by: string; readonly ms: number }> = [];

const failure = (operation: string, cwd: string, detail: string): VcsError =>
  new VcsProcessExitError({ operation, command: "git", cwd, exitCode: 1, detail });

const call = (operation: string, cwd: string, op: CheckpointOp): Effect.Effect<unknown, VcsError> => {
  const at = locate(normalize(cwd));
  if (at === undefined) return Effect.fail(failure(operation, cwd, `No Workspace is at ${cwd}.`));
  const started = Date.now();
  return Effect.tryPromise({
    try: (): Promise<CheckpointAnswer> => at.rpc.checkpoint(op),
    catch: (cause) => failure(operation, cwd, `The Workspace did not answer: ${String(cause).slice(0, 300)}`),
  }).pipe(
    Effect.flatMap((answer) => {
      checkpointTrace.push({ at: started, op: op.op, cwd, by: answer.ok ? answer.by : "error", ms: Date.now() - started });
      if (checkpointTrace.length > 200) checkpointTrace.shift();
      return answer.ok ? Effect.succeed(answer.value) : Effect.fail(failure(operation, cwd, answer.error));
    }),
  );
};

const ours = (stock: VcsDriver.VcsCheckpointOps): VcsDriver.VcsCheckpointOps => ({
  captureCheckpoint: (input) =>
    isUnderW(input.cwd)
      ? call("checkpoints.captureCheckpoint", input.cwd, { op: "capture", ref: input.checkpointRef }).pipe(Effect.asVoid)
      : stock.captureCheckpoint(input),
  hasCheckpointRef: (input) =>
    isUnderW(input.cwd)
      ? call("checkpoints.hasCheckpointRef", input.cwd, { op: "has", ref: input.checkpointRef }).pipe(Effect.map((value) => value === true))
      : stock.hasCheckpointRef(input),
  restoreCheckpoint: (input) =>
    isUnderW(input.cwd)
      ? call("checkpoints.restoreCheckpoint", input.cwd, { op: "restore", ref: input.checkpointRef, fallbackToHead: input.fallbackToHead === true }).pipe(
          Effect.map((value) => value === true),
        )
      : stock.restoreCheckpoint(input),
  diffCheckpoints: (input) =>
    isUnderW(input.cwd)
      ? call("checkpoints.diffCheckpoints", input.cwd, {
          op: "diff",
          from: input.fromCheckpointRef,
          to: input.toCheckpointRef,
          fallbackFromToHead: input.fallbackFromToHead === true,
          ignoreWhitespace: input.ignoreWhitespace,
          format: input.format ?? "patch",
          ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
          ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
        }).pipe(Effect.map((value) => (typeof value === "string" ? value : "")))
      : stock.diffCheckpoints(input),
  listAuthoredPaths: (input) =>
    isUnderW(input.cwd)
      ? call("checkpoints.listAuthoredPaths", input.cwd, { op: "authored", from: input.fromCheckpointRef, to: input.toCheckpointRef }).pipe(
          Effect.map((value) => (Array.isArray(value) ? new Set(value as ReadonlyArray<string>) : null)),
        )
      : stock.listAuthoredPaths(input),
  deleteCheckpointRefs: (input) =>
    isUnderW(input.cwd)
      ? call("checkpoints.deleteCheckpointRefs", input.cwd, { op: "delete", refs: input.checkpointRefs }).pipe(Effect.asVoid)
      : stock.deleteCheckpointRefs(input),
});

const wrap = (driver: VcsDriver.VcsDriver["Service"]): VcsDriver.VcsDriver["Service"] => ({ ...driver, checkpoints: ours(driver.checkpoints) });

/** The stock registry, its drivers' checkpoints answered by the Workspace DOs for `/w` paths. */
export const layerVcsDriverRegistry = <E, R>(stock: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry, E, R>) =>
  Layer.effect(
    VcsDriverRegistry.VcsDriverRegistry,
    Effect.gen(function* () {
      const base = yield* VcsDriverRegistry.VcsDriverRegistry;
      return VcsDriverRegistry.VcsDriverRegistry.of({
        get: (kind) => base.get(kind).pipe(Effect.map(wrap)),
        detect: (input) => base.detect(input).pipe(Effect.map((handle) => (handle === null ? null : { ...handle, driver: wrap(handle.driver) }))),
        resolve: (input) => base.resolve(input).pipe(Effect.map((handle) => ({ ...handle, driver: wrap(handle.driver) }))),
      });
    }),
  ).pipe(Layer.provide(stock));
