// @effect-diagnostics globalDate:off effectFnOpportunity:off
// The Environment's file system with Workspaces in it (ADR-0008; step 2a plan, section 2): `/w` lists the registry's
// Workspaces and `/w/<id>/…` is that Workspace DO's files over RPC; every other path is the State directory
// (fileSystem.ts). An id the registry does not list is NotFound and never reaches a Durable Object.
import { W_ROOT, isUnderW, normalize, toWorkspace, type DirEntry, type FileStat, type FsAnswer } from "@t3flare/workspace-client";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import { environmentServices } from "../agents/bindings.ts";
import { locate, type Located } from "../agents/workspaceClient.ts";
import type { FsOp } from "../agents/rpc.ts";
import * as DoFileSystem from "./fileSystem.ts";

type Impl = Parameters<typeof FileSystem.make>[0];

const tagOf = (code: string): "NotFound" | "AlreadyExists" | "BadResource" | "Unknown" =>
  code === "ENOENT"
    ? "NotFound"
    : code === "EEXIST"
      ? "AlreadyExists"
      : code === "EISDIR" || code === "ENOTDIR" || code === "ENOTEMPTY" || code === "EINVAL"
        ? "BadResource"
        : "Unknown";

const failure = (method: string, path: string, tag: ReturnType<typeof tagOf>, description: string) =>
  PlatformError.systemError({ _tag: tag, module: "FileSystem", method, pathOrDescriptor: path, description });

const notFound = (method: string, path: string) => Effect.fail(failure(method, path, "NotFound", "t3flare: no such Workspace"));
const readOnly = (method: string, path: string) =>
  Effect.fail(failure(method, path, "BadResource", "t3flare: not supported in a Workspace"));

/** One Workspace file operation, its answer's error as a PlatformError. */
const call = <A>(method: string, path: string, at: Located, op: FsOp): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: (): Promise<FsAnswer<unknown>> => at.rpc.fs(op),
    catch: (cause) => failure(method, path, "Unknown", `t3flare: Workspace ${at.id}: ${String(cause).slice(0, 300)}`),
  }).pipe(
    Effect.flatMap((answer: FsAnswer<unknown>) =>
      "ok" in answer ? Effect.succeed(answer.ok as A) : Effect.fail(failure(method, path, tagOf(answer.error), answer.message)),
    ),
  );

const fileType = (kind: FileStat["kind"]): FileSystem.File.Type =>
  kind === "directory" ? "Directory" : kind === "symlink" ? "SymbolicLink" : "File";

const info = (stat: { readonly kind: FileStat["kind"]; readonly size: number; readonly mtimeMs: number; readonly mode: number }): FileSystem.File.Info => ({
  type: fileType(stat.kind),
  mtime: Option.some(new Date(stat.mtimeMs)),
  atime: Option.some(new Date(stat.mtimeMs)),
  birthtime: Option.some(new Date(stat.mtimeMs)),
  dev: 2n,
  ino: Option.none(),
  mode: stat.mode,
  nlink: Option.some(1n),
  uid: Option.some(0),
  gid: Option.some(0),
  rdev: Option.none(),
  size: ByteSize.bytes(stat.size),
  blksize: Option.none(),
  blocks: Option.none(),
});

const ROOT_INFO = info({ kind: "directory", size: 0, mtimeMs: 0, mode: 0o755 });

const isRoot = (path: string) => normalize(path) === W_ROOT;

/** The Workspace of a `/w/<id>/…` path, or a NotFound when the id is not listed. */
const workspace = (method: string, path: string): Effect.Effect<Located, PlatformError.PlatformError> =>
  Effect.suspend(() => {
    const at = locate(path);
    return at === undefined ? notFound(method, path) : Effect.succeed(at);
  });

const listRoot = () => environmentServices().workspaces.list().map((record) => record.id);

const statOf = (method: string, path: string, follow: boolean) =>
  isRoot(path)
    ? Effect.succeed(ROOT_INFO)
    : Effect.flatMap(workspace(method, path), (at) => Effect.map(call<FileStat>(method, path, at, { op: "stat", path: at.inner, follow }), info));

const readAll = (path: string) =>
  Effect.flatMap(workspace("readFile", path), (at) => call<Uint8Array>("readFile", path, at, { op: "read", path: at.inner }));

const writeAll = (method: string, path: string, data: Uint8Array, options: { readonly append?: boolean; readonly exclusive?: boolean } = {}) =>
  Effect.flatMap(workspace(method, path), (at) => Effect.asVoid(call(method, path, at, { op: "write", path: at.inner, data, options })));

/** Reads a Workspace file through a handle: the whole file once, then from memory. Writes go through writeFile. */
const openWorkspaceFile = (path: string): Effect.Effect<FileSystem.File, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const stat = yield* statOf("open", path, true);
    const bytes = yield* readAll(path);
    let position = 0n;
    const file = {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: Effect.succeed(stat),
      seek: (offset: bigint | number, from: "start" | "current") =>
        Effect.sync(() => {
          position = from === "start" ? BigInt(offset) : position + BigInt(offset);
          return position;
        }),
      sync: Effect.void,
      read: (buffer: Uint8Array) =>
        Effect.sync(() => {
          const slice = bytes.subarray(Number(position), Number(position) + buffer.byteLength);
          buffer.set(slice);
          position += BigInt(slice.byteLength);
          return slice.byteLength;
        }),
      readAlloc: (size: bigint | number) =>
        Effect.sync(() => {
          const slice = bytes.slice(Number(position), Number(position) + Number(size));
          position += BigInt(slice.byteLength);
          return slice.byteLength === 0 ? Option.none() : Option.some(slice);
        }),
      truncate: () => readOnly("truncate", path),
      write: () => readOnly("write", path),
      writeAll: () => readOnly("write", path),
    };
    return file as unknown as FileSystem.File;
  });

/** `local` with every path in `/w` sent to its Workspace. */
export const routing = (local: Impl): Impl => ({
  access: (path, options) =>
    isUnderW(path) ? Effect.asVoid(statOf("access", path, true)) : local.access(path, options),
  chmod: (path, mode) => (isUnderW(path) ? Effect.void : local.chmod(path, mode)),
  chown: (path, uid, gid) => (isUnderW(path) ? Effect.void : local.chown(path, uid, gid)),
  copy: (from, to, options) =>
    isUnderW(from) || isUnderW(to) ? readOnly("copy", from) : local.copy(from, to, options),
  copyFile: (from, to) => {
    if (!isUnderW(from) && !isUnderW(to)) return local.copyFile(from, to);
    const read = isUnderW(from) ? readAll(from) : local.readFile(from);
    return Effect.flatMap(read, (data) => (isUnderW(to) ? writeAll("copyFile", to, data) : local.writeFile(to, data)));
  },
  link: (from, to) => (isUnderW(from) || isUnderW(to) ? readOnly("link", to) : local.link(from, to)),
  lstat: (path) => (isUnderW(path) ? statOf("lstat", path, false) : local.lstat(path)),
  stat: (path) => (isUnderW(path) ? statOf("stat", path, true) : local.stat(path)),
  makeDirectory: (path, options) => {
    if (!isUnderW(path)) return local.makeDirectory(path, options);
    if (isRoot(path)) return options?.recursive === true ? Effect.void : Effect.fail(failure("makeDirectory", path, "AlreadyExists", "/w exists"));
    return Effect.flatMap(workspace("makeDirectory", path), (at) =>
      Effect.asVoid(call("makeDirectory", path, at, { op: "mkdir", path: at.inner, recursive: options?.recursive === true })),
    );
  },
  makeTempDirectory: (options) =>
    options?.directory !== undefined && isUnderW(options.directory) ? readOnly("makeTempDirectory", options.directory) : local.makeTempDirectory(options),
  makeTempDirectoryScoped: (options) =>
    options?.directory !== undefined && isUnderW(options.directory)
      ? readOnly("makeTempDirectory", options.directory)
      : local.makeTempDirectoryScoped(options),
  makeTempFile: (options) =>
    options?.directory !== undefined && isUnderW(options.directory) ? readOnly("makeTempFile", options.directory) : local.makeTempFile(options),
  makeTempFileScoped: (options) =>
    options?.directory !== undefined && isUnderW(options.directory) ? readOnly("makeTempFile", options.directory) : local.makeTempFileScoped(options),
  open: (path, options) => {
    if (!isUnderW(path)) return local.open(path, options);
    const flag = options?.flag ?? "r";
    return flag === "r" ? openWorkspaceFile(path) : readOnly("open", path);
  },
  readDirectory: (path, options) => {
    if (!isUnderW(path)) return local.readDirectory(path, options);
    if (isRoot(path)) return Effect.sync(listRoot);
    if (options?.recursive === true) {
      return Effect.flatMap(workspace("readDirectory", path), (at) =>
        Effect.map(call<ReadonlyArray<{ readonly path: string }>>("readDirectory", path, at, { op: "find", path: at.inner, limit: 20_000 }), (found) =>
          found.map((entry) => entry.path.slice(at.inner.length).replace(/^\//, "")).filter((name) => name !== ""),
        ),
      );
    }
    return Effect.flatMap(workspace("readDirectory", path), (at) =>
      Effect.map(call<ReadonlyArray<DirEntry>>("readDirectory", path, at, { op: "readdir", path: at.inner }), (entries) =>
        entries.map((entry) => entry.name),
      ),
    );
  },
  readDirectoryEntries: (path) => {
    if (!isUnderW(path)) return local.readDirectoryEntries(path);
    if (isRoot(path)) return Effect.sync(() => listRoot().map((name) => ({ name, type: "Directory" as const })));
    return Effect.flatMap(workspace("readDirectoryEntries", path), (at) =>
      Effect.map(call<ReadonlyArray<DirEntry>>("readDirectoryEntries", path, at, { op: "readdir", path: at.inner }), (entries) =>
        entries.map((entry) => ({ name: entry.name, type: fileType(entry.kind) })),
      ),
    );
  },
  readFile: (path) => (isUnderW(path) ? readAll(path) : local.readFile(path)),
  readLink: (path) => (isUnderW(path) ? readOnly("readLink", path) : local.readLink(path)),
  realPath: (path) => {
    if (!isUnderW(path)) return local.realPath(path);
    if (isRoot(path)) return Effect.succeed(W_ROOT);
    return Effect.flatMap(workspace("realPath", path), (at) =>
      Effect.map(call<string>("realPath", path, at, { op: "realPath", path: at.inner }), (inner) => {
        const back = inner === "/workspace/repo" || inner.startsWith("/workspace/repo/") ? `${W_ROOT}/${at.id}${inner.slice("/workspace/repo".length)}` : null;
        return back ?? normalize(path);
      }),
    );
  },
  remove: (path, options) => {
    if (!isUnderW(path)) return local.remove(path, options);
    const at = toWorkspace(path);
    // A Workspace's root goes with the Workspace, not a file operation.
    if (isRoot(path) || (at !== null && at.inner === "/workspace/repo")) return readOnly("remove", path);
    return Effect.flatMap(workspace("remove", path), (located) =>
      Effect.asVoid(call("remove", path, located, { op: "remove", path: located.inner, options: { recursive: options?.recursive === true, force: options?.force === true } })),
    );
  },
  rename: (from, to) => {
    if (!isUnderW(from) && !isUnderW(to)) return local.rename(from, to);
    const a = toWorkspace(from);
    const b = toWorkspace(to);
    if (a === null || b === null || a.id !== b.id) return readOnly("rename", from);
    return Effect.flatMap(workspace("rename", from), (at) => Effect.asVoid(call("rename", from, at, { op: "rename", path: a.inner, to: b.inner })));
  },
  symlink: (target, path) => (isUnderW(path) ? readOnly("symlink", path) : local.symlink(target, path)),
  truncate: (path, length) => (isUnderW(path) ? readOnly("truncate", path) : local.truncate(path, length)),
  utimes: (path, atime, mtime) => (isUnderW(path) ? Effect.void : local.utimes(path, atime, mtime)),
  watch: (path, options) => local.watch(path, options),
  writeFile: (path, data, options) =>
    isUnderW(path)
      ? writeAll("writeFile", path, data, { append: options?.flag?.startsWith("a") ?? false, exclusive: options?.flag?.includes("x") ?? false })
      : local.writeFile(path, data, options),
});

export const make = (): FileSystem.FileSystem => FileSystem.make(routing(DoFileSystem.impl));

export const layer = Layer.sync(FileSystem.FileSystem, make);
