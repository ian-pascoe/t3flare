// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// SPI-1169 in `pnpm run test:docker`: OpenCode on the model relay, launched as the Workspace DO launches it (the profile
// with an `opencodeRelay`, the handle in the process's environment) in the image's CLI layer, against the stand-in
// `computer.internal`'s model relay (keyhost.mjs; no model is called). The real launcher and key plugin:
// - each endpoint is its own provider at the relay's per-endpoint path, by API: Anthropic Messages at `…/v1/messages`
//   with the handle in `x-api-key`, OpenAI Chat Completions at `…/chat/completions` and Responses at `…/responses` with
//   it as a Bearer; the model's own id in the body; the key helper never asked;
// - one session switches between the three endpoints' models, each turn running OpenCode's shell tool;
// - the session offers only the endpoints' models (t3's adapter refuses a stale proxy id before any request);
// - a shell command OpenCode runs, and a repository's MCP server it starts, have `T3FLARE_EXEC` and no handle;
// - only the launch chain (setsid, `opencode acp` and the server it starts) holds the handle, not the launcher's
//   watcher or snapshot loop.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EndpointApi, EndpointModel, ModelEndpoint } from "@t3flare/models/endpoints";
import { expect, it } from "vitest";

import { profileLaunch } from "../../src/agents/cliProfiles.ts";
import { opencodeRelayOf } from "../../src/provider/cli/opencodeEndpoints.ts";
import { docker, drive, runCommand, startHarness, T3_PATH } from "./cliHarness.ts";

const here = import.meta.dirname;

const model = (id: string): EndpointModel => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, modelId: string): ModelEndpoint => ({ id, label: id, api, baseUrl: `https://${id}.example`, auth: "api-key", headers: {}, models: [model(modelId)] });

it("OpenCode reaches each endpoint's provider at the model relay with its handle, which no shell or MCP server inherits", () => {
  const handle = randomBytes(32).toString("hex");
  const nonce = `nonce-${randomUUID()}`;
  const harness = startHarness("t3flare-opencode-relay", [nonce], { modelHandle: handle });
  const workspace = fs.mkdtempSync(path.join(here, ".opencode-relay-"));
  fs.mkdirSync(path.join(workspace, ".t3flare"), { recursive: true });
  const repo = path.join(workspace, "repo");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  // A repository's own MCP server (honoured, as stock t3 honours it): it writes the environment OpenCode starts it with.
  fs.writeFileSync(path.join(repo, "opencode.json"), JSON.stringify({ mcp: { servers: { envdump: { type: "local", command: ["sh", "-c", "env > /workspace/mcp-env.txt; exec sleep 600"] } } } }));
  fs.chmodSync(workspace, 0o777);
  try {
    const marker = `proc-${randomUUID()}`;
    const relay = opencodeRelayOf(
      { revision: 1, endpoints: [endpoint("anth", "anthropic-messages", "claude-haiku-5-5"), endpoint("oai", "openai-completions", "gpt-x"), endpoint("resp", "openai-responses", "gpt-r"), endpoint("gem", "google-generative-ai", "gemini-x")] },
      undefined,
    );
    const answer = profileLaunch(
      { cli: "opencode", args: ["acp"], key: marker, cwd: T3_PATH, env: {}, allowProbe: false },
      { proxyUrl: "", models: [], readStateFile: () => undefined, piExtensionSource: "", ...(relay === undefined ? {} : { opencodeRelay: relay }) },
    );
    if ("refused" in answer) throw new Error(answer.refused);
    expect(answer.modelRelay).toEqual(["anth", "oai", "resp"]);
    // The watcher runs without the handle: once the first turn's shell has written its environment, it records which
    // processes hold the handle (by their command line) while OpenCode, its loops and the MCP server run.
    const watcher = [
      "for i in $(seq 1 240); do [ -s /workspace/shell-env.txt ] && break; sleep 0.5; done",
      "sleep 1",
      "for f in /proc/[0-9]*/environ; do p=${f#/proc/}; p=${p%/environ}; if tr '\\0' '\\n' < $f 2>/dev/null | grep -q '^T3FLARE_MODEL_HANDLE='; then tr '\\0' ' ' < /proc/$p/cmdline; echo; fi; done > /workspace/holders.txt",
      "ps -eo args > /workspace/ps.txt",
    ].join("\n");
    fs.writeFileSync(path.join(workspace, "watch.sh"), `${watcher}\n`);
    const command = runCommand({
      harness,
      name: "t3flare-opencode-relay",
      launch: { ...answer, env: { ...answer.env, T3FLARE_MODEL_HANDLE: handle } },
      marker,
      nonce,
      workspace,
      setup: "(env -u T3FLARE_MODEL_HANDLE bash /workspace/watch.sh > /workspace/watch.log 2>&1 &)",
    });
    const result = drive(
      "acp-rpc.mjs",
      {
        cwd: T3_PATH,
        waitMs: 20_000,
        settleMs: 3000,
        timeoutMs: 240_000,
        model: "t3flare-endpoint-anth/claude-haiku-5-5",
        prompt: "Write your environment to a file.",
        turns: [
          { model: "t3flare-endpoint-oai/gpt-x", prompt: "Write your environment to a file again." },
          { model: "t3flare-endpoint-resp/gpt-r", prompt: "And once more." },
        ],
        lingerMs: 3000,
      },
      command,
    );
    const read = (name: string) => (fs.existsSync(path.join(workspace, name)) ? fs.readFileSync(path.join(workspace, name), "utf8") : "");
    const logs = docker(["logs", "t3flare-opencode-relay-keyhost"]).stdout.split("\n");
    const relayed = logs
      .filter((line) => line.includes('"model-relay"'))
      .map((line) => JSON.parse(line) as { path: string; api: string; model: string; headers: ReadonlyArray<string>; apiKeyIsHandle: boolean; bearerIsHandle: boolean; bash: boolean });
    const keyAsked = logs.filter((line) => line.includes('"model-key"')).length;
    const shellEnv = read("shell-env.txt");
    const mcpEnv = read("mcp-env.txt");
    const holders = read("holders.txt").split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const report = { models: result.models, stopReason: result.stopReason, turns: result.turns, errors: result.errors, toolCalls: result.toolCalls, stderr: String(result.stderr ?? "").slice(-1500), relayed, keyAsked, holders, ps: read("ps.txt"), shellEnvWritten: shellEnv !== "", mcpEnvWritten: mcpEnv !== "", watchLog: read("watch.log").slice(-600) };
    const text = JSON.stringify(report);
    expect(text.includes(handle), "the handle reached the report").toBe(false);
    // Only the endpoints' models, by OpenCode's provider ids; no proxy model, no Google endpoint.
    expect([...report.models].sort((a: string, b: string) => a.localeCompare(b)), text).toEqual(["t3flare-endpoint-anth/claude-haiku-5-5", "t3flare-endpoint-oai/gpt-x", "t3flare-endpoint-resp/gpt-r"]);
    // Each API's path, the model's own id, the handle in the API's key header.
    const anth = relayed.filter((entry) => entry.path.startsWith("/t3flare/model/anth/"));
    const oai = relayed.filter((entry) => entry.path.startsWith("/t3flare/model/oai/"));
    const resp = relayed.filter((entry) => entry.path.startsWith("/t3flare/model/resp/"));
    expect(anth.length, text).toBeGreaterThan(0);
    expect(oai.length, text).toBeGreaterThan(0);
    expect(resp.length, text).toBeGreaterThan(0);
    expect(relayed.length, text).toBe(anth.length + oai.length + resp.length);
    expect(anth.every((entry) => entry.path === "/t3flare/model/anth/v1/messages" && entry.model === "claude-haiku-5-5" && entry.apiKeyIsHandle), text).toBe(true);
    expect(oai.every((entry) => entry.path === "/t3flare/model/oai/chat/completions" && entry.model === "gpt-x" && entry.bearerIsHandle), text).toBe(true);
    expect(resp.every((entry) => entry.path === "/t3flare/model/resp/responses" && entry.model === "gpt-r" && entry.bearerIsHandle), text).toBe(true);
    // A tool turn on each, in one session.
    for (const group of [anth, oai, resp]) expect(group.some((entry) => entry.bash), text).toBe(true);
    expect(report.stopReason, text).toBe("end_turn");
    expect(report.turns.map((turn: { stopReason: string }) => turn.stopReason), text).toEqual(["end_turn", "end_turn"]);
    // The handle needs no key helper.
    expect(keyAsked, text).toBe(0);
    // The shell and the repository's MCP server: the marker, no handle, no nonce.
    expect(shellEnv.includes("T3FLARE_EXEC="), text).toBe(true);
    expect(shellEnv.includes("T3FLARE_MODEL_HANDLE"), text).toBe(false);
    expect(shellEnv.includes("T3FLARE_MODEL_KEY_NONCE"), text).toBe(false);
    expect(mcpEnv.includes("T3FLARE_MODEL_HANDLE"), text).toBe(false);
    expect(mcpEnv.includes("T3FLARE_MODEL_KEY_NONCE"), text).toBe(false);
    // The holders: setsid and OpenCode itself (the launcher it became), not the launcher's loops.
    expect(holders.length, text).toBeGreaterThan(0);
    // `opencode acp` runs its server as a child (`opencode serve --stdio`), where the plugin runs: both are OpenCode.
    const chain = new Set(["setsid --wait /opt/t3flare/bin/opencode acp", "/opt/t3flare/opencode/opencode acp", "/opt/t3flare/opencode/opencode serve --stdio --port 0"]);
    expect(holders.every((line) => chain.has(line)), text).toBe(true);
  } finally {
    harness.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
