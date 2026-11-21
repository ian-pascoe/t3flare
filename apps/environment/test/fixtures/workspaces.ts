// @effect-diagnostics globalDate:off
// The Workspaces section's fixtures (ADR-0044 §1, §2–3): t3's three tables as the reference read and the titles read them,
// a registry row, and the view's dependencies over fixed rows.
import type { SweepSettings } from "../../src/agents/deletionSettings.ts";
import type { WorkspacesDeps } from "../../src/agents/workspaceView.ts";
import type { WorkspaceRecord } from "../../src/agents/workspaces.ts";
import { nodeSqlStorage } from "../nodeSqlStorage.ts";

export const DAY = 24 * 60 * 60_000;
export const GRACE = 7 * DAY;

/** t3's three tables as the reference read and the titles read them. */
export const t3Tables = () => {
  const sql = nodeSqlStorage();
  sql.exec("CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, created_at TEXT, deleted_at TEXT, archived_at TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, deleted_at TEXT, archived_at TEXT, payload_json TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)");
  return sql;
};

export const record = (overrides: Partial<WorkspaceRecord> & Pick<WorkspaceRecord, "id">): WorkspaceRecord => ({
  host: "github.com",
  owner: "acme",
  name: "app",
  cloneUrl: "https://github.com/acme/app.git",
  createdAt: 10 * DAY,
  state: "ready",
  workflows: false,
  kind: "project",
  parent: null,
  branch: null,
  unreferencedSince: null,
  deletedAt: null,
  purgeAfter: null,
  lastError: null,
  ...overrides,
});

export const ON: SweepSettings = { purging: true, graceMs: GRACE, graceDays: 7, overridden: false };

export const viewDeps = (rows: ReadonlyArray<WorkspaceRecord>, options: { readonly settings?: SweepSettings; readonly purgingSince?: number | null; readonly terminals?: Readonly<Record<string, number>>; readonly sql?: ReturnType<typeof t3Tables> } = {}): WorkspacesDeps => ({
  sql: options.sql ?? t3Tables(),
  registry: { list: () => rows, get: (id) => rows.find((row) => row.id === id) },
  settings: () => options.settings ?? ON,
  purgingSince: () => (options.purgingSince === undefined ? 0 : options.purgingSince),
  terminals: async (id) => options.terminals?.[id] ?? 0,
});
