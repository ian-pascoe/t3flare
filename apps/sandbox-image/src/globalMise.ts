// The Global mise config's lay-down at a Container start (SPI-1150, ADR-0032's Global mise config refinement): the bash the Workspace DO runs on the
// Container through the platform's exec, under COMMAND_ENV, with the owner's text on stdin. No Node imports: the agents
// Worker imports it.
//
// It installs the owner's tools with the text as mise's global config (a staging file), keeps the file only when git
// and gh still run under it (an owner's file can otherwise break t3's git: invalid TOML fails every shim), and answers
// one JSON line. It is idempotent per Container disk: an answer for the same revision and text is printed again.
import { GLOBAL_MISE_CONFIG, GLOBAL_MISE_DIR } from "./env.ts";

/**
 * The script's own bounds, in seconds; the Workspace DO's deadline is derived from them (`GLOBAL_MISE_DEADLINE_MS`).
 * `timeout -k` sends TERM at the bound (exit 124) and KILL `…KillAfter` later (exit 137).
 */
export const GLOBAL_MISE_BOUNDS = {
  lock: 60,
  install: 600,
  installKillAfter: 10,
  check: 20,
  checkKillAfter: 5,
} as const;

/** How long the Workspace DO waits for the whole exec: every bound in the script, and a minute's margin. */
export const GLOBAL_MISE_DEADLINE_MS =
  (GLOBAL_MISE_BOUNDS.lock + GLOBAL_MISE_BOUNDS.install + GLOBAL_MISE_BOUNDS.installKillAfter + 2 * (GLOBAL_MISE_BOUNDS.check + GLOBAL_MISE_BOUNDS.checkKillAfter) + 60) * 1000;

/** Where an owner-pinned git gets the image's system gitconfig from (the credential helper, Dockerfile). */
export const SYSTEM_GITCONFIG = "/usr/local/share/t3flare/gitconfig";

/** The script's answer: its last line of stdout (`BASH_ENV`'s EXIT trap prints on stderr). */
export interface GlobalMiseAnswer {
  readonly revision: number;
  readonly sha256: string;
  readonly source: string;
  /** The owner's file is mise's global config now. */
  readonly laid: boolean;
  /** `mise install`'s exit, or null when it did not run (no text). */
  readonly install: number | null;
  /** The install or a check was cut off (124 after TERM, 137 after KILL). */
  readonly timedOut: boolean;
  /** Another lay-down held the lock past its bound: nothing was done. */
  readonly locked?: boolean;
  readonly ms: number;
  readonly bytes: number;
}

const b = GLOBAL_MISE_BOUNDS;

/** The checks run with mise's auto-installs off, so a shim never starts an install of its own. */
const check = (tool: "git" | "gh") =>
  `MISE_GLOBAL_CONFIG_FILE="$stage" MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_NOT_FOUND_AUTO_INSTALL=false timeout -k ${b.checkKillAfter} ${b.check} ${tool} --version > /dev/null 2>&1`;

/** The lay-down: `bash -c <this> t3flare-global-mise <revision> <sha256> <source>`, the text on stdin. */
export const GLOBAL_MISE_SCRIPT = `set -u
revision=$1 sha=$2 source=$3
dir=${GLOBAL_MISE_DIR} global=${GLOBAL_MISE_CONFIG}
mkdir -p "$dir" && cd / || exit 1
started=$(date +%s%N)
answer() {
  printf '{"revision":%s,"sha256":"%s","source":"%s","laid":%s,"install":%s,"timedOut":%s,"ms":%s,"bytes":%s%s}\\n' \\
    "$revision" "$sha" "$source" "$1" "$2" "$3" "$(( ($(date +%s%N) - started) / 1000000 ))" "$4" "\${5:-}"
}
# One lay-down at a time on this disk (two Workspace DO instances across a deploy).
exec 9> "$dir/.lock"
if ! flock -w ${b.lock} 9; then answer false null false 0 ',"locked":true'; exit 0; fi
# The same revision and text already laid down (or refused) on this disk: its answer again.
if [ -f "$dir/answer.json" ] && grep -q "\\"revision\\":$revision," "$dir/answer.json" && grep -q "\\"sha256\\":\\"$sha\\"" "$dir/answer.json"; then
  tail -n 1 "$dir/answer.json"; exit 0
fi
stage="$dir/config.$sha.$$.toml"
cat > "$stage"
bytes=$(wc -c < "$stage")
if [ "$bytes" -eq 0 ]; then
  rm -f "$stage" "$global"
  line=$(answer false null false 0)
else
  MISE_GLOBAL_CONFIG_FILE="$stage" timeout -k ${b.installKillAfter} ${b.install} mise install > "$dir/install.log" 2>&1
  install=$?
  timed=false
  case $install in 124|137) timed=true ;; esac
  laid=false
  ${check("git")}; git_rc=$?
  ${check("gh")}; gh_rc=$?
  for rc in $git_rc $gh_rc; do case $rc in 124|137) timed=true ;; esac; done
  if [ $git_rc = 0 ] && [ $gh_rc = 0 ] && mv -f "$stage" "$global"; then laid=true; fi
  rm -f "$stage"
  # A git the owner pinned is not the image's: it gets the image's system gitconfig (the credential helper), as the
  # Dockerfile gives the image's own.
  for git in "\${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/*/*/bin/git; do
    [ -x "$git" ] || continue
    prefix=$(dirname "$(dirname "$git")")
    grep -qs t3flare/git-credential "$prefix/etc/gitconfig" || { mkdir -p "$prefix/etc" && cp ${SYSTEM_GITCONFIG} "$prefix/etc/gitconfig"; }
  done
  line=$(answer $laid $install $timed "$bytes")
fi
printf '%s\\n' "$line" > "$dir/answer.json.$$" && mv -f "$dir/answer.json.$$" "$dir/answer.json"
printf '%s\\n' "$line"
`;

/** The argv the platform's exec runs; the text goes on stdin. */
export const globalMiseArgv = (revision: number, sha256: string, source: string): ReadonlyArray<string> => [
  "bash",
  "-c",
  GLOBAL_MISE_SCRIPT,
  "t3flare-global-mise",
  String(revision),
  sha256,
  source,
];

/** The answer from the script's stdout (its last line), or undefined when it is not one, field by field. */
export const parseGlobalMiseAnswer = (stdout: string): GlobalMiseAnswer | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const answer = value as Record<string, unknown>;
  const count = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field >= 0;
  const ok =
    count(answer.revision) &&
    typeof answer.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(answer.sha256) &&
    typeof answer.source === "string" &&
    answer.source.length <= 32 &&
    typeof answer.laid === "boolean" &&
    (answer.install === null || (typeof answer.install === "number" && Number.isInteger(answer.install))) &&
    typeof answer.timedOut === "boolean" &&
    (answer.locked === undefined || typeof answer.locked === "boolean") &&
    count(answer.ms) &&
    count(answer.bytes);
  if (!ok) return undefined;
  return {
    revision: answer.revision as number,
    sha256: answer.sha256 as string,
    source: answer.source as string,
    laid: answer.laid as boolean,
    install: answer.install as number | null,
    timedOut: answer.timedOut as boolean,
    ...(answer.locked === undefined ? {} : { locked: answer.locked as boolean }),
    ms: answer.ms as number,
    bytes: answer.bytes as number,
  };
};
