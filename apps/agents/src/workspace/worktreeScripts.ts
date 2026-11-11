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

// ---------------------------------------------------------------------------------------------------------------------
// Removal (step 2b, plan section 3.3; review F8): carrying the worktree's work home to its project before a purge.

/**
 * In the worktree's Container: whether it has uncommitted work (`DIRTY`), and a bundle of every `refs/heads/*` and
 * `refs/stash` the project cannot reach (`CARRY <ref> <sha>` each, then `BUNDLE`), less the project's tips it has.
 */
export const carryOutScript = (input: { readonly projectTips: ReadonlyArray<string>; readonly bundle: string }): string => {
  const bundle = shellWord(input.bundle);
  return [
    "set -u",
    `mkdir -p "$(dirname ${bundle})" && rm -f ${bundle}`,
    `[ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null | head -c 4096)" ] && echo DIRTY`,
    `tips=${shellWord(input.projectTips.filter(isObjectId).join(" "))}`,
    `have=""; for t in $tips; do git cat-file -e "$t^{commit}" 2>/dev/null && have="$have $t"; done`,
    `refs=""`,
    `for r in $(git for-each-ref --format='%(refname)' refs/heads refs/stash); do`,
    `  reach=0; for t in $have; do git merge-base --is-ancestor "$r" "$t" 2>/dev/null && reach=1 && break; done`,
    `  if [ $reach = 0 ]; then refs="$refs $r"; echo "CARRY $r $(git rev-parse "$r")"; fi`,
    `done`,
    `exclude=""; for t in $have; do exclude="$exclude ^$t"; done`,
    `if [ -n "$refs" ]; then git bundle create --quiet ${bundle} $refs $exclude 2>/dev/null || git bundle create --quiet ${bundle} $refs >&2 || exit 128; echo BUNDLE; fi`,
    "exit 0",
  ].join("\n");
};

export const parseCarryOut = (stdout: string): { readonly dirty: boolean; readonly carried: ReadonlyArray<{ readonly ref: string; readonly sha: string }>; readonly bundled: boolean } => {
  const lines = stdout.split("\n");
  return {
    dirty: lines.includes("DIRTY"),
    carried: lines
      .filter((line) => line.startsWith("CARRY "))
      .map((line) => {
        const [, ref = "", sha = ""] = line.split(" ");
        return { ref, sha };
      })
      .filter((carry) => isObjectId(carry.sha)),
    bundled: lines.includes("BUNDLE"),
  };
};

/**
 * In the project's Container: fetch the carried refs from the bundle and give each a home. A branch the project lacks
 * is created; one it has fast-forwards when that is a fast-forward and it is not the project's checked-out branch;
 * anything else (a diverged branch, the stash) is kept at `refs/t3flare/worktrees/<dir>/…`. Prints one line per ref.
 */
export const carryInScript = (input: { readonly bundle: string; readonly dir: string; readonly carried: ReadonlyArray<{ readonly ref: string; readonly sha: string }> }): string => {
  const keep = (rest: string) => shellWord(`refs/t3flare/worktrees/${input.dir.replace(/[^A-Za-z0-9._-]/g, "_")}/${rest}`);
  return [
    "set -eu",
    `git fetch --quiet ${shellWord(input.bundle)} '+refs/*:refs/t3flare/carry/*'`,
    `cur=$(git symbolic-ref --quiet HEAD || true)`,
    ...input.carried.filter((carry) => isObjectId(carry.sha)).map((carry) => {
      if (!carry.ref.startsWith("refs/heads/")) return `git update-ref ${keep(carry.ref.replace(/^refs\//, ""))} ${carry.sha} && echo "KEPT ${carry.ref} ${keep(carry.ref.replace(/^refs\//, "")).slice(1, -1)}"`;
      const ref = shellWord(carry.ref);
      return [
        `if ! git show-ref --verify --quiet ${ref}; then git update-ref ${ref} ${carry.sha} && echo "CREATED ${carry.ref}";`,
        `elif [ ${ref} != "$cur" ] && git merge-base --is-ancestor ${ref} ${carry.sha}; then git update-ref ${ref} ${carry.sha} && echo "FASTFORWARD ${carry.ref}";`,
        `else git update-ref ${keep(carry.ref.replace(/^refs\//, ""))} ${carry.sha} && echo "KEPT ${carry.ref} ${keep(carry.ref.replace(/^refs\//, "")).slice(1, -1)}"; fi`,
      ].join(" ");
    }),
    `git for-each-ref --format='%(refname)' refs/t3flare/carry | while read -r r; do git update-ref -d "$r"; done`,
    `rm -f ${shellWord(input.bundle)}`,
  ].join("\n");
};
