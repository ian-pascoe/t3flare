// The Environment skill set as it travels and is served (SPI-1148, ADR-0033): each file's text by its path under the
// mount (`<skill>/SKILL.md`, …) and a hash of the whole, which says whether two sets differ without comparing their
// files. The Environment DO makes it from its rows; each Workspace DO keeps a copy and serves it read-only at
// `SKILLS_MOUNT`. Ported from cloudpid@47941c7c (`apps/server/src/workspace/skill-set-schema.ts`, `skill-set.ts`).

import type { EnvironmentPrecedence } from "./cliRoots.ts";
import { parseSkill, type Skill, type SkillDiscovery } from "./discovery.ts";

/** Where every Workspace serves the Environment skill set, read-only: outside the repo at `/workspace/repo`. */
export const SKILLS_MOUNT = "/workspace/.agents/skills";

export interface SkillSet {
  /** SHA-256 over the files' paths and SHA-256s (`skillSetHash`). */
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
}

/** The hash of a set with no file: SHA-256 of nothing. Never a version computer recorded for a mount that held files. */
export const EMPTY_SKILL_SET_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const EMPTY_SKILL_SET: SkillSet = { hash: EMPTY_SKILL_SET_HASH, files: {} };

/** The longest path a file under the mount may have, in UTF-8 bytes: far under a Durable Object KV key's limit. */
export const MAX_SKILL_PATH_BYTES = 512;

/** The longest segment of such a path, in UTF-8 bytes: a Linux file name's limit. */
export const MAX_SKILL_SEGMENT_BYTES = 255;

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** SHA-256 of `text`'s UTF-8, in hex. */
export const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/**
 * The set's hash: SHA-256 over each file's path, a NUL, its SHA-256 and a newline, in path order. `digests` gives a
 * file's SHA-256 where it is known (the Environment keeps one per file), so the hash needs no content; the rest are
 * made from `files`. No files hash as nothing (`EMPTY_SKILL_SET_HASH`).
 */
export const skillSetHash = async (files: Readonly<Record<string, string>>, digests: Readonly<Record<string, string>> = {}): Promise<string> => {
  const paths = [...new Set([...Object.keys(files), ...Object.keys(digests)])].sort();
  const lines: Array<string> = [];
  for (const path of paths) lines.push(`${path}\0${digests[path] ?? (await sha256Hex(files[path]!))}\n`);
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(lines.join(""))));
};

/** A set of `files` with its hash. */
export const skillSetOf = async (files: Readonly<Record<string, string>>): Promise<SkillSet> => ({ hash: await skillSetHash(files), files });

/**
 * Why `path` is not a file's path under the mount as a walk of it lists it, or undefined: segments joined by `/`, none
 * empty, `.` or `..`, no `\` and no NUL (computer would normalize some of these, so the listing would name a path the
 * mount lacks); at most `MAX_SKILL_PATH_BYTES`, and each segment at most `MAX_SKILL_SEGMENT_BYTES`. The install and every
 * Workspace apply this one rule (ADR-0033), so a set the Environment keeps is one a Workspace mounts.
 */
export const skillFilePathProblem = (path: string): string | undefined => {
  if (path.includes("\\") || path.includes("\0")) return "has a backslash or a NUL";
  // oxlint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(path)) return "has a control character";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "has an empty, `.` or `..` segment";
  const bytes = encoder.encode(path).byteLength;
  if (bytes > MAX_SKILL_PATH_BYTES) return `is ${bytes} bytes, more than the ${MAX_SKILL_PATH_BYTES} a path may be`;
  if (segments.some((segment) => encoder.encode(segment).byteLength > MAX_SKILL_SEGMENT_BYTES)) return `has a part longer than ${MAX_SKILL_SEGMENT_BYTES} bytes`;
  return undefined;
};

/** The first of `paths` that is also a directory of another, or undefined. */
export const pathAlsoDirectory = (paths: ReadonlyArray<string>): string | undefined => {
  const directories = new Set(paths.flatMap((path) => path.split("/").slice(0, -1).map((_, index, segments) => segments.slice(0, index + 1).join("/"))));
  return paths.find((path) => directories.has(path));
};

/** Why `set` (from RPC) is not a set the mount can serve, or undefined: its shape, its paths, a path both file and directory. */
export const skillSetProblem = (set: unknown): string | undefined => {
  if (set === null || typeof set !== "object") return "not a Skill set";
  const { hash, files } = set as { hash?: unknown; files?: unknown };
  if (typeof hash !== "string" || hash === "") return "not a Skill set: no hash";
  if (files === null || typeof files !== "object" || Array.isArray(files)) return "not a Skill set: no files";
  const paths = Object.keys(files);
  for (const path of paths) {
    if (typeof (files as Record<string, unknown>)[path] !== "string") return `Skill file ${path} is not text`;
    const problem = skillFilePathProblem(path);
    if (problem !== undefined) return `Skill file path ${path} ${problem}`;
  }
  const both = pathAlsoDirectory(paths);
  if (both !== undefined) return `Skill file path ${both} is also a directory`;
  return undefined;
};

/** An Environment skill as the composer and expansion see it, from the Environment's rows. */
export interface EnvironmentSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly disableModelInvocation: boolean;
}

/** Where an Environment skill's `SKILL.md` is in every Workspace. */
export const environmentSkillPath = (name: string): string => `${SKILLS_MOUNT}/${name}/SKILL.md`;

/**
 * `repo` (a Workspace's Repo-only discovery) with `environment` first: an Environment skill beats a Repo skill of the
 * same name (SPI-1001), which goes to `skipped`. Anything the Workspace listed under `SKILLS_MOUNT` (one that predates
 * Repo-only discovery) is dropped: the Environment's rows are the current set, so a removed or disabled Environment
 * skill un-shadows its Repo namesake at once. The Repo skills' cap and `omitted` are untouched. Pi Durable's merge.
 */
export const withEnvironmentSkills = (environment: ReadonlyArray<EnvironmentSkillEntry>, repo: SkillDiscovery): SkillDiscovery =>
  withEnvironmentSkillsFor(() => "environment", environment, repo);

/**
 * `repo` (a Repo-only discovery) with `environment` merged, each same-named pair settled by `precedenceOf` its Repo
 * skill (SPI-1153: a CLI agent's own rule, by the root the Repo skill is in, `environmentPrecedenceOf`), so the composer
 * shows what the CLI loads. `environment`: the Environment's is listed, first, and the Repo's goes to `skipped`; `repo`:
 * the Repo's is kept and the Environment's goes to `skipped`; `both`: both are listed, the Repo's first, as Codex lists
 * them (t3's menu shows the first of a name). An Environment skill without a Repo namesake is listed first. Anything
 * the Workspace listed under `SKILLS_MOUNT` is dropped: the rows are the set.
 */
export const withEnvironmentSkillsFor = (precedenceOf: (repoSkill: Skill) => EnvironmentPrecedence, environment: ReadonlyArray<EnvironmentSkillEntry>, repo: SkillDiscovery): SkillDiscovery => {
  const own = repo.skills.filter((skill) => !skill.filePath.startsWith(`${SKILLS_MOUNT}/`));
  const repoByName = new Map<string, Skill>();
  for (const skill of own) if (!repoByName.has(skill.name)) repoByName.set(skill.name, skill);
  const atMount = (skill: EnvironmentSkillEntry): Skill => ({ name: skill.name, description: skill.description, filePath: environmentSkillPath(skill.name), disableModelInvocation: skill.disableModelInvocation });
  const by: Record<EnvironmentPrecedence, Array<EnvironmentSkillEntry>> = { environment: [], repo: [], both: [] };
  for (const skill of environment) {
    const namesake = repoByName.get(skill.name);
    by[namesake === undefined ? "environment" : precedenceOf(namesake)].push(skill);
  }
  const winning = new Set(by.environment.map((skill) => skill.name));
  return {
    skills: [...by.environment.map(atMount), ...own.filter((skill) => !winning.has(skill.name)), ...by.both.map(atMount)],
    skipped: [
      ...own.filter((skill) => winning.has(skill.name)).map((skill) => ({ path: skill.filePath, reason: `"${skill.name}" is shadowed by the Environment skill ${skill.name}` })),
      ...by.repo.map((skill) => ({ path: environmentSkillPath(skill.name), reason: `"${skill.name}" is shadowed by the Repo skill at ${repoByName.get(skill.name)!.filePath}` })),
      ...repo.skipped.filter((skip) => !skip.path.startsWith(`${SKILLS_MOUNT}/`)),
    ],
    omitted: repo.omitted,
  };
};

/** The Skills a set's files declare, each `<name>/SKILL.md` read as at `SKILLS_MOUNT`: the model's listing of a Workspace's set. */
export const listingOfSet = (files: Readonly<Record<string, string>>): ReadonlyArray<Skill> =>
  Object.keys(files)
    .filter((path) => /^[^/]+\/SKILL\.md$/.test(path))
    .sort()
    .flatMap((path) => {
      const parsed = parseSkill(`${SKILLS_MOUNT}/${path}`, files[path]!);
      return "reason" in parsed ? [] : [parsed];
    });
