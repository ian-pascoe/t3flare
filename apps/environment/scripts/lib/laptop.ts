// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off globalTimers:off nodeBuiltinImport:off
// Step 3: the "laptop" of a Peer link, headless on this machine: a stock t3 server from npm at an exact version, in a
// temporary base directory and loopback port (plan section 2.1, M0 R2). Driven through its own CLI (`t3 auth pairing
// create`, `t3 environment link`) and its own WebSocket protocol, as the owner's desktop drives its bundled server.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { clientAt, sleep } from "./client.ts";

export interface LaptopOptions {
  readonly version: string;
  readonly port: number;
  /** Its base directory (T3CODE_HOME); made if missing. */
  readonly dir: string;
  /** The working directory the server starts in. */
  readonly cwd?: string;
  /** More environment for the server process (the Pi provider's agent directory, the proxy key). */
  readonly env?: Readonly<Record<string, string>>;
}

export class Laptop {
  readonly options: LaptopOptions;
  readonly url: URL;
  readonly client: ReturnType<typeof clientAt>;
  #process: ChildProcess | undefined;
  #log: fs.WriteStream | undefined;

  constructor(options: LaptopOptions) {
    this.options = options;
    this.url = new URL(`http://127.0.0.1:${options.port}`);
    this.client = clientAt(this.url);
  }

  get logFile(): string {
    return path.join(this.options.dir, "serve.log");
  }

  /** `t3 <args>` at this version against this base directory; its stdout. Throws on a non-zero exit. */
  cli(args: ReadonlyArray<string>, options: { readonly allowFailure?: boolean } = {}): { readonly status: number; readonly stdout: string; readonly stderr: string } {
    fs.mkdirSync(this.options.dir, { recursive: true });
    const result = spawnSync("npx", ["-y", `t3@${this.options.version}`, ...args, "--base-dir", this.options.dir], {
      encoding: "utf8",
      // Outside this repo: npx in a workspace reads its package.json.
      cwd: this.options.dir,
      env: { ...process.env, ...this.options.env },
      timeout: 120_000,
    });
    const answer = { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    if (answer.status !== 0 && options.allowFailure !== true) {
      throw new Error(`t3 ${args[0]} ${args[1] ?? ""} exited ${answer.status}: ${answer.stderr.slice(-600)}`);
    }
    return answer;
  }

  /** Starts `t3 serve` and waits until its descriptor answers. */
  async start(): Promise<{ readonly environmentId: string; readonly serverVersion: string }> {
    fs.mkdirSync(this.options.dir, { recursive: true });
    const cwd = this.options.cwd ?? path.join(this.options.dir, "work");
    fs.mkdirSync(cwd, { recursive: true });
    this.#log = fs.createWriteStream(this.logFile, { flags: "a" });
    const child = spawn(
      "npx",
      ["-y", `t3@${this.options.version}`, "serve", "--base-dir", this.options.dir, "--port", String(this.options.port), "--host", "127.0.0.1", "--no-browser", cwd],
      { cwd: this.options.dir, env: { ...process.env, ...this.options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.pipe(this.#log);
    child.stderr?.pipe(this.#log);
    this.#process = child;
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const descriptor = await this.descriptor().catch(() => undefined);
      if (descriptor !== undefined) return descriptor;
      if (child.exitCode !== null) throw new Error(`t3 serve exited ${child.exitCode}; see ${this.logFile}`);
      await sleep(500);
    }
    throw new Error(`t3 serve did not answer within 120 s; see ${this.logFile}`);
  }

  async descriptor(): Promise<{ readonly environmentId: string; readonly serverVersion: string; readonly [key: string]: unknown }> {
    const response = await fetch(new URL("/.well-known/t3/environment", this.url));
    if (response.status !== 200) throw new Error(`descriptor ${response.status}`);
    return (await response.json()) as never;
  }

  /** Stops the server (its whole process group, `npx` and node) and waits for it to go. */
  async stop(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    if (child?.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    const started = Date.now();
    while (child.exitCode === null && child.signalCode === null && Date.now() - started < 15_000) await sleep(200);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await sleep(500);
  }

  /** A pairing token from the server's CLI (`t3 auth pairing create`), exchanged for a browser session's cookie. */
  async pair(): Promise<string> {
    const issued = JSON.parse(this.cli(["auth", "pairing", "create", "--json", "--label", "t3flare harness"]).stdout) as { credential?: string; token?: string };
    const credential = issued.credential ?? issued.token;
    if (credential === undefined) throw new Error("t3 auth pairing create printed no credential");
    const response = await fetch(new URL("/api/auth/browser-session", this.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.url.origin },
      body: JSON.stringify({ credential }),
    });
    if (response.status !== 200) throw new Error(`laptop pairing failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  }
}
