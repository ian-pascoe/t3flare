// test:docker's pi RPC driver (from step 4a M0's probe): spawns the command after `--` (pi's launcher in a container),
// sends each command of the scenario (waiting for `agent_end` after a prompt), answers extension UI confirms, logs every
// line to $LOG and prints a summary JSON.   node pi-rpc.mjs '<json {commands, confirm?, timeoutMs?}>' -- <command…>
import { spawn } from "node:child_process";
import fs from "node:fs";

const sep = process.argv.indexOf("--");
const scenario = JSON.parse(process.argv[2]);
const command = process.argv.slice(sep + 1);
const log = fs.createWriteStream(process.env.LOG ?? "/dev/null", { flags: "a" });
const started = Date.now();
const note = (dir, msg) => log.write(`${JSON.stringify({ t: Date.now() - started, dir, msg })}\n`);
const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const summary = { responses: [], events: {}, toolCalls: [], uiRequests: [], text: "", errors: [], stderr: "" };
let waiter = null;
let reqId = 0;
const send = (msg) => {
  note("out", msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
};
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
    summary.events[msg.type] = (summary.events[msg.type] ?? 0) + 1;
    if (msg.type === "response") {
      summary.responses.push({ command: msg.command, success: msg.success, error: msg.error ?? null, data: msg.command === "get_state" ? { sessionFile: msg.data?.sessionFile, sessionId: msg.data?.sessionId, model: msg.data?.model?.id } : undefined });
      if (waiter?.kind === "response" && msg.id === waiter.id) waiter.resolve();
    }
    if (msg.type === "extension_ui_request") {
      summary.uiRequests.push({ method: msg.method, title: msg.title ?? null, message: (msg.message ?? "").slice(0, 200) });
      if (msg.method === "confirm") send({ type: "extension_ui_response", id: msg.id, confirmed: scenario.confirm ?? true });
      else if (msg.method === "select") send({ type: "extension_ui_response", id: msg.id, value: msg.options?.[0] });
    }
    if (msg.type === "tool_execution_start") summary.toolCalls.push({ tool: msg.toolName, args: JSON.stringify(msg.args ?? {}).slice(0, 160) });
    if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") summary.text += msg.assistantMessageEvent.delta;
    if (msg.type === "message_end" && msg.message?.errorMessage) summary.errors.push(msg.message.errorMessage);
    if (msg.type === "agent_end" && waiter?.kind === "agent_end") waiter.resolve();
  }
});
child.stderr.on("data", (chunk) => (summary.stderr = (summary.stderr + chunk.toString("utf8")).slice(-3000)));
child.on("exit", (code, signal) => {
  summary.exit = { code, signal };
  waiter?.resolve();
});
const timer = setTimeout(() => {
  summary.errors.push("probe timeout");
  waiter?.resolve();
}, scenario.timeoutMs ?? 300_000);
for (const command of scenario.commands) {
  const id = `c${++reqId}`;
  await new Promise((resolve) => {
    waiter = { kind: command.type === "prompt" ? "agent_end" : "response", id, resolve };
    send({ id, ...command });
  });
  if (summary.exit) break;
}
clearTimeout(timer);
summary.ms = Date.now() - started;
summary.text = summary.text.slice(-1500);
child.kill("SIGTERM");
console.log(JSON.stringify(summary));
setTimeout(() => process.exit(0), 300);
