// `node scripts/land-check.ts --ref <candidate> --pin <t3:<tag> | cli:<cli>:<version>> [--base <ref>]`
//
// May this proposed pin be published as proven, or land (ADR-0037; review F3)? Run by the trusted jobs (`bump.yml`'s
// publish, `cli-bump.yml`'s publish, `land.yml`) on a runner that ran no upstream code, with plain Node: no install but
// `yaml` at main's locked version for a t3 bump (`scripts/updates-ci.ts install-yaml`). The pin comes from the caller's
// inputs, never from the bump's report. Exits 0 with `{"ok":true,"sha":…}` as its last line, 1 with the reason.
//
//  1. The shape (`land.ts` `landRefusal`): one commit on `--base` (origin/main), only its kind's files, and for a t3 bump
//     the `t3code` gitlink equal to the tag's commit on t3code's origin.
//  2. The content. Step 1 passed, so every file outside the allowlist, these scripts included, is main's own.
//     - CLI bump: only that CLI's fields moved (`cliPinRefusal`), and the pin made again here from main's files
//       (`applyCliPin`: the tarballs downloaded and hashed, the npm lock resolved with `--package-lock-only
//       --ignore-scripts`, which runs no package code) is byte for byte the proposed one.
//     - t3 bump: package.json moves only packageManager and engines.node; in a worktree of the candidate with t3code at
//       the tag (data: nothing of it runs), `gen-workspace.ts --check` regenerates pnpm-workspace.yaml, package.json's
//       two fields and mise.toml from t3code and requires them equal; `verify-lock.ts` holds t3's graph in the lock to
//       t3's own lock; `t3LockRefusal` holds everything outside that graph to main's or t3's lock (importers, snapshots,
//       packages, the header); and `lockProvenance` has the npm registry confirm any entry of t3's graph neither lock
//       holds. The lock is not regenerated: the land runs hours after the proof, and the registry moves.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyCliPin, CLI_PIN_FILES, cliPinRefusal, type PinFiles } from "../apps/environment/scripts/lib/cliPins.ts";
import { landRefusal, lockProvenance, t3LockRefusal, t3ManifestRefusal } from "../apps/environment/scripts/lib/land.ts";
import { COMMIT, parsePin, type Pin } from "../apps/environment/src/updates/pins.ts";
import { git as gitIn, optionOf, tagCommitOf } from "./lib/updatesGit.ts";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = optionOf(args);
const git = (gitArgs: ReadonlyArray<string>, cwd = root) => gitIn(gitArgs, cwd);

const refuse = (reason: string): never => {
  console.error(`land-check: refused: ${reason}`);
  process.exit(1);
};

const pinned = parsePin(option("pin"));
if (typeof pinned === "string") refuse(pinned);
const pin = pinned as Pin;
const ref = option("ref") ?? refuse("--ref is required");
const base = option("base") ?? "origin/main";
const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]).out;
if (!COMMIT.test(sha)) refuse(`${ref} is not a commit`);

// 1. The shape.
const submoduleUrl = git(["config", "-f", ".gitmodules", "submodule.t3code.url"]).out;
const gitlink = pin.kind === "t3" ? /^160000 commit ([0-9a-f]{40})\tt3code$/m.exec(git(["ls-tree", sha, "t3code"]).out)?.[1] : undefined;
const facts = {
  pin,
  mainIsAncestor: git(["merge-base", "--is-ancestor", base, sha]).ok,
  commits: Number(git(["rev-list", "--count", `${base}..${sha}`]).out || "0"),
  files: git(["diff", "--name-only", base, sha]).out.split("\n").filter((file) => file !== ""),
  gitlink,
  tagCommit: pin.kind === "t3" ? tagCommitOf(submoduleUrl, pin.tag) : undefined,
};
console.log(JSON.stringify(facts));
const shape = landRefusal(facts);
if (shape !== undefined) refuse(shape);

const show = (at: string, file: string) => {
  const result = git(["show", `${at}:${file}`]);
  if (!result.ok) refuse(`${file} is not at ${at}`);
  return result.raw;
};

// 2. The content.
if (pin.kind === "cli") {
  const files = (at: string) => Object.fromEntries(CLI_PIN_FILES.map((file) => [file, show(at, file)])) as PinFiles;
  const before = files(base);
  const after = files(sha);
  const fields = cliPinRefusal(pin.cli, pin.version, before, after);
  if (fields !== undefined) refuse(fields);
  // The pin made again from main's files.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "land-check-"));
  for (const [file, text] of Object.entries(before)) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.writeFileSync(path.join(scratch, file), text);
  }
  await applyCliPin(scratch, pin.cli, pin.version).catch((error: unknown) => refuse(`could not make the pin again: ${String(error)}`));
  const differing = CLI_PIN_FILES.filter((file) => fs.readFileSync(path.join(scratch, file), "utf8") !== after[file]);
  fs.rmSync(scratch, { recursive: true, force: true });
  if (differing.length > 0) refuse(`made again from main, the pin differs in ${differing.join(", ")}`);
} else {
  const manifest = t3ManifestRefusal(show(base, "package.json"), show(sha, "package.json"));
  if (manifest !== undefined) refuse(manifest);
  const yaml = path.join(root, "node_modules/yaml");
  if (!fs.existsSync(yaml)) refuse("yaml is not installed (scripts/updates-ci.ts install-yaml)");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "land-check-tree-"));
  const added = git(["worktree", "add", "--detach", tree, sha]);
  if (!added.ok) refuse(`git worktree add: ${added.err}`);
  // `refuse` exits: the worktree goes on exit, whatever the outcome.
  process.on("exit", () => void git(["worktree", "remove", "--force", tree]));
  {
    // t3code at the gitlink, as data: no script of it runs.
    const submodule = git(["submodule", "update", "--init", "t3code"], tree);
    if (!submodule.ok) refuse(`git submodule update: ${submodule.err}`);
    fs.mkdirSync(path.join(tree, "node_modules"), { recursive: true });
    fs.symlinkSync(fs.realpathSync(yaml), path.join(tree, "node_modules/yaml"));
    for (const script of ["scripts/gen-workspace.ts", "scripts/verify-lock.ts"]) {
      const result = spawnSync(process.execPath, [script, ...(script.endsWith("gen-workspace.ts") ? ["--check"] : [])], { cwd: tree, encoding: "utf8" });
      if (result.status !== 0) refuse(`${script} failed on the candidate: ${`${result.stdout}${result.stderr}`.slice(-2000)}`);
    }
    const { readLock } = await import("./lock.ts");
    const { parse } = await import("yaml");
    const mainLockFile = path.join(tree, "main-pnpm-lock.yaml");
    fs.writeFileSync(mainLockFile, show(base, "pnpm-lock.yaml"));
    const [afterLock, mainLock, t3Lock] = [readLock(path.join(tree, "pnpm-lock.yaml")), readLock(mainLockFile), readLock(path.join(tree, "t3code/pnpm-lock.yaml"))];
    const afterWorkspace = parse(fs.readFileSync(path.join(tree, "pnpm-workspace.yaml"), "utf8")) as Record<string, any>;
    const patchHashes = Object.fromEntries(
      Object.entries<string>(afterWorkspace.patchedDependencies ?? {})
        .map(([key, file]) => [key, createHash("sha256").update(fs.readFileSync(path.join(tree, file))).digest("hex")] as const)
        .sort(([x], [y]) => x.localeCompare(y)),
    );
    // Review B2: outside t3's graph, the lock is main's.
    const diff = t3LockRefusal({ after: afterLock, main: mainLock, t3: t3Lock, mainWorkspace: parse(show(base, "pnpm-workspace.yaml")) as Record<string, any>, afterWorkspace, patchHashes });
    if (diff !== undefined) refuse(diff);
    const provenance = lockProvenance(afterLock.documents, mainLock.documents, t3Lock.documents);
    if (provenance.refused.length > 0) refuse(`the lock holds entries neither main's nor t3's lock vouches for, outside the npm registry: ${provenance.refused.slice(0, 10).join(", ")}`);
    for (const entry of provenance.registry) {
      const response = await fetch(`https://registry.npmjs.org/${entry.name.replaceAll("/", "%2F")}/${entry.version}`, { headers: { accept: "application/json" } });
      const published = response.ok ? ((await response.json()) as { dist?: { integrity?: string } }).dist?.integrity : undefined;
      if (published !== entry.integrity) refuse(`${entry.name}@${entry.version}'s integrity is not the npm registry's (${String(published)})`);
    }
    console.log(JSON.stringify({ lockFromRegistry: provenance.registry.map((entry) => `${entry.name}@${entry.version}`) }));
  }
}

console.log(JSON.stringify({ ok: true, sha }));
