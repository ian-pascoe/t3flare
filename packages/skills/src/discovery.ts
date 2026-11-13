// Repo skills' discovery (SPI-1147 §1; ported from cloudpid@47941c7c `packages/extensions/src/skills-discovery.ts`):
// what a Skill is, how its `SKILL.md` is read, and the walk from a thread's cwd up to the repo root through each
// directory's `.pi/skills`, `.agents/skills` and `.claude/skills`. It reads files only, through `SkillFiles`, so the
// Workspace DO runs it next to its storage and never starts the Container (ADR-0009).
//
// Unlike cloudpid, an Environment skill beats a Repo skill of the same name (SPI-1001's shared decisions), and what is
// not taken is reported in `skipped` with its reason, so a skill that does not show can be explained.
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import { parse } from "yaml";

/** A Skill: a directory with a `SKILL.md` whose frontmatter names and describes it. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The absolute path of its `SKILL.md`, inside the Workspace (`/workspace/repo/…`). */
  readonly filePath: string;
  /** `disable-model-invocation: true`: for the owner to name, so the agent's listing leaves it out. */
  readonly disableModelInvocation: boolean;
}

/** A `SKILL.md` that is not taken, and why. */
export interface SkippedSkill {
  readonly path: string;
  readonly reason: string;
}

/** What discovery found: the Skills in precedence order, those skipped, and how many Repo skills the cap left out. */
export interface SkillDiscovery {
  readonly skills: ReadonlyArray<Skill>;
  readonly skipped: ReadonlyArray<SkippedSkill>;
  readonly omitted: number;
}

export interface ListedEntry {
  /** The path relative to the listed directory. */
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
}

/** What discovery reads: the Workspace's own files. */
export interface SkillFiles {
  /** The files, directories and links below `directory` (recursive, links not followed), at most `maxEntries`; none when absent. */
  readonly list: (directory: string, maxEntries: number) => Promise<ReadonlyArray<ListedEntry>>;
  /** A file's text, or undefined when it cannot be read. */
  readonly read: (path: string) => Promise<string | undefined>;
}

/** Where each directory's skills are, in precedence order. */
export const SKILL_ROOTS = [".pi/skills", ".agents/skills", ".claude/skills"] as const;

/** The longest description kept, the Agent Skills limit: a repo's skills are not trusted to size the prompt. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** The most Repo skills kept, nearest first. */
export const MAX_REPO_SKILLS = 100;

/**
 * Whether `$name` is a mention t3 recognises, within the Agent Skills' 64 characters: t3's own `matchInlineSkills` is
 * asked, so its token rule (an alphanumeric first character, a letter, no number-like name) is the one applied.
 */
export const isMentionable = (name: string): boolean => name.length <= 64 && [...matchInlineSkills(`$${name}`, [{ name }])].length === 1;

/** The most entries listed in one skills directory: far above any real one, below a walk of a whole tree. */
const MAX_ROOT_ENTRIES = 5000;
/** The most entries read from a directory a skills link points to: a link may lead anywhere. */
const MAX_LINKED_ENTRIES = 200;

export const join = (directory: string, path: string): string => (directory === "/" ? `/${path}` : `${directory}/${path}`);

/** `text`'s YAML frontmatter, as pi's `parseFrontmatter` finds it, or undefined. */
const frontmatterOf = (text: string): string | undefined => {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  return end === -1 ? undefined : normalized.slice(4, end);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The Skill a `SKILL.md` at `filePath` declares, or why it is not one. A skill without a `name` takes its directory's;
 * `allowed-tools` and every other field are ignored (a Skill grants no permission).
 */
export const parseSkill = (filePath: string, text: string): Skill | { readonly reason: string } => {
  const source = frontmatterOf(text);
  if (source === undefined) return { reason: "no frontmatter" };
  let fields: unknown;
  try {
    fields = parse(source);
  } catch {
    return { reason: "the frontmatter is not YAML" };
  }
  if (!isRecord(fields)) return { reason: "the frontmatter is not YAML" };
  const description = fields.description;
  if (typeof description !== "string" || description.trim() === "") return { reason: "no description" };
  const declared = fields.name;
  const name = typeof declared === "string" && declared !== "" ? declared : (filePath.split("/").at(-2) ?? "");
  if (!isMentionable(name)) return { reason: `"${name.slice(0, 80)}" is not a name t3 can mention` };
  return {
    name,
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    filePath,
    disableModelInvocation: fields["disable-model-invocation"] === true,
  };
};

/** The directories whose skill roots count for `cwd`: it and those above it up to `root`, nearest first. */
export const directoriesUp = (cwd: string, root: string): ReadonlyArray<string> => {
  const directory = cwd.replace(/\/+$/, "") || "/";
  if (directory !== root && !directory.startsWith(`${root}/`)) return [root];
  const below = directory.slice(root.length).split("/").filter(Boolean);
  return [...below.map((_, depth) => `${root}/${below.slice(0, below.length - depth).join("/")}`), root];
};

/** The `SKILL.md` paths below a skills directory: not in a dot directory or `node_modules`, nor inside another skill. */
const skillFiles = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const candidates = paths.filter(
    (path) =>
      (path === "SKILL.md" || path.endsWith("/SKILL.md")) && !path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules"),
  );
  const roots = candidates.map((path) => path.slice(0, -"SKILL.md".length));
  // A directory with a `SKILL.md` is a skill, and pi does not look below one.
  return candidates.filter((path) => !roots.some((root) => root !== "" && path !== `${root}SKILL.md` && path.startsWith(root))).sort();
};

/** The paths below a skills directory that may be a `SKILL.md`, following its links to directories one level, as pi does. */
const candidatePaths = async (files: SkillFiles, root: string): Promise<ReadonlyArray<string>> => {
  const entries = await files.list(root, MAX_ROOT_ENTRIES);
  const links = entries.filter((entry) => entry.kind === "symlink" && !entry.path.split("/").some((part) => part.startsWith(".")));
  const linked = await Promise.all(
    links.map(async (link) => (await files.list(join(root, link.path), MAX_LINKED_ENTRIES)).map((entry) => ({ ...entry, path: `${link.path}/${entry.path}` }))),
  );
  return [...entries, ...linked.flat()].filter((entry) => entry.kind !== "directory").map((entry) => entry.path);
};

/**
 * The Skills a thread in `cwd` can use. `environment` (the Environment skill set; empty until SPI-1148) comes first and
 * beats a Repo skill of the same name. Repo skills follow, nearest directory first and, in each, `SKILL_ROOTS` in order;
 * the first name found wins. At most `MAX_REPO_SKILLS` Repo skills are read; `omitted` counts the `SKILL.md` files past
 * the cap, unread.
 */
export const discoverSkills = async (
  files: SkillFiles,
  options: { readonly cwd: string; readonly root: string; readonly environment?: ReadonlyArray<Skill> },
): Promise<SkillDiscovery> => {
  const environment = options.environment ?? [];
  const taken = new Map<string, string>(environment.map((skill) => [skill.name, skill.filePath]));
  const roots = directoriesUp(options.cwd, options.root).flatMap((directory) => SKILL_ROOTS.map((root) => join(directory, root)));
  // Listed at once; read in order, since precedence decides which of two same-named skills is kept.
  const listed = await Promise.all(roots.map(async (root) => skillFiles(await candidatePaths(files, root)).map((path) => join(root, path))));
  const skills: Array<Skill> = [...environment];
  const skipped: Array<SkippedSkill> = [];
  let repo = 0;
  let omitted = 0;
  for (const path of listed.flat()) {
    if (repo >= MAX_REPO_SKILLS) {
      omitted++;
      continue;
    }
    const text = await files.read(path);
    const parsed = text === undefined ? { reason: "cannot be read" } : parseSkill(path, text);
    if ("reason" in parsed) {
      skipped.push({ path, reason: parsed.reason });
      continue;
    }
    const winner = taken.get(parsed.name);
    if (winner !== undefined) {
      skipped.push({ path, reason: `"${parsed.name}" is shadowed by ${winner}` });
      continue;
    }
    taken.set(parsed.name, path);
    skills.push(parsed);
    repo++;
  }
  return { skills, skipped, omitted };
};
