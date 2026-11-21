// @effect-diagnostics globalDate:off globalConsole:off
// Deleting Workspaces (step 2b, plan section 5; review F3, F4, F5, F8): t3's `git worktree remove`, the purge, the
// tombstone, and the sweep with its cost guard. The registry stays the only index of Workspace DOs (they cannot be
// listed), so a purge deletes the registry row last; a row left in `deleting` is driven again by the sweep.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { toWorkspace } from "@t3flare/workspace-client";

import { environmentServices } from "./bindings.ts";
import { byName } from "./rpc.ts";
import { workspaceRpc } from "./workspaceClient.ts";
import { DAY_MS, type SweepSettings } from "./deletionSettings.ts";
import type { WorkspaceRecord } from "./workspaces.ts";

export { type SweepSettings, sweepSettingsOf } from "./deletionSettings.ts";
export const SWEEP_EVERY_MS = DAY_MS;
/** A `deleting` row is driven again this soon (review F5: t3 may re-create the same worktree path). */
export const DELETING_RETRY_MS = 5 * 60_000;
/** A `provisioning` or `failed` row older than this is purged. */
export const STALE_PROVISIONING_MS = 60 * 60_000;
/** The Sweep never runs again sooner than this after a run (ADR-0043 §5). */
export const SWEEP_MIN_GAP_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------------
// The purge date (ADR-0043 §2): computed when it is read, never stored

/** What waits out the Grace. A Tombstone is `dated` when its `purge_after` is set (a removal step that ran). */
export type PurgeSubject =
  | { readonly kind: "unreferenced"; readonly since: number }
  | { readonly kind: "tombstone"; readonly deletedAt: number; readonly dated: boolean }
  /** A deleted thread's Session, by t3's `deleted_at`. */
  | { readonly kind: "session"; readonly deletedAt: string };

/** The Grace a date is computed with: its length, and when purging was last turned on (ADR-0043 §4), if it is on. */
export interface GraceClock {
  readonly graceMs: number;
  readonly purgingSince: number | null;
}

/**
 * When the Sweep may purge `subject`: when it started waiting plus the Grace, no sooner than one Grace after purging was
 * turned on (ADR-0043 §4). Null for what is never purged: a Tombstone whose removal could not run, a date not readable.
 */
export const purgeDue = (subject: PurgeSubject, grace: GraceClock): number | null => {
  const since = subject.kind === "unreferenced" ? subject.since : subject.kind === "tombstone" ? (subject.dated ? subject.deletedAt : null) : Date.parse(subject.deletedAt);
  if (since === null || !Number.isFinite(since)) return null;
  return Math.max(since, grace.purgingSince ?? since) + grace.graceMs;
};

/**
 * What of a registry row waits out the Grace: a marked `ready` row, or a Tombstone. Nothing for any other row. It waits
 * from its mark (or removal), or from `released`, the last deletion in t3 of a project or thread that referenced it, when
 * that is later: a mark no Sweep cleared, while a thread held the Workspace and was deleted, is stale (ADR-0043 §2).
 */
export const purgeSubjectOf = (row: WorkspaceRecord, released?: number): PurgeSubject | undefined => {
  const after = (at: number) => Math.max(at, released ?? at);
  if (row.state === "ready") return row.unreferencedSince === null ? undefined : { kind: "unreferenced", since: after(row.unreferencedSince) };
  // A Tombstone from before ADR-0043 has a `deleted_at` (set with its `purge_after`); its old due date is the fallback.
  if (row.state === "tombstoned") return { kind: "tombstone", deletedAt: after(row.deletedAt ?? row.purgeAfter ?? row.createdAt), dated: row.purgeAfter !== null };
  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------------
// References (plan section 5.2): read from t3's own tables, failing closed (review F3)

/** One thing that references a Workspace (ADR-0044 §1): the page names it with its t3 title. */
export type Holder =
  | { readonly kind: "project" | "thread"; readonly id: string; readonly archived: boolean }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "terminals"; readonly count: number };

/** A holder as the Sweep's reasons and the admin routes word it (no titles). */
export const holderText = (holder: Holder): string =>
  holder.kind === "terminals"
    ? `${holder.count} open terminals`
    : holder.kind === "run"
      ? `open run in thread ${holder.id}`
      : `${holder.kind} ${holder.id}${holder.archived ? " (archived)" : ""}`;

export interface References {
  /** Why each Workspace id is referenced. */
  readonly byWorkspace: ReadonlyMap<string, ReadonlyArray<string>>;
  /** The same, as the holders themselves (at most 5 a Workspace). */
  readonly holders: ReadonlyMap<string, ReadonlyArray<Holder>>;
  /** Deleted threads by the Workspace their worktree or project was in (their Sessions go with a purge). */
  readonly deletedThreads: ReadonlyMap<string, ReadonlyArray<{ readonly threadId: string; readonly deletedAt: string }>>;
  /** The latest t3 `deleted_at` of a deleted project or thread that referenced each Workspace (`purgeSubjectOf`). */
  readonly released: ReadonlyMap<string, number>;
}

const OPEN_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];

/** The Workspace id of a t3 path (a project may sit in a subdirectory of its repo: matched by id, review F3). */
const idOf = (path: string | null | undefined): string | null => (path ? (toWorkspace(path)?.id ?? null) : null);

/**
 * What references each Workspace in t3's projection: live projects (archived included), live threads' worktrees and
 * projects, and open runs. Any read error throws: the sweep then does nothing (unlike the idle check's empty answer).
 */
export const referencesFrom = (sql: SqlStorage): References => {
  const holders = new Map<string, Array<Holder>>();
  const add = (id: string | null, holder: Holder) => {
    if (id === null) return;
    const list = holders.get(id) ?? [];
    if (list.length < 5) list.push(holder);
    holders.set(id, list);
  };
  const projects = sql
    .exec<{ project_id: string; workspace_root: string; deleted_at: string | null; archived_at: string | null }>(
      "SELECT project_id, workspace_root, deleted_at, archived_at FROM projection_projects",
    )
    .toArray();
  const rootOf = new Map(projects.map((project) => [project.project_id, project.workspace_root]));
  const released = new Map<string, number>();
  const release = (ids: ReadonlyArray<string>, deletedAt: string) => {
    const at = Date.parse(deletedAt);
    if (Number.isFinite(at)) for (const id of ids) released.set(id, Math.max(at, released.get(id) ?? at));
  };
  for (const project of projects) {
    const id = idOf(project.workspace_root);
    if (project.deleted_at === null) add(id, { kind: "project", id: project.project_id, archived: project.archived_at !== null });
    else if (id !== null) release([id], project.deleted_at);
  }
  const threads = sql
    .exec<{ thread_id: string; project_id: string; deleted_at: string | null; archived_at: string | null; worktree: string | null }>(
      "SELECT thread_id, project_id, deleted_at, archived_at, json_extract(payload_json, '$.worktreePath') AS worktree FROM orchestration_v2_projection_threads",
    )
    .toArray();
  const deletedThreads = new Map<string, Array<{ threadId: string; deletedAt: string }>>();
  for (const thread of threads) {
    const ids = [...new Set([idOf(thread.worktree), idOf(rootOf.get(thread.project_id))].filter((id): id is string => id !== null))];
    if (thread.deleted_at === null) {
      for (const id of ids) add(id, { kind: "thread", id: thread.thread_id, archived: thread.archived_at !== null });
    } else {
      for (const id of ids) deletedThreads.set(id, [...(deletedThreads.get(id) ?? []), { threadId: thread.thread_id, deletedAt: thread.deleted_at }]);
      release(ids, thread.deleted_at);
    }
  }
  const runs = sql
    .exec<{ thread_id: string }>(`SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE status IN (${OPEN_RUN_STATUSES.map((s) => `'${s}'`).join(", ")})`)
    .toArray();
  const threadById = new Map(threads.map((thread) => [thread.thread_id, thread]));
  for (const run of runs) {
    const thread = threadById.get(run.thread_id);
    if (thread !== undefined) for (const id of [idOf(thread.worktree), idOf(rootOf.get(thread.project_id))]) add(id, { kind: "run", id: run.thread_id });
  }
  return { byWorkspace: textsOf(holders), holders, deletedThreads, released };
};

const textsOf = (holders: ReadonlyMap<string, ReadonlyArray<Holder>>): ReadonlyMap<string, ReadonlyArray<string>> => new Map([...holders].map(([id, list]) => [id, list.map(holderText)]));

/** How many Terminals a `ready` Workspace has open; throws when it cannot answer. */
export type OpenTerminals = (id: string) => Promise<number>;

export const openTerminals: OpenTerminals = async (id) => (await workspaceRpc(id).terminalState()).keys.length;

/**
 * Everything that references the Workspaces `rows` (ADR-0044 §1), shared by the Sweep, the page and a Purge: t3's projection
 * (`referencesFrom`) and each `ready` row's open Terminals. Any read that fails throws: the caller then does nothing
 * (review F3).
 */
export const readReferences = async (sql: SqlStorage, rows: ReadonlyArray<WorkspaceRecord>, terminals: OpenTerminals = openTerminals): Promise<References> => {
  const read = referencesFrom(sql);
  const holders = new Map(read.holders);
  for (const row of rows.filter((ws) => ws.state === "ready")) {
    const count = await terminals(row.id);
    if (count > 0) holders.set(row.id, [...(holders.get(row.id) ?? []), { kind: "terminals", count }]);
  }
  return { byWorkspace: textsOf(holders), holders, deletedThreads: read.deletedThreads, released: read.released };
};

// ---------------------------------------------------------------------------------------------------------------------
// Purge (plan section 5.4): ordered, idempotent, registry last

export interface PurgeReport {
  readonly id: string;
  readonly sessionsDestroyed: ReadonlyArray<string>;
  readonly destroyed: boolean;
  readonly error?: string;
}

/** A `destroy()` whose object restarted before its answer arrived ("… destroyed") did its work. */
const destroyed = async (call: Promise<unknown>): Promise<void> => {
  try {
    await call;
  } catch (error) {
    if (!/destroyed/.test(String(error))) throw error;
  }
};

/** Sessions of deleted threads first (review F4), then the Workspace DO, then the registry row. */
export const purgeWorkspace = async (id: string, deletedThreads: ReadonlyArray<{ readonly threadId: string }>): Promise<PurgeReport> => {
  const services = environmentServices();
  services.workspaces.setState(id, "deleting", { deletedAt: Date.now() });
  const sessionsDestroyed: Array<string> = [];
  try {
    for (const { threadId } of deletedThreads) {
      await destroyed(byName(services.agents.SESSIONS, `thread:${threadId}`, "SESSIONS").destroy());
      sessionsDestroyed.push(threadId);
    }
    await destroyed(workspaceRpc(id).destroy());
    services.workspaces.remove(id);
    console.log(JSON.stringify({ t3flare: "workspace-purged", id, sessions: sessionsDestroyed.length }));
    return { id, sessionsDestroyed, destroyed: true };
  } catch (error) {
    // Left in `deleting`: the sweep drives it again within minutes.
    services.workspaces.setLastError(id, `purge: ${String(error).slice(0, 500)}`);
    return { id, sessionsDestroyed, destroyed: false, error: String(error).slice(0, 500) };
  }
};

/**
 * A tombstone back to `ready` (admin `workspace-restore`; `git worktree add` at its path, review F5): its Container may
 * start again first, so a failed reopen leaves it a tombstone rather than a `ready` Workspace that cannot run.
 */
export const restoreWorkspace = async (id: string): Promise<WorkspaceRecord | undefined> => {
  const services = environmentServices();
  const record = services.workspaces.get(id);
  if (record?.state !== "tombstoned") return undefined;
  await workspaceRpc(id).reopenContainer();
  services.workspaces.setState(id, "ready", { deletedAt: null, purgeAfter: null, lastError: null });
  services.workspaces.setUnreferencedSince(id, null);
  return services.workspaces.get(id);
};

// ---------------------------------------------------------------------------------------------------------------------
// t3's `git worktree remove [--force] -- <path>` (plan section 5.3)

export interface RemoveAnswer {
  readonly exitCode: number;
  readonly stderr: string;
  readonly detail: string;
}

const notAWorktree = (path: string): RemoveAnswer => ({ exitCode: 128, stderr: `fatal: '${path}' is not a working tree\n`, detail: "unknown" });

/**
 * Removes a worktree Workspace: refuses a dirty one without `--force` (git's own words); otherwise leaves `ready` at
 * once, carries every ref its project cannot reach home (review F8), and purges it, or tombstones it when it had
 * uncommitted work (purged after the grace) or when a step could not run (never purged).
 */
export const removeWorktree = async (projectCwd: string, path: string, force: boolean, sql: SqlStorage, settings: SweepSettings): Promise<RemoveAnswer> => {
  const services = environmentServices();
  const project = toWorkspace(projectCwd);
  const target = toWorkspace(path);
  if (project === null || target === null) return notAWorktree(path);
  const record = services.workspaces.resolve(target.id);
  if (record === undefined || record.kind !== "worktree" || record.parent !== project.id) return notAWorktree(path);
  const id = record.id;
  const dir = id.split("/")[2] ?? id;
  const tombstone = async (why: string, purgeAfter: number | null, extra: Readonly<Record<string, unknown>> = {}): Promise<RemoveAnswer> => {
    services.workspaces.setState(id, "tombstoned", { deletedAt: Date.now(), purgeAfter, lastError: why });
    // The work is kept; the Container and its budget slot are not. Closed, not just stopped: a start under way (the
    // thread's first turn, its terminal) would otherwise bring it back with a lease (the nightly's `leased: true`).
    // A close that fails still leaves the Workspace closed: its alarm stops the Container rather than renew it. The
    // removal itself stands (t3's worktree is gone either way); the failure is on the row and in the answer's detail.
    const stopError = await workspaceRpc(id)
      .closeContainer()
      .then(
        () => undefined,
        (error: unknown) => String(error).slice(0, 300),
      );
    if (stopError !== undefined) services.workspaces.setLastError(id, `${why}; the Container did not stop: ${stopError}`);
    const outcome = { outcome: "tombstoned", why, purgeAfter, ...extra, ...(stopError === undefined ? {} : { stopError }) };
    console.log(JSON.stringify({ t3flare: "workspace-tombstoned", id, ...outcome }));
    return { exitCode: 0, stderr: "", detail: JSON.stringify(outcome) };
  };
  let tips: { readonly ok: boolean; readonly tips: ReadonlyArray<string>; readonly error?: string };
  let out: Awaited<ReturnType<ReturnType<typeof workspaceRpc>["carryOut"]>>;
  try {
    tips = await workspaceRpc(project.id).refTips();
    out = await workspaceRpc(id).carryOut({ projectTips: tips.ok ? tips.tips : [] });
  } catch (error) {
    // The check needs both Containers (a budget of 3): without it nothing is known, so nothing is purged.
    return await tombstone(`the removal could not check the worktree: ${String(error).slice(0, 300)}`, null);
  }
  if (!out.ok || !tips.ok) return await tombstone(`the removal could not check the worktree: ${(out.error ?? tips.error ?? "").slice(0, 300)}`, null);
  if (out.dirty && !force) {
    return { exitCode: 128, stderr: `fatal: '${path}' contains modified or untracked files, use --force to delete it\n`, detail: "dirty, no --force" };
  }
  services.workspaces.setState(id, "deleting", { deletedAt: Date.now() });
  let carried: ReadonlyArray<string> = [];
  if (out.bundle !== null && out.carried.length > 0) {
    const home = await workspaceRpc(project.id)
      .carryIn({ worktree: id, bundle: out.bundle, dir, carried: out.carried })
      .catch((error: unknown) => ({ ok: false, lines: [] as ReadonlyArray<string>, error: String(error) }));
    if (!home.ok) return await tombstone(`the worktree's refs could not be carried home: ${(home.error ?? "").slice(0, 300)}`, null);
    carried = home.lines;
  }
  // `purge_after` only says the Tombstone has a date (ADR-0043 §2): the date itself is its deletion plus the Grace as it is then.
  if (out.dirty) return await tombstone("uncommitted work (--force)", Date.now() + settings.graceMs, { carried });
  const references = referencesFrom(sql);
  const purged = await purgeWorkspace(id, references.deletedThreads.get(id) ?? []);
  return { exitCode: 0, stderr: "", detail: JSON.stringify({ outcome: purged.destroyed ? "purged" : "deleting", carried, sessions: purged.sessionsDestroyed.length, error: purged.error }) };
};

// ---------------------------------------------------------------------------------------------------------------------
// The sweep (plan section 5.5; review F3)

export interface SweepAction {
  readonly id: string;
  readonly action: "purge" | "mark-unreferenced" | "clear-unreferenced" | "skip";
  readonly why: string;
  /** A skipped or newly marked row's purge date (ADR-0043 §2), when purging is on and it has one: the next run is due by it (ADR-0043 §5). */
  readonly due?: number;
}

export interface SweepReport {
  readonly at: string;
  /** Nothing was written (a preview). */
  readonly dry: boolean;
  /** The Environment setting `sweepPurges`: off, the Sweep marked and purged nothing. */
  readonly purging: boolean;
  readonly graceMs: number;
  /** When purging was last turned on (ADR-0043 §4): nothing is purged before one Grace after it. */
  readonly purgingSince: string | null;
  readonly ok: boolean;
  readonly error?: string;
  readonly actions: ReadonlyArray<SweepAction>;
  readonly purged: ReadonlyArray<PurgeReport>;
  /** Sessions of threads deleted more than the grace ago (destroyed, or that would be on a dry run). */
  readonly sessions?: ReadonlyArray<string>;
  readonly costGuard: ReadonlyArray<{ readonly holder: string; readonly action: string }>;
  readonly nextDue: string;
}

/** The Grace as one Sweep plans with: purging on or off, its length, and when purging was turned on (null when off). */
export interface SweepGrace extends GraceClock {
  readonly purging: boolean;
}

const iso = (at: number) => new Date(at).toISOString();

/**
 * What the sweep would do to each row, given its references; pure (tests). With purging off it still marks and clears
 * (ADR-0043 §4) and drives a `deleting` row on (a Purge already under way), and purges nothing else. A `deleting` row and a
 * stale `provisioning` or `failed` one are not held by `purgingSince` (ADR-0043 §4). `released` is `References.released`.
 */
export const planSweep = (
  rows: ReadonlyArray<WorkspaceRecord>,
  references: ReadonlyMap<string, ReadonlyArray<string>>,
  now: number,
  grace: SweepGrace,
  released: ReadonlyMap<string, number>,
): ReadonlyArray<SweepAction> =>
  rows.map((row): SweepAction => {
    const why = references.get(row.id);
    const subject = purgeSubjectOf(row, released.get(row.id));
    const off = "purging is off";
    /** A row waiting out the Grace: purged on its date when purging is on, else skipped with the date it waits for. */
    const waiting = (subject: PurgeSubject, purge: string, wait: string): SweepAction => {
      if (!grace.purging) return { id: row.id, action: "skip", why: `${wait}; ${off}` };
      const due = purgeDue(subject, grace);
      if (due === null) return { id: row.id, action: "skip", why: wait };
      return due <= now ? { id: row.id, action: "purge", why: purge } : { id: row.id, action: "skip", why: `${wait}, in its Grace until ${iso(due)}`, due };
    };
    if (row.state === "deleting") return { id: row.id, action: "purge", why: "left in deleting" };
    if (row.state === "tombstoned") {
      if (why !== undefined) return { id: row.id, action: "skip", why: `tombstone referenced: ${why[0]}` };
      if (row.purgeAfter === null) return { id: row.id, action: "skip", why: "tombstone kept (a removal step could not run)" };
      return waiting(subject!, "tombstone past its Grace", "tombstone");
    }
    if (row.state === "provisioning" || row.state === "failed") {
      if (now - row.createdAt < STALE_PROVISIONING_MS || why !== undefined) return { id: row.id, action: "skip", why: row.state };
      return grace.purging ? { id: row.id, action: "purge", why: `${row.state} for over an hour` } : { id: row.id, action: "skip", why: `${row.state} for over an hour; ${off}` };
    }
    if (why !== undefined) return row.unreferencedSince === null ? { id: row.id, action: "skip", why: why[0]! } : { id: row.id, action: "clear-unreferenced", why: why[0]! };
    if (subject?.kind !== "unreferenced") {
      // Marked now: its date is known now, so a Sweep that only marks comes back on it (ADR-0043 §5), not a day later.
      const marked = grace.purging ? purgeSubjectOf({ ...row, unreferencedSince: now }, released.get(row.id)) : undefined;
      const due = marked === undefined ? null : purgeDue(marked, grace);
      return { id: row.id, action: "mark-unreferenced", why: "nothing references it", ...(due === null ? {} : { due }) };
    }
    const since = `unreferenced since ${iso(subject.since)}`;
    return waiting(subject, since, since);
  });

/**
 * When the Sweep runs next (ADR-0043 §5): a day ahead, or sooner at the earliest purge date it skipped, or five minutes
 * ahead when a `deleting` row is left; never sooner than a minute ahead.
 */
export const nextSweepAt = (input: { readonly now: number; readonly dues: ReadonlyArray<number>; readonly deletingLeft: boolean }): number =>
  Math.max(input.now + SWEEP_MIN_GAP_MS, Math.min(input.now + (input.deletingLeft ? DELETING_RETRY_MS : SWEEP_EVERY_MS), ...input.dues));

/** When purging was last turned on (ADR-0043 §4), kept by the Environment DO. */
export interface PurgingSince {
  get(): number | null;
  set(at: number | null): void;
}

/** Which deleted threads' Sessions the sweep already destroyed (kept by the Environment DO). */
export interface SweptSessions {
  has(threadId: string): boolean;
  add(threadId: string): void;
}

/** Told of each Workspace the Sweep purged (ADR-0044 §4: its `sweep.purge` audit entry). */
export type OnSweepPurge = (purged: PurgeReport, why: string) => void;

export const sweep = async (
  sql: SqlStorage,
  settings: SweepSettings & { readonly dry: boolean },
  now = Date.now(),
  sweptSessions?: SweptSessions,
  purgingSinceStore?: PurgingSince,
  onPurge?: OnSweepPurge,
): Promise<SweepReport> => {
  const services = environmentServices();
  const { dry, purging } = settings;
  // ADR-0043 §4: the first Sweep that finds purging on starts its Grace; one that finds it off clears it. A dry run writes
  // nothing, and plans as if it were the first.
  const stored = purgingSinceStore?.get() ?? null;
  const purgingSince = purging ? (stored ?? now) : null;
  if (!dry && stored !== purgingSince) purgingSinceStore?.set(purgingSince);
  const grace: SweepGrace = { purging, graceMs: settings.graceMs, purgingSince };
  const reported = { at: iso(now), dry, purging, graceMs: settings.graceMs, purgingSince: purgingSince === null ? null : iso(purgingSince) };
  const rows = services.workspaces.list();
  let references: References;
  try {
    // Open terminals reference their Workspace too; a Workspace DO that cannot answer fails the sweep (review F3).
    references = await readReferences(sql, rows);
  } catch (error) {
    const report: SweepReport = { ...reported, ok: false, error: `the sweep read failed, nothing done: ${String(error).slice(0, 500)}`, actions: [], purged: [], costGuard: [], nextDue: new Date(now + DELETING_RETRY_MS).toISOString() };
    console.warn(JSON.stringify({ t3flare: "sweep-aborted", error: report.error }));
    return report;
  }
  const actions = planSweep(rows, references.byWorkspace, now, grace, references.released);
  const purged: Array<PurgeReport> = [];
  // Marks are written with purging off too (ADR-0043 §4); `dry` alone writes nothing. planSweep purges with purging off only
  // a row already `deleting`.
  if (!dry) {
    // A deleted worktree thread is under its project too: its Session goes once, with the first of them purged (as a
    // Purge now's set, workspaceActions.ts), so one `sweep.purge` entry counts it. One an earlier run destroyed (its date
    // comes a few seconds before its Workspace's) is left, and not counted again.
    const taken = new Set<string>();
    for (const action of actions) {
      if (action.action === "mark-unreferenced") services.workspaces.setUnreferencedSince(action.id, now);
      if (action.action === "clear-unreferenced") services.workspaces.setUnreferencedSince(action.id, null);
      if (action.action !== "purge") continue;
      const threads = (references.deletedThreads.get(action.id) ?? []).filter((thread) => !taken.has(thread.threadId) && sweptSessions?.has(thread.threadId) !== true);
      const report = await purgeWorkspace(action.id, threads);
      // A failed purge's Sessions stay unrecorded: the Session pass below, or its `deleting` row's retry, counts them.
      if (report.destroyed) {
        for (const threadId of report.sessionsDestroyed) {
          taken.add(threadId);
          sweptSessions?.add(threadId);
        }
      }
      purged.push(report);
      if (report.destroyed) onPurge?.(report, action.why);
    }
  }
  // ADR-0008: the Sessions of threads deleted more than the Grace ago go too, whether or not their Workspace does; with
  // purging off, none (ADR-0043 §4).
  const sessions: Array<string> = [];
  const dues = actions.flatMap((action) => (action.due === undefined ? [] : [action.due]));
  const purgedIds = new Set(purged.filter((p) => p.destroyed).flatMap((p) => p.sessionsDestroyed));
  for (const thread of purging ? [...references.deletedThreads.values()].flat() : []) {
    if (sessions.length >= 50 || purgedIds.has(thread.threadId) || sweptSessions?.has(thread.threadId) === true) continue;
    const due = purgeDue({ kind: "session", deletedAt: thread.deletedAt }, grace);
    if (due === null) continue;
    if (due > now) {
      dues.push(due);
      continue;
    }
    if (!dry) {
      try {
        await destroyed(byName(services.agents.SESSIONS, `thread:${thread.threadId}`, "SESSIONS").destroy());
        sweptSessions?.add(thread.threadId);
      } catch (error) {
        console.warn(JSON.stringify({ t3flare: "sweep-session-failed", thread: thread.threadId, error: String(error).slice(0, 200) }));
        continue;
      }
    }
    sessions.push(thread.threadId);
  }
  // The cost guard runs with purging off too (ADR-0043 §4): a Container no Workspace holds is stopped, no files go.
  const costGuard = await guardCost(dry);
  const deletingLeft = services.workspaces.list().some((ws) => ws.state === "deleting");
  const report: SweepReport = {
    ...reported,
    ok: true,
    actions,
    purged,
    sessions,
    costGuard,
    nextDue: iso(nextSweepAt({ now, dues, deletingLeft })),
  };
  console.log(JSON.stringify({ t3flare: "sweep", dry, purging, actions: actions.filter((a) => a.action !== "skip").length, purged: purged.length, costGuard: costGuard.length }));
  return report;
};

/**
 * The cost guard: a Container whose budget lease no `ready` Workspace holds is stopped. Holders are Durable Object
 * ids in hex, so the registry's ids are compared as `idFromName(id).toString()` (review F4).
 */
export const guardCost = async (dry: boolean): Promise<ReadonlyArray<{ readonly holder: string; readonly action: string }>> => {
  const services = environmentServices();
  const namespace = services.agents.WORKSPACES;
  const budget = services.agents.CONTAINER_BUDGET;
  if (namespace === undefined || budget === undefined) return [];
  const known = new Set(services.workspaces.list().filter((ws) => ws.state === "ready" || ws.state === "provisioning").map((ws) => String(namespace.idFromName(ws.id))));
  const state = await byName(budget, "budget", "CONTAINER_BUDGET").state();
  const out: Array<{ holder: string; action: string }> = [];
  for (const lease of state.leases) {
    if (known.has(lease.holder)) continue;
    if (dry || namespace.idFromString === undefined) {
      out.push({ holder: lease.holder, action: "would stop" });
      continue;
    }
    try {
      await namespace.get(namespace.idFromString(lease.holder)).stopContainer();
      await byName(budget, "budget", "CONTAINER_BUDGET").release(lease.holder);
      out.push({ holder: lease.holder, action: "stopped" });
    } catch (error) {
      out.push({ holder: lease.holder, action: `stop failed: ${String(error).slice(0, 200)}` });
    }
  }
  return out;
};
