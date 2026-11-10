// @effect-diagnostics globalDate:off
// The Cloud Environment's Workspaces (ADR-0008; step 2a plan, section 2): a small table of our own beside t3's, in the
// Environment DO's SQLite. It answers `/w` listings, whether a `/w/<id>` path exists at all (an unlisted id never
// reaches a Durable Object), and which repo a Workspace's GitHub tokens may name.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { isWorkspaceId } from "@t3flare/workspace-client";

export interface WorkspaceRecord {
  readonly id: string;
  readonly host: string | null;
  readonly owner: string | null;
  readonly name: string | null;
  readonly cloneUrl: string | null;
  readonly createdAt: number;
  readonly state: "provisioning" | "ready" | "failed";
  /** The owner opted this Workspace in to `workflows: write` on its Container tokens (ADR-0013 refinement). */
  readonly workflows: boolean;
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

type Row = {
  id: string;
  host: string | null;
  owner: string | null;
  name: string | null;
  clone_url: string | null;
  created_at: number;
  state: string;
  workflows: number;
};

const record = (row: Row): WorkspaceRecord => ({
  id: row.id,
  host: row.host,
  owner: row.owner,
  name: row.name,
  cloneUrl: row.clone_url,
  createdAt: row.created_at,
  state: row.state as WorkspaceRecord["state"],
  workflows: row.workflows === 1,
});

export const workspaceRegistry = (sql: SqlStorage) => {
  let ready = false;
  const ensure = () => {
    if (!ready) sql.exec(SCHEMA);
    ready = true;
  };
  return {
    list(): ReadonlyArray<WorkspaceRecord> {
      ensure();
      return sql.exec<Row>("SELECT * FROM t3flare_workspaces ORDER BY id").toArray().map(record);
    },
    get(id: string): WorkspaceRecord | undefined {
      ensure();
      const row = sql.exec<Row>("SELECT * FROM t3flare_workspaces WHERE id = ?", id).toArray()[0];
      return row === undefined ? undefined : record(row);
    },
    /** Registers a Workspace being provisioned; refuses an id in use or not a valid id. */
    create(input: { readonly id: string; readonly host?: string | null; readonly owner?: string | null; readonly name?: string | null; readonly cloneUrl?: string | null }): WorkspaceRecord {
      ensure();
      if (!isWorkspaceId(input.id)) throw new Error(`t3flare: "${input.id}" is not a Workspace name (letters, digits, ".", "_", "-")`);
      if (this.get(input.id) !== undefined) throw new Error(`t3flare: the Workspace /w/${input.id} exists`);
      sql.exec(
        "INSERT INTO t3flare_workspaces (id, host, owner, name, clone_url, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'provisioning')",
        input.id,
        input.host ?? null,
        input.owner?.toLowerCase() ?? null,
        input.name ?? null,
        input.cloneUrl ?? null,
        Date.now(),
      );
      return this.get(input.id)!;
    },
    setState(id: string, state: WorkspaceRecord["state"]): void {
      ensure();
      sql.exec("UPDATE t3flare_workspaces SET state = ? WHERE id = ?", state, id);
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
