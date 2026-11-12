// test:docker's Codex app-server driver (from step 4a M0's probe): spawns the command after `--` (the launcher in a
// container), runs one scenario over JSON-RPC on stdio, logs every message to $LOG, prints a summary JSON on stdout.
//   node codex-rpc.mjs '<json scenario>' -- <command…>
// Scenario: { model, cwd, prompt, resume?: threadId, approve?: "accept"|"decline", threadConfig?, turnParams?,
//             threadParams?, extraRequests?: [{method, params}], timeoutMs? }
import { spawn } from "node:child_process";
import fs from "node:fs";

const sep = process.argv.indexOf("--");
const scenario = JSON.parse(process.argv[2]);
const command = process.argv.slice(sep + 1);
const logPath = process.env.LOG ?? "/dev/null";
const log = fs.createWriteStream(logPath, { flags: "a" });
const started = Date.now();
const note = (dir, msg) => log.write(`${JSON.stringify({ t: Date.now() - started, dir, msg })}\n`);

const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let nextId = 1;
const pending = new Map();
const summary = { threadId: null, items: [], approvals: [], errors: [], notifications: {}, agentText: "", stderr: "", turnStatus: null, requests: {} };
const send = (msg) => {
  note("out", msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
let turnDone;
const turnCompleted = new Promise((resolve) => (turnDone = resolve));
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
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p === undefined) continue;
      if (msg.error) p.reject(Object.assign(new Error(JSON.stringify(msg.error)), { rpc: msg.error }));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      summary.requests[msg.method] = (summary.requests[msg.method] ?? 0) + 1;
      summary.approvals.push({ method: msg.method, command: msg.params?.command ?? null, reason: msg.params?.reason ?? null });
      send({ jsonrpc: "2.0", id: msg.id, result: { decision: scenario.approve ?? "accept" } });
    } else {
      summary.notifications[msg.method] = (summary.notifications[msg.method] ?? 0) + 1;
      if (msg.method === "item/completed") summary.items.push({ type: msg.params?.item?.type, status: msg.params?.item?.status ?? null, command: msg.params?.item?.command ?? null });
      if (msg.method === "item/agentMessage/delta") summary.agentText += msg.params?.delta ?? "";
      if (msg.method === "error") summary.errors.push(msg.params);
      if (msg.method === "turn/completed") {
        summary.turnStatus = msg.params?.turn?.status ?? null;
        if (msg.params?.turn?.error) summary.errors.push(msg.params.turn.error);
        turnDone();
      }
    }
  }
});
child.stderr.on("data", (chunk) => {
  summary.stderr = (summary.stderr + chunk.toString("utf8")).slice(-4000);
});
child.on("exit", (code, signal) => {
  summary.exit = { code, signal };
  turnDone();
});

const timeout = setTimeout(() => {
  summary.errors.push({ probe: "timeout" });
  turnDone();
}, scenario.timeoutMs ?? 300_000);

try {
  summary.initialize = await request("initialize", { clientInfo: { name: "t3flare-probe", title: "t3flare probe", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  send({ jsonrpc: "2.0", method: "initialized" });
  for (const extraRequest of scenario.extraRequests ?? []) {
    try {
      summary[`extra:${extraRequest.method}`] = { ok: await request(extraRequest.method, extraRequest.params ?? {}) };
    } catch (error) {
      summary[`extra:${extraRequest.method}`] = { error: error.rpc ?? String(error) };
    }
  }
  if (scenario.prompt !== undefined) {
    const threadParams = { cwd: scenario.cwd, model: scenario.model, ...(scenario.threadConfig ? { config: scenario.threadConfig } : {}), ...scenario.threadParams };
    const thread = scenario.resume
      ? await request("thread/resume", { threadId: scenario.resume, ...threadParams })
      : await request("thread/start", threadParams);
    summary.threadId = thread.thread?.id ?? null;
    summary.threadPath = thread.thread?.path ?? null;
    for (let turn = 0; turn < (scenario.turns ?? 1); turn++) {
      const done = new Promise((resolve) => (turnDone = resolve));
      await request("turn/start", { threadId: summary.threadId, input: [{ type: "text", text: scenario.prompt, text_elements: [] }], ...scenario.turnParams });
      await done;
      summary.turnsCompleted = turn + 1;
      if (summary.exit) break;
    }
  }
} catch (error) {
  summary.errors.push({ probe: "request-failed", error: error.rpc ?? String(error) });
}
clearTimeout(timeout);
summary.ms = Date.now() - started;
summary.agentText = summary.agentText.slice(-2000);
child.kill("SIGTERM");
console.log(JSON.stringify(summary));
setTimeout(() => process.exit(0), 300);
