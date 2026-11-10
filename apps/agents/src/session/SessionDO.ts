// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off
// The Session DO (ADR-0005, step 2a plan): one Durable agent's conversation, a pi-durable Harness, per t3 thread.
// M0: the object and its binding back to the Environment DO; the Harness arrives in M1.
import { DurableObject } from "cloudflare:workers";

import type { EnvironmentRpc } from "../environment.ts";
import { environmentStub } from "../environment.ts";

export interface SessionEnv {
  readonly ENVIRONMENT: DurableObjectNamespace;
}

export class SessionDO extends DurableObject<SessionEnv> {
  /** M0's check: the Environment calls this, and it calls the Environment back over its own binding. */
  async ping(echo: string): Promise<{ readonly session: string; readonly echo: string; readonly environment: unknown }> {
    const environment: EnvironmentRpc = environmentStub(this.env.ENVIRONMENT);
    return { session: this.ctx.id.toString(), echo, environment: await environment.agentsPing(`from session ${echo}`) };
  }
}
