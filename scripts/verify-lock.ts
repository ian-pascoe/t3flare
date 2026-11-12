// Compares the versions Bun resolved (bun.lock) with t3's pnpm-lock.yaml (ADR-0019), and checks there is a
// single copy of `effect`, which duplicate copies break (schema decoding).
//
//   node scripts/verify-lock.ts      exit 1 when effect is duplicated
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

const root = path.resolve(import.meta.dirname, "..");

const versionsOf = (keys: Iterable<string>) => {
  const map = new Map<string, Set<string>>();
  for (const key of keys) {
    const match = /^(@?[^@]+)@(.+)$/.exec(key);
    if (match === null) continue;
    const [, name, version] = match as unknown as [string, string, string];
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)!.add(version);
  }
  return map;
};

const lockDocs = parseAllDocuments(fs.readFileSync(path.join(root, "t3code/pnpm-lock.yaml"), "utf8")).map((doc) => doc.toJS()) as unknown;
const t3Lock = (Array.isArray(lockDocs) ? lockDocs : [lockDocs]).find((doc) => doc?.settings !== undefined) as {
  packages: Record<string, unknown>;
};
const t3 = versionsOf(Object.keys(t3Lock.packages));

// bun.lock is JSONC: `"packages": { "<alias>": ["name@version", …] }`.
const bunLockText = fs.readFileSync(path.join(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1");
const bunLock = JSON.parse(bunLockText) as { packages: Record<string, [string, ...Array<unknown>]> };
const ours = versionsOf(Object.values(bunLock.packages).map((entry) => entry[0]));

let shared = 0;
const differing: Array<string> = [];
for (const [name, versions] of ours) {
  const theirs = t3.get(name);
  if (theirs === undefined) continue;
  shared++;
  const extra = [...versions].filter((v) => !theirs.has(v.replace(/^npm:/, "")));
  if (extra.length > 0) differing.push(`${name}: ours ${[...versions].join(", ")}; t3 ${[...theirs].join(", ")}`);
}
const effect = [...(ours.get("effect") ?? [])];
const result = { shared, differing: differing.length, effectCopies: effect };
console.log(JSON.stringify(result));
if (process.argv.includes("--list")) for (const line of differing) console.log(`  ${line}`);
if (effect.length !== 1) {
  console.error(`effect resolves to ${effect.length} versions: ${effect.join(", ")}`);
  process.exit(1);
}
