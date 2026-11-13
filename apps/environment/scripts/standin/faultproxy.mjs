// SPI-1061 C6: the stand-in's front door. A byte-for-byte TCP relay from the tunnel's origin port (3773) to t3 (3774),
// so `Host`, `X-Forwarded-Proto` and streaming answers pass as cloudflared sends them. While /tmp/fault names a fault,
// a request whose line matches it has its connection cut, as a dropped Route cuts one mid-request:
//   signin  POST /oauth/mcp/token (a link's sign-in, after the descriptor and the decision answered)
//   call    POST /mcp (a forwarded call)
import * as fs from "node:fs";
import * as net from "node:net";

const FAULTS = { signin: /^POST \/oauth\/mcp\/token /m, call: /^POST \/mcp /m };
const fault = () => {
  try {
    return FAULTS[fs.readFileSync("/tmp/fault", "utf8").trim()];
  } catch {
    return undefined;
  }
};

net
  .createServer((client) => {
    const upstream = net.connect(3774, "127.0.0.1");
    client.on("data", (chunk) => {
      const pattern = fault();
      if (pattern !== undefined && pattern.test(chunk.toString("latin1"))) {
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(chunk);
    });
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  })
  .listen(3773, "0.0.0.0");
