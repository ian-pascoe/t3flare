// @effect-diagnostics nodeBuiltinImport:off
// Reading pnpm lockfiles (v9) for gen-workspace.ts, seed-lock.ts and verify-lock.ts.
import * as fs from "node:fs";
import { parseAllDocuments } from "yaml";

import type { Json } from "./lockGraph.ts";

export type { Json } from "./lockGraph.ts";

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

export { bareKey, closure, DEPENDENCY_FIELDS, depPatchKey, versionsByName } from "./lockGraph.ts";
