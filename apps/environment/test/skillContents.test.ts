// How the Environment reads GitHub for Environment skills (SPI-1148, plan §3.2): which token it reads with, and how
// GitHub's answers are told, against a fake `fetch`. Every refusal is checked whole.
import { GitHubNotInstalled } from "@t3flare/github-app/app";
import { describe, expect, it } from "vitest";

import type { MintRequest } from "../src/agents/github.ts";
import { GithubReadError } from "../src/skills/fetch.ts";
import { githubReader, readAccessFor, type ReadAccess } from "../src/skills/contents.ts";

const minter = (installed: Record<string, ReadonlyArray<string>>) => {
  const asked: Array<MintRequest> = [];
  return {
    asked,
    mint: async (request: MintRequest) => {
      asked.push(request);
      const repos = installed[request.owner];
      if (repos === undefined) throw new GitHubNotInstalled(request.owner);
      if (!repos.includes(request.repositories[0]!)) throw new Error("GitHub refused the mint (422)");
      return { token: `token-${request.owner}/${request.repositories[0]}`, expiresAt: 0 };
    },
  };
};

describe("readAccessFor", () => {
  it("1: reads a repo the App is installed on with a token for that repo alone, contents and metadata read", async () => {
    const tokens = minter({ acme: ["private-skills"] });
    expect(await readAccessFor(tokens, [], { owner: "acme", name: "private-skills" })).toEqual({ token: "token-acme/private-skills", how: "repo", ownerInstalled: true });
    expect(tokens.asked).toEqual([{ owner: "acme", repositories: ["private-skills"], permissions: { contents: "read", metadata: "read" } }]);
  });

  it("2: reads a repo outside the installation with a token for the first installed repo that mints", async () => {
    const tokens = minter({ me: ["app"] });
    expect(await readAccessFor(tokens, [{ owner: "me", name: "gone" }, { owner: "me", name: "app" }], { owner: "mattpocock", name: "skills" })).toEqual({
      token: "token-me/app",
      how: "installation",
      ownerInstalled: false,
    });
    // The owner is installed, but not on this repo: the refusal's words say so.
    expect(await readAccessFor(tokens, [{ owner: "me", name: "app" }], { owner: "me", name: "other" })).toMatchObject({ how: "installation", ownerInstalled: true });
  });

  it("3: reads unauthenticated when no installed repo mints", async () => {
    expect(await readAccessFor(minter({}), [{ owner: "me", name: "app" }], { owner: "mattpocock", name: "skills" })).toEqual({ token: undefined, how: "unauthenticated", ownerInstalled: false });
  });
});

/** A fake GitHub answering by path, recording each request's path and whether it carried a token. */
const fakeFetch = (answers: Record<string, () => Response>) => {
  const seen: Array<{ readonly path: string; readonly token: boolean }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    seen.push({ path, token: new Headers(init.headers).has("authorization") });
    const answer = answers[path];
    if (answer === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    return answer();
  };
  return { fetch, seen };
};

const SHA = "a".repeat(40);
const installed: ReadAccess = { token: "t", how: "installation", ownerInstalled: false };
const unauthenticated: ReadAccess = { token: undefined, how: "unauthenticated", ownerInstalled: false };
const rateLimit = (remaining: number) => () => Response.json({ resources: { core: { limit: 60, remaining, reset: 1_794_615_811 } } });
const NOW = 1_794_615_811_000 - 20 * 60_000;
const repo = { owner: "o", name: "r" };

describe("githubReader", () => {
  it("reads a commit, a recursive tree with modes, and a blob, with the token", async () => {
    const github = fakeFetch({
      "/repos/o/r/commits/main": () => new Response(`${SHA}\n`),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () =>
        Response.json({ truncated: false, tree: [{ path: "s/SKILL.md", type: "blob", sha: "b1", size: 3, mode: "100644" }, { path: "s/l", type: "blob", sha: "b2", size: 1, mode: "120000" }] }),
      "/repos/o/r/git/blobs/b1": () => new Response("abc"),
    });
    const reader = githubReader({ fetch: github.fetch, access: installed });
    expect(await reader.commit(repo, "main")).toBe(SHA);
    expect(await reader.tree(repo, SHA)).toEqual({
      truncated: false,
      entries: [
        { path: "s/SKILL.md", type: "blob", sha: "b1", size: 3, mode: "100644" },
        { path: "s/l", type: "blob", sha: "b2", size: 1, mode: "120000" },
      ],
    });
    expect(new TextDecoder().decode(await reader.blob(repo, "b1"))).toBe("abc");
    expect(github.seen.every((request) => request.token)).toBe(true);
  });

  it("tells a repo it cannot read in cloudpid's two ways: private and not installed, or not in the installation", async () => {
    const github = fakeFetch({});
    await expect(githubReader({ fetch: github.fetch, access: installed }).commit({ owner: "acme", name: "x" }, null)).rejects.toThrow(
      "GitHub has no repo acme/x, or it is private and the GitHub App is not installed on acme (install it there, on all repositories).",
    );
    await expect(githubReader({ fetch: github.fetch, access: { ...installed, ownerInstalled: true } }).commit({ owner: "acme", name: "x" }, "v1")).rejects.toThrow(
      'GitHub has no repo acme/x, or the GitHub App\'s installation on acme does not include it (install it on all repositories). Or it has no ref "v1" (a branch, a tag or a commit).',
    );
  });

  it("refuses GitHub's request to slow down (a 403 or 429 with retry-after) plainly, naming the wait", async () => {
    for (const status of [403, 429]) {
      const github = fakeFetch({ "/repos/o/r/commits/HEAD": () => Response.json({ message: "You have exceeded a secondary rate limit" }, { status, headers: { "retry-after": "42" } }) });
      const refused = await githubReader({ fetch: github.fetch, access: installed })
        .commit(repo, null)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(GithubReadError);
      expect(refused).toMatchObject({ kind: "rate_limited", message: "GitHub asked t3flare to slow down: try again in 42 seconds. Nothing was kept." });
    }
  });

  it("tells a used-up limit with its reset, and the way out when reads are unauthenticated", async () => {
    const used = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794615811" } });
    await expect(githubReader({ fetch: fakeFetch({ [`/repos/o/r/git/blobs/b`]: used }).fetch, access: installed, now: () => NOW }).blob(repo, "b")).rejects.toThrow(
      "The GitHub App installation's GitHub rate limit is used up. It resets at 2026-11-14T00:23:31.000Z (in 20 minutes).",
    );
    await expect(githubReader({ fetch: fakeFetch({ [`/repos/o/r/git/blobs/b`]: used }).fetch, access: unauthenticated, now: () => NOW }).blob(repo, "b")).rejects.toThrow(
      "GitHub's unauthenticated limit for this Worker (60 an hour, shared with others on its address) is used up. It resets at 2026-11-14T00:23:31.000Z (in 20 minutes). Install the GitHub App on a repository and add it as a Project, so reads use the installation's own limit.",
    );
  });

  it("unauthenticated, reads /rate_limit before the first read and before the files, and refuses early", async () => {
    const github = fakeFetch({ "/rate_limit": rateLimit(1), "/repos/o/r/commits/HEAD": () => new Response(SHA) });
    const reader = githubReader({ fetch: github.fetch, access: unauthenticated, now: () => NOW });
    await expect(reader.commit(repo, null)).rejects.toThrow(
      "GitHub's unauthenticated limit for this Worker (60 an hour, shared with others on its address) has 1 requests left, and this needs 2. It resets at 2026-11-14T00:23:31.000Z (in 20 minutes). Install the GitHub App on a repository and add it as a Project, so reads use the installation's own limit.",
    );
    expect(github.seen.map((request) => request.path)).toEqual(["/rate_limit"]);
    const enough = fakeFetch({ "/rate_limit": rateLimit(5), "/repos/o/r/commits/HEAD": () => new Response(SHA) });
    const second = githubReader({ fetch: enough.fetch, access: unauthenticated, now: () => NOW });
    expect(await second.commit(repo, null)).toBe(SHA);
    await expect(second.beforeBlobs!(6)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(enough.seen.map((request) => request.path)).toEqual(["/rate_limit", "/repos/o/r/commits/HEAD", "/rate_limit"]);
    expect(enough.seen.some((request) => request.token)).toBe(false);
  });

  it("with a token, never asks /rate_limit", async () => {
    const github = fakeFetch({ "/repos/o/r/commits/HEAD": () => new Response(SHA) });
    const reader = githubReader({ fetch: github.fetch, access: installed });
    await reader.commit(repo, null);
    await reader.beforeBlobs!(400);
    expect(github.seen.map((request) => request.path)).toEqual(["/repos/o/r/commits/HEAD"]);
  });

  it("stops at the request's deadline, and refuses a `.` or `..` name before it reaches a URL", async () => {
    let now = 0;
    const github = fakeFetch({ "/repos/o/r/commits/HEAD": () => new Response(SHA) });
    const reader = githubReader({ fetch: github.fetch, access: installed, now: () => now, deadline: 60_000 });
    now = 60_001;
    await expect(reader.commit(repo, null)).rejects.toThrow("GitHub took too long: the request stopped after 60 seconds and kept nothing. Try again, or install fewer skills at a time.");
    await expect(githubReader({ fetch: github.fetch, access: installed }).commit({ owner: "o", name: ".." }, null)).rejects.toThrow('".." is not a name GitHub has');
    expect(github.seen).toEqual([]);
  });
});
