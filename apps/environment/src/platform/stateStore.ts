// @effect-diagnostics extendsNativeError:off globalDate:off globalRandom:off
// The State directory as a file system in Durable Object SQLite (ADR-0007).
//
// One row per file, directory or symlink in `t3flare_files`. DO SQLite's API is synchronous, so this backs
// both t3's synchronous `node:fs` calls (through the import-scoped Build shim, ../shims/node-fs.ts) and the
// Effect `FileSystem` Layer (./fileSystem.ts). A file up to CHUNK_BYTES keeps its bytes in its own row; a
// larger one keeps them in `t3flare_file_chunks`, CHUNK_BYTES per row, because DO SQLite refuses rows and
// BLOBs over 8 MB.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

import { migrate, type Migration } from "./migrate.ts";

/** Bytes per stored row: half of DO SQLite's 8 MB row limit. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

export interface Entry {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink";
  readonly size: number;
  readonly target: string | null;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}

export type FsErrorCode = "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL" | "ENOSYS";

const ERRNO: Record<FsErrorCode, number> = {
  ENOENT: -2,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  ENOTEMPTY: -39,
  EINVAL: -22,
  ENOSYS: -38,
};

/** A Node-style system error (`code`, `errno`, `syscall`, `path`), as t3's callers check them. */
export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly errno: number;
  readonly syscall: string;
  readonly path: string;
  constructor(code: FsErrorCode, syscall: string, path: string) {
    super(`${code}: ${syscall} '${path}'`);
    this.code = code;
    this.errno = ERRNO[code];
    this.syscall = syscall;
    this.path = path;
  }
}

/**
 * The State directory's tables. Step 1 is the spike's schema, unchanged so a spike-era object keeps its
 * files; step 2 adds sizes and chunks.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS t3flare_files (
      path TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      kind TEXT NOT NULL,
      data BLOB,
      target TEXT,
      mode INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      birthtime_ms INTEGER NOT NULL
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS t3flare_files_parent ON t3flare_files(parent)`);
  },
  (sql) => {
    // `chunks` is 0 for a file whose bytes are in `data`, else the number of rows in t3flare_file_chunks.
    sql.exec(`ALTER TABLE t3flare_files ADD COLUMN size INTEGER NOT NULL DEFAULT 0`);
    sql.exec(`ALTER TABLE t3flare_files ADD COLUMN chunks INTEGER NOT NULL DEFAULT 0`);
    sql.exec(`UPDATE t3flare_files SET size = COALESCE(length(data), 0)`);
    sql.exec(`CREATE TABLE t3flare_file_chunks (
      path TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (path, idx)
    )`);
  },
];

let sql: SqlStorage | undefined;

/** The storage `bindStateStorage` needs: SQLite, and a synchronous transaction for migrations and writes. */
export interface StateStorage {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
}

let transactionSync: StateStorage["transactionSync"] = (closure) => closure();

/** Called by the Environment DO's constructor, before any t3 code runs. */
export const bindStateStorage = (storage: StateStorage) => {
  sql = storage.sql;
  transactionSync = storage.transactionSync;
  migrate(storage, "state-directory", MIGRATIONS);
  if (get("/") === undefined) insertMeta("/", "dir", null, 0o755);
};

const db = () => {
  if (sql === undefined) throw new Error("State storage is not bound");
  return sql;
};

export const normalize = (input: string | URL): string => {
  const raw = typeof input === "string" ? input : input.pathname;
  const parts: Array<string> = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

export const parentOf = (path: string) => {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

type Row = {
  path: string;
  kind: Entry["kind"];
  size: number;
  target: string | null;
  mode: number;
  mtime_ms: number;
  birthtime_ms: number;
};

/**
 * Paths under `/w` that reached the State directory: t3 code calling `node:fs` on a Workspace path (step 2a plan,
 * section 1: the `node:fs` audit). The routing FileSystem never sends `/w` here, so each one is a Shadow candidate;
 * they read as missing and are never created.
 */
const wAccesses = new Map<string, { count: number; sample: string }>();
export const workspacePathAccesses = () => Object.fromEntries(wAccesses);
const isUnderW = (path: string) => path === "/w" || path.startsWith("/w/");
const noteW = (method: string, path: string) => {
  const stack = new Error("t3flare: node:fs on a Workspace path").stack?.split("\n").slice(2, 7).join(" | ") ?? "";
  const key = `${method} ${stack}`.slice(0, 400);
  const seen = wAccesses.get(key);
  if (seen === undefined) wAccesses.set(key, { count: 1, sample: path });
  else seen.count++;
};

export const get = (input: string): Entry | undefined => {
  const path = normalize(input);
  if (isUnderW(path)) {
    noteW("get", path);
    return undefined;
  }
  const row = db()
    .exec<Row>(`SELECT path, kind, size, target, mode, mtime_ms, birthtime_ms FROM t3flare_files WHERE path = ?`, path)
    .toArray()[0];
  if (row === undefined) return undefined;
  return {
    path: row.path,
    kind: row.kind,
    size: row.size,
    target: row.target,
    mode: row.mode,
    mtimeMs: row.mtime_ms,
    birthtimeMs: row.birthtime_ms,
  };
};

/** Follows symlinks to the entry they name. */
export const resolve = (input: string, depth = 0): Entry | undefined => {
  const entry = get(input);
  if (entry?.kind === "symlink" && entry.target !== null && depth < 16) {
    const target = entry.target.startsWith("/") ? entry.target : `${parentOf(entry.path)}/${entry.target}`;
    return resolve(target, depth + 1);
  }
  return entry;
};

/** Creates or replaces an entry's metadata row; a file's bytes are written by `storeBytes`. */
const insertMeta = (path: string, kind: Entry["kind"], target: string | null, mode: number) => {
  if (isUnderW(path)) {
    noteW("create", path);
    throw new FsError("ENOENT", "create", path);
  }
  const now = Date.now();
  db().exec(
    `INSERT INTO t3flare_files (path, parent, kind, data, target, mode, mtime_ms, birthtime_ms, size, chunks)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, data = NULL, target = excluded.target,
       mtime_ms = excluded.mtime_ms, size = 0, chunks = 0`,
    path,
    parentOf(path),
    kind,
    target,
    mode,
    now,
    now,
  );
};

const dropChunks = (path: string) => db().exec(`DELETE FROM t3flare_file_chunks WHERE path = ?`, path);

/** Writes a file's whole contents: inline up to CHUNK_BYTES, in chunk rows above. */
const storeBytes = (path: string, data: Uint8Array, mode: number) => {
  transactionSync(() => {
    const now = Date.now();
    dropChunks(path);
    const chunked = data.byteLength > CHUNK_BYTES;
    const chunks = chunked ? Math.ceil(data.byteLength / CHUNK_BYTES) : 0;
    db().exec(
      `INSERT INTO t3flare_files (path, parent, kind, data, target, mode, mtime_ms, birthtime_ms, size, chunks)
       VALUES (?, ?, 'file', ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET kind = 'file', data = excluded.data, target = NULL,
         mtime_ms = excluded.mtime_ms, size = excluded.size, chunks = excluded.chunks`,
      path,
      parentOf(path),
      chunked ? null : data,
      mode,
      now,
      now,
      data.byteLength,
      chunks,
    );
    for (let idx = 0; idx < chunks; idx++) {
      db().exec(
        `INSERT INTO t3flare_file_chunks (path, idx, data) VALUES (?, ?, ?)`,
        path,
        idx,
        data.subarray(idx * CHUNK_BYTES, Math.min(data.byteLength, (idx + 1) * CHUNK_BYTES)),
      );
    }
  });
};

/** The bytes of the file at `path` (already resolved), between `start` and `end`. */
const loadBytes = (path: string, start = 0, end = Number.POSITIVE_INFINITY): Uint8Array => {
  const row = db()
    .exec<{ data: ArrayBuffer | null; size: number; chunks: number }>(
      `SELECT data, size, chunks FROM t3flare_files WHERE path = ?`,
      path,
    )
    .toArray()[0];
  if (row === undefined) return new Uint8Array(0);
  const from = Math.max(0, Math.min(start, row.size));
  const to = Math.max(from, Math.min(end, row.size));
  if (row.chunks === 0) return new Uint8Array(row.data ?? new ArrayBuffer(0)).slice(from, to);
  const out = new Uint8Array(to - from);
  if (to === from) return out;
  const first = Math.floor(from / CHUNK_BYTES);
  const last = Math.floor((to - 1) / CHUNK_BYTES);
  const rows = db()
    .exec<{ idx: number; data: ArrayBuffer }>(
      `SELECT idx, data FROM t3flare_file_chunks WHERE path = ? AND idx BETWEEN ? AND ? ORDER BY idx`,
      path,
      first,
      last,
    )
    .toArray();
  for (const chunk of rows) {
    const chunkStart = chunk.idx * CHUNK_BYTES;
    const bytes = new Uint8Array(chunk.data);
    const sliceFrom = Math.max(from, chunkStart) - chunkStart;
    const sliceTo = Math.min(to, chunkStart + bytes.byteLength) - chunkStart;
    out.set(bytes.subarray(sliceFrom, sliceTo), chunkStart + sliceFrom - from);
  }
  return out;
};

const requireParentDir = (path: string, syscall: string) => {
  const parent = resolve(parentOf(path));
  if (parent === undefined) throw new FsError("ENOENT", syscall, path);
  if (parent.kind !== "dir") throw new FsError("ENOTDIR", syscall, path);
};

export const mkdir = (
  input: string,
  options: { readonly recursive?: boolean | undefined; readonly mode?: number | undefined } = {},
): string | undefined => {
  const path = normalize(input);
  const existing = resolve(path);
  if (existing !== undefined) {
    if (options.recursive && existing.kind === "dir") return undefined;
    throw new FsError("EEXIST", "mkdir", path);
  }
  if (options.recursive) {
    let first: string | undefined;
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current += `/${part}`;
      const entry = resolve(current);
      if (entry === undefined) {
        insertMeta(current, "dir", null, options.mode ?? 0o755);
        first ??= current;
      } else if (entry.kind !== "dir") {
        throw new FsError("ENOTDIR", "mkdir", current);
      }
    }
    return first;
  }
  requireParentDir(path, "mkdir");
  insertMeta(path, "dir", null, options.mode ?? 0o755);
  return undefined;
};

export const writeFile = (
  input: string,
  data: Uint8Array,
  options: {
    readonly append?: boolean | undefined;
    readonly exclusive?: boolean | undefined;
    readonly mode?: number | undefined;
  } = {},
) => {
  const path = normalize(input);
  const existing = resolve(path);
  if (existing?.kind === "dir") throw new FsError("EISDIR", "open", path);
  if (existing !== undefined && options.exclusive) throw new FsError("EEXIST", "open", path);
  if (existing === undefined) requireParentDir(path, "open");
  const target = existing?.path ?? path;
  if (options.append && existing !== undefined && existing.size > 0) {
    const before = loadBytes(target);
    const joined = new Uint8Array(before.byteLength + data.byteLength);
    joined.set(before, 0);
    joined.set(data, before.byteLength);
    storeBytes(target, joined, existing.mode);
  } else {
    storeBytes(target, data, existing?.mode ?? options.mode ?? 0o644);
  }
};

export const readFile = (input: string): Uint8Array => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "open", path);
  if (entry.kind === "dir") throw new FsError("EISDIR", "read", path);
  return loadBytes(entry.path);
};

/** `length` bytes of a file from `position`, reading only the chunks they lie in. */
export const readRange = (input: string, position: number, length: number): Uint8Array => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "read", path);
  if (entry.kind === "dir") throw new FsError("EISDIR", "read", path);
  return loadBytes(entry.path, position, position + length);
};

export const truncate = (input: string, length: number) => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "open", path);
  if (entry.kind === "dir") throw new FsError("EISDIR", "open", path);
  const kept = loadBytes(entry.path, 0, length);
  const bytes = kept.byteLength === length ? kept : new Uint8Array(length);
  if (bytes !== kept) bytes.set(kept);
  storeBytes(entry.path, bytes, entry.mode);
};

export const readdir = (input: string): Array<string> => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "scandir", path);
  if (entry.kind !== "dir") throw new FsError("ENOTDIR", "scandir", path);
  return db()
    .exec<{ path: string }>(`SELECT path FROM t3flare_files WHERE parent = ? AND path != '/' ORDER BY path`, entry.path)
    .toArray()
    .map((row) => row.path.slice(row.path.lastIndexOf("/") + 1));
};

// DO SQLite refuses LIKE patterns over 50 bytes, so a subtree is the key range between `dir/` and `dir0`
// ('0' sorts right after '/').
const descendants = (dir: string): [string, string] => (dir === "/" ? ["/", "0"] : [`${dir}/`, `${dir}0`]);

export const remove = (
  input: string,
  options: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined } = {},
) => {
  const path = normalize(input);
  const entry = get(path);
  if (entry === undefined) {
    if (options.force) return;
    throw new FsError("ENOENT", "rm", path);
  }
  if (entry.kind === "dir") {
    const children = db().exec(`SELECT 1 FROM t3flare_files WHERE parent = ? LIMIT 1`, path).toArray();
    if (children.length > 0 && !options.recursive) throw new FsError("ENOTEMPTY", "rmdir", path);
    transactionSync(() => {
      db().exec(`DELETE FROM t3flare_file_chunks WHERE path = ? OR (path > ? AND path < ?)`, path, ...descendants(path));
      db().exec(`DELETE FROM t3flare_files WHERE path = ? OR (path > ? AND path < ?)`, path, ...descendants(path));
    });
    return;
  }
  transactionSync(() => {
    dropChunks(path);
    db().exec(`DELETE FROM t3flare_files WHERE path = ?`, path);
  });
};

export const rename = (fromInput: string, toInput: string) => {
  const from = normalize(fromInput);
  const to = normalize(toInput);
  const entry = get(from);
  if (entry === undefined) throw new FsError("ENOENT", "rename", from);
  if (from === to) return;
  requireParentDir(to, "rename");
  const existing = get(to);
  if (existing?.kind === "dir" && entry.kind !== "dir") throw new FsError("EISDIR", "rename", to);
  transactionSync(() => {
    remove(to, { recursive: true, force: true });
    const rows = db()
      .exec<{ path: string }>(
        `SELECT path FROM t3flare_files WHERE path = ? OR (path > ? AND path < ?)`,
        from,
        ...descendants(from),
      )
      .toArray();
    for (const row of rows) {
      const next = to + row.path.slice(from.length);
      db().exec(`UPDATE t3flare_files SET path = ?, parent = ? WHERE path = ?`, next, parentOf(next), row.path);
      db().exec(`UPDATE t3flare_file_chunks SET path = ? WHERE path = ?`, next, row.path);
    }
  });
};

export const symlink = (target: string, input: string) => {
  const path = normalize(input);
  if (get(path) !== undefined) throw new FsError("EEXIST", "symlink", path);
  requireParentDir(path, "symlink");
  insertMeta(path, "symlink", target, 0o777);
};

export const chmod = (input: string, mode: number) => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "chmod", path);
  db().exec(`UPDATE t3flare_files SET mode = ? WHERE path = ?`, mode, entry.path);
};

export const utimes = (input: string, mtimeMs: number) => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "utime", path);
  db().exec(`UPDATE t3flare_files SET mtime_ms = ? WHERE path = ?`, Math.trunc(mtimeMs), entry.path);
};

let tempCounter = 0;
export const tempName = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(tempCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Totals for the admin health route. */
export const usage = () =>
  db()
    .exec<{ files: number; bytes: number; chunked: number }>(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(chunks > 0), 0) AS chunked
       FROM t3flare_files WHERE kind = 'file'`,
    )
    .toArray()[0];
