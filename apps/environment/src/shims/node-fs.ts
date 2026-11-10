// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// `node:fs` for t3's own modules (ADR-0007), installed by the import-scoped alias in
// ../../build.ts. The State directory lives in DO SQLite (../platform/stateStore.ts);
// workerd's own `/bundle` and `/dev` stay on its virtual file system. Everything not
// overridden here is workerd's `node:fs`.
import * as real from "node:fs";
import { Buffer } from "node:buffer";

import * as store from "../platform/stateStore.ts";

export * from "node:fs";

const REAL_PREFIXES = ["/bundle", "/dev"];
const isReal = (path: string) => REAL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
const pathOf = (input: unknown): string => {
  if (typeof input === "string") return store.normalize(input);
  if (input instanceof URL) return store.normalize(input.pathname);
  if (Buffer.isBuffer(input)) return store.normalize(input.toString("utf8"));
  throw new TypeError(`Unsupported path ${String(input)}`);
};

const encodingOf = (options: unknown): BufferEncoding | undefined =>
  typeof options === "string" ? (options as BufferEncoding) : ((options as { encoding?: BufferEncoding } | undefined)?.encoding ?? undefined);

const toBytes = (data: unknown, options?: unknown): Uint8Array => {
  if (typeof data === "string") return Buffer.from(data, encodingOf(options) ?? "utf8");
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("Unsupported data");
};

export class Stats {
  dev = 1;
  ino: number;
  mode: number;
  nlink = 1;
  uid = 0;
  gid = 0;
  rdev = 0;
  size: number;
  blksize = 4096;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  #kind: store.Entry["kind"];
  constructor(entry: store.Entry) {
    this.#kind = entry.kind;
    const typeBits = entry.kind === "dir" ? 0o040000 : entry.kind === "symlink" ? 0o120000 : 0o100000;
    this.mode = typeBits | entry.mode;
    this.size = entry.data?.byteLength ?? 0;
    this.blocks = Math.ceil(this.size / 512);
    let hash = 0;
    for (const char of entry.path) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    this.ino = Math.abs(hash);
    this.atimeMs = this.mtimeMs = this.ctimeMs = entry.mtimeMs;
    this.birthtimeMs = entry.birthtimeMs;
    this.atime = this.mtime = this.ctime = new Date(entry.mtimeMs);
    this.birthtime = new Date(entry.birthtimeMs);
  }
  isFile() { return this.#kind === "file"; }
  isDirectory() { return this.#kind === "dir"; }
  isSymbolicLink() { return this.#kind === "symlink"; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

class Dirent {
  name: string;
  parentPath: string;
  path: string;
  #kind: store.Entry["kind"];
  constructor(name: string, parentPath: string, kind: store.Entry["kind"]) {
    this.name = name;
    this.parentPath = this.path = parentPath;
    this.#kind = kind;
  }
  isFile() { return this.#kind === "file"; }
  isDirectory() { return this.#kind === "dir"; }
  isSymbolicLink() { return this.#kind === "symlink"; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

export function existsSync(input: unknown): boolean {
  try {
    const path = pathOf(input);
    return isReal(path) ? real.existsSync(path) : store.resolve(path) !== undefined;
  } catch {
    return false;
  }
}

export function statSync(input: unknown, options?: { throwIfNoEntry?: boolean }): any {
  const path = pathOf(input);
  if (isReal(path)) return real.statSync(path, options as never);
  const entry = store.resolve(path);
  if (entry === undefined) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw new store.FsError("ENOENT", "stat", path);
  }
  return new Stats(entry);
}

export function lstatSync(input: unknown, options?: { throwIfNoEntry?: boolean }): any {
  const path = pathOf(input);
  if (isReal(path)) return real.lstatSync(path, options as never);
  const entry = store.get(path);
  if (entry === undefined) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw new store.FsError("ENOENT", "lstat", path);
  }
  return new Stats(entry);
}

export function readFileSync(input: unknown, options?: unknown): any {
  if (typeof input === "number") throw new store.FsError("ENOSYS", "read", `fd ${input}`);
  const path = pathOf(input);
  if (isReal(path)) return real.readFileSync(path, options as never);
  const bytes = Buffer.from(store.readFile(path));
  const encoding = encodingOf(options);
  return encoding ? bytes.toString(encoding) : bytes;
}

export function writeFileSync(input: unknown, data: unknown, options?: unknown): void {
  const flag = (options as { flag?: string } | undefined)?.flag;
  store.writeFile(pathOf(input), toBytes(data, options), {
    append: flag?.startsWith("a") ?? false,
    exclusive: flag?.includes("x") ?? false,
    ...((options as { mode?: number } | undefined)?.mode === undefined ? {} : { mode: (options as { mode: number }).mode }),
  });
}

export function appendFileSync(input: unknown, data: unknown, options?: unknown): void {
  store.writeFile(pathOf(input), toBytes(data, options), { append: true });
}

export function mkdirSync(input: unknown, options?: { recursive?: boolean; mode?: number } | number): string | undefined {
  return store.mkdir(pathOf(input), typeof options === "number" ? { mode: options } : (options ?? {}));
}

export function mkdtempSync(prefix: string): string {
  const path = store.normalize(store.tempName(prefix));
  store.mkdir(path, { mode: 0o700 });
  return path;
}

export function readdirSync(input: unknown, options?: { withFileTypes?: boolean; encoding?: string } | string): any {
  const path = pathOf(input);
  if (isReal(path)) return real.readdirSync(path, options as never);
  const names = store.readdir(path);
  if (typeof options === "object" && options?.withFileTypes) {
    return names.map((name) => new Dirent(name, path, store.get(`${path}/${name}`)?.kind ?? "file"));
  }
  return names;
}

export function rmSync(input: unknown, options?: { recursive?: boolean; force?: boolean }): void {
  store.remove(pathOf(input), options);
}

export function rmdirSync(input: unknown, options?: { recursive?: boolean }): void {
  store.remove(pathOf(input), options);
}

export function unlinkSync(input: unknown): void {
  const path = pathOf(input);
  if (store.get(path)?.kind === "dir") throw new store.FsError("EISDIR", "unlink", path);
  store.remove(path);
}

export function renameSync(from: unknown, to: unknown): void {
  store.rename(pathOf(from), pathOf(to));
}

export function copyFileSync(from: unknown, to: unknown): void {
  store.writeFile(pathOf(to), store.readFile(pathOf(from)));
}

export function realpathSync(input: unknown): string {
  const path = pathOf(input);
  if (isReal(path)) return real.realpathSync(path);
  const entry = store.resolve(path);
  if (entry === undefined) throw new store.FsError("ENOENT", "realpath", path);
  return entry.path;
}
realpathSync.native = realpathSync;

export function symlinkSync(target: string, input: unknown): void {
  store.symlink(target, pathOf(input));
}

export function readlinkSync(input: unknown): string {
  const path = pathOf(input);
  const entry = store.get(path);
  if (entry?.kind !== "symlink" || entry.target === null) throw new store.FsError("EINVAL", "readlink", path);
  return entry.target;
}

export function chmodSync(input: unknown, mode: number): void {
  store.chmod(pathOf(input), mode);
}

export function utimesSync(input: unknown, _atime: unknown, mtime: number | Date): void {
  store.utimes(pathOf(input), typeof mtime === "number" ? mtime * 1000 : mtime.getTime());
}

export function truncateSync(input: unknown, length = 0): void {
  const path = pathOf(input);
  store.writeFile(path, store.readFile(path).slice(0, length));
}

export function accessSync(input: unknown): void {
  if (!existsSync(input)) throw new store.FsError("ENOENT", "access", String(input));
}

// File descriptors: t3 opens files for exclusive creation and lock files. The spike keeps
// a tiny table that buffers writes and commits them on close.
const fds = new Map<number, { path: string; chunks: Array<Uint8Array>; append: boolean }>();
let nextFd = 1000;

export function openSync(input: unknown, flags: string | number = "r", mode?: number): number {
  const path = pathOf(input);
  const flag = typeof flags === "number" ? "w" : flags;
  const exists = store.resolve(path) !== undefined;
  if (flag.includes("x") && exists) throw new store.FsError("EEXIST", "open", path);
  if (flag.startsWith("r") && !exists) throw new store.FsError("ENOENT", "open", path);
  if (!flag.startsWith("r")) {
    store.writeFile(path, new Uint8Array(0), { append: flag.startsWith("a"), ...(mode === undefined ? {} : { mode }) });
  }
  const fd = nextFd++;
  fds.set(fd, { path, chunks: [], append: true });
  return fd;
}

export function writeSync(fd: number, data: unknown): number {
  const file = fds.get(fd);
  if (file === undefined) throw new store.FsError("EINVAL", "write", `fd ${fd}`);
  const bytes = toBytes(data);
  file.chunks.push(bytes);
  return bytes.byteLength;
}

export function closeSync(fd: number): void {
  const file = fds.get(fd);
  if (file === undefined) return;
  fds.delete(fd);
  for (const chunk of file.chunks) store.writeFile(file.path, chunk, { append: true });
}

export function fsyncSync(_fd: number): void {}

export function fstatSync(fd: number): any {
  const file = fds.get(fd);
  if (file === undefined) throw new store.FsError("EINVAL", "fstat", `fd ${fd}`);
  return statSync(file.path);
}

import * as promisesModule from "./node-fs-promises.ts";
export const promises = promisesModule;

export default {
  ...real,
  existsSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  realpathSync,
  symlinkSync,
  readlinkSync,
  chmodSync,
  utimesSync,
  truncateSync,
  accessSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  fstatSync,
  Stats,
  promises,
};
