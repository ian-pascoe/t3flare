// The Container's listening TCP ports, for t3's port discovery (G11's M2, ADR-0031). No Node imports, so the agents
// Worker can import it: the Workspace DO runs it with the platform's exec (no PTY), only while the Container runs, as it
// runs the kill script (`kill.ts`). It ships with the Worker's code, not in the image.
//
// The scan is stock's Linux path (`PortScanner.ts`: `/proc/net/tcp{,6}` in state LISTEN, socket inodes to pids through
// `/proc/<pid>/fd`), plus what attributes a listener here: the process's `T3FLARE_EXEC` (a terminal's `term-<key>`, a CLI
// process's `proc-<uuid>`, a Durable agent command's exec id) and `T3CODE_THREAD_ID`. It runs in the image's Node, so
// every field is JSON-encoded by `JSON.stringify` (review M7: a `comm` or an environment value can hold anything), and
// each field is clipped. It prints one JSON object: the listeners, the process table (pid, ppid, pgid) and computerd's
// pid, for stock's `stoppableProcessGroup`.

export interface ScannedListener {
  readonly port: number;
  readonly host: string;
  readonly pid: number;
  readonly pgid: number;
  readonly comm: string;
  /** `T3FLARE_EXEC` of the process, or null. */
  readonly exec: string | null;
  /** `T3CODE_THREAD_ID` of the process, or null. */
  readonly thread: string | null;
}

export interface PortScan {
  readonly computerd: number | null;
  readonly listeners: ReadonlyArray<ScannedListener>;
  /** `[pid, ppid, pgid]` for every process. */
  readonly table: ReadonlyArray<readonly [number, number, number]>;
}

const NODE_SCRIPT = String.raw`
const fs = require("fs");
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
const hexHost = (hex) => {
  if (hex.length === 8) return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
  const words = [];
  for (let i = 0; i < 32; i += 8) {
    const word = hex.slice(i, i + 8).match(/../g).reverse().join("");
    words.push(word.slice(0, 4), word.slice(4, 8));
  }
  return words.map((w) => w.replace(/^0+(?=.)/, "")).join(":");
};
const sockets = new Map();
for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [hostHex, portHex] = f[1].split(":");
    sockets.set(f[9], { host: hexHost(hostHex), port: parseInt(portHex, 16) });
  }
}
const table = [];
const listeners = [];
let computerd = null;
for (const name of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  const pid = Number(name);
  let stat;
  try { stat = fs.readFileSync("/proc/" + name + "/stat", "utf8"); } catch { continue; }
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  table.push([pid, ppid, pgid]);
  let comm = "";
  try { comm = fs.readFileSync("/proc/" + name + "/comm", "utf8").trim(); } catch {}
  if (comm === "computerd" && computerd === null) computerd = pid;
  let fds = [];
  try { fds = fs.readdirSync("/proc/" + name + "/fd"); } catch { continue; }
  const owned = [];
  for (const fd of fds) {
    let link = "";
    try { link = fs.readlinkSync("/proc/" + name + "/fd/" + fd); } catch { continue; }
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (inode !== undefined && sockets.has(inode)) owned.push(sockets.get(inode));
  }
  if (owned.length === 0) continue;
  let exec = null;
  let thread = null;
  try {
    for (const pair of fs.readFileSync("/proc/" + name + "/environ", "utf8").split("\0")) {
      if (pair.startsWith("T3FLARE_EXEC=")) exec = pair.slice(13);
      else if (pair.startsWith("T3CODE_THREAD_ID=")) thread = pair.slice(17);
    }
  } catch {}
  for (const socket of owned) {
    listeners.push({ port: socket.port, host: socket.host, pid, pgid, comm: clip(comm, 64) ?? "", exec: clip(exec, 128), thread: clip(thread, 128) });
  }
}
process.stdout.write(JSON.stringify({ computerd, listeners, table }) + "\n");
`;

/** The argv the Workspace DO execs: the image's Node (mise's system install), running the scan. */
export const portsArgv = (): ReadonlyArray<string> => [
  "bash",
  "-c",
  'node=$(ls -d /usr/local/share/mise/installs/node/*/bin/node 2>/dev/null | tail -n 1); exec "${node:-node}" -e "$1"',
  "t3flare-ports",
  NODE_SCRIPT,
];

/** The script alone, for tests that run it under a local Node against a fake `/proc`. */
export const PORTS_NODE_SCRIPT = NODE_SCRIPT;

const STOP_SCRIPT = String.raw`
g=$1; shift; members="$*"
kill -s TERM -- "-$g" 2>/dev/null || { echo '{"signalled":false}'; exit 0; }
for _ in $(seq 1 30); do
  alive=0
  for p in $members; do
    read -r stat < "/proc/$p/stat" 2>/dev/null || continue
    rest=\${stat##*) }
    read -r _state _ppid pgrp _more <<< "$rest"
    [ "$pgrp" = "$g" ] && alive=1
  done
  [ $alive = 0 ] && { echo '{"signalled":true}'; exit 0; }
  sleep 0.1
done
kill -s KILL -- "-$g" 2>/dev/null
echo '{"signalled":true}'
`.replaceAll("\\${", "${");

/**
 * The argv that stops process group `pgid`: TERM, then KILL after 3 s if any of its members is still in it (stock's
 * `signalUntilStopped`). Prints `{"signalled":true|false}`; false when the group was already gone.
 */
export const stopGroupArgv = (pgid: number, members: ReadonlyArray<number>): ReadonlyArray<string> => {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const pids = members.filter((pid) => Number.isInteger(pid) && pid > 1).map(String);
  return ["bash", "-c", STOP_SCRIPT, "t3flare-stop", String(pgid), ...pids];
};

