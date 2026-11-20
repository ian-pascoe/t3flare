// t3's passive git reads while the Container is stopped (step 2a M3; the parent's ruling on M2's deviation 2; ADR-0009
// refinement): a passive read never starts the Container. A read the cache cannot answer at the repo's current revision
// gets the last real answer for its key (any revision), patched with the write journal: the paths written since that
// answer's revision, from computer's change log (`./changeLog.ts`). The answer is marked stale internally.
//
// Patched shapes (the repo-scoped reads t3's status poll and diff panel send; `kindOf`):
// - `status --porcelain=2 --branch -z [--untracked-files=normal] [--no-ahead-behind]`: each journal path's entry
//   recomputed from HEAD, the index and the working tree; untracked files collapsed to their topmost untracked
//   directory, as git's default does.
// - `diff-index -M --numstat -z HEAD --`: each journal path's record recomputed (HEAD against the working tree).
// - `ls-files --others --exclude-standard -z -- [one file's pathspec]`: journal paths added or removed.
// - `-c diff.suppressBlankEmpty=false diff --find-renames … --src-prefix=a/ --dst-prefix=b/ [--minimal]
//   <--patch | --raw --numstat -z> <HEAD or a merge base> -- [one file's pathspecs]` without a temporary index: each
//   journal path's section or records recomputed.
// Every other argv gets the last answer alone (git-dir-scoped reads are not moved by working-tree writes; the review
// diffs that stage untracked files in a temporary index, `GIT_INDEX_FILE`, are listed in the step's report).
// Recomputed paths pair exact renames, as git does; a rename in the last answer that touches a journal path and is no
// longer exact is shown as its two sides. One file's reads (`:(top,literal)<path>`, the diff panel's) with no last
// answer are computed from the repo's facts alone (SPI-1295; ADR-0009). Pure but for `RepoFacts`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { asOutput, byPath, type FileChange, fileNumstat, filePatch, fileRaw, latin1, type TreeEntry, typeChanged } from "./gitPatch.ts";

/** What the repo says about one path now. */
export interface PathFacts {
  readonly head: TreeEntry | null;
  readonly index: TreeEntry | null;
  /** The working tree's file: its mode, blob id and bytes; null when absent. */
  readonly worktree: { readonly mode: string; readonly oid: string; readonly bytes: Uint8Array } | null;
  readonly ignored: boolean;
}

export interface RepoFacts {
  /** The commit the diff's base side resolved to; null when it names none (an unborn HEAD). */
  readonly base: string | null;
  facts(path: string): Promise<PathFacts>;
  headBytes(oid: string): Promise<Uint8Array>;
  /** Whether the index has a file under directory `dir` (repo-relative, no trailing slash). */
  trackedUnder(dir: string): boolean;
  /** The submodules' paths (the index's gitlinks): their files are their own repos', never this one's. */
  readonly submodules: ReadonlyArray<string>;
  /** The files under `dir` (recursive, repo-relative) that are neither tracked nor ignored. */
  untrackedUnder(dir: string): Promise<ReadonlyArray<string>>;
}

export type StaleKind = "status" | "diff-index-numstat" | "ls-files-others" | "review-patch" | "review-stats";

/** A patched read: its kind, the commit its base side is, and, for one file's read, the paths its pathspecs name. */
export interface StaleShape {
  readonly kind: StaleKind;
  readonly base: string;
  readonly paths?: ReadonlyArray<string>;
}

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

const STATUS_SHAPE = ["status", "--porcelain=2", "--branch", "-z"];
const UNTRACKED_NORMAL = "--untracked-files=normal";
const NO_AHEAD_BEHIND = "--no-ahead-behind";
const OTHERS_SHAPE = ["ls-files", "--others", "--exclude-standard", "-z", "--"];
/** The review reads' tails, before the base: the patch read and the stats read (t3's `getReviewDiffPreview`). */
const REVIEW_MODES: ReadonlyArray<readonly [ReadonlyArray<string>, StaleKind]> = [
  [["--patch"], "review-patch"],
  [["--raw", "--numstat", "-z"], "review-stats"],
];
/** How t3 names one file of the diff panel: its path, and a rename's previous path, each a literal pathspec. */
const PATHSPEC = ":(top,literal)";

/** The paths `words` name as one file's pathspecs (none, or one or two literal paths); undefined for any other words. */
const pathspecs = (words: ReadonlyArray<string>): { readonly paths?: ReadonlyArray<string> } | undefined => {
  if (words.length === 0) return {};
  if (words.length > 2 || !words.every((word) => word.startsWith(PATHSPEC) && word.length > PATHSPEC.length)) return undefined;
  return { paths: words.map((word) => word.slice(PATHSPEC.length)) };
};

/** Which patched shape `argv` is (with `env`), the commit its base side is, and one file's paths; undefined for last-answer-only. */
export const kindOf = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> | undefined): StaleShape | undefined => {
  const statusFlags = argv.slice(STATUS_SHAPE.length);
  const statusShape = [[], [UNTRACKED_NORMAL]].some((flag) => [[], [NO_AHEAD_BEHIND]].some((nab) => same(statusFlags, [...flag, ...nab])));
  if (same(argv.slice(0, STATUS_SHAPE.length), STATUS_SHAPE) && statusShape) {
    return { kind: "status", base: "HEAD" };
  }
  if (same(argv, ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"])) return { kind: "diff-index-numstat", base: "HEAD" };
  if (same(argv.slice(0, OTHERS_SHAPE.length), OTHERS_SHAPE)) {
    const one = pathspecs(argv.slice(OTHERS_SHAPE.length));
    return one === undefined ? undefined : { kind: "ls-files-others", base: "HEAD", ...one };
  }
  // The review diffs: HEAD or a merge base against the working tree; with untracked files staged in a temporary index
  // (`GIT_INDEX_FILE`) they are last-answer-only.
  if (env?.GIT_INDEX_FILE !== undefined || !same(argv.slice(0, REVIEW_PREFIX.length), REVIEW_PREFIX)) return undefined;
  const rest = argv.slice(REVIEW_PREFIX.length).filter((arg) => arg !== "--minimal");
  const dashes = rest.indexOf("--");
  const base = rest[dashes - 1];
  if (dashes < 1 || base === undefined || !(base === "HEAD" || /^[0-9a-f]{40}$/.test(base))) return undefined;
  const kind = REVIEW_MODES.find(([mode]) => same(rest.slice(0, dashes - 1), mode))?.[1];
  const one = pathspecs(rest.slice(dashes + 1));
  return kind === undefined || one === undefined ? undefined : { kind, base, ...one };
};

/** Whether `path` is `dir` or lies under it (repo-relative). */
const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** The written paths a read can see: all of them, or for one file's read those its pathspecs match (a path, or under it). */
const journalFor = (shape: StaleShape, written: ReadonlyArray<string>): ReadonlyArray<string> =>
  shape.paths === undefined ? written : written.filter((path) => shape.paths!.some((one) => isUnder(path, one)));

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
  // git's letter for one side's change: `T` when a file became a symlink or back, else `M`.
  const changed = (from: { readonly mode: string }, to: { readonly mode: string }) => ((from.mode === "120000") !== (to.mode === "120000") ? "T" : "M");
  const x = index === null ? "D" : head === null ? "A" : head.oid !== index.oid || head.mode !== index.mode ? changed(head, index) : ".";
  const y = index === null ? "." : worktree === null ? "D" : worktree.oid !== index.oid || worktree.mode !== index.mode ? changed(index, worktree) : ".";
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

/** One path's change, with whether its new side is the index's entry unchanged (git's raw record names its id then). */
interface Changed extends FileChange {
  readonly indexed: boolean;
}

/** HEAD against the working tree for a tracked path (as `git diff HEAD` sees it), or undefined when unchanged. */
const headChange = async (path: string, facts: PathFacts, repo: RepoFacts): Promise<Changed | undefined> => {
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
    indexed: index !== null && after !== null && after.oid === index.oid && after.mode === index.mode,
  };
};

/**
 * The changes of `paths` (HEAD, or the base, against the working tree), with exact renames paired as git pairs them: a
 * deleted file and an added one with the same blob and of the same type (a mode change rides along), the deleted file
 * with the same basename first.
 */
const changesOf = async (paths: Iterable<string>, repo: RepoFacts): Promise<Array<Changed>> => {
  const changes: Array<Changed> = [];
  // In git's path order: git pairs each added file, in that order, with the first deleted file in that order.
  for (const path of [...paths].toSorted(byPath)) {
    const change = await headChange(path, await repo.facts(path), repo);
    if (change !== undefined) changes.push(change);
  }
  const used = new Set<Changed>();
  const out: Array<Changed> = [];
  for (const change of changes) {
    const added = change.new;
    if (change.old === null && added !== null) {
      const sources = changes.filter(
        (other) => !used.has(other) && other.new === null && other.old !== null && other.old.oid === added.oid && !typeChanged({ ...other, new: added }),
      );
      const source = sources.find((other) => basename(other.oldPath) === basename(change.newPath)) ?? sources[0];
      if (source !== undefined) {
        used.add(source);
        out.push({ oldPath: source.oldPath, newPath: change.newPath, old: source.old, new: added, indexed: change.indexed });
        continue;
      }
    }
    out.push(change);
  }
  return out.filter((change) => !used.has(change));
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether git could pair a deleted and an added file of `changes` as an inexact rename, whose similarity only git knows. */
const mayPairInexactly = (changes: ReadonlyArray<Changed>): boolean =>
  changes.some((change) => change.new === null) && changes.some((change) => change.old === null);

interface AnswerRecord {
  readonly text: string;
  readonly paths: ReadonlyArray<string>;
  /** The path git orders it by: a rename's new path. */
  readonly sortPath: string;
}

const sorted = (records: ReadonlyArray<Pick<AnswerRecord, "text" | "sortPath">>): string =>
  records.toSorted((left, right) => byPath(left.sortPath, right.sortPath)).map((record) => record.text).join("");

/** `changes` written by `render` (Latin-1) as records of the answer's text. */
const rendered = (changes: ReadonlyArray<Changed>, render: (change: Changed) => string): Array<AnswerRecord> =>
  changes.map((change) => ({ text: asOutput(render(change)), paths: [change.oldPath, change.newPath], sortPath: change.newPath }));

/**
 * An answer's parts (the raw records and the numstat records of one read, or its one kind of record) patched with the
 * journal: in each, the records naming no journal path kept, and the rest recomputed and written by the part's `render`.
 * A record a journal path touches has all its paths recomputed (a rename's other side), once for every part.
 */
const patchRecords = async (
  parts: ReadonlyArray<{ readonly records: ReadonlyArray<AnswerRecord>; readonly render: (change: Changed) => string }>,
  journal: ReadonlyArray<string>,
  repo: RepoFacts,
): Promise<string> => {
  const touched = new Set(journal);
  const hit = (record: AnswerRecord) => record.paths.some((path) => touched.has(path));
  const recompute = new Set([...journal, ...parts.flatMap((part) => part.records.filter(hit).flatMap((record) => record.paths))]);
  const changes = await changesOf(recompute, repo);
  return parts.map((part) => sorted([...part.records.filter((record) => !hit(record)), ...rendered(changes, part.render)])).join("");
};

/** git's raw record of a change: it names the working tree's blob only when the file is its index entry unchanged. */
const rawOf = (change: Changed) => fileRaw(change, change.indexed);

const parseNumstat = (stdout: string): Array<AnswerRecord> => {
  const out: Array<AnswerRecord> = [];
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

/** `--raw --numstat -z`'s answer: the raw records (`:<modes> <ids> <status>`, then one path or a rename's two), then numstat's. */
const parseRawNumstat = (stdout: string): { readonly raw: Array<AnswerRecord>; readonly numstat: Array<AnswerRecord> } => {
  const fields = stdout.split("\0");
  const raw: Array<AnswerRecord> = [];
  let at = 0;
  while (at < fields.length && fields[at]!.startsWith(":")) {
    const header = fields[at]!;
    const status = header.split(" ").at(-1) ?? "";
    const paths = fields.slice(at + 1, at + (status.startsWith("R") || status.startsWith("C") ? 3 : 2));
    raw.push({ text: `${header}\0${paths.map((path) => `${path}\0`).join("")}`, paths, sortPath: paths.at(-1) ?? "" });
    at += 1 + paths.length;
  }
  return { raw, numstat: parseNumstat(fields.slice(at).join("\0")) };
};

const patchNumstat = (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> =>
  patchRecords([{ records: parseNumstat(stdout), render: fileNumstat }], journal, repo);

const patchStats = (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const { raw, numstat } = parseRawNumstat(stdout);
  return patchRecords([{ records: raw, render: rawOf }, { records: numstat, render: fileNumstat }], journal, repo);
};

/** A patch's sections, by the `diff --git` line that opens each. */
const parseSections = (stdout: string): Array<AnswerRecord> => {
  const out: Array<{ text: string; header: string }> = [];
  for (const line of stdout.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) out.push({ text: line, header: line });
    else if (out.length > 0) out[out.length - 1]!.text += line;
  }
  return out.map((section) => {
    const paths = sectionPaths(section.header);
    return { text: section.text, paths, sortPath: paths[1] ?? paths[0] ?? "" };
  });
};

/** The paths a section's header names: `diff --git a/X b/Y` (quoted names unquoted only for plain ASCII). */
const sectionPaths = (header: string): ReadonlyArray<string> => {
  const body = header.slice("diff --git ".length).replace(/\n$/, "");
  const match = /^a\/(.*) b\/(.*)$/.exec(body);
  return match === null ? [] : [match[1]!, match[2]!];
};

const patchReview = (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> =>
  patchRecords([{ records: parseSections(stdout), render: filePatch }], journal, repo);

const patchOthers = async (stdout: string, journal: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const listed = new Set(stdout.split("\0").filter((path) => path !== ""));
  for (const path of journal) {
    listed.delete(path);
    if (isUntracked(await repo.facts(path))) listed.add(path);
  }
  return [...listed].toSorted(byPath).map((path) => `${path}\0`).join("");
};

/**
 * The journal without a submodule's own paths: git shows a submodule by its checked-out commit and dirtiness, which this
 * repo's files cannot say, so its entry stays as the last answer had it.
 */
export const outsideSubmodules = (journal: ReadonlyArray<string>, submodules: ReadonlyArray<string>): ReadonlyArray<string> =>
  submodules.length === 0 ? journal : journal.filter((path) => !submodules.some((sub) => isUnder(path, sub)));

/** `stdout` (the last real answer of a `shape` read) patched with the paths written since it ran. */
export const patchAnswer = (shape: StaleShape, stdout: string, written: ReadonlyArray<string>, repo: RepoFacts): Promise<string> => {
  const journal = outsideSubmodules(journalFor(shape, written), repo.submodules);
  if (journal.length === 0) return Promise.resolve(stdout);
  switch (shape.kind) {
    case "status":
      return patchStatus(stdout, journal, repo);
    case "diff-index-numstat":
      return patchNumstat(stdout, journal, repo);
    case "ls-files-others":
      return patchOthers(stdout, journal, repo);
    case "review-patch":
      return patchReview(stdout, journal, repo);
    case "review-stats":
      return patchStats(stdout, journal, repo);
  }
};

/**
 * One file's read with no last answer (the diff panel's `:(top,literal)<path>` reads), computed from the repo's facts
 * alone: for each path it names, the last answer would be discarded and the path recomputed anyway (SPI-1295; ADR-0009).
 * Undefined when only git can answer it: a path that is a directory or a submodule, a base that names no commit, or two
 * paths git may pair as an inexact rename.
 */
const computeOneFile = async (shape: StaleShape, repo: RepoFacts): Promise<string | undefined> => {
  const paths = shape.paths;
  if (paths === undefined || shape.kind === "status" || shape.kind === "diff-index-numstat") return undefined;
  if (paths.some((path) => repo.trackedUnder(path) || repo.submodules.some((sub) => isUnder(path, sub) || isUnder(sub, path)))) return undefined;
  for (const path of paths) if ((await repo.untrackedUnder(path)).length > 0) return undefined;
  if (shape.kind === "ls-files-others") return patchOthers("", paths, repo);
  if (repo.base === null) return undefined;
  const changes = await changesOf(paths, repo);
  if (mayPairInexactly(changes)) return undefined;
  if (shape.kind === "review-patch") return sorted(rendered(changes, filePatch));
  return sorted(rendered(changes, rawOf)) + sorted(rendered(changes, fileNumstat));
};

export { latin1 };

// ---------------------------------------------------------------------------------------------------------------------
// The read as a whole (the Workspace DO's `#stale`, with its storage as `StaleSources`)

/**
 * The most written paths a stale read patches. Each costs a read and a hash of the file in the Workspace DO, whose CPU
 * time per request is limited: the prod reset of 2026-11-11 was a review diff patched with a journal of 37,000 paths
 * (a checked-out submodule). Past it the read gets its last answer, as above the guard.
 */
export const MAX_PATCHED_PATHS = 500;

/**
 * t3's other status shape: `--no-ahead-behind` (its local poll) for the plain one (its `statusDetails`, which also
 * counts ahead/behind), and back, with `--untracked-files=normal` kept as it was: an answer without it lacks the
 * untracked files a repo configured to hide them has. Undefined for any other argv.
 */
export const statusSibling = (argv: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  if (kindOf(argv, undefined)?.kind !== "status") return undefined;
  return argv.includes(NO_AHEAD_BEHIND) ? argv.filter((arg) => arg !== NO_AHEAD_BEHIND) : [...argv, NO_AHEAD_BEHIND];
};

/**
 * A status answer in `argv`'s shape: with `--no-ahead-behind`, git writes a branch's counts as `+? -?` unless both are
 * zero. The plain shape keeps whatever the answer had (`+? -?` from the poll: the counts are unknown while the
 * Container is stopped, which t3 reads as zero, ADR-0009).
 */
export const asStatusShape = (stdout: string, argv: ReadonlyArray<string>): string =>
  argv.includes("--no-ahead-behind")
    ? stdout
        .split("\0")
        .map((record) => (record.startsWith("# branch.ab ") && record !== "# branch.ab +0 -0" ? "# branch.ab +? -?" : record))
        .join("\0")
    : stdout;

export interface StaleAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a stale read is made from: the Workspace DO's read cache, its change log, and its repo. */
export interface StaleSources {
  /** The last real answer to `argv` (with this read's cwd and env), and the revision it was made at. */
  last(argv: ReadonlyArray<string>): Promise<{ readonly rev: number; readonly answer: StaleAnswer } | undefined>;
  /** The repo's paths (relative, outside `.git`) written after revision `rev`. */
  journalSince(rev: number): ReadonlyArray<string>;
  /** Whether the repo is small enough for the DO's isomorphic-git (the 2,000-file, 16 MB guard). */
  withinGuard(): Promise<boolean>;
  facts(base: string): Promise<RepoFacts>;
}

export type StaleOutcome =
  | { readonly found: false }
  | { readonly found: true; readonly answer: StaleAnswer; readonly stale: "patched" | "last-answer"; readonly why?: string };

/** The read's patched shape: undefined for a `.git`-scoped read, or argv no shape matches. */
const shapeOf = (read: { readonly argv: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> | undefined; readonly readScope?: "git-dir" | "repo" | undefined }) =>
  (read.readScope ?? "repo") === "repo" ? kindOf(read.argv, read.env) : undefined;

/**
 * A passive read while the Container is stopped: its last real answer (else, for status, its sibling shape's), patched
 * with the paths written since where the shape allows and the DO can afford it; else that answer alone. One file's read
 * with no last answer is computed within the guard (`computeOneFile`).
 */
export const staleRead = async (
  read: { readonly argv: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> | undefined; readonly readScope?: "git-dir" | "repo" | undefined },
  sources: StaleSources,
): Promise<StaleOutcome> => {
  let last = await sources.last(read.argv);
  if (last === undefined) {
    const sibling = statusSibling(read.argv);
    const theirs = sibling === undefined ? undefined : await sources.last(sibling);
    if (theirs !== undefined) last = { rev: theirs.rev, answer: { ...theirs.answer, stdout: asStatusShape(theirs.answer.stdout, read.argv) } };
  }
  if (last === undefined) {
    const shape = shapeOf(read);
    if (shape?.paths === undefined || !(await sources.withinGuard())) return { found: false };
    const stdout = await computeOneFile(shape, await sources.facts(shape.base));
    return stdout === undefined ? { found: false } : { found: true, answer: { exitCode: 0, stdout, stderr: "" }, stale: "patched" };
  }
  const asIs = (why?: string): StaleOutcome => ({ found: true, answer: last.answer, stale: "last-answer", ...(why === undefined ? {} : { why }) });
  const shape = last.answer.exitCode === 0 ? shapeOf(read) : undefined;
  if (shape === undefined) return asIs();
  const written = journalFor(shape, sources.journalSince(last.rev));
  if (written.length === 0) return { found: true, answer: last.answer, stale: "patched" };
  if (!(await sources.withinGuard())) return asIs("above the guard");
  const facts = await sources.facts(shape.base);
  const journal = outsideSubmodules(written, facts.submodules);
  if (journal.length > MAX_PATCHED_PATHS) return asIs(`${journal.length} paths written`);
  return { found: true, answer: { ...last.answer, stdout: await patchAnswer(shape, last.answer.stdout, journal, facts) }, stale: "patched" };
};
