// One-off evidence for the pnpm migration (plan §2.6, M0): what the move from bun.lock to pnpm-lock.yaml changes, by
// package name, in three groups:
//   (a) moved to a version t3's lock has (expected: t3's resolutions now apply exactly)
//   (b) changed, to a version t3's lock does not have (ours alone)
//   (c) added or removed
// Core packages must not move in any group (review M1), except to add a version t3's lock installs; exit 1 when one does.
//
//   node docs/steps/pnpm/lock-diff.ts <bun.lock> [out.json]
import * as fs from "node:fs";
import * as path from "node:path";
import { readLock } from "../../../scripts/lock.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const bunFile = process.argv[2];
if (bunFile === undefined) throw new Error("usage: node docs/steps/pnpm/lock-diff.ts <bun.lock> [out.json]");

const versionsOf = (keys: Iterable<string>) => {
  const map = new Map<string, Set<string>>();
  for (const key of keys) {
    const [, name, version] = /^(@?[^@]+)@(.+)$/.exec(key) ?? [];
    if (name === undefined || version!.startsWith("workspace:") || version!.startsWith("link:")) continue;
    map.set(name, (map.get(name) ?? new Set()).add(version!.replace(/^npm:/, "")));
  }
  return map;
};
// bun.lock is JSONC: `"packages": { "<alias>": ["name@version", …] }`.
const bunLock = JSON.parse(fs.readFileSync(bunFile, "utf8").replace(/,(\s*[}\]])/g, "$1")) as {
  packages: Record<string, [string, ...Array<unknown>]>;
};
const before = versionsOf(Object.values(bunLock.packages).map((entry) => entry[0]));
const after = versionsOf(Object.keys(readLock(path.join(root, "pnpm-lock.yaml")).main.packages));
const t3 = versionsOf(Object.keys(readLock(path.join(root, "t3code/pnpm-lock.yaml")).main.packages));

const CORE = [
  /^alchemy$/, /^@alchemy\.run\//, /^wrangler$/, /^workerd$/, /^miniflare$/, /^@cloudflare\//, /^@earendil-works\//,
  /^rolldown$/, /^vitest$/, /^vite-plus$/, /^@voidzero-dev\//, /^typescript$/, /^@effect\/tsgo/, /^oxlint/,
  /^@maschwenk\/tsrslint$/, /^effect$/, /^@effect\//, /^zod$/,
];
const isCore = (name: string) => CORE.some((pattern) => pattern.test(name));
const list = (set: Set<string> | undefined) => [...(set ?? [])].sort().join(", ");

const groups = { a: [] as Array<string>, b: [] as Array<string>, c: [] as Array<string> };
const coreMoves: Array<string> = [];
for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  const was = before.get(name);
  const now = after.get(name);
  if (list(was) === list(now)) continue;
  const line = `${name}: ${list(was) || "-"} → ${list(now) || "-"}`;
  if (was === undefined || now === undefined) groups.c.push(line);
  else if ([...now].every((version) => t3.get(name)?.has(version))) groups.a.push(line);
  else groups.b.push(line);
  // A core package may gain a version t3's own graph installs (unrun's rolldown), and nothing else.
  const onlyT3Added = was !== undefined && [...was].every((v) => now?.has(v)) && [...(now ?? [])].every((v) => was.has(v) || t3.get(name)?.has(v));
  if (isCore(name) && !onlyT3Added) coreMoves.push(line);
}

const result = { counts: { a: groups.a.length, b: groups.b.length, c: groups.c.length }, coreMoves, groups };
if (process.argv[3] !== undefined) fs.writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.counts));
for (const line of coreMoves) console.log(`core moved: ${line}`);
process.exit(coreMoves.length === 0 ? 0 : 1);
