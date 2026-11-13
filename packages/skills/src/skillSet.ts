// The Environment skill set as it travels and is served (SPI-1148): each file's text by its path under the mount
// (`<skill>/SKILL.md`, …) and a hash of the whole, which says whether two sets differ without comparing their files.
// The Environment DO makes it from its rows; each Workspace DO keeps a copy and serves it read-only at `SKILLS_MOUNT`.
// Ported from cloudpid@47941c7c (`apps/server/src/workspace/skill-set-schema.ts`, `skill-set.ts`).

/** Where every Workspace serves the Environment skill set, read-only: outside the repo at `/workspace/repo`. */
export const SKILLS_MOUNT = "/workspace/.agents/skills";

export interface SkillSet {
  /** SHA-256 over the files, by path (`skillSetHash`). */
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
}

/** The hash of a set with no file: SHA-256 of nothing. Never a version computer recorded for a mount that held files. */
export const EMPTY_SKILL_SET_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const EMPTY_SKILL_SET: SkillSet = { hash: EMPTY_SKILL_SET_HASH, files: {} };

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * SHA-256 over `files` in path order, each as its path, a NUL, its UTF-8 length, a NUL and its text. No files hash as
 * nothing (`EMPTY_SKILL_SET_HASH`).
 */
export const skillSetHash = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const encoder = new TextEncoder();
  const parts: Array<Uint8Array> = [];
  for (const path of Object.keys(files).sort()) {
    const body = encoder.encode(files[path]!);
    parts.push(encoder.encode(`${path}\0${body.byteLength}\0`), body);
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return hex(await crypto.subtle.digest("SHA-256", joined));
};

/** A set of `files` with its hash. */
export const skillSetOf = async (files: Readonly<Record<string, string>>): Promise<SkillSet> => ({ hash: await skillSetHash(files), files });

/**
 * Why `path` is not a file's path under the mount as a walk of it lists it: segments joined by `/`, none empty, `.` or
 * `..`, no `\` and no NUL. computer would normalize some of these, so the listing would name a path the mount lacks.
 */
const pathProblem = (path: string): string | undefined => {
  if (path.includes("\\") || path.includes("\0")) return "has a backslash or a NUL";
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return "has an empty, `.` or `..` segment";
  return undefined;
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
    const problem = pathProblem(path);
    if (problem !== undefined) return `Skill file path ${path} ${problem}`;
  }
  const directories = new Set(paths.flatMap((path) => path.split("/").slice(0, -1).map((_, index, segments) => segments.slice(0, index + 1).join("/"))));
  const both = paths.find((path) => directories.has(path));
  if (both !== undefined) return `Skill file path ${both} is also a directory`;
  return undefined;
};
