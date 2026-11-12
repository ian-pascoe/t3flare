// A smart-HTTP git server over a local bare repo (`git http-backend` as CGI) and a Node HTTP server in front of a
// fetch-style handler, for the push gateway's tests: real git on both ends, no network, no credentials.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const gitEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

export const gitSync = (cwd: string, env: NodeJS.ProcessEnv, ...args: Array<string>): string => {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

export const gitAsync = (cwd: string, env: NodeJS.ProcessEnv, ...args: Array<string>): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("close", (code) => resolve({ code, output }));
  });

/** A bare repo `<root>/<owner>/<name>.git` answered by `git http-backend`; requests it saw, with their headers. */
export const makeUpstream = (root: string, owner: string, name: string) => {
  const env = gitEnv(root);
  const bare = path.join(root, owner, `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  gitSync(root, env, "init", "-q", "--bare", "-b", "main", bare);
  gitSync(bare, env, "config", "http.receivepack", "true");
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const seen: Array<{ readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly redirect: string | undefined }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    seen.push({ url: request.url, method: request.method, headers, redirect: init?.redirect });
    if (url.origin !== "https://github.com") return new Response("not github", { status: 599 });
    const body = request.body === null ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    const child = spawn(path.join(execPath, "git-http-backend"), [], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: headers["content-type"] ?? "",
        REMOTE_USER: "x",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    child.stdin.end(body);
    const chunks: Array<Buffer> = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    const all = Buffer.concat(chunks);
    const split = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, split).toString();
    const out = new Headers();
    for (const line of head.split("\r\n")) {
      const at = line.indexOf(":");
      if (at > 0 && !line.startsWith("Status")) out.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    return new Response(all.subarray(split + 4), { status: Number(/^Status: (\d+)/m.exec(head)?.[1] ?? "200"), headers: out });
  };
  return { bare, fetch, seen, refs: () => gitSync(bare, env, "for-each-ref", "--format=%(refname) %(objectname)") };
};

/** Serves `handler` on 127.0.0.1 (streamed request bodies, as workerd hands them to a fetch handler). */
export const serve = async (handler: (request: Request) => Promise<Response>) => {
  const server = http.createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    // The client going away (git killed) errors the body and aborts the request's signal, as workerd does.
    const gone = new AbortController();
    let ended = false;
    req.on("end", () => (ended = true));
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    const body = hasBody
      ? (new ReadableStream({
          start(controller) {
            const safely = (act: () => void) => {
              try {
                act();
              } catch {
                /* the handler cancelled the body */
              }
            };
            req.on("data", (chunk: Buffer) => safely(() => controller.enqueue(new Uint8Array(chunk))));
            req.on("end", () => safely(() => controller.close()));
            req.on("close", () => {
              if (!ended) safely(() => controller.error(new Error("client went away")));
            });
          },
        }) as ReadableStream<Uint8Array>)
      : null;
    const response = await handler(new Request(url, { method: req.method, headers, body, signal: gone.signal, ...(hasBody ? { duplex: "half" } : {}) } as RequestInit));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
};

export const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
