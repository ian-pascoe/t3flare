// A turn's checkpoint capture (t3's `captureCheckpoint`; ADR-0009 items 1–2; SPI-1100), for the Workspace DO.
//
// A capture reads the DO's own files: within the guard it commits them with isomorphic-git, and above it the capture
// is an alias of the last one when the DO's change log has nothing since. A CLI agent (Codex, Pi CLI, Claude, OpenCode)
// and a terminal write in the Container, and their writes reach the DO only with a pull (`terminalSync.ts`), which is
// debounced on the process's output. t3 captures as soon as the turn ends, before that pull ran, so the capture first
// pulls the Container's writes (nothing when it is stopped: a stop pulls before it ends), and only then reads the
// change log's revision and the files.
// @effect-diagnostics asyncFunction:off
import type { CheckpointAnswer } from "@t3flare/workspace-client";
import * as git from "isomorphic-git";

import { captureCheckpoint, type Repo, resolverFor, withinGuard } from "./gitRepo.ts";

/** The last checkpoint captured: its commit, the change log's revision then, and HEAD then. */
export interface LastCapture {
  readonly commit: string;
  readonly rev: number;
  readonly head: string | null;
}

export interface CaptureDeps {
  /** Brings the Container's writes not yet pulled into the DO's files; nothing when the Container is stopped. */
  readonly pull: () => Promise<unknown>;
  readonly repo: () => Promise<Repo>;
  /** The DO's change-log revision (a pull's writes move it). */
  readonly revision: () => number;
  /** The repo's paths written after revision `after`, through `through`. */
  readonly journalSince: (after: number, through: number) => ReadonlyArray<string>;
  readonly last: () => LastCapture | undefined;
  readonly remember: (last: LastCapture) => void;
  /** The capture in the Container's git (above the guard). */
  readonly inContainer: (ref: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  readonly nowSeconds: () => number;
}

/** Captures the Workspace's working tree as checkpoint `ref`, the Container's writes included. */
export const captureTurn = async (deps: CaptureDeps, ref: string): Promise<CheckpointAnswer> => {
  // A failed pull fails the capture: a checkpoint without the Container's writes would be wrong, not just late.
  await deps.pull();
  const repo = await deps.repo();
  const global = deps.revision();
  // The guard first: above it, no object is read in the DO (SPI-1050 review: a big pack is read whole).
  const within = await withinGuard(repo);
  const resolve = resolverFor(repo, within);
  const head = await resolve("HEAD");
  let answer: CheckpointAnswer;
  if (within) {
    await captureCheckpoint(repo, ref, deps.nowSeconds());
    answer = { ok: true, value: null, by: "do" };
  } else {
    const previous = deps.last();
    if (previous !== undefined && previous.head === head && deps.journalSince(previous.rev, global).length === 0) {
      await git.writeRef({ fs: repo.fs, dir: repo.dir, ref, value: previous.commit, force: true });
      answer = { ok: true, value: null, by: "alias" };
    } else {
      const result = await deps.inContainer(ref);
      if (!result.ok) return { ok: false, error: result.error };
      answer = { ok: true, value: null, by: "container" };
    }
  }
  const commit = await resolve(ref);
  if (commit !== null) deps.remember({ commit, rev: global, head });
  return answer;
};
