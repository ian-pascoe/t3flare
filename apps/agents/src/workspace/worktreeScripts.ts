// The scripts that make a worktree Workspace (step 2b, plan section 3.2), kept pure so Node tests run them on real git:
// a clone without checkout in the worktree's Container (its tips answered), a bundle of what that clone lacks in the
// project's Container, and the checkout in the worktree's. Paths are parameters (the DO passes `/workspace/repo`).
import { shellWord } from "./checkpointScripts.ts";

const isObjectId = (value: string) => /^[0-9a-f]{40,64}$/.test(value);

/** In the worktree's Container: a fresh repo (clone without checkout, or `git init` with no remote); prints `TIPS` then its tips. */
export const worktreeCloneScript = (input: {
  readonly repo: string;
  readonly url: string | null;
  readonly helper: string;
  readonly name: string;
  readonly email: string;
}): string =>
  [
    "set -eu",
    // Provisioning starts from nothing: a failed earlier attempt left at most a partial clone.
    `rm -rf ${shellWord(input.repo)}`,
    input.url === null
      ? `git init -q ${shellWord(input.repo)}`
      : `git -c credential.helper= -c ${shellWord(`credential.helper=${input.helper}`)} clone --no-checkout --quiet -- ${shellWord(input.url)} ${shellWord(input.repo)}`,
    `cd ${shellWord(input.repo)}`,
    `git config credential.helper ${shellWord(input.helper)}`,
    `git config user.name ${shellWord(input.name)}`,
    `git config user.email ${shellWord(input.email)}`,
    "echo TIPS",
    "git for-each-ref --format='%(objectname)' | sort -u",
  ].join("\n");

export const parseTips = (stdout: string): ReadonlyArray<string> =>
  stdout
    .slice(stdout.indexOf("TIPS") + 4)
    .split("\n")
    .map((line) => line.trim())
    .filter(isObjectId);

/**
 * In the project's Container: `ref`'s commit, and a bundle of what the new clone lacks: `ref` without the clone's
 * actual tips that this repo has (review F7: not `--not --remotes`, which trusts stale remote-tracking refs), else the
 * whole of `ref`. No bundle when one of the clone's tips already reaches the commit. Prints `COMMIT`, `BUNDLE` and
 * `ref`'s `branch.<ref>.*` config as `CONFIG` lines.
 */
export const worktreeBundleScript = (input: { readonly ref: string; readonly tips: ReadonlyArray<string>; readonly bundle: string }): string => {
  const bundle = shellWord(input.bundle);
  return [
    "set -u",
    `ref=${shellWord(input.ref)}`,
    `commit=$(git rev-parse --verify --quiet "$ref^{commit}") || { echo "fatal: invalid reference: $ref" >&2; exit 128; }`,
    `mkdir -p "$(dirname ${bundle})" && rm -f ${bundle}`,
    `tips=${shellWord(input.tips.filter(isObjectId).join(" "))}`,
    `exclude=""`,
    `for tip in $tips; do git cat-file -e "$tip^{commit}" 2>/dev/null && exclude="$exclude ^$tip"; done`,
    `full=$(git rev-parse --verify --quiet "refs/heads/$ref" >/dev/null && echo "refs/heads/$ref" || echo "$commit")`,
    `have=0; for tip in $tips; do git merge-base --is-ancestor "$commit" "$tip" 2>/dev/null && have=1 && break; done`,
    `if [ $have = 0 ]; then git bundle create --quiet ${bundle} "$full" $exclude 2>/dev/null || git bundle create --quiet ${bundle} "$full" >&2 || exit 128; fi`,
    `echo "COMMIT $commit"`,
    `[ -f ${bundle} ] && echo "BUNDLE"`,
    `git config --get-regexp "^branch\\.$(printf '%s' "$ref" | sed 's/[.[\\*^$]/\\\\&/g')\\." | sed 's/^/CONFIG /'`,
    "exit 0",
  ].join("\n");
};

export const parseBundleAnswer = (stdout: string): { readonly commit: string | null; readonly bundled: boolean; readonly config: ReadonlyArray<string> } => {
  const lines = stdout.split("\n");
  const commit = lines.find((line) => line.startsWith("COMMIT "))?.slice(7).trim() ?? null;
  return {
    commit: commit !== null && isObjectId(commit) ? commit : null,
    bundled: lines.includes("BUNDLE"),
    config: lines.filter((line) => line.startsWith("CONFIG ")).map((line) => line.slice(7)),
  };
};

/** In the worktree's Container: fetch the bundle (when there is one), check `ref` out at `commit`, copy the branch config; prints HEAD. */
export const worktreeFinishScript = (input: {
  readonly bundle: string | null;
  readonly ref: string;
  readonly commit: string;
  readonly config: ReadonlyArray<string>;
}): string => {
  if (!isObjectId(input.commit)) throw new Error(`t3flare: not a commit: ${input.commit}`);
  const config = input.config.flatMap((line) => {
    const at = line.indexOf(" ");
    return at > 0 && line.startsWith("branch.") ? [`git config ${shellWord(line.slice(0, at))} ${shellWord(line.slice(at + 1))}`] : [];
  });
  return [
    "set -eu",
    ...(input.bundle === null ? [] : [`git fetch --quiet ${shellWord(input.bundle)} '+refs/*:refs/t3flare/seed/*' 2>/dev/null || git fetch --quiet ${shellWord(input.bundle)} ${input.commit}`, `rm -f ${shellWord(input.bundle)}`]),
    `git checkout --quiet -B ${shellWord(input.ref)} ${input.commit}`,
    `git for-each-ref --format='%(refname)' refs/t3flare/seed | while read -r seed; do git update-ref -d "$seed"; done`,
    ...config,
    "git rev-parse HEAD",
  ].join("\n");
};
