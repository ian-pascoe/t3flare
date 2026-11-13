// Checks the root pnpm-lock.yaml against t3code's (ADR-0030):
//
//  - every t3 importer installs exactly what it installs in t3's lock (the transitive closure, by name@version;
//    peer and patch suffixes aside);
//  - one copy of `effect`, which duplicate copies break (schema decoding);
//  - every version t3 patches that our install contains is patched, and so is every `patches/deps` key;
//  - the vendored `@cloudpid/*` packages link to the workspace, never the registry (review H2).
//
//   node scripts/verify-lock.ts [--list]     prints one JSON line; exit 1 on any failure
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { bareKey, closure, DEPENDENCY_FIELDS, depPatchKey, readLock, versionsByName, type Json } from "./lock.ts";

const root = path.resolve(import.meta.dirname, "..");
const PREFIX = "t3code/";
const ours = readLock(path.join(root, "pnpm-lock.yaml")).main;
const t3 = readLock(path.join(root, "t3code/pnpm-lock.yaml")).main;
const failures: Array<string> = [];

// Peer choices that sharing one workspace with our packages moves, each explained. pnpm satisfies an unmet peer with
// the highest version already in the graph, and our packages bring newer ones; an override does not reach a peer.
// Anything not listed here fails.
const PEER_DRIFT: ReadonlyArray<{ readonly t3: ReadonlyArray<string>; readonly ours: RegExp; readonly why: string }> = [
  {
    t3: ["@anthropic-ai/sdk@0.93.0"],
    ours: /^(@anthropic-ai\/sdk@0\.129\.0|standardwebhooks@1\.\d+\.\d+|@stablelib\/base64@1\.0\.1|fast-sha256@1\.3\.0)$/,
    why: "the peer of @anthropic-ai/claude-agent-sdk (a stub in the Worker); pi-ai pins 0.129.0",
  },
  {
    t3: ["supports-color@8.1.1", "has-flag@4.0.0"],
    ours: /^supports-color@10\.2\.2$/,
    why: "debug's optional peer, which only colours its output",
  },
  {
    t3: ["typescript@6.0.3"],
    ours: /^(typescript|@typescript\/typescript-[\w-]+)@7\.0\.2$/,
    why: "build tools' peer, from our root's typescript (effect-tsgo); Bun resolved 7.0.2 too",
  },
];
const driftT3 = new Set(PEER_DRIFT.flatMap((drift) => drift.t3));
const driftOurs = (key: string) => PEER_DRIFT.some((drift) => drift.ours.test(key));

// t3's importers: the same closure.
const t3Importers = Object.keys(ours.importers).filter((dir) => dir.startsWith(PREFIX));
let compared = 0;
for (const dir of t3Importers) {
  const theirs = new Set([...closure(t3, [dir.slice(PREFIX.length)])].map(bareKey));
  const mine = new Set([...closure(ours, [dir])].map(bareKey));
  compared += theirs.size;
  const missing = [...theirs].filter((key) => !mine.has(key) && !driftT3.has(key));
  const extra = [...mine].filter((key) => !theirs.has(key) && !driftOurs(key));
  if (missing.length > 0 || extra.length > 0) {
    failures.push(`${dir}: t3 installs but we do not: ${missing.join(", ") || "-"}; we install but t3 does not: ${extra.join(", ") || "-"}`);
  }
}

// One effect.
const names = versionsByName(Object.keys(ours.packages ?? {}));
const effect = [...(names.get("effect") ?? [])];
if (effect.length !== 1) failures.push(`effect resolves to ${effect.length} versions: ${effect.join(", ")}`);

// Patches.
const installed = new Set([...closure(ours, Object.keys(ours.importers))].map(bareKey));
const patched = new Set(Object.keys(ours.patchedDependencies ?? {}));
const t3Patches = Object.keys((parse(fs.readFileSync(path.join(root, "t3code/pnpm-workspace.yaml"), "utf8")) as Json).patchedDependencies ?? {});
for (const key of t3Patches) if (installed.has(key) && !patched.has(key)) failures.push(`t3 patches ${key}, which we install unpatched`);
for (const file of fs.readdirSync(path.join(root, "patches/deps")).filter((name) => name.endsWith(".patch"))) {
  const key = depPatchKey(file);
  if (!patched.has(key)) failures.push(`patches/deps/${file} is not in the lock's patchedDependencies`);
}

// Vendored links.
const VENDORED = ["@cloudpid/protocol", "@cloudpid/config"];
let links = 0;
for (const [dir, importer] of Object.entries<Json>(ours.importers)) {
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of VENDORED) {
      const version = importer[field]?.[name]?.version as string | undefined;
      if (version === undefined) continue;
      if (version.startsWith("link:")) links++;
      else failures.push(`${dir} resolves ${name} to ${version}, not the workspace`);
    }
  }
}

// For information: names both locks hold, at versions t3's lock does not have.
const t3Names = versionsByName(Object.keys(t3.packages ?? {}));
const differing: Array<string> = [];
for (const [name, versions] of names) {
  const theirs = t3Names.get(name);
  if (theirs !== undefined && [...versions].some((v) => !theirs.has(v))) {
    differing.push(`${name}: ours ${[...versions].join(", ")}; t3 ${[...theirs].join(", ")}`);
  }
}

console.log(
  JSON.stringify({
    t3Importers: t3Importers.length,
    t3ClosureEntries: compared,
    effectCopies: effect,
    patches: patched.size,
    vendoredLinks: links,
    sharedNamesAtOtherVersions: differing.length,
    failures: failures.length,
  }),
);
if (process.argv.includes("--list")) for (const line of differing) console.log(`  ${line}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
