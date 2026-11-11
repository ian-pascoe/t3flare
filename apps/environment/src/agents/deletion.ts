// @effect-diagnostics globalDate:off globalConsole:off
// Deleting Workspaces (step 2b, plan section 5; review F3, F4, F5, F8): t3's `git worktree remove`, the purge, the
// tombstone, and the sweep with its cost guard. The registry stays the only index of Workspace DOs (they cannot be
// listed), so a purge deletes the registry row last; a row left in `deleting` is driven again by the sweep.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { toWorkspace } from "@t3flare/workspace-client";

import { environmentServices } from "./bindings.ts";
import { byName } from "./rpc.ts";
import { workspaceRpc } from "./workspaceClient.ts";
import type { WorkspaceRecord } from "./workspaces.ts";

export { GRACE_MS } from "./deletionConstants.ts";
export const SWEEP_EVERY_MS = 24 * 60 * 60_000;
/** A `deleting` row is driven again this soon (review F5: t3 may re-create the same worktree path). */
export const DELETING_RETRY_MS = 5 * 60_000;
/** A `provisioning` or `failed` row older than this is purged. */
export const STALE_PROVISIONING_MS = 60 * 60_000;

export interface SweepSettings {
  readonly graceMs: number;
  /** Purging is on (stages); off, the sweep only reports what it would do (prod's default, review F3). */
  readonly purge: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// References (plan section 5.2): read from t3's own tables, failing closed (review F3)

export interface References {
  /** Why each Workspace id is referenced. */
  readonly byWorkspace: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Deleted threads by the Workspace their worktree or project was in (their Sessions go with a purge). */
  readonly deletedThreads: ReadonlyMap<string, ReadonlyArray<{ readonly threadId: string; readonly deletedAt: string }>>;
}

const OPEN_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];

/** The Workspace id of a t3 path (a project may sit in a subdirectory of its repo: matched by id, review F3). */
const idOf = (path: string | null | undefined): string | null => (path ? (toWorkspace(path)?.id ?? null) : null);

/**
 * What references each Workspace in t3's projection: live projects (archived included), live threads' worktrees and
 * projects, and open runs. Any read error throws: the sweep then does nothing (unlike the idle check's empty answer).
 */
export const referencesFrom = (sql: SqlStorage): References => {
  const byWorkspace = new Map<string, Array<string>>();
  const add = (id: string | null, why: string) => {
    if (id === null) return;
    const list = byWorkspace.get(id) ?? [];
    if (list.length < 5) list.push(why);
    byWorkspace.set(id, list);
  };
  const projects = sql
    .exec<{ project_id: string; workspace_root: string; deleted_at: string | null; archived_at: string | null }>(
      "SELECT project_id, workspace_root, deleted_at, archived_at FROM projection_projects",
    )
    .toArray();
  const rootOf = new Map(projects.map((project) => [project.project_id, project.workspace_root]));
  for (const project of projects) if (project.deleted_at === null) add(idOf(project.workspace_root), `project ${project.project_id}${project.archived_at === null ? "" : " (archived)"}`);
  const threads = sql
    .exec<{ thread_id: string; project_id: string; deleted_at: string | null; archived_at: string | null; worktree: string | null }>(
      "SELECT thread_id, project_id, deleted_at, archived_at, json_extract(payload_json, '$.worktreePath') AS worktree FROM orchestration_v2_projection_threads",
    )
    .toArray();
  const deletedThreads = new Map<string, Array<{ threadId: string; deletedAt: string }>>();
  for (const thread of threads) {
    const ids = [...new Set([idOf(thread.worktree), idOf(rootOf.get(thread.project_id))].filter((id): id is string => id !== null))];
    if (thread.deleted_at === null) {
      for (const id of ids) add(id, `thread ${thread.thread_id}${thread.archived_at === null ? "" : " (archived)"}`);
    } else {
      for (const id of ids) deletedThreads.set(id, [...(deletedThreads.get(id) ?? []), { threadId: thread.thread_id, deletedAt: thread.deleted_at }]);
    }
  }
  const runs = sql
    .exec<{ thread_id: string }>(`SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE status IN (${OPEN_RUN_STATUSES.map((s) => `'${s}'`).join(", ")})`)
    .toArray();
  const threadById = new Map(threads.map((thread) => [thread.thread_id, thread]));
  for (const run of runs) {
    const thread = threadById.get(run.thread_id);
    if (thread !== undefined) for (const id of [idOf(thread.worktree), idOf(rootOf.get(thread.project_id))]) add(id, `open run in thread ${run.thread_id}`);
  }
  return { byWorkspace, deletedThreads };
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

/** A tombstone back to `ready` (admin `workspace-restore`; `git worktree add` at its path, review F5). */
export const restoreWorkspace = (id: string): WorkspaceRecord | undefined => {
  const services = environmentServices();
  const record = services.workspaces.get(id);
  if (record?.state !== "tombstoned") return undefined;
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
  const tombstone = async (why: string, purgeAfter: number | null): Promise<RemoveAnswer> => {
    services.workspaces.setState(id, "tombstoned", { deletedAt: Date.now(), purgeAfter, lastError: why });
    // The work is kept; the Container and its budget slot are not.
    await workspaceRpc(id).stopContainer().catch(() => undefined);
    console.log(JSON.stringify({ t3flare: "workspace-tombstoned", id, why, purgeAfter }));
    return { exitCode: 0, stderr: "", detail: JSON.stringify({ outcome: "tombstoned", why, purgeAfter }) };
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
  if (out.dirty) return { ...(await tombstone("uncommitted work (--force)", Date.now() + settings.graceMs)), detail: JSON.stringify({ outcome: "tombstoned", carried }) };
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
}

export interface SweepReport {
  readonly at: string;
  readonly dry: boolean;
  readonly ok: boolean;
  readonly error?: string;
  readonly actions: ReadonlyArray<SweepAction>;
  readonly purged: ReadonlyArray<PurgeReport>;
  readonly costGuard: ReadonlyArray<{ readonly holder: string; readonly action: string }>;
  readonly nextDue: string;
}

/** What the sweep would do to each row, given its references; pure (tests). */
export const planSweep = (
  rows: ReadonlyArray<WorkspaceRecord>,
  references: ReadonlyMap<string, ReadonlyArray<string>>,
  now: number,
  graceMs: number,
): ReadonlyArray<SweepAction> =>
  rows.map((row): SweepAction => {
    const why = references.get(row.id);
    if (row.state === "deleting") return { id: row.id, action: "purge", why: "left in deleting" };
    if (row.state === "tombstoned") {
      if (row.purgeAfter !== null && row.purgeAfter <= now && why === undefined) return { id: row.id, action: "purge", why: "tombstone past its grace" };
      return { id: row.id, action: "skip", why: row.purgeAfter === null ? "tombstone kept (a removal step could not run)" : why !== undefined ? `tombstone referenced: ${why[0]}` : "tombstone in its grace" };
    }
    if (row.state === "provisioning" || row.state === "failed") {
      return now - row.createdAt >= STALE_PROVISIONING_MS && why === undefined
        ? { id: row.id, action: "purge", why: `${row.state} for over an hour` }
        : { id: row.id, action: "skip", why: row.state };
    }
    if (why !== undefined) return row.unreferencedSince === null ? { id: row.id, action: "skip", why: why[0]! } : { id: row.id, action: "clear-unreferenced", why: why[0]! };
    if (row.unreferencedSince === null) return { id: row.id, action: "mark-unreferenced", why: "nothing references it" };
    return now - row.unreferencedSince >= graceMs
      ? { id: row.id, action: "purge", why: `unreferenced since ${new Date(row.unreferencedSince).toISOString()}` }
      : { id: row.id, action: "skip", why: `unreferenced, in its grace until ${new Date(row.unreferencedSince + graceMs).toISOString()}` };
  });

export const sweep = async (sql: SqlStorage, settings: SweepSettings & { readonly dry: boolean }, now = Date.now()): Promise<SweepReport> => {
  const services = environmentServices();
  const dry = settings.dry || !settings.purge;
  const rows = services.workspaces.list();
  let references: References;
  const terminals = new Map<string, Array<string>>();
  try {
    references = referencesFrom(sql);
    // Open terminals reference their Workspace too; a Workspace DO that cannot answer fails the sweep (review F3).
    for (const row of rows.filter((ws) => ws.state === "ready")) {
      const state = await workspaceRpc(row.id).terminalState();
      if (state.keys.length > 0) terminals.set(row.id, [`${state.keys.length} open terminals`]);
    }
  } catch (error) {
    const report: SweepReport = { at: new Date(now).toISOString(), dry, ok: false, error: `the sweep read failed, nothing done: ${String(error).slice(0, 500)}`, actions: [], purged: [], costGuard: [], nextDue: new Date(now + DELETING_RETRY_MS).toISOString() };
    console.warn(JSON.stringify({ t3flare: "sweep-aborted", error: report.error }));
    return report;
  }
  const merged = new Map(references.byWorkspace);
  for (const [id, why] of terminals) merged.set(id, [...(merged.get(id) ?? []), ...why]);
  const actions = planSweep(rows, merged, now, settings.graceMs);
  const purged: Array<PurgeReport> = [];
  if (!dry) {
    for (const action of actions) {
      if (action.action === "mark-unreferenced") services.workspaces.setUnreferencedSince(action.id, now);
      if (action.action === "clear-unreferenced") services.workspaces.setUnreferencedSince(action.id, null);
      if (action.action === "purge") purged.push(await purgeWorkspace(action.id, references.deletedThreads.get(action.id) ?? []));
    }
  }
  const costGuard = await guardCost(dry);
  const deletingLeft = services.workspaces.list().some((ws) => ws.state === "deleting");
  const report: SweepReport = {
    at: new Date(now).toISOString(),
    dry,
    ok: true,
    actions,
    purged,
    costGuard,
    nextDue: new Date(now + (deletingLeft ? DELETING_RETRY_MS : SWEEP_EVERY_MS)).toISOString(),
  };
  console.log(JSON.stringify({ t3flare: "sweep", dry, actions: actions.filter((a) => a.action !== "skip").length, purged: purged.length, costGuard: costGuard.length }));
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
