// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4a M0's stage probes (plan §8 M0, with the review's P12 and P8 gate), through the admin routes.
//
//   node scripts/stage.ts run step4a probe4a workspace            clone the fixture project (once); prints its Workspace id
//   (P1, a 35-minute non-PTY exec and the Workspace DO's abort, ran on M0's stage code, since replaced by the process
//    channel: docs/steps/step-4a/m0-p1.json, m0-p1-abort.json; the channel's own checks are scripts/cli4a.ts)
//   node scripts/stage.ts run step4a probe4a p2 --workspace <id>   bwrap and user namespaces in the Container
//   node scripts/stage.ts run step4a probe4a p8 --workspace <id>   SQLite on computer's FUSE mount; rollouts of 5, 20,
//       50 MB appended in the synced dir and pulled (the DO's CPU and rows per pull, from the agents Worker's logs)
import { admin, pair } from "./lib/client.ts";
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
const exec = async (script: string, timeoutMs = 120_000) => (await call({ exec: { script, timeoutMs } }))?.result;

switch (scenario) {
  case "workspace": {
    const cookie = await pair();
    console.log(JSON.stringify(await ensureCloudFixtureProject(cookie)));
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
