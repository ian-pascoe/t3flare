// @effect-diagnostics extendsNativeError:off globalDate:off globalRandom:off
// The State directory as a file system in Durable Object SQLite (ADR-0007).
//
// One row per file or directory. DO SQLite's API is synchronous, so this backs both t3's
// synchronous `node:fs` calls (through the import-scoped alias, ../shims/node-fs.ts) and
// the Effect `FileSystem` Layer (./fileSystem.ts). Files are one row each; the spike does
// not chunk files above the 8 MB row limit (step 1 does).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export interface Entry {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink";
  readonly data: Uint8Array | null;
  readonly target: string | null;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}

export class FsError extends Error {
  readonly code: string;
  readonly errno: number;
  readonly syscall: string;
  readonly path: string;
  constructor(code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL" | "ENOSYS", syscall: string, path: string) {
    super(`${code}: ${syscall} '${path}'`);
    this.code = code;
    this.errno = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EINVAL: -22, ENOSYS: -38 }[code];
    this.syscall = syscall;
    this.path = path;
  }
}

let sql: SqlStorage | undefined;

/** Called by the Environment DO's constructor, before any t3 code runs. */
export const bindStateStorage = (storage: SqlStorage) => {
  sql = storage;
  storage.exec(`CREATE TABLE IF NOT EXISTS t3flare_files (
    path TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    kind TEXT NOT NULL,
    data BLOB,
    target TEXT,
    mode INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    birthtime_ms INTEGER NOT NULL
  )`);
  storage.exec(`CREATE INDEX IF NOT EXISTS t3flare_files_parent ON t3flare_files(parent)`);
  if (get("/") === undefined) insert("/", "dir", null, null, 0o755);
};

const db = () => {
  if (sql === undefined) throw new Error("State storage is not bound");
  return sql;
};

export const normalize = (input: string | URL): string => {
  const raw = typeof input === "string" ? input : input.pathname;
  const parts: string[] = [];
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

const toBytes = (value: ArrayBuffer | null): Uint8Array | null =>
  value === null ? null : new Uint8Array(value);

export const get = (input: string): Entry | undefined => {
  const path = normalize(input);
  const row = db()
    .exec<{
      path: string;
      kind: Entry["kind"];
      data: ArrayBuffer | null;
      target: string | null;
      mode: number;
      mtime_ms: number;
      birthtime_ms: number;
    }>(`SELECT path, kind, data, target, mode, mtime_ms, birthtime_ms FROM t3flare_files WHERE path = ?`, path)
    .toArray()[0];
  if (row === undefined) return undefined;
  return {
    path: row.path,
    kind: row.kind,
    data: toBytes(row.data),
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

const insert = (path: string, kind: Entry["kind"], data: Uint8Array | null, target: string | null, mode: number) => {
  const now = Date.now();
  db().exec(
    `INSERT INTO t3flare_files (path, parent, kind, data, target, mode, mtime_ms, birthtime_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, data = excluded.data, target = excluded.target, mtime_ms = excluded.mtime_ms`,
    path,
    parentOf(path),
    kind,
    data,
    target,
    mode,
    now,
    now,
  );
};

const requireParentDir = (path: string, syscall: string) => {
  const parent = resolve(parentOf(path));
  if (parent === undefined) throw new FsError("ENOENT", syscall, path);
  if (parent.kind !== "dir") throw new FsError("ENOTDIR", syscall, path);
};

export const mkdir = (input: string, options: { readonly recursive?: boolean | undefined; readonly mode?: number | undefined } = {}): string | undefined => {
  const path = normalize(input);
  const existing = resolve(path);
  if (existing !== undefined) {
    if (options.recursive && existing.kind === "dir") return undefined;
    throw new FsError("EEXIST", "mkdir", path);
  }
  if (options.recursive) {
    let first: string | undefined;
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      const entry = resolve(current);
      if (entry === undefined) {
        insert(current, "dir", null, null, options.mode ?? 0o755);
        first ??= current;
      } else if (entry.kind !== "dir") {
        throw new FsError("ENOTDIR", "mkdir", current);
      }
    }
    return first;
  }
  requireParentDir(path, "mkdir");
  insert(path, "dir", null, null, options.mode ?? 0o755);
  return undefined;
};

export const writeFile = (input: string, data: Uint8Array, options: { readonly append?: boolean | undefined; readonly exclusive?: boolean | undefined; readonly mode?: number | undefined } = {}) => {
  const path = normalize(input);
  const existing = resolve(path);
  if (existing?.kind === "dir") throw new FsError("EISDIR", "open", path);
  if (existing !== undefined && options.exclusive) throw new FsError("EEXIST", "open", path);
  if (existing === undefined) requireParentDir(path, "open");
  const target = existing?.path ?? path;
  if (options.append && existing?.data) {
    const joined = new Uint8Array(existing.data.byteLength + data.byteLength);
    joined.set(existing.data, 0);
    joined.set(data, existing.data.byteLength);
    insert(target, "file", joined, null, existing.mode);
  } else {
    insert(target, "file", data, null, existing?.mode ?? options.mode ?? 0o644);
  }
};

export const readFile = (input: string): Uint8Array => {
  const path = normalize(input);
  const entry = resolve(path);
  if (entry === undefined) throw new FsError("ENOENT", "open", path);
  if (entry.kind === "dir") throw new FsError("EISDIR", "read", path);
  return entry.data ?? new Uint8Array(0);
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

export const remove = (input: string, options: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined } = {}) => {
  const path = normalize(input);
  const entry = get(path);
  if (entry === undefined) {
    if (options.force) return;
    throw new FsError("ENOENT", "rm", path);
  }
  if (entry.kind === "dir") {
    const children = db().exec(`SELECT 1 FROM t3flare_files WHERE parent = ? LIMIT 1`, path).toArray();
    if (children.length > 0 && !options.recursive) throw new FsError("ENOTEMPTY", "rmdir", path);
    db().exec(`DELETE FROM t3flare_files WHERE path = ? OR (path > ? AND path < ?)`, path, ...descendants(path));
    return;
  }
  db().exec(`DELETE FROM t3flare_files WHERE path = ?`, path);
};

// DO SQLite rejects LIKE patterns longer than a few dozen bytes ("LIKE or GLOB pattern too
// complex"), so a subtree is the key range between `dir/` and `dir0` ('0' follows '/').
const descendants = (dir: string): [string, string] => (dir === "/" ? ["/", "0"] : [`${dir}/`, `${dir}0`]);

export const rename = (fromInput: string, toInput: string) => {
  const from = normalize(fromInput);
  const to = normalize(toInput);
  const entry = get(from);
  if (entry === undefined) throw new FsError("ENOENT", "rename", from);
  requireParentDir(to, "rename");
  const existing = get(to);
  if (existing?.kind === "dir" && entry.kind !== "dir") throw new FsError("EISDIR", "rename", to);
  remove(to, { recursive: true, force: true });
  const rows = db()
    .exec<{ path: string }>(`SELECT path FROM t3flare_files WHERE path = ? OR (path > ? AND path < ?)`, from, ...descendants(from))
    .toArray();
  for (const row of rows) {
    const next = to + row.path.slice(from.length);
    db().exec(`UPDATE t3flare_files SET path = ?, parent = ? WHERE path = ?`, next, parentOf(next), row.path);
  }
};

export const symlink = (target: string, input: string) => {
  const path = normalize(input);
  if (get(path) !== undefined) throw new FsError("EEXIST", "symlink", path);
  requireParentDir(path, "symlink");
  insert(path, "symlink", null, target, 0o777);
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
