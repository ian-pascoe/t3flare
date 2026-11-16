// @effect-diagnostics globalConsole:off
// Which Model endpoint each open Pi Durable session's turns run on (SPI-1164), so a sign-out stops that endpoint's
// Sessions: every open Session drops any token it holds for the endpoint, and the ones whose model is on it have their
// running turns stopped. Module state, as the Environment DO is the only object in its isolate (as endpoints/changes.ts).

/** The endpoint (a model ref's provider) each open session's last turn ran on, by session name. */
const onEndpoint = new Map<string, string>();

/** A session's model is on `provider` now (a Model endpoint's id, or `anthropic` for the Model proxy). */
export const noteSessionModel = (sessionName: string, provider: string): void => void onEndpoint.set(sessionName, provider);

/** The session closed. */
export const forgetSessionModel = (sessionName: string): void => void onEndpoint.delete(sessionName);

/** What a sign-out asks of a Session (the agents Worker's `SessionDO`). */
export interface SignedOutSession {
  endpointSignedOut(input: { readonly endpointId: string }): Promise<unknown>;
  abort(input: { readonly all: true; readonly reason: string }): Promise<unknown>;
}

/**
 * Stops `endpointId`'s Sessions after its sign-out: each open session drops the endpoint's token, and each whose model is
 * on the endpoint has its running turns stopped (reason `signed_out`). Best effort: a Session that does not answer is
 * logged and skipped (its token is refused at its next request anyway, as the broker has none).
 */
export const stopSessionsOn = async (
  endpointId: string,
  sessions: { readonly open: () => ReadonlyArray<string>; readonly session: (name: string) => SignedOutSession },
): Promise<{ readonly told: number; readonly stopped: number }> => {
  let told = 0;
  let stopped = 0;
  await Promise.all(
    sessions.open().map(async (name) => {
      try {
        const session = sessions.session(name);
        await session.endpointSignedOut({ endpointId });
        told += 1;
        if (onEndpoint.get(name) === endpointId) {
          await session.abort({ all: true, reason: "signed_out" });
          stopped += 1;
        }
      } catch (error) {
        console.warn(JSON.stringify({ t3flare: "sign-out-session-failed", endpoint: endpointId, session: name, error: String(error).slice(0, 200) }));
      }
    }),
  );
  console.log(JSON.stringify({ t3flare: "sign-out-sessions", endpoint: endpointId, told, stopped }));
  return { told, stopped };
};
