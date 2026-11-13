// G11's two records in the Environment DO's SQLite (ADR-0031), outside t3's `FileSystem` (review L4):
//
// - the Browser Run sessions this Environment acquired, so that a new instance closes the ones the last left behind
//   (review M5: never `listSessions`, which is account-wide), and
// - each server-browser profile's `storageState` (cookies, localStorage, IndexedDB): what stock keeps in its profile
//   directory. A profile is kept in 1 MiB rows (a DO SQLite row holds at most 2 MB) and refused over 8 MiB.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const PROFILE_MAX_BYTES = 8 * 1024 * 1024;
/** At most 1.5 MB of UTF-8 a row (3 bytes a UTF-16 unit at most), under DO SQLite's 2 MB. */
const PROFILE_CHUNK_CHARS = 512 * 1024;

/** `state` in rows of at most PROFILE_CHUNK_CHARS, never splitting a surrogate pair. */
export const profileChunks = (state: string): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let at = 0;
  while (at < state.length) {
    let end = Math.min(state.length, at + PROFILE_CHUNK_CHARS);
    const last = state.charCodeAt(end - 1);
    if (end < state.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(state.slice(at, end));
    at = end;
  }
  return chunks;
};

export type PreviewSessionKind = "html" | "workspace" | "shared";

export interface PreviewSessionRecord {
  readonly id: string;
  readonly kind: PreviewSessionKind;
  readonly workspace: string | null;
  readonly openedAt: number;
}

export interface PreviewStore {
  sessionOpened(record: PreviewSessionRecord): void;
  sessionClosed(id: string): void;
  sessions(): ReadonlyArray<PreviewSessionRecord>;
  /** A profile's saved `storageState` JSON, or undefined. */
  profile(profileId: string): string | undefined;
  /** Saves `state` (JSON) for the profile; refused, keeping the last saved, when it is over PROFILE_MAX_BYTES. */
  saveProfile(profileId: string, state: string): "saved" | "too-large";
  clearProfile(profileId: string): void;
}

let ready = new WeakSet<SqlStorage>();

const ensure = (sql: SqlStorage) => {
  if (ready.has(sql)) return;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS t3flare_preview_sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace TEXT, opened_at INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS t3flare_preview_profiles (profile_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (profile_id, seq))",
  );
  ready.add(sql);
};

/** For tests: forget which databases have their tables. */
export const resetPreviewStoreForTests = (): void => {
  ready = new WeakSet();
};

export const previewStore = (sql: SqlStorage): PreviewStore => ({
  sessionOpened(record) {
    ensure(sql);
    sql.exec(
      "INSERT OR REPLACE INTO t3flare_preview_sessions (id, kind, workspace, opened_at) VALUES (?, ?, ?, ?)",
      record.id,
      record.kind,
      record.workspace,
      record.openedAt,
    );
  },
  sessionClosed(id) {
    ensure(sql);
    sql.exec("DELETE FROM t3flare_preview_sessions WHERE id = ?", id);
  },
  sessions() {
    ensure(sql);
    return sql
      .exec<{ id: string; kind: PreviewSessionKind; workspace: string | null; opened_at: number }>(
        "SELECT id, kind, workspace, opened_at FROM t3flare_preview_sessions ORDER BY opened_at",
      )
      .toArray()
      .map((row) => ({ id: row.id, kind: row.kind, workspace: row.workspace, openedAt: row.opened_at }));
  },
  profile(profileId) {
    ensure(sql);
    const rows = sql
      .exec<{ data: string }>("SELECT data FROM t3flare_preview_profiles WHERE profile_id = ? ORDER BY seq", profileId)
      .toArray();
    return rows.length === 0 ? undefined : rows.map((row) => row.data).join("");
  },
  saveProfile(profileId, state) {
    ensure(sql);
    if (new TextEncoder().encode(state).byteLength > PROFILE_MAX_BYTES) return "too-large";
    sql.exec("DELETE FROM t3flare_preview_profiles WHERE profile_id = ?", profileId);
    profileChunks(state).forEach((data, seq) => {
      sql.exec("INSERT INTO t3flare_preview_profiles (profile_id, seq, data) VALUES (?, ?, ?)", profileId, seq, data);
    });
    return "saved";
  },
  clearProfile(profileId) {
    ensure(sql);
    sql.exec("DELETE FROM t3flare_preview_profiles WHERE profile_id = ?", profileId);
  },
});
