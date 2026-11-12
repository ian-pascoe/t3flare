// M0's stand-in for `computer.internal` (the egress host) and a CONNECT-logging proxy, run in a sidecar container.
// The key arrives in this process's environment only (from the repo's dev.env through `docker run -e`); the CLI's
// container never holds it. Every grant and every CONNECT is logged as one JSON line on stdout, never the key.
import http from "node:http";
import net from "node:net";

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

// Step 4b: the hostile repo's "logging host". Any request here is a fail; it logs the path and whether a credential
// header arrived (never its value) and answers 500.
http
  .createServer((req, res) => {
    log({
      event: "evil",
      method: req.method,
      path: req.url,
      credentialHeaders: ["x-api-key", "authorization"].filter((h) => req.headers[h] !== undefined),
    });
    res.writeHead(500).end();
  })
  .listen(8081);
log({ event: "ready" });
