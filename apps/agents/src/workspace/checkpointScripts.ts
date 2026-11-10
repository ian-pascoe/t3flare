// The checkpoint operations the Workspace DO hands to the Container's git (step 2a M3): a capture of a repo above the
// isomorphic-git guard, a restore, and the authored paths of a range where HEAD moved. Each is t3's own sequence from
// `GitVcsDriver.checkpoints` (t3code apps/server/src/vcs/GitVcsDriver.ts), reduced to what a Workspace repo needs (no
// sparse checkout, no Windows, no flagged index entries: the Workspace's repos are plain clones).

/** `value` as one single-quoted shell word. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const AUTHOR = [
  "GIT_AUTHOR_NAME='T3 Code'",
  "GIT_AUTHOR_EMAIL=t3code@users.noreply.github.com",
  "GIT_COMMITTER_NAME='T3 Code'",
  "GIT_COMMITTER_EMAIL=t3code@users.noreply.github.com",
].join(" ");

/** A fresh index from HEAD, `add -A`, `write-tree`, `commit-tree -p HEAD`, `update-ref` (captureCheckpoint). */
export const captureScript = (ref: string): string =>
  [
    "set -eu",
    'idx="$(git rev-parse --path-format=absolute --git-common-dir)/t3-checkpoint-index-$$"',
    'trap \'rm -f "$idx" "$idx.lock"\' EXIT',
    'if git rev-parse --verify -q HEAD >/dev/null; then parent="-p HEAD"; GIT_INDEX_FILE="$idx" git read-tree HEAD; else parent=""; fi',
    'GIT_INDEX_FILE="$idx" git -c core.safecrlf=false add -A -- .',
    'tree="$(GIT_INDEX_FILE="$idx" git write-tree)"',
    `commit="$(${AUTHOR} git commit-tree "$tree" $parent -m ${shellWord(`t3 checkpoint ref=${ref}`)})"`,
    `git update-ref ${shellWord(ref)} "$commit"`,
  ].join("\n");

/** `restore --source`, `clean -fd`, `reset` (restoreCheckpoint). */
export const restoreScript = (commit: string): string =>
  [
    "set -eu",
    `if [ -n "$(git ls-files --cached --with-tree=${commit} -z -- . | head -c 1)" ]; then git restore --source ${commit} --worktree --staged -- .; fi`,
    "for pass in 1 2 3 4; do out=\"$(LC_ALL=C git clean -fd -- .)\"; case \"$out\" in *Removing*) ;; *) break ;; esac; done",
    "git reset --quiet -- .",
  ].join("\n");

/** The four path lists of listAuthoredPaths, NUL-separated. */
export const authoredScript = (from: string, to: string, startHead: string, endHead: string): string => {
  const list = (args: string) => `git -c diff.relative=false -c log.showSignature=false ${args} --name-only -z --no-renames --no-ext-diff`;
  return [
    "set -eu",
    `captured="$(git log --no-walk --format=%ct ${from})"`,
    list(`diff ${startHead} ${from}`),
    list(`diff ${endHead} ${to}`),
    list(`log --format= --diff-merges=remerge ${endHead}..${startHead}`),
    list(`log --format= --diff-merges=remerge "--since=@$captured" ${startHead}..${endHead}`),
  ].join("\n");
};
