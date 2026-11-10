// t3's passive git reads while the Container is stopped (step 2a M3; the parent's ruling on M2's deviation 2; ADR-0009
// refinement): a passive read never starts the Container. A read the cache cannot answer at the repo's current revision
// gets the last real answer for its key (any revision), patched with the write journal: the paths written since that
// answer's revision, from computer's change log (`./changeLog.ts`). The answer is marked stale internally.
//
// Patched shapes (the repo-scoped reads t3's status poll and diff panel send; `kindOf`):
// - `status --porcelain=2 --branch -z [--no-ahead-behind]`: each journal path's entry recomputed from HEAD, the index
//   and the working tree; untracked files collapsed to their topmost untracked directory, as git's default does.
// - `diff-index -M --numstat -z HEAD --`: each journal path's record recomputed (HEAD against the working tree).
// - `ls-files --others --exclude-standard -z --`: journal paths added or removed.
// - `-c diff.suppressBlankEmpty=false diff --find-renames … --src-prefix=a/ --dst-prefix=b/ [--minimal] [--numstat -z]
//   <HEAD or a merge base> --` without a temporary index: each journal path's section or record recomputed.
// Every other argv gets the last answer alone (git-dir-scoped reads are not moved by working-tree writes; the review
// diffs that stage untracked files in a temporary index, `GIT_INDEX_FILE`, are listed in the step's report).
// Renames in the last answer that touch a journal path are shown as their two sides. Pure but for `RepoFacts`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { byPath, fileNumstat, filePatch, latin1, type TreeEntry } from "./gitPatch.ts";

/** What the repo says about one path now. */
export interface PathFacts {
  readonly head: TreeEntry | null;
  readonly index: TreeEntry | null;
  /** The working tree's file: its mode, blob id and bytes; null when absent. */
  readonly worktree: { readonly mode: string; readonly oid: string; readonly bytes: Uint8Array } | null;
  readonly ignored: boolean;
}

export interface RepoFacts {
  facts(path: string): Promise<PathFacts>;
  headBytes(oid: string): Promise<Uint8Array>;
  /** Whether the index has a file under directory `dir` (repo-relative, no trailing slash). */
  trackedUnder(dir: string): boolean;
  /** The files under `dir` (recursive, repo-relative) that are neither tracked nor ignored. */
  untrackedUnder(dir: string): Promise<ReadonlyArray<string>>;
}

export type StaleKind = "status" | "diff-index-numstat" | "ls-files-others" | "review-diff" | "review-numstat";

const REVIEW_PREFIX = [
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--find-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, at) => value === right[at]);

/** Which patched shape `argv` is (with `env`), and the commit its base side is; undefined for last-answer-only. */
export const kindOf = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> | undefined,
): { readonly kind: StaleKind; readonly base: string } | undefined => {
  if (same(argv, ["status", "--porcelain=2", "--branch", "-z", "--no-ahead-behind"]) || same(argv, ["status", "--porcelain=2", "--branch", "-z"])) {
    return { kind: "status", base: "HEAD" };
  }
  if (same(argv, ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"])) return { kind: "diff-index-numstat", base: "HEAD" };
  if (same(argv, ["ls-files", "--others", "--exclude-standard", "-z", "--"])) return { kind: "ls-files-others", base: "HEAD" };
  // The review diffs: HEAD or a merge base against the working tree; with untracked files staged in a temporary index
  // (`GIT_INDEX_FILE`) they are last-answer-only.
  if (env?.GIT_INDEX_FILE !== undefined || !same(argv.slice(0, REVIEW_PREFIX.length), REVIEW_PREFIX)) return undefined;
  const rest = argv.slice(REVIEW_PREFIX.length).filter((arg) => arg !== "--minimal");
  const base = rest.at(-2);
  if (base === undefined || rest.at(-1) !== "--" || !(base === "HEAD" || /^[0-9a-f]{40}$/.test(base))) return undefined;
  if (rest.length === 2) return { kind: "review-diff", base };
  if (same(rest.slice(0, -2), ["--numstat", "-z"])) return { kind: "review-numstat", base };
  return undefined;
};

const ZERO_OID = "0".repeat(40);
const parentDirs = (path: string): Array<string> => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join("/"));
};

// ---------------------------------------------------------------------------------------------------------------------
// status --porcelain=2

interface StatusParts {
  readonly headers: Array<string>;
  /** Tracked entries (`1`, `2`, `u`) by the paths they name (a rename names two). */
  readonly tracked: Array<{ readonly record: string; readonly paths: ReadonlyArray<string>; readonly sortPath: string }>;
  readonly untracked: Array<string>;
  readonly ignored: Array<string>;
}

const parseStatus = (stdout: string): StatusParts => {
  const parts: StatusParts = { headers: [], tracked: [], untracked: [], ignored: [] };
  const records = stdout.split("\0");
  for (let at = 0; at < records.length; at++) {
    const record = records[at]!;
    if (record === "") continue;
    if (record.startsWith("# ")) parts.headers.push(record);
    else if (record.startsWith("1 ")) {
      const path = record.split(" ").slice(8).join(" ");
      parts.tracked.push({ record, paths: [path], sortPath: path });
    } else if (record.startsWith("2 ")) {
      const path = record.split(" ").slice(9).join(" ");
      const original = records[++at] ?? "";
      parts.tracked.push({ record: `${record}\0${original}`, paths: [path, original], sortPath: path });
    } else if (record.startsWith("u ")) {
      const path = record.split(" ").slice(10).join(" ");
      parts.tracked.push({ record, paths: [path], sortPath: path });
    } else if (record.startsWith("? ")) parts.untracked.push(record.slice(2));
    else if (record.startsWith("! ")) parts.ignored.push(record.slice(2));
  }
  return parts;
};

/** One path's tracked entry (`1 XY …`), or undefined when it is clean or not tracked. */
const trackedEntry = (path: string, facts: PathFacts): string | undefined => {
  const { head, index, worktree } = facts;
  if (index === null && head === null) return undefined;
  const x = index === null ? "D" : head === null ? "A" : head.oid !== index.oid || head.mode !== index.mode ? "M" : ".";
  const y = index === null ? "." : worktree === null ? "D" : worktree.oid !== index.oid || worktree.mode !== index.mode ? "M" : ".";
  if (x === "." && y === ".") return undefined;
  const mH = head?.mode ?? "000000";
  const mI = index?.mode ?? "000000";
  const mW = index === null ? "000000" : (worktree?.mode ?? "000000");
  return `1 ${x}${y} N... ${mH} ${mI} ${mW} ${head?.oid ?? ZERO_OID} ${index?.oid ?? ZERO_OID} ${path}`;
};

/** The `?` entry an untracked path shows as: itself, or its topmost directory that holds no tracked file. */
const untrackedName = (path: string, repo: RepoFacts): string => {
  for (const dir of parentDirs(path)) if (!repo.trackedUnder(dir)) return `${dir}/`;
  return path;
};

const isUntracked = (facts: PathFacts) => facts.index === null && facts.worktree !== null && !facts.ignored;

const patchStatus = async (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const parts = parseStatus(stdout);
  const touched = new Set(journal);
  const tracked = parts.tracked.filter((entry) => !entry.paths.some((path) => touched.has(path)));
  // Untracked entries a journal path is, or lies under, are recomputed with the journal.
  const untracked = new Set(parts.untracked);
  const rescan = new Set<string>();
  for (const name of parts.untracked) {
    const covers = name.endsWith("/") ? journal.some((path) => path.startsWith(name)) : touched.has(name);
    if (covers) {
      untracked.delete(name);
      if (name.endsWith("/")) rescan.add(name.slice(0, -1));
    }
  }
  const relisted = new Set<string>();
  for (const dir of rescan) for (const path of await repo.untrackedUnder(dir)) relisted.add(path);
  // Renamed entries' other sides are recomputed too.
  const recompute = new Set([...journal, ...parts.tracked.filter((entry) => entry.paths.some((path) => touched.has(path))).flatMap((entry) => entry.paths)]);
  for (const path of recompute) {
    const facts = await repo.facts(path);
    const entry = trackedEntry(path, facts);
    if (entry !== undefined) tracked.push({ record: entry, paths: [path], sortPath: path });
    if (isUntracked(facts)) untracked.add(untrackedName(path, repo));
  }
  for (const path of relisted) untracked.add(untrackedName(path, repo));
  const records = [
    ...parts.headers,
    ...tracked.toSorted((left, right) => byPath(left.sortPath, right.sortPath)).map((entry) => entry.record),
    ...[...untracked].toSorted(byPath).map((name) => `? ${name}`),
    ...parts.ignored.map((name) => `! ${name}`),
  ];
  return records.map((record) => `${record}\0`).join("");
};

// ---------------------------------------------------------------------------------------------------------------------
// numstat (-z) and patches

interface NumstatRecord {
  readonly text: string;
  readonly paths: ReadonlyArray<string>;
  readonly sortPath: string;
}

const parseNumstat = (stdout: string): Array<NumstatRecord> => {
  const out: Array<NumstatRecord> = [];
  const fields = stdout.split("\0");
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at]!;
    if (field === "") continue;
    const [added, deleted, ...rest] = field.split("\t");
    const path = rest.join("\t");
    if (path === "") {
      const from = fields[++at] ?? "";
      const to = fields[++at] ?? "";
      out.push({ text: `${added}\t${deleted}\t\0${from}\0${to}\0`, paths: [from, to], sortPath: to });
    } else out.push({ text: `${field}\0`, paths: [path], sortPath: path });
  }
  return out;
};

/** HEAD against the working tree for a tracked path (as `git diff HEAD` sees it), or undefined when unchanged. */
const headChange = async (path: string, facts: PathFacts, repo: RepoFacts) => {
  const { head, index, worktree } = facts;
  // `diff HEAD` and `diff-index HEAD` cover the index's paths and HEAD's: an untracked file is not in it.
  if (head === null && index === null) return undefined;
  const after = index === null ? null : worktree;
  if (head !== null && after !== null && head.oid === after.oid && head.mode === after.mode) return undefined;
  if (head === null && after === null) return undefined;
  return {
    oldPath: path,
    newPath: path,
    old: head === null ? null : { ...head, bytes: await repo.headBytes(head.oid) },
    new: after === null ? null : { mode: after.mode, oid: after.oid, bytes: after.bytes },
  };
};

const patchNumstat = async (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const touched = new Set(journal);
  const records = parseNumstat(stdout);
  const kept = records.filter((record) => !record.paths.some((path) => touched.has(path)));
  const recompute = new Set([...journal, ...records.filter((record) => record.paths.some((path) => touched.has(path))).flatMap((record) => record.paths)]);
  for (const path of recompute) {
    const change = await headChange(path, await repo.facts(path), repo);
    if (change !== undefined) kept.push({ text: new TextDecoder().decode(Uint8Array.from(fileNumstat(change), (char) => char.charCodeAt(0))), paths: [path], sortPath: path });
  }
  return kept.toSorted((left, right) => byPath(left.sortPath, right.sortPath)).map((record) => record.text).join("");
};

/** A patch's sections, by the `diff --git` line that opens each. */
const parseSections = (stdout: string): Array<{ readonly text: string; readonly header: string }> => {
  const out: Array<{ text: string; header: string }> = [];
  for (const line of stdout.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) out.push({ text: line, header: line });
    else if (out.length > 0) out[out.length - 1]!.text += line;
  }
  return out;
};

/** The paths a section's header names: `diff --git a/X b/Y` (quoted names unquoted only for plain ASCII). */
const sectionPaths = (header: string): ReadonlyArray<string> => {
  const body = header.slice("diff --git ".length).replace(/\n$/, "");
  const match = /^a\/(.*) b\/(.*)$/.exec(body);
  return match === null ? [] : [match[1]!, match[2]!];
};

const patchReview = async (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const touched = new Set(journal);
  const sections = parseSections(stdout).map((section) => ({ ...section, paths: sectionPaths(section.header) }));
  const kept = sections.filter((section) => !section.paths.some((path) => touched.has(path)));
  const recompute = new Set([...journal, ...sections.filter((section) => section.paths.some((path) => touched.has(path))).flatMap((section) => section.paths)]);
  const out: Array<{ readonly text: string; readonly sortPath: string }> = kept.map((section) => ({ text: section.text, sortPath: section.paths[1] ?? section.paths[0] ?? "" }));
  for (const path of recompute) {
    const change = await headChange(path, await repo.facts(path), repo);
    if (change !== undefined) out.push({ text: new TextDecoder().decode(Uint8Array.from(filePatch(change), (char) => char.charCodeAt(0))), sortPath: path });
  }
  return out.toSorted((left, right) => byPath(left.sortPath, right.sortPath)).map((section) => section.text).join("");
};

const patchReviewNumstat = patchNumstat;

const patchOthers = async (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const listed = new Set(stdout.split("\0").filter((path) => path !== ""));
  for (const path of journal) {
    listed.delete(path);
    if (isUntracked(await repo.facts(path))) listed.add(path);
  }
  return [...listed].toSorted(byPath).map((path) => `${path}\0`).join("");
};

/** `stdout` (the last real answer of a `kind` read) patched with the paths written since it ran. */
export const patchAnswer = (kind: StaleKind, stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  if (journal.length === 0) return Promise.resolve(stdout);
  switch (kind) {
    case "status":
      return patchStatus(stdout, journal, repo);
    case "diff-index-numstat":
      return patchNumstat(stdout, journal, repo);
    case "ls-files-others":
      return patchOthers(stdout, journal, repo);
    case "review-diff":
      return patchReview(stdout, journal, repo);
    case "review-numstat":
      return patchReviewNumstat(stdout, journal, repo);
  }
};

export { latin1 };
