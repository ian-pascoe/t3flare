// A scripted ACP agent for the flavor tests (step 4b): answers t3's adapter as claude-agent-acp 0.106.0 or opencode
// 2.2.7 did in M0's probes (their recorded initialize, session/new and request shapes), runs one scripted list of
// steps per prompt, and writes every message it receives to $FAKE_ACP_LOG, one JSON line each.
//   FAKE_ACP_SCRIPT=<json file> FAKE_ACP_LOG=<file> node fake-acp-agent.mjs
// Script: { initialize, sessionNew, prompts: [[step…]…] }; a step is { update } (a session/update), { request:
// { method, params } } (waits for the answer), { result } (the prompt's own answer, default end_turn), or { respond }
// (answers the prompt now and goes on: ACP v2, whose prompt is answered before the turn's work).
import * as fs from "node:fs";
import * as readline from "node:readline";

const script = JSON.parse(fs.readFileSync(process.env.FAKE_ACP_SCRIPT, "utf8"));
const log = (entry) => fs.appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let sessionId = script.sessionNew.sessionId;
let promptIndex = 0;
let nextRequestId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++;
    waiting.set(id, resolve);
    send({ id, method, params: { sessionId, ...params } });
  });

const runPrompt = async (id) => {
  const steps = script.prompts[promptIndex++] ?? [];
  let result = { stopReason: "end_turn" };
  let answered = false;
  for (const step of steps) {
    if (step.respond !== undefined) {
      send({ id, result: step.respond });
      answered = true;
    }
    if (step.update !== undefined) send({ method: "session/update", params: { sessionId, update: step.update } });
    if (step.request !== undefined) log({ answered: step.request.method, result: await request(step.request.method, step.request.params) });
    if (step.result !== undefined) result = step.result;
    if (step.error !== undefined) return send({ id, error: step.error });
  }
  if (!answered) send({ id, result });
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  log({ received: message.method ?? "response", id: message.id ?? null, params: message.params ?? null, result: message.result ?? null });
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result ?? { error: message.error });
    waiting.delete(message.id);
    return;
  }
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: script.initialize });
    case "session/new":
      return send({ id: message.id, result: script.sessionNew });
    case "session/load":
    case "session/resume":
      sessionId = message.params.sessionId;
      return send({ id: message.id, result: { ...script.sessionNew, sessionId: undefined } });
    case "session/set_mode":
      if (script.sessionNew.modes) script.sessionNew.modes.currentModeId = message.params.modeId;
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: message.params.modeId } } });
      return send({ id: message.id, result: {} });
    case "session/set_config_option": {
      const option = script.sessionNew.configOptions?.find((entry) => entry.id === message.params.configId);
      if (option !== undefined) option.currentValue = message.params.value;
      return send({ id: message.id, result: { configOptions: script.sessionNew.configOptions ?? [] } });
    }
    case "session/prompt":
      return void runPrompt(message.id);
    case "session/close":
      return send({ id: message.id, result: {} });
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
