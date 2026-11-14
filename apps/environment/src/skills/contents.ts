// @effect-diagnostics globalFetch:off globalDate:off
// A repo's commit, tree and blobs, read from GitHub's REST API by the Environment DO alone (SPI-1148, ADR-0033): the
// `RepoReader` the fetch reads through. Ported from cloudpid@47941c7c (`apps/server/src/github/contents.ts`,
// `request.ts`), with t3flare's credential (plan §3.2):
//
// 1. a token for the repo itself, where the GitHub App is installed on it: the only way to read a private repo;
// 2. else a token for one installed repo, which reads public repos outside the installation (R1) from the
//    installation's limit;
// 3. else, with no installed repo at all, no token: the 60 an hour GitHub gives this Worker's shared address, checked
//    before the first read and again before the files (`/rate_limit` is free).
//
// The token is used for these requests and dropped; it reaches no Session, Container, page or log. Failures are told
// plainly (`GithubReadError`), each whole.
import { GitHubNotInstalled } from "@t3flare/github-app/app";
import { SKILL_FETCH_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";

import type { MintRequest } from "../agents/github.ts";
import { GithubReadError, type RepoReader, type RepoTree, type SkillRepo } from "./fetch.ts";
import type { TreeEntry } from "./paths.ts";

const API = "https://api.github.com";

/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How the fetch reads a repo: with which token, and whether the App is installed on the repo's owner. */
export interface ReadAccess {
  readonly token: string | undefined;
  readonly how: "repo" | "installation" | "unauthenticated";
  /** The App is installed on the repo's owner (which a refusal's words depend on). */
  readonly ownerInstalled: boolean;
}

/**
 * The access for reading `repo`: a token for it, else for the first of `installed` the App mints for, else none. A mint
 * that fails for any reason moves to the next; none is ever kept beyond the request that asked.
 */
export const readAccessFor = async (
  minter: { readonly mint: (request: MintRequest) => Promise<{ readonly token: string }> },
  installed: ReadonlyArray<SkillRepo>,
  repo: SkillRepo,
): Promise<ReadAccess> => {
  const mint = (owner: string, name: string) => minter.mint({ owner: owner.toLowerCase(), repositories: [name], permissions: SKILL_FETCH_GITHUB_PERMISSIONS });
  let ownerInstalled = true;
  try {
    return { token: (await mint(repo.owner, repo.name)).token, how: "repo", ownerInstalled };
  } catch (cause) {
    ownerInstalled = !(cause instanceof GitHubNotInstalled) && !String(cause).includes("not configured");
  }
  const seen = new Set<string>();
  for (const other of installed) {
    const key = `${other.owner}/${other.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return { token: (await mint(other.owner, other.name)).token, how: "installation", ownerInstalled };
    } catch {
      // The next installed repo, else unauthenticated.
    }
  }
  return { token: undefined, how: "unauthenticated", ownerInstalled: false };
};

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What the way out of the shared unauthenticated limit is, for a refusal. */
export const UNAUTHENTICATED_WAY_OUT = "Install the GitHub App on a repository and add it as a Project, so reads use the installation's own limit.";

/**
 * A name that goes in a URL's path as one segment, escaped. A URL parser resolves `.` and `..` (escaped or not), which
 * would send the request, made with the Environment's token, to another endpoint: they and an empty name are refused.
 */
const segment = (name: string): string => {
  if (name === "" || name === "." || name === "..") throw new GithubReadError("refused", `${JSON.stringify(name)} is not a name GitHub has`);
  return encodeURIComponent(name);
};

const repoPath = ({ owner, name }: SkillRepo): string => `/repos/${segment(owner)}/${segment(name)}`;

/** A ref as it goes in a URL: each segment escaped, the slashes of a branch name kept. */
const refPath = (ref: string): string => ref.split("/").map(segment).join("/");

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const whenOf = (resetSeconds: number | undefined, now: number): string =>
  resetSeconds === undefined ? "" : ` It resets at ${new Date(resetSeconds * 1000).toISOString()} (in ${Math.max(1, Math.ceil((resetSeconds * 1000 - now) / 60_000))} minutes).`;

export interface GithubReaderOptions {
  readonly fetch: GithubFetch;
  readonly access: ReadAccess;
  readonly now?: () => number;
  /** The whole request's end: a read after it is refused, so a request that runs out stores nothing. */
  readonly deadline?: number;
}

/** A `RepoReader` over GitHub's REST API with `access`. */
export const githubReader = (options: GithubReaderOptions): RepoReader => {
  const { access } = options;
  const now = options.now ?? (() => Date.now());
  let checkedAtStart = false;
  /** Before the request's first read (a commit, or an install's tree): the commit and the tree. */
  const atStart = async () => {
    if (checkedAtStart) return;
    checkedAtStart = true;
    await ensureLeft(2);
  };

  const ask = async (path: string, accept: string): Promise<Response> => {
    if (options.deadline !== undefined && now() > options.deadline) {
      throw new GithubReadError("failed", "GitHub took too long: the request stopped after 60 seconds and kept nothing. Try again, or install fewer skills at a time.");
    }
    const headers = new Headers({ accept, "x-github-api-version": "2022-11-28", "user-agent": "t3flare" });
    if (access.token !== undefined) headers.set("authorization", `Bearer ${access.token}`);
    try {
      return await options.fetch(`${API}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      throw new GithubReadError("failed", `GitHub could not be reached: ${messageOf(cause)}`);
    }
  };

  /** The unauthenticated limit has `needed` requests left, or a refusal naming the reset and the way out. */
  const ensureLeft = async (needed: number): Promise<void> => {
    if (access.how !== "unauthenticated") return;
    const response = await ask("/rate_limit", "application/vnd.github+json");
    const body = (await response.json().catch(() => null)) as { resources?: { core?: { remaining?: number; limit?: number; reset?: number } } } | null;
    const core = body?.resources?.core;
    if (core?.remaining === undefined) return;
    if (core.remaining < needed) {
      throw new GithubReadError(
        "rate_limited",
        `GitHub's unauthenticated limit for this Worker (${core.limit ?? 60} an hour, shared with others on its address) has ${core.remaining} requests left, and this needs ${needed}.${whenOf(core.reset, now())} ${UNAUTHENTICATED_WAY_OUT}`,
      );
    }
  };

  const refusalOf = async (repo: SkillRepo, response: Response, notFound: string): Promise<GithubReadError> => {
    const said = ((await response.json().catch(() => null)) as { message?: unknown } | null)?.message;
    const saying = typeof said === "string" ? `: ${said}` : "";
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if ((response.status === 403 || response.status === 429) && Number.isFinite(retryAfter) && retryAfter > 0) {
      return new GithubReadError("rate_limited", `GitHub asked t3flare to slow down: try again in ${Math.ceil(retryAfter)} seconds. Nothing was kept.`);
    }
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      const whose =
        access.how === "unauthenticated" ? "GitHub's unauthenticated limit for this Worker (60 an hour, shared with others on its address)" : "The GitHub App installation's GitHub rate limit";
      return new GithubReadError(
        "rate_limited",
        `${whose} is used up.${whenOf(Number.isFinite(reset) && reset > 0 ? reset : undefined, now())}${access.how === "unauthenticated" ? ` ${UNAUTHENTICATED_WAY_OUT}` : ""}`,
      );
    }
    if (response.status === 404 || response.status === 422) return new GithubReadError("not_found", notFound);
    if (response.status === 401 || response.status === 403) {
      return new GithubReadError("refused", `GitHub refused the read of ${repo.owner}/${repo.name} (${response.status}${saying}). Check the GitHub App's installation on ${repo.owner}.`);
    }
    return new GithubReadError("failed", `GitHub answered ${response.status}${saying}`);
  };

  /** What a 404 says, by what is known of the App on the repo's owner (cloudpid's two variants). */
  const gone = (repo: SkillRepo): string =>
    access.ownerInstalled
      ? `GitHub has no repo ${repo.owner}/${repo.name}, or the GitHub App's installation on ${repo.owner} does not include it (install it on all repositories).`
      : `GitHub has no repo ${repo.owner}/${repo.name}, or it is private and the GitHub App is not installed on ${repo.owner} (install it there, on all repositories).`;

  const read = async (repo: SkillRepo, path: string, accept: string, notFound = gone(repo)): Promise<Response> => {
    const response = await ask(`${repoPath(repo)}${path}`, accept);
    if (response.ok) return response;
    throw await refusalOf(repo, response, notFound);
  };

  return {
    commit: async (repo, ref) => {
      await atStart();
      const response = await read(repo, `/commits/${ref === null ? "HEAD" : refPath(ref)}`, "application/vnd.github.sha", ref === null ? gone(repo) : `${gone(repo)} Or it has no ref ${JSON.stringify(ref)} (a branch, a tag or a commit).`);
      const sha = (await response.text()).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new GithubReadError("failed", "GitHub's answer to the commit was not a SHA");
      return sha;
    },
    tree: async (repo, commit): Promise<RepoTree> => {
      await atStart();
      const response = await read(repo, `/git/trees/${segment(commit)}?recursive=1`, "application/vnd.github+json");
      const body = (await response.json().catch(() => null)) as { truncated?: unknown; tree?: unknown } | null;
      if (body === null || typeof body.truncated !== "boolean" || !Array.isArray(body.tree)) throw new GithubReadError("failed", "GitHub's answer to the tree was not a tree");
      const entries = (body.tree as Array<Record<string, unknown>>).flatMap((entry): Array<TreeEntry> =>
        typeof entry.path === "string" && typeof entry.sha === "string" && (entry.type === "blob" || entry.type === "tree" || entry.type === "commit")
          ? [{ path: entry.path, type: entry.type, sha: entry.sha, size: typeof entry.size === "number" ? entry.size : undefined, mode: typeof entry.mode === "string" ? entry.mode : undefined }]
          : [],
      );
      return { truncated: body.truncated, entries };
    },
    blob: async (repo, sha) => new Uint8Array(await (await read(repo, `/git/blobs/${segment(sha)}`, "application/vnd.github.raw+json")).arrayBuffer()),
    beforeBlobs: (reads) => ensureLeft(reads),
  };
};
