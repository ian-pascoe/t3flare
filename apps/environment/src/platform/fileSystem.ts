// @effect-diagnostics globalDate:off effectFnOpportunity:off
// Effect `FileSystem` over the State directory in DO SQLite (ADR-0007).
// Same rows as the `node:fs` shim, so t3's Effect and synchronous paths agree.
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import * as store from "./stateStore.ts";

const tagOf = (code: string) =>
  code === "ENOENT"
    ? "NotFound"
    : code === "EEXIST"
      ? "AlreadyExists"
      : code === "EISDIR" || code === "ENOTDIR" || code === "ENOTEMPTY"
        ? "BadResource"
        : "Unknown";

const attempt = <A>(method: string, path: string, f: () => A) =>
  Effect.try({
    try: f,
    catch: (cause) =>
      PlatformError.systemError({
        _tag: cause instanceof store.FsError ? (tagOf(cause.code) as "NotFound") : "Unknown",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        cause,
      }),
  });

const info = (entry: store.Entry): FileSystem.File.Info => ({
  type: entry.kind === "dir" ? "Directory" : entry.kind === "symlink" ? "SymbolicLink" : "File",
  mtime: Option.some(new Date(entry.mtimeMs)),
  atime: Option.some(new Date(entry.mtimeMs)),
  birthtime: Option.some(new Date(entry.birthtimeMs)),
  dev: 1n,
  ino: Option.none(),
  mode: entry.mode,
  nlink: Option.some(1n),
  uid: Option.some(0),
  gid: Option.some(0),
  rdev: Option.none(),
  size: ByteSize.bytes(entry.size),
  blksize: Option.none(),
  blocks: Option.none(),
});

const entryOf = (method: string, path: string, follow: boolean) =>
  attempt(method, path, () => {
    const entry = follow ? store.resolve(path) : store.get(path);
    if (entry === undefined) throw new store.FsError("ENOENT", method, path);
    return entry;
  });

const makeTemp = (kind: "dir" | "file", options?: { readonly directory?: string | undefined; readonly prefix?: string | undefined; readonly suffix?: string | undefined }) =>
  attempt("makeTemp", options?.directory ?? "/tmp", () => {
    const directory = options?.directory ?? "/tmp";
    store.mkdir(directory, { recursive: true });
    const path = store.normalize(`${directory}/${store.tempName(options?.prefix ?? "tmp-")}${options?.suffix ?? ""}`);
    if (kind === "dir") store.mkdir(path, { mode: 0o700 });
    else store.writeFile(path, new Uint8Array(0), { exclusive: true, mode: 0o600 });
    return path;
  });

const open: FileSystem.FileSystem["open"] = (path, options) =>
  Effect.gen(function* () {
    const flag = options?.flag ?? "r";
    if (flag.startsWith("r")) yield* entryOf("open", path, true);
    else yield* attempt("open", path, () => store.writeFile(path, new Uint8Array(0), { append: flag.startsWith("a"), exclusive: flag.includes("x") }));
    let position = 0n;
    const file: FileSystem.File = {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: Effect.map(entryOf("stat", path, true), info),
      seek: (offset, from) =>
        Effect.sync(() => {
          position = from === "start" ? offset : position + offset;
          return position;
        }),
      sync: Effect.void,
      read: (buffer) =>
        attempt("read", path, () => {
          const bytes = store.readRange(path, Number(position), buffer.byteLength);
          buffer.set(bytes);
          position += BigInt(bytes.byteLength);
          return bytes.byteLength;
        }) as never,
      readAlloc: (size) =>
        attempt("read", path, () => {
          const bytes = store.readRange(path, Number(position), Number(size));
          position += BigInt(bytes.byteLength);
          return bytes.byteLength === 0 ? Option.none() : Option.some(bytes);
        }),
      truncate: (length) => attempt("truncate", path, () => store.truncate(path, Number(length ?? 0))),
      write: (buffer) =>
        attempt("write", path, () => {
          store.writeFile(path, buffer, { append: true });
          position += BigInt(buffer.byteLength);
          return buffer.byteLength;
        }),
      writeAll: (buffer) => attempt("write", path, () => store.writeFile(path, buffer, { append: true })),
    } as FileSystem.File;
    return file;
  });

export const impl: Parameters<typeof FileSystem.make>[0] = {
    access: (path) => Effect.asVoid(entryOf("access", path, true)),
    chmod: (path, mode) => attempt("chmod", path, () => store.chmod(path, mode)),
    chown: () => Effect.void,
    copy: (from, to) =>
      attempt("copy", from, () => {
        const walk = (source: string, target: string) => {
          const entry = store.resolve(source);
          if (entry === undefined) throw new store.FsError("ENOENT", "copy", source);
          if (entry.kind === "dir") {
            store.mkdir(target, { recursive: true });
            for (const name of store.readdir(source)) walk(`${source}/${name}`, `${target}/${name}`);
          } else store.writeFile(target, store.readFile(entry.path));
        };
        walk(from, to);
      }),
    copyFile: (from, to) => attempt("copyFile", from, () => store.writeFile(to, store.readFile(from))),
    link: (from, to) => attempt("link", to, () => {
      if (store.get(to) !== undefined) throw new store.FsError("EEXIST", "link", to);
      store.writeFile(to, store.readFile(from), { exclusive: true });
    }),
    lstat: (path) => Effect.map(entryOf("lstat", path, false), info),
    stat: (path) => Effect.map(entryOf("stat", path, true), info),
    makeDirectory: (path, options) => Effect.asVoid(attempt("makeDirectory", path, () => store.mkdir(path, options ?? {}))),
    makeTempDirectory: (options) => makeTemp("dir", options),
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(makeTemp("dir", options), (path) => Effect.sync(() => store.remove(path, { recursive: true, force: true }))),
    makeTempFile: (options) => makeTemp("file", options),
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(makeTemp("file", options), (path) => Effect.sync(() => store.remove(path, { force: true }))),
    open,
    readDirectory: (path, options) =>
      attempt("readDirectory", path, () => {
        if (!options?.recursive) return store.readdir(path);
        const out: string[] = [];
        const walk = (dir: string, prefix: string) => {
          for (const name of store.readdir(dir)) {
            out.push(prefix + name);
            if (store.resolve(`${dir}/${name}`)?.kind === "dir") walk(`${dir}/${name}`, `${prefix}${name}/`);
          }
        };
        walk(path, "");
        return out;
      }),
    readDirectoryEntries: (path) =>
      attempt("readDirectoryEntries", path, () =>
        store.readdir(path).map((name) => {
          const kind = store.get(`${path}/${name}`)?.kind;
          return { name, type: kind === "dir" ? "Directory" : kind === "symlink" ? "SymbolicLink" : "File" } as never;
        }),
      ),
    readFile: (path) => attempt("readFile", path, () => store.readFile(path)),
    readLink: (path) =>
      attempt("readLink", path, () => {
        const entry = store.get(path);
        if (entry?.kind !== "symlink" || entry.target === null) throw new store.FsError("EINVAL", "readlink", path);
        return entry.target;
      }),
    realPath: (path) => Effect.map(entryOf("realPath", path, true), (entry) => entry.path),
    remove: (path, options) => attempt("remove", path, () => store.remove(path, options ?? {})),
    rename: (from, to) => attempt("rename", from, () => store.rename(from, to)),
    symlink: (target, path) => attempt("symlink", path, () => store.symlink(target, path)),
    truncate: (path, length) => attempt("truncate", path, () => store.truncate(path, Number(length ?? 0))),
    utimes: (path, _atime, mtime) =>
      attempt("utimes", path, () => store.utimes(path, typeof mtime === "number" ? mtime : mtime.getTime())),
    watch: () => Stream.empty,
    writeFile: (path, data, options) =>
      attempt("writeFile", path, () =>
        store.writeFile(path, data, {
          append: options?.flag?.startsWith("a") ?? false,
          exclusive: options?.flag?.includes("x") ?? false,
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
        }),
      ),
};

export const make = (): FileSystem.FileSystem => FileSystem.make(impl);

export const layer = Layer.sync(FileSystem.FileSystem, make);
