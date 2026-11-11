// A terminal's shell in the Container (step 2b, ADR-0021). No Node imports, so the agents Worker can import it: the
// Workspace DO runs `terminalCommand(…)` with `bash -c` under the platform's PTY exec, so it ships with the Worker's code
// rather than in the image, as the kill script does.
//
// The wrapper makes t3's path of the Workspace (`/w/<id>`) the repo itself (a bind mount, else a symlink), links a
// worktree's project-root view at the project's path, writes the rc file, `cd`s to t3's cwd and becomes an interactive
// bash. The rc file activates mise as the agent's commands do, keeps the history in the synced harness directory, and
// prints two markers the Workspace DO strips from the output (review F1):
//
// - `BUSY` from `PS0`: bash read a command and runs it (the foreground is not the prompt);
// - `PROMPT` from `PROMPT_COMMAND`: the prompt is back (nothing runs in the foreground).
//
// The DO answers t3's subprocess inspector from them, pulls the Container's files when a prompt returns, and holds the
// input typed before the first prompt.

/** An OSC sequence no program prints: `ESC ] 6973 ; <b|p> BEL`. */
export const MARK_PREFIX = "\x1b]6973;";
export const MARK_BUSY = `${MARK_PREFIX}b\x07`;
export const MARK_PROMPT = `${MARK_PREFIX}p\x07`;

/** Where a terminal's bash history is kept: synced, so it outlives the Container. */
export const TERMINAL_HISTORY = "/workspace/.t3flare/terminal/history";

/** The marker's id grammar is the kill script's (`[A-Za-z0-9-]+`). */
export const isTerminalMarker = (value: string): boolean => /^term-[A-Za-z0-9-]{1,80}$/.test(value);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface TerminalCommandInput {
  /** `term-<key>`: the shell's `T3FLARE_EXEC`, inherited by everything it starts (part 2's kill script). */
  readonly marker: string;
  /** t3's path of the Workspace's repo, `/w/<id>`. */
  readonly t3Path: string;
  /** t3's cwd (at or below `t3Path`); the repo root when it does not exist. */
  readonly cwd: string;
  /** A worktree's project-root view: `/w/<project>` linked to this directory in the Container. */
  readonly projectRoot?: { readonly t3Path: string; readonly view: string };
}

/** The rc file: no `BASH_ENV`, mise, history, a short prompt and the two markers. */
export const terminalRc = (): string =>
  [
    "unset BASH_ENV",
    "[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc",
    'command -v mise >/dev/null 2>&1 && eval "$(mise activate bash)"',
    `HISTFILE=${TERMINAL_HISTORY}`,
    "HISTSIZE=5000",
    "HISTFILESIZE=20000",
    "shopt -s histappend",
    "PS1='\\[\\e[1;34m\\]\\w\\[\\e[0m\\] \\$ '",
    `PS0=$'\\e]6973;b\\a'`,
    `__t3flare_prompt() { local s=$?; printf '\\e]6973;p\\a'; history -a; return $s; }`,
    'PROMPT_COMMAND="__t3flare_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
  ].join("\n");

/** The wrapper `bash -c` runs; it ends by becoming the terminal's interactive bash. */
export const terminalCommand = (input: TerminalCommandInput): string => {
  if (!isTerminalMarker(input.marker)) throw new Error(`t3flare: bad terminal marker ${input.marker}`);
  const link = (target: string, source: string) =>
    [
      `if ! mountpoint -q ${quote(target)} 2>/dev/null && [ ! -L ${quote(target)} ]; then`,
      `  mkdir -p ${quote(target)} && mount --bind ${quote(source)} ${quote(target)} 2>/dev/null ||`,
      `  { rmdir ${quote(target)} 2>/dev/null; mkdir -p "$(dirname ${quote(target)})"; ln -sfn ${quote(source)} ${quote(target)}; }`,
      "fi",
    ].join("\n");
  const rc = `/tmp/t3flare-rc-${input.marker}`;
  return [
    "set -u",
    `mkdir -p "$(dirname ${TERMINAL_HISTORY})"`,
    link(input.t3Path, "/workspace/repo"),
    ...(input.projectRoot === undefined
      ? []
      : [
          `mkdir -p ${quote(input.projectRoot.view)}`,
          link(input.projectRoot.t3Path, input.projectRoot.view),
          // The first line says what the project-root view holds (plan section 4.2): its untracked files only.
          `files=$(cd ${quote(input.projectRoot.view)} && find . -type f | sed 's|^\\./||' | sort | head -8 | paste -sd ' ' -)`,
          `printf '\\033[2mt3flare: %s holds the project'"'"'s untracked files only (%s)\\033[0m\\r\\n' ${quote(input.projectRoot.t3Path)} "\${files:-none}"`,
        ]),
    `cat > ${rc} <<'T3FLARE_RC'`,
    terminalRc(),
    "T3FLARE_RC",
    `cd -- ${quote(input.cwd)} 2>/dev/null || cd -- ${quote(input.t3Path)}`,
    `exec bash --rcfile ${rc} -i`,
  ].join("\n");
};

export interface Scanned {
  /** The output with the markers removed. */
  readonly text: string;
  /** The foreground's state after the chunk, when a marker said. */
  readonly busy: boolean | undefined;
  /** How many prompts returned in the chunk. */
  readonly prompts: number;
  /** A marker cut by the chunk's end, kept for the next chunk. */
  readonly carry: string;
}

/** Splits a chunk of a terminal's output into its text and its markers. */
export const scanMarkers = (carry: string, chunk: string): Scanned => {
  let input = carry + chunk;
  let busy: boolean | undefined;
  let prompts = 0;
  let text = "";
  for (;;) {
    const at = input.indexOf(MARK_PREFIX);
    if (at === -1) break;
    text += input.slice(0, at);
    const rest = input.slice(at);
    if (rest.startsWith(MARK_BUSY)) busy = true;
    else if (rest.startsWith(MARK_PROMPT)) {
      busy = false;
      prompts++;
    } else if (rest.length < MARK_BUSY.length && (MARK_BUSY.startsWith(rest) || MARK_PROMPT.startsWith(rest))) {
      return { text, busy, prompts, carry: rest };
    } else {
      text += MARK_PREFIX;
      input = rest.slice(MARK_PREFIX.length);
      continue;
    }
    input = rest.slice(MARK_BUSY.length);
  }
  // A trailing partial prefix (`ESC`, `ESC ]`, …) waits for the next chunk.
  for (let n = Math.min(MARK_PREFIX.length - 1, input.length); n > 0; n--) {
    if (MARK_PREFIX.startsWith(input.slice(-n))) return { text: text + input.slice(0, -n), busy, prompts, carry: input.slice(-n) };
  }
  return { text: text + input, busy, prompts, carry: "" };
};
