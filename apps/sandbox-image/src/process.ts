// A CLI agent's process in the Container (step 4a, the process channel). No Node imports, so the agents Worker can
// import it: the Workspace DO runs `processCommand(…)` with `PROCESS_SHELL -c` under the platform's non-PTY exec.
//
// The launcher writes nothing to stdout (it is the CLI's JSON-RPC stream): its own notes go to stderr. It
//
// - turns core dumps off (`ulimit -c 0`, review F3: a dump of a CLI holding the key would land on disk);
// - makes t3's path of the Workspace (`/w/<id>`) the repo itself (a bind mount, else a symlink), as terminals do, so the
//   CLI sees t3's own paths;
// - removes the homes of CLI processes that no longer run, then writes this process's home fresh on the Container's own
//   disk (review F2: nothing a CLI loads at start comes from the synced, agent-writable Workspace);
// - `cd`s to t3's cwd and becomes the CLI, leader of its own session (`setsid --wait`), so part 2's kill script takes
//   its whole tree by the marker.
//
// SPI-1209: it names every program it runs by its absolute path, as the Workspace DO names its shell
// (`PROCESS_SHELL`). The image puts mise's shims first on PATH and trusts /workspace's mise configuration, so a project
// could supply a `mkdir` or a `setsid`, which would get the process's model handle from this environment (or, as
// `setsid`, become its holder). setsid keeps its name in argv (`exec -a setsid`): the handle helpers and the holder
// lists find the holder by its command line, `setsid --wait <launcher> …`.

/** The shell the Workspace DO runs `processCommand`'s script with, by its absolute path (SPI-1209). */
export const PROCESS_SHELL = "/usr/bin/bash";

/** Where CLI homes live: the Container's own disk, never synced (not under /workspace). */
export const CLI_HOMES = "/var/lib/t3flare/cli";

/** `proc-<uuid>`: the kill script's id grammar (`[A-Za-z0-9-]+`). */
export const isProcessMarker = (value: string): boolean => /^proc-[A-Za-z0-9-]{1,80}$/.test(value);

/** A CLI process's home: `CLI_HOMES/<marker>`. */
export const cliHomeOf = (marker: string): string => `${CLI_HOMES}/${marker}`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export interface ProcessFile {
  /** Absolute; inside the process's home, or under `/workspace/.t3flare/` for the synced session directories. */
  readonly path: string;
  readonly text: string;
  readonly mode?: number;
}

export interface ProcessCommandInput {
  readonly marker: string;
  /** t3's path of the Workspace's repo, `/w/<id>`. */
  readonly t3Path: string;
  /** t3's cwd (at or below `t3Path`); the repo root when it does not exist. */
  readonly cwd: string;
  /** The binary (absolute) and its arguments. */
  readonly argv: ReadonlyArray<string>;
  /** Files written before the start (the CLI's home, its config). */
  readonly files?: ReadonlyArray<ProcessFile>;
  /** Symbolic links made before the start: `{ path, target }` (Codex's `sessions/` into the synced directory). */
  readonly links?: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  /** Session retention (review F2): files under `dir` (in the synced harness directory) untouched for `days` are removed. */
  readonly prune?: ReadonlyArray<{ readonly dir: string; readonly days: number }>;
}

/** Where a profile may write: the process's own home, or the synced harness directory (session directories only). */
const writable = (marker: string, path: string): boolean =>
  !path.includes("/../") && !path.endsWith("/..") && (path.startsWith(`${cliHomeOf(marker)}/`) || path.startsWith("/workspace/.t3flare/"));

/** The wrapper `bash -c` runs; it ends by becoming the CLI. */
export const processCommand = (input: ProcessCommandInput): string => {
  if (!isProcessMarker(input.marker)) throw new Error(`t3flare: bad process marker ${input.marker}`);
  if (input.argv.length === 0 || !input.argv[0]!.startsWith("/")) throw new Error("t3flare: a process's binary must be an absolute path");
  for (const file of [...(input.files ?? []), ...(input.links ?? []), ...(input.prune ?? []).map((entry) => ({ path: `${entry.dir}/x` }))]) {
    if (!writable(input.marker, file.path)) throw new Error(`t3flare: a process may not write ${file.path}`);
  }
  const home = cliHomeOf(input.marker);
  return [
    "set -u",
    "exec 3>&1 1>&2", // the launcher's own output goes to stderr; fd 3 is the CLI's stdout
    "ulimit -c 0",
    "unset BASH_ENV",
    `if ! /usr/bin/mountpoint -q ${quote(input.t3Path)} 2>/dev/null && [ ! -L ${quote(input.t3Path)} ]; then`,
    `  /usr/bin/mkdir -p ${quote(input.t3Path)} && /usr/bin/mount --bind /workspace/repo ${quote(input.t3Path)} 2>/dev/null ||`,
    `  { /usr/bin/rmdir ${quote(input.t3Path)} 2>/dev/null; /usr/bin/mkdir -p "$(/usr/bin/dirname ${quote(input.t3Path)})"; /usr/bin/ln -sfn /workspace/repo ${quote(input.t3Path)}; }`,
    "fi",
    // Homes of processes that no longer run (none carries their marker).
    `/usr/bin/mkdir -p ${CLI_HOMES} && for d in ${CLI_HOMES}/proc-*; do [ -d "$d" ] || continue; k=$(/usr/bin/basename "$d");`,
    `  /usr/bin/grep -lqa "T3FLARE_EXEC=$k" /proc/[0-9]*/environ 2>/dev/null || /usr/bin/rm -rf -- "$d"; done`,
    `/usr/bin/rm -rf -- ${quote(home)} && /usr/bin/mkdir -p -m 700 ${quote(home)}`,
    ...(input.files ?? []).flatMap((file) => [
      `/usr/bin/mkdir -p "$(/usr/bin/dirname ${quote(file.path)})"`,
      `printf %s ${quote(base64(file.text))} | /usr/bin/base64 -d > ${quote(file.path)}`,
      `/usr/bin/chmod ${(file.mode ?? 0o600).toString(8)} ${quote(file.path)}`,
    ]),
    ...(input.links ?? []).flatMap((link) => [`/usr/bin/mkdir -p ${quote(link.target)} "$(/usr/bin/dirname ${quote(link.path)})"`, `/usr/bin/ln -sfn ${quote(link.target)} ${quote(link.path)}`]),
    ...(input.prune ?? []).map((entry) => `[ -d ${quote(entry.dir)} ] && /usr/bin/find ${quote(entry.dir)} -type f -mtime +${Math.max(1, Math.floor(entry.days))} -delete 2>/dev/null`),
    `cd -- ${quote(input.cwd)} 2>/dev/null || cd -- ${quote(input.t3Path)}`,
    `exec 1>&3 3>&-`,
    `exec -a setsid /usr/bin/setsid --wait ${input.argv.map(quote).join(" ")}`,
  ].join("\n");
};
