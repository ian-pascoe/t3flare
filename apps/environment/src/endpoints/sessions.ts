// @effect-diagnostics globalConsole:off
// A sign-out stops the signed-out endpoint's Sessions (SPI-1164): every open Pi Durable session is told, drops any
// token it holds for the endpoint, and stops its live turns when they run on it. Which endpoint a Session's turns run on
// is the Session's own record, kept in its storage (agents' `session/signOut.ts`), so it holds after a restart of either
// object; the Environment only knows which sessions are open (the push registry, `registeredSessions`).

/** What a sign-out asks of a Session (the agents Worker's `SessionDO`). */
export interface SignedOutSession {
  endpointSignedOut(input: { readonly endpointId: string }): Promise<{ readonly dropped: boolean; readonly stopped: boolean }>;
}

/**
 * Tells every open session that `endpointId` was signed out. Best effort: a Session that does not answer is logged and
 * skipped (its token is refused at its next request anyway, as the broker has none).
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
        const answer = await sessions.session(name).endpointSignedOut({ endpointId });
        told += 1;
        if (answer.stopped) stopped += 1;
      } catch (error) {
        console.warn(JSON.stringify({ t3flare: "sign-out-session-failed", endpoint: endpointId, session: name, error: String(error).slice(0, 200) }));
      }
    }),
  );
  console.log(JSON.stringify({ t3flare: "sign-out-sessions", endpoint: endpointId, told, stopped }));
  return { told, stopped };
};
