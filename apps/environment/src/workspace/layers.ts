// @effect-diagnostics effectFnOpportunity:off
// t3's workspace services for paths in a Workspace (step 2a plan, section 2). The stock WorkspaceEntries and
// WorkspaceFileSystem read the disk through `node:fs` and index it with fff; a Workspace's files are its Durable
// Object's, over RPC. These Layers answer `/w/…` from the Workspace DO and hand every other path to the stock service.
import type { FilesystemEntryMetadata, ProjectContentMatch, ProjectEntry } from "@t3tools/contracts";
import { W_ROOT, isUnderW, normalize, type DirEntry, type FileStat, type FoundEntry, type FsAnswer, type GrepMatch } from "@t3flare/workspace-client";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as KnownWorkspaces from "t3/src/workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "t3/src/workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "t3/src/workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "t3/src/workspace/WorkspacePaths.ts";

import type { FsOp } from "../agents/rpc.ts";
import { environmentServices } from "../agents/bindings.ts";
import { locate, type Located } from "../agents/workspaceClient.ts";

const READ_MAX_BYTES = 1024 * 1024;
const LIST_LIMIT = 5000;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;

class WorkspaceRpcError extends Schema.TaggedError<WorkspaceRpcError>()("WorkspaceRpcError", {
  code: Schema.String,
  detail: Schema.String,
}) {}

const call = <A>(at: Located, op: FsOp): Effect.Effect<A, WorkspaceRpcError> =>
  Effect.tryPromise({
    try: (): Promise<FsAnswer<unknown>> => at.rpc.fs(op),
    catch: (cause) => new WorkspaceRpcError({ code: "EIO", detail: String(cause).slice(0, 300) }),
  }).pipe(
    Effect.flatMap((answer) =>
      "ok" in answer ? Effect.succeed(answer.ok as A) : Effect.fail(new WorkspaceRpcError({ code: answer.error, detail: answer.message })),
    ),
  );

const expandHome = (value: string) => (value === "~" ? W_ROOT : value.startsWith("~/") ? `${W_ROOT}/${value.slice(2)}` : value);

/** A path the Workspace DO answered, relative to the repo root (`inner`). */
const relativeTo = (inner: string, path: string) => {
  if (path === inner) return "";
  if (path.startsWith(`${inner}/`)) return path.slice(inner.length + 1);
  return path.replace(/^\/+/, "");
};

const kindOf = (kind: DirEntry["kind"]): ProjectEntry["kind"] | undefined =>
  kind === "directory" ? "directory" : kind === "file" ? "file" : undefined;

/** Fuzzy rank of `path` for `query` (lower is better), or null when it does not match. */
const rank = (path: string, query: string): number | null => {
  if (query === "") return 0;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  let at = 0;
  for (const char of lower) if (char === query[at]) at++;
  return at === query.length ? 4 : null;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The match ranges of `pattern` in `line`, as the client highlights them. */
const rangesOf = (line: string, pattern: RegExp) => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of line.matchAll(pattern)) {
    if (match[0].length === 0) break;
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (ranges.length >= 50) break;
  }
  return ranges;
};

const findAll = (at: Located) =>
  call<ReadonlyArray<FoundEntry>>(at, { op: "find", path: at.inner, limit: LIST_LIMIT }).pipe(
    Effect.map((found) => ({
      entries: found.flatMap((entry): Array<ProjectEntry> => {
        const path = relativeTo(at.inner, entry.path);
        const kind = kindOf(entry.kind);
        return path === "" || kind === undefined || path.split("/").includes(".git") ? [] : [{ path, kind }];
      }),
      truncated: found.length >= LIST_LIMIT,
    })),
  );

export const layerWorkspaceEntries = <E, R>(stock: Layer.Layer<WorkspaceEntries.WorkspaceEntries, E, R>) =>
  Layer.effect(
    WorkspaceEntries.WorkspaceEntries,
    Effect.gen(function* () {
      const base = yield* WorkspaceEntries.WorkspaceEntries;
      const mine = (cwd: string | undefined) => (cwd === undefined ? undefined : locate(normalize(expandHome(cwd))));
      const readError = (cwd: string, partialPath: string, parentPath: string) => (cause: unknown) =>
        new WorkspaceEntries.WorkspaceEntriesReadDirectoryError({ cwd, partialPath, parentPath, cause });

      const browse: WorkspaceEntries.WorkspaceEntries["Service"]["browse"] = (input) => {
        const partial = expandHome(input.partialPath);
        const absolute = partial.startsWith("/") ? partial : input.cwd === undefined ? partial : `${expandHome(input.cwd)}/${partial}`;
        if (!absolute.startsWith("/") || !isUnderW(absolute)) return base.browse(input);
        const endsWithSeparator = input.partialPath.endsWith("/") || input.partialPath === "~";
        const resolved = normalize(absolute);
        const parentPath = endsWithSeparator ? resolved : resolved.slice(0, resolved.lastIndexOf("/")) || "/";
        const prefix = (endsWithSeparator ? "" : resolved.slice(resolved.lastIndexOf("/") + 1)).toLowerCase();
        const showHidden = endsWithSeparator || prefix.startsWith(".");
        const keep = (name: string) => name.toLowerCase().startsWith(prefix) && (showHidden || !name.startsWith("."));
        if (parentPath === W_ROOT || parentPath === "/") {
          const names = parentPath === W_ROOT ? environmentServices().workspaces.list().map((ws) => ws.id) : ["w"];
          return Effect.succeed({
            parentPath,
            entries: names.filter(keep).map((name) => ({ name, fullPath: `${parentPath === "/" ? "" : parentPath}/${name}` })),
          });
        }
        const at = locate(parentPath);
        if (at === undefined) return Effect.succeed({ parentPath, entries: [] });
        return call<ReadonlyArray<DirEntry>>(at, { op: "readdir", path: at.inner }).pipe(
          Effect.map((entries) => ({
            parentPath,
            entries: entries
              .filter((entry) => entry.kind === "directory" && entry.name !== ".git" && keep(entry.name))
              .map((entry) => ({ name: entry.name, fullPath: `${parentPath}/${entry.name}` }))
              .toSorted((left, right) => left.name.localeCompare(right.name)),
          })),
          Effect.mapError(readError(input.cwd ?? "", input.partialPath, parentPath)),
        );
      };

      const list: WorkspaceEntries.WorkspaceEntries["Service"]["list"] = (input) => {
        const at = mine(input.cwd);
        if (at === undefined) return base.list(input);
        const directory = (input.directoryPath ?? "").replace(/^\/+|\/+$/g, "");
        if (input.directoryPath === undefined) return Effect.mapError(findAll(at), readError(input.cwd, "", input.cwd));
        if (directory.split("/").some((segment) => segment === ".." || segment === ".git")) {
          return Effect.fail(readError(input.cwd, directory, input.cwd)(new Error("Directory must be inside the workspace and outside .git.")));
        }
        const inner = directory === "" ? at.inner : `${at.inner}/${directory}`;
        return call<ReadonlyArray<DirEntry>>(at, { op: "readdir", path: inner }).pipe(
          Effect.map((entries) => ({
            entries: entries.flatMap((entry): Array<ProjectEntry> => {
              const kind = kindOf(entry.kind);
              return entry.name === ".git" || kind === undefined ? [] : [{ path: directory === "" ? entry.name : `${directory}/${entry.name}`, kind }];
            }),
            truncated: false,
          })),
          Effect.mapError(readError(input.cwd, directory, inner)),
        );
      };

      const search: WorkspaceEntries.WorkspaceEntries["Service"]["search"] = (input) => {
        const at = mine(input.cwd);
        if (at === undefined) return base.search(input);
        const query = input.query.trim().replace(/^[@./]+/, "").toLowerCase();
        return findAll(at).pipe(
          Effect.map(({ entries }) => {
            const ranked = entries
              .filter((entry) => (input.kind === undefined || entry.kind === input.kind) && (input.imageOnly !== true || IMAGE.test(entry.path)))
              .flatMap((entry) => {
                const score = rank(entry.path, query);
                return score === null ? [] : [{ entry, score }];
              })
              .toSorted((left, right) => left.score - right.score || left.entry.path.length - right.entry.path.length);
            return { entries: ranked.slice(0, input.limit).map((item) => item.entry), truncated: ranked.length > input.limit };
          }),
          Effect.mapError(readError(input.cwd, input.query, input.cwd)),
        );
      };

      const searchContents: WorkspaceEntries.WorkspaceEntries["Service"]["searchContents"] = (input) => {
        const at = mine(input.cwd);
        if (at === undefined) return base.searchContents(input);
        const source = input.useRegex ? input.query : escapeRegex(input.query);
        const wrapped = input.wholeWord ? `\\b(?:${source})\\b` : source;
        let pattern: RegExp;
        try {
          pattern = new RegExp(wrapped, input.caseSensitive ? "g" : "gi");
        } catch (error) {
          return Effect.succeed({ matches: [], truncated: false, regexFallbackError: String(error) });
        }
        return call<ReadonlyArray<GrepMatch>>(at, {
          op: "grep",
          path: at.inner,
          pattern: wrapped,
          options: { regex: true, ignoreCase: !input.caseSensitive, limit: input.limit + 1 },
        }).pipe(
          Effect.map((found) => ({
            matches: found.slice(0, input.limit).flatMap((match): Array<ProjectContentMatch> => {
              const path = relativeTo(at.inner, match.path);
              return path === "" ? [] : [{ path, lineNumber: Math.max(1, match.line), lineContent: match.text, matchRanges: rangesOf(match.text, pattern) }];
            }) as Array<ProjectContentMatch>,
            truncated: found.length > input.limit,
          })),
          Effect.mapError(readError(input.cwd, input.query, input.cwd)),
        );
      };

      return WorkspaceEntries.WorkspaceEntries.of({
        browse,
        list,
        search,
        searchContents,
        listIgnoredFiles: (input) => (mine(input.cwd) === undefined ? base.listIgnoredFiles(input) : Effect.succeed({ files: [], truncated: false })),
        refresh: (cwd) => (mine(cwd) === undefined ? base.refresh(cwd) : Effect.void),
      });
    }),
  ).pipe(Layer.provide(stock));

const isGitSegment = (segment: string) => segment.replace(/[. ]+$/, "").toUpperCase() === ".GIT";

export const layerWorkspaceFileSystem = <E, R>(stock: Layer.Layer<WorkspaceFileSystem.WorkspaceFileSystem, E, R>) =>
  Layer.effect(
    WorkspaceFileSystem.WorkspaceFileSystem,
    Effect.gen(function* () {
      const base = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const home = yield* HostProcess.HomeDirectory;
      const expand = (value: string) => (value === "~" ? home : value.startsWith("~/") ? `${home}/${value.slice(2)}` : value);

      const metadataOf = (path: string): Effect.Effect<FilesystemEntryMetadata | null> => {
        const at = locate(normalize(path));
        if (normalize(path) === W_ROOT) return Effect.succeed({ kind: "directory" });
        if (at === undefined) return Effect.succeed(null);
        return call<FileStat>(at, { op: "stat", path: at.inner }).pipe(
          Effect.map((stat) =>
            stat.kind === "directory"
              ? { kind: "directory" as const }
              : stat.kind === "file"
                ? { kind: "file" as const, byteLength: stat.size }
                : { kind: "other" as const },
          ),
          Effect.orElseSucceed(() => null),
        );
      };

      const getMetadata: WorkspaceFileSystem.WorkspaceFileSystem["Service"]["getMetadata"] = (input) =>
        Effect.gen(function* () {
          const expanded = input.paths.map(expand);
          const theirs = input.paths.filter((_, index) => !(expanded[index]!.startsWith("/") && isUnderW(expanded[index]!)));
          const stockAnswer = theirs.length === 0 ? [] : (yield* base.getMetadata({ paths: theirs })).entries;
          let next = 0;
          return {
            entries: yield* Effect.forEach(
              expanded,
              (path): Effect.Effect<FilesystemEntryMetadata | null> =>
                path.startsWith("/") && isUnderW(path) ? metadataOf(path) : Effect.succeed(stockAnswer[next++] ?? null),
              { concurrency: 8 },
            ),
          };
        });

      /** The Workspace path of a read or write, or null when it is not in a Workspace. */
      const targetOf = (cwd: string, relativePath: string) => {
        const requested = expand(relativePath.trim());
        const absolute = requested.startsWith("/") ? normalize(requested) : normalize(`${expand(cwd)}/${requested}`);
        if (!isUnderW(absolute)) return null;
        const at = locate(absolute);
        return at === undefined ? null : { at, absolute };
      };

      const operationError = (cwd: string, relativePath: string, resolved: string, operation: "read" | "write-file" | "stat") => (cause: unknown) =>
        new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
          workspaceRoot: cwd,
          relativePath,
          resolvedPath: resolved,
          operationPath: resolved,
          operation,
          cause,
        });

      const readFile: WorkspaceFileSystem.WorkspaceFileSystem["Service"]["readFile"] = (input) => {
        const target = targetOf(input.cwd, input.relativePath);
        if (target === null) return base.readFile(input);
        const { at, absolute } = target;
        return call<Uint8Array>(at, { op: "read", path: at.inner }).pipe(
          Effect.map((bytes) => ({ exists: true as const, bytes })),
          Effect.catchIf(
            (error) => error.code === "ENOENT" && input.allowMissing === true,
            () => Effect.succeed({ exists: false as const, bytes: new Uint8Array(0) }),
          ),
          Effect.mapError(operationError(input.cwd, input.relativePath, absolute, "read")),
          Effect.flatMap(({ exists, bytes }) => {
            if (bytes.subarray(0, 8000).includes(0)) {
              return Effect.fail(
                new WorkspaceFileSystem.WorkspaceBinaryFileError({ workspaceRoot: input.cwd, relativePath: input.relativePath, resolvedPath: absolute }),
              );
            }
            const truncated = bytes.byteLength > READ_MAX_BYTES;
            return Effect.succeed({
              relativePath: input.relativePath,
              contents: new TextDecoder().decode(truncated ? bytes.subarray(0, READ_MAX_BYTES) : bytes),
              byteLength: bytes.byteLength,
              truncated,
              exists,
            });
          }),
        );
      };

      const writeFile: WorkspaceFileSystem.WorkspaceFileSystem["Service"]["writeFile"] = (input) => {
        const cwd = normalize(expand(input.cwd));
        if (!isUnderW(cwd)) return base.writeFile(input);
        const relative = input.relativePath.trim();
        const absolute = normalize(`${cwd}/${relative}`);
        const at = locate(cwd);
        if (relative.startsWith("/") || relative.startsWith("~") || !absolute.startsWith(`${cwd}/`) || at === undefined) {
          return Effect.fail(new WorkspacePaths.WorkspacePathOutsideRootError({ workspaceRoot: input.cwd, relativePath: input.relativePath }));
        }
        if (relative.split("/").some(isGitSegment)) {
          return Effect.fail(
            new WorkspaceFileSystem.WorkspaceFilePathEscapeError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedWorkspaceRoot: cwd,
              resolvedPath: absolute,
            }),
          );
        }
        const inner = `${at.inner}${absolute.slice(cwd.length)}`;
        return call(at, { op: "write", path: inner, data: input.contents }).pipe(
          Effect.as({ relativePath: input.relativePath }),
          Effect.mapError(operationError(input.cwd, input.relativePath, absolute, "write-file")),
        );
      };

      return WorkspaceFileSystem.WorkspaceFileSystem.of({ getMetadata, readFile, writeFile });
    }),
  ).pipe(Layer.provide(stock));

/** KnownWorkspaces is unchanged: it reads t3's Projects and resolves paths through the routing FileSystem. */
export type { KnownWorkspaces };
