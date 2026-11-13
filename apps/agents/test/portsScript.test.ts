// G11's port scan and group stop (apps/sandbox-image/src/ports.ts) on real processes: each case runs in a Node container
// with Docker (the image's Node runs the scan), and is skipped without Docker or the image. The scripts go in on stdin.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { PORTS_NODE_SCRIPT, stopGroupArgv } from "@t3flare/sandbox-image/ports";
import { describe, expect, it } from "vitest";

const IMAGE = "node:24";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;

const run = (body: string) => {
  const stop = stopGroupArgv(2, [2])[2]!;
  const script = `mkdir -p /t && cat > /t/scan.js <<'T3FLARE_SCAN_EOF'
${PORTS_NODE_SCRIPT}
T3FLARE_SCAN_EOF
cat > /t/stop.sh <<'T3FLARE_STOP_EOF'
${stop}
T3FLARE_STOP_EOF
${body}`;
  const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash"], { input: script, encoding: "utf8", timeout: 60_000 });
  return result.stdout;
};

describe.skipIf(!docker)("the Container's port scan", () => {
  it("lists a listener with its markers, JSON-encoded whatever they hold, and stops its group", () => {
    const out = run(`T3FLARE_EXEC=term-abc T3CODE_THREAD_ID=$'th"1\\nx' setsid node -e 'require("http").createServer(() => {}).listen(5173, "0.0.0.0")' &
sleep 1
node /t/scan.js
pid=$(pgrep -f createServer | head -1); pg=$(ps -o pgid= -p "$pid" | tr -d ' ')
bash /t/stop.sh "$pg" "$pid"
sleep 0.3
node /t/scan.js`);
    const [first, stopped, second] = out.trim().split("\n");
    const scan = JSON.parse(first!) as { listeners: Array<Record<string, unknown>>; table: Array<[number, number, number]> };
    expect(scan.listeners).toEqual([expect.objectContaining({ port: 5173, host: "0.0.0.0", exec: "term-abc", thread: 'th"1\nx' })]);
    expect(scan.table.length).toBeGreaterThan(1);
    expect(stopped).toBe('{"signalled":true}');
    expect((JSON.parse(second!) as { listeners: Array<unknown> }).listeners).toEqual([]);
  }, 90_000);
});
