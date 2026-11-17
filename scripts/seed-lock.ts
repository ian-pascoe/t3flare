// Seeds the root pnpm-lock.yaml from t3code's, so the root installs t3's packages at t3's resolutions (ADR-0030).
// Run after gen-workspace.ts and before `pnpm install --no-frozen-lockfile`, which keeps every seeded resolution,
// resolves our own packages, and prunes what nothing uses.
//
//   node scripts/seed-lock.ts [--refresh]    --refresh: carry none of t3flare's own resolutions over (step 4), so pnpm
//                                            resolves them again (relock.ts --refresh)
//
//  1. Take both documents of t3code/pnpm-lock.yaml: pnpm's env document (its own version, which ours follows, see
//     gen-workspace.ts) as is, and the main one as below.
//  2. Keep the importers of the t3 packages in pnpm-workspace.yaml, re-keyed under `t3code/`. Their `link:` paths are
//     relative between t3 directories, so they stay valid. Keep only the packages and snapshots they install.
//  3. Write the settings header pnpm computes for our root: t3's catalogs and packageExtensions checksum, t3's
//     overrides plus ours, our patches (sha256 of each file), no pnpmfile checksum. A header that differs from the
//     config makes pnpm re-resolve everything, which moves t3's packages (review M1; measured in M0).
//  4. Our own importers are kept as the current lock resolves them, with what they install that t3's graph does not name
//     (ADR-0037, review B2: a bump moves only what t3 moved, which the land check then holds it to). Names t3 installs
//     are left out: kept, our entries (a newer version of a name t3 also installs) win pnpm's deduplication and move
//     t3's transitive dependencies (measured in M0: tldts). pnpm resolves those against the seeded t3 graph, and
//     relock.ts's `--fix-lockfile` mends the references left dangling. verify-lock.ts fails on any move of t3's graph.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "yaml";
import { bareKey, closure, readLock } from "./lock.ts";

const root = path.resolve(import.meta.dirname, "..");
const PREFIX = "t3code/";

const t3Lock = readLock(path.join(root, "t3code/pnpm-lock.yaml"));
const t3 = t3Lock.main;
const env = t3Lock.documents.find((doc) => doc !== t3);
const workspace = parse(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as {
  packages: Array<string>;
  overrides: Record<string, string>;
  patchedDependencies: Record<string, string>;
};
const members = workspace.packages.filter((entry) => entry.startsWith(PREFIX)).map((entry) => entry.slice(PREFIX.length));

const importers: Record<string, unknown> = Object.fromEntries(members.sort().map((dir) => [`${PREFIX}${dir}`, t3.importers[dir]]));
const reachable = closure(t3, members);
const installed = new Set([...reachable].map(bareKey));
const snapshots: Record<string, unknown> = Object.fromEntries(Object.entries(t3.snapshots).filter(([key]) => reachable.has(key)));
const packages: Record<string, unknown> = Object.fromEntries(Object.entries(t3.packages).filter(([key]) => installed.has(key)));

const patchedDependencies = Object.fromEntries(
  Object.entries(workspace.patchedDependencies)
    .map(([key, file]) => [key, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")] as const)
    .sort(([a], [b]) => a.localeCompare(b)),
);
// Ours, as the current lock resolves them (ADR-0037, review B2): our importers, and what they install that t3's graph
// does not name, are kept, so a bump moves only what t3 moved and what follows from t3's catalog and overrides. A name
// t3 installs is left out (kept, ours would win pnpm's deduplication and move t3's packages, see 4.): pnpm resolves
// that dependency again against the seeded t3 graph.
const currentFile = path.join(root, "pnpm-lock.yaml");
const current = fs.existsSync(currentFile) && !process.argv.includes("--refresh") ? readLock(currentFile).main : undefined;
const t3Names = new Set([...installed].map((key) => key.replace(/^(@?[^@]+)@.*$/, "$1")));
const nameOf = (key: string) => key.replace(/^(@?[^@]+)@.*$/, "$1");
if (current !== undefined) {
  const ours = Object.keys(current.importers).filter((dir) => !dir.startsWith(PREFIX));
  for (const dir of ours) importers[dir] = current.importers[dir];
  const kept = [...closure(current, ours)].filter((key) => !t3Names.has(nameOf(key)) && current.snapshots?.[key] !== undefined);
  for (const key of kept) {
    snapshots[key] = current.snapshots[key];
    if (current.packages?.[bareKey(key)] !== undefined) packages[bareKey(key)] = current.packages[bareKey(key)];
  }
}
const seeded = {
  lockfileVersion: t3.lockfileVersion,
  settings: t3.settings,
  catalogs: t3.catalogs,
  overrides: workspace.overrides,
  packageExtensionsChecksum: t3.packageExtensionsChecksum,
  patchedDependencies,
  importers,
  packages,
  snapshots,
};
fs.writeFileSync(
  path.join(root, "pnpm-lock.yaml"),
  [env, seeded].filter((doc) => doc !== undefined).map((doc) => `---\n${stringify(doc, { lineWidth: 0 })}`).join("\n"),
);
console.log(`seeded pnpm-lock.yaml: ${members.length} t3 importers, ${Object.keys(snapshots).length} snapshots from t3code`);
