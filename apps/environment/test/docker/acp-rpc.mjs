// test:docker's ACP driver (SPI-1151): spawns the command after `--` (claude-agent-acp's or OpenCode's launcher in a
// container), runs `initialize` and `session/new`, keeps every `available_commands_update` until `settleMs` passes
// without one (after the first), optionally sends one prompt, answers the agent's requests with an error (no client
// file system, no terminal), logs every line to $LOG and prints a summary JSON.
//   node acp-rpc.mjs '<json {cwd, settleMs?, waitMs?, prompt?, timeoutMs?}>' -- <command…>
import { spawn } from "node:child_process";
import fs from "node:fs";

const sep = process.argv.indexOf("--");
const scenario = JSON.parse(process.argv[2]);
const command = process.argv.slice(sep + 1);
const log = fs.createWriteStream(process.env.LOG ?? "/dev/null", { flags: "a" });
const started = Date.now();
const note = (dir, msg) => log.write(`${JSON.stringify({ t: Date.now() - started, dir, msg })}\n`);
const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const summary = { commandUpdates: [], sessionId: null, errors: [], stderr: "", text: "", toolCalls: [], requests: {} };
let nextId = 1;
const pending = new Map();
let lastUpdate = 0;
const send = (msg) => {
  note("out", msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      note("in-raw", line.slice(0, 500));
      continue;
    }
    note("in", msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter?.reject(Object.assign(new Error(JSON.stringify(msg.error)), { rpc: msg.error }));
      else waiter?.resolve(msg.result);
    } else if (msg.id !== undefined) {
      summary.requests[msg.method] = (summary.requests[msg.method] ?? 0) + 1;
      if (msg.method === "session/request_permission") {
        const option = (msg.params?.options ?? []).find((candidate) => candidate.kind === "allow_once") ?? msg.params?.options?.[0];
        send({ jsonrpc: "2.0", id: msg.id, result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
      } else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not offered by the probe" } });
    } else if (msg.method === "session/update") {
      const update = msg.params?.update ?? {};
      if (update.sessionUpdate === "available_commands_update") {
        summary.commandUpdates.push((update.availableCommands ?? []).map((entry) => ({ name: entry.name, description: entry.description ?? null })));
        lastUpdate = Date.now();
      }
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") summary.text += update.content.text;
      if (update.sessionUpdate === "tool_call") summary.toolCalls.push({ title: update.title ?? null, kind: update.kind ?? null });
    }
  }
});
child.stderr.on("data", (chunk) => (summary.stderr = (summary.stderr + chunk.toString("utf8")).slice(-4000)));
child.on("exit", (code, signal) => (summary.exit = { code, signal }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = started + (scenario.timeoutMs ?? 180_000);
try {
  summary.initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }).then((result) => ({
    agentInfo: result?.agentInfo ?? null,
    protocolVersion: result?.protocolVersion ?? null,
  }));
  const session = await request("session/new", { cwd: scenario.cwd, mcpServers: [] });
  summary.sessionId = session?.sessionId ?? null;
  // The commands come after `session/new`; wait for the first, then until they settle.
  const waitUntil = Date.now() + (scenario.waitMs ?? 60_000);
  while (Date.now() < Math.min(waitUntil, deadline) && summary.exit === undefined) {
    if (lastUpdate !== 0 && Date.now() - lastUpdate > (scenario.settleMs ?? 3000)) break;
    await sleep(250);
  }
  if (scenario.prompt !== undefined && summary.sessionId !== null) {
    const result = await Promise.race([
      request("session/prompt", { sessionId: summary.sessionId, prompt: [{ type: "text", text: scenario.prompt }] }),
      sleep(Math.max(deadline - Date.now(), 0)).then(() => ({ stopReason: "probe timeout" })),
    ]);
    summary.stopReason = result?.stopReason ?? null;
  }
} catch (error) {
  summary.errors.push(error.rpc ?? String(error));
}
summary.ms = Date.now() - started;
summary.text = summary.text.slice(-2000);
child.kill("SIGTERM");
console.log(JSON.stringify(summary));
setTimeout(() => process.exit(0), 300);
