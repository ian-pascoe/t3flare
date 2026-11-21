// The Workspaces section's read (ADR-0044 §1): every Workspace in the registry with its status, what
// references it (named by t3's titles), its purge date (ADR-0043 §2), the Sweep's plan for it, a project's Worktree
// Workspaces under it, and what the Owner may do to it. One read for the Settings page, its JSON API and the
// Settings server's `list_workspaces`; it shares `readReferences` with the Sweep, so a failed read fails it as it fails
// the Sweep. Size and Container state are not here: the page loads them per row (ADR-0044 §1).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { toWorkspace } from "@t3flare/workspace-client";

import { type Holder, type OpenTerminals, planSweep, purgeDue, purgeSubjectOf, readReferences, type References, type SweepAction, type SweepReport } from "./deletion.ts";
import type { SweepSettings } from "./deletionSettings.ts";
import type { WorkspaceKind, WorkspaceRecord } from "./workspaces.ts";

/** What the view reads, injected so it runs over fixed rows in tests. */
export interface WorkspacesDeps {
  /** The Environment DO's SQLite: t3's projection. */
  readonly sql: SqlStorage;
  readonly registry: { list(): ReadonlyArray<WorkspaceRecord>; get(id: string): WorkspaceRecord | undefined };
  /** The Grace as stored now (ADR-0043 §2–3). */
  readonly settings: () => SweepSettings;
  /** When purging was last turned on (ADR-0043 §4), or null. */
  readonly purgingSince: () => number | null;
  /** A `ready` Workspace's open Terminals; throws when its DO cannot answer. */
  readonly terminals: OpenTerminals;
}

export type WorkspaceStatus = "in use" | "unreferenced" | "tombstone" | "tombstone (kept)" | "purging" | "provisioning" | "failed";

export interface WorkspaceRow {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly parent: string | null;
  readonly branch: string | null;
  /** `owner/name`, when the Workspace has a repo. */
  readonly repo: string | null;
  readonly createdAt: number;
  /** The t3 project's title (a deleted project's too, the newest at its root); a worktree's branch. */
  readonly title: string;
  /** What the Owner types to purge it (ADR-0044 §4). */
  readonly confirmName: string;
  readonly status: WorkspaceStatus;
  /** At most 5 (and its open Terminals), named by t3's titles. */
  readonly references: ReadonlyArray<string>;
  readonly unreferencedSince: number | null;
  readonly deletedAt: number | null;
  readonly lastError: string | null;
  /** When the Sweep may purge it (ADR-0043 §2), or null: purging off, referenced, kept, or not yet marked. */
  readonly purgeDue: number | null;
  /** What the next Sweep would do to it, and why. */
  readonly planned: { readonly action: SweepAction["action"]; readonly why: string };
  /** Deleted threads' Sessions that go with its Purge (its worktrees' included, each once). */
  readonly sessions: number;
  readonly worktrees: ReadonlyArray<WorkspaceRow>;
  readonly can: { readonly purge: boolean; readonly restore: boolean; readonly stop: boolean };
}

export interface WorkspacesView {
  readonly purging: boolean;
  /** The setting as stored, even when a Stage overrides it. */
  readonly graceDays: number;
  /** The Grace the Sweep uses. */
  readonly graceMs: number;
  /** A Stage's `T3FLARE_SWEEP_GRACE_MS` sets `graceMs`. */
  readonly overridden: boolean;
  readonly purgingSince: number | null;
  readonly rows: ReadonlyArray<WorkspaceRow>;
}

/** What the Owner types to purge a Workspace (ADR-0044 §4): a project's folder name, a worktree's last path segment. */
export const confirmNameOf = (id: string): string => id.split("/").at(-1) ?? id;

/** t3's titles, by project id, thread id, and Workspace id (the newest project at it, deleted ones included). */
export interface Titles {
  readonly projects: ReadonlyMap<string, string>;
  readonly threads: ReadonlyMap<string, string>;
  readonly workspaces: ReadonlyMap<string, string>;
}

/** The titles of t3's projects and threads; a table or column t3 renamed throws. */
export const titlesFrom = (sql: SqlStorage): Titles => {
  const projects = sql
    .exec<{ project_id: string; title: string; workspace_root: string }>("SELECT project_id, title, workspace_root FROM projection_projects ORDER BY created_at DESC")
    .toArray();
  const threads = sql.exec<{ thread_id: string; title: string }>("SELECT thread_id, title FROM orchestration_v2_projection_threads").toArray();
  const workspaces = new Map<string, string>();
  for (const project of projects) {
    // A project may sit in a subdirectory of its repo: matched by Workspace id, as the references are.
    const id = toWorkspace(project.workspace_root)?.id;
    if (id !== undefined && !workspaces.has(id)) workspaces.set(id, project.title);
  }
  return {
    projects: new Map(projects.map((project) => [project.project_id, project.title])),
    threads: new Map(threads.map((thread) => [thread.thread_id, thread.title])),
    workspaces,
  };
};

/** A Workspace's title (ADR-0044 §1): its t3 project's, by Workspace id, else its id; a worktree's branch, else its name. */
export const titleOf = (row: WorkspaceRecord, titles: Titles): string => (row.kind === "worktree" ? (row.branch ?? confirmNameOf(row.id)) : (titles.workspaces.get(row.id) ?? row.id));

/** How many deleted threads' Sessions a Purge of `members` destroys, each once (a worktree thread is under its project too). */
export const sessionsOf = (members: ReadonlyArray<Pick<WorkspaceRecord, "id">>, references: Pick<References, "deletedThreads">): number =>
  new Set(members.flatMap((member) => (references.deletedThreads.get(member.id) ?? []).map((thread) => thread.threadId))).size;

const quoted = (title: string | undefined, id: string) => `“${title ?? id}”`;

/** A reference as the Owner reads it: by its t3 title, its id when t3 has none. */
export const namedHolder = (holder: Holder, titles: Titles): string => {
  switch (holder.kind) {
    case "terminals":
      return `${holder.count} open terminals`;
    case "run":
      return `open run in thread ${quoted(titles.threads.get(holder.id), holder.id)}`;
    case "project":
      return `project ${quoted(titles.projects.get(holder.id), holder.id)}${holder.archived ? " (archived)" : ""}`;
    case "thread":
      return `thread ${quoted(titles.threads.get(holder.id), holder.id)}${holder.archived ? " (archived)" : ""}`;
  }
};

/** The references to `rows` and their titles, read together (ADR-0044 §1): what the view and a Purge both need. */
export const readNamedReferences = async (deps: WorkspacesDeps, rows: ReadonlyArray<WorkspaceRecord>) => {
  const references: References = await readReferences(deps.sql, rows, deps.terminals);
  const titles = titlesFrom(deps.sql);
  return {
    references,
    titles,
    /** What references Workspace `id`, by title; empty when nothing does. */
    named: (id: string): ReadonlyArray<string> => (references.holders.get(id) ?? []).map((holder) => namedHolder(holder, titles)),
  };
};

/** A row's status as the page and a Purge's ask name it (ADR-0044 §1). */
export const statusOf = (row: WorkspaceRecord, referenced: boolean): WorkspaceStatus => {
  switch (row.state) {
    case "ready":
      return referenced ? "in use" : "unreferenced";
    case "tombstoned":
      return row.purgeAfter === null ? "tombstone (kept)" : "tombstone";
    case "deleting":
      return "purging";
    default:
      return row.state;
  }
};

/** Every Workspace, a project's worktrees under it (a worktree whose project is gone is a row of its own). */
export const workspacesView = async (deps: WorkspacesDeps, now: number): Promise<WorkspacesView> => {
  const all = [...deps.registry.list()].toSorted((a, b) => a.id.localeCompare(b.id));
  const settings = deps.settings();
  const purgingSince = deps.purgingSince();
  const { references, titles, named } = await readNamedReferences(deps, all);
  // As the next Sweep would plan: a Sweep that has not run since purging was turned on starts its Grace then (ADR-0043 §4).
  const grace = { purging: settings.purging, graceMs: settings.graceMs, purgingSince: settings.purging ? (purgingSince ?? now) : null };
  const plans = new Map(planSweep(all, references.byWorkspace, now, grace, references.released).map((action) => [action.id, action]));
  const rowOf = (row: WorkspaceRecord, worktrees: ReadonlyArray<WorkspaceRow>): WorkspaceRow => {
    const referenced = references.holders.has(row.id);
    const subject = purgeSubjectOf(row, references.released.get(row.id));
    const plan = plans.get(row.id)!;
    return {
      id: row.id,
      kind: row.kind,
      parent: row.parent,
      branch: row.branch,
      repo: row.owner !== null && row.name !== null ? `${row.owner}/${row.name}` : null,
      createdAt: row.createdAt,
      title: titleOf(row, titles),
      confirmName: confirmNameOf(row.id),
      status: statusOf(row, referenced),
      references: named(row.id),
      unreferencedSince: row.unreferencedSince,
      deletedAt: row.deletedAt,
      lastError: row.lastError,
      purgeDue: grace.purging && !referenced && subject !== undefined ? purgeDue(subject, grace) : null,
      planned: { action: plan.action, why: plan.why },
      sessions: sessionsOf([row, ...worktrees], references),
      worktrees,
      can: {
        // The whole set (ADR-0044 §2–3): nothing referenced, the worktrees included.
        purge: !referenced && worktrees.every((worktree) => worktree.references.length === 0),
        restore: row.state === "tombstoned",
        stop: row.state === "ready",
      },
    };
  };
  const ids = new Set(all.map((row) => row.id));
  const rows = all
    .filter((row) => row.kind === "project" || row.parent === null || !ids.has(row.parent))
    .map((row) =>
      rowOf(
        row,
        all.filter((child) => child.kind === "worktree" && child.parent === row.id && row.kind === "project").map((child) => rowOf(child, [])),
      ),
    );
  return { purging: settings.purging, graceDays: settings.graceDays, graceMs: settings.graceMs, overridden: settings.overridden, purgingSince, rows };
};

/** The dry Sweep as the page's preview shows it (ADR-0044 §1). */
export interface SweepPreview {
  readonly ok: boolean;
  readonly purging: boolean;
  readonly summary: string;
  readonly rows: ReadonlyArray<{ readonly id: string; readonly action: SweepAction["action"]; readonly why: string }>;
  /** Deleted threads whose Sessions it would destroy. */
  readonly sessions: ReadonlyArray<string>;
  /** Containers no Workspace holds that it would stop (their DO ids). */
  readonly containers: ReadonlyArray<string>;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const sweepPreview = (report: SweepReport): SweepPreview => {
  const rows = report.actions.map(({ id, action, why }) => ({ id, action, why }));
  const sessions = report.sessions ?? [];
  const containers = report.costGuard.map((entry) => entry.holder);
  const workspaces = count(report.dry ? rows.filter((row) => row.action === "purge").length : report.purged.filter((entry) => entry.destroyed).length, "Workspace", "Workspaces");
  const stopped = count(report.dry ? containers.length : report.costGuard.filter((entry) => entry.action === "stopped").length, "Container", "Containers");
  // With purging off, the Sweep still finishes a Purge under way (a `deleting` row, ADR-0043 §4), with its Sessions.
  const finishing = rows.filter((row) => row.action === "purge").length;
  const off =
    finishing === 0
      ? "Purging is off: the Sweep would purge nothing and destroy no Session."
      : `Purging is off: the Sweep would start no Purge and destroy no Session on its own; it would finish purging ${count(finishing, "Workspace", "Workspaces")} left purging, with ${finishing === 1 ? "its" : "their"} deleted threads' Sessions.`;
  const summary = !report.ok
    ? (report.error ?? "the Sweep's read failed")
    : !report.dry
      ? `The Sweep purged ${workspaces}, destroyed ${count(sessions.length, "Session", "Sessions")} and stopped ${stopped}.`
      : report.purging
        ? `The Sweep would purge ${workspaces}, destroy ${count(sessions.length, "Session", "Sessions")} and stop ${stopped}.`
        : `${off}${containers.length === 0 ? "" : ` It would stop ${stopped} no Workspace holds.`}`;
  return { ok: report.ok, purging: report.purging, summary, rows, sessions, containers };
};
