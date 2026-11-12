// M0's stand-in for `computer.internal` (the egress host) and a CONNECT-logging proxy, run in a sidecar container.
// The key arrives in this process's environment only (from the repo's dev.env through `docker run -e`); the CLI's
// container never holds it. Every grant and every CONNECT is logged as one JSON line on stdout, never the key.
import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";

const KEY = process.env.PROBE_MODEL_KEY ?? "";
let grants = 0;
const log = (entry) => console.log(JSON.stringify({ at: Date.now(), ...entry }));

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://computer.internal");
    if (url.pathname === "/t3flare/model-key") {
      grants++;
      log({ event: "model-key", cli: url.searchParams.get("cli"), nonce: req.headers["x-t3flare-nonce"] ?? null, grants });
      res.writeHead(KEY === "" ? 403 : 200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(KEY);
      return;
    }
    log({ event: "http", method: req.method, path: url.pathname });
    res.writeHead(404).end();
  })
  .listen(80);

// The CONNECT logger: every tunnel a CLI opens through HTTPS_PROXY, by host. Plain HTTP requests are logged too.
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
// A logging resolver: every DNS name asked is logged, and answered NXDOMAIN (the CLI network has no route out anyway).
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
