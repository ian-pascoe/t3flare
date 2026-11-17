// test:docker's stand-in for `computer.internal` (the egress host), in a sidecar container, from step 4a M0's probe:
// - a CONNECT proxy on :3128, the CLI network's only way out, logging every host it tunnels to;
// - a resolver on :53 that logs every name asked and answers NXDOMAIN (the CLI network has no route out).
// - with KEYHOST_MODEL_HANDLE (SPI-1168), a stand-in model relay and endpoint under /t3flare/model/: Anthropic Messages,
//   and OpenAI Chat Completions and Responses (SPI-1169), Google Generative AI and Mistral's chat (SPI-1170, pi's
//   APIs). KEYHOST_MODEL_HANDLE may name several handles (comma-separated): a process each (SPI-1170's resume).
// Every event is one JSON line on stdout, never a handle. (A request to `/t3flare/model-key` is logged as any other
// path, `http`, and answered 404, as computer's proxy answers it.)
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";

const log = (entry) => console.log(JSON.stringify({ at: Date.now(), ...entry }));
/**
 * SPI-1168: the model handles the stand-in model relay expects (claudeRelay, opencodeRelay and piRelay docker tests), in
 * order; never logged (a request's handle is logged by its index).
 */
const HANDLES = (process.env.KEYHOST_MODEL_HANDLE ?? "").split(",").filter((handle) => handle !== "");
/** The index of the handle `value` is (`prefix` before it, as `Bearer `), or -1. */
const handleIndex = (value, prefix = "") => (typeof value === "string" && value.startsWith(prefix) ? HANDLES.indexOf(value.slice(prefix.length)) : -1);
/** What each key header of a request holds: a handle (by index), or not. */
const keysOf = (req) => {
  const apiKey = handleIndex(req.headers["x-api-key"]);
  const bearer = handleIndex(req.headers.authorization, "Bearer ");
  const goog = handleIndex(req.headers["x-goog-api-key"]);
  return { apiKeyIsHandle: apiKey !== -1, bearerIsHandle: bearer !== -1, googKeyIsHandle: goog !== -1, handle: Math.max(apiKey, bearer, goog) };
};

/** The shell tool each CLI offers: Claude Code's `Bash`, OpenCode's `shell`, pi's `bash`. */
const SHELL_TOOLS = new Set(["Bash", "shell", "bash"]);
const SHELL_COMMAND = "env > /workspace/shell-env.txt";
/** The shell tool's input: pi's takes the command alone. */
const shellInput = (tool) => (tool === "bash" ? { command: SHELL_COMMAND } : { command: SHELL_COMMAND, description: "Write the environment" });

/**
 * The API a relayed request speaks, by its path: Anthropic Messages, OpenAI (or Mistral's) Chat Completions, OpenAI
 * Responses, or Google Generative AI (`…/models/<model>:streamGenerateContent`).
 */
const apiOf = (pathname) =>
  /:(stream)?[gG]enerateContent$/.test(pathname) ? "google" : pathname.endsWith("/chat/completions") ? "completions" : pathname.endsWith("/responses") ? "responses" : "messages";

/** The shell tool's name a request offers, if it offers one and its last message is not a tool result (a new turn). */
const shellToolOf = (api, parsed) => {
  const names =
    api === "google" ? (parsed.tools ?? []).flatMap((tool) => (tool.functionDeclarations ?? []).map((declaration) => declaration.name)) : (parsed.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
  const last = api === "responses" ? (Array.isArray(parsed.input) ? parsed.input : []).at(-1) : api === "google" ? (parsed.contents ?? []).at(-1) : (parsed.messages ?? []).at(-1);
  const answered =
    api === "messages"
      ? Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result")
      : api === "completions"
        ? last?.role === "tool"
        : api === "google"
          ? (last?.parts ?? []).some((part) => part.functionResponse !== undefined)
          : last?.type === "function_call_output";
  return answered ? undefined : names.find((name) => SHELL_TOOLS.has(name));
};

const sse = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  return (type, data) => res.write(type === undefined ? `data: ${JSON.stringify(data)}\n\n` : `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
};

/** Anthropic Messages: the shell tool call, or the text PONG. */
const answerMessages = (res, parsed, tool) => {
  const id = `msg_${Date.now()}`;
  if (parsed.stream !== true) {
    // A request that does not stream (Claude Code's check of a model it is switched to): one text message.
    const message = { id, type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text: "PONG" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } };
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
  }
  const block = tool !== undefined ? { type: "tool_use", id: `toolu_${Date.now()}`, name: tool, input: {} } : { type: "text", text: "" };
  const delta = tool !== undefined ? { type: "input_json_delta", partial_json: JSON.stringify(shellInput(tool)) } : { type: "text_delta", text: "PONG" };
  const event = sse(res);
  event("message_start", { message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
  event("content_block_start", { index: 0, content_block: block });
  event("content_block_delta", { index: 0, delta });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: tool !== undefined ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  event("message_stop", {});
  res.end();
};

/** Google Generative AI (`streamGenerateContent?alt=sse`): the shell tool call, or the text PONG. */
const answerGoogle = (res, tool) => {
  const part = tool !== undefined ? { functionCall: { name: tool, args: shellInput(tool) } } : { text: "PONG" };
  const chunk = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
};

/** OpenAI Chat Completions: the shell tool call, or the text PONG. */
const answerCompletions = (res, parsed, tool) => {
  const base = { id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed.model };
  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  if (parsed.stream !== true) {
    const message = tool !== undefined ? { role: "assistant", content: null, tool_calls: [{ id: `call_${Date.now()}`, type: "function", function: { name: tool, arguments: JSON.stringify(shellInput(tool)) } }] } : { role: "assistant", content: "PONG" };
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: tool !== undefined ? "tool_calls" : "stop" }], usage }));
  }
  const event = sse(res);
  const delta = tool !== undefined ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: tool, arguments: JSON.stringify(shellInput(tool)) } }] } : { role: "assistant", content: "PONG" };
  event(undefined, { ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  event(undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: tool !== undefined ? "tool_calls" : "stop" }], usage });
  res.write("data: [DONE]\n\n");
  res.end();
};

/** OpenAI Responses: the shell tool call, or the text PONG. */
const answerResponses = (res, parsed, tool) => {
  const id = `resp_${Date.now()}`;
  const item =
    tool !== undefined
      ? { type: "function_call", id: `fc_${Date.now()}`, call_id: `call_${Date.now()}`, name: tool, arguments: JSON.stringify(shellInput(tool)), status: "completed" }
      : { type: "message", id: `msg_${Date.now()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "PONG", annotations: [] }] };
  const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const response = (status, output) => ({ id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: parsed.model, output, ...(status === "completed" ? { usage } : {}) });
  if (parsed.stream !== true) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response("completed", [item])));
  const event = sse(res);
  let sequence = 0;
  const send = (type, data) => event(type, { sequence_number: sequence++, ...data });
  send("response.created", { response: response("in_progress", []) });
  if (tool !== undefined) {
    send("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
    send("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
    send("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
  } else {
    send("response.output_item.added", { output_index: 0, item: { ...item, content: [], status: "in_progress" } });
    send("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    send("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: "PONG" });
    send("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: "PONG" });
    send("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
  }
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: response("completed", [item]) });
  res.end();
};

/**
 * A stand-in model relay and endpoint (Anthropic Messages, OpenAI Chat Completions or Responses, by the path): logs the
 * path, the body's model, the request's header names and whether each key header held the handle; answers a request
 * offering a shell tool (`Bash`, `shell`), with no tool result yet, by running `env > /workspace/shell-env.txt` in it,
 * and anything else with the text PONG.
 */
const relay = (req, res, url) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const api = apiOf(url.pathname);
    const tool = shellToolOf(api, parsed);
    // Google's model is in the path, not the body.
    const model = parsed.model ?? /\/models\/([^/:]+):/.exec(url.pathname)?.[1] ?? null;
    log({ event: "model-relay", method: req.method, path: url.pathname, query: url.search, api, model, messages: (parsed.messages ?? parsed.input ?? parsed.contents ?? []).length, headers: Object.keys(req.headers).sort(), ...keysOf(req), bash: tool !== undefined, tools: (parsed.tools ?? []).map((t) => t.name ?? t.function?.name ?? (t.functionDeclarations ?? []).map((d) => d.name).join(",")) });
    if (url.pathname.endsWith("/count_tokens")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
    if (api === "google") return answerGoogle(res, tool);
    if (api === "completions") return answerCompletions(res, parsed, tool);
    if (api === "responses") return answerResponses(res, parsed, tool);
    answerMessages(res, parsed, tool);
  });
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://computer.internal");
    if (url.pathname.startsWith("/t3flare/model/") && HANDLES.length > 0) {
      relay(req, res, url);
      return;
    }
    log({ event: "http", method: req.method, path: url.pathname, ...keysOf(req) });
    res.writeHead(404).end();
  })
  .listen(80);

const proxy = http.createServer((req, res) => {
  log({ event: "proxy-http", method: req.method, url: req.url });
  res.writeHead(403).end();
});
proxy.on("connect", (req, socket, head) => {
  const [host, port] = req.url.split(":");
  log({ event: "connect", host, port: Number(port) });
  const upstream = net.connect(Number(port) || 443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
proxy.listen(3128);

const dns = dgram.createSocket("udp4");
dns.on("message", (msg, rinfo) => {
  let at = 12;
  const labels = [];
  while (msg[at] !== 0 && at < msg.length) {
    labels.push(msg.subarray(at + 1, at + 1 + msg[at]).toString());
    at += msg[at] + 1;
  }
  log({ event: "dns", name: labels.join(".") });
  const reply = Buffer.from(msg);
  reply[2] = 0x81;
  reply[3] = 0x83;
  dns.send(reply, rinfo.port, rinfo.address);
});
dns.bind(53);
log({ event: "ready" });
