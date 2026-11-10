// The agents Worker's view of the Environment DO (ADR-0005): the RPC methods it calls, typed here so the agents Worker
// never imports the environment Worker's code. One Environment DO per deploy, named "environment" (ADR-0002).
export { ENVIRONMENT_NAME } from "@t3flare/session-protocol";
import { ENVIRONMENT_NAME } from "@t3flare/session-protocol";

import type { SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";

export interface EnvironmentRpc {
  agentsPing(message: string): Promise<{ readonly environment: string; readonly message: string }>;
  /** The Session's committed state (ADR-0005). */
  sessionPush(push: SessionPush): Promise<SessionPushAnswer>;
}

export const environmentStub = (namespace: DurableObjectNamespace): EnvironmentRpc =>
  namespace.get(namespace.idFromName(ENVIRONMENT_NAME)) as unknown as EnvironmentRpc;
