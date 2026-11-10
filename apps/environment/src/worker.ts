// @effect-diagnostics globalDate:off globalConsole:off
// The environment Worker (ADR-0014): the front door, the Environment DO, and the t3 web
// client as static assets. Kept tiny: t3 itself loads inside the DO, on first use.
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";

import { bindStateStorage } from "./platform/stateStore.ts";
import type { Runtime } from "./runtime.ts";

export interface Env {
  readonly ENVIRONMENT: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly T3_BOOTSTRAP_TOKEN?: string;
  readonly T3FLARE_ADMIN_TOKEN?: string;
}

/** Paths t3's server answers; everything else is the web client (t3's DEV_PROXIED_PATH_PREFIXES). */
const SERVER_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp", "/_t3flare"];
const isServerPath = (pathname: string) =>
  SERVER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

/** One Environment DO per deploy (ADR-0002). */
const ENVIRONMENT_NAME = "environment";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (isServerPath(url.pathname)) {
      return env.ENVIRONMENT.getByName(ENVIRONMENT_NAME).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class EnvironmentDO extends DurableObject<Env> {
  #runtime: Promise<Runtime> | undefined;
  #stats = { constructedAt: Date.now(), importMs: 0, bootMs: 0, firstRequestAt: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Before any t3 code runs: the `node:fs` shim and FileSystem Layer read this.
    bindStateStorage(ctx.storage.sql);
  }

  #boot(): Promise<Runtime> {
    this.#runtime ??= (async () => {
      this.#stats.firstRequestAt = Date.now();
      const importStarted = performance.now();
      const { boot } = await import("./runtime.ts");
      this.#stats.importMs = performance.now() - importStarted;
      const runtime = await boot({ storage: this.ctx.storage, bootstrapToken: this.env.T3_BOOTSTRAP_TOKEN });
      this.#stats.bootMs = runtime.bootMs;
      console.log(JSON.stringify({ t3flare: "booted", ...this.#stats }));
      return runtime;
    })().catch((error) => {
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_t3flare/")) {
      const { handleAdmin } = await import("./admin.ts");
      return handleAdmin(request, {
        ctx: this.ctx,
        env: this.env,
        stats: this.#stats,
        runtime: () => this.#boot(),
      });
    }
    try {
      const runtime = await this.#boot();
      return await runtime.fetch(request);
    } catch (error) {
      console.error("t3flare: request failed", error, (error as { cause?: unknown })?.cause);
      return new Response(`t3flare: ${String(error)}\n${String((error as { cause?: unknown })?.cause ?? "")}`, {
        status: 500,
      });
    }
  }
}
