// Generates the root package.json's workspace fields from t3code's pnpm-workspace.yaml
// (ADR-0001, ADR-0019): Bun reads catalogs, overrides and patchedDependencies only at the
// root, so we derive them from the submodule instead of copying them by hand.
//
//   bun scripts/gen-workspace.ts
//
// Fields it owns in package.json: workspaces, overrides, patchedDependencies.
// Everything it cannot translate is printed, so a bump shows what changed.
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const t3 = path.join(root, "t3code");
const PREFIX = "t3code/";

// The t3 packages we import; their workspace dependencies are added transitively.
const T3_ROOTS = ["t3", "@t3tools/web"];
// Our own workspace globs.
const OUR_WORKSPACES = ["apps/*", "packages/*"];

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

const ws = Bun.YAML.parse(fs.readFileSync(path.join(t3, "pnpm-workspace.yaml"), "utf8")) as {
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
// Bun resolves afresh instead of reading t3's pnpm lock, so some packages land on newer
// releases than t3 tested. Pin the ones that break a build back to t3's lock.
const LOCK_PINS: Record<string, string> = {
  // 2.2.0 ships no license file, which fails the web build's third-party notice check.
  "@nodable/entities": "2.1.1",
  // claude-agent-sdk asks for ">=0.93.0"; 1.x changes the content block types t3 compiles against.
  "@anthropic-ai/sdk": "0.93.0",
};
Object.assign(overrides, LOCK_PINS);
// Held at the effect version, as in cloudpid (ADR-0028): @effect/platform-bun pulls it in.
overrides["@effect/platform-node-shared"] = catalog["effect"]!;

const patchedDependencies: Record<string, string> = {};
for (const [key, file] of Object.entries(ws.patchedDependencies)) {
  patchedDependencies[key] = `${PREFIX}${file}`;
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.workspaces = {
  packages: [...OUR_WORKSPACES, ...[...members].sort().map((dir) => `${PREFIX}${dir}`)],
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

console.log(`workspaces: ${members.size} t3 packages`);
for (const line of skipped) console.log(`untranslated: ${line}`);
