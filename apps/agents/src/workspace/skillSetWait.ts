// A running Container's copy of a new Environment skill set, and a Workspace's files at the mount from before it
// existed (SPI-1148, plan §4.1-§4.2): plain functions, apart from computer, so they are tested on Node.
import { sha256Hex } from "@t3flare/skills";

/** What a running Container must show of a new set: each added or changed file's SHA-256, and each removed path. */
export interface ContainerExpectation {
  readonly present: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  readonly removed: ReadonlyArray<string>;
}

/** The files of `next` that are new or changed against `previous`, and the paths `previous` had and `next` lacks. */
export const expectationOf = async (previous: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): Promise<ContainerExpectation> => {
  const present: Array<{ readonly path: string; readonly sha256: string }> = [];
  for (const [path, text] of Object.entries(next)) if (previous[path] !== text) present.push({ path, sha256: await sha256Hex(text) });
  return { present, removed: Object.keys(previous).filter((path) => next[path] === undefined) };
};

/**
 * The wait's stdin (never the script: Linux caps one argument at 128 KiB): `sha256sum -c` lines for the files that must
 * read so, then a line `--removed--` and the paths that must be gone. Paths are relative to the mount; the path rule
 * (`skillFilePathProblem`) keeps them free of newlines.
 */
export const expectationInput = (expectation: ContainerExpectation): string =>
  [...expectation.present.map((file) => `${file.sha256}  ${file.path}`), "--removed--", ...expectation.removed, ""].join("\n");

/**
 * The passive command that waits for a running Container's copy (plan §4.2): in `dir`, every 200 ms for up to `tries`
 * looks, it checks the stdin's files and absences. It prints `caught-up <looks>` or `stale <looks>` and the paths still
 * stale, then the lock's failure marker when there is one (logged once per launch by the Workspace).
 */
export const skillsWaitScript = (dir: string, tries: number, lockFailed: string): string =>
  [
    `t=$(mktemp); cat > "$t"`,
    // One pass with a flag: a `sed '1,/re/d'` range finds its end from line 2, so a list whose marker is line 1 (a
    // removal-only take) would lose every removed path.
    `: > "$t.sum"; : > "$t.gone"; awk -v sum="$t.sum" -v gone="$t.gone" '/^--removed--$/ { removed = 1; next } { print > (removed ? gone : sum) }' "$t"`,
    `cd ${dir} 2>/dev/null || cd /`,
    `n=0; while :; do n=$((n+1)); ok=1`,
    `  if [ -s "$t.sum" ] && ! sha256sum -c --status "$t.sum" 2>/dev/null; then ok=0; fi`,
    `  while IFS= read -r p; do [ -n "$p" ] && [ -e "$p" ] && ok=0; done < "$t.gone"`,
    `  if [ $ok = 1 ] || [ $n -ge ${tries} ]; then break; fi; sleep 0.2`,
    `done`,
    `if [ $ok = 1 ]; then echo "caught-up $n"; else echo "stale $n"; sha256sum -c "$t.sum" 2>/dev/null | grep -v ': OK$' | head -20; while IFS= read -r p; do [ -n "$p" ] && [ -e "$p" ] && echo "present: $p"; done < "$t.gone"; fi`,
    `[ -f ${lockFailed} ] && echo "lock-failed: $(head -c 300 ${lockFailed} | tr '\\n' ' ')"`,
    `rm -f "$t" "$t.sum" "$t.gone"; exit 0`,
  ].join("\n");

/** What the wait printed. */
export interface WaitAnswer {
  readonly caughtUp: boolean;
  readonly looks: number;
  readonly stale: ReadonlyArray<string>;
  readonly lockFailed?: string;
}

export const parseWait = (stdout: string): WaitAnswer => {
  const lines = stdout.split("\n").filter((line) => line !== "");
  const head = /^(caught-up|stale) (\d+)$/.exec(lines[0] ?? "");
  const lock = lines.find((line) => line.startsWith("lock-failed: "));
  return {
    caughtUp: head?.[1] === "caught-up",
    looks: Number(head?.[2] ?? 0),
    stale: lines.slice(1).filter((line) => !line.startsWith("lock-failed: ")),
    ...(lock === undefined ? {} : { lockFailed: lock.slice("lock-failed: ".length).trim() }),
  };
};

/** Where a Workspace's own files at the mount are kept, beside it: not a skills directory, so nothing discovers them. */
export const priorSkillsDir = (mount: string): string => `${mount}.pre-mount`;

export interface PriorSkillsOptions {
  readonly fs: {
    lstat(path: string): Promise<{ readonly isDirectory: boolean }>;
    readdir(path: string): Promise<ReadonlyArray<unknown>>;
    rename(from: string, to: string): Promise<void>;
  };
  readonly mount: string;
  /** Whether computer has indexed the mount before: it clears whatever is at the mount when it first does. */
  readonly indexed: () => boolean;
  readonly warn: (message: string) => void;
}

/**
 * What is at the mount before the Workspace first indexes it is the Workspace's own (written there before the mount
 * existed). computer clears a mount's root when it indexes it, so those files are moved aside first, unless there are
 * none (cloudpid's `keepPriorSkills`). Returns where they went.
 */
export const keepPriorSkills = async (options: PriorSkillsOptions): Promise<string | undefined> => {
  const { fs, mount } = options;
  const lstatOrNull = async (path: string) => {
    try {
      return await fs.lstat(path);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
      throw cause;
    }
  };
  if (options.indexed()) return undefined;
  const stat = await lstatOrNull(mount);
  if (stat === null) return undefined;
  if (stat.isDirectory && (await fs.readdir(mount)).length === 0) return undefined;
  let target = priorSkillsDir(mount);
  for (let attempt = 2; (await lstatOrNull(target)) !== null; attempt++) target = `${priorSkillsDir(mount)}-${attempt}`;
  await fs.rename(mount, target);
  options.warn(`${mount} is the Environment skills' read-only mount now: what the Workspace had there was moved to ${target}`);
  return target;
};
