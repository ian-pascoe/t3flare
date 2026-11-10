// Where Session pushes land (ADR-0005; step 2a plan, section 2): `EnvironmentDO.sessionPush` hands each push here, and
// the provider adapter's open sessions register for their Session. A push for a Session with no open provider session
// is acknowledged and dropped (the adapter pulls a snapshot when it opens one), and its live turns are orphans: t3 has
// no open run for them, so the Session aborts them. Module state, cleared at each boot: registrations belong to one t3
// runtime.
import type { SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";

export type PushHandler = (push: SessionPush) => Promise<SessionPushAnswer>;

const handlers = new Map<string, PushHandler>();

export const registerSession = (sessionName: string, handler: PushHandler): (() => void) => {
  handlers.set(sessionName, handler);
  return () => {
    if (handlers.get(sessionName) === handler) handlers.delete(sessionName);
  };
};

/** Forget every registration: a new t3 runtime is booting. */
export const resetSessions = (): void => {
  handlers.clear();
};

export const deliverPush = async (sessionName: string, push: SessionPush): Promise<SessionPushAnswer> => {
  const handler = handlers.get(sessionName);
  if (handler !== undefined) return handler(push);
  const orphans = Object.entries(push.turns)
    .filter(([, turn]) => turn.status === "queued" || turn.status === "running")
    .map(([id]) => id);
  return orphans.length === 0 ? { ok: true } : { ok: true, orphans };
};

export const registeredSessions = (): ReadonlyArray<string> => [...handlers.keys()];
