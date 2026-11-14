// A fake GitHub for the Environment skill fetch tests (SPI-1148): repos whose branches move as commits are pushed, read
// through a `RepoReader` that counts each request, so a test can say how many a run spent. Blob SHAs are made of the
// content (as git's are), so a file changes its SHA exactly when its text does. Ported from cloudpid@47941c7c
// (`apps/server/src/github/skill-repo.fixture.ts`), with links and submodules.
import { GithubReadError, type RepoReader, type SkillRepo } from "../src/skills/fetch.ts";
import type { TreeEntry } from "../src/skills/paths.ts";

/** A file's text, or a link (mode 120000) or a submodule at that path. */
export type Files = Readonly<Record<string, string | { readonly link: string } | { readonly submodule: true }>>;

/** The 40 hex digits of a string's hash: a stand-in for git's SHA that depends on the content alone. */
const shaOf = (text: string): string => {
  let hash = 5381;
  for (let at = 0; at < text.length; at += 1) {
    hash = (hash * 33) ^ text.charCodeAt(at);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(5);
};

export const fakeGithub = () => {
  const commits = new Map<string, { readonly repo: string; readonly files: Files }>();
  const refs = new Map<string, string>();
  const requests: Array<string> = [];
  const failures = new Map<string, Error>();
  let truncated = false;
  let next = 1;
  const key = ({ owner, name }: SkillRepo) => `${owner}/${name}`;
  const resolve = (repo: SkillRepo, ref: string | null): string => {
    const named = refs.get(`${key(repo)}@${ref ?? "main"}`);
    if (named !== undefined) return named;
    if (ref !== null && commits.get(ref)?.repo === key(repo)) return ref;
    throw new GithubReadError("not_found", `GitHub has no repo ${key(repo)} or no ref ${ref}`);
  };
  const failing = (repo: SkillRepo) => {
    const failure = failures.get(key(repo));
    if (failure !== undefined) throw failure;
  };
  const reader: RepoReader = {
    commit: async (repo, ref) => {
      requests.push(`commit ${key(repo)}@${ref ?? "HEAD"}`);
      failing(repo);
      return resolve(repo, ref);
    },
    tree: async (repo, commit) => {
      requests.push(`tree ${key(repo)}@${commit.slice(0, 7)}`);
      failing(repo);
      const files = commits.get(commit)?.files;
      if (files === undefined) throw new GithubReadError("not_found", `GitHub has no commit ${commit} in ${key(repo)}`);
      return {
        truncated,
        entries: Object.entries(files).map(([path, file]): TreeEntry => {
          if (typeof file === "string") return { path, type: "blob", sha: shaOf(file), size: new TextEncoder().encode(file).length, mode: "100644" };
          if ("link" in file) return { path, type: "blob", sha: shaOf(file.link), size: file.link.length, mode: "120000" };
          return { path, type: "commit", sha: shaOf(path) };
        }),
      };
    },
    blob: async (repo, sha) => {
      requests.push(`blob ${key(repo)}@${sha.slice(0, 7)}`);
      failing(repo);
      for (const { repo: owner, files } of commits.values()) {
        if (owner !== key(repo)) continue;
        for (const file of Object.values(files)) if (typeof file === "string" && shaOf(file) === sha) return new TextEncoder().encode(file);
      }
      throw new GithubReadError("not_found", `no blob ${sha}`);
    },
  };
  return {
    reader,
    requests,
    /** Push `files` as a new commit of `repo`'s branch `ref` (`main`: the default branch); its SHA. */
    push: (repo: string, files: Files, ref = "main"): string => {
      const commit = `${(next++).toString(16).padStart(2, "0")}${shaOf(`${repo}${ref}${next}`)}`.slice(0, 40).padEnd(40, "0");
      commits.set(commit, { repo, files });
      refs.set(`${repo}@${ref}`, commit);
      return commit;
    },
    fail: (repo: string, failure: Error | undefined) => {
      if (failure === undefined) failures.delete(repo);
      else failures.set(repo, failure);
    },
    truncate: (on: boolean) => {
      truncated = on;
    },
    reset: () => {
      requests.length = 0;
    },
    blobs: () => requests.filter((request) => request.startsWith("blob ")).length,
  };
};

/** A `SKILL.md` that declares `name`. */
export const skillMd = (name: string, body = "Steps.", extra = "") => `---\nname: ${name}\ndescription: What ${name} does.\n${extra}---\n${body}\n`;
