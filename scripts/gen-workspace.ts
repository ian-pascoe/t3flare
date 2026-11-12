// Generates the root package.json's workspace fields from t3code's pnpm-workspace.yaml
// (ADR-0001, ADR-0019): Bun reads catalogs, overrides and patchedDependencies only at the
// root, so we derive them from the submodule instead of copying them by hand.
//
//   node scripts/gen-workspace.ts
//
// Fields it owns in package.json: workspaces, overrides, patchedDependencies.
// Everything it cannot translate is printed, so a bump shows what changed.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, parseAllDocuments } from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const t3 = path.join(root, "t3code");
const PREFIX = "t3code/";

// The t3 packages we import; their workspace dependencies are added transitively.
const T3_ROOTS = ["t3", "@t3tools/web"];
// Our own workspace globs.
const OUR_WORKSPACES = ["apps/*", "packages/*", "infra"];
// Vendored packages (vendor/cloudpid/README.md): workspace members, but their dependencies are pinned like t3's.
const VENDORED = ["vendor/cloudpid/*"];

type Pkg = { dir: string; json: Record<string, any> };
const t3Packages = new Map<string, Pkg>();
for (const group of ["apps", "packages", "infra"]) {
  for (const name of fs.readdirSync(path.join(t3, group))) {
    const file = path.join(t3, group, name, "package.json");
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    t3Packages.set(json.name, { dir: `${group}/${name}`, json });
  }
}

const members = new Set<string>();
const queue = [...T3_ROOTS];
while (queue.length > 0) {
  const name = queue.pop()!;
  const pkg = t3Packages.get(name);
  if (pkg === undefined || members.has(pkg.dir)) continue;
  members.add(pkg.dir);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries<string>(pkg.json[field] ?? {})) {
      if (spec.startsWith("workspace:")) queue.push(dep);
    }
  }
}

const ws = parse(fs.readFileSync(path.join(t3, "pnpm-workspace.yaml"), "utf8")) as {
  catalog: Record<string, string>;
  overrides: Record<string, string>;
  patchedDependencies: Record<string, string>;
};

const skipped: string[] = [];
const catalog = ws.catalog;

// pnpm overrides → Bun overrides. Bun supports only top-level package names, so a
// `parent>child` edge becomes a plain override of `child` when it pins a version, a
// `pkg@^8` selector becomes `pkg`, and removals ("-") have no Bun equivalent.
const overrides: Record<string, string> = {};
for (const [key, raw] of Object.entries(ws.overrides)) {
  const value = raw === "catalog:" ? undefined : String(raw);
  const leaf = key.includes(">") ? key.slice(key.lastIndexOf(">") + 1) : key;
  const name = leaf.replace(/(.)@[^@]*$/, "$1");
  if (raw === "-") {
    skipped.push(`override ${key}: "-" (dependency removal; Bun has none)`);
    continue;
  }
  const version = value ?? catalog[name] ?? catalog[leaf];
  if (version === undefined) {
    skipped.push(`override ${key}: catalog has no ${name}`);
    continue;
  }
  if (key.includes(">") || leaf !== name) skipped.push(`override ${key} → ${name} (edge/selector flattened)`);
  if (overrides[name] !== undefined && overrides[name] !== version) {
    skipped.push(`override ${key}: conflicts with ${name}@${overrides[name]}`);
    continue;
  }
  overrides[name] = version;
}
// Bun does not read t3's pnpm-lock.yaml and resolves afresh, so some packages would land on releases t3
// never tested (209 of 993 at the spike; two broke the build). Every package t3's lock resolves to exactly
// one version is pinned to it. A package the lock holds at several versions cannot be pinned (Bun's
// overrides are per name), nor can our own direct dependencies be, which we choose ourselves.
const lockText = fs.readFileSync(path.join(t3, "pnpm-lock.yaml"), "utf8");
const lockDocs = parseAllDocuments(lockText).map((doc) => doc.toJS()) as unknown;
const lock = (Array.isArray(lockDocs) ? lockDocs : [lockDocs]).find(
  (doc): doc is { packages: Record<string, unknown> } => doc?.settings !== undefined && doc?.packages !== undefined,
);
if (lock === undefined) throw new Error("t3code/pnpm-lock.yaml: no lockfile document with packages");
const lockVersions = new Map<string, Set<string>>();
for (const key of Object.keys(lock.packages)) {
  const match = /^(@?[^@]+)@(.+)$/.exec(key);
  if (match === null) continue;
  const [, name, version] = match as unknown as [string, string, string];
  if (!lockVersions.has(name)) lockVersions.set(name, new Set());
  lockVersions.get(name)!.add(version);
}
const ourDirect = new Set<string>();
for (const file of [path.join(root, "package.json"), ...OUR_WORKSPACES.flatMap((glob) => {
  if (!glob.endsWith("/*")) return [path.join(root, glob, "package.json")];
  const dir = path.join(root, glob.slice(0, -2));
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name, "package.json")) : [];
})]) {
  if (!fs.existsSync(file)) continue;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries<string>(json[field] ?? {})) {
      if (!spec.startsWith("catalog:") && !spec.startsWith("workspace:")) ourDirect.add(dep);
    }
  }
}
const lockPins: Record<string, string> = {};
const multiVersion: Array<string> = [];
const notPinned: Array<string> = [];
for (const [name, versions] of [...lockVersions].sort(([a], [b]) => a.localeCompare(b))) {
  const [version] = versions;
  if (versions.size > 1) {
    multiVersion.push(`${name} (${[...versions].join(", ")})`);
    continue;
  }
  if (!/^\d/.test(version!)) {
    notPinned.push(`${name}@${version} (not a registry version)`);
    continue;
  }
  if (overrides[name] !== undefined) continue; // t3's own override wins
  if (ourDirect.has(name)) {
    notPinned.push(`${name}@${version} (our direct dependency)`);
    continue;
  }
  lockPins[name] = version!;
}
Object.assign(overrides, lockPins);
// Held at the effect version, as in cloudpid (ADR-0028): @effect/platform-bun pulls it in.
overrides["@effect/platform-node-shared"] = catalog["effect"]!;

const patchedDependencies: Record<string, string> = {};
for (const [key, file] of Object.entries(ws.patchedDependencies)) {
  patchedDependencies[key] = `${PREFIX}${file}`;
}
// Our own dependency patches (`patches/deps/<scope>__<name>@<version>.patch`, step 2a): bun patchedDependencies, not
// t3 Patches (ADR-0001 counts those apart).
const depPatches = path.join(root, "patches/deps");
if (fs.existsSync(depPatches)) {
  for (const file of fs.readdirSync(depPatches).filter((name) => name.endsWith(".patch")).sort()) {
    const key = file.slice(0, -".patch".length).replace(/^@([^_]+)__/, "@$1/");
    if (patchedDependencies[key] !== undefined) throw new Error(`patches/deps/${file}: t3 already patches ${key}`);
    patchedDependencies[key] = `patches/deps/${file}`;
  }
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.workspaces = {
  packages: [...OUR_WORKSPACES.slice(0, 2), ...VENDORED, ...OUR_WORKSPACES.slice(2), ...[...members].sort().map((dir) => `${PREFIX}${dir}`)],
  catalog,
};
pkg.overrides = overrides;
pkg.patchedDependencies = patchedDependencies;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// t3's exemptions from the minimum release age (versions it vetted younger than a day).
const bunfigPath = path.join(root, "bunfig.toml");
const excludes = (ws as { minimumReleaseAgeExclude?: string[] }).minimumReleaseAgeExclude ?? [];
fs.writeFileSync(
  bunfigPath,
  fs
    .readFileSync(bunfigPath, "utf8")
    .replace(/^minimumReleaseAgeExcludes = .*$/m, `minimumReleaseAgeExcludes = ${JSON.stringify(excludes)}`),
);

// What the lock pinning could not express, for the bump report (ADR-0019).
const report = [
  `# Generated by scripts/gen-workspace.ts from t3code/pnpm-lock.yaml; do not edit.`,
  `lock packages: ${lockVersions.size}; pinned: ${Object.keys(lockPins).length}; at several versions (not pinnable): ${multiVersion.length}; not pinned otherwise: ${notPinned.length}`,
  "",
  "## Untranslated pnpm settings",
  ...skipped.map((line) => `- ${line}`),
  "",
  "## At several versions in t3's lock (Bun overrides are per name)",
  ...multiVersion.map((line) => `- ${line}`),
  "",
  "## Not pinned",
  ...notPinned.map((line) => `- ${line}`),
  "",
];
fs.writeFileSync(path.join(root, "scripts/lock-pins.report.md"), report.join("\n"));

console.log(`workspaces: ${members.size} t3 packages`);
console.log(report[1]);
for (const line of skipped) console.log(`untranslated: ${line}`);
