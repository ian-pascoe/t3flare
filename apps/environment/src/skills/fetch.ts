// Fetching Environment skills from a GitHub repo (SPI-1148, ADR-0033): resolve the ref to a commit, list the commit's
// tree, pick the Skill folders by the `skills` CLI's path rules (`paths.ts`), and read the chosen Skills' files at that
// commit. GitHub is read through a `RepoReader` (`contents.ts` asks GitHub with the Environment's token), so the rules are
// tested without a network. Nothing is kept here: the store keeps what comes out. Ported from cloudpid@47941c7c
// (`apps/server/src/github/skill-fetch.ts`), cut to what the Harness panel asks: a preview, a fetch of the folders the
// owner picked at the previewed commit, and an update check that reads no file.
//
// Every request is bounded (plan §3.3): a preview reads one commit, one tree and at most `MAX_SKILL_CANDIDATES`
// `SKILL.md` blobs; a fetch reads each chosen folder's `SKILL.md`, checks the folder from the tree, and refuses before
// any other read when the files are more than `MAX_BLOB_READS`; an update check reads one commit and one tree.
// @effect-diagnostics extendsNativeError:off -- `GithubReadError` is thrown from Promise code and read with `instanceof`.
import { frontmatterFields, sha256Hex } from "@t3flare/skills";

import { MAX_BLOB_READS, MAX_FILE_BYTES, MAX_SKILL_CANDIDATES, MAX_SKILL_DESCRIPTION_LENGTH, problemsIn, skillNameProblem, treeProblems } from "./checks.ts";
import { findSkillMdPaths, folderHashOf, linksIn, skillFilesIn, skillFolderOf, skillMdIn, type TreeEntry } from "./paths.ts";
import type { SkillSourceInput } from "./source.ts";

/** A repo on GitHub. */
export interface SkillRepo {
  readonly owner: string;
  readonly name: string;
}

/** A commit's tree, flattened. */
export interface RepoTree {
  readonly entries: ReadonlyArray<TreeEntry>;
  /** GitHub left entries out: the repo is larger than one listing holds. */
  readonly truncated: boolean;
}

export type FetchFailureKind = "not_found" | "rate_limited" | "refused" | "truncated" | "bad_ref" | "no_skills" | "no_match" | "too_many" | "failed";

/** A failed read of GitHub: what kind of failure, and what to tell. */
export class GithubReadError extends Error {
  readonly kind: FetchFailureKind;
  constructor(kind: FetchFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** What fetching reads of GitHub. Each throws a `GithubReadError` when GitHub gives no answer. */
export interface RepoReader {
  /** The commit `ref` names in `repo` (the default branch's head when null). */
  readonly commit: (repo: SkillRepo, ref: string | null) => Promise<string>;
  /** The tree of `commit`, every folder below it. */
  readonly tree: (repo: SkillRepo, commit: string) => Promise<RepoTree>;
  /** The content of the blob `sha`. */
  readonly blob: (repo: SkillRepo, sha: string) => Promise<Uint8Array>;
  /** Called before `reads` blobs are read: throws when they cannot be (an unauthenticated limit that would run out). */
  readonly beforeBlobs?: (reads: number) => Promise<void>;
}

export interface Failed {
  readonly status: "failed";
  readonly kind: FetchFailureKind;
  readonly message: string;
}

/** What a `SKILL.md` declares, or why it is not an Environment skill. */
export type SkillMdInfo =
  | {
      readonly ok: true;
      readonly name: string;
      readonly description: string;
      /** The repo marks it `metadata.internal`: left out unless it is named, as the CLI does. */
      readonly internal: boolean;
      readonly disableModelInvocation: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** A frontmatter value as one line of printable text, as the CLI's `sanitizeMetadata` makes it. */
const oneLine = (value: string): string =>
  value
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();

/**
 * `text` read as an Environment skill's `SKILL.md`: frontmatter with a `name` and a `description` of at most 1,024
 * characters. Unlike a Repo skill, a missing name is not taken from the folder (ADR-0033).
 */
export const readSkillMd = (text: string): SkillMdInfo => {
  const read = frontmatterFields(text);
  if (!read.ok) return { ok: false, message: `SKILL.md has ${read.reason}` };
  const { fields } = read;
  const name = typeof fields.name === "string" ? oneLine(fields.name) : "";
  const description = typeof fields.description === "string" ? oneLine(fields.description) : "";
  if (name === "") return { ok: false, message: "SKILL.md's frontmatter sets no name" };
  if (description === "") return { ok: false, message: "SKILL.md's frontmatter sets no description" };
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return { ok: false, message: `SKILL.md's description is ${description.length} characters, more than the ${MAX_SKILL_DESCRIPTION_LENGTH} it may be` };
  }
  const metadata = fields.metadata;
  const internal = typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>).internal === true;
  return { ok: true, name, description, internal, disableModelInvocation: fields["disable-model-invocation"] === true };
};

/** How `skills` names a Skill: lower case, words joined by hyphens. */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Whether the Skill named `skill.name` in folder `skill.path` is the one `name` asks for (cloudpid's `isNamedSkill`). */
export const isNamedSkill = (skill: { readonly name: string; readonly path: string }, name: string): boolean =>
  skill.name.toLowerCase() === name.toLowerCase() || slug(skill.name) === slug(name) || slug(basename(skill.path)) === slug(name);

/** The most blobs read at once. */
const CONCURRENCY = 6;

/** `run` over `items`, at most `CONCURRENCY` at a time, in order. */
const mapLimited = async <A, B>(items: ReadonlyArray<A>, run: (item: A) => Promise<B>): Promise<Array<B>> => {
  const results: Array<B> = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await run(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
};

const failed = (kind: FetchFailureKind, message: string): Failed => ({ status: "failed", kind, message });

const asFailure = (cause: unknown): Failed => {
  // Only what the reader says of GitHub is a failure to report; anything else is a bug and surfaces as one.
  if (cause instanceof GithubReadError) return failed(cause.kind, cause.message);
  throw cause;
};

const decoder = new TextDecoder();

/**
 * The commit `ref` names and its tree. A ref the repo does not have is told apart from a repo that cannot be read: when
 * the ref is not found, the default branch is asked, so a repo that answers it has no such ref.
 */
const readRepoAt = async (reader: RepoReader, repo: SkillRepo, ref: string | null): Promise<{ readonly commit: string; readonly tree: RepoTree }> => {
  const name = `${repo.owner}/${repo.name}`;
  const commit = await reader.commit(repo, ref).catch(async (cause: unknown) => {
    if (ref !== null && cause instanceof GithubReadError && cause.kind === "not_found") {
      const head = await reader.commit(repo, null).then(
        () => true,
        () => false,
      );
      if (head) throw new GithubReadError("bad_ref", `${name} has no ref ${JSON.stringify(ref)} (a branch, a tag or a commit).`);
    }
    throw cause;
  });
  const tree = await reader.tree(repo, commit);
  if (tree.truncated) {
    throw new GithubReadError("truncated", `GitHub listed only part of ${name}'s files (the repo is larger than one listing holds), so its Skills cannot be found reliably. Install from a smaller repo, or fork the Skills into one.`);
  }
  return { commit, tree };
};

/** A Skill a preview found: what its `SKILL.md` says, its size from the tree, and why it cannot be installed. */
export interface PreviewSkill {
  readonly name: string;
  readonly description: string;
  /** Its folder in the repo (`""` for the repo's root). */
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  readonly internal: boolean;
  /** Its folder hash at this commit, from the tree: equal to a kept Skill's when the files are the same. */
  readonly digest: string;
  /** Empty when it can be installed, as far as the tree and its `SKILL.md` tell. */
  readonly problems: ReadonlyArray<string>;
}

export interface Preview {
  readonly status: "listed";
  readonly repo: string;
  readonly ref: string | null;
  readonly commit: string;
  readonly skills: ReadonlyArray<PreviewSkill>;
  /** `SKILL.md` files that are not Skills. */
  readonly unreadable: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  /** Skills the repo marks `metadata.internal`, left out because none was named. */
  readonly internal: number;
  /** `SKILL.md` files past `MAX_SKILL_CANDIDATES`, unread. */
  readonly omitted: number;
}

/** The checks a Skill found by its `SKILL.md` at `skillMdPath` fails from the tree, its `SKILL.md` and its name alone. */
const previewProblems = (tree: RepoTree, skillMdPath: string, name: string, skillMd: Uint8Array): Array<string> => {
  const entries = skillFilesIn({ tree: tree.entries }, skillMdPath);
  const nameProblem = skillNameProblem(name);
  return [
    ...(nameProblem === undefined ? [] : [nameProblem]),
    ...treeProblems(name, entries.map(fileOf(skillMdPath)), linksIn({ tree: tree.entries }, skillMdPath)),
    ...problemsIn("SKILL.md", skillMd),
  ];
};

/** A tree entry as the checks take it: its path in the folder, `SKILL.md` in that case. */
const fileOf =
  (skillMdPath: string) =>
  (entry: TreeEntry & { readonly relative: string }): { readonly relative: string; readonly size?: number | undefined } => ({
    relative: entry.path === skillMdPath ? "SKILL.md" : entry.relative,
    size: entry.size,
  });

/**
 * The Skills `source` holds at its ref (or under its folder, or the one it names after `@`), each with what would refuse
 * it. Reads one commit, one tree and the candidates' `SKILL.md` (at most `MAX_SKILL_CANDIDATES`); no other file, so the
 * content checks of the other files run at install.
 */
export const previewSkills = async (reader: RepoReader, source: SkillSourceInput): Promise<Preview | Failed> => {
  const repo: SkillRepo = { owner: source.owner, name: source.name };
  try {
    const { commit, tree } = await readRepoAt(reader, repo, source.ref);
    const where = source.path === "" ? source.repo : `${source.repo} under ${source.path}`;
    const found = findSkillMdPaths({ tree: tree.entries }, source.path || undefined).filter((path) => basename(path).toLowerCase() === "skill.md");
    if (found.length === 0) return failed("no_skills", `${where} holds no Skill (no folder with a SKILL.md).`);
    // A named Skill whose folder is named so is found without reading the others' `SKILL.md`.
    const byFolder = source.skill === null ? [] : found.filter((path) => slug(basename(skillFolderOf(path))) === slug(source.skill!));
    const walk = byFolder.length > 0 ? byFolder : found;
    const toRead = walk.slice(0, MAX_SKILL_CANDIDATES);
    const entryOf = new Map(tree.entries.map((entry) => [entry.path, entry] as const));
    await reader.beforeBlobs?.(toRead.length);
    const read = await mapLimited(toRead, async (skillMdPath) => {
      const entry = entryOf.get(skillMdPath)!;
      const folder = skillFolderOf(skillMdPath);
      if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
        return { folder, skillMdPath, info: { ok: false, message: `SKILL.md: ${entry.size} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be` } as SkillMdInfo, bytes: new Uint8Array() };
      }
      const bytes = await reader.blob(repo, entry.sha);
      return { folder, skillMdPath, info: readSkillMd(decoder.decode(bytes)), bytes };
    });
    const unreadable: Array<{ readonly path: string; readonly message: string }> = [];
    const skills: Array<PreviewSkill> = [];
    const taken = new Set<string>();
    let internal = 0;
    for (const { folder, skillMdPath, info, bytes } of read) {
      if (!info.ok) {
        unreadable.push({ path: folder, message: info.message });
        continue;
      }
      if (source.skill !== null && !isNamedSkill({ name: info.name, path: folder }, source.skill)) continue;
      if (info.internal && source.skill === null) {
        internal++;
        continue;
      }
      const entries = skillFilesIn({ tree: tree.entries }, skillMdPath);
      const problems = previewProblems(tree, skillMdPath, info.name, bytes);
      if (taken.has(info.name)) problems.unshift(`another Skill of the name ${info.name} comes first in the repo`);
      taken.add(info.name);
      skills.push({
        name: info.name,
        description: info.description,
        path: folder,
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
        internal: info.internal,
        digest: await folderHashOf({ tree: tree.entries }, skillMdPath),
        problems,
      });
    }
    if (source.skill !== null && skills.length === 0) {
      return failed("no_match", `${where} has no Skill named ${JSON.stringify(source.skill)}.`);
    }
    return { status: "listed", repo: source.repo, ref: source.ref, commit, skills, unreadable, internal, omitted: walk.length - toRead.length };
  } catch (cause) {
    return asFailure(cause);
  }
};

/** One file of a fetched Skill: its text, GitHub's blob SHA, its size in bytes and the SHA-256 of its text. */
export interface FetchedFile {
  readonly text: string;
  readonly blob: string;
  readonly size: number;
  readonly sha256: string;
}

/** A Skill read from the repo at a commit. */
export interface FetchedSkill {
  readonly name: string;
  readonly description: string;
  /** Its folder in the repo (`""` for the repo's root). */
  readonly path: string;
  readonly disableModelInvocation: boolean;
  /** cloudpid's folder hash: SHA-256 over the kept files' paths and blob SHAs. */
  readonly digest: string;
  readonly bytes: number;
  readonly files: Readonly<Record<string, FetchedFile>>;
}

export interface Fetched {
  readonly status: "fetched";
  readonly commit: string;
  readonly skills: ReadonlyArray<FetchedSkill>;
  /** The folders asked for that cannot be kept, and why. */
  readonly refused: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * The Skills in `folders` of `repo` at `commit` (what the owner was shown and picked), each read whole and checked, or
 * why not. Each folder's `SKILL.md` is read first (for its name), then the folder is checked from the tree; the other
 * files are read only when the checks pass, and none when they are more than `MAX_BLOB_READS` together.
 */
export const fetchSkills = async (reader: RepoReader, request: { readonly repo: SkillRepo; readonly commit: string; readonly folders: ReadonlyArray<string> }): Promise<Fetched | Failed> => {
  const { repo, folders } = request;
  const where = `${repo.owner}/${repo.name}`;
  try {
    const tree = await reader.tree(repo, request.commit);
    if (tree.truncated) return failed("truncated", `GitHub listed only part of ${where}'s files (the repo is larger than one listing holds), so its Skills cannot be read reliably.`);
    const refused: Array<{ readonly path: string; readonly message: string }> = [];
    const located = folders.flatMap((folder) => {
      const skillMdPath = skillMdIn({ tree: tree.entries }, folder);
      if (skillMdPath === undefined) {
        refused.push({ path: folder, message: `${folder === "" ? where : `${where}/${folder}`} holds no SKILL.md at ${request.commit.slice(0, 7)}` });
        return [];
      }
      return [{ folder, skillMdPath, entries: skillFilesIn({ tree: tree.entries }, skillMdPath) }];
    });
    const reads = located.reduce((sum, skill) => sum + skill.entries.length, 0);
    if (reads > MAX_BLOB_READS) return failed("too_many", `These skills hold ${reads} files; install at most ${MAX_BLOB_READS} files at a time.`);
    await reader.beforeBlobs?.(reads);
    // A blob two Skills share is asked once.
    const blobs = new Map<string, Promise<Uint8Array>>();
    const blob = (sha: string) => {
      let read = blobs.get(sha);
      if (read === undefined) blobs.set(sha, (read = reader.blob(repo, sha)));
      return read;
    };
    const skills: Array<FetchedSkill> = [];
    for (const { folder, skillMdPath, entries } of located) {
      const skillMdEntry = entries.find((entry) => entry.path === skillMdPath)!;
      const skillMd = await blob(skillMdEntry.sha);
      const info = readSkillMd(decoder.decode(skillMd));
      if (!info.ok) {
        refused.push({ path: folder, message: info.message });
        continue;
      }
      const before = previewProblems(tree, skillMdPath, info.name, skillMd);
      if (before.length > 0) {
        refused.push({ path: folder, message: `${info.name}: ${before.join("; ")}` });
        continue;
      }
      const contents = await mapLimited(entries, async (entry) => ({ path: fileOf(skillMdPath)(entry).relative, entry, bytes: await blob(entry.sha) }));
      const problems = contents.flatMap(({ path, bytes }) => (path === "SKILL.md" ? [] : problemsIn(path, bytes)));
      if (problems.length > 0) {
        refused.push({ path: folder, message: `${info.name}: ${problems.join("; ")}` });
        continue;
      }
      const files: Record<string, FetchedFile> = {};
      for (const { path, entry, bytes } of contents) {
        const text = decoder.decode(bytes);
        files[path] = { text, blob: entry.sha, size: bytes.byteLength, sha256: await sha256Hex(text) };
      }
      skills.push({
        name: info.name,
        description: info.description,
        path: folder,
        disableModelInvocation: info.disableModelInvocation,
        digest: await folderHashOf({ tree: tree.entries }, skillMdPath),
        bytes: contents.reduce((sum, { bytes }) => sum + bytes.byteLength, 0),
        files,
      });
    }
    return { status: "fetched", commit: request.commit, skills, refused };
  } catch (cause) {
    return asFailure(cause);
  }
};

/** A kept Skill, as an update check compares it: its folder, digest and each file's blob by path. */
export interface KeptForCheck {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly files: Readonly<Record<string, string>>;
}

export type CheckResult =
  | { readonly name: string; readonly status: "current" }
  | {
      readonly name: string;
      readonly status: "update";
      readonly added: ReadonlyArray<string>;
      readonly changed: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
    }
  | { readonly name: string; readonly status: "gone"; readonly message: string };

export interface Checked {
  readonly status: "checked";
  readonly commit: string;
  readonly results: ReadonlyArray<CheckResult>;
}

/**
 * Whether the Skills `kept` of `repo` have moved at `ref`'s latest commit: one commit and one tree for all of them, and
 * no file read. A folder that lost its `SKILL.md` is `gone`; a name changed in the frontmatter is told at the update.
 */
export const checkSkills = async (reader: RepoReader, request: { readonly repo: SkillRepo; readonly ref: string | null; readonly kept: ReadonlyArray<KeptForCheck> }): Promise<Checked | Failed> => {
  const { repo } = request;
  try {
    const { commit, tree } = await readRepoAt(reader, repo, request.ref);
    const results: Array<CheckResult> = [];
    for (const skill of request.kept) {
      const skillMdPath = skillMdIn({ tree: tree.entries }, skill.path);
      if (skillMdPath === undefined) {
        results.push({ name: skill.name, status: "gone", message: `No longer in ${repo.owner}/${repo.name} at ${request.ref ?? "the default branch"}` });
        continue;
      }
      if ((await folderHashOf({ tree: tree.entries }, skillMdPath)) === skill.digest) {
        results.push({ name: skill.name, status: "current" });
        continue;
      }
      const now = new Map(skillFilesIn({ tree: tree.entries }, skillMdPath).map((entry) => [fileOf(skillMdPath)(entry).relative, entry.sha] as const));
      const before = new Map(Object.entries(skill.files));
      results.push({
        name: skill.name,
        status: "update",
        added: [...now.keys()].filter((path) => !before.has(path)).sort(),
        changed: [...now].filter(([path, sha]) => before.has(path) && before.get(path) !== sha).map(([path]) => path).sort(),
        removed: [...before.keys()].filter((path) => !now.has(path)).sort(),
      });
    }
    return { status: "checked", commit, results };
  } catch (cause) {
    return asFailure(cause);
  }
};
