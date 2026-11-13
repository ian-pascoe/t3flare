// Seeds the root pnpm-lock.yaml from t3code's, so the root installs t3's packages at t3's resolutions (ADR-0030).
// Run after gen-workspace.ts and before `pnpm install --no-frozen-lockfile`, which keeps every seeded resolution,
// resolves our own packages, and prunes what nothing uses.
//
//   node scripts/seed-lock.ts
//
//  1. Take both documents of t3code/pnpm-lock.yaml: pnpm's env document (its own version, which ours follows, see
//     gen-workspace.ts) as is, and the main one as below.
//  2. Keep the importers of the t3 packages in pnpm-workspace.yaml, re-keyed under `t3code/`. Their `link:` paths are
//     relative between t3 directories, so they stay valid. Keep only the packages and snapshots they install.
//  3. Write the settings header pnpm computes for our root: t3's catalogs and packageExtensions checksum, t3's
//     overrides plus ours, our patches (sha256 of each file), no pnpmfile checksum. A header that differs from the
//     config makes pnpm re-resolve everything, which moves t3's packages (review M1; measured in M0).
//  4. Our own importers are not kept: pnpm resolves them against the seeded t3 graph. Kept, their entries (a newer
//     version of a name t3 also installs) win pnpm's deduplication and move t3's transitive dependencies (measured
//     in M0: tldts). verify-lock.ts fails on any such move, and docs/steps/pnpm/lock-diff.ts shows ours.
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

const importers = Object.fromEntries(members.sort().map((dir) => [`${PREFIX}${dir}`, t3.importers[dir]]));
const reachable = closure(t3, members);
const installed = new Set([...reachable].map(bareKey));
const snapshots = Object.fromEntries(Object.entries(t3.snapshots).filter(([key]) => reachable.has(key)));
const packages = Object.fromEntries(Object.entries(t3.packages).filter(([key]) => installed.has(key)));

const patchedDependencies = Object.fromEntries(
  Object.entries(workspace.patchedDependencies)
    .map(([key, file]) => [key, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")] as const)
    .sort(([a], [b]) => a.localeCompare(b)),
);
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
