// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// SPI-1168 in `pnpm run test:docker`: Claude Code on the model relay, launched as the Workspace DO launches it (the
// profile with a `claudeRelay`, the handle in the process's environment) in the image's CLI layer, against the stand-in
// `computer.internal`'s model relay (keyhost.mjs; no model is called). The real launcher, preload and handle helper:
// - Claude Code's requests reach the routed URL with the endpoint's slug and the handle in its key headers, with no
//   model set on the session (Claude Code's own default resolves through the pinned aliases to a slug);
// - the session offers only `default` and the endpoints' slugs (t3's adapter refuses a stale non-slug before any request);
// - a Bash command Claude Code runs has `T3FLARE_EXEC` and no handle in its environment;
// - only the launch chain (setsid, claude-agent-acp) holds the handle; the `claude` processes do not;
// - the handle helper refuses a launcher record that names another process, or the right pid with another start time.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, it } from "vitest";

import { profileLaunch } from "../../src/agents/cliProfiles.ts";
import { docker, drive, runCommand, startHarness, T3_PATH } from "./cliHarness.ts";

const here = import.meta.dirname;

it("Claude Code reaches the model relay with its handle, which no Claude process or shell inherits", () => {
  const handle = randomBytes(32).toString("hex");
  const nonce = `nonce-${randomUUID()}`;
  const harness = startHarness("t3flare-claude-relay", [nonce], { modelHandle: handle });
  const workspace = fs.mkdtempSync(path.join(here, ".claude-relay-"));
  fs.mkdirSync(path.join(workspace, ".t3flare"), { recursive: true });
  // The fixture's repo, where the process's cwd (T3_PATH) lands.
  fs.mkdirSync(path.join(workspace, "repo"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: path.join(workspace, "repo") });
  fs.chmodSync(workspace, 0o777);
  try {
    const marker = `proc-${randomUUID()}`;
    const answer = profileLaunch(
      { cli: "claude", args: [], key: marker, cwd: T3_PATH, env: {}, allowProbe: false },
      { proxyUrl: "", models: [], readStateFile: () => undefined, piExtensionSource: "", claudeRelay: { endpoints: ["comm"], models: ["comm/claude-haiku-5-5"], backgroundModel: "comm/claude-haiku-5-5", opusModel: "comm/claude-haiku-5-5", sonnetModel: "comm/claude-haiku-5-5" } },
    );
    if ("refused" in answer) throw new Error(answer.refused);
    // The watcher runs without the handle: once Claude's Bash has written its environment, it records which processes
    // hold the handle (by their command line), how many `claude` processes run, and what the helper says to forged
    // launcher records.
    const watcher = [
      "for i in $(seq 1 240); do [ -s /workspace/shell-env.txt ] && break; sleep 0.5; done",
      "for f in /proc/[0-9]*/environ; do p=${f#/proc/}; p=${p%/environ}; if tr '\\0' '\\n' < $f 2>/dev/null | grep -q '^T3FLARE_MODEL_HANDLE='; then tr '\\0' ' ' < /proc/$p/cmdline; echo; fi; done > /workspace/holders.txt",
      "pgrep -fc 'claude-agent-sdk-linux-x64/claude' > /workspace/claude-count.txt || true",
      `real=$(cut -d' ' -f1 /var/lib/t3flare/cli/${marker}/acp.pid)`,
      "mkdir -p /var/lib/t3flare/cli/forged",
      "sleep 300 > /dev/null 2>&1 &",
      "other=$!",
      "sleep 0.2; echo \"$other $(sed 's/.*) //' /proc/$other/stat | cut -d' ' -f20)\" > /var/lib/t3flare/cli/forged/acp.pid",
      "T3FLARE_EXEC=forged /opt/t3flare/bin/t3flare-claude-handle > /dev/null 2> /workspace/forged-other.txt; echo $? >> /workspace/forged-other.txt",
      "echo \"$real 1\" > /var/lib/t3flare/cli/forged/acp.pid",
      "T3FLARE_EXEC=forged /opt/t3flare/bin/t3flare-claude-handle > /dev/null 2> /workspace/forged-start.txt; echo $? >> /workspace/forged-start.txt",
      `T3FLARE_EXEC=${marker} /opt/t3flare/bin/t3flare-claude-handle | wc -c > /workspace/helper-bytes.txt`,
      "kill $other",
    ].join("\n");
    fs.writeFileSync(path.join(workspace, "watch.sh"), `${watcher}\n`);
    const command = runCommand({
      harness,
      name: "t3flare-claude-relay",
      launch: { ...answer, env: { ...answer.env, T3FLARE_MODEL_HANDLE: handle } },
      marker,
      nonce,
      workspace,
      setup: "(env -u T3FLARE_MODEL_HANDLE bash /workspace/watch.sh > /workspace/watch.log 2>&1 &)",
    });
    const result = drive("acp-rpc.mjs", { cwd: T3_PATH, waitMs: 30_000, settleMs: 3000, timeoutMs: 180_000, prompt: "Write your environment to a file.", lingerMs: 10_000 }, command);
    const read = (name: string) => (fs.existsSync(path.join(workspace, name)) ? fs.readFileSync(path.join(workspace, name), "utf8") : "");
    const relayed = docker(["logs", "t3flare-claude-relay-keyhost"]).stdout
      .split("\n")
      .filter((line) => line.includes('"model-relay"'))
      .map((line) => JSON.parse(line) as { path: string; model: string; apiKeyIsHandle: boolean; bearerIsHandle: boolean; bash: boolean });
    const shellEnv = read("shell-env.txt");
    const holders = read("holders.txt").split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const report = { models: result.models, shellEnvWritten: shellEnv !== "", watchLog: read("watch.log").slice(-600), stopReason: result.stopReason, errors: result.errors, toolCalls: result.toolCalls, relayed, holders, claude: read("claude-count.txt").trim(), forgedOther: read("forged-other.txt"), forgedStart: read("forged-start.txt"), helperBytes: read("helper-bytes.txt").trim() };
    const text = JSON.stringify(report);
    expect(text.includes(handle), "the handle reached the report").toBe(false);
    expect(relayed.length, text).toBeGreaterThan(0);
    // Claude Code's `default` (its own default, through the pinned aliases) and the slugs: never a non-slug id.
    expect(report.models, text).toEqual(["default", "comm/claude-haiku-5-5"]);
    expect(relayed.every((entry) => entry.path.startsWith("/t3flare/model/_/") && entry.model === "comm/claude-haiku-5-5" && entry.apiKeyIsHandle && entry.bearerIsHandle), text).toBe(true);
    expect(relayed.some((entry) => entry.bash), text).toBe(true);
    expect(shellEnv.includes("T3FLARE_EXEC="), text).toBe(true);
    expect(shellEnv.includes("T3FLARE_MODEL_HANDLE"), text).toBe(false);
    expect(holders.length, text).toBeGreaterThan(0);
    expect(holders.every((line) => line.startsWith("setsid --wait /opt/t3flare/bin/claude-agent-acp") || line.includes("--require /opt/t3flare/share/claude-handle-unset.cjs")), text).toBe(true);
    expect(Number(report.claude), text).toBeGreaterThan(0);
    expect(report.forgedOther, text).toMatch(/names another process\n1\n$/);
    expect(report.forgedStart, text).toMatch(/is gone\n1\n$/);
    // The helper prints the 64-character handle and its newline.
    expect(report.helperBytes, text).toBe("65");
  } finally {
    harness.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
