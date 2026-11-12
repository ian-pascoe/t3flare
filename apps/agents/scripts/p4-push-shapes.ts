// SPI-992 M0 probe P4: the request shapes git sends to a smart-HTTP receive-pack (gzip, chunked above
// `http.postBuffer`, `probe_rpc`, `Expect`, push options, `--atomic`, `--signed`, delete, force), recorded by a small
// server in front of `git http-backend` over a local bare repo. Writes the shapes as JSON and the receive-pack request
// prefixes (up to the pack) as base64 fixtures for the gateway's parser tests.
//
//   bun apps/agents/scripts/p4-push-shapes.ts <out.json> <fixtures-dir>
//
// No network, no credentials: git runs with GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const [out = "p4.json", fixtures = "fixtures"] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "p4-"));
const bare = path.join(root, "remote.git");
const work = path.join(root, "work");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: root };
const git = (cwd: string, ...args: Array<string>) => {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();

git(root, "init", "-q", "--bare", "-b", "main", bare);
git(bare, "config", "http.receivepack", "true");
fs.mkdirSync(work);
git(work, "init", "-q", "-b", "main");
git(work, "config", "user.name", "p4");
git(work, "config", "user.email", "p4@example.invalid");

interface Seen {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  bodyBytes: number;
  prefix: string; // base64, up to and including the first flush (or 4 KiB)
  prefixText: string;
}
let seen: Array<Seen> = [];

const flushEnd = (bytes: Uint8Array): number => {
  // pkt-line walk to the first `0000`, and to the second when the commands asked for `push-options` (their section).
  let at = 0;
  let flushes = new TextDecoder().decode(bytes.subarray(0, 600)).includes(" push-options") ? 2 : 1;
  while (at + 4 <= bytes.length) {
    const len = Number.parseInt(new TextDecoder().decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(len)) return Math.min(bytes.length, 4096);
    if (len === 0) {
      flushes -= 1;
      if (flushes === 0) return at + 4;
      at += 4;
      continue;
    }
    at += len;
  }
  return Math.min(bytes.length, 4096);
};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    const raw = headers["content-encoding"] === "gzip" ? Bun.gunzipSync(body) : body;
    const end = flushEnd(raw);
    seen.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      headers,
      bodyBytes: body.length,
      prefix: Buffer.from(raw.subarray(0, end)).toString("base64"),
      prefixText: new TextDecoder().decode(raw.subarray(0, Math.min(end, 600))).replace(/\0/g, "\\0"),
    });
    const child = spawn(path.join(execPath, "git-http-backend"), [], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: headers["content-type"] ?? "",
        ...(headers["content-encoding"] === undefined ? {} : { HTTP_CONTENT_ENCODING: headers["content-encoding"] }),
        ...(headers["git-protocol"] === undefined ? {} : { GIT_PROTOCOL: headers["git-protocol"] }),
        REMOTE_USER: "p4",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    child.stdin.end(body);
    const chunks: Array<Buffer> = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    const all = Buffer.concat(chunks);
    const split = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, split).toString();
    const status = /^Status: (\d+)/m.exec(head)?.[1] ?? "200";
    const out = new Headers();
    for (const line of head.split("\r\n")) {
      const at = line.indexOf(":");
      if (at > 0 && !line.startsWith("Status")) out.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    return new Response(all.subarray(split + 4), { status: Number(status), headers: out });
  },
});
const remote = `http://127.0.0.1:${server.port}/remote.git`;

const run = async (name: string, setup: () => void, ...args: Array<string>) => {
  seen = [];
  setup();
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("git", args, { cwd: work, env: { ...env, GIT_TRACE_CURL: "", GIT_CURL_VERBOSE: "" } });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.on("close", (code) => resolve({ code, out: text.trim() }));
  });
  const posts = seen.filter((s) => s.method === "POST" && s.path.endsWith("git-receive-pack"));
  posts.forEach((post, i) => fs.writeFileSync(path.join(fixtures, `${name}${posts.length > 1 ? `-${i}` : ""}.prefix.b64`), post.prefix));
  return { name, argv: args, exitCode: result.code, gitOutput: result.out.slice(-800), requests: seen };
};

const commit = (file: string, bytes = 16) => () => {
  fs.writeFileSync(path.join(work, file), Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))));
  git(work, "add", file);
  git(work, "commit", "-qm", file);
};
const none = () => {};

fs.mkdirSync(fixtures, { recursive: true });
const results = [];
results.push(await run("first", commit("a"), "push", remote, "HEAD:refs/heads/main"));
results.push(await run("t3-form", commit("b"), "push", "--", remote, "HEAD:refs/heads/spi992/t3"));
results.push(await run("delete", none, "push", remote, "--delete", "refs/heads/spi992/t3"));
results.push(await run("atomic-two", commit("c"), "push", "--atomic", remote, "HEAD:refs/heads/main", "HEAD:refs/heads/spi992/two"));
results.push(await run("push-option", commit("d"), "-c", "receive.advertisePushOptions=true", "push", "-o", "ci.skip", "-o", "x=y", remote, "HEAD:refs/heads/main"));
git(bare, "config", "receive.advertisePushOptions", "true");
results.push(await run("push-option-advertised", commit("e"), "push", "-o", "ci.skip", remote, "HEAD:refs/heads/main"));
results.push(await run("force", () => { git(work, "commit", "-q", "--amend", "-m", "amended"); }, "push", "--force", remote, "HEAD:refs/heads/main"));
results.push(await run("force-with-lease", commit("f"), "push", "--quiet", `--force-with-lease=refs/heads/main`, remote, "HEAD:refs/heads/main"));
results.push(await run("tag", () => git(work, "tag", "v1"), "push", remote, "refs/tags/v1"));
results.push(await run("signed", none, "push", "--signed", remote, "HEAD:refs/heads/spi992/signed"));
// Above http.postBuffer (1 MiB by default): chunked, with probe_rpc first when the server needs auth (not here).
results.push(await run("large", commit("big", 3 * 1024 * 1024), "push", remote, "HEAD:refs/heads/main"));
results.push(await run("large-small-buffer", commit("big2", 300 * 1024), "-c", "http.postBuffer=65536", "push", remote, "HEAD:refs/heads/main"));
results.push(await run("up-to-date", none, "push", remote, "HEAD:refs/heads/main"));

server.stop(true);
const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
fs.writeFileSync(out, `${JSON.stringify({ probe: "P4", git: version, at: new Date().toISOString(), results }, null, 2)}\n`);
console.log(results.map((r) => `${r.name}: exit ${r.exitCode}, ${r.requests.map((q) => `${q.method} ${q.path}${q.query} ${q.headers["content-encoding"] ?? "-"} ${q.headers["transfer-encoding"] ?? q.headers["content-length"] ?? "?"} ${q.headers.expect ?? ""}`).join(" | ")}`).join("\n"));
fs.rmSync(root, { recursive: true, force: true });
