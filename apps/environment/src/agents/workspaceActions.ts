// The Owner's acts on a Workspace (ADR-0044 §2–4): Purge now, Restore and Stop. One module for the
// Settings page's routes, the admin routes and the Settings server's `purge_workspace`; each act reads what it needs
// again, never trusting the page it was asked from, and writes its own audit entry under `workspaces` with the actor
// the caller names. A refusal changes nothing and is not audited.
//
// A Purge's set is the Workspace and, for a project, every registry row whose `parent` it is, in any state: one
// referenced member refuses the whole set, naming every reference (ADR-0044 §2–3); `force` (the admin route's alone)
// purges anyway. Worktrees go first, then the project, each with its deleted threads' Sessions.
import { type PurgeReport, purgeDue, purgeSubjectOf, type SweepReport, type SweptSessions } from "./deletion.ts";
import type { WorkspaceKind, WorkspaceRecord } from "./workspaces.ts";
import { readNamedReferences, sessionsOf, statusOf, titleOf, type WorkspacesDeps, type WorkspaceStatus } from "./workspaceView.ts";
import { type AuditActor, type AuditEntry, auditWorkspace } from "../harness/store.ts";

export interface WorkspaceActionsDeps extends WorkspacesDeps {
  /** `deletion.ts`'s `purgeWorkspace`: Sessions, then the Workspace DO, then the registry row. */
  readonly purge: (id: string, deletedThreads: ReadonlyArray<{ readonly threadId: string }>) => Promise<PurgeReport>;
  /** `deletion.ts`'s `restoreWorkspace`. */
  readonly restore: (id: string) => Promise<WorkspaceRecord | undefined>;
  /** The Workspace DO's `stopContainer`. */
  readonly stop: (id: string) => Promise<void>;
  readonly audit: (entry: AuditEntry) => void;
  readonly now: () => number;
  /** The deleted threads' Sessions the Sweep already destroyed, left alone and not counted again. */
  readonly sweptSessions?: SweptSessions;
}

/** A Workspace DO's size and Container state (ADR-0044 §1), read without starting it; zeros for a destroyed one. */
export interface WorkspaceUsage {
  readonly bytes: number;
  readonly containerRunning: boolean;
}

/** The Workspaces as the Settings page's routes reach them (ADR-0044 §4). */
export interface WorkspacesApi {
  readonly deps: WorkspaceActionsDeps;
  readonly usage: (id: string) => Promise<WorkspaceUsage>;
  /** The Environment DO's Sweep; `dry` writes nothing. */
  readonly runSweep: (dry: boolean) => Promise<SweepReport>;
}

/** An act's outcome, or its refusal with an HTTP-like status. */
export type ActionOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly status: 404 | 409 | 502 | 503; readonly error: string; readonly references?: Readonly<Record<string, ReadonlyArray<string>>> };

const unknown = (id: string) => ({ ok: false, status: 404, error: `no Workspace ${id}` }) as const;

/** A Workspace DO that could not say whether its Terminals are open, under `force` (its Purge went on). */
export interface UnreadTerminals {
  readonly id: string;
  readonly error: string;
}

export interface Purged {
  /** The Workspaces purged, in order. */
  readonly ids: ReadonlyArray<string>;
  /** Deleted threads' Sessions destroyed with them. */
  readonly sessions: number;
  readonly purged: ReadonlyArray<PurgeReport>;
  /** With `force` only: the members whose open Terminals could not be read. */
  readonly unread?: ReadonlyArray<UnreadTerminals>;
}

/**
 * A Purge's set (ADR-0044 §2–3): `id`'s row and, for a project, every registry row whose `parent` it is, in any state, worktrees
 * first; with their references read now and named by t3's titles. A failed read throws; with `force` (the admin route's),
 * a Workspace DO that cannot answer for its Terminals is recorded in `unread` instead, so a broken one can be cleared.
 */
const readPurgeSet = async (deps: WorkspacesDeps, id: string, force = false) => {
  const target = deps.registry.get(id);
  if (target === undefined) return undefined;
  const worktrees = target.kind === "project" ? deps.registry.list().filter((row) => row.parent === id) : [];
  const set = [...worktrees, target];
  const unread: Array<UnreadTerminals> = [];
  const terminals: WorkspacesDeps["terminals"] = force
    ? (member) =>
        deps.terminals(member).catch((error: unknown) => {
          unread.push({ id: member, error: String(error).slice(0, 300) });
          return 0;
        })
    : deps.terminals;
  const read = await readNamedReferences({ ...deps, terminals }, set);
  const held = set.filter((row) => read.named(row.id).length > 0);
  /** The whole set's refusal, naming every reference (ADR-0044 §2–3), or undefined when nothing references it. */
  const refusal =
    held.length === 0
      ? undefined
      : ({
          ok: false,
          status: 409,
          error: `${id} is referenced, so nothing was purged: ${held.map((row) => `${row.id} by ${read.named(row.id).join(", ")}`).join("; ")}. Delete the project or thread in t3 first.`,
          references: Object.fromEntries(held.map((row) => [row.id, read.named(row.id)])),
        } as const);
  return { target, worktrees, set, refusal, unread, ...read };
};

/** What a Purge of a Workspace would take, read now (ADR-0044 §5): what the Settings server shows before it asks. */
export interface PurgePlan {
  readonly id: string;
  readonly kind: WorkspaceKind;
  /** The t3 project's title; a worktree's branch. */
  readonly title: string;
  readonly status: WorkspaceStatus;
  /** The Worktree Workspaces that go with it, each with its status (a kept Tombstone holds work no removal checked). */
  readonly worktrees: ReadonlyArray<{ readonly id: string; readonly status: WorkspaceStatus }>;
  /** Deleted threads' Sessions destroyed with them, each once. */
  readonly sessions: number;
  /** When the Sweep would have purged it (ADR-0043 §2), or null: never (purging off, a kept Tombstone) or not yet marked. */
  readonly purgeDue: number | null;
}

/**
 * Plans a Purge of `id` without purging (ADR-0044 §5): refused, as `purgeNow` would refuse it, when `id` is unknown or any
 * member of its set is referenced.
 */
export const planPurge = async (deps: WorkspacesDeps, id: string, now: number): Promise<ActionOutcome<{ readonly plan: PurgePlan }>> => {
  const read = await readPurgeSet(deps, id);
  if (read === undefined) return unknown(id);
  if (read.refusal !== undefined) return read.refusal;
  const { target, worktrees, references, titles } = read;
  const settings = deps.settings();
  const subject = purgeSubjectOf(target, references.released.get(id));
  const grace = { purging: settings.purging, graceMs: settings.graceMs, purgingSince: settings.purging ? (deps.purgingSince() ?? now) : null };
  return {
    ok: true,
    plan: {
      id,
      kind: target.kind,
      title: titleOf(target, titles),
      // Nothing in a planned set is referenced (a reference refuses it).
      status: statusOf(target, false),
      worktrees: worktrees.map((row) => ({ id: row.id, status: statusOf(row, false) })),
      sessions: sessionsOf(read.set, references),
      purgeDue: grace.purging && subject !== undefined ? purgeDue(subject, grace) : null,
    },
  };
};

/** Purge `id` now, with its Worktree Workspaces (ADR-0044 §2–3). */
export const purgeNow = async (deps: WorkspaceActionsDeps, id: string, options: { readonly force: boolean; readonly actor: AuditActor }): Promise<ActionOutcome<Purged>> => {
  // Read again here, whatever the page or the ask showed; a failed read purges nothing.
  let read: Awaited<ReturnType<typeof readPurgeSet>>;
  try {
    read = await readPurgeSet(deps, id, options.force);
  } catch (error) {
    return { ok: false, status: 503, error: `the Workspace's references could not be read, so nothing was purged: ${String(error).slice(0, 300)}` };
  }
  if (read === undefined) return unknown(id);
  if (read.refusal !== undefined && !options.force) return read.refusal;
  const { set, references, unread } = read;
  const purged: Array<PurgeReport> = [];
  const taken = new Set<string>();
  let failed: PurgeReport | undefined;
  for (const row of set) {
    // A deleted worktree thread is under its project too: its Session goes once, with the first of them purged; one the
    // Sweep already destroyed is left.
    const threads = (references.deletedThreads.get(row.id) ?? []).filter((thread) => !taken.has(thread.threadId) && deps.sweptSessions?.has(thread.threadId) !== true);
    for (const thread of threads) taken.add(thread.threadId);
    const report = await deps.purge(row.id, threads);
    if (!report.destroyed) {
      // Its Sessions stay unrecorded: the retry of its `deleting` row destroys and counts them (ADR-0044 §4).
      failed = report;
      break;
    }
    for (const threadId of report.sessionsDestroyed) deps.sweptSessions?.add(threadId);
    purged.push(report);
  }
  const ids = purged.map((report) => report.id);
  const sessions = purged.reduce((sum, report) => sum + report.sessionsDestroyed.length, 0);
  deps.audit(
    auditWorkspace({
      at: deps.now(),
      actor: options.actor,
      action: "workspace.purge",
      target: id,
      after: {
        purged: ids,
        sessions,
        ...(options.force ? { force: true } : {}),
        ...(unread.length === 0 ? {} : { unread }),
        ...(failed === undefined ? {} : { failed: { id: failed.id, error: failed.error ?? "" } }),
      },
    }),
  );
  if (failed !== undefined) {
    const done = ids.length === 0 ? "nothing was purged" : `${ids.join(", ")} purged`;
    return { ok: false, status: 502, error: `${failed.id} could not be purged: ${failed.error ?? "unknown"}. ${done}; the Sweep drives a Workspace left purging again within minutes.` };
  }
  return { ok: true, ids, sessions, purged, ...(unread.length === 0 ? {} : { unread }) };
};

/** A Tombstone back at its path (ADR-0044's Consequences): its Grace starts over unless a thread in t3 takes the worktree again. */
export const restore = async (deps: WorkspaceActionsDeps, id: string, options: { readonly actor: AuditActor }): Promise<ActionOutcome<{ readonly restored: WorkspaceRecord }>> => {
  const row = deps.registry.get(id);
  if (row === undefined) return unknown(id);
  if (row.state !== "tombstoned") return { ok: false, status: 409, error: `${id} is not a Tombstone` };
  const restored = await deps.restore(id);
  if (restored === undefined) return { ok: false, status: 409, error: `${id} is not a Tombstone` };
  deps.audit(auditWorkspace({ at: deps.now(), actor: options.actor, action: "workspace.restore", target: id, before: { state: "tombstoned" }, after: { state: restored.state } }));
  return { ok: true, restored };
};

/** Stops a `ready` Workspace's Container now (ADR-0044 §1); it starts again at its next use. */
export const stop = async (deps: WorkspaceActionsDeps, id: string, options: { readonly actor: AuditActor }): Promise<ActionOutcome<{ readonly stopped: string }>> => {
  const row = deps.registry.get(id);
  if (row === undefined) return unknown(id);
  if (row.state !== "ready") return { ok: false, status: 409, error: `${id} is not ready: ${row.state}` };
  await deps.stop(id);
  deps.audit(auditWorkspace({ at: deps.now(), actor: options.actor, action: "workspace.stop", target: id, after: { stopped: true } }));
  return { ok: true, stopped: id };
};
