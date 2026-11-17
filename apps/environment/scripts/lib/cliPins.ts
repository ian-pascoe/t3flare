// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
// The CLI pins a CLI bump edits (ADR-0037; in-app updates plan D22), and the edit itself, dependency-free: the
// untrusted bump job (`scripts/cli-bump.ts`) applies it to the checkout, and the trusted land job
// (`scripts/land-check.ts`, plain Node, no install) applies it again to main's own files and requires the proposed
// files to be byte for byte what it made, after checking field by field that only the bumped CLI's pin moved.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CLIS } from "../../../sandbox-image/src/clis.ts";
import { CLI_PIN_FILES, EXACT_VERSION, type UpdatableCli } from "../../src/updates/pins.ts";

export { CLI_PIN_FILES };

const DOCKERFILE = "apps/sandbox-image/image/Dockerfile";
const CLIS_FILE = "apps/sandbox-image/src/clis.ts";
const SHA256 = /^[0-9a-f]{64}$/;

/** The npm package and image folder of a CLI installed from npm. */
const NPM: Partial<Record<UpdatableCli, { readonly dir: string; readonly pkg: string }>> = {
  pi: { dir: "apps/sandbox-image/image/cli", pkg: CLIS.pi.package },
  claude: { dir: "apps/sandbox-image/image/claude", pkg: CLIS.claude.package },
};

/** The Dockerfile ARGs a CLI's bump sets (only Codex is installed from a release tarball). */
const DOCKERFILE_ARGS: Record<UpdatableCli, ReadonlyArray<string>> = { codex: ["CODEX_VERSION", "CODEX_SHA256"], pi: [], claude: [] };
/** The fields of a CLI's entry in clis.ts its bump sets. */
const CLIS_FIELDS: Record<UpdatableCli, ReadonlyArray<string>> = { codex: ["version", "sha256", "sha256Arm64"], pi: ["version"], claude: ["version", "packageVersion", "sdkVersion"] };

/** `text` with `ARG <name>=<value>`; throws when the Dockerfile has no such default. */
export const withDockerfileArg = (text: string, name: string, value: string): string => {
  const pattern = new RegExp(`^ARG ${name}=.*$`, "m");
  if (!pattern.test(text)) throw new Error(`the Dockerfile has no ARG ${name}=…`);
  return text.replace(pattern, `ARG ${name}=${value}`);
};

export const dockerfileArg = (text: string, name: string): string | undefined => new RegExp(`^ARG ${name}=(.*)$`, "m").exec(text)?.[1];

const entryBounds = (source: string, cli: string) => {
  const start = source.indexOf(`\n  ${cli}: {`);
  if (start === -1) throw new Error(`clis.ts has no ${cli} entry`);
  return { start, end: source.indexOf("\n  },", start) };
};

/** `clis.ts`'s source with `fields` of `cli`'s entry set; throws on a field the entry lacks. */
export const withClisFields = (source: string, cli: string, fields: Readonly<Record<string, string>>): string => {
  const { start, end } = entryBounds(source, cli);
  let entry = source.slice(start, end);
  for (const [field, value] of Object.entries(fields)) {
    const pattern = new RegExp(`(\\n\\s+${field}: )"[^"]*"`);
    if (!pattern.test(entry)) throw new Error(`clis.ts's ${cli} entry has no ${field}`);
    entry = entry.replace(pattern, `$1${JSON.stringify(value)}`);
  }
  return `${source.slice(0, start)}${entry}${source.slice(end)}`;
};

/** A field of `cli`'s entry in clis.ts. */
export const clisField = (source: string, cli: string, field: string): string | undefined => {
  const { start, end } = entryBounds(source, cli);
  return new RegExp(`\\n\\s+${field}: "([^"]*)"`).exec(source.slice(start, end))?.[1];
};

/** A `package.json`'s text with its one dependency `name` at exactly `version`. */
export const withDependency = (text: string, name: string, version: string): string => {
  const json = JSON.parse(text) as { dependencies?: Record<string, string> };
  if (json.dependencies?.[name] === undefined) throw new Error(`package.json does not depend on ${name}`);
  json.dependencies[name] = version;
  return `${JSON.stringify(json, null, 2)}\n`;
};

/** The version a lock installs for `name`. */
export const lockedVersion = (lockText: string, name: string): string | undefined =>
  (JSON.parse(lockText) as { packages?: Record<string, { version?: string }> }).packages?.[`node_modules/${name}`]?.version;

/** The release tarballs of Codex `version` (amd64 for the Workspace image, arm64 for test:docker on an arm64 host). */
export const codexTarballs = (version: string) => ({
  amd64: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-x86_64-unknown-linux-musl.tar.gz`,
  arm64: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-unknown-linux-musl.tar.gz`,
});

/** The six pinned files, by their path from the repo's root. */
export type PinFiles = Readonly<Record<(typeof CLI_PIN_FILES)[number], string>>;

/**
 * Why `after` is not `before` with only `cli`'s pin moved to `version`, or undefined (F3's field-level check): the
 * Dockerfile's ARG defaults of that CLI, that CLI's fields in clis.ts, and its own package.json dependency; everything
 * else byte for byte. Its npm lock is checked by regenerating it (`applyCliPin`).
 */
export const cliPinRefusal = (cli: UpdatableCli, version: string, before: PinFiles, after: PinFiles): string | undefined => {
  if (!EXACT_VERSION.test(version)) return `not an exact version: ${version}`;
  // The Dockerfile: only this CLI's ARG defaults, with values of their shape.
  const args = Object.fromEntries(DOCKERFILE_ARGS[cli].map((name) => [name, dockerfileArg(after[DOCKERFILE], name) ?? ""]));
  for (const [name, value] of Object.entries(args)) {
    if (!(name.endsWith("_SHA256") ? SHA256 : EXACT_VERSION).test(value)) return `the Dockerfile's ${name} is ${JSON.stringify(value)}`;
  }
  if (Object.entries(args).reduce((text, [name, value]) => withDockerfileArg(text, name, value), before[DOCKERFILE]) !== after[DOCKERFILE]) {
    return `the Dockerfile changes more than ${DOCKERFILE_ARGS[cli].join(", ") || "nothing"}`;
  }
  // clis.ts: only this CLI's fields, with values of their shape.
  const fields = Object.fromEntries(CLIS_FIELDS[cli].map((field) => [field, clisField(after[CLIS_FILE], cli, field) ?? ""]));
  for (const [field, value] of Object.entries(fields)) {
    if (!(field.startsWith("sha256") ? SHA256 : EXACT_VERSION).test(value)) return `clis.ts's ${cli}.${field} is ${JSON.stringify(value)}`;
  }
  if (withClisFields(before[CLIS_FILE], cli, fields) !== after[CLIS_FILE]) return `clis.ts changes more than ${cli}'s ${CLIS_FIELDS[cli].join(", ")}`;
  const pinned = cli === "claude" ? fields.packageVersion : fields.version;
  if (pinned !== version) return `clis.ts pins ${cli} at ${pinned}, not ${version}`;
  if (cli === "codex" && args.CODEX_VERSION !== version) return `the Dockerfile's CODEX_VERSION is ${args.CODEX_VERSION}, not ${version}`;
  if (cli === "codex" && args.CODEX_SHA256 !== fields.sha256) return "the Dockerfile's CODEX_SHA256 is not clis.ts's";
  // package.json and the lock: only this CLI's, its one dependency at exactly `version`.
  for (const [other, npm] of Object.entries(NPM)) {
    const manifest = `${npm.dir}/package.json` as const;
    const lock = `${npm.dir}/package-lock.json` as const;
    if (other !== cli) {
      if (before[manifest as keyof PinFiles] !== after[manifest as keyof PinFiles] || before[lock as keyof PinFiles] !== after[lock as keyof PinFiles]) return `a ${cli} bump changes ${npm.dir}`;
      continue;
    }
    if (withDependency(before[manifest as keyof PinFiles], npm.pkg, version) !== after[manifest as keyof PinFiles]) return `${manifest} changes more than ${npm.pkg}`;
    if (lockedVersion(after[lock as keyof PinFiles], npm.pkg) !== version) return `${lock} does not install ${npm.pkg}@${version}`;
  }
  return undefined;
};

export interface PinIo {
  /** The sha256 of the file at `url`. */
  readonly sha256Of: (url: string) => Promise<string>;
  /** Rewrites the npm lock in `dir` from its package.json, resolving only (no install, no scripts). */
  readonly relock: (dir: string) => { readonly ok: boolean; readonly output: string };
  /** `npm view <spec> <field>`, or "". */
  readonly npmView: (spec: string, field: string) => string;
}

export const defaultPinIo: PinIo = {
  sha256Of: async (url) => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || response.body === null) throw new Error(`${url} answered ${response.status}`);
    const hash = createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    return hash.digest("hex");
  },
  relock: (dir) => {
    const result = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8" });
    return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  },
  // From outside any workspace: npm warns about workspaces there.
  npmView: (spec, field) => (spawnSync("npm", ["view", spec, field], { cwd: os.tmpdir(), encoding: "utf8" }).stdout ?? "").trim(),
};

/**
 * Moves `cli`'s pin to `version` in the pinned files under `root`: Codex's ARGs and both tarballs' hashes; pi's or
 * Claude's package.json and npm lock (Claude's SDK follows the adapter, and Claude Code's version is the SDK's npm
 * `claudeCodeVersion`); and clis.ts. Returns the clis.ts fields it set.
 */
export const applyCliPin = async (root: string, cli: UpdatableCli, version: string, io: PinIo = defaultPinIo): Promise<Record<string, string>> => {
  const file = (relative: string) => path.join(root, relative);
  const edit = (relative: string, change: (text: string) => string) => fs.writeFileSync(file(relative), change(fs.readFileSync(file(relative), "utf8")));
  let fields: Record<string, string>;
  if (cli === "codex") {
    const tarballs = codexTarballs(version);
    const [amd64, arm64] = await Promise.all([io.sha256Of(tarballs.amd64), io.sha256Of(tarballs.arm64)]);
    edit(DOCKERFILE, (text) => withDockerfileArg(withDockerfileArg(text, "CODEX_VERSION", version), "CODEX_SHA256", amd64));
    fields = { version, sha256: amd64, sha256Arm64: arm64 };
  } else {
    const npm = NPM[cli]!;
    edit(`${npm.dir}/package.json`, (text) => withDependency(text, npm.pkg, version));
    const relocked = io.relock(file(npm.dir));
    if (!relocked.ok) throw new Error(`npm could not lock ${npm.pkg}@${version}: ${relocked.output.slice(-1000)}`);
    const lock = fs.readFileSync(file(`${npm.dir}/package-lock.json`), "utf8");
    const locked = lockedVersion(lock, npm.pkg);
    if (locked !== version) throw new Error(`the lock installs ${npm.pkg}@${String(locked)}, not ${version}`);
    if (cli === "pi") {
      fields = { version };
    } else {
      const sdkVersion = lockedVersion(lock, "@anthropic-ai/claude-agent-sdk");
      if (sdkVersion === undefined) throw new Error("the lock installs no @anthropic-ai/claude-agent-sdk");
      const claudeCode = io.npmView(`@anthropic-ai/claude-agent-sdk@${sdkVersion}`, "claudeCodeVersion");
      if (claudeCode === "") throw new Error(`npm names no claudeCodeVersion for @anthropic-ai/claude-agent-sdk@${sdkVersion}`);
      fields = { version: claudeCode, packageVersion: version, sdkVersion };
    }
  }
  edit(CLIS_FILE, (text) => withClisFields(text, cli, fields));
  return fields;
};

/** The npm package whose newest version a CLI bump pins. */
export const latestPackageOf = (cli: UpdatableCli): string => (cli === "codex" ? "@openai/codex" : NPM[cli]!.pkg);
