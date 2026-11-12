# SPI-992 M2's hostile capture: a plain-HTTP forward proxy (git's `http.proxy`) that records every request and answer,
# headers and bodies, to <dir>/<n>-<METHOD>-{head,body,answer}, and forwards it unchanged.
#   python3 logproxy.py <port> <dir>
import http.client
import os
import socketserver
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

PORT = int(sys.argv[1])
DIR = sys.argv[2]
os.makedirs(DIR, exist_ok=True)
COUNT = [0]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _forward(self):
        COUNT[0] += 1
        name = os.path.join(DIR, "%03d-%s" % (COUNT[0], self.command))
        body = self._body()
        with open(name + "-head", "w") as f:
            f.write("%s %s\n%s" % (self.command, self.path, str(self.headers)))
        with open(name + "-body", "wb") as f:
            f.write(body)
        url = urlsplit(self.path)
        conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=900)
        headers = {
            k: v
            for k, v in self.headers.items()
            if k.lower()
            not in ("proxy-connection", "transfer-encoding", "content-length")
        }
        conn.request(
            self.command,
            url.path + ("?" + url.query if url.query else ""),
            body=body if body else None,
            headers=headers,
        )
        answer = conn.getresponse()
        data = answer.read()
        with open(name + "-answer", "wb") as f:
            f.write(("%d\n%s\n" % (answer.status, str(answer.headers))).encode() + data)
        self.send_response(answer.status)
        for k, v in answer.getheaders():
            if k.lower() not in ("transfer-encoding", "content-length", "connection"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _forward
    do_POST = _forward

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


Server(("127.0.0.1", PORT), Handler).serve_forever()
