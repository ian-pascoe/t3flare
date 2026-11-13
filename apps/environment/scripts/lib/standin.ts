// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off globalTimers:off nodeBuiltinImport:off
// SPI-1061 (plan §8, D16, D21): the stage stand-in for the owner's laptop. A stock `t3` from npm at an exact version, in
// a Docker container on this machine (never as the owner's user, never against his home), with t3's Pi provider on the
// model proxy, reachable from the cloud over the stage's named Cloudflare Tunnel (`T3FLARE_STANDIN=1` on deploy; its
// token in `.alchemy/stages/<stage>.standin.json`, read here and handed to the container's environment, never printed).
// The harness reaches the same t3 at a loopback port, so it can watch while the connector is stopped. From step 3's
// `lib/laptop.ts`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { standinFile } from "../../stage-files.ts";
import { clientAt, sleep } from "./client.ts";

export const STANDIN_T3_VERSION = "0.1.10-nightly.20261112.4606";
export const STANDIN_PI_VERSION = "1.5.2";
export const STANDIN_MODEL = { instanceId: "pi", model: "anthropic/claude-haiku-5-5" };

const docker = (args: ReadonlyArray<string>, options: { readonly env?: Record<string, string>; readonly input?: string; readonly allowFailure?: boolean; readonly timeoutMs?: number } = {}) => {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    ...(options.input === undefined ? {} : { input: options.input }),
    timeout: options.timeoutMs ?? 600_000,
  });
  const answer = { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (answer.status !== 0 && options.allowFailure !== true) throw new Error(`docker ${args[0]} exited ${answer.status}: ${answer.stderr.slice(-600)}`);
  return answer;
};

export interface StandinOptions {
  readonly stage: string;
  /** The loopback port the harness reaches the container's t3 at. */
  readonly localPort: number;
  readonly version?: string;
}

export class Standin {
  readonly stage: string;
  readonly version: string;
  readonly name: string;
  readonly image: string;
  readonly local: URL;
  readonly client: ReturnType<typeof clientAt>;
  readonly #tunnel: { readonly host: string; readonly token: string };

  constructor(options: StandinOptions) {
    this.stage = options.stage;
    this.version = options.version ?? STANDIN_T3_VERSION;
    this.name = `t3flare-standin-${options.stage}`;
    this.image = `t3flare-standin:${this.version}`;
    this.local = new URL(`http://127.0.0.1:${options.localPort}`);
    this.client = clientAt(this.local);
    const file = standinFile(options.stage);
    if (!fs.existsSync(file)) throw new Error(`no stand-in tunnel for stage ${options.stage}: deploy it with T3FLARE_STANDIN=1`);
    this.#tunnel = JSON.parse(fs.readFileSync(file, "utf8")) as { host: string; token: string };
  }

  /** The Route the cloud links over: the tunnel's hostname, plain https, no Access in front. */
  get publicUrl(): URL {
    return new URL(`https://${this.#tunnel.host}`);
  }

  /** The tunnel's token, for the leak scan's canaries only. */
  get tunnelToken(): string {
    return this.#tunnel.token;
  }

  build(): void {
    docker(
      ["build", "-q", "--build-arg", `T3_VERSION=${this.version}`, "--build-arg", `PI_VERSION=${STANDIN_PI_VERSION}`, "-t", this.image, path.join(import.meta.dirname, "../standin")],
      { timeoutMs: 1_800_000 },
    );
  }

  /** Starts a fresh container (any earlier one of this stage is removed), its t3 and its connector. */
  async start(): Promise<{ readonly environmentId: string; readonly label: string }> {
    if (!process.env.MODEL_PROXY_URL || !process.env.MODEL_PROXY_API_KEY) throw new Error("the stand-in's agent needs MODEL_PROXY_URL and MODEL_PROXY_API_KEY (stage.ts run)");
    if (docker(["image", "inspect", this.image], { allowFailure: true }).status !== 0) this.build();
    docker(["rm", "-f", this.name], { allowFailure: true });
    // Values by name only (`-e NAME`), so no secret is on a command line.
    docker(
      ["run", "-d", "--name", this.name, "--hostname", "standin-laptop", "--memory", "2g", "-p", `127.0.0.1:${this.local.port}:3774`, "-e", "MODEL_PROXY_API_KEY", "-e", "TUNNEL_TOKEN", this.image],
      { env: { TUNNEL_TOKEN: this.#tunnel.token } },
    );
    // t3's Pi provider on the model proxy: the key is named, never written (`$MODEL_PROXY_API_KEY`).
    docker(["exec", "-i", this.name, "sh", "-c", "mkdir -p /data/pi-agent && cat > /data/pi-agent/models.json"], {
      input: JSON.stringify({ providers: { anthropic: { baseUrl: process.env.MODEL_PROXY_URL, apiKey: "$MODEL_PROXY_API_KEY" } } }),
    });
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      const descriptor = await this.descriptor().catch(() => undefined);
      if (descriptor !== undefined) {
        this.connectorStart();
        return { environmentId: descriptor.environmentId, label: String(descriptor.label) };
      }
      await sleep(1000);
    }
    throw new Error(`the stand-in's t3 did not answer within 180 s: ${this.logs().slice(-1500)}`);
  }

  /** The descriptor, at the loopback port or (`public`) over the tunnel. */
  async descriptor(at: "local" | "public" = "local"): Promise<{ readonly environmentId: string; readonly label: unknown; readonly [key: string]: unknown }> {
    const response = await fetch(new URL("/.well-known/t3/environment", at === "local" ? this.local : this.publicUrl));
    if (response.status !== 200) throw new Error(`descriptor ${response.status}`);
    return (await response.json()) as never;
  }

  /** Starts the container's `cloudflared` (the laptop's tunnel connector); its token is the container's own variable. */
  connectorStart(): void {
    docker(["exec", "-d", this.name, "cloudflared", "--no-autoupdate", "tunnel", "run"]);
  }

  /** Cuts the Route's connections for one kind of request (`signin`, `call`), or none (C6; standin/faultproxy.mjs). */
  fault(kind: "signin" | "call" | "none"): void {
    docker(["exec", this.name, "sh", "-c", kind === "none" ? "rm -f /tmp/fault" : `echo ${kind} > /tmp/fault`]);
  }

  /** Stops the connector: Cloudflare then answers 530 at the Route, as for a laptop asleep. */
  connectorStop(): void {
    docker(["exec", this.name, "pkill", "-f", "cloudflared"], { allowFailure: true });
  }

  /**
   * Waits until the Route answers as this t3 (`up`), or answers Cloudflare's 530 for a tunnel with no connector (`down`;
   * a 502 comes first while the connector's connections drain).
   */
  async awaitRoute(state: "up" | "down", timeoutMs = 120_000): Promise<{ readonly ms: number; readonly status: number | string }> {
    const started = Date.now();
    let status: number | string = "none";
    while (Date.now() - started < timeoutMs) {
      status = await fetch(new URL("/.well-known/t3/environment", this.publicUrl)).then((r) => r.status, (e: Error) => e.message);
      if (state === "up" ? status === 200 : status === 530) return { ms: Date.now() - started, status };
      await sleep(2000);
    }
    throw new Error(`the Route did not go ${state} within ${timeoutMs} ms (last: ${status})`);
  }

  /** `t3 <args>` in the container against its base directory. */
  cli(args: ReadonlyArray<string>): string {
    return docker(["exec", this.name, "t3", ...args, "--base-dir", "/data"]).stdout;
  }

  /** A browser session on the stand-in, from a pairing token its CLI makes (the owner's own client there). */
  async pair(): Promise<string> {
    const issued = JSON.parse(this.cli(["auth", "pairing", "create", "--json", "--label", "t3flare harness"])) as { credential?: string; token?: string };
    const credential = issued.credential ?? issued.token;
    if (credential === undefined) throw new Error("t3 auth pairing create printed no credential");
    const response = await fetch(new URL("/api/auth/browser-session", this.local), {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.local.origin },
      body: JSON.stringify({ credential }),
    });
    if (response.status !== 200) throw new Error(`stand-in pairing failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  }

  logs(): string {
    return docker(["logs", "--tail", "400", this.name], { allowFailure: true }).stdout + docker(["logs", "--tail", "400", this.name], { allowFailure: true }).stderr;
  }

  /** A command's output in the container (the leak scan reads its files and processes). */
  exec(script: string): string {
    return docker(["exec", this.name, "sh", "-c", script], { allowFailure: true, timeoutMs: 120_000 }).stdout;
  }

  stop(): void {
    docker(["rm", "-f", this.name], { allowFailure: true });
  }
}
