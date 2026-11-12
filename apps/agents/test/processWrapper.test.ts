// A CLI process's launcher (step 4a; apps/sandbox-image/src/process.ts) on a real bash: in an Ubuntu container (the
// image's base) with Docker, skipped without Docker. The CLI's stdout carries only the CLI's bytes; the home is fresh,
// its files and links made; t3's path resolves to the repo; core dumps are off; old homes and old sessions go.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { processCommand } from "@t3flare/sandbox-image/process";
import { describe, expect, it } from "vitest";

const IMAGE = "ubuntu:26.04";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;

describe.skipIf(!docker)("the CLI process launcher", () => {
  it("leaves stdout to the CLI, builds the home fresh, and resolves t3's path to the repo", () => {
    const launcher = processCommand({
      marker: "proc-test1",
      t3Path: "/w/demo",
      cwd: "/w/demo/sub",
      argv: ["/bin/bash", "-c", 'echo "cwd=$(pwd -P) core=$(ulimit -c) cfg=$(cat /var/lib/t3flare/cli/proc-test1/cfg.toml) link=$(readlink /var/lib/t3flare/cli/proc-test1/sessions) stale=$(ls /var/lib/t3flare/cli | tr "\\n" ,) old=$(ls /workspace/.t3flare/pi/sessions | tr "\\n" ,)"'],
      files: [{ path: "/var/lib/t3flare/cli/proc-test1/cfg.toml", text: "a = \"it's\"\n" }],
      links: [{ path: "/var/lib/t3flare/cli/proc-test1/sessions", target: "/workspace/.t3flare/codex/sessions" }],
      prune: [{ dir: "/workspace/.t3flare/pi/sessions", days: 60 }],
    });
    const script = `set -u
mkdir -p /workspace/repo/sub /var/lib/t3flare/cli/proc-gone /workspace/.t3flare/pi/sessions
touch -d '90 days ago' /workspace/.t3flare/pi/sessions/old.jsonl
touch /workspace/.t3flare/pi/sessions/new.jsonl
cat > /tmp/launcher.sh <<'T3FLARE_EOF'
${launcher}
T3FLARE_EOF
T3FLARE_EXEC=proc-test1 bash /tmp/launcher.sh 2>/tmp/err
echo "exit=$?"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], { input: script, encoding: "utf8", timeout: 120_000 });
    expect(result.stdout.trim().split("\n")).toEqual([
      "cwd=/workspace/repo/sub core=0 cfg=a = \"it's\" link=/workspace/.t3flare/codex/sessions stale=proc-test1, old=new.jsonl,",
      "exit=0",
    ]);
  }, 180_000);

  it("refuses a file outside the process's home and the synced harness directory", () => {
    expect(() => processCommand({ marker: "proc-x", t3Path: "/w/d", cwd: "/w/d", argv: ["/bin/true"], files: [{ path: "/root/.bashrc", text: "x" }] })).toThrow(/may not write/);
    expect(() => processCommand({ marker: "proc-x", t3Path: "/w/d", cwd: "/w/d", argv: ["/bin/true"], files: [{ path: "/workspace/.t3flare/../repo/x", text: "x" }] })).toThrow(/may not write/);
    expect(() => processCommand({ marker: "term-x", t3Path: "/w/d", cwd: "/w/d", argv: ["/bin/true"] })).toThrow(/marker/);
  });
});
