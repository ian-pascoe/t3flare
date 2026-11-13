// @effect-diagnostics globalFetch:off globalDate:off
// SPI-1148's M0 probes (docs/steps/spi-1001-env-plan.md): what the stage Worker gets from GitHub unauthenticated and
// with a token scoped to one installed repo (R1), and an Environment skill set of a given size handed to a Workspace DO
// over one call. Admin-only (`POST /_t3flare/probe/env-skills`); answers statuses and rate-limit headers, never a token.
import { skillSetOf, type SkillSet } from "@t3flare/skills";

import type { GitHubTokens } from "../agents/github.ts";

const API = "https://api.github.com";
const RATE_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-used", "x-ratelimit-reset", "x-ratelimit-resource", "x-accepted-github-permissions", "x-github-api-version-selected"];

const headersOf = (response: Response): Record<string, string | null> => Object.fromEntries(RATE_HEADERS.map((name) => [name, response.headers.get(name)]));

const ask = async (path: string, token: string | undefined, accept = "application/vnd.github+json") => {
  const started = Date.now();
  const response = await fetch(`${API}${path}`, {
    headers: { accept, "user-agent": "t3flare-probe", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  });
  const text = await response.text();
  return { path, status: response.status, ms: Date.now() - started, headers: headersOf(response), text };
};

const brief = (answer: Awaited<ReturnType<typeof ask>>, body: (text: string) => unknown = (text) => text.slice(0, 200)) => ({
  path: answer.path,
  status: answer.status,
  ms: answer.ms,
  headers: answer.headers,
  body: body(answer.text),
});

const json = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** R1: unauthenticated, and with a `contents: read`, `metadata: read` token for `owner/repo` only, against `outside` (public, outside the installation) and `privateOutside` (private, outside the token's scope). */
export const probeGitHub = async (github: GitHubTokens, options: { readonly owner: string; readonly repo: string; readonly outside: string; readonly privateOutside: string }) => {
  const coreOf = (text: string) => json(text)?.resources?.core ?? null;
  const unauthLimit = await ask("/rate_limit", undefined);
  const unauthCommit = await ask(`/repos/${options.outside}/commits/HEAD`, undefined, "application/vnd.github.sha");
  const unauthPrivate = await ask(`/repos/${options.owner}/${options.repo}/commits/HEAD`, undefined, "application/vnd.github.sha");
  let scoped: Record<string, unknown>;
  try {
    const { token } = await github.mint({ owner: options.owner, repositories: [options.repo], permissions: { contents: "read", metadata: "read" } });
    const limit = await ask("/rate_limit", token);
    const commit = await ask(`/repos/${options.outside}/commits/HEAD`, token, "application/vnd.github.sha");
    const sha = commit.status === 200 ? commit.text.trim() : "HEAD";
    const tree = await ask(`/repos/${options.outside}/git/trees/${sha}?recursive=1`, token);
    const entries = (json(tree.text)?.tree ?? []) as Array<{ path: string; type: string; sha: string; size?: number }>;
    const skillMd = entries.find((entry) => entry.type === "blob" && entry.path.endsWith("SKILL.md"));
    const blob = skillMd === undefined ? undefined : await ask(`/repos/${options.outside}/git/blobs/${skillMd.sha}`, token, "application/vnd.github.raw+json");
    const own = await ask(`/repos/${options.owner}/${options.repo}/commits/HEAD`, token, "application/vnd.github.sha");
    const privateOutside = await ask(`/repos/${options.privateOutside}/commits/HEAD`, token, "application/vnd.github.sha");
    const after = await ask("/rate_limit", token);
    scoped = {
      rateLimit: brief(limit, coreOf),
      outsideCommit: brief(commit, (text) => (commit.status === 200 ? text.trim() : text.slice(0, 200))),
      outsideTree: brief(tree, (text) => ({ truncated: json(text)?.truncated ?? null, entries: entries.length, skillMd: entries.filter((entry) => entry.path.endsWith("SKILL.md")).length })),
      outsideBlob: blob === undefined ? null : brief(blob, (text) => ({ path: skillMd?.path, bytes: text.length, starts: text.slice(0, 40) })),
      ownRepoCommit: brief(own, (text) => (own.status === 200 ? text.trim() : text.slice(0, 200))),
      privateOutsideScope: brief(privateOutside),
      rateLimitAfter: brief(after, coreOf),
    };
  } catch (error) {
    scoped = { error: String(error).slice(0, 300) };
  }
  let privateMint: unknown;
  const [privateOwner = "", privateRepo = ""] = options.privateOutside.split("/");
  try {
    await github.mint({ owner: privateOwner, repositories: [privateRepo], permissions: { contents: "read", metadata: "read" } });
    privateMint = { minted: true };
  } catch (error) {
    privateMint = { minted: false, error: String(error).slice(0, 300) };
  }
  return {
    unauthenticated: {
      rateLimit: brief(unauthLimit, coreOf),
      outsideCommit: brief(unauthCommit, (text) => (unauthCommit.status === 200 ? text.trim() : text.slice(0, 200))),
      privateRepoCommit: brief(unauthPrivate),
    },
    scoped,
    privateOutsideMint: privateMint,
  };
};

/**
 * An Environment skill set of about `mib` MiB: skills of a `SKILL.md` and one ASCII data file each (at most 1.5 MiB a
 * file), and one `SKILL.md` with multi-byte text.
 */
export const probeSkillSet = async (mib: number): Promise<SkillSet> => {
  const files: Record<string, string> = {};
  const fileBytes = 1_536 * 1024 - 4096;
  let left = Math.round(mib * 1024 * 1024);
  for (let index = 0; left > 0; index++) {
    const name = `probe-${index}`;
    const head = `---\nname: ${name}\ndescription: M0 probe skill ${index}.\n---\n\nRead data.txt.\n`;
    files[`${name}/SKILL.md`] = head;
    left -= head.length;
    const size = Math.max(0, Math.min(fileBytes, left));
    if (size > 0) files[`${name}/data.txt`] = `${index}`.padEnd(size, "x");
    left -= size;
  }
  files["probe-utf8/SKILL.md"] = "---\nname: probe-utf8\ndescription: Multi-byte text, é ü 漢字.\n---\n\nPLUM-9 ✓\n";
  return skillSetOf(files);
};
