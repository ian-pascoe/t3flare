// test:docker's stand-in for `computer.internal` (the egress host), in a sidecar container, from step 4a M0's probe:
// - the key route: the model key for the expected nonce only (as the Workspace DO's gate), 403 otherwise;
// - a CONNECT proxy on :3128, the CLI network's only way out, logging every host it tunnels to;
// - a resolver on :53 that logs every name asked and answers NXDOMAIN (the CLI network has no route out).
// - with KEYHOST_MODEL_HANDLE (SPI-1168), a stand-in model relay and Anthropic endpoint under /t3flare/model/.
// The key is in this process's environment only; every event is one JSON line on stdout, never the key.
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";

const KEY = process.env.KEYHOST_MODEL_KEY ?? "";
const NONCES = new Set((process.env.KEYHOST_NONCES ?? "").split(",").filter((nonce) => nonce !== ""));
const log = (entry) => console.log(JSON.stringify({ at: Date.now(), ...entry }));
/** SPI-1168: the model handle the stand-in model relay expects (claudeRelay.docker.test.ts); never logged. */
const HANDLE = process.env.KEYHOST_MODEL_HANDLE ?? "";

/**
 * A stand-in model relay and Anthropic Messages endpoint: logs the path, the body's model, whether each key header held
 * the handle; answers a request offering the Bash tool, with no tool result yet, by running
 * `env > /workspace/shell-env.txt` in Bash, and anything else with the text PONG.
 */
const relay = (req, res, url) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const messages = parsed.messages ?? [];
    const answered = messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"));
    const bash = parsed.stream === true && !answered && (parsed.tools ?? []).some((tool) => tool.name === "Bash");
    log({ event: "model-relay", method: req.method, path: url.pathname, model: parsed.model ?? null, apiKeyIsHandle: req.headers["x-api-key"] === HANDLE, bearerIsHandle: req.headers.authorization === `Bearer ${HANDLE}`, bash });
    if (url.pathname.endsWith("/count_tokens")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
    const id = `msg_${Date.now()}`;
    if (parsed.stream !== true) {
      // A request that does not stream (Claude Code's check of a model it is switched to): one text message.
      const message = { id, type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text: "PONG" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } };
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    }
    const block = bash ? { type: "tool_use", id: `toolu_${Date.now()}`, name: "Bash", input: {} } : { type: "text", text: "" };
    const delta = bash ? { type: "input_json_delta", partial_json: JSON.stringify({ command: "env > /workspace/shell-env.txt", description: "Write the environment" }) } : { type: "text_delta", text: "PONG" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
    event("content_block_start", { index: 0, content_block: block });
    event("content_block_delta", { index: 0, delta });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: bash ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    event("message_stop", {});
    res.end();
  });
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://computer.internal");
    if (url.pathname === "/t3flare/model-key") {
      const nonce = req.headers["x-t3flare-nonce"] ?? "";
      const granted = KEY !== "" && NONCES.has(nonce);
      log({ event: "model-key", cli: url.searchParams.get("cli"), granted });
      res.writeHead(granted ? 200 : 403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(granted ? KEY : "");
      return;
    }
    if (url.pathname.startsWith("/t3flare/model/") && HANDLE !== "") {
      relay(req, res, url);
      return;
    }
    log({ event: "http", method: req.method, path: url.pathname });
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
