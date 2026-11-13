// Generates the root pnpm-workspace.yaml from t3code's (ADR-0001, ADR-0030): our packages plus the t3 packages we
// import, and t3's settings copied as they are, so the root resolves t3's packages the way t3 does.
//
//   node scripts/gen-workspace.ts            write pnpm-workspace.yaml, package.json's packageManager and
//                                            engines.node, and mise.toml's node, pnpm and vp
//   node scripts/gen-workspace.ts --check    exit 1 when any of them differs from what the pinned t3code gives
//
// A t3 setting this script has not classified fails it ("classify it"), so a new key never lands unread in a bump.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "yaml";
import { bareKey, closure, depPatchKey, readLock, versionsByName } from "./lock.ts";

const root = path.resolve(import.meta.dirname, "..");
const t3 = path.join(root, "t3code");
const PREFIX = "t3code/";
const check = process.argv.includes("--check");

// The t3 packages we import; their workspace dependencies are added transitively.
const T3_ROOTS = ["t3", "@t3tools/web"];
// Our own workspace globs, vendored packages included (vendor/cloudpid/README.md).
const OUR_WORKSPACES = ["apps/*", "packages/*", "vendor/cloudpid/*", "infra"];

// t3's top-level settings, by how they reach our root. Anything else fails the script.
const COPIED = [
  "catalog",
  "overrides",
  "packageExtensions",
  "strictPeerDependencies",
  "peerDependencyRules",
  "permissions",
  "publicHoistPattern",
  "minimumReleaseAgeExclude",
] as const;
const ADJUSTED = ["packages", "patchedDependencies", "allowBuilds"] as const;

// Ours, merged into t3's overrides.
const OUR_OVERRIDES: Record<string, string> = {
  // The vendored packages ask for each other as "*" (vendor/ is not edited); pnpm would fetch those from the registry.
  "@cloudpid/protocol": "workspace:*",
  "@cloudpid/config": "workspace:*",
  // Our core packages stay where Bun's per-name pins held them (plan §2.6's no-move rule; docs/steps/pnpm/lock-diff.ts).
  // wrangler and miniflare (tests only) ask for a newer workerd; the deploy uses @alchemy.run/cloudflare-runtime's.
  workerd: "1.20261026.1",
  "@cloudflare/workers-types@^5.20261104.1": "5.20261108.1",
  // @alchemy.run/cloudflare's `^4.1.0`; t3 does not install it.
  "@effect/sql-d1": "4.1.1",
};

// Ours, merged into t3's peerDependencyRules.allowedVersions (t3's strictPeerDependencies covers our packages too).
const OUR_ALLOWED_PEERS: Record<string, string> = {
  // Our oxlint (1.91.0) is newer than vite-plus's oxlint-tsgolint. Our lint never uses that backend: oxlint
  // --type-aware runs tsrslint's, linked as node_modules/.bin/tsgolint by scripts/link-tsrslint.sh.
  "oxlint>oxlint-tsgolint": "7.0.2004",
};

// Dependency build scripts are denied (review H4): nothing in the Worker needs a native build, and CI's deploy step
// carries secrets. t3's `true`s become `false`; ours with install scripts are listed so pnpm does not fail on them.
// Allow one only when proven needed, with the reason beside it.
const OUR_DENIED_BUILDS = ["@google/genai", "@mongodb-js/zstd", "node-liblzma", "protobufjs"];

type Json = Record<string, any>;
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, "utf8"));

const t3Packages = new Map<string, { dir: string; json: Json }>();
for (const group of ["apps", "packages", "infra"]) {
  for (const name of fs.readdirSync(path.join(t3, group))) {
    const file = path.join(t3, group, name, "package.json");
    if (fs.existsSync(file)) t3Packages.set(readJson(file).name, { dir: `${group}/${name}`, json: readJson(file) });
  }
}
const members = new Set<string>();
const queue = [...T3_ROOTS];
while (queue.length > 0) {
  const pkg = t3Packages.get(queue.pop()!);
  if (pkg === undefined || members.has(pkg.dir)) continue;
  members.add(pkg.dir);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries<string>(pkg.json[field] ?? {})) if (spec.startsWith("workspace:")) queue.push(dep);
  }
}

const ws = parse(fs.readFileSync(path.join(t3, "pnpm-workspace.yaml"), "utf8")) as Json;
const unknown = Object.keys(ws).filter((key) => !(COPIED as ReadonlyArray<string>).includes(key) && !(ADJUSTED as ReadonlyArray<string>).includes(key));
if (unknown.length > 0) {
  console.error(`t3code/pnpm-workspace.yaml has settings gen-workspace.ts has not classified: ${unknown.join(", ")}.`);
  console.error("Classify each in COPIED or ADJUSTED (or drop it on purpose), then rerun.");
  process.exit(1);
}

// t3's patches for packages our install contains (review H1): pnpm fails on a patch that matches nothing, so a key is
// kept only when its name@version is installed by our t3 importers in t3's lock, or by any importer in our own lock
// (our packages' own dependencies, such as alchemy). A first install without a root lock can miss the latter;
// `--check` then reports the file stale, and verify-lock.ts fails on any t3-patched version left unpatched.
const t3Lock = readLock(path.join(t3, "pnpm-lock.yaml")).main;
const installed = new Set([...closure(t3Lock, members)].map(bareKey));
const rootLockFile = path.join(root, "pnpm-lock.yaml");
if (fs.existsSync(rootLockFile)) {
  const rootLock = readLock(rootLockFile).main;
  for (const key of closure(rootLock, Object.keys(rootLock.importers))) installed.add(bareKey(key));
}

// t3's edges into names its lock holds at several versions, pinned as t3 resolved them. A snapshot's key carries only
// its peers, so when one of our packages also installs `parent@v`, pnpm resolves the parent's dependencies afresh and
// takes the highest version already in the lock, for t3's importers too (measured in M3: the MCP SDK's jose moved).
// Single-version names need no pin: the seeded lock already holds them.
const t3Versions = versionsByName(Object.keys(t3Lock.packages ?? {}));
const T3_EDGE_PINS: Record<string, string> = {};
for (const key of closure(t3Lock, members)) {
  const snapshot = t3Lock.snapshots?.[key] as Json | undefined;
  // A snapshot lists its resolved peers among its dependencies; those follow the parent's context, not a pin.
  const peers = (t3Lock.packages?.[bareKey(key)] as Json | undefined)?.peerDependencies ?? {};
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [name, raw] of Object.entries<string>(snapshot?.[field] ?? {})) {
      const version = String(raw).replace(/\(.*$/, "");
      if (!/^\d/.test(version) || (t3Versions.get(name)?.size ?? 0) < 2 || name in peers) continue;
      T3_EDGE_PINS[`${bareKey(key)}>${name}`] = version;
    }
  }
}

const patchedDependencies: Record<string, string> = {};
for (const [key, file] of Object.entries<string>(ws.patchedDependencies ?? {})) {
  if (installed.has(key)) patchedDependencies[key] = `${PREFIX}${file}`;
}
// Our own dependency patches (`patches/deps/<scope>__<name>@<version>.patch`): not t3 Patches (ADR-0001 counts those).
const depPatches = path.join(root, "patches/deps");
for (const file of fs.readdirSync(depPatches).filter((name) => name.endsWith(".patch")).sort()) {
  const key = depPatchKey(file);
  if (ws.patchedDependencies?.[key] !== undefined) throw new Error(`patches/deps/${file}: t3 already patches ${key}`);
  patchedDependencies[key] = `patches/deps/${file}`;
}

const allowBuilds: Record<string, boolean> = {};
for (const key of Object.keys(ws.allowBuilds ?? {})) {
  if (key.includes("@file:")) continue; // a tarball only t3's mobile app installs
  allowBuilds[key] = false;
}
for (const name of OUR_DENIED_BUILDS) allowBuilds[name] = false;

const out: Json = {
  packages: [...OUR_WORKSPACES, ...[...members].sort().map((dir) => `${PREFIX}${dir}`)],
};
for (const key of Object.keys(ws)) {
  if (key === "packages") continue;
  if (key === "patchedDependencies") out.patchedDependencies = patchedDependencies;
  else if (key === "allowBuilds") out.allowBuilds = Object.fromEntries(Object.entries(allowBuilds).sort(([a], [b]) => a.localeCompare(b)));
  else if (key === "overrides") {
    const pins = Object.fromEntries(Object.entries(T3_EDGE_PINS).filter(([pin]) => ws.overrides[pin] === undefined).sort(([a], [b]) => a.localeCompare(b)));
    out.overrides = { ...ws.overrides, ...OUR_OVERRIDES, ...pins };
  }
  else if (key === "peerDependencyRules") {
    out.peerDependencyRules = { ...ws.peerDependencyRules, allowedVersions: { ...ws.peerDependencyRules.allowedVersions, ...OUR_ALLOWED_PEERS } };
  }
  else out[key] = ws[key];
}
// A `pnpm run` with missing or stale dependencies fails instead of installing (review M3).
out.verifyDepsBeforeRun = "error";

const t3Manifest = readJson(path.join(t3, "package.json"));
const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)/.exec(t3Manifest.packageManager ?? "")?.[1];
const nodeVersion = t3Manifest.engines?.node as string | undefined;
if (pnpmVersion === undefined || nodeVersion === undefined || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  throw new Error(`t3code/package.json: expected packageManager pnpm@x.y.z and an exact engines.node, got ${t3Manifest.packageManager} / ${nodeVersion}`);
}

// vp (Vite+) is mise's `vp` tool at the version of t3's `vite-plus` catalog entry, so the owner's PATH, CI's setup-vp
// (which reads the same entry through package.json's `catalog:` and the generated pnpm-workspace.yaml) and the
// installed vite-plus all agree.
const vpVersion = ws.catalog?.["vite-plus"] as string | undefined;
if (vpVersion === undefined || !/^\d+\.\d+\.\d+$/.test(vpVersion)) {
  throw new Error(`t3code/pnpm-workspace.yaml: expected an exact catalog entry for vite-plus, got ${vpVersion}`);
}

const files = new Map<string, string>();
files.set(
  "pnpm-workspace.yaml",
  `# Generated by scripts/gen-workspace.ts from t3code/pnpm-workspace.yaml; do not edit. t3's comments are in its file.\n${stringify(out, { lineWidth: 0 })}`,
);
const manifest = readJson(path.join(root, "package.json"));
manifest.packageManager = `pnpm@${pnpmVersion}`;
manifest.engines = { ...manifest.engines, node: nodeVersion };
files.set("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
files.set(
  "mise.toml",
  [
    "# Generated by scripts/gen-workspace.ts from t3code/package.json (packageManager, engines.node) and t3code/pnpm-workspace.yaml (the vite-plus catalog entry); do not edit.",
    "[tools]",
    `node = "${nodeVersion}"`,
    `pnpm = "${pnpmVersion}"`,
    `vp = "${vpVersion}"`,
    "",
    "# A pnpm or vp command run inside t3code/ would otherwise install it as its own workspace (AGENTS.md).",
    "[env]",
    'NPM_CONFIG_WORKSPACE_DIR = "{{config_root}}"',
    "",
  ].join("\n"),
);

if (check) {
  const stale = [...files].filter(([file, text]) => !fs.existsSync(path.join(root, file)) || fs.readFileSync(path.join(root, file), "utf8") !== text);
  // A pnpm command run inside t3code/ installs it as its own workspace (AGENTS.md).
  const nested = fs.existsSync(path.join(t3, "node_modules/.pnpm"));
  for (const [file] of stale) console.error(`${file} is stale: run \`pnpm run gen:workspace\``);
  if (nested) console.error("t3code/node_modules/.pnpm exists: a pnpm or vp command ran inside t3code/. Remove t3code/node_modules and reinstall.");
  if (stale.length > 0 || nested) process.exit(1);
  console.log(`workspace ok: ${members.size} t3 packages, ${Object.keys(patchedDependencies).length} patches`);
} else {
  for (const [file, text] of files) fs.writeFileSync(path.join(root, file), text);
  const dropped = Object.keys(ws.patchedDependencies ?? {}).filter((key) => patchedDependencies[key] === undefined);
  console.log(`workspace: ${members.size} t3 packages; pnpm ${pnpmVersion}, node ${nodeVersion}`);
  console.log(`patches: ${Object.keys(patchedDependencies).length} kept; ${dropped.length} of t3's outside our install`);
}
