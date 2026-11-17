// The pnpm lock (v9) as a graph: dependency-free, so the trusted update jobs (ADR-0037) read it with plain Node.
// `lock.ts` re-exports it beside `readLock`, which parses the file with `yaml`.

export type Json = Record<string, any>;

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

/** A package key's name: `@scope/name@1.2.3(peer@4)` → `@scope/name`. */
export const nameOfKey = (key: string) => /^(@?[^@]+)@/.exec(key)?.[1] ?? key;

/** The snapshot keys reachable from `roots` (snapshot keys), roots included. */
export const reachableFrom = (lock: Json, roots: Iterable<string>): Set<string> => {
  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    const snapshot = lock.snapshots?.[key] as Json | undefined;
    for (const deps of [snapshot?.dependencies, snapshot?.optionalDependencies]) {
      for (const [name, version] of Object.entries<string>(deps ?? {})) {
        if (version.startsWith("link:")) continue;
        stack.push(/^\d/.test(version) ? `${name}@${version}` : version);
      }
    }
  }
  return reachable;
};

/** An importer dependency's snapshot key (`version` as the importer records it), or undefined for a link. */
export const importerKey = (name: string, version: string): string | undefined =>
  version.startsWith("link:") ? undefined : /^\d/.test(version) ? `${name}@${version}` : version;
