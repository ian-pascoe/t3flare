// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4a M0's stage probes (plan §8 M0, with the review's P12 and P8 gate), through the admin routes.
//
//   bun scripts/stage.ts run step4a probe4a workspace            clone the fixture project (once); prints its Workspace id
//   bun scripts/stage.ts run step4a probe4a p1 --workspace <id> [--minutes 35] [--gap 10]
//       a long-lived non-PTY exec: stdin echoed to stdout and stderr, written at each gap, silent between, an exit code
//   bun scripts/stage.ts run step4a probe4a p1-abort --workspace <id>
//       a process, then the Workspace DO aborted: does the process outlive the object, and does the new one know it
//   bun scripts/stage.ts run step4a probe4a p2 --workspace <id>   bwrap and user namespaces in the Container
//   bun scripts/stage.ts run step4a probe4a p8 --workspace <id>   SQLite on computer's FUSE mount; rollouts of 5, 20,
//       50 MB appended in the synced dir and pulled (the DO's CPU and rows per pull, from the agents Worker's logs)
import { admin, pair, sleep } from "./lib/client.ts";
import { ensureCloudFixtureProject } from "./lib/fixtureProject.ts";
import * as path from "node:path";

import { writeEvidence as writeAt } from "./lib/evidence.ts";

const writeEvidence = (name: string, value: unknown) => writeAt(path.resolve(import.meta.dirname, "../../../docs/steps/step-4a", name), value);

const [scenario = "workspace", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const workspace = arg("workspace") ?? "step3-fixture";
const call = async (body: unknown) => (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, body)).json;
const probe = (op: unknown) => call({ probeProcess: op });
const exec = async (script: string, timeoutMs = 120_000) => (await call({ exec: { script, timeoutMs } }))?.result;

switch (scenario) {
  case "workspace": {
    const cookie = await pair();
    console.log(JSON.stringify(await ensureCloudFixtureProject(cookie)));
    break;
  }
  case "p1": {
    const minutes = Number(arg("minutes") ?? 35);
    const gap = Number(arg("gap") ?? 10);
    const key = `p1-${Date.now()}`;
    const script = 'while IFS= read -r l; do echo "out:$l"; echo "err:$l" >&2; [ "$l" = exit ] && exit 7; done; exit 3';
    const started = Date.now();
    console.log(JSON.stringify(await probe({ op: "start", key, argv: ["bash", "-c", script] })));
    const writes: Array<{ at: number; text: string }> = [];
    const write = async (text: string) => {
      writes.push({ at: Date.now() - started, text });
      return probe({ op: "write", key, text: `${text}\n` });
    };
    await write("hello");
    for (let at = gap; at < minutes; at += gap) {
      await sleep(gap * 60_000);
      console.log(JSON.stringify({ minute: at, write: await write(`ping-${at}`) }));
    }
    await sleep(Math.max(0, minutes * 60_000 - (Date.now() - started)));
    await write("exit");
    await sleep(3000);
    const state = await probe({ op: "state", key });
    const result = { scenario, minutes, gap, writes, state: state?.result, epoch: state?.epoch, ps: (await probe({ op: "ps" }))?.stdout };
    writeEvidence("m0-p1.json", result);
    console.log(JSON.stringify(result).slice(0, 3000));
    break;
  }
  case "p1-abort": {
    const key = `p1a-${Date.now()}`;
    const marker = `T3FLARE_PROBE=${key}`;
    const before = await probe({ op: "start", key, argv: ["bash", "-c", "while IFS= read -r l; do echo \"out:$l\"; done"], env: { T3FLARE_PROBE: key } });
    await probe({ op: "write", key, text: "one\n" });
    await sleep(1000);
    const aborting = await probe({ op: "abort" });
    await sleep(3000);
    const after = await probe({ op: "state", key });
    const alive = await exec(`grep -l -a '${marker}' /proc/[0-9]*/environ 2>/dev/null | wc -l`);
    const container = await admin("GET", "/_t3flare/agents/workspaces");
    const result = { scenario, before, aborting, afterState: after, processesWithMarker: Number(String(alive?.stdout ?? "").trim()), workspaces: container.json };
    writeEvidence("m0-p1-abort.json", result);
    console.log(JSON.stringify(result).slice(0, 3000));
    break;
  }
  case "p2": {
    const result = await exec(
      [
        "echo kernel=$(uname -r)",
        "echo userns_max=$(cat /proc/sys/user/max_user_namespaces 2>&1)",
        "echo unpriv_userns=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>&1)",
        "echo apparmor_restrict=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>&1)",
        "id",
        "bwrap --unshare-all --ro-bind / / true && echo bwrap-unshare-all=ok || echo bwrap-unshare-all=fail",
        "bwrap --unshare-user --ro-bind / / true && echo bwrap-userns=ok || echo bwrap-userns=fail",
        "bwrap --unshare-net --ro-bind / / true && echo bwrap-netns=ok || echo bwrap-netns=fail",
        "unshare -U true && echo unshare-U=ok || echo unshare-U=fail",
        "grep -E 'Seccomp|NoNewPrivs|CapEff' /proc/self/status",
        "cat /sys/kernel/security/lsm 2>/dev/null",
      ].join("\n"),
    );
    writeEvidence("m0-p2.json", { scenario, result });
    console.log(JSON.stringify(result, null, 1));
    break;
  }
  case "p8": {
    // SQLite on the FUSE mount, then rollouts grown in the synced dir, each followed by the Workspace's pull (an exec
    // of `true` ends with computer's sync; the pull's work shows in the agents Worker's CPU time and rows).
    const sqlite = await exec(
      [
        "set -e",
        "d=/workspace/.t3flare/probe-p8 && mkdir -p $d && cd $d",
        "rm -f s.db* && sqlite3 s.db 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);' && echo wal=ok || echo wal=fail",
        "sqlite3 s.db 'SELECT count(*) FROM t;' && echo read=ok",
        "rm -f j.db && sqlite3 j.db 'PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES (1);' && echo delete=ok || echo delete=fail",
      ].join("\n"),
    );
    const sizes = (arg("sizes") ?? "5,20,50").split(",").map(Number);
    const pulls: Array<unknown> = [];
    for (const mb of sizes) {
      const started = Date.now();
      // A rollout-like file: JSON lines of ~2 KiB each, appended in 1 MB steps (a growing file between pulls).
      const grow = await exec(
        [
          "d=/workspace/.t3flare/probe-p8 && mkdir -p $d && f=$d/rollout-" + mb + ".jsonl && : > $f",
          `line=$(head -c 1500 /dev/urandom | base64 -w0)`,
          `for i in $(seq 1 ${mb}); do for j in $(seq 1 500); do printf '{"type":"event","i":%d,"payload":"%s"}\\n' $i "$line"; done >> $f; done`,
          "ls -l $f | awk '{print $5}'",
        ].join("\n"),
        600_000,
      );
      const pulled = await exec("true", 600_000);
      pulls.push({ mb, bytes: String(grow?.stdout ?? "").trim(), growMs: grow?.ms, pullAndExecMs: pulled?.ms, totalMs: Date.now() - started });
      console.log(JSON.stringify(pulls.at(-1)));
    }
    const result = { scenario, sqlite, pulls, note: "DO CPU and rows per pull: read from the agents Worker's telemetry for this window" };
    writeEvidence("m0-p8.json", result);
    console.log(JSON.stringify(result, null, 1).slice(0, 4000));
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
