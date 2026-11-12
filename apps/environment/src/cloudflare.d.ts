// The Workers runtime APIs this package uses, typed from the module form of
// @cloudflare/workers-types so its globals stay out of t3's Node-typed program.
declare module "cloudflare:workers" {
  import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
  }
  /** A named entrypoint other Workers reach over a service binding (the harness panel's, ADR-0026). */
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
