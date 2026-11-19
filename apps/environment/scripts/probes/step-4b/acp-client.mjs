// M0's ACP client (step 4b): drives one ACP agent over stdio as t3's adapter would, with no client file system and no
// client terminal, and prints one JSON summary. Every JSON-RPC message goes to $LOG as one line.
//   node acp-client.mjs '<scenario json>' -- <command> [args…]
// Scenario: { cwd, protocolVersion?, sessionMeta?, load?: sessionId, resume?: sessionId,
//   steps: [{ prompt } | { setMode } | { setConfig: { configId, value } } | { sleepMs }],
//   permission?: "allow" | "reject" | "cancel" | { [toolKind]: "allow" | "reject" | "cancel", default },
//   timeoutMs? }
import { spawn } from "node:child_process";
import fs from "node:fs";

const sep = process.argv.indexOf("--");
const scenario = JSON.parse(process.argv[2]);
const [command, ...args] = process.argv.slice(sep + 1);
const log = process.env.LOG ? fs.createWriteStream(process.env.LOG) : null;
const started = Date.now();
const out = {
  initialize: null,
  session: null,
  prompts: [],
  permissions: [],
  tools: {},
  modeUpdates: [],
  text: "",
  errors: [],
  stderr: "",
  authenticateCalls: 0,
  extRequests: [],
  ms: 0,
};

const child = spawn(command, args, { cwd: scenario.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
child.stderr.on("data", (d) => {
  out.stderr = (out.stderr + d.toString()).slice(-4000);
});
let nextId = 1;
const pending = new Map();
const send = (msg) => {
  log?.write(JSON.stringify({ dir: "out", t: Date.now() - started, msg }) + "\n");
  child.stdin.write(JSON.stringify(msg) + "\n");
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: "2.0", id, method, params });
  });

const permissionAnswer = (params) => {
  const kind = params.toolCall?.kind ?? "other";
  const policy = scenario.permission ?? "allow";
  const choice = typeof policy === "string" ? policy : (policy[kind] ?? policy.default ?? "allow");
  if (choice === "cancel") return { outcome: { outcome: "cancelled" } };
  const wanted = choice === "allow" ? "allow_once" : choice === "always" ? "allow_always" : "reject_once";
  const option = params.options.find((o) => o.kind === wanted) ?? (choice.startsWith?.("id:") ? params.options.find((o) => o.optionId === choice.slice(3)) : undefined);
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
};

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      out.errors.push({ nonJson: line.slice(0, 200) });
      continue;
    }
    log?.write(JSON.stringify({ dir: "in", t: Date.now() - started, msg }) + "\n");
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error, method: p?.method }));
      else p?.resolve(msg.result);
      continue;
    }
    if (msg.method === "session/update") {
      const u = msg.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") out.text += u.content.text;
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const t = (out.tools[u.toolCallId] ??= { kind: null, title: null, status: null, locations: null });
        if (u.kind) t.kind = u.kind;
        if (u.title) t.title = u.title.slice(0, 120);
        if (u.status) t.status = u.status;
        if (u.locations) t.locations = u.locations.map((l) => l.path);
        if (u.rawInput?.plan) t.plan = String(u.rawInput.plan).slice(0, 200);
      }
      if (u.sessionUpdate === "current_mode_update") out.modeUpdates.push(u.currentModeId);
      continue;
    }
    if (msg.method === "session/request_permission") {
      const answer = permissionAnswer(msg.params);
      out.permissions.push({
        kind: msg.params.toolCall?.kind ?? null,
        title: msg.params.toolCall?.title?.slice(0, 120) ?? null,
        locations: msg.params.toolCall?.locations?.map((l) => l.path) ?? null,
        rawInputKeys: Object.keys(msg.params.toolCall?.rawInput ?? {}),
        plan: msg.params.toolCall?.rawInput?.plan ? String(msg.params.toolCall.rawInput.plan).slice(0, 200) : undefined,
        options: msg.params.options.map((o) => `${o.optionId}:${o.kind}`),
        answered: answer.outcome.optionId ?? answer.outcome.outcome,
      });
      send({ jsonrpc: "2.0", id: msg.id, result: answer });
      continue;
    }
    if (msg.method === "authenticate") out.authenticateCalls++;
    if (msg.id !== undefined && msg.method) {
      out.extRequests.push(msg.method);
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});

const timer = setTimeout(() => finish("timeout"), scenario.timeoutMs ?? 180000);
let done = false;
function finish(reason) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  out.end = reason;
  out.ms = Date.now() - started;
  out.pid = child.pid;
  console.log(JSON.stringify(out));
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}
child.on("exit", (code, signal) => {
  out.exit = { code, signal };
  finish("exit");
});

try {
  out.initialize = await request("initialize", {
    protocolVersion: scenario.protocolVersion ?? 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "t3flare-probe", version: "0" },
  });
  const sessionParams = { cwd: scenario.cwd, mcpServers: [], ...(scenario.sessionMeta ? { _meta: scenario.sessionMeta } : {}) };
  if (scenario.load) out.session = { ...(await request("session/load", { ...sessionParams, sessionId: scenario.load })), sessionId: scenario.load };
  else if (scenario.resume) out.session = { ...(await request("session/resume", { ...sessionParams, sessionId: scenario.resume })), sessionId: scenario.resume };
  else out.session = await request("session/new", sessionParams);
  let sessionId = out.session.sessionId;
  for (const step of scenario.steps ?? []) {
    // { fork: true }: session/fork of the current session, then continue in the fork.
    if (step.fork) {
      const r = await request("session/fork", { sessionId, cwd: scenario.cwd, mcpServers: [], ...(step.fork._meta ? { _meta: step.fork._meta } : {}) }).catch((e) => ({ error: e.rpc ?? String(e) }));
      out.prompts.push({ fork: r.sessionId ?? null, error: r.error ?? null, keys: Object.keys(r) });
      if (r.sessionId) sessionId = r.sessionId;
    }
    if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
    if (step.setMode) out.prompts.push({ setMode: step.setMode, result: await request("session/set_mode", { sessionId, modeId: step.setMode }).then(() => "ok", (e) => e.rpc ?? String(e)) });
    if (step.setConfig) out.prompts.push({ setConfig: step.setConfig, result: await request("session/set_config_option", { sessionId, ...step.setConfig }).then(() => "ok", (e) => e.rpc ?? String(e)) });
    if (step.prompt !== undefined) {
      const t0 = Date.now();
      const textBefore = out.text.length;
      try {
        const r = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: step.prompt }] });
        out.prompts.push({ stopReason: r.stopReason, ms: Date.now() - t0, usage: r.usage ?? null, text: out.text.slice(textBefore).slice(-300) });
      } catch (e) {
        out.prompts.push({ error: e.rpc ?? String(e), ms: Date.now() - t0, text: out.text.slice(textBefore).slice(-300) });
      }
    }
  }
  finish("done");
} catch (e) {
  out.errors.push({ method: e.method, error: e.rpc ?? String(e) });
  finish("error");
}
