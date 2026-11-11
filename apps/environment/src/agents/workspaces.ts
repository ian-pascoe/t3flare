// @effect-diagnostics globalDate:off
// The Cloud Environment's Workspaces (ADR-0008; step 2a plan, section 2): a small table of our own beside t3's, in the
// Environment DO's SQLite. It answers `/w` listings, whether a `/w/<id>` path exists at all (an unlisted id never
// reaches a Durable Object), and which repo a Workspace's GitHub tokens may name.
//
// Step 2b adds worktree Workspaces (`.wt/<project dir>/<dir>`, kind `worktree`, with their project as `parent`) and the
// deletion states (plan section 5): only `provisioning` and `ready` resolve for t3's paths; `deleting` and `tombstoned`
// are "No such file or directory" to t3 at once, and stay listed here until the purge or the restore.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { isWorkspaceId, isWorktreeId } from "@t3flare/workspace-client";

export type WorkspaceState = "provisioning" | "ready" | "failed" | "deleting" | "tombstoned";
export type WorkspaceKind = "project" | "worktree";

export interface WorkspaceRecord {
  readonly id: string;
  readonly host: string | null;
  readonly owner: string | null;
  readonly name: string | null;
  readonly cloneUrl: string | null;
  readonly createdAt: number;
  readonly state: WorkspaceState;
  /** The owner opted this Workspace in to `workflows: write` on its Container tokens (ADR-0013 refinement). */
  readonly workflows: boolean;
  readonly kind: WorkspaceKind;
  /** A worktree's project Workspace. */
  readonly parent: string | null;
  /** A worktree's branch. */
  readonly branch: string | null;
  /** When the sweep first found nothing referencing it. */
  readonly unreferencedSince: number | null;
  readonly deletedAt: number | null;
  readonly purgeAfter: number | null;
  readonly lastError: string | null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS t3flare_workspaces (
  id TEXT PRIMARY KEY,
  host TEXT,
  owner TEXT,
  name TEXT,
  clone_url TEXT,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  workflows INTEGER NOT NULL DEFAULT 0
)`;

/** Step 2b's columns, added to a step-2a table in place (idempotent). */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["kind", "TEXT NOT NULL DEFAULT 'project'"],
  ["parent", "TEXT"],
  ["branch", "TEXT"],
  ["unreferenced_since", "INTEGER"],
  ["deleted_at", "INTEGER"],
  ["purge_after", "INTEGER"],
  ["last_error", "TEXT"],
];

type Row = {
  id: string;
  host: string | null;
  owner: string | null;
  name: string | null;
  clone_url: string | null;
  created_at: number;
  state: string;
  workflows: number;
  kind: string;
  parent: string | null;
  branch: string | null;
  unreferenced_since: number | null;
  deleted_at: number | null;
  purge_after: number | null;
  last_error: string | null;
};

const record = (row: Row): WorkspaceRecord => ({
  id: row.id,
  host: row.host,
  owner: row.owner,
  name: row.name,
  cloneUrl: row.clone_url,
  createdAt: row.created_at,
  state: row.state as WorkspaceState,
  workflows: row.workflows === 1,
  kind: row.kind === "worktree" ? "worktree" : "project",
  parent: row.parent,
  branch: row.branch,
  unreferencedSince: row.unreferenced_since,
  deletedAt: row.deleted_at,
  purgeAfter: row.purge_after,
  lastError: row.last_error,
});

/** Whether t3's paths resolve to the Workspace (plan section 3.5). */
export const resolves = (record: WorkspaceRecord): boolean => record.state === "provisioning" || record.state === "ready";

export const migrateWorkspaceRegistry = (sql: SqlStorage): void => {
  sql.exec(SCHEMA);
  const columns = new Set(sql.exec<{ name: string }>("PRAGMA table_info(t3flare_workspaces)").toArray().map((column) => column.name));
  const first = !columns.has("kind");
  for (const [name, type] of ADDED_COLUMNS) if (!columns.has(name)) sql.exec(`ALTER TABLE t3flare_workspaces ADD COLUMN ${name} ${type}`);
  // Step 2a left a New project's empty folder `provisioning` for good; step 2b's sweep purges stale `provisioning` rows.
  if (first) sql.exec("UPDATE t3flare_workspaces SET state = 'ready' WHERE state = 'provisioning'");
};

export const workspaceRegistry = (sql: SqlStorage) => {
  let ready = false;
  const ensure = () => {
    if (!ready) migrateWorkspaceRegistry(sql);
    ready = true;
  };
  const get = (id: string): WorkspaceRecord | undefined => {
    ensure();
    const row = sql.exec<Row>("SELECT * FROM t3flare_workspaces WHERE id = ?", id).toArray()[0];
    return row === undefined ? undefined : record(row);
  };
  return {
    list(): ReadonlyArray<WorkspaceRecord> {
      ensure();
      return sql.exec<Row>("SELECT * FROM t3flare_workspaces ORDER BY id").toArray().map(record);
    },
    get,
    /** The Workspace only when t3's paths resolve to it (`provisioning` or `ready`). */
    resolve(id: string): WorkspaceRecord | undefined {
      const found = get(id);
      return found !== undefined && resolves(found) ? found : undefined;
    },
    /** The project Workspaces `/w` lists (worktrees live under `/w/.wt`). */
    projects(): ReadonlyArray<WorkspaceRecord> {
      return this.list().filter((ws) => ws.kind === "project" && resolves(ws));
    },
    /** A project's worktree Workspaces that resolve. */
    worktreesOf(parent: string): ReadonlyArray<WorkspaceRecord> {
      return this.list().filter((ws) => ws.kind === "worktree" && ws.parent === parent && resolves(ws));
    },
    /** Registers a Workspace being provisioned; refuses an id in use or not a valid id. */
    create(input: { readonly id: string; readonly host?: string | null; readonly owner?: string | null; readonly name?: string | null; readonly cloneUrl?: string | null }): WorkspaceRecord {
      ensure();
      if (!isWorkspaceId(input.id)) throw new Error(`t3flare: "${input.id}" is not a Workspace name (letters, digits, ".", "_", "-")`);
      if (get(input.id) !== undefined) throw new Error(`t3flare: the Workspace /w/${input.id} exists`);
      sql.exec(
        "INSERT INTO t3flare_workspaces (id, host, owner, name, clone_url, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'provisioning')",
        input.id,
        input.host ?? null,
        input.owner?.toLowerCase() ?? null,
        input.name ?? null,
        input.cloneUrl ?? null,
        Date.now(),
      );
      return get(input.id)!;
    },
    /** Registers a worktree Workspace of `parent` being provisioned: the parent's remote and `workflows` opt-in. */
    createWorktree(input: { readonly id: string; readonly parent: WorkspaceRecord; readonly branch: string }): WorkspaceRecord {
      ensure();
      if (!isWorktreeId(input.id)) throw new Error(`t3flare: "${input.id}" is not a worktree Workspace name`);
      if (get(input.id) !== undefined) throw new Error(`t3flare: the Workspace /w/${input.id} exists`);
      const parent = input.parent;
      sql.exec(
        "INSERT INTO t3flare_workspaces (id, host, owner, name, clone_url, created_at, state, workflows, kind, parent, branch) VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?, 'worktree', ?, ?)",
        input.id,
        parent.host,
        parent.owner,
        parent.name,
        parent.cloneUrl,
        Date.now(),
        parent.workflows ? 1 : 0,
        parent.id,
        input.branch,
      );
      return get(input.id)!;
    },
    /** Names the repo a Workspace made empty (a project folder t3 created first) is cloned from. */
    setRemote(id: string, remote: { readonly host: string | null; readonly owner: string | null; readonly name: string | null; readonly cloneUrl: string | null }): void {
      ensure();
      sql.exec(
        "UPDATE t3flare_workspaces SET host = ?, owner = ?, name = ?, clone_url = ? WHERE id = ?",
        remote.host,
        remote.owner?.toLowerCase() ?? null,
        remote.name,
        remote.cloneUrl,
        id,
      );
    },
    setState(id: string, state: WorkspaceState, fields: { readonly deletedAt?: number | null; readonly purgeAfter?: number | null; readonly lastError?: string | null } = {}): void {
      ensure();
      sql.exec("UPDATE t3flare_workspaces SET state = ? WHERE id = ?", state, id);
      if (fields.deletedAt !== undefined) sql.exec("UPDATE t3flare_workspaces SET deleted_at = ? WHERE id = ?", fields.deletedAt, id);
      if (fields.purgeAfter !== undefined) sql.exec("UPDATE t3flare_workspaces SET purge_after = ? WHERE id = ?", fields.purgeAfter, id);
      if (fields.lastError !== undefined) sql.exec("UPDATE t3flare_workspaces SET last_error = ? WHERE id = ?", fields.lastError, id);
    },
    setBranch(id: string, branch: string | null): void {
      ensure();
      sql.exec("UPDATE t3flare_workspaces SET branch = ? WHERE id = ?", branch, id);
    },
    setUnreferencedSince(id: string, at: number | null): void {
      ensure();
      sql.exec("UPDATE t3flare_workspaces SET unreferenced_since = ? WHERE id = ?", at, id);
    },
    setLastError(id: string, error: string | null): void {
      ensure();
      sql.exec("UPDATE t3flare_workspaces SET last_error = ? WHERE id = ?", error === null ? null : error.slice(0, 1000), id);
    },
    remove(id: string): void {
      ensure();
      sql.exec("DELETE FROM t3flare_workspaces WHERE id = ?", id);
    },
    setWorkflows(id: string, on: boolean): void {
      ensure();
      sql.exec("UPDATE t3flare_workspaces SET workflows = ? WHERE id = ?", on ? 1 : 0, id);
    },
  };
};

export type WorkspaceRegistry = ReturnType<typeof workspaceRegistry>;
