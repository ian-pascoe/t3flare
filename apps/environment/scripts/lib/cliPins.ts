// The CLI pins a CLI bump edits (ADR-0037; in-app updates plan D22), as text: the Workspace image's Dockerfile ARGs and
// `apps/sandbox-image/src/clis.ts`'s fields. `scripts/cli-bump.ts` does the rest (npm, the release tarballs' hashes).
// `test/cliManifest.test.ts` keeps the two in step and checks the pins against t3's compatibility manifest.

export type BumpableCli = "pi" | "codex" | "claude";

/** The files a CLI bump may change: the land workflow's allowlist for `bump/cli-*` branches. */
export const CLI_PIN_FILES = [
  "apps/sandbox-image/image/Dockerfile",
  "apps/sandbox-image/image/cli/package.json",
  "apps/sandbox-image/image/cli/package-lock.json",
  "apps/sandbox-image/image/claude/package.json",
  "apps/sandbox-image/image/claude/package-lock.json",
  "apps/sandbox-image/src/clis.ts",
] as const;

/** `text` with `ARG <name>=<value>`; throws when the Dockerfile has no such default. */
export const withDockerfileArg = (text: string, name: string, value: string): string => {
  const pattern = new RegExp(`^ARG ${name}=.*$`, "m");
  if (!pattern.test(text)) throw new Error(`the Dockerfile has no ARG ${name}=…`);
  return text.replace(pattern, `ARG ${name}=${value}`);
};

/** `clis.ts`'s source with `fields` of `cli`'s entry set; throws on a field the entry lacks. */
export const withClisFields = (source: string, cli: BumpableCli, fields: Readonly<Record<string, string>>): string => {
  const start = source.indexOf(`\n  ${cli}: {`);
  if (start === -1) throw new Error(`clis.ts has no ${cli} entry`);
  const end = source.indexOf("\n  },", start);
  let entry = source.slice(start, end);
  for (const [field, value] of Object.entries(fields)) {
    const pattern = new RegExp(`(\\n\\s+${field}: )"[^"]*"`);
    if (!pattern.test(entry)) throw new Error(`clis.ts's ${cli} entry has no ${field}`);
    entry = entry.replace(pattern, `$1${JSON.stringify(value)}`);
  }
  return `${source.slice(0, start)}${entry}${source.slice(end)}`;
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

/** The exact version a dependency range names (`0.3.326`, `^0.3.326`, `~0.3.326`). */
export const versionOfRange = (range: string): string | undefined => /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)?.[0];

/** The release tarballs of Codex `version` (amd64 for the Workspace image, arm64 for test:docker on an arm64 host). */
export const codexTarballs = (version: string) => ({
  amd64: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-x86_64-unknown-linux-musl.tar.gz`,
  arm64: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-unknown-linux-musl.tar.gz`,
});

/** The branch a CLI bump pushes: `bump/cli-<cli>-<version>`. */
export const cliBumpBranch = (cli: BumpableCli, version: string): string => `bump/cli-${cli}-${version}`;
