// What an Environment skill may hold (SPI-1148, ADR-0033): the checks its files pass before the Environment keeps them,
// the Agent Skills name rules, and the limits. Ported from cloudpid@47941c7c (`packages/extensions/src/skill-checks.ts`)
// with SPI-1148's added rules: a name needs a letter (so t3 can mention it), a Skill may hold no link or submodule, and
// every path passes the rule each Workspace applies (`skillFilePathProblem`).
import { pathAlsoDirectory, skillFilePathProblem } from "@t3flare/skills";

/** The most one file may be: under the 2 MB a Durable Object SQLite row may hold. */
export const MAX_FILE_BYTES = 1_536 * 1024;
/** The most one Skill's files may be together. */
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;
/** The most files one Skill's folder may hold, far above any real one. */
export const MAX_SKILL_FILES = 500;
/** The most the Environment's skills may be together, disabled ones counted: the set travels in one Durable Object call. */
export const MAX_SET_BYTES = 8 * 1024 * 1024;
/** The most Environment skills kept, disabled ones counted. */
export const MAX_ENVIRONMENT_SKILLS = 100;
/** The longest name a Skill may have (Agent Skills). */
export const MAX_SKILL_NAME_LENGTH = 64;
/** The longest description a Skill may have (Agent Skills). */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/** The most `SKILL.md` files read to list a repo's Skills. */
export const MAX_SKILL_CANDIDATES = 200;
/**
 * The most blobs one request reads: the largest Skill. GitHub's secondary limit is 900 points a minute per REST
 * endpoint, a GET 1 point, so these and the commit and the tree stay under it in any minute.
 */
export const MAX_BLOB_READS = MAX_SKILL_FILES;

/** What looks like a credential or a path on somebody's machine. */
export const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pour]_[A-Za-z0-9]{30,}/,
  // An installation token, classic or stateless (`ghs_<app id>_<JWT>`).
  /\bghs_[A-Za-z0-9._-]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{20,}["']/i,
  /\/Users\/[a-z][a-z0-9_-]*\//,
  /\/home\/[a-z][a-z0-9_-]*\//,
];

/** Why `bytes`, the contents of a Skill's file at `path`, may not be kept: none when it may. */
export const problemsIn = (path: string, bytes: Uint8Array): Array<string> => {
  const problems: Array<string> = [];
  if (bytes.length > MAX_FILE_BYTES) problems.push(`${path}: ${bytes.length} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be`);
  if (bytes.includes(0)) return [...problems, `${path}: a binary file; a Skill holds text only`];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return [...problems, `${path}: not UTF-8 text; a Skill holds text only`];
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) problems.push(`${path}: matches ${String(pattern)}, which looks like a credential or a local path`);
  }
  return problems;
};

/**
 * Why `name` is not an Environment skill's name, or undefined: the Agent Skills rules (1 to 64 characters, lowercase
 * letters, digits and hyphens, no leading, trailing or double hyphen), and at least one letter, so t3 can mention it.
 */
export const skillNameProblem = (name: string): string | undefined => {
  if (name.length === 0) return "a Skill's name may not be empty";
  if (name.length > MAX_SKILL_NAME_LENGTH) return `${JSON.stringify(name.slice(0, 80))} is ${name.length} characters, more than the ${MAX_SKILL_NAME_LENGTH} a Skill's name may be`;
  if (!/^[a-z0-9-]+$/.test(name)) return `${JSON.stringify(name)} may hold only lowercase letters, digits and hyphens`;
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return `${JSON.stringify(name)} may not start or end with a hyphen, or hold two in a row`;
  if (!/[a-z]/.test(name)) return `${JSON.stringify(name)} needs at least one letter, so t3 can mention it`;
  return undefined;
};

/** One file of a Skill as GitHub's tree lists it: its path in the Skill's folder, and its size when GitHub says. */
export interface TreeFile {
  readonly relative: string;
  readonly size?: number | undefined;
}

/**
 * Why a Skill named `name`, by its folder's tree entries, may not be kept, before any file is read: too many files or
 * bytes, a file too large, a path a Workspace would refuse, a link or a submodule.
 */
export const treeProblems = (name: string, files: ReadonlyArray<TreeFile>, links: ReadonlyArray<string>): Array<string> => {
  const problems: Array<string> = [];
  if (files.length > MAX_SKILL_FILES) problems.push(`the folder holds ${files.length} files, more than ${MAX_SKILL_FILES}`);
  let total = 0;
  for (const file of files) {
    total += file.size ?? 0;
    if (file.size !== undefined && file.size > MAX_FILE_BYTES) problems.push(`${file.relative}: ${file.size} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be`);
    const path = `${name}/${file.relative}`;
    const problem = skillFilePathProblem(path);
    if (problem !== undefined) problems.push(`${file.relative}: the path ${problem}`);
  }
  const both = pathAlsoDirectory(files.map((file) => file.relative));
  if (both !== undefined) problems.push(`${both}: the path is also a directory`);
  if (total > MAX_SKILL_BYTES) problems.push(`the files are ${total} bytes together, more than the ${MAX_SKILL_BYTES} a Skill may be`);
  for (const link of links) problems.push(`${link}: a link or a submodule; a Skill may hold neither`);
  return problems;
};

/** A kept Skill, as the set's limits count it. */
export interface KeptSize {
  readonly name: string;
  readonly bytes: number;
}

/**
 * Why the Environment's skills would be more than the set may hold once `incoming` replace the kept ones of their names,
 * or undefined. Disabled skills count, so switching one on never fails.
 */
export const setProblem = (kept: ReadonlyArray<KeptSize>, incoming: ReadonlyArray<KeptSize>): string | undefined => {
  const names = new Set(incoming.map((skill) => skill.name));
  const after = [...kept.filter((skill) => !names.has(skill.name)), ...incoming];
  if (after.length > MAX_ENVIRONMENT_SKILLS) return `the Environment would hold ${after.length} skills, more than the ${MAX_ENVIRONMENT_SKILLS} it may (disabled ones count)`;
  const bytes = after.reduce((sum, skill) => sum + skill.bytes, 0);
  if (bytes > MAX_SET_BYTES) return `the Environment's skills would be ${bytes} bytes together, more than the ${MAX_SET_BYTES} they may be (disabled ones count)`;
  return undefined;
};
