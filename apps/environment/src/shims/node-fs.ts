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
    this.size = entry.size;
    this.blocks = Math.ceil(this.size / 512);
    let hash = 0;
    for (const char of entry.path) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    this.ino = Math.abs(hash);
    this.atimeMs = this.mtimeMs = this.ctimeMs = entry.mtimeMs;
    this.birthtimeMs = entry.birthtimeMs;
    this.atime = this.mtime = this.ctime = new Date(entry.mtimeMs);
    this.birthtime = new Date(entry.birthtimeMs);
    this.mtimeNs = BigInt(Math.round(entry.mtimeMs * 1e6));
  }
  /** As a `{ bigint: true }` stat has it: t3 keys an Environment theme's background on it. */
  mtimeNs: bigint;
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

type Callback<T> = (error: Error | null, value?: T) => void;

/** Node's callback form of a sync call: the callback runs on a later microtask, with the error or the value. */
const toCallback = <T>(run: () => T, callback: Callback<T>): void => {
  let value: T;
  try {
    value = run();
  } catch (error) {
    queueMicrotask(() => callback(error as Error));
    return;
  }
  queueMicrotask(() => callback(null, value));
};

const callbackOf = <T>(optionsOrCallback: unknown, callback: Callback<T> | undefined): Callback<T> =>
  (typeof optionsOrCallback === "function" ? optionsOrCallback : callback) as Callback<T>;

// The callback forms t3 calls on State directory paths (SPI-1301's check lists them): `realpath` in
// `assets/MediaFile.ts`, `stat` in `usage/usageTranscriptReader.ts`.
export function realpath(input: unknown, optionsOrCallback: unknown, callback?: Callback<string>): void {
  toCallback(() => realpathSync(input), callbackOf(optionsOrCallback, callback));
}
realpath.native = realpath;

export function stat(input: unknown, optionsOrCallback: unknown, callback?: Callback<any>): void {
  toCallback(() => statSync(input), callbackOf(optionsOrCallback, callback));
}

/** workerd's own: the same numbers `openSync` decodes. */
export const constants = real.constants;

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
  store.truncate(pathOf(input), length);
}

export function accessSync(input: unknown): void {
  if (!existsSync(input)) throw new store.FsError("ENOENT", "access", String(input));
}

// File descriptors: t3 opens files for exclusive creation and lock files, and reads its Environment themes through
// one (`readThemeFileGuarded`). A tiny table buffers writes and commits them on close, in one write; reads see the
// file as stored, not writes still buffered on the descriptor.
const fds = new Map<number, { path: string; chunks: Array<Uint8Array>; position: number }>();
let nextFd = 1000;

/** What an open does, from Node's string flags (`r`, `r+`, `w`, `wx`, `a`, …) or numeric ones (`O_*`). */
interface OpenMode {
  readonly create: boolean;
  readonly exclusive: boolean;
  readonly truncate: boolean;
  readonly nofollow: boolean;
}

// Linux's values, for a workerd whose `constants` lacks one: the numbers t3 passes come from the same `constants`.
const O_CREAT = real.constants?.O_CREAT ?? 0o100;
const O_EXCL = real.constants?.O_EXCL ?? 0o200;
const O_TRUNC = real.constants?.O_TRUNC ?? 0o1000;
const O_NOFOLLOW = real.constants?.O_NOFOLLOW ?? 0o400000;

const openModeOf = (flags: string | number): OpenMode =>
  typeof flags === "number"
    ? { create: (flags & O_CREAT) !== 0, exclusive: (flags & O_EXCL) !== 0, truncate: (flags & O_TRUNC) !== 0, nofollow: (flags & O_NOFOLLOW) !== 0 }
    : { create: !flags.startsWith("r"), exclusive: flags.includes("x"), truncate: flags.startsWith("w"), nofollow: false };

export function openSync(input: unknown, flags: string | number = "r", mode?: number): number {
  const path = pathOf(input);
  const openMode = openModeOf(flags);
  if (openMode.nofollow && store.get(path)?.kind === "symlink") throw new store.FsError("ELOOP", "open", path);
  const entry = store.resolve(path);
  const exists = entry !== undefined;
  if (openMode.create && openMode.exclusive && exists) throw new store.FsError("EEXIST", "open", path);
  // As Node: an open that would create or truncate a directory fails (other writes to one fail when they land).
  if ((openMode.create || openMode.truncate) && entry?.kind === "dir") throw new store.FsError("EISDIR", "open", path);
  if (!openMode.create && !exists) throw new store.FsError("ENOENT", "open", path);
  if (openMode.truncate || !exists) store.writeFile(path, new Uint8Array(0), mode === undefined ? {} : { mode });
  const fd = nextFd++;
  fds.set(fd, { path, chunks: [], position: 0 });
  return fd;
}

type ReadOptions = { offset?: number; length?: number; position?: number | bigint | null };

/** Node's `readSync(fd, buffer, offset, length, position)` and `readSync(fd, buffer, options)`. */
export function readSync(fd: number, buffer: ArrayBufferView, offsetOrOptions?: number | ReadOptions, length?: number, position?: number | bigint | null): number {
  const file = fds.get(fd);
  if (file === undefined) throw new store.FsError("EINVAL", "read", `fd ${fd}`);
  const options: ReadOptions =
    typeof offsetOrOptions === "object"
      ? offsetOrOptions
      : {
          ...(offsetOrOptions === undefined ? {} : { offset: offsetOrOptions }),
          ...(length === undefined ? {} : { length }),
          position: position ?? null,
        };
  const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const offset = options.offset ?? 0;
  const count = Math.max(0, Math.min(options.length ?? target.byteLength - offset, target.byteLength - offset));
  // No position (or -1) reads from, and advances, the descriptor's own; a given one leaves it as it was.
  const atCurrent = options.position === undefined || options.position === null || Number(options.position) < 0;
  const bytes = store.readRange(file.path, atCurrent ? file.position : Number(options.position), count);
  target.set(bytes, offset);
  if (atCurrent) file.position += bytes.byteLength;
  return bytes.byteLength;
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
  if (file.chunks.length === 0) return;
  const total = file.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of file.chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  store.writeFile(file.path, joined, { append: true });
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
  realpath,
  stat,
  constants,
  symlinkSync,
  readlinkSync,
  chmodSync,
  utimesSync,
  truncateSync,
  accessSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  fsyncSync,
  fstatSync,
  Stats,
  promises,
};
