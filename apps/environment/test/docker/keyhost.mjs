// test:docker's stand-in for `computer.internal` (the egress host), in a sidecar container, from step 4a M0's probe:
// - the key route: the model key for the expected nonce only (as the Workspace DO's gate), 403 otherwise;
// - a CONNECT proxy on :3128, the CLI network's only way out, logging every host it tunnels to;
// - a resolver on :53 that logs every name asked and answers NXDOMAIN (the CLI network has no route out).
// The key is in this process's environment only; every event is one JSON line on stdout, never the key.
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";

const KEY = process.env.KEYHOST_MODEL_KEY ?? "";
const NONCES = new Set((process.env.KEYHOST_NONCES ?? "").split(",").filter((nonce) => nonce !== ""));
const log = (entry) => console.log(JSON.stringify({ at: Date.now(), ...entry }));

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
