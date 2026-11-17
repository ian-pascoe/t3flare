// Git and GitHub reads the trusted update jobs share (ADR-0037): `scripts/updates-ci.ts` and `scripts/land-check.ts`.
// Plain Node: no dependency.
import { spawnSync } from "node:child_process";

import { COMMIT, NIGHTLY_TAG, type Gate, PROVEN_CONTEXT, proofRunRefusal, provenDescription, provenStatus } from "../../apps/environment/src/updates/pins.ts";

/** `--name value` from `args` (every update script's one parser). */
export const optionOf =
  (args: ReadonlyArray<string>) =>
  (name: string): string | undefined =>
    args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;

/** This run's page. */
export const thisRunUrl = (): string => `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? ""}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;

export const git = (args: ReadonlyArray<string>, cwd?: string) => {
  const result = spawnSync("git", args, { ...(cwd === undefined ? {} : { cwd }), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim(), raw: result.stdout ?? "" };
};

/** `git ls-remote` lines as `[sha, ref]`. */
const lsRemote = (args: ReadonlyArray<string>): Array<[string, string]> =>
  git(["ls-remote", ...args])
    .out.split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t") as [string, string]);

/** Every nightly tag on `url` with its commit, peeled when annotated. */
export const nightlyTagsOf = (url: string): Map<string, string> => {
  const tags = new Map<string, string>();
  for (const [sha, ref] of lsRemote(["--tags", url, "v*-nightly.*"])) {
    const match = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
    if (match === null || !NIGHTLY_TAG.test(match[1]!) || !COMMIT.test(sha)) continue;
    if (match[2] !== undefined || !tags.has(match[1]!)) tags.set(match[1]!, sha);
  }
  return tags;
};

/** The commit `tag` names on `url`, peeled when annotated. */
export const tagCommitOf = (url: string, tag: string): string | undefined => {
  const lines = lsRemote([url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  return (lines.find(([, name]) => name.endsWith("^{}")) ?? lines[0])?.[0];
};

/** The tip of `branch` on origin, if it exists. */
export const branchTipOf = (branch: string): string | undefined => lsRemote(["--heads", "origin", `refs/heads/${branch}`])[0]?.[0];

/** The `bump/*` branches on origin. */
export const bumpBranches = (): ReadonlyArray<string> => lsRemote(["--heads", "origin", "refs/heads/bump/*"]).map(([, ref]) => ref.replace(/^refs\/heads\//, ""));

const api = async (method: string, pathname: string, body?: unknown): Promise<unknown> => {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const response = await fetch(`https://api.github.com/repos/${repository}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "t3flare-ci", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${method} ${pathname} with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
};

/**
 * The gate `sha` is proven through (review A1, B1): its newest `t3flare/proven` status, set by GitHub Actions, naming a
 * run of one of this repository's proving workflows on `main` (`proofRunRefusal`). Undefined with the reason otherwise.
 */
export const provenGateOf = async (sha: string): Promise<{ readonly gate: Gate } | { readonly gate: undefined; readonly reason: string }> => {
  const status = provenStatus((await api("GET", `/commits/${sha}/statuses?per_page=100`)) as Parameters<typeof provenStatus>[0]);
  if (status === undefined) return { gate: undefined, reason: `${sha} has no t3flare/proven status set by GitHub Actions` };
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (status.repository !== repository) return { gate: undefined, reason: `its proof names a run of ${status.repository}` };
  const refusal = proofRunRefusal((await api("GET", `/actions/runs/${status.runId}`)) as Parameters<typeof proofRunRefusal>[0], repository);
  return refusal === undefined ? { gate: status.gate } : { gate: undefined, reason: `its proof does not count: ${refusal}` };
};

/** Records that `sha` passed `gate` (the trusted publish job only). */
export const setProven = async (sha: string, gate: Gate): Promise<void> => {
  if (!COMMIT.test(sha)) throw new Error(`not a commit: ${sha}`);
  await api("POST", `/statuses/${sha}`, { state: "success", context: PROVEN_CONTEXT, description: provenDescription(gate), target_url: thisRunUrl() });
};
