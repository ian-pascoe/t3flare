// Reading pnpm lockfiles (v9) for gen-workspace.ts, seed-lock.ts and verify-lock.ts.
import * as fs from "node:fs";
import { parseAllDocuments } from "yaml";

export type Json = Record<string, any>;

export interface Lock {
  /** The document with `settings`, `importers`, `packages` and `snapshots`; the other one is pnpm's own env. */
  readonly main: Json;
  /** Every document, in file order, for writing the file back. */
  readonly documents: Array<Json>;
}

export const readLock = (file: string): Lock => {
  const documents = parseAllDocuments(fs.readFileSync(file, "utf8")).map((doc) => doc.toJS({ maxAliasCount: -1 }) as Json);
  const main = documents.find((doc) => doc?.importers !== undefined && doc?.settings !== undefined);
  if (main === undefined) throw new Error(`${file}: no lockfile document with settings and importers`);
  return { main, documents };
};

export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** `name@1.2.3(peer@4)(patch_hash=…)` → `name@1.2.3`. */
export const bareKey = (key: string) => key.replace(/^(@?[^@]+@[^(]+).*$/, "$1");

/**
 * The snapshot keys (`name@version(peers…)`) reachable from the given importers: everything those importers install.
 * Workspace links are not followed; list every importer you want.
 */
export const closure = (lock: Json, importers: Iterable<string>): Set<string> => {
  const reachable = new Set<string>();
  const visit = (deps: Json | undefined, fromImporter: boolean) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      const version: string = fromImporter ? entry.version : entry;
      if (version.startsWith("link:")) continue;
      // An alias (`vite: npm:@voidzero-dev/vite-plus-core@…`) records the real package's own key.
      const key = /^\d/.test(version) ? `${name}@${version}` : version;
      if (reachable.has(key)) continue;
      reachable.add(key);
      const snapshot = lock.snapshots?.[key] as Json | undefined;
      visit(snapshot?.dependencies, false);
      visit(snapshot?.optionalDependencies, false);
    }
  };
  for (const dir of importers) {
    const importer = lock.importers?.[dir] as Json | undefined;
    if (importer === undefined) throw new Error(`the lock has no importer ${dir}`);
    for (const field of DEPENDENCY_FIELDS) visit(importer[field], true);
  }
  return reachable;
};

/** Package keys (`name@version`) grouped by name: the versions of each name a lock holds. */
export const versionsByName = (keys: Iterable<string>): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  for (const key of keys) {
    const [, name, version] = /^(@?[^@]+)@(.+)$/.exec(key) ?? [];
    if (name !== undefined) map.set(name, (map.get(name) ?? new Set()).add(version!));
  }
  return map;
};

/** The `patchedDependencies` key of a `patches/deps` file: `@scope__name@1.2.3.patch` → `@scope/name@1.2.3`. */
export const depPatchKey = (file: string) => file.slice(0, -".patch".length).replace(/^@([^_]+)__/, "@$1/");
